/**
 * Isolated application alert entrypoint for local G2 verification.
 *
 * This deliberately calls the isolated in-memory receiver only. It does not
 * enqueue email, SMS, webhook, or production notification work.
 */

import { dispatchIsolatedAlert, type IsolatedAlertChannel } from '@beaconhs/events'

export type IsolatedAlertApplicationEvent = {
  alertId: string
  recipients: readonly string[]
  channel: IsolatedAlertChannel
  payload: Record<string, unknown>
  /** Required marker: this entrypoint must only be used with disposable data. */
  disposable: true
  maxAttempts?: number
}

/**
 * Runtime gate: the isolated alert path exists only in a local/development
 * process that explicitly opts in. It is never callable from production.
 */
export function isolatedAlertEntrypointEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' && process.env.BEACONHS_ISOLATED_ALERTS_ENABLED === 'true'
  )
}

export async function emitIsolatedAlertApplicationEvent(event: IsolatedAlertApplicationEvent) {
  if (!isolatedAlertEntrypointEnabled()) {
    throw new Error('Isolated alert entrypoint is disabled in this environment')
  }
  if (event.disposable !== true) {
    throw new Error('Isolated alert entrypoint accepts disposable events only')
  }

  return dispatchIsolatedAlert(
    {
      alertId: event.alertId,
      recipients: event.recipients,
      channel: event.channel,
      payload: event.payload,
    },
    { maxAttempts: event.maxAttempts ?? 3 },
  )
}
