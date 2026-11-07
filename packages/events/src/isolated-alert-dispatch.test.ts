import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { getIsolatedAlertReceiver, resetIsolatedAlertReceiver } from './isolated-alert-receiver'
import { dispatchIsolatedAlert } from './isolated-alert-dispatch'

describe('isolated alert application dispatch', () => {
  const alertId = 'aa-dispatch-alert-001'
  const recipient = 'operator@example.test'

  beforeEach(() => {
    resetIsolatedAlertReceiver()
  })

  afterEach(() => {
    resetIsolatedAlertReceiver()
  })

  it('delivers an application event and records an ACK', async () => {
    const result = await dispatchIsolatedAlert({
      alertId,
      recipients: [recipient],
      channel: 'email',
      payload: { type: 'storage.freeze', state: 'UNIT_TEST' },
    })

    const receiver = getIsolatedAlertReceiver()
    expect(result.deliveryIds).toHaveLength(1)
    expect(result.deliveredCount).toBe(1)
    expect(receiver.wasDelivered(alertId, recipient)).toBe(true)

    const ack = await receiver.acknowledge(alertId, recipient, 'admin@example.test')
    const acknowledgedBy = ack['acknowledgedBy']
    expect(receiver.wasAcknowledged(alertId, recipient)).toBe(true)
    expect(acknowledgedBy).toBe('admin@example.test')
  })

  it('supports multiple recipients through the application entrypoint', async () => {
    const recipients = ['operator1@example.test', 'operator2@example.test']
    const result = await dispatchIsolatedAlert({
      alertId,
      recipients,
      channel: 'push',
      payload: { type: 'storage.freeze', recipients },
    })

    const receiver = getIsolatedAlertReceiver()
    expect(result.deliveredCount).toBe(2)
    expect(result.deliveryIds).toHaveLength(2)
    expect(receiver.wasDelivered(alertId, recipients[0]!)).toBe(true)
    expect(receiver.wasDelivered(alertId, recipients[1]!)).toBe(true)
  })

  it('is idempotent for a repeated application event', async () => {
    const event = {
      alertId,
      recipients: [recipient],
      channel: 'email' as const,
      payload: { type: 'storage.freeze' },
    }

    const first = await dispatchIsolatedAlert(event)
    const second = await dispatchIsolatedAlert(event)

    const receiver = getIsolatedAlertReceiver()
    expect(first.deliveredCount).toBe(1)
    expect(second.deliveredCount).toBe(0)
    expect(second.duplicateCount).toBe(1)
    expect(receiver.getDeliveryCount(alertId)).toBe(1)
  })

  it('recovers from a transient delivery failure with bounded retry', async () => {
    const receiver = getIsolatedAlertReceiver()
    receiver.setDeliveryFailures(1)

    const result = await dispatchIsolatedAlert(
      {
        alertId,
        recipients: [recipient],
        channel: 'webhook',
        payload: { type: 'storage.freeze' },
      },
      { maxAttempts: 3 },
    )

    expect(result.deliveredCount).toBe(1)
    expect(result.attempts).toBe(2)
    expect(receiver.getDeliveryFailuresRemaining()).toBe(0)
    expect(receiver.wasDelivered(alertId, recipient)).toBe(true)
  })

  it('propagates a failure when retry budget is exhausted', async () => {
    const receiver = getIsolatedAlertReceiver()
    receiver.setDeliveryFailures(3)

    await expect(
      dispatchIsolatedAlert(
        {
          alertId,
          recipients: [recipient],
          channel: 'email',
          payload: { type: 'storage.freeze' },
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toThrow(/failed/)

    const receiverAfter = getIsolatedAlertReceiver()
    expect(receiverAfter.getDeliveryCount(alertId)).toBe(0)
  })

  it('cleanup leaves no receiver evidence', async () => {
    await dispatchIsolatedAlert({
      alertId,
      recipients: [recipient],
      channel: 'email',
      payload: { type: 'storage.freeze' },
    })

    const receiver = getIsolatedAlertReceiver()
    receiver.clear()
    expect(receiver.getDeliveryCount(alertId)).toBe(0)
    expect(receiver.getAckCount(alertId)).toBe(0)
  })
})
