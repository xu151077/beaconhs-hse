import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KNOWN_STALE_DRIFT_SHA256,
  classifyDrift,
  indexPrefix,
  sha256,
  type DriftInput,
} from './check-migration-drift'

/**
 * Three layers are tested.
 *
 * 1. `classifyDrift` is pure, so every verdict is asserted directly, including
 *    the three failure modes that would silently pass a build: a broken
 *    generator, an unrecognised generator output, and an existing migration
 *    reused by a new one.
 *
 * 2. The fail-closed rule is pinned in both directions: every crash signature
 *    observed from the real binary must be a `tool-error`, and every legitimate
 *    outcome must still be reachable. A stricter guard is only useful if it does
 *    not also start failing healthy builds.
 *
 * 3. The real generator is exercised end to end against a temporary copy of the
 *    schema, proving the guard actually discriminates. This needs the drizzle-kit
 *    binary and so is slower, but it is the only part that can catch a change in
 *    drizzle-kit's behaviour.
 */

/** A clean, successful run: this is what drizzle-kit prints when it works. */
const SUCCESS_NEW_MIGRATION = '  193 tables\n  [✓] Your SQL migration file ➜ out/0041_x.sql 🚀'
const SUCCESS_NO_CHANGES = '  193 tables\n  No schema changes, nothing to migrate 😴'

const base = (over: Partial<DriftInput> = {}): DriftInput => ({
  toolOutput: SUCCESS_NEW_MIGRATION,
  toolFailed: false,
  removedSql: [],
  newSql: [],
  newSqlBodies: {},
  seededSql: ['0000_init.sql', '0041_document_book_cover_template.sql'],
  baselineSha256: KNOWN_STALE_DRIFT_SHA256,
  ...over,
})

const knownPhantom = (over: Partial<DriftInput> = {}): DriftInput =>
  base({
    newSql: ['0041_freezing_the_phantom.sql'],
    newSqlBodies: { '0041_freezing_the_phantom.sql': 'x' },
    ...over,
  })

describe('sha256 and indexPrefix', () => {
  it('hashes content, not filenames', () => {
    expect(sha256('SELECT 1;')).toBe(sha256('SELECT 1;'))
    expect(sha256('SELECT 1;')).not.toBe(sha256('SELECT 2;'))
  })

  it('extracts the migration index prefix', () => {
    expect(indexPrefix('0041_fine_vision.sql')).toBe('0041')
    expect(indexPrefix('0000_init.sql')).toBe('0000')
    expect(indexPrefix('no_index.sql')).toBeNull()
  })
})

describe('classifyDrift — the healthy case', () => {
  it('passes when generation produces nothing', () => {
    const verdict = classifyDrift(base())
    expect(verdict.status).toBe('in-sync')
  })

  it('passes when drizzle-kit reports schema unchanged', () => {
    const verdict = classifyDrift(base({ toolOutput: SUCCESS_NO_CHANGES }))
    expect(verdict.status).toBe('in-sync')
  })
})

describe('classifyDrift — the recorded stale chain', () => {
  it('tolerates exactly the known phantom so CI can pass today', () => {
    const body = 'CREATE TABLE "x" ();'
    const verdict = classifyDrift(
      base({
        newSql: ['0041_a.sql'],
        newSqlBodies: { '0041_a.sql': body },
        baselineSha256: sha256(body),
      }),
    )
    expect(verdict.status).toBe('known-stale')
  })

  it('reports the index collision that the stale chain would cause', () => {
    const body = 'SELECT 1;'
    const verdict = classifyDrift(
      base({
        newSql: ['0041_a.sql'],
        newSqlBodies: { '0041_a.sql': body },
        baselineSha256: sha256(body),
      }),
    )
    expect(verdict.status).toBe('known-stale')
    expect(verdict.status === 'known-stale' && verdict.collisions).toEqual(['0041'])
  })
})

describe('classifyDrift — real drift must fail', () => {
  it('fails on a NEW migration that is not the recorded baseline', () => {
    const verdict = classifyDrift(
      base({
        newSql: ['0042_new_work.sql'],
        newSqlBodies: { '0042_new_work.sql': 'ALTER TABLE "users" ADD COLUMN "x" int;' },
      }),
    )
    expect(verdict.status).toBe('drift')
  })

  it('fails when a new migration reuses a committed index (phantom 0041 case)', () => {
    const verdict = classifyDrift(
      base({
        newSql: ['0041_freezing_the_phantom.sql'],
        newSqlBodies: { '0041_freezing_the_phantom.sql': 'CREATE TYPE "public"."x" AS ENUM();' },
      }),
    )
    expect(verdict.status).toBe('drift')
    expect(verdict.status === 'drift' && verdict.collisions).toEqual(['0041'])
  })

  it('fails when a migration disappears', () => {
    const verdict = classifyDrift(base({ removedSql: ['0040_platform_feedback.sql'] }))
    expect(verdict.status).toBe('drift')
  })

  it('fails if two new migrations collide on one index', () => {
    const verdict = classifyDrift(
      base({
        newSql: ['0042_a.sql', '0042_b.sql'],
        newSqlBodies: { '0042_a.sql': 'a', '0042_b.sql': 'b' },
      }),
    )
    expect(verdict.status).toBe('drift')
  })

  it('fails when the phantom grows: baseline plus extra statements', () => {
    const verdict = classifyDrift(
      base({
        newSql: ['0041_a.sql'],
        newSqlBodies: {
          '0041_a.sql': 'CREATE TABLE "x" ();\nALTER TABLE "users" ADD COLUMN "y" int;',
        },
        baselineSha256: sha256('CREATE TABLE "x" ();'),
      }),
    )
    expect(verdict.status).toBe('drift')
  })
})

describe('classifyDrift — a broken tool must never read as a pass', () => {
  // Regression guard for a real fail-open. The original implementation detected a
  // broken generator with `/^\s*(Error|.*\bENOENT\b|.*\bCannot find\b)/m` and read
  // anything else as "generated nothing" -> `in-sync` -> exit 0.
  //
  // Each output below was captured from the real drizzle-kit 0.31.10 binary while
  // it was crashing. All of them exit 0 with the diagnostic on stdout, so the
  // exit code alone cannot save the guard either. A crash that starts with
  // "TypeError" or "EACCES" is not matched by an `Error`-anchored pattern, and
  // the guard used to pass it. The fix inverts the test: a verdict other than
  // `tool-error` now REQUIRES positive evidence that the generator succeeded.

  it('fails on a TypeError crash, which the old Error-anchored pattern missed', () => {
    // Reproduced from a schema module that threw at import time.
    const verdict = classifyDrift(
      base({
        toolOutput: `TypeError: Cannot read properties of undefined (reading 'map')
    at <anonymous> (/app/packages/db/src/schema/index.ts:2:52)
    at Object.transformer (/app/node_modules/drizzle-kit/bin.cjs:15008:47)`,
      }),
    )
    expect(verdict.status).toBe('tool-error')
  })

  it('fails on EACCES, which the old pattern missed', () => {
    const verdict = classifyDrift(
      base({ toolOutput: "EACCES: permission denied, open '/app/packages/db/drizzle'" }),
    )
    expect(verdict.status).toBe('tool-error')
  })

  it('fails on a RangeError, which the old pattern missed', () => {
    const verdict = classifyDrift(
      base({ toolOutput: 'RangeError: Maximum call stack size exceeded' }),
    )
    expect(verdict.status).toBe('tool-error')
  })

  it('fails on a lowercase "error:" diagnostic', () => {
    const verdict = classifyDrift(base({ toolOutput: 'error: schema parse failed' }))
    expect(verdict.status).toBe('tool-error')
  })

  it('fails on unrecognised output even when no error keyword is present', () => {
    // Nothing here matches any error vocabulary, and nothing proves success
    // either. Unknown must mean failed, not "in-sync".
    const verdict = classifyDrift(base({ toolOutput: 'the generator printed something odd' }))
    expect(verdict.status).toBe('tool-error')
  })

  it('fails on empty output rather than reading it as an empty diff', () => {
    const verdict = classifyDrift(base({ toolOutput: '' }))
    expect(verdict.status).toBe('tool-error')
  })

  it('fails when the run was not captured at all', () => {
    const verdict = classifyDrift(base({ toolOutput: null }))
    expect(verdict.status).toBe('tool-error')
  })

  it('trusts the generator exit status over its own text', () => {
    // The strongest signal available: the process reported failure outright.
    // It must fail even if the output would otherwise look like a clean run.
    const verdict = classifyDrift(base({ toolFailed: true, toolOutput: SUCCESS_NO_CHANGES }))
    expect(verdict.status).toBe('tool-error')
  })

  it('keeps failing when drizzle-kit throws its own Error', () => {
    const verdict = classifyDrift(base({ toolOutput: 'Error: ENOENT: no such file or directory' }))
    expect(verdict.status).toBe('tool-error')
  })

  it('keeps failing on a missing-snapshot error', () => {
    const verdict = classifyDrift(base({ toolOutput: 'Cannot find meta/0030_snapshot.json' }))
    expect(verdict.status).toBe('tool-error')
  })

  it('keeps a tool error winning over a coincidental empty diff', () => {
    // drizzle-kit exits 0 on failure, so a guard trusting the exit code would
    // see "no new files" here and pass.
    const verdict = classifyDrift(base({ toolOutput: 'Error: something broke', newSql: [] }))
    expect(verdict.status).toBe('tool-error')
  })

  it('keeps a tool error winning even when a new migration exists', () => {
    // A half-written migration from a crashed run must never be classified.
    const verdict = classifyDrift(
      knownPhantom({ toolFailed: true, newSql: ['0041_freezing_the_phantom.sql'] }),
    )
    expect(verdict.status).toBe('tool-error')
  })

  it('carries a readable detail from the real output', () => {
    const verdict = classifyDrift(
      base({ toolOutput: 'TypeError: Cannot read properties of undefined' }),
    )
    expect(verdict.status === 'tool-error' && verdict.detail).toContain('TypeError')
  })
})

describe('classifyDrift — fail-closed does not break the healthy verdicts', () => {
  // The rule is "no verdict without positive proof of success", so these pin
  // that the stricter gate still admits every legitimate outcome.

  it('still reports in-sync for a real "No schema changes" run', () => {
    const verdict = classifyDrift(base({ toolFailed: false, toolOutput: SUCCESS_NO_CHANGES }))
    expect(verdict.status).toBe('in-sync')
  })

  it('still reports in-sync when generation produced nothing at all', () => {
    const verdict = classifyDrift(base({ toolFailed: false, toolOutput: SUCCESS_NO_CHANGES }))
    expect(verdict.status).toBe('in-sync')
  })

  it('still tolerates the recorded known phantom', () => {
    const body = 'CREATE TABLE "x" ();'
    const verdict = classifyDrift(
      base({
        toolFailed: false,
        newSql: ['0041_a.sql'],
        newSqlBodies: { '0041_a.sql': body },
        baselineSha256: sha256(body),
      }),
    )
    expect(verdict.status).toBe('known-stale')
  })

  it('still reports drift for a genuine new migration', () => {
    const verdict = classifyDrift(
      base({
        toolFailed: false,
        newSql: ['0042_new_work.sql'],
        newSqlBodies: { '0042_new_work.sql': 'ALTER TABLE "users" ADD COLUMN "x" int;' },
      }),
    )
    expect(verdict.status).toBe('drift')
  })

  it('still detects an index collision alongside a real generation', () => {
    const verdict = classifyDrift(
      base({
        toolFailed: false,
        newSql: ['0041_freezing_the_phantom.sql'],
        newSqlBodies: { '0041_freezing_the_phantom.sql': 'CREATE TYPE "public"."x" AS ENUM();' },
      }),
    )
    expect(verdict.status).toBe('drift')
    expect(verdict.status === 'drift' && verdict.collisions).toEqual(['0041'])
  })
})

describe('end-to-end against the real generator', () => {
  const PKG = join(import.meta.dirname, '..', '..')
  const REPO_DRIZZLE = join(PKG, 'drizzle')
  const SCHEMA = join(PKG, 'src/schema/index.ts')
  const DRIZZLE_KIT = join(PKG, 'node_modules/.bin/drizzle-kit')

  const generate = (
    schemaEntry: string,
    seed: string,
  ): { newSql: string[]; bodies: Record<string, string>; toolOutput: string } => {
    const work = mkdtempSync(join(tmpdir(), 'beaconhs-drift-e2e-'))
    try {
      const out = join(work, 'out')
      cpSync(seed, out, { recursive: true })
      const seeded = readdirSync(out).filter((f) => f.endsWith('.sql'))
      const toolOutput = execFileSync(
        DRIZZLE_KIT,
        ['generate', '--dialect', 'postgresql', '--schema', schemaEntry, '--out', 'out'],
        { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const after = readdirSync(out).filter((f) => f.endsWith('.sql'))
      const newSql = after.filter((f) => !seeded.includes(f))
      const bodies: Record<string, string> = {}
      for (const f of newSql) bodies[f] = readFileSync(join(out, f), 'utf8')
      return { newSql, bodies, toolOutput }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  it('reproduces the phantom from the real repo schema (documents why the baseline exists)', () => {
    const { newSql } = generate(SCHEMA, REPO_DRIZZLE)
    // The stale chain means generate DOES propose a migration today. Asserting
    // this keeps the recorded baseline honest: if the chain is ever repaired this
    // test fails and the baseline should be removed, not extended.
    expect(newSql).toHaveLength(1)
    expect(indexPrefix(newSql[0]!)).toBe('0041')
  }, 120_000)

  it('fails when the schema contains a change the migrations do not have', () => {
    // A schema ahead of its migrations is exactly the phantom-generation trap.
    const work = mkdtempSync(join(tmpdir(), 'beaconhs-drift-fixture-'))
    try {
      const schemaDir = join(work, 'schema')
      mkdirSync(schemaDir, { recursive: true })
      const extra = join(schemaDir, 'extra.ts')
      writeFileSync(
        extra,
        `import { pgTable, text } from 'drizzle-orm/pg-core'\n` +
          `export const driftGuardProbe = pgTable('drift_guard_probe', { id: text('id') })\n`,
      )
      const entry = join(schemaDir, 'index.ts')
      writeFileSync(entry, `export * from '${SCHEMA}'\nexport * from './extra'\n`)

      const { newSql, bodies, toolOutput } = generate(entry, REPO_DRIZZLE)
      const verdict = classifyDrift({
        toolOutput,
        toolFailed: false,
        removedSql: [],
        newSql,
        newSqlBodies: bodies,
        seededSql: readdirSync(REPO_DRIZZLE).filter((f) => f.endsWith('.sql')),
        baselineSha256: KNOWN_STALE_DRIFT_SHA256,
      })
      // Not 'known-stale': the new table is genuinely absent from the migrations.
      expect(verdict.status).toBe('drift')
      expect(bodies[newSql[0]!]).toContain('drift_guard_probe')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }, 120_000)
})
