'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@beaconhs/ui'
import type { ReportScheduleRun } from '@beaconhs/reports/react'
import { FilterChips } from '@/components/filter-bar'
import { ListCard, MobileCardList } from '@/components/list-card'
import { Pagination } from '@/components/pagination'
import { SearchInput } from '@/components/search-input'
import { GeneratedValue, useGeneratedValueTranslations } from '@/i18n/generated'

function formatWhen(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function duration(run: ReportScheduleRun): string {
  if (!run.finishedAt) return '—'
  const start = new Date(run.startedAt).getTime()
  const end = new Date(run.finishedAt).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—'
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  succeeded: 'success',
  running: 'warning',
  failed: 'destructive',
}

export function BeaconReportRunHistory({
  scheduleId,
  runs,
  query,
  status,
  total,
  page,
}: {
  scheduleId: string
  runs: ReportScheduleRun[]
  query: string
  status: 'all' | 'queued' | 'running' | 'succeeded' | 'failed'
  total: number
  page: number
}) {
  const t = useGeneratedValueTranslations()
  const router = useRouter()
  const basePath = `/reports/schedules/${scheduleId}`
  const currentParams = {
    q: query || undefined,
    status: status === 'all' ? undefined : status,
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={t('Search runs')} />
        <FilterChips
          basePath={basePath}
          currentParams={currentParams}
          paramKey="status"
          label={t('Status')}
          allLabel={t('All statuses')}
          options={[
            { value: 'queued', label: t('Queued') },
            { value: 'running', label: t('Running') },
            { value: 'succeeded', label: t('Succeeded') },
            { value: 'failed', label: t('Failed') },
          ]}
        />
      </div>

      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {t('No report runs found.')}
        </div>
      ) : (
        <>
          <MobileCardList breakpoint="md">
            <GeneratedValue
              value={runs.map((run) => (
                <ListCard
                  key={run.id}
                  href={`${basePath}/runs/${run.id}`}
                  title={<GeneratedValue value={run.status} />}
                  status={
                    <Badge variant={STATUS_VARIANT[run.status] ?? 'secondary'}>
                      <GeneratedValue value={run.status} />
                    </Badge>
                  }
                  meta={`${t('Started')}: ${formatWhen(run.startedAt)} · ${t('Rows')}: ${run.rowCount ?? '—'}`}
                  footer={run.error ? <span className="text-red-600">{run.error}</span> : undefined}
                />
              ))}
            />
          </MobileCardList>

          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white md:block dark:border-slate-800 dark:bg-slate-900">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Status')}</TableHead>
                  <TableHead>{t('Trigger')}</TableHead>
                  <TableHead>{t('Rows')}</TableHead>
                  <TableHead>{t('Started')}</TableHead>
                  <TableHead>{t('Finished')}</TableHead>
                  <TableHead>{t('Duration')}</TableHead>
                  <TableHead>{t('Output')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant={STATUS_VARIANT[run.status] ?? 'secondary'}>
                          <GeneratedValue value={run.status} />
                        </Badge>
                        {run.error ? (
                          <span
                            className="max-w-48 truncate text-xs text-red-600"
                            title={run.error}
                          >
                            {run.error}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-400">
                      <GeneratedValue value={run.trigger} />
                    </TableCell>
                    <TableCell className="text-slate-600 tabular-nums dark:text-slate-400">
                      {run.rowCount ?? '—'}
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-400">
                      {formatWhen(run.startedAt)}
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-400">
                      {formatWhen(run.finishedAt)}
                    </TableCell>
                    <TableCell className="text-slate-600 tabular-nums dark:text-slate-400">
                      {duration(run)}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`${basePath}/runs/${run.id}`}
                        className="text-teal-700 hover:underline dark:text-teal-400"
                      >
                        {t('View')}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <Pagination
            basePath={basePath}
            currentParams={currentParams}
            total={total}
            page={page}
            perPage={25}
          />
        </>
      )}
    </div>
  )
}
