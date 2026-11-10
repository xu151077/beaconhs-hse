// PD-01 phase 3 — per-entity record-scope mapping for the public API.
//
// The public API already runs every query inside a tenant-bound transaction, so
// RLS is the second layer. This module is the FIRST layer: it turns the caller's
// RoleScope into a row predicate using the same `recordVisibilityWhere` the UI
// uses, so a bound API credential sees exactly what the same person sees in the
// app.
//
// Only entities whose owner columns are confirmed and frozen appear in the map
// (see BEACONHS_PD01_PHASE3_ENTITY_MAPPING.md). An entity that is missing from
// the map FAILS CLOSED under a non-tenant scope — never silently tenant-wide.
// An unbound credential still carries `[{type:'tenant'}]`, so every existing
// key keeps today's behaviour byte-for-byte.

import { and, eq, sql, type SQL } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import type { Database } from '@beaconhs/db'
import { correctiveActions } from '@beaconhs/db/schema'
import { ApiError } from './errors'
import { recordVisibilityWhere, type RecordOwnerColumns } from '@/lib/visibility'

type ScopeEntry = {
  table: PgTable
  id: PgColumn
  tenantId: PgColumn
  cols: RecordOwnerColumns
  /** Body key that names the record's site, for create-time scope checks. */
  bodySiteKey?: string
}

const API_ENTITY_SCOPE: Record<string, ScopeEntry> = {
  // Frozen by product 2026-11-10: self scope = the owner, never assignedBy/createdBy.
  corrective_actions: {
    table: correctiveActions,
    id: correctiveActions.id,
    tenantId: correctiveActions.tenantId,
    cols: {
      siteCol: correctiveActions.siteOrgUnitId,
      createdByCol: correctiveActions.ownerTenantUserId,
    },
    bodySiteKey: 'siteOrgUnitId',
  },
}

function isTenantScope(ctx: { scopes: Array<{ type: string }> }): boolean {
  return ctx.scopes.some((scope) => scope.type === 'tenant')
}

/**
 * Row predicate for list/detail reads. `undefined` means "no narrowing", which
 * only happens for a tenant-scoped caller (the legacy, unbound credential).
 */
export async function entityScopeWhere(
  ctx: { scopes: Array<{ type: string }> } & Parameters<typeof recordVisibilityWhere>[0],
  tx: Database,
  entityKey: string,
): Promise<SQL | undefined> {
  if (isTenantScope(ctx)) return undefined
  const entry = API_ENTITY_SCOPE[entityKey]
  // Not mapped: fail closed. A scoped credential must never fall back to the
  // whole tenant just because an entity has no mapping yet.
  if (!entry) return sql`false`
  return recordVisibilityWhere(ctx, tx, entry.cols)
}

/**
 * Assert the addressed row is inside the caller's scope before a mutation runs.
 * Returns 404 (not 403) so a scoped credential cannot probe which ids exist.
 */
export async function assertEntityInScope(
  ctx: Parameters<typeof recordVisibilityWhere>[0],
  entityKey: string,
  id: string,
): Promise<void> {
  if (isTenantScope(ctx)) return
  const entry = API_ENTITY_SCOPE[entityKey]
  if (!entry) throw ApiError.notFound(`No ${entityKey} with id ${id}`)
  const visible = await ctx.db(async (tx) => {
    const scope = await recordVisibilityWhere(ctx, tx, entry.cols)
    const where = and(eq(entry.id, id), eq(entry.tenantId, ctx.tenantId), scope)
    const [row] = await tx.select({ id: entry.id }).from(entry.table).where(where).limit(1)
    return row ?? null
  })
  if (!visible) throw ApiError.notFound(`No ${entityKey} with id ${id}`)
}

/**
 * Create-time check: a scoped credential may only create a record at a site it
 * can see. Entities without a known site field are left to the handler (they
 * carry no site), which is safe because their reads are still scope-filtered.
 */
export function assertCreateInScope(
  ctx: { scopes: Array<{ type: string }> },
  entityKey: string,
  body: unknown,
): void {
  if (isTenantScope(ctx)) return
  const entry = API_ENTITY_SCOPE[entityKey]
  if (!entry?.bodySiteKey) return
  const allowed = new Set<string>()
  for (const scope of ctx.scopes as Array<{ type: string; siteIds?: string[] }>) {
    if (scope.type === 'sites') for (const id of scope.siteIds ?? []) allowed.add(id)
  }
  const siteId =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>)[entry.bodySiteKey]
      : undefined
  if (typeof siteId !== 'string' || !allowed.has(siteId)) {
    throw ApiError.forbidden(`This API key cannot create ${entityKey} outside its site scope`)
  }
}
