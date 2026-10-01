// Assignment validity — the effective-date RULE plus the form-input validators.
//
// `people_assignments` carries a `validFrom` / `validTo` window, and "is this
// assignment current?" is asked in two forms: a pure predicate for rendering the
// person's assignment history, and a SQL predicate for queries. Both live here
// so they cannot drift apart.
//
// The SQL form matches how `packages/compliance/src/audience.ts` and
// `identity.ts` already read the same table: `valid_to` is INCLUSIVE, so a person
// whose assignment ends today is still on it today.
//
// The form-input half (`parseIsoDate`, `parseValidityWindow`) validates what an
// administrator typed into a date field. It is only ever called from React server
// components and the people-assignment server actions, and it owns the message
// translator, which has no business in a data package.

import { and, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'

/** A `YYYY-MM-DD` calendar date, matching the pg `date` column type. */
export type IsoDate = string

/** Today as a `YYYY-MM-DD` string in UTC, matching how the DB compares dates. */
export function todayIso(now: Date = new Date()): IsoDate {
  return now.toISOString().slice(0, 10)
}

/**
 * The pure form of the window rule, for rendering and for tests.
 *
 * `validTo` is INCLUSIVE: a person whose assignment ends today is still on the
 * assignment today.
 */
export function isAssignmentEffectiveOn(
  row: { validFrom: string; validTo: string | null },
  today: IsoDate = todayIso(),
): boolean {
  if (row.validFrom > today) return false
  return row.validTo === null || row.validTo >= today
}

/**
 * The SQL form of the same rule, for queries. `sql`current_date`` is used rather
 * than a bound parameter so the predicate stays sargable against the existing
 * `(tenant_id, person_id)` and `(tenant_id, org_unit_id)` indexes and evaluates
 * in the database's own timezone.
 */
export function effectiveOn(
  validFrom: AnyColumn,
  validTo: AnyColumn,
  onDate: SQL = sql`current_date`,
): SQL | undefined {
  return and(lte(validFrom, onDate), or(isNull(validTo), gte(validTo, onDate)))
}

/**
 * Message translator: takes the ENGLISH SOURCE LITERAL and returns the string to
 * show. Callers are React server/client components, so they pass a wrapper over
 * `getGeneratedValueTranslations()` / `useGeneratedValueTranslations()`, which
 * hash the literal to its catalogue key. The default substitutes
 * `{value0}`-style placeholders, so the pure validators stay usable from tests
 * and from non-React callers, and every user-facing string is still emitted
 * through `t(...)` for the i18n coverage gate to find.
 */
export type Translate = (source: string, values?: Record<string, unknown>) => string

const passthrough: Translate = (source, values) =>
  values
    ? source.replace(/\{(\w+)\}/g, (match, key: string) =>
        key in values ? String(values[key]) : match,
      )
    : source

/** Strict `YYYY-MM-DD`. Rejects `2026-2-1`, ISO timestamps, and `2026-02-30`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export type DateParse = { ok: true; date: IsoDate } | { ok: false; error: string }

/**
 * Validate a caller-supplied date. The round-trip check is what rejects
 * `2026-02-30`: `new Date('2026-02-30')` silently becomes 2 March, so comparing
 * the re-formatted value back to the input is the cheapest correct test.
 */
export function parseIsoDate(
  value: string | null | undefined,
  label: string,
  t: Translate = passthrough,
): DateParse {
  const raw = (value ?? '').trim()
  if (!raw) return { ok: false, error: t('{value0} is required.', { value0: label }) }
  if (!ISO_DATE.test(raw)) {
    return { ok: false, error: t('{value0} must be a YYYY-MM-DD date.', { value0: label }) }
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    return { ok: false, error: t('{value0} is not a real date.', { value0: label }) }
  }
  return { ok: true, date: raw }
}

export type WindowParse =
  { ok: true; validFrom: IsoDate; validTo: IsoDate | null } | { ok: false; error: string }

/**
 * Validate a validity window. `validTo` is optional — omitting it means "open
 * ended", which is how a current assignment is expressed. An empty string is
 * treated the same as omission so a cleared date input is not an error.
 */
export function parseValidityWindow(
  validFrom: string | null | undefined,
  validTo: string | null | undefined,
  t: Translate = passthrough,
): WindowParse {
  const from = parseIsoDate(validFrom, t('Start date'), t)
  if (!from.ok) return from
  const toRaw = (validTo ?? '').trim()
  if (!toRaw) return { ok: true, validFrom: from.date, validTo: null }
  const to = parseIsoDate(toRaw, t('End date'), t)
  if (!to.ok) return to
  // String comparison is a real date comparison for zero-padded ISO dates.
  if (to.date < from.date) {
    return { ok: false, error: t('End date cannot be before the start date.') }
  }
  return { ok: true, validFrom: from.date, validTo: to.date }
}
