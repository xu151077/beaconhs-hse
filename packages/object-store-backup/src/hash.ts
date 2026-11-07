// Streaming SHA-256 and the on-disk layout for backed-up objects.
//
// WHY THE STORE IS CONTENT-ADDRESSED
//
// The obvious layout mirrors object keys as file paths. It is the wrong choice
// here, for three concrete reasons that all show up in real buckets:
//
//   1. TRAVERSAL. An S3 key is an arbitrary UTF-8 string. `../`, `..`, a leading
//      `/`, a Windows drive letter or a NUL byte are all legal key material, and a
//      naive `path.join(dir, key)` turns any of them into a write outside the
//      backup directory. Encoding each segment closes that, but only if the encoder
//      is provably injective.
//   2. ILLEGAL AND OVERLONG NAMES. ext4 caps a component at 255 bytes. An S3 key
//      may be 1024 bytes, so a long key cannot be represented at all without
//      splitting and truncation — and truncation is what creates collisions.
//   3. ENCODING. Keys arrive percent-encoded, with spaces, `#`, `?`, newlines and
//      emoji. Round-tripping them through a filesystem path and back is a source
//      of silent corruption.
//
// Storing each object at `objects/<sha256>` removes all three by construction: the
// path is derived from content the tool itself computed, never from user input.
// The key -> hash mapping lives in the manifest, which is the single source of
// truth for a restore. Identical content is stored once, which is a bonus rather
// than a complication: the manifest records one entry per key, so restore still
// writes every key.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'

export const OBJECT_DIR = 'objects'
export const MANIFEST_NAME = 'manifest.json'
export const CHECKPOINT_NAME = 'checkpoint.json'
/** Format 2: the checkpoint carries object keys and hashes, so it is encrypted. */
export const CHECKPOINT_ENC_NAME = 'checkpoint.json.enc'
export const BUCKET_CONFIG_NAME = 'bucket.json'

/** Hex SHA-256 of a buffer. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Hash a file without loading it into memory.
 *
 * A 5 GiB object must not become a 5 GiB Buffer. The file is streamed in 1 MiB
 * chunks; peak memory is the chunk, not the object.
 */
export async function hashFile(path: string, chunkSize = 1024 * 1024): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(chunkSize)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, null)
      if (bytesRead === 0) break
      hash.update(bytesRead === chunkSize ? buffer : buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** Relative path of an object inside the backup directory. */
export function objectRelativePath(sha256: string): string {
  return `${OBJECT_DIR}/${sha256}`
}

/** Feed a Node stream into a SHA-256 while writing it to an open file handle. */
export async function pumpAndHash(
  stream: AsyncIterable<Uint8Array>,
  write: (chunk: Uint8Array) => unknown,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of stream) {
    const bytes = chunk as Uint8Array
    hash.update(bytes)
    size += bytes.byteLength
    await write(bytes)
  }
  return { sha256: hash.digest('hex'), size }
}
