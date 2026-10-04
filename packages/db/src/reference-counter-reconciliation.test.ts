// The seed must leave `reference_counters` able to mint a number that no record
// already holds.
//
// WHY THIS IS A CORRECTNESS CONTRACT, NOT A COSMETIC ONE
//
// `nextReference` (apps/web/src/lib/reference.ts) mints `PREFIX-YYYY-NNNN` from
// `reference_counters` and nothing else. Its own comment records that it
// replaced a `SELECT count(*) + 1` scheme precisely because that scheme "raced"
// and "drifted" — so uniqueness is the documented intent of the mechanism, not an
// accident.
//
// The seed writes references as LITERALS — `CA-2026-0001`..`CA-2026-0004`,
// `INC-2026-0001`..`INC-2026-0004`, `WO-2026-0001`..`WO-2026-0002` — in exactly the
// shape `nextReference` mints, but it never advanced the counter. The counter
// therefore still read 0 after a seed, and the first records a user created
// through the UI or the public API were handed `CA-2026-0001` and `CA-2026-0002`
// again.
//
// That is a live defect, observed on the dev tenant: two corrective actions
// shared `CA-2026-0001` and two shared `CA-2026-0002`. These strings are how a
// corrective action, incident or work order is identified to a person in a list,
// a PDF, a print sheet and an email, so a collision makes the audit trail
// ambiguous — which is the opposite of what an HSE record is for.
//
// Verified behaviourally against a throwaway database (migrate + seed): counters
// land on the seeded maxima (corrective_action 4, incident 4, work_order 2), the
// next mint is CA-2026-0005 / INC-2026-0005 / WO-2026-0003 and collides with
// nothing, and a second seed run leaves every counter unchanged.
//
// Structural assertions, matching the sibling `*.test.ts` files here: the
// reconciliation is SQL inside the seed transaction and is not reachable without
// a database.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const seedSource = readFileSync(new URL('./seed.ts', import.meta.url), 'utf8')
const referenceSource = readFileSync(
  new URL('../../../apps/web/src/lib/reference.ts', import.meta.url),
  'utf8',
)

const reconciliation = (() => {
  const start = seedSource.indexOf('// Reference-counter reconciliation.')
  expect(start).toBeGreaterThan(-1)
  const end = seedSource.indexOf('// Completeness assertion.', start)
  expect(end).toBeGreaterThan(start)
  return seedSource.slice(start, end)
})()

/** Every entity `nextReference` can mint, and the table it mints into. */
const MINT_TARGETS = [
  ['incident', 'INC', 'incidents'],
  ['corrective_action', 'CA', 'corrective_actions'],
  ['inspection', 'INS', 'inspection_records'],
  ['equipment_inspection', 'EQI', 'equipment_inspection_records'],
  ['work_order', 'WO', 'equipment_work_orders'],
  ['hazid', 'HAZ', 'hazid_assessments'],
  ['journal', 'JRN', 'journal_entries'],
  ['safe_distance', 'SD', 'safe_distance_records'],
] as const

describe('reference numbers are unique by construction', () => {
  it('the counter is the single source of the next number', () => {
    // If this ever stops being true, the whole contract below is moot, so assert
    // the mechanism this file protects rather than a restatement of it.
    expect(referenceSource).toContain('INSERT INTO reference_counters')
    expect(referenceSource).toMatch(/ON CONFLICT \(tenant_id, entity, period\)/)
    expect(referenceSource).toMatch(/DO UPDATE SET seq = reference_counters\.seq \+ 1/)
  })

  it('the seed reconciles the counter after writing literal references', () => {
    expect(reconciliation).toContain('INSERT INTO reference_counters')
  })

  it('covers every entity nextReference can mint', () => {
    // A new mint target that the seed does not reconcile would reintroduce the
    // collision for that entity alone, so the two lists must not drift.
    for (const [entity, prefix, table] of MINT_TARGETS) {
      expect(reconciliation, `${entity} entity key`).toContain(`'${entity}'`)
      expect(reconciliation, `${entity} prefix`).toContain(`'^${prefix}-[0-9]{4}-[0-9]+$'`)
      expect(reconciliation, `${entity} table`).toContain(`FROM ${table} `)
    }
  })

  it('only matches the exact shape nextReference mints', () => {
    // A free-text reference must never be read as a sequence number, or the
    // counter could be pushed to a nonsense value.
    for (const [, prefix] of MINT_TARGETS) {
      expect(reconciliation).toContain(`'^${prefix}-[0-9]{4}-[0-9]+$'`)
    }
    // Anchored at both ends, and the year captured as exactly four digits.
    expect(reconciliation).toContain("from '^[A-Z]+-([0-9]{4})-'")
    expect(reconciliation).toContain("from '-([0-9]+)$'")
  })

  it('is raise-only, so it can never rewind a counter', () => {
    // GREATEST on the conflict target is what makes the stage idempotent and
    // safe to re-run: a counter already ahead of the seeded rows stays ahead.
    expect(reconciliation).toMatch(
      /DO UPDATE\s+SET seq = GREATEST\(reference_counters\.seq, EXCLUDED\.seq\)/,
    )
  })

  it('is tenant-scoped, like every other seeded row', () => {
    const scoped = reconciliation.match(/\.tenant_id = \$\{t\.id\}::uuid/g) ?? []
    expect(scoped.length).toBe(MINT_TARGETS.length)
  })

  it('runs for every tenant on every seed, not only the demo bootstrap', () => {
    // A first-run-only stage cannot repair a database that already exists, which
    // is the state the collision was observed in.
    expect(reconciliation).toContain('select({ id: tenants.id }).from(tenants)')
    expect(reconciliation).not.toContain('DEMO_TENANT_SLUG')
  })
})
