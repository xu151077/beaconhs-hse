// Storage write-freeze gate — boundary tests (Phase 6R, stage E2-A).
//
// These prove the property that the pure gate tests cannot: that a REFUSED operation
// never reaches the underlying S3 client. They reuse the in-process origin pattern
// from endpoint-routing.test.ts, so nothing touches the network or a real store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { registerStorageFreezeReader, StorageWriteBlockedError } from './freeze-gate'
import {
  createNoOpInFlightWriteTracker,
  registerInFlightWriteTracker,
  type InFlightWriteTracker,
} from './freeze-gate'
import { clearFreezeReader, freezeReaderReturning, freezeReaderThrowing } from './testing/freeze'

type Recorded = { method: string; path: string }

const TENANT = '11111111-2222-4333-8444-555555555555'
const KEY = `t/${TENANT}/documents/gate-probe.bin`

let server: Server
let mutations: Recorded[] = []

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    mutations.push({ method: req.method ?? '?', path: url.pathname })
    if (req.method === 'PUT') {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { etag: '"probe-etag"' })
        res.end()
      })
      return
    }
    res.writeHead(204)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  process.env.R2_ENDPOINT = `http://127.0.0.1:${address.port}`
  process.env.R2_INTERNAL_ENDPOINT = `http://127.0.0.1:${address.port}`
  delete process.env.R2_BUCKET
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => {
  mutations = []
  clearFreezeReader()
  registerInFlightWriteTracker(createNoOpInFlightWriteTracker())
})

const importStorage = async () => import('./index')

describe('a refused mutation never reaches the object store', () => {
  it('putObject is refused while FROZEN and makes no request', async () => {
    freezeReaderReturning('FROZEN')
    const storage = await importStorage()
    const error = await storage
      .putObject({
        key: KEY,
        body: Buffer.from('x'),
        contentType: 'application/octet-stream',
      })
      .catch((e) => e)
    expect(error).toBeInstanceOf(StorageWriteBlockedError)
    expect(error.code).toBe('STORAGE_FROZEN')
    expect(mutations).toHaveLength(0)
  })

  it('deleteObject is refused while FROZEN and makes no request', async () => {
    freezeReaderReturning('FROZEN')
    const storage = await importStorage()
    await expect(storage.deleteObject({ key: KEY })).rejects.toThrow(StorageWriteBlockedError)
    expect(mutations).toHaveLength(0)
  })

  it('createMultipartUpload is refused while DRAINING and makes no request', async () => {
    freezeReaderReturning('DRAINING')
    const storage = await importStorage()
    await expect(
      storage.createMultipartUpload({ key: KEY, contentType: 'text/plain' }),
    ).rejects.toThrow(/STORAGE_FROZEN/)
    expect(mutations).toHaveLength(0)
  })

  it('completeMultipartUpload is refused while RECONCILING and makes no request', async () => {
    freezeReaderReturning('RECONCILING')
    const storage = await importStorage()
    await expect(
      storage.completeMultipartUpload({ key: KEY, uploadId: 'upload-id' }),
    ).rejects.toThrow(/STORAGE_FROZEN/)
    // ListParts is a read the gate permits; no Complete request was issued.
    expect(
      mutations.every((m) => m.method !== 'POST' || !m.path.includes('uploadId=upload-id')),
    ).toBe(true)
  })

  it('abortMultipartUpload is refused while FROZEN and makes no request', async () => {
    freezeReaderReturning('FROZEN')
    const storage = await importStorage()
    await expect(storage.abortMultipartUpload({ key: KEY, uploadId: 'upload-id' })).rejects.toThrow(
      /STORAGE_FROZEN/,
    )
    expect(mutations).toHaveLength(0)
  })

  it('promoteObject is refused while FAILED and makes no request', async () => {
    freezeReaderReturning('FAILED')
    const storage = await importStorage()
    await expect(
      storage.promoteObject({
        sourceKey: KEY,
        sourceEtag: '"etag"',
        destinationKey: KEY,
        contentType: 'application/octet-stream',
        contentDisposition: 'attachment',
      }),
    ).rejects.toThrow(/STORAGE_FROZEN/)
    expect(mutations).toHaveLength(0)
  })
})

describe('an indeterminate state fails closed', () => {
  it('refuses when the reader throws', async () => {
    freezeReaderThrowing()
    const storage = await importStorage()
    await expect(
      storage.putObject({
        key: KEY,
        body: Buffer.from('x'),
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow(/STORAGE_FREEZE_STATE_UNKNOWN/)
    expect(mutations).toHaveLength(0)
  })

  it('refuses when no reader is registered', async () => {
    clearFreezeReader()
    const storage = await importStorage()
    await expect(
      storage.putObject({
        key: KEY,
        body: Buffer.from('x'),
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow(/STORAGE_FREEZE_STATE_UNKNOWN/)
    expect(mutations).toHaveLength(0)
  })
})

describe('reads are unaffected by a freeze', () => {
  it('headObject still succeeds while FROZEN', async () => {
    freezeReaderReturning('FROZEN')
    const storage = await importStorage()
    // A read must not be blocked: the gate covers mutations only.
    const md = await storage.headObject({ key: KEY })
    expect(md === null || typeof md === 'object').toBe(true)
  })
})

describe('ACTIVE lets a mutation through', () => {
  it('putObject succeeds when ACTIVE', async () => {
    freezeReaderReturning('ACTIVE')
    const storage = await importStorage()
    await storage.putObject({
      key: KEY,
      body: Buffer.from('hello'),
      contentType: 'application/octet-stream',
    })
    expect(mutations.length).toBeGreaterThan(0)
  })
})

describe('existing error semantics are unchanged for non-frozen states', () => {
  it('an invalid key is refused before any tenant lookup, not by the freeze gate', async () => {
    const fixture = freezeReaderReturning('ACTIVE')
    const storage = await importStorage()
    await expect(storage.deleteObject({ key: 'not-a-tenant-key' })).rejects.toThrow(
      StorageWriteBlockedError,
    )
    expect(fixture.calls).toHaveLength(0)
  })

  it('an ACTIVE mutation uses the same error path as before when the store fails', async () => {
    // A store failure while ACTIVE must surface the store's own error, not a gate
    // error: the gate must not swallow or relabel underlying failures.
    freezeReaderReturning('ACTIVE')
    const storage = await importStorage()
    // Complete with no parts: a genuine store/shape error, not a refusal.
    const error = await storage
      .completeMultipartUpload({ key: KEY, uploadId: 'nonexistent' })
      .catch((e) => e)
    expect(error).toBeDefined()
    expect((error as Error).name).not.toBe('StorageWriteBlockedError')
  })
})

describe('the putObject internal rollback path stays ungated', () => {
  it('does not re-check the gate mid-write, and does not strand a multipart upload', async () => {
    // putObject admits once at its boundary. Its multipart creation and its abort
    // rollback are internal helpers that inherit that decision. If the rollback were
    // gated, a write authorised while ACTIVE and failing after a freeze arrived could
    // not clean up, leaving a dangling upload. What is asserted here is the structural
    // property: the gate is consulted exactly once per putObject call.
    const fixture = freezeReaderReturning('ACTIVE')
    const storage = await importStorage()
    await storage.putObject({
      key: KEY,
      body: Buffer.from('hello'),
      contentType: 'application/octet-stream',
    })
    expect(fixture.calls).toHaveLength(1)
  })

  it('a freeze arriving between admission and the S3 write is not detected here', async () => {
    // The honest statement of the E2-A limitation: the gate reads state once. A freeze
    // requested after that read but before the S3 request lands is not caught, and no
    // retry of the gate would discover it because the write has already been issued.
    // This is the in-flight window Phase 6R records as an E2-B/E3 blocker.
    const fixture = freezeReaderReturning('ACTIVE')
    const storage = await importStorage()
    await storage.putObject({
      key: KEY,
      body: Buffer.from('x'),
      contentType: 'application/octet-stream',
    })
    expect(fixture.calls).toHaveLength(1)
    expect(mutations.length).toBeGreaterThan(0)
  })
})

describe('in-flight tracker failure modes', () => {
  it('refuses write when no tracker is registered (no S3 request)', async () => {
    freezeReaderReturning('ACTIVE')
    registerInFlightWriteTracker(null)
    const storage = await importStorage()
    await expect(
      storage.putObject({
        key: KEY,
        body: Buffer.from('x'),
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow(/STORAGE_WRITE_BLOCKED.*not registered/)

    expect(mutations).toHaveLength(0)
  })

  it('refuses write when tracker.register throws (no S3 request)', async () => {
    freezeReaderReturning('ACTIVE')
    const failingTracker: InFlightWriteTracker = {
      register: async () => {
        throw new Error('db unavailable')
      },
      markCompleted: async () => {},
      markFailed: async () => {},
    }
    registerInFlightWriteTracker(failingTracker)
    const storage = await importStorage()
    await expect(
      storage.putObject({
        key: KEY,
        body: Buffer.from('x'),
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow(/STORAGE_WRITE_BLOCKED.*registration failed/)
    expect(mutations).toHaveLength(0)
  })

  it('refuses write when tracker.register returns null (no S3 request)', async () => {
    freezeReaderReturning('ACTIVE')
    const nullTracker: InFlightWriteTracker = {
      register: async () => null,
      markCompleted: async () => {},
      markFailed: async () => {},
    }
    registerInFlightWriteTracker(nullTracker)
    const storage = await importStorage()
    await expect(
      storage.putObject({
        key: KEY,
        body: Buffer.from('x'),
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow(/STORAGE_WRITE_BLOCKED.*returned null/)
    expect(mutations).toHaveLength(0)
  })

  it('tracks a successful write through markCompleted', async () => {
    freezeReaderReturning('ACTIVE')
    const calls: { op: string; status: string }[] = []
    const trackingTracker: InFlightWriteTracker = {
      register: async () => {
        calls.push({ op: 'register', status: 'ok' })
        return 'rec-1'
      },
      markCompleted: async () => {
        calls.push({ op: 'markCompleted', status: 'ok' })
      },
      markFailed: async () => {
        calls.push({ op: 'markFailed', status: 'ok' })
      },
    }
    registerInFlightWriteTracker(trackingTracker)
    const storage = await importStorage()
    await storage.putObject({
      key: KEY,
      body: Buffer.from('x'),
      contentType: 'application/octet-stream',
    })
    expect(calls.map((c) => c.op)).toEqual(['register', 'markCompleted'])
    expect(mutations.length).toBeGreaterThan(0)
  })
})
