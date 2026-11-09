'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'
import { Button, Input, Label, SearchSelect, Textarea } from '@beaconhs/ui'
import {
  PERIOD_PRESETS,
  REPORT_SCHEDULE_LIMITS,
  isTechnicalIdentifierColumn,
  operatorsForKind,
  type ParsedReportScheduleForm,
  type ReportEntity,
  type ReportRule,
  type ReportSchedule,
  type ReportRuleGroup,
} from '@beaconhs/reports'
import type {
  ReportScheduleDefinitionOption,
  ReportScheduleMemberOption,
} from '@beaconhs/reports/react'
import { useGeneratedValueTranslations } from '@/i18n/generated'
import { saveSchedule } from './actions'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const TIMEZONES = [
  'UTC',
  'America/Toronto',
  'America/Vancouver',
  'America/Edmonton',
  'America/Winnipeg',
  'America/Halifax',
  'America/St_Johns',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
]

const EMPTY_GROUP: ReportRuleGroup = { combinator: 'and', rules: [] }

function scheduleFilterGroup(value: unknown): ReportRuleGroup {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ((value as { combinator?: unknown }).combinator === 'and' ||
      (value as { combinator?: unknown }).combinator === 'or') &&
    Array.isArray((value as { rules?: unknown }).rules)
  ) {
    return value as ReportRuleGroup
  }
  return EMPTY_GROUP
}

function isRule(value: ReportRule | ReportRuleGroup): value is ReportRule {
  return 'field' in value
}

export function BeaconScheduleForm({
  scheduleId,
  definitions,
  members,
  initial,
  defaultTimezone,
}: {
  scheduleId: string | null
  definitions: ReportScheduleDefinitionOption[]
  members: ReportScheduleMemberOption[]
  initial?: Partial<ReportSchedule>
  defaultTimezone?: string
}) {
  const t = useGeneratedValueTranslations()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [definitionId, setDefinitionId] = useState(
    initial?.definitionId ?? definitions[0]?.id ?? '',
  )
  const definition = definitions.find((item) => item.id === definitionId)
  const [name, setName] = useState(initial?.name ?? '')
  const [cadence, setCadence] = useState<'daily' | 'weekly' | 'monthly'>(
    initial?.cadence ?? 'weekly',
  )
  const [monthlyMode, setMonthlyMode] = useState<'day' | 'weekday'>(
    initial?.weekOfMonth ? 'weekday' : 'day',
  )
  const [repeatEvery, setRepeatEvery] = useState(String(initial?.repeatEvery ?? 1))
  const [dayOfWeek, setDayOfWeek] = useState(String(initial?.dayOfWeek ?? 1))
  const [dayOfMonth, setDayOfMonth] = useState(String(initial?.dayOfMonth ?? 1))
  const [weekOfMonth, setWeekOfMonth] = useState(String(initial?.weekOfMonth ?? 1))
  const [hour, setHour] = useState(String(initial?.hour ?? 7))
  const [minute, setMinute] = useState(String(initial?.minute ?? 0))
  const [timezone, setTimezone] = useState(initial?.timezone ?? defaultTimezone ?? 'UTC')
  const [startsOn, setStartsOn] = useState(
    typeof initial?.startsOn === 'string' ? initial.startsOn : '',
  )
  const [endsOn, setEndsOn] = useState(typeof initial?.endsOn === 'string' ? initial.endsOn : '')
  const [selectedUsers, setSelectedUsers] = useState(() => new Set(initial?.recipientUserIds ?? []))
  const [emails, setEmails] = useState((initial?.recipientEmails ?? []).join(', '))
  const [subject, setSubject] = useState(initial?.emailSubject ?? '')
  const [message, setMessage] = useState(initial?.emailMessage ?? '')
  const [filters, setFilters] = useState<ReportRuleGroup>(() =>
    scheduleFilterGroup(initial?.filters),
  )

  const selectedMembers = members.filter((member) => selectedUsers.has(member.userId))
  const addableMembers = members.filter((member) => !selectedUsers.has(member.userId))

  function toggleUser(userId: string) {
    setSelectedUsers((current) => {
      const next = new Set(current)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    const parsedRepeat = Number(repeatEvery)
    if (!definitionId) return setError(t('Choose a report.'))
    if (!name.trim()) return setError(t('Enter a schedule name.'))
    if (name.trim().length > REPORT_SCHEDULE_LIMITS.nameChars)
      return setError(t('Name is too long.'))
    if (!Number.isInteger(parsedRepeat) || parsedRepeat < 1 || parsedRepeat > 999) {
      return setError(t('Repeat interval must be a whole number between 1 and 999.'))
    }
    const parsedHour = Number(hour)
    const parsedMinute = Number(minute)
    if (!Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 23) {
      return setError(t('Hour must be between 0 and 23.'))
    }
    if (!Number.isInteger(parsedMinute) || parsedMinute < 0 || parsedMinute > 59) {
      return setError(t('Minute must be between 0 and 59.'))
    }
    const parsedDayOfMonth = Number(dayOfMonth)
    if (
      cadence === 'monthly' &&
      monthlyMode === 'day' &&
      (!Number.isInteger(parsedDayOfMonth) || parsedDayOfMonth < 1 || parsedDayOfMonth > 31)
    ) {
      return setError(t('Day of month must be between 1 and 31.'))
    }
    if (startsOn && endsOn && startsOn > endsOn) {
      return setError(t('Start date must be on or before end date.'))
    }
    const trimmedTimezone = timezone.trim()
    try {
      if (!trimmedTimezone) throw new Error('timezone')
      new Intl.DateTimeFormat(undefined, { timeZone: trimmedTimezone }).format()
    } catch {
      return setError(t('Unknown timezone. Use an IANA timezone name.'))
    }
    const recipientEmails = emails
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean)
    if (recipientEmails.some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
      return setError(t('One or more email addresses are invalid.'))
    }

    const value: ParsedReportScheduleForm = {
      definitionId,
      name: name.trim(),
      cadence,
      repeatEvery: parsedRepeat,
      dayOfWeek:
        cadence === 'weekly' || (cadence === 'monthly' && monthlyMode === 'weekday')
          ? Number(dayOfWeek)
          : null,
      dayOfMonth: cadence === 'monthly' && monthlyMode === 'day' ? parsedDayOfMonth : null,
      weekOfMonth:
        cadence === 'monthly' && monthlyMode === 'weekday'
          ? (Number(weekOfMonth) as 1 | 2 | 3 | 4 | 5)
          : null,
      hour: parsedHour,
      minute: parsedMinute,
      timezone: trimmedTimezone,
      startsOn: startsOn || null,
      endsOn: endsOn || null,
      recipientUserIds: [...selectedUsers],
      recipientEmails,
      filters: filters.rules.length ? filters : {},
      emailSubject: subject.trim() || null,
      emailMessage: message.trim() || null,
    }

    startTransition(async () => {
      const result = await saveSchedule(scheduleId, value)
      if (!result.ok) setError(t(result.error))
      else router.push(`/reports/schedules/${result.id}`)
    })
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {/* Report + name */}
      <Field label={t('Report')} required>
        <SearchSelect
          value={definitionId}
          onChange={(next) => {
            setDefinitionId(next)
            setFilters(EMPTY_GROUP)
          }}
          options={definitions.map((item) => ({
            value: item.id,
            label: item.name,
            group: item.category ?? undefined,
          }))}
          ariaLabel={t('Report')}
          placeholder={t('Choose a value')}
        />
        {definition?.description ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">{definition.description}</p>
        ) : null}
      </Field>

      <Field label={t('Schedule name')} required>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={REPORT_SCHEDULE_LIMITS.nameChars}
          placeholder={
            definition
              ? `${definition.name} — ${t(
                  cadence === 'daily' ? 'Daily' : cadence === 'weekly' ? 'Weekly' : 'Monthly',
                )}`
              : t('Schedule name')
          }
        />
      </Field>

      {/* Cadence */}
      <fieldset className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          {t('Cadence')}
        </legend>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label={t('Frequency')}>
            <SearchSelect
              value={cadence}
              onChange={(next) => setCadence(next as 'daily' | 'weekly' | 'monthly')}
              options={[
                { value: 'daily', label: t('Daily') },
                { value: 'weekly', label: t('Weekly') },
                { value: 'monthly', label: t('Monthly') },
              ]}
              ariaLabel={t('Frequency')}
            />
          </Field>
          <Field label={t('Repeat every')}>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={999}
                required
                value={repeatEvery}
                onChange={(event) => setRepeatEvery(event.target.value)}
                className="w-20"
                aria-label={t('Repeat every')}
              />
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t(cadence === 'daily' ? 'days' : cadence === 'weekly' ? 'weeks' : 'months')}
              </span>
            </div>
          </Field>
          {cadence === 'weekly' ? (
            <Field label={t('Day of week')}>
              <SearchSelect
                value={dayOfWeek}
                onChange={setDayOfWeek}
                options={WEEKDAYS.map((day, index) => ({
                  value: String(index),
                  label: t(day),
                }))}
                ariaLabel={t('Day of week')}
              />
            </Field>
          ) : null}
          {cadence === 'monthly' ? (
            <Field label={t('Monthly pattern')}>
              <SearchSelect
                value={monthlyMode}
                onChange={(next) => setMonthlyMode(next as 'day' | 'weekday')}
                options={[
                  { value: 'day', label: t('Day of month') },
                  { value: 'weekday', label: t('Weekday of month') },
                ]}
                ariaLabel={t('Monthly pattern')}
              />
            </Field>
          ) : null}
          {cadence === 'monthly' && monthlyMode === 'day' ? (
            <Field label={t('Day of month')}>
              <Input
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(event) => setDayOfMonth(event.target.value)}
                aria-label={t('Day of month')}
              />
            </Field>
          ) : null}
          {cadence === 'monthly' && monthlyMode === 'weekday' ? (
            <>
              <Field label={t('Week')}>
                <SearchSelect
                  value={weekOfMonth}
                  onChange={setWeekOfMonth}
                  options={[
                    { value: '1', label: t('First') },
                    { value: '2', label: t('Second') },
                    { value: '3', label: t('Third') },
                    { value: '4', label: t('Fourth') },
                    { value: '5', label: t('Last') },
                  ]}
                  ariaLabel={t('Week')}
                />
              </Field>
              <Field label={t('Weekday')}>
                <SearchSelect
                  value={dayOfWeek}
                  onChange={setDayOfWeek}
                  options={WEEKDAYS.map((day, index) => ({
                    value: String(index),
                    label: t(day),
                  }))}
                  ariaLabel={t('Weekday')}
                />
              </Field>
            </>
          ) : null}
          <Field label={t('Time')}>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                max={23}
                required
                value={hour}
                onChange={(event) => setHour(event.target.value)}
                className="w-20"
                aria-label={t('Hour')}
              />
              <span className="text-slate-400">:</span>
              <Input
                type="number"
                min={0}
                max={59}
                required
                value={minute}
                onChange={(event) => setMinute(event.target.value)}
                className="w-20"
                aria-label={t('Minute')}
              />
            </div>
          </Field>
          <Field label={t('Timezone')}>
            <Input
              required
              maxLength={REPORT_SCHEDULE_LIMITS.timezoneChars}
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              list="schedule-timezones"
            />
            <datalist id="schedule-timezones">
              {TIMEZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </Field>
          <Field label={t('Starts on')}>
            <Input
              type="date"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
            />
          </Field>
          <Field label={t('Ends on')}>
            <Input type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
          </Field>
        </div>
      </fieldset>

      {/* Recipients */}
      <fieldset className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          {t('Recipients')}
        </legend>
        <div className="space-y-2">
          <Label>{t('Members')}</Label>
          {selectedMembers.length ? (
            <div className="flex flex-wrap gap-1.5">
              {selectedMembers.map((member) => (
                <span
                  key={member.userId}
                  className="inline-flex items-center gap-1 rounded-full border border-teal-300 bg-teal-50 py-0.5 pr-1 pl-2.5 text-xs text-teal-800 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300"
                >
                  <span>{member.name}</span>
                  <button
                    type="button"
                    onClick={() => toggleUser(member.userId)}
                    aria-label={`${t('Remove recipient')}: ${member.name}`}
                    className="rounded-full p-0.5 hover:bg-teal-100 dark:hover:bg-teal-900"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <SearchSelect
            value=""
            onChange={(userId) => userId && toggleUser(userId)}
            options={addableMembers.map((member) => ({
              value: member.userId,
              label: member.name,
              hint: member.email,
            }))}
            placeholder={t('Add a member')}
            searchPlaceholder={t('Search members')}
            sheetTitle={t('Add recipient')}
            ariaLabel={t('Add a member')}
            className="max-w-sm"
          />
        </div>
        <div className="mt-3 space-y-1.5">
          <Label>{t('Additional email addresses')}</Label>
          <Textarea
            rows={2}
            maxLength={REPORT_SCHEDULE_LIMITS.recipientEmailListChars}
            value={emails}
            onChange={(event) => setEmails(event.target.value)}
            placeholder={t('finance@example.com, operations@example.com')}
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('Separate email addresses with commas or new lines.')}
          </p>
        </div>
      </fieldset>

      {/* Email copy */}
      <fieldset className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          {t('Email')}
        </legend>
        <div className="space-y-3">
          <Field label={t('Subject')}>
            <Input
              maxLength={REPORT_SCHEDULE_LIMITS.emailSubjectChars}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder={t('Optional custom subject')}
            />
          </Field>
          <Field label={t('Message')}>
            <Textarea
              rows={4}
              maxLength={REPORT_SCHEDULE_LIMITS.emailMessageChars}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t('Optional message above the report attachment')}
            />
          </Field>
        </div>
      </fieldset>

      {/* Runtime filters */}
      <fieldset className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          {t('Report filters')}
        </legend>
        {definition?.entity ? (
          <FilterGroupEditor
            entity={definition.entity}
            group={filters}
            onChange={setFilters}
            depth={0}
          />
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t('This report does not expose schedule-time filters.')}
          </p>
        )}
      </fieldset>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.push('/reports/schedules')}>
          {t('Cancel')}
        </Button>
        <Button type="submit" disabled={pending}>
          {scheduleId ? t('Save schedule') : t('Create schedule')}
        </Button>
      </div>
    </form>
  )
}

function Field({
  label,
  required = false,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required ? <span className="text-red-600"> *</span> : null}
      </Label>
      {children}
    </div>
  )
}

function FilterGroupEditor({
  entity,
  group,
  onChange,
  depth,
}: {
  entity: ReportEntity
  group: ReportRuleGroup
  onChange: (group: ReportRuleGroup) => void
  depth: number
}) {
  const t = useGeneratedValueTranslations()
  const columns = entity.columns.filter((column) => !isTechnicalIdentifierColumn(column))

  function replaceRule(index: number, next: ReportRule | ReportRuleGroup) {
    onChange({ ...group, rules: group.rules.map((rule, i) => (i === index ? next : rule)) })
  }

  function removeRule(index: number) {
    onChange({ ...group, rules: group.rules.filter((_, i) => i !== index) })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-40">
          <SearchSelect
            value={group.combinator}
            onChange={(next) => onChange({ ...group, combinator: next === 'or' ? 'or' : 'and' })}
            options={[
              { value: 'and', label: t('All conditions') },
              { value: 'or', label: t('Any condition') },
            ]}
            ariaLabel={t('All conditions')}
          />
        </div>
        {depth < 2 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({ ...group, rules: [...group.rules, { combinator: 'and', rules: [] }] })
            }
          >
            <Plus size={14} /> {t('Add group')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange({
              ...group,
              rules: [
                ...group.rules,
                {
                  field: columns[0]?.key ?? '',
                  op: columns[0]
                    ? (operatorsForKind(columns[0].kind)[0]?.key ?? 'is_null')
                    : 'is_null',
                  value: null,
                },
              ],
            })
          }
        >
          <Plus size={14} /> {t('Add condition')}
        </Button>
      </div>

      {group.rules.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('No conditions.')}</p>
      ) : (
        <div className="space-y-2">
          {group.rules.map((rule, index) => (
            <div
              key={index}
              className="rounded-md border border-slate-200 p-2 dark:border-slate-800"
            >
              {isRule(rule) ? (
                <RuleEditor
                  entity={entity}
                  rule={rule}
                  onChange={(next) => replaceRule(index, next)}
                  onRemove={() => removeRule(index)}
                />
              ) : (
                <div className="space-y-2">
                  <FilterGroupEditor
                    entity={entity}
                    group={rule}
                    onChange={(next) => replaceRule(index, next)}
                    depth={depth + 1}
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeRule(index)}>
                    <X size={14} /> {t('Remove')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RuleEditor({
  entity,
  rule,
  onChange,
  onRemove,
}: {
  entity: ReportEntity
  rule: ReportRule
  onChange: (rule: ReportRule) => void
  onRemove: () => void
}) {
  const t = useGeneratedValueTranslations()
  const columns = entity.columns.filter((column) => !isTechnicalIdentifierColumn(column))
  const column = columns.find((item) => item.key === rule.field) ?? columns[0]
  const operators = column ? operatorsForKind(column.kind) : []
  const operator = operators.find((item) => item.key === rule.op) ?? operators[0]

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-40 flex-1">
        <Label className="text-xs">{t('Field')}</Label>
        <SearchSelect
          value={column?.key ?? ''}
          onChange={(next) => {
            const nextColumn = columns.find((item) => item.key === next)
            const nextOperators = nextColumn ? operatorsForKind(nextColumn.kind) : []
            onChange({
              field: next,
              op: nextOperators[0]?.key ?? 'is_null',
              value: null,
            })
          }}
          options={columns.map((item) => ({ value: item.key, label: item.label }))}
          ariaLabel={t('Field')}
        />
      </div>
      <div className="min-w-32 flex-1">
        <Label className="text-xs">{t('Operator')}</Label>
        <SearchSelect
          value={operator?.key ?? 'is_null'}
          onChange={(next) => onChange({ ...rule, op: next as ReportRule['op'], value: null })}
          options={operators.map((item) => ({ value: item.key, label: t(item.label) }))}
          ariaLabel={t('Operator')}
        />
      </div>
      {operator && operator.needsValue !== 'none' ? (
        <div className="min-w-40 flex-1">
          <Label className="text-xs">{t('Value')}</Label>
          <RuleValueEditor column={column} operator={operator} rule={rule} onChange={onChange} />
        </div>
      ) : null}
      <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label={t('Remove')}>
        <X size={14} />
      </Button>
    </div>
  )
}

function RuleValueEditor({
  column,
  operator,
  rule,
  onChange,
}: {
  column: ReportEntity['columns'][number] | undefined
  operator: { key: string; needsValue: 'none' | 'one' | 'list' }
  rule: ReportRule
  onChange: (rule: ReportRule) => void
}) {
  const t = useGeneratedValueTranslations()
  if (!column) return null
  const stringValue = typeof rule.value === 'string' ? rule.value : ''
  const options =
    column.filterOptions?.map((option) => ({ value: option.value, label: option.label })) ??
    column.options?.map((option) => ({ value: option, label: option })) ??
    []

  if (operator.key === 'period_preset') {
    return (
      <SearchSelect
        value={stringValue}
        onChange={(next) => onChange({ ...rule, value: next })}
        options={PERIOD_PRESETS.filter((preset) => preset.id !== 'custom').map((preset) => ({
          value: preset.id,
          label: t(preset.label),
        }))}
        ariaLabel={t('Value')}
        placeholder={t('Choose a value')}
      />
    )
  }

  if (operator.needsValue === 'list' && options.length) {
    const selected = new Set(
      Array.isArray(rule.value) ? rule.value.map((value) => String(value)) : [],
    )
    return (
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const active = selected.has(option.value)
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                const next = new Set(selected)
                if (next.has(option.value)) next.delete(option.value)
                else next.add(option.value)
                onChange({ ...rule, value: [...next] })
              }}
              className={
                active
                  ? 'rounded-full bg-teal-600 px-2.5 py-1 text-xs text-white'
                  : 'rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300'
              }
            >
              {option.label}
            </button>
          )
        })}
      </div>
    )
  }

  if (operator.needsValue === 'list') {
    const text = Array.isArray(rule.value) ? rule.value.join(', ') : stringValue
    return (
      <Input
        value={text}
        onChange={(event) =>
          onChange({
            ...rule,
            value: event.target.value
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean),
          })
        }
        placeholder={t('Comma-separated values')}
        aria-label={t('Value')}
      />
    )
  }

  if (options.length) {
    return (
      <SearchSelect
        value={stringValue}
        onChange={(next) => onChange({ ...rule, value: next })}
        options={options}
        ariaLabel={t('Value')}
        placeholder={t('Choose a value')}
      />
    )
  }

  if (column.kind === 'date' || column.kind === 'timestamp') {
    if (operator.key === 'between_days_ago' || operator.key === 'due_within_days') {
      return (
        <Input
          type="number"
          min={0}
          value={stringValue}
          onChange={(event) => onChange({ ...rule, value: event.target.value })}
          aria-label={t('Value')}
        />
      )
    }
    return (
      <Input
        type="date"
        value={stringValue}
        onChange={(event) => onChange({ ...rule, value: event.target.value })}
        aria-label={t('Value')}
      />
    )
  }

  if (column.kind === 'number' || column.kind === 'money') {
    return (
      <Input
        type="number"
        value={stringValue}
        onChange={(event) => onChange({ ...rule, value: event.target.value })}
        aria-label={t('Value')}
      />
    )
  }

  return (
    <Input
      value={stringValue}
      onChange={(event) => onChange({ ...rule, value: event.target.value })}
      placeholder={t('Type a value')}
      aria-label={t('Value')}
    />
  )
}
