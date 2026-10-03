// Behavioural tests for the monitored-session VALIDITY-WINDOW scan.
//
// The contract tests in packages/db pin the SHAPE of the rule (which monitor
// states are claimable, that no enum value is added, that each closure is
// audited). These pin the actual OUTCOMES against a real database, because the
// failure mode this work exists to fix is silent: a work permit whose approved
// window had passed kept reading as `active` forever.
//
//   SEED_TEST_SCRATCH_DATABASE_URL=postgresql://…/scratch \
//     pnpm --filter @beaconhs/worker test src/workers/session-window-scan.test.ts
//
// Without that variable every scenario reports SKIPPED with a printed reason —
// never as passed. The development database is never touched: the env vars are
// redirected at module load, before the lazy `db` singleton materialises.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { createClient, db, withSuperAdmin } from '@beaconhs/db'
import { auditLog, formResponses, formTemplates, formTemplateVersions } from '@beaconhs/db/schema'
import {
  WORK_PERMIT_APP_KEY,
  permitWindowEnded,
  permitWindowEndedExpr,
  permitWindowOpen,
} from '@beaconhs/db/work-permit'

const SCRATCH_URL = process.env.SEED_TEST_SCRATCH_DATABASE_URL

// Point the worker module's lazy `db`/`superDb` at the scratch database BEFORE
// anything can open a connection. `db` is a Proxy that defers construction, so
// setting these here is sufficient.
if (SCRATCH_URL) {
  process.env.DATABASE_URL = SCRATCH_URL
  process.env.SUPERADMIN_DATABASE_URL = process.env.SEED_TEST_SCRATCH_OWNER_URL ?? SCRATCH_URL
}

const TENANT = '31000000-0000-4000-8000-00000000000c'
const TEMPLATE = '32000000-0000-4000-8000-00000000000c'
const MINUTE = 60_000

const IDS = {
  expiredActive: '33000000-0000-4000-8000-000000000001',
  expiredEscalated: '33000000-0000-4000-8000-000000000002',
  openWindow: '33000000-0000-4000-8000-000000000003',
  openEnded: '33000000-0000-4000-8000-000000000004',
  alreadyDone: '33000000-0000-4000-8000-000000000005',
} as const

/** Report why a scenario could not run, instead of pretending it passed. */
function skipOr(reason: string): boolean {
  if (SCRATCH_URL) return false
  console.warn(`SKIPPED work-permit window scan: ${reason}`)
  return true
}

function scratchClient() {
  if (!SCRATCH_URL) throw new Error('SEED_TEST_SCRATCH_DATABASE_URL is not set')
  return createClient({ url: SCRATCH_URL, max: 2 })
}

/** Load the worker module only after the env points at the scratch database. */
async function runScan() {
  const { processScheduledTick } = await import('./scheduled')
  await processScheduledTick({
    id: 'window-scan-test',
    name: 'tick:form_session_overdue',
    data: { kind: 'form_session_overdue_scan' },
  } as never)
}

async function seedFixtures() {
  const client = scratchClient()
  try {
    await client.db.execute(
      sql`insert into tenants (id, name, slug, status, created_at, updated_at)
          values (${TENANT}, 'Work Permit Scan', 'work-permit-scan', 'active', now(), now())
          on conflict (id) do nothing`,
    )
    await client.db.execute(
      sql`insert into form_templates
            (id, tenant_id, key, name, category, description, status, kind, created_at, updated_at)
          values (${TEMPLATE}, ${TENANT}, ${WORK_PERMIT_APP_KEY}, 'Work Permit', 'work_permit',
                  'scan fixture', 'published', 'wizard', now(), now())
          on conflict (id) do nothing`,
    )
    const schema = {
      schemaVersion: 1,
      title: { en: 'Work Permit' },
      sections: [{ id: 'permit_details', fields: [] }],
      workflow: {
        steps: [
          {
            key: 'request',
            title: { en: 'Request' },
            assignee: { type: 'expression', expr: '$submitter' },
          },
        ],
      },
    }
    const [version] = await client.db
      .insert(formTemplateVersions)
      .values({
        tenantId: TENANT,
        templateId: TEMPLATE,
        version: 1,
        schema: schema as never,
        publishedAt: new Date(),
      })
      .returning({ id: formTemplateVersions.id })
    return version!.id
  } finally {
    await client.sql.end({ timeout: 0 }).catch(() => {})
  }
}

async function cleanupFixtures() {
  const client = scratchClient()
  try {
    await client.db.delete(auditLog).where(eq(auditLog.tenantId, TENANT))
    await client.db.delete(formResponses).where(eq(formResponses.tenantId, TENANT))
    await client.db.delete(formTemplateVersions).where(eq(formTemplateVersions.tenantId, TENANT))
    await client.db.delete(formTemplates).where(eq(formTemplates.tenantId, TENANT))
    await client.db.execute(sql`delete from tenants where id = ${TENANT}`)
  } finally {
    await client.sql.end({ timeout: 0 }).catch(() => {})
  }
}

async function insertSession(input: {
  id: string
  versionId: string
  monitorStatus: 'active' | 'escalated' | 'missed' | 'completed'
  expectedEndAt: Date | null
}) {
  await withSuperAdmin(db, async (tx) => {
    await tx.insert(formResponses).values({
      id: input.id,
      tenantId: TENANT,
      templateId: TEMPLATE,
      templateVersionId: input.versionId,
      monitorStatus: input.monitorStatus,
      checkinIntervalMinutes: 1440,
      gracePeriodMinutes: 0,
      // Far-future check-in so the MISSED-CHECK-IN scan never claims a fixture.
      // These tests exercise the window-end rule in isolation.
      nextCheckinDueAt: new Date(Date.now() + 365 * 24 * 60 * MINUTE),
      expectedEndAt: input.expectedEndAt,
    })
  })
}

function stateOf(id: string) {
  return withSuperAdmin(db, async (tx) => {
    const [row] = await tx
      .select({ monitorStatus: formResponses.monitorStatus, closedAt: formResponses.closedAt })
      .from(formResponses)
      .where(eq(formResponses.id, id))
      .limit(1)
    return row ?? null
  })
}

function auditsFor(id: string) {
  return withSuperAdmin(db, async (tx) => {
    const rows = await tx
      .select({
        action: auditLog.action,
        summary: auditLog.summary,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, TENANT), eq(auditLog.entityId, id)))
    return rows
  })
}

// Fixtures are created once for the WHOLE FILE and torn down once at the end.
// Scoping them to the first describe would delete the rows every later describe
// needs — vitest runs the sibling describes after that describe's afterAll.
beforeAll(async () => {
  if (skipOr('SEED_TEST_SCRATCH_DATABASE_URL is not set')) return
  await cleanupFixtures()
  const versionId = await seedFixtures()
  const past = new Date(Date.now() - 10 * MINUTE)
  const future = new Date(Date.now() + 4 * 60 * MINUTE)
  await insertSession({
    id: IDS.expiredActive,
    versionId,
    monitorStatus: 'active',
    expectedEndAt: past,
  })
  await insertSession({
    id: IDS.expiredEscalated,
    versionId,
    monitorStatus: 'escalated',
    expectedEndAt: past,
  })
  await insertSession({
    id: IDS.openWindow,
    versionId,
    monitorStatus: 'active',
    expectedEndAt: future,
  })
  await insertSession({
    id: IDS.openEnded,
    versionId,
    monitorStatus: 'active',
    expectedEndAt: null,
  })
  await insertSession({
    id: IDS.alreadyDone,
    versionId,
    monitorStatus: 'completed',
    expectedEndAt: past,
  })
})

afterAll(async () => {
  if (skipOr('SEED_TEST_SCRATCH_DATABASE_URL is not set')) return
  await cleanupFixtures()
})

describe('monitored-session validity-window scan', () => {
  // A — an ordinary open-ended session is untouched.
  // B — a permit inside its window stays active.
  // C — a permit past its window reaches a legal terminal state.
  it('closes expired windows and leaves in-window and open-ended sessions alone', async () => {
    if (skipOr('SEED_TEST_SCRATCH_DATABASE_URL is not set')) return
    await runScan()

    // C: expired, still-open states are driven terminal and stamped closed.
    expect((await stateOf(IDS.expiredActive))?.monitorStatus).toBe('completed')
    expect((await stateOf(IDS.expiredActive))?.closedAt).not.toBeNull()
    expect((await stateOf(IDS.expiredEscalated))?.monitorStatus).toBe('completed')

    // B: a future window keeps the session live.
    expect((await stateOf(IDS.openWindow))?.monitorStatus).toBe('active')
    expect((await stateOf(IDS.openWindow))?.closedAt).toBeNull()

    // A: no window means no expiry, ever.
    expect((await stateOf(IDS.openEnded))?.monitorStatus).toBe('active')
    expect((await stateOf(IDS.openEnded))?.closedAt).toBeNull()

    // An already-closed session is neither reopened nor re-stamped.
    expect((await stateOf(IDS.alreadyDone))?.monitorStatus).toBe('completed')
  })

  // WP10 — a second pass is a no-op.
  it('is idempotent across repeated runs', async () => {
    if (skipOr('SEED_TEST_SCRATCH_DATABASE_URL is not set')) return
    const firstRunAudits = (await auditsFor(IDS.expiredActive)).length
    const firstClosedAt = (await stateOf(IDS.expiredActive))?.closedAt
    await runScan()
    await runScan()
    expect((await auditsFor(IDS.expiredActive)).length).toBe(firstRunAudits)
    expect((await stateOf(IDS.expiredActive))?.closedAt).toEqual(firstClosedAt)
  })

  // WP11 — the scan must never terminate an open-ended session.
  it('never terminates an open-ended session, and never audits one', async () => {
    if (skipOr('SEED_TEST_SCRATCH_DATABASE_URL is not set')) return
    await runScan()
    expect((await stateOf(IDS.openEnded))?.monitorStatus).toBe('active')
    expect(await auditsFor(IDS.openEnded)).toEqual([])
  })

  // WP17 — the closure is attributable in the shared audit log.
  it('audits each closure with the trigger and the state transition', async () => {
    if (skipOr('SEED_TEST_SCRATCH_DATABASE_URL is not set')) return
    const rows = await auditsFor(IDS.expiredActive)
    const closure = rows.find((r) => r.metadata?.trigger === 'monitored_session_window_end')
    expect(closure).toBeDefined()
    expect(closure?.action).toBe('update')
    expect(closure?.metadata.monitorStatusFrom).toBe('active')
    expect(closure?.metadata.monitorStatusTo).toBe('completed')
    expect(String(closure?.metadata.expectedEndAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

// The defensive predicate against real rows. This is the rule that must hold in
// the gap between a window ending and the cron observing it.
describe('permitWindowOpen / permitWindowEnded against real rows', () => {
  async function setMonitorStatus(
    id: string,
    status: 'active' | 'completed',
    closedAt: Date | null,
  ) {
    await withSuperAdmin(db, (tx) =>
      tx
        .update(formResponses)
        .set({ monitorStatus: status, closedAt })
        .where(eq(formResponses.id, id)),
    )
  }

  it('returns only in-window sessions from permitWindowOpen', async () => {
    if (skipOr('SEED_TEST_SCRATCH_DATABASE_URL is not set')) return
    await runScan()
    const [open] = await withSuperAdmin(db, (tx) =>
      tx
        .select({ id: formResponses.id })
        .from(formResponses)
        .where(and(eq(formResponses.tenantId, TENANT), permitWindowOpen(new Date()))),
    )
    expect(open?.id).toBe(IDS.openWindow)
  })

  it('reports a window-ended session as ended', async () => {
    if (skipOr('SEED_TEST_SCRATCH_DATABASE_URL is not set')) return
    const ended = await withSuperAdmin(db, (tx) =>
      tx
        .select({ id: formResponses.id })
        .from(formResponses)
        .where(
          and(
            eq(formResponses.tenantId, TENANT),
            permitWindowEnded(new Date()),
            eq(formResponses.id, IDS.expiredActive),
          ),
        ),
    )
    expect(ended).toHaveLength(1)
  })

  // The security-critical assertion: an expired permit is NOT returned as active
  // even though its stored status still literally says 'active'.
  it('refuses to present an expired-but-not-yet-scanned permit as active', async () => {
    if (skipOr('SEED_TEST_SCRATCH_DATABASE_URL is not set')) return
    await setMonitorStatus(IDS.expiredActive, 'active', null)
    const now = new Date()
    const [open] = await withSuperAdmin(db, (tx) =>
      tx
        .select({ id: formResponses.id })
        .from(formResponses)
        .where(
          and(
            eq(formResponses.tenantId, TENANT),
            eq(formResponses.id, IDS.expiredActive),
            permitWindowOpen(now),
          ),
        ),
    )
    const ended = await withSuperAdmin(db, (tx) =>
      tx
        .select({ id: formResponses.id })
        .from(formResponses)
        .where(
          and(
            eq(formResponses.tenantId, TENANT),
            eq(formResponses.id, IDS.expiredActive),
            permitWindowEndedExpr(now),
          ),
        ),
    )
    expect(open).toBeUndefined()
    expect(ended).toHaveLength(1)
    // restore for any later ordering
    await runScan()
  })

  it('keeps an in-window permit active', async () => {
    if (skipOr('SEED_TEST_SCRATCH_DATABASE_URL is not set')) return
    const [open] = await withSuperAdmin(db, (tx) =>
      tx
        .select({ id: formResponses.id })
        .from(formResponses)
        .where(
          and(
            eq(formResponses.tenantId, TENANT),
            eq(formResponses.id, IDS.openWindow),
            permitWindowOpen(new Date()),
          ),
        ),
    )
    expect(open?.id).toBe(IDS.openWindow)
  })
})

// Guards the fixture itself, so a broken scenario can never be mistaken for a
// working rule.
describe('fixture integrity', () => {
  it('creates a published work_permit template with a real version', async () => {
    if (skipOr('SEED_TEST_SCRATCH_DATABASE_URL is not set')) return
    const [template] = await withSuperAdmin(db, (tx) =>
      tx
        .select({ category: formTemplates.category, status: formTemplates.status })
        .from(formTemplates)
        .where(eq(formTemplates.id, TEMPLATE)),
    )
    expect(template?.category).toBe('work_permit')
    expect(template?.status).toBe('published')
    const [version] = await withSuperAdmin(db, (tx) =>
      tx
        .select({ id: formTemplateVersions.id })
        .from(formTemplateVersions)
        .where(eq(formTemplateVersions.templateId, TEMPLATE)),
    )
    expect(version?.id).toBeTruthy()
  })
})
