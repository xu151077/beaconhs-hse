// The backup command.
//
// WHAT MAKES A BACKUP TRUSTWORTHY
//
// Three properties, each easy to get wrong and impossible to detect afterwards from
// the output alone:
//
//   1. THE ENUMERATION IS COMPLETE. Pagination is followed to the end, and a store
//      that truncates without a continuation token aborts the run instead of
//      producing a partial backup that reports success.
//   2. THE HASH IS OF THE BYTES THAT WERE WRITTEN. The digest is computed while the
//      download streams to disk, in the same pass, so the manifest can never
//      describe content that is not on disk.
//   3. A RESUMED RUN DOES NOT TRUST ITS CHECKPOINT BLINDLY. The checkpoint records
//      what was finished; on resume each finished key's local file is re-hashed and
//      compared before it is skipped. A checkpoint written just before a crash can
//      name a file that was truncated or never flushed, and trusting it is how a
//      restore later fails on data the backup claimed was good.
//
// DISK SPACE
//
// The pre-flight check is an estimate and the log says so. It cannot see other
// writers, sparse files, or metadata overhead. It exists to fail early on the common
// case (backing up 50 GiB into 10 GiB free), not to guarantee the run will fit.

import { open, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'
import type { StoreConfig } from './config'
import { redactEndpoint } from './config'
import {
  BUCKET_CONFIG_NAME,
  CHECKPOINT_ENC_NAME,
  CHECKPOINT_NAME,
  MANIFEST_NAME,
  OBJECT_DIR,
  hashFile,
  objectRelativePath,
  pumpAndHash,
} from './hash'
import { decryptFile, encryptFile, loadAgeRecipient, loadHmacKey, HMAC_ALGORITHM } from './crypto'
import { FORMAT_V2, MANIFEST_ENC_NAME, commitEncryptedManifest } from './vault'
import {
  MANIFEST_SCHEMA_VERSION,
  writeManifest,
  type Manifest,
  type ManifestObject,
} from './manifest'
import {
  bucketExists,
  createBucket,
  getObjectStream,
  listAllObjects,
  readBucketLifecycle,
  readObjectMetadata,
} from './s3'

export type BackupOptions = {
  config: StoreConfig
  client: S3Client
  /** Destination directory. Created if absent, with mode 0700. */
  destination: string
  /** Create the bucket when it does not exist. Default false: a backup of a mistyped bucket name is not useful. */
  createBucket?: boolean
  /** Skip objects already recorded in a valid checkpoint, after re-hashing them. */
  resume?: boolean
  /**
   * Write an encrypted backup (format 2). Object blobs, the manifest and the
   * checkpoint are age-encrypted, and a keyed HMAC over the canonical manifest
   * encoding is written alongside them. Requires the age CLI plus a recipient and
   * an HMAC key; a missing either fails the run instead of falling back to plaintext.
   */
  encrypt?: boolean
  log?: (line: string) => void
}

export type BackupResult = {
  backupDir: string
  manifestPath: string
  objectCount: number
  totalBytes: number
  reusedFromCheckpoint: number
  downloaded: number
}

type Checkpoint = {
  schema_version: number
  /** Keys whose bytes are on disk and whose manifest record is complete. */
  completed: Record<string, { size: number; sha256: string }>
}

const CHECKPOINT_SCHEMA_VERSION = 1

async function ensureDir(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode })
}

/**
 * Space a backup is expected to need.
 *
 * The ~10% headroom covers the manifest, the checkpoint, filesystem block rounding,
 * and the temporary name a download lands on before it is renamed to its digest.
 * It is deliberately an estimate: it cannot see another writer, sparse files, or
 * quota, so it must never be presented as a guarantee.
 */
export function requiredBackupBytes(totalBytes: number): number {
  return Math.ceil(totalBytes * 1.1)
}

/** The refusal message, extracted so the wording can be asserted in a test. */
export function insufficientSpaceMessage(required: number, available: number): string {
  return (
    `insufficient space: the backup needs about ${required} bytes (objects plus ~10% ` +
    `overhead) but only ${available} bytes are free. This is an estimate only — it cannot see ` +
    `other writers, so it does not guarantee the run will fit.`
  )
}

/** Free bytes on the filesystem holding `path`, or undefined when unstatable. */
async function freeSpaceBytes(path: string): Promise<number | undefined> {
  try {
    const stats = await statfs(path)
    return stats.bavail * stats.bsize
  } catch {
    return undefined
  }
}

/** Load the age identity for a v2 resume without re-reading it for every object. */
let cachedIdentity: string | undefined
async function loadAgeIdentityRef(): Promise<string> {
  if (cachedIdentity === undefined) {
    cachedIdentity = await (await import('./crypto')).loadAgeIdentity()
  }
  return cachedIdentity
}

export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const log = options.log ?? ((line: string) => console.log(line))
  const { config, client } = options
  const backupDir = options.destination

  // 0700/0600 throughout: a backup holds every object the bucket holds, including
  // whatever its metadata says about the tenant, so it is not world-readable.
  await ensureDir(backupDir, 0o700)
  await ensureDir(join(backupDir, OBJECT_DIR), 0o700)

  // Sweep abandoned download temporaries before counting anything.
  //
  // A `.incoming-*` file is, by construction, a download that never reached its
  // rename: it is written to a temporary name and only renamed to its digest once
  // the stream has been fully hashed and fsynced. An interrupted run therefore
  // leaves one behind, and a resumed backup would otherwise carry it forever — every
  // later `verify --strict` would report it as an unreferenced file and fail a
  // backup that is actually complete. The sweep is safe exactly because the name is
  // reserved for incomplete work: nothing a finished backup can reference lives
  // under it.
  const staleTemporaries = await readdir(join(backupDir, OBJECT_DIR)).catch(() => [] as string[])
  let swept = 0
  for (const entry of staleTemporaries) {
    if (!entry.startsWith('.incoming-')) continue
    await rm(join(backupDir, OBJECT_DIR, entry), { force: true }).catch(() => undefined)
    swept += 1
  }
  if (swept > 0) {
    log(
      `removed ${swept} abandoned download temporary file(s) left by an earlier ` +
        `interrupted run`,
    )
  }

  if (!(await bucketExists(client, config.bucket))) {
    if (options.createBucket !== true) {
      throw new Error(
        `bucket "${config.bucket}" does not exist on ${redactEndpoint(config.endpoint)}. ` +
          `Refusing to back up nothing; pass --create-bucket only when that is really what ` +
          `you intend.`,
      )
    }
    await createBucket(client, config.bucket)
    log(`created bucket ${config.bucket}`)
  }

  const listing = await listAllObjects(client, config.bucket)
  const totalBytes = listing.reduce((sum, entry) => sum + entry.size, 0)
  log(
    `inventory: ${listing.length} object(s), ${totalBytes} byte(s) in bucket ` +
      `"${config.bucket}" on ${redactEndpoint(config.endpoint)}`,
  )

  const free = await freeSpaceBytes(backupDir)
  if (free !== undefined) {
    const required = requiredBackupBytes(totalBytes)
    if (free < required) {
      throw new Error(insufficientSpaceMessage(required, free))
    }
  } else {
    log(
      'WARNING: could not determine free disk space; the pre-flight check is skipped, so a ' +
        'full disk can still abort this run part-way through.',
    )
  }

  const encrypted = options.encrypt === true
  const checkpointPath = join(backupDir, encrypted ? CHECKPOINT_ENC_NAME : CHECKPOINT_NAME)
  let ageRecipient: string | undefined
  let hmacKey: Buffer | undefined
  if (encrypted) {
    ageRecipient = await loadAgeRecipient()
    hmacKey = await loadHmacKey()
  }
  let checkpoint: Checkpoint = { schema_version: CHECKPOINT_SCHEMA_VERSION, completed: {} }
  if (options.resume === true) {
    try {
      // Format 2 checkpoints are age-encrypted, so the plaintext checkpoint must
      // be decrypted before it can be read. Without this, `--resume` silently
      // starts a full backup even though a valid encrypted checkpoint exists.
      let raw: string
      if (encrypted) {
        const identity = await loadAgeIdentityRef()
        const plainPath = join(backupDir, `.checkpoint-decrypt-${process.pid}.json`)
        try {
          await decryptFile(checkpointPath, plainPath, identity)
          raw = await readFile(plainPath, 'utf8')
        } finally {
          await rm(plainPath, { force: true }).catch(() => undefined)
        }
      } else {
        raw = await readFile(checkpointPath, 'utf8')
      }
      const parsed = JSON.parse(raw) as Checkpoint
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.schema_version === CHECKPOINT_SCHEMA_VERSION &&
        parsed.completed &&
        typeof parsed.completed === 'object'
      ) {
        checkpoint = parsed
        log(`resuming from checkpoint: ${Object.keys(parsed.completed).length} key(s) recorded`)
      } else {
        log('no usable checkpoint found; performing a full backup')
      }
    } catch {
      log('no usable checkpoint found; performing a full backup')
    }
  }

  const writeCheckpoint = async (): Promise<void> => {
    // Temp-then-rename so an interrupt cannot leave a half-written checkpoint that
    // looks complete. In format 2 the checkpoint names object keys and their
    // hashes, so it carries business information and is encrypted with the same
    // key as everything else.
    const temp = `${checkpointPath}.tmp`
    const body = `${JSON.stringify(checkpoint, null, 2)}\n`
    if (!encrypted) {
      await writeFile(temp, body, { mode: 0o600 })
      await rename(temp, checkpointPath)
      return
    }
    await writeFile(temp, body, { mode: 0o600 })
    await encryptFile(temp, checkpointPath, ageRecipient as string)
    await rm(temp, { force: true }).catch(() => undefined)
  }

  /**
   * Name a blob, and publish the plaintext download into its final home.
   *
   * Format 2 encrypts before the blob is named, so no unencrypted object ever has
   * a permanent path in the backup directory.
   */
  const blobRelative = (sha256: string): string =>
    encrypted ? `${OBJECT_DIR}/${sha256}.age` : objectRelativePath(sha256)

  const publishBlob = async (tempPath: string, sha256: string): Promise<string> => {
    const relative = blobRelative(sha256)
    if (!encrypted) {
      const finalPath = join(backupDir, relative)
      if (finalPath !== tempPath) await rename(tempPath, finalPath)
      return relative
    }
    await encryptFile(tempPath, join(backupDir, relative), ageRecipient as string)
    await rm(tempPath, { force: true }).catch(() => undefined)
    return relative
  }

  const objects: ManifestObject[] = []
  let downloaded = 0
  let reused = 0

  for (const entry of listing) {
    const recorded = checkpoint.completed[entry.key]
    if (options.resume === true && recorded && recorded.size === entry.size) {
      // Re-hash before trusting. The checkpoint can precede a crash. In format 2 the
      // stored bytes are ciphertext, so the re-hash decrypts first.
      let onDisk: string
      if (!encrypted) {
        onDisk = await hashFile(join(backupDir, objectRelativePath(recorded.sha256)))
      } else {
        const { decryptAndHash, removeTempFile } = await import('./vault')
        const identity = await loadAgeIdentityRef()
        const result = await decryptAndHash(backupDir, blobRelative(recorded.sha256), identity)
        await removeTempFile(result.plaintextPath)
        onDisk = result.sha256
      }
      if (onDisk === recorded.sha256) {
        objects.push(
          await readManifestRecord(client, config.bucket, entry.key, recorded, blobRelative),
        )
        reused += 1
        continue
      }
      log(`checkpoint entry for ${entry.key} failed re-hash; downloading again`)
    }

    objects.push(
      await downloadAndHash(client, config.bucket, backupDir, entry.key, entry.size, publishBlob),
    )
    downloaded += 1
    // Persist the record before the checkpoint names it, so a crash between the two
    // leaves a checkpoint behind the data rather than ahead of it.
    checkpoint.completed[entry.key] = {
      size: objects[objects.length - 1]!.size,
      sha256: objects[objects.length - 1]!.sha256,
    }
    // Written after EVERY object, not every Nth.
    //
    // This was `% 25`, and it made the resume path nearly useless: a backup of
    // twenty objects wrote its first checkpoint only at the very end, so an
    // interruption cost the whole run — exactly the case resume is meant to save.
    // The cost of writing every time is one small, atomic file write per object;
    // a backup of a million objects is dominated by transfer, not by a million
    // local writes, and losing 25 objects of progress to save those writes is the
    // wrong trade for a data-protection tool.
    await writeCheckpoint()
  }
  await writeCheckpoint()

  const lifecycle = await readBucketLifecycle(client, config.bucket)

  const manifest: Manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    ...(encrypted ? { format_version: FORMAT_V2, hmac_algorithm: HMAC_ALGORITHM } : {}),
    created_at: new Date().toISOString(),
    source: {
      endpoint: redactEndpoint(config.endpoint),
      bucket: config.bucket,
      region: config.region,
    },
    object_count: objects.length,
    total_bytes: objects.reduce((sum, object) => sum + object.size, 0),
    lifecycle:
      lifecycle.status === 'captured'
        ? { status: 'captured', xml: lifecycle.xml, sha256: lifecycle.sha256 }
        : lifecycle.status === 'none'
          ? { status: 'none' }
          : { status: 'unsupported', reason: lifecycle.reason },
    objects: [...objects].sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    ),
  }

  const manifestPath = join(backupDir, encrypted ? MANIFEST_ENC_NAME : MANIFEST_NAME)
  if (!encrypted) {
    await writeManifest(backupDir, manifest)
    // The lifecycle configuration is a separate, human-readable file in format 1;
    // in format 2 it lives inside the encrypted manifest and must not be duplicated
    // in plaintext.
    await writeFile(
      join(backupDir, BUCKET_CONFIG_NAME),
      `${JSON.stringify(manifest.lifecycle, null, 2)}\n`,
      { mode: 0o600 },
    )
  } else {
    const { computeHmac, canonicalManifestEncoding } = await import('./crypto')
    const hmacHex = computeHmac(hmacKey as Buffer, canonicalManifestEncoding(manifest))
    await commitEncryptedManifest(backupDir, manifest, hmacHex)
  }

  log(`backed up ${manifest.object_count} object(s), ${manifest.total_bytes} byte(s)`)
  log(`  downloaded: ${downloaded}   reused from checkpoint: ${reused}`)
  if (lifecycle.status === 'unsupported') {
    log(`NOTE: bucket lifecycle could not be read on this store: ${lifecycle.reason}`)
  }
  log(`manifest: ${manifestPath}`)
  log('Next step: run "verify" against this directory before relying on this backup.')

  return {
    backupDir,
    manifestPath,
    objectCount: manifest.object_count,
    totalBytes: manifest.total_bytes,
    reusedFromCheckpoint: reused,
    downloaded,
  }
}

/** HeadObject + tags for a resumed key, so the record matches a fresh download. */
async function readManifestRecord(
  client: S3Client,
  bucket: string,
  key: string,
  known: { size: number; sha256: string },
  blobRelative: (sha256: string) => string,
): Promise<ManifestObject> {
  const metadata = await readObjectMetadata(client, bucket, key)
  return {
    key,
    size: known.size,
    sha256: known.sha256,
    contentType: metadata.contentType,
    contentDisposition: metadata.contentDisposition,
    metadata: metadata.metadata,
    tags: metadata.tags,
    file: blobRelative(known.sha256),
  }
}

/**
 * Stream one object to its content-addressed file, hashing while writing.
 *
 * The download lands on a temporary name and is renamed only after the stream is
 * flushed and fsynced, so an interrupted download can never leave a blob that a
 * later run mistakes for a complete one. The final name is the digest itself, which
 * also means re-running over identical content is a no-op on disk.
 */
async function downloadAndHash(
  client: S3Client,
  bucket: string,
  backupDir: string,
  key: string,
  expectedSize: number,
  publish: (tempPath: string, sha256: string) => Promise<string>,
): Promise<ManifestObject> {
  const metadata = await readObjectMetadata(client, bucket, key)
  const { stream, contentLength } = await getObjectStream(client, bucket, key)
  if (contentLength !== undefined && contentLength !== expectedSize) {
    throw new Error(
      `size mismatch for ${key}: the listing said ${expectedSize} bytes but the store ` +
        `returned ${contentLength}`,
    )
  }

  await ensureDir(join(backupDir, OBJECT_DIR), 0o700)
  const tempPath = join(backupDir, OBJECT_DIR, `.incoming-${process.pid}-${Date.now()}`)
  const handle = await open(tempPath, 'w', 0o600)
  try {
    const hashed = await pumpAndHash(stream, (chunk) => handle.write(chunk))
    if (hashed.size !== expectedSize) {
      throw new Error(`short read for ${key}: expected ${expectedSize} bytes, wrote ${hashed.size}`)
    }
    // Flush to disk before the file is named by its digest.
    await handle.sync()
    await handle.close()
    // The publisher decides what the stored form is: a rename for format 1, or an
    // encrypt-then-remove for format 2 so no plaintext copy is left behind.
    const relative = await publish(tempPath, hashed.sha256)
    return {
      key,
      size: hashed.size,
      sha256: hashed.sha256,
      contentType: metadata.contentType,
      contentDisposition: metadata.contentDisposition,
      metadata: metadata.metadata,
      tags: metadata.tags,
      file: relative,
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}
