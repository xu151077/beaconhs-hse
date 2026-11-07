#!/usr/bin/env node
// Canonical Server Action key fingerprint, for build tooling.
//
// WHY THIS EXISTS
//
// `Dockerfile` consumes the key through a BuildKit secret, and BuildKit does NOT
// include secret CONTENT in its layer cache key. A rebuild of the same commit
// after a key rotation therefore reuses the cached `next build` layer and
// produces an image that still holds the OLD key. The post-build fingerprint gate
// correctly rejects that image, which turns a rotation into a deploy outage until
// someone clears the builder cache.
//
// The fix is to bind the key into the cache key. This script computes the same
// fingerprint the gate already uses — `HMAC-SHA256(key, label)` truncated to 128
// bits (apps/web/src/lib/server-action-key.ts) — so callers can pass it as a
// build argument. It is a PRF under the key: it reveals only key equality, never
// the key, and it is already printed by the gate and the readiness log.
//
// This is a dependency-free Node CLI so CI can compute the value before any
// `pnpm install`. It is the ONLY non-TypeScript implementation, and
// `server-action-key-fingerprint-cli.test.ts` pins it to the canonical function.
//
// USAGE
//   node scripts/ci/server-action-key-fingerprint.mjs <key-file>
//
// Prints the 32-character fingerprint to stdout. Exit 2 for a missing,
// unreadable, or invalid key. The key is never printed.

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Must match FINGERPRINT_LABEL in apps/web/src/lib/server-action-key.ts. */
const FINGERPRINT_LABEL = 'beaconhs:server-action-key:fingerprint:v1'
/** Hex characters kept from the HMAC output (128 bits). */
const FINGERPRINT_LENGTH = 32
/** Raw AES key lengths Next.js accepts, in bytes. */
const REQUIRED_KEY_BYTES = [16, 24, 32]

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Strict base64 decode. `Buffer.from(value, 'base64')` silently drops invalid
 * characters, so a round-trip check is required to match `atob`'s rejections.
 */
function decodeBase64(value) {
  if (!BASE64_RE.test(value) || value.length % 4 !== 0) return null
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) return null
  return decoded
}

/**
 * `HMAC-SHA256(key, label)` truncated to 128 bits, or `null` when the value is
 * absent or not a valid key. Equivalent to `serverActionKeyFingerprint`.
 */
export function fingerprintFromKey(raw) {
  const value = (raw ?? '').trim()
  if (value === '') return null
  const keyBytes = decodeBase64(value)
  if (!keyBytes || !REQUIRED_KEY_BYTES.includes(keyBytes.length)) return null
  return createHmac('sha256', keyBytes)
    .update(FINGERPRINT_LABEL)
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH)
}

/** Exported for the test that pins this file to the canonical implementation. */
export { FINGERPRINT_LABEL, FINGERPRINT_LENGTH }

function main(argv) {
  const keyFile = argv[0]
  if (!keyFile) {
    process.stderr.write('usage: server-action-key-fingerprint.mjs <key-file>\n')
    return 2
  }

  let raw
  try {
    raw = readFileSync(keyFile, 'utf8')
  } catch {
    process.stderr.write('server-action-key-fingerprint: key file is missing or unreadable\n')
    return 2
  }

  const fingerprint = fingerprintFromKey(raw)
  if (fingerprint === null) {
    process.stderr.write(
      'server-action-key-fingerprint: the key is not a valid base64-encoded AES key (16, 24, or 32 bytes)\n',
    )
    return 2
  }

  process.stdout.write(`${fingerprint}\n`)
  return 0
}

// Only run when executed directly, so the test can import the pure function.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
