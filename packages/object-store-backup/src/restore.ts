// The restore command.
//
// ORDER OF OPERATIONS IS THE WHOLE DESIGN
//
// A restore that writes first and checks later can leave a target store half-full of
// objects with wrong metadata, having already "succeeded" from the caller's point of
// view. This module therefore does every cheap, local check before the first byte is
// uploaded:
//
//   1. the manifest parses and is internally consistent,
//   2. every object file it names exists, with the recorded size AND digest,
//   3. the target bucket exists (or was explicitly created),
//   4. none of the keys already exist on the target — unless overwrite was asked
//      for explicitly.
//
// Only then does it write. After writing it re-reads the target and compares, because
// "the store accepted the PUT" is not evidence that the object is retrievable with its
// metadata and tags intact.
//
// WHAT IT WILL NOT DO
//
// It never deletes objects on the target. A backup is an input to a restore, not a
// mirror: an object present on the target but absent from the backup may be newer
// than the backup, and silently removing it would destroy data the tool was never
// given. Extra objects are reported, never touched. Also, overwriting is opt-in for
// the same reason.

import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { StoreConfig } from './config'
import { redactEndpoint } from './config'
import { OBJECT_DIR, sha256Hex } from './hash'
import { openBackup, decryptAndHash, removeTempFile } from './vault'
import { loadManifest, writeJsonReport, type Manifest, type ManifestObject } from './manifest'
import {
  lifecycleHasIncompleteUploadRule,
  bucketExists,
  createBucket,
  createS3Client,
  listAllObjects,
  putObject,
  readBucketLifecycle,
  writeBucketLifecycle,
} from './s3'
import { classifyError } from './retry'

export type RestoreOptions = {
  backupDir: string
  /** Target store. Never the source store by default — the caller must name it. */
  target: StoreConfig
  /** Create the target bucket when absent. Default false. */
  createTargetBucket?: boolean
  /** Overwrite objects that already exist on the target. Default false. */
  overwrite?: boolean
  /** Apply the captured lifecycle configuration to the target bucket. Default false. */
  applyLifecycle?: boolean
  /** Endpoint used for the presigned-URL and anonymous-access checks. */
  publicEndpoint?: string
  /**
   * Lifecycle XML to apply to the target bucket, read from this file.
   *
   * It exists because "captured from the source bucket" and "what the target needs"
   * are not always the same: MinIO accepts `AbortIncompleteMultipartUpload` but never
   * returns it, so a backup taken from MinIO silently loses that rule. Supplying the
   * configuration explicitly is how a migration reproduces it instead of shipping a
   * lifecycle that expires objects and never aborts the uploads that never finished.
   */
  lifecycleFile?: string
  log?: (line: string) => void
}

type RestoreFailure = { key: string; stage: string; reason: string }
type VerifyFailure = { key: string; category: string; reason: string }

export type RestoreReport = {
  schema_version: 1
  backup_dir: string
  target: { endpoint: string; bucket: string }
  objects_in_manifest: number
  /**
   * Result of comparing the manifest against its recorded digest.
   * `null` means no sidecar was present, so no comparison was possible.
   */
  manifest_checksum_ok: boolean | null
  restored: number
  failed: RestoreFailure[]
  /** Keys present on the target but absent from the backup. Reported, never deleted. */
  extra_on_target: string[]
  post_restore: {
    objects_on_target: number
    verified: number
    content_mismatches: string[]
    metadata_mismatches: string[]
    tag_mismatches: string[]
    /**
     * Per-object reason for every mismatch. The counts above answer "how many"; this
     * answers "why", which is what an operator needs to decide whether to retry.
     */
    verification_failures: VerifyFailure[]
  }
  lifecycle: {
    status: 'applied' | 'not_requested' | 'nothing_to_apply' | 'unsupported'
    detail?: string
  }
  access_checks: {
    anonymous_read_denied: 'pass' | 'fail' | 'not_verified'
    wrong_credentials_denied: 'pass' | 'fail' | 'not_verified'
    presigned_get: 'pass' | 'fail' | 'not_verified'
    detail?: string
  }
  passed: boolean
}

/**
 * The configured age identity, validated once per configured value.
 *
 * The cache is keyed on BACKUP_AGE_IDENTITY rather than being a single slot. A plain
 * "remember the first answer" cache outlives the thing it remembered: if the
 * environment changes between calls it would keep decrypting with a stale path. The
 * CLI runs one command per process so this never bit in production, but it made the
 * suite order-dependent and would bite any long-running caller.
 */
let cachedIdentityEnv: string | undefined
let cachedIdentityPath: string | undefined
async function loadIdentity2(): Promise<string> {
  const configured = process.env.BACKUP_AGE_IDENTITY?.trim()
  if (cachedIdentityPath === undefined || cachedIdentityEnv !== configured) {
    cachedIdentityPath = await (await import('./crypto')).loadAgeIdentity()
    cachedIdentityEnv = configured
  }
  return cachedIdentityPath
}

export async function runRestore(options: RestoreOptions): Promise<RestoreReport> {
  const log = options.log ?? ((line: string) => console.log(line))
  const { backupDir, target } = options

  // --- 1. manifest ------------------------------------------------------------
  // openBackup handles both formats: it decrypts a format-2 manifest and verifies
  // its HMAC before anything is read, and for a plaintext backup it compares the
  // manifest against its `.sha256` sidecar and reports the result. A tampered
  // backup therefore cannot reach a write on either path.
  const opened = await openBackup(backupDir)
  const manifest: Manifest = opened.manifest
  // A plaintext backup carries no HMAC, so its sidecar digest is the only proof
  // that the manifest has not been altered. Restoring from a manifest that fails
  // it would faithfully reproduce a corrupted plan and report success, so refuse
  // before a single byte is written — the same fail-closed posture the per-object
  // preflight below takes.
  if (opened.manifestChecksumOk === false) {
    return buildEarlyFailure(
      backupDir,
      target,
      manifest,
      [
        {
          key: 'manifest.json',
          stage: 'manifest',
          reason: 'manifest.json does not match its recorded digest in manifest.json.sha256',
        },
      ],
      'manifest integrity check failed — refusing to restore from a backup that cannot be trusted',
      false,
      log,
    )
  }
  if (opened.manifestChecksumOk === null) {
    log(
      'WARNING: manifest.json.sha256 is absent, so the manifest could not be integrity-checked. ' +
        'Object bytes are still verified against the manifest before anything is written.',
    )
  }

  // --- 2. every local object, before any write ---------------------------------
  const localFailures: RestoreFailure[] = []
  for (const object of manifest.objects) {
    const path = join(backupDir, object.file)
    const info = await stat(path).catch(() => undefined)
    if (!info) {
      localFailures.push({ key: object.key, stage: 'preflight', reason: 'file is missing' })
      continue
    }
    // A format-2 blob on disk is ciphertext, so its length is not the object's
    // length. Measure the decrypted bytes instead.
    if (opened.format === 1) {
      if (info.size !== object.size) {
        localFailures.push({
          key: object.key,
          stage: 'preflight',
          reason: `size mismatch: manifest ${object.size}, file ${info.size}`,
        })
        continue
      }
      const digest = await (await import('./hash')).hashFile(path)
      if (digest !== object.sha256) {
        localFailures.push({
          key: object.key,
          stage: 'preflight',
          reason: `sha256 mismatch: manifest ${object.sha256}, file ${digest}`,
        })
      }
      continue
    }
    const decrypted = await decryptAndHash(backupDir, object.file, await loadIdentity2())
    await removeTempFile(decrypted.plaintextPath)
    if (decrypted.size !== object.size) {
      localFailures.push({
        key: object.key,
        stage: 'preflight',
        reason: `size mismatch: manifest ${object.size}, decrypted object ${decrypted.size}`,
      })
      continue
    }
    if (decrypted.sha256 !== object.sha256) {
      localFailures.push({
        key: object.key,
        stage: 'preflight',
        reason: `sha256 mismatch: manifest ${object.sha256}, object ${decrypted.sha256}`,
      })
    }
  }
  if (localFailures.length > 0) {
    log(`preflight FAILED for ${localFailures.length} object(s); nothing was written`)
    for (const failure of localFailures.slice(0, 20)) {
      log(`  ${failure.key}: ${failure.reason}`)
    }
    return buildEarlyFailure(backupDir, target, manifest, localFailures)
  }

  // --- 3. target bucket --------------------------------------------------------
  const client = createS3Client(target)
  const exists = await bucketExists(client, target.bucket)
  if (!exists) {
    if (options.createTargetBucket !== true) {
      const message =
        `target bucket "${target.bucket}" does not exist on ${redactEndpoint(target.endpoint)}. ` +
        `Refusing to create it implicitly; pass --create-target-bucket to do so deliberately.`
      log(message)
      return buildEarlyFailure(backupDir, target, manifest, [
        { key: '*', stage: 'target', reason: message },
      ])
    }
    await createBucket(client, target.bucket)
    log(`created target bucket ${target.bucket}`)
  }

  // --- 4. refuse to overwrite unless asked -------------------------------------
  const existing = new Set((await listAllObjects(client, target.bucket)).map((o) => o.key))
  const collisions = manifest.objects.filter((object) => existing.has(object.key))
  if (collisions.length > 0 && options.overwrite !== true) {
    const message =
      `${collisions.length} object(s) already exist on the target and would be overwritten. ` +
      `Refusing, because overwriting a live object with backup content can lose writes made ` +
      `after the backup. Pass --overwrite to proceed, and confirm the target is not serving ` +
      `newer data. First few: ${collisions
        .slice(0, 5)
        .map((o) => o.key)
        .join(', ')}`
    log(message)
    return buildEarlyFailure(backupDir, target, manifest, [
      { key: collisions[0]!.key, stage: 'overwrite', reason: message },
    ])
  }
  if (collisions.length > 0) {
    log(
      `WARNING: --overwrite given; ${collisions.length} existing object(s) on the target will ` +
        `be replaced by backup content.`,
    )
  }

  // --- 5. write -----------------------------------------------------------------
  log(
    `restoring ${manifest.object_count} object(s), ${manifest.total_bytes} byte(s) into bucket ` +
      `"${target.bucket}" on ${redactEndpoint(target.endpoint)}`,
  )
  const failures: RestoreFailure[] = []
  let restored = 0
  for (const object of manifest.objects) {
    try {
      await restoreOne(backupDir, client, target.bucket, object, opened.format)
      restored += 1
      if (restored % 25 === 0) log(`  ${restored}/${manifest.object_count} restored`)
    } catch (error) {
      const reason = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)
      failures.push({ key: object.key, stage: 'upload', reason })
      log(`  FAILED ${object.key}: ${reason}`)
    }
  }

  // --- 6. read the target back and compare --------------------------------------
  const after = await listAllObjects(client, target.bucket)
  const afterKeys = new Set(after.map((object) => object.key))
  const manifestKeys = manifest.objects.map((object) => object.key)
  const missing = manifestKeys.filter((key) => !afterKeys.has(key))
  const extra = [...afterKeys].filter((key) => !manifestKeys.includes(key))
  if (extra.length > 0) {
    log(
      `NOTE: ${extra.length} object(s) exist on the target but not in the backup. They are ` +
        `left untouched — this tool never deletes on the target.`,
    )
  }

  const contentMismatches: string[] = []
  const metadataMismatches: string[] = []
  const tagMismatches: string[] = []
  const verificationFailures: VerifyFailure[] = []
  let verified = 0
  for (const object of manifest.objects) {
    if (!afterKeys.has(object.key)) continue
    try {
      await verifyRestored(client, target.bucket, object)
      verified += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const category = message.split(':')[0] ?? 'UNKNOWN'
      verificationFailures.push({ key: object.key, category, reason: message })
      if (category === 'CONTENT') contentMismatches.push(object.key)
      else if (category === 'METADATA') metadataMismatches.push(object.key)
      else if (category === 'TAGS') tagMismatches.push(object.key)
      else failures.push({ key: object.key, stage: 'verify', reason: message })
    }
  }

  // --- 7. lifecycle -------------------------------------------------------------
  const suppliedLifecycle =
    options.applyLifecycle === true && options.lifecycleFile !== undefined
      ? await readFile(options.lifecycleFile, 'utf8')
      : undefined
  const effectiveLifecycleXml =
    suppliedLifecycle ??
    (manifest.lifecycle.status === 'captured' ? (manifest.lifecycle.xml ?? '') : undefined)

  if (
    effectiveLifecycleXml !== undefined &&
    !lifecycleHasIncompleteUploadRule(effectiveLifecycleXml)
  ) {
    log(
      'WARNING: the lifecycle configuration being applied contains no ' +
        'AbortIncompleteMultipartUpload rule. MinIO accepts that rule but never returns ' +
        'it from GetBucketLifecycleConfiguration, so a backup captured from MinIO cannot ' +
        'reproduce it. Pass --lifecycle-file with the full configuration to restore ' +
        'incomplete-upload cleanup.',
    )
  }

  let lifecycle: RestoreReport['lifecycle'] = { status: 'not_requested' }
  if (options.applyLifecycle === true) {
    if (effectiveLifecycleXml === undefined) {
      lifecycle = {
        status: 'nothing_to_apply',
        detail:
          manifest.lifecycle.status === 'unsupported'
            ? `the source store could not report lifecycle: ${manifest.lifecycle.reason}`
            : 'the source bucket had no lifecycle configuration',
      }
      log(`lifecycle: ${lifecycle.detail}`)
    } else {
      try {
        await writeBucketLifecycle(client, target.bucket, effectiveLifecycleXml)
        lifecycle = {
          status: 'applied',
          ...(suppliedLifecycle !== undefined ? { detail: 'from --lifecycle-file' } : {}),
        }
        log('lifecycle: configuration applied to the target bucket')
      } catch (error) {
        lifecycle = { status: 'unsupported', detail: (error as Error).message }
        log(`lifecycle: could NOT be applied — ${lifecycle.detail}`)
        failures.push({
          key: '*',
          stage: 'lifecycle',
          reason: `captured lifecycle could not be applied: ${lifecycle.detail}`,
        })
      }
    }
  } else if (manifest.lifecycle.status === 'captured') {
    log(
      'lifecycle: a configuration was captured but --apply-lifecycle was not given, so the ' +
        'target bucket was not modified. The configuration is recorded in the manifest.',
    )
  }

  // --- 8. access semantics ------------------------------------------------------
  const accessChecks = await checkAccessSemantics(target, options.publicEndpoint, manifest)

  const passed =
    failures.length === 0 &&
    missing.length === 0 &&
    contentMismatches.length === 0 &&
    metadataMismatches.length === 0 &&
    tagMismatches.length === 0 &&
    verified === manifest.objects.length &&
    lifecycle.status !== 'unsupported' &&
    accessChecks.anonymous_read_denied !== 'fail' &&
    accessChecks.wrong_credentials_denied !== 'fail' &&
    accessChecks.presigned_get !== 'fail'

  const report: RestoreReport = {
    schema_version: 1,
    backup_dir: backupDir,
    target: { endpoint: redactEndpoint(target.endpoint), bucket: target.bucket },
    objects_in_manifest: manifest.object_count,
    manifest_checksum_ok: opened.manifestChecksumOk,
    restored,
    failed: failures,
    extra_on_target: extra,
    post_restore: {
      objects_on_target: after.length,
      verified,
      content_mismatches: contentMismatches,
      metadata_mismatches: metadataMismatches,
      tag_mismatches: tagMismatches,
      verification_failures: verificationFailures,
    },
    lifecycle,
    access_checks: accessChecks,
    passed,
  }
  await writeJsonReport(join(backupDir, 'restore-report.json'), report)

  log(`restored:        ${restored}/${manifest.object_count}`)
  log(`verified:        ${verified}/${manifest.object_count}`)
  if (missing.length > 0) log(`MISSING on target: ${missing.length}`)
  if (contentMismatches.length > 0) log(`CONTENT mismatches: ${contentMismatches.length}`)
  if (metadataMismatches.length > 0) log(`METADATA mismatches: ${metadataMismatches.length}`)
  if (tagMismatches.length > 0) log(`TAG mismatches: ${tagMismatches.length}`)
  log(
    `access checks:    anonymous=${accessChecks.anonymous_read_denied} ` +
      `wrong-creds=${accessChecks.wrong_credentials_denied} presigned=${accessChecks.presigned_get}`,
  )
  log(passed ? 'RESTORE VERIFIED' : 'RESTORE FAILED — see the report for the objects at fault')
  return report
}

function buildEarlyFailure(
  backupDir: string,
  target: StoreConfig,
  manifest: Manifest,
  failures: RestoreFailure[],
  headline?: string,
  manifestChecksumOk: boolean | null = null,
  log: (line: string) => void = () => undefined,
): RestoreReport {
  const report: RestoreReport = {
    schema_version: 1,
    backup_dir: backupDir,
    target: { endpoint: redactEndpoint(target.endpoint), bucket: target.bucket },
    objects_in_manifest: manifest.object_count,
    manifest_checksum_ok: manifestChecksumOk,
    restored: 0,
    failed: failures,
    extra_on_target: [],
    post_restore: {
      objects_on_target: 0,
      verified: 0,
      content_mismatches: [],
      metadata_mismatches: [],
      tag_mismatches: [],
      verification_failures: [],
    },
    lifecycle: { status: 'not_requested' },
    access_checks: {
      anonymous_read_denied: 'not_verified',
      wrong_credentials_denied: 'not_verified',
      presigned_get: 'not_verified',
    },
    passed: false,
  }
  void writeJsonReport(join(backupDir, 'restore-report.json'), report).catch(() => undefined)
  if (headline) log(`RESTORE FAILED — ${headline}`)
  return report
}

/**
 * Stream one object from the backup directory into the target store.
 *
 * For a format-2 backup the file on disk is ciphertext, so it is decrypted to a
 * private temporary file first and it is that plaintext which is uploaded. Uploading
 * the ciphertext would restore an object no client could ever read, and it would
 * "succeed" — which is exactly the kind of silent corruption a restore must not do.
 */
async function restoreOne(
  backupDir: string,
  client: S3Client,
  bucket: string,
  object: ManifestObject,
  format: 1 | 2,
): Promise<void> {
  if (format === 1) {
    const stream = createReadStream(join(backupDir, object.file))
    try {
      await putObject(client, bucket, {
        key: object.key,
        body: stream,
        size: object.size,
        contentType: object.contentType,
        contentDisposition: object.contentDisposition,
        metadata: object.metadata,
        tags: object.tags,
      })
    } finally {
      stream.destroy()
    }
    return
  }

  const identity = await loadIdentity2()
  const { decryptFile, tempPathFor } = await import('./crypto')
  const source = join(backupDir, object.file)
  // The same scratch-path helper the verify path uses, so there is one convention for
  // decrypted scratch files rather than two that could drift.
  const plaintext = tempPathFor(source)
  await decryptFile(source, plaintext, identity)
  try {
    const stream = createReadStream(plaintext)
    try {
      await putObject(client, bucket, {
        key: object.key,
        body: stream,
        size: object.size,
        contentType: object.contentType,
        contentDisposition: object.contentDisposition,
        metadata: object.metadata,
        tags: object.tags,
      })
    } finally {
      stream.destroy()
    }
  } finally {
    await removeTempFile(plaintext)
  }
}

/**
 * Read one object back from the target and compare it to the manifest.
 *
 * The thrown message is prefixed with the failing category so the caller can sort
 * failures into the report's fields without parsing prose.
 */
async function verifyRestored(
  client: S3Client,
  bucket: string,
  object: ManifestObject,
): Promise<void> {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: object.key }))
  const headMetadata = Object.fromEntries(
    Object.entries(head.Metadata ?? {}).filter(([, value]) => value !== undefined) as Array<
      [string, string]
    >,
  )
  const metadataEqual =
    JSON.stringify(sortRecord(headMetadata)) === JSON.stringify(sortRecord(object.metadata))
  if (!metadataEqual) {
    throw new Error(
      `METADATA: expected ${JSON.stringify(object.metadata)}, target has ` +
        `${JSON.stringify(headMetadata)}`,
    )
  }
  if ((head.ContentType ?? null) !== object.contentType) {
    throw new Error(
      `METADATA: content-type expected ${object.contentType}, target has ${head.ContentType ?? null}`,
    )
  }
  if ((head.ContentDisposition ?? null) !== object.contentDisposition) {
    throw new Error(
      `METADATA: content-disposition expected ${object.contentDisposition}, target has ` +
        `${head.ContentDisposition ?? null}`,
    )
  }

  const tagging = await client.send(
    new GetObjectTaggingCommand({ Bucket: bucket, Key: object.key }),
  )
  const tags = Object.fromEntries(
    (tagging.TagSet ?? []).map((tag) => [tag.Key ?? '', tag.Value ?? '']),
  )
  if (JSON.stringify(sortRecord(tags)) !== JSON.stringify(sortRecord(object.tags))) {
    throw new Error(
      `TAGS: expected ${JSON.stringify(object.tags)}, target has ${JSON.stringify(tags)}`,
    )
  }

  // Content: stream the object back and hash it. Never buffered.
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }))
  if (!response.Body) throw new Error(`CONTENT: target returned an empty body`)
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256')
  let size = 0
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    digest.update(chunk)
    size += chunk.byteLength
  }
  const actual = digest.digest('hex')
  if (size !== object.size) throw new Error(`CONTENT: size ${size}, manifest says ${object.size}`)
  if (actual !== object.sha256) {
    throw new Error(`CONTENT: sha256 ${actual}, manifest says ${object.sha256}`)
  }
  if (response.ContentLength !== undefined && response.ContentLength !== object.size) {
    throw new Error(
      `CONTENT: Content-Length header ${response.ContentLength}, manifest says ${object.size}`,
    )
  }
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * Verify the access semantics BeaconHS depends on.
 *
 * Every result is one of pass / fail / not_verified. "not_verified" is returned when
 * the check could not be run at all — for example a store that does not implement
 * bucket policies, or an endpoint that cannot be reached from here. It is never
 * collapsed into "pass": a check that could not run is not a check that passed.
 */
async function checkAccessSemantics(
  target: StoreConfig,
  publicEndpoint: string | undefined,
  manifest: Manifest,
): Promise<RestoreReport['access_checks']> {
  if (manifest.objects.length === 0) {
    return {
      anonymous_read_denied: 'not_verified',
      wrong_credentials_denied: 'not_verified',
      presigned_get: 'not_verified',
      detail: 'the backup contains no objects, so there is nothing to probe',
    }
  }
  const probe = manifest.objects[0]!
  const detail: string[] = []

  const anonymous = await probeAnonymous(
    publicEndpoint ?? target.endpoint,
    target.bucket,
    probe.key,
  )
  const wrong = await probeWrongCredentials(target, target.bucket, probe.key)
  const presigned = await probePresigned(
    target,
    publicEndpoint ?? target.endpoint,
    target.bucket,
    probe.key,
    probe.sha256,
  )

  if (anonymous.detail) detail.push(anonymous.detail)
  if (wrong.detail) detail.push(wrong.detail)
  if (presigned.detail) detail.push(presigned.detail)

  return {
    anonymous_read_denied: anonymous.result,
    wrong_credentials_denied: wrong.result,
    presigned_get: presigned.result,
    ...(detail.length > 0 ? { detail: detail.join('; ') } : {}),
  }
}

async function probeAnonymous(
  endpoint: string,
  bucket: string,
  key: string,
): Promise<{ result: 'pass' | 'fail' | 'not_verified'; detail?: string }> {
  try {
    const url = `${endpoint.replace(/\/$/, '')}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
    const response = await fetch(url, { method: 'GET', redirect: 'manual' })
    if (response.status >= 200 && response.status < 400) {
      return {
        result: 'fail',
        detail: `anonymous GET of ${key} returned HTTP ${response.status}; objects are publicly readable`,
      }
    }
    return { result: 'pass' }
  } catch (error) {
    return {
      result: 'not_verified',
      detail: `anonymous probe could not run: ${(error as Error).message}`,
    }
  }
}

async function probeWrongCredentials(
  target: StoreConfig,
  bucket: string,
  key: string,
): Promise<{ result: 'pass' | 'fail' | 'not_verified'; detail?: string }> {
  try {
    const wrong = new S3Client({
      region: target.region,
      endpoint: target.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: 'deliberately-wrong-key',
        secretAccessKey: 'deliberately-wrong-secret',
      },
    })
    try {
      await wrong.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      return {
        result: 'fail',
        detail: 'a request signed with deliberately wrong credentials was accepted',
      }
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode
      if (status === undefined || classifyError(error) !== 'permanent') {
        return {
          result: 'not_verified',
          detail: `wrong-credential probe was inconclusive (HTTP ${status ?? 'n/a'})`,
        }
      }
      return { result: 'pass' }
    } finally {
      wrong.destroy()
    }
  } catch (error) {
    return {
      result: 'not_verified',
      detail: `wrong-credential probe could not run: ${(error as Error).message}`,
    }
  }
}

async function probePresigned(
  target: StoreConfig,
  publicEndpoint: string,
  bucket: string,
  key: string,
  expectedSha256: string,
): Promise<{ result: 'pass' | 'fail' | 'not_verified'; detail?: string }> {
  try {
    const presignClient = new S3Client({
      region: target.region,
      endpoint: publicEndpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
      },
    })
    const url = await getSignedUrl(
      presignClient,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      {
        expiresIn: 300,
      },
    )
    presignClient.destroy()
    const response = await fetch(url, { method: 'GET' })
    if (response.status !== 200) {
      return {
        result: 'fail',
        detail: `presigned GET returned HTTP ${response.status} against ${redactEndpoint(publicEndpoint)}`,
      }
    }
    const body = Buffer.from(await response.arrayBuffer())
    const digest = sha256Hex(body)
    if (digest !== expectedSha256) {
      return {
        result: 'fail',
        detail: 'presigned GET returned content that does not match the manifest digest',
      }
    }
    return { result: 'pass' }
  } catch (error) {
    return {
      result: 'not_verified',
      detail: `presigned probe could not run against ${redactEndpoint(publicEndpoint)}: ${(error as Error).message}`,
    }
  }
}
