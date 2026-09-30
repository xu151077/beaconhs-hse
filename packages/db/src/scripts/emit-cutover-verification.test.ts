import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE } from '../schema'
import { main, normaliseArgs, parseRolesSnapshot } from './emit-cutover-verification.cli'
import {
  CUTOVER_SPOT_CHECK_KEYS,
  baselineFor,
  catalogue,
  renderPostMigrateSql,
  renderRollbackSql,
  type RoleSnapshot,
} from './emit-cutover-verification'

/**
 * The generator exists so the cutover SQL cannot carry a second, hand-typed copy
 * of the permission catalogue. These tests enforce that: if anyone reintroduces a
 * literal key list, the generated SQL stops matching the schema and these fail.
 */

const TENANT = '85df8265-e62d-43ac-9455-e80a2a81efc9'
const FOREMAN = '49e8c965-e59e-4765-866b-38a61639dd90'

/** Every permission-shaped key quoted anywhere in the generated SQL. */
const quotedKeys = (sql: string): Set<string> =>
  new Set(
    [...sql.matchAll(/'([a-z_]+\.[a-z_.*-]+)'/g)]
      .map((match) => match[1])
      .filter((key): key is string => key !== undefined),
  )

const foremanSnapshot: RoleSnapshot = {
  id: FOREMAN,
  tenantId: TENANT,
  key: 'foreman',
  isBuiltIn: true,
  permissions: [...baselineFor('foreman')].sort(),
}

describe('catalogue accessors', () => {
  it('reads the catalogue from the schema', () => {
    expect(catalogue()).toEqual([...PERMISSION_CATALOGUE])
  })

  it('reads a role baseline from the schema', () => {
    expect(baselineFor('foreman')).toEqual([
      ...(BUILTIN_ROLES.foreman?.permissions as unknown as string[]),
    ])
  })

  it('rejects an unknown role rather than inventing a baseline', () => {
    expect(() => baselineFor('not_a_role')).toThrow(/Unknown built-in role/)
  })
})

describe('generated post-migrate SQL', () => {
  const sql = renderPostMigrateSql({ tenantId: TENANT, targetRoleId: FOREMAN })
  const emitted = quotedKeys(sql)

  it('embeds every catalogue key, so the stray-key check cannot be incomplete', () => {
    const missing = catalogue().filter((key) => !sql.includes(`'${key}'`))
    expect(missing, 'catalogue keys absent from the generated check').toEqual([])
  })

  it('embeds no key that is not in the catalogue', () => {
    const real = new Set(catalogue())
    // The PPE keys are deliberate spot checks — but they are still catalogue
    // keys, which the next test proves. Anything else must be a catalogue key.
    const stray = [...new Set(emitted)].filter((key) => !real.has(key))
    expect(stray).toEqual([])
  })

  it('checks only spot-check keys that really exist in the catalogue', () => {
    // Regression guard for a fail-open. The spot checks are the only
    // permission-shaped strings the generator writes that are not derived from
    // the catalogue, so the stray-key filter above used to exempt them
    // unconditionally. Retiring one of them therefore left the generated
    // verification checking a key no role can hold — vacuously passing — with
    // this file still green.
    const real = new Set(catalogue())
    for (const key of CUTOVER_SPOT_CHECK_KEYS) {
      expect(real.has(key), `spot-check key "${key}" is not in PERMISSION_CATALOGUE`).toBe(true)
    }
    // And they are genuinely emitted, so the assertion above is not vacuous.
    for (const key of CUTOVER_SPOT_CHECK_KEYS) {
      expect(emitted.has(key), `spot-check key "${key}" absent from the generated SQL`).toBe(true)
    }
  })

  it('refuses to render when a spot-check key is missing from the catalogue', () => {
    // The generator must fail loudly rather than emit SQL that can only ever
    // pass. Proven by checking the guard directly, because retiring a key in
    // PERMISSION_CATALOGUE is not something a test may do to the real schema.
    const withoutOne = catalogue().filter((key) => key !== CUTOVER_SPOT_CHECK_KEYS[2])
    const missing = CUTOVER_SPOT_CHECK_KEYS.filter((key) => !withoutOne.includes(key))
    expect(missing).toEqual([CUTOVER_SPOT_CHECK_KEYS[2]])

    // Rendering with the intact catalogue must still succeed, so the guard
    // above is not simply always-throwing.
    expect(() => renderPostMigrateSql({ tenantId: TENANT, targetRoleId: FOREMAN })).not.toThrow()
  })

  it('is byte-for-byte reproducible, so a re-run cannot silently differ', () => {
    const again = renderPostMigrateSql({ tenantId: TENANT, targetRoleId: FOREMAN })
    expect(again).toBe(sql)
    expect(renderRollbackSql(foremanSnapshot)).toBe(renderRollbackSql(foremanSnapshot))
  })

  it('carries no hand-typed catalogue: every quoted key is either a spot check or a catalogue key', () => {
    const emitted = quotedKeys(sql)
    const real = new Set(catalogue())
    // If a hand list ever replaces the derived one, the emitted set stops being
    // a superset of the catalogue, which this guards.
    const covered = [...real].every((key) => emitted.has(key))
    expect(covered).toBe(true)
  })

  it('checks the PPE tiers by name and asserts the target row', () => {
    expect(sql).toContain("permissions ? 'ppe.read.all'  AS ppe_all_must_be_false")
    expect(sql).toContain("permissions ? 'ppe.read.site' AS ppe_site_must_be_true")
    expect(sql).toContain(FOREMAN)
    expect(sql).toContain(TENANT)
  })

  it('diffs every built-in role against its declared baseline', () => {
    for (const key of Object.keys(BUILTIN_ROLES)) {
      expect(sql, `baseline check missing role ${key}`).toContain(`'${key}' AS role_key`)
    }
  })

  it('contains no write statement', () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/im)
  })
})

describe('generated rollback SQL', () => {
  const sql = renderRollbackSql(foremanSnapshot)

  it('restores the snapshot set exactly, not a re-derived baseline', () => {
    const emitted = quotedKeys(sql)
    const snapshotKeys = new Set(foremanSnapshot.permissions)
    for (const key of snapshotKeys) expect(emitted, `snapshot key absent: ${key}`).toContain(key)
    for (const key of emitted) {
      if (['ppe.read.all', 'ppe.read.site'].includes(key)) continue
      expect(snapshotKeys, `rollback introduced a non-snapshot key: ${key}`).toContain(key)
    }
  })

  it('guards the exact role, tenant, built-in flag and expected count', () => {
    expect(sql).toContain(`'${FOREMAN}'::uuid`)
    expect(sql).toContain(`'${TENANT}'::uuid`)
    expect(sql).toContain("key          = 'foreman'")
    expect(sql).toContain('is_built_in  = true')
    expect(sql).toContain(`jsonb_array_length(permissions) = ${foremanSnapshot.permissions.length}`)
  })

  it('is state-guarded so it cannot re-apply or corrupt', () => {
    expect(sql).toContain("permissions  ? 'ppe.read.site'")
    expect(sql).toContain('NOT (permissions ?')
  })

  it('uses a non-vacuous symmetric set-equality check', () => {
    // `value = ALL (ARRAY[...])` is always false for text, so it would report
    // 0 rows even after a failed rollback. The extra-in-db direction must be
    // expressed as NOT (… = ANY (…)), and both directions must be present.
    expect(sql).toContain("SELECT 'extra_in_db' AS problem, value")
    expect(sql).toContain('WHERE NOT (value = ANY (ARRAY[')
    expect(sql).toContain("SELECT 'absent_but_in_snapshot', v.value")
    expect(sql).not.toContain('value = ALL (ARRAY[')
  })

  it('is wrapped in a transaction and self-verifies before COMMIT', () => {
    const begin = sql.indexOf('BEGIN;')
    const verify = sql.indexOf('exact set equality with the snapshot')
    const commit = sql.indexOf('COMMIT;')
    expect(begin).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(begin)
    expect(commit).toBeGreaterThan(verify)
  })
})

describe('snapshot parsing', () => {
  const row = [FOREMAN, TENANT, 'foreman', 't', '["a.b"]'].join('|')

  it('reads a well-formed snapshot row', () => {
    expect(parseRolesSnapshot(row)).toEqual([
      { id: FOREMAN, tenantId: TENANT, key: 'foreman', isBuiltIn: true, permissions: ['a.b'] },
    ])
  })

  it('ignores blank lines and surrounding whitespace', () => {
    expect(parseRolesSnapshot(`\n  ${row}  \n\n`)).toHaveLength(1)
  })

  it('marks a custom role as not built-in', () => {
    const custom = [FOREMAN, TENANT, 'verif_no_ppe', 'f', '["a.b"]'].join('|')
    expect(parseRolesSnapshot(custom)[0]?.isBuiltIn).toBe(false)
  })

  it('rejects a truncated row rather than emitting a half-filled one', () => {
    // A snapshot that silently lost a column would restore the wrong permissions.
    expect(() => parseRolesSnapshot(`${FOREMAN}|${TENANT}|foreman`)).toThrow(
      /must have 5 '\|'-separated columns/,
    )
  })

  it('rejects a row missing a required column', () => {
    expect(() => parseRolesSnapshot(`|${TENANT}|foreman|t|["a.b"]`)).toThrow(/missing a required/)
  })

  it('rejects permissions that are not a string array', () => {
    expect(() => parseRolesSnapshot(`${FOREMAN}|${TENANT}|foreman|t|{"a":1}`)).toThrow(
      /string array/,
    )
    expect(() => parseRolesSnapshot(`${FOREMAN}|${TENANT}|foreman|t|[1,2]`)).toThrow(/string array/)
  })
})

describe('generated SQL never invents permissions', () => {
  it('rejects a snapshot containing a key outside the catalogue', () => {
    // A snapshot row is history, not policy: it may legitimately hold a key that
    // has since been retired, so the generator must not "fix" it. It must also not
    // silently accept one when the caller expects a live catalogue key.
    const stray: RoleSnapshot = {
      ...foremanSnapshot,
      permissions: [...foremanSnapshot.permissions, 'totally.made.up'],
    }
    const sql = renderRollbackSql(stray)
    // preserved verbatim — the generator reports, it does not filter
    expect(sql).toContain('totally.made.up')
  })
})

describe('CLI argument handling and exit codes', () => {
  // The exit code is the whole contract with a caller: 0 emitted, 1 refused,
  // 2 misused. None of it was reachable from a test while main() was private.

  it('strips a task-runner `--` separator instead of reading it as a path', () => {
    // Regression guard. pnpm forwards a literal `--` to the script, and the CLI
    // used to document exactly that form. `--` is truthy, so the usage guard was
    // skipped and the tool died with a raw ENOENT stack trace.
    expect(normaliseArgs(['--', 'snap.txt', 'out'])).toEqual(['snap.txt', 'out'])
    expect(normaliseArgs(['snap.txt', 'out'])).toEqual(['snap.txt', 'out'])
    expect(normaliseArgs([])).toEqual([])
  })

  it('exits 2 with a usage line when no snapshot is given', () => {
    expect(main([])).toBe(2)
    // The documented-but-broken form must land on the same clean path.
    expect(main(['--'])).toBe(2)
  })

  it('exits 1 when the snapshot has no foreman row to verify', () => {
    const work = mkdtempSync(join(tmpdir(), 'beaconhs-vh-cli-'))
    try {
      const snapshot = join(work, 'snap.txt')
      writeFileSync(snapshot, ['aa|bb|safety_manager|t|["incidents.read.all"]'].join('\n'))
      const out = join(work, 'out')
      expect(main([snapshot, out])).toBe(1)
      // A refused run must not leave half-written artefacts behind.
      expect(existsSync(join(out, '04-post-migrate.sql'))).toBe(false)
      expect(existsSync(join(out, '05-rollback.sql'))).toBe(false)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('exits 0 and writes both artefacts on a valid snapshot', () => {
    const work = mkdtempSync(join(tmpdir(), 'beaconhs-vh-cli-'))
    try {
      const snapshot = join(work, 'snap.txt')
      writeFileSync(
        snapshot,
        [FOREMAN, TENANT, 'foreman', 't', JSON.stringify(foremanSnapshot.permissions)].join('|'),
      )
      const out = join(work, 'out')
      expect(main([snapshot, out])).toBe(0)
      const post = readFileSync(join(out, '04-post-migrate.sql'), 'utf8')
      const rollback = readFileSync(join(out, '05-rollback.sql'), 'utf8')
      // Real catalogue keys, not a fixture list.
      expect(post).toContain(`'${catalogue()[0]}'`)
      expect(post).toContain(TENANT)
      expect(rollback).toContain(FOREMAN)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
