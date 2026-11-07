import { existsSync } from 'node:fs'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { getAuth } from '@beaconhs/auth'
import { db, superDb } from '@beaconhs/db'
import { assertRedisReady } from '@beaconhs/jobs/health'
import { assertServerActionKeyUsable, SERVER_ACTION_KEY_ENV } from '@/lib/server-action-key'
import { serverActionKeyFingerprint } from '@/lib/server-action-key'
import { classifySchema, migrationsDir } from '@/lib/schema-compatibility'

export const dynamic = 'force-dynamic'

const CACHE_MS = 5_000
let cached: { ready: boolean; expiresAt: number } | undefined
let pending: Promise<boolean> | undefined
let fingerprintLogged = false
let lastFailureReason: string | undefined

/**
 * Log the instance's Server Action key fingerprint once per process.
 *
 * The fingerprint is a keyed MAC (see `serverActionKeyFingerprint`): it lets an
 * operator prove that two instances hold the SAME key without either of them
 * ever handling the key, and it cannot be inverted into the key. It stays out of
 * the HTTP response because the readiness endpoint is reachable by the load
 * balancer and should not identify a deployment's key equality.
 */
async function logKeyFingerprintOnce(): Promise<void> {
  if (fingerprintLogged) return
  const fingerprint = await serverActionKeyFingerprint(process.env[SERVER_ACTION_KEY_ENV])
  fingerprintLogged = true
  if (fingerprint) {
    console.log(`[server-action-key] configuration fingerprint: ${fingerprint}`)
  } else {
    console.log(
      '[server-action-key] no runtime override; the effective key is the build-time key embedded in the image',
    )
  }
}

/**
 * Compare the database ledger with the journal embedded in this build.
 *
 * `ahead` is fatal: a newer migration created columns/tables this build does not
 * know about, and there is no down path. `pending` is NOT fatal — during a
 * rollout the outgoing replicas legitimately run while the migration step is
 * still finishing — but it is logged once so the skew is visible. `unknown` is
 * fatal in a production image (a ledger that cannot be read is not a pass) and
 * only non-fatal where the journal is simply absent, such as `next dev`.
 */
let schemaLogged = false

async function assertSchemaCompatible(): Promise<void> {
  const rows = await superDb.execute(
    sql`select hash, created_at from "drizzle"."__drizzle_migrations" order by created_at`,
  )
  const ledger = (rows as unknown as Array<{ hash: string; created_at: string | number }>).map(
    (row) => ({ hash: row.hash, createdAt: row.created_at }),
  )
  const dir = migrationsDir()
  const result = classifySchema(dir, ledger)

  if (!schemaLogged || result.state === 'ahead') {
    schemaLogged = true
    console.log(`[schema] ${result.state}: ${JSON.stringify(result)}`)
  }

  switch (result.state) {
    case 'match':
      return
    case 'pending':
      // Old replicas keep serving through a forward migration that adds tables
      // they never read. Do not take the fleet out of rotation for that.
      return
    case 'ahead':
      throw new Error(`[schema] the database is ahead of this build: ${result.detail}`)
    case 'unknown': {
      // A missing journal is tolerated ONLY where this build is demonstrably not
      // a deployment image. Production images always ship it (the `ops-migrate`
      // target copies `@beaconhs/db`), so in production an absent journal means
      // the image is malformed and must not serve.
      const journalAbsent = !existsSync(`${dir}/meta/_journal.json`)
      if (journalAbsent && process.env.NODE_ENV !== 'production') return
      throw new Error(`[schema] schema compatibility could not be established: ${result.detail}`)
    }
  }
}

async function runChecks() {
  try {
    // A Server Action key that is present but invalid silently overrides the
    // valid build-time key Next.js embedded in the image, and every action with
    // bound arguments then fails at request time. Refuse to report ready while
    // that is true. A missing override is legitimate: the build-time key is
    // the effective key in the deployed stacks.
    try {
      assertServerActionKeyUsable(process.env[SERVER_ACTION_KEY_ENV])
    } catch (error) {
      console.error('[readiness] server action key rejected:', (error as Error).message)
      throw error
    }
    await logKeyFingerprintOnce()
    // Initialize auth as part of readiness so a missing/weak signing secret
    // cannot pass deployment health and fail on the first login request.
    getAuth()
    await Promise.all([
      db.execute(sql`select 1`),
      superDb.execute(sql`select 1`),
      assertRedisReady(),
    ])
    // Refuse traffic on a schema this build cannot understand. Read AFTER the
    // connectivity checks so a database outage is reported as an outage.
    await assertSchemaCompatible()
    return true
  } catch (error) {
    // A readiness failure with no reason is indistinguishable from a healthy
    // instance that a load balancer simply cannot reach. Name the cause once per
    // distinct message so an operator can tell WHY a pod is out of rotation.
    const reason = error instanceof Error ? error.message : String(error)
    if (lastFailureReason !== reason) {
      lastFailureReason = reason
      console.error(`[readiness] not ready: ${reason}`)
    }
    return false
  }
}

async function isReady() {
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.ready

  pending ??= runChecks().finally(() => {
    pending = undefined
  })
  const ready = await pending
  cached = { ready, expiresAt: Date.now() + CACHE_MS }
  return ready
}

export async function GET() {
  const ready = await isReady()
  return NextResponse.json(
    {
      status: ready ? 'ready' : 'unavailable',
      version: process.env.APP_VERSION ?? 'unknown',
    },
    {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
