// Authorization for a scheduled report's run-as member.
//
// The schedule owner picks who a run impersonates, but the run must still only
// report what THAT member could report by hand. Two boundaries apply:
//
//   1. `canAccessTemplate` (in workers/reports.ts) decides which Builder apps
//      the source inventory may include. It says nothing about the module
//      tables a saved report then queries.
//   2. This module applies the run-as member's module read permission, Role Scope
//      and read tier to the source inventory, so a scheduled run cannot read past
//      what the impersonated member is allowed to see.
//
// WHY THE SUBJECT IS BUILT HERE AND NOT RESOLVED FURTHER DOWN
// `apps/web` and `apps/worker` both go through `analyticsScopeSubject` (the
// shared constructor in `@beaconhs/analytics/server`), so the two cannot drift
// into answering "what may this identity see?" differently. Everything the rules
// need comes off the `RequestContext` — no database read, so there is nothing
// for a caller to forget to pass.

import type { AnalyticsEntity } from '@beaconhs/analytics'
import {
  analyticsScopeSubject,
  scopeAnalyticsEntities,
  siteIdsFromScopes,
} from '@beaconhs/analytics/server'
import { can, type RequestContext } from '@beaconhs/tenant'

/**
 * Resolve the identity + permission surface the analytics scope rules need.
 *
 * Identical in shape to the web app's subject, because both call the same shared
 * constructor.
 */
export function reportRunAsScopeSubject(ctx: RequestContext) {
  return analyticsScopeSubject({
    isSuperAdmin: ctx.isSuperAdmin,
    permissions: (key) => can(ctx, key),
    siteIds: siteIdsFromScopes(ctx.scopes),
    personId: ctx.personId,
    tenantUserId: ctx.membership?.id ?? null,
  })
}

/**
 * Narrow a discovered source inventory to what `ctx` may read, and pin a row
 * predicate on the sources they may read only narrowly. Entities the run-as
 * member has no read permission for, and entities whose resolved tier cannot be
 * expressed against them, are dropped — so the report fails closed rather than
 * reporting the whole tenant.
 */
export function scopeReportSourcesForRunAs(
  ctx: RequestContext,
  sources: readonly AnalyticsEntity[],
): AnalyticsEntity[] {
  return scopeAnalyticsEntities(reportRunAsScopeSubject(ctx), sources)
}
