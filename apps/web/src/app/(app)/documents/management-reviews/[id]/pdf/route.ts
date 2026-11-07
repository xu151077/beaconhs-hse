// GET /documents/management-reviews/:id/pdf
//
// Render a management review PDF on demand — the minutes: attendees, documents
// reviewed, decisions, and actions raised. Uses the tenant's configured
// template for the `documents` module when one is set, else the generic record
// summary.

import { and, eq, isNull } from 'drizzle-orm'
import { documentManagementReviews } from '@beaconhs/db/schema'
import { assertCan } from '@beaconhs/tenant'
import { requireRequestContext } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { renderModulePdfResponse } from '@/lib/module-pdf'
import { isUuid } from '@/lib/list-params'
import { isRouterPrefetch } from '@/lib/router-prefetch'

import { withRouteErrors } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

async function getHandler(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (isRouterPrefetch(request)) return new Response(null, { status: 204 })

  const { id } = await params
  if (!isUuid(id)) return Response.json({ error: 'Not found' }, { status: 404 })

  const ctx = await requireRequestContext()
  if (!ctx.tenantId) return Response.json({ error: 'No active tenant' }, { status: 400 })
  // Board-level minutes are a manage-only surface — mirrors the detail page.
  assertCan(ctx, 'documents.manage')

  const [review] = await ctx.db((tx) =>
    tx
      .select({ id: documentManagementReviews.id })
      .from(documentManagementReviews)
      .where(and(eq(documentManagementReviews.id, id), isNull(documentManagementReviews.deletedAt)))
      .limit(1),
  )
  if (!review) return Response.json({ error: 'Not found' }, { status: 404 })

  const response = await renderModulePdfResponse(ctx, { moduleKey: 'documents', recordId: id })
  if (response.ok) {
    await recordAudit(ctx, {
      entityType: 'document_management_review',
      entityId: id,
      action: 'export',
      summary: 'Exported PDF',
      metadata: { format: 'pdf' },
    })
  }
  return response
}

export const GET = withRouteErrors(getHandler)
