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
import { correctiveActions, documents, trainingRecords } from '@beaconhs/db/schema'
import { ApiError } from './errors'
import { recordVisibilityWhere, type RecordOwnerColumns } from '@/lib/visibility'

type ScopeEntry = {
  table: PgTable
  id: PgColumn
  tenantId: PgColumn
  cols: RecordOwnerColumns
  /** Body key that names the record's site, for create-time scope checks. */
  bodySiteKey?: string
  /**
   * Some report entities are SQL VIEWS (e.g. `report_corrective_actions`) with
   * no Drizzle table definition. `recordVisibilityWhere` emits table-qualified
   * columns from `cols`, which cannot resolve against a differently-named view.
   * For those entries, build the same predicate from constant column names.
   */
  viewCols?: { siteColName?: string; ownerColName?: string; personColName?: string }
}

const API_ENTITY_SCOPE: Record<string, ScopeEntry> = {
  // Frozen by product 2026-11-10: self scope = the owner, never assignedBy/createdBy.
  corrective_actions: {
    table: correctiveActions,
    id: correctiveActions.id,
    tenantId: correctiveActions.tenantId,
    cols: {
      siteCol: correctiveActions.siteOrgUnitId,
      ownerTenantUserCol: correctiveActions.ownerTenantUserId,
    },
    bodySiteKey: 'siteOrgUnitId',
    viewCols: { siteColName: 'site_org_unit_id', ownerColName: 'owner_tenant_user_id' },
  },
  // Documents have NO site column (the site on `document_ack_sessions` is a
  // different table). Self = the document owner. A `sites` scope therefore has
  // no expressible predicate and fails closed below.
  documents: {
    table: documents,
    id: documents.id,
    tenantId: documents.tenantId,
    cols: {
      ownerTenantUserCol: documents.ownerTenantUserId,
    },
  },
  // Training records have no site column either. Self = the trainee.
  training_records: {
    table: trainingRecords,
    id: trainingRecords.id,
    tenantId: trainingRecords.tenantId,
    cols: {
      personCol: trainingRecords.personId,
    },
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
  // A `sites` scope on an entity with no site column cannot be expressed.
  // Degrading to "own records only" would silently answer a different question
  // than the caller asked, so refuse instead.
  if (
    ctx.scopes.some((scope) => scope.type === 'sites') &&
    !entry.cols.siteCol &&
    !entry.viewCols?.siteColName
  ) {
    return sql`false`
  }
  if (!entry.viewCols) return recordVisibilityWhere(ctx, tx, entry.cols)
  // View entity: identical scope semantics, expressed with unqualified column
  // names so the predicate resolves against the view in the FROM clause.
  const conds: SQL[] = []
  for (const scope of ctx.scopes) {
    if (scope.type === 'sites' && entry.viewCols.siteColName) {
      const ids = scope.siteIds ?? []
      if (ids.length > 0) {
        conds.push(sql`${sql.raw(`"${entry.viewCols.siteColName}"`)} in ${ids}`)
      }
    } else if (scope.type === 'self' && entry.viewCols.ownerColName && ctx.membership) {
      conds.push(sql`${sql.raw(`"${entry.viewCols.ownerColName}"`)} = ${ctx.membership.id}`)
    }
  }
  if (conds.length === 0) return sql`false`
  return conds.length === 1 ? conds[0]! : sql.join(conds, sql` OR `)
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
 * Reject a scoped credential from an entity whose owner semantics are not yet
 * confirmed (B-1: Builder app responses). `entityScopeWhere` returns
 * `undefined` only for a tenant-scoped caller; any SQL — including the
 * fail-closed `false` for an unmapped entity — means this credential must not
 * reach the data path at all. This runs BEFORE any row is read, so no
 * cross-scope data is ever fetched and hidden afterwards.
 */
export async function assertScopedEntityAllowed(
  ctx: Parameters<typeof recordVisibilityWhere>[0],
  entityKey: string,
): Promise<void> {
  const narrowed = await ctx.db((tx) => entityScopeWhere(ctx, tx, entityKey))
  if (narrowed !== undefined) {
    throw ApiError.forbidden(
      `Scoped API keys cannot access ${entityKey}: owner semantics are not configured`,
    )
  }
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
  // An unmapped entity has no proven owner/site columns. Never let a scoped
  // credential create one (it could then be read back outside the scope).
  if (!entry) {
    throw ApiError.forbidden(`Scoped API keys cannot create ${entityKey}`)
  }
  if (!entry.bodySiteKey) return
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
