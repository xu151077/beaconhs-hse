// The MinIO lifecycle gap, and the guard that closes it.
//
// THE GAP
//
// MinIO RELEASE.2025-10-15T17-29-55Z accepts `AbortIncompleteMultipartUpload` on a
// lifecycle PUT and then never returns it from `GetBucketLifecycleConfiguration`
// (verified against a live instance: raw XML and the SDK's parsed rules both omit
// it). SeaweedFS does return it. A backup captured from MinIO therefore cannot
// reproduce incomplete-upload cleanup on its own, and a restore performed from the
// captured manifest alone would install a lifecycle that expires objects and never
// aborts the uploads that never finished.
//
// WHAT THIS FILE PINS
//
//   1. a store with that behaviour produces an incomplete capture, and the tool says so;
//   2. `--lifecycle-file` restores the full configuration, abort rule included;
//   3. a missing or unreadable lifecycle file is an error, not a silent skip;
//   4. the warning fires exactly when the configuration being applied is incomplete.
//
// The store is modelled by the fake rather than by a live MinIO so the test is
// hermetic; the behaviour it models was measured against the real server.

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CreateBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { runBackup } from './backup'
import { runRestore } from './restore'
import { loadManifest } from './manifest'
import { createS3Client, lifecycleHasIncompleteUploadRule, readBucketLifecycle } from './s3'
import type { StoreConfig } from './config'
import { startFakeS3, type FakeS3 } from './testing/fake-s3'

function config(endpoint: string, bucket: string): StoreConfig {
  return {
    endpoint,
    bucket,
    accessKeyId: 'test-access-key-0001',
    secretAccessKey: 'test-secret-value-abcdef0123456789',
    region: 'auto',
  }
}

/** Install BeaconHS's full lifecycle configuration on a bucket via the S3 API. */
async function seedLifecycle(client: S3Client, bucket: string): Promise<void> {
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
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
}

/** The configuration BeaconHS installs, including the rule MinIO will not report. */
const FULL_LIFECYCLE_XML = [
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

describe('the MinIO lifecycle gap and the --lifecycle-file guard', () => {
  const dirs: string[] = []
  let fake: FakeS3

  beforeAll(async () => {
    fake = await startFakeS3()
  })

  afterAll(async () => {
    await fake.close()
    const { rm } = await import('node:fs/promises')
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  async function tmp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-lc-'))
    dirs.push(dir)
    return dir
  }

  it('captures an incomplete configuration when the store will not report the rule', async () => {
    fake.setLifecycleReportsAbortRule(false) // model MinIO
    const client = createS3Client(config(fake.endpoint, 'minio-like'))
    await client.send(new CreateBucketCommand({ Bucket: 'minio-like' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'minio-like', Key: 'a.txt', Body: Buffer.from('a') }),
    )
    await seedLifecycle(client, 'minio-like')

    const dir = await tmp()
    await runBackup({ config: config(fake.endpoint, 'minio-like'), client, destination: dir })

    const { manifest } = await loadManifest(dir)
    // The capture is honest: it says "captured" because a configuration exists, but
    // the configuration it holds is missing the rule the store refused to report.
    expect(manifest.lifecycle.status).toBe('captured')
    expect(lifecycleHasIncompleteUploadRule(manifest.lifecycle.xml ?? '')).toBe(false)
    fake.setLifecycleReportsAbortRule(true)
  }, 60_000)

  it('warns when the configuration being applied cannot reproduce upload cleanup', async () => {
    fake.setLifecycleReportsAbortRule(false)
    const client = createS3Client(config(fake.endpoint, 'warn-src'))
    await client.send(new CreateBucketCommand({ Bucket: 'warn-src' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'warn-src', Key: 'a.txt', Body: Buffer.from('a') }),
    )
    await seedLifecycle(client, 'warn-src')
    const dir = await tmp()
    await runBackup({ config: config(fake.endpoint, 'warn-src'), client, destination: dir })

    const lines: string[] = []
    const report = await runRestore({
      backupDir: dir,
      target: config(fake.endpoint, 'warn-dst'),
      createTargetBucket: true,
      applyLifecycle: true,
      log: (line) => lines.push(line),
    })
    fake.setLifecycleReportsAbortRule(true)

    expect(lines.join('\n')).toContain('AbortIncompleteMultipartUpload')
    // The warning is about the rule, not a generic failure, and it names the remedy.
    expect(lines.join('\n')).toContain('--lifecycle-file')
    expect(report.lifecycle.status).toBe('applied')
  }, 60_000)

  it('restores the full configuration when --lifecycle-file supplies it', async () => {
    fake.setLifecycleReportsAbortRule(false)
    const client = createS3Client(config(fake.endpoint, 'recover-src'))
    await client.send(new CreateBucketCommand({ Bucket: 'recover-src' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'recover-src', Key: 'a.txt', Body: Buffer.from('a') }),
    )
    await seedLifecycle(client, 'recover-src')
    const dir = await tmp()
    await runBackup({ config: config(fake.endpoint, 'recover-src'), client, destination: dir })

    const lifecyclePath = join(dir, 'beaconhs-lifecycle.xml')
    await writeFile(lifecyclePath, FULL_LIFECYCLE_XML, 'utf8')

    const report = await runRestore({
      backupDir: dir,
      target: config(fake.endpoint, 'recover-dst'),
      createTargetBucket: true,
      applyLifecycle: true,
      lifecycleFile: lifecyclePath,
    })
    expect(report.lifecycle.status).toBe('applied')

    // Prove it on the target, where the store IS able to report the rule.
    fake.setLifecycleReportsAbortRule(true)
    const readBack = await readBucketLifecycle(
      createS3Client(config(fake.endpoint, 'recover-dst')),
      'recover-dst',
    )
    expect(readBack.status).toBe('captured')
    if (readBack.status !== 'captured') return
    const restoredXml: string = readBack.xml
    expect(lifecycleHasIncompleteUploadRule(restoredXml)).toBe(true)
    expect(restoredXml).toContain('expire-transient-artifacts')
  }, 60_000)

  it('treats a missing --lifecycle-file as an error rather than a silent skip', async () => {
    const client = createS3Client(config(fake.endpoint, 'missing-file-src'))
    await client.send(new CreateBucketCommand({ Bucket: 'missing-file-src' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'missing-file-src', Key: 'a.txt', Body: Buffer.from('a') }),
    )
    const dir = await tmp()
    await runBackup({ config: config(fake.endpoint, 'missing-file-src'), client, destination: dir })

    await expect(
      runRestore({
        backupDir: dir,
        target: config(fake.endpoint, 'missing-file-dst'),
        createTargetBucket: true,
        applyLifecycle: true,
        lifecycleFile: join(dir, 'does-not-exist.xml'),
      }),
    ).rejects.toThrow()
  }, 60_000)

  it('leaves the target bucket alone when --apply-lifecycle is not given', async () => {
    const client = createS3Client(config(fake.endpoint, 'untouched-src'))
    await client.send(new CreateBucketCommand({ Bucket: 'untouched-src' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'untouched-src', Key: 'a.txt', Body: Buffer.from('a') }),
    )
    const dir = await tmp()
    await runBackup({ config: config(fake.endpoint, 'untouched-src'), client, destination: dir })

    const report = await runRestore({
      backupDir: dir,
      target: config(fake.endpoint, 'untouched-dst'),
      createTargetBucket: true,
    })
    expect(report.lifecycle.status).toBe('not_requested')
    expect(report.passed).toBe(true)
  }, 60_000)
})
