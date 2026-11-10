import type { NextRequest } from 'next/server'
import { requireRequestContext } from '@/lib/auth'
import { withRouteErrors, ApiError } from '@/lib/api/errors'
import { csvFilename, csvResponse } from '@/lib/csv'
import { runCrossTenantAuditExport } from '@/lib/audit/cross-tenant'
import { formatDateTime } from '@/lib/datetime'
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

/** Cross-tenant audit CSV export. Requires an active grant with extra
 * approval; every lifecycle step is appended to the access trail. */
export const GET = withRouteErrors(async (req: NextRequest) => {
  const ctx = await requireRequestContext()
  const sp = new URL(req.url).searchParams
  const tenantIds = sp
    .get('tenantIds')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (tenantIds?.some((v) => !isUuid(v))) {
    throw ApiError.invalid('tenantIds must be uuids')
  }
  const actions = sp
    .get('actions')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const entityTypes = sp
    .get('entityTypes')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return runCrossTenantAuditExport(
    ctx,
    {
      from: parseDate(sp.get('from')),
      to: parseDate(sp.get('to')),
      tenantIds: tenantIds && tenantIds.length ? tenantIds : undefined,
      actions: actions && actions.length ? actions : undefined,
      entityTypes: entityTypes && entityTypes.length ? entityTypes : undefined,
    },
    (rows) =>
      csvResponse({
        filename: csvFilename('cross-tenant-audit'),
        headers: [
          'occurred_at',
          'tenant_id',
          'actor_user_id',
          'actor_ip',
          'entity_type',
          'entity_id',
          'action',
          'summary',
        ],
        rows: rows.map((r) => [
          formatDateTime(r.occurredAt, ctx.timezone),
          r.tenantId,
          r.actorUserId,
          r.actorIp,
          r.entityType,
          r.entityId,
          r.action,
          r.summary,
        ]),
      }),
  )
})
