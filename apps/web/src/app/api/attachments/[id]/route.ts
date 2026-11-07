import { NextResponse, type NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { attachments } from '@beaconhs/db/schema'
import { contentDisposition, getObjectStream, headObject } from '@beaconhs/storage'
import { validateAttachmentCapability } from '../../../../lib/attachment-url'
import { getRequestContext } from '../../../../lib/auth'

export const dynamic = 'force-dynamic'

const idSchema = z.string().uuid()

/**
 * Stable authenticated capability used by persisted form values. Both the
 * unforgeable capability and the caller's active tenant RLS scope must match;
 * neither a session nor an attachment UUID alone authorizes delivery.
 *
 * The bytes are STREAMED through this route rather than redirected to a
 * presigned object-store URL. A redirect would hand the browser a URL that
 * reaches the object store directly, which would require the object store to be
 * publicly reachable — a public hostname, a public DNS record and a second
 * tunnel route for a bucket holding every tenant's files. Streaming keeps the
 * object store on the internal network and keeps its address and credentials
 * out of the browser entirely.
 */
export async function GET(
  request: NextRequest,
  routeContext: { params: Promise<{ id: string }> },
): Promise<Response> {
  const parsedId = idSchema.safeParse((await routeContext.params).id)
  if (!parsedId.success) return new NextResponse('Not found', { status: 404 })
  const cap = request.nextUrl.searchParams.get('cap') ?? ''
  if (!validateAttachmentCapability(parsedId.data, cap)) {
    return new NextResponse('Not found', { status: 404 })
  }

  const ctx = await getRequestContext()
  if (!ctx) return new NextResponse('Unauthorized', { status: 401 })
  const attachment = await ctx.db(async (tx) => {
    const [row] = await tx
      .select({ r2Key: attachments.r2Key, filename: attachments.filename })
      .from(attachments)
      .where(eq(attachments.id, parsedId.data))
      .limit(1)
    return row ?? null
  })
  if (!attachment) return new NextResponse('Not found', { status: 404 })

  let metadata
  try {
    metadata = await headObject({ key: attachment.r2Key })
  } catch {
    metadata = null
  }
  if (!metadata) return new NextResponse('Not found', { status: 404 })

  let streamed
  try {
    streamed = await getObjectStream({ key: attachment.r2Key })
  } catch {
    return new NextResponse('Not found', { status: 404 })
  }

  const headers = new Headers()
  headers.set(
    'Content-Type',
    streamed.contentType ?? metadata.contentType ?? 'application/octet-stream',
  )
  if (streamed.contentLength ?? metadata.contentLength) {
    headers.set('Content-Length', String(streamed.contentLength ?? metadata.contentLength))
  }
  headers.set('Content-Disposition', contentDisposition('inline', attachment.filename, 'file'))
  headers.set('Cache-Control', 'private, no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')

  return new Response(streamed.stream, { status: 200, headers })
}
