import { describe, expect, it } from 'vitest'
import { ForbiddenError, ImpersonationBlockedError } from '@beaconhs/tenant'
import { withRouteErrors } from './errors'

// Authorization refusals are 403, not 500.
//
// Next.js renders an uncaught error from a route handler as an opaque 500. That
// made a missing permission indistinguishable from a database fault, and the
// Phase CX file-authorization matrix had encoded the 500 as the expected
// refusal. These assertions pin the boundary: a refusal is a 403 with a generic
// body, while an unexpected fault still propagates as a 5xx.

describe('withRouteErrors', () => {
  it('maps a missing permission to 403 without naming the permission', async () => {
    const handler = withRouteErrors(async () => {
      throw new ForbiddenError('documents.manage')
    })
    const response = await handler()
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'forbidden', message: 'Forbidden' },
    })
  })

  it('maps an impersonation refusal to 403', async () => {
    const handler = withRouteErrors(async () => {
      throw new ImpersonationBlockedError('export')
    })
    const response = await handler()
    expect(response.status).toBe(403)
  })

  it('does not disguise an unexpected fault as an authorization outcome', async () => {
    const handler = withRouteErrors(async () => {
      throw new Error('database unavailable')
    })
    await expect(handler()).rejects.toThrow('database unavailable')
  })

  it('passes a normal response through unchanged', async () => {
    const handler = withRouteErrors(async (value: string) => new Response(value, { status: 200 }))
    const response = await handler('ok')
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('ok')
  })
})
