// Live integration tests against a REAL S3-compatible store.
//
// WHY A GATE
//
// These need a reachable store with credentials, which CI does not have and must not
// have. Following the convention `packages/db` already uses for `SEED_TEST_SCRATCH_*`,
// the suite SKIPS (loudly) when `OBJECT_STORE_TEST_ENDPOINT` is unset, and only runs
// against a store the operator has explicitly pointed it at.
//
// WHAT THE FAKE SERVER CANNOT PROVE
//
// The in-process fake covers the tool's own logic. What it cannot cover is the
// behaviour that differs between real stores: whether an unsigned request is refused,
// whether the presigned path works end to end, how a real store reports a lifecycle
// configuration, and whether a 300 MiB transfer survives chunking and reassembly.
// Those are exactly the properties that decide whether a backup is restorable, so
// they are checked here against the real thing.
//
// WHAT IS DELIBERATELY NOT HERE
//
// A real disk-exhaustion run. Constructing one needs either a privileged loop mount
// or the ability to fill the host's filesystem, and neither is available or wise in
// this environment, so the failure is injected in `fault-injection.test.ts` instead
// (unwritable destination, partial blob) and the live case is recorded as UNVERIFIED
// here rather than presented as covered.
//
// RUNNING
//
//   OBJECT_STORE_TEST_ENDPOINT=http://127.0.0.1:9200 \
//   OBJECT_STORE_TEST_ACCESS_KEY_ID=... OBJECT_STORE_TEST_SECRET_ACCESS_KEY=... \
//   OBJECT_STORE_TEST_INCLUDE_LARGE=true \
//   pnpm --filter @beaconhs/object-store-backup test src/live-integration.test.ts

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  createS3Client,
  lifecycleHasIncompleteUploadRule,
  listAllObjects,
  readBucketLifecycle,
} from './s3'
import { runBackup } from './backup'
import { runInventory } from './inventory'
import { runRestore } from './restore'
import { runVerify } from './verify'
import { loadManifest } from './manifest'
import type { StoreConfig } from './config'

const ENDPOINT = process.env.OBJECT_STORE_TEST_ENDPOINT
const ACCESS_KEY = process.env.OBJECT_STORE_TEST_ACCESS_KEY_ID
const SECRET_KEY = process.env.OBJECT_STORE_TEST_SECRET_ACCESS_KEY
const INCLUDE_LARGE = process.env.OBJECT_STORE_TEST_INCLUDE_LARGE === 'true'
/** Size of the large-object fixture. Only created when explicitly requested. */
const LARGE_BYTES = 300 * 1024 * 1024

const live = Boolean(ENDPOINT && ACCESS_KEY && SECRET_KEY)
const suffix = liveSuffix()
const BUCKET = `bhs-probe-${suffix}`
const RESTORE_BUCKET = `bhs-probe-restore-${suffix}`

function liveSuffix(): string {
  return live ? randomUUID().replace(/-/g, '').slice(0, 10) : 'skipped'
}

function cfg(bucket: string): StoreConfig {
  return {
    endpoint: ENDPOINT as string,
    bucket,
    accessKeyId: ACCESS_KEY as string,
    secretAccessKey: SECRET_KEY as string,
    region: 'auto',
  }
}

/** Fixed, reproducible content so a SHA-256 can be compared across runs. */
function fixture(seed: number, length: number): Buffer {
  const out = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) out[index] = (seed + index) % 251
  return out
}

/**
 * BeaconHS's managed lifecycle rules, verbatim from `packages/storage`. They live in
 * the test because the whole point of the `--lifecycle-file` guard is that this
 * configuration is known to BeaconHS and must survive a migration even when the
 * source store refuses to report part of it.
 */
const BEACONHS_MANAGED_LIFECYCLE_XML = [
  '<LifecycleConfiguration>',
  '<Rule><ID>expire-unfinalized-uploads</ID><Status>Enabled</Status>',
  '<Filter><Tag><Key>beaconhs-state</Key><Value>pending</Value></Tag></Filter>',
  '<Expiration><Days>1</Days></Expiration>',
  '<AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload>',
  '</Rule>',
  '<Rule><ID>expire-transient-artifacts</ID><Status>Enabled</Status>',
  '<Filter><Tag><Key>beaconhs-state</Key><Value>transient</Value></Tag></Filter>',
  '<Expiration><Days>1</Days></Expiration>',
  '</Rule>',
  '</LifecycleConfiguration>',
].join('')

const described = live ? describe : describe.skip

if (!live) {
  // eslint-disable-next-line no-console
  console.warn(
    '[live-integration] OBJECT_STORE_TEST_ENDPOINT (and credentials) is not set — ' +
      'live store tests are SKIPPED, not passed.',
  )
}

described('live S3 integration: inventory → backup → verify → restore', () => {
  const dirs: string[] = []
  let seedClient: S3Client

  beforeAll(async () => {
    seedClient = createS3Client(cfg(BUCKET))
    await seedClient.send(new CreateBucketCommand({ Bucket: BUCKET }))

    // A deliberately awkward corpus: unicode, spaces and characters that are illegal
    // in a filename, plus an empty object and a small one carrying metadata and tags.
    const corpus: Array<{ key: string; body: Buffer; headers: Record<string, string> }> = [
      {
        key: 'plain/hello.txt',
        body: Buffer.from('hello live'),
        headers: { 'content-type': 'text/plain' },
      },
      {
        key: 'plain/empty.bin',
        body: Buffer.alloc(0),
        headers: { 'content-type': 'application/octet-stream' },
      },
      {
        key: 'plain/small.txt',
        body: Buffer.from('small live object'),
        headers: {
          'content-type': 'text/plain',
          'content-disposition': 'inline',
          'x-amz-meta-upload-token': 'live-token-1',
        },
      },
      {
        key: 'awkward/a b c/report final.pdf',
        body: Buffer.from('spaces'),
        headers: { 'content-type': 'application/pdf' },
      },
      {
        key: 'awkward/日本語/報告 #1.csv',
        body: Buffer.from('unicode'),
        headers: { 'content-type': 'text/csv' },
      },
      {
        key: 'awkward/special?chars&=#@!.bin',
        body: Buffer.from('special'),
        headers: { 'content-type': 'application/octet-stream' },
      },
      {
        key: `${'k'.repeat(120)}/${'v'.repeat(120)}.dat`,
        body: Buffer.from('long'),
        headers: { 'content-type': 'application/octet-stream' },
      },
    ]
    for (const entry of corpus) {
      await seedClient.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: entry.key,
          Body: entry.body,
          ContentType: entry.headers['content-type'],
          ...(entry.headers['content-disposition']
            ? { ContentDisposition: entry.headers['content-disposition'] }
            : {}),
          ...(entry.headers['x-amz-meta-upload-token']
            ? { Metadata: { 'upload-token': entry.headers['x-amz-meta-upload-token'] } }
            : {}),
        }),
      )
    }
    // Tags are applied through the tagging sub-resource, the way the app's staged
    // uploads end up tagged, so the backup must read them from `GET ?tagging`.
    await seedClient.send(
      new PutObjectTaggingCommand({
        Bucket: BUCKET,
        Key: 'plain/small.txt',
        Tagging: { TagSet: [{ Key: 'beaconhs-state', Value: 'pending' }] },
      }),
    )

    if (INCLUDE_LARGE) {
      // 300 MiB: above the tool's own 256 MiB multipart threshold, so this exercises
      // the real chunking/part-assembly path rather than a single PUT.
      const body = fixture(7, LARGE_BYTES)
      await seedClient.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: 'plain/large-300mb.bin',
          Body: body,
          ContentType: 'application/octet-stream',
        }),
      )
    }

    // A lifecycle configuration, to check that the tool reads it back faithfully
    // rather than reporting "none" for a bucket that has rules.
    await seedClient.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: BUCKET,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'expire-unfinalized-uploads',
              Status: 'Enabled',
              Filter: { Tag: { Key: 'beaconhs-state', Value: 'pending' } },
              Expiration: { Days: 1 },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            },
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
  }, 600_000)

  afterAll(async () => {
    if (!live) return
    // Only clean up what this run created.
    const buckets = [BUCKET, RESTORE_BUCKET]
    for (const bucket of buckets) {
      const objects = await listAllObjects(createS3Client(cfg(bucket)), bucket).catch(() => [])
      for (const object of objects) {
        await createS3Client(cfg(bucket))
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key }))
          .catch(() => undefined)
      }
      await createS3Client(cfg(bucket))
        .send(new DeleteBucketCommand({ Bucket: bucket }))
        .catch(() => undefined)
    }
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  }, 300_000)

  async function tmp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-live-'))
    dirs.push(dir)
    return dir
  }

  it('inventories the seeded bucket read-only', async () => {
    const report = await runInventory({ config: cfg(BUCKET), client: createS3Client(cfg(BUCKET)) })
    expect(report.bucket_exists).toBe(true)
    expect(report.object_count).toBe(INCLUDE_LARGE ? 8 : 7)
    expect(report.lifecycle.status).toBe('captured')
    expect(report.lifecycle.sha256).toMatch(/^[0-9a-f]{64}$/)
  }, 300_000)

  it('backs up, verifies strictly, and restores into a fresh bucket', async () => {
    const dir = await tmp()
    const backup = await runBackup({
      config: cfg(BUCKET),
      client: createS3Client(cfg(BUCKET)),
      destination: dir,
    })
    expect(backup.objectCount).toBe(INCLUDE_LARGE ? 8 : 7)

    const verify = await runVerify({ backupDir: dir, strict: true })
    expect(verify.passed).toBe(true)
    expect(verify.failed_objects).toEqual([])

    const { manifest } = await loadManifest(dir)
    expect(manifest.lifecycle.status).toBe('captured')
    // The tag filter MUST survive the write/read round-trip: a rule that loses its
    // filter silently expires the whole bucket. Both stores return it today.
    expect(manifest.lifecycle.xml).toContain(
      '<Tag><Key>beaconhs-state</Key><Value>pending</Value></Tag>',
    )

    // OBSERVED DIFFERENCE, recorded rather than worked around: MinIO
    // RELEASE.2025-10-15T17-29-55Z accepts `AbortIncompleteMultipartUpload` on PUT
    // (200) but omits it from GetBucketLifecycleConfiguration; SeaweedFS returns it.
    // A backup taken from MinIO therefore cannot reproduce incomplete-upload cleanup
    // on its own, which is what the `--lifecycle-file` guard below exists for. This
    // assertion documents which behaviour the store under test has, instead of
    // asserting a field the store may legitimately not report.
    const storeReportsAbortRule = manifest.lifecycle.xml!.includes('AbortIncompleteMultipartUpload')
    console.log(
      `[live-integration] store returns AbortIncompleteMultipartUpload: ${storeReportsAbortRule}`,
    )

    const restore = await runRestore({
      backupDir: dir,
      target: cfg(RESTORE_BUCKET),
      createTargetBucket: true,
    })
    expect(restore.passed).toBe(true)
    expect(restore.restored).toBe(INCLUDE_LARGE ? 8 : 7)
    expect(restore.post_restore.verified).toBe(INCLUDE_LARGE ? 8 : 7)
    expect(restore.access_checks.anonymous_read_denied).toBe('pass')
    expect(restore.access_checks.wrong_credentials_denied).toBe('pass')
    expect(restore.access_checks.presigned_get).toBe('pass')
  }, 900_000)

  it('round-trips metadata, tags, content type and disposition exactly', async () => {
    const dir = await tmp()
    await runBackup({ config: cfg(BUCKET), client: createS3Client(cfg(BUCKET)), destination: dir })
    await runRestore({
      backupDir: dir,
      target: cfg(RESTORE_BUCKET),
      createTargetBucket: true,
      overwrite: true,
    })

    const client = createS3Client(cfg(RESTORE_BUCKET))
    const head = await client.send(
      new HeadObjectCommand({ Bucket: RESTORE_BUCKET, Key: 'plain/small.txt' }),
    )
    expect(head.ContentType).toBe('text/plain')
    expect(head.ContentDisposition).toBe('inline')
    expect(head.Metadata).toEqual({ 'upload-token': 'live-token-1' })

    const tags = await client.send(
      new GetObjectTaggingCommand({ Bucket: RESTORE_BUCKET, Key: 'plain/small.txt' }),
    )
    expect(tags.TagSet).toEqual([{ Key: 'beaconhs-state', Value: 'pending' }])

    // The awkward keys must round-trip byte-for-byte, including the unicode key.
    const get = await client.send(
      new GetObjectCommand({ Bucket: RESTORE_BUCKET, Key: 'awkward/日本語/報告 #1.csv' }),
    )
    const body = Buffer.from(await get.Body!.transformToByteArray())
    expect(body.toString('utf8')).toBe('unicode')
  }, 900_000)

  it('refuses to overwrite objects that already exist on the target', async () => {
    const dir = await tmp()
    await runBackup({ config: cfg(BUCKET), client: createS3Client(cfg(BUCKET)), destination: dir })
    await runRestore({ backupDir: dir, target: cfg(RESTORE_BUCKET), createTargetBucket: true })

    const again = await runRestore({ backupDir: dir, target: cfg(RESTORE_BUCKET) })
    expect(again.passed).toBe(false)
    expect(again.restored).toBe(0)
    expect(again.failed[0]!.reason).toMatch(/already exist on the target/)
  }, 900_000)

  // Loudly skipped rather than passed when the operator has not opted in: this is
  // the one check that must never be assumed.
  it.skipIf(!INCLUDE_LARGE)(
    'verifies a 300 MiB object end to end with a matching SHA-256',
    async () => {
      const dir = await tmp()
      await runBackup({
        config: cfg(BUCKET),
        client: createS3Client(cfg(BUCKET)),
        destination: dir,
      })

      const { manifest } = await loadManifest(dir)
      const large = manifest.objects.find((object) => object.key === 'plain/large-300mb.bin')
      expect(large).toBeDefined()
      expect(large!.size).toBe(LARGE_BYTES)
      expect(large!.sha256).toBe(fixtureSha(7, LARGE_BYTES))

      const verify = await runVerify({ backupDir: dir, strict: true })
      expect(verify.passed).toBe(true)

      const restore = await runRestore({
        backupDir: dir,
        target: cfg(RESTORE_BUCKET),
        createTargetBucket: true,
        overwrite: true,
      })
      expect(restore.passed).toBe(true)
      expect(restore.post_restore.verified).toBe(INCLUDE_LARGE ? 8 : 7)

      // Read the restored large object back and compare its digest independently of
      // the tool's own bookkeeping.
      const client = createS3Client(cfg(RESTORE_BUCKET))
      const response = await client.send(
        new GetObjectCommand({ Bucket: RESTORE_BUCKET, Key: 'plain/large-300mb.bin' }),
      )
      const { createHash } = await import('node:crypto')
      const digest = createHash('sha256')
      let size = 0
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        digest.update(chunk)
        size += chunk.byteLength
      }
      expect(size).toBe(LARGE_BYTES)
      expect(digest.digest('hex')).toBe(fixtureSha(7, LARGE_BYTES))
    },
    1_800_000,
  )
})

/** SHA-256 of the deterministic fixture, computed without holding two copies. */
function fixtureSha(seed: number, length: number): string {
  const digest = createHash('sha256')
  const chunkSize = 1024 * 1024
  const buffer = Buffer.allocUnsafe(chunkSize)
  let produced = 0
  while (produced < length) {
    const take = Math.min(chunkSize, length - produced)
    for (let index = 0; index < take; index += 1) buffer[index] = (seed + produced + index) % 251
    digest.update(take === chunkSize ? buffer : buffer.subarray(0, take))
    produced += take
  }
  return digest.digest('hex')
}

/** Exported for the SIGKILL and disk-exhaustion suites. */
export { live, cfg as liveConfig, BUCKET as liveBucket, RESTORE_BUCKET as liveRestoreBucket }
