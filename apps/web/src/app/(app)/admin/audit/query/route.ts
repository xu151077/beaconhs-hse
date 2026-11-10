import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireRequestContext } from '@/lib/auth'
import { withRouteErrors, noStore, ApiError } from '@/lib/api/errors'
import { runCrossTenantAuditQuery, AUDIT_MAX_PAGE_SIZE } from '@/lib/audit/cross-tenant'
import { isUuid } from '@/lib/list-params'

export const dynamic = 'force-dynamic'

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    throw ApiError.invalid('from/to must be ISO timestamps')
  }
  return d
}

function parseList(value: string | null, validate?: (v: string) => boolean): string[] | undefined {
  if (!value) return undefined
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (items.length === 0) return undefined
  if (validate && items.some((v) => !validate(v))) {
    throw ApiError.invalid('invalid list parameter')
  }
  return items
}

/** Paginated cross-tenant audit query. All limits are enforced server-side in
 * runCrossTenantAuditQuery: permission key, active grant, 31-day window,
 * page ≤ 500, ≤ 10,000 rows per grant (unless extra approval), 10 s timeout. */
export const GET = withRouteErrors(async (req: NextRequest) => {
  const ctx = await requireRequestContext()
  const sp = new URL(req.url).searchParams
  let pageSize = Number.parseInt(sp.get('pageSize') ?? '50', 10)
  if (!Number.isSafeInteger(pageSize)) pageSize = 50
  pageSize = Math.min(Math.max(pageSize, 1), AUDIT_MAX_PAGE_SIZE)
  let page = Number.parseInt(sp.get('page') ?? '1', 10)
  if (!Number.isSafeInteger(page) || page < 1) page = 1

  const result = await runCrossTenantAuditQuery(ctx, {
    from: parseDate(sp.get('from')),
    to: parseDate(sp.get('to')),
    tenantIds: parseList(sp.get('tenantIds'), (v) => isUuid(v)),
    entityTypes: parseList(sp.get('entityTypes')),
    actions: parseList(sp.get('actions')),
    page,
    pageSize,
  })
  return NextResponse.json(
    {
      scope: result.scope,
      grantId: result.grantId,
      rowCount: result.rowCount,
      hasMore: result.hasMore,
      nextPage: result.nextPage,
      rows: result.rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        actorUserId: r.actorUserId,
        actorIp: r.actorIp,
        entityType: r.entityType,
        entityId: r.entityId,
        action: r.action,
        summary: r.summary,
        occurredAt: r.occurredAt.toISOString(),
      })),
    },
    { headers: noStore() },
  )
})
