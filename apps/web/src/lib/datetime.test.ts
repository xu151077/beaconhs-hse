import { describe, expect, it } from 'vitest'
import {
  addDaysToIsoDate,
  addYearsToIsoDate,
  dateIsoInTimeZone,
  datetimeLocalValue,
  isCalendarDate,
  parseDatetimeLocal,
  todayIsoLocal,
} from './datetime'

describe('timezone-aware datetime helpers', () => {
  it('accepts only real calendar dates', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true)
    expect(isCalendarDate('2024-02-29')).toBe(true)
    expect(isCalendarDate('2026-02-30')).toBe(false)
    expect(isCalendarDate('2025-02-29')).toBe(false)
    expect(isCalendarDate('2026-13-01')).toBe(false)
    expect(isCalendarDate('not-a-date')).toBe(false)
    expect(isCalendarDate('2026-02-28T00:00:00Z')).toBe(false)
  })
  it('formats the calendar date in the requested timezone', () => {
    const instant = new Date('2026-07-14T02:30:00.000Z')
    expect(dateIsoInTimeZone(instant, 'America/Toronto')).toBe('2026-07-13')
    expect(dateIsoInTimeZone(instant, 'UTC')).toBe('2026-07-14')
  })

  it('adds calendar days without timezone or DST drift', () => {
    // Month, year and leap-day boundaries.
    expect(addDaysToIsoDate('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDaysToIsoDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysToIsoDate('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDaysToIsoDate('2026-02-28', 1)).toBe('2026-03-01')
    // A DST transition must not shift a date-only column.
    expect(addDaysToIsoDate('2026-03-08', 1)).toBe('2026-03-09')
    expect(addDaysToIsoDate('2026-11-01', 1)).toBe('2026-11-02')
    // Severity offsets used by the CA due-date rules.
    expect(addDaysToIsoDate('2026-07-13', 1)).toBe('2026-07-14')
    expect(addDaysToIsoDate('2026-07-13', 3)).toBe('2026-07-16')
    expect(addDaysToIsoDate('2026-07-13', 7)).toBe('2026-07-20')
    expect(() => addDaysToIsoDate('2026-7-3', 1)).toThrow(/YYYY-MM-DD/)
  })

  it('adds calendar years without a local-Date round trip', () => {
    // The recert rule: an inspected-on date plus one year, as a date.
    expect(addYearsToIsoDate('2026-07-13', 1)).toBe('2027-07-13')
    expect(addYearsToIsoDate('2026-12-31', 1)).toBe('2027-12-31')
    // Feb 29 rolls to Mar 1, matching the previous UTC-based behaviour.
    expect(addYearsToIsoDate('2024-02-29', 1)).toBe('2025-03-01')
    expect(addYearsToIsoDate('2026-01-01', 2)).toBe('2028-01-01')
    expect(() => addYearsToIsoDate('13/07/2026', 1)).toThrow(/YYYY-MM-DD/)
  })

  it('formats the local calendar day for client components', () => {
    const instant = new Date(2026, 6, 13, 23, 30) // local wall clock, any TZ
    expect(todayIsoLocal(instant)).toBe('2026-07-13')
    expect(todayIsoLocal(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })

  it('round-trips datetime-local values in the viewer timezone', () => {
    const instant = new Date('2026-01-15T19:30:00.000Z')
    expect(datetimeLocalValue(instant, 'America/Toronto')).toBe('2026-01-15T14:30')
    expect(parseDatetimeLocal('2026-01-15T14:30', 'America/Toronto')?.toISOString()).toBe(
      instant.toISOString(),
    )
  })

  it('preserves seconds and milliseconds when a caller supplies them', () => {
    expect(parseDatetimeLocal('2026-07-13T23:59:58.125', 'America/Toronto')?.toISOString()).toBe(
      '2026-07-14T03:59:58.125Z',
    )
  })

  it('accepts explicit offsets without applying the viewer timezone again', () => {
    expect(
      parseDatetimeLocal('2026-01-15T14:30:00-05:00', 'America/Vancouver')?.toISOString(),
    ).toBe('2026-01-15T19:30:00.000Z')
  })

  it('rejects normalized calendar dates and nonexistent DST wall-clock times', () => {
    expect(parseDatetimeLocal('2026-02-30T09:00', 'America/Toronto')).toBeNull()
    expect(parseDatetimeLocal('2026-13-01T09:00', 'America/Toronto')).toBeNull()
    expect(parseDatetimeLocal('2026-03-08T02:30', 'America/Toronto')).toBeNull()
  })
})
