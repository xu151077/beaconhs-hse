import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { attachmentUrl } from '../../../../lib/attachment-url'

const state = vi.hoisted(() => ({
  row: null as { r2Key: string } | null,
  authCalls: 0,
  authenticated: true,
  headCalls: 0,
  streamCalls: 0,
  headResult: null as { contentLength: number; contentType: string | null } | null,
}))

vi.mock('../../../../lib/auth', () => ({
  getRequestContext: async () => {
    state.authCalls++
    if (!state.authenticated) return null
    return {
      db: async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          select: () => ({
            from: () => ({
              where: () => ({ limit: async () => (state.row ? [state.row] : []) }),
            }),
          }),
        }),
    }
  },
}))

// The route must never mint an object-store URL: it streams the bytes itself.
vi.mock('@beaconhs/storage', () => ({
  headObject: async () => {
    state.headCalls++
    return state.headResult
  },
  getObjectStream: async () => {
    state.streamCalls++
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('file-bytes'))
          controller.close()
        },
      }),
      contentLength: 10,
      contentType: 'application/pdf',
    }
  },
  contentDisposition: (mode: string, filename: string, fallback: string) =>
    `${mode}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
}))

import { GET } from './route'

const ID = '10000000-0000-4000-8000-000000000001'

async function request(url: string) {
  return GET(new NextRequest(`http://localhost${url}`), { params: Promise.resolve({ id: ID }) })
}

describe('attachment capability route', () => {
  beforeEach(() => {
    state.row = null
    state.authCalls = 0
    state.authenticated = true
    state.headCalls = 0
    state.streamCalls = 0
    state.headResult = { contentLength: 10, contentType: 'application/pdf' }
  })

  it('rejects ID-only and invalid capabilities before tenant lookup', async () => {
    expect((await request(`/api/attachments/${ID}`)).status).toBe(404)
    expect((await request(`/api/attachments/${ID}?cap=${'A'.repeat(43)}`)).status).toBe(404)
    expect(state.authCalls).toBe(0)
  })

  it('keeps a valid capability tenant-scoped', async () => {
    expect((await request(attachmentUrl(ID))).status).toBe(404)
    expect(state.authCalls).toBe(1)
  })

  it('requires an authenticated tenant after validating the capability', async () => {
    state.authenticated = false
    expect((await request(attachmentUrl(ID))).status).toBe(401)
    expect(state.authCalls).toBe(1)
  })

  it('streams the bytes instead of redirecting to the object store', async () => {
    state.row = { r2Key: 't/tenant/private.pdf' }
    const response = await request(attachmentUrl(ID))
    expect(response.status).toBe(200)
    // A redirect would hand the browser a URL that reaches the object store
    // directly, which the internal-only object-storage architecture forbids.
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(state.headCalls).toBe(1)
    expect(state.streamCalls).toBe(1)
    expect(await response.text()).toBe('file-bytes')
  })

  it('answers 404 when the object is gone from the store', async () => {
    state.row = { r2Key: 't/tenant/private.pdf' }
    state.headResult = null
    const response = await request(attachmentUrl(ID))
    expect(response.status).toBe(404)
    expect(state.streamCalls).toBe(0)
  })
})
