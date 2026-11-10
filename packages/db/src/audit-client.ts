// PD-02 P-2 — dedicated cross-tenant audit connection.
//
// V3 (方案 A, §2 / P1-P6 closure §P-2): cross-tenant audit reads travel on their
// OWN connection, authenticated as the restricted `audit_service` login role,
// and are only ever executed after a transaction-local `SET LOCAL ROLE
// audit_reader` (P-3). This module owns the connection lifecycle and the
// fail-closed configuration contract:
//
//  - `AUDIT_DATABASE_URL` is the ONLY source. There is no fallback to
//    `DATABASE_URL` / `SUPERADMIN_DATABASE_URL` — a missing, empty, or blank
//    value disables the feature, and callers must surface HTTP 503.
//  - The pool is separate from the business pools (never shares sockets or
//    prepared statements with `db` / `superDb`) and is capped at 2 by design
//    (V3 §P-2).
//  - Connection strings are secrets: nothing in this module logs or embeds the
//    URL. Error messages name the configuration key, never the value.

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

/** V3 §P-2: the audit pool is deliberately tiny — at most two concurrent
 * cross-tenant audit queries per process. Not configurable on purpose: a
 * larger audit fan-out is a product decision, not a tuning knob. */
export const AUDIT_DATABASE_POOL_MAX = 2

/** Raised when the audit feature is used without `AUDIT_DATABASE_URL`. HTTP
 * surfaces must translate this to 503 `audit_unavailable` — never to a
 * business-connection fallback. */
export class AuditConnectionUnavailableError extends Error {
  constructor() {
    super('AUDIT_DATABASE_URL is not configured; cross-tenant audit reading is unavailable.')
    this.name = 'AuditConnectionUnavailableError'
  }
}

/**
 * Read the audit connection URL. Returns `null` when the variable is absent,
 * empty, or whitespace-only — an empty value must behave exactly like a
 * missing one (fail-closed), never fall back to another pool's credential.
 */
export function readAuditDatabaseUrl(): string | null {
  const raw = process.env.AUDIT_DATABASE_URL
  const value = raw?.trim()
  return value ? value : null
}

export type AuditConnection = {
  /** Raw postgres-js client. All audit SQL runs through its tagged templates
   * or `.begin()`, which parameterize values — no string interpolation. */
  sql: postgres.Sql
  /** Drizzle handle over the same pool, for typed selects against
   * `audit_log`-shaped tables without re-creating a pool. */
  db: PostgresJsDatabase<typeof schema>
  /** Close the pool (tests / process shutdown). */
  end(): Promise<void>
}

export function createAuditConnection(): AuditConnection {
  const url = readAuditDatabaseUrl()
  if (!url) throw new AuditConnectionUnavailableError()
  const sql = postgres(url, {
    max: AUDIT_DATABASE_POOL_MAX,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false, // required for PgBouncer transaction-mode pooling
  })
  return { sql, db: drizzle(sql, { schema }), end: () => sql.end({ timeout: 5 }) }
}

let singleton: AuditConnection | undefined

/** Process-wide audit connection. Created lazily on first audit use; throws
 * `AuditConnectionUnavailableError` when the environment is not configured. */
export function getAuditConnection(): AuditConnection {
  singleton ??= createAuditConnection()
  return singleton
}

/** Test/teardown helper: closes the singleton (if any) and drops it so the
 * next `getAuditConnection()` re-reads the environment. */
export async function closeAuditConnection(): Promise<void> {
  const current = singleton
  singleton = undefined
  try {
    await current?.end()
  } catch {
    // Never mask the caller's real result during teardown.
  }
}
