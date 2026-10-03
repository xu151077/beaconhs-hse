// Phase 11-F Step 2 item E — Safety Observations dashboard metric.
//
// A safety observation is a `journal_entries` row whose class is an observation
// (Phase 11-A `entryClassWhere`). There is no observation table and no observation
// permission, so this metric must:
//   * count `journal_entries` under the Journals module's own `journals.read.*`
//     ladder, never a bespoke key;
//   * route through `moduleScopeWhere`, the same primitive every other dashboard
//     count uses, so a site-scoped caller cannot read another site's observations;
//   * preserve the positive/negative classification the row already carries;
//   * stay tenant-bound by riding `ctx.db` (Postgres RLS).
//
// Structural assertions read the metrics source; the scope predicate itself is
// proven against the live resolver in `_metrics-scope.test.ts`.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = () => readFileSync(new URL('./_metrics.ts', import.meta.url), 'utf8')

describe('Step 2 E — safety observations metric', () => {
  it('counts journal_entries under the Journals module ladder', () => {
    const source = readSource()
    expect(source).toContain("prefix: 'journals'")
    // The scope is resolved once, up front, with the canonical primitive.
    expect(source).toContain('scopeJournals')
  })

  it('classifies with the shared journal-class helper, not a second definition', () => {
    const source = readSource()
    // Reused from @beaconhs/db/journal-class so the metric cannot drift from the
    // class list the Safety Observations report filters on.
    expect(source).toContain("from '@beaconhs/db/journal-class'")
    expect(source).toContain("entryClassWhere('observation')")
    // No ad-hoc re-statement of the two observation enum values as a filter.
    expect(source).not.toMatch(/definition\s*=\s*'positive_observation'/)
  })

  it('scopes by the columns journal_entries really has', () => {
    const source = readSource()
    expect(source).toContain('siteCol: journalEntries.siteOrgUnitId')
    expect(source).toContain('personCol: journalEntries.personId')
    expect(source).toContain('ownerCols: [journalEntries.createdByTenantUserId]')
    // Soft-deleted entries must never be counted.
    expect(source).toContain('isNull(journalEntries.deletedAt)')
  })

  it('bounds the window to the last 30 days on the DATE column', () => {
    const source = readSource()
    expect(source).toContain('const thirtyDaysAgoIso')
    expect(source).toContain('gte(journalEntries.entryDate, thirtyDaysAgoIso)')
  })

  it('preserves the positive/negative split without a second round trip', () => {
    const source = readSource()
    // One grouped query yields the total and both classes together.
    expect(source).toContain('safetyObservations: {')
    expect(source).toContain('positive: sql<number>')
    expect(source).toContain('negative: sql<number>')
  })

  it('introduces no new permission, scope rule, table or API entity', () => {
    const source = readSource()
    expect(source).not.toMatch(/observation\.[a-z]/)
    // Reads the table that Phase 11-A already registered; no new substrate.
    expect(source).toContain('from(journalEntries)')
  })
})

describe('Step 2 E — the widget is gated by the Journals ladder', () => {
  const access = readFileSync(new URL('./_widget-access.ts', import.meta.url), 'utf8')

  it('gates on journals.read.* exactly, adding no new key', () => {
    expect(access).toContain(
      "'op-safety-observations-30d': ['journals.read.all', 'journals.read.site']",
    )
    // Neither half of an observation-specific key may appear.
    expect(access).not.toMatch(/observations?\.(read|manage)/)
  })

  it('is registered so it can actually be placed on a dashboard', () => {
    const registry = readFileSync(new URL('./_widget-registry.ts', import.meta.url), 'utf8')
    expect(registry).toContain("'op-safety-observations-30d': {")
    expect(registry).toContain("label: 'Safety observations'")
  })
})
