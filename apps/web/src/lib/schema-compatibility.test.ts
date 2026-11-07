import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifySchema } from './schema-compatibility'

// Phase EA-9: readiness must refuse a database this build cannot understand,
// without turning every forward migration into an outage.
//
// Phase EA-8 reproduced an old image reporting `ready` against a schema that had
// a newer migration applied. These fixtures pin the four states.

/** Build a migration folder shaped exactly like `packages/db/drizzle`. */
function journalFixture(tags: Array<{ tag: string; when: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ea9-migrations-'))
  mkdirSync(join(dir, 'meta'))
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: tags }))
  for (const entry of tags) writeFileSync(join(dir, `${entry.tag}.sql`), `-- ${entry.tag}\n`)
  return dir
}

function ledgerFor(dir: string, tags: Array<{ tag: string; when: number }>) {
  return tags.map((entry) => ({
    hash: createHash('sha256').update(`-- ${entry.tag}\n`).digest('hex'),
    createdAt: entry.when,
  }))
}

const A = { tag: '0000_a', when: 1000 }
const B = { tag: '0001_b', when: 2000 }
const C = { tag: '0002_c', when: 3000 }

describe('readiness schema compatibility', () => {
  it('is ready when the ledger matches the journal', () => {
    const dir = journalFixture([A, B])
    expect(classifySchema(dir, ledgerFor(dir, [A, B]))).toEqual({ state: 'match', applied: 2 })
  })

  it('is NOT ready when the database is ahead of this build', () => {
    // The build only knows [A, B]; the database already applied C.
    const dir = journalFixture([A, B])
    const ledger = ledgerFor(dir, [A, B])
    ledger.push({ hash: 'f'.repeat(64), createdAt: C.when })

    const result = classifySchema(dir, ledger)

    expect(result.state).toBe('ahead')
    expect(JSON.stringify(result)).toContain('ahead of this checkout')
  })

  it('is ready but reports pending migrations when the database is behind', () => {
    // A forward migration adds a table the outgoing build never reads; taking the
    // fleet out of rotation for that would break every additive deploy.
    const dir = journalFixture([A, B, C])
    const result = classifySchema(dir, ledgerFor(dir, [A, B]))

    expect(result.state).toBe('pending')
    expect(result).toMatchObject({ pending: [C.tag] })
  })

  it('is not ready when the ledger is empty', () => {
    const dir = journalFixture([A])
    expect(classifySchema(dir, [])).toMatchObject({ state: 'unknown' })
  })

  it('reports an absent journal as unknown rather than assuming compatibility', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ea9-nojournal-'))
    expect(classifySchema(dir, [{ hash: 'a'.repeat(64), createdAt: A.when }])).toMatchObject({
      state: 'unknown',
    })
  })

  it('is not ready when the ledger is inconsistent with the journal', () => {
    // Same timestamp, different hash: a modified migration file on the database.
    const dir = journalFixture([A, B])
    const ledger = [{ hash: 'b'.repeat(64), createdAt: A.when }]
    expect(classifySchema(dir, ledger)).toMatchObject({ state: 'ahead' })
  })
})
