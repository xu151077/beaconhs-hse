// Migration drift guard.
//
// Why this exists
// ---------------
// `packages/db/drizzle/meta/` holds 25 snapshots while the journal lists 41
// entries. Sixteen journal entries (idx 1, 2, 26-28, 30-40) have no snapshot
// file. drizzle-kit diffs the schema against the newest snapshot it can find —
// `0029_snapshot.json` — so every `db:generate` run re-proposes all the schema
// changes already committed as migrations 0030-0041. The result is a phantom
// migration that re-creates live objects, and it is written under an index that
// collides with an existing migration.
//
// This guard runs that generation in a throwaway directory and reports whether
// the proposal has changed. It never runs the repo's own `db:generate`, never
// connects to a database, and never writes inside the repository.
//
// It is FAIL-CLOSED. drizzle-kit was observed to exit 0 while crashing, with the
// stack trace on stdout, so neither the exit code nor the text is trusted on its
// own: a verdict of anything other than `tool-error` requires positive evidence
// that the generator completed (see SUCCESS_MARKERS). An unrecognised output is
// therefore a failure, not an empty diff.
//
// What it deliberately does NOT check: `snapshots === migrations`. The 25/41 gap
// is pre-existing, legitimate history, not an error. Repairing the chain is a
// separate decision (see docs/hse-migration-integrity-guard.md §11).

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// this file lives at <pkg>/src/scripts/, so the package root is two levels up
const PKG_DB = resolve(HERE, '../..')
const REPO_DRIZZLE = join(PKG_DB, 'drizzle')
const SCHEMA_ENTRY = join(PKG_DB, 'src/schema/index.ts')

/**
 * Fingerprint of the phantom migration drizzle-kit proposes today, recorded on
 * 2026-09-30 with drizzle-kit 0.31.10 against schema `src/schema/index.ts`.
 *
 * It is a golden value, not a hand-maintained list: it was captured by running
 * the real generator in an isolated temp directory. Regenerate it only after a
 * deliberate snapshot-chain repair, and never to silence a real drift report.
 */
export const KNOWN_STALE_DRIFT_SHA256 =
  'e9845ceff2a4e80d18cf2367682df082f80136bbb65b2f2765a9739fa99d658a'

/** sql_bodies is content-only: drizzle-kit appends a random adjective to the filename. */
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The `NNNN` prefix drizzle-kit gives a migration, or null if it has none. */
export const indexPrefix = (filename: string): string | null =>
  /^(\d+)_/.exec(filename)?.[1] ?? null

export type DriftInput = {
  /** drizzle-kit stdout+stderr, or null when the run was not captured. */
  toolOutput: string | null
  /**
   * True when the generator process itself reported failure — a non-zero exit
   * code, or it could not be spawned at all.
   *
   * Necessary but NOT sufficient: drizzle-kit was observed to exit 0 while
   * crashing (an esbuild `TransformError`, and a `TypeError` thrown from the
   * schema module, both exit 0 with the stack trace on stdout). So a clean exit
   * is treated as "no evidence of failure", never as "proof of success" — see
   * {@link SUCCESS_MARKERS}.
   */
  toolFailed?: boolean
  /** Migration filenames present in the seed but missing from the run. */
  removedSql: string[]
  /** Migration filenames the run created. */
  newSql: string[]
  /** Body of each created migration, keyed by filename. */
  newSqlBodies: Record<string, string>
  /** Filenames the seed already had. */
  seededSql: string[]
  /** The recorded fingerprint for the known pre-existing phantom. */
  baselineSha256?: string
}

export type DriftVerdict =
  | { status: 'in-sync'; message: string }
  | { status: 'tool-error'; message: string; detail: string }
  | { status: 'known-stale'; message: string; collisions: string[]; fingerprints: string[] }
  | { status: 'drift'; message: string; collisions: string[]; newSql: string[] }

/**
 * Phrases drizzle-kit prints when, and only when, a `generate` run completes
 * successfully. Captured from the real 0.31.10 binary:
 *
 *   wrote a migration : "[✓] Your SQL migration file ➜ out/0041_x.sql 🚀"
 *   nothing to do     : "No schema changes, nothing to migrate 😴"
 *
 * The guard is FAIL-CLOSED on this: a verdict of anything other than
 * `tool-error` requires positive proof that the generator ran to completion.
 * An unrecognised, truncated or empty output is therefore a failure, never an
 * `in-sync` pass. That is what makes the guard robust against the long tail of
 * failure shapes (`TypeError`, `EACCES`, `RangeError`, `error: …`, a bare
 * esbuild diagnostic) — none of which have to be enumerated here.
 */
const SUCCESS_MARKERS = ['Your SQL migration file', 'No schema changes'] as const

/**
 * Error shapes recognised only to enrich the reported `detail`. Control flow
 * does not depend on this list: a run is failed by {@link SUCCESS_MARKERS} not
 * being present, and by `toolFailed`, so an unlisted error is still caught.
 */
const RECOGNISED_ERROR = /^\s*(?:[A-Za-z]*Error\b|.*\bE[A-Z]{3,}\b|error\s*:|.*\bENOENT\b)/m

/**
 * Classify a generation run. Pure: no filesystem, no subprocess.
 *
 * Ordering matters, and it is fail-closed by construction:
 *
 *   1. the process reported failure            -> tool-error
 *   2. the output was not captured             -> tool-error
 *   3. the output proves neither success nor a
 *      recognised failure — i.e. an unrecognised
 *      crash signature                        -> tool-error
 *   4. only then may the diff be trusted
 *
 * Step 3 is the one that matters. Matching a list of error strings is a
 * fail-open design: any failure shape not on the list reads as "nothing was
 * generated" and passes. Requiring positive evidence of success inverts that,
 * so an unknown failure is a failure. `RECOGNISED_ERROR` is used only to choose
 * a message, never to reach a passing verdict.
 */
export function classifyDrift(input: DriftInput): DriftVerdict {
  const { toolOutput, removedSql, newSql, newSqlBodies, seededSql, baselineSha256 } = input

  const toolError = (message: string): DriftVerdict => ({
    status: 'tool-error',
    message,
    detail:
      toolOutput === null
        ? '(no output captured)'
        : toolOutput.trim().split('\n').slice(0, 12).join('\n'),
  })

  // 1. The generator's own exit status. This is the authoritative signal.
  if (input.toolFailed === true) {
    return toolError('drizzle-kit exited non-zero, so drift could not be determined')
  }

  // 2. Nothing was captured, so nothing can be trusted.
  if (toolOutput === null) {
    return toolError('drizzle-kit produced no captured output, so drift could not be determined')
  }

  // 3. Fail closed: without positive proof of success, do not report a diff.
  const provedSuccess = SUCCESS_MARKERS.some((marker) => toolOutput.includes(marker))
  if (!provedSuccess) {
    return RECOGNISED_ERROR.test(toolOutput)
      ? toolError('drizzle-kit failed, so drift could not be determined')
      : toolError(
          'drizzle-kit produced no recognised success or failure output, so drift could not be determined',
        )
  }

  if (removedSql.length > 0) {
    return {
      status: 'drift',
      message: 'generation removed committed migrations',
      collisions: [],
      newSql: removedSql,
    }
  }

  if (newSql.length === 0) {
    return {
      status: 'in-sync',
      message: 'schema matches the migration metadata; db:generate would produce nothing',
    }
  }

  // A new migration reusing the index of a committed one is the most dangerous
  // shape: the ledger already has that index applied, so the file cannot be
  // distinguished from history and will re-run committed DDL.
  const seededIndexes = new Set(
    seededSql.map(indexPrefix).filter((value): value is string => value !== null),
  )
  const collisions = [
    ...new Set(
      newSql
        .map((name) => {
          const prefix = indexPrefix(name)
          return prefix && seededIndexes.has(prefix) ? prefix : null
        })
        .filter((value): value is string => value !== null),
    ),
  ]

  const fingerprints = newSql.map((name) => sha256(newSqlBodies[name] ?? ''))
  const isKnownStale =
    baselineSha256 !== undefined && newSql.length === 1 && fingerprints[0] === baselineSha256

  if (isKnownStale) {
    return {
      status: 'known-stale',
      message:
        'db:generate would still re-propose the known phantom migration; the snapshot chain ' +
        'is incomplete (see docs/hse-migration-integrity-guard.md). No NEW drift.',
      collisions,
      fingerprints,
    }
  }

  return {
    status: 'drift',
    message: 'db:generate would emit a migration that is not the recorded baseline',
    collisions,
    newSql,
  }
}

/** Recursively hash a directory tree so the guard can prove it changed nothing. */
export function hashTree(root: string): string {
  const hash = createHash('sha256')
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        hash.update(entry.name).update(readFileSync(full))
      }
    }
  }
  walk(root)
  return hash.digest('hex')
}

const listSql = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort()
    : []

export type CheckResult = { ok: boolean; verdict: DriftVerdict; repoUnchanged: boolean }

/**
 * Run the guard. Creates a temp directory, seeds it with a copy of the
 * committed migration metadata, generates there, and removes the directory.
 *
 * Refuses to run if `packages/db/drizzle` is missing, and re-hashes that
 * directory afterwards so a guard that somehow writes into the repo is caught
 * rather than trusted.
 */
export function checkMigrationDrift(
  options: { baselineSha256?: string; keepTempDir?: string } = {},
): CheckResult {
  if (!existsSync(REPO_DRIZZLE)) {
    throw new Error(`migration directory not found: ${REPO_DRIZZLE}`)
  }

  const repoBefore = hashTree(REPO_DRIZZLE)
  const workDir = options.keepTempDir ?? mkdtempSync(join(tmpdir(), 'beaconhs-migration-drift-'))
  const outDir = join(workDir, 'out')

  try {
    cpSync(REPO_DRIZZLE, outDir, { recursive: true })
    const seededSql = listSql(outDir)

    const drizzleKit = join(PKG_DB, 'node_modules/.bin/drizzle-kit')
    let toolOutput: string | null = null
    // execFileSync throws on a non-zero exit, so this flag is the generator's own
    // verdict rather than an inference from its text. drizzle-kit is known to
    // exit 0 while crashing, which is why the classifier ALSO demands positive
    // evidence of success before it will report a diff.
    let toolFailed = false
    try {
      // cwd is the temp dir and --out is relative: drizzle-kit prefixes `--out`
      // with '.' and cannot accept an absolute path, and the repo config is
      // deliberately not loaded so `out` can never resolve to packages/db/drizzle.
      const out = execFileSync(
        drizzleKit,
        ['generate', '--dialect', 'postgresql', '--schema', SCHEMA_ENTRY, '--out', 'out'],
        {
          cwd: workDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, DATABASE_URL: '' },
        },
      )
      toolOutput = out
    } catch (error) {
      toolFailed = true
      toolOutput = `${(error as { stdout?: string }).stdout ?? ''}\n${(error as { stderr?: string }).stderr ?? ''}`
    }

    const afterSql = listSql(outDir)
    const seededSet = new Set(seededSql)
    const newSql = afterSql.filter((name) => !seededSet.has(name))
    const removedSql = seededSql.filter((name) => !new Set(afterSql).has(name))
    const newSqlBodies: Record<string, string> = {}
    for (const name of newSql) newSqlBodies[name] = readFileSync(join(outDir, name), 'utf8')

    const verdict = classifyDrift({
      toolOutput,
      toolFailed,
      removedSql,
      newSql,
      newSqlBodies,
      seededSql,
      baselineSha256: options.baselineSha256 ?? KNOWN_STALE_DRIFT_SHA256,
    })

    return {
      ok: verdict.status === 'in-sync' || verdict.status === 'known-stale',
      verdict,
      repoUnchanged: hashTree(REPO_DRIZZLE) === repoBefore,
    }
  } finally {
    if (!options.keepTempDir) rmSync(workDir, { recursive: true, force: true })
  }
}

function main(_argv: string[]): number {
  const result = checkMigrationDrift()
  const { verdict } = result

  if (!result.repoUnchanged) {
    console.error('FAIL the guard modified packages/db/drizzle; this is a bug in the guard')
    return 1
  }

  switch (verdict.status) {
    case 'in-sync':
      console.log(`PASS ${verdict.message}`)
      return 0
    case 'known-stale':
      console.warn(`PASS (known stale snapshot chain, no new drift) ${verdict.message}`)
      if (verdict.collisions.length > 0) {
        console.warn(`     would reuse committed migration index: ${verdict.collisions.join(', ')}`)
      }
      console.warn(
        '     repair the snapshot chain to clear this; see docs/hse-migration-integrity-guard.md',
      )
      return 0
    case 'tool-error':
      console.error(`FAIL ${verdict.message}\n${verdict.detail}`)
      return 1
    case 'drift':
      console.error(`FAIL ${verdict.message}`)
      for (const name of verdict.newSql) console.error(`     would create: ${name}`)
      if (verdict.collisions.length > 0) {
        console.error(
          `     would REUSE a committed migration index: ${verdict.collisions.join(', ')}`,
        )
      }
      console.error('     commit a migration deliberately, or repair the snapshot chain')
      return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)))
}
