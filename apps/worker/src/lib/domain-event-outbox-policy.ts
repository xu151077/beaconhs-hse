const INITIAL_RETRY_MS = 15_000
const MAX_RETRY_MS = 60 * 60_000

/**
 * A committed event must survive a transient outage, but a POISON event
 * (invalid payload, rejected web command, deleted subject) must not be
 * retried forever: it is the oldest row, so it occupies a batch slot on every
 * scan and is never surfaced to an operator. After this many attempts the
 * drain marks it `dead` (terminal, still queryable with its lastError).
 */
export const MAX_DOMAIN_EVENT_ATTEMPTS = 10

/** Retry with bounded exponential backoff until MAX_DOMAIN_EVENT_ATTEMPTS. */
export function domainEventRetryAt(attempts: number, now: Date): Date {
  const safeAttempts = Number.isFinite(attempts) ? Math.trunc(attempts) : 1
  const exponent = Math.max(0, Math.min(30, safeAttempts - 1))
  const delayMs = Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** exponent)
  return new Date(now.getTime() + delayMs)
}
