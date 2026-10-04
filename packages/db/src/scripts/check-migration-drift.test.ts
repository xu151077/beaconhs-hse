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
import { classifyDrift, indexPrefix, sha256, type DriftInput } from './check-migration-drift'

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
  seededSql: ['0000_init.sql', '0041_document_book_cover_template.sql'],
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

describe('classifyDrift — a re-proposed migration is now always drift', () => {
  // There used to be a `known-stale` verdict that passed a phantom matching a
  // recorded fingerprint. That verdict is gone: with `0043_snapshot.json` the
  // generator proposes nothing when the schema matches its migrations, so ANY
  // proposal means the schema moved without a migration or the snapshot chain
  // regressed. Both must fail. These tests pin that the old escape hatch is closed.

  it('fails on a single proposed migration that reuses a committed index', () => {
    const verdict = classifyDrift(base({ newSql: ['0041_a.sql'] }))
    expect(verdict.status).toBe('drift')
    expect(verdict.status === 'drift' && verdict.collisions).toEqual(['0041'])
  })

  it('has no verdict that tolerates a proposal', () => {
    // No input can produce a passing verdict while a migration is proposed.
    const withProposal = classifyDrift(base({ newSql: ['0044_new.sql'] }))
    expect(withProposal.status).toBe('drift')
  })
})

describe('classifyDrift — real drift must fail', () => {
  it('fails on a NEW migration the migrations do not describe', () => {
    const verdict = classifyDrift(base({ newSql: ['0042_new_work.sql'] }))
    expect(verdict.status).toBe('drift')
  })

  it('fails when a new migration reuses a committed index (the old phantom shape)', () => {
    const verdict = classifyDrift(base({ newSql: ['0041_freezing_the_phantom.sql'] }))
    expect(verdict.status).toBe('drift')
    expect(verdict.status === 'drift' && verdict.collisions).toEqual(['0041'])
  })

  it('fails when a migration disappears', () => {
    const verdict = classifyDrift(base({ removedSql: ['0040_platform_feedback.sql'] }))
    expect(verdict.status).toBe('drift')
  })

  it('fails if two new migrations collide on one index', () => {
    const verdict = classifyDrift(base({ newSql: ['0042_a.sql', '0042_b.sql'] }))
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
      base({ toolFailed: true, newSql: ['0041_freezing_the_phantom.sql'] }),
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

  it('still reports drift for a genuine new migration', () => {
    const verdict = classifyDrift(base({ toolFailed: false, newSql: ['0042_new_work.sql'] }))
    expect(verdict.status).toBe('drift')
  })

  it('still detects an index collision alongside a real generation', () => {
    const verdict = classifyDrift(
      base({
        toolFailed: false,
        newSql: ['0041_freezing_the_phantom.sql'],
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

  it('proposes NOTHING for the real repo schema (the chain is understood)', () => {
    const { newSql, toolOutput } = generate(SCHEMA, REPO_DRIZZLE)
    // This is the whole point of `0043_snapshot.json`. drizzle-kit walks back from
    // the newest journal entry, so a snapshot for the CURRENT migration is enough
    // — it does not need one per historical entry. With it, `generate` reports
    // "No schema changes" instead of re-proposing everything committed after 0029.
    //
    // Asserting this keeps the repair honest. If a future change regresses the
    // chain, this test fails and the cause must be fixed; re-recording a
    // fingerprint to make it pass again is exactly the failure mode that was
    // removed.
    expect(newSql).toEqual([])
    expect(toolOutput).toContain('No schema changes')
  }, 120_000)

  it('still detects a schema that moved ahead of its migrations', () => {
    // The guard must keep its teeth. Adding a table the migrations do not create
    // has to be caught, and reported.
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
      const seededSql = readdirSync(REPO_DRIZZLE).filter((f) => f.endsWith('.sql'))
      const verdict = classifyDrift({
        toolOutput,
        toolFailed: false,
        removedSql: [],
        newSql,
        seededSql,
      })

      expect(verdict.status).toBe('drift')
      expect(newSql).toHaveLength(1)
      expect(bodies[newSql[0]!]).toContain('drift_guard_probe')

      // The proposal must land on a FREE index, not reuse a committed one.
      //
      // drizzle-kit derives the prefix from the last journal entry's `idx` + 1.
      // This repo's filenames skipped `0033`, so for a while `filename prefix`
      // ran one ahead of `idx`, and the last entry sat at idx 42 while the
      // highest committed prefix was 0043 — so the generator proposed `0043_…`
      // straight on top of `0043_companies.sql`. Setting that entry's idx to 43
      // moves the proposal to 0044. Both are metadata-only: `readMigrationFiles`
      // applies by `tag` and keys the ledger by sha256 of the SQL, never by idx.
      //
      // So a real drift is now caught WITHOUT a filename collision, and a
      // contributor never has to hand-rename the generated file.
      //
      // The head has since advanced: `0044_inspection_type_fk_snapshot` is a
      // statement-free reconciliation that only recorded the pre-existing
      // `equipment_inspection_schedules_tenant_inspection_type_fk`, so the next
      // free index is now `0045`.
      expect(indexPrefix(newSql[0]!)).toBe('0045')
      expect(verdict.status === 'drift' && verdict.collisions).toEqual([])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }, 120_000)
})
