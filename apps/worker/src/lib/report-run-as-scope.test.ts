import { describe, expect, it } from 'vitest'
import type { AnalyticsEntity } from '@beaconhs/analytics'
import { discoverEntities, type ProjectScope } from '@beaconhs/analytics/server'
import { PERMISSION_CATALOGUE } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { reportRunAsScopeSubject, scopeReportSourcesForRunAs } from './report-run-as-scope'

const SITE_A = '018f47ba-86c4-7ee2-8d7a-5e7602f2a001'
const SITE_B = '018f47ba-86c4-7ee2-8d7a-5e7602f2a002'

/** The foreman is placed at Site A — the personnel fact Project Scope resolves. */
const AT_SITE_A: ProjectScope = { kind: 'orgUnits', orgUnitIds: [SITE_A], personIds: [] }

/** Placed at both sites, the union a two-assignment person resolves. */
const AT_BOTH: ProjectScope = { kind: 'orgUnits', orgUnitIds: [SITE_A, SITE_B], personIds: [] }

function runAsCtx(over: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'member-1', displayName: 'Foreman' },
    personId: 'person-1',
    permissions: new Set(['reports.read', 'incidents.read.site']),
    scopes: [{ type: 'sites', siteIds: [SITE_A] }],
    activeRoleId: 'foreman-role',
    db: async () => {
      throw new Error('Database access is not expected')
    },
    ...over,
  }
}

const discovered = (): AnalyticsEntity[] => discoverEntities()

function entityFor(sources: readonly AnalyticsEntity[], table: string): AnalyticsEntity {
  const found = sources.find((entity) => entity.table === table)
  if (!found) throw new Error(`fixture is missing the "${table}" source`)
  return found
}

describe('scheduled report run-as authorization', () => {
  it("pins the run-as member's site scope onto the source inventory", () => {
    const scoped = scopeReportSourcesForRunAs(runAsCtx(), discovered(), AT_SITE_A)
    const incidents = entityFor(scoped, 'incidents')

    // TWO legs, because 15B-3B introduced a second, independent restriction:
    //   1. the read TIER — `incidents.read.site` plus the `{type:'sites'}` scope
    //      naming Site A;
    //   2. Project SCOPE — the personnel placement, which independently resolves
    //      to Site A.
    // They are different facts and either alone would not be enough. Here they
    // happen to agree, so the filter mentions Site A twice; what matters is that
    // it is an `and` of both, never a single leg that could be dropped.
    const filter = incidents.baseFilter
    expect(filter?.combinator).toBe('and')
    const serialized = JSON.stringify(filter)
    expect(serialized).toContain('site_org_unit_id')
    expect(serialized).toContain(SITE_A)
    expect(serialized).not.toContain(SITE_B)
  })

  it('ANDs the Project Scope even when it is wider than the read tier', () => {
    // The two vocabularies are independent, so they can disagree. A foreman whose
    // legacy `{type:'sites'}` scope is Site A but whose personnel placement covers
    // both sites must still be confined to Site A — the narrower of the two wins,
    // and neither leg is discarded.
    const ctx = runAsCtx({
      scopes: [{ type: 'sites', siteIds: [SITE_A] }],
      permissions: new Set(['reports.read', 'incidents.read.site']),
    })
    const filter = entityFor(
      scopeReportSourcesForRunAs(ctx, discovered(), AT_BOTH),
      'incidents',
    ).baseFilter
    const serialized = JSON.stringify(filter)
    // Site A from the tier leg, and the union from the Project Scope leg.
    expect(serialized).toContain(SITE_A)
    expect(serialized).toContain(SITE_B)
    expect(filter?.combinator).toBe('and')
  })

  it('does not carry the impersonated tenant-wide data for a site-scoped member', () => {
    const scoped = scopeReportSourcesForRunAs(runAsCtx(), discovered(), AT_SITE_A)
    const serialized = JSON.stringify(entityFor(scoped, 'incidents').baseFilter)

    expect(serialized).toContain(SITE_A)
    expect(serialized).not.toContain(SITE_B)
  })

  it('drops sources the run-as member has no module read permission for', () => {
    const scoped = scopeReportSourcesForRunAs(runAsCtx(), discovered(), AT_SITE_A)
    const kept = new Set(scoped.map((entity) => entity.table))

    // The foreman has reports.read + incidents.read.site and nothing else.
    expect(kept).not.toContain('ppe_items')
    expect(kept).not.toContain('compliance_obligations')
    expect(kept).toContain('incidents')
  })

  it('grants a report read but no incident read nothing to report incidents with', () => {
    const ctx = runAsCtx({ permissions: new Set(['reports.read']) })
    const scoped = scopeReportSourcesForRunAs(ctx, discovered(), AT_SITE_A)
    expect(scoped.map((entity) => entity.table)).not.toContain('incidents')
  })

  it('leaves a read.all member unfiltered ONLY when the scope is unrestricted', () => {
    // CHANGED IN 15B-3B. A `read.all` permission is no longer sufficient for a
    // company-wide read: a member placed at one site gets a filtered inventory
    // even holding `incidents.read.all`. This is the whole point of the change,
    // and it is why a scheduled report can no longer out-reach the same member's
    // own dashboard.
    const scopedMember = runAsCtx({
      permissions: new Set(['reports.read', 'incidents.read.all']),
    })
    const narrowed = entityFor(
      scopeReportSourcesForRunAs(scopedMember, discovered(), AT_SITE_A),
      'incidents',
    )
    expect(narrowed.baseFilter).toBeDefined()
    expect(JSON.stringify(narrowed.baseFilter)).toContain(SITE_A)

    // Company-wide, it stays unfiltered.
    const companyWide = runAsCtx({
      permissions: new Set(['reports.read', 'incidents.read.all']),
      scopes: [{ type: 'tenant' }],
    })
    const wide = entityFor(
      scopeReportSourcesForRunAs(companyWide, discovered(), { kind: 'unrestricted' }),
      'incidents',
    )
    expect(wide.baseFilter).toBeUndefined()
  })

  it('reads the site scope from the resolved membership scopes, not the role name', () => {
    const sameRoleOtherSite = reportRunAsScopeSubject(
      runAsCtx({ scopes: [{ type: 'sites', siteIds: [SITE_B] }] }),
      AT_SITE_A,
    )
    expect(sameRoleOtherSite.siteIds).toEqual([SITE_B])
  })
})

// ---------------------------------------------------------------------------
// 15B-3B: the worker's Project Scope subject must behave exactly as the web's.
//
// The failure this prevents is specific: 15B-2 added the Project Scope fields to
// the subject and populated them in `apps/web` only. A scheduled report would
// then have carried `projectScopeKind: undefined` — which fails closed — so every
// scheduled report would have returned nothing. A narrower failure is worse and
// would be silent: a future refactor that defaults the worker subject to
// `unrestricted` would hand a placed foreman the whole tenant.
// ---------------------------------------------------------------------------

describe('the worker subject carries the same four Project Scope states as the web', () => {
  it('unrestricted', () => {
    const s = reportRunAsScopeSubject(runAsCtx(), { kind: 'unrestricted' })
    expect(s.projectScopeKind).toBe('unrestricted')
    expect(s.orgUnitIds).toBeUndefined()
    expect(s.projectPersonIds).toBeUndefined()
  })

  it('empty', () => {
    const s = reportRunAsScopeSubject(runAsCtx(), { kind: 'empty', reason: 'no_assignment' })
    expect(s.projectScopeKind).toBe('empty')
    expect(s.orgUnitIds).toBeUndefined()
  })

  it('restricted, carrying the org units', () => {
    const s = reportRunAsScopeSubject(runAsCtx(), AT_BOTH)
    expect(s.projectScopeKind).toBe('restricted')
    expect(s.orgUnitIds).toEqual([SITE_A, SITE_B])
  })

  it('unknown when no scope was resolved — and it fails CLOSED', () => {
    // The critical case. A worker that forgot to resolve its scope must see
    // NOTHING, not everything.
    const s = reportRunAsScopeSubject(runAsCtx())
    expect(s.projectScopeKind).toBe('unknown')
    expect(scopeReportSourcesForRunAs(runAsCtx(), discovered())).toEqual([])
  })

  it('an empty scope also withholds everything, even from a super-admin', () => {
    // The strongest form of the rule: no permission and no super-admin status can
    // reach past an empty or unknown Project Scope. `tierFor` returns 'all' for a
    // super-admin, and the scope is checked anyway.
    const allPermissions = [...PERMISSION_CATALOGUE] as string[]
    const empty = scopeReportSourcesForRunAs(
      runAsCtx({ permissions: new Set(allPermissions), isSuperAdmin: true }),
      discovered(),
      { kind: 'empty', reason: 'expired_assignment' },
    )
    expect(empty).toEqual([])
  })
})
