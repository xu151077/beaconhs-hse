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

/** A subject with exactly the built-in role's permissions and a given site scope. */
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
    const safety = {
      ...viewer,
      permissions: (k: string) =>
        (BUILTIN_ROLES.safety_manager?.permissions as string[]).includes(k),
    } satisfies AnalyticsScopeSubject
    expect(scopeAnalyticsEntities(viewer, [REPORT_VIEWS.incident_rates!])).toEqual([])
    const wide = scopeAnalyticsEntities(safety, [REPORT_VIEWS.incident_rates!])
    expect(wide).toHaveLength(1)
    expect(wide[0]?.baseFilter).toBeUndefined() // tenant-wide by permission, not by accident
  })

  it('leaves safety_manager and tenant_admin with unfiltered access', () => {
    for (const role of ['safety_manager', 'tenant_admin'] as const) {
      const s = subject(role)
      for (const view of Object.values(REPORT_VIEWS)) {
        const visible = scopeAnalyticsEntities(s, [view])
        expect(visible, `${role} lost ${view.key}`).toHaveLength(1)
      }
    }
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
