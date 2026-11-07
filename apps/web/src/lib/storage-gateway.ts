// The browser-facing URL for a stored object.
//
// WHY THIS EXISTS
// ---------------
// The browser must never talk to the object store directly. A presigned MinIO
// URL handed to a browser requires the object store to be reachable from the
// public internet, which means a public hostname, a public DNS record and a
// second tunnel route — and a second attack surface for a bucket that holds
// every tenant's files.
//
// So the browser-facing URL is a BEACONHS URL. The route behind it
// (app/api/storage/object) re-checks the caller, re-checks the tenant, and
// then streams the bytes from the object store's INTERNAL endpoint. The
// capability below is what makes that route safe to expose: it is a
// server-minted HMAC over the object key, so a caller who can guess or steal
// an object key still cannot reach the bytes without the capability.
//
// The capability mechanism is the SAME one the attachment URLs already use
// (`lib/attachment-url.ts`): an HMAC keyed by ATTACHMENT_CAPABILITY_SECRET,
// verified with a timing-safe comparison. The two families are separated by a
// namespace prefix, so an attachment capability can never be replayed as an
// object capability and vice versa.
//
// WHAT THIS MODULE NEVER DOES
// --------------------------
// It never returns a presigned URL, and it never returns the object store's
// endpoint, host, bucket or credentials. The browser only ever learns a path
// on this application.

import { createHmac, timingSafeEqual } from 'node:crypto'

function capabilitySecret(): string {
  const secret = process.env.ATTACHMENT_CAPABILITY_SECRET
  if (secret && secret.length >= 32) return secret
  if (process.env.NODE_ENV !== 'production') {
    return 'beaconhs-local-attachment-capability-secret'
  }
  throw new Error('ATTACHMENT_CAPABILITY_SECRET must be configured with at least 32 characters')
}

/** Namespace separation: an attachment capability is not an object capability. */
const NAMESPACE = 'object:v1:'

/**
 * Capabilities expire. A capability minted into a page, an email or a log
 * must not stay valid forever: without an expiry, revoking the share that
 * minted it did nothing and the object was effectively public forever.
 * One hour is long enough for a document session and short enough that a
 * leaked URL stops mattering without a revocation mechanism.
 */
const CAPABILITY_TTL_SECONDS = 60 * 60

function capability(key: string, expiresAt: number): string {
  return createHmac('sha256', capabilitySecret())
    .update(`${NAMESPACE}${key}:${expiresAt}`)
    .digest('base64url')
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * The browser-facing URL of a stored object.
 *
 * The key is carried base64url-encoded so it cannot be confused with the
 * query string, and it is still opaque to the caller: it is covered by the
 * capability, so possession of the key alone grants nothing.
 */
export function storageObjectUrl(key: string): string {
  const encoded = Buffer.from(key, 'utf8').toString('base64url')
  const expiresAt = nowSeconds() + CAPABILITY_TTL_SECONDS
  return `/api/storage/object?k=${encodeURIComponent(encoded)}&cap=${capability(key, expiresAt)}&exp=${expiresAt}`
}

/** Verify a presented capability against an object key, in constant time. */
export function validateStorageCapability(
  key: string,
  presented: string,
  expiresAt: number | null,
): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(presented)) return false
  if (expiresAt === null || !Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds()) {
    return false
  }
  const expected = capability(key, expiresAt)
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented))
}

/** Recover the object key from the base64url parameter the route receives. */
export function decodeStorageObjectKey(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
    if (!decoded) return null
    return decoded
  } catch {
    return null
  }
}
