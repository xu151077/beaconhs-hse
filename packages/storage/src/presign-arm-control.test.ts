import { describe, expect, it } from 'vitest'
import { registerStorageWriteArmIssuer } from './write-arms'
import { freezeReaderReturning } from './testing/freeze'
import { createNoOpStorageWriteArmIssuer } from './write-arms'
import {
  MAX_PRESIGN_MULTIPART_PART_EXPIRES_SECONDS,
  MAX_PRESIGN_PUT_EXPIRES_SECONDS,
  putStagedObject,
} from './index'

const KEY = 't/11111111-2222-4333-8444-555555555555/documents/test.docx'

function body(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x78]))
      controller.close()
    },
  })
}

/**
 * The server-side write path is the only remaining way an object is written,
 * so it inherits the write-arm control the presigned path used to carry: no
 * issuer, or an issuer that refuses, means no write reaches the object store.
 */
describe('storage write-arm control on the server-side write path', () => {
  it('issuer absent -> throws before writing', async () => {
    freezeReaderReturning('ACTIVE')
    registerStorageWriteArmIssuer(null)
    await expect(
      putStagedObject({
        key: KEY,
        contentType: 'application/octet-stream',
        uploadToken: 'tok',
        body: body(),
        contentLength: 1,
      }),
    ).rejects.toThrow(/issuer not registered/)
    registerStorageWriteArmIssuer(createNoOpStorageWriteArmIssuer())
  })

  it('issuer issue returns null -> throws and writes nothing', async () => {
    freezeReaderReturning('ACTIVE')
    registerStorageWriteArmIssuer({
      issue: async () => null,
      activate: async () => true,
      withdraw: async () => true,
    })
    await expect(
      putStagedObject({
        key: KEY,
        contentType: 'application/octet-stream',
        uploadToken: 'tok',
        body: body(),
        contentLength: 1,
      }),
    ).rejects.toThrow(/could not issue write arm/)
    registerStorageWriteArmIssuer(createNoOpStorageWriteArmIssuer())
  })
})

describe('storage write TTL alignment', () => {
  it('publishes one shared cap for each write path', () => {
    expect(MAX_PRESIGN_PUT_EXPIRES_SECONDS).toBe(120)
    expect(MAX_PRESIGN_MULTIPART_PART_EXPIRES_SECONDS).toBe(60)
  })

  it('preserves the caller upload token so finalisation can verify object metadata', async () => {
    const issuer = createNoOpStorageWriteArmIssuer()
    const result = await issuer.issue({
      tenantId: '11111111-2222-4333-8444-555555555555',
      key: KEY,
      operation: 'presignPut',
      uploadToken: 'caller-token',
    })
    expect(result?.uploadToken).toBe('caller-token')
  })
})
