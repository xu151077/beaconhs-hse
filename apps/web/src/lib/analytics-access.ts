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

/** The tenant-wide `app_responses` source needs a real response-read permission. */
export function canReadAppResponses(ctx: RequestContext): boolean {
  return can(ctx, 'forms.response.read.all') || can(ctx, 'forms.response.read.site')
}
