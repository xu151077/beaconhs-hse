import { getGeneratedTranslations } from '@/i18n/generated.server'
import Link from 'next/link'
import { Button, EmptyState, PageHeader } from '@beaconhs/ui'
import { can } from '@beaconhs/tenant'
import { requireRequestContext } from '@/lib/auth'
import { ListPageLayout } from '@/components/page-layout'
import { TableToolbar } from '@/components/table-toolbar'
import { SearchInput } from '@/components/search-input'
import { Pagination } from '@/components/pagination'
import { FilterChips } from '@/components/filter-bar'
import { DownloadLink } from '@/components/download-link'
import { buildExportHref, isUuid, parseListParams, pickString } from '@/lib/list-params'
import {
  JOURNAL_TAG_NAME_LIMIT,
  type JournalDefinition,
  type JournalStatus,
} from '../journals/_types'
import { canCreateJournal } from '../journals/_mutation-policy'
import {
  countObservations,
  listObservationFacets,
  listObservations,
  observationTagColors,
  openActionCountsForPage,
} from './_data'
import { ObservationRecordsTable } from './_records-table'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const tGenerated = await getGeneratedTranslations()
  return { title: tGenerated('m_02068af67c6a94') }
}

const SORTS = ['date', 'author', 'site', 'status', 'reference'] as const

const STATUS_OPTIONS = [
  { value: 'submitted', label: 'Submitted' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
]

/**
 * The positive/negative choice. These are the two `journal_definition` values an
 * observation carries, so the filter and the classification are the same column —
 * there is no second "observation type" that could disagree with the record.
 */
const TYPE_OPTIONS = [
  { value: 'positive_observation', label: 'Positive observation' },
  { value: 'negative_observation', label: 'Negative observation' },
]

function validDateParam(value: string | undefined): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined
}

export default async function ObservationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const tGenerated = await getGeneratedTranslations()
  const ctx = await requireRequestContext()
  // Visible to any member: the list IS the caller's own observations plus whatever
  // their `journals.read.site` / `journals.read.all` tier already allows, and
  // `journalScopeWhere()` narrows it server-side. A self-tier worker simply sees
  // their own row here — the same posture as /journals.
  const canCreate = canCreateJournal(ctx)
  const canExport = can(ctx, 'admin.data.export') && can(ctx, 'journals.read.self')

  const sp = await searchParams
  const params = parseListParams(sp, {
    sort: 'date',
    dir: 'desc',
    perPage: 25,
    allowedSorts: SORTS,
  })

  const statusParam = pickString(sp.status)
  const definitionParam = pickString(sp.definition)
  const siteParam = pickString(sp.site)
  const personParam = pickString(sp.person)
  const tagParam = pickString(sp.tag)
  const filters = {
    q: params.q,
    status: STATUS_OPTIONS.some((o) => o.value === statusParam)
      ? (statusParam as JournalStatus)
      : undefined,
    definition: TYPE_OPTIONS.some((o) => o.value === definitionParam)
      ? (definitionParam as JournalDefinition)
      : undefined,
    site: siteParam && isUuid(siteParam) ? siteParam : undefined,
    person: personParam && isUuid(personParam) ? personParam : undefined,
    tag:
      tagParam &&
      tagParam.length <= JOURNAL_TAG_NAME_LIMIT &&
      !/[\u0000-\u001f\u007f]/.test(tagParam)
        ? tagParam
        : undefined,
    from: validDateParam(pickString(sp.from)),
    to: validDateParam(pickString(sp.to)),
  }

  const [items, total, facets] = await Promise.all([
    listObservations(ctx, filters, {
      limit: params.perPage,
      offset: (params.page - 1) * params.perPage,
      sort: params.sort,
      dir: params.dir,
    }),
    countObservations(ctx, filters),
    listObservationFacets(ctx),
  ])

  const [tagColors, openActionCounts] = await Promise.all([
    observationTagColors(
      ctx,
      items.flatMap((i) => i.tags),
    ),
    openActionCountsForPage(
      ctx,
      items.map((i) => i.id),
    ),
  ])

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={tGenerated('m_02068af67c6a94')}
            description={tGenerated('m_1813e297d51f80')}
            actions={
              <>
                {canExport ? (
                  <DownloadLink href={buildExportHref('/observations/export.csv', sp)}>
                    <Button variant="outline">{tGenerated('m_0d47355249b0e6')}</Button>
                  </DownloadLink>
                ) : null}
                {canCreate ? (
                  <Link
                    href="/observations/new"
                    className="inline-flex items-center rounded-md bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 dark:bg-teal-500 dark:hover:bg-teal-600"
                  >
                    {tGenerated('m_1d4341033ef81d')}
                  </Link>
                ) : null}
              </>
            }
          />
          <TableToolbar>
            <SearchInput placeholder={tGenerated('m_127bef15075bf0')} />
            <FilterChips
              basePath="/observations"
              currentParams={sp}
              paramKey="status"
              label={tGenerated('m_0b9da892d6faf0')}
              allLabel={tGenerated('m_08a3d19309f061')}
              options={STATUS_OPTIONS.map((o) => ({
                ...o,
                count: facets.statusCounts[o.value],
              }))}
            />
            <FilterChips
              basePath="/observations"
              currentParams={sp}
              paramKey="definition"
              label={tGenerated('m_032e2c53fdcc08')}
              allLabel={tGenerated('m_1507bc415d9c23')}
              options={TYPE_OPTIONS}
            />
            {/* Hidden inputs preserve the active filters across the date-range
                submit, so narrowing by date never drops the type or status. */}
            <form method="get" className="flex items-center gap-1 text-xs">
              <input type="hidden" name="q" value={filters.q ?? ''} />
              <input type="hidden" name="status" value={filters.status ?? ''} />
              <input type="hidden" name="definition" value={filters.definition ?? ''} />
              <input type="hidden" name="site" value={filters.site ?? ''} />
              <input type="hidden" name="person" value={filters.person ?? ''} />
              <input type="hidden" name="tag" value={filters.tag ?? ''} />
              <input
                type="date"
                name="from"
                defaultValue={filters.from ?? ''}
                aria-label={tGenerated('m_154c9d7a784dda')}
              />
              <input
                type="date"
                name="to"
                defaultValue={filters.to ?? ''}
                aria-label={tGenerated('m_0ea10a854847b2')}
              />
              <Button type="submit" variant="outline" size="sm">
                {tGenerated('m_0285c38761c540')}
              </Button>
            </form>
          </TableToolbar>
        </>
      }
    >
      {items.length === 0 ? (
        <EmptyState
          title={
            params.q || filters.definition || filters.status || filters.tag || filters.site
              ? tGenerated('m_0c2acc19659000')
              : tGenerated('m_1a58346e855add')
          }
          description={canCreate ? tGenerated('m_1813e297d51f80') : tGenerated('m_02ece773081af5')}
          action={
            canCreate ? (
              <Link
                href="/observations/new"
                className="inline-flex items-center rounded-md bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 dark:bg-teal-500 dark:hover:bg-teal-600"
              >
                {tGenerated('m_1d4341033ef81d')}
              </Link>
            ) : null
          }
        />
      ) : (
        <>
          <ObservationRecordsTable
            rows={items}
            tagColors={tagColors}
            openActionCounts={openActionCounts}
            basePath="/observations"
            currentParams={sp}
            sort={params.sort}
            dir={params.dir}
          />
          <Pagination
            page={params.page}
            perPage={params.perPage}
            total={total}
            basePath="/observations"
            currentParams={sp}
          />
        </>
      )}
    </ListPageLayout>
  )
}
