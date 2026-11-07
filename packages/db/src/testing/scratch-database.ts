// Identity guard for the live database suites.
//
// WHY THIS EXISTS
//
// These suites TRUNCATE tenant data, create and delete tenants, and drive the
// real seed against a database they own. Before this guard the only precondition
// was "SEED_TEST_SCRATCH_DATABASE_URL is set", so a developer who exported the
// development URL — or a CI job that pointed at the shared database — would
// destroy it and the run would look like a pass.
//
// The guard is deliberately about IDENTITY, not credentials: the database name
// must be an explicitly isolated test database. The CI databases are named
// `beaconhs_ci_*`; local scratch databases are expected to carry `scratch`,
// `test`, or `ci` as a name segment. A name such as `beaconhs` or `app` is
// refused even if it is reachable.
//
// An unset variable still means "skip the live scenarios", which is the existing
// contract for `pnpm test` on a machine without Postgres. A SET but unsafe
// variable throws at import time, so the suite fails loudly instead of skipping.

const SAFE_DATABASE_NAME = /(^|[_-])(?:test|scratch|ci)(?:[_-]|$)/i
const RESERVED_DATABASE_NAMES = new Set(['postgres', 'template0', 'template1'])

function parsePostgresUrl(raw: string, label: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`[scratch-db] ${label} is not a valid URL.`)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`[scratch-db] ${label} must be a postgres:// URL.`)
  }
  return url
}

function databaseName(url: URL): string {
  const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (!name) throw new Error('[scratch-db] The database URL has no database name.')
  return name
}

/**
 * Validate one URL that a live suite may write to.
 *
 * Returns the trimmed URL unchanged so callers can keep using it.
 */
export function assertScratchDatabaseUrl(
  raw: string,
  label = 'SEED_TEST_SCRATCH_DATABASE_URL',
): string {
  const value = raw.trim()
  if (!value) throw new Error(`[scratch-db] ${label} is empty.`)

  const url = parsePostgresUrl(value, label)
  const name = databaseName(url)

  if (RESERVED_DATABASE_NAMES.has(name.toLowerCase())) {
    throw new Error(`[scratch-db] ${label} points at the reserved database "${name}".`)
  }
  if (!SAFE_DATABASE_NAME.test(name)) {
    throw new Error(
      `[scratch-db] ${label} points at "${name}", which is not an isolated test database. ` +
        'Use a database whose name contains test, scratch, or ci as a segment.',
    )
  }
  return value
}

/**
 * Read and validate the scratch URL. Returns `null` when the suite is not
 * configured, preserving the loud-skip behaviour of `pnpm test`.
 */
export function resolveScratchDatabaseUrl(label = 'SEED_TEST_SCRATCH_DATABASE_URL'): string | null {
  const raw = process.env[label]?.trim()
  return raw ? assertScratchDatabaseUrl(raw, label) : null
}

/**
 * Validate an optional companion URL (superadmin/owner). Unset is allowed; a set
 * value must still name an isolated test database.
 */
export function resolveOptionalScratchDatabaseUrl(label: string): string | null {
  return resolveScratchDatabaseUrl(label)
}

/**
 * Assert that a runtime client points at the same database as the scratch URL.
 *
 * `storage-freeze-operations.test.ts` uses the shared `db` client, which reads
 * `DATABASE_URL`, while its gate reads `SEED_TEST_SCRATCH_DATABASE_URL`. If the
 * two disagree the suite would mutate whichever database the process happened to
 * be configured for. Comparing host, port, and database name (never credentials)
 * makes that mismatch impossible to miss.
 */
export function assertSameScratchDatabase(scratchUrl: string, runtimeUrl: string): void {
  const scratch = parsePostgresUrl(scratchUrl, 'SEED_TEST_SCRATCH_DATABASE_URL')
  const runtime = parsePostgresUrl(runtimeUrl, 'DATABASE_URL')
  const scratchPort = scratch.port || '5432'
  const runtimePort = runtime.port || '5432'
  const same =
    scratch.hostname === runtime.hostname &&
    scratchPort === runtimePort &&
    databaseName(scratch) === databaseName(runtime)
  if (!same) {
    throw new Error(
      '[scratch-db] DATABASE_URL and SEED_TEST_SCRATCH_DATABASE_URL point at different ' +
        'databases. The live suite would write to the wrong target.',
    )
  }
}
