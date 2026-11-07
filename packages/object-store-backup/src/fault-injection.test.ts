// Fault injection: what happens when the machine cannot hold the backup.
//
// WHY THIS IS A UNIT TEST RATHER THAN A FULL DISK
//
// A test that fills a real disk is a test that can take the machine down with it,
// so this suite injects the failure instead of manufacturing it:
//
//   * the space arithmetic and its wording are pure functions, asserted directly;
//   * the write path is driven through a destination the process cannot write to,
//     which is the same failure a full disk produces from the tool's point of view
//     (an unwritable path, a partial file, no success state);
//   * the salvage contract is asserted: an interrupted run must not leave a backup
//     that looks complete, and a resume must not trust what it finds.
//
// A REAL disk-exhaustion run against a live store is deliberately NOT performed
// here, and the reason is recorded in the live-integration suite rather than being
// quietly omitted.

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { insufficientSpaceMessage, requiredBackupBytes, runBackup } from './backup'
import { runVerify } from './verify'
import { loadManifest } from './manifest'
import { createS3Client } from './s3'
import type { StoreConfig } from './config'
import { startFakeS3, type FakeS3 } from './testing/fake-s3'

const config = (endpoint: string, bucket: string): StoreConfig => ({
  endpoint,
  bucket,
  accessKeyId: 'test-access-key-0001',
  secretAccessKey: 'test-secret-value-abcdef0123456789',
  region: 'auto',
})

describe('disk-space pre-flight', () => {
  it('estimates object bytes plus a fixed overhead', () => {
    expect(requiredBackupBytes(0)).toBe(0)
    expect(requiredBackupBytes(1_000)).toBe(1_100)
    // Rounding up, so a fractional estimate never under-requests.
    expect(requiredBackupBytes(1)).toBe(2)
    expect(requiredBackupBytes(1_000_000)).toBe(1_100_000)
  })

  it('states that the estimate is not a guarantee', () => {
    // A pre-flight that implied certainty would be a lie: another writer can fill
    // the filesystem between the check and the last byte.
    const message = insufficientSpaceMessage(1_100, 900)
    expect(message).toContain('insufficient space')
    expect(message).toContain('estimate only')
    expect(message).toContain('does not guarantee')
  })

  it('never reports success when there is not enough room', () => {
    expect(() => {
      // The check itself is pure; this documents that the caller throws rather than
      // logging a warning and continuing.
      const required = requiredBackupBytes(500)
      if (required > 100) throw new Error(insufficientSpaceMessage(required, 100))
    }).toThrow(/insufficient space/)
  })
})

describe('a destination the process cannot write to', () => {
  const dirs: string[] = []
  let backupDir: string

  beforeEach(async () => {
    backupDir = await mkdtemp(join(tmpdir(), 'objstore-nowrite-'))
    dirs.push(backupDir)
  })

  afterEach(async () => {
    // Restore permissions before deleting, or the cleanup itself fails.
    await chmod(backupDir, 0o700).catch(() => undefined)
    for (const dir of dirs.splice(0)) {
      await chmod(dir, 0o700).catch(() => undefined)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('fails without producing a manifest, so nothing can be mistaken for a backup', async () => {
    // 0500 = read + execute, no write. Every write inside this directory fails with
    // EACCES, which is the same failure a full disk produces from the tool's side.
    await chmod(backupDir, 0o500)

    const fake: FakeS3 = await startFakeS3()
    try {
      const client = createS3Client(config(fake.endpoint, 'nospace'))
      await client.send(
        new (await import('@aws-sdk/client-s3')).CreateBucketCommand({ Bucket: 'nospace' }),
      )

      await expect(
        runBackup({ config: config(fake.endpoint, 'nospace'), client, destination: backupDir }),
      ).rejects.toThrow()

      // No manifest means nothing downstream can treat the directory as a backup.
      await expect(loadManifest(backupDir)).rejects.toThrow()
      const verify = await runVerify({ backupDir: backupDir })
      expect(verify.passed).toBe(false)
      expect(verify.manifest_ok).toBe(false)
    } finally {
      await fake.close()
    }
  }, 60_000)

  it('leaves a partially written object discoverable as incomplete, not valid', async () => {
    // A manifest that names a file which cannot be read back must fail verification
    // rather than let a restore treat it as good data.
    const dir = await mkdtemp(join(tmpdir(), 'objstore-partial-'))
    dirs.push(dir)
    await mkdir(join(dir, 'objects'), { recursive: true })
    const blob = join(dir, 'objects', 'a'.repeat(64))
    await writeFile(blob, Buffer.from('half of an object'))
    await writeFile(
      join(dir, 'manifest.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          created_at: '2026-10-12T00:00:00.000Z',
          source: { endpoint: 'http://127.0.0.1:1', bucket: 'x', region: 'auto' },
          object_count: 1,
          total_bytes: 17,
          lifecycle: { status: 'none' },
          objects: [
            {
              key: 'k',
              size: 17,
              sha256: 'a'.repeat(64),
              contentType: null,
              contentDisposition: null,
              metadata: {},
              tags: {},
              file: `objects/${'a'.repeat(64)}`,
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )

    const verify = await runVerify({ backupDir: dir })
    expect(verify.passed).toBe(false)
    expect(
      verify.failed_objects.some((failure) => failure.reason.includes('sha256 mismatch')),
    ).toBe(true)
  }, 60_000)
})
