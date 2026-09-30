// Canonical Project Scope resolver.
//
// Answers exactly one question: **"which places and which people may this
// identity see, as of a given date?"** It is the single source of that answer for
// the whole platform — there is deliberately no second implementation.
//
// It is NOT an authorization decision maker. It never reads `ctx.permissions`,
// never reads a read tier, and never looks at a role name. Those belong to the
// permission and visibility layers, and keeping them separate is what stops one
// deleting the other. The bug this resolver exists to prevent is precisely that a
// maximal permission (`read.all`) currently discards scope entirely — see
// `apps/web/src/lib/visibility.ts:165`, `:201` and
// `packages/analytics/src/server/scope.ts:374`.
//
// Nothing consumes this yet. It is added ahead of the consumers so the semantics
// can be reviewed and tested on their own, and so migrating the 86 authorization
// call sites later has something canonical to move onto. Consumers are a later
// commit; until then no existing behaviour changes.
//
// Effective-date rule: `valid_from <= onDate AND (valid_to IS NULL OR
// valid_to >= onDate)`, with `valid_to` INCLUSIVE. That is the one rule in
// `./assignment-validity` — the same rule `@beaconhs/compliance` applies to this
// table in `audience.ts:99-104` and `identity.ts:104-105`. It is called, not
// restated, so there is no second copy here to drift.

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '@beaconhs/db'
import { orgUnits, people, peopleAssignments } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { effectiveOn, isAssignmentEffectiveOn, todayIso, type IsoDate } from './assignment-validity'

/**
 * Depth cap for the org-unit walk. `org_units.parent_id` is single-parent, so a
 * well-formed tree is four deep (`customer → project → site → area`), but the
 * column carries no CHECK constraint preventing a longer or cyclic chain. The cap
 * plus the `seen` sets below make a malformed tree fail closed rather than hang.
 */
export const MAX_ORG_UNIT_DEPTH = 8

/** Why a caller resolved to no scope. Never a substitute for "unrestricted". */
export type ProjectScopeEmptyReason =
  /** The identity has no `people` row in this tenant, so no assignment can exist. */
  | 'no_scope'
  /** A `people` row exists but has no `people_assignments` row at all. */
  | 'no_assignment'
  /** Assignment rows exist, but every one has ended before `onDate`. */
  | 'expired_assignment'
  /** An assignment row could not be read as a usable validity window. */
  | 'invalid_assignment'
  /** An assignment names an org unit that is missing, soft-deleted, or another tenant's. */
  | 'missing_org_unit'
  /** The caller asked for a subset that does not intersect the resolved scope. */
  | 'requested_outside_scope'
  /** A caller-supplied `tenantId` did not match the request context's tenant. */
  | 'tenant_mismatch'

/**
 * The resolved scope — a discriminated union on `kind`, deliberately:
 *
 *  - `empty` and `unrestricted` are different cases. `unrestricted` is reachable
 *    ONLY from `ctx.isSuperAdmin` or an explicit `{type:'tenant'}` scope. No id
 *    list, no `undefined` and no empty array is ever read as unrestricted.
 *  - `empty` carries a reason, so a UI can tell "you have no project assigned"
 *    from "there is no data".
 */
export type ProjectScope =
  | { kind: 'unrestricted' }
  | { kind: 'orgUnits'; orgUnitIds: string[]; personIds: string[] }
  | { kind: 'persons'; personIds: string[] }
  | { kind: 'peopleAndOrgUnits'; orgUnitIds: string[]; personIds: string[] }
  | { kind: 'empty'; reason: ProjectScopeEmptyReason }

export type ProjectScopeOptions = {
  /**
   * Optional assertion of the caller's tenant. When present it must equal
   * `ctx.tenantId`; a mismatch is `empty`/`tenant_mismatch` and never falls back
   * to `unrestricted`. The tenant is otherwise always read from the context, and
   * never from caller input.
   */
  tenantId?: string
  /** Effective date, UTC. Defaults to today. */
  onDate?: IsoDate
  /** Narrow the result to these org units. Intersects; never widens. */
  requestedOrgUnitIds?: readonly string[]
  /** Narrow the result to these people. Intersects; never widens. */
  personIds?: readonly string[]
  /** Drop soft-deleted org units. Default `true`: a deleted place is not in scope. */
  excludeDeleted?: boolean
}

function empty(reason: ProjectScopeEmptyReason): ProjectScope {
  return { kind: 'empty', reason }
}

function assemble(orgUnitIds: string[], personIds: string[]): ProjectScope {
  if (orgUnitIds.length === 0 && personIds.length === 0) return empty('no_scope')
  if (orgUnitIds.length === 0) return { kind: 'persons', personIds }
  if (personIds.length === 0) return { kind: 'orgUnits', orgUnitIds, personIds }
  return { kind: 'peopleAndOrgUnits', orgUnitIds, personIds }
}

/** The caller's own employee rows. `ctx.personId` is canonical; userId is a fallback. */
async function callerPersonIds(ctx: RequestContext, tx: Database): Promise<string[]> {
  if (ctx.personId) return [ctx.personId]
  // `ctx.personId` is null for accounts with no employee record. Re-derive it
  // rather than trusting the caller's context to be complete: the resolver must be
  // correct when used standalone.
  const rows = await tx
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.tenantId, ctx.tenantId), eq(people.userId, ctx.userId)))
  return rows.map((r) => r.id)
}

/** A row of `org_units`, reduced to what the walk needs. */
export type OrgNode = {
  id: string
  parentId: string | null
  level: string
  deletedAt: Date | null
}

/**
 * Child index for the org tree. Soft-deleted nodes are dropped when
 * `excludeDeleted`, so a deleted place cannot be reached as a descendant either.
 */
export function buildOrgTreeIndex(
  nodes: readonly OrgNode[],
  options: { excludeDeleted?: boolean } = {},
): Map<string, string[]> {
  const excludeDeleted = options.excludeDeleted ?? true
  const live = new Map<string, OrgNode>()
  for (const n of nodes) {
    if (excludeDeleted && n.deletedAt !== null) continue
    live.set(n.id, n)
  }
  const childrenOf = new Map<string, string[]>()
  for (const n of live.values()) {
    if (!n.parentId) continue
    const bucket = childrenOf.get(n.parentId)
    if (bucket) bucket.push(n.id)
    else childrenOf.set(n.parentId, [n.id])
  }
  return childrenOf
}

/**
 * Every descendant of `rootId`, depth-capped and cycle-guarded. A cyclic
 * `parent_id` chain is visited once and stops, rather than recursing forever.
 */
export function descendantOrgUnitIds(
  childrenOf: ReadonlyMap<string, string[]>,
  rootId: string,
  maxDepth: number = MAX_ORG_UNIT_DEPTH,
): string[] {
  const out: string[] = []
  const seen = new Set<string>([rootId])
  let frontier = [rootId]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const child of childrenOf.get(id) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        out.push(child)
        next.push(child)
      }
    }
    frontier = next
  }
  return out
}

/**
 * The ancestor chain above `startId`, nearest first, depth-capped and
 * cycle-guarded. Assigning someone to a *site* must also grant the project that
 * site sits under, or a project-scoped reader could not see the site they are
 * standing on.
 */
export function ancestorOrgUnitIds(
  live: ReadonlyMap<string, OrgNode>,
  startId: string,
  maxDepth: number = MAX_ORG_UNIT_DEPTH,
): string[] {
  const chain: string[] = []
  const seen = new Set<string>([startId])
  let current = live.get(startId)
  for (let depth = 0; depth < maxDepth && current?.parentId; depth++) {
    const parentId = current.parentId
    if (seen.has(parentId)) break // cycle — stop rather than loop
    const parent = live.get(parentId)
    if (!parent) break
    seen.add(parentId)
    chain.push(parentId)
    current = parent
  }
  return chain
}

/**
 * Resolve the canonical project scope for a context.
 *
 * Read-only, uncached, and bounded: at most three tenant-scoped SELECTs inside
 * `ctx.db`, so the existing tenant RLS policy applies and no query can cross a
 * tenant. The org tree is read once and walked in memory, so cost is O(org units)
 * rather than O(assignments) queries. It writes nothing and creates no audit
 * record. No cache: an assignment edit must be visible on the next read, so
 * caching here would be a correctness bug, not an optimisation.
 */
export async function resolveProjectScope(
  ctx: RequestContext,
  options: ProjectScopeOptions = {},
): Promise<ProjectScope> {
  return ctx.db((tx) => resolveProjectScopeIn(tx, ctx, options))
}

/**
 * The same resolution against a transaction the caller already holds.
 *
 * The visibility ladder is always called from inside `ctx.db(...)`, and its
 * predicates are part of that same query. Opening a second transaction would both
 * cost a round trip and re-run `set_config` for no benefit, so the bridge passes
 * its transaction in. Behaviour is identical to {@link resolveProjectScope}.
 */
export async function resolveProjectScopeIn(
  tx: Database,
  ctx: RequestContext,
  options: ProjectScopeOptions = {},
): Promise<ProjectScope> {
  const onDate = options.onDate ?? todayIso()
  const excludeDeleted = options.excludeDeleted ?? true
  const requested = options.requestedOrgUnitIds

  // Step 1 — tenant. A caller-supplied tenant that disagrees with the context is
  // a mismatch, never a licence to widen.
  if (options.tenantId !== undefined && options.tenantId !== ctx.tenantId) {
    return empty('tenant_mismatch')
  }

  // Step 2 — unrestricted, from exactly two sources: super-admin, or an explicit
  // `{type:'tenant'}` scope held in `role_assignments`. Deliberately NOT from a
  // role name: `tenant_admin` is only a role key, and keying off the string would
  // hand an unconditional bypass to any future role that happened to share it.
  // The scope row is data, so the decision stays auditable and revocable per user.
  const tenantWide = ctx.isSuperAdmin || ctx.scopes.some((s) => s.type === 'tenant')

  // A requested subset narrows even an unrestricted caller — the intersection
  // rule holds for every resolved scope, `unrestricted` included. Returning
  // `unrestricted` here while ignoring a filter would hand back MORE than the
  // caller asked for.
  if (tenantWide && !requested && !options.personIds) return { kind: 'unrestricted' }

  return (async () => {
    // The org tree is read once for the tenant and walked in memory.
    const nodes = await tx
      .select({
        id: orgUnits.id,
        parentId: orgUnits.parentId,
        level: orgUnits.level,
        deletedAt: orgUnits.deletedAt,
      })
      .from(orgUnits)
      .where(eq(orgUnits.tenantId, ctx.tenantId))

    const live = new Map<string, OrgNode>()
    for (const n of nodes) {
      if (excludeDeleted && n.deletedAt !== null) continue
      live.set(n.id, n)
    }
    const childrenOf = buildOrgTreeIndex(nodes, { excludeDeleted })

    const wanted = requested && requested.length > 0 ? new Set(requested) : null

    // A tenant-wide caller resolving *with* a filter is scoped to that filter, not
    // to their assignments: the assignments say nothing about what they may see.
    let orgUnitIds: Set<string>
    if (tenantWide) {
      orgUnitIds = new Set(wanted ? [...wanted].filter((id) => live.has(id)) : [...live.keys()])
    } else {
      // Step 3 — the identity's own assignments.
      const me = await callerPersonIds(ctx, tx)
      if (me.length === 0) return empty('no_scope')

      const rows = await tx
        .select({
          id: peopleAssignments.id,
          personId: peopleAssignments.personId,
          orgUnitId: peopleAssignments.orgUnitId,
          validFrom: peopleAssignments.validFrom,
          validTo: peopleAssignments.validTo,
        })
        .from(peopleAssignments)
        .where(
          and(
            eq(peopleAssignments.tenantId, ctx.tenantId),
            inArray(peopleAssignments.personId, me),
          ),
        )
      if (rows.length === 0) return empty('no_assignment')

      // The one shared window rule, with an explicit `onDate`.
      const effective = rows.filter((r) => isAssignmentEffectiveOn(r, onDate))
      if (effective.length === 0) {
        // Distinguish "everything has ended" from "everything is still in the
        // future", so the reason is truthful rather than a guess.
        const allEnded = rows.every((r) => r.validTo !== null && r.validTo < onDate)
        return empty(allEnded ? 'expired_assignment' : 'no_assignment')
      }

      // Steps 6-7 — validate each target org unit, then expand both directions.
      orgUnitIds = new Set<string>()
      let missingOrgUnit = false
      for (const a of effective) {
        const node = live.get(a.orgUnitId)
        if (!node) {
          // Step 6 — an assignment to a missing, soft-deleted or other-tenant org
          // unit contributes nothing. It must never widen the result.
          missingOrgUnit = true
          continue
        }
        orgUnitIds.add(node.id)
        for (const d of descendantOrgUnitIds(childrenOf, node.id)) orgUnitIds.add(d)
        for (const a2 of ancestorOrgUnitIds(live, node.id)) orgUnitIds.add(a2)
      }
      if (orgUnitIds.size === 0) {
        return empty(missingOrgUnit ? 'missing_org_unit' : 'no_scope')
      }
    }

    // Step 9 — a requested org unit can only narrow, and the narrowing happens
    // BEFORE the person set is derived: a person assigned only to an org the
    // caller did not ask for is not in the answer. Applies to the tenant-wide
    // branch too, so the intersection rule is stated once.
    if (wanted) {
      const narrowed = new Set([...orgUnitIds].filter((id) => wanted.has(id)))
      orgUnitIds = narrowed
      if (orgUnitIds.size === 0) return empty('requested_outside_scope')
    }

    // Step 8 — the people in scope: everyone with an effective assignment to one
    // of the resolved org units. This is what makes a person-based entity
    // (`ppe_items`, training records) scopeable without a location column. The
    // date filter here is the same rule in SQL, for the inverse direction; the
    // contract suite asserts the SQL and the TypeScript forms agree.
    const peers = await tx
      .selectDistinct({
        personId: peopleAssignments.personId,
        orgUnitId: peopleAssignments.orgUnitId,
      })
      .from(peopleAssignments)
      .where(
        and(
          eq(peopleAssignments.tenantId, ctx.tenantId),
          inArray(peopleAssignments.orgUnitId, [...orgUnitIds]),
          effectiveOn(peopleAssignments.validFrom, peopleAssignments.validTo, sql`${onDate}`),
        ),
      )

    const personIds = new Set<string>()
    for (const p of peers) {
      if (orgUnitIds.has(p.orgUnitId)) personIds.add(p.personId)
    }

    // Step 10 — a person filter intersects like everything else.
    if (options.personIds) {
      const wantedPersons = new Set(options.personIds)
      for (const id of [...personIds]) if (!wantedPersons.has(id)) personIds.delete(id)
    }

    return assemble([...orgUnitIds].sort(), [...personIds].sort())
  })()
}
