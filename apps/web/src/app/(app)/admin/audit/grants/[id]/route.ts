import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireRequestContext } from '@/lib/auth'
import { withRouteErrors, noStore, ApiError } from '@/lib/api/errors'
import { hasAuditPermission, decideCrossTenantAuditGrant } from '@/lib/audit/cross-tenant'
import { isUuid } from '@/lib/list-params'

export const dynamic = 'force-dynamic'

/** Approve / reject / revoke a cross-tenant audit grant. The approver must
 * hold `admin.audit.approve` (strictly — no super-admin bypass, V3 §3) and
 * must be a different subject than the grantee (DB CHECK + service check). */
export const POST = withRouteErrors(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    if (!isUuid(id)) throw ApiError.invalid('Grant id must be a uuid')
    const ctx = await requireRequestContext()
    if (!hasAuditPermission(ctx, 'admin.audit.approve')) {
      throw ApiError.forbidden('This account cannot approve cross-tenant audit grants.')
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const action = body?.action
    if (action !== 'approve' && action !== 'reject' && action !== 'revoke') {
      return NextResponse.json(
        {
          error: {
            code: 'invalid_request',
            message: 'action must be "approve", "reject" or "revoke"',
          },
        },
        { status: 400, headers: noStore() },
      )
    }
    const grant = await decideCrossTenantAuditGrant(ctx, {
      grantId: id,
      action,
      extraApproval: body?.extraApproval === true,
    })
    return NextResponse.json({ grant }, { headers: noStore() })
  },
)
