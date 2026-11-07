import { describe, expect, it } from 'vitest'
import { domainEventRetryAt, MAX_DOMAIN_EVENT_ATTEMPTS } from './domain-event-outbox-policy'

describe('domain event outbox retry policy', () => {
  const now = new Date('2026-07-12T12:00:00.000Z')

  it('starts at fifteen seconds and doubles by attempt', () => {
    expect(domainEventRetryAt(1, now).toISOString()).toBe('2026-07-12T12:00:15.000Z')
    expect(domainEventRetryAt(2, now).toISOString()).toBe('2026-07-12T12:00:30.000Z')
    expect(domainEventRetryAt(3, now).toISOString()).toBe('2026-07-12T12:01:00.000Z')
  })

  it('caps retries at one hour while still bounded by MAX_DOMAIN_EVENT_ATTEMPTS', () => {
    expect(domainEventRetryAt(100, now).toISOString()).toBe('2026-07-12T13:00:00.000Z')
    // A poison event must not be retried forever: after this many attempts the
    // drain marks it `dead` instead of releasing it back to `pending`.
    expect(MAX_DOMAIN_EVENT_ATTEMPTS).toBe(10)
    expect(
      domainEventRetryAt(MAX_DOMAIN_EVENT_ATTEMPTS - 1, now).getTime() - now.getTime(),
    ).toBeLessThanOrEqual(60 * 60_000)
  })

  it('handles malformed attempt counters conservatively', () => {
    expect(domainEventRetryAt(-10, now).toISOString()).toBe('2026-07-12T12:00:15.000Z')
    expect(domainEventRetryAt(Number.NaN, now).toISOString()).toBe('2026-07-12T12:00:15.000Z')
  })
})
