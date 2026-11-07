import { NextResponse, type NextRequest } from 'next/server'
import { assertTenantObjectKey, getObjectStream, headObject } from '@beaconhs/storage'
import { getRequestContext } from '@/lib/auth'
import { decodeStorageObjectKey, validateStorageCapability } from '@/lib/storage-gateway'

export const dynamic = 'force-dynamic'

/**
 * The authorized object gateway.
 *
 * The browser asks THIS application for an object; the application checks the
 * caller and then streams the bytes out of the object store's internal
 * endpoint. The browser never receives an object-store URL, never learns the
 * object store's host, and never holds a credential.
 *
 * Two gates, and which one applies depends on the caller:
 *
 *   1. THE CAPABILITY. A server-minted HMAC over THIS object key, verified in
 *      constant time. Possession of a key alone grants nothing, and a wrong
 *      capability is answered with 404 — the same answer as a missing object —
 *      so it cannot be used to probe for existing keys.
 *
 *   2. THE TENANT SCOPE, when the caller has a session. A key is
 *      tenant-namespaced, so a caller who captured a key from another tenant
 *      and then switched tenant cookies is refused with 403.
 *
 * A caller with NO session is a public share: the one-time token that revealed
 * the page also caused the capability to be minted for exactly that key, so
 * the capability is the authorization. Such a key is still tenant-namespaced,
 * and the object store remains unreachable from the browser.
 *
 * The response streams, so a large file is never buffered whole in the web
 * process.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const encodedKey = request.nextUrl.searchParams.get('k') ?? ''
  const presented = request.nextUrl.searchParams.get('cap') ?? ''
  const expiresAtRaw = request.nextUrl.searchParams.get('exp')
  const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : null
  const key = decodeStorageObjectKey(encodedKey)
  if (!key) return new NextResponse('Not found', { status: 404 })
  // An expired or missing expiry is answered like a wrong capability: the
  // route must not become an expiry oracle.
  if (!validateStorageCapability(key, presented, expiresAt)) {
    return new NextResponse('Not found', { status: 404 })
  }

  // When the caller is signed in, the tenant scope is enforced as well. A
  // caller with no session is a public share and is authorized by the
  // capability alone.
  const ctx = await getRequestContext()
  if (ctx) {
    try {
      assertTenantObjectKey({ tenantId: ctx.tenantId, key })
    } catch {
      return new NextResponse('Forbidden', { status: 403 })
    }
  }

  let metadata
  try {
    metadata = await headObject({ key })
  } catch {
    metadata = null
  }
  if (!metadata) return new NextResponse('Not found', { status: 404 })

  let streamed
  try {
    streamed = await getObjectStream({ key })
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
  if (metadata.contentDisposition) {
    headers.set('Content-Disposition', metadata.contentDisposition)
  }
  // A stored object is tenant data: it must never be cached by a shared proxy,
  // and the type must not be sniffed into something executable.
  headers.set('Cache-Control', 'private, no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')

  return new Response(streamed.stream, { status: 200, headers })
}
