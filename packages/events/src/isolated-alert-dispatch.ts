/**
 * Application-facing isolated alert dispatcher.
 *
 * This is a deliberately tiny event entrypoint used for G2 evidence. It uses
 * the in-memory isolated receiver only and does not connect to production
 * email, SMS, webhook, or alert routing infrastructure.
 *
 * The dispatcher records which recipients were already delivered so a repeated
 * domain event does not create another delivery record. That is idempotency at
 * the receiver boundary only; it is in-process state and survives neither a
 * process restart nor a new receiver instance.
 */

import { getIsolatedAlertReceiver, type IsolatedAlertReceiver } from './isolated-alert-receiver'

export type IsolatedAlertChannel = 'email' | 'push' | 'webhook'

export type IsolatedAlertDomainEvent = {
  /** Stable application alert/deduplication identity for one alert. */
  alertId: string
  /** Recipients for this alert instance. */
  recipients: readonly string[]
  /** Delivery channel to use. */
  channel: IsolatedAlertChannel
  /** Disposable domain payload recorded by the receiver. */
  payload: Record<string, unknown>
}

export type IsolatedAlertDispatchOptions = {
  /**
   * Maximum attempts for one recipient. Defaults to 3.
   *
   * Differences between attempts are an in-process retry loop used only for
   * isolated verification; there is no durable queue, background worker, or
   * deferred retry system here.
   */
  maxAttempts?: number
}

export type IsolatedAlertDispatchResult = {
  alertId: string
  deliveryIds: string[]
  deliveredCount: number
  duplicateCount: number
  attempts: number
}

/**
 * Resolve the receiver used by the dispatcher.
 *
 * Tests may pass a deliberately reset receiver instance by calling
 * `getIsolatedAlertReceiver()` immediately before this function.
 */
function resolveReceiver(receiver?: IsolatedAlertReceiver): IsolatedAlertReceiver {
  return receiver ?? getIsolatedAlertReceiver()
}

/**
 * Dispatch an isolated alert to recipients and return observable delivery IDs.
 */
export async function dispatchIsolatedAlert(
  event: IsolatedAlertDomainEvent,
  options: IsolatedAlertDispatchOptions = {},
): Promise<IsolatedAlertDispatchResult> {
  const receiver = resolveReceiver()
  const maxAttempts = options.maxAttempts ?? 3
  if (maxAttempts < 1) {
    throw new Error('maxAttempts must be at least 1')
  }

  const deliveryIds: string[] = []
  let attempts = 0
  let duplicateCount = 0

  // Snapshot before dispatch so repeated alert identities are discoverable.
  const deliveredBefore = new Set(
    receiver.getDeliveries(event.alertId).map((delivery) => delivery.recipient),
  )

  for (const recipient of event.recipients) {
    if (deliveredBefore.has(recipient)) {
      duplicateCount += 1
      continue
    }

    let lastError: unknown
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      attempts += 1
      try {
        const delivery = await receiver.deliver(
          event.alertId,
          recipient,
          event.channel,
          event.payload,
        )
        deliveryIds.push(delivery.id)
        lastError = undefined
        break
      } catch (error) {
        lastError = error
      }
    }

    if (lastError) {
      throw lastError instanceof Error ? lastError : new Error('isolated alert delivery failed')
    }
  }

  return {
    alertId: event.alertId,
    deliveryIds,
    deliveredCount: deliveryIds.length,
    duplicateCount,
    attempts,
  }
}
