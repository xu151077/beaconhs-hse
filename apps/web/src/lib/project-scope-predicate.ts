// Project Scope → SQL predicate adapter.
//
// The ONE place a resolved `ProjectScope` becomes a row predicate. Every consumer
// goes through here so the rules below cannot drift between the list query and
// the single-record guard, which is the failure mode the 15B-1 audit flagged.
//
// The four rules that matter:
//
//   unrestricted → `undefined`  (no predicate; the caller is company-wide)
//   empty        → `sql\`false\`` (NEVER `undefined` — that means "no filter")
//   bound ids    → `inArray(column, ids)` for whichever column the entity has
//   unbindable   → `sql\`false\`` (fail closed, never widened to unrestricted)
//
// Two hazards this exists to prevent:
//
//  1. An empty id list must never produce `IN ()`, which is a SQL syntax error.
//     Every `inArray` is guarded on a non-empty list, and an empty list on a
//     bound column degrades to `sql\`false\``.
//  2. `undefined` and `[]` must never be read as "no restriction". `undefined`
//     is returned for exactly one case — `kind: 'unrestricted'` — and the empty
//     scope is a hard `false`.
//
// AND semantics only. This adapter can narrow; it has no path that returns a
// wider predicate than the scope it was given.

import { and, inArray, or, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { ProjectScope } from './project-scope'

/** The entity columns a scope can bind to. Both are optional. */
export type ProjectScopeBinding = {
  /** A location column: `site_org_unit_id` / `current_site_org_unit_id`. */
  orgUnitCol?: PgColumn | null
  /** A person column: `person_id` / `current_holder_person_id`. */
  personCol?: PgColumn | null
}

/**
 * The single `false` this module ever emits, as one shared object.
 *
 * Identity comparison is then exact and free. Building a fresh `sql`false`` per
 * call would force every consumer to string-match a SQL AST to recognise a
 * terminal condition, which is both fragile and slow.
 */
const HARD_FALSE: SQL = sql`false`

/** True only for the exact predicate this module emits for "no scope". */
export function isAlwaysFalse(predicate: SQL | undefined): boolean {
  return predicate === HARD_FALSE
}

/** `inArray` on a guaranteed non-empty list, or `false` when the list is empty. */
function inList(column: PgColumn, ids: readonly string[]): SQL {
  if (ids.length === 0) return HARD_FALSE
  return inArray(column, [...ids])
}

/**
 * Bind a resolved scope to an entity's columns.
 *
 * Returns `undefined` only for `unrestricted`. Every other outcome is a predicate
 * that cannot be wider than the scope.
 */
export function projectScopePredicate(
  scope: ProjectScope,
  binding: ProjectScopeBinding = {},
): SQL | undefined {
  // The one and only `undefined`: company-wide, nothing to add.
  if (scope.kind === 'unrestricted') return undefined

  // No scope at all. This must be `false`, never `undefined`.
  if (scope.kind === 'empty') return HARD_FALSE

  const legs: SQL[] = []

  if (scope.kind === 'orgUnits' || scope.kind === 'peopleAndOrgUnits') {
    if (binding.orgUnitCol) legs.push(inList(binding.orgUnitCol, scope.orgUnitIds))
  }
  if (scope.kind === 'persons' || scope.kind === 'peopleAndOrgUnits') {
    if (binding.personCol) legs.push(inList(binding.personCol, scope.personIds))
  }

  // The scope has ids but the entity exposes no column to bind them to. Fail
  // closed: an entity that cannot be scoped must not fall back to unrestricted.
  if (legs.length === 0) return HARD_FALSE

  return legs.length === 1 ? legs[0]! : or(...legs)!
}

/**
 * AND two predicates, treating `undefined` as "no constraint".
 *
 * This is the only AND-ing helper the bridge uses. `undefined` here means the
 * other leg did not constrain anything, which is legitimate — the Project Scope
 * leg is `undefined` only when the caller is unrestricted, and in that case the
 * visibility predicate alone is the correct answer.
 */
export function andPredicates(...parts: (SQL | undefined)[]): SQL | undefined {
  const present = parts.filter((p): p is SQL => p !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]!
  return and(...present)!
}

/**
 * The single-record form of {@link projectScopePredicate}: is this record's
 * location / person inside the scope?
 *
 * Kept beside the SQL form, and pinned against it by a contract test, so the
 * list query and the detail guard can never disagree — a record the SQL filters
 * out must not be readable by id, and a record `canSeeRecord` refuses must not
 * come back from the query.
 */
export function recordInProjectScope(
  scope: ProjectScope,
  record: { siteId?: string | null; personId?: string | null },
): boolean {
  if (scope.kind === 'unrestricted') return true
  if (scope.kind === 'empty') return false
  if (scope.kind === 'persons') {
    return Boolean(record.personId && scope.personIds.includes(record.personId))
  }
  // `orgUnits` and `peopleAndOrgUnits` both admit a match on EITHER leg, which
  // mirrors the `or(...)` the SQL form builds.
  const byOrg = Boolean(record.siteId && scope.orgUnitIds.includes(record.siteId))
  const byPerson = Boolean(record.personId && scope.personIds.includes(record.personId))
  return byOrg || byPerson
}
