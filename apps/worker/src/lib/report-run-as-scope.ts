// Authorization for a scheduled report's run-as member.
//
// The schedule owner picks who a run impersonates, but the run must still only
// report what THAT member could report by hand. Three boundaries apply:
//
//   1. `canAccessTemplate` (in workers/reports.ts) decides which Builder apps
//      the source inventory may include. It says nothing about the module
//      tables a saved report then queries.
//   2. The caller's Project Scope is resolved once, in the run's own tenant
//      transaction, and passed in here.
//   3. This module applies the run-as member's module read permission and row
//      scope to the source inventory, so a scheduled run cannot read past what
//      the impersonated member is allowed to see.
//
// WHY THE SCOPE IS A PARAMETER AND NOT RESOLVED HERE
// Resolving inside this function would need a transaction, and this module is
// called from the middle of a report run. More importantly, making it a required
// argument is what keeps the two apps honest: `apps/web` and `apps/worker` both
// go through `analyticsScopeSubject` (the shared constructor in
// `@beaconhs/analytics/server`), so the two cannot drift into answering "what
// may this identity see?" differently.
//
// OMITTING IT FAILS CLOSED. `projectScope` is not optional in spirit: an absent
// scope becomes `projectScopeKind: 'unknown'`, and every entity is withheld. That
// is deliberate — before 15B-3B the worker had no Project Scope at all, and a
// silent default would have quietly returned every entity instead.

import type { AnalyticsEntity } from '@beaconhs/analytics'
import {
  analyticsScopeSubject,
  scopeAnalyticsEntities,
  siteIdsFromScopes,
  type ProjectScope,
} from '@beaconhs/analytics/server'
import { can, type RequestContext } from '@beaconhs/tenant'

/**
 * Resolve the identity + permission surface the analytics scope rules need.
 *
 * Identical in shape to the web app's subject, because both call the same
 * shared constructor. `projectScope` is the caller's resolved Project Scope;
 * omit it only in a test that is deliberately exercising the fail-closed path.
 */
export function reportRunAsScopeSubject(
  ctx: RequestContext,
  projectScope?: ProjectScope,
): ReturnType<typeof analyticsScopeSubject> {
  return analyticsScopeSubject(
    {
      isSuperAdmin: ctx.isSuperAdmin,
      permissions: (key) => can(ctx, key),
      siteIds: siteIdsFromScopes(ctx.scopes),
      personId: ctx.personId,
      tenantUserId: ctx.membership?.id ?? null,
    },
    projectScope,
  )
}

/**
 * Narrow a discovered source inventory to what `ctx` may read, and pin a row
 * predicate on the sources they may read only narrowly. Entities the run-as
 * member has no read permission for, entities whose Project Scope cannot be
 * expressed, and every entity when no scope was resolved, are dropped — so the
 * report fails closed rather than reporting the whole tenant.
 */
export function scopeReportSourcesForRunAs(
  ctx: RequestContext,
  sources: readonly AnalyticsEntity[],
  projectScope?: ProjectScope,
): AnalyticsEntity[] {
  return scopeAnalyticsEntities(reportRunAsScopeSubject(ctx, projectScope), sources)
}
