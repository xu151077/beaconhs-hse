import type { Database } from '@beaconhs/db'
import { safeDistanceRecords } from '@beaconhs/db/schema'
import { can, type RequestContext } from '@beaconhs/tenant'
import { canSeeRecord, moduleScopeWhere } from './visibility'

/** One capability gates the native Safe Distance tool end to end. */
export const SAFE_DISTANCE_PERMISSION = 'tools.safe-distance.use' as const

/**
 * Permission-key PREFIX for the Safe Distance read tier, so the module resolves
 * its visibility through the one canonical ladder rather than any bespoke rule.
 *
 * `resolveVisibilityTier(ctx, prefix)` reads `<prefix>.read.all` / `.read.site`
 * and falls back to `self`, which makes the three catalogue keys
 * `tools.safe-distance.read.{all,site,self}` the whole read boundary:
 *
 *   all  → no extra filter; RLS already bounds the query to the tenant
 *   site → records at the sites named by the caller's `{type:'sites'}` Role Scope,
 *          unioned with their own
 *   self → records whose `operator_person_id` is the caller
 *
 * There is deliberately no Safe Distance ACL, scope type, or row-predicate
 * resolver. `tools.safe-distance.use` above stays the separate OPERATE
 * capability (open the tool, create, save, lock, print, export); this prefix is
 * the READ axis and the two are independent.
 */
export const SAFE_DISTANCE_SCOPE_PREFIX = 'tools.safe-distance' as const

/**
 * The two columns the ladder binds, declared ONCE.
 *
 * `safe_distance_records` carries both natively, which is what makes the tier
 * enforceable rather than withheld:
 *   • `site_org_unit_id`   — the site the pressure test was recorded at
 *   • `operator_person_id` — the person who performed the check
 *
 * Every surface (list, detail, print, CSV, and the analytics `safe_distance`
 * spec) binds this same pair, so a record the list filters out cannot be reached
 * by id and a saved report cannot disagree with the screen.
 */
export const SAFE_DISTANCE_SCOPE_COLUMNS = {
  prefix: SAFE_DISTANCE_SCOPE_PREFIX,
  siteCol: safeDistanceRecords.siteOrgUnitId,
  personCol: safeDistanceRecords.operatorPersonId,
  // Safe Distance is bounded by Permission + Role Scope + tier + RLS alone. It
  // opts out of the Project Scope conjunct that `moduleScopeWhere` ANDs for every
  // other module, so the tier is the WHOLE read boundary here rather than one of
  // two. The tier logic itself is untouched — this is one conjunct, not a
  // parallel ladder — and the site binding still comes from the caller's own
  // `{type:'sites'}` Role Scope.
  applyProjectScope: false,
} as const

/** May this person open and operate the Safe Distance tool? */
export function canUseSafeDistance(ctx: RequestContext): boolean {
  return can(ctx, SAFE_DISTANCE_PERMISSION)
}

/**
 * List predicate for `safe_distance_records`, AND this into a list query's WHERE.
 * Resolved by the shared ladder, so it cannot drift from the detail guard below.
 * Call inside the caller's `ctx.db((tx) => …)`.
 */
export function safeDistanceScopeWhere(ctx: RequestContext, tx: Database) {
  return moduleScopeWhere(ctx, tx, SAFE_DISTANCE_SCOPE_COLUMNS)
}

/**
 * Single-record guard for the detail and print views. `notFound()` when false,
 * which closes the read-by-guessing-the-URL gap: a record the list filters out
 * is not readable by id.
 */
export function canSeeSafeDistanceRecord(
  ctx: RequestContext,
  tx: Database,
  rec: { siteOrgUnitId?: string | null; operatorPersonId?: string | null },
) {
  return canSeeRecord(ctx, tx, {
    prefix: SAFE_DISTANCE_SCOPE_PREFIX,
    siteId: rec.siteOrgUnitId ?? null,
    personId: rec.operatorPersonId ?? null,
    applyProjectScope: false,
  })
}
