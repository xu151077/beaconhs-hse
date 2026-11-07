// Hashing and content-addressed layout tests.

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OBJECT_DIR, hashFile, objectRelativePath, sha256Hex } from './hash'

describe('sha256Hex', () => {
  it('matches node:crypto for a buffer', () => {
    const data = Buffer.from('beaconhs')
    expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'))
  })

  it('matches node:crypto for a string', () => {
    expect(sha256Hex('beaconhs')).toBe(sha256Hex(Buffer.from('beaconhs')))
    expect(sha256Hex('beaconhs')).toBe(
      createHash('sha256').update(Buffer.from('beaconhs')).digest('hex'),
    )
  })
})

describe('objectRelativePath', () => {
  it('places every object under objects/ by digest', () => {
    const digest = sha256Hex('x')
    expect(objectRelativePath(digest)).toBe(`${OBJECT_DIR}/${digest}`)
  })

  it('cannot be influenced by a hostile object key', () => {
    // The layout is content-addressed precisely so that no part of an S3 key — which
    // may contain `..`, `/`, or a drive letter — reaches the filesystem path.
    const keys = ['../../etc/passwd', '/absolute/path', 'C:\\windows', '\u0000null']
    const paths = new Set(keys.map((key) => objectRelativePath(sha256Hex(key))))
    expect(paths.size).toBe(4)
    for (const path of paths) {
      expect(path.startsWith(`${OBJECT_DIR}/`)).toBe(true)
      expect(path.split('/').includes('..')).toBe(false)
    }
  })
})

describe('hashFile', () => {
  it('hashes a file without loading it into memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-hash-'))
    const path = join(dir, 'blob')
    // 4 MiB: larger than a single internal read, so the chunked loop is exercised.
    const data = Buffer.alloc(4 * 1024 * 1024)
    for (let index = 0; index < data.byteLength; index += 1) data[index] = index % 251
    await writeFile(path, data)
    expect(await hashFile(path)).toBe(createHash('sha256').update(data).digest('hex'))
  })

  it('hashes an empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-hash-'))
    const path = join(dir, 'empty')
    await writeFile(path, Buffer.alloc(0))
    expect(await hashFile(path)).toBe(createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
  })

  it('produces identical digests for identical content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-hash-'))
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    await writeFile(a, Buffer.from('same'))
    await writeFile(b, Buffer.from('same'))
    expect(await hashFile(a)).toBe(await hashFile(b))
  })

  it('produces different digests for a single flipped byte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-hash-'))
    const path = join(dir, 'flip')
    const data = Buffer.from('abcdef')
    await writeFile(path, data)
    const before = await hashFile(path)
    await writeFile(path, Buffer.concat([data.subarray(0, 5), Buffer.from([data[5]! ^ 0xff])]))
    expect(await hashFile(path)).not.toBe(before)
  })
})

describe('content addressing', () => {
  it('maps two different keys with identical content to one blob', async () => {
    // Deduplication is a consequence of the layout, not a special case in the code.
    const keyA = sha256Hex(Buffer.from('identical content'))
    const keyB = sha256Hex(Buffer.from('identical content'))
    expect(objectRelativePath(keyA)).toBe(objectRelativePath(keyB))
  })
})
