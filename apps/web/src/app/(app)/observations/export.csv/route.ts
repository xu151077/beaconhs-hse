import type { NextRequest } from 'next/server'
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
import { isRouterPrefetch } from '@/lib/router-prefetch'
import { listObservations, openActionCountsForPage } from '../_data'
import {
  JOURNAL_TAG_NAME_LIMIT,
  type JournalDefinition,
  type JournalStatus,
} from '../../journals/_types'
import { isUuid } from '@/lib/list-params'

export const dynamic = 'force-dynamic'

const STATUS_VALUES = ['draft', 'submitted', 'archived'] as const
const DEFINITION_VALUES = ['positive_observation', 'negative_observation'] as const

export async function GET(req: NextRequest) {
  if (isRouterPrefetch(req)) return new Response(null, { status: 204 })

  const ctx = await requireExportContext()
  // The same gate the journals CSV route uses, because the same permission
  // family is the boundary: a caller who cannot read a single journal cannot
  // export the observations subset either.
  assertCan(ctx, 'journals.read.self')

  const sp = new URL(req.url).searchParams
  const get = (k: string) => sp.get(k) || undefined

  const status = get('status')
  const definition = get('definition')
  const site = get('site')
  const person = get('person')
  const tag = get('tag')
  const from = get('from')
  const to = get('to')

  const filters = {
    q: get('q'),
    status: (STATUS_VALUES as readonly string[]).includes(status ?? '')
      ? (status as JournalStatus)
      : undefined,
    definition: (DEFINITION_VALUES as readonly string[]).includes(definition ?? '')
      ? (definition as JournalDefinition)
      : undefined,
    site: site && isUuid(site) ? site : undefined,
    person: person && isUuid(person) ? person : undefined,
    tag:
      tag && tag.length <= JOURNAL_TAG_NAME_LIMIT && !/[\u0000-\u001f\u007f]/.test(tag)
        ? tag
        : undefined,
    from: from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : undefined,
    to: to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : undefined,
  }

  // Observations only — `listObservations` partitions the class server-side, so
  // this route can never emit a daily journal.
  const rows = await listObservations(ctx, filters, { limit: CSV_EXPORT_QUERY_LIMIT })

  const overflow = csvExportOverflowResponse(rows.length)
  if (overflow) return overflow

  const openActions = await openActionCountsForPage(
    ctx,
    rows.map((r) => r.id),
  )

  await recordAudit(ctx, {
    entityType: 'journal_entry',
    action: 'export',
    summary: `Exported ${rows.length} observation${rows.length === 1 ? '' : 's'} to CSV`,
    metadata: { format: 'csv', kind: 'safety_observation' },
  })

  const columns = csvColumns([
    'Reference',
    'Date',
    'Title',
    'Type',
    'Status',
    'Author',
    'Location',
    'Tags',
    'Photos',
    'Open actions',
    'Description',
  ])
  const selection = selectCsvColumns(sp, columns)

  return csvResponse({
    filename: csvFilename('observations'),
    headers: selection.headers,
    rows: rows.map((r) =>
      selection.project([
        r.reference,
        r.entryDate,
        r.title ?? '',
        r.definition,
        r.status,
        r.authorName ?? '',
        r.siteName ?? '',
        r.tags.join('; '),
        String(r.photoCount),
        String(openActions[r.id] ?? 0),
        r.snippet,
      ]),
    ),
  })
}
