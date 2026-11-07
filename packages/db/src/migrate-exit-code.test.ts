// The migration CLI must exit non-zero on every failure path.
//
// WHY THIS FILE EXISTS
//
// `db:migrate` runs `main()` at module scope and force-exits 1 on any rejection
// (`process.exit(1)` in the `.catch`). The regression this pins down is exit
// code delivery: if the process exited 0 despite a failed migration, deploy
// automation would treat a broken schema step as a green deploy. `main()`'s
// failure path is small and easy to regress, so it is asserted directly.
//
// WHAT IS ASSERTED — and the honest limit
//
// These run the REAL command as a subprocess. They need no database: the three
// credential guards throw BEFORE any connection is opened, so a missing variable
// fails deterministically; and an unreachable host fails at the first connect.
// The full green path (45 migrations applied, RLS on every tenant table,
// 45-applied/0-pending ledger) and the role/privilege preflight are covered by
// `pnpm db:migrate` against a real database and are out of scope here by design —
// this file owns the EXIT CODES only.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATE = resolve(PKG_DIR, 'src/migrate.ts')
// Resolve `tsx` from @beaconhs/db, where it is a real dependency, so this works
// under pnpm's isolated layout exactly as `pnpm db:migrate` does.
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli', { paths: [PKG_DIR] })

const DEAD = 'postgres://beaconhs_test:wont-connect@127.0.0.1:59999/beaconhs_test'

/**
 * Run the migration CLI with a controlled environment. The three database URLs
 * are stripped from the inherited environment first so a developer's or CI's real
 * `.env` can never satisfy a guard this test expects to fail, then the caller's
 * overrides are applied. `tsx` reads no `--env-file`, so nothing else leaks in.
 */
function runMigrate(overrides: Record<string, string>): {
  status: number | null
  output: string
} {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' }
  delete env.MIGRATION_DATABASE_URL
  delete env.DATABASE_URL
  delete env.SUPERADMIN_DATABASE_URL
  Object.assign(env, overrides)

  const result = spawnSync(process.execPath, [TSX_CLI, MIGRATE], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

// Each case boots the real CLI through tsx; that cold start exceeds vitest's
// 5s default on a loaded runner, so the suite carries its own budget (the
// spawnSync timeout below stays the inner bound).
describe('migrate CLI exit codes', { timeout: 20_000 }, () => {
  it('exits 1 when MIGRATION_DATABASE_URL (schema owner login) is missing', () => {
    const { status, output } = runMigrate({})
    expect(status).toBe(1)
    expect(output).toContain('MIGRATION_DATABASE_URL is required')
  })

  it('exits 1 when DATABASE_URL (runtime role) is missing', () => {
    const { status, output } = runMigrate({
      MIGRATION_DATABASE_URL: DEAD,
      SUPERADMIN_DATABASE_URL: DEAD,
    })
    expect(status).toBe(1)
    expect(output).toContain('DATABASE_URL is required')
  })

  it('exits 1 when SUPERADMIN_DATABASE_URL (maintenance role) is missing', () => {
    const { status, output } = runMigrate({
      MIGRATION_DATABASE_URL: DEAD,
      DATABASE_URL: DEAD,
    })
    expect(status).toBe(1)
    expect(output).toContain('SUPERADMIN_DATABASE_URL is required')
  })

  it('exits 1 when the migration database cannot be reached', () => {
    const { status } = runMigrate({
      MIGRATION_DATABASE_URL: DEAD,
      DATABASE_URL: DEAD,
      SUPERADMIN_DATABASE_URL: DEAD,
    })
    expect(status).toBe(1)
  })
})
