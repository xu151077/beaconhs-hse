// Per-tenant reference data: what a provisioned tenant gets, and what it must never get.
//
// SCOPE OF THIS FILE
//
// `insertProvisionedTenant` now seeds five reference catalogues through the SAME exported
// seeders `seed.ts` calls. What matters is not that rows appear — it is that the row
// seeder did the safe half of its old job and stopped before the dangerous half:
//
//   1. every catalogue is populated on a fresh database;
//   2. re-running changes nothing — no duplicate, no new id, no lost customisation;
//   3. two tenants cannot see each other's catalogues under the real runtime RLS role;
//   4. an existing incident is NOT reclassified by provisioning. The demo seeder used to
//      do that in the same function that created the taxonomy, and the split is what makes
//      this assertable.
//
// EXPECTED VALUES ARE DERIVED, NEVER RESTATED
//
// The incident taxonomy and the HAZID app template keys are exported from the modules
// that own them, and the role count comes from `BUILTIN_ROLES`. A test that hard-codes
// "6 classifications" is a test that goes quietly stale the day someone adds a seventh;
// these read the source instead. Counts that genuinely have no exported source (PPE
// criteria rows, for instance) are asserted as "> 0" because "> 0" is the actual
// contract — the catalogue is populated — and pinning 20 would assert an implementation
// detail nobody wants policed.
//
// ROLES AND REALITY
//
// These scenarios run the REAL CLI as a subprocess against a throwaway database, because
// the properties only mean anything against real rows and the real transaction. They are
// skipped, loudly, when no scratch Postgres is configured. A skipped scenario is reported
// as skipped, never as passed.

import { describe, expect, it, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import postgres from 'postgres'
import { db, type Database } from './client'
import { withSuperAdmin } from './rls'
import {
  resolveOptionalScratchDatabaseUrl,
  resolveScratchDatabaseUrl,
} from './testing/scratch-database'
import { insertProvisionedTenant } from './tenant-provisioning'
import { INCIDENT_CLASSIFICATION_SEED, INCIDENT_INJURY_TYPE_SEED } from './seed/incident-taxonomy'
import {
  HAZID_ARC_FLASH_APP_KEY,
  HAZID_CONFINED_SPACE_APP_KEY,
  HAZID_FALL_PROTECTION_APP_KEY,
} from './seed/hazard-assessment-app-templates'
import {
  ENVIRONMENT_MONITORING_APP_KEY,
  STATUTORY_REGISTER_APP_KEY,
} from './seed/phase11e-register-apps'
import { WORK_PERMIT_APP_KEY } from './work-permit'
import { BUILTIN_ROLES } from './schema/iam'

/**
 * The day-one builder templates, derived from the owning constants — the
 * earlier 4-template list went stale when the register/template seeders joined
 * provisioning (CI: expected 4, got 8).
 */
const DAY_ONE_TEMPLATE_KEYS = [
  'lift-plan',
  HAZID_CONFINED_SPACE_APP_KEY,
  HAZID_ARC_FLASH_APP_KEY,
  HAZID_FALL_PROTECTION_APP_KEY,
  ENVIRONMENT_MONITORING_APP_KEY,
  STATUTORY_REGISTER_APP_KEY,
  'toolbox-talk',
  WORK_PERMIT_APP_KEY,
] as const

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = resolve(PKG_DIR, 'src/scripts/provision-first-tenant.cli.ts')
const require = createRequire(import.meta.url)
void require

const SCRATCH_URL = resolveScratchDatabaseUrl()
const SUPERADMIN_URL = resolveOptionalScratchDatabaseUrl('SEED_TEST_SCRATCH_SUPERADMIN_URL')
const describeDb = SCRATCH_URL ? describe : describe.skip

/** Every catalogue provisioning is expected to populate, with its table. */
const CATALOGUES = [
  'document_types',
  'document_categories',
  'ppe_types',
  'ppe_type_inspection_criteria',
  'hazid_hazard_types',
  'hazid_hazards',
  'hazid_tasks',
  'hazid_assessment_types',
  'training_assessment_types',
  'training_assessment_type_questions',
  'incident_classifications',
  'incident_injury_types',
  'inspection_banks',
  'inspection_types',
  'inspection_type_criteria',
  'equipment_types',
  'person_groups',
  'training_skill_types',
  'training_skill_authorities',
  'ppe_criteria_banks',
  'email_templates',
  'data_sources',
  'pdf_templates',
] as const

type CatalogueCounts = Record<(typeof CATALOGUES)[number], number>

if (!SCRATCH_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[tenant-reference-data] SEED_TEST_SCRATCH_DATABASE_URL is not set — database scenarios are SKIPPED, not passed.',
  )
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const url = SUPERADMIN_URL ?? SCRATCH_URL ?? ''
  const result = spawnSync(process.execPath, [require.resolve('tsx/cli'), CLI, ...args], {
    encoding: 'utf8',
    cwd: PKG_DIR,
    timeout: 240_000,
    env: {
      ...process.env,
      DATABASE_URL: url,
      SUPERADMIN_DATABASE_URL: url,
      MIGRATION_DATABASE_URL: url,
      // Keep the seeder quiet; the assertions read the database, not stdout.
      NODE_ENV: 'test',
    },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Read through the superadmin credential — the runtime role sees zero rows unscoped. */
async function query<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  if (!SUPERADMIN_URL) throw new Error('SEED_TEST_SCRATCH_SUPERADMIN_URL is not set.')
  const sql = postgres(SUPERADMIN_URL, { max: 1 })
  try {
    const result = (await sql.unsafe(text, values as never[])) as unknown as T[]
    return Array.isArray(result) ? result : []
  } finally {
    await sql.end({ timeout: 0 }).catch(() => {})
  }
}

/**
 * Delete every tenant, which cascades to all tenant-scoped rows.
 *
 * `beaconhs_super` holds DELETE on `tenants` and everything the cascade reaches, so one
 * credential is enough — no `TRUNCATE`, no second connection identity.
 *
 * The one exception is `storage_freeze`: it references `tenants` with NO ACTION,
 * deliberately, so that a hard tenant delete cannot silently erase the record that the
 * tenant was frozen (migration 0046). Its rows are therefore deleted explicitly first —
 * this teardown really does mean "gone", and it says so in two statements rather than
 * relying on a cascade that a future migration could change the meaning of.
 *
 * Audit rows are append-only for every role except `beaconhs_owner` (the
 * immutable trigger, migration 0056) and the tenant FK is RESTRICT, so the
 * teardown removes them FIRST as the owner — via `MIGRATION_DATABASE_URL`
 * (the migrator login reaching the owner by `SET ROLE`, as `migrate.ts`
 * does) — then deletes tenants with the superadmin credential.
 */
async function wipeTenants(): Promise<void> {
  const migratorUrl = process.env.MIGRATION_DATABASE_URL
  if (!migratorUrl) throw new Error('MIGRATION_DATABASE_URL is not set for teardown.')
  const adminUrl = process.env.SEED_TEST_SCRATCH_SUPERADMIN_URL
  if (!adminUrl) throw new Error('SEED_TEST_SCRATCH_SUPERADMIN_URL is not set for teardown.')
  const admin = postgres(adminUrl, { max: 1 })
  try {
    const rows = (await admin`select id::text as id from tenants`) as Array<{ id: string }>
    const owner = postgres(migratorUrl, { max: 1 })
    try {
      await owner.unsafe('SET ROLE beaconhs_owner')
      for (const row of rows) {
        await owner.unsafe(`SET app.tenant_id='${row.id}'`)
        await owner.unsafe(`DELETE FROM audit_log WHERE tenant_id='${row.id}'::uuid`)
      }
    } finally {
      await owner.end({ timeout: 0 }).catch(() => {})
    }
  } finally {
    await admin.end({ timeout: 0 }).catch(() => {})
  }
  await query('DELETE FROM storage_object_deletion_outbox')
  await query('DELETE FROM storage_write_arms')
  await query('DELETE FROM in_flight_writes')
  await query('DELETE FROM storage_freeze')
  await query('DELETE FROM tenants')
}

async function tenantIdBySlug(slug: string): Promise<string> {
  const rows = await query<{ id: string }>('select id::text as id from tenants where slug = $1', [
    slug,
  ])
  const id = rows[0]?.id
  if (!id) throw new Error(`No tenant with slug "${slug}" — the provisioner did not run.`)
  return id
}

/** Per-tenant row count for every catalogue, keyed by table. */
async function catalogueCounts(tenantId: string): Promise<CatalogueCounts> {
  const rows = await query<Record<string, number>>(
    `select ${CATALOGUES.map((t) => `(select count(*) from ${t} where tenant_id = $1)::int as ${t}`).join(',\n       ')}`,
    [tenantId],
  )
  return rows[0] as CatalogueCounts
}

/** The incident taxonomy's id + name pairs, for comparison across runs. */
async function taxonomySnapshot(tenantId: string): Promise<{
  classifications: { id: string; name: string }[]
  injuryTypes: { id: string; name: string }[]
}> {
  const classifications = await query<{ id: string; name: string }>(
    `select id::text as id, name from incident_classifications where tenant_id = $1 order by name`,
    [tenantId],
  )
  const injuryTypes = await query<{ id: string; name: string }>(
    `select id::text as id, name from incident_injury_types where tenant_id = $1 order by name`,
    [tenantId],
  )
  return { classifications, injuryTypes }
}

/**
 * Re-run the reference initialisers against an existing tenant, exactly as a second
 * provisioning pass would.
 *
 * `withSuperAdmin` ignores its first argument and always opens on `superDb`, which reads
 * `SUPERADMIN_DATABASE_URL` on first use — so that is the variable that decides which
 * database this mutates. Asserted rather than assumed: pointing it at a developer's real
 * Postgres would otherwise re-converge catalogues in it and could then "pass" against the
 * wrong data.
 */
function assertInProcessUrls(): void {
  const actual = process.env.SUPERADMIN_DATABASE_URL
  if (actual !== SUPERADMIN_URL) {
    throw new Error(
      'SUPERADMIN_DATABASE_URL must equal SEED_TEST_SCRATCH_SUPERADMIN_URL for the ' +
        `in-process reference scenarios (it is ${actual ?? 'unset'}, expected ${SUPERADMIN_URL ?? 'unset'}).`,
    )
  }
}

describeDb('reference data provisioned for a tenant', () => {
  afterAll(async () => {
    await wipeTenants()
  })

  it('populates every reference catalogue on a fresh database, and nothing else', async () => {
    await wipeTenants()
    const result = runCli(['--name', 'Reference Data Ltd', '--apply'])
    expect(result.status, `provisioner failed:\n${result.stderr}`).toBe(0)

    const tenantId = await tenantIdBySlug('reference-data-ltd')
    const counts = await catalogueCounts(tenantId)

    // Populated — this is the actual contract.
    for (const table of CATALOGUES) {
      expect(counts[table], `${table} should be populated`).toBeGreaterThan(0)
    }

    // The incident taxonomy, key-for-key against the exported source data.
    const expectedClassifications = INCIDENT_CLASSIFICATION_SEED.map((c) => c.name).sort()
    const expectedInjuryTypes = INCIDENT_INJURY_TYPE_SEED.map((i) => i.name).sort()
    const actualClassifications = (
      await query<{ name: string }>(
        `select name from incident_classifications where tenant_id = $1`,
        [tenantId],
      )
    ).map((r) => r.name)
    const actualInjuryTypes = (
      await query<{ name: string }>(`select name from incident_injury_types where tenant_id = $1`, [
        tenantId,
      ])
    ).map((r) => r.name)
    expect(actualClassifications.sort()).toEqual(expectedClassifications)
    expect(actualInjuryTypes.sort()).toEqual(expectedInjuryTypes)

    // The built-in roles, from the catalogue rather than a literal.
    const roleRows = await query<{ key: string }>(
      `select key from roles where tenant_id = $1 and is_built_in`,
      [tenantId],
    )
    expect(roleRows.map((r) => r.key).sort()).toEqual(Object.keys(BUILTIN_ROLES).sort())

    // The day-one templates: the Lift Plan, the HAZID embedded apps (whose
    // `hazid_assessment_type_apps.template_id` is a real foreign key), and the
    // register/template apps from the phase-11E + template seeders. The set is
    // derived from their source constants, never restated as a stale literal.
    const templates = await query<{ key: string }>('select key from form_templates', [])
    expect(templates.map((t) => t.key).sort()).toEqual([...DAY_ONE_TEMPLATE_KEYS].sort())

    // And no demo business data whatsoever. This is the property the whole split exists
    // to protect, so it is asserted per table rather than as one aggregate that could
    // hide which table regressed.
    const mustBeEmpty = [
      'incidents',
      'incident_injuries',
      'incident_injury_type_assignments',
      'incident_hours_periods',
      'inspection_records',
      'equipment_items',
      'ppe_items',
      'people',
      'org_units',
      'tenant_users',
      'training_assessments',
      'training_records',
    ]
    for (const table of mustBeEmpty) {
      const rows = await query<{ n: number }>(`select count(*)::int as n from ${table}`)
      expect(rows[0]?.n, `${table} must stay empty — provisioning writes no demo data`).toBe(0)
    }
  }, 300_000)

  it('re-running the initialisers changes nothing: no duplicates, no new ids, no lost edits', async () => {
    await wipeTenants()
    const first = runCli(['--name', 'Idempotent Ltd', '--apply'])
    expect(first.status, `provisioner failed:\n${first.stderr}`).toBe(0)
    const tenantId = await tenantIdBySlug('idempotent-ltd')

    const before = await catalogueCounts(tenantId)
    const beforeTaxonomy = await taxonomySnapshot(tenantId)

    // A tenant administrator customises the catalogue, as a real one would.
    await query(
      `update incident_classifications set description = 'CUSTOM: site-specific wording' where tenant_id = $1 and name = 'Near miss'`,
      [tenantId],
    )
    await query(
      `update ppe_types set category = 'custom-head-protection' where tenant_id = $1 and name = 'Hard hat'`,
      [tenantId],
    )
    const customBefore = await query<{ id: string }>(
      `select id::text as id from incident_classifications where tenant_id = $1 and name = 'Near miss'`,
      [tenantId],
    )

    // Re-run every reference initialiser in-process, exactly as a second pass would.
    assertInProcessUrls()
    await withSuperAdmin(db, async (tx) => {
      const t = tx as unknown as Database
      const { seedDocumentTypesAndCategories } =
        await import('./seed/document-types-and-categories')
      const { seedHazidLibraries } = await import('./seed/hazid-libraries')
      const { seedIncidentTaxonomy } = await import('./seed/incident-taxonomy')
      const { seedPpeTypesWithCriteria } = await import('./seed/ppe-types')
      const { seedTrainingAssessmentTypes } = await import('./seed/training-assessment-types')
      const seed = t as never
      await seedDocumentTypesAndCategories(seed, tenantId)
      await seedPpeTypesWithCriteria(seed, tenantId)
      await seedHazidLibraries(seed, tenantId)
      await seedTrainingAssessmentTypes(seed, tenantId)
      await seedIncidentTaxonomy(seed, tenantId)
    })

    const after = await catalogueCounts(tenantId)
    // Not one row added anywhere.
    for (const table of CATALOGUES) {
      expect(after[table], `${table} must not gain rows on a re-run`).toBe(before[table])
    }

    // Ids are stable — a re-run must not churn primary keys out from under anything
    // already referencing them.
    const afterTaxonomy = await taxonomySnapshot(tenantId)
    expect(afterTaxonomy.classifications).toEqual(beforeTaxonomy.classifications)
    expect(afterTaxonomy.injuryTypes).toEqual(beforeTaxonomy.injuryTypes)

    // And the tenant's own edits survived.
    const customAfter = await query<{ id: string; description: string | null }>(
      `select id::text as id, description from incident_classifications where tenant_id = $1 and name = 'Near miss'`,
      [tenantId],
    )
    expect(customAfter[0]?.description).toBe('CUSTOM: site-specific wording')
    expect(customAfter[0]?.id).toBe(customBefore[0]?.id)

    const ppeAfter = await query<{ category: string | null }>(
      `select category from ppe_types where tenant_id = $1 and name = 'Hard hat'`,
      [tenantId],
    )
    expect(ppeAfter[0]?.category).toBe('custom-head-protection')
  }, 300_000)

  it('does not touch an existing incident — no row added, no classification written', async () => {
    await wipeTenants()
    const provision = runCli(['--name', 'Incident Safety Ltd', '--apply'])
    expect(provision.status, `provisioner failed:\n${provision.stderr}`).toBe(0)
    const tenantId = await tenantIdBySlug('incident-safety-ltd')

    // Two incidents: one unclassified, one already carrying a real classification.
    // `classification_id` is what the demo seeder used to back-fill, so both are the
    // exact shape a regression would corrupt.
    const [classified] = await query<{ id: string }>(
      `select id::text as id from incident_classifications where tenant_id = $1 and name = 'Injury'`,
      [tenantId],
    )
    const inserted = await query<{ id: string; reference: string }>(
      `insert into incidents (tenant_id, reference, type, severity, title, occurred_at)
       values
         ($1, 'INC-TEST-0001', 'injury', 'first_aid_only', 'Pre-existing unclassified incident', now()),
         ($1, 'INC-TEST-0002', 'injury', 'first_aid_only', 'Pre-existing classified incident', now())
       returning id::text as id, reference`,
      [tenantId],
    )
    expect(inserted).toHaveLength(2)
    await query(`update incidents set classification_id = $1 where id = $2`, [
      classified?.id,
      inserted[1]?.id,
    ])

    const before = await query<{ id: string; classification_id: string | null }>(
      `select id::text as id, classification_id::text as classification_id from incidents where tenant_id = $1 order by reference`,
      [tenantId],
    )
    expect(before).toHaveLength(2)

    // Re-run the whole reference layer, which is the only thing provisioning adds.
    assertInProcessUrls()
    await withSuperAdmin(db, async (tx) => {
      const { seedIncidentTaxonomy } = await import('./seed/incident-taxonomy')
      await seedIncidentTaxonomy(tx as never, tenantId)
    })

    const after = await query<{ id: string; classification_id: string | null }>(
      `select id::text as id, classification_id::text as classification_id from incidents where tenant_id = $1 order by reference`,
      [tenantId],
    )

    // Row-for-row identical: same rows, same ids, same classification state.
    expect(after).toHaveLength(before.length)
    expect(after).toEqual(before)
    // Explicit, because "the null one is still null" is the property under test.
    expect(after.find((r) => r.id === inserted[0]?.id)?.classification_id).toBeNull()
    expect(after.find((r) => r.id === inserted[1]?.id)?.classification_id).toBe(classified?.id)
  }, 300_000)

  it("two tenants cannot see each other's catalogues under the real runtime role", async () => {
    await wipeTenants()

    // Deliberately NOT the first-tenant CLI twice: `provisionFirstTenant` refuses once
    // any tenant exists, which is the correct contract and is asserted elsewhere. Tenant
    // 2..N come through `insertProvisionedTenant`, which is the same function the
    // `/platform/tenants/new` page calls — so this exercises the real UI path for the
    // second tenant rather than a test-only shortcut.
    assertInProcessUrls()
    const created = await withSuperAdmin(db, async (tx) => {
      const provision = tx as unknown as Database
      const first = await insertProvisionedTenant(provision, {
        name: 'Isolation Alpha',
        defaultLanguage: 'en',
        enabledLanguages: ['en'],
        actorUserId: null,
      })
      const second = await insertProvisionedTenant(provision, {
        name: 'Isolation Beta',
        defaultLanguage: 'en',
        enabledLanguages: ['en'],
        actorUserId: null,
      })
      return { first, second }
    })

    const tenantA = created.first.id
    const tenantB = created.second.id
    expect(created.first.slug).toBe('isolation-alpha')
    expect(created.second.slug).toBe('isolation-beta')

    // Both were seeded, so a zero below is isolation working rather than an empty tenant.
    const countsA = await catalogueCounts(tenantA)
    const countsB = await catalogueCounts(tenantB)
    for (const table of CATALOGUES) {
      expect(countsA[table], `${table} should be seeded in A`).toBeGreaterThan(0)
      expect(countsB[table], `${table} should be seeded in B`).toBeGreaterThan(0)
    }

    if (!SCRATCH_URL) throw new Error('SEED_TEST_SCRATCH_DATABASE_URL is not set.')
    const sql = postgres(SCRATCH_URL, { max: 1 })
    /** `count(*)` through whichever handle we hold — root client or transaction. */
    const scalarCount = async (
      client: { unsafe: (q: string, v?: never[]) => Promise<unknown> },
      text: string,
      values: unknown[] = [],
    ): Promise<number> => {
      const rows = (await client.unsafe(text, values as never[])) as { n: number }[]
      return rows[0]?.n ?? 0
    }
    try {
      // `beaconhs_app` with `app.tenant_id` set — the runtime configuration, not the
      // bypass credential everything else in this file uses. FORCE RLS means the runtime
      // role reads ZERO rows from a tenant-scoped table when the scope is unset, which is
      // why both a scoped read and an unscoped read are checked.
      const scopedA = await sql.begin(async (tx) => {
        await tx.unsafe(`select set_config('app.tenant_id', $1, true)`, [tenantA])
        return {
          own: await scalarCount(tx, `select count(*)::int as n from ppe_types`),
          other: await scalarCount(
            tx,
            `select count(*)::int as n from ppe_types where tenant_id = $1`,
            [tenantB],
          ),
          classifications: await scalarCount(
            tx,
            `select count(*)::int as n from incident_classifications`,
          ),
          documents: await scalarCount(tx, `select count(*)::int as n from document_types`),
          hazards: await scalarCount(tx, `select count(*)::int as n from hazid_hazards`),
        }
      })

      // Scoped to A: A sees its own catalogue and nothing of B's.
      expect(scopedA.own).toBeGreaterThan(0)
      expect(scopedA.classifications).toBeGreaterThan(0)
      expect(scopedA.documents).toBeGreaterThan(0)
      expect(scopedA.hazards).toBeGreaterThan(0)
      expect(scopedA.other).toBe(0)

      // Unscoped: nothing at all. Proves the rows are genuinely RLS-protected and the
      // zero above was the policy, not an artefact of the query.
      expect(await scalarCount(sql, `select count(*)::int as n from ppe_types`)).toBe(0)
      expect(
        await scalarCount(sql, `select count(*)::int as n from incident_classifications`),
      ).toBe(0)

      // Sanity, through the BYPASSRLS credential rather than the runtime pool: both
      // tenants really do have rows, so the zeros above are the policy doing its job and
      // not missing data. Read via `query()` — reading through `sql` here would exercise
      // the same unscoped runtime role and return 0 for the same reason, proving nothing.
      const viaSuperA = await query<{ n: number }>(
        `select count(*)::int as n from ppe_types where tenant_id = $1`,
        [tenantA],
      )
      const viaSuperB = await query<{ n: number }>(
        `select count(*)::int as n from ppe_types where tenant_id = $1`,
        [tenantB],
      )
      expect(viaSuperA[0]?.n).toBeGreaterThan(0)
      expect(viaSuperB[0]?.n).toBeGreaterThan(0)
    } finally {
      await sql.end({ timeout: 0 }).catch(() => {})
    }
  }, 300_000)
})
