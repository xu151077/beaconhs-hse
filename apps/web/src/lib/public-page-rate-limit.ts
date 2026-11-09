// Rate limiting for unauthenticated public pages (/verify/*).
//
// The kiosk PIN limiter (./public-pin-rate-limit) guards a 6–12 digit PIN
// space; the verify pages carry 160-bit bearer tokens, so enumeration is
// infeasible — the limit here guards against scraping, credential-link
// abuse and mis-sharing, not guessing. Every visit consumes one budget slot
// (a page load IS the event, not only failed attempts), keyed per-client
// and per-token so one client cannot enumerate another holder's badge.

import { createHash } from 'node:crypto'
import { headers } from 'next/headers'
import { getRateLimitStatus, recordRateLimitFailure } from '@beaconhs/jobs/rate-limit'

const WINDOW_SECONDS = 10 * 60
const CLIENT_LIMIT = 60
const TOKEN_LIMIT = 300

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function headerFirst(value: string | null) {
  return value?.split(',')[0]?.trim() || ''
}

async function clientFingerprint() {
  const h = await headers()
  const ip =
    headerFirst(h.get('x-forwarded-for')) ||
    h.get('x-real-ip') ||
    h.get('cf-connecting-ip') ||
    'unknown'
  const ua = h.get('user-agent')?.slice(0, 160) || 'unknown'
  return digest(`${ip}:${ua}`)
}

/**
 * Consume one visit from the caller's budget for a public verify page.
 * Returns `ok: false` when the caller must not see the page (429-style).
 * Fails closed when the limiter is unavailable (the page must not render
 * unlimited traffic because the guard happened to be down).
 */
export async function guardPublicPageRateLimit(
  scope: string,
  keyId: string,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  try {
    const fingerprint = await clientFingerprint()
    const checks = [
      {
        key: `public-page:${scope}:client:${fingerprint}`,
        limit: CLIENT_LIMIT,
        windowSeconds: WINDOW_SECONDS,
      },
      {
        key: `public-page:${scope}:token:${digest(keyId)}`,
        limit: TOKEN_LIMIT,
        windowSeconds: WINDOW_SECONDS,
      },
    ]
    const statuses = await Promise.all(checks.map((check) => getRateLimitStatus(check)))
    const blocked = statuses.find((status) => !status.allowed)
    if (blocked) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((blocked.resetAt.getTime() - Date.now()) / 1_000)),
      }
    }
    await Promise.all(checks.map((check) => recordRateLimitFailure(check)))
    return { ok: true }
  } catch (error) {
    console.error('Public page rate limit unavailable', error)
    return { ok: false, retryAfterSeconds: 60 }
  }
}
