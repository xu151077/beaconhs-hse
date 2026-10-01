// Project Scope authorization for the controlled-document library.
//
// 15B-3C product decision: `documents` is a TENANT-LEVEL CONTROLLED DOCUMENT
// LIBRARY. It is not project-, site- or person-scoped, and no applicability
// binding is being introduced. This module is the web half of that decision; the
// analytics half is the `tenant-level-document-library` exemption in
// `packages/analytics/src/server/scope.ts`.
//
// The resulting rule, which both halves must express identically:
//
//   unrestricted -> no Project Scope constraint
//   restricted   -> no Project Scope constraint   (a scoped reader still sees the
//                                                  tenant's published library)
//   empty        -> DENY
//   unknown      -> DENY
//
// WHY THIS IS NOT AN EXEMPTION ON THE WEB SIDE
//
// The analytics ladder has a named `projectScopeExempt` concept. The web ladder
// does not, and this change deliberately does not add one: `moduleScopeWhere`
// and `projectScopePredicate` are the canonical shared ladder behind 68 module
// lists, and teaching them about exemptions would change every one of them. This
// is a separate, single-purpose primitive instead.
//
// WHY `unknown` IS HANDLED DESPITE BEING UNREACHABLE HERE
//
// `resolveProjectScopeIn` never throws and never returns an "unknown" state —
// an identity it cannot resolve comes back as `empty(...)`. The four states are
// nevertheless all handled, because the rule is written as "usable or not" and
// the predicate is written fail-closed: anything that is not a usable scope
// denies. A future resolver that can report "unresolved" therefore denies here
// without anyone having to remember to update this file.
//
// WHAT THIS MODULE DOES NOT DECIDE
//
// Nothing about `documents.read`, `documents.manage`, publication status, soft
// deletion or ownership. Those stay in `documentReadFilter` and in each surface's
// own filters. This is one more AND-ed layer, never a replacement.

import { sql, type SQL } from 'drizzle-orm'
import type { Database } from '@beaconhs/db'
import type { RequestContext } from '@beaconhs/tenant'
// Relative, not `@/`: `apps/web` has no vitest config, so the tsconfig path is
// not aliased under the test runner and an aliased import here would make this
// module untestable. The sibling modules in `lib/` do the same.
import { andPredicates } from '../project-scope-predicate'
import { resolveProjectScopeIn, type ProjectScope } from '../project-scope'
import { documentReadFilter } from './doc-access'

/** The one `false` this module emits, so identity comparison stays exact. */
const DENY: SQL = sql`false`

/**
 * Whether the caller's Project Scope admits the tenant-level document library.
 *
 * Pure, and exported so the four states are directly testable — in particular
 * `undefined`, which stands for "never resolved" and is the web counterpart of
 * the analytics `unknown` state.
 *
 * Fail-closed by construction: only a scope that is present and not `empty` is
 * usable, so an unrecognised or absent scope denies rather than passing.
 */
export function documentScopeUsable(scope: ProjectScope | undefined): boolean {
  if (scope === undefined) return false
  return scope.kind !== 'empty'
}

/**
 * The Project Scope half of the documents rule, as a row predicate.
 *
 * `undefined` means "add nothing"; `false` means "withhold". Callers AND it with
 * their own filters — it never replaces them.
 */
export async function documentScopeFilter(
  ctx: RequestContext,
  tx: Database,
): Promise<SQL | undefined> {
  const scope = await resolveProjectScopeIn(ctx, tx)
  return documentScopeUsable(scope) ? undefined : DENY
}

/**
 * THE documents read predicate: Project Scope usability AND the published/manage
 * rule, composed.
 *
 * Every read surface composes this one function so that the four-state decision
 * and the publication rule cannot drift apart, and so that no surface can apply
 * one while forgetting the other. `documentReadFilter` itself is unchanged and
 * still answers only "may an unpublished document be seen".
 *
 * Returns `undefined` when neither layer constrains anything, which for a
 * manager inside a usable scope is the correct "no extra filter".
 */
export async function documentAuthorizationFilter(
  ctx: RequestContext,
  tx: Database,
): Promise<SQL | undefined> {
  return andPredicates(documentReadFilter(ctx), await documentScopeFilter(ctx, tx))
}
