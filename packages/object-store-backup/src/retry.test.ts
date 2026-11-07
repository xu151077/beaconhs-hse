// Retry policy tests.
//
// The properties worth pinning: retryable errors are retried, permanent ones are not
// (an unbounded retry of a 403 turns a clear misconfiguration into a hang), and the
// attempt count is always bounded.

import { describe, expect, it, vi } from 'vitest'
import { RetryExhaustedError, classifyError, withRetry } from './retry'

const noSleep = async (): Promise<void> => undefined

function sdkError(name: string, status?: number): unknown {
  return { name, $metadata: status === undefined ? {} : { httpStatusCode: status } }
}

describe('classifyError', () => {
  it.each([
    ['connection reset', sdkError('ECONNRESET')],
    ['ECONNREFUSED', sdkError('ECONNREFUSED')],
    ['request timeout', sdkError('TimeoutError')],
    ['throttling', sdkError('ThrottlingException')],
    ['slow down', sdkError('SlowDown')],
    ['503', sdkError('ServiceUnavailable', 503)],
    ['500', sdkError('InternalError', 500)],
    ['429', sdkError('Throttling', 429)],
    ['408', sdkError('RequestTimeout', 408)],
  ])('treats %s as retryable', (_label, error) => {
    expect(classifyError(error)).toBe('retryable')
  })

  it.each([
    ['403 forbidden', sdkError('AccessDenied', 403)],
    ['404 missing', sdkError('NoSuchKey', 404)],
    ['400 bad request', sdkError('InvalidRequest', 400)],
    ['signature mismatch', sdkError('SignatureDoesNotMatch', 403)],
    ['an unrecognised error', sdkError('SomethingElse')],
  ])('treats %s as permanent', (_label, error) => {
    expect(classifyError(error)).toBe('permanent')
  })

  it('does not guess that an unknown error will clear itself', () => {
    // The safe default is permanent: retrying an error the tool does not understand
    // is how it ends up hammering a store it cannot authenticate to.
    expect(classifyError({ name: 'TotallyNovel' })).toBe('permanent')
  })
})

describe('withRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const operation = vi.fn().mockResolvedValue('ok')
    await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('retries a transient failure and then succeeds', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(sdkError('ECONNRESET'))
      .mockRejectedValueOnce(sdkError('ServiceUnavailable', 503))
      .mockResolvedValue('recovered')
    await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe('recovered')
    expect(operation).toHaveBeenCalledTimes(3)
  })

  it('does not retry a permanent failure', async () => {
    const operation = vi.fn().mockRejectedValue(sdkError('AccessDenied', 403))
    await expect(withRetry(operation, { sleep: noSleep })).rejects.toMatchObject({
      name: 'AccessDenied',
    })
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('gives up after the configured number of attempts', async () => {
    const operation = vi.fn().mockRejectedValue(sdkError('ECONNRESET'))
    await expect(withRetry(operation, { attempts: 4, sleep: noSleep })).rejects.toThrow(
      /failed after 4 attempt/,
    )
    expect(operation).toHaveBeenCalledTimes(4)
  })

  it('backs off exponentially, capped', async () => {
    const delays: number[] = []
    const operation = vi.fn().mockRejectedValue(sdkError('ECONNRESET'))
    await expect(
      withRetry(operation, {
        attempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 350,
        sleep: async (ms) => {
          delays.push(ms)
        },
      }),
    ).rejects.toThrow()
    expect(delays).toEqual([100, 200, 350, 350])
  })

  it('reports the attempt number to the retry callback', async () => {
    const seen: number[] = []
    const operation = vi.fn().mockRejectedValue(sdkError('ECONNRESET'))
    await expect(
      withRetry(operation, {
        attempts: 3,
        sleep: noSleep,
        onRetry: ({ attempt }) => seen.push(attempt),
      }),
    ).rejects.toThrow()
    expect(seen).toEqual([1, 2])
  })

  it('rethrows a single-attempt failure with its original type intact', async () => {
    // Callers inspect `$metadata.httpStatusCode`; wrapping it would break them.
    const error = sdkError('NoSuchBucket', 404)
    const operation = vi.fn().mockRejectedValue(error)
    await expect(withRetry(operation, { attempts: 3, sleep: noSleep })).rejects.toBe(error)
  })
})
