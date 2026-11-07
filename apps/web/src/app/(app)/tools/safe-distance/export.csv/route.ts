import type { NextRequest } from 'next/server'
import { and, asc, desc, eq, ilike, isNull, or, type SQL } from 'drizzle-orm'
import { orgUnits, safeDistanceRecords } from '@beaconhs/db/schema'
import { assertCan } from '@beaconhs/tenant'
import { requireExportContext } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import {
  CSV_EXPORT_QUERY_LIMIT,
  csvExportOverflowResponse,
  csvFilename,
  csvResponse,
} from '@/lib/csv'
import { csvColumns, selectCsvColumns } from '@/lib/export-columns'
import { parseListParams, pickString } from '@/lib/list-params'
import { SAFE_DISTANCE_PERMISSION, safeDistanceScopeWhere } from '@/lib/safe-distance-access'
import {
  pressureUnitLabel,
  SAFE_DISTANCE_METHOD_LABELS,
  type SafeDistanceMethod,
  type SafeDistanceUnit,
} from '../_lib'
import { isRouterPrefetch } from '@/lib/router-prefetch'

import { withRouteErrors } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

const SORTS = ['reference', 'occurred_at', 'name', 'method'] as const
const METHODS: SafeDistanceMethod[] = ['nasa', 'asme', 'lloyds']

async function getHandler(req: NextRequest) {
  if (isRouterPrefetch(req)) return new Response(null, { status: 204 })

  const url = new URL(req.url)
  const sp = Object.fromEntries(url.searchParams.entries())
  const params = parseListParams(sp, {
    sort: 'occurred_at',
    dir: 'desc',
    perPage: 25,
    allowedSorts: SORTS,
  })
  const methodFilter = pickString(sp.method)
  const ctx = await requireExportContext()
  assertCan(ctx, SAFE_DISTANCE_PERMISSION)

  const rows = await ctx.db(async (tx) => {
    const filters: SQL<unknown>[] = [isNull(safeDistanceRecords.deletedAt)]
    // The SAME native read tier the list applies, through the same shared helper
    // and the same two native columns. The CSV is a second rendering of the
    // screen, so it must not be able to reach a row the list withholds — nor may
    // it be narrowed independently of the list.
    //
    // `tools.safe-distance.read.{all,site,self}` now exists, so this route no
    // longer needs a bespoke adapter: the tier resolves from the caller's own
    // permission plus their `{type:'sites'}` Role Scope, and a caller with no
    // read key falls back to `self` (their own operated checks) rather than to
    // the whole tenant. `safe_distance_records` carries both `site_org_unit_id`
    // and `operator_person_id`, and the analytics `safe_distance` spec binds the
    // same two, so this file and a saved report agree with each other.
    const scopeWhere = await safeDistanceScopeWhere(ctx, tx)
    if (scopeWhere) filters.push(scopeWhere)
    if (params.q) {
      const term = `%${params.q}%`
      const cond = or(
        ilike(safeDistanceRecords.reference, term),
        ilike(safeDistanceRecords.name, term),
        ilike(safeDistanceRecords.description, term),
        ilike(safeDistanceRecords.notes, term),
      )
      if (cond) filters.push(cond)
    }
    if (methodFilter && METHODS.includes(methodFilter as SafeDistanceMethod))
      filters.push(eq(safeDistanceRecords.method, methodFilter as SafeDistanceMethod))
    const whereClause = and(...filters)

    const orderBy =
      params.sort === 'reference'
        ? [
            params.dir === 'asc'
              ? asc(safeDistanceRecords.reference)
              : desc(safeDistanceRecords.reference),
          ]
        : params.sort === 'name'
          ? [params.dir === 'asc' ? asc(safeDistanceRecords.name) : desc(safeDistanceRecords.name)]
          : params.sort === 'method'
            ? [
                params.dir === 'asc'
                  ? asc(safeDistanceRecords.method)
                  : desc(safeDistanceRecords.method),
              ]
            : [
                params.dir === 'asc'
                  ? asc(safeDistanceRecords.occurredAt)
                  : desc(safeDistanceRecords.occurredAt),
              ]

    return tx
      .select({ rec: safeDistanceRecords, site: orgUnits })
      .from(safeDistanceRecords)
      .leftJoin(orgUnits, eq(orgUnits.id, safeDistanceRecords.siteOrgUnitId))
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(CSV_EXPORT_QUERY_LIMIT)
  })

  const overflow = csvExportOverflowResponse(rows.length)
  if (overflow) return overflow

  await recordAudit(ctx, {
    entityType: 'safe_distance_record',
    action: 'export',
    summary: `Exported ${rows.length} safe-distance records to CSV`,
    metadata: {
      format: 'csv',
      filters: { q: params.q ?? null, method: methodFilter ?? null },
    },
  })

  const columns = csvColumns([
    'Reference',
    'Date',
    'Name',
    'Method',
    'Unit',
    'Test pressure',
    'Pressure unit',
    'Total volume',
    'NASA (dist)',
    'ASME (dist)',
    "Lloyd's (dist)",
    'Site',
    'Locked',
    'Notes',
  ])
  const selection = selectCsvColumns(url.searchParams, columns)

  return csvResponse({
    filename: csvFilename('safe-distance'),
    headers: selection.headers,
    rows: rows.map(({ rec, site }) =>
      selection.project([
        rec.reference,
        rec.occurredAt ? new Date(rec.occurredAt).toISOString() : '',
        rec.name,
        SAFE_DISTANCE_METHOD_LABELS[rec.method as SafeDistanceMethod],
        rec.unit,
        rec.testPressure ?? '',
        pressureUnitLabel(rec.unit as SafeDistanceUnit),
        rec.totalVolume ?? '',
        rec.resultNasa ?? '',
        rec.resultAsme ?? '',
        rec.resultLloyds ?? '',
        site?.name ?? '',
        rec.locked ? 'Yes' : 'No',
        rec.notes ?? '',
      ]),
    ),
  })
}

export const GET = withRouteErrors(getHandler)
