import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDF_PREVIEW_LOAD_TIMEOUT_MS, startPdfLoadWatchdog } from './pdf-preview-policy'

describe('pdf preview policy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('abandons a load that is still running at the deadline', () => {
    const onTimeout = vi.fn()
    startPdfLoadWatchdog(onTimeout)

    vi.advanceTimersByTime(PDF_PREVIEW_LOAD_TIMEOUT_MS - 1)
    expect(onTimeout).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)

    // A destroyed loading task never resolves, so the deadline must not repeat.
    vi.advanceTimersByTime(PDF_PREVIEW_LOAD_TIMEOUT_MS * 3)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('stays silent once the document has loaded or the viewer has gone', () => {
    const onTimeout = vi.fn()
    const stop = startPdfLoadWatchdog(onTimeout)
    stop()

    vi.advanceTimersByTime(PDF_PREVIEW_LOAD_TIMEOUT_MS * 4)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('leaves real documents an order of magnitude more time than they need', () => {
    // The slowest measured real load (a 255 MiB document on a local origin)
    // resolved in 0.3 s, so the ceiling must stay far above that.
    expect(PDF_PREVIEW_LOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
  })
})
