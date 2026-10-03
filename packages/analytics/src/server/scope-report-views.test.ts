import { describe, expect, it } from 'vitest'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE } from '@beaconhs/db/schema'
import { scopeAnalyticsEntities, siteIdsFromScopes, type AnalyticsScopeSubject } from './scope'
import type { ReportRule, ReportRuleGroup } from '@beaconhs/reports'
import type { AnalyticsColumn, AnalyticsEntity } from '../semantic'

/**
 * Regression tests for F1: the `report_*` projection views used to be granted
 * tenant-wide to every holder of `reports.read`, because their scope spec was
 * `{ read: { key: 'reports.read' } }` — a flat key, which `tierFor` always
 * resolves to tier 'all', so `resolveEntity` returned no row predicate.
 *
 * A five-permission user could then read tenant-wide equipment, training, skills,
 * vehicle-log and KPI rows through the reporting studio, and the same rows came
 * back in the CSV export. Verified in a real browser before this fix.
 *
 * These tests assert on the resolved `baseFilter` — the actual predicate handed to
 * both report compilers — and on concrete column values, not on counts.
 */

const SITE_A = 'd83943d2-58e9-4b1c-a241-e455d8a77c8a'
const SITE_B = '85b2dbd0-b120-406c-8486-1c425ddf858d'

/** Depth-first search of a (possibly nested) rule group for one field. */
function filterFor(group: ReportRuleGroup | undefined, field: string): ReportRule | undefined {
  for (const rule of group?.rules ?? []) {
    if ('rules' in rule) {
      const nested = filterFor(rule, field)
      if (nested) return nested
    } else if (rule.field === field) {
      return rule
    }
  }
  return undefined
}

const entity = (
  key: string,
  table: string,
  columns: string[],
  extra: Partial<AnalyticsEntity> = {},
): AnalyticsEntity => ({
  key,
  label: key,
  category: 'custom',
  table,
  columns: columns.map((c) => ({ key: c, label: c, kind: 'text' }) as AnalyticsColumn),
  ...extra,
})

/** Mirrors the declared columns of each report view in packages/reports. */
const REPORT_VIEWS: Record<string, AnalyticsEntity> = {
  equipment_fleet: entity('equipment_fleet', 'report_equipment_fleet', [
    'asset_tag',
    'vehicle_name',
    'current_site_org_unit_id',
    'current_holder_person_id',
  ]),
  corrective_actions: entity('corrective_actions', 'report_corrective_actions', [
    'reference',
    'title',
    'site_org_unit_id',
    'owner_tenant_user_id',
  ]),
  vehicle_log_entries: entity('vehicle_log_entries', 'report_vehicle_log_entries', [
    'entry_date',
    'site_org_unit_id',
    'driver_person_id',
    'business_km',
  ]),
  vehicle_log_monthly: entity('vehicle_log_monthly', 'report_vehicle_log_monthly', [
    'month',
    'asset_tag',
    'driver_person_id',
    'site_count',
  ]),
  ppe_items: entity('ppe_items', 'report_ppe_items', [
    'serial_number',
    'current_holder_person_id',
    'status',
  ]),
  training_matrix: entity('training_matrix', 'report_training_matrix', [
    'person_id',
    'course_code',
    'status',
  ]),
  incident_rates: entity('incident_rates', 'report_incident_rates', [
    'month',
    'recordable_incidents',
    'hours_worked',
  ]),
  compliance_status: entity('compliance_status', 'report_compliance_status', [
    'entity_key',
    'status',
  ]),
}

/**
 * A subject with exactly the built-in role's permissions and a given Role Scope.
 *
 * These cases are about the READ TIER ladder, so the only things that vary are the
 * permission set and the `{type:'sites'}` ids the caller holds. There is no second
 * authorization dimension to satisfy, so a subject is fully described by these two
 * plus its person and membership.
 */
function subject(
  roleKey: keyof typeof BUILTIN_ROLES,
  opts: { siteIds?: string[]; personId?: string; tenantUserId?: string } = {},
): AnalyticsScopeSubject {
  const declared = BUILTIN_ROLES[roleKey]?.permissions as unknown as string[]
  const permissions = new Set(declared)
  return {
    tenantUserId: opts.tenantUserId ?? 'verif-foreman-a',
    personId: opts.personId ?? null,
    isSuperAdmin: false,
    permissions: (key: string) => permissions.has(key),
    siteIds: opts.siteIds ?? [],
  }
}
const foremanA = (siteIds = [SITE_A], personId?: string) =>
  subject('foreman', { siteIds, personId })
const foremanB = (personId?: string) => subject('foreman', { siteIds: [SITE_B], personId })

describe('F1 — report_* views inherit their module scope, not the studio grant', () => {
  it('does not let `reports.read` alone expose any report view', () => {
    // The heart of the defect: a subject holding ONLY the studio grant.
    const studioOnly: AnalyticsScopeSubject = {
      tenantUserId: 'verif-viewer',
      personId: null,
      isSuperAdmin: false,
      permissions: (key) => key === 'reports.read',
      siteIds: [],
    }
    const visible = scopeAnalyticsEntities(studioOnly, Object.values(REPORT_VIEWS))
    expect(visible.map((e) => e.key)).toEqual([])
  })

  it('withholds a report view for a subject with no module read permission', () => {
    // viewer-a: five keys, none of them a module read for these views.
    const viewer: AnalyticsScopeSubject = {
      tenantUserId: 'verif-viewer',
      personId: null,
      isSuperAdmin: false,
      permissions: (key) =>
        [
          'reports.read',
          'insights.read',
          'dashboards.read',
          'incidents.read.site',
          'documents.read',
        ].includes(key),
      siteIds: [],
    }
    const visible = scopeAnalyticsEntities(viewer, Object.values(REPORT_VIEWS))
    expect(visible.map((e) => e.key)).toEqual([])
  })

  it('scopes foreman-a to Site A and foreman-b to Site B, on different values', () => {
    const a = scopeAnalyticsEntities(foremanA(), [REPORT_VIEWS.equipment_fleet!])
    const b = scopeAnalyticsEntities(foremanB(), [REPORT_VIEWS.equipment_fleet!])
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(filterFor(a[0]?.baseFilter, 'current_site_org_unit_id')?.value).toEqual([SITE_A])
    expect(filterFor(b[0]?.baseFilter, 'current_site_org_unit_id')?.value).toEqual([SITE_B])
  })

  it('never emits a site filter containing both sites', () => {
    for (const view of Object.values(REPORT_VIEWS)) {
      const a = scopeAnalyticsEntities(foremanA(), [view])[0]
      const b = scopeAnalyticsEntities(foremanB(), [view])[0]
      for (const entity of [a, b]) {
        if (!entity) continue
        const site =
          filterFor(entity?.baseFilter, 'site_org_unit_id') ??
          filterFor(entity?.baseFilter, 'current_site_org_unit_id')
        if (!site) continue
        const values = site.value as string[]
        expect(values).not.toContain(SITE_B === values[0] ? SITE_A : SITE_B)
        expect(values.length).toBe(1)
      }
    }
  })

  it('scopes corrective actions and vehicle log entries by site', () => {
    const ca = scopeAnalyticsEntities(foremanA(), [REPORT_VIEWS.corrective_actions!])[0]
    expect(ca).toBeDefined()
    expect(filterFor(ca?.baseFilter, 'site_org_unit_id')?.value).toEqual([SITE_A])
    const vl = scopeAnalyticsEntities(foremanB(), [REPORT_VIEWS.vehicle_log_entries!])[0]
    expect(vl).toBeDefined()
    expect(filterFor(vl?.baseFilter, 'site_org_unit_id')?.value).toEqual([SITE_B])
  })

  it('withholds the vehicle-log monthly rollup for a foreman with no person link', () => {
    // The rollup exposes only `driver_person_id`. There is no honest site
    // predicate for it, so a site-scoped caller is withheld rather than
    // handed every vehicle in the tenant.
    const visible = scopeAnalyticsEntities(foremanA(), [REPORT_VIEWS.vehicle_log_monthly!])
    expect(visible).toEqual([])
  })

  it('withholds the vehicle-log rollup from every non-tenant-wide caller', () => {
    // The rollup exposes only `driver_person_id`. There is no honest site
    // predicate for it, so a site-scoped caller is withheld rather than handed
    // every vehicle in the tenant. `worker` additionally holds no `equipment.*`
    // key at all, so it is withheld one step earlier, on the read tier.
    expect(scopeAnalyticsEntities(foremanA(), [REPORT_VIEWS.vehicle_log_monthly!])).toEqual([])
    expect(
      scopeAnalyticsEntities(subject('worker', { personId: 'person-2' }), [
        REPORT_VIEWS.vehicle_log_monthly!,
      ]),
    ).toEqual([])
    // The person-link fallback itself is covered by the PPE case below: it is the
    // one report view whose module grants a `self` tier to a built-in role.
  })

  it('withholds PPE for a foreman and narrows it for the holder', () => {
    // `report_ppe_items` has no site column either; the holder column is the
    // only honest predicate. This does not change the PPE permission model.
    expect(scopeAnalyticsEntities(foremanA(), [REPORT_VIEWS.ppe_items!])).toEqual([])
    const holder = subject('worker', { personId: 'person-2' })
    const visible = scopeAnalyticsEntities(holder, [REPORT_VIEWS.ppe_items!])
    expect(filterFor(visible[0]?.baseFilter, 'current_holder_person_id')?.value).toEqual([
      'person-2',
    ])
  })

  it('withholds a view that carries no scope column at all', () => {
    // incident_rates is an aggregate with no location or owner column.
    expect(scopeAnalyticsEntities(foremanA(), [REPORT_VIEWS.incident_rates!])).toEqual([])
  })

  it('grants a tenant-wide aggregate only to the holder of that module key', () => {
    const viewer = {
      tenantUserId: 'verif-viewer',
      personId: null,
      isSuperAdmin: false,
      permissions: (k: string) => k === 'reports.read',
      siteIds: [] as string[],
    } satisfies AnalyticsScopeSubject
    const safetyWide = {
      ...viewer,
      permissions: (k: string) =>
        (BUILTIN_ROLES.safety_manager?.permissions as string[]).includes(k),
    } satisfies AnalyticsScopeSubject
    const safetyScoped = { ...safetyWide, siteIds: [SITE_A] } satisfies AnalyticsScopeSubject
    // `reports.read` alone is not the capability: the view belongs to the
    // `incidents` module, so a reporting-studio grant must not reach it.
    expect(scopeAnalyticsEntities(viewer, [REPORT_VIEWS.incident_rates!])).toEqual([])
    // `incidents.read.all` IS the capability, and tier `all` means the whole
    // tenant — which is the point of a tenant-wide aggregate.
    const wide = scopeAnalyticsEntities(safetyWide, [REPORT_VIEWS.incident_rates!])
    expect(wide).toHaveLength(1)
    expect(wide[0]?.baseFilter).toBeUndefined() // tenant-wide BY PERMISSION
    // A `{type:'sites'}` Role Scope is not a read permission and cannot narrow a
    // `read.all` grant. The aggregate has no column to narrow on either, so
    // withholding it here would mean the permission decided nothing.
    expect(scopeAnalyticsEntities(safetyScoped, [REPORT_VIEWS.incident_rates!])).toHaveLength(1)
  })

  it('leaves a safety_manager and tenant_admin with unfiltered access', () => {
    // Both hold the module read keys at tier `all`, so every view — including the
    // aggregates that expose no column to filter on — is the whole tenant. That is
    // what `read.all` means.
    for (const role of ['safety_manager', 'tenant_admin'] as const) {
      for (const view of Object.values(REPORT_VIEWS)) {
        const visible = scopeAnalyticsEntities(subject(role), [view])
        expect(visible, `${role} lost ${view.key}`).toHaveLength(1)
        expect(visible[0]?.baseFilter, `${role} / ${view.key}`).toBeUndefined()
      }
    }
  })

  it('narrows a view that HAS a column, and withholds one that does not', () => {
    // The counterpart to the case above: the SAME caller, on a narrower tier. A
    // view with a site column is reached and narrowed by the Role Scope; the
    // aggregate has no column, so that tier cannot be expressed against it and the
    // honest answer is WITHHOLD — strictly narrower than the tenant-wide read.
    const siteTier: AnalyticsScopeSubject = {
      tenantUserId: 'tu_foreman',
      personId: 'person_foreman',
      isSuperAdmin: false,
      permissions: (key) => key === 'incidents.read.site' || key === 'equipment.read.site',
      siteIds: [SITE_A],
    }
    const visible = scopeAnalyticsEntities(siteTier, Object.values(REPORT_VIEWS))
    const keys = visible.map((e) => e.key)
    const fleet = visible.find((e) => e.key === 'equipment_fleet')
    expect(keys).toContain('equipment_fleet')
    expect(fleet?.baseFilter, 'a site-tier view must be narrowed by the Role Scope').toBeDefined()
    expect(keys).not.toContain('incident_rates')
  })

  it('leaves super admin unfiltered', () => {
    const admin: AnalyticsScopeSubject = {
      tenantUserId: 'admin',
      personId: null,
      isSuperAdmin: true,
      permissions: () => true,
      siteIds: [SITE_A, SITE_B],
    }
    for (const view of Object.values(REPORT_VIEWS)) {
      const visible = scopeAnalyticsEntities(admin, [view])
      expect(visible, `super admin lost ${view.key}`).toHaveLength(1)
      expect(visible[0]?.baseFilter).toBeUndefined()
    }
  })

  it('preserves an authored baseFilter instead of replacing it', () => {
    const authored: AnalyticsEntity = {
      ...REPORT_VIEWS.equipment_fleet!,
      baseFilter: {
        combinator: 'and',
        rules: [{ field: 'status', op: 'eq', value: 'in_service' }],
      },
    }
    const visible = scopeAnalyticsEntities(foremanA(), [authored])
    expect(visible).toHaveLength(1)
    expect(filterFor(visible[0]?.baseFilter, 'status')).toBeDefined()
    expect(filterFor(visible[0]?.baseFilter, 'current_site_org_unit_id')?.value).toEqual([SITE_A])
  })

  it('withholds a site-scoped caller with an empty site list', () => {
    expect(scopeAnalyticsEntities(foremanA([]), [REPORT_VIEWS.equipment_fleet!])).toEqual([])
  })

  it('keeps `reports.read` out of the analytics tier ladder', () => {
    // The fail-closed default depends on there being no `reports.read.all` /
    // `.site` / `.self` to satisfy. `reports.builder` and `reports.schedule` are
    // authoring capabilities, not read tiers, and are expected to remain.
    const keys = PERMISSION_CATALOGUE as unknown as string[]
    expect(keys.filter((k) => k.startsWith('reports.read.'))).toEqual([])
    expect(keys).toContain('reports.read')
  })

  it('withholds a report view nobody has mapped yet', () => {
    // The default is what protects the NEXT report view. A subject holding every
    // module permission in the catalogue still must not receive a view that has
    // no entry, because `reports.read` alone is not a data grant.
    const future = entity('future_view', 'report_future_thing', ['id', 'site_org_unit_id'])
    const everythingButReportsTier: AnalyticsScopeSubject = {
      tenantUserId: 'u',
      personId: null,
      isSuperAdmin: false,
      permissions: (key) => {
        const all = PERMISSION_CATALOGUE as unknown as string[]
        return all.includes(key) && !key.startsWith('reports.read.')
      },
      siteIds: [SITE_A],
    }
    expect(scopeAnalyticsEntities(everythingButReportsTier, [future])).toEqual([])
    // super admin is unaffected
    expect(
      scopeAnalyticsEntities({ ...everythingButReportsTier, isSuperAdmin: true }, [future]),
    ).toHaveLength(1)
  })
})

describe('F1 — siteIdsFromScopes still feeds the filter', () => {
  it('extracts the site ids a report filter is built from', () => {
    const ids = siteIdsFromScopes([{ type: 'sites', siteIds: [SITE_A] }] as unknown as Parameters<
      typeof siteIdsFromScopes
    >[0])
    expect(ids).toEqual([SITE_A])
  })
})

/**
 * R2 — `report_compliance_status` was declared with a FLAT key
 * (`read: { key: 'compliance.read' }`). A flat key resolves to tier 'all', and
 * `resolveEntity` returns `filter: undefined` before `pickColumn` is ever
 * called, so the site/person/user columns declared beside it were unreachable and
 * every `compliance.read` holder — including a site-scoped foreman — received the
 * entity tenant-wide.
 *
 * The entity is now declared with `read: { prefix: 'compliance' }`, which takes the
 * ordinary tiered path. Its declared columns are asserted here from the real
 * `packages/reports` entity, so this cannot drift from production source.
 */
describe('R2 — report_compliance_status is scoped, not granted tenant-wide', () => {
  /** The columns `packages/reports` actually exposes for this entity. */
  const COMPLIANCE_COLUMNS = [
    'source_module',
    'obligation_title',
    'subject_key',
    'person_name',
    'status',
    'period_start',
    'period_end',
    'due_on',
    'completed_on',
    'count',
    'expected',
    'percent',
    'computed_at',
  ]
  const complianceStatus = entity(
    'compliance_status',
    'report_compliance_status',
    COMPLIANCE_COLUMNS,
    { category: 'compliance' },
  )

  /**
   * A foreman-shaped subject. By default it is `restricted` to `siteIds`, which is
   * the realistic case: an employee with a personnel placement, not a company-wide
   * administrator. `scope` overrides the Project Scope so a case can be made
   * unrestricted or unresolved.
   */
  const subject = (
    keys: string[],
    siteIds: string[] = [SITE_A],
    scope: Partial<AnalyticsScopeSubject> = {},
  ): AnalyticsScopeSubject => ({
    tenantUserId: 'tu_foreman',
    personId: 'person_foreman',
    isSuperAdmin: false,
    permissions: (key) => keys.includes(key),
    siteIds,
    ...scope,
  })

  it('exposes no scope column, so the outcome is fail-closed rather than tenant-wide', () => {
    // Recorded deliberately: the entity has neither a location nor a person_id
    // column, so a scoped tier resolves to no predicate and the ladder withholds
    // the entity. That is strictly narrower than the tenant-wide answer it
    // replaced, and it does not invent a filter on a column that does not exist.
    expect(COMPLIANCE_COLUMNS).not.toContain('site_org_unit_id')
    expect(COMPLIANCE_COLUMNS).not.toContain('person_id')
  })

  it('no longer hands a foreman an unfiltered entity', () => {
    const scoped = scopeAnalyticsEntities(subject(['compliance.read', 'compliance.read.site']), [
      complianceStatus,
    ])
    const first = scoped[0]
    // Either withheld, or filtered — but never an undefined (tenant-wide) filter.
    if (first) expect(first.baseFilter, 'a visible entity must carry a filter').toBeDefined()
    else expect(scoped).toHaveLength(0)
  })

  it('grants a register-wide reader the whole register — that is what read.all means', () => {
    // `compliance.read.all` resolves tier `all`, and tier `all` is the tenant. This
    // entity exposes NO site or owner column — the underlying view joins
    // `compliance_status.person_id` only to render a name and never selects it
    // (packages/reports/src/entities.ts:393-428) — so there is nothing to narrow on
    // even if a narrower tier were intended.
    //
    // The permission is therefore the whole boundary here. Asserted so that a
    // future `compliance.read.site` cannot appear to narrow this view: with no
    // column to bind, the honest answer for a narrower tier is WITHHOLD, which is
    // the case below.
    const companyWide = scopeAnalyticsEntities(
      subject(['compliance.read', 'compliance.read.all']),
      [complianceStatus],
    )
    expect(companyWide).toHaveLength(1)
    expect(companyWide[0]?.baseFilter).toBeUndefined()
  })

  it('withholds it from a narrower tier, since no column can express that tier', () => {
    const narrower = scopeAnalyticsEntities(subject(['compliance.read', 'compliance.read.site']), [
      complianceStatus,
    ])
    expect(narrower).toHaveLength(0)
  })

  it('withholds the entity from a caller with no compliance key', () => {
    expect(scopeAnalyticsEntities(subject([]), [complianceStatus])).toHaveLength(0)
  })

  it('does not let a compliance write capability imply read', () => {
    const writer = subject(['compliance.manage', 'compliance.assign'])
    expect(scopeAnalyticsEntities(writer, [complianceStatus])).toHaveLength(0)
  })

  it('keeps a super-admin unfiltered', () => {
    const root: AnalyticsScopeSubject = {
      tenantUserId: 'tu_admin',
      personId: null,
      isSuperAdmin: true,
      permissions: () => false,
      siteIds: [],
    }
    const all = scopeAnalyticsEntities(root, [complianceStatus])
    expect(all).toHaveLength(1)
    expect(all[0]?.baseFilter).toBeUndefined()
  })
})

/**
 * `report_hazid_signatures` — the projection renamed so discovery would inject it.
 *
 * Renaming the curated entry's table to the `report_` convention is what makes the
 * seeded `hazid_signatures` report reachable at all: `discover.ts` only injects a
 * curated entity whose table starts with `report_`. But it also moves the entity
 * off the `hazid_` prefix rule, and the `report_` default is the studio-wide
 * `reports.read` — so without an explicit `TABLE_SCOPE` entry, renaming the table
 * would have WIDENED access: any holder of `reports.read` could read every
 * hazard-assessment signature in the tenant.
 *
 * These assertions pin the rebinding to the Hazard ID module's own ladder, and
 * pin it against the base table the projection actually reads from.
 */
describe('report_hazid_signatures stays on the Hazard ID ladder', () => {
  const signatures = entity('hazid_signatures', 'report_hazid_signatures', [
    'assessment_id',
    'signature_type',
    'person_id',
    'external_name',
    'signed_at',
  ])

  it('is NOT exposed to a caller holding only the studio grant', () => {
    const studioOnly: AnalyticsScopeSubject = {
      tenantUserId: 'verif-viewer',
      personId: null,
      isSuperAdmin: false,
      permissions: (key) => key === 'reports.read',
      siteIds: [],
    }
    expect(scopeAnalyticsEntities(studioOnly, [signatures])).toHaveLength(0)
  })

  it('is exposed to a Hazard ID reader, and narrowed by their tier', () => {
    // `hazid.read.all` -> no row predicate, RLS bounds the tenant.
    const manager = subject('safety_manager')
    const all = scopeAnalyticsEntities(manager, [signatures])
    expect(all).toHaveLength(1)
    expect(all[0]?.baseFilter).toBeUndefined()

    // A self-tier reader must still be pinned to their own rows.
    const worker = subject('worker', { personId: 'verif-worker' })
    const own = scopeAnalyticsEntities(worker, [signatures])
    expect(own).toHaveLength(1)
    expect(filterFor(own[0]?.baseFilter, 'person_id')?.value).toEqual(['verif-worker'])
  })

  it('resolves identically to the base table it projects from', () => {
    // The projection joins `hazid_assessments`/`people` off
    // `hazid_assessment_signatures`, so it must not be more permissive than that
    // table under any tier.
    const base = entity('hazid_assessment_signatures', 'hazid_assessment_signatures', [
      'assessment_id',
      'signature_type',
      'person_id',
      'external_name',
      'signed_at',
    ])
    for (const role of ['worker', 'foreman', 'safety_manager'] as const) {
      for (const siteIds of [[], [SITE_A]]) {
        const viewer = subject(role, { siteIds, personId: 'verif-worker' })
        const projection = scopeAnalyticsEntities(viewer, [signatures])
        const source = scopeAnalyticsEntities(viewer, [base])
        expect(projection.length, `${role} @ ${siteIds.length} sites`).toBe(source.length)
      }
    }
  })
})

/**
 * Phase 1 — `safe_distance_records` on the NATIVE read tier.
 *
 * The spec's read rule changed from the flat key `tools.safe-distance.use` to the
 * tiered prefix `tools.safe-distance`, so `tierFor` now resolves a real tier from
 * `tools.safe-distance.read.{all,site,self}` and `resolveEntity` applies the
 * ordinary site/self branches. Two consequences are asserted here.
 *
 * 1. The tier actually narrows. With the flat key, `tierFor` returned 'all' for
 *    every holder of the operate capability, so a report could read every pressure
 *    test in the tenant. That was the defect; these tests are the fix's contract.
 *
 * 2. `operator_person_id` remains in `PERSON_COLUMNS`, APPENDED and never
 *    inserted. `pickColumn` returns the first candidate the entity actually has, so
 *    appending can only affect an entity with none of the earlier names — verified
 *    against the live schema to be `safe_distance_records` and nothing else. The
 *    self tier has no other person column to bind, so removing it would withhold
 *    the table from every self-tier holder.
 */
describe('Phase 1 — safe_distance reads through the native tier', () => {
  const OPERATOR_A = '9a000000-0000-4000-8000-0000000000a1'
  const OPERATOR_B = '9a000000-0000-4000-8000-0000000000b1'

  /** The declared columns of `safe_distance_records`, per the live schema. */
  const safeDistance = entity('safe_distance', 'safe_distance_records', [
    'reference',
    'name',
    'method',
    'occurred_at',
    'site_org_unit_id',
    'operator_person_id',
    'supervisor_tenant_user_id',
  ])

  /** Holds exactly the named Safe Distance permission; scope comes from `siteIds`. */
  const sdUser = (
    permission: string,
    over: Partial<AnalyticsScopeSubject> = {},
  ): AnalyticsScopeSubject => ({
    tenantUserId: 'tu_operator',
    personId: OPERATOR_A,
    isSuperAdmin: false,
    permissions: (key) => key === permission,
    siteIds: [],
    ...over,
  })

  it('read.all is unrestricted: no baseFilter, RLS alone bounds the tenant', () => {
    const visible = scopeAnalyticsEntities(sdUser('tools.safe-distance.read.all'), [safeDistance])
    expect(visible).toHaveLength(1)
    expect(visible[0]?.baseFilter).toBeUndefined()
  })

  it('read.site + site A binds site_org_unit_id to site A only', () => {
    const visible = scopeAnalyticsEntities(
      sdUser('tools.safe-distance.read.site', { siteIds: [SITE_A] }),
      [safeDistance],
    )
    expect(visible).toHaveLength(1)
    const values = filterFor(visible[0]?.baseFilter, 'site_org_unit_id')?.value as string[]
    expect(values).toEqual([SITE_A])
    expect(values).not.toContain(SITE_B)
  })

  it('read.site with no site ids is WITHHELD, not widened to the tenant', () => {
    // The analytics half of the pre-existing `read.site` divergence: the web ladder
    // falls through to own-only, analytics withholds. Asserted so it stays
    // deliberate rather than accidental. What must never happen is tenant-wide.
    const visible = scopeAnalyticsEntities(sdUser('tools.safe-distance.read.site'), [safeDistance])
    expect(visible).toEqual([])
  })

  it('read.self binds operator_person_id to the caller, never to another operator', () => {
    const mine = scopeAnalyticsEntities(sdUser('tools.safe-distance.read.self'), [safeDistance])
    expect(mine).toHaveLength(1)
    expect(filterFor(mine[0]?.baseFilter, 'operator_person_id')?.value).toEqual([OPERATOR_A])

    const theirs = scopeAnalyticsEntities(
      sdUser('tools.safe-distance.read.self', { personId: OPERATOR_B }),
      [safeDistance],
    )
    const values = filterFor(theirs[0]?.baseFilter, 'operator_person_id')?.value as string[]
    expect(values).toEqual([OPERATOR_B])
    expect(values).not.toContain(OPERATOR_A)
  })

  it('the operate capability ALONE no longer grants tenant-wide rows', () => {
    // The regression this phase exists to close. `tools.safe-distance.use` is held
    // by all four built-in roles, so a flat-key spec let a field worker read every
    // pressure test in the tenant through a saved report.
    const visible = scopeAnalyticsEntities(sdUser('tools.safe-distance.use'), [safeDistance])
    expect(visible).toEqual([])
  })

  it('a caller with no Safe Distance permission sees nothing at all', () => {
    expect(scopeAnalyticsEntities(sdUser('incidents.read.all'), [safeDistance])).toEqual([])
  })

  it('a super-admin is unrestricted', () => {
    const visible = scopeAnalyticsEntities(sdUser('incidents.read.all', { isSuperAdmin: true }), [
      safeDistance,
    ])
    expect(visible).toHaveLength(1)
    expect(visible[0]?.baseFilter).toBeUndefined()
  })

  it('leaves every earlier person candidate in priority, so no other module is stolen', () => {
    // An entity that has BOTH `person_id` and `operator_person_id` must keep
    // binding `person_id`. If `operator_person_id` were ever inserted before an
    // existing name, this would fail — which is the regression worth preventing.
    for (const [earlier, later] of [
      ['person_id', 'operator_person_id'],
      ['subject_person_id', 'operator_person_id'],
      ['driver_person_id', 'operator_person_id'],
      ['inspector_person_id', 'operator_person_id'],
      ['current_holder_person_id', 'operator_person_id'],
    ] as const) {
      const both = entity('safe_distance', 'safe_distance_records', [
        earlier,
        later,
        'site_org_unit_id',
      ])
      const visible = scopeAnalyticsEntities(sdUser('tools.safe-distance.read.self'), [both])
      expect(filterFor(visible[0]?.baseFilter, earlier)?.value, earlier).toEqual([OPERATOR_A])
      expect(filterFor(visible[0]?.baseFilter, later), earlier).toBeUndefined()
    }
  })

  it('the three tier keys exist in the catalogue for the four built-in roles', () => {
    for (const key of ['all', 'site', 'self'] as const) {
      expect(PERMISSION_CATALOGUE).toContain(`tools.safe-distance.read.${key}`)
    }
    expect(BUILTIN_ROLES.worker?.permissions).toContain('tools.safe-distance.read.self')
    expect(BUILTIN_ROLES.foreman?.permissions).toContain('tools.safe-distance.read.site')
    expect(BUILTIN_ROLES.safety_manager?.permissions).toContain('tools.safe-distance.read.all')
  })
})
