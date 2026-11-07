// Format-2 (encrypted) backups: confidentiality, integrity, and the failures that
// must not be survivable.
//
// The property under test is fail-closed behaviour. A backup tool that consumes a
// manifest whose HMAC does not match, or that accepts a key file anyone can read, is
// worse than one that refuses: it converts a detectable problem into silent data
// compromise.
//
// age is driven through the real CLI — the same requirement `scripts/cluster/backup.sh`
// already imposes — so these tests skip, loudly, when the binary is absent.

import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBackup } from './backup'
import { runDiff } from './diff'
import { runRestore } from './restore'
import { runVerify } from './verify'
import { loadHmacKey } from './crypto'
import { openBackup } from './vault'
import { createS3Client } from './s3'
import type { StoreConfig } from './config'
import { startFakeS3, type FakeS3 } from './testing/fake-s3'
import { CreateBucketCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'

/**
 * Locate the age binaries.
 *
 * PATH first, then the directory named by AGE_HOME, then the well-known staging path.
 * A previous revision hardcoded the staging path, so the suite broke silently the
 * moment /tmp was cleaned and every encryption test stopped running. Resolution is now
 * explicit and overridable, and a missing binary SKIPS loudly rather than passing.
 */
function ageDir(): string | null {
  const candidates = [
    process.env.AGE_HOME,
    join(dirname(dirname(process.execPath)), 'age'),
    '/tmp/opencode/agebin',
    '/tmp/beaconhs-phase6g/bin/age',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  for (const dir of candidates) {
    if (spawnSync(join(dir, 'age'), ['--version']).status === 0) return dir
  }
  return null
}

const AGE_DIR = ageDir()
const AGE_BIN = AGE_DIR === null ? null : join(AGE_DIR, 'age')
/** age ships a dedicated keygen binary next to `age`; `age -o f keygen` is not valid. */
const AGE_KEYGEN = AGE_DIR === null ? 'age-keygen' : join(AGE_DIR, 'age-keygen')

const config = (endpoint: string, bucket: string): StoreConfig => ({
  endpoint,
  bucket,
  accessKeyId: 'test-access-key-0001',
  secretAccessKey: 'test-secret-value-abcdef0123456789',
  region: 'auto',
})

if (AGE_BIN === null) {
  console.warn(
    '[crypto] the age CLI is not available — encrypted-backup tests are SKIPPED, not passed.',
  )
}

// `describe.skipIf` so a host without age reports SKIPPED. Failing inside beforeEach
// made an environment problem look like a code regression, and a green run that
// quietly stopped testing encryption would be far worse than a loud skip.
describe.skipIf(AGE_BIN === null)('format 2: encrypted backups', () => {
  const dirs: string[] = []
  let fake: FakeS3
  let identity: string
  let recipient: string
  let hmacKey: string
  let hmacKeyFile: string

  beforeEach(async () => {
    fake = await startFakeS3()
    const dir = await mkdtemp(join(tmpdir(), 'objstore-keys-'))
    dirs.push(dir)
    // age-keygen refuses to overwrite an existing file, so the path must not exist yet.
    identity = join(dir, 'identity.txt')
    execFileSync(AGE_KEYGEN, ['-o', identity], {
      env: { ...process.env, PATH: `${AGE_DIR ?? ''}:${process.env.PATH}` },
    })
    await chmod(identity, 0o600)
    const keyText = await readFile(identity, 'utf8')
    recipient = /age1[A-Za-z0-9]+/.exec(keyText)![0]
    hmacKey = 'K'.repeat(43)
    hmacKeyFile = join(dir, 'hmac.key')
    await writeFile(hmacKeyFile, `${hmacKey}\n`, { mode: 0o600 })
    await chmod(hmacKeyFile, 0o600)

    process.env.PATH = `${AGE_DIR ?? ''}:${process.env.PATH}`
    process.env.BACKUP_AGE_RECIPIENT = recipient
    process.env.BACKUP_AGE_IDENTITY = identity
    process.env.BACKUP_HMAC_KEY_FILE = hmacKeyFile
  }, 60_000)

  afterEach(async () => {
    await fake.close()
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    delete process.env.BACKUP_AGE_RECIPIENT
    delete process.env.BACKUP_AGE_IDENTITY
    delete process.env.BACKUP_HMAC_KEY_FILE
  })

  // ---------------------------------------------------------------------------
  // Signature-algorithm identification (A3 cases 1-8).
  //
  // A tool upgrade that changes how the manifest is signed must not be
  // indistinguishable from an attack. These tests pin both halves: a current backup
  // verifies end to end, and a backup signed by the older construction is refused with
  // a diagnosis that names the version rather than accusing anyone of tampering.
  // ---------------------------------------------------------------------------

  /** Decrypt the manifest so a test can edit and re-encrypt it, as an attacker would. */
  async function editEncryptedManifest(
    dir: string,
    mutate: (m: Record<string, unknown>) => void,
  ): Promise<void> {
    const enc = join(dir, 'manifest.json.enc')
    const plain = join(dir, '.edit.json')
    execFileSync(AGE_BIN as string, ['--decrypt', '--identity', identity, '--output', plain, enc])
    const manifest = JSON.parse(await readFile(plain, 'utf8')) as Record<string, unknown>
    mutate(manifest)
    await writeFile(plain, JSON.stringify(manifest, null, 2))
    execFileSync(AGE_BIN as string, ['--encrypt', '--recipient', recipient, '--output', enc, plain])
    await rm(plain, { force: true })
  }

  async function freshEncryptedBackup(bucket: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `objstore-algo-${bucket}-`))
    dirs.push(dir)
    const client = createS3Client(config(fake.endpoint, bucket))
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: 'a.txt',
        Body: Buffer.from('body-for-algorithm-tests'),
        ContentType: 'text/plain',
        Metadata: { owner: 'ops' },
        Tagging: 'env=production',
      }),
    )
    await runBackup({
      config: config(fake.endpoint, bucket),
      client,
      destination: dir,
      encrypt: true,
    })
    return dir
  }

  it('stamps the signature algorithm into the manifest and verifies it end to end', async () => {
    const { HMAC_ALGORITHM } = await import('./crypto')
    const dir = await freshEncryptedBackup('algo-stamp')
    const enc = join(dir, 'manifest.json.enc')
    const plain = join(dir, '.read.json')
    execFileSync(AGE_BIN as string, ['--decrypt', '--identity', identity, '--output', plain, enc])
    const manifest = JSON.parse(await readFile(plain, 'utf8'))
    await rm(plain, { force: true })

    expect(manifest.hmac_algorithm).toBe(HMAC_ALGORITHM)
    expect(manifest.format_version).toBe(2)
    // The two fields answer different questions and must not be conflated.
    expect(manifest.hmac_algorithm).not.toBe(String(manifest.format_version))

    expect((await openBackup(dir)).manifest.hmac_algorithm).toBe(HMAC_ALGORITHM)
    const verify = await runVerify({ backupDir: dir, strict: true, log: () => {} })
    expect(verify.passed).toBe(true)

    const report = await runRestore({
      backupDir: dir,
      target: config(fake.endpoint, 'algo-stamp-dst'),
      createTargetBucket: true,
      log: () => {},
    })
    expect(report.passed).toBe(true)
    expect(report.post_restore.verified).toBe(1)

    // And diff reads it through the same path.
    const diffed = await runDiff({
      baselinePath: dir,
      currentManifestPath: dir,
      log: () => {},
    })
    expect(diffed.content_comparison_authoritative).toBe(true)
  }, 180_000)

  it('refuses a legacy-signed backup with a version diagnosis, not a tampering claim', async () => {
    const dir = await freshEncryptedBackup('algo-legacy')
    // Re-sign with the pre-hmac_algorithm construction, as an older tool would have.
    const { computeHmac } = await import('./crypto')
    const enc = join(dir, 'manifest.json.enc')
    const plain = join(dir, '.legacy.json')
    execFileSync(AGE_BIN as string, ['--decrypt', '--identity', identity, '--output', plain, enc])
    const m = JSON.parse(await readFile(plain, 'utf8')) as Record<string, unknown>
    delete m['hmac_algorithm']
    const legacyEncoding =
      [
        'v2',
        (m['source'] as { bucket: string }).bucket,
        String(m['object_count']),
        String(m['total_bytes']),
        (m['lifecycle'] as { sha256?: string }).sha256 ?? '-',
      ].join('|') +
      '\n' +
      [...(m['objects'] as Array<{ key: string; sha256: string }>)]
        .sort((l, r) => (l.key < r.key ? -1 : 1))
        .map((o) => `${o.sha256} ${o.key}`)
        .join('\n')
    await writeFile(plain, JSON.stringify(m, null, 2))
    execFileSync(AGE_BIN as string, ['--encrypt', '--recipient', recipient, '--output', enc, plain])
    await rm(plain, { force: true })
    await writeFile(
      join(dir, 'backup.hmac'),
      `${computeHmac(Buffer.from(hmacKey, 'utf8'), legacyEncoding)}\n`,
      { mode: 0o600 },
    )

    // The message must name the version problem and must NOT say the backup was
    // tampered with: an operator chasing a phantom attacker wastes an incident.
    await expect(openBackup(dir)).rejects.toThrow(/older tool version/)
    await expect(openBackup(dir)).rejects.toThrow(/NOT evidence of tampering/)

    // It is still refused everywhere it could have caused harm.
    expect((await runVerify({ backupDir: dir, strict: true, log: () => {} })).passed).toBe(false)
    const target = config(fake.endpoint, 'algo-legacy-dst')
    await expect(
      runRestore({ backupDir: dir, target, createTargetBucket: true, log: () => {} }),
    ).rejects.toThrow()
    const listed = await createS3Client(target)
      .send(new ListObjectsV2Command({ Bucket: target.bucket }))
      .catch(() => ({ Contents: [] as Array<{ Key: string }> }))
    expect(listed.Contents ?? []).toEqual([])
  }, 180_000)

  it('refuses a backup whose hmac_algorithm names an unknown construction', async () => {
    const dir = await freshEncryptedBackup('algo-unknown')
    for (const bad of ['beaconhs-manifest-hmac-v99', 'md5', 'none', '']) {
      await editEncryptedManifest(dir, (m) => {
        m['hmac_algorithm'] = bad
      })
      if (bad === '') {
        // An empty string is refused by structural validation, before dispatch.
        await expect(openBackup(dir)).rejects.toThrow(/hmac_algorithm/)
        continue
      }
      await expect(openBackup(dir), `algorithm ${bad} must be refused`).rejects.toThrow(
        /unknown hmac_algorithm/,
      )
    }
  }, 180_000)

  it('refuses a backup whose hmac_algorithm field was rewritten to select another algorithm', async () => {
    const dir = await freshEncryptedBackup('algo-rewrite')
    const tagBefore = (await readFile(join(dir, 'backup.hmac'), 'utf8')).trim()
    // The field is inside the bytes it selects, so editing it invalidates the tag
    // rather than steering the verifier onto a weaker construction.
    await editEncryptedManifest(dir, (m) => {
      m['hmac_algorithm'] = 'beaconhs-manifest-hmac-v1'
    })
    expect((await readFile(join(dir, 'backup.hmac'), 'utf8')).trim()).toBe(tagBefore)
    await expect(openBackup(dir)).rejects.toThrow(/unknown hmac_algorithm/)
  }, 120_000)

  it('refuses a non-string hmac_algorithm before it can reach the dispatcher', async () => {
    const dir = await freshEncryptedBackup('algo-nonstring')
    for (const bad of [123, true, null, ['beaconhs-manifest-hmac-v2'], { a: 1 }]) {
      await editEncryptedManifest(dir, (m) => {
        m['hmac_algorithm'] = bad
      })
      await expect(openBackup(dir)).rejects.toThrow()
    }
  }, 180_000)

  it('still refuses a current-algorithm backup whose HMAC is wrong', async () => {
    const dir = await freshEncryptedBackup('algo-wrongkey')
    const wrong = join(dir, 'wrong.key')
    await writeFile(wrong, `${'Z'.repeat(43)}\n`, { mode: 0o600 })
    process.env.BACKUP_HMAC_KEY_FILE = wrong
    // A wrong key on a CURRENT backup is a real integrity failure and must say so,
    // not be softened into "wrong version".
    await expect(openBackup(dir)).rejects.toThrow(/integrity check failed/)
    process.env.BACKUP_HMAC_KEY_FILE = hmacKeyFile
  }, 120_000)

  it('never accepts a legacy signature merely because the algorithm field was removed', async () => {
    // The attack this design exists to stop. Take a backup signed with the legacy
    // construction, rewrite the object metadata, re-encrypt (the age recipient is
    // public), drop hmac_algorithm entirely and keep the legacy tag.
    //
    // An implementation that "tries every known algorithm until one matches" would
    // accept this: the legacy tag still verifies, so the unauthenticated metadata
    // sails through and restore writes attacker-chosen values to the target store.
    // Only an explicit refusal keeps the coverage gap closed.
    const dir = await freshEncryptedBackup('algo-attack')
    const { computeHmac } = await import('./crypto')
    const enc = join(dir, 'manifest.json.enc')
    const plain = join(dir, '.atk.json')
    execFileSync(AGE_BIN as string, ['--decrypt', '--identity', identity, '--output', plain, enc])
    const m = JSON.parse(await readFile(plain, 'utf8')) as Record<string, unknown>
    const objects = m['objects'] as Array<Record<string, unknown>>
    objects[0]!['metadata'] = { owner: 'ATTACKER' }
    objects[0]!['contentType'] = 'application/x-evil'
    delete m['hmac_algorithm']
    const legacyEncoding =
      [
        'v2',
        (m['source'] as { bucket: string }).bucket,
        String(m['object_count']),
        String(m['total_bytes']),
        (m['lifecycle'] as { sha256?: string }).sha256 ?? '-',
      ].join('|') +
      '\n' +
      [...(m['objects'] as Array<{ key: string; sha256: string }>)]
        .sort((l, r) => (l.key < r.key ? -1 : 1))
        .map((o) => `${o.sha256} ${o.key}`)
        .join('\n')
    await writeFile(plain, JSON.stringify(m, null, 2))
    execFileSync(AGE_BIN as string, ['--encrypt', '--recipient', recipient, '--output', enc, plain])
    await rm(plain, { force: true })
    // The legacy tag is still perfectly valid for this (rewritten) manifest.
    await writeFile(
      join(dir, 'backup.hmac'),
      `${computeHmac(Buffer.from(hmacKey, 'utf8'), legacyEncoding)}\n`,
      { mode: 0o600 },
    )

    await expect(openBackup(dir)).rejects.toThrow(/older tool version/)

    // And it must not reach the target store either.
    const target = config(fake.endpoint, 'algo-attack-dst')
    await expect(
      runRestore({ backupDir: dir, target, createTargetBucket: true, log: () => {} }),
    ).rejects.toThrow()
    const listed = await createS3Client(target)
      .send(new ListObjectsV2Command({ Bucket: target.bucket }))
      .catch(() => ({ Contents: [] as Array<{ Key: string }> }))
    expect(listed.Contents ?? []).toEqual([])
  }, 180_000)

  it('re-reads the age identity when the configured path changes', async () => {
    // The restore path used to remember the first identity it ever saw for the whole
    // process. After the environment changed it kept decrypting with a stale path and
    // failed with an opaque "age command failed". A long-running caller would hit this.
    const first = await freshEncryptedBackup('algo-rotate-1')

    const otherDir = await mkdtemp(join(tmpdir(), 'objstore-algo-rotate2-'))
    dirs.push(otherDir)
    const second = join(otherDir, 'id.txt')
    execFileSync(AGE_KEYGEN, ['-o', second])
    await chmod(second, 0o600)

    const firstReport = await runRestore({
      backupDir: first,
      target: config(fake.endpoint, 'algo-rotate-1-dst'),
      createTargetBucket: true,
      log: () => {},
    })
    expect(firstReport.passed).toBe(true)

    // Point at a DIFFERENT identity. The restore must fail on the identity, not on a
    // stale cached path pointing at a file that no longer matches.
    process.env.BACKUP_AGE_IDENTITY = second
    await expect(
      runRestore({
        backupDir: first,
        target: config(fake.endpoint, 'algo-rotate-2-dst'),
        createTargetBucket: true,
        log: () => {},
      }),
    ).rejects.toThrow()

    // Restoring the original identity must work again — no stale cache left behind.
    process.env.BACKUP_AGE_IDENTITY = identity
    const again = await runRestore({
      backupDir: first,
      target: config(fake.endpoint, 'algo-rotate-3-dst'),
      createTargetBucket: true,
      log: () => {},
    })
    expect(again.passed).toBe(true)
  }, 180_000)

  it('leaves format-1 plaintext backups behaving exactly as before', async () => {
    const bucket = 'algo-plaintext'
    const dir = await mkdtemp(join(tmpdir(), 'objstore-algo-plain-'))
    dirs.push(dir)
    const client = createS3Client(config(fake.endpoint, bucket))
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: 'p.txt', Body: Buffer.from('plain') }),
    )
    await runBackup({ config: config(fake.endpoint, bucket), client, destination: dir })

    // Format 1 has no signature, so it must carry no algorithm field and still open.
    const opened = await openBackup(dir)
    expect(opened.format).toBe(1)
    expect(opened.manifest.hmac_algorithm).toBeUndefined()
    expect((await runVerify({ backupDir: dir, strict: true, log: () => {} })).passed).toBe(true)
  }, 120_000)

  it('encrypts blobs and the manifest, and writes a keyed HMAC', async () => {
    const client = createS3Client(config(fake.endpoint, 'enc'))
    await client.send(new CreateBucketCommand({ Bucket: 'enc' }))
    await client.send(
      new PutObjectCommand({
        Bucket: 'enc',
        Key: 'secret.txt',
        Body: Buffer.from('top-secret-body'),
        ContentType: 'text/plain',
      }),
    )
    const dir = await mkdtemp(join(tmpdir(), 'objstore-enc-'))
    dirs.push(dir)
    await runBackup({
      config: config(fake.endpoint, 'enc'),
      client,
      destination: dir,
      encrypt: true,
    })

    const names = await readdir(dir)
    expect(names).toContain('manifest.json.enc')
    expect(names).toContain('backup.hmac')
    expect(names).toContain('checkpoint.json.enc')
    expect(names).not.toContain('manifest.json')
    expect(names).not.toContain('bucket.json')

    const blobs = await readdir(join(dir, 'objects'))
    expect(blobs.length).toBeGreaterThan(0)
    expect(blobs.every((name) => name.endsWith('.age'))).toBe(true)
    const cipher = Buffer.concat(
      await Promise.all(blobs.map((n) => readFile(join(dir, 'objects', n)))),
    )
    expect(cipher.includes(Buffer.from('top-secret-body'))).toBe(false)

    const opened = await openBackup(dir)
    expect(opened.format).toBe(2)
    expect(opened.manifest.object_count).toBe(1)

    const verify = await runVerify({ backupDir: dir, strict: true })
    expect(verify.passed).toBe(true)
    expect(verify.backup_format).toBe(2)
  }, 120_000)

  it('restores from an encrypted backup when every key is present', async () => {
    const client = createS3Client(config(fake.endpoint, 'roundtrip'))
    await client.send(new CreateBucketCommand({ Bucket: 'roundtrip' }))
    await client.send(
      new PutObjectCommand({
        Bucket: 'roundtrip',
        Key: 'a.txt',
        Body: Buffer.from('round-trip-bytes'),
      }),
    )
    const dir = await mkdtemp(join(tmpdir(), 'objstore-rt-'))
    dirs.push(dir)
    await runBackup({
      config: config(fake.endpoint, 'roundtrip'),
      client,
      destination: dir,
      encrypt: true,
    })

    const report = await runRestore({
      backupDir: dir,
      target: config(fake.endpoint, 'roundtrip-dst'),
      createTargetBucket: true,
    })
    expect(report.passed).toBe(true)
    expect(report.post_restore.verified).toBe(1)
  }, 120_000)

  it('refuses to restore with the wrong age identity, writing nothing to the target', async () => {
    const store = config(fake.endpoint, 'wrongid')
    const client = createS3Client(store)
    await client.send(new CreateBucketCommand({ Bucket: 'wrongid' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'wrongid', Key: 'a.txt', Body: Buffer.from('secret-body') }),
    )
    const dir = await mkdtemp(join(tmpdir(), 'objstore-wrongid-'))
    dirs.push(dir)
    await runBackup({ config: store, client, destination: dir, encrypt: true })

    // A different, valid-looking identity: the wrong key, not a malformed file.
    const otherDir = await mkdtemp(join(tmpdir(), 'objstore-otherid-'))
    dirs.push(otherDir)
    const otherIdentity = join(otherDir, 'other.txt')
    execFileSync(AGE_KEYGEN, ['-o', otherIdentity])
    await chmod(otherIdentity, 0o600)
    process.env.BACKUP_AGE_IDENTITY = otherIdentity

    const dstBucket = 'wrongid-dst'
    await expect(
      runRestore({
        backupDir: dir,
        target: config(fake.endpoint, dstBucket),
        createTargetBucket: true,
      }),
    ).rejects.toThrow()

    // Nothing may exist on the target: a failed decryption must not leave a partial or
    // empty object behind for an operator to mistake for a completed restore.
    const target = createS3Client(config(fake.endpoint, dstBucket))
    const listed = await target
      .send(new ListObjectsV2Command({ Bucket: dstBucket }))
      .catch(() => ({ Contents: [] as Array<{ Key: string }> }))
    expect(listed.Contents ?? []).toEqual([])
  }, 120_000)

  it('refuses to restore when the HMAC does not verify, leaving the target unchanged', async () => {
    const store = config(fake.endpoint, 'hmacrestore')
    const client = createS3Client(store)
    await client.send(new CreateBucketCommand({ Bucket: 'hmacrestore' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'hmacrestore', Key: 'a.txt', Body: Buffer.from('body-here') }),
    )
    const dir = await mkdtemp(join(tmpdir(), 'objstore-hmacrestore-'))
    dirs.push(dir)
    await runBackup({ config: store, client, destination: dir, encrypt: true })

    // Corrupt the integrity tag rather than the ciphertext, so the failure is
    // specifically the authentication step rather than decryption.
    const tag = (await readFile(join(dir, 'backup.hmac'), 'utf8')).trim()
    const flipped = `${tag[0] === 'a' ? 'b' : 'a'}${tag.slice(1)}`
    await writeFile(join(dir, 'backup.hmac'), `${flipped}\n`, { mode: 0o600 })

    const dstBucket = 'hmacrestore-dst'
    await expect(
      runRestore({
        backupDir: dir,
        target: config(fake.endpoint, dstBucket),
        createTargetBucket: true,
      }),
    ).rejects.toThrow(/integrity check failed/)

    const target = createS3Client(config(fake.endpoint, dstBucket))
    const listed = await target
      .send(new ListObjectsV2Command({ Bucket: dstBucket }))
      .catch(() => ({ Contents: [] as Array<{ Key: string }> }))
    expect(listed.Contents ?? []).toEqual([])
  }, 120_000)

  it('refuses to restore when an object blob was truncated', async () => {
    const store = config(fake.endpoint, 'truncated')
    const client = createS3Client(store)
    await client.send(new CreateBucketCommand({ Bucket: 'truncated' }))
    await client.send(
      new PutObjectCommand({
        Bucket: 'truncated',
        Key: 'a.txt',
        Body: Buffer.from('0123456789abcdefghij'),
      }),
    )
    const dir = await mkdtemp(join(tmpdir(), 'objstore-truncated-'))
    dirs.push(dir)
    await runBackup({ config: store, client, destination: dir, encrypt: true })

    const opened = await openBackup(dir)
    const blob = join(dir, opened.manifest.objects[0]!.file)
    const bytes = await readFile(blob)
    await writeFile(blob, bytes.subarray(0, Math.floor(bytes.length / 2)))

    const dstBucket = 'truncated-dst'
    // A half-written blob must never reach the target store.
    const report = await runRestore({
      backupDir: dir,
      target: config(fake.endpoint, dstBucket),
      createTargetBucket: true,
    }).catch((error: Error) => error as unknown)
    expect(report).toBeInstanceOf(Error)
    const target = createS3Client(config(fake.endpoint, dstBucket))
    const listed = await target
      .send(new ListObjectsV2Command({ Bucket: dstBucket }))
      .catch(() => ({ Contents: [] as Array<{ Key: string }> }))
    expect(listed.Contents ?? []).toEqual([])
  }, 120_000)

  it('refuses a backup that only pretends to be encrypted', async () => {
    // A plaintext manifest dropped alongside an empty .enc marker must not be read as
    // format 1: the presence of the encrypted manifest selects format 2, and format 2
    // has no plaintext fallback.
    const dir = await mkdtemp(join(tmpdir(), 'objstore-pretend-'))
    dirs.push(dir)
    await writeFile(join(dir, 'manifest.json'), '{"schema_version":1,"objects":[]}')
    await writeFile(join(dir, 'manifest.json.enc'), 'age-encryption.org/v1\nnot-real\n---\n')
    await expect(openBackup(dir)).rejects.toThrow()
  }, 30_000)

  it('fails closed when the HMAC key is missing', async () => {
    const client = createS3Client(config(fake.endpoint, 'nokey'))
    await client.send(new CreateBucketCommand({ Bucket: 'nokey' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'nokey', Key: 'a.txt', Body: Buffer.from('aaaa') }),
    )
    const dir = await mkdtemp(join(tmpdir(), 'objstore-nokey-'))
    dirs.push(dir)
    await runBackup({
      config: config(fake.endpoint, 'nokey'),
      client,
      destination: dir,
      encrypt: true,
    })

    delete process.env.BACKUP_HMAC_KEY_FILE
    delete process.env.BACKUP_HMAC_KEY
    await expect(openBackup(dir)).rejects.toThrow(/HMAC/)
  }, 120_000)

  it('fails closed when the HMAC key is wrong', async () => {
    const client = createS3Client(config(fake.endpoint, 'wrongkey'))
    await client.send(new CreateBucketCommand({ Bucket: 'wrongkey' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'wrongkey', Key: 'a.txt', Body: Buffer.from('aaaa') }),
    )
    const dir = await mkdtemp(join(tmpdir(), 'objstore-wrongkey-'))
    dirs.push(dir)
    await runBackup({
      config: config(fake.endpoint, 'wrongkey'),
      client,
      destination: dir,
      encrypt: true,
    })

    const wrong = join(dir, 'wrong.key')
    await writeFile(wrong, `${'Z'.repeat(43)}\n`, { mode: 0o600 })
    process.env.BACKUP_HMAC_KEY_FILE = wrong
    await expect(openBackup(dir)).rejects.toThrow(/integrity check failed/)
  }, 120_000)

  it('refuses a backup whose encrypted manifest was tampered with', async () => {
    const client = createS3Client(config(fake.endpoint, 'tamper'))
    await client.send(new CreateBucketCommand({ Bucket: 'tamper' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'tamper', Key: 'a.txt', Body: Buffer.from('aaaa') }),
    )
    const dir = await mkdtemp(join(tmpdir(), 'objstore-tamper-'))
    dirs.push(dir)
    await runBackup({
      config: config(fake.endpoint, 'tamper'),
      client,
      destination: dir,
      encrypt: true,
    })

    const enc = join(dir, 'manifest.json.enc')
    const bytes = await readFile(enc)
    // Corrupt one byte of the ciphertext: age usually rejects it outright, and if it
    // does not, the HMAC must. Either way the backup must not be usable.
    const index = bytes.length - 20
    const original = bytes[index]
    if (original !== undefined) bytes[index] = original ^ 0xff
    await writeFile(enc, bytes)

    await expect(openBackup(dir)).rejects.toThrow()
    expect((await runVerify({ backupDir: dir, strict: true })).passed).toBe(false)
  }, 120_000)

  /**
   * Rewrite the decrypted manifest, re-encrypt it with the PUBLIC recipient, and leave
   * the original HMAC file untouched — exactly what an attacker with write access to
   * the backup directory can do without ever holding the HMAC key.
   */
  async function rewriteManifestTampered(
    dir: string,
    mutate: (manifest: Record<string, unknown>) => void,
  ): Promise<void> {
    const encPath = join(dir, 'manifest.json.enc')
    const plain = join(dir, '.audit-rewrite.json')
    execFileSync(AGE_BIN as string, [
      '--decrypt',
      '--identity',
      identity,
      '--output',
      plain,
      encPath,
    ])
    const manifest = JSON.parse(await readFile(plain, 'utf8')) as Record<string, unknown>
    mutate(manifest)
    await writeFile(plain, JSON.stringify(manifest, null, 2))
    execFileSync(AGE_BIN as string, [
      '--encrypt',
      '--recipient',
      recipient,
      '--output',
      encPath,
      plain,
    ])
    await rm(plain, { force: true })
  }

  async function seededEncryptedBackup(bucket: string, dir: string): Promise<void> {
    const client = createS3Client(config(fake.endpoint, bucket))
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: 'doc.txt',
        Body: Buffer.from('payload-bytes'),
        ContentType: 'text/plain',
        ContentDisposition: 'inline',
        Metadata: { owner: 'original-owner' },
        Tagging: 'env=production',
      }),
    )
    await runBackup({
      config: config(fake.endpoint, bucket),
      client,
      destination: dir,
      encrypt: true,
    })
  }

  it('refuses a manifest whose metadata was rewritten and re-encrypted', async () => {
    // Regression for an audit finding: the HMAC originally covered only the bucket,
    // counts, totals, lifecycle digest and each object's key+content-hash. Metadata,
    // tags, contentType and contentDisposition were NOT covered, and because the age
    // recipient is public an attacker could rewrite them and re-encrypt, and the
    // original tag still verified — so restore wrote attacker-chosen values to the
    // target store while reporting the restore as passed.
    const dir = await mkdtemp(join(tmpdir(), 'objstore-meta-'))
    dirs.push(dir)
    await seededEncryptedBackup('meta', dir)

    const before = (await openBackup(dir)).manifest.objects[0]!
    expect(before.metadata).toEqual({ owner: 'original-owner' })

    const tagBefore = (await readFile(join(dir, 'backup.hmac'), 'utf8')).trim()
    await rewriteManifestTampered(dir, (m) => {
      const objects = m['objects'] as Array<Record<string, unknown>>
      objects[0]!['metadata'] = { owner: 'ATTACKER' }
    })
    // The tag was not touched, so only the coverage of the encoding can catch this.
    expect((await readFile(join(dir, 'backup.hmac'), 'utf8')).trim()).toBe(tagBefore)

    await expect(openBackup(dir)).rejects.toThrow(/integrity check failed/)
    expect((await runVerify({ backupDir: dir, strict: true })).passed).toBe(false)
  }, 120_000)

  it('refuses a manifest whose tags, content type or disposition were rewritten', async () => {
    for (const [label, mutate] of [
      ['tags', (o: Record<string, unknown>) => (o['tags'] = { env: 'attacker' })],
      ['contentType', (o: Record<string, unknown>) => (o['contentType'] = 'application/x-evil')],
      [
        'contentDisposition',
        (o: Record<string, unknown>) => (o['contentDisposition'] = 'attachment; filename="leak"'),
      ],
    ] as Array<[string, (o: Record<string, unknown>) => void]>) {
      const dir = await mkdtemp(join(tmpdir(), `objstore-${label}-`))
      dirs.push(dir)
      await seededEncryptedBackup(label, dir)
      await rewriteManifestTampered(dir, (m) => {
        mutate((m['objects'] as Array<Record<string, unknown>>)[0]!)
      })
      await expect(openBackup(dir), `${label} must be authenticated`).rejects.toThrow(
        /integrity check failed/,
      )
    }
  }, 180_000)

  it('refuses a manifest whose object key or blob mapping was rewritten', async () => {
    for (const [label, mutate] of [
      // Renaming a key moves the object on restore; the content hash alone would not
      // notice, because the blob still matches.
      ['key', (o: Record<string, unknown>) => (o['key'] = 'attacker-chosen-name.txt')],
      // Pointing a different object at another object's blob.
      ['file', (o: Record<string, unknown>) => (o['file'] = `objects/${'f'.repeat(64)}.age`)],
    ] as Array<[string, (o: Record<string, unknown>) => void]>) {
      const dir = await mkdtemp(join(tmpdir(), `objstore-map-${label}-`))
      dirs.push(dir)
      await seededEncryptedBackup(`map-${label}`, dir)
      await rewriteManifestTampered(dir, (m) => {
        mutate((m['objects'] as Array<Record<string, unknown>>)[0]!)
      })
      await expect(openBackup(dir), `${label} must be authenticated`).rejects.toThrow(
        /integrity check failed/,
      )
    }
  }, 180_000)

  it('refuses a manifest whose lifecycle configuration was rewritten', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-lifecycle-tamper-'))
    dirs.push(dir)
    await seededEncryptedBackup('lifecycle-tamper', dir)
    await rewriteManifestTampered(dir, (m) => {
      m['lifecycle'] = {
        status: 'captured',
        xml: '<LifecycleConfiguration/>',
        sha256: 'a'.repeat(64),
      }
    })
    // A rewritten lifecycle configuration would be applied to the target bucket.
    await expect(openBackup(dir)).rejects.toThrow(/integrity check failed/)
  }, 120_000)

  it('signs a length-prefixed encoding, so a key cannot be shifted between fields', async () => {
    const { canonicalManifestEncoding } = await import('./crypto')
    const shape = {
      schema_version: 1,
      format_version: 2,
      created_at: '2026-01-01T00:00:00.000Z',
      source: { endpoint: 'e', bucket: 'b', region: 'auto' },
      object_count: 1,
      total_bytes: 0,
      lifecycle: {},
      objects: [
        {
          key: 'k',
          size: 0,
          sha256: 'a'.repeat(64),
          contentType: null,
          contentDisposition: null,
          metadata: {},
          tags: {},
          file: 'objects/x',
        },
      ],
    }
    // Without a length prefix, moving a newline between the key and the hash yields the
    // same signed string for two different manifests. The encoding must be injective.
    const injected = JSON.parse(JSON.stringify(shape)) as typeof shape
    injected.objects[0]!.key = `k\n${'a'.repeat(64)} `
    expect(canonicalManifestEncoding(injected)).not.toBe(canonicalManifestEncoding(shape))
  }, 30_000)

  it('rejects an HMAC key too short to resist guessing', async () => {
    const weak = join(await mkdtemp(join(tmpdir(), 'objstore-weak-')), 'weak.key')
    await writeFile(weak, 'x\n', { mode: 0o600 })
    await chmod(weak, 0o600)
    process.env.BACKUP_HMAC_KEY_FILE = weak
    // A one-byte key is brute-forceable in microseconds; accepting it would let a
    // backup verify as authentic when anyone could have forged the tag.
    await expect(loadHmacKey()).rejects.toThrow(/at least 32/)
    await chmod(weak, 0o600)
  }, 30_000)

  it('leaves no plaintext file when decryption fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-plainfail-'))
    dirs.push(dir)
    await seededEncryptedBackup('plainfail', dir)
    const opened = await openBackup(dir)
    const blob = join(dir, opened.manifest.objects[0]!.file)

    const before = new Set(await readdir(join(dir, 'objects')))
    // Corrupt the ciphertext so age fails part-way.
    const bytes = await readFile(blob)
    await writeFile(blob, Buffer.concat([bytes.subarray(0, 10), Buffer.from([0, 1, 2, 3, 4, 5])]))
    const { decryptFile } = await import('./crypto')
    const scratch = `${blob}.scratch`
    await expect(decryptFile(blob, scratch, identity)).rejects.toThrow()
    // The scratch file must not survive a failed decryption: a partial or empty
    // plaintext file could otherwise be read by a later run as if it were content.
    const after = new Set(await readdir(join(dir, 'objects')))
    expect([...after].filter((n) => n.includes('scratch'))).toEqual([])
    expect([...before].every((n) => after.has(n))).toBe(true)
  }, 120_000)

  it('creates decrypted scratch files with no group or other access', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-mode-'))
    dirs.push(dir)
    await seededEncryptedBackup('mode', dir)
    const opened = await openBackup(dir)
    const { decryptFile } = await import('./crypto')
    const scratch = `${join(dir, opened.manifest.objects[0]!.file)}.mode-probe`
    await decryptFile(join(dir, opened.manifest.objects[0]!.file), scratch, identity)
    // `age --output` creates 0644 on its own; the tool must pre-create the file 0600 so
    // plaintext is never briefly world-readable.
    const info = await stat(scratch)
    expect(info.mode & 0o077).toBe(0)
    await rm(scratch, { force: true })
  }, 120_000)

  it('diffs two encrypted backups, which is the normal case once --encrypt is used', async () => {
    const store = config(fake.endpoint, 'diffenc')
    const client = createS3Client(store)
    await client.send(new CreateBucketCommand({ Bucket: 'diffenc' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'diffenc', Key: 'keep.txt', Body: Buffer.from('same') }),
    )
    await client.send(
      new PutObjectCommand({ Bucket: 'diffenc', Key: 'edit.txt', Body: Buffer.from('before') }),
    )

    const baseline = await mkdtemp(join(tmpdir(), 'objstore-diffenc-a-'))
    dirs.push(baseline)
    await runBackup({ config: store, client, destination: baseline, encrypt: true })

    // A second encrypted backup after a change, so the two manifests differ.
    await client.send(
      new PutObjectCommand({ Bucket: 'diffenc', Key: 'edit.txt', Body: Buffer.from('after!') }),
    )
    await client.send(
      new PutObjectCommand({ Bucket: 'diffenc', Key: 'new.txt', Body: Buffer.from('brand-new') }),
    )
    const current = await mkdtemp(join(tmpdir(), 'objstore-diffenc-b-'))
    dirs.push(current)
    await runBackup({ config: store, client, destination: current, encrypt: true })

    const report = await runDiff({
      baselinePath: baseline,
      currentManifestPath: current,
      log: () => {},
    })
    // Reading an encrypted manifest means decrypting it and checking its HMAC, which
    // is what makes the content comparison authoritative.
    expect(report.content_comparison_authoritative).toBe(true)
    expect(report.counts.added).toBe(1)
    expect(report.counts.modified).toBe(1)
    expect(report.counts.unchanged).toBe(1)
    expect(report.objects.find((o) => o.key === 'new.txt')!.class).toBe('ADDED')
    expect(report.objects.find((o) => o.key === 'edit.txt')!.class).toBe('MODIFIED')
    expect(report.objects.find((o) => o.key === 'keep.txt')!.class).toBe('UNCHANGED')
  }, 120_000)

  it('refuses to diff an encrypted backup whose HMAC does not verify', async () => {
    const store = config(fake.endpoint, 'diffbad')
    const client = createS3Client(store)
    await client.send(new CreateBucketCommand({ Bucket: 'diffbad' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'diffbad', Key: 'a.txt', Body: Buffer.from('aaaa') }),
    )
    const dir = await mkdtemp(join(tmpdir(), 'objstore-diffbad-'))
    dirs.push(dir)
    await runBackup({ config: store, client, destination: dir, encrypt: true })

    const wrong = join(dir, 'wrong.key')
    await writeFile(wrong, `${'Z'.repeat(43)}\n`, { mode: 0o600 })
    process.env.BACKUP_HMAC_KEY_FILE = wrong
    // A diff that ignored the HMAC would happily report on an unauthenticated backup.
    await expect(
      runDiff({ baselinePath: dir, currentManifestPath: dir, log: () => {} }),
    ).rejects.toThrow(/baseline manifest is unusable/)
  }, 120_000)

  it('keeps a legacy plaintext backup readable, in its own format', async () => {
    const client = createS3Client(config(fake.endpoint, 'legacy'))
    await client.send(new CreateBucketCommand({ Bucket: 'legacy' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'legacy', Key: 'a.txt', Body: Buffer.from('aaaa') }),
    )
    const dir = await mkdtemp(join(tmpdir(), 'objstore-legacy-'))
    dirs.push(dir)
    await runBackup({ config: config(fake.endpoint, 'legacy'), client, destination: dir })

    const opened = await openBackup(dir)
    expect(opened.format).toBe(1)
    const verify = await runVerify({ backupDir: dir, strict: true })
    expect(verify.passed).toBe(true)
    expect(verify.backup_format).toBe(1)
  }, 60_000)

  it('refuses a key file that group or others can read', async () => {
    await chmod(hmacKeyFile, 0o644)
    await expect(loadHmacKey()).rejects.toThrow(/permissions/)
    await chmod(hmacKeyFile, 0o600)
  }, 30_000)

  it('keeps the HMAC key out of the artifacts', async () => {
    const client = createS3Client(config(fake.endpoint, 'leakcheck'))
    await client.send(new CreateBucketCommand({ Bucket: 'leakcheck' }))
    await client.send(
      new PutObjectCommand({ Bucket: 'leakcheck', Key: 'a.txt', Body: Buffer.from('aaaa') }),
    )
    const dir = await mkdtemp(join(tmpdir(), 'objstore-leak-'))
    dirs.push(dir)
    await runBackup({
      config: config(fake.endpoint, 'leakcheck'),
      client,
      destination: dir,
      encrypt: true,
    })

    const artifact = Buffer.concat([
      await readFile(join(dir, 'manifest.json.enc')),
      await readFile(join(dir, 'backup.hmac')),
    ])
    expect(artifact.includes(Buffer.from(hmacKey))).toBe(false)
  }, 120_000)
})
