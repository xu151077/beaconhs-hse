import { createHmac, timingSafeEqual } from 'node:crypto'

function capabilitySecret(): string {
  const secret = process.env.ATTACHMENT_CAPABILITY_SECRET
  if (secret && secret.length >= 32) return secret
  if (process.env.NODE_ENV !== 'production') return 'beaconhs-local-attachment-capability-secret'
  throw new Error('ATTACHMENT_CAPABILITY_SECRET must be configured with at least 32 characters')
}

/**
 * Deliberate rejection of v1 capabilities (2026-11-09).
 *
 * v1 capabilities were stable bearer HMACs valid forever (`attachment:v1:<id>`):
 * a leaked link never expired and revoking a share did nothing. Since then the
 * app gained the expiring storage-gateway capability (`object:v1:`), but the
 * attachment route deliberately kept stability so persisted form values and
 * rich text could embed links.
 *
 * v2 keeps the one property persisted content needs — a deterministic cap per
 * attachment — but lives under a new namespace. The validator only computes
 * v2, so every historical v1 cap fails closed. Fresh page renders and the
 * persisted-value backfill (`scripts/backfill-attachment-capability-v2.ts`)
 * mint v2 caps; stored v1 links are unknown to the server and 404.
 *
 * Namespace separation still holds: a v2 attachment cap is not a storage
 * object cap and vice versa (`lib/storage-gateway.ts`).
 */
const CAPABILITY_NAMESPACE = 'attachment:v2:'

function capability(attachmentId: string): string {
  return createHmac('sha256', capabilitySecret())
    .update(`${CAPABILITY_NAMESPACE}${attachmentId}`)
    .digest('base64url')
}

/** Server-minted bearer capability suitable for persisted rich text and
 * upload return values. Knowledge of an attachment UUID alone is insufficient. */
export function attachmentUrl(attachmentId: string): string {
  return `/api/attachments/${encodeURIComponent(attachmentId)}?cap=${capability(attachmentId)}`
}

/**
 * Validate a presented v2 capability in constant time. Caps minted under the
 * retired `attachment:v1:` namespace intentionally fail: there is no fallback
 * accept path, so historical links die immediately on deploy rather than
 * lingering as unrevocable bearer secrets.
 */
export function validateAttachmentCapability(attachmentId: string, presented: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(presented)) return false
  const expected = capability(attachmentId)
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented))
}
