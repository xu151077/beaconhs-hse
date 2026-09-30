import { describe, expect, it } from 'vitest'
import type { RoleScope } from '@beaconhs/db/schema'
import type { AnalyticsEntity } from '../semantic'
import { discoverEntities } from './discover'
import {
  analyticsScopeFingerprint,
  scopeAnalyticsEntities,
  siteIdsFromScopes,
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
