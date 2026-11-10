// PD-02 P-3 — cross-tenant audit log query executor.
//
// Every cross-tenant audit read runs here, inside a SINGLE transaction on the
// dedicated audit connection (see ./audit-client):
//
//   1. `SET LOCAL ROLE audit_reader`  — transaction-local only. The connection
//      default identity stays `audit_service` (NOBYPASSRLS, no table grants);
//      committing or rolling back restores it, so pool reuse can never leak
//      the BYPASSRLS read identity to a later request.
//   2. `SET LOCAL statement_timeout`  — bounded execution time (V3 §P-6).
//   3. A fully parameterized, read-only SELECT on `audit_log`. No dynamic SQL,
//      no string interpolation, no SECURITY DEFINER.
//
// Session-level `SET ROLE` is FORBIDDEN on this path and would be a defect.

import type postgres from 'postgres'
import { AUDIT_READER_ROLE } from './audit-roles'
import type { AuditConnection } from './audit-client'

/** V3 §P-6: hard execution timeout for audit queries. */
export const AUDIT_QUERY_STATEMENT_TIMEOUT = '10s'

/** V3 §P-6: server-side page-size cap. Any limit above this is rejected —
 * clients cannot enlarge pages by changing parameters. */
export const AUDIT_MAX_PAGE_SIZE = 500

export type AuditLogFilter = {
  /** Inclusive lower bound on occurred_at. */
  from?: Date
  /** Inclusive upper bound on occurred_at. */
  to?: Date
  /** Restrict to these tenants (uuid). Undefined = all tenants (platform
   * scope); an explicitly empty array matches nothing. */
  tenantIds?: string[]
  entityTypes?: string[]
  actions?: string[]
  /** Page size; must be within [1, AUDIT_MAX_PAGE_SIZE]. */
  limit: number
  /** Row offset; must be >= 0. */
  offset?: number
}

export type AuditLogRow = {
  id: string
  tenantId: string
  actorUserId: string | null
  actorIp: string | null
  actorUserAgent: string | null
  entityType: string
  entityId: string | null
  action: string
  summary: string | null
  occurredAt: Date
  metadata: Record<string, unknown>
}

type Sql = postgres.Sql<Record<string, unknown>>
type Fragment = ReturnType<Sql>

function buildWhere(conn: AuditConnection, filter: AuditLogFilter): Fragment {
  const conds: Fragment[] = []
  if (filter.from) conds.push(conn.sql`occurred_at >= ${filter.from}`)
  if (filter.to) conds.push(conn.sql`occurred_at <= ${filter.to}`)
  if (filter.tenantIds !== undefined) {
    // An explicitly empty scope matches nothing (fail-closed); the uuid cast
    // keeps the parameter a typed array instead of relying on inference.
    conds.push(
      filter.tenantIds.length
        ? conn.sql`tenant_id = any(${filter.tenantIds}::uuid[])`
        : conn.sql`false`,
    )
  }
  if (filter.entityTypes?.length) {
    conds.push(conn.sql`entity_type = any(${filter.entityTypes})`)
  }
  if (filter.actions?.length) {
    conds.push(conn.sql`action = any(${filter.actions})`)
  }
  // postgres.js has no sql.join; nested fragments compose parameterized ANDs.
  let joined: Fragment | null = null
  for (const cond of conds) {
    joined = joined ? conn.sql`${joined} and ${cond}` : cond
  }
  return joined ? conn.sql`where ${joined}` : conn.sql``
}

/** Run one cross-tenant audit query. Throws when the connection identity is
 * wrong, when the role switch fails, or when the query exceeds its timeout —
 * in every failure case the transaction (and with it the role switch) is
 * rolled back by postgres.js, restoring `audit_service` on the connection. */
export async function queryAuditLogAcrossTenants(
  conn: AuditConnection,
  filter: AuditLogFilter,
): Promise<{ rows: AuditLogRow[] }> {
  if (
    !Number.isSafeInteger(filter.limit) ||
    filter.limit < 1 ||
    filter.limit > AUDIT_MAX_PAGE_SIZE
  ) {
    throw new Error(`Audit page size must be within [1, ${AUDIT_MAX_PAGE_SIZE}].`)
  }
  const offset = filter.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Audit page offset must be a non-negative integer.')
  }
  const where = buildWhere(conn, filter)
  const rows = await conn.sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${AUDIT_READER_ROLE}`)
    await tx.unsafe(`set local statement_timeout = '${AUDIT_QUERY_STATEMENT_TIMEOUT}'`)
    return (await tx`
      select id, tenant_id, actor_user_id, actor_ip, actor_user_agent,
             entity_type, entity_id, action, summary, occurred_at, metadata
      from audit_log
      ${where}
      order by occurred_at desc
      limit ${filter.limit} offset ${offset}
    `) as Array<Record<string, unknown>>
  })
  return {
    rows: rows.map((r) => ({
      id: r.id as string,
      tenantId: r.tenant_id as string,
      actorUserId: (r.actor_user_id as string | null) ?? null,
      actorIp: (r.actor_ip as string | null) ?? null,
      actorUserAgent: (r.actor_user_agent as string | null) ?? null,
      entityType: r.entity_type as string,
      entityId: (r.entity_id as string | null) ?? null,
      action: r.action as string,
      summary: (r.summary as string | null) ?? null,
      occurredAt: r.occurred_at as Date,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
    })),
  }
}
