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
    projectScopeKind: 'unrestricted',
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

    // 15B-3C product decision: the two built-in cards that read `app_responses`
    // are a single `count` each — no `groupBy`, no person, no site, no
    // row-level output — so they are a tenant-wide SYSTEM METRIC rather than a
    // Project-Scope-scoped view, and stay exempt.
    //
    // The PERMISSION half of the rule is NOT decided here and never was: this
    // layer short-circuits on `ALWAYS_ALLOWED` before the permission is read,
    // which is exactly why the entity is described as "granted, caller gate is
    // separate". `canReadAppResponses` in apps/web is that gate and it admits
    // `forms.response.read.all` only. These cases pin the SCOPE dimension alone;
    // the permission cases live in
    // `apps/web/src/lib/insights-trusted-card-scope-contract.test.ts`.
    const withScope = (projectScopeKind: 'unrestricted' | 'restricted' | 'empty' | 'unknown') =>
      scopeAnalyticsEntities(
        subject({
          permissions: (k) => k === 'forms.response.read.all',
          projectScopeKind,
          orgUnitIds: [SITE_A],
          projectPersonIds: [],
        }),
        [appResponses],
      )

    it('is granted in an unrestricted scope (Case A)', () => {
      expect(withScope('unrestricted').map((e) => e.key)).toEqual(['app_responses'])
    })

    it('is granted in a RESTRICTED scope too (Case B) — the aggregate is not narrowed', () => {
      // The decision `read.site` must not silently inherit. Project Scope does
      // not narrow this source, so a scoped `read.all` holder still sees the
      // tenant-wide number on the KPI.
      const out = withScope('restricted')
      expect(out.map((e) => e.key)).toEqual(['app_responses'])
      // Tenant-wide means tenant-wide: no row predicate is attached.
      expect(out[0]?.baseFilter).toBeUndefined()
    })

    it('is granted with an EMPTY Project Scope (Case G)', () => {
      // NOT because the scope was widened. `read.all` is a tenant-wide
      // capability in its own right, and an aggregate with no rows has no scope
      // left to narrow, so there is nothing for `empty` to withhold. This is the
      // documented exception, not a fail-open: the permission half (Cases C–F)
      // is enforced before this layer is ever reached.
      expect(withScope('empty').map((e) => e.key)).toEqual(['app_responses'])
    })

    it('is granted with an UNRESOLVED Project Scope (Case H)', () => {
      // Same reasoning as Case G. `unknown` means the scope was never resolved;
      // here the grant rests on the permission, not on a scope.
      expect(withScope('unknown').map((e) => e.key)).toEqual(['app_responses'])
    })

    it('stays exempt while an ordinary form-responses read is still scoped', () => {
      // The boundary that must not blur. `form_responses` — the underlying
      // records behind the same rows — keeps its `form_` spec and IS narrowed
      // for a restricted caller. Only the alias the two KPI cards use is exempt,
      // so "Insights trusted KPI" never becomes "all form responses are
      // tenant-wide".
      const formResponses = entity({
        table: 'form_responses',
        columns: [
          { key: 'site_org_unit_id', label: 'Site', kind: 'uuid' },
          { key: 'subject_person_id', label: 'Subject', kind: 'uuid' },
        ] as AnalyticsEntity['columns'],
      })
      const out = scopeAnalyticsEntities(
        subject({
          permissions: (k) => k === 'forms.response.read.all',
          projectScopeKind: 'restricted',
          orgUnitIds: [SITE_A],
          projectPersonIds: [],
        }),
        [appResponses, formResponses],
      )
      const ordinary = out.find((e) => e.key === formResponses.key)
      expect(ordinary, 'the ordinary entity must survive to be filtered').toBeDefined()
      expect(ordinary?.baseFilter, 'and it must be narrowed by Project Scope').toBeDefined()
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

describe('15B-3B — Project Scope applied to analytics resolutions', () => {
  const cols = (keys: string[]) =>
    keys.map((key) => ({ key, label: key, kind: 'uuid' })) as AnalyticsEntity['columns']

  const bound = entity({ table: 'incidents', columns: cols(['site_org_unit_id', 'id']) })
  const boundByPerson = entity({
    table: 'ppe_items',
    columns: cols(['current_holder_person_id', 'id']),
  })
  const boundBoth = entity({
    table: 'training_records',
    columns: cols(['site_org_unit_id', 'person_id', 'id']),
  })
  /**
   * No location and no owner column, and NO exemption: nothing to scope with,
   * so a restricted caller must be withheld.
   *
   * This was `documents` until 15B-3C. `documents` is now the
   * `tenant-level-document-library` exemption — a tenant publishes one SDS for the
   * whole company, so a Project Scope must not narrow it. The fail-closed rule
   * this block pins is unchanged and still applies to every OTHER unbindable
   * table, so the fixture moved to `insight_cards`: a flat `insights.read` key, no
   * columns, no exemption.
   */
  const unbound = entity({ table: 'insight_cards', columns: cols(['id', 'title']) })
  /** The aggregates: no column, so a scoped caller is withheld. */
  const aggregate = entity({ table: 'report_incident_rates', columns: cols(['count', 'rate']) })

  const scope = (orgUnitIds: string[], personIds: string[] = []) =>
    subject({
      projectScopeKind: 'restricted',
      orgUnitIds,
      projectPersonIds: personIds,
    })

  const first = <T>(out: readonly T[]) => (out.length === 0 ? undefined : out[0])

  // --- 1. unrestricted + bound / unbound ---------------------------------
  describe('unrestricted is tenant-wide', () => {
    it('grants a bound entity with no predicate, whatever the tier it can reach', () => {
      // `bound` is an `incidents` entity, whose spec declares a site column but no
      // owner column, so only the `all` and `site` tiers reach it. The self tier
      // withholding is pre-existing behaviour, asserted in the tier block below.
      const out = scopeAnalyticsEntities(
        subject({ permissions: (k) => k === 'incidents.read.all' }),
        [bound],
      )
      expect(out).toHaveLength(1)
      expect(out[0]?.baseFilter).toBeUndefined()

      // `read.site` with an empty site list is withheld by the pre-existing ladder
      // (its `tier === 'site'` branch). 15B-3B did not change that, so it is
      // asserted rather than assumed to pass through.
      expect(
        scopeAnalyticsEntities(
          subject({ permissions: (k) => k === 'incidents.read.site', siteIds: [] }),
          [bound],
        ),
      ).toEqual([])

      // ...and with a site list it passes, still unfiltered for an unrestricted caller.
      const withSites = scopeAnalyticsEntities(
        subject({ permissions: (k) => k === 'incidents.read.site', siteIds: [SITE_A] }),
        [bound],
      )
      expect(withSites).toHaveLength(1)
      expect(withSites[0]?.baseFilter).toBeDefined()
    })

    it('grants an unbound entity with no predicate too', () => {
      const out = scopeAnalyticsEntities(subject({ permissions: () => true }), [unbound])
      expect(out).toHaveLength(1)
      expect(out[0]?.baseFilter).toBeUndefined()
    })

    it('grants a super-admin the same', () => {
      const out = scopeAnalyticsEntities(subject({ isSuperAdmin: true }), [
        bound,
        unbound,
        aggregate,
      ])
      expect(out).toHaveLength(3)
      expect(out.every((e) => e.baseFilter === undefined)).toBe(true)
    })
  })

  // --- 2. restricted + matching / nonmatching ----------------------------
  describe('a restricted scope narrows a bound entity', () => {
    it('pins the site column to the scope org units (matching)', () => {
      const [out] = scopeAnalyticsEntities(
        subject({
          permissions: (k) => k === 'incidents.read.all',
          projectScopeKind: 'restricted',
          orgUnitIds: [SITE_A],
          projectPersonIds: [],
        }),
        [bound],
      )
      expect(out?.baseFilter).toEqual({
        combinator: 'and',
        rules: [{ field: 'site_org_unit_id', op: 'in', value: [SITE_A] }],
      })
    })

    it('a non-matching scope yields a predicate that excludes the other site', () => {
      const out = first(
        scopeAnalyticsEntities(
          subject({
            permissions: (k) => k === 'incidents.read.all',
            projectScopeKind: 'restricted',
            orgUnitIds: [SITE_A],
            projectPersonIds: [],
          }),
          [bound],
        ),
      )
      const serialized = JSON.stringify(out?.baseFilter)
      expect(serialized).toContain(SITE_A)
      expect(serialized).not.toContain(SITE_B)
    })

    it('binds a person-only entity by person id', () => {
      const out = first(
        scopeAnalyticsEntities(
          subject({
            permissions: (k) => k === 'ppe.read.all',
            projectScopeKind: 'restricted',
            orgUnitIds: [],
            projectPersonIds: ['person-7'],
          }),
          [boundByPerson],
        ),
      )
      expect(out?.baseFilter).toEqual({
        combinator: 'and',
        rules: [{ field: 'current_holder_person_id', op: 'in', value: ['person-7'] }],
      })
    })

    it('unions the two legs when the entity has both columns', () => {
      const out = first(
        scopeAnalyticsEntities(
          subject({
            permissions: (k) => k === 'training.read.all',
            projectScopeKind: 'restricted',
            orgUnitIds: [SITE_A],
            projectPersonIds: ['person-7'],
          }),
          [boundBoth],
        ),
      )
      expect(out?.baseFilter?.combinator).toBe('or')
      const serialized = JSON.stringify(out?.baseFilter)
      expect(serialized).toContain('site_org_unit_id')
      expect(serialized).toContain('person_id')
    })

    it('a multiple-placement scope covers the union, never an empty IN ()', () => {
      const out = first(
        scopeAnalyticsEntities(
          subject({
            permissions: (k) => k === 'incidents.read.all',
            projectScopeKind: 'restricted',
            orgUnitIds: [SITE_A, SITE_B],
            projectPersonIds: [],
          }),
          [bound],
        ),
      )
      const serialized = JSON.stringify(out?.baseFilter)
      expect(serialized).toContain(SITE_A)
      expect(serialized).toContain(SITE_B)
      // Both ids are in ONE `in` list, so the union is a single predicate rather
      // than two overlapping ones, and the list is never empty.
      expect(out?.baseFilter).toEqual({
        combinator: 'and',
        rules: [{ field: 'site_org_unit_id', op: 'in', value: [SITE_A, SITE_B] }],
      })
    })
  })

  // --- 3. restricted + unbound => withhold -------------------------------
  describe('a restricted scope withholds an unbindable entity', () => {
    it('withholds a table with no scope column', () => {
      expect(
        scopeAnalyticsEntities(
          subject({
            permissions: () => true,
            projectScopeKind: 'restricted',
            orgUnitIds: [SITE_A],
            projectPersonIds: [],
          }),
          [unbound],
        ),
      ).toEqual([])
    })

    it('withholds an aggregate at every tier, including read.all', () => {
      for (const key of ['incidents.read.all', 'incidents.read.site', 'incidents.read.self']) {
        expect(
          scopeAnalyticsEntities(
            subject({
              permissions: (k) => k === key,
              projectScopeKind: 'restricted',
              orgUnitIds: [SITE_A],
              projectPersonIds: [],
            }),
            [aggregate],
          ),
          key,
        ).toEqual([])
      }
    })

    it('never widens to unrestricted as a fallback', () => {
      const out = scopeAnalyticsEntities(
        subject({
          permissions: (k) => k === 'incidents.read.all',
          projectScopeKind: 'restricted',
          orgUnitIds: [SITE_A],
          projectPersonIds: [],
        }),
        [unbound],
      )
      expect(out).toEqual([])
      expect(first(out)?.baseFilter).toBeUndefined()
      // Length zero, not a length-one entry with an undefined filter.
      expect(out.filter((e) => e.baseFilter === undefined)).toHaveLength(0)
    })
  })

  // --- 4. empty / unknown / invalid / expired ---------------------------
  describe('no usable scope fails closed', () => {
    const denied = [
      ['empty', 'empty' as const],
      ['unknown', undefined],
    ] as const

    for (const [label, kind] of denied) {
      it(`withholds everything for an ${label} scope, at every tier`, () => {
        for (const key of ['incidents.read.all', 'incidents.read.site', 'incidents.read.self']) {
          const out = scopeAnalyticsEntities(
            subject({
              permissions: (k) => k === key,
              projectScopeKind: kind,
              orgUnitIds: kind === 'empty' ? [] : [SITE_A],
              projectPersonIds: kind === 'empty' ? [] : ['person-7'],
            }),
            [bound, boundBoth, boundByPerson],
          )
          expect(out, `${label} ${key}`).toEqual([])
        }
      })

      it(`withholds everything for an ${label} scope, even from a super-admin`, () => {
        expect(
          scopeAnalyticsEntities(subject({ isSuperAdmin: true, projectScopeKind: kind }), [
            bound,
            unbound,
          ]),
          label,
        ).toEqual([])
      })
    }

    it('treats an expired, future or invalid assignment as empty, not unrestricted', () => {
      // The resolver's four failing reasons all produce `empty`, so all four reach
      // this layer as the same state. The ladder must not distinguish them by
      // guessing: one of them must not leak.
      const failingReasons = [
        'no_scope',
        'no_assignment',
        'expired_assignment',
        'invalid_assignment',
        'missing_org_unit',
        'requested_outside_scope',
        'tenant_mismatch',
      ] as const
      for (const reason of failingReasons) {
        const out = scopeAnalyticsEntities(
          subject({
            permissions: (k) => k === 'incidents.read.all',
            projectScopeKind: 'empty',
            orgUnitIds: [],
            projectPersonIds: [],
          }),
          [bound],
        )
        expect(out, reason).toEqual([])
      }
    })
  })

  // --- 5. tier interaction -----------------------------------------------
  describe('tier and scope combine, neither overrides the other', () => {
    it('tier all + bound + restricted => the scope predicate (THE 15B-3B FIX)', () => {
      const out = first(
        scopeAnalyticsEntities(
          subject({
            permissions: (k) => k === 'incidents.read.all',
            projectScopeKind: 'restricted',
            orgUnitIds: [SITE_A],
            projectPersonIds: [],
          }),
          [bound],
        ),
      )
      expect(out?.baseFilter).toBeDefined()
    })

    it('tier all + unbound + restricted => withheld', () => {
      expect(
        scopeAnalyticsEntities(
          subject({
            permissions: (k) => k === 'incidents.read.all',
            projectScopeKind: 'restricted',
            orgUnitIds: [SITE_A],
            projectPersonIds: [],
          }),
          [unbound],
        ),
      ).toEqual([])
    })

    it('tier all + bound + unrestricted => unfiltered', () => {
      const out = first(
        scopeAnalyticsEntities(subject({ permissions: (k) => k === 'incidents.read.all' }), [
          bound,
        ]),
      )
      expect(out?.baseFilter).toBeUndefined()
    })

    it('tier site + empty siteIds + a Project Scope => withheld, ladder unchanged', () => {
      // The read.site ladder's own behaviour (an empty site list withholds) is
      // preserved exactly; 15B-3B did not touch it.
      expect(
        scopeAnalyticsEntities(
          subject({
            permissions: (k) => k === 'incidents.read.site',
            siteIds: [],
            projectScopeKind: 'restricted',
            orgUnitIds: [SITE_A],
            projectPersonIds: [],
          }),
          [bound],
        ),
      ).toEqual([])
    })

    it('tier site + siteIds present + a wider Project Scope => both legs ANDed', () => {
      const out = first(
        scopeAnalyticsEntities(
          subject({
            permissions: (k) => k === 'incidents.read.site',
            siteIds: [SITE_A],
            projectScopeKind: 'restricted',
            orgUnitIds: [SITE_A, SITE_B],
            projectPersonIds: [],
          }),
          [bound],
        ),
      )
      expect(out?.baseFilter?.combinator).toBe('and')
    })

    it('tier self + a Project Scope => both legs ANDed', () => {
      const out = first(
        scopeAnalyticsEntities(
          subject({
            // `boundBoth` is a `training_records` table, so its spec is the
            // `training` prefix - not `incidents`.
            permissions: (k) => k === 'training.read.self',
            personId: 'person-1',
            tenantUserId: 'member-1',
            projectScopeKind: 'restricted',
            orgUnitIds: [SITE_A],
            projectPersonIds: [],
          }),
          [boundBoth],
        ),
      )
      expect(out?.baseFilter?.combinator).toBe('and')
    })

    it('tier none => withheld whatever the scope', () => {
      for (const kind of ['unrestricted', 'restricted'] as const) {
        expect(
          scopeAnalyticsEntities(
            subject({
              permissions: () => false,
              projectScopeKind: kind,
              orgUnitIds: [SITE_A],
              projectPersonIds: [],
            }),
            [bound],
          ),
          kind,
        ).toEqual([])
      }
    })
  })

  // --- 6. the vehicle_log_settings exemption ----------------------------
  describe('the only exemption is explicit and justified', () => {
    it('lets a restricted caller read a tenant-level setting', () => {
      const setting = entity({
        table: 'vehicle_log_settings',
        columns: cols(['id', 'enabled_modes', 'default_mode']),
      })
      const out = scopeAnalyticsEntities(
        subject({
          permissions: (k) => k === 'equipment.read.all',
          projectScopeKind: 'restricted',
          orgUnitIds: [SITE_A],
          projectPersonIds: [],
        }),
        [setting],
      )
      expect(out).toHaveLength(1)
      // Configuration, not records: there is no row predicate to build, and none
      // is needed because the table holds no business data.
      expect(out[0]?.baseFilter).toBeUndefined()
    })

    it('the spec table itself is structurally valid', () => {
      // Catches an exemption smuggled onto a table that DOES declare a column,
      // and any unrecognised exemption reason.
      expect(runScopeSpecValidation().errors).toEqual([])
    })

    it('rejects an exemption on a spec that declares a scope column', () => {
      // Proves the guard is real, not decorative. Without this the exemption
      // would be "a table with columns may opt out", which is the leak.
      const errors = validateScopeSpecs([
        {
          match: 'a-bound-table',
          spec: {
            read: { key: 'x.read' },
            siteCols: ['site_org_unit_id'],
            projectScopeExempt: 'tenant-level-setting',
          },
        },
      ])
      expect(errors.join('\n')).toContain('a-bound-table')
      expect(errors.join('\n')).toContain('licence to skip a bindable entity')
    })

    it('rejects an unrecognised exemption reason', () => {
      const errors = validateScopeSpecs([
        {
          match: 'mystery',
          spec: { read: { key: 'x.read' }, projectScopeExempt: 'because' as never },
        },
      ])
      expect(errors.join('\n')).toContain('unrecognised projectScopeExempt')
    })
  })
})

// ===========================================================================
// 15B-3E — the Project Scope DEFINITION DOMAIN
//
// `org_units` defines the tree every scope is expressed in; `departments`,
// `crews` and `trades` are grouping catalogs drawn from it. 15B-3B made them
// fail CLOSED, which removed a scoped administrator's ability to group a report
// by location or crew. 15B-3E resolves the TODO(15B-3E) with option (c): an
// explicit, named `tenant-level-definition` exemption.
//
// The safety argument these tests exist to hold:
//
//   The exemption skips the Project Scope ROW PREDICATE only. It does NOT grant a
//   read permission, and it is NOT the `tier === 'all' -> undefined` fail-open
//   that 15B-3B fixed. Case D pins the permission boundary and Case H pins the
//   fail-closed boundary for every OTHER unbindable table.
// ===========================================================================

/** The four definition-domain tables, as the discovery layer would expose them. */
const DEFINITION_DOMAIN_TABLES = ['org_units', 'departments', 'crews', 'trades'] as const

const defCols = (keys: string[]) =>
  keys.map((key) => ({ key, label: key, kind: 'uuid' })) as AnalyticsEntity['columns']

const definitionEntity = (table: string) =>
  entity({
    table,
    // A definitional table's real shape: identifiers, tenant, the definition and
    // timestamps. `org_units` also carries the tree definition itself. None of
    // them has a person, owner or placement column — that is the whole argument,
    // and `runScopeSpecValidation` re-checks it against the schema transcription.
    columns: defCols(
      table === 'org_units'
        ? ['id', 'tenant_id', 'parent_id', 'level', 'name', 'code']
        : table === 'departments'
          ? ['id', 'tenant_id', 'name', 'code', 'description']
          : table === 'trades'
            ? ['id', 'tenant_id', 'name', 'code']
            : ['id', 'tenant_id', 'name'],
    ),
  })

const scopedOrgAdmin = () =>
  subject({
    permissions: (k) => k === 'admin.org.manage',
    projectScopeKind: 'restricted',
    orgUnitIds: [SITE_A],
    projectPersonIds: [],
  })

describe('15B-3E — the Project Scope definition domain is exempt, by name', () => {
  // --- Case A: restricted scope + the read permission ---------------------
  it('Case A: a restricted administrator reads all four, with no row predicate', () => {
    for (const table of DEFINITION_DOMAIN_TABLES) {
      const out = scopeAnalyticsEntities(scopedOrgAdmin(), [definitionEntity(table)])
      expect(out, table).toHaveLength(1)
      // Definition data, not records: there is nothing to narrow on, so no filter.
      expect(out[0]?.baseFilter, table).toBeUndefined()
    }
  })

  it('Case A: the exemption is the reason, not the missing columns', () => {
    // A table that is unbindable for the SAME reason (no columns) but is NOT
    // exempt stays withheld. If this ever passes with a filter, the four tables
    // would be visible by accident rather than by decision.
    const out = scopeAnalyticsEntities(
      subject({
        permissions: (k) => k === 'equipment.read.all',
        projectScopeKind: 'restricted',
        orgUnitIds: [SITE_A],
        projectPersonIds: [],
      }),
      [entity({ table: 'equipment_categories', columns: defCols(['id', 'name']) })],
    )
    expect(out).toEqual([])
  })

  // --- Case B: empty / unknown Project Scope -------------------------------
  it('Case B: an unusable scope still withholds — the exemption does not rescue it', () => {
    // This is the direction that matters. An exemption says "Project Scope does
    // not apply to this table"; it does NOT say "an absent scope is a wide one".
    // If it did, a caller whose scope failed to resolve would be handed the
    // whole org tree — the fail-open 15B-3B removed.
    for (const kind of ['empty', 'unknown'] as const) {
      for (const table of DEFINITION_DOMAIN_TABLES) {
        const out = scopeAnalyticsEntities(
          subject({
            permissions: (k) => k === 'admin.org.manage',
            projectScopeKind: kind,
          }),
          [definitionEntity(table)],
        )
        expect(out, `${table}/${kind}`).toEqual([])
      }
    }
  })

  // --- Case C: unrestricted -----------------------------------------------
  it('Case C: an unrestricted caller keeps the existing tenant-level behaviour', () => {
    for (const table of DEFINITION_DOMAIN_TABLES) {
      const out = scopeAnalyticsEntities(
        subject({
          permissions: (k) => k === 'admin.org.manage',
          projectScopeKind: 'unrestricted',
        }),
        [definitionEntity(table)],
      )
      expect(out, table).toHaveLength(1)
      expect(out[0]?.baseFilter, table).toBeUndefined()
    }
  })

  // --- Case D: the exemption never grants a permission --------------------
  it('Case D: without admin.org.manage all four stay invisible', () => {
    // The exemption skips the row predicate, not the read tier. `tierFor` runs
    // first and withholds on `none`, so a restricted caller holding only, say,
    // `incidents.read.all` still sees nothing here.
    for (const table of DEFINITION_DOMAIN_TABLES) {
      for (const perms of [[], ['incidents.read.all'], ['admin.users.manage']]) {
        const out = scopeAnalyticsEntities(
          subject({
            permissions: (k) => perms.includes(k),
            projectScopeKind: 'restricted',
            orgUnitIds: [SITE_A],
            projectPersonIds: [],
          }),
          [definitionEntity(table)],
        )
        expect(out, `${table}/${perms.join('|') || 'none'}`).toEqual([])
      }
    }
  })

  // --- Case E/F: validation still refuses the two bad shapes --------------
  it('Case E: tenant-level-definition plus a scope column is still rejected', () => {
    const errors = validateScopeSpecs([
      {
        match: 'bad_table',
        spec: {
          read: { key: 'admin.org.manage' },
          siteCols: ['site_org_unit_id'],
          projectScopeExempt: 'tenant-level-definition',
        },
      },
    ])
    expect(errors.join('\n')).toContain('bad_table')
    expect(errors.join('\n')).toContain('licence to skip a bindable entity')
  })

  it('Case E: it is rejected for every column kind, not just site columns', () => {
    // A person- or owner-keyed exemption would be the actual leak, so the guard
    // must not be sidable by choosing a different column list.
    for (const cols of [
      { personCols: ['person_id'] },
      { userCols: ['owner_tenant_user_id'] },
      { orgUnitCols: ['org_unit_id'] },
    ]) {
      const errors = validateScopeSpecs([
        {
          match: 'x',
          spec: { read: { key: 'k' }, ...cols, projectScopeExempt: 'tenant-level-definition' },
        },
      ])
      expect(errors.join('\n'), JSON.stringify(cols)).toContain('licence to skip a bindable entity')
    }
  })

  it('Case F: an unknown exemption reason is still rejected', () => {
    const errors = validateScopeSpecs([
      {
        match: 'mystery',
        spec: { read: { key: 'x.read' }, projectScopeExempt: 'something-else' as never },
      },
    ])
    expect(errors.join('\n')).toContain('unrecognised projectScopeExempt')
  })

  it('the real spec table is structurally valid with the new exemption', () => {
    expect(runScopeSpecValidation().errors).toEqual([])
  })

  // --- Case G: the pre-existing exemption is untouched --------------------
  it('Case G: vehicle_log_settings keeps tenant-level-setting and still works', () => {
    const setting = entity({
      table: 'vehicle_log_settings',
      columns: defCols(['id', 'enabled_modes', 'default_mode']),
    })
    const out = scopeAnalyticsEntities(
      subject({
        permissions: (k) => k === 'equipment.read.all',
        projectScopeKind: 'restricted',
        orgUnitIds: [SITE_A],
        projectPersonIds: [],
      }),
      [setting],
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.baseFilter).toBeUndefined()
  })

  // --- Case H: anti-fail-open ---------------------------------------------
  it('Case H: a read.all holder with no columns and NO exemption is still withheld', () => {
    // This is the 15B-3B security boundary, and 15B-3E must not have moved it.
    // `tier === 'all'` alone is never an exemption: if this returns a row, the
    // fail-open is back and every unbindable table is tenant-wide again.
    const unbound = entity({ table: 'some_future_catalog', columns: defCols(['id', 'name']) })
    const out = scopeAnalyticsEntities(
      subject({
        permissions: (k) => k === 'some.future.read.all',
        projectScopeKind: 'restricted',
        orgUnitIds: [SITE_A],
        projectPersonIds: [],
      }),
      [unbound],
    )
    expect(out).toEqual([])
  })

  it('Case H: a super-admin is unaffected — tier all with no scope is tenant-wide', () => {
    // The exemption is not what makes an unrestricted caller unrestricted; that
    // is `projectScopeKind: 'unrestricted'`. This keeps the two paths distinct.
    // `people` is used because it HAS a spec (`admin.users.manage`, no scope
    // columns), so this isolates the scope rule rather than the allowlist: a table
    // with no spec at all is withheld for everyone, super-admin included.
    const out = scopeAnalyticsEntities(
      subject({
        isSuperAdmin: true,
        projectScopeKind: 'unrestricted',
      }),
      [entity({ table: 'people', columns: defCols(['id', 'user_id']) })],
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.baseFilter).toBeUndefined()
  })

  it('Case H: a table with no spec is withheld even for a super-admin', () => {
    // The allowlist half of the same boundary: 15B-3B turned the previous
    // blocklist into an allowlist, so a newly registered table stops being
    // tenant-wide-readable on arrival. 15B-3E adds exemptions to four NAMED
    // tables and does not reopen this.
    const out = scopeAnalyticsEntities(
      subject({ isSuperAdmin: true, projectScopeKind: 'unrestricted' }),
      [entity({ table: 'some_future_catalog', columns: defCols(['id', 'name']) })],
    )
    expect(out).toEqual([])
  })
})

// ===========================================================================
// 15B-3C — the controlled-document library
//
// PRODUCT DECISION: `documents` is a TENANT-LEVEL CONTROLLED DOCUMENT LIBRARY.
// A tenant publishes one version of an SDS / SOP / policy and every field worker
// on every site must be able to read it, so a Project Scope must not narrow it.
// No applicability binding is introduced, and the table gains no scope column.
//
// The resulting rule, which the web half (`documentScopeUsable` in
// `apps/web/src/lib/assistant/document-project-scope.ts`) must express
// identically:
//
//   unrestricted -> visible, no row predicate
//   restricted   -> visible, no row predicate
//   empty        -> withheld
//   unknown      -> withheld
//
// The last two matter most. The exemption is a ROW-PREDICATE exemption, and
// `scopeContribution` denies `empty`/`unknown` ABOVE the exemption check, so an
// exemption can never rescue a scope that could not be resolved.
// ===========================================================================

describe('15B-3C — the document library is tenant-level, not scope-bound', () => {
  const doc = entity({
    table: 'documents',
    columns: defCols(['id', 'tenant_id', 'key', 'title', 'status', 'owner_tenant_user_id']),
  })

  const reader = (kind: 'unrestricted' | 'restricted' | 'empty' | 'unknown') =>
    subject({
      permissions: (k) => k === 'documents.read',
      projectScopeKind: kind,
      orgUnitIds: [SITE_A],
      projectPersonIds: [],
    })

  it('unrestricted -> visible, with no row predicate', () => {
    const out = scopeAnalyticsEntities(reader('unrestricted'), [doc])
    expect(out).toHaveLength(1)
    expect(out[0]?.baseFilter).toBeUndefined()
  })

  it('restricted -> visible, with no row predicate', () => {
    // THE product decision. Before it, this caller was withheld.
    const out = scopeAnalyticsEntities(reader('restricted'), [doc])
    expect(out).toHaveLength(1)
    expect(out[0]?.baseFilter).toBeUndefined()
  })

  it('empty -> withheld', () => {
    expect(scopeAnalyticsEntities(reader('empty'), [doc])).toEqual([])
  })

  it('unknown -> withheld', () => {
    expect(scopeAnalyticsEntities(reader('unknown'), [doc])).toEqual([])
  })

  it('the exemption does not grant documents.read', () => {
    // An exemption skips a row predicate; it is not a capability. A caller with
    // no read key is withheld at every scope state, restricted included.
    for (const kind of ['unrestricted', 'restricted'] as const) {
      const out = scopeAnalyticsEntities(
        subject({
          permissions: () => false,
          projectScopeKind: kind,
          orgUnitIds: [SITE_A],
          projectPersonIds: [],
        }),
        [doc],
      )
      expect(out, kind).toEqual([])
    }
  })

  it('the exemption is named, and it is not the definition-domain one', () => {
    // A tenant-level LIBRARY of controlled documents is a different fact from
    // tenant-level organizational STRUCTURE, and the two exemptions are named
    // apart so neither can be read as the other.
    const spec = entity({ table: 'documents', columns: [] })
    const out = scopeAnalyticsEntities(reader('restricted'), [spec])
    expect(out).toHaveLength(1)
    expect(runScopeSpecValidation().errors).toEqual([])
  })

  it('documents declares no scope column, so no binding could creep in', () => {
    // `validateScopeSpecs` already rejects exemption + columns; this pins the
    // shape from the spec side as well, so the exemption stays only valid
    // because there is genuinely nothing to narrow on.
    const errors = validateScopeSpecs([
      {
        match: 'documents-like',
        spec: {
          read: { key: 'documents.read' },
          projectScopeExempt: 'tenant-level-document-library',
        },
      },
    ])
    expect(errors).toEqual([])
  })

  it('an unknown exemption reason is still rejected', () => {
    const errors = validateScopeSpecs([
      {
        match: 'mystery',
        spec: {
          read: { key: 'documents.read' },
          projectScopeExempt: 'tenant-level-controlled-docs' as never,
        },
      },
    ])
    expect(errors.join('\n')).toContain('unrecognised projectScopeExempt')
  })

  it('the exemption still cannot be combined with a scope column', () => {
    const errors = validateScopeSpecs([
      {
        match: 'documents-with-site',
        spec: {
          read: { key: 'documents.read' },
          siteCols: ['site_org_unit_id'],
          projectScopeExempt: 'tenant-level-document-library',
        },
      },
    ])
    expect(errors.join('\n')).toContain('licence to skip a bindable entity')
  })

  it('the other exemptions are unaffected by this one being added', () => {
    // 15B-3E's four definition tables and the vehicle-log setting keep their own
    // rules; adding a third reason must not relax any of them.
    const setting = entity({
      table: 'vehicle_log_settings',
      columns: defCols(['id', 'enabled_modes', 'default_mode']),
    })
    const out = scopeAnalyticsEntities(
      subject({
        permissions: (k) => k === 'equipment.read.all',
        projectScopeKind: 'restricted',
        orgUnitIds: [SITE_A],
        projectPersonIds: [],
      }),
      [setting],
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.baseFilter).toBeUndefined()

    for (const table of ['org_units', 'departments', 'crews', 'trades']) {
      const e = entity({ table, columns: defCols(['id', 'tenant_id', 'name']) })
      const r = scopeAnalyticsEntities(
        subject({
          permissions: (k) => k === 'admin.org.manage',
          projectScopeKind: 'restricted',
          orgUnitIds: [SITE_A],
          projectPersonIds: [],
        }),
        [e],
      )
      expect(r, table).toHaveLength(1)
      expect(r[0]?.baseFilter, table).toBeUndefined()
    }
  })
})
