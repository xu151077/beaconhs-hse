import { describe, expect, it } from 'vitest'
import { collectMissedOccurrences } from './report-scheduler'

const DAY = 24 * 60 * 60 * 1000
// A calendar-aware daily cadence, like the real computeNextRunAt: it snaps to
// 08:00 UTC rather than drifting by the +1ms cursor offset.
const daily = (after: Date) => {
  const d = new Date(after)
  d.setUTCDate(d.getUTCDate() + 1)
  d.setUTCHours(8, 0, 0, 0)
  return d
}

describe('collectMissedOccurrences', () => {
  it('catches up every missed daily occurrence, not just the first', () => {
    // Regression: the old scheduler claimed ONE run and then advanced
    // nextRunAt to the first occurrence after `now`, permanently losing the
    // intermediate days after a worker outage.
    const first = new Date('2026-11-07T08:00:00.000Z')
    const now = new Date('2026-11-09T10:00:00.000Z')
    const result = collectMissedOccurrences({ nextRunAt: first, now, nextAfter: daily })
    expect(result.occurrences.map((d) => d.toISOString())).toEqual([
      '2026-11-07T08:00:00.000Z',
      '2026-11-08T08:00:00.000Z',
      '2026-11-09T08:00:00.000Z',
    ])
    // `next` is the first UNPROCESSED occurrence, strictly after `now`.
    expect(result.next?.toISOString()).toBe('2026-11-10T08:00:00.000Z')
    expect(result.ended).toBe(false)
  })

  it('caps a long outage and leaves a past cursor so the next tick resumes', () => {
    const first = new Date('2026-01-01T08:00:00.000Z')
    const now = new Date('2026-12-31T10:00:00.000Z')
    const result = collectMissedOccurrences({ nextRunAt: first, now, nextAfter: daily, max: 3 })
    expect(result.occurrences).toHaveLength(3)
    expect(result.next && result.next.getTime() <= now.getTime()).toBe(true)
    expect(result.ended).toBe(false)
  })

  it('deactivates when the cadence has no further occurrence', () => {
    const first = new Date('2026-11-07T08:00:00.000Z')
    const now = new Date('2026-11-09T10:00:00.000Z')
    const result = collectMissedOccurrences({
      nextRunAt: first,
      now,
      nextAfter: () => null,
    })
    expect(result.occurrences).toHaveLength(1)
    expect(result.next).toBeNull()
    expect(result.ended).toBe(true)
  })

  it('refuses a non-advancing cadence instead of looping forever', () => {
    const first = new Date('2026-11-07T08:00:00.000Z')
    const now = new Date('2026-11-09T10:00:00.000Z')
    const result = collectMissedOccurrences({
      nextRunAt: first,
      now,
      nextAfter: (after) => new Date(after.getTime() - DAY),
    })
    expect(result.occurrences).toHaveLength(1)
    expect(result.ended).toBe(true)
  })

  it('does nothing when the next occurrence is still in the future', () => {
    const next = new Date('2026-11-10T08:00:00.000Z')
    const now = new Date('2026-11-09T10:00:00.000Z')
    const result = collectMissedOccurrences({ nextRunAt: next, now, nextAfter: daily })
    expect(result.occurrences).toEqual([])
    expect(result.next).toBe(next)
  })
})
