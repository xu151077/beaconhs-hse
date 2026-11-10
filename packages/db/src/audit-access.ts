import type { Sql } from 'postgres'
import { AUDIT_QUERY_MAX_ROWS } from './audit-query'

/**
 * PD-02 P-4 — audit access grants: request / independent approval / revoke /
 * validity resolution (V3 §3, BEACONHS_PD02_P1_P6_CLOSURE_REPORT.md §P-4).
 *
 * Every function runs on the dedicated audit connection (identity
 * `audit_service`) — the session-facing application role has NO privileges on
 * `audit_access_grants` / `platform_audit_access_log` by design, so grant
 * management and the append-only access trail cannot be forged or tampered
 * with through ordinary request context.
 *
 * Permission-key enforcement (`audit.read.tenant` / `audit.read.platform` /
 * `admin.audit.approve`) happens in the session layer before these functions
 * are reached; this module enforces the DB-level invariants: different
 * approver (CHECK + pre-check), mandatory ≤ 90-day window, purpose required,
 * fail-closed resolution (a grant is usable only when approved, unexpired,
 * unrevoked, and scope-matched).
 */

export const AUDIT_GRANT_MAX_WINDOW_DAYS = 90
export const AUDIT_GRANT_PURPOSE_MAX = 500

export type AuditAccessScope = 'tenant' | 'platform'

export type AuditAccessGrant = {
  id: string
  granteeUserId: string
  granteeTenantId: string | null
  scope: AuditAccessScope
  purpose: string
  approvedByUserId: string | null
  /** Approver-granted permission for oversized queries and exports (V3 P-6). */
  extraApproval: boolean
  startsAt: Date
  expiresAt: Date
  revokedAt: Date | null
  revokedByUserId: string | null
  createdAt: Date
}

export type AuditAccessErrorCode =
  'invalid_request' | 'not_found' | 'already_resolved' | 'already_revoked' | 'window_expired'

export class AuditAccessError extends Error {
  constructor(
    readonly code: AuditAccessErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AuditAccessError'
  }
}

type GrantRow = {
  id: string
  grantee_user_id: string
  grantee_tenant_id: string | null
  scope: string
  purpose: string
  approved_by_user_id: string | null
  extra_approval: boolean
  starts_at: Date
  expires_at: Date
  revoked_at: Date | null
  revoked_by_user_id: string | null
  created_at: Date
}

function toGrant(row: GrantRow): AuditAccessGrant {
  return {
    id: row.id,
    granteeUserId: row.grantee_user_id,
    granteeTenantId: row.grantee_tenant_id,
    scope: row.scope as AuditAccessScope,
    purpose: row.purpose,
    approvedByUserId: row.approved_by_user_id,
    extraApproval: row.extra_approval,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id,
    createdAt: row.created_at,
  }
}

/** The audit connection type is structural so tests can pass a bare pool. */
type GrantExecutor = { sql: Sql }

function isScope(value: string): value is AuditAccessScope {
  return value === 'tenant' || value === 'platform'
}

/** postgres.js rejects raw `Date` bind values; timestamps cross the wire as ISO
 * text with an explicit timestamptz cast (same convention as audit-query). */
function tsv(value: Date): string {
  return value.toISOString()
}

/** Window validation shared by request creation and approval. */
function validateAuditGrantWindow(startsAt: Date, expiresAt: Date, now: Date): void {
  if (!(expiresAt.getTime() > startsAt.getTime())) {
    throw new AuditAccessError('invalid_request', 'Grant window must end after it starts')
  }
  const maxEnds = startsAt.getTime() + AUDIT_GRANT_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000
  if (expiresAt.getTime() > maxEnds) {
    throw new AuditAccessError(
      'invalid_request',
      `Grant window exceeds the ${AUDIT_GRANT_MAX_WINDOW_DAYS}-day maximum`,
    )
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new AuditAccessError('window_expired', 'Grant window has already ended')
  }
}

async function insertAccessEvent(
  conn: GrantExecutor,
  event: {
    actorUserId: string
    actorTenantId: string | null
    scope: AuditAccessScope
    grantId: string | null
    action: string
    purpose: string
    filter?: Record<string, unknown>
    rowCount?: number | null
  },
): Promise<void> {
  await conn.sql`
    insert into platform_audit_access_log
      (actor_user_id, actor_tenant_id, scope, grant_id, action, purpose, filter, row_count)
    values
      (${event.actorUserId}, ${event.actorTenantId}, ${event.scope}, ${event.grantId},
       ${event.action}, ${event.purpose}, ${JSON.stringify(event.filter ?? {})},
       ${event.rowCount ?? null})
  `
}

/** Record one cross-tenant audit access event (query/export lifecycle) from
 * the session layer. Runs on the audit connection; the trail is append-only. */
export async function recordAuditAccessEvent(
  conn: GrantExecutor,
  event: {
    actorUserId: string
    actorTenantId: string | null
    scope: AuditAccessScope
    grantId: string | null
    action:
      | 'audit_query'
      | 'audit_query_failed'
      | 'audit_query_timeout'
      | 'audit_oversize_requested'
      | 'audit_export_requested'
      | 'audit_export_completed'
      | 'audit_access_denied'
    purpose: string
    filter?: Record<string, unknown>
    rowCount?: number | null
  },
): Promise<void> {
  await insertAccessEvent(conn, event)
}

/** List grants for the approver/requester UI, newest first. `granteeUserId`
 * restricts to one subject's own grants; without it the caller must hold the
 * approval permission (checked by the session layer). */
export async function listAuditAccessGrants(
  conn: GrantExecutor,
  req: { granteeUserId?: string; limit?: number; offset?: number },
): Promise<AuditAccessGrant[]> {
  const limit = Math.min(Math.max(req.limit ?? 50, 1), 200)
  const offset = Math.max(req.offset ?? 0, 0)
  const rows = (
    req.granteeUserId
      ? await conn.sql<GrantRow[]>`
        select id, grantee_user_id, grantee_tenant_id, scope, purpose,
          approved_by_user_id, extra_approval, starts_at, expires_at, revoked_at, revoked_by_user_id, created_at
        from audit_access_grants
        where grantee_user_id = ${req.granteeUserId}
        order by created_at desc
        limit ${limit} offset ${offset}
      `
      : await conn.sql<GrantRow[]>`
        select id, grantee_user_id, grantee_tenant_id, scope, purpose,
          approved_by_user_id, extra_approval, starts_at, expires_at, revoked_at, revoked_by_user_id, created_at
        from audit_access_grants
        order by created_at desc
        limit ${limit} offset ${offset}
      `
  ) as GrantRow[]
  return rows.map(toGrant)
}

export async function createAuditAccessRequest(
  conn: GrantExecutor,
  req: {
    granteeUserId: string
    granteeTenantId: string | null
    scope: AuditAccessScope
    purpose: string
    /** Ask the approver for oversized-query/export permission (V3 P-6). */
    extraApproval?: boolean
    startsAt: Date
    expiresAt: Date
    requestedBy?: string
    now: Date
  },
): Promise<AuditAccessGrant> {
  const purpose = req.purpose.trim()
  if (purpose.length === 0 || purpose.length > AUDIT_GRANT_PURPOSE_MAX) {
    throw new AuditAccessError(
      'invalid_request',
      `Purpose is required and must be at most ${AUDIT_GRANT_PURPOSE_MAX} characters`,
    )
  }
  if (!isScope(req.scope)) {
    throw new AuditAccessError('invalid_request', 'Scope must be "tenant" or "platform"')
  }
  if (req.scope === 'tenant' && !req.granteeTenantId) {
    throw new AuditAccessError('invalid_request', 'Tenant-scope grants require a tenant id')
  }
  if (req.scope === 'platform' && req.granteeTenantId) {
    throw new AuditAccessError(
      'invalid_request',
      'Platform-scope grants must not carry a tenant id',
    )
  }
  validateAuditGrantWindow(req.startsAt, req.expiresAt, req.now)
  const rows = await conn.sql<GrantRow[]>`
    insert into audit_access_grants
      (grantee_user_id, grantee_tenant_id, scope, purpose, extra_approval, starts_at, expires_at)
    values
      (${req.granteeUserId}, ${req.granteeTenantId}, ${req.scope}, ${purpose},
       ${req.extraApproval ?? false}, ${tsv(req.startsAt)}::timestamptz, ${tsv(req.expiresAt)}::timestamptz)
    returning id, grantee_user_id, grantee_tenant_id, scope, purpose,
      approved_by_user_id, extra_approval, starts_at, expires_at, revoked_at, revoked_by_user_id, created_at
  `
  const grant = toGrant(rows[0]!)
  await insertAccessEvent(conn, {
    actorUserId: req.requestedBy ?? req.granteeUserId,
    actorTenantId: req.granteeTenantId,
    scope: grant.scope,
    grantId: grant.id,
    action: 'grant_requested',
    purpose: grant.purpose,
  })
  return grant
}

/** Approve a pending request. The approver must differ from the grantee —
 * enforced here and by the `audit_access_grants_approver_ck` CHECK. Atomic:
 * concurrent approvals race on `approved_by_user_id IS NULL` and exactly one
 * wins. */
export async function approveAuditAccessRequest(
  conn: GrantExecutor,
  req: {
    grantId: string
    approverUserId: string
    /** Approver decision on the oversize/export extension (V3 P-6). */
    extraApproval?: boolean
    now: Date
  },
): Promise<AuditAccessGrant> {
  const pending = await conn.sql<GrantRow[]>`
    select id, grantee_user_id, grantee_tenant_id, scope, purpose,
      approved_by_user_id, extra_approval, starts_at, expires_at, revoked_at, revoked_by_user_id, created_at
    from audit_access_grants where id = ${req.grantId}
  `
  const existingGrant = pending[0]
  if (!existingGrant) throw new AuditAccessError('not_found', 'Grant not found')
  if (existingGrant.grantee_user_id === req.approverUserId) {
    throw new AuditAccessError(
      'invalid_request',
      'The approver must be a different subject than the grantee',
    )
  }
  const updated = await conn.sql<GrantRow[]>`
    update audit_access_grants
    set approved_by_user_id = ${req.approverUserId},
      extra_approval = ${req.extraApproval ?? false}, updated_at = now()
    where id = ${req.grantId}
      and approved_by_user_id is null
      and revoked_at is null
      and grantee_user_id <> ${req.approverUserId}
      and expires_at > ${tsv(req.now)}::timestamptz
    returning id, grantee_user_id, grantee_tenant_id, scope, purpose,
      approved_by_user_id, extra_approval, starts_at, expires_at, revoked_at, revoked_by_user_id, created_at
  `
  if (!updated[0]) {
    await throwResolutionState(conn, req.grantId)
  }
  const grant = toGrant(updated[0]!)
  await insertAccessEvent(conn, {
    actorUserId: req.approverUserId,
    actorTenantId: grant.granteeTenantId,
    scope: grant.scope,
    grantId: grant.id,
    action: 'grant_approved',
    purpose: grant.purpose,
  })
  return grant
}

/** Reject a pending request: the row is voided (revoked) and the trail keeps
 * the rejection. Approved grants cannot be "rejected", only revoked. */
export async function rejectAuditAccessRequest(
  conn: GrantExecutor,
  req: { grantId: string; approverUserId: string; now: Date },
): Promise<AuditAccessGrant> {
  const updated = await conn.sql<GrantRow[]>`
    update audit_access_grants
    set revoked_at = ${tsv(req.now)}::timestamptz, revoked_by_user_id = ${req.approverUserId}, updated_at = now()
    where id = ${req.grantId}
      and approved_by_user_id is null
      and revoked_at is null
      and grantee_user_id <> ${req.approverUserId}
    returning id, grantee_user_id, grantee_tenant_id, scope, purpose,
      approved_by_user_id, extra_approval, starts_at, expires_at, revoked_at, revoked_by_user_id, created_at
  `
  if (!updated[0]) {
    await throwResolutionState(conn, req.grantId)
  }
  const grant = toGrant(updated[0]!)
  await insertAccessEvent(conn, {
    actorUserId: req.approverUserId,
    actorTenantId: grant.granteeTenantId,
    scope: grant.scope,
    grantId: grant.id,
    action: 'grant_rejected',
    purpose: grant.purpose,
  })
  return grant
}

/** Revoke an approved grant — effective immediately (no cache; every query
 * re-resolves validity). */
export async function revokeAuditAccess(
  conn: GrantExecutor,
  req: { grantId: string; revokedByUserId: string; now: Date },
): Promise<AuditAccessGrant> {
  const updated = await conn.sql<GrantRow[]>`
    update audit_access_grants
    set revoked_at = ${tsv(req.now)}::timestamptz, revoked_by_user_id = ${req.revokedByUserId}, updated_at = now()
    where id = ${req.grantId}
      and approved_by_user_id is not null
      and revoked_at is null
    returning id, grantee_user_id, grantee_tenant_id, scope, purpose,
      approved_by_user_id, extra_approval, starts_at, expires_at, revoked_at, revoked_by_user_id, created_at
  `
  if (!updated[0]) {
    const rows = await conn.sql<GrantRow[]>`
      select id, grantee_user_id, grantee_tenant_id, scope, purpose,
        approved_by_user_id, extra_approval, starts_at, expires_at, revoked_at, revoked_by_user_id, created_at
      from audit_access_grants where id = ${req.grantId}
    `
    const existing = rows[0]
    if (!existing) throw new AuditAccessError('not_found', 'Grant not found')
    if (existing.revoked_at) {
      throw new AuditAccessError('already_revoked', 'Grant is already revoked')
    }
    throw new AuditAccessError('already_resolved', 'Grant is still pending approval')
  }
  const grant = toGrant(updated[0]!)
  await insertAccessEvent(conn, {
    actorUserId: req.revokedByUserId,
    actorTenantId: grant.granteeTenantId,
    scope: grant.scope,
    grantId: grant.id,
    action: 'grant_revoked',
    purpose: grant.purpose,
  })
  return grant
}

async function throwResolutionState(conn: GrantExecutor, grantId: string): Promise<never> {
  const rows = await conn.sql<GrantRow[]>`
    select id, grantee_user_id, grantee_tenant_id, scope, purpose,
      approved_by_user_id, extra_approval, starts_at, expires_at, revoked_at, revoked_by_user_id, created_at
    from audit_access_grants where id = ${grantId}
  `
  const existing = rows[0]
  if (!existing) throw new AuditAccessError('not_found', 'Grant not found')
  if (existing.revoked_at) {
    throw new AuditAccessError('already_resolved', 'Grant request was already rejected or revoked')
  }
  if (existing.approved_by_user_id) {
    throw new AuditAccessError('already_resolved', 'Grant request was already approved')
  }
  throw new AuditAccessError('window_expired', 'Grant window has already ended')
}

/**
 * Cumulative row budget per grant (V3 §P-6): repeated requests must not
 * accumulate past AUDIT_QUERY_MAX_ROWS unless the grant carries extra
 * approval. Sums the successful-query row counts already recorded in the
 * append-only trail — server-side accounting, not client-trust.
 */
export async function assertAuditRowBudget(
  conn: GrantExecutor,
  req: { grantId: string; requestedRows: number; extraApproval: boolean },
): Promise<void> {
  if (req.extraApproval) return
  const rows = await conn.sql<Array<{ used: number | string }>>`
    select coalesce(sum(row_count), 0) as used
    from platform_audit_access_log
    where grant_id = ${req.grantId} and action = 'audit_query'
  `
  const used = Number(rows[0]?.used ?? 0)
  if (used + req.requestedRows > AUDIT_QUERY_MAX_ROWS) {
    throw new AuditAccessError(
      'invalid_request',
      `Grant has consumed ${used} of the ${AUDIT_QUERY_MAX_ROWS}-row budget; request extra approval for larger reads`,
    )
  }
}

/**
 * Fail-closed validity resolution: returns the newest grant for the subject
 * only when it is approved, unexpired, unrevoked, and scope-matched. Anything
 * else — including a scope/tenant mismatch — is null. Every audit query must
 * call this immediately before executing; there is no cache by design.
 */
export async function resolveActiveAuditGrant(
  conn: GrantExecutor,
  req: {
    granteeUserId: string
    scope: AuditAccessScope
    granteeTenantId?: string | null
    now: Date
  },
): Promise<AuditAccessGrant | null> {
  const rows = await conn.sql<GrantRow[]>`
    select id, grantee_user_id, grantee_tenant_id, scope, purpose,
      approved_by_user_id, extra_approval, starts_at, expires_at, revoked_at, revoked_by_user_id, created_at
    from audit_access_grants
    where grantee_user_id = ${req.granteeUserId}
      and scope = ${req.scope}
      and approved_by_user_id is not null
      and revoked_at is null
      and starts_at <= ${tsv(req.now)}::timestamptz
      and expires_at > ${tsv(req.now)}::timestamptz
      and (
        scope = 'platform'
        or grantee_tenant_id = ${req.granteeTenantId ?? null}
      )
    order by created_at desc
    limit 1
  `
  return rows[0] ? toGrant(rows[0]) : null
}
