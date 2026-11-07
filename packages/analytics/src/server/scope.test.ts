import { describe, expect, it } from 'vitest'
import type { RoleScope } from '@beaconhs/db/schema'
import type { AnalyticsEntity } from '../semantic'
import { discoverEntities } from './discover'
import {
  analyticsScopeFingerprint,
  runScopeSpecValidation,
  scopeAnalyticsEntities,
  siteIdsFromScopes,
  validateScopeSpecs,
  validateTenantLevelColumns,
  type AnalyticsScopeSubject,
} from './scope'

function entity(over: Partial<AnalyticsEntity> & { table: string }): AnalyticsEntity {
  return {
    key: over.table,
    label: over.table,
    category: 'Test',
    columns: [],
    ...over,
  } as AnalyticsEntity
}

/**
 * A subject for the READ TIER ladder.
 *
 * It defaults to `unrestricted`, which is what isolates this file: these cases
 * assert what a permission tier does, and an unrestricted caller is the only way
 * to observe that in isolation — since 15B-3B, a caller inside a Project Scope
 * also carries a row predicate, so a tier assertion would otherwise be reading a
 * combination of two rules. The Project Scope dimension has its own describe
 * block at the end of this file.
 */
function subject(over: Partial<AnalyticsScopeSubject> = {}): AnalyticsScopeSubject {
  return {
    isSuperAdmin: false,
    permissions: () => false,
    siteIds: [],
    personId: null,
    tenantUserId: null,
    ...over,
  }
}

const SITE_A = '018f47ba-86c4-7ee2-8d7a-5e7602f2a001'
const SITE_B = '018f47ba-86c4-7ee2-8d7a-5e7602f2a002'

const incidents = entity({
  table: 'incidents',
  columns: [{ key: 'site_org_unit_id', label: 'Site', kind: 'uuid' }] as AnalyticsEntity['columns'],
})
const correctiveActions = entity({
  table: 'corrective_actions',
  columns: [
    { key: 'site_org_unit_id', label: 'Site', kind: 'uuid' },
    { key: 'owner_tenant_user_id', label: 'Owner', kind: 'uuid' },
  ] as AnalyticsEntity['columns'],
})
const trainingCourses = entity({
  table: 'training_courses',
  columns: [{ key: 'site_org_unit_id', label: 'Site', kind: 'uuid' }] as AnalyticsEntity['columns'],
})
/** No location and no owner column: nothing to scope with. */
const unscopeable = entity({ table: 'equipment_categories', columns: [] })
const appResponses = entity({ table: 'app_responses', key: 'app_responses' })
const apiKeys = entity({ table: 'api_keys' })

describe('analytics row-scope rules', () => {
  describe('module read permission', () => {
    it('withholds an entity when the caller holds no read tier for its module', () => {
      const out = scopeAnalyticsEntities(subject({ permissions: () => false }), [incidents])
      expect(out).toEqual([])
    })

    it('grants an unfiltered entity on the module read.all tier', () => {
      const out = scopeAnalyticsEntities(
        subject({ permissions: (key) => key === 'incidents.read.all' }),
        [incidents],
      )
      expect(out).toHaveLength(1)
      expect(out[0]?.baseFilter).toBeUndefined()
    })

    it('grants a super-admin the module without pinning a row filter', () => {
      const out = scopeAnalyticsEntities(subject({ isSuperAdmin: true }), [incidents, unscopeable])
      expect(out.map((e) => e.table).sort()).toEqual(['equipment_categories', 'incidents'])
      expect(out.every((e) => e.baseFilter === undefined)).toBe(true)
    })

    it('keeps platform infrastructure out of the report engine entirely', () => {
      const out = scopeAnalyticsEntities(subject({ isSuperAdmin: true, permissions: () => true }), [
        apiKeys,
      ])
      expect(out).toEqual([])
    })
  })

  describe('site tier', () => {
    it("pins the entity's site column to the caller's resolved site ids", () => {
      const [scoped] = scopeAnalyticsEntities(
        subject({
          permissions: (key) => key === 'incidents.read.site',
          siteIds: [SITE_A, SITE_B],
        }),
        [incidents],
      )
      expect(scoped?.baseFilter).toEqual({
        combinator: 'and',
        rules: [{ field: 'site_org_unit_id', op: 'in', value: [SITE_A, SITE_B] }],
      })
    })

    it('withholds the entity when the site tier resolves to no sites', () => {
      const out = scopeAnalyticsEntities(
        subject({ permissions: (key) => key === 'incidents.read.site', siteIds: [] }),
        [incidents],
      )
      expect(out).toEqual([])
    })

    it('falls back to the owner column when the entity has no site column', () => {
      const noSite = entity({
        table: 'truck_log_entries',
        columns: [
          { key: 'driver_person_id', label: 'Driver', kind: 'uuid' },
        ] as AnalyticsEntity['columns'],
      })
      const [scoped] = scopeAnalyticsEntities(
        subject({
          permissions: (key) => key === 'equipment.read.site',
          siteIds: [SITE_A],
          personId: 'person-9',
        }),
        [noSite],
      )
      // Own rows are strictly narrower than the site scope — a fallback, not a widening.
      expect(scoped?.baseFilter).toEqual({
        combinator: 'and',
        rules: [{ field: 'driver_person_id', op: 'in', value: ['person-9'] }],
      })
    })

    it('withholds rather than widening when neither a site nor an owner column exists', () => {
      const out = scopeAnalyticsEntities(
        subject({
          permissions: (key) => key === 'equipment.read.site',
          siteIds: [SITE_A],
          personId: 'person-9',
        }),
        [unscopeable],
      )
      expect(out).toEqual([])
    })

    it('prefers the site column over the owner column when both exist', () => {
      const [scoped] = scopeAnalyticsEntities(
        subject({
          permissions: (key) => key === 'ca.read.site',
          siteIds: [SITE_A],
          personId: 'person-9',
          tenantUserId: 'member-9',
        }),
        [correctiveActions],
      )
      expect(scoped?.baseFilter).toEqual({
        combinator: 'and',
        rules: [{ field: 'site_org_unit_id', op: 'in', value: [SITE_A] }],
      })
    })
  })

  describe('self tier', () => {
    it('pins the owner column to the caller, never to a site', () => {
      const [scoped] = scopeAnalyticsEntities(
        subject({ permissions: (key) => key === 'ca.read.self', tenantUserId: 'member-9' }),
        [correctiveActions],
      )
      expect(scoped?.baseFilter).toEqual({
        combinator: 'and',
        rules: [{ field: 'owner_tenant_user_id', op: 'in', value: ['member-9'] }],
      })
    })

    it('withholds when the owner identity is not resolved', () => {
      const out = scopeAnalyticsEntities(
        subject({ permissions: (key) => key === 'ca.read.self', tenantUserId: null }),
        [correctiveActions],
      )
      expect(out).toEqual([])
    })
  })

  describe('composition with an existing base filter', () => {
    it("ANDs the row scope under an entity's own base filter instead of replacing it", () => {
      const scopedApp = entity({
        table: 'form_responses',
        key: 'form_responses:abc',
        columns: [
          { key: 'template_id', label: 'Template', kind: 'uuid' },
          { key: 'site_org_unit_id', label: 'Site', kind: 'uuid' },
        ] as AnalyticsEntity['columns'],
        baseFilter: {
          combinator: 'and',
          rules: [{ field: 'template_id', op: 'eq', value: 'abc' }],
        },
      })
      const [scoped] = scopeAnalyticsEntities(
        subject({
          permissions: (key) => key === 'forms.response.read.site',
          siteIds: [SITE_A],
        }),
        [scopedApp],
      )
      expect(scoped?.baseFilter).toEqual({
        combinator: 'and',
        rules: [
          { combinator: 'and', rules: [{ field: 'template_id', op: 'eq', value: 'abc' }] },
          { combinator: 'and', rules: [{ field: 'site_org_unit_id', op: 'in', value: [SITE_A] }] },
        ],
      })
    })

    it('never mutates the input entity', () => {
      const original = { ...incidents }
      scopeAnalyticsEntities(
        subject({ permissions: (key) => key === 'incidents.read.site', siteIds: [SITE_A] }),
        [incidents],
      )
      expect(incidents).toEqual(original)
      expect(incidents.baseFilter).toBeUndefined()
    })
  })

  describe('the tenant-wide system source', () => {
    it('is always present, because its caller gate is separate', () => {
      const out = scopeAnalyticsEntities(subject({ permissions: () => false }), [appResponses])
      expect(out.map((e) => e.key)).toEqual(['app_responses'])
    })

    // The two built-in cards that read `app_responses` are a single `count` each —
    // no `groupBy`, no person, no site, no row-level output — so they are a
    // tenant-wide SYSTEM METRIC and resolve to tier `all`, i.e. no row predicate.
    //
    // The PERMISSION half of the rule is NOT decided here and never was: this layer
    // short-circuits on `ALWAYS_ALLOWED` before the permission is read, which is
    // exactly why the entity is described as "granted, caller gate is separate".
    // `canReadAppResponses` in apps/web is that gate and it admits
    // `forms.response.read.all` only. The permission cases live in
    // `apps/web/src/lib/insights-trusted-card-scope-contract.test.ts`.
    const withTier = (permission: string, siteIds: string[] = [SITE_A]) =>
      scopeAnalyticsEntities(
        subject({
          permissions: (k) => k === permission,
          siteIds,
        }),
        [appResponses],
      )

    it('is unfiltered for a read.all holder, whatever sites they hold (Case B)', () => {
      // The decision `read.site` must not silently inherit: the KPI is a tenant
      // number, so `read.all` still sees it whole. A row filter here would make a
      // system metric inconsistent with itself.
      const out = withTier('forms.response.read.all')
      expect(out.map((e) => e.key)).toEqual(['app_responses'])
      expect(out[0]?.baseFilter).toBeUndefined()
    })

    it('and for a read.all holder who holds NO sites at all (Case G)', () => {
      // A sites Role Scope is not a read permission and cannot narrow the grant.
      // The grant rests on `read.all`, which is a tenant-wide capability in its own
      // right, and an aggregate with no rows has nothing left to narrow.
      const out = withTier('forms.response.read.all', [])
      expect(out.map((e) => e.key)).toEqual(['app_responses'])
      expect(out[0]?.baseFilter).toBeUndefined()
    })

    it('stays unfiltered while an ordinary form-responses read is still scoped', () => {
      // The boundary that must not blur. `form_responses` — the underlying records
      // behind the same rows — keeps its `form_` spec and IS narrowed for a
      // site-scoped caller. Only the alias the two KPI cards use is unfiltered, so
      // "Insights trusted KPI" never becomes "all form responses are tenant-wide".
      const formResponses = entity({
        table: 'form_responses',
        columns: [
          { key: 'site_org_unit_id', label: 'Site', kind: 'uuid' },
          { key: 'subject_person_id', label: 'Subject', kind: 'uuid' },
        ] as AnalyticsEntity['columns'],
      })
      const out = scopeAnalyticsEntities(
        subject({
          permissions: (k) => k === 'forms.response.read.site',
          siteIds: [SITE_A],
        }),
        [appResponses, formResponses],
      )
      const ordinary = out.find((e) => e.key === formResponses.key)
      expect(ordinary, 'the ordinary entity must survive to be filtered').toBeDefined()
      expect(ordinary?.baseFilter, 'and it must be narrowed by the site tier').toBeDefined()
      expect(out.find((e) => e.key === 'app_responses')?.baseFilter).toBeUndefined()
    })
  })

  describe('siteIdsFromScopes', () => {
    it('collects only site scopes and de-duplicates them', () => {
      const scopes: RoleScope[] = [
        { type: 'tenant' },
        { type: 'sites', siteIds: [SITE_A, SITE_B] },
        { type: 'sites', siteIds: [SITE_A] },
      ]
      expect(siteIdsFromScopes(scopes)).toEqual([SITE_A, SITE_B])
    })

    it('returns nothing when the caller holds no site scope', () => {
      expect(siteIdsFromScopes([{ type: 'tenant' }])).toEqual([])
    })
  })

  describe('cache fingerprint', () => {
    const base = {
      isSuperAdmin: false,
      permissions: () => true,
      personId: 'person-1',
      tenantUserId: 'member-1',
    }

    it('separates two members of the same role holding different site scopes', () => {
      const a = analyticsScopeFingerprint(subject({ ...base, siteIds: [SITE_A] }))
      const b = analyticsScopeFingerprint(subject({ ...base, siteIds: [SITE_B] }))
      expect(a).not.toBe(b)
    })

    it('is stable for the same authorization context', () => {
      const a = analyticsScopeFingerprint(subject({ ...base, siteIds: [SITE_B, SITE_A] }))
      const b = analyticsScopeFingerprint(subject({ ...base, siteIds: [SITE_A, SITE_B] }))
      expect(a).toBe(b)
    })

    it('separates a super-admin from a scoped member', () => {
      expect(analyticsScopeFingerprint(subject({ ...base, isSuperAdmin: true }))).not.toBe(
        analyticsScopeFingerprint(subject({ ...base })),
      )
    })
  })

  describe('scope spec self-validation', () => {
    /**
     * `runScopeSpecValidation` is the guard that keeps the scope configuration
     * honest: it rejects malformed specs, and it rejects a table granted with a
     * FLAT read key whose transcribed schema columns include a person- or
     * site-keyed one — which would turn "a tenant admin sees the org tree" into
     * a tenant-wide leak.
     *
     * It was imported here but never called, so both halves of the guard were
     * dead. These assertions are what make it load-bearing, and the second one
     * exercises the split-out pure function so the check is proven to fire rather
     * than merely to pass.
     */
    it('has no tenant-level column-allowlist violations', () => {
      // The half `companies` participates in: a flat-keyed table must not expose a
      // person- or site-keyed column. This must stay empty as tables are added.
      const leaks = runScopeSpecValidation().errors.filter((e) => e.includes('tenant-wide leak'))
      expect(leaks).toEqual([])
    })

    it('reports only the two known flat-key spec conflicts, and no others', () => {
      /**
       * KNOWN PRE-EXISTING DEFECT (present before the companies work, unrelated to
       * it): `PREFIX_SCOPE` gives `ppe_` and `customer_` a flat read key AND scope
       * columns. A flat key resolves to tier `all` and never applies a row
       * predicate, so those columns are dead config.
       *
       * Fixing it means choosing a real read tier for PPE and customer contacts —
       * an authorization decision outside the companies scope. Until that is done
       * deliberately, this assertion pins the exact known set so the guard is live:
       * a THIRD conflict, or the disappearance of these, both fail.
       */
      const KNOWN = [
        'ppe_: declares a flat read key AND scope columns.',
        'customer_: declares a flat read key AND scope columns.',
      ]
      const errors = runScopeSpecValidation().errors
      expect(errors).toHaveLength(KNOWN.length)
      for (const [index, prefix] of KNOWN.entries()) {
        expect(errors[index]).toContain(prefix)
      }
    })

    it('accepts a flat-keyed tenant-level table whose columns are all allowlisted', () => {
      expect(
        validateTenantLevelColumns(
          ['companies'],
          { companies: ['id', 'tenant_id', 'name', 'type'] },
          { companies: ['id', 'tenant_id', 'name', 'type'] },
          'tenant-level organizational definition data',
          { companies: { key: 'admin.org.manage' } },
        ),
      ).toEqual([])
    })

    it('gates the companies report surface on admin.org.manage and nothing wider', () => {
      /**
       * `companies` is contractor/subcontractor employer master data. It must be
       * reachable by exactly the org-admin key that already gates the People admin
       * pages maintaining it — and by NO wider key. In particular
       * `people.read.all` (the directory read boundary) must not become a back
       * door into the company catalogue, and `admin.org.read` must not either
       * unless it is the key actually configured here.
       */
      const companies = entity({ table: 'companies', columns: [] })

      const seen = (permissions: string[]) =>
        scopeAnalyticsEntities(subject({ permissions: (key) => permissions.includes(key) }), [
          companies,
        ]).map((e) => e.table)

      expect(seen(['admin.org.manage'])).toEqual(['companies'])
      // Not by the people directory read key.
      expect(seen(['people.read.all'])).toEqual([])
      // Not by org READ alone — `readTierCovers` never widens `.manage` into
      // `.read`, and this pins that the configured key is the manage one.
      expect(seen(['admin.org.read'])).toEqual([])
      expect(seen([])).toEqual([])
    })

    it('rejects a flat-keyed tenant-level table that grows a person-keyed column', () => {
      const errors = validateTenantLevelColumns(
        ['companies'],
        { companies: ['id', 'tenant_id', 'name', 'type'] },
        { companies: ['id', 'tenant_id', 'name', 'type', 'contact_person_id'] },
        'tenant-level organizational definition data',
        { companies: { key: 'admin.org.manage' } },
      )
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('companies')
      expect(errors[0]).toContain('contact_person_id')
      expect(errors[0]).toContain('tenant-wide leak')
    })

    it('does not apply the column guard to a withheld or tier-scoped table', () => {
      // `read: null` is withheld and a tiered `prefix` spec narrows itself, so
      // neither shape is a flat-key leak and neither should be reported.
      const actual = { companies: ['id', 'contact_person_id'] }
      const allowed = { companies: ['id'] }
      const args = ['companies'] as const
      const description = 'tenant-level organizational definition data'

      expect(
        validateTenantLevelColumns(args, allowed, actual, description, { companies: null }),
      ).toEqual([])
      expect(
        validateTenantLevelColumns(args, allowed, actual, description, { companies: undefined }),
      ).toEqual([])
      // A tiered read (no `key`) is also not flat-keyed.
      expect(
        validateTenantLevelColumns(args, allowed, actual, description, {
          companies: { prefix: 'people' } as never,
        }),
      ).toEqual([])
    })
  })

  describe('table coverage', () => {
    /**
     * Every discoverable table must resolve to a rule. A table with no rule is
     * withheld, so a newly RLS-registered table would silently disappear from
     * reports and insights. This test fails when that happens, forcing the
     * table to be given a rule or listed in `WITHHELD` on purpose.
     *
     * `WITHHELD` is a deliberate narrowing, not an oversight. These are
     * platform-infrastructure tables that the previous blocklist-based
     * discovery let any analytics user read tenant-wide, and that no module
     * read permission was ever intended to cover. Removing them from the
     * report/insight surface is a behaviour change worth stating out loud.
     */
    const WITHHELD = new Set<string>([
      // counters, caches and internal queues
      'reference_counters',
      'storage_object_deletion_outbox',
      // Storage write-freeze state (Phase 6Q stage E1). Authorization/operational
      // state for a tenant, same class as the deletion outbox — it says whether a
      // migration is in progress, which is not reportable workforce data and must
      // never reach the report or insight surface.
      'storage_freeze',
      'in_flight_writes',
      'storage_write_arms',
      'attachment_upload_reservations',
      // IAM internals — authorization state is not reportable data
      'user_permission_overrides',
      // notification / integration / sync plumbing
      'tenant_notification_policy',
      'tenant_notification_settings',
      'tenant_integrations',
      'integration_export_log',
      'sync_record_changes',
      'sms_log',
      'email_templates',
      'pdf_templates',
      // assistant + product-config internals
      'ai_conversation_shares',
      'custom_field_definitions',
      'flow_gates',
      'walkthrough_settings',
      'walkthrough_progress',
      // per-user dashboard layout is personalisation, not a report source
      'role_dashboard_layouts',
    ])

    it('gives every discoverable table a scope rule', () => {
      const discovered = discoverEntities()
      const kept = new Set(
        scopeAnalyticsEntities(subject({ isSuperAdmin: true, permissions: () => true }), discovered)
          .map((e) => e.table)
          .filter((t) => t !== 'app_responses'),
      )
      const uncovered = discovered.map((e) => e.table).filter((t) => !kept.has(t))
      expect(uncovered.filter((t) => !WITHHELD.has(t))).toEqual([])
    })

    it('keeps the tables the built-in overview dashboard reads', () => {
      const kept = new Set(
        scopeAnalyticsEntities(subject({ isSuperAdmin: true }), discoverEntities()).map(
          (e) => e.table,
        ),
      )
      for (const table of [
        'incidents',
        'people',
        'training_courses',
        'training_records',
        'corrective_actions',
        'journal_entries',
        'journal_entry_tags',
        'incident_hours_periods',
        'inspection_records',
        'ppe_issue_reports',
        'compliance_status',
      ]) {
        expect(kept, table).toContain(table)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// 15B-3B — the Project Scope matrix.
//
// The suite above covers the READ TIER ladder and is deliberately run with an
// unrestricted caller, so each case observes one rule in isolation. This block
// covers the OTHER rule: what a caller's Project Scope does to a resolution that
// the permission already allowed.
//
// The property under test throughout: **`tier === 'all'` does not mean
// tenant-wide.** Before 15B-3B `resolveEntity` returned `{filter: undefined}` for
// that tier, so any `read.all` holder received every row in the tenant. The two
// ladders (this one and `apps/web/src/lib/visibility.ts`) now agree, and
// `project-scope-oracle.test.ts` pins that agreement across the two.
// ---------------------------------------------------------------------------
