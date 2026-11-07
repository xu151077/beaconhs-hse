import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  authCalls: 0,
  authenticated: true,
  tenantId: '11111111-1111-4111-8111-111111111111',
  headResult: null as { contentLength: number; contentType: string | null } | null,
  streamCalls: 0,
  assertTenantCalls: [] as string[],
  assertTenantThrows: false,
}))

vi.mock('../../../../lib/auth', () => ({
  getRequestContext: async () => {
    state.authCalls++
    if (!state.authenticated) return null
    return { tenantId: state.tenantId }
  },
}))

vi.mock('@beaconhs/storage', () => ({
  assertTenantObjectKey: ({ tenantId }: { tenantId: string; key: string }) => {
    state.assertTenantCalls.push(tenantId)
    if (state.assertTenantThrows) throw new Error('cross-tenant')
  },
  headObject: async () => state.headResult,
  getObjectStream: async () => {
    state.streamCalls++
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('object-bytes'))
          controller.close()
        },
      }),
      contentLength: 12,
      contentType: 'image/png',
    }
  },
}))

import { storageObjectUrl, validateStorageCapability } from '../../../../lib/storage-gateway'
import { GET } from './route'

const KEY = 't/11111111-1111-4111-8111-111111111111/avatars/pic.png'

async function request(url: string) {
  return GET(new NextRequest(`http://localhost${url}`))
}

describe('authorized object gateway', () => {
  beforeEach(() => {
    state.authCalls = 0
    state.authenticated = true
    state.headResult = { contentLength: 12, contentType: 'image/png' }
    state.streamCalls = 0
    state.assertTenantCalls = []
    state.assertTenantThrows = false
  })

  it('never returns an object-store URL', async () => {
    const response = await request(storageObjectUrl(KEY))
    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    const body = await response.text()
    expect(body).toBe('object-bytes')
    // The object store's address, bucket and credentials are absent from every
    // header the browser can see.
    const headerText = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')
    expect(headerText).not.toContain('minio')
    expect(headerText).not.toContain('amazonaws')
    expect(headerText).not.toContain('AccessKey')
  })

  it('marks the response private and non-sniffable', async () => {
    const response = await request(storageObjectUrl(KEY))
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('content-type')).toBe('image/png')
  })

  it('answers 404 for a missing or wrong capability', async () => {
    expect((await request('/api/storage/object?k=abc')).status).toBe(404)
    const wrong = storageObjectUrl(KEY).replace(/cap=.{43}/, `cap=${'A'.repeat(43)}`)
    expect((await request(wrong)).status).toBe(404)
    expect(state.streamCalls).toBe(0)
  })

  it('answers 404 when the object is not in the store', async () => {
    state.headResult = null
    const response = await request(storageObjectUrl(KEY))
    expect(response.status).toBe(404)
    expect(state.streamCalls).toBe(0)
  })

  it('refuses a key from another tenant', async () => {
    state.assertTenantThrows = true
    const response = await request(storageObjectUrl(KEY))
    expect(response.status).toBe(403)
    expect(state.streamCalls).toBe(0)
  })

  it('authorizes a public share by the capability alone', async () => {
    // A caller with no session is a one-time-token share: the capability is the
    // authorization, and the key is still tenant-namespaced.
    state.authenticated = false
    const response = await request(storageObjectUrl(KEY))
    expect(response.status).toBe(200)
    expect(state.assertTenantCalls).toEqual([])
  })

  it('mints a capability that does not verify for a different key', () => {
    const url = new URL(storageObjectUrl(KEY), 'http://localhost')
    const capability = url.searchParams.get('cap') ?? ''
    const expiresAt = Number(url.searchParams.get('exp'))
    expect(validateStorageCapability(KEY, capability, expiresAt)).toBe(true)
    expect(validateStorageCapability('t/other-tenant/avatars/pic.png', capability, expiresAt)).toBe(
      false,
    )
  })

  it('rejects an expired capability', () => {
    const url = new URL(storageObjectUrl(KEY), 'http://localhost')
    const capability = url.searchParams.get('cap') ?? ''
    // The URL was minted with a one-hour expiry; an expiry in the past must
    // not verify even with the matching capability.
    expect(validateStorageCapability(KEY, capability, Math.floor(Date.now() / 1000) - 1)).toBe(
      false,
    )
  })
})
