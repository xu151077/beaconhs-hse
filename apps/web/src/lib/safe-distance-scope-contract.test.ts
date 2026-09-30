// 15B-3C-2A — the Safe Distance list, CSV and analytics path, and the proof that
// they are the SAME rule.
//
// The three surfaces read the same table and must answer the same question:
//
//   list      `tools/safe-distance/page.tsx`   resolveProjectScopeIn + predicate
//   CSV       `tools/safe-distance/export.csv` resolveProjectScopeIn + predicate
//   analytics `packages/analytics` `safe_distance` spec, via the `PERSON_COLUMNS`
//             candidate list
//
// Before 15B-3C-2A the list had no Project Scope at all, and the analytics spec
// declared `personCols: PERSON_COLUMNS` without `operator_person_id` being in that
// list — so the CSV (site OR operator) and analytics (site only) disagreed with
// each other as well as with the list (neither).
//
// WHAT IS ASSERTED, AND HOW
//
// Nothing here greps SQL text for an id. Drizzle compiles `inArray` to
// `in ($1, $2)` and BOUNDS the values, so an id never appears in the statement
// text; a text grep would pass for the wrong reason. Every behavioural assertion
// reads `dialect.sqlToQuery(p).params`, and every "can this reach that row"
// assertion goes through the real predicate, not a proxy for it.
//
// The cross-path assertions read the three SOURCES to confirm they bind the same
// two columns through the same two helpers, because the alternative — three
// independently correct filters that disagree at runtime — is the actual failure
// mode being guarded.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PgDialect } from 'drizzle-orm/pg-core'
import { safeDistanceRecords } from '@beaconhs/db/schema'
import { isAlwaysFalse, projectScopePredicate } from './project-scope-predicate'
import type { ProjectScope } from './project-scope'

const SITE_A = '00000000-0000-4000-8000-00000000a001'
const SITE_B = '00000000-0000-4000-8000-00000000b001'
const OPERATOR_A = '0c000000-0000-4000-8000-0000000000c2'
const OPERATOR_B = '0c000000-0000-4000-8000-0000000000c3'

const dialect = new PgDialect()

/** The bound values of a predicate. NEVER the SQL text — the ids are parameters. */
const boundValues = (p: unknown): string[] => {
  if (p === undefined) return []
  return dialect.sqlToQuery(p as never).params.map(String)
}

const statement = (p: unknown): string =>
  p === undefined ? '(no predicate)' : dialect.sqlToQuery(p as never).sql

/** The binding both the list and the CSV use. */
const safeDistanceScope = (scope: ProjectScope) =>
  projectScopePredicate(scope, {
    orgUnitCol: safeDistanceRecords.siteOrgUnitId,
    personCol: safeDistanceRecords.operatorPersonId,
  })

const readSource = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

const LIST = readSource('../app/(app)/tools/safe-distance/page.tsx')
const CSV = readSource('../app/(app)/tools/safe-distance/export.csv/route.ts')

// ---------------------------------------------------------------------------

describe('15B-3C-2A — the Safe Distance binding, at the resolver/predicate level', () => {
  it('unrestricted -> no predicate at all', () => {
    const p = safeDistanceScope({ kind: 'unrestricted' })
    expect(p).toBeUndefined()
    expect(statement(p)).toBe('(no predicate)')
  })

  it('restricted on the site leg -> only that site is bound', () => {
    const p = safeDistanceScope({ kind: 'orgUnits', orgUnitIds: [SITE_A], personIds: [] })
    expect(statement(p)).toContain('"safe_distance_records"."site_org_unit_id"')
    expect(boundValues(p)).toEqual([SITE_A])
    // No person leg exists for an org-units-only scope, so no operator value binds.
    expect(statement(p)).not.toContain('operator_person_id')
  })

  it('restricted on the operator leg -> only that operator is bound', () => {
    const p = safeDistanceScope({ kind: 'persons', personIds: [OPERATOR_A] })
    expect(statement(p)).toContain('"safe_distance_records"."operator_person_id"')
    expect(boundValues(p)).toEqual([OPERATOR_A])
    expect(statement(p)).not.toContain('site_org_unit_id')
  })

  it('both legs union, so a record matching EITHER is reachable', () => {
    // This is the existing OR design: a row is in scope if its place is in the
    // scope OR its operator is. Both ids are bound; the combinator is `or`.
    const p = safeDistanceScope({
      kind: 'peopleAndOrgUnits',
      orgUnitIds: [SITE_A],
      personIds: [OPERATOR_B],
    })
    expect(statement(p).toLowerCase()).toContain(' or ')
    expect(statement(p)).toContain('site_org_unit_id')
    expect(statement(p)).toContain('operator_person_id')
    expect(boundValues(p).sort()).toEqual([SITE_A, OPERATOR_B].sort())
  })

  it('a nonmatching site binds the other site, never both', () => {
    const p = safeDistanceScope({ kind: 'orgUnits', orgUnitIds: [SITE_B], personIds: [] })
    expect(boundValues(p)).toEqual([SITE_B])
    expect(boundValues(p)).not.toContain(SITE_A)
  })

  it('a nonmatching operator binds the other operator, never both', () => {
    const p = safeDistanceScope({ kind: 'persons', personIds: [OPERATOR_B] })
    expect(boundValues(p)).toEqual([OPERATOR_B])
    expect(boundValues(p)).not.toContain(OPERATOR_A)
  })

  it('empty and every failing reason deny rather than widening', () => {
    for (const reason of [
      'no_scope',
      'no_assignment',
      'expired_assignment',
      'invalid_assignment',
      'missing_org_unit',
      'requested_outside_scope',
      'tenant_mismatch',
    ] as const) {
      const p = safeDistanceScope({ kind: 'empty', reason })
      expect(isAlwaysFalse(p), reason).toBe(true)
      expect(p, reason).not.toBeUndefined()
      // Not a readable predicate: it is terminal, so no ids are ever bound.
      expect(boundValues(p), reason).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// The three surfaces must agree. Each check reads a SOURCE, because a runtime
// assertion on the analytics side would need a discovered entity (and therefore
// a database) — and because the failure being guarded is a source-level drift.
// ---------------------------------------------------------------------------

describe('15B-3C-2A — list, CSV and analytics bind the same two columns', () => {
  it('the list binds site_org_unit_id and operator_person_id', () => {
    expect(LIST).toContain('orgUnitCol: safeDistanceRecords.siteOrgUnitId')
    expect(LIST).toContain('personCol: safeDistanceRecords.operatorPersonId')
  })

  it('the CSV binds the same two columns', () => {
    expect(CSV).toContain('orgUnitCol: safeDistanceRecords.siteOrgUnitId')
    expect(CSV).toContain('personCol: safeDistanceRecords.operatorPersonId')
  })

  it('the analytics spec declares both candidate lists for this table', () => {
    const scope = readSource('../../../../packages/analytics/src/server/scope.ts')
    // A small, fixed window after the entry name: the spec is a literal
    // `{ read, siteCols, personCols }` object, so both candidate declarations must
    // appear immediately after it. Slicing to the next `]` is fragile because the
    // entry closes with `],` and an earlier `]` would be found first.
    const start = scope.indexOf("'safe_distance',")
    expect(start, 'the safe_distance spec must exist').toBeGreaterThan(-1)
    const block = scope.slice(start, start + 260)
    expect(block).toContain('siteCols: SITE_COLUMNS')
    expect(block).toContain('personCols: PERSON_COLUMNS')
    // And it is the FLAT permission, not a tiered prefix — which is why neither
    // the list nor the CSV can use `moduleScopeWhere`.
    expect(block).toContain("read: { key: 'tools.safe-distance.use' }")
  })

  it('operator_person_id is now a person candidate, LAST in priority', () => {
    const scope = readSource('../../../../packages/analytics/src/server/scope.ts')
    const start = scope.indexOf('const PERSON_COLUMNS = [')
    const list = scope.slice(start, scope.indexOf('] as const', start))
    // Priority order is load-bearing: `pickColumn` takes the first match, so
    // `operator_person_id` must be appended, never inserted before an existing
    // name — inserting would silently steal the binding from another module.
    expect(list).toContain('operator_person_id')
    const names = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
    expect(names[names.length - 1]).toBe('operator_person_id')
    // The five pre-existing candidates keep their order and count.
    expect(names.slice(0, 5)).toEqual([
      'person_id',
      'subject_person_id',
      'driver_person_id',
      'inspector_person_id',
      'current_holder_person_id',
    ])
  })
})

describe('15B-3C-2A — the list is scoped, ordered, and its facet counts agree', () => {
  it('the capability gate comes BEFORE the scope resolution', () => {
    const gate = LIST.indexOf('if (!canUseSafeDistance(ctx)) redirect')
    const scope = LIST.indexOf('resolveProjectScopeIn(ctx, tx)')
    expect(gate, 'the gate must exist').toBeGreaterThan(-1)
    expect(scope, 'the scope must be resolved after the gate').toBeGreaterThan(gate)
  })

  it('the list did not previously scope — the regression is now closed', () => {
    // Would have failed before 15B-3C-2A: the page imported no scope machinery.
    expect(LIST).toContain("from '@/lib/project-scope'")
    expect(LIST).toContain("from '@/lib/project-scope-predicate'")
  })

  it('the scope is ANDed into the existing filters, not substituted for them', () => {
    // `filters` still starts with the deleted-at check, and `whereClause` is
    // still the AND of every filter — the scope is one more conjunct.
    expect(LIST).toMatch(
      /const filters: SQL<unknown>\[\] = \[isNull\(safeDistanceRecords\.deletedAt\)\]/,
    )
    expect(LIST).toMatch(/if \(scopeWhere\) filters\.push\(scopeWhere\)/)
    expect(LIST).toContain('const whereClause = and(...filters)')
    // It must never replace the filter list.
    expect(LIST).not.toMatch(/const filters: SQL<unknown>\[\] = \[scopeWhere\]/)
    expect(LIST).not.toMatch(/whereClause\s*=\s*scopeWhere\b/)
  })

  it('the method facet counts are bounded by the same scope as the rows', () => {
    // Otherwise a restricted caller reads the tenant-wide totals off the chip
    // labels even with the rows withheld — an information leak, not cosmetics.
    expect(LIST).toContain('.where(and(isNull(safeDistanceRecords.deletedAt), scopeWhere))')
    // The facet query must come after the scope is resolved.
    expect(LIST.indexOf('scopeWhere')).toBeLessThan(LIST.indexOf('const mc = await tx'))
  })

  it('the list still uses no tier ladder — its permission is a flat key', () => {
    // `tools.safe-distance.use` has no `read.all` / `.site` / `.self`, so
    // `moduleScopeWhere` would silently degrade to the `self` tier. Using it
    // here would be wrong even though the export could not use it either.
    expect(LIST).not.toMatch(/import \{[^}]*moduleScopeWhere/)
    expect(LIST).not.toMatch(/await moduleScopeWhere\(/)
  })

  it('the CSV was not widened to make the list match it', () => {
    // The task is to narrow the LIST, not to relax the CSV.
    expect(CSV).toContain('orgUnitCol: safeDistanceRecords.siteOrgUnitId')
    expect(CSV).toContain('personCol: safeDistanceRecords.operatorPersonId')
    expect(CSV).toContain('resolveProjectScopeIn(ctx, tx)')
  })
})
