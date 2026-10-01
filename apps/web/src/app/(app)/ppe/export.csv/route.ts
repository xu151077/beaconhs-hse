import type { NextRequest } from 'next/server'
import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL } from 'drizzle-orm'
import { people, ppeItems, ppeTypes } from '@beaconhs/db/schema'
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
import { withRouteErrors } from '@/lib/api/errors'
import { parseListParams, pickString } from '@/lib/list-params'
import { isRouterPrefetch } from '@/lib/router-prefetch'
import { moduleScopeWhere } from '@/lib/visibility'

export const dynamic = 'force-dynamic'

const SORTS = ['type', 'serial', 'size', 'status', 'holder'] as const

const STATUS_VALUES = [
  'in_stock',
  'issued',
  'returned',
  'out_of_service',
  'discarded',
  'expired',
] as const

export const GET = withRouteErrors(async (req: NextRequest) => {
  if (isRouterPrefetch(req)) return new Response(null, { status: 204 })

  const url = new URL(req.url)
  const sp = Object.fromEntries(url.searchParams.entries())
  const params = parseListParams(sp, {
    sort: 'type',
    dir: 'asc',
    perPage: 25,
    allowedSorts: SORTS,
  })
  // Mirror the register's status handling exactly: default to in-circulation
  // gear, `all` clears the filter, and unknown values are ignored instead of
  // reaching Postgres as invalid enum input. Drifting from the register here
  // would silently export a different set of rows than the screen showed.
  const statusRaw = pickString(sp.status) ?? 'active'
  const statusFilter =
    statusRaw === 'active'
      ? 'active'
      : (STATUS_VALUES as readonly string[]).includes(statusRaw)
        ? (statusRaw as (typeof STATUS_VALUES)[number])
        : undefined
  const ctx = await requireExportContext()
  // PPE has a single read tier (read.all); gate the tenant-wide export on it.
  assertCan(ctx, 'ppe.read.all')

  const rows = await ctx.db(async (tx) => {
    const filters: SQL<unknown>[] = [isNull(ppeItems.deletedAt)]
    // Read tier AND tenant, via the same call the PPE list makes
    // (`ppe/page.tsx`). `ppe_items` has no org-unit column, so the binding is
    // `current_holder_person_id` — the column the table already carries, on the
    // table this query already reads. No join and no new column is needed, and
    // the CSV can never report gear the same caller cannot see on the list.
    const scope = await moduleScopeWhere(ctx, tx, {
      prefix: 'ppe',
      personCol: ppeItems.currentHolderPersonId,
    })
    if (scope) filters.push(scope)
    if (params.q) {
      const term = `%${params.q}%`
      const cond = or(ilike(ppeItems.serialNumber, term), ilike(ppeTypes.name, term))
      if (cond) filters.push(cond)
    }
    if (statusFilter === 'active') {
      filters.push(inArray(ppeItems.status, ['in_stock', 'issued', 'returned', 'out_of_service']))
    } else if (statusFilter) {
      filters.push(eq(ppeItems.status, statusFilter))
    }
    const whereClause = and(...filters)

    const orderBy =
      params.sort === 'serial'
        ? [params.dir === 'asc' ? asc(ppeItems.serialNumber) : desc(ppeItems.serialNumber)]
        : params.sort === 'size'
          ? [params.dir === 'asc' ? asc(ppeItems.size) : desc(ppeItems.size)]
          : params.sort === 'status'
            ? [params.dir === 'asc' ? asc(ppeItems.status) : desc(ppeItems.status)]
            : params.sort === 'holder'
              ? [params.dir === 'asc' ? asc(people.lastName) : desc(people.lastName)]
              : [params.dir === 'asc' ? asc(ppeTypes.name) : desc(ppeTypes.name)]

    return tx
      .select({ item: ppeItems, type: ppeTypes, holder: people })
      .from(ppeItems)
      .innerJoin(ppeTypes, eq(ppeTypes.id, ppeItems.typeId))
      .leftJoin(people, eq(people.id, ppeItems.currentHolderPersonId))
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(CSV_EXPORT_QUERY_LIMIT)
  })

  const overflow = csvExportOverflowResponse(rows.length)
  if (overflow) return overflow

  await recordAudit(ctx, {
    entityType: 'ppe_item',
    action: 'export',
    summary: `Exported ${rows.length} PPE items to CSV`,
    metadata: { format: 'csv', filters: { q: params.q ?? null, status: statusFilter ?? null } },
  })

  const columns = csvColumns([
    'Type',
    'Serial #',
    'Size',
    'Status',
    'Holder',
    'Purchase date',
    'Expires on',
    'Next inspection',
  ])
  const selection = selectCsvColumns(url.searchParams, columns)

  return csvResponse({
    filename: csvFilename('ppe'),
    headers: selection.headers,
    rows: rows.map(({ item, type, holder }) =>
      selection.project([
        type.name,
        item.serialNumber ?? '',
        item.size ?? '',
        item.status,
        holder ? `${holder.firstName} ${holder.lastName}` : '',
        item.purchaseDate ?? '',
        item.expiresOn ?? '',
        item.nextInspectionDue ?? '',
      ]),
    ),
  })
})
