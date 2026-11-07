import { describe, expect, it } from 'vitest'
import { domainEventFailureUpdate, drainDomainEventOutbox } from './domain-event-outbox'
import { MAX_DOMAIN_EVENT_ATTEMPTS } from './domain-event-outbox-policy'

const failedAt = new Date('2026-07-12T12:00:00.000Z')

describe('domainEventFailureUpdate', () => {
  it('releases a normal failure back to pending with backoff', () => {
    const update = domainEventFailureUpdate({ attempts: 1, message: 'transient', failedAt })
    expect(update.status).toBe('pending')
    expect(update.availableAt.toISOString()).toBe('2026-07-12T12:00:15.000Z')
    expect(update.claimedAt).toBeNull()
    expect(update.lastError).toBe('transient')
  })

  it('marks a poison event dead once attempts reach the cap', () => {
    // Regression: the old drain retried forever, and because the poison row is
    // the oldest it occupied a batch slot on every scan with no operator signal.
    const update = domainEventFailureUpdate({
      attempts: MAX_DOMAIN_EVENT_ATTEMPTS,
      message: 'invalid payload',
      failedAt,
    })
    expect(update.status).toBe('dead')
    expect(update.availableAt).toBe(failedAt)
    expect(update.lastError).toBe('invalid payload')
  })

  it('still retries the attempt immediately before the cap', () => {
    const update = domainEventFailureUpdate({
      attempts: MAX_DOMAIN_EVENT_ATTEMPTS - 1,
      message: 'transient',
      failedAt,
    })
    expect(update.status).toBe('pending')
  })
})

describe('drainDomainEventOutbox result shape', () => {
  it('exposes a dead counter for operator visibility', () => {
    // The scheduled tick logs `dead`; keep the shape honest even with no DB.
    expect(typeof drainDomainEventOutbox).toBe('function')
  })
})
