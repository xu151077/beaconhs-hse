// Read layer for the Safety Observations surface.
//
// A safety observation IS a journal entry whose `definition` is
// `positive_observation` or `negative_observation` — it is a CLASSIFICATION of
// the existing record, not a second table. This module therefore owns no
// authorization of its own: every query below delegates to the journals read
// layer (`listEntries` / `countEntries` / `getEntry` / `listRecordsFacets`) with
// `entryClass: 'observation'`, which routes through the same
// `journalScopeWhere()` predicate, the same `journals.*` read tiers and the same
// RLS boundary as a daily journal.
//
// The one thing this module adds is the REVERSE direction: a corrective action
// points back at the observation it came from through the existing polymorphic
// `corrective_actions.source_entity_type` / `source_entity_id` pair, and there is
// no column on `journal_entries` to hold that. The observations detail page is
// the only place that needs it, so the lookup lives here.

import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { correctiveActions } from '@beaconhs/db/schema'
import { can, type RequestContext } from '@beaconhs/tenant'
import type { Database } from '@beaconhs/db'
import { isObservationEntry, type EntryClass } from '@beaconhs/db/journal-class'
import {
  countEntries,
  getEntry,
  listEntries,
  listRecordsFacets,
  listTagColors,
} from '../journals/_data'
import type { JournalFilters, JournalRecordsFacets, JournalSort } from '../journals/_types'
import type { ObservationRow } from './_types'

/** The only `entryClass` this surface ever passes. Named so a call site cannot
 *  pass the wrong one by accident. */
const ENTRY_CLASS: EntryClass = 'observation'

/**
 * Cards for /observations, with the display fields the table needs already
 * joined. Same paging/sort contract as the journals list.
 *
 * The definition is narrowed to the two observation values here rather than
 * asserted at the call site: the class predicate in `listEntries` already
 * guarantees it, and a row that somehow is not an observation is dropped rather
 * than rendered with an impossible union type.
 */
export async function listObservations(
  ctx: RequestContext,
  filters: JournalFilters,
  paging: { limit?: number; offset?: number; sort?: JournalSort; dir?: 'asc' | 'desc' } = {},
): Promise<ObservationRow[]> {
  const rows = await listEntries(ctx, filters, paging, false, ENTRY_CLASS)
  return rows.flatMap((row) =>
    isObservationEntry(row.definition)
      ? [{ ...row, definition: row.definition as ObservationRow['definition'] }]
      : [],
  )
}

/** Governed tag colours for the rows on this page. */
export async function observationTagColors(
  ctx: RequestContext,
  names: readonly string[],
): Promise<Record<string, string | null>> {
  return listTagColors(ctx, names)
}

/** Total matching, for the count + pagination. */
export async function countObservations(
  ctx: RequestContext,
  filters: JournalFilters,
): Promise<number> {
  return countEntries(ctx, filters, ENTRY_CLASS)
}

/** Scoped status counts, for the filter chips. */
export async function listObservationFacets(ctx: RequestContext): Promise<JournalRecordsFacets> {
  return listRecordsFacets(ctx, ENTRY_CLASS)
}

/**
 * One observation, or null. Null covers BOTH "no such id" and "not visible to
 * this caller", so the detail page can `notFound()` without leaking whether the
 * record exists.
 */
export async function getObservation(
  ctx: RequestContext,
  id: string,
): Promise<Awaited<ReturnType<typeof getEntry>>> {
  return getEntry(ctx, id, ENTRY_CLASS)
}

export type LinkedAction = {
  id: string
  reference: string
  title: string
  status: string
  severity: string
  dueOn: string | null
  closedAt: string | null
}

/**
 * The corrective actions raised from one observation — the 1:N leg of
 * Observation → Corrective Action.
 *
 * The link is held entirely by `corrective_actions`: `source = 'observation'`
 * (a value the enum already had and nothing produced until now) plus the
 * polymorphic `source_entity_type = 'journal_entry'` / `source_entity_id`. There
 * is no FK and no column on `journal_entries` to add, and nothing to migrate.
 *
 * Visibility is the caller's own: the rows are filtered by `ca.read` tier and the
 * caller's scope, so an observation never exposes an action the viewer could not
 * otherwise open. A positive observation legitimately has none.
 */
export async function listObservationActions(
  ctx: RequestContext,
  observationId: string,
): Promise<LinkedAction[]> {
  return ctx.db(async (tx) => {
    const scope = actionVisibilityWhere(ctx)
    const rows = await tx
      .select({
        id: correctiveActions.id,
        reference: correctiveActions.reference,
        title: correctiveActions.title,
        status: correctiveActions.status,
        severity: correctiveActions.severity,
        dueOn: correctiveActions.dueOn,
        closedAt: correctiveActions.closedAt,
      })
      .from(correctiveActions)
      .where(
        and(
          eq(correctiveActions.sourceEntityType, 'journal_entry'),
          eq(correctiveActions.sourceEntityId, observationId),
          isNull(correctiveActions.deletedAt),
          scope,
        ),
      )
      .orderBy(asc(correctiveActions.assignedOn), desc(correctiveActions.createdAt))
    // `closed_at` is a timestamptz; the client renders it as a plain date string,
    // and the linked list crosses the RSC boundary, so normalise it here the way
    // the journals reader normalises its own timestamps.
    return rows.map((r) => ({
      ...r,
      closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    }))
  })
}

/**
 * The caller's corrective-action read boundary, applied to the linked-action
 * list. Mirrors the `ca` tier ladder `moduleScopeWhere` implements, inlined here
 * so this read does not need a transaction-scoped call before its own opens.
 *
 * read.all → no filter (RLS already bounds to the tenant). read.site → my sites
 * UNION my own, so a scoped reviewer still sees an action they own at another
 * site — the journals own-record cross-site rule, applied consistently. Lower
 * tiers → own only, and `false` when I have no identity, so the list is empty
 * rather than tenant-wide.
 */
function actionVisibilityWhere(ctx: RequestContext): SQL | undefined {
  if (ctx.isSuperAdmin || can(ctx, 'ca.read.all')) return undefined

  // The own-record leg. `membership.id` is compared through the same
  // 'super-admin' sentinel guard `authorTenantUserId` uses, so the sentinel is
  // never handed to a uuid comparison.
  const own: SQL[] = []
  const tenantUserId = ctx.membership?.id
  if (tenantUserId && tenantUserId !== 'super-admin') {
    own.push(eq(correctiveActions.ownerTenantUserId, tenantUserId))
    own.push(eq(correctiveActions.assignedByTenantUserId, tenantUserId))
  }
  const ownWhere = own.length === 0 ? null : own.length === 1 ? own[0]! : or(...own)!

  if (can(ctx, 'ca.read.site')) {
    const siteIds = ctx.scopes.flatMap((s) => (s.type === 'sites' ? s.siteIds : []))
    if (siteIds.length > 0) {
      const siteWhere = inArray(correctiveActions.siteOrgUnitId, siteIds)
      return ownWhere ? or(siteWhere, ownWhere)! : siteWhere
    }
  }
  return ownWhere ?? sql`false`
}

/**
 * Open-action counts for a whole page of observations, in one grouped query.
 * Returns `observationId → count`, so the list can render a "Needs action"
 * column without an N+1.
 */
export async function openActionCountsForPage(
  ctx: RequestContext,
  observationIds: string[],
): Promise<Record<string, number>> {
  if (observationIds.length === 0) return {}
  return ctx.db((tx) => countOpenActionsByObservation(ctx, tx, observationIds))
}

/**
 * A per-observation count of open corrective actions, for the list's
 * "Needs action" column. One grouped query for the whole page rather than N.
 */
async function countOpenActionsByObservation(
  ctx: RequestContext,
  tx: Database,
  observationIds: string[],
): Promise<Record<string, number>> {
  if (observationIds.length === 0) return {}
  const scope = actionVisibilityWhere(ctx)
  const rows = await tx
    .select({
      sourceEntityId: correctiveActions.sourceEntityId,
      c: sql<number>`count(*)::int`,
    })
    .from(correctiveActions)
    .where(
      and(
        eq(correctiveActions.sourceEntityType, 'journal_entry'),
        inArray(correctiveActions.sourceEntityId, observationIds),
        isNull(correctiveActions.deletedAt),
        sql`${correctiveActions.status} not in ('closed','cancelled')`,
        scope,
      ),
    )
    .groupBy(correctiveActions.sourceEntityId)
  return Object.fromEntries(rows.map((r) => [r.sourceEntityId, Number(r.c)]))
}
