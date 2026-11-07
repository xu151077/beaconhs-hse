/**
 * Schema-compatibility guard for readiness.
 *
 * WHY THIS EXISTS
 *
 * A deploy migrates forward first and rolls the app out second. The migrator
 * refuses a database that is AHEAD of its checkout, but the web process itself
 * never checked, so an old image re-pinned by hand against a forward-migrated
 * schema reported `ready` and then failed on the first query touching a column
 * it does not know about (Phase EA-8 reproduced exactly that).
 *
 * The rules are deliberately NOT "any mismatch is fatal":
 *
 *  - database AHEAD of this build → NOT ready. The build cannot understand
 *    columns/tables a newer migration created, and it has no down path.
 *  - database BEHIND (migrations pending) → ready, but loud. During a normal
 *    rollout the old replicas keep serving while the migration step is still
 *    running, and an older release is expected to run against a schema that is
 *    newer than it only in the sense of missing tables it never reads. Treating
 *    "behind" as fatal would take the fleet down for every forward migration
 *    that adds a table.
 *  - identical → ready.
 *  - unreadable ledger/journal → NOT ready. Guessing here is how an operator
 *    ends up confident in a state nobody verified.
 *
 * The journal ships inside the image (the `ops-migrate` target's copy of
 * `@beaconhs/db`), so the running build can compare what it was compiled with
 * against what the database recorded.
 */

import { existsSync } from 'node:fs'
import { readMigrationFiles, validateMigrationState } from '@beaconhs/db'

export type SchemaCompatibility =
  | { state: 'match'; applied: number }
  | { state: 'ahead'; detail: string }
  | { state: 'pending'; pending: string[] }
  | { state: 'unknown'; detail: string }

/**
 * Overrides where the running image keeps the migration journal. Only an
 * override matters operationally; the constant does not need to be exported.
 */
const MIGRATIONS_DIR_ENV = 'BEACONHS_MIGRATIONS_DIR'

const DEFAULT_MIGRATIONS_DIR = '/app/apps/ops-migrate/node_modules/@beaconhs/db/drizzle'

export function migrationsDir(): string {
  return process.env[MIGRATIONS_DIR_ENV]?.trim() || DEFAULT_MIGRATIONS_DIR
}

/**
 * Classify how the database compares with the journal embedded in this build.
 *
 * `rows` is the ledger exactly as the database returned it. Any failure to read
 * either side is reported as `unknown`, never as a pass.
 */
export function classifySchema(
  migrationsDirPath: string,
  ledger: ReadonlyArray<{ hash: string; createdAt: string | number | bigint | null }>,
): SchemaCompatibility {
  // `validateMigrationState` takes a mutable array; copy rather than widen its
  // signature for one caller.
  const rows = ledger.map((row) => ({ ...row }))
  if (rows.length === 0) {
    return { state: 'unknown', detail: 'the database has no migration ledger' }
  }
  if (!existsSync(`${migrationsDirPath}/meta/_journal.json`)) {
    // Development (`next dev`) and any image without the migrate target cannot
    // prove compatibility. Report it rather than pretending, and let the caller
    // decide — production images always ship the journal.
    return { state: 'unknown', detail: 'this build carries no migration journal' }
  }

  let migrations
  try {
    migrations = readMigrationFiles(migrationsDirPath)
  } catch (error) {
    return {
      state: 'unknown',
      detail: `the migration journal could not be read: ${(error as Error).message}`,
    }
  }

  try {
    const state = validateMigrationState(migrations, rows)
    if (state.pending.length > 0) {
      return { state: 'pending', pending: state.pending.map((migration) => migration.tag) }
    }
    return { state: 'match', applied: state.applied.length }
  } catch (error) {
    // `validateMigrationState` throws when the tracker is AHEAD of this checkout
    // or when history is inconsistent. Both mean "this build must not serve".
    return { state: 'ahead', detail: (error as Error).message }
  }
}
