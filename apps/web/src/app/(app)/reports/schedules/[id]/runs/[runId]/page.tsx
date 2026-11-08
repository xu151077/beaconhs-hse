import { notFound } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { Download } from 'lucide-react'
import { attachments, reportDefinitions, reportRuns, reportSchedules } from '@beaconhs/db/schema'
import { translateSystemCopy } from '@beaconhs/i18n/messages'
import { assertCan } from '@beaconhs/tenant'
import { Badge, Button, DetailHeader } from '@beaconhs/ui'
import { DownloadLink } from '@/components/download-link'
import { PageContainer } from '@/components/page-layout'
import { GeneratedText, GeneratedValue } from '@/i18n/generated'
import { getGeneratedTranslations } from '@/i18n/generated.server'
import { requireRequestContext } from '@/lib/auth'
import { isUuid } from '@/lib/list-params'
import { describeScheduleLocalized } from '../../../_describe'
import { toSchedule } from '../../../page'

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  succeeded: 'success',
  running: 'warning',
  failed: 'destructive',
}

function formatWhen(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function runDuration(
  startedAt: string | Date,
  finishedAt: string | Date | null | undefined,
): string {
  if (!finishedAt) return '—'
  const start = new Date(startedAt).getTime()
  const end = new Date(finishedAt).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—'
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {label}
      </dt>
      <dd className="mt-0.5 text-slate-900 dark:text-slate-100">{children}</dd>
    </div>
  )
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>
}) {
  const { id, runId } = await params
  if (!isUuid(id) || !isUuid(runId)) notFound()
  const tGenerated = await getGeneratedTranslations()
  const ctx = await requireRequestContext()
  assertCan(ctx, 'reports.read')
  const t = (source: string) => translateSystemCopy(ctx.locale, source)

  const row = await ctx.db(async (tx) => {
    const [result] = await tx
      .select({
        run: reportRuns,
        schedule: reportSchedules,
        definitionName: reportDefinitions.name,
        attachment: attachments,
      })
      .from(reportRuns)
      .innerJoin(
        reportSchedules,
        and(
          eq(reportSchedules.tenantId, reportRuns.tenantId),
          eq(reportSchedules.id, reportRuns.scheduleId),
        ),
      )
      .innerJoin(
        reportDefinitions,
        and(
          eq(reportDefinitions.tenantId, reportSchedules.tenantId),
          eq(reportDefinitions.id, reportSchedules.definitionId),
        ),
      )
      .leftJoin(
        attachments,
        and(
          eq(attachments.tenantId, reportRuns.tenantId),
          eq(attachments.id, reportRuns.pdfAttachmentId),
        ),
      )
      .where(
        and(
          eq(reportRuns.tenantId, ctx.tenantId!),
          eq(reportRuns.scheduleId, id),
          eq(reportRuns.id, runId),
        ),
      )
      .limit(1)
    return result ?? null
  })
  if (!row) notFound()
  const pdfHref = row.attachment ? `/reports/schedules/${id}/runs/${runId}/pdf` : undefined

  return (
    <PageContainer className="space-y-4">
      <DetailHeader
        back={{ href: `/reports/schedules/${id}`, label: t('Back to schedule') }}
        title={row.schedule.name}
        subtitle={tGenerated('m_175bec260f32b5', { value0: row.run.id })}
        actions={
          pdfHref ? (
            <Button asChild>
              <DownloadLink href={pdfHref}>
                <Download size={14} />
                <GeneratedText id="m_1eeaf573dabd83" />
              </DownloadLink>
            </Button>
          ) : null
        }
      />

      {row.run.status === 'failed' && row.run.error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/40"
        >
          <h3 className="text-sm font-semibold text-red-800 dark:text-red-300">
            {t('Report run failed')}
          </h3>
          <pre className="mt-2 text-xs whitespace-pre-wrap text-red-800 dark:text-red-300">
            {row.run.error}
          </pre>
        </div>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('Run details')}
          </h3>
          <Badge variant={STATUS_VARIANT[row.run.status] ?? 'secondary'}>
            <GeneratedValue value={row.run.status} />
          </Badge>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Detail label={t('Started')}>{formatWhen(row.run.startedAt)}</Detail>
          <Detail label={t('Finished')}>{formatWhen(row.run.finishedAt)}</Detail>
          <Detail label={t('Duration')}>
            {runDuration(row.run.startedAt, row.run.finishedAt)}
          </Detail>
          <Detail label={t('Rows')}>{row.run.rowCount ?? '—'}</Detail>
          <Detail label={t('Schedule')}>{row.schedule.name}</Detail>
          <Detail label={t('Report')}>{row.definitionName}</Detail>
          <Detail label={t('Cadence')}>
            {describeScheduleLocalized(toSchedule(row.schedule), t)}
          </Detail>
          <Detail label={t('Trigger')}>
            <GeneratedValue value={row.run.trigger} />
          </Detail>
        </dl>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('Generated document')}
          </h3>
          {pdfHref ? (
            <Button asChild size="sm">
              <DownloadLink href={pdfHref}>
                <Download size={14} />
                <GeneratedText id="m_1eeaf573dabd83" />
              </DownloadLink>
            </Button>
          ) : null}
        </div>
        {row.attachment ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Detail label={t('Filename')}>
              <span className="font-mono text-xs">{row.attachment.filename}</span>
            </Detail>
            <Detail label={t('Size')}>
              {Math.round(row.attachment.sizeBytes / 1024)} {t('KB')}
            </Detail>
            <Detail label={t('Content type')}>{row.attachment.contentType}</Detail>
            <Detail label={t('Created')}>{formatWhen(row.attachment.createdAt)}</Detail>
          </dl>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t(
              row.run.status === 'failed'
                ? 'No document was generated because the run failed.'
                : row.run.status === 'succeeded'
                  ? 'The run completed without a stored artifact.'
                  : 'The document will be available after the run completes.',
            )}
          </p>
        )}
      </section>
    </PageContainer>
  )
}
