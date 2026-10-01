// 15B-3C-1 — the three exports that had a usable Project Scope binding.
//
// Each of these routes already asserted a PERMISSION. None of them applied a
// row scope, so a caller holding that permission downloaded the whole tenant
// even though the corresponding list page — the thing the user actually reads —
// was already scoped. A CSV is the same rows as a list: if the two disagree, the
// export is the way around the restriction.
//
// The bindings used here are columns the tables ALREADY carry. Nothing was added
// to the schema, and no join was introduced:
//
//   people            people.id                       (the list's binding)
//   ppe_items         current_holder_person_id        (the list's binding)
//
// Safe Distance was in this set under 15B-3C-1 and left it in Phase 1: its
// permission is now a tiered family, so it no longer has a Project Scope binding
// and is asserted through the shared native ladder instead — see the Phase 1
// block below and `safe-distance-native-tier.test.ts`.
//
// The properties asserted are the same four the Project Scope adapter guarantees,
// applied at the boundary each route owns:
//
//   unrestricted            -> no predicate
//   restricted + matching   -> predicate naming the caller's own ids
//   restricted + nonmatching-> predicate that excludes the other ids
//   empty / unresolved      -> `false`, i.e. an empty file, never the tenant
//
// Plus the point of the whole exercise: a restricted caller cannot reach a row
// the list would hide, and the `admin.users.manage` holder gets no special pass.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { people, ppeItems, safeDistanceRecords } from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'
import type { RequestContext } from '@beaconhs/tenant'
import { isAlwaysFalse, projectScopePredicate } from './project-scope-predicate'
import type { ProjectScope } from './project-scope'
import { projectScopeTx } from './testing/project-scope-fixture'

const SITE_A = '00000000-0000-4000-8000-00000000a001'
const SITE_B = '00000000-0000-4000-8000-00000000b001'
const READER = '018f47ba-86c4-7ee2-8d7a-5e7602f2afff'
const PEER_A = '0c000000-0000-4000-8000-0000000000c2'
const PEER_B = '0c000000-0000-4000-8000-0000000000c3'

const dialect = new PgDialect()

/**
 * The predicate as SQL text plus its BOUND VALUES, space-joined.
 *
 * The ids must be read from `params`: drizzle compiles an `inArray` to
 * `in ($1, $2)` and binds the values, so no id ever appears in the SQL text. A
 * test that greps the text for an id passes for the wrong reason — it simply
 * never finds one, whether or not the filter is correct.
 */
const renderWithValues = (p: unknown): string => {
  if (p === undefined) return '(no predicate)'
  const q = dialect.sqlToQuery(p as never)
  return `${q.sql} ${q.params.map(String).join(' ')}`
}

/** The binding each route is required to use, read straight from its source. */
function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const PEOPLE_EXPORT = source('../app/(app)/people/export.csv/route.ts')
const PPE_EXPORT = source('../app/(app)/ppe/export.csv/route.ts')
const SAFE_DISTANCE_EXPORT = source('../app/(app)/tools/safe-distance/export.csv/route.ts')

// ---------------------------------------------------------------------------
// The three bindings, exercised through the real adapter.
// ---------------------------------------------------------------------------

describe('15B-3C-1 — people export is bound by the person column', () => {
  const bind = (scope: ProjectScope) => projectScopePredicate(scope, { personCol: people.id })

  it('unrestricted -> no predicate at all', () => {
    expect(bind({ kind: 'unrestricted' })).toBeUndefined()
  })

  it('restricted -> the caller sees only themselves and their placed peers', () => {
    const out = bind({ kind: 'peopleAndOrgUnits', orgUnitIds: [SITE_A], personIds: [PEER_A] })
    const text = renderWithValues(out)
    expect(out).toBeDefined()
    expect(text).toContain('"people"."id"')
    expect(text).toContain(PEER_A)
    // The project they are NOT placed at must not be reachable.
    expect(text).not.toContain(PEER_B)
  })

  it('a scope placing them only in project B cannot reach a project A peer', () => {
    const out = bind({ kind: 'peopleAndOrgUnits', orgUnitIds: [SITE_B], personIds: [PEER_B] })
    const text = renderWithValues(out)
    expect(text).toContain(PEER_B)
    expect(text).not.toContain(PEER_A)
  })

  it('empty -> a hard false, never "no filter"', () => {
    const out = bind({ kind: 'empty', reason: 'no_assignment' })
    expect(isAlwaysFalse(out)).toBe(true)
    expect(out).not.toBeUndefined()
  })

  it('the route actually uses this binding, and resolves inside its transaction', () => {
    // The regression that matters: the predicate must be on the ROUTE, not only
    // in this test. Both the call and the binding column are asserted.
    expect(PEOPLE_EXPORT).toContain('resolveProjectScopeIn(ctx, tx)')
    expect(PEOPLE_EXPORT).toContain('projectScopePredicate(projectScope, { personCol: people.id })')
    expect(PEOPLE_EXPORT).toContain('if (scopeWhere) filters.push(scopeWhere)')
  })

  it('admin.users.manage alone does not restore tenant-wide', () => {
    // The permission is the capability gate and stays. What must NOT appear is
    // any path where holding it skips the scope.
    expect(PEOPLE_EXPORT).toContain("assertCan(ctx, 'admin.users.manage')")
    // The scope is resolved unconditionally after the gate, and pushed into the
    // same filter list as the deleted-at check.
    const gate = PEOPLE_EXPORT.indexOf("assertCan(ctx, 'admin.users.manage')")
    const scope = PEOPLE_EXPORT.indexOf('resolveProjectScopeIn(ctx, tx)')
    expect(scope, 'the scope must be applied after the capability gate').toBeGreaterThan(gate)
    // No early return between the gate and the scope.
    expect(PEOPLE_EXPORT.slice(gate, scope)).not.toContain('return csvResponse')
  })
})

describe('15B-3C-1 — ppe export is bound by the holder column', () => {
  const bind = (scope: ProjectScope) =>
    projectScopePredicate(scope, { personCol: ppeItems.currentHolderPersonId })

  it('unrestricted -> no predicate', () => {
    expect(bind({ kind: 'unrestricted' })).toBeUndefined()
  })

  it('restricted -> only the gear held by people in scope', () => {
    const out = bind({ kind: 'persons', personIds: [READER] })
    const text = renderWithValues(out)
    expect(text).toContain('"ppe_items"."current_holder_person_id"')
    expect(text).toContain(READER)
    expect(text).not.toContain(PEER_B)
  })

  it('a nonmatching placement yields a predicate excluding the other holder', () => {
    const out = bind({ kind: 'persons', personIds: [PEER_B] })
    const text = renderWithValues(out)
    expect(text).toContain(PEER_B)
    expect(text).not.toContain(READER)
  })

  it('empty -> a hard false', () => {
    expect(isAlwaysFalse(bind({ kind: 'empty', reason: 'expired_assignment' }))).toBe(true)
  })

  it('the route uses moduleScopeWhere on the holder column, like the list does', () => {
    // Reuses the shared ladder rather than a second, export-only rule.
    expect(PPE_EXPORT).toContain('moduleScopeWhere')
    expect(PPE_EXPORT).toContain('prefix:')
    expect(PPE_EXPORT).toContain('personCol: ppeItems.currentHolderPersonId')
    expect(PPE_EXPORT).toContain('if (scope) filters.push(scope)')
    // The capability gate is unchanged.
    expect(PPE_EXPORT).toContain("assertCan(ctx, 'ppe.read.all')")
  })

  it('adds no join and no new column', () => {
    // The binding is the column the table already had. A `person_id` column or
    // an `item_id -> holder` join would both be a schema change.
    expect(PPE_EXPORT).not.toMatch(/\bperson_id\b/)
    expect(PPE_EXPORT).not.toMatch(/itemId:\s*ppeIssues/)
    expect(PPE_EXPORT).not.toMatch(/from\(ppeIssues|from\(ppeIssueReports/)
  })
})

// Phase 1 — the Safe Distance export reads through the shared native ladder.
//
// SUPERSEDES 15B-3C-1. That block asserted the CSV applied the same PROJECT
// SCOPE as the list, and that the route must NOT use `moduleScopeWhere` because
// `tools.safe-distance.use` was a flat key with no read tier. Both premises are
// gone: `tools.safe-distance.read.{all,site,self}` now exists, so the export calls
// the shared ladder and declares no Project Scope predicate of its own.
//
// The properties that mattered are preserved and are now enforced by the tier:
//   • the export can never return more than the list, because both call the same
//     helper over the same two columns;
//   • the operate capability alone still cannot widen to the tenant — it resolves
//     to the self tier and binds only the caller's own operator id.
//
// Row-level tier behaviour is covered in `safe-distance-native-tier.test.ts`.
describe('Phase 1 — the safe-distance export uses the shared native ladder', () => {
  it('routes through the one shared helper, not a bespoke predicate', () => {
    expect(SAFE_DISTANCE_EXPORT).toContain('safeDistanceScopeWhere(ctx, tx)')
    // No second binding: re-declaring the columns is how the list and the export
    // drifted apart in 15B-3C-2A.
    expect(SAFE_DISTANCE_EXPORT).not.toMatch(/orgUnitCol:\s*safeDistanceRecords/)
    expect(SAFE_DISTANCE_EXPORT).not.toMatch(/personCol:\s*safeDistanceRecords/)
    expect(SAFE_DISTANCE_EXPORT).not.toMatch(/siteCol:\s*safeDistanceRecords/)
  })

  it('carries no Project Scope dependency at all', () => {
    expect(SAFE_DISTANCE_EXPORT).not.toContain('resolveProjectScopeIn')
    expect(SAFE_DISTANCE_EXPORT).not.toContain('projectScopePredicate')
    expect(SAFE_DISTANCE_EXPORT).not.toContain('ProjectScope')
  })

  it('keeps the operate-capability gate, so read and operate stay separate axes', () => {
    expect(SAFE_DISTANCE_EXPORT).toContain('assertCan(ctx, SAFE_DISTANCE_PERMISSION)')
  })

  it('ANDs the scope into the existing filters rather than replacing them', () => {
    // A substitution would drop the soft-delete check and leak deleted records.
    expect(SAFE_DISTANCE_EXPORT).toMatch(
      /const filters: SQL<unknown>\[\] = \[isNull\(safeDistanceRecords\.deletedAt\)\]/,
    )
    expect(SAFE_DISTANCE_EXPORT).toMatch(/if \(scopeWhere\) filters\.push\(scopeWhere\)/)
    expect(SAFE_DISTANCE_EXPORT).toContain('const whereClause = and(...filters)')
  })

  it('still audits the export', () => {
    expect(SAFE_DISTANCE_EXPORT).toContain('recordAudit')
  })
})

// ---------------------------------------------------------------------------
// The cross-cutting property: a restricted caller cannot use a CSV to get around
// what the list already hides. The list pages are the reference, exactly as
// `project-scope-oracle.test.ts` treats the dashboard for analytics.
// ---------------------------------------------------------------------------

describe('15B-3C-1 — the export cannot be a way around the list', () => {
  /** How many people each of these scopes would let the export return. */
  const visiblePeople = (scope: ProjectScope): number => {
    const p = projectScopePredicate(scope, { personCol: people.id })
    if (p === undefined) return Number.POSITIVE_INFINITY // company-wide
    if (isAlwaysFalse(p)) return 0
    return 1
  }

  it('a restricted caller exporting people gets a subset, not the roster', () => {
    const scope: ProjectScope = {
      kind: 'peopleAndOrgUnits',
      orgUnitIds: [SITE_A],
      personIds: [PEER_A],
    }
    expect(visiblePeople(scope)).toBeLessThan(Number.POSITIVE_INFINITY)
    expect(visiblePeople(scope)).toBeGreaterThan(0)
  })

  it('a caller with no assignment exports nothing at all', () => {
    // The regression a management permission would otherwise open: `false`, so
    // the file has headers and no rows — not the company.
    expect(visiblePeople({ kind: 'empty', reason: 'no_assignment' })).toBe(0)
  })

  it('the people list and the export resolve the scope the same way', () => {
    // Both call the same resolver and the same adapter on the same column, so
    // the two cannot drift. Asserted on the source so a future edit to one
    // without the other fails here.
    const list = source('../app/(app)/people/page.tsx')
    expect(list).toContain('projectScopePredicate(projectScope, { personCol: people.id })')
    expect(PEOPLE_EXPORT).toContain('projectScopePredicate(projectScope, { personCol: people.id })')
  })

  it('the ppe list and the ppe export resolve the scope the same way', () => {
    const list = source('../app/(app)/ppe/page.tsx')
    expect(list).toContain('personCol: ppeItems.currentHolderPersonId')
    expect(PPE_EXPORT).toContain('personCol: ppeItems.currentHolderPersonId')
  })

  it('a restricted export filters rather than erroring, and never widens', () => {
    // Every binding above can only narrow. `andPredicates` is the shared AND-ing
    // helper; the exports push the scope into the SAME filter list as their
    // other conditions rather than replacing them.
    for (const [name, src] of [
      ['people', PEOPLE_EXPORT],
      ['ppe', PPE_EXPORT],
      ['safe-distance', SAFE_DISTANCE_EXPORT],
    ] as const) {
      expect(src, name).toContain('isNull(')
      expect(src, `${name} must AND the scope, not replace filters`).toMatch(
        /filters\.push\((scope|scopeWhere)\)/,
      )
      expect(src, name).not.toMatch(/whereClause\s*=\s*scope\b/)
    }
    void sql
  })
})
