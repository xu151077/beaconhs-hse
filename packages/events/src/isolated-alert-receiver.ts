/**
 * Isolated alert receiver for G2 verification.
 *
 * This is a test-only receiver that records delivery and ACK events in memory.
 * It is used to provide authorized delivery/ACK evidence for the G2 freeze gate
 * matrix without touching production alert infrastructure.
 *
 * The receiver is intentionally simple and stateful, designed for isolated
 * verification only. It does not support persistence, retries, or multi-tenant
 * isolation.
 */

export type AlertDeliveryEvent = {
  id: string
  timestamp: Date
  alertId: string
  recipient: string
  channel: 'email' | 'push' | 'webhook'
  payload: Record<string, unknown>
}

export type AlertAckEvent = {
  id: string
  timestamp: Date
  alertId: string
  recipient: string
  acknowledgedAt: Date
  acknowledgedBy: string
}

export type IsolatedAlertReceiverConfig = {
  /** Email delivery endpoint (test-only). */
  emailDeliveryUrl?: string
  /** Push delivery endpoint (test-only). */
  pushDeliveryUrl?: string
  /** Webhook delivery endpoint (test-only). */
  webhookDeliveryUrl?: string
  /** Whether to actually send alerts or just record them. */
  dryRun?: boolean
}

/**
 * In-memory storage for delivery and ACK events.
 */
class InMemoryAlertStore {
  deliveries: AlertDeliveryEvent[] = []
  acks: AlertAckEvent[] = []

  addDelivery(event: AlertDeliveryEvent): void {
    this.deliveries.push(event)
  }

  addAck(event: AlertAckEvent): void {
    this.acks.push(event)
  }

  getDeliveries(alertId?: string): AlertDeliveryEvent[] {
    if (alertId) {
      return this.deliveries.filter((d) => d.alertId === alertId)
    }
    return [...this.deliveries]
  }

  getAcks(alertId?: string): AlertAckEvent[] {
    if (alertId) {
      return this.acks.filter((a) => a.alertId === alertId)
    }
    return [...this.acks]
  }

  getDeliveryCount(alertId?: string): number {
    return this.getDeliveries(alertId).length
  }

  getAckCount(alertId?: string): number {
    return this.getAcks(alertId).length
  }

  clear(): void {
    this.deliveries = []
    this.acks = []
  }
}

// Single global instance for test isolation
let instance: IsolatedAlertReceiver | null = null

export function getIsolatedAlertReceiver(): IsolatedAlertReceiver {
  if (!instance) {
    instance = new IsolatedAlertReceiver()
  }
  return instance
}

export function resetIsolatedAlertReceiver(): void {
  instance = null
}

/**
 * Isolated alert receiver for G2 verification.
 *
 * This receiver provides:
 * - Delivery tracking with timestamps and payloads
 * - ACK tracking with who acknowledged the alert
 * - Dry-run mode for testing without actual delivery
 * - In-memory storage that can be verified programmatically
 */
export class IsolatedAlertReceiver {
  private store = new InMemoryAlertStore()
  private deliveryFailuresRemaining = 0
  private config: {
    emailDeliveryUrl: string
    pushDeliveryUrl?: string
    webhookDeliveryUrl?: string
    dryRun: boolean
  }

  constructor(config: IsolatedAlertReceiverConfig = {}) {
    this.config = {
      emailDeliveryUrl: config.emailDeliveryUrl ?? 'http://localhost:8025/mailpit',
      pushDeliveryUrl: config.pushDeliveryUrl ?? undefined,
      webhookDeliveryUrl: config.webhookDeliveryUrl ?? undefined,
      dryRun: config.dryRun ?? true,
    }
  }

  /**
   * Deliver an alert to a recipient.
   *
   * @param alertId Unique identifier for this alert
   * @param recipient Email address, push token, or webhook URL
   * @param channel Delivery channel ('email', 'push', or 'webhook')
   * @param payload Alert payload (will be logged, not sent in dry-run)
   * @returns Delivery event with tracking information
   */
  async deliver(
    alertId: string,
    recipient: string,
    channel: 'email' | 'push' | 'webhook',
    payload: Record<string, unknown>,
  ): Promise<AlertDeliveryEvent> {
    if (this.deliveryFailuresRemaining > 0) {
      this.deliveryFailuresRemaining -= 1
      throw new Error(`isolated alert delivery failed: ${alertId}/${recipient}`)
    }

    const event: AlertDeliveryEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      alertId,
      recipient,
      channel,
      payload,
    }

    this.store.addDelivery(event)

    if (this.config.dryRun) {
      console.log('[IsolatedAlertReceiver] DRY RUN - would deliver:', {
        alertId,
        recipient,
        channel,
        payload,
      })
    } else {
      // In production, this would actually send the alert
      console.log('[IsolatedAlertReceiver] would send alert:', {
        alertId,
        recipient,
        channel,
      })
    }

    return event
  }

  /**
   * Acknowledge an alert.
   *
   * @param alertId Alert ID to acknowledge
   * @param recipient Recipient who acknowledged
   * @param acknowledgedBy User or system that acknowledged
   * @returns ACK event with tracking information
   */
  async acknowledge(
    alertId: string,
    recipient: string,
    acknowledgedBy: string,
  ): Promise<AlertAckEvent> {
    const event: AlertAckEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      alertId,
      recipient,
      acknowledgedAt: new Date(),
      acknowledgedBy,
    }

    this.store.addAck(event)
    return event
  }

  /**
   * Verify that an alert was delivered to a recipient.
   *
   * @param alertId Alert ID
   * @param recipient Expected recipient
   * @returns True if delivered, false otherwise
   */
  wasDelivered(alertId: string, recipient: string): boolean {
    return this.store.getDeliveries(alertId).some((d) => d.recipient === recipient)
  }

  /**
   * Verify that an alert was acknowledged.
   *
   * @param alertId Alert ID
   * @param recipient Expected recipient
   * @returns True if acknowledged, false otherwise
   */
  wasAcknowledged(alertId: string, recipient: string): boolean {
    return this.store.getAcks(alertId).some((a) => a.recipient === recipient)
  }

  /**
   * Get delivery count for an alert.
   *
   * @param alertId Alert ID
   * @returns Number of deliveries
   */
  getDeliveryCount(alertId: string): number {
    return this.store.getDeliveryCount(alertId)
  }

  /**
   * Get ACK count for an alert.
   *
   * @param alertId Alert ID
   * @returns Number of acknowledgments
   */
  getAckCount(alertId: string): number {
    return this.store.getAckCount(alertId)
  }

  /**
   * Get all delivery events for verification.
   *
   * @param alertId Optional filter by alert ID
   * @returns Array of delivery events
   */
  getDeliveries(alertId?: string): AlertDeliveryEvent[] {
    return this.store.getDeliveries(alertId)
  }

  /**
   * Get all ACK events for verification.
   *
   * @param alertId Optional filter by alert ID
   * @returns Array of ACK events
   */
  getAcks(alertId?: string): AlertAckEvent[] {
    return this.store.getAcks(alertId)
  }

  /**
   * Arm delivery failure for the next delivery attempts, for isolated tests.
   *
   * This does not connect to a real channel; it simulates a transient application/
   * receiver failure that dispatch retry behavior must handle.
   */
  setDeliveryFailures(count: number): void {
    if (count < 0) throw new Error('count must be non-negative')
    this.deliveryFailuresRemaining = count
  }

  getDeliveryFailuresRemaining(): number {
    return this.deliveryFailuresRemaining
  }

  /**
   * Clear all recorded events (for test cleanup).
   */
  clear(): void {
    this.store.clear()
  }

  /**
   * Get the receiver configuration.
   */
  getConfig(): {
    emailDeliveryUrl: string
    pushDeliveryUrl?: string
    webhookDeliveryUrl?: string
    dryRun: boolean
  } {
    return { ...this.config }
  }
}
