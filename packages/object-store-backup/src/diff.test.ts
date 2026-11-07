// `inventory --diff`: what changed, and what the tool honestly cannot tell.
//
// The properties worth pinning are the REFUSALS and the honest "I don't know":
//
//   * a manifest with no trusted content hash on the current side yields UNKNOWN,
//     never UNCHANGED;
//   * equal content but changed metadata/tags is MODIFIED;
//   * an ETag is never consulted, let alone treated as a SHA-256;
//   * two different buckets are refused outright;
//   * a broken baseline manifest fails the run;
//   * the report is written atomically, so an interrupt cannot leave a half file;
//   * nothing in this file performs a single write against a store.

import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { computeDiff, runDiff, type Side } from './diff'
import { MANIFEST_SCHEMA_VERSION, type Manifest } from './manifest'
import { MANIFEST_NAME } from './hash'
import { createS3Client } from './s3'
import { startFakeS3, type FakeS3 } from './testing/fake-s3'

function baseObject(
  overrides: Partial<Manifest['objects'][number]> = {},
): Manifest['objects'][number] {
  return {
    key: 'a.txt',
    size: 5,
    sha256: 'a'.repeat(64),
    contentType: 'text/plain',
    contentDisposition: null,
    metadata: {},
    tags: {},
    file: `objects/${'a'.repeat(64)}`,
    ...overrides,
  }
}

function manifestOf(objects: Manifest['objects'], bucket = 'b'): Manifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    created_at: '2026-10-12T00:00:00.000Z',
    source: { endpoint: 'http://127.0.0.1:1', bucket, region: 'auto' },
    object_count: objects.length,
    total_bytes: objects.reduce((sum, o) => sum + o.size, 0),
    lifecycle: { status: 'none' },
    objects,
  }
}

function sideOf(
  entries: Array<
    [
      string,
      {
        size: number
        sha256?: string
        metadata?: Record<string, string>
        tags?: Record<string, string>
      },
    ]
  >,
): Side {
  return {
    endpoint: 'http://127.0.0.1:1',
    bucket: 'b',
    created_at: '2026-10-12T00:00:00.000Z',
    entries: new Map(entries),
  }
}

describe('diff classification', () => {
  it('classifies added, deleted and unchanged', () => {
    const base = sideOf([
      ['keep.txt', { size: 5, sha256: 'a'.repeat(64) }],
      ['gone.txt', { size: 5, sha256: 'b'.repeat(64) }],
    ])
    const cur = sideOf([
      ['keep.txt', { size: 5, sha256: 'a'.repeat(64) }],
      ['new.txt', { size: 5, sha256: 'c'.repeat(64) }],
    ])
    const r = computeDiff({
      baseSide: base,
      currentSide: cur,
      currentHasContent: true,
      baseManifestDigest: 'd'.repeat(64),
    })
    expect(r.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 1, unknown: 0 })
    expect(r.objects.find((o) => o.key === 'new.txt')!.class).toBe('ADDED')
    expect(r.objects.find((o) => o.key === 'gone.txt')!.class).toBe('DELETED')
  })

  it('marks same-size objects UNKNOWN when the current side has no content hash', () => {
    const base = sideOf([['x.bin', { size: 10, sha256: 'a'.repeat(64) }]])
    const cur = sideOf([['x.bin', { size: 10 }]]) // live inventory: no hash
    const r = computeDiff({
      baseSide: base,
      currentSide: cur,
      currentHasContent: false,
      baseManifestDigest: 'd'.repeat(64),
    })
    expect(r.counts.unknown).toBe(1)
    expect(r.counts.unchanged).toBe(0)
    expect(r.content_comparison_authoritative).toBe(false)
    expect(r.notes.join(' ')).toContain('UNKNOWN')
  })

  it('reports MODIFIED, not UNKNOWN, when the size differs', () => {
    const r = computeDiff({
      baseSide: sideOf([['x.bin', { size: 10, sha256: 'a'.repeat(64) }]]),
      currentSide: sideOf([['x.bin', { size: 20 }]]),
      currentHasContent: false,
      baseManifestDigest: 'd'.repeat(64),
    })
    expect(r.counts.modified).toBe(1)
    expect(r.objects[0]!.reason).toContain('size differs')
  })

  it('reports MODIFIED when only metadata changes', () => {
    const r = computeDiff({
      baseSide: sideOf([['x.bin', { size: 5, sha256: 'a'.repeat(64), metadata: { a: '1' } }]]),
      currentSide: sideOf([['x.bin', { size: 5, sha256: 'a'.repeat(64), metadata: { a: '2' } }]]),
      currentHasContent: true,
      baseManifestDigest: 'd'.repeat(64),
    })
    expect(r.counts.modified).toBe(1)
    expect(r.objects[0]!.changedAttributes).toEqual(['metadata'])
  })

  it('reports MODIFIED when only tags change', () => {
    const r = computeDiff({
      baseSide: sideOf([['x.bin', { size: 5, sha256: 'a'.repeat(64) }]]),
      currentSide: sideOf([['x.bin', { size: 5, sha256: 'a'.repeat(64), tags: { s: 'pending' } }]]),
      currentHasContent: true,
      baseManifestDigest: 'd'.repeat(64),
    })
    expect(r.objects[0]!.changedAttributes).toEqual(['tags'])
  })

  it('refuses to diff two different buckets', () => {
    const base = sideOf([['x', { size: 1, sha256: 'a'.repeat(64) }]])
    const cur = { ...sideOf([['x', { size: 1, sha256: 'a'.repeat(64) }]]), bucket: 'other' }
    expect(() =>
      computeDiff({
        baseSide: base,
        currentSide: cur,
        currentHasContent: true,
        baseManifestDigest: 'd'.repeat(64),
      }),
    ).toThrow(/different buckets/)
  })

  it('never consults an ETag: a same-size object stays UNKNOWN', () => {
    // The input type has no ETag field at all; this test documents that a caller
    // cannot smuggle one in to force an UNCHANGED classification.
    const r = computeDiff({
      baseSide: sideOf([['x', { size: 3, sha256: 'a'.repeat(64) }]]),
      currentSide: sideOf([['x', { size: 3 }]]),
      currentHasContent: false,
      baseManifestDigest: 'd'.repeat(64),
    })
    expect(r.counts.unknown).toBe(1)
    expect(JSON.stringify(r.objects)).not.toContain('etag')
  })

  it('handles an empty bucket on both sides', () => {
    const r = computeDiff({
      baseSide: sideOf([]),
      currentSide: sideOf([]),
      currentHasContent: true,
      baseManifestDigest: 'd'.repeat(64),
    })
    expect(r.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0, unknown: 0 })
  })
})

describe('runDiff report handling', () => {
  const dirs: string[] = []
  let fake: FakeS3

  beforeEach(async () => {
    fake = await startFakeS3()
  })

  afterEach(async () => {
    await fake.close()
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  async function tmp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-diff-'))
    dirs.push(dir)
    return dir
  }

  it('leaves no half-written report when the publish step fails', async () => {
    const dir = await tmp()
    const backupDir = join(dir, 'baseline')
    await mkdir(backupDir, { recursive: true })
    await writeFile(join(backupDir, MANIFEST_NAME), `${JSON.stringify(manifestOf([]), null, 2)}\n`)

    // Make the final path a directory so the rename of the finished report onto it
    // fails, exactly as an interrupted publish would. Nothing a reader could mistake
    // for a report may appear at that path.
    const outPath = join(dir, 'diff.json')
    await mkdir(outPath)

    await expect(
      runDiff({ baselinePath: backupDir, currentManifestPath: backupDir, outputPath: outPath }),
    ).rejects.toThrow()
    // The final path is still a directory, i.e. no partial JSON was published there.
    expect((await readdir(outPath)).length).toBe(0)
    // The incomplete bytes only ever exist under the .tmp name.
    expect(await readdir(dir)).toContain('diff.json.tmp')
  })

  it('rejects an unusable baseline manifest', async () => {
    const dir = await tmp()
    const broken = join(dir, 'broken')
    await (await import('node:fs/promises')).mkdir(broken, { recursive: true })
    await writeFile(join(broken, MANIFEST_NAME), '{ not json')
    await expect(runDiff({ baselinePath: broken, currentManifestPath: broken })).rejects.toThrow(
      /baseline manifest is unusable/,
    )
  })

  it('marks objects created after the baseline as ADDED against a live store', async () => {
    const { createS3Client } = await import('./s3')
    const { PutObjectCommand, CreateBucketCommand } = await import('@aws-sdk/client-s3')
    const client = createS3Client({
      endpoint: fake.endpoint,
      bucket: 'live',
      accessKeyId: 'test-access-key-0001',
      secretAccessKey: 'test-secret-value-abcdef0123456789',
      region: 'auto',
    })
    await client.send(new CreateBucketCommand({ Bucket: 'live' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'live', Key: 'a.txt', Body: Buffer.from('a') }),
    )

    const dir = await tmp()
    const backupDir = join(dir, 'baseline')
    await mkdir(backupDir, { recursive: true })
    // The baseline describes the same bucket, taken before a.txt existed. A diff
    // across buckets is refused outright, so the sides must name the same one.
    await writeFile(
      join(backupDir, MANIFEST_NAME),
      `${JSON.stringify(manifestOf([], 'live'), null, 2)}\n`,
    )

    const report = await runDiff({
      baselinePath: backupDir,
      client,
      endpoint: fake.endpoint,
      bucket: 'live',
    })
    expect(report.current.mode).toBe('live-inventory')
    expect(report.counts.added).toBe(1)
    expect(report.objects[0]!.key).toBe('a.txt')
    // A live inventory cannot prove content, so the report must not claim authority.
    expect(report.content_comparison_authoritative).toBe(false)
  })

  it('never modifies the store it is diffing against', async () => {
    const client = createS3Client({
      endpoint: fake.endpoint,
      bucket: 'readonly',
      accessKeyId: 'test-access-key-0001',
      secretAccessKey: 'test-secret-value-abcdef0123456789',
      region: 'auto',
    })
    await client.send(new CreateBucketCommand({ Bucket: 'readonly' }))
    await client.send(
      new PutObjectCommand({
        Bucket: 'readonly',
        Key: 'stay.txt',
        Body: Buffer.from('original-body'),
      }),
    )

    const dir = await tmp()
    const backupDir = join(dir, 'baseline')
    await mkdir(backupDir, { recursive: true })
    // The baseline lists a key the store does not have, so the diff must report it
    // DELETED — the classification that would drive a delete if anyone ever acted on it.
    const base = manifestOf(
      [
        {
          key: 'stay.txt',
          size: 14,
          sha256: 'a'.repeat(64),
          contentType: 'text/plain',
          contentDisposition: null,
          metadata: {},
          tags: {},
          file: `objects/${'a'.repeat(64)}`,
        },
        {
          key: 'already-removed.txt',
          size: 3,
          sha256: 'b'.repeat(64),
          contentType: 'text/plain',
          contentDisposition: null,
          metadata: {},
          tags: {},
          file: `objects/${'b'.repeat(64)}`,
        },
      ],
      'readonly',
    )
    await writeFile(join(backupDir, MANIFEST_NAME), `${JSON.stringify(base, null, 2)}\n`)

    // Add a key the baseline does not know about, so the diff also reports ADDED.
    await client.send(
      new PutObjectCommand({ Bucket: 'readonly', Key: 'fresh.txt', Body: Buffer.from('new') }),
    )

    const report = await runDiff({
      baselinePath: backupDir,
      client,
      endpoint: fake.endpoint,
      bucket: 'readonly',
      log: () => {},
    })
    expect(report.counts.deleted).toBe(1)
    expect(report.counts.added).toBe(1)

    // The store must be exactly as the diff found it: `fresh.txt` is still there (the
    // diff did not remove a key merely because the baseline lacked it) and `stay.txt`
    // is byte-identical (the diff did not rewrite it).
    const untouched = await client
      .send(new GetObjectCommand({ Bucket: 'readonly', Key: 'stay.txt' }))
      .then((r) => r.Body?.transformToString())
    expect(untouched).toBe('original-body')
    const added = await client
      .send(new GetObjectCommand({ Bucket: 'readonly', Key: 'fresh.txt' }))
      .then((r) => r.Body?.transformToString())
    expect(added).toBe('new')
    // And the DELETED key was not resurrected either.
    await expect(
      client.send(new GetObjectCommand({ Bucket: 'readonly', Key: 'already-removed.txt' })),
    ).rejects.toThrow()
  })

  it('writes the report owner-only, so a diff cannot leak object names', async () => {
    const dir = await tmp()
    const backupDir = join(dir, 'baseline')
    await mkdir(backupDir, { recursive: true })
    await writeFile(
      join(backupDir, MANIFEST_NAME),
      `${JSON.stringify(manifestOf([], 'secret-bucket'), null, 2)}\n`,
    )
    const out = join(dir, 'report.json')
    const report = await runDiff({
      baselinePath: backupDir,
      currentManifestPath: backupDir,
      outputPath: out,
      log: () => {},
    })
    expect(report.objects).toEqual([])
    // The report lists every key in the bucket, so it is as sensitive as the inventory.
    expect((await stat(out)).mode & 0o077).toBe(0)
  })

  it('reports UNKNOWN, never UNCHANGED, when the live side cannot prove content', async () => {
    // Same key, same size, but the live inventory carries no hash. Reporting UNCHANGED
    // here would be a false claim that nothing changed.
    const client = createS3Client({
      endpoint: fake.endpoint,
      bucket: 'unknown-bucket',
      accessKeyId: 'test-access-key-0001',
      secretAccessKey: 'test-secret-value-abcdef0123456789',
      region: 'auto',
    })
    await client.send(new CreateBucketCommand({ Bucket: 'unknown-bucket' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'unknown-bucket', Key: 'x.bin', Body: Buffer.from('12345') }),
    )
    const dir = await tmp()
    const backupDir = join(dir, 'baseline')
    await mkdir(backupDir, { recursive: true })
    await writeFile(
      join(backupDir, MANIFEST_NAME),
      `${JSON.stringify(
        manifestOf(
          [
            {
              key: 'x.bin',
              size: 5,
              sha256: 'c'.repeat(64),
              contentType: null,
              contentDisposition: null,
              metadata: {},
              tags: {},
              file: `objects/${'c'.repeat(64)}`,
            },
          ],
          'unknown-bucket',
        ),
        null,
        2,
      )}\n`,
    )
    const report = await runDiff({
      baselinePath: backupDir,
      client,
      endpoint: fake.endpoint,
      bucket: 'unknown-bucket',
      log: () => {},
    })
    expect(report.counts.unknown).toBe(1)
    expect(report.counts.unchanged).toBe(0)
    expect(report.objects[0]!.class).toBe('UNKNOWN')
  })

  it('refuses to compare two manifests from different buckets', async () => {
    const dir = await tmp()
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    await mkdir(a, { recursive: true })
    await mkdir(b, { recursive: true })
    await writeFile(
      join(a, MANIFEST_NAME),
      `${JSON.stringify(manifestOf([], 'bucket-a'), null, 2)}\n`,
    )
    await writeFile(
      join(b, MANIFEST_NAME),
      `${JSON.stringify(manifestOf([], 'bucket-b'), null, 2)}\n`,
    )
    // Acting on a cross-bucket diff would delete the wrong objects.
    await expect(
      runDiff({ baselinePath: a, currentManifestPath: b, log: () => {} }),
    ).rejects.toThrow(/refusing to diff different buckets/)
  })

  it('marks a differing endpoint rather than silently comparing across stores', async () => {
    const dir = await tmp()
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    await mkdir(a, { recursive: true })
    await mkdir(b, { recursive: true })
    const shape = manifestOf([], 'same-bucket')
    await writeFile(join(a, MANIFEST_NAME), `${JSON.stringify(shape, null, 2)}\n`)
    await writeFile(
      join(b, MANIFEST_NAME),
      `${JSON.stringify(
        { ...shape, source: { ...shape.source, endpoint: 'http://other-store:9000' } },
        null,
        2,
      )}\n`,
    )
    const report = await runDiff({ baselinePath: a, currentManifestPath: b, log: () => {} })
    // Rolling back from one store to another is legitimate, but the operator must be told.
    expect(report.notes.join(' ')).toMatch(/endpoints differ/)
  })

  it('states that a live inventory is not an atomic snapshot', async () => {
    const client = createS3Client({
      endpoint: fake.endpoint,
      bucket: 'snapshot',
      accessKeyId: 'test-access-key-0001',
      secretAccessKey: 'test-secret-value-abcdef0123456789',
      region: 'auto',
    })
    await client.send(new CreateBucketCommand({ Bucket: 'snapshot' }))
    const dir = await tmp()
    const backupDir = join(dir, 'baseline')
    await mkdir(backupDir, { recursive: true })
    await writeFile(
      join(backupDir, MANIFEST_NAME),
      `${JSON.stringify(manifestOf([], 'snapshot'), null, 2)}\n`,
    )
    const report = await runDiff({
      baselinePath: backupDir,
      client,
      endpoint: fake.endpoint,
      bucket: 'snapshot',
      log: () => {},
    })
    // An empty bucket diffed against an empty manifest is still not a snapshot claim.
    expect(report.current.mode).toBe('live-inventory')
    expect(report.notes.join(' ')).toMatch(/not an atomic snapshot/)
  })

  it('produces an empty, non-misleading report for an empty bucket on both sides', async () => {
    const dir = await tmp()
    const backupDir = join(dir, 'baseline')
    await mkdir(backupDir, { recursive: true })
    await writeFile(
      join(backupDir, MANIFEST_NAME),
      `${JSON.stringify(manifestOf([], 'empty'), null, 2)}\n`,
    )
    const report = await runDiff({
      baselinePath: backupDir,
      currentManifestPath: backupDir,
      log: () => {},
    })
    expect(report.counts).toEqual({
      added: 0,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      unknown: 0,
    })
    expect(report.baseline.object_count).toBe(0)
  })
})
