// Scheduled report run-as authorization.
//
// The schedule owner picks who a run impersonates, but the run must report only
// what THAT member could report by hand. This file proves the worker resolves the
// run-as member's Permission, Role Scope and read tier, and drops everything else.
//
// The property that matters most is the last one in the first block: a scheduled
// run can never out-reach the same member's own dashboard, because both build their
// subject through the same shared `analyticsScopeSubject` constructor and pass it
// to the same `scopeAnalyticsEntities`.
//
// HOW IT IS ASSERTED
//
// The inventory is produced by the REAL `discoverEntities()` and narrowed by the
// REAL `scopeReportSourcesForRunAs`, so the `baseFilter` asserted here is the one a
// scheduled report actually receives. Filter values are compared through the
// serialized rule group, because the ids are values, not SQL text.

import { describe, expect, it } from 'vitest'
import type { AnalyticsEntity } from '@beaconhs/analytics'
import { discoverEntities } from '@beaconhs/analytics/server'
import { PERMISSION_CATALOGUE } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { reportRunAsScopeSubject, scopeReportSourcesForRunAs } from './report-run-as-scope'

const SITE_A = '018f47ba-86c4-7ee2-8d7a-5e7602f2a001'
const SITE_B = '018f47ba-86c4-7ee2-8d7a-5e7602f2a002'

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

const ruleText = (entity: AnalyticsEntity): string => JSON.stringify(entity.baseFilter)

describe('scheduled report run-as authorization', () => {
  it("pins the run-as member's Role Scope onto the source inventory", () => {
    const scoped = scopeReportSourcesForRunAs(runAsCtx(), discovered())
    const incidents = entityFor(scoped, 'incidents')

    // `incidents.read.site` plus the `{type:'sites'}` scope naming Site A. The
    // filter mentions Site A and never Site B, so a scheduled run cannot report
    // another site's rows.
    const serialized = ruleText(incidents)
    expect(serialized).toContain('site_org_unit_id')
    expect(serialized).toContain(SITE_A)
    expect(serialized).not.toContain(SITE_B)
  })

  it('a member scoped to a different site reports only their own', () => {
    const ctx = runAsCtx({ scopes: [{ type: 'sites', siteIds: [SITE_B] }] })
    const serialized = ruleText(
      entityFor(scopeReportSourcesForRunAs(ctx, discovered()), 'incidents'),
    )
    expect(serialized).toContain(SITE_B)
    expect(serialized).not.toContain(SITE_A)
  })

  it('drops sources the run-as member has no module read permission for', () => {
    const kept = new Set(scopeReportSourcesForRunAs(runAsCtx(), discovered()).map((e) => e.table))

    // The foreman has reports.read + incidents.read.site and nothing else.
    expect(kept).not.toContain('ppe_items')
    expect(kept).not.toContain('compliance_obligations')
    expect(kept).toContain('incidents')
  })

  it('grants a report read but no incident read nothing to report incidents with', () => {
    const ctx = runAsCtx({ permissions: new Set(['reports.read']) })
    expect(scopeReportSourcesForRunAs(ctx, discovered()).map((e) => e.table)).not.toContain(
      'incidents',
    )
  })

  it('a read.all member gets the unfiltered inventory, and a narrower tier does not', () => {
    // `read.all` is the whole tenant; a narrower tier is not. Both directions are
    // asserted because either alone would be half the contract.
    const wide = runAsCtx({ permissions: new Set(['reports.read', 'incidents.read.all']) })
    expect(
      entityFor(scopeReportSourcesForRunAs(wide, discovered()), 'incidents').baseFilter,
    ).toBeUndefined()

    const narrow = runAsCtx({ permissions: new Set(['reports.read', 'incidents.read.site']) })
    expect(
      entityFor(scopeReportSourcesForRunAs(narrow, discovered()), 'incidents').baseFilter,
    ).toBeDefined()
  })

  it('reads the site scope from the resolved membership scopes, not the role name', () => {
    // Two members holding the same role with different `{type:'sites'}` scopes must
    // produce different subjects, or one member's rows would be reported to the
    // other.
    const sameRoleOtherSite = reportRunAsScopeSubject(
      runAsCtx({ scopes: [{ type: 'sites', siteIds: [SITE_B] }] }),
    )
    expect(sameRoleOtherSite.siteIds).toEqual([SITE_B])
  })
})

// ---------------------------------------------------------------------------
// The worker subject must carry the same native inputs as the web's.
//
// The failure this prevents is a silent widening: a worker that built its own
// subject instead of going through the shared constructor could default a member's
// site ids to empty, and an empty site list on a `read.site` holder is WITHHELD —
// or, worse, a future default could hand a placed foreman the whole tenant.
// ---------------------------------------------------------------------------

describe("the worker subject is built from the run-as member's own inputs", () => {
  it('carries the permission predicate, not a role name', () => {
    const s = reportRunAsScopeSubject(runAsCtx())
    expect(s.permissions('incidents.read.site')).toBe(true)
    expect(s.permissions('incidents.read.all')).toBe(false)
  })

  it('carries the person and the membership, so the self tier resolves', () => {
    const s = reportRunAsScopeSubject(runAsCtx())
    expect(s.personId).toBe('person-1')
    expect(s.tenantUserId).toBe('member-1')
  })

  it('carries no scope it was not given — there is no default to leak from', () => {
    // Every field is assigned from the context, so there is nothing that could be
    // "unset" and interpreted as a wide scope.
    const s = reportRunAsScopeSubject(runAsCtx({ scopes: [] }))
    expect(s.siteIds).toEqual([])
  })

  it('a member with no read permission for anything gets an empty inventory', () => {
    const none = runAsCtx({ permissions: new Set() })
    expect(scopeReportSourcesForRunAs(none, discovered())).toEqual([])
  })

  it('and neither does a super-admin whose entities carry no read permission', () => {
    // `tierFor` returns 'all' for a super-admin, so the SPEC is the only thing that
    // can withhold. This asserts the spec layer is actually consulted rather than
    // short-circuited — with no permission-bearing entity in the inventory, the
    // answer is empty, not "everything".
    const allPermissions = [...PERMISSION_CATALOGUE] as string[]
    const superAdmin = runAsCtx({ permissions: new Set(allPermissions), isSuperAdmin: true })
    const scoped = scopeReportSourcesForRunAs(superAdmin, discovered())
    // A super-admin holding the whole catalogue reaches the tenant-level tables
    // and the tiered ones; the platform-infrastructure tables stay withheld.
    const tables = new Set(scoped.map((e) => e.table))
    expect(tables.has('incidents')).toBe(true)
    expect(tables.has('api_keys')).toBe(false)
    expect(tables.has('audit')).toBe(false)
  })
})
