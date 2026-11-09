import type { ReportSchedule } from '@beaconhs/reports'

type Translate = (source: string) => string

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEK_POSITIONS = ['First', 'Second', 'Third', 'Fourth', 'Last']

/**
 * Localized cadence description for schedule registers, run history and run
 * detail. The AppKit helper returns English copy; this mirrors its semantics.
 */
export function describeScheduleLocalized(
  schedule: Pick<
    ReportSchedule,
    'cadence' | 'repeatEvery' | 'dayOfWeek' | 'dayOfMonth' | 'weekOfMonth' | 'hour' | 'minute'
  >,
  t: Translate,
): string {
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
  const interval = Math.max(1, schedule.repeatEvery)
  const unit =
    schedule.cadence === 'daily' ? 'days' : schedule.cadence === 'weekly' ? 'weeks' : 'months'
  const every =
    interval === 1
      ? t(
          schedule.cadence === 'daily'
            ? 'Daily'
            : schedule.cadence === 'weekly'
              ? 'Weekly'
              : 'Monthly',
        )
      : `${t('Every')} ${interval} ${t(unit)}`
  if (schedule.cadence === 'weekly') {
    const weekday = WEEKDAYS[schedule.dayOfWeek ?? 1] ?? WEEKDAYS[1]!
    return `${every} · ${t(weekday)} · ${time}`
  }
  if (schedule.cadence === 'monthly') {
    if (schedule.weekOfMonth) {
      const position = WEEK_POSITIONS[(schedule.weekOfMonth ?? 1) - 1] ?? WEEK_POSITIONS[0]!
      const weekday = WEEKDAYS[schedule.dayOfWeek ?? 1] ?? WEEKDAYS[1]!
      return `${every} · ${t(position)} ${t(weekday)} · ${time}`
    }
    return `${every} · ${t('Day of month')} ${schedule.dayOfMonth ?? 1} · ${time}`
  }
  return `${every} · ${time}`
}
