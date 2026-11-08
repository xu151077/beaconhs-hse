/**
 * Clean-cutover migration for attachment capabilities v2.
 *
 * The verifier in `lib/attachment-url.ts` only computes `attachment:v2:<id>`,
 * so every historical v1 cap embedded in persisted values 404s. This script
 * re-mints the embedded caps by rewriting every persisted attachment-route
 * reference to the current `attachmentUrl()` form. v2 caps are deterministic
 * per attachment, so a second apply pass is a no-op (proved, not assumed).
 *
 * Surfaces are identical to the v1 private-attachment-url cutover:
 * `training_lessons` / `training_content_items` `content_html` and
 * `form_responses` `data` / `draft_data` / `workflow_state`.
 *
 * Audit mode (default) inspects and reports without writing. Apply mode
 * repeats the preflight under a dedicated session advisory lock and then
 * atomically CAS-rewrites each changed row, followed by an idempotency
 * second pass. Every referenced attachment must exist in the row's own
 * tenant; anything else fails closed.
 *
 * Run: tsx scripts/backfill-attachment-capability-v2.ts [--apply]
 */

import { createClient } from '@beaconhs/db'
import { attachmentUrl } from '../src/lib/attachment-url'
import { sanitizeTrainingHtml } from '../src/lib/training-rich-content'
import {
  inspectPersistedValue,
  rewritePersistedValue,
  type AttachmentReference,
  type PersistedJson,
} from './private-attachment-url-cutover'
import {
  assertCutoverDatabaseSession,
  requireCutoverCapabilitySecret,
  requireCutoverDatabaseTarget,
} from './cutover-target'

const APPLY = process.argv.includes('--apply')
const DATABASE_URL = requireCutoverDatabaseTarget(APPLY)
requireCutoverCapabilitySecret()

const LOCK_NAME = 'beaconhs:attachment-capability-v2:v1'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const { sql } = createClient({ url: DATABASE_URL, max: 2 })
const { sql: lockSql } = createClient({ url: DATABASE_URL, max: 1 })

type AttachmentRow = { id: string; tenant_id: string }

type NullableJson = { value: PersistedJson; sqlNull: boolean }

type TrainingRow = { id: string; tenant_id: string; content_html: string | null }

type FormResponseRow = {
  id: string
  tenant_id: string
  data: PersistedJson
  draft_data: PersistedJson
  draft_data_sql_null: boolean
  workflow_state: PersistedJson
  workflow_state_sql_null: boolean
}

type TrainingSnapshot = { contentHtml: string | null }

type FormResponseSnapshot = {
  data: PersistedJson
  draftData: NullableJson
  workflowState: NullableJson
}

type RowPlan = {
  table: 'training_lessons' | 'training_content_items' | 'form_responses'
  id: string
  tenantId: string
  before: TrainingSnapshot | FormResponseSnapshot
  after: TrainingSnapshot | FormResponseSnapshot
}

type InspectedRow = {
  table: RowPlan['table']
  id: string
  tenantId: string
  before: TrainingSnapshot | FormResponseSnapshot
  references: AttachmentReference[]
}

type PreparedCutover = {
  plans: RowPlan[]
  stats: {
    rowsScanned: number
    references: number
    withCap: number
    pending: number
    invalid: number
    changedRows: number
  }
}

function canonicalJson(value: PersistedJson): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`
}

function jsonEqual(left: PersistedJson, right: PersistedJson): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function nullableJsonEqual(left: NullableJson, right: NullableJson): boolean {
  return left.sqlNull === right.sqlNull && jsonEqual(left.value, right.value)
}

function trainingEqual(left: TrainingSnapshot, right: TrainingSnapshot): boolean {
  return left.contentHtml === right.contentHtml
}

function formResponseEqual(left: FormResponseSnapshot, right: FormResponseSnapshot): boolean {
  return (
    jsonEqual(left.data, right.data) &&
    nullableJsonEqual(left.draftData, right.draftData) &&
    nullableJsonEqual(left.workflowState, right.workflowState)
  )
}

function referenceKey(reference: AttachmentReference): string {
  return `${reference.kind}\0${reference.raw}`
}

async function loadRows(): Promise<{
  lessons: TrainingRow[]
  items: TrainingRow[]
  responses: FormResponseRow[]
}> {
  const [lessons, items, responses] = await Promise.all([
    sql<TrainingRow[]>`
      select id::text, tenant_id::text, content_html
      from training_lessons order by id
    `,
    sql<TrainingRow[]>`
      select id::text, tenant_id::text, content_html
      from training_content_items order by id
    `,
    sql<FormResponseRow[]>`
      select id::text, tenant_id::text, data, draft_data,
             draft_data is null as draft_data_sql_null, workflow_state,
             workflow_state is null as workflow_state_sql_null
      from form_responses order by id
    `,
  ])
  return { lessons, items, responses }
}

function inspectTrainingRow(
  table: 'training_lessons' | 'training_content_items',
  row: TrainingRow,
): { row: InspectedRow; invalid: ReturnType<typeof inspectPersistedValue>['invalid'] } {
  const cell = inspectPersistedValue(
    row.content_html,
    row.tenant_id,
    `${table}.${row.id}.content_html`,
  )
  return {
    row: {
      table,
      id: row.id,
      tenantId: row.tenant_id,
      before: { contentHtml: row.content_html },
      references: cell.references,
    },
    invalid: cell.invalid,
  }
}

function inspectFormResponseRow(row: FormResponseRow): {
  row: InspectedRow
  invalid: ReturnType<typeof inspectPersistedValue>['invalid']
} {
  const path = `form_responses.${row.id}`
  const cells = [
    inspectPersistedValue(row.data, row.tenant_id, `${path}.data`),
    inspectPersistedValue(row.draft_data, row.tenant_id, `${path}.draft_data`),
    inspectPersistedValue(row.workflow_state, row.tenant_id, `${path}.workflow_state`),
  ]
  return {
    row: {
      table: 'form_responses',
      id: row.id,
      tenantId: row.tenant_id,
      before: {
        data: row.data,
        draftData: { value: row.draft_data, sqlNull: row.draft_data_sql_null },
        workflowState: { value: row.workflow_state, sqlNull: row.workflow_state_sql_null },
      },
      references: cells.flatMap((cell) => cell.references),
    },
    invalid: cells.flatMap((cell) => cell.invalid),
  }
}

function rewriteInspectedRow(
  row: InspectedRow,
  replacements: ReadonlyMap<string, string>,
): RowPlan {
  const replace = (reference: AttachmentReference) => {
    const value = replacements.get(referenceKey(reference))
    if (!value) throw new Error(`Missing preflight replacement for ${reference.path}`)
    return value
  }
  if (row.table === 'form_responses') {
    const before = row.before as FormResponseSnapshot
    return {
      table: row.table,
      id: row.id,
      tenantId: row.tenantId,
      before,
      after: {
        data: rewritePersistedValue(
          before.data,
          row.tenantId,
          replace,
          `form_responses.${row.id}.data`,
        ),
        draftData: {
          value: rewritePersistedValue(
            before.draftData.value,
            row.tenantId,
            replace,
            `form_responses.${row.id}.draft_data`,
          ),
          sqlNull: before.draftData.sqlNull,
        },
        workflowState: {
          value: rewritePersistedValue(
            before.workflowState.value,
            row.tenantId,
            replace,
            `form_responses.${row.id}.workflow_state`,
          ),
          sqlNull: before.workflowState.sqlNull,
        },
      },
    }
  }
  const before = row.before as TrainingSnapshot
  const rewritten = rewritePersistedValue(
    before.contentHtml,
    row.tenantId,
    replace,
    `${row.table}.${row.id}.content_html`,
  )
  if (rewritten !== null && typeof rewritten !== 'string') {
    throw new Error(`${row.table}.${row.id}.content_html changed type during preflight`)
  }
  const contentHtml = typeof rewritten === 'string' ? sanitizeTrainingHtml(rewritten) : rewritten
  return { table: row.table, id: row.id, tenantId: row.tenantId, before, after: { contentHtml } }
}

async function prepareCutover(): Promise<PreparedCutover> {
  const loaded = await loadRows()
  const inspected = [
    ...loaded.lessons.map((row) => inspectTrainingRow('training_lessons', row)),
    ...loaded.items.map((row) => inspectTrainingRow('training_content_items', row)),
    ...loaded.responses.map(inspectFormResponseRow),
  ]
  const invalid = inspected.flatMap((item) => item.invalid)
  if (invalid.length > 0) {
    const examples = invalid
      .slice(0, 5)
      .map((item) => `${item.path}: ${item.reason}`)
      .join('; ')
    throw new Error(`Found ${invalid.length} invalid attachment reference(s): ${examples}`)
  }

  const rows = inspected.map((item) => item.row)
  const references = rows.flatMap((row) => row.references)
  for (const reference of references) {
    if (reference.kind === 'public-object') {
      throw new Error(
        `Public-object reference survives at ${reference.path}; rerun the v1 private-attachment-url cutover first`,
      )
    }
  }
  const ids = [
    ...new Set(
      references
        .filter((reference) => reference.kind === 'route')
        .map((reference) => reference.attachmentId),
    ),
  ]
  const attachmentRows =
    ids.length === 0
      ? []
      : await sql<AttachmentRow[]>`
          select id::text, tenant_id::text from attachments
          where id = any(${ids}::uuid[]) order by id
        `
  const attachmentsById = new Map(attachmentRows.map((row) => [row.id.toLowerCase(), row]))

  const plans: RowPlan[] = []
  let pending = 0
  for (const row of rows) {
    const replacements = new Map<string, string>()
    for (const reference of row.references) {
      if (reference.kind !== 'route') {
        throw new Error(
          `Public-object reference survives at ${reference.path}; rerun the v1 private-attachment-url cutover first`,
        )
      }
      const attachment = attachmentsById.get(reference.attachmentId.toLowerCase())
      if (!attachment) throw new Error(`No attachment matches ${reference.path}`)
      if (attachment.tenant_id.toLowerCase() !== row.tenantId.toLowerCase()) {
        throw new Error(`Attachment reference crosses tenants at ${reference.path}`)
      }
      if (!UUID_RE.test(attachment.id) || !UUID_RE.test(attachment.tenant_id)) {
        throw new Error('Attachment lookup returned a non-UUID identifier')
      }
      const value = attachmentUrl(attachment.id)
      const key = referenceKey(reference)
      const previous = replacements.get(key)
      if (previous && previous !== value) {
        throw new Error(`Attachment reference resolves inconsistently at ${reference.path}`)
      }
      replacements.set(key, value)
      if (reference.raw !== value) pending++
    }
    const plan = rewriteInspectedRow(row, replacements)
    const changed =
      plan.table === 'form_responses'
        ? !formResponseEqual(
            plan.before as FormResponseSnapshot,
            plan.after as FormResponseSnapshot,
          )
        : !trainingEqual(plan.before as TrainingSnapshot, plan.after as TrainingSnapshot)
    if (changed) plans.push(plan)
  }

  return {
    plans,
    stats: {
      rowsScanned: rows.length,
      references: references.length,
      withCap: references.filter(
        (reference) => reference.kind === 'route' && reference.capability !== null,
      ).length,
      pending,
      invalid: invalid.length,
      changedRows: plans.length,
    },
  }
}

async function applyPlans(plans: readonly RowPlan[]): Promise<number> {
  if (plans.length === 0) return 0
  return sql.begin(async (tx) => {
    let mutations = 0
    for (const plan of plans) {
      if (plan.table === 'form_responses') {
        const [current] = await tx<FormResponseRow[]>`
          select id::text, tenant_id::text, data, draft_data,
                 draft_data is null as draft_data_sql_null, workflow_state,
                 workflow_state is null as workflow_state_sql_null
          from form_responses where id = ${plan.id}::uuid for update
        `
        if (!current) throw new Error(`form_responses ${plan.id} disappeared during cutover`)
        const snapshot: FormResponseSnapshot = {
          data: current.data,
          draftData: { value: current.draft_data, sqlNull: current.draft_data_sql_null },
          workflowState: {
            value: current.workflow_state,
            sqlNull: current.workflow_state_sql_null,
          },
        }
        if (
          current.tenant_id !== plan.tenantId ||
          !formResponseEqual(snapshot, plan.before as FormResponseSnapshot)
        ) {
          throw new Error(`form_responses ${plan.id} changed after preflight`)
        }
        const after = plan.after as FormResponseSnapshot
        const updated = await tx<{ id: string }[]>`
          update form_responses
          set data = ${JSON.stringify(after.data)}::jsonb,
              draft_data = case when ${after.draftData.sqlNull} then null
                                else ${JSON.stringify(after.draftData.value)}::jsonb end,
              workflow_state = case when ${after.workflowState.sqlNull} then null
                                    else ${JSON.stringify(after.workflowState.value)}::jsonb end,
              updated_at = now()
          where id = ${plan.id}::uuid and tenant_id = ${plan.tenantId}::uuid
            and data is not distinct from ${JSON.stringify((plan.before as FormResponseSnapshot).data)}::jsonb
            and draft_data is not distinct from
                (case when ${(plan.before as FormResponseSnapshot).draftData.sqlNull} then null
                      else ${JSON.stringify((plan.before as FormResponseSnapshot).draftData.value)}::jsonb end)
            and workflow_state is not distinct from
                (case when ${(plan.before as FormResponseSnapshot).workflowState.sqlNull} then null
                      else ${JSON.stringify((plan.before as FormResponseSnapshot).workflowState.value)}::jsonb end)
          returning id::text
        `
        if (updated.length !== 1) {
          throw new Error(`form_responses ${plan.id} was not updated exactly once`)
        }
      } else {
        const table = plan.table
        const currentRows =
          table === 'training_lessons'
            ? await tx<TrainingRow[]>`
                select id::text, tenant_id::text, content_html
                from training_lessons where id = ${plan.id}::uuid for update
              `
            : await tx<TrainingRow[]>`
                select id::text, tenant_id::text, content_html
                from training_content_items where id = ${plan.id}::uuid for update
              `
        const current = currentRows[0]
        if (!current) throw new Error(`${table} ${plan.id} disappeared during cutover`)
        const snapshot: TrainingSnapshot = { contentHtml: current.content_html }
        if (
          current.tenant_id !== plan.tenantId ||
          !trainingEqual(snapshot, plan.before as TrainingSnapshot)
        ) {
          throw new Error(`${table} ${plan.id} changed after preflight`)
        }
        const updated =
          table === 'training_lessons'
            ? await tx<{ id: string }[]>`
                update training_lessons
                set content_html = ${(plan.after as TrainingSnapshot).contentHtml},
                    updated_at = now()
                where id = ${plan.id}::uuid and tenant_id = ${plan.tenantId}::uuid
                  and content_html is not distinct from ${(plan.before as TrainingSnapshot).contentHtml}
                returning id::text
              `
            : await tx<{ id: string }[]>`
                update training_content_items
                set content_html = ${(plan.after as TrainingSnapshot).contentHtml},
                    updated_at = now()
                where id = ${plan.id}::uuid and tenant_id = ${plan.tenantId}::uuid
                  and content_html is not distinct from ${(plan.before as TrainingSnapshot).contentHtml}
                returning id::text
              `
        if (updated.length !== 1) {
          throw new Error(`${table} ${plan.id} was not updated exactly once`)
        }
      }
      mutations++
    }
    return mutations
  })
}

function assertPostcondition(prepared: PreparedCutover): void {
  const { pending, invalid, changedRows } = prepared.stats
  if (pending !== 0 || invalid !== 0 || changedRows !== 0) {
    throw new Error(
      `Attachment capability v2 postcondition failed: pending=${pending}, invalid=${invalid}, changedRows=${changedRows}`,
    )
  }
}

async function auditOnly(): Promise<void> {
  const prepared = await prepareCutover()
  console.log('[attachment-capability-v2]', { mode: 'AUDIT-ONLY', ...prepared.stats })
}

async function applyCutover(): Promise<void> {
  const lockConnection = await lockSql.reserve()
  let lockHeld = false
  try {
    const [lock] = await lockConnection<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtextextended(${LOCK_NAME}, 0)) as locked
    `
    if (!lock?.locked)
      throw new Error('Another attachment capability v2 cutover holds the advisory lock')
    lockHeld = true

    const prepared = await prepareCutover()
    console.log('[attachment-capability-v2]', { mode: 'APPLY', ...prepared.stats })
    const mutations = await applyPlans(prepared.plans)
    if (mutations !== prepared.stats.changedRows) {
      throw new Error('Attachment capability v2 mutation count did not match its preflight plan')
    }

    const after = await prepareCutover()
    assertPostcondition(after)
    const secondApplyMutations = await applyPlans(after.plans)
    if (secondApplyMutations !== 0) {
      throw new Error('Attachment capability v2 was not idempotent on its second apply pass')
    }
    const final = await prepareCutover()
    assertPostcondition(final)
    console.log('[attachment-capability-v2] complete', {
      mutations,
      secondApplyMutations,
      ...final.stats,
    })
  } finally {
    try {
      if (lockHeld) {
        await lockConnection`select pg_advisory_unlock(hashtextextended(${LOCK_NAME}, 0))`
      }
    } finally {
      lockConnection.release()
    }
  }
}

async function main(): Promise<void> {
  await assertCutoverDatabaseSession(sql)
  if (APPLY) await applyCutover()
  else await auditOnly()
}

main()
  .catch((error: unknown) => {
    console.error(
      '[attachment-capability-v2] FAILED:',
      error instanceof Error ? error.message : error,
    )
    process.exitCode = 1
  })
  .finally(async () => {
    await Promise.all([sql.end({ timeout: 5 }), lockSql.end({ timeout: 5 })])
  })
