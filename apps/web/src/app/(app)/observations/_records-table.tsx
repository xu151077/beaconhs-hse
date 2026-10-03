'use client'

import { GeneratedText, GeneratedValue, useGeneratedValueTranslations } from '@/i18n/generated'

// Client table for the Safety Observations list. Presentational only — the rows
// were queried and visibility-filtered server-side by `listObservations`, which
// routes through `journalScopeWhere()`. Nothing here re-checks authorization; the
// server is the boundary.

import Link from 'next/link'
import { AlertTriangle, ThumbsUp } from 'lucide-react'
import { Badge, cn } from '@beaconhs/ui'
import { SortTh } from '@/components/sortable-th'
import { ListCard, MobileCardList } from '@/components/list-card'
import { tagSwatch } from '../journals/_tag-colors'
import { statusMeta } from '../journals/_format'
import type { ObservationRow } from './_types'

/** A governed tag chip, byte-identical in intent to the journals TagChip: the
 *  swatch is a pair of Tailwind classes (`chip` / `dot`), not a colour value. */
function TagChip({ tag, color }: { tag: string; color: string | null }) {
  const sw = tagSwatch(color)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset',
        sw.chip,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', sw.dot)} />
      {tag}
    </span>
  )
}

export function ObservationRecordsTable({
  rows,
  tagColors,
  openActionCounts,
  basePath,
  currentParams,
  sort,
  dir,
}: {
  rows: ObservationRow[]
  /** name → governed colour (plain object so it crosses the RSC boundary). */
  tagColors: Record<string, string | null>
  /** observation id → count of still-open corrective actions it raised. */
  openActionCounts: Record<string, number>
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  sort: string
  dir: 'asc' | 'desc'
}) {
  const tGeneratedValue = useGeneratedValueTranslations()
  const sortProps = { basePath, currentParams, sort, dir }

  return (
    <>
      {/* Phones: tappable cards. */}
      <MobileCardList>
        <GeneratedValue
          value={rows.map((r) => (
            <ListCard
              key={r.id}
              href={`/observations/${r.id}`}
              reference={r.reference}
              status={
                <Badge className={statusMeta(r.status).className} variant="secondary">
                  {statusMeta(r.status).label}
                </Badge>
              }
              leading={
                r.definition === 'positive_observation' ? (
                  <ThumbsUp size={15} className="text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <AlertTriangle size={15} className="text-amber-600 dark:text-amber-400" />
                )
              }
              title={tGeneratedValue(r.title ?? r.snippet)}
              meta={
                <span>
                  <GeneratedValue value={r.siteName ?? ''} />
                  <GeneratedValue value={r.authorName ? ` · ${r.authorName}` : ''} />
                </span>
              }
              footer={
                <span className="flex flex-wrap items-center gap-1">
                  <Badge variant={r.definition === 'positive_observation' ? 'success' : 'warning'}>
                    {r.definition === 'positive_observation' ? (
                      <GeneratedText id="m_11ff05b3ce5e8c" />
                    ) : (
                      <GeneratedText id="m_003f57e352b85d" />
                    )}
                  </Badge>
                  {r.tags.map((tag: string) => (
                    <TagChip key={tag} tag={tag} color={tagColors[tag] ?? null} />
                  ))}
                </span>
              }
            />
          ))}
        />
      </MobileCardList>

      {/* Tablet/desktop: sortable table. */}
      <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white sm:block dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/60 text-left text-xs tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-400">
              <SortTh column="reference" {...sortProps}>
                <GeneratedText id="m_036b564bb88dfe" />
              </SortTh>
              <SortTh column="title" {...sortProps}>
                <GeneratedText id="m_0decefd558c355" />
              </SortTh>
              <th className="px-3 py-2">
                <GeneratedText id="m_074ba2f160c506" />
              </th>
              <SortTh column="date" {...sortProps}>
                <GeneratedText id="m_0285c38761c540" />
              </SortTh>
              <SortTh column="author" {...sortProps}>
                <GeneratedText id="m_09e0cae12d3f44" />
              </SortTh>
              <SortTh column="site" {...sortProps}>
                <GeneratedText id="m_020146dd3d3d5a" />
              </SortTh>
              <SortTh column="status" {...sortProps}>
                <GeneratedText id="m_0b9da892d6faf0" />
              </SortTh>
              <th className="px-3 py-2">
                <GeneratedText id="m_1b1501ff5de95f" />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            <GeneratedValue
              value={rows.map((r) => {
                const openActions = openActionCounts[r.id] ?? 0
                return (
                  <tr key={r.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/60">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link href={`/observations/${r.id}` as never} className="hover:underline">
                        <GeneratedValue value={r.reference} />
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/observations/${r.id}` as never}
                        className="font-medium text-slate-900 hover:underline dark:text-slate-100"
                      >
                        <GeneratedValue value={r.title ?? r.snippet} />
                      </Link>
                      <GeneratedValue
                        value={
                          r.tags.length > 0 ? (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {r.tags.map((tag: string) => (
                                <TagChip key={tag} tag={tag} color={tagColors[tag] ?? null} />
                              ))}
                            </span>
                          ) : null
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        variant={r.definition === 'positive_observation' ? 'success' : 'warning'}
                      >
                        {r.definition === 'positive_observation' ? (
                          <GeneratedText id="m_11ff05b3ce5e8c" />
                        ) : (
                          <GeneratedText id="m_003f57e352b85d" />
                        )}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                      <GeneratedValue value={r.entryDate} />
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                      <GeneratedValue value={r.authorName ?? ''} />
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                      <GeneratedValue value={r.siteName ?? ''} />
                    </td>
                    <td className="px-3 py-2">
                      <Badge className={statusMeta(r.status).className} variant="secondary">
                        {statusMeta(r.status).label}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      {openActions > 0 ? (
                        <Badge variant="warning">
                          <GeneratedText
                            id="m_08a3cb282bc45c"
                            values={{ value0: String(openActions) }}
                          />
                        </Badge>
                      ) : (
                        <GeneratedValue value="—" />
                      )}
                    </td>
                  </tr>
                )
              })}
            />
          </tbody>
        </table>
      </div>
    </>
  )
}
