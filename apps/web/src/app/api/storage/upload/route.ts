import { NextResponse, type NextRequest } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { attachmentUploadReservations } from '@beaconhs/db/schema'
import {
  MULTIPART_UPLOAD_PART_SIZE_BYTES,
  putStagedObject,
  uploadStagedPart,
} from '@beaconhs/storage'
import { getRequestContext } from '@/lib/auth'
import { normalizedContentType, uploadTokenMatches } from '@/lib/upload-verification'

export const dynamic = 'force-dynamic'

/**
 * The server-proxied upload endpoint.
 *
 * The browser sends the file HERE, not to the object store. The object store
 * stays on the internal network, so it needs no public hostname, no DNS record
 * and no tunnel route — and the browser never holds a write capability for it.
 *
 * The reservation row is the authority:
 *
 *   * it belongs to a tenant and to the caller who requested it;
 *   * it is unconsumed and unexpired;
 *   * it fixes the object key, the content type and the exact byte count, so the
 *     caller cannot redirect the write to another key or inflate the size.
 *
 * The body is STREAMED to the object store. Nothing here buffers the upload:
 * a 500 MB video passes through the web process without ever being held in its
 * memory. The declared length is checked against the reservation before the
 * first byte moves, and the stream itself fails if the bytes that arrive are
 * not exactly that many.
 *
 * The upload token is verified against the reservation's hash before anything is
 * written, and the SAME token is written into the object's metadata so the
 * existing finalize step keeps verifying exactly as it did for a presigned
 * upload.
 */

type Rejection = { status: number; message: string }

function declaredLength(request: NextRequest): number | Rejection {
  const header = request.headers.get('content-length')
  if (header === null) {
    // Without a length the stream cannot be bounded, and an unbounded write is
    // exactly what a hostile client would send.
    return { status: 411, message: 'Content-Length is required' }
  }
  const length = Number(header)
  if (!Number.isFinite(length) || !Number.isInteger(length) || length < 0) {
    return { status: 400, message: 'Invalid Content-Length' }
  }
  return length
}

/** The exact number of bytes a part must carry, given the reservation. */
function expectedPartLength(args: {
  partNumber: number
  partCount: number
  sizeBytes: number
}): number {
  const offset = (args.partNumber - 1) * MULTIPART_UPLOAD_PART_SIZE_BYTES
  const remaining = args.sizeBytes - offset
  if (args.partNumber === args.partCount) return remaining
  return Math.min(MULTIPART_UPLOAD_PART_SIZE_BYTES, remaining)
}

/** The single-object upload: the browser posts the whole file. */
export async function POST(request: NextRequest): Promise<Response> {
  const ctx = await getRequestContext()
  if (!ctx) return new NextResponse('Unauthorized', { status: 401 })

  const url = new URL(request.url)
  const uploadId = url.searchParams.get('uploadId') ?? ''
  // The write capability travels in a header, never the URL: full URLs are
  // routinely written to web/proxy/access logs, which would hand log readers
  // the capability for the reservation's lifetime.
  const token = request.headers.get('x-upload-token') ?? ''
  const partNumberRaw = url.searchParams.get('partNumber')
  if (!uploadId || !token) {
    return new NextResponse('Missing upload reference', { status: 400 })
  }

  const reservation = await ctx.db(async (tx) => {
    const [row] = await tx
      .select()
      .from(attachmentUploadReservations)
      .where(
        and(
          eq(attachmentUploadReservations.id, uploadId),
          eq(attachmentUploadReservations.requestedBy, ctx.userId),
          isNull(attachmentUploadReservations.consumedAt),
        ),
      )
      .limit(1)
    return row ?? null
  })
  if (!reservation) return new NextResponse('Not found', { status: 404 })
  if (reservation.expiresAt.getTime() <= Date.now()) {
    return new NextResponse('Upload reference expired', { status: 410 })
  }
  if (!uploadTokenMatches(token, reservation.verificationTokenHash)) {
    return new NextResponse('Not found', { status: 404 })
  }
  if (reservation.tenantId !== ctx.tenantId) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  const isPart = partNumberRaw !== null
  const sizeBytes = Number(reservation.sizeBytes)
  let partNumber = 0
  let expected: number

  if (isPart) {
    partNumber = Number(partNumberRaw)
    if (!Number.isInteger(partNumber) || partNumber < 1) {
      return new NextResponse('Invalid part number', { status: 400 })
    }
    if (!reservation.multipartUploadId) {
      return new NextResponse('No multipart upload is open for this reference', { status: 409 })
    }
    const partCount = Math.ceil(sizeBytes / MULTIPART_UPLOAD_PART_SIZE_BYTES)
    if (partNumber > partCount) {
      return new NextResponse('Part number exceeds the upload', { status: 400 })
    }
    expected = expectedPartLength({ partNumber, partCount, sizeBytes })
    if (expected <= 0) {
      return new NextResponse('Part number exceeds the upload', { status: 400 })
    }
  } else {
    expected = sizeBytes
    if (expected <= 0) {
      return new NextResponse('Upload reference is empty', { status: 400 })
    }
    // A single-object write must carry the type the reservation fixed. Parts
    // carry raw slices, whose media type is not the object's media type.
    const presented = request.headers.get('content-type')
    if (
      presented &&
      normalizedContentType(presented) !== normalizedContentType(reservation.contentType)
    ) {
      return new NextResponse('Uploaded file type does not match the reservation', { status: 400 })
    }
  }

  const declared = declaredLength(request)
  if (typeof declared !== 'number') {
    return new NextResponse(declared.message, { status: declared.status })
  }
  if (declared !== expected) {
    return new NextResponse('Uploaded size does not match the reservation', { status: 400 })
  }
  if (!request.body) {
    return new NextResponse('Upload body is missing', { status: 400 })
  }

  // The request body is already a web stream, and the object-store client
  // accepts one directly, so the bytes move chunk by chunk with no conversion
  // and no buffering.
  const body = request.body

  try {
    if (isPart) {
      await uploadStagedPart({
        key: reservation.stagingKey,
        uploadId: reservation.multipartUploadId!,
        partNumber,
        body,
        contentLength: expected,
      })
      return NextResponse.json({ ok: true, partNumber })
    }

    await putStagedObject({
      key: reservation.stagingKey,
      contentType: reservation.contentType,
      uploadToken: token,
      body,
      contentLength: expected,
    })
    return NextResponse.json({ ok: true, uploadId: reservation.id })
  } catch (error) {
    console.error('[storage-upload] the object store refused the write', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    return new NextResponse('The upload could not be stored', { status: 502 })
  }
}
