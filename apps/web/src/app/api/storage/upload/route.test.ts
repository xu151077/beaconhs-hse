import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'a-valid-upload-token'
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')
const UPLOAD_ID = '10000000-0000-4000-8000-000000000001'
const KEY = `t/${TENANT}/pending/${UPLOAD_ID}`

const state = vi.hoisted(() => ({
  authenticated: true,
  tenantId: '11111111-1111-4111-8111-111111111111',
  reservation: null as Record<string, unknown> | null,
  writes: [] as Array<Record<string, unknown>>,
  parts: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth', () => ({
  getRequestContext: async () =>
    state.authenticated
      ? {
          userId: 'user-1',
          tenantId: state.tenantId,
          // The route reads the reservation through the tenant-scoped executor;
          // the fixture stands in for that one query.
          db: async (run: (tx: unknown) => Promise<unknown>) =>
            run({
              select: () => ({
                from: () => ({
                  where: () => ({
                    limit: async () => (state.reservation ? [state.reservation] : []),
                  }),
                }),
              }),
            }),
        }
      : null,
}))

vi.mock('@beaconhs/storage', async () => {
  const actual = await vi.importActual<typeof import('@beaconhs/storage')>('@beaconhs/storage')
  return {
    ...actual,
    putStagedObject: async (args: Record<string, unknown>) => {
      // Consume the stream so the route's own plumbing is exercised, then
      // record only what the object store would have received.
      const body = args.body as NodeJS.ReadableStream
      let received = 0
      for await (const chunk of body) received += (chunk as Buffer).byteLength
      state.writes.push({ ...args, body: undefined, received })
    },
    uploadStagedPart: async (args: Record<string, unknown>) => {
      const body = args.body as NodeJS.ReadableStream
      let received = 0
      for await (const chunk of body) received += (chunk as Buffer).byteLength
      state.parts.push({ ...args, body: undefined, received })
    },
  }
})

import { POST } from './route'

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: UPLOAD_ID,
    tenantId: TENANT,
    requestedBy: 'user-1',
    kind: 'document',
    stagingKey: KEY,
    r2Key: `t/${TENANT}/files/report.pdf`,
    filename: 'report.pdf',
    contentType: 'application/pdf',
    sizeBytes: 11,
    verificationTokenHash: TOKEN_HASH,
    multipartUploadId: null,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  }
}

function request(
  args: {
    uploadId?: string
    token?: string
    partNumber?: number
    body?: string
    contentType?: string | null
    contentLength?: string | null
  } = {},
) {
  const params = new URLSearchParams({ uploadId: args.uploadId ?? UPLOAD_ID })
  if (args.partNumber !== undefined) params.set('partNumber', String(args.partNumber))
  const headers = new Headers()
  headers.set('x-upload-token', args.token ?? TOKEN)
  if (args.contentType !== null) headers.set('content-type', args.contentType ?? 'application/pdf')
  if (args.contentLength !== null) {
    headers.set('content-length', args.contentLength ?? String((args.body ?? 'hello world').length))
  }
  return POST(
    new NextRequest(`http://localhost/api/storage/upload?${params.toString()}`, {
      method: 'POST',
      headers,
      body: args.body ?? 'hello world',
    }),
  )
}

describe('server-proxied upload', () => {
  beforeEach(() => {
    state.authenticated = true
    state.tenantId = TENANT
    state.reservation = reservation()
    state.writes = []
    state.parts = []
  })

  it('refuses an unauthenticated upload', async () => {
    state.authenticated = false
    expect((await request()).status).toBe(401)
    expect(state.writes).toHaveLength(0)
  })

  it('answers 404 for an upload reference the caller does not own', async () => {
    state.reservation = null
    expect((await request()).status).toBe(404)
    expect(state.writes).toHaveLength(0)
  })

  it('answers 404 for a wrong token, indistinguishable from a missing reference', async () => {
    expect((await request({ token: 'wrong-token' })).status).toBe(404)
    expect(state.writes).toHaveLength(0)
  })

  it('refuses a reservation from another tenant', async () => {
    state.reservation = reservation({ tenantId: OTHER_TENANT })
    expect((await request()).status).toBe(403)
    expect(state.writes).toHaveLength(0)
  })

  it('answers 410 for an expired reference', async () => {
    state.reservation = reservation({ expiresAt: new Date(Date.now() - 1_000) })
    expect((await request()).status).toBe(410)
    expect(state.writes).toHaveLength(0)
  })

  it('requires a declared length', async () => {
    expect((await request({ contentLength: null })).status).toBe(411)
    expect(state.writes).toHaveLength(0)
  })

  it('refuses a body whose length differs from the reservation', async () => {
    expect((await request({ body: 'too short', contentLength: '9' })).status).toBe(400)
    expect(state.writes).toHaveLength(0)
  })

  it('refuses a single-object upload whose type differs from the reservation', async () => {
    expect((await request({ contentType: 'text/html' })).status).toBe(400)
    expect(state.writes).toHaveLength(0)
  })

  it('writes the reservation key, type, token and exact length', async () => {
    const response = await request()
    expect(response.status).toBe(200)
    expect(state.writes).toHaveLength(1)
    const write = state.writes[0]!
    expect(write.key).toBe(KEY)
    expect(write.contentType).toBe('application/pdf')
    expect(write.uploadToken).toBe(TOKEN)
    expect(write.contentLength).toBe(11)
    expect(write.received).toBe(11)
  })

  it('accepts a part and ignores the part media type', async () => {
    state.reservation = reservation({
      sizeBytes: 10,
      multipartUploadId: 'multipart-1',
      contentType: 'application/pdf',
    })
    // The browser sends raw slices, whose media type is not the object's.
    const response = await request({
      partNumber: 1,
      body: 'abcdefghij',
      contentType: 'application/octet-stream',
      contentLength: '10',
    })
    expect(response.status).toBe(200)
    expect(state.parts).toHaveLength(1)
    expect(state.parts[0]!.partNumber).toBe(1)
    expect(state.parts[0]!.contentLength).toBe(10)
  })

  it('refuses a part number beyond the upload', async () => {
    state.reservation = reservation({ sizeBytes: 10, multipartUploadId: 'multipart-1' })
    const response = await request({
      partNumber: 99,
      body: 'abcd',
      contentLength: '4',
    })
    expect(response.status).toBe(400)
    expect(state.parts).toHaveLength(0)
  })

  it('refuses a part when no multipart upload is open', async () => {
    const response = await request({ partNumber: 1, body: 'abcd', contentLength: '4' })
    expect(response.status).toBe(409)
    expect(state.parts).toHaveLength(0)
  })
})
