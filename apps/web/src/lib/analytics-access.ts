import 'server-only'

import { asc, isNull } from 'drizzle-orm'
import type { Database } from '@beaconhs/db'
import { formTemplates, type BhqlQuery } from '@beaconhs/db/schema'
import type { AnalyticsEntity, BhqlResult } from '@beaconhs/analytics'
import {
  addTrustedSystemAppResponsesEntity,
  analyticsScopeFingerprint,
  analyticsScopeSubject as sharedAnalyticsScopeSubject,
  discoverEntitiesWithScopedApps,
  runBhql,
  scopeAnalyticsEntities,
  siteIdsFromScopes,
  type AnalyticsScopeSubject,
} from '@beaconhs/analytics/server'
import { can, type RequestContext } from '@beaconhs/tenant'
import { resolveProjectScopeIn, type ProjectScope } from './project-scope'
import { getEffectiveRoleKeys } from './effective-roles'
import {
  accessibleAnalyticsTemplates,
  analyticsAccessScopeKey,
  removeRawBuilderEntities,
} from './analytics-access-policy'

type AnalyticsAccess = {
  entities: AnalyticsEntity[]
  entityMap: Record<string, AnalyticsEntity>
  scopeKey: string
}

/** Resolve the canonical fail-closed catalog inside the caller's tenant tx. */
export async function resolveAnalyticsAccess(
  ctx: RequestContext,
  tx: Database,
): Promise<AnalyticsAccess> {
  const [templates, roleKeys] = await Promise.all([
    tx
      .select({
        id: formTemplates.id,
        name: formTemplates.name,
        status: formTemplates.status,
        allowedRoles: formTemplates.allowedRoles,
        deletedAt: formTemplates.deletedAt,
      })
      .from(formTemplates)
      .where(isNull(formTemplates.deletedAt))
      .orderBy(asc(formTemplates.name)),
    getEffectiveRoleKeys(ctx, tx),
  ])
  const accessible = accessibleAnalyticsTemplates(ctx, templates, roleKeys)
  const discovered = removeRawBuilderEntities(
    await discoverEntitiesWithScopedApps(
      tx,
      accessible.map(({ id, name }) => ({ id, name })),
    ),
  )
  // Authorization boundary: drop every entity the caller has no module read
  // permission for, and pin a row predicate onto the ones they may read only
  // narrowly. Both compilers AND `entity.baseFilter` under the caller's own
  // filters, so a saved report can never widen past the caller's own access.
  const subject = analyticsScopeSubject(ctx, await resolveProjectScopeIn(ctx, tx))
  const entities = scopeAnalyticsEntities(subject, discovered)
  return {
    entities,
    entityMap: Object.fromEntries(entities.map((entity) => [entity.key, entity])),
    scopeKey: analyticsAccessScopeKey({
      activeRoleId: ctx.activeRoleId,
      effectiveRoleKeys: roleKeys,
      templateIds: accessible.map((template) => template.id),
      rowScope: analyticsScopeFingerprint(subject),
    }),
  }
}

/**
 * Resolve the identity + permission surface the analytics scope rules need.
 *
 * Since 15B-3B this is a thin wrapper over the SHARED constructor in
 * `@beaconhs/analytics/server`, which `apps/worker` also calls. That is the point:
 * a scheduled report and a dashboard must answer "what may this identity see?"
 * identically, and two hand-written copies of this object are how they would
 * drift. The three Project Scope fields are no longer only cache-key inputs —
 * `resolveEntity` now reads them to pin the row predicate.
 */
function analyticsScopeSubject(
  ctx: RequestContext,
  projectScope?: ProjectScope,
): AnalyticsScopeSubject {
  return sharedAnalyticsScopeSubject(
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
 * `resolveAnalyticsAccess` already applied the caller's module read permission
 * and row scope. The trusted system-card addition is the one entity that stays
 * tenant-wide by design, so it is gated separately on a real read permission.
 *
 * "Tenant-wide" covers exactly two built-in cards — `kpi-submissions` and
 * `kpi-monitored-sessions-active` — and both are a single `count` with no
 * `groupBy`, no person, no site and no row-level output. That is why the grant is
 * tenant-wide rather than Project-Scope-scoped: a tenant KPI is not a scoped view.
 * It is NOT a licence for the underlying response records, which keep their
 * normal `moduleScopeWhere` narrowing everywhere else.
 */
export async function runAuthorizedBhql(
  ctx: RequestContext,
  query: BhqlQuery | unknown,
  opts: { maxRows?: number; trustedSystemCard?: boolean } = {},
): Promise<BhqlResult> {
  if (opts.trustedSystemCard && !canReadAppResponses(ctx)) {
    throw new Error('Not authorized to read app responses')
  }
  return ctx.db(async (tx) => {
    const access = await resolveAnalyticsAccess(ctx, tx)
    const entityMap = opts.trustedSystemCard
      ? addTrustedSystemAppResponsesEntity(access.entityMap)
      : access.entityMap
    return runBhql(tx, query, { maxRows: opts.maxRows, entityMap })
  })
}

/**
 * The tenant-wide `app_responses` KPI source, authorized by
 * `forms.response.read.all` ONLY.
 *
 * `forms.response.read.site` deliberately does NOT authorize it. A site-scoped
 * reader sees the tenant-wide total on a KPI that is a system metric by design,
 * while the same reader is correctly narrowed to their own sites everywhere the
 * underlying response records are read — so the two must not be confused. This
 * is the whole difference between "Apps Responses" (ordinary records, Project
 * Scope applied) and "Insights trusted KPI" (an aggregate, tenant-wide).
 *
 * Because the grant is a permission and not a scope, an `empty` or unresolved
 * Project Scope does not block it: `read.all` is a tenant-wide capability in its
 * own right, and there is no scope left to narrow an aggregate that has no rows.
 */
export function canReadAppResponses(ctx: RequestContext): boolean {
  return can(ctx, 'forms.response.read.all')
}
