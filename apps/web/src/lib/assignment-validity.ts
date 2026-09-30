// Assignment validity — web-side form parsing, plus a re-export of the shared
// effective-date rule.
//
// The RULE (`todayIso`, `isAssignmentEffectiveOn`, `effectiveOn`, `IsoDate`)
// moved to `packages/analytics/src/server/project-scope.ts` in 15B-3B, so the
// web app, the worker and the resolver cannot drift into three definitions of
// "currently effective". It is re-exported below unchanged, so every existing
// `from '@/lib/assignment-validity'` import keeps working.
//
// What stays HERE is the form-input half: `parseIsoDate` and
// `parseValidityWindow` exist to validate what an administrator typed into a
// date field, and they are only ever called from React server components and the
// people-assignment server actions. They are not part of the authorization
// surface and moving them would drag the message translator into a package that
// has no business owning user-facing copy.

import type { IsoDate } from '@beaconhs/analytics/server'

export {
  effectiveOn,
  isAssignmentEffectiveOn,
  todayIso,
  type IsoDate,
} from '@beaconhs/analytics/server'

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
