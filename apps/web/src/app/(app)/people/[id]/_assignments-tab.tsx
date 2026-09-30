// The "Location assignments" tab on a person's page.
//
// Renders a person's `people_assignments` as two lists: the ones effective today
// and the historical ones. The current/expired split uses the SAME window rule
// as the server actions and the compliance readers (`isAssignmentEffectiveOn` in
// `@/lib/assignment-validity`), so the UI can never disagree with what the
// compliance audience resolver will match.
//
// Management controls are shown only to a caller with `admin.org.manage`; the
// actions re-check it, so hiding them is presentation, not the control.

import Link from 'next/link'
import { Building2, CalendarClock, Pencil } from 'lucide-react'
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@beaconhs/ui'
import { getGeneratedValueTranslations } from '@/i18n/generated.server'
import { isAssignmentEffectiveOn, type IsoDate } from '@/lib/assignment-validity'
import type { AssignmentRow } from './_assignments-drawers'

function formatDate(value: IsoDate): string {
  // `YYYY-MM-DD` parsed as UTC so the rendered day never shifts by timezone.
  const d = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export async function AssignmentTab({
  assignments,
  today,
  canManage,
  addHref,
  editHref,
}: {
  assignments: AssignmentRow[]
  today: IsoDate
  canManage: boolean
  addHref: string
  editHref: (assignmentId: string) => string
}) {
  const t = await getGeneratedValueTranslations()
  const current = assignments.filter((a) => isAssignmentEffectiveOn(a, today))
  const history = assignments.filter((a) => !isAssignmentEffectiveOn(a, today))
  const levelLabel = (level: string) => (level === 'project' ? t('Project') : t('Site'))

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4" aria-hidden />
            {t('Current assignments')}
          </CardTitle>
          {canManage ? (
            <Link href={addHref}>
              <Badge variant="secondary" data-walkthrough="add-assignment">
                {t('Add assignment')}
              </Badge>
            </Link>
          ) : null}
        </CardHeader>
        <CardContent>
          {current.length === 0 ? (
            <EmptyState
              icon={<Building2 className="h-6 w-6" aria-hidden />}
              title={t('No current assignments')}
              description={
                canManage
                  ? t('Add an assignment to record which project or site this person works at.')
                  : t('Nobody has recorded a location assignment for this person yet.')
              }
            />
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {current.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium text-slate-900 dark:text-slate-100">
                      {a.orgUnitName}
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {levelLabel(a.orgUnitLevel)} · {formatDate(a.validFrom)}
                      {a.validTo ? ` – ${formatDate(a.validTo)}` : ` · ${t('· ongoing')}`}
                    </p>
                  </div>
                  {canManage ? (
                    <Link
                      href={editHref(a.id)}
                      className="inline-flex items-center gap-1 text-sm text-teal-700 hover:underline dark:text-teal-400"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                      {t('Edit dates')}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canManage && current.length > 0 ? (
            <p className="mt-4 border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
              {t('To finish an assignment, use')} <strong>{t('End current assignment')}</strong>{' '}
              {t('below the history list. Ending keeps the record — it is never deleted.')}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4" aria-hidden />
            {t('Assignment history')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t('No past assignments.')}
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {history.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium text-slate-700 dark:text-slate-200">
                      {a.orgUnitName}
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {levelLabel(a.orgUnitLevel)} · {formatDate(a.validFrom)}
                      {a.validTo ? ` – ${formatDate(a.validTo)}` : ''}
                    </p>
                  </div>
                  <Badge variant="outline">{t('Ended')}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
