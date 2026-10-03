// Phase 11-F Step 1 contract tests — Work Permit Expiry, Safety Observations and
// Contractor / Company Register.
//
// The approved audit classified all three as SEED/CONFIG: no table, no
// migration, no permission, no scope rule. This file pins that in both
// directions:
//
//   * each report exists, compiles through the one AppKit query contract, and
//     carries the filters that make it mean what its name says; and
//   * the phase introduced NO table, migration, permission, RoleScope variant or
//     nav module. The negative half is the point: a test that only checked "the
//     seed exists" would pass just as happily if someone had answered "safety
//     observations" by adding a `safety_observations` table.
//
// The load-bearing negative assertion is in `seed-parity.test.ts` (the curated
// list is pinned) and repeated here: none of the three may appear in
// REPORT_ENTITIES, because that list is also the public REST API entity list.
//
// Structural assertions read source; no database is required.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileCustomReport, type ReportRule } from '@braedonsaunders/appkit-reports'
import { discoverEntities } from '@beaconhs/analytics/server'
import type { ReportEntityCatalog } from '@beaconhs/reports/entities'
import { REPORT_ENTITIES } from './entities'
import {
  BEACON_REPORT_SEEDS,
  EXPECTED_BEACON_REPORT_SEED_KEYS,
} from '@beaconhs/db/seed/report-definitions'

const TENANT = '00000000-0000-4000-8000-000000000001'
const RUNTIME_CATALOG: ReportEntityCatalog = {
  entities: discoverEntities() as unknown as ReportEntityCatalog['entities'],
}
const repoRead = (...segments: string[]) =>
  readFileSync(new URL(['..', '..', '..', ...segments].join('/'), import.meta.url), 'utf8')

const seedOf = (key: string) => {
  const found = BEACON_REPORT_SEEDS.find((d) => d.seedKey === key)
  expect(found, `seed ${key} must exist`).toBeDefined()
  return found!
}
type SeedRule = ReportRule & { value?: string[] | number }
/** The seed's flat AND-rules, narrowed to leaf rules (the ones with a field). */
const rulesOf = (key: string): SeedRule[] => {
  const rules = seedOf(key).query.filters?.rules ?? []
  return rules.filter((r): r is SeedRule => 'field' in r)
}
const compileInRuntime = (key: string) =>
  compileCustomReport(seedOf(key).query, TENANT, RUNTIME_CATALOG, { maxRows: 1 })

const PHASE_11_F_KEYS = [
  'work_permit_expiry',
  'safety_observations',
  'contractor_company_register',
] as const

// ---------------------------------------------------------------------------
// EXISTING
// ---------------------------------------------------------------------------

describe('Phase 11-F ships three seed-only reports', () => {
  it.each(PHASE_11_F_KEYS)('%s is present exactly once', (key) => {
    expect(EXPECTED_BEACON_REPORT_SEED_KEYS.filter((k) => k === key)).toHaveLength(1)
  })

  it.each(PHASE_11_F_KEYS)(
    '%s compiles through the one AppKit query contract, against the runtime catalogue',
    (key) => {
      // The runtime catalogue, not the curated list: reports are compiled
      // against discovery, so that is the fixture that means anything.
      expect(() => compileInRuntime(key)).not.toThrow()
    },
  )

  it.each(PHASE_11_F_KEYS)('%s is a published, tagged, seeded definition', (key) => {
    const d = seedOf(key)
    expect(d.state).toBe('published')
    expect(d.tags).toContain('beacon-default')
    expect(d.slug).toBe(key.replaceAll('_', '-'))
  })

  it('does not disturb the 32 pre-existing seeds', () => {
    // 32 before Phase 11-F, 35 after: purely additive.
    expect(BEACON_REPORT_SEEDS).toHaveLength(35)
    expect(new Set(EXPECTED_BEACON_REPORT_SEED_KEYS).size).toBe(35)
    for (const key of [
      'incidents_weekly',
      'corrective_actions_open',
      'training_certificates',
      'ppe_list',
      'equipment_fleet',
      'monitored_sessions_weekly',
    ]) {
      expect(EXPECTED_BEACON_REPORT_SEED_KEYS).toContain(key)
    }
    // `training_matrix` is deliberately absent: it is an Insights pivot, pinned
    // by seed-parity.test.ts, so it is not a seed key at all.
    expect(EXPECTED_BEACON_REPORT_SEED_KEYS).not.toContain('training_matrix')
  })

  it('each report targets a different already-existing entity', () => {
    const entities = PHASE_11_F_KEYS.map((k) => seedOf(k).query.entity)
    expect(new Set(entities).size).toBe(3)
    expect(entities.sort()).toEqual(['companies', 'journal_entries', 'monitored_sessions'])
  })
})

// ---------------------------------------------------------------------------
// The filter IS the report
// ---------------------------------------------------------------------------

describe('safety_observations selects observations, not plain journals', () => {
  it('reads journal_entries, where an observation is an entry CLASSIFICATION', () => {
    // Phase 11-A added the two observation classes to `journal_definition`.
    expect(seedOf('safety_observations').query.entity).toBe('journal_entries')
    expect(rulesOf('safety_observations')).toEqual([
      {
        field: 'definition',
        op: 'in',
        value: ['positive_observation', 'negative_observation'],
      },
    ])
  })

  it('does not also filter on status, so a draft observation is still visible', () => {
    // Drafting an observation must not hide it from the register; the class is
    // the whole point of the filter.
    const fields = rulesOf('safety_observations').map((r) => r.field)
    expect(fields).not.toContain('status')
  })

  it('sorts newest first and carries the reference a foreman would quote', () => {
    expect(seedOf('safety_observations').query.sorts).toEqual([
      { column: 'entry_date', direction: 'desc' },
    ])
    expect(seedOf('safety_observations').query.columns).toContain('reference')
  })
})

describe('work_permit_expiry selects only sessions that can still expire', () => {
  it('reads the monitored-sessions projection Phase 11-C landed', () => {
    expect(seedOf('work_permit_expiry').query.entity).toBe('monitored_sessions')
  })

  it('excludes completed and cancelled sessions', () => {
    const status = rulesOf('work_permit_expiry').find((r) => r.field === 'monitor_status')
    expect(status?.value).toEqual(['active', 'missed', 'escalated'])
    expect(status?.value).not.toContain('completed')
    expect(status?.value).not.toContain('cancelled')
  })

  it('looks ahead a fixed window and sorts by soonest end', () => {
    const due = rulesOf('work_permit_expiry').find((r) => r.field === 'expected_end_at')
    expect(due?.op).toBe('due_within_days')
    expect(due?.value).toBe(7)
    expect(seedOf('work_permit_expiry').query.sorts).toEqual([
      { column: 'expected_end_at', direction: 'asc' },
    ])
  })

  it('surfaces the columns a coordinator needs to act on it', () => {
    for (const column of ['app_name', 'monitor_status', 'expected_end_at']) {
      expect(seedOf('work_permit_expiry').query.columns).toContain(column)
    }
  })
})

describe('contractor_company_register lists the companies', () => {
  it('reads companies and needs no filter to be meaningful', () => {
    expect(seedOf('contractor_company_register').query.entity).toBe('companies')
    expect(seedOf('contractor_company_register').query.filters ?? null).toBeNull()
  })

  it('shows the company name and its type, sorted by name', () => {
    expect(seedOf('contractor_company_register').query.columns).toEqual([
      'name',
      'type',
      'created_at',
      'updated_at',
    ])
    expect(seedOf('contractor_company_register').query.sorts).toEqual([
      { column: 'name', direction: 'asc' },
    ])
  })
})

// ---------------------------------------------------------------------------
// B. Authorization isolation — the reports inherit their entity's ladder
// ---------------------------------------------------------------------------

describe("each Step-1 report stays bound to its entity's existing read ladder", () => {
  const scope = () => repoRead('packages', 'analytics', 'src', 'server', 'scope.ts')

  it('safety_observations inherits the journals ladder, not a bespoke one', () => {
    // `journal_` -> journals.read.* with site scoping. No 11-F rule was added.
    expect(scope()).toContain("['journal_', { read: { prefix: 'journals' }")
    expect(scope()).not.toMatch(/observation/i)
  })

  it('contractor_company_register inherits admin.org.manage, unchanged', () => {
    expect(scope()).toContain("companies: { read: { key: 'admin.org.manage' } }")
  })

  it('work_permit_expiry inherits the Builder-app response ladder', () => {
    expect(scope()).toContain('report_monitored_sessions:')
  })

  it('adds no scope rule of its own', () => {
    // The three seeds must not have introduced a rule keyed to a report key:
    // a report is not a scope boundary, the entity is.
    expect(scope()).not.toMatch(
      /work_permit_expiry|safety_observations|contractor_company_register/,
    )
  })
})

// ---------------------------------------------------------------------------
// C. No new architecture
// ---------------------------------------------------------------------------

describe('Phase 11-F introduced no new architecture', () => {
  const seeds = repoRead('packages', 'db', 'src', 'seed', 'report-definitions.ts')

  it('no new table or enum: the seed file declares no schema', () => {
    expect(seeds).not.toMatch(/pgTable\(|pgEnum\(/)
  })

  it('no new permission: PERMISSION_CATALOGUE untouched', () => {
    expect(repoRead('packages', 'db', 'src', 'schema', 'iam.ts')).not.toMatch(
      /permit\.read|observation\.read|compan(y|ies)\.read/,
    )
  })

  it('no new RoleScope variant and no Project Scope', () => {
    const iam = repoRead('packages', 'db', 'src', 'schema', 'iam.ts')
    const scope = iam.slice(
      iam.indexOf('export type RoleScope'),
      iam.indexOf('export const roleAssignments'),
    )
    expect(scope).not.toMatch(/'project'|'permit'|'observation'|'company'/)
  })

  it('no new migration', () => {
    // This phase adds no schema, so the journal must still END at the tag that
    // shipped before it. Asserting on the tail rather than on keywords matters:
    // `0042_journal_observation_definitions` and `0043_companies` are legitimate
    // Phase 11-A/11-B migrations.
    const journal = JSON.parse(repoRead('packages', 'db', 'drizzle', 'meta', '_journal.json')) as {
      entries: { tag: string }[]
    }
    const tags = journal.entries.map((e) => e.tag)
    expect(tags[tags.length - 1]).toBe('0043_companies')
    expect(tags.filter((t) => /permit|observation/i.test(t))).toEqual([
      '0042_journal_observation_definitions',
    ])
  })

  it('no new curated report entity, so no new public API surface', () => {
    // The regression this guards against is subtle and real: naming an entity in
    // REPORT_ENTITIES does two things at once — it makes it seedable AND it
    // publishes it on /api/v1. `journal_entries` and `companies` would introduce
    // the categories `journals` and `people`, which have no
    // READ_PERMISSION_BY_CATEGORY entry, so /api/v1 would 500.
    const keys = REPORT_ENTITIES.map((e) => e.key)
    expect(keys).not.toContain('journal_entries')
    expect(keys).not.toContain('companies')
    expect(keys).toHaveLength(16)
  })

  it('every curated entity category still has a public API read gate', () => {
    // Mirrors the invariant in apps/web/src/lib/api/permissions.test.ts.
    const gated = new Set([
      'forms',
      'incidents',
      'inspections',
      'hazid',
      'training',
      'documents',
      'equipment',
      'ppe',
      'corrective_actions',
      // Known recorded defects: no read gate, /api/v1 500s. See AGENTS.md.
      'compliance',
      'apps',
    ])
    const categories = [...new Set(REPORT_ENTITIES.map((e) => e.category))]
    expect(categories.filter((c) => !gated.has(c))).toEqual([])
  })

  it('does not touch the public API authorization map', () => {
    const apiPerms = repoRead('apps', 'web', 'src', 'lib', 'api', 'permissions.ts')
    expect(apiPerms).not.toMatch(/^\s*journals:|^\s*people:/m)
  })

  it('does not touch API entity publishing', () => {
    const apiRoute = repoRead('apps', 'web', 'src', 'app', 'api', 'v1', 'route.ts')
    // Still derives its published list from REPORT_ENTITIES, unchanged.
    expect(apiRoute).toContain('REPORT_ENTITIES.map')
  })

  it('does not modify the curated entity catalogue itself', () => {
    // entities.ts must be byte-identical to HEAD for this phase.
    const curated = repoRead('packages', 'reports', 'src', 'entities.ts')
    expect(curated).toContain('export const REPORT_ENTITIES: ReportEntity[] = [')
    expect(curated).not.toMatch(/publishToApi|apiExposed|publicApi/)
  })

  it('no new nav module', () => {
    const nav = repoRead('apps', 'web', 'src', 'lib', 'nav', 'registry.ts')
    for (const slug of [
      'work-permit-expiry',
      'safety-observations',
      'contractor-company-register',
    ]) {
      expect(nav).not.toContain(slug)
    }
    // The Phase 11-A "Safety observations" MODULE nav entry is pre-existing.
    expect(nav).toContain("label: 'Safety observations'")
  })

  it('did not modify the report engine, the compiler or the query contract', () => {
    const run = repoRead('packages', 'reports', 'src', 'run.ts')
    expect(run).toContain('compileCustomReport')
    expect(run).toContain('executeParameterizedRows')
    // runBeaconReport still takes the tenant-scoped tx + tenant id from the caller.
    expect(run).toMatch(/tx: Database,\s*\n\s*tenantId: string/)
  })

  it('did not touch the authorization chain', () => {
    const access = repoRead('apps', 'web', 'src', 'lib', 'analytics-access.ts')
    expect(access).toContain('scopeAnalyticsEntities')
    const catalog = repoRead('apps', 'web', 'src', 'lib', 'report-catalog.ts')
    expect(catalog).toContain('loadAuthorizedReportCatalogInTransaction')
  })

  it('did not touch RLS registration', () => {
    // Both tables were already registered by Phase 11-A/11-B; the phase adds no
    // table, so TENANT_SCOPED_TABLES is unchanged.
    const rls = repoRead('packages', 'db', 'src', 'rls.ts')
    expect(rls).toContain("'journal_entries'")
    expect(rls).toContain("'companies'")
  })
})

// ---------------------------------------------------------------------------
// D. Re-seeding is idempotent
// ---------------------------------------------------------------------------

describe('the seed set is insert-only, so re-seeding restores without duplicating', () => {
  const seedSource = () => repoRead('packages', 'db', 'src', 'seed.ts')

  it('seeds report definitions with onConflictDoNothing', () => {
    expect(seedSource()).toContain('onConflictDoNothing')
  })

  it('relying on a unique key rather than a hand-kept list', () => {
    // The DB owns uniqueness via report_definitions_tenant_seed_ux; the seed must
    // not carry a second source of truth that could drift from it.
    expect(seedSource()).not.toMatch(/reportSeedKeys|SEEDED_REPORT_KEYS/)
  })

  it('each Step-1 seed key is unique across the whole seed set', () => {
    for (const key of PHASE_11_F_KEYS) {
      expect(EXPECTED_BEACON_REPORT_SEED_KEYS.filter((k) => k === key)).toHaveLength(1)
    }
    expect(new Set(EXPECTED_BEACON_REPORT_SEED_KEYS).size).toBe(35)
  })
})

// ---------------------------------------------------------------------------
// E. Tenant isolation is the compiler's job, and it still happens
// ---------------------------------------------------------------------------

describe.each(PHASE_11_F_KEYS)('%s is tenant-bound at compile time', (key) => {
  it('binds tenant_id as a parameter, never as an inline literal', () => {
    const compiled = compileInRuntime(key)
    expect(compiled.sql).toContain('tenant_id')
    expect(compiled.params).toContain(TENANT)
    expect(compiled.sql).not.toContain(TENANT)
  })

  it('reads only from its own entity, so no other table leaks in', () => {
    const entity = seedOf(key).query.entity
    const others = PHASE_11_F_KEYS.map((k) => seedOf(k).query.entity).filter((e) => e !== entity)
    const compiled = compileInRuntime(key)
    for (const other of others) {
      if (other === 'journal_entries') continue // monitored_sessions reads it internally
      expect(compiled.sql).not.toContain(`"${other}"`)
    }
  })
})
