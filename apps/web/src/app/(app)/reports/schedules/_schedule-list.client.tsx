'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Pause, Play, Plus, Zap } from 'lucide-react'
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@beaconhs/ui'
import type { ReportSchedule } from '@beaconhs/reports'
import type { ReportScheduleDefinitionOption } from '@beaconhs/reports/react'
import { FilterChips } from '@/components/filter-bar'
import { ListCard, MobileCardList } from '@/components/list-card'
import { Pagination } from '@/components/pagination'
import { SearchInput } from '@/components/search-input'
import { GeneratedValue, useGeneratedValueTranslations } from '@/i18n/generated'
import { describeScheduleLocalized } from './_describe'
import { runScheduleNow, setScheduleActive } from './actions'

function formatWhen(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function recipientCount(schedule: ReportSchedule): number {
  return schedule.recipientUserIds.length + schedule.recipientEmails.length
}

export function BeaconScheduleList({
  schedules,
  definitions,
  query,
  status,
  total,
  page,
  canManage,
}: {
  schedules: ReportSchedule[]
  definitions: ReportScheduleDefinitionOption[]
  query: string
  status: 'all' | 'active' | 'paused'
  total: number
  page: number
  canManage: boolean
}) {
  const t = useGeneratedValueTranslations()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const currentParams = {
    q: query || undefined,
    status: status === 'all' ? undefined : status,
  }
  const definitionName = (definitionId: string) =>
    definitions.find((definition) => definition.id === definitionId)?.name ?? definitionId

  function runNow(schedule: ReportSchedule) {
    setBusyId(schedule.id)
    startTransition(async () => {
      await runScheduleNow(schedule.id)
      setBusyId(null)
      router.refresh()
    })
  }

  function toggleActive(schedule: ReportSchedule) {
    setBusyId(schedule.id)
    startTransition(async () => {
      await setScheduleActive(schedule.id, !schedule.active)
      setBusyId(null)
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={t('Search schedules')} />
        <FilterChips
          basePath="/reports/schedules"
          currentParams={currentParams}
          paramKey="status"
          label={t('Status')}
          allLabel={t('All schedules')}
          options={[
            { value: 'active', label: t('Active') },
            { value: 'paused', label: t('Paused') },
          ]}
        />
        {canManage ? (
          <Button asChild className="ml-auto">
            <Link href="/reports/schedules/new">
              <Plus size={14} />
              {t('New schedule')}
            </Link>
          </Button>
        ) : null}
      </div>

      {schedules.length === 0 ? (
        <div className="grid min-h-48 place-items-center rounded-lg border border-dashed border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-900">
          <div>
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('No schedules found')}
            </p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {t('Create recurring delivery for any saved report.')}
            </p>
          </div>
        </div>
      ) : (
        <>
          <MobileCardList breakpoint="md">
            <GeneratedValue
              value={schedules.map((schedule) => (
                <ListCard
                  key={schedule.id}
                  href={`/reports/schedules/${schedule.id}`}
                  title={schedule.name}
                  status={
                    <Badge variant={schedule.active ? 'success' : 'secondary'}>
                      {t(schedule.active ? 'Active' : 'Paused')}
                    </Badge>
                  }
                  meta={`${definitionName(schedule.definitionId)} · ${describeScheduleLocalized(schedule, t)}`}
                  footer={`${t('Next run')}: ${formatWhen(schedule.nextRunAt)}`}
                />
              ))}
            />
          </MobileCardList>

          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white md:block dark:border-slate-800 dark:bg-slate-900">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Schedule')}</TableHead>
                  <TableHead>{t('Report')}</TableHead>
                  <TableHead>{t('Cadence')}</TableHead>
                  <TableHead>{t('Recipients')}</TableHead>
                  <TableHead>{t('Next run')}</TableHead>
                  <TableHead>{t('Last run')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((schedule) => (
                  <TableRow key={schedule.id}>
                    <TableCell>
                      <Link
                        href={`/reports/schedules/${schedule.id}`}
                        className="font-medium text-slate-900 hover:underline dark:text-slate-100"
                      >
                        {schedule.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-400">
                      {definitionName(schedule.definitionId)}
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-400">
                      {describeScheduleLocalized(schedule, t)}
                    </TableCell>
                    <TableCell className="text-slate-600 tabular-nums dark:text-slate-400">
                      {recipientCount(schedule)}
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-400">
                      {formatWhen(schedule.nextRunAt)}
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-400">
                      {formatWhen(schedule.lastRunAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={schedule.active ? 'success' : 'secondary'}>
                        {t(schedule.active ? 'Active' : 'Paused')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {canManage ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={pending && busyId === schedule.id}
                            aria-label={t('Run now')}
                            title={t('Run now')}
                            onClick={() => runNow(schedule)}
                          >
                            <Zap size={14} />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={pending && busyId === schedule.id}
                            aria-label={t(schedule.active ? 'Pause' : 'Resume')}
                            title={t(schedule.active ? 'Pause' : 'Resume')}
                            onClick={() => toggleActive(schedule)}
                          >
                            {schedule.active ? <Pause size={14} /> : <Play size={14} />}
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <Pagination
            basePath="/reports/schedules"
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
