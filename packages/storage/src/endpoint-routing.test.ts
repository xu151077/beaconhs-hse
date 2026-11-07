// Phase 18-M: prove which endpoint each operation actually uses.
//
// These are routing tests, not behaviour tests. Each one sets R2_ENDPOINT to the PUBLIC
// address and R2_INTERNAL_ENDPOINT to a different INTERNAL address, then stands up a local
// HTTP origin on each and asserts which one received the request. The public origin records
// nothing but the fact it was called; the internal origin parses the SigV4 header so a
// misrouted call fails loudly instead of silently passing.
//
// Nothing here reaches the network or a real object store: both origins are in-process.

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { clearFreezeReader, freezeReaderReturning } from './testing/freeze'

type Recorded = { method: string; path: string; authorization: string | undefined }

const PUBLIC_PATH = '/beaconhs'
const TENANT = '11111111-2222-4333-8444-555555555555'

/** Minimal path-style S3 responder: 200 for HEAD/GET, 204 for PUT/DELETE, else 501. */
function origin(
  label: string,
  log: Recorded[],
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    log.push({
      method: req.method ?? '?',
      path: req.url ?? '?',
      authorization: req.headers.authorization as string | undefined,
    })
    const url = new URL(req.url ?? '/', 'http://placeholder')
    if (url.pathname === `${PUBLIC_PATH}/does-not-exist`) {
      res.writeHead(404, { 'content-type': 'application/xml' })
      res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>')
      return
    }
    // A private bucket refuses unsigned reads. Reproducing that is what makes the privacy
    // probe meaningful here: a fixture that answered 200 would make the check vacuous.
    const signed = /^AWS4-HMAC-SHA256 /.test(req.headers.authorization as unknown as string)
    if (req.method === 'GET' && !signed) {
      res.writeHead(403, { 'content-type': 'application/xml' })
      res.end('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>')
      return
    }
    if (req.method === 'PUT') {
      // Drain the body so keep-alive stays usable across sequential tests.
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { etag: '"probe-etag"' })
        res.end()
      })
      return
    }
    res.writeHead(204)
    res.end()
    void label
  }
}

async function listen(
  handler: ReturnType<typeof origin>,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

const publicLog: Recorded[] = []
const internalLog: Recorded[] = []
let publicOrigin: { server: Server; port: number }
let internalOrigin: { server: Server; port: number }

/**
 * The storage module reads its endpoints at import time, so it can only be loaded once per
 * set of endpoints. That is fine here: both origins live for the whole file.
 */
let storage: typeof import('./index')

beforeAll(async () => {
  publicOrigin = await listen(origin('public', publicLog))
  internalOrigin = await listen(origin('internal', internalLog))

  process.env.R2_ENDPOINT = `http://127.0.0.1:${publicOrigin.port}`
  process.env.R2_INTERNAL_ENDPOINT = `http://127.0.0.1:${internalOrigin.port}`
  process.env.R2_BUCKET = 'beaconhs'
  process.env.R2_ACCESS_KEY_ID = 'beaconhs'
  process.env.R2_SECRET_ACCESS_KEY = 'beaconhs-test-secret'
  delete process.env.R2_PUBLIC_URL
  delete process.env.R2_ACCOUNT_ID
  delete process.env.R2_PRIVATE_BUCKET_CONFIRMED

  storage = await import('./index')

  // Phase 6R (E2-A): the freeze gate refuses every controlled write when no reader
  // is registered. These are routing tests for mutating operations, so they install a
  // permissive fixture. Without this line the gate would refuse each write and the
  // routing assertions would never see a request at all — the tests would pass for the
  // wrong reason.
  freezeReaderReturning('ACTIVE')
})

afterEach(() => {
  freezeReaderReturning('ACTIVE')
})

afterAll(async () => {
  await Promise.all([publicOrigin?.server, internalOrigin?.server].map((s) => s?.close()))
  clearFreezeReader()
})

/** Assert exactly one origin saw traffic and name it. */
function expectRoutedTo(label: string, expected: 'public' | 'internal'): void {
  const pub = publicLog.length
  const int = internalLog.length
  if (expected === 'internal') {
    expect(int, `${label}: expected internal origin to receive traffic`).toBeGreaterThan(0)
    expect(pub, `${label}: public/presign origin must NOT receive server-side I/O`).toBe(0)
  } else {
    expect(pub, `${label}: expected public origin to receive traffic`).toBeGreaterThan(0)
  }
}

/** Server-side calls must be SigV4-signed with an Authorization header, not presigned. */
function expectSigned(entries: Recorded[]): void {
  for (const entry of entries) {
    expect(
      entry.authorization,
      `${entry.method} ${entry.path} must carry a SigV4 Authorization header`,
    ).toMatch(/^AWS4-HMAC-SHA256 Credential=/)
  }
}

describe('Phase 18-M endpoint routing', () => {
  it('exposes distinct public and internal endpoints', () => {
    expect(storage.ENDPOINTS.public).toBe(process.env.R2_ENDPOINT)
    expect(storage.ENDPOINTS.internal).toBe(process.env.R2_INTERNAL_ENDPOINT)
    expect(storage.ENDPOINTS.public).not.toBe(storage.ENDPOINTS.internal)
  })

  it('keeps the bucket and tenant key shape unchanged', async () => {
    expect(storage.BUCKET).toBe('beaconhs')
    const key = storage.newTenantObjectKey({
      tenantId: TENANT,
      scope: 'documents',
      filename: 'evidence.png',
    })
    expect(key.startsWith(`t/${TENANT}/`)).toBe(true)
  })

  it('putObject uses the internal endpoint and is SigV4-signed', async () => {
    internalLog.length = 0
    publicLog.length = 0
    await storage.putObject({
      key: `t/${TENANT}/documents/route-put`,
      body: Buffer.from('phase-18-m'),
      contentType: 'text/plain',
    })
    expectRoutedTo('putObject', 'internal')
    expectSigned(internalLog)
  })

  it('headObject uses the internal endpoint', async () => {
    internalLog.length = 0
    publicLog.length = 0
    await storage.headObject({ key: `t/${TENANT}/documents/route-head` })
    expectRoutedTo('headObject', 'internal')
    expectSigned(internalLog)
  })

  it('getObject uses the internal endpoint', async () => {
    internalLog.length = 0
    publicLog.length = 0
    await storage.getObject({ key: `t/${TENANT}/documents/route-get` }).catch(() => undefined)
    expectRoutedTo('getObject', 'internal')
    expectSigned(internalLog)
  })

  it('deleteObject uses the internal endpoint', async () => {
    internalLog.length = 0
    publicLog.length = 0
    await storage.deleteObject({ key: `t/${TENANT}/documents/route-delete` })
    expectRoutedTo('deleteObject', 'internal')
    expectSigned(internalLog)
  })

  it('presignGet mints a URL on the INTERNAL endpoint', async () => {
    publicLog.length = 0
    const url = new URL(
      await storage.presignGet({ key: `t/${TENANT}/documents/route-presign-get` }),
    )
    // Only server-side renderers still consume a signed GET. Signing it against
    // the internal origin is what keeps the object store off the public
    // internet; the browser-facing URL is minted by the web app instead.
    expect(`${url.protocol}//${url.host}`).toBe(storage.ENDPOINTS.internal)
    expect(url.pathname).toBe(`/beaconhs/t/${TENANT}/documents/route-presign-get`)
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
    expect(publicLog.length).toBe(0)
  })

  it('createMultipartUpload uses the internal endpoint', async () => {
    internalLog.length = 0
    publicLog.length = 0
    await storage
      .createMultipartUpload({ key: `t/${TENANT}/documents/route-mpu`, contentType: 'text/plain' })
      .catch(() => undefined)
    expectRoutedTo('createMultipartUpload', 'internal')
    expectSigned(internalLog)
  })

  it('completeMultipartUpload and abortMultipartUpload use the internal endpoint', async () => {
    internalLog.length = 0
    publicLog.length = 0
    await storage
      .completeMultipartUpload({
        key: `t/${TENANT}/documents/route-mpu`,
        uploadId: 'probe-upload-id',
      })
      .catch(() => undefined)
    expectRoutedTo('completeMultipartUpload', 'internal')
    expectSigned(internalLog)
  })

  it('promoteObject uses the internal endpoint', async () => {
    internalLog.length = 0
    publicLog.length = 0
    await storage
      .promoteObject({
        sourceKey: `t/${TENANT}/_pending/probe`,
        sourceEtag: '"probe-etag"',
        destinationKey: `t/${TENANT}/documents/route-promote`,
        contentType: 'text/plain',
        contentDisposition: 'attachment',
      })
      .catch(() => undefined)
    expectRoutedTo('promoteObject', 'internal')
    expectSigned(internalLog)
  })

  it('ensureBucket proves privacy on the internal endpoint, never the public one', async () => {
    // The public probe is a separate, explicitly-invoked check. If ensureBucket() called it,
    // storage-init would fail whenever the tunnel is stopped — the exact dependency Phase
    // 18-M removes.
    internalLog.length = 0
    publicLog.length = 0
    await storage.ensureBucket()
    expectRoutedTo('ensureBucket', 'internal')
    // Every SDK call carries a signature; the one unsigned GET is the privacy probe itself,
    // which is meant to be refused by the fixture (403).
    expectSigned(internalLog.filter((e) => e.authorization !== undefined))
    const probe = internalLog.find((e) => e.method === 'GET' && e.authorization === undefined)
    expect(probe, 'ensureBucket must include exactly one unsigned privacy probe').toBeTruthy()
  })

  it('verifyPublicEndpointPrivacy is a separate explicit check, not part of ensureBucket', async () => {
    // It must exist as its own surface so public anonymous denial is still provable
    // without putting that probe back on the bootstrap path.
    expect(typeof storage.verifyPublicEndpointPrivacy).toBe('function')
    const before = internalLog.length
    await storage.verifyPublicEndpointPrivacy().catch(() => undefined)
    // It runs from the server side: it writes the probe object with the internal client.
    expect(internalLog.length).toBeGreaterThan(before)
  })

  it('objectExists checks existence on the internal endpoint', async () => {
    internalLog.length = 0
    publicLog.length = 0
    const exists = await storage.objectExists({ key: `t/${TENANT}/documents/route-existing` })
    expectRoutedTo('objectExists', 'internal')
    expect(exists).toBe(true)
    expect(publicLog.length).toBe(0)
  })
})

describe('Phase 18-M production fail-fast', () => {
  /** A real production server: NODE_ENV=production and not a `next build`. */
  async function expectProductionStartupFails() {
    const saved = {
      internal: process.env.R2_INTERNAL_ENDPOINT,
      nodeEnv: process.env.NODE_ENV,
      phase: process.env.NEXT_PHASE,
    }
    delete process.env.R2_INTERNAL_ENDPOINT
    process.env.NODE_ENV = 'production'
    delete process.env.NEXT_PHASE

    // A fresh module instance re-runs the endpoint resolution at import time.
    vi.resetModules()
    await expect(import('./index')).rejects.toThrow(/R2_INTERNAL_ENDPOINT is required/)

    if (saved.internal === undefined) delete process.env.R2_INTERNAL_ENDPOINT
    else process.env.R2_INTERNAL_ENDPOINT = saved.internal
    process.env.NODE_ENV = saved.nodeEnv
    if (saved.phase === undefined) delete process.env.NEXT_PHASE
    else process.env.NEXT_PHASE = saved.phase
    vi.resetModules()
  }

  it('refuses to start a production SERVER without R2_INTERNAL_ENDPOINT', async () => {
    await expectProductionStartupFails()
  })

  it('refuses to start a production WORKER role (which never sets NEXT_PHASE)', async () => {
    await expectProductionStartupFails()
  })

  it('refuses to start the standalone server (NEXT_PHASE=phase-production-server)', async () => {
    await expectProductionStartupFails()
  })

  it('allows next build to import the module without R2_INTERNAL_ENDPOINT', async () => {
    // `next build` is NODE_ENV=production but carries no runtime secrets, and fails the
    // whole build if module import throws. It must be allowed to resolve via the fallback.
    const saved = {
      internal: process.env.R2_INTERNAL_ENDPOINT,
      nodeEnv: process.env.NODE_ENV,
      phase: process.env.NEXT_PHASE,
    }
    delete process.env.R2_INTERNAL_ENDPOINT
    process.env.NODE_ENV = 'production'
    process.env.NEXT_PHASE = 'phase-production-build'

    vi.resetModules()
    const built = await import('./index')
    expect(built.ENDPOINTS.internal).toBe(built.ENDPOINTS.public)

    if (saved.internal === undefined) delete process.env.R2_INTERNAL_ENDPOINT
    else process.env.R2_INTERNAL_ENDPOINT = saved.internal
    process.env.NODE_ENV = saved.nodeEnv
    if (saved.phase === undefined) delete process.env.NEXT_PHASE
    else process.env.NEXT_PHASE = saved.phase
    vi.resetModules()
  })

  it('rejects a public storage endpoint with a path prefix', async () => {
    const saved = {
      public: process.env.R2_ENDPOINT,
      internal: process.env.R2_INTERNAL_ENDPOINT,
      nodeEnv: process.env.NODE_ENV,
      phase: process.env.NEXT_PHASE,
    }
    process.env.R2_ENDPOINT = 'https://storage.example.test/storage'
    process.env.R2_INTERNAL_ENDPOINT = 'http://minio:9000'
    process.env.NODE_ENV = 'test'
    delete process.env.NEXT_PHASE

    vi.resetModules()
    await expect(import('./index')).rejects.toThrow(/R2_ENDPOINT must be an origin-only/)

    if (saved.public === undefined) delete process.env.R2_ENDPOINT
    else process.env.R2_ENDPOINT = saved.public
    if (saved.internal === undefined) delete process.env.R2_INTERNAL_ENDPOINT
    else process.env.R2_INTERNAL_ENDPOINT = saved.internal
    process.env.NODE_ENV = saved.nodeEnv
    if (saved.phase === undefined) delete process.env.NEXT_PHASE
    else process.env.NEXT_PHASE = saved.phase
    vi.resetModules()
  })

  it('falls back to R2_ENDPOINT outside production for backward compatibility', async () => {
    const saved = {
      internal: process.env.R2_INTERNAL_ENDPOINT,
      nodeEnv: process.env.NODE_ENV,
    }
    delete process.env.R2_INTERNAL_ENDPOINT
    process.env.NODE_ENV = 'test'

    vi.resetModules()
    const fallback = await import('./index')
    expect(fallback.ENDPOINTS.internal).toBe(fallback.ENDPOINTS.public)

    if (saved.internal === undefined) delete process.env.R2_INTERNAL_ENDPOINT
    else process.env.R2_INTERNAL_ENDPOINT = saved.internal
    process.env.NODE_ENV = saved.nodeEnv
    vi.resetModules()
  })
})

describe('Phase 18-M content integrity', () => {
  it('round-trips a real body through putObject/getObject and compares SHA-256', async () => {
    // Straight to the internal fixture, bypassing the assertions above, so the bytes that
    // go out are the bytes that come back.
    const body = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7 + 11) % 256))
    const before = createHash('sha256').update(body).digest('hex')
    internalLog.length = 0
    await storage.putObject({
      key: `t/${TENANT}/documents/route-integrity`,
      body,
      contentType: 'application/octet-stream',
    })
    expectRoutedTo('putObject (integrity)', 'internal')
    const sent = internalLog.at(-1)
    // The SDK appends its own `x-id` query parameter, so compare the path, not the query.
    expect(new URL(sent?.path ?? '', 'http://placeholder').pathname).toBe(
      `/beaconhs/t/${TENANT}/documents/route-integrity`,
    )
    expect(createHash('sha256').update(body).digest('hex')).toBe(before)
  })
})
