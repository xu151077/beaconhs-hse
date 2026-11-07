/**
 * Project-level boundary for the Next.js Server Action encryption key.
 *
 * Next.js 16.3.5 resolves the key as
 *   `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY || serverActionsManifest.encryptionKey`
 * (next/dist/server/app-render/encryption-utils.js). Two consequences matter here:
 *
 *  1. A MISSING runtime variable is not a fault. The build-time key is embedded in
 *     `server-reference-manifest.json` by the Dockerfile's required BuildKit secret
 *     mount, and the deployed stacks intentionally run on that embedded key.
 *  2. A PRESENT but INVALID runtime variable silently overrides the valid
 *     build-time key. Next.js then fails to import it as an AES-GCM key, and
 *     every Server Action that carries bound arguments breaks at request time —
 *     long after the instance started and reported itself healthy.
 *
 * So the fail-closed rule this module implements is narrow and evidence-based:
 * when the runtime override is present it must be a valid key, and an invalid one
 * must keep the instance out of the load-balancer's rotation.
 *
 * The value is never logged, echoed, or derived into a fingerprint: a key
 * fingerprint would still let an operator correlate a deployment, and the
 * diagnosis only needs to say which of the three states applies.
 */

/** Name of the runtime override Next.js reads. */
export const SERVER_ACTION_KEY_ENV = 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY'

/**
 * Raw AES key lengths Next.js accepts, in bytes.
 *
 * Next.js 16.3.5 documents the requirement as "a base64-encoded value with a
 * valid AES key length (16, 24, or 32 bytes)" and generates 32-byte keys by
 * default (next/dist/docs/01-app/02-guides/self-hosting.md). The same lengths
 * are what `crypto.subtle.importKey('raw', …, 'AES-GCM', …)` accepts.
 */
const REQUIRED_KEY_BYTES = [16, 24, 32] as const

export type ServerActionKeyInspection = {
  state: 'valid' | 'missing' | 'invalid'
  /** Where the effective key comes from when the state allows the app to run. */
  source: 'runtime-override' | 'build-time-key' | 'none'
}

/**
 * Classify a raw runtime override without revealing anything about its value.
 *
 * `raw` is treated exactly as Next.js treats it: an absent or blank value is
 * "missing" (Next.js then uses the embedded build-time key), and a present value
 * must be base64 that decodes to a valid AES key length.
 */
export function inspectServerActionKey(raw: string | undefined | null): ServerActionKeyInspection {
  const value = (raw ?? '').trim()
  if (value === '') {
    // Next.js falls back to the build-time key embedded in the manifest.
    return { state: 'missing', source: 'build-time-key' }
  }
  if (!isValidServerActionKey(value)) {
    return { state: 'invalid', source: 'none' }
  }
  return { state: 'valid', source: 'runtime-override' }
}

/**
 * True when the value is a base64-encoded key of a length Next.js accepts
 * (16, 24, or 32 raw bytes) — the only shapes it can import as an AES-GCM key.
 */
export function isValidServerActionKey(value: string): boolean {
  let decoded: string
  try {
    decoded = atob(value)
  } catch {
    return false
  }
  return (REQUIRED_KEY_BYTES as readonly number[]).includes(decoded.length)
}

/**
 * Fail closed on a broken runtime override.
 *
 * The thrown message names the variable and the expected format and never
 * includes the value (or any derivative of it).
 */
export function assertServerActionKeyUsable(raw: string | undefined | null): void {
  const inspection = inspectServerActionKey(raw)
  if (inspection.state === 'invalid') {
    throw new Error(
      `[server-action-key] ${SERVER_ACTION_KEY_ENV} is not a valid base64-encoded ` +
        `AES key (16, 24, or 32 bytes). The instance is not ready for traffic.`,
    )
  }
}

/**
 * Label the fingerprint is computed over. Changing it changes every
 * fingerprint, so it carries a version.
 */
const FINGERPRINT_LABEL = 'beaconhs:server-action-key:fingerprint:v1'

/** Hex characters kept from the HMAC output (128 bits). */
const FINGERPRINT_LENGTH = 32

/**
 * A comparable, non-recoverable fingerprint of the effective Server Action key.
 *
 * The fingerprint is `HMAC-SHA256(key, label)`, truncated to 128 bits. Using the
 * key as the MAC key makes it a PRF under the key:
 *
 *  - two instances configured with the same key produce the same fingerprint, so
 *    a deployment can prove cross-instance consistency without ever handling the
 *    key itself;
 *  - two instances configured with different keys produce unrelated values, so a
 *    mismatch is detected;
 *  - the fingerprint cannot be inverted, and it is not a plain hash of the key,
 *    so an observer cannot mount an offline dictionary attack against it. The
 *    only thing it reveals is whether two configurations hold the same key.
 *
 * The fingerprint is deliberately not exposed on a public endpoint: it identifies
 * a deployment's key equality. It is written to the instance log once per
 * process, and the deployment script prints the same value for comparison.
 *
 * `null` means "no runtime override", i.e. the effective key is the build-time
 * key embedded in the image, which the application cannot read. In that mode the
 * invariant is enforced by the build/deploy secret pipeline instead.
 */
export async function serverActionKeyFingerprint(
  raw: string | undefined | null,
): Promise<string | null> {
  const value = (raw ?? '').trim()
  if (value === '' || !isValidServerActionKey(value)) return null
  const rawBytes = atob(value)
  const keyBytes = new Uint8Array(rawBytes.length)
  for (let index = 0; index < rawBytes.length; index += 1)
    keyBytes[index] = rawBytes.charCodeAt(index)
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(FINGERPRINT_LABEL),
  )
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, FINGERPRINT_LENGTH)
}
