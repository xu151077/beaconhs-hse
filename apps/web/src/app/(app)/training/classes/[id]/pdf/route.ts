// GET /training/classes/:id/pdf
//
// Render a training class PDF on demand — the printable session sheet with its
// roster. Uses the tenant's configured template for the `training-classes`
// module when one is set, else the generic record summary.

import { eq } from 'drizzle-orm'
import { trainingClasses } from '@beaconhs/db/schema'
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
  // The roster names every attendee, so printing is a class-management action —
  // the same permission every class mutation asserts.
  assertCan(ctx, 'training.class.manage')

  const [cls] = await ctx.db((tx) =>
    tx
      .select({ id: trainingClasses.id })
      .from(trainingClasses)
      .where(eq(trainingClasses.id, id))
      .limit(1),
  )
  if (!cls) return Response.json({ error: 'Not found' }, { status: 404 })

  const response = await renderModulePdfResponse(ctx, {
    moduleKey: 'training-classes',
    recordId: id,
  })
  if (response.ok) {
    await recordAudit(ctx, {
      entityType: 'training_class',
      entityId: id,
      action: 'export',
      summary: 'Exported PDF',
      metadata: { format: 'pdf' },
    })
  }
  return response
}

export const GET = withRouteErrors(getHandler)
