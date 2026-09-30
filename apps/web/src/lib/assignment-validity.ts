// Effective-dated window semantics for person↔org-unit assignments
// (`people_assignments`).
//
// `valid_from` / `valid_to` are pg `date` columns in Drizzle's STRING mode, so
// every value crossing this boundary is a `YYYY-MM-DD` string and compares
// correctly as a string. This module is the ONLY place that decides what
// "currently effective" means, so the server actions, the UI and the tests
// cannot drift into three different definitions.
//
// An assignment is effective on date D when:
//
//     valid_from <= D  AND  (valid_to IS NULL OR valid_to >= D)
//
// `valid_to` is INCLUSIVE. A person whose assignment ends today is still on the
// assignment today; that matches how `packages/compliance/src/audience.ts:99-104`
// and `packages/compliance/src/identity.ts:104-105` already read the same table.
//
// NOTE on the duplicate SQL: `packages/compliance` inlines this same predicate
// in its own queries. That duplication is a package-boundary consequence — this
// module is app-side and `@beaconhs/compliance` cannot import from `apps/web` —
// not a second design. If the two ever need to converge, this file and
// `audience.ts` are the two places to change. Do NOT add a third copy.

import { and, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'

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

/** A `YYYY-MM-DD` calendar date, matching the pg `date` column type. */
export type IsoDate = string

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

/** Today as a `YYYY-MM-DD` string in UTC, matching how the DB compares dates. */
export function todayIso(now: Date = new Date()): IsoDate {
  return now.toISOString().slice(0, 10)
}

/**
 * The pure form of the window rule, for rendering and for tests. `today`
 * defaults to the current UTC date.
 */
export function isAssignmentEffectiveOn(
  row: { validFrom: string; validTo: string | null },
  today: IsoDate = todayIso(),
): boolean {
  if (row.validFrom > today) return false
  return row.validTo === null || row.validTo >= today
}

/**
 * The SQL form of the same rule, for queries. `sql`current_date`` is used
 * rather than a bound parameter so the predicate is sargable against the
 * existing `(tenant_id, person_id)` and `(tenant_id, org_unit_id)` indexes and
 * evaluates in the database's own timezone — identical to what
 * `@beaconhs/compliance` already does.
 */
export function effectiveOn(
  validFrom: AnyColumn,
  validTo: AnyColumn,
  onDate: SQL = sql`current_date`,
): SQL | undefined {
  return and(lte(validFrom, onDate), or(isNull(validTo), gte(validTo, onDate)))
}
