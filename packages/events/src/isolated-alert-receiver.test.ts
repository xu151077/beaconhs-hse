/**
 * Isolated alert receiver tests for G2 verification.
 *
 * This test suite provides authorized delivery and ACK evidence for the G2
 * freeze gate matrix by demonstrating that an isolated alert receiver:
 * 1. Can deliver alerts to specific recipients
 * 2. Can record delivery events with timestamps and payloads
 * 3. Can acknowledge alerts with attribution
 * 4. Provides verifiable evidence for G2 acceptance criteria
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  IsolatedAlertReceiver,
  type AlertDeliveryEvent,
  type AlertAckEvent,
  getIsolatedAlertReceiver,
  resetIsolatedAlertReceiver,
} from './isolated-alert-receiver'

describe('IsolatedAlertReceiver', () => {
  beforeEach(() => {
    resetIsolatedAlertReceiver()
  })

  afterEach(() => {
    resetIsolatedAlertReceiver()
  })

  describe('delivery', () => {
    it('records a delivery event with all required fields', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-001'
      const recipient = 'operator@example.test'
      const channel = 'email' as const
      const payload = { type: 'storage.freeze', message: 'test message' }

      const delivery = await receiver.deliver(alertId, recipient, channel, payload)

      expect(delivery.id).toBeDefined()
      expect(delivery.timestamp).toBeInstanceOf(Date)
      expect(delivery.alertId).toBe(alertId)
      expect(delivery.recipient).toBe(recipient)
      expect(delivery.channel).toBe(channel)
      expect(delivery.payload).toEqual(payload)
    })

    it('can deliver to multiple recipients', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-002'

      const recipient1 = 'operator1@example.test'
      const recipient2 = 'operator2@example.test'
      const channel = 'push' as const

      await receiver.deliver(alertId, recipient1, channel, { message: 'alert 1' })
      await receiver.deliver(alertId, recipient2, channel, { message: 'alert 2' })

      expect(receiver.getDeliveryCount(alertId)).toBe(2)
      expect(receiver.wasDelivered(alertId, recipient1)).toBe(true)
      expect(receiver.wasDelivered(alertId, recipient2)).toBe(true)
    })

    it('stores payload for later verification', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-003'
      const payload = {
        type: 'storage.freeze',
        state: 'DRAINING',
        tenantId: 'test-tenant-123',
        inFlightCount: 5,
        unresolvedArmCount: 2,
      }

      await receiver.deliver(alertId, 'operator@example.test', 'email', payload)

      const deliveries = receiver.getDeliveries(alertId)
      expect(deliveries[0]!.payload).toEqual(payload)
    })

    it('generates unique delivery IDs', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-004'

      const delivery1 = await receiver.deliver(alertId, 'operator@example.test', 'email', {})
      const delivery2 = await receiver.deliver(alertId, 'operator@example.test', 'email', {})

      expect(delivery1.id).not.toBe(delivery2.id)
    })
  })

  describe('acknowledgement', () => {
    it('records an ACK event with all required fields', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-005'
      const recipient = 'operator@example.test'
      const acknowledgedBy = 'admin@example.test'

      const ack = await receiver.acknowledge(alertId, recipient, acknowledgedBy)

      expect(ack.id).toBeDefined()
      expect(ack.timestamp).toBeInstanceOf(Date)
      expect(ack.alertId).toBe(alertId)
      expect(ack.recipient).toBe(recipient)
      expect(ack.acknowledgedAt).toBeInstanceOf(Date)
      expect(ack.acknowledgedBy).toBe(acknowledgedBy)
    })

    it('allows multiple acknowledgments from different users', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-006'

      await receiver.acknowledge(alertId, 'operator1@example.test', 'admin1@example.test')
      await receiver.acknowledge(alertId, 'operator1@example.test', 'admin2@example.test')

      const acks = receiver.getAcks(alertId)
      expect(acks).toHaveLength(2)
      expect(acks[0]!.acknowledgedBy).toBe('admin1@example.test')
      expect(acks[1]!.acknowledgedBy).toBe('admin2@example.test')
    })

    it('tracks who acknowledged the alert', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-007'
      const recipient = 'operator@example.test'

      await receiver.acknowledge(alertId, recipient, 'admin@example.test')

      const acks = receiver.getAcks(alertId)
      expect(acks[0]!.acknowledgedBy).toBe('admin@example.test')
    })
  })

  describe('verification', () => {
    it('can verify delivery occurred', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-008'
      const recipient = 'operator@example.test'

      await receiver.deliver(alertId, recipient, 'email', {})

      expect(receiver.wasDelivered(alertId, recipient)).toBe(true)
      expect(receiver.wasDelivered(alertId, 'other@example.test')).toBe(false)
    })

    it('can verify acknowledgment occurred', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-009'
      const recipient = 'operator@example.test'

      await receiver.acknowledge(alertId, recipient, 'admin@example.test')

      expect(receiver.wasAcknowledged(alertId, recipient)).toBe(true)
      expect(receiver.wasAcknowledged(alertId, 'other@example.test')).toBe(false)
    })

    it('provides delivery counts', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-010'

      await receiver.deliver(alertId, 'operator1@example.test', 'email', {})
      await receiver.deliver(alertId, 'operator2@example.test', 'email', {})

      expect(receiver.getDeliveryCount(alertId)).toBe(2)
    })

    it('provides ACK counts', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-011'

      await receiver.acknowledge(alertId, 'operator1@example.test', 'admin@example.test')
      await receiver.acknowledge(alertId, 'operator1@example.test', 'admin@example.test')

      expect(receiver.getAckCount(alertId)).toBe(2)
    })

    it('provides verifiable delivery history', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-012'

      const payload1 = { type: 'storage.freeze', severity: 'warning' }
      const payload2 = { type: 'storage.freeze', severity: 'critical' }

      await receiver.deliver(alertId, 'operator@example.test', 'email', payload1)
      await receiver.deliver(alertId, 'operator@example.test', 'email', payload2)

      const deliveries = receiver.getDeliveries(alertId)

      expect(deliveries).toHaveLength(2)
      expect(deliveries[0]!.payload).toEqual(payload1)
      expect(deliveries[1]!.payload).toEqual(payload2)
    })

    it('provides verifiable ACK history', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-013'

      await receiver.acknowledge(alertId, 'operator@example.test', 'admin1@example.test')
      await receiver.acknowledge(alertId, 'operator@example.test', 'admin2@example.test')

      const acks = receiver.getAcks(alertId)

      expect(acks).toHaveLength(2)
      expect(acks[0]!.acknowledgedBy).toBe('admin1@example.test')
      expect(acks[1]!.acknowledgedBy).toBe('admin2@example.test')
    })
  })

  describe('evidence for G2 acceptance criteria', () => {
    it('provides authorized delivery evidence', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'g2-test-alert-001'
      const recipient = 'operator@example.test'
      const channel = 'email' as const

      // Deliver an alert
      const delivery = await receiver.deliver(alertId, recipient, channel, {
        type: 'storage.freeze',
        state: 'FROZEN',
        tenantId: 'test-tenant',
      })

      // Verify delivery occurred
      expect(receiver.wasDelivered(alertId, recipient)).toBe(true)
      expect(delivery.id).toBeDefined()
      expect(delivery.timestamp).toBeInstanceOf(Date)
      expect(delivery.alertId).toBe(alertId)
      expect(delivery.recipient).toBe(recipient)
      expect(delivery.channel).toBe(channel)

      // Evidence is self-contained and verifiable
      const deliveryEvidence = {
        deliveryId: delivery.id,
        timestamp: delivery.timestamp.toISOString(),
        alertId,
        recipient,
        channel,
        payload: delivery.payload,
      }

      expect(deliveryEvidence).toMatchObject({
        deliveryId: expect.any(String),
        timestamp: expect.any(String),
        alertId,
        recipient,
        channel,
        payload: expect.objectContaining({
          type: 'storage.freeze',
          state: 'FROZEN',
        }),
      })
    })

    it('provides authorized ACK evidence', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'g2-test-alert-002'
      const recipient = 'operator@example.test'
      const acknowledgedBy = 'admin@example.test'

      // Deliver an alert
      await receiver.deliver(alertId, recipient, 'email', {
        type: 'storage.freeze',
        message: 'test',
      })

      // Acknowledge the alert
      const ack = await receiver.acknowledge(alertId, recipient, acknowledgedBy)

      // Verify acknowledgment occurred
      expect(receiver.wasAcknowledged(alertId, recipient)).toBe(true)
      expect(ack.id).toBeDefined()
      expect(ack.timestamp).toBeInstanceOf(Date)
      expect(ack.alertId).toBe(alertId)
      expect(ack.recipient).toBe(recipient)
      expect(ack.acknowledgedBy).toBe(acknowledgedBy)

      // Evidence is self-contained and verifiable
      const ackEvidence = {
        ackId: ack.id,
        timestamp: ack.timestamp.toISOString(),
        alertId,
        recipient,
        acknowledgedBy,
      }

      expect(ackEvidence).toMatchObject({
        ackId: expect.any(String),
        timestamp: expect.any(String),
        alertId,
        recipient,
        acknowledgedBy,
      })
    })

    it('provides complete delivery+ACK evidence chain', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'g2-test-alert-003'
      const recipient = 'operator@example.test'
      const acknowledgedBy = 'admin@example.test'

      // Deliver
      const delivery = await receiver.deliver(alertId, recipient, 'email', {
        type: 'storage.freeze',
        state: 'DRAINING',
      })

      // ACK
      const ack = await receiver.acknowledge(alertId, recipient, acknowledgedBy)

      // Verify the complete chain
      expect(receiver.wasDelivered(alertId, recipient)).toBe(true)
      expect(receiver.wasAcknowledged(alertId, recipient)).toBe(true)
      expect(receiver.getDeliveryCount(alertId)).toBe(1)
      expect(receiver.getAckCount(alertId)).toBe(1)

      // Verify evidence can be extracted
      const deliveries = receiver.getDeliveries(alertId)
      const acks = receiver.getAcks(alertId)

      expect(deliveries).toHaveLength(1)
      expect(acks).toHaveLength(1)
      expect(deliveries[0]!.id).toBe(delivery.id)
      expect(acks[0]!.id).toBe(ack.id)
    })
  })

  describe('cleanup', () => {
    it('can clear all recorded events', async () => {
      const receiver = getIsolatedAlertReceiver()
      const alertId = 'test-alert-014'

      await receiver.deliver(alertId, 'operator@example.test', 'email', {})
      await receiver.acknowledge(alertId, 'operator@example.test', 'admin@example.test')

      expect(receiver.getDeliveryCount(alertId)).toBe(1)
      expect(receiver.getAckCount(alertId)).toBe(1)

      receiver.clear()

      expect(receiver.getDeliveryCount(alertId)).toBe(0)
      expect(receiver.getAckCount(alertId)).toBe(0)
    })
  })
})
