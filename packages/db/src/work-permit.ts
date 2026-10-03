// Work Permit — the ONE thing that had to be defined rather than reused.
//
// BeaconHS already expresses a work permit completely as a Builder App: a
// `form_templates` row in the `work_permit` category, a `form_responses` record
// carrying the requester / site / hazards / controls, `flow_gates` for approval,
// and the monitored-session timer (`monitorStatus`, `nextCheckinDueAt`,
// `expectedEndAt`) for the validity window. This module adds no table, no
// permission, no RoleScope variant and no authorization rule.
//
// What it DOES own is the one confirmed behavioural gap: a permit must stop
// being usable the moment its approved validity window ends, and nothing in the
// existing code did that. `expectedEndAt` was written by
// `start_monitored_session` and exposed as a report column, but never READ to
// change state — so a permit whose window expired while nobody touched it stayed
// `active` forever. Only a MISSED CHECK-IN escalated it, which is a different
// condition (the holder went quiet mid-window) from expiry (the window closed).
//
// So expiry is expressed the only honest way available, without inventing a
// status: the window is a predicate over existing columns.
//
//   active-and-usable  := monitor_status = 'active' AND (expected_end_at IS NULL
//                         OR expected_end_at > now)
//   window-has-ended   := expected_end_at IS NOT NULL AND expected_end_at <= now
//
// `now` is a parameter, never `now()` inside the fragment, so a caller and a test
// agree on the instant and the predicate is deterministic.
//
// `formMonitorStatus` has no `expired` value and none is added: a permit whose
// window closed is driven to an existing terminal state (`completed`) by the
// worker scan, and until that scan runs the predicate above already refuses to
// present it as active. Product surfaces show "Expired" as a DERIVED label, not a
// stored status.

import { and, eq, gt, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { formResponses } from './schema/forms'

/** `form_templates.category` value that marks a template as a work permit. */
export const WORK_PERMIT_CATEGORY = 'work_permit'

/** Stable `form_templates.key` of the seeded Work Permit Builder App. */
export const WORK_PERMIT_APP_KEY = 'work-permit'

/**
 * The comparison instant. Pass a `Date` when the caller wants the predicate to be
 * reproducible (tests, request-time reads with a single shared `now`), or a raw
 * SQL fragment such as `sql\`now()\`` when the worker wants the DATABASE clock so
 * worker/DB skew cannot close a window early.
 */
export type PermitWindowInstant = Date | SQL

/**
 * WHERE fragment: the monitored session is inside its validity window right now.
 *
 * This is the safety-critical half. Any surface that answers "is this permit
 * currently live?" MUST AND this in rather than trusting `monitor_status`, because
 * the worker scan runs on a cron and there is always a window between the moment
 * a window ends and the moment the scan observes it.
 *
 * A NULL `expectedEndAt` means the session has no fixed end (an open-ended
 * monitored session), which stays valid — that is the existing behaviour for every
 * non-permit monitored session, and this predicate must not change it.
 */
export function permitWindowOpen(now: PermitWindowInstant): SQL {
  const afterNow =
    now instanceof Date
      ? gt(formResponses.expectedEndAt, now)
      : sql`${formResponses.expectedEndAt} > ${now}`
  return and(
    eq(formResponses.monitorStatus, 'active'),
    or(isNull(formResponses.expectedEndAt), afterNow),
  )!
}

/**
 * WHERE fragment: the monitored session's validity window has ended.
 *
 * Used by the worker scan to terminate a permit, and by read surfaces to label it
 * "Expired" while the scan is still catching up.
 */
export function permitWindowEnded(now: PermitWindowInstant): SQL {
  return and(
    isNotNull(formResponses.expectedEndAt),
    now instanceof Date
      ? lte(formResponses.expectedEndAt, now)
      : sql`${formResponses.expectedEndAt} <= ${now}`,
  )!
}

/**
 * SELECT projection: a boolean "this window has ended" for list rows, so a surface
 * can show the derived Expired label while the scan is still catching up.
 *
 * `permitWindowEnded(now) as SQL<boolean>` is the same expression; this wrapper
 * exists only so call sites don't repeat the cast.
 */
export function permitWindowEndedExpr(now: PermitWindowInstant): SQL<boolean> {
  return permitWindowEnded(now) as SQL<boolean>
}
