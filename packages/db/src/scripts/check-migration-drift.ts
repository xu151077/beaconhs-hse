// Migration drift guard.
//
// Why this exists
// ---------------
// It answers one question: if a contributor ran `pnpm db:generate` right now,
// would drizzle-kit propose a migration? It should not — the schema and the
// migrations are supposed to agree — and if it would, the schema has drifted
// ahead of its migrations and CI must fail.
//
// This guard runs that generation in a throwaway directory and classifies the
// result. It never runs the repo's own `db:generate`, never connects to a
// database, and never writes inside the repository.
//
// WHY THERE USED TO BE A "known stale" VERDICT, AND WHY IT IS GONE
// ----------------------------------------------------------------
// `meta/` held 25 snapshots against 43 journal entries, so drizzle-kit diffed the
// schema against `0029_snapshot.json` and re-proposed every change committed as
// 0030-0043 — a phantom that re-creates live objects under an index that
// collides with a committed migration. The guard's answer was to fingerprint that
// phantom in a golden SHA and call the run a pass when it matched.
//
// That was the wrong shape for three reasons, all of which bit in practice:
//   1. Every legitimate migration changed the phantom, so the golden had to be
//      re-recorded by hand each time — twice in one session — and a re-record is
//      indistinguishable from silencing a real report.
//   2. The golden was not a drift baseline at all. It was a fingerprint of the
//      schema delta, so it encoded "the schema is whatever it currently is".
//   3. It left `pnpm db:generate` itself broken for every contributor: the one
//      supported way to author a migration produced a re-creating phantom at a
//      colliding index.
//
// `0043_snapshot.json` fixes the cause rather than the symptom. drizzle-kit walks
// back from the newest journal entry, so a snapshot for the CURRENT migration is
// all it needs; it does not require one per historical entry. With it, `generate`
// reports "No schema changes" when the schema matches its migrations, and proposes
// a correctly-scoped migration at the NEXT FREE INDEX when it does not.
//
// The snapshot is not invented history. It was emitted by drizzle-kit itself from
// `src/schema/index.ts`, and it was verified against the live database built by
// executing all 43 committed migrations in order: 194 tables, every column, and
// 108 enums with identical values. It records the true post-0043 state. No
// committed migration SQL was modified and no historical entry was removed; the
// `0000-0029` snapshots are untouched and still chain by `prevId`.
//
// It is FAIL-CLOSED. drizzle-kit was observed to exit 0 while crashing, with the
// stack trace on stdout, so neither the exit code nor the text is trusted on its
// own: a verdict of anything other than `tool-error` requires positive evidence
// that the generator completed (see SUCCESS_MARKERS). An unrecognised output is
// therefore a failure, not an empty diff. A phantom is a failure too — there is no
// longer any state in which proposing one is expected.

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
  /** Filenames the seed already had. */
  seededSql: string[]
}

export type DriftVerdict =
  | { status: 'in-sync'; message: string }
  | { status: 'tool-error'; message: string; detail: string }
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
  const { toolOutput, removedSql, newSql, seededSql } = input

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

  // Any proposal at all is now a failure. There is no longer a state in which a
  // migration is expected to be re-proposed: the newest snapshot describes the
  // current schema, so a proposal means either the schema moved without a
  // migration, or the snapshot chain regressed. Both must fail closed rather than
  // be waved through by a recorded fingerprint.
  return {
    status: 'drift',
    message:
      'db:generate would propose a migration, so the schema does not match its migrations ' +
      '(either the schema moved without a migration, or the snapshot chain regressed)',
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
export function checkMigrationDrift(options: { keepTempDir?: string } = {}): CheckResult {
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

    const verdict = classifyDrift({
      toolOutput,
      toolFailed,
      removedSql,
      newSql,
      seededSql,
    })

    return {
      ok: verdict.status === 'in-sync',
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
