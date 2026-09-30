import { describe, expect, it } from 'vitest'
import type { AnalyticsEntity } from '@beaconhs/analytics'
import { discoverEntities } from '@beaconhs/analytics/server'
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

describe('scheduled report run-as authorization', () => {
  it("pins the run-as member's site scope onto the source inventory", () => {
    const ctx = runAsCtx()
    const scoped = scopeReportSourcesForRunAs(ctx, discovered())
    const incidents = entityFor(scoped, 'incidents')

    expect(incidents.baseFilter).toEqual({
      combinator: 'and',
      rules: [{ field: 'site_org_unit_id', op: 'in', value: [SITE_A] }],
    })
  })

  it('does not carry the impersonated tenant-wide data for a site-scoped member', () => {
    const scoped = scopeReportSourcesForRunAs(runAsCtx(), discovered())
    const incidents = entityFor(scoped, 'incidents')
    const serialized = JSON.stringify(incidents.baseFilter)

    expect(serialized).toContain(SITE_A)
    expect(serialized).not.toContain(SITE_B)
  })

  it('drops sources the run-as member has no module read permission for', () => {
    const sources = discovered()
    const scoped = scopeReportSourcesForRunAs(runAsCtx(), sources)
    const kept = new Set(scoped.map((entity) => entity.table))

    // The foreman has reports.read + incidents.read.site and nothing else.
    expect(kept).not.toContain('ppe_items')
    expect(kept).not.toContain('compliance_obligations')
    expect(kept).toContain('incidents')
  })

  it('grants a report read but no incident read nothing to report incidents with', () => {
    const ctx = runAsCtx({ permissions: new Set(['reports.read']) })
    const scoped = scopeReportSourcesForRunAs(ctx, discovered())
    expect(scoped.map((entity) => entity.table)).not.toContain('incidents')
  })

  it('leaves a read.all member unfiltered so scheduled reports keep their reach', () => {
    const ctx = runAsCtx({
      permissions: new Set(['reports.read', 'incidents.read.all']),
      scopes: [{ type: 'tenant' }],
    })
    const incidents = entityFor(scopeReportSourcesForRunAs(ctx, discovered()), 'incidents')
    expect(incidents.baseFilter).toBeUndefined()
  })

  it('reads the site scope from the resolved membership scopes, not the role name', () => {
    const sameRoleOtherSite = reportRunAsScopeSubject(
      runAsCtx({ scopes: [{ type: 'sites', siteIds: [SITE_B] }] }),
    )
    expect(sameRoleOtherSite.siteIds).toEqual([SITE_B])
  })
})
