// Bounded retry with exponential backoff.
//
// WHY THIS EXISTS
//
// An object copy of any size will meet transient failures: a connection reset, a
// read timeout, a 503 from an overloaded gateway. Retrying those is correct.
// Retrying a 403 is not: it is permanent, it will fail identically every time, and
// an unbounded retry loop turns a clear misconfiguration into a hang that operators
// only notice hours later. This module makes the distinction explicit and caps the
// total number of attempts, so every failure is bounded and reported.

export type RetryClassification = 'retryable' | 'permanent'

export class RetryExhaustedError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(message)
    this.name = 'RetryExhaustedError'
  }
}

/** Fields present on AWS SDK errors that carry enough signal to classify. */
type SdkLikeError = {
  name?: string
  Code?: string
  code?: string
  $metadata?: { httpStatusCode?: number }
  $retryable?: { throttling?: boolean }
  errno?: string
  cause?: unknown
  message?: string
}

const RETRYABLE_NAMES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'TimeoutError',
  'RequestTimeout',
  'ServiceUnavailable',
  'InternalError',
  'SlowDown',
  'ThrottlingException',
  'Throttling',
  'RequestThrottled',
  'PriorRequestNotComplete',
  'RequestTimeoutException',
  'NetworkingError',
])

/**
 * Decide whether an error is worth retrying.
 *
 * Network-layer errors and 5xx/throttling responses are retryable. 4xx is not:
 * a bad signature, a missing bucket or a forbidden operation will produce the same
 * response on every attempt. An unknown error is treated as permanent — guessing
 * "maybe it will work next time" is how a tool ends up hammering a store it cannot
 * authenticate to.
 */
export function classifyError(error: unknown): RetryClassification {
  const candidate = error as SdkLikeError
  const status = candidate?.$metadata?.httpStatusCode
  const name = candidate?.name ?? candidate?.code ?? candidate?.Code
  if (typeof status === 'number') {
    if (status === 408 || status === 429) return 'retryable'
    if (status >= 500) return 'retryable'
    if (status >= 400) return 'permanent'
  }
  if (candidate?.$retryable?.throttling === true) return 'retryable'
  if (name !== undefined && RETRYABLE_NAMES.has(name)) return 'retryable'
  if (typeof candidate?.errno === 'string' && candidate.errno.startsWith('E')) return 'retryable'
  return 'permanent'
}

export type RetryOptions = {
  /** Total attempts including the first. Must be >= 1. */
  attempts?: number
  /** First backoff in milliseconds. */
  baseDelayMs?: number
  /** Upper bound for a single backoff. */
  maxDelayMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Called before each retry, for logging only. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Run `operation`, retrying only classified-retryable failures.
 *
 * The final failure is re-thrown as `RetryExhaustedError` when at least one retry
 * happened, so the caller can report "failed after N attempts" rather than a bare
 * SDK error. A single-attempt failure is re-thrown unchanged to preserve the
 * original error type for callers that inspect it.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 5)
  const baseDelayMs = options.baseDelayMs ?? 250
  const maxDelayMs = options.maxDelayMs ?? 10_000
  const sleep = options.sleep ?? defaultSleep
  const onRetry = options.onRetry

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      if (classifyError(error) === 'permanent' || attempt === attempts) {
        if (attempt === 1) throw error
        throw new RetryExhaustedError(
          `Operation failed after ${attempt} attempt(s): ${describeError(error)}`,
          attempt,
          error,
        )
      }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastError
}

/** Short, secret-free description of an error for logs. */
export function describeError(error: unknown): string {
  const candidate = error as SdkLikeError & { message?: string }
  const name = candidate?.name ?? candidate?.code ?? candidate?.Code
  const status = candidate?.$metadata?.httpStatusCode
  const parts: string[] = []
  if (name) parts.push(String(name))
  if (typeof status === 'number') parts.push(`HTTP ${status}`)
  if (candidate?.message) parts.push(candidate.message.split('\n')[0] ?? '')
  return parts.join(' ') || 'unknown error'
}
