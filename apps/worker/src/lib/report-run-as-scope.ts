// Authorization for a scheduled report's run-as member.
//
// The schedule owner picks who a run impersonates, but the run must still only
// report what THAT member could report by hand. Two boundaries apply:
//
//   1. `canAccessTemplate` (in workers/reports.ts) decides which Builder apps
//      the source inventory may include. It says nothing about the module
//      tables a saved report then queries.
//   2. This module applies the run-as member's module read permission and row
//      scope to the source inventory, so a scheduled run cannot read past what
//      the impersonated member is allowed to see.
//
// It lives in lib/ rather than inline in the worker so the boundary is covered
// by a behavioural test rather than only a source-text assertion.

import type { AnalyticsEntity } from '@beaconhs/analytics'
import {
  scopeAnalyticsEntities,
  siteIdsFromScopes,
  type AnalyticsScopeSubject,
} from '@beaconhs/analytics/server'
import { can, type RequestContext } from '@beaconhs/tenant'

/** Resolve the identity + permission surface the analytics scope rules need. */
export function reportRunAsScopeSubject(ctx: RequestContext): AnalyticsScopeSubject {
  return {
    isSuperAdmin: ctx.isSuperAdmin,
    permissions: (key) => can(ctx, key),
    siteIds: siteIdsFromScopes(ctx.scopes),
    personId: ctx.personId,
    tenantUserId: ctx.membership?.id ?? null,
  }
}

/**
 * Narrow a discovered source inventory to what `ctx` may read, and pin a row
 * predicate on the sources they may read only narrowly. Entities the run-as
 * member has no read permission for — and entities whose scope cannot be
 * expressed — are dropped, so the report fails closed rather than reporting the
 * whole tenant.
 */
export function scopeReportSourcesForRunAs(
  ctx: RequestContext,
  sources: readonly AnalyticsEntity[],
): AnalyticsEntity[] {
  return scopeAnalyticsEntities(reportRunAsScopeSubject(ctx), sources)
}
