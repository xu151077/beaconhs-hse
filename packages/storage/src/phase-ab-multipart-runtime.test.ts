import './test-setup'

import crypto from 'node:crypto'
import { describe, it, expect } from 'vitest'
import * as storage from './index'

/** A one-chunk web stream, the shape a route handler receives. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Multipart integrity through the SERVER-SIDE write path.
 *
 * The browser no longer writes to the object store: a part is posted to the
 * application, which streams it to the internal endpoint. This test drives that
 * exact primitive against the real object store, so the multipart behaviour
 * (part numbering, overwrite-on-retry, concurrency, completion, hash) is still
 * proven end to end after the presigned part URLs were removed.
 */
describe('multipart runtime through the server-side write path', () => {
  it('uploads a multi-part object through real multipart, retry, and concurrency', async () => {
    const tenantId = '550e8400-e29b-41d4-a716-446655440000'
    const key = storage.newTenantObjectKey({
      tenantId,
      scope: `_phase_ab_${Date.now()}`,
      filename: 'phase-ab-multipart.bin',
    })
    // Three 64 MiB parts: enough to prove real multipart without starving the
    // rest of the suite of memory on a small host.
    const size = 130 * 1024 * 1024
    const expectedBuffer = Buffer.alloc(size)
    const partSize = storage.MULTIPART_UPLOAD_PART_SIZE_BYTES
    for (let partNumber = 1; partNumber <= Math.ceil(size / partSize); partNumber += 1) {
      expectedBuffer[(partNumber - 1) * partSize] = partNumber
    }
    const expectedHash = crypto.createHash('sha256').update(expectedBuffer).digest('hex')
    await storage.ensureBucket()

    // The helper picks multipart above 256 MiB; this test drives the multipart
    // primitives directly, so it asserts the boundary rather than relying on it.
    expect(storage.shouldUseMultipartUpload(256 * 1024 * 1024 + 1)).toBe(true)
    expect(storage.shouldUseMultipartUpload(size)).toBe(false)
    expect(partSize).toBe(64 * 1024 * 1024)

    storage.registerStorageFreezeReader(async () => ({ state: 'ACTIVE', version: 1 }))

    const uploadId = await storage.createMultipartUpload({
      key,
      contentType: 'application/octet-stream',
    })
    expect(String(uploadId).length).toBeGreaterThan(10)

    const uploadPart = async (partNumber: number) => {
      const offset = (partNumber - 1) * partSize
      const length = Math.min(partSize, size - offset)
      const chunk = Buffer.from(expectedBuffer.subarray(offset, offset + length))
      await storage.uploadStagedPart({
        key,
        uploadId,
        partNumber,
        body: streamOf(chunk),
        contentLength: chunk.byteLength,
      })
      return { partNumber, bytes: length }
    }

    // A retry overwrites the same part number with identical bytes; the part
    // must not be duplicated or corrupted by the second write.
    await uploadPart(1)
    await uploadPart(1)

    const partNumbers = [2, 3]
    const concurrentUploads = await Promise.all(partNumbers.map(uploadPart))
    expect(concurrentUploads.map((item) => item.partNumber)).toEqual(partNumbers)

    await storage.completeMultipartUpload({ key, uploadId })
    const head = await storage.headObject({ key })
    expect(head).not.toBeNull()
    expect(head!.contentLength).toBe(size)
    const object = await storage.getObject({ key })
    expect(crypto.createHash('sha256').update(object).digest('hex')).toBe(expectedHash)

    await storage.deleteObject({ key })
    expect(await storage.objectExists({ key })).toBe(false)

    // Abort leaves nothing behind.
    const abortKey = storage.newTenantObjectKey({
      tenantId,
      scope: '_phase_ab_abort',
      filename: 'abort.test.bin',
    })
    const abortUploadId = await storage.createMultipartUpload({
      key: abortKey,
      contentType: 'application/octet-stream',
    })
    await storage.abortMultipartUpload({ key: abortKey, uploadId: abortUploadId })
    expect(await storage.objectExists({ key: abortKey })).toBe(false)

    // A frozen tenant is refused before the object store is touched.
    storage.registerStorageFreezeReader(async () => ({ state: 'FROZEN', version: 2 }))
    await expect(
      storage.uploadStagedPart({
        key,
        uploadId,
        partNumber: 1,
        body: streamOf(Buffer.alloc(16, 7)),
        contentLength: 16,
      }),
    ).rejects.toThrow(/FROZEN/)
    storage.registerStorageFreezeReader(async () => ({ state: 'ACTIVE', version: 1 }))

    await storage.deleteObject({ key: abortKey }).catch(() => undefined)
  }, 180_000)
})
