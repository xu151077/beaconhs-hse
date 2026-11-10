import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireRequestContext } from '@/lib/auth'
import { withRouteErrors, noStore, ApiError } from '@/lib/api/errors'
import { listCrossTenantAuditGrants, requestCrossTenantAuditAccess } from '@/lib/audit/cross-tenant'
import { AUDIT_GRANT_MAX_WINDOW_DAYS } from '@beaconhs/db/audit-access'

export const dynamic = 'force-dynamic'

function parseDate(value: unknown, name: string): Date {
  if (typeof value !== 'string') {
    throw ApiError.invalid(`${name} is required as an ISO timestamp`)
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw ApiError.invalid(`${name} is not a valid date`)
  return d
}

/** List grants — approvers see all, requesters see their own. */
export const GET = withRouteErrors(async () => {
  const ctx = await requireRequestContext()
  const { grants, canApprove } = await listCrossTenantAuditGrants(ctx)
  return NextResponse.json({ grants, canApprove }, { headers: noStore() })
})

/** Submit a cross-tenant audit access request. Any authenticated member may
 * apply; a different subject with the approval permission must approve. */
export const POST = withRouteErrors(async (req: NextRequest) => {
  const ctx = await requireRequestContext()
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'A JSON body is required' } },
      { status: 400, headers: noStore() },
    )
  }
  const startsAt = parseDate(body.startsAt, 'startsAt')
  const expiresAt = parseDate(body.expiresAt, 'expiresAt')
  const maxSpan = AUDIT_GRANT_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000
  if (expiresAt.getTime() - startsAt.getTime() > maxSpan) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_request',
          message: `Grant window exceeds the ${AUDIT_GRANT_MAX_WINDOW_DAYS}-day maximum`,
        },
      },
      { status: 400, headers: noStore() },
    )
  }
  const grant = await requestCrossTenantAuditAccess(ctx, {
    scope: String(body.scope ?? ''),
    purpose: String(body.purpose ?? ''),
    startsAt,
    expiresAt,
    extraApproval: body.extraApproval === true,
  })
  return NextResponse.json({ grant }, { status: 201, headers: noStore() })
})
