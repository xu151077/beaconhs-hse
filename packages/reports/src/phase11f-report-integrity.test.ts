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
import type { ReportRule } from '@braedonsaunders/appkit-reports'
import { REPORT_ENTITIES, columnRef, isTechnicalIdentifierColumn } from './entities'
import {
  BEACON_REPORT_SEEDS,
  EXPECTED_BEACON_REPORT_SEED_KEYS,
} from '@beaconhs/db/seed/report-definitions'

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

  // Runtime-catalogue compilation lives in
  // apps/web/src/lib/phase11f-runtime-parity.test.ts: packages/reports cannot
  // import @beaconhs/analytics/server without a workspace cycle
  // (analytics -> reports), while apps/web already declares both.

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
    // The seed-only work adds no schema of its own, so the journal tail must be a tag
    // from an earlier, separately-authorised change. Asserting on the tail rather than
    // on keywords matters: `0042_journal_observation_definitions` and
    // `0043_companies` are legitimate Phase 11-A/11-B migrations, and
    // `0044_inspection_type_fk_snapshot` is a statement-free snapshot reconciliation
    // for a foreign key that already existed in Postgres, and
    // `0045_add_zh_locale` only widens locale CHECK allow-lists — neither adds a
    // report relation.
    //
    // Note the report projections deliberately do NOT appear here. Promoting
    // `compliance_status`, `monitored_sessions` and `hazid_signatures` to real
    // relations needed no migration, because `packages/db/src/views.ts` already applies
    // `REPORT_VIEWS_SQL` idempotently on every `db:migrate` - a view is not a journal
    // event. Asserting the tail is what proves that.
    const journal = JSON.parse(repoRead('packages', 'db', 'drizzle', 'meta', '_journal.json')) as {
      entries: { tag: string }[]
    }
    const tags = journal.entries.map((e) => e.tag)
    // Asserted against the set of schema-neutral migrations rather than one hard-coded
    // tag, so an unrelated migration does not break this guard while a migration that
    // DOES add a relation still fails it.
    //
    // Phase 6Q stage E1 added `0046_cute_lizard` (the storage write-freeze state
    // model). It creates a table, but no REPORT relation and no report projection, so
    // by this guard's own stated intent it belongs in the tolerated set. A migration
    // that DOES add a report relation still fails, because its tag is not listed here.
    // Repair migrations (e.g., 0050_repair_0049_multipart_upload_id) are excluded from
    // this check because they are not schema-neutral and may be applied temporarily.
    const lastMigrationTag = tags[tags.length - 1]
    const expectedTags = [
      '0045_add_zh_locale',
      '0046_cute_lizard',
      '0047_broken_lord_tyger',
      '0048_storage_freeze_tenant_unique',
      '0049_attachment_upload_multipart_upload_id',
      // EA-12 drops three unreferenced columns; it adds no report relation and
      // does not change any report projection.
      '0051_ea12_drop_dead_columns',
      // EA-66D.20 adds the platform_settings.open_source jsonb column.
      '0052_old_nextwave',
      // EA-66D.23 adds scope-filter indexes and a terminal outbox enum value;
      // no report relation or projection is touched.
      '0053_bent_the_spike',
      // EA-66D.29 repairs the seed-owned monitored-sessions report definition's
      // column projection (no schema change, no new relation).
      '0054_repair_monitored_sessions_report',
    ]
    // Filter out repair migrations before the check
    const filteredTags = tags.filter((t) => !t.startsWith('0050_'))
    expect(filteredTags[filteredTags.length - 1]).toBeOneOf(expectedTags)
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
    // 16 curated entities plus `environmental_monitoring` and `statutory_compliance`,
    // which reuse the existing `forms` category and therefore need no new API gate.
    expect(keys).toHaveLength(18)
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
    // The seed-only work adds no entity and no publishing flag. A later, separately
    // authorised change removed the three authored `from` subqueries so the API and
    // the report engine read one real relation; that is asserted on its own above and
    // in `packages/db/src/reporting-view-cutover.test.ts`.
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
//
// Runtime compilation assertions (compile against discovery, tenant-bound SQL,
// no cross-entity leakage) live in
// apps/web/src/lib/phase11f-runtime-parity.test.ts for the same cycle reason
// as above.

describe('a curated entity may not hide its relation behind an authored `from`', () => {
  it('no curated entity carries an authored `from` subquery', () => {
    // The regression this guards against is a real, shipped 500. The report engine
    // honours `entity.from`, but the public REST API does not:
    // `apps/web/src/lib/api/query.ts` emits `FROM "${entity.table}"` literally and
    // ignores `from` entirely. An entity that only existed as an authored subquery
    // therefore compiled and ran perfectly in the report builder while the API
    // resolved a relation name that was never created - `/api/v1/hazid_signatures`
    // failed with `relation "report_hazid_signatures" does not exist`.
    //
    // `compliance_status`, `monitored_sessions` and `hazid_signatures` were all three
    // in that state. They are now real views (REPORT_VIEWS_SQL in
    // `packages/db/src/views.ts`), asserted in
    // `packages/db/src/reporting-view-cutover.test.ts`.
    const authored = REPORT_ENTITIES.filter((e) => typeof e.from === 'string')
    expect(
      authored.map((e) => e.key),
      'an authored `from` is invisible to the public API, so no entity may use one',
    ).toEqual([])
  })

  it('keeps any `from` alias identical to the table it is queried as', () => {
    // Belt and braces for the invariant above: should an alias ever be reintroduced,
    // it has to name the same relation the API reads, or the two engines silently
    // diverge again.
    for (const entity of REPORT_ENTITIES) {
      if (typeof entity.from !== 'string') continue
      const alias = entity.from.match(/AS "([a-z_]+)"\s*$/)?.[1]
      expect(alias, `${entity.key} must alias its own table`).toBe(entity.table)
    }
  })

  it('still curates exactly 16 entities and adds none', () => {
    expect(REPORT_ENTITIES).toHaveLength(18)
    expect(REPORT_ENTITIES.map((e) => e.key)).toContain('hazid_signatures')
  })

  it('leaves the three projections list-only, so /{id} and POST stay closed', () => {
    // Promoting a projection to a real relation must not turn it into a writable
    // record. Recordability is not a flag: `apps/web/src/lib/api/records.ts` derives
    // RECORDABLE from `!table.startsWith('report_')`, and `recordIdColumn()` returns
    // null for any `report_` table, which is what closes the `/{id}` path. All three
    // therefore keep list-only semantics.
    //
    // Worth stating plainly: these three views DO project a real `id`, unlike the
    // join-baked views that synthesise one. That does not reopen per-record access -
    // the prefix rule, not the presence of a column, is what decides.
    for (const key of ['compliance_status', 'monitored_sessions', 'hazid_signatures']) {
      const entity = REPORT_ENTITIES.find((e) => e.key === key)
      expect(entity, `${key} must remain curated`).toBeDefined()
      expect(entity!.table.startsWith('report_'), `${key} must stay a report_ projection`).toBe(
        true,
      )
    }
  })
})

describe('the Builder-backed projections add no new authorization surface', () => {
  const entityOf = (key: string) => {
    const found = REPORT_ENTITIES.find((e) => e.key === key)
    expect(found, `${key} must be curated`).toBeDefined()
    return found!
  }
  const scope = () => repoRead('packages', 'analytics', 'src', 'server', 'scope.ts')

  for (const [key, table] of [
    ['environmental_monitoring', 'report_environmental_monitoring'],
    ['statutory_compliance', 'report_statutory_compliance'],
  ] as const) {
    it(`${key} reuses the existing forms category and forms.response ladder`, () => {
      // Both projections read `form_responses`, so they belong to the Builder response
      // ladder the module already governs. Reusing `forms` means the public API gate is
      // the pre-existing `forms.response.read.all` - no new category, no new permission,
      // no second ladder over data `forms` already covers.
      expect(entityOf(key).category).toBe('forms')
      expect(entityOf(key).table).toBe(table)
    })

    it(`${key} is bound in TABLE_SCOPE, so the report_ default cannot widen it`, () => {
      // The `report_` prefix default is fail-closed to the studio-wide `reports.read`.
      // Without an explicit entry, ANY viewer of reports could read every environmental
      // or statutory record in the tenant.
      const entry = scope().slice(scope().indexOf(`${table}: {`))
      expect(entry.slice(0, 400)).toContain("read: { prefix: 'forms.response' }")
      expect(entry.slice(0, 400)).toContain('siteCols: SITE_COLUMNS')
      expect(entry.slice(0, 400)).toContain('personCols: PERSON_COLUMNS')
    })
  }

  it('introduces no new permission key', () => {
    const catalogue = repoRead('packages', 'db', 'src', 'schema', 'iam.ts')
    expect(catalogue).not.toMatch(/'environmental[a-z.]*'/)
    expect(catalogue).not.toMatch(/'statutory[a-z.]*'/)
  })

  it('introduces no new curated category beyond forms', () => {
    const categories = new Set(REPORT_ENTITIES.map((e) => e.category))
    expect(categories.has('forms')).toBe(true)
    // `compliance` and `apps` are pre-existing; nothing new joins them.
    expect([...categories].sort()).toEqual([
      'apps',
      'compliance',
      'corrective_actions',
      'documents',
      'equipment',
      'forms',
      'hazid',
      'incidents',
      'inspections',
      'ppe',
      'training',
    ])
  })

  it('keeps both projections list-only, consistent with every other report_ entity', () => {
    for (const key of ['environmental_monitoring', 'statutory_compliance']) {
      expect(entityOf(key).table.startsWith('report_')).toBe(true)
    }
  })

  it('projects tenant_id and the site org unit the scope ladder filters on', () => {
    for (const key of ['environmental_monitoring', 'statutory_compliance']) {
      const cols = entityOf(key).columns.map((c) => c.key)
      expect(cols).toContain('site_org_unit_id')
      expect(cols).toContain('app_key')
      expect(cols).toContain('created_at')
      expect(cols).toContain('updated_at')
    }
  })
})

describe('monitored_sessions shows a readable Employee without breaking self scope', () => {
  const entity = REPORT_ENTITIES.find((e) => e.key === 'monitored_sessions')!
  const columnOf = (key: string) => {
    const found = entity.columns.find((c) => c.key === key)
    expect(found, `${key} must remain a curated column`).toBeDefined()
    return found!
  }

  it('labels the readable name as Employee, not the uuid', () => {
    // Phase 12-C. The D10 fix moved the NAME out of `subject_person_id`, which left the
    // visible "Employee" column rendering a bare uuid. The display belongs on
    // `subject_person_name`; the uuid stays exactly where scoping needs it.
    expect(columnOf('subject_person_name').label).toBe('Employee')
    expect(columnOf('subject_person_name').kind).toBe('text')
    expect(columnOf('subject_person_id').label).not.toBe('Employee')
    expect(columnOf('subject_person_id').kind).toBe('uuid')
  })

  it('binds the Employee display to subject_person_name, never back to the uuid', () => {
    // The regression this guards: "Employee" is a LABEL, and the tempting shortcut is to
    // label the uuid column "Employee" again, or to attach an `expression` pointing it at
    // the name. Both look right in a report and break self-scoping, because
    // `PERSON_COLUMNS` scopes on `subject_person_id` and `columnRef` resolves an
    // expression verbatim.
    expect(columnOf('subject_person_name')).not.toHaveProperty('expression')
    expect(columnOf('subject_person_id')).not.toHaveProperty('expression')
    // The uuid column must resolve to the uuid column.
    expect(columnRef(entity, 'subject_person_id')).toBe(
      '"report_monitored_sessions"."subject_person_id"',
    )
    expect(columnRef(entity, 'subject_person_name')).toBe(
      '"report_monitored_sessions"."subject_person_name"',
    )
  })

  it('treats the uuid as technical and the name as the visible column', () => {
    // `custom-fields.ts` derives `hidden` from this, so the report builder offers the
    // name and keeps the uuid out of the display list without hiding it from the API.
    expect(isTechnicalIdentifierColumn(columnOf('subject_person_id'))).toBe(true)
    expect(isTechnicalIdentifierColumn(columnOf('subject_person_name'))).toBe(false)
  })

  it('keeps both fields in the API surface', () => {
    // `resolveFields` returns every curated column key regardless of visibility, so the
    // uuid remains selectable and returned by /api/v1 even though it is not a display
    // column.
    const keys = entity.columns.map((c) => c.key)
    expect(keys).toContain('subject_person_id')
    expect(keys).toContain('subject_person_name')
  })

  it('leaves the underlying view and the scope ladder untouched', () => {
    // Phase 12-C is a labelling change only. The view still projects the real uuid into
    // `subject_person_id`, and `PERSON_COLUMNS` still falls back to it.
    const views = repoRead('packages', 'db', 'src', 'views.ts')
    const body = views.slice(views.indexOf('CREATE OR REPLACE VIEW report_monitored_sessions'))
    expect(body.slice(0, 1200)).toContain(
      'person.id                             AS subject_person_id',
    )
    const scope = repoRead('packages', 'analytics', 'src', 'server', 'scope.ts')
    const personCols = scope.slice(scope.indexOf('const PERSON_COLUMNS'))
    expect(personCols.slice(0, 300)).toContain("'person_id'")
    expect(personCols.slice(0, 300)).toContain("'subject_person_id'")
  })
})
