// Configurable record-visibility resolver.
//
// Turns a user's role-assignment scopes (RoleScope) into a WHERE predicate over
// a record's "owner" columns, so a limited user sees only: their own records ·
// own + a hand-picked set of people · a department (people in chosen departments
// and/or groups) · specific sites · or everybody. Each record list calls this
// inside its query and ANDs the result into its filters.
//
// Super-admins and anyone holding a `tenant` scope see everything (returns
// undefined). Department membership is read from people.departmentId and group
// membership from the denormalised people.groupIds cache, so no extra joins are
// needed.
//
// SINCE 15B-2 this file ANDs a third input: the canonical Project Scope
// (`resolveProjectScopeIn`). The model is
//
//     Permission  ->  Read Tier  ->  Visibility  AND  Project Scope  ->  predicate
//
// and the rule that makes it safe is that **Project Scope can only narrow**.
// Before 15B-2 a maximal tier short-circuited to "no filter", which silently
// discarded scope. Now `undefined` (no constraint) is returned for exactly one
// reason — the caller is genuinely company-wide — and an empty scope is a hard
// `sql`false``. `projectScopePredicate` is the single place that decides which.

import { eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { people } from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'
import { can, type RequestContext } from '@beaconhs/tenant'
import { resolveProjectScopeIn } from './project-scope'
import {
  andPredicates,
  isAlwaysFalse,
  projectScopePredicate,
  recordInProjectScope,
} from './project-scope-predicate'

type RecordOwnerColumns = {
  /** Person the record is about/assigned to (holder, owner, assignee, author). */
  personCol?: PgColumn
  /** tenant_users id of whoever created the record. */
  createdByCol?: PgColumn
  /** The record's site/org unit, for the `sites` scope. */
  siteCol?: PgColumn
}

/** A safe, parameterised `array['a','b']::text[]` literal. */
function textArray(ids: string[]): SQL {
  return sql`array[${sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  )}]::text[]`
}

/**
 * Build the visibility predicate for a record list from the caller's scopes.
 * Returns `undefined` (no filter) for super-admins and tenant-scoped users;
 * otherwise unions own records with every scope the user holds. A user whose
 * scopes resolve to nothing sees an empty list — never the whole tenant.
 *
 * Call inside the list query's `ctx.db((tx) => …)` so the people sub-selects run
 * under the same RLS-bounded transaction.
 */
export async function recordVisibilityWhere(
  ctx: RequestContext,
  tx: Database,
  cols: RecordOwnerColumns,
): Promise<SQL | undefined> {
  if (ctx.isSuperAdmin) return undefined
  const scopes = ctx.scopes
  if (scopes.some((s) => s.type === 'tenant')) return undefined

  const conds: SQL[] = []

  // Project Scope, ANDed in. Deliberately placed AFTER the two unrestricted
  // returns above: those are the only paths that may yield `undefined`, and the
  // only two that may skip the scope entirely.
  const projectScope = await resolveProjectScopeIn(ctx, tx)
  const scopeCond = projectScopePredicate(projectScope, {
    orgUnitCol: cols.siteCol,
    personCol: cols.personCol,
  })
  if (scopeCond) conds.push(scopeCond)

  // Always include the caller's own records (as subject and/or creator).
  if (cols.personCol && ctx.personId) {
    conds.push(eq(cols.personCol, ctx.personId))
  }
  const myUserId = ctx.membership?.id
  if (cols.createdByCol && myUserId) {
    conds.push(eq(cols.createdByCol, myUserId))
  }

  for (const s of scopes) {
    if (s.type === 'sites' && cols.siteCol && s.siteIds.length > 0) {
      conds.push(inArray(cols.siteCol, s.siteIds))
    } else if (s.type === 'people' && cols.personCol && s.personIds.length > 0) {
      conds.push(inArray(cols.personCol, s.personIds))
    } else if (s.type === 'crews' && cols.personCol && s.crewIds.length > 0) {
      conds.push(
        inArray(
          cols.personCol,
          tx.select({ id: people.id }).from(people).where(inArray(people.crewId, s.crewIds)),
        ),
      )
    } else if (s.type === 'team' && cols.personCol) {
      const member: SQL[] = []
      if (s.departmentIds.length > 0) member.push(inArray(people.departmentId, s.departmentIds))
      if (s.groupIds.length > 0)
        member.push(sql`jsonb_exists_any(${people.groupIds}, ${textArray(s.groupIds)})`)
      const memberWhere = or(...member)
      if (memberWhere) {
        conds.push(
          inArray(cols.personCol, tx.select({ id: people.id }).from(people).where(memberWhere)),
        )
      }
    }
  }

  // No scope grants anything → see nothing (defensive; never fall through to all).
  if (conds.length === 0) return sql`false`
  return conds.length === 1 ? conds[0] : or(...conds)
}

// ---------------------------------------------------------------------------
// Tiered per-module record visibility (the "most people see only their own"
// model). Permission-driven (not scope-driven like recordVisibilityWhere above):
// each record module declares `<prefix>.read.{all,site,self}` keys, and these
// helpers turn the caller's tier into a list predicate (`moduleScopeWhere`) or a
// single-record guard (`canSeeRecord`). Generalises the Journals approach
// (journals/_lib.ts `journalScopeWhere`) to every record module.
// ---------------------------------------------------------------------------

type VisibilityTier = 'all' | 'site' | 'self'

/**
 * The record-visibility tier this context holds for a module, from its tiered
 * read permissions: `<prefix>.read.all` (or super-admin) → all; `.read.site` →
 * site; otherwise self (the safe default — a role with no read tier still only
 * ever sees its own records, never the whole tenant).
 */
function resolveVisibilityTier(ctx: RequestContext, prefix: string): VisibilityTier {
  if (ctx.isSuperAdmin || can(ctx, `${prefix}.read.all`)) return 'all'
  if (can(ctx, `${prefix}.read.site`)) return 'site'
  return 'self'
}

function mySiteIds(ctx: RequestContext): string[] {
  return ctx.scopes.flatMap((s) => (s.type === 'sites' ? s.siteIds : []))
}

function myTenantUserId(ctx: RequestContext): string | null {
  return ctx.membership?.id ?? null
}

type ModuleScopeCols = {
  /** Permission-key prefix, e.g. 'incidents' | 'ca' | 'hazid' | 'inspections' | 'forms.response'. */
  prefix: string
  /** tenant_users columns identifying who owns/created/submitted the record. */
  ownerCols?: PgColumn[]
  /** The record's site/org-unit column, for the `site` tier. */
  siteCol?: PgColumn
  /** A person column when the viewer can also be the record's SUBJECT. */
  personCol?: PgColumn
}

/** The "this record is mine" conditions: an owner column equals me, or I'm the subject. */
async function ownPredicates(ctx: RequestContext, cols: ModuleScopeCols): Promise<SQL[]> {
  const conds: SQL[] = []
  const tuId = myTenantUserId(ctx)
  if (tuId && cols.ownerCols) for (const c of cols.ownerCols) conds.push(eq(c, tuId))
  if (cols.personCol && ctx.personId) conds.push(eq(cols.personCol, ctx.personId))
  return conds
}

/**
 * List predicate enforcing the caller's read tier for a module. AND this into a
 * list query's WHERE. Returns:
 *   all  → undefined (no extra filter; RLS already bounds to tenant)
 *   site → records at the caller's scoped sites, unioned with their own
 *   self → records the caller owns/created or is the subject of (else `false`)
 * Call inside `ctx.db((tx) => …)` so the person sub-select runs under the same tx.
 */
export async function moduleScopeWhere(
  ctx: RequestContext,
  tx: Database,
  cols: ModuleScopeCols,
): Promise<SQL | undefined> {
  const tier = resolveVisibilityTier(ctx, cols.prefix)

  // Project Scope is resolved ONCE per call and ANDed with the visibility
  // predicate below. It is not an input to the tier decision, and it never
  // replaces the tier decision.
  const projectScope = await resolveProjectScopeIn(ctx, tx)
  const scopeCond = projectScopePredicate(projectScope, {
    orgUnitCol: cols.siteCol,
    personCol: cols.personCol,
  })

  // Opt-in hazid read of others' assessments. Since 15B-2 this removes only the
  // VISIBILITY restriction (it lets a self-tier holder see other people's rows) —
  // it no longer implies company-wide, because Project Scope is ANDed regardless.
  const othersTier = cols.prefix === 'hazid' && can(ctx, 'hazid.read.others')

  // An empty Project Scope is terminal: nothing a permission can grant is visible
  // inside no scope. Returning the visibility predicate here would be a leak.
  if (isAlwaysFalse(scopeCond)) return scopeCond

  if (tier === 'all' || othersTier) return scopeCond

  const ownConds = await ownPredicates(ctx, cols)

  if (tier === 'site' && cols.siteCol) {
    const sites = mySiteIds(ctx)
    if (sites.length > 0) {
      return andPredicates(or(inArray(cols.siteCol, sites), ...ownConds), scopeCond)
    }
    // read.site but no site scope assigned → fall through to own-only.
    // NOTE: this is the "own-only fallback" the 15B-1 audit flagged as
    // disagreeing with `packages/analytics/src/server/scope.ts:383`, which
    // withholds instead. The disagreement is recorded, not resolved here.
  }

  const visibility =
    ownConds.length === 0 ? sql`false` : ownConds.length === 1 ? ownConds[0]! : or(...ownConds)
  return andPredicates(visibility, scopeCond)
}

type RecordOwnership = {
  prefix: string
  /** tenant_users ids that own/created/submitted the record (nullish ignored). */
  ownerIds?: (string | null | undefined)[]
  siteId?: string | null
  /** person id the record is about, compared to the caller's person. */
  personId?: string | null
}

/**
 * Detail-page guard mirroring `moduleScopeWhere` for a single loaded record —
 * `notFound()` when this returns false. Closes the read-by-guessing-the-URL gap:
 * all → always; site → record at one of my sites (or mine); self → mine only.
 */
export async function canSeeRecord(
  ctx: RequestContext,
  tx: Database,
  rec: RecordOwnership,
): Promise<boolean> {
  // Project Scope first, and it is NOT overridable by a permission. Resolved from
  // the same resolver, in the same transaction, as `moduleScopeWhere` — so the
  // list filter and this detail guard cannot disagree. A record the SQL filters
  // out is not readable by id, and a record this refuses cannot come back from a
  // list query.
  const projectScope = await resolveProjectScopeIn(ctx, tx)
  if (!recordInProjectScope(projectScope, { siteId: rec.siteId, personId: rec.personId })) {
    return false
  }

  const tier = resolveVisibilityTier(ctx, rec.prefix)
  // Same opt-in as moduleScopeWhere, with the same narrowed meaning since 15B-2:
  // `hazid.read.others` lifts the VISIBILITY tier, not the Project Scope check
  // that already ran above.
  if (tier === 'all' || (rec.prefix === 'hazid' && can(ctx, 'hazid.read.others'))) return true
  if (tier === 'site' && rec.siteId && mySiteIds(ctx).includes(rec.siteId)) return true

  const tuId = myTenantUserId(ctx)
  if (tuId && rec.ownerIds?.some((o) => o === tuId)) return true
  if (rec.personId && ctx.personId && ctx.personId === rec.personId) return true
  return false
}
