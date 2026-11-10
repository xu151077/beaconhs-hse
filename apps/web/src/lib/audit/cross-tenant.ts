// PD-02 — cross-tenant audit access orchestration (session layer).
//
// This module is the ONLY path from the web app to the cross-tenant audit
// surface. It combines, in order, every layer of the V3 §P-6 control chain:
//
//   1. Permission keys — strict `ctx.permissions.has()` ONLY. Deliberately NOT
//      `can()`/`assertCan()`: those grant super-admins everything, and V3
//      explicitly denies super-admins automatic audit access ("超级管理员不
//      自动获得"). Wildcards do not apply either — fail-closed.
//   2. AUDIT_DATABASE_URL — missing/empty/unreachable means 503, never a
//      fallback onto the business pool.
//   3. Valid grant — resolved fresh on EVERY request from the platform-level
//      grant store (revocation is immediate; nothing is cached).
//   4. Query limits — 31-day window, page ≤ 500, per-request ≤ 10,000 rows,
//      cumulative ≤ 10,000 rows per grant unless the grant carries extra
//      approval, 10 s statement timeout (enforced inside the query executor).
//   5. Trail — every query (success or failure) and every export lifecycle
//      step is appended to platform_audit_access_log.

import { ApiError } from '@/lib/api/errors'
import {
  AuditAccessError,
  assertAuditRowBudget,
  approveAuditAccessRequest,
  createAuditAccessRequest,
  listAuditAccessGrants,
  recordAuditAccessEvent,
  rejectAuditAccessRequest,
  resolveActiveAuditGrant,
  revokeAuditAccess,
  type AuditAccessGrant,
  type AuditAccessScope,
} from '@beaconhs/db/audit-access'
import {
  AUDIT_MAX_PAGE_SIZE,
  AUDIT_QUERY_MAX_ROWS,
  AUDIT_QUERY_MAX_WINDOW_DAYS,
  AuditQueryLimitError,
  queryAuditLogAcrossTenants,
  validateAuditQueryWindow,
  type AuditLogRow,
} from '@beaconhs/db/audit-query'
import {
  AuditConnectionUnavailableError,
  getAuditConnection,
  type AuditConnection,
} from '@beaconhs/db/audit-client'
import type { RequestContext } from '@beaconhs/tenant'

export { AUDIT_MAX_PAGE_SIZE } from '@beaconhs/db/audit-query'

/** Audit permission keys never ride the super-admin bypass or wildcards —
 * V3 grants them to nobody by default; only explicit membership counts. */
export function hasAuditPermission(ctx: RequestContext, key: string): boolean {
  return ctx.permissions.has(key)
}

export type CrossTenantAuditScope = AuditAccessScope

/** The strongest audit scope the caller may use, or null. 'platform' wins
 * over 'tenant' — it is the superset. */
function crossTenantAuditScopeFor(ctx: RequestContext): CrossTenantAuditScope | null {
  if (hasAuditPermission(ctx, 'audit.read.platform')) return 'platform'
  if (hasAuditPermission(ctx, 'audit.read.tenant')) return 'tenant'
  return null
}

function auditConnectionOr503(): AuditConnection {
  try {
    return getAuditConnection()
  } catch (err) {
    if (err instanceof AuditConnectionUnavailableError) {
      throw ApiError.unavailable(
        'Cross-tenant audit is not configured on this deployment (AUDIT_DATABASE_URL missing).',
      )
    }
    throw err
  }
}

function mapAuditError(err: unknown): never {
  if (err instanceof AuditAccessError) {
    if (err.code === 'not_found') throw ApiError.notFound(err.message)
    throw ApiError.invalid(err.message)
  }
  if (err instanceof AuditQueryLimitError) throw ApiError.invalid(err.message)
  throw err
}

async function activeGrantFor(
  conn: AuditConnection,
  ctx: RequestContext,
  scope: CrossTenantAuditScope,
): Promise<AuditAccessGrant> {
  const grant = await resolveActiveAuditGrant(conn, {
    granteeUserId: ctx.userId,
    scope,
    granteeTenantId: scope === 'tenant' ? ctx.tenantId : null,
    now: new Date(),
  })
  if (!grant) {
    await recordAuditAccessEvent(conn, {
      actorUserId: ctx.userId,
      actorTenantId: ctx.tenantId,
      scope,
      grantId: null,
      action: 'audit_access_denied',
      purpose: 'no active grant',
      filter: { scope },
    })
    throw ApiError.forbidden(
      'No active cross-tenant audit grant. Request access and obtain approval first.',
    )
  }
  return grant
}

export type CrossTenantAuditQueryParams = {
  from?: Date
  to?: Date
  tenantIds?: string[]
  entityTypes?: string[]
  actions?: string[]
  page?: number
  pageSize?: number
}

export type CrossTenantAuditQueryResult = {
  scope: CrossTenantAuditScope
  grantId: string
  rows: AuditLogRow[]
  rowCount: number
  hasMore: boolean
  nextPage: number | null
}

/** Run one paginated cross-tenant audit query under the full V3 §P-6 chain. */
export async function runCrossTenantAuditQuery(
  ctx: RequestContext,
  params: CrossTenantAuditQueryParams,
): Promise<CrossTenantAuditQueryResult> {
  const scope = crossTenantAuditScopeFor(ctx)
  if (!scope) {
    throw ApiError.forbidden('This account has no cross-tenant audit permission.')
  }
  const conn = auditConnectionOr503()
  const grant = await activeGrantFor(conn, ctx, scope)

  // Window: default to the trailing 24 h, then enforce the 31-day cap.
  const to = params.to ?? new Date()
  const from = params.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1000)
  try {
    validateAuditQueryWindow(from, to)
  } catch (err) {
    mapAuditError(err)
  }

  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), AUDIT_MAX_PAGE_SIZE)
  const page = Math.max(params.page ?? 1, 1)
  const offset = (page - 1) * pageSize

  // Cumulative row budget for this grant (10,000 rows unless extra approval).
  try {
    await assertAuditRowBudget(conn, {
      grantId: grant.id,
      requestedRows: pageSize,
      extraApproval: grant.extraApproval,
    })
  } catch (err) {
    await recordAuditAccessEvent(conn, {
      actorUserId: ctx.userId,
      actorTenantId: ctx.tenantId,
      scope,
      grantId: grant.id,
      action: 'audit_oversize_requested',
      purpose: grant.purpose,
      filter: { requestedRows: pageSize, page },
    })
    mapAuditError(err)
  }

  // Tenant scope is server-bound: the caller can never widen past their own
  // tenant regardless of parameters. Platform scope may filter or read all.
  const tenantIds = scope === 'tenant' ? [ctx.tenantId] : params.tenantIds
  const filter = {
    from,
    to,
    tenantIds,
    entityTypes: params.entityTypes,
    actions: params.actions,
    limit: pageSize + 1, // one extra row detects hasMore without a count query
    // the db layer caps limit at maxPageSize; keep the floor at the normal
    // page size so the +1 probe stays legal, while the row-cap check below
    // still bounds offset+limit to AUDIT_QUERY_MAX_ROWS.
    maxPageSize: Math.max(AUDIT_MAX_PAGE_SIZE, pageSize + 1),
    offset,
  }

  let rows: AuditLogRow[]
  try {
    const result = await queryAuditLogAcrossTenants(conn, filter)
    rows = result.rows
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = /statement timeout|timed out/i.test(message)
    await recordAuditAccessEvent(conn, {
      actorUserId: ctx.userId,
      actorTenantId: ctx.tenantId,
      scope,
      grantId: grant.id,
      action: timedOut ? 'audit_query_timeout' : 'audit_query_failed',
      purpose: grant.purpose,
      filter: {
        from,
        to,
        tenantIds,
        actions: params.actions,
        entityTypes: params.entityTypes,
        page,
      },
    })
    mapAuditError(err)
  }

  const hasMore = rows.length > pageSize
  if (hasMore) rows = rows.slice(0, pageSize)
  await recordAuditAccessEvent(conn, {
    actorUserId: ctx.userId,
    actorTenantId: ctx.tenantId,
    scope,
    grantId: grant.id,
    action: 'audit_query',
    purpose: grant.purpose,
    filter: { from, to, tenantIds, actions: params.actions, entityTypes: params.entityTypes, page },
    rowCount: rows.length,
  })
  return {
    scope,
    grantId: grant.id,
    rows,
    rowCount: rows.length,
    hasMore,
    nextPage: hasMore ? page + 1 : null,
  }
}

/** CSV export across tenants. Requires a grant with extra approval; every
 * lifecycle step (requested → completed / denied) is trailed. */
export async function runCrossTenantAuditExport(
  ctx: RequestContext,
  params: CrossTenantAuditQueryParams,
  render: (rows: AuditLogRow[], meta: { scope: CrossTenantAuditScope }) => Response,
): Promise<Response> {
  const scope = crossTenantAuditScopeFor(ctx)
  if (!scope) {
    throw ApiError.forbidden('This account has no cross-tenant audit permission.')
  }
  const conn = auditConnectionOr503()
  const grant = await activeGrantFor(conn, ctx, scope)
  if (!grant.extraApproval) {
    await recordAuditAccessEvent(conn, {
      actorUserId: ctx.userId,
      actorTenantId: ctx.tenantId,
      scope,
      grantId: grant.id,
      action: 'audit_export_requested',
      purpose: grant.purpose,
      filter: { denied: 'grant lacks extra approval' },
    })
    throw ApiError.forbidden(
      'Exports require a grant with extra approval. Request it from an approver.',
    )
  }

  const to = params.to ?? new Date()
  const from = params.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1000)
  try {
    validateAuditQueryWindow(from, to)
  } catch (err) {
    mapAuditError(err)
  }

  await recordAuditAccessEvent(conn, {
    actorUserId: ctx.userId,
    actorTenantId: ctx.tenantId,
    scope,
    grantId: grant.id,
    action: 'audit_export_requested',
    purpose: grant.purpose,
    filter: { from, to, tenantIds: scope === 'tenant' ? [ctx.tenantId] : params.tenantIds },
  })

  const tenantIds = scope === 'tenant' ? [ctx.tenantId] : params.tenantIds
  let rows: AuditLogRow[]
  try {
    const result = await queryAuditLogAcrossTenants(conn, {
      from,
      to,
      tenantIds,
      entityTypes: params.entityTypes,
      actions: params.actions,
      limit: AUDIT_QUERY_MAX_ROWS, // export cap: one full page under extra approval
      maxPageSize: AUDIT_QUERY_MAX_ROWS,
      offset: 0,
    })
    rows = result.rows
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = /statement timeout|timed out/i.test(message)
    await recordAuditAccessEvent(conn, {
      actorUserId: ctx.userId,
      actorTenantId: ctx.tenantId,
      scope,
      grantId: grant.id,
      action: timedOut ? 'audit_query_timeout' : 'audit_query_failed',
      purpose: grant.purpose,
      filter: { from, to, tenantIds, export: true },
    })
    mapAuditError(err)
  }

  await recordAuditAccessEvent(conn, {
    actorUserId: ctx.userId,
    actorTenantId: ctx.tenantId,
    scope,
    grantId: grant.id,
    action: 'audit_export_completed',
    purpose: grant.purpose,
    filter: { from, to, tenantIds, entityTypes: params.entityTypes, actions: params.actions },
    rowCount: rows.length,
  })
  return render(rows, { scope })
}

// ---------------------------------------------------------------------------
// Grant management (P-4 flows over the audit connection)
// ---------------------------------------------------------------------------

export type AuditGrantRequestInput = {
  scope: string
  purpose: string
  startsAt: Date
  expiresAt: Date
  extraApproval: boolean
}

export async function requestCrossTenantAuditAccess(
  ctx: RequestContext,
  input: AuditGrantRequestInput,
): Promise<AuditAccessGrant> {
  // Any authenticated member may apply; the approver (a different subject)
  // and the permission keys gate actual access. Scope validity is enforced
  // by createAuditAccessRequest.
  const conn = auditConnectionOr503()
  try {
    return await createAuditAccessRequest(conn, {
      granteeUserId: ctx.userId,
      granteeTenantId: input.scope === 'tenant' ? ctx.tenantId : null,
      scope: input.scope as AuditAccessScope,
      purpose: input.purpose,
      extraApproval: input.extraApproval,
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      requestedBy: ctx.userId,
      now: new Date(),
    })
  } catch (err) {
    mapAuditError(err)
  }
}

export type AuditGrantDecisionInput = {
  grantId: string
  action: 'approve' | 'reject' | 'revoke'
  extraApproval?: boolean
}

export async function decideCrossTenantAuditGrant(
  ctx: RequestContext,
  input: AuditGrantDecisionInput,
): Promise<AuditAccessGrant> {
  const conn = auditConnectionOr503()
  try {
    if (input.action === 'approve') {
      return await approveAuditAccessRequest(conn, {
        grantId: input.grantId,
        approverUserId: ctx.userId,
        extraApproval: input.extraApproval ?? false,
        now: new Date(),
      })
    }
    if (input.action === 'reject') {
      return await rejectAuditAccessRequest(conn, {
        grantId: input.grantId,
        approverUserId: ctx.userId,
        now: new Date(),
      })
    }
    return await revokeAuditAccess(conn, {
      grantId: input.grantId,
      revokedByUserId: ctx.userId,
      now: new Date(),
    })
  } catch (err) {
    mapAuditError(err)
  }
}

/** Grants for the UI: approvers see everything, requesters only their own. */
export async function listCrossTenantAuditGrants(
  ctx: RequestContext,
  req: { limit?: number; offset?: number } = {},
): Promise<{ grants: AuditAccessGrant[]; canApprove: boolean }> {
  const conn = auditConnectionOr503()
  const canApprove = hasAuditPermission(ctx, 'admin.audit.approve')
  const grants = await listAuditAccessGrants(conn, {
    granteeUserId: canApprove ? undefined : ctx.userId,
    limit: req.limit,
    offset: req.offset,
  })
  return { grants, canApprove }
}
