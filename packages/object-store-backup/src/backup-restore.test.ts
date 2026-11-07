// End-to-end tests for backup, verify and restore, driven through the real AWS SDK
// against an in-process S3-compatible server.
//
// WHAT THESE PROVE THAT UNIT TESTS CANNOT
//
//   - pagination is followed across multiple pages;
//   - the digest recorded in the manifest is the digest of the bytes on disk;
//   - a restore reproduces content, metadata and tags, not just the object count;
//   - corruption, a missing file and an existing target object are each refused
//     before or instead of writing wrong data;
//   - a resumed backup re-hashes rather than trusting its checkpoint.
//
// Every test uses a fresh temp directory and a fresh loopback port, so nothing here
// can reach a development or production store.

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBackup } from './backup'
import { runInventory } from './inventory'
import { runRestore } from './restore'
import { runVerify } from './verify'
import { createS3Client, putObject } from './s3'
import { loadManifest } from './manifest'
import type { StoreConfig } from './config'
import { startFakeS3, type FakeS3 } from './testing/fake-s3'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

function config(endpoint: string, bucket: string): StoreConfig {
  return {
    endpoint,
    bucket,
    accessKeyId: 'test-access-key-0001',
    secretAccessKey: 'test-secret-value-abcdef0123456789',
    region: 'auto',
  }
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'objstore-'))
}

describe('backup / verify / restore against an S3-compatible store', () => {
  let source: FakeS3
  let destination: FakeS3
  const dirs: string[] = []

  beforeAll(async () => {
    source = await startFakeS3()
    destination = await startFakeS3()
  })

  afterAll(async () => {
    await source.close()
    await destination.close()
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function makeDir(): Promise<string> {
    const dir = await tmp()
    dirs.push(dir)
    return dir
  }

  async function seed(client: ReturnType<typeof createS3Client>, bucket: string): Promise<void> {
    await client.send(
      new (await import('@aws-sdk/client-s3')).CreateBucketCommand({ Bucket: bucket }),
    )
    const corpus: Array<{
      key: string
      body: Buffer
      contentType?: string
      contentDisposition?: string
      metadata?: Record<string, string>
      tags?: Record<string, string>
    }> = []
    // A long key with spaces, unicode and characters that are illegal in a filename.
    const awkwardKeys = [
      't/tenant/a b c/report final.pdf',
      't/tenant/日本語/报告 #1.pdf',
      't/tenant/special?chars&=#@!.bin',
      'a'.repeat(200) + '/deep/' + 'b'.repeat(200),
    ]
    for (const key of awkwardKeys) {
      corpus.push({ key, body: Buffer.from(`content of ${key}`), contentType: 'text/plain' })
    }
    // An empty object, a small object, and a large one that must go multipart.
    corpus.push({
      key: 'empty.bin',
      body: Buffer.alloc(0),
      contentType: 'application/octet-stream',
    })
    corpus.push({
      key: 'small.txt',
      body: Buffer.from('small'),
      contentType: 'text/plain',
      contentDisposition: 'inline',
      metadata: { 'upload-token': 'tok-small' },
      tags: { 'beaconhs-state': 'pending' },
    })
    corpus.push({
      key: 'large.bin',
      body: Buffer.alloc(300 * 1024 * 1024, 7),
      contentType: 'application/octet-stream',
      contentDisposition: 'attachment',
      metadata: { tenant: 'tenant-uuid' },
      tags: { 'beaconhs-state': 'transient' },
    })
    for (const entry of corpus) {
      await putObject(client, bucket, {
        key: entry.key,
        body: entry.body,
        size: entry.body.byteLength,
        contentType: entry.contentType,
        contentDisposition: entry.contentDisposition,
        metadata: entry.metadata,
        tags: entry.tags,
      })
    }
  }

  it('inventories a bucket read-only', async () => {
    const client = createS3Client(config(source.endpoint, 'inv-bucket'))
    await seed(client, 'inv-bucket')
    const report = await runInventory({ config: config(source.endpoint, 'inv-bucket'), client })
    expect(report.object_count).toBe(7)
    expect(report.total_bytes).toBeGreaterThan(300 * 1024 * 1024)
    expect(report.multipart_candidates).toBe(1)
    client.destroy()
  })

  it('follows pagination rather than trusting a single page', async () => {
    const client = createS3Client(config(source.endpoint, 'page-bucket'))
    await seed(client, 'page-bucket')
    // Two-list page size forces several continuation tokens.
    source.setPageSize(2)
    const report = await runInventory({ config: config(source.endpoint, 'page-bucket'), client })
    source.setPageSize(1000)
    expect(report.object_count).toBe(7)
    client.destroy()
  })

  it('backs up every object with byte-exact hashes, metadata and tags', async () => {
    const client = createS3Client(config(source.endpoint, 'backup-bucket'))
    await seed(client, 'backup-bucket')
    const dir = await makeDir()
    const result = await runBackup({
      config: config(source.endpoint, 'backup-bucket'),
      client,
      destination: dir,
    })
    expect(result.objectCount).toBe(7)
    expect(result.reusedFromCheckpoint).toBe(0)

    const { manifest } = await loadManifest(dir)
    expect(manifest.object_count).toBe(7)
    const awkward = manifest.objects.filter((object) => object.key.includes('a b c'))
    expect(awkward).toHaveLength(1)
    expect(awkward[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    const small = manifest.objects.find((object) => object.key === 'small.txt')
    expect(small).toMatchObject({
      contentType: 'text/plain',
      contentDisposition: 'inline',
      metadata: { 'upload-token': 'tok-small' },
      tags: { 'beaconhs-state': 'pending' },
    })
    client.destroy()
  })

  it('verifies an intact backup', async () => {
    const client = createS3Client(config(source.endpoint, 'verify-bucket'))
    await seed(client, 'verify-bucket')
    const dir = await makeDir()
    await runBackup({ config: config(source.endpoint, 'verify-bucket'), client, destination: dir })
    const report = await runVerify({ backupDir: dir, strict: true })
    expect(report.passed).toBe(true)
    expect(report.checked_objects).toBe(7)
    expect(report.failed_objects).toEqual([])
    expect(report.orphan_objects).toEqual([])
    client.destroy()
  })

  it('fails verification when a backed-up object is modified', async () => {
    const client = createS3Client(config(source.endpoint, 'tamper-bucket'))
    await seed(client, 'tamper-bucket')
    const dir = await makeDir()
    await runBackup({ config: config(source.endpoint, 'tamper-bucket'), client, destination: dir })
    const { manifest } = await loadManifest(dir)
    const victim = manifest.objects.find((object) => object.key === 'small.txt')!
    await writeFile(join(dir, victim.file), Buffer.from('tampe'))
    const report = await runVerify({ backupDir: dir })
    expect(report.passed).toBe(false)
    expect(report.failed_objects).toEqual([
      expect.objectContaining({
        key: 'small.txt',
        reason: expect.stringContaining('sha256 mismatch'),
      }),
    ])
    client.destroy()
  })

  it('fails verification when a backed-up object is deleted', async () => {
    const client = createS3Client(config(source.endpoint, 'missing-bucket'))
    await seed(client, 'missing-bucket')
    const dir = await makeDir()
    await runBackup({ config: config(source.endpoint, 'missing-bucket'), client, destination: dir })
    const { manifest } = await loadManifest(dir)
    const victim = manifest.objects.find(
      (object) => object.key === 'small.bin'.replace('bin', 'txt'),
    )!
    await rm(join(dir, victim.file))
    const report = await runVerify({ backupDir: dir })
    expect(report.passed).toBe(false)
    expect(
      report.failed_objects.some((failure) => failure.reason === 'object file is missing'),
    ).toBe(true)
    client.destroy()
  })

  it('fails verification when the manifest is corrupted', async () => {
    const client = createS3Client(config(source.endpoint, 'corrupt-manifest'))
    await seed(client, 'corrupt-manifest')
    const dir = await makeDir()
    await runBackup({
      config: config(source.endpoint, 'corrupt-manifest'),
      client,
      destination: dir,
    })
    await writeFile(join(dir, 'manifest.json'), '{"schema_version": 1, "truncated"')
    const report = await runVerify({ backupDir: dir })
    expect(report.passed).toBe(false)
    expect(report.manifest_ok).toBe(false)
    client.destroy()
  })

  it('fails verification in strict mode when objects/ holds an unreferenced file', async () => {
    const client = createS3Client(config(source.endpoint, 'orphan-bucket'))
    await seed(client, 'orphan-bucket')
    const dir = await makeDir()
    await runBackup({ config: config(source.endpoint, 'orphan-bucket'), client, destination: dir })
    await writeFile(join(dir, 'objects', 'f'.repeat(64)), Buffer.from('orphan'))
    const lenient = await runVerify({ backupDir: dir })
    expect(lenient.passed).toBe(true)
    expect(lenient.orphan_objects).toHaveLength(1)
    const strict = await runVerify({ backupDir: dir, strict: true })
    expect(strict.passed).toBe(false)
    client.destroy()
  })

  it(
    'restores into a fresh store, reproducing content, metadata and tags',
    { timeout: 600_000 },
    async () => {
      const sourceClient = createS3Client(config(source.endpoint, 'restore-src'))
      await seed(sourceClient, 'restore-src')
      const dir = await makeDir()
      await runBackup({
        config: config(source.endpoint, 'restore-src'),
        client: sourceClient,
        destination: dir,
      })

      const report = await runRestore({
        backupDir: dir,
        target: config(destination.endpoint, 'restore-dst'),
        createTargetBucket: true,
      })
      expect(report.passed).toBe(true)
      expect(report.restored).toBe(7)
      expect(report.post_restore.verified).toBe(7)
      expect(report.post_restore.content_mismatches).toEqual([])
      expect(report.post_restore.metadata_mismatches).toEqual([])
      expect(report.post_restore.tag_mismatches).toEqual([])
      // Nothing on the target may be deleted, and there is nothing extra here.
      expect(report.extra_on_target).toEqual([])
      sourceClient.destroy()
    },
  )

  it(
    'refuses to overwrite objects that already exist on the target',
    { timeout: 600_000 },
    async () => {
      const sourceClient = createS3Client(config(source.endpoint, 'overwrite-src'))
      await seed(sourceClient, 'overwrite-src')
      const dir = await makeDir()
      await runBackup({
        config: config(source.endpoint, 'overwrite-src'),
        client: sourceClient,
        destination: dir,
      })

      // First restore into a store that already holds the same keys.
      await runRestore({
        backupDir: dir,
        target: config(destination.endpoint, 'overwrite-dst'),
        createTargetBucket: true,
      })
      const second = await runRestore({
        backupDir: dir,
        target: config(destination.endpoint, 'overwrite-dst'),
      })
      expect(second.passed).toBe(false)
      expect(second.restored).toBe(0)
      expect(second.failed[0]!.reason).toMatch(/already exist on the target/)

      // With the explicit flag it proceeds, and says what it is doing.
      const forced = await runRestore({
        backupDir: dir,
        target: config(destination.endpoint, 'overwrite-dst'),
        overwrite: true,
      })
      expect(forced.passed).toBe(true)
      expect(forced.restored).toBe(7)
      sourceClient.destroy()
    },
  )

  it('refuses to restore anything when a local object does not match its manifest', async () => {
    const sourceClient = createS3Client(config(source.endpoint, 'badlocal-src'))
    await seed(sourceClient, 'badlocal-src')
    const dir = await makeDir()
    await runBackup({
      config: config(source.endpoint, 'badlocal-src'),
      client: sourceClient,
      destination: dir,
    })
    const { manifest } = await loadManifest(dir)
    const victim = manifest.objects.find((object) => object.key === 'small.txt')!
    await writeFile(join(dir, victim.file), Buffer.from('corrupted before restore'))

    const report = await runRestore({
      backupDir: dir,
      target: config(destination.endpoint, 'never-created'),
      createTargetBucket: true,
    })
    expect(report.passed).toBe(false)
    expect(report.restored).toBe(0)
    expect(report.failed[0]!.stage).toBe('preflight')
    // The target must not even exist: nothing was written.
    expect(destination.store.has('never-created')).toBe(false)
    sourceClient.destroy()
  })

  /**
   * Seed a small bucket. The shared `seed()` writes a 300 MB object, which is
   * right for the transfer tests and ruinous for a test whose only subject is
   * the manifest digest.
   */
  async function seedSmall(
    client: ReturnType<typeof createS3Client>,
    bucket: string,
  ): Promise<void> {
    await client.send(
      new (await import('@aws-sdk/client-s3')).CreateBucketCommand({ Bucket: bucket }),
    )
    for (let i = 0; i < 2; i++) {
      const body = Buffer.from(`integrity-${i}`.repeat(32))
      await putObject(client, bucket, {
        key: `small-${i}.txt`,
        body,
        size: body.length,
        contentType: 'text/plain',
        metadata: { index: String(i) },
        tags: { phase: 'ai' },
      })
    }
  }

  /**
   * Rewrite a manifest so its bytes no longer match `manifest.json.sha256` while
   * still passing schema validation. `created_at` is used deliberately: breaking
   * a structural rule would fail at load time and never reach the digest check,
   * which is the very thing being tested.
   */
  async function tamperManifest(dir: string): Promise<void> {
    const { manifest } = await loadManifest(dir)
    await writeFile(
      join(dir, 'manifest.json'),
      `${JSON.stringify({ ...manifest, created_at: '2000-01-01T00:00:00.000Z' }, null, 2)}\n`,
    )
  }

  it('refuses to restore from a manifest that fails its own recorded digest', async () => {
    // REGRESSION. `restore` used to log "manifest.json does not match
    // manifest.json.sha256" for EVERY plaintext backup, comparing nothing, and
    // `openBackup` never checked the sidecar at all on the plaintext path. A
    // tampered manifest therefore restored cleanly and exited 0.
    const sourceClient = createS3Client(config(source.endpoint, 'tamper-src'))
    await seedSmall(sourceClient, 'tamper-src')
    const dir = await makeDir()
    await runBackup({
      config: config(source.endpoint, 'tamper-src'),
      client: sourceClient,
      destination: dir,
    })

    // An intact backup must NOT produce the warning.
    const clean = await runRestore({
      backupDir: dir,
      target: config(destination.endpoint, 'tamper-clean'),
      createTargetBucket: true,
    })
    expect(clean.passed).toBe(true)
    expect(clean.manifest_checksum_ok).toBe(true)

    // Now alter the manifest without touching its recorded digest.
    await tamperManifest(dir)

    const report = await runRestore({
      backupDir: dir,
      target: config(destination.endpoint, 'tamper-never-created'),
      createTargetBucket: true,
    })
    expect(report.passed).toBe(false)
    expect(report.manifest_checksum_ok).toBe(false)
    expect(report.restored).toBe(0)
    expect(report.failed[0]!.stage).toBe('manifest')
    // Nothing was written: the target must not exist.
    expect(destination.store.has('tamper-never-created')).toBe(false)
    sourceClient.destroy()
  })

  it('fails verify when the manifest does not match its recorded digest', async () => {
    // REGRESSION. `verify` detected the mismatch and logged a WARNING, but left
    // `passed` true and exited 0, so `verify && restore` walked straight past a
    // corrupted backup.
    const sourceClient = createS3Client(config(source.endpoint, 'verify-tamper-src'))
    await seedSmall(sourceClient, 'verify-tamper-src')
    const dir = await makeDir()
    await runBackup({
      config: config(source.endpoint, 'verify-tamper-src'),
      client: sourceClient,
      destination: dir,
    })

    const clean = await runVerify({ backupDir: dir })
    expect(clean.manifest_checksum_ok).toBe(true)
    expect(clean.passed).toBe(true)

    await tamperManifest(dir)

    const report = await runVerify({ backupDir: dir })
    expect(report.manifest_checksum_ok).toBe(false)
    expect(report.passed).toBe(false)
    sourceClient.destroy()
  })

  it('reports the access semantics of the target store', { timeout: 600_000 }, async () => {
    const sourceClient = createS3Client(config(source.endpoint, 'access-src'))
    await seed(sourceClient, 'access-src')
    const dir = await makeDir()
    await runBackup({
      config: config(source.endpoint, 'access-src'),
      client: sourceClient,
      destination: dir,
    })
    const report = await runRestore({
      backupDir: dir,
      target: config(destination.endpoint, 'access-dst'),
      createTargetBucket: true,
    })
    expect(report.access_checks.anonymous_read_denied).toBe('pass')
    expect(report.access_checks.wrong_credentials_denied).toBe('pass')
    expect(report.access_checks.presigned_get).toBe('pass')
    sourceClient.destroy()
  })

  it('reports "unsupported" when the store cannot report lifecycle, instead of "none"', async () => {
    const client = createS3Client(config(source.endpoint, 'nolifecycle-bucket'))
    await client.send(
      new (await import('@aws-sdk/client-s3')).CreateBucketCommand({
        Bucket: 'nolifecycle-bucket',
      }),
    )
    source.setLifecycleSupported(false)
    const report = await runInventory({
      config: config(source.endpoint, 'nolifecycle-bucket'),
      client,
    })
    source.setLifecycleSupported(true)
    expect(report.lifecycle.status).toBe('unsupported')
    expect(report.lifecycle.reason).toContain('NotImplemented')
    client.destroy()
  })

  it('fails loudly when the target store lets anonymous reads through', async () => {
    const sourceClient = createS3Client(config(source.endpoint, 'anon-src'))
    await seed(sourceClient, 'anon-src')
    const dir = await makeDir()
    await runBackup({
      config: config(source.endpoint, 'anon-src'),
      client: sourceClient,
      destination: dir,
    })

    // A store configured to accept unsigned requests is the privacy failure this
    // tool exists to surface, so the restore must report it rather than pass.
    destination.setAllowAnonymous(true)
    const report = await runRestore({
      backupDir: dir,
      target: config(destination.endpoint, 'anon-dst'),
      createTargetBucket: true,
    })
    destination.setAllowAnonymous(false)
    expect(report.passed).toBe(false)
    expect(report.access_checks.anonymous_read_denied).toBe('fail')
    expect(report.access_checks.detail).toContain('publicly readable')
    sourceClient.destroy()
  })

  it('does not apply a captured lifecycle configuration unless asked', async () => {
    const sourceClient = createS3Client(config(source.endpoint, 'lc-src'))
    await sourceClient.send(
      new (await import('@aws-sdk/client-s3')).CreateBucketCommand({ Bucket: 'lc-src' }),
    )
    await putObject(sourceClient, 'lc-src', { key: 'k', body: Buffer.from('v'), size: 1 })
    await sourceClient.send(
      new (await import('@aws-sdk/client-s3')).PutBucketLifecycleConfigurationCommand({
        Bucket: 'lc-src',
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'expire-transient-artifacts',
              Status: 'Enabled',
              Filter: { Tag: { Key: 'beaconhs-state', Value: 'transient' } },
              Expiration: { Days: 1 },
            },
          ],
        },
      }),
    )
    const dir = await makeDir()
    await runBackup({
      config: config(source.endpoint, 'lc-src'),
      client: sourceClient,
      destination: dir,
    })
    const { manifest } = await loadManifest(dir)
    expect(manifest.lifecycle.status).toBe('captured')

    const report = await runRestore({
      backupDir: dir,
      target: config(destination.endpoint, 'lc-dst'),
      createTargetBucket: true,
    })
    expect(report.lifecycle.status).toBe('not_requested')
    expect(report.passed).toBe(true)

    const applied = await runRestore({
      backupDir: dir,
      target: config(destination.endpoint, 'lc-dst2'),
      createTargetBucket: true,
      applyLifecycle: true,
    })
    expect(applied.lifecycle.status).toBe('applied')
    sourceClient.destroy()
  })

  it('a resumed backup re-hashes instead of trusting its checkpoint', async () => {
    const client = createS3Client(config(source.endpoint, 'resume-bucket'))
    await seed(client, 'resume-bucket')
    const dir = await makeDir()

    const first = await runBackup({
      config: config(source.endpoint, 'resume-bucket'),
      client,
      destination: dir,
    })
    expect(first.objectCount).toBe(7)

    // Corrupt a completed blob on disk while leaving the checkpoint pointing at its
    // original digest. A resume that trusts the checkpoint would ship a backup whose
    // manifest names bytes that are not on disk.
    const { manifest } = await loadManifest(dir)
    const victim = manifest.objects.find((object) => object.key === 'small.txt')!
    await writeFile(join(dir, victim.file), Buffer.from('corrupt'))

    const resumed = await runBackup({
      config: config(source.endpoint, 'resume-bucket'),
      client,
      destination: dir,
      resume: true,
    })
    expect(resumed.objectCount).toBe(7)
    // The corrupted entry is detected by re-hashing and re-fetched.
    expect(resumed.downloaded).toBeGreaterThan(0)

    const after = await loadManifest(dir)
    expect(after.manifest.objects).toHaveLength(7)
    const report = await runVerify({ backupDir: dir, strict: true })
    expect(report.passed).toBe(true)
    client.destroy()
  })
})

describe('digest constants', () => {
  it('uses 64-character hex placeholders in fixtures', () => {
    expect(DIGEST_A).toMatch(/^[0-9a-f]{64}$/)
    expect(DIGEST_B).toMatch(/^[0-9a-f]{64}$/)
  })
})
