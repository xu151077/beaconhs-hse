import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getIsolatedAlertReceiver,
  resetIsolatedAlertReceiver,
} from '@beaconhs/events/testing/isolated-alert-receiver'
import {
  emitIsolatedAlertApplicationEvent,
  isolatedAlertEntrypointEnabled,
} from './isolated-alert-entrypoint'

describe('isolated application alert entrypoint', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('BEACONHS_ISOLATED_ALERTS_ENABLED', 'true')
    resetIsolatedAlertReceiver()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetIsolatedAlertReceiver()
  })

  it('dispatches disposable events through the application entrypoint and records an ACK', async () => {
    const alertId = 'app-entrypoint-delivery'
    const recipient = 'operator@example.test'
    const result = await emitIsolatedAlertApplicationEvent({
      alertId,
      recipients: [recipient],
      channel: 'email',
      payload: { type: 'storage.freeze', state: 'UNIT_TEST' },
      disposable: true,
    })

    const receiver = getIsolatedAlertReceiver()
    expect(result.deliveredCount).toBe(1)
    expect(receiver.wasDelivered(alertId, recipient)).toBe(true)
    await receiver.acknowledge(alertId, recipient, 'app-test@example.test')
    expect(receiver.wasAcknowledged(alertId, recipient)).toBe(true)
  })

  it('recovers transient failures and suppresses a duplicate application event', async () => {
    const alertId = 'app-entrypoint-retry'
    const recipient = 'operator@example.test'
    const receiver = getIsolatedAlertReceiver()
    receiver.setDeliveryFailures(1)

    const first = await emitIsolatedAlertApplicationEvent({
      alertId,
      recipients: [recipient],
      channel: 'email',
      payload: { type: 'storage.freeze' },
      disposable: true,
    })
    expect(first.attempts).toBe(2)
    expect(first.deliveredCount).toBe(1)

    const duplicate = await emitIsolatedAlertApplicationEvent({
      alertId,
      recipients: [recipient],
      channel: 'email',
      payload: { type: 'storage.freeze' },
      disposable: true,
    })
    expect(duplicate.deliveredCount).toBe(0)
    expect(duplicate.duplicateCount).toBe(1)
    expect(receiver.getDeliveryCount(alertId)).toBe(1)
  })

  it('rejects non-disposable events', async () => {
    await expect(
      emitIsolatedAlertApplicationEvent({
        alertId: 'not-disposable',
        recipients: ['operator@example.test'],
        channel: 'email',
        payload: {},
        disposable: false as true,
      }),
    ).rejects.toThrow(/disposable/)
  })

  it('is disabled without an explicit development opt-in', () => {
    delete process.env.BEACONHS_ISOLATED_ALERTS_ENABLED
    expect(isolatedAlertEntrypointEnabled()).toBe(false)
  })

  it('is disabled in production even when the flag is set', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(isolatedAlertEntrypointEnabled()).toBe(false)
    await expect(
      emitIsolatedAlertApplicationEvent({
        alertId: 'production-block',
        recipients: ['operator@example.test'],
        channel: 'email',
        payload: {},
        disposable: true,
      }),
    ).rejects.toThrow(/disabled/)
  })
})
