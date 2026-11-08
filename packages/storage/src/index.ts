// S3-compatible storage (Cloudflare R2 in prod, MinIO in dev).
// Same code path either way — only the endpoint changes.

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListPartsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import type { LifecycleRule } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'
import {
  storageObjectTagging,
  withManagedStorageLifecycleRules,
  type StorageObjectLifecycle,
} from './lifecycle'
import {
  MULTIPART_UPLOAD_PART_SIZE_BYTES,
  multipartPartCount,
  shouldUseMultipartUpload,
} from './multipart'
import {
  assertStorageWriteAllowed,
  type GatedStorageOperation,
  getInFlightWriteTracker,
  tenantIdFromObjectKey,
} from './freeze-gate'
import { getStorageWriteArmIssuer } from './write-arms'

export * from './multipart'
export * from './freeze-gate'
export * from './write-arms'

const accountId = process.env.R2_ACCOUNT_ID ?? 'local'
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? 'beaconhs'
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? 'beaconhs-dev-secret'
const bucket = process.env.R2_BUCKET ?? 'beaconhs-dev'

// PUBLIC endpoint — the address the BROWSER reaches. Every presigned URL is minted
// against this, because the signature covers the `host` header the browser will send.
// In dev we point at MinIO. R2 uses https://{account}.r2.cloudflarestorage.com.
function assertS3Origin(value: string, name: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`)
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error(
      `${name} must be an origin-only HTTP(S) URL without credentials, query, or path`,
    )
  }
  return value.replace(/\/+$/, '')
}

function browserReachableStorageOrigin(value: string | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim()
  if (!trimmed) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return false
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false
  if (parsed.pathname !== '' && parsed.pathname !== '/') return false
  // In development an http loopback S3 server (MinIO) is acceptable: it is the same
  // machine that is serving the test/beta page, so the host bytes stay local.
  if (parsed.protocol === 'https:') return true
  const loopback =
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1') &&
    value.trim().length > 0
  return process.env.NODE_ENV !== 'production' && loopback
}

const storagePublicOriginCandidate =
  process.env.PUBLIC_APP_URL?.trim() ||
  process.env.APP_URL?.trim() ||
  process.env.NEXT_PUBLIC_APP_URL?.trim() ||
  ''

// `R2_ENDPOINT` is described as the browser-facing address, but a containerized
// deployment can misconfigure it as the private gateway URL (`http://127.0.0.1`
// or an in-network loopback). Presigning against such a value raises it into
// the browser, where CSP blocks it and users mount their own `127.0.0.1`. Fall
// back to the runtime-resolved application origin when the configured value is
// not actually browser-reachable so URLs stay attributable to a public host.
// A configured `R2_ENDPOINT` that is malformed (e.g. carries a path prefix) is
// a CONFIG ERROR and must fail fast at import, whether or not the PUBLIC_APP_URL
// fallback below would rescue presigning. Validating only the post-fallback
// value let a misconfigured prefix slip through whenever APP_URL was set —
// exactly what CI caught (APP_URL is set there, so the prefix rejection never
// fired and the import resolved instead of throwing).
const configuredR2Endpoint = process.env.R2_ENDPOINT?.trim()
if (configuredR2Endpoint) assertS3Origin(configuredR2Endpoint, 'R2_ENDPOINT')

const browserReachableR2 = browserReachableStorageOrigin(process.env.R2_ENDPOINT)
const rawPublicEndpoint = browserReachableR2
  ? process.env.R2_ENDPOINT!.trim()
  : browserReachableStorageOrigin(storagePublicOriginCandidate)
    ? storagePublicOriginCandidate
    : process.env.R2_ENDPOINT?.trim() ||
      (accountId === 'local'
        ? 'http://localhost:9000'
        : `https://${accountId}.r2.cloudflarestorage.com`)

if (!browserReachableR2 && browserReachableStorageOrigin(storagePublicOriginCandidate)) {
  console.warn(
    '[storage] R2_ENDPOINT is not browser-reachable; falling back to PUBLIC_APP_URL for presigned URLs',
  )
}

const publicEndpoint = assertS3Origin(rawPublicEndpoint, 'R2_ENDPOINT')

/**
 * INTERNAL endpoint — where the application's own S3 I/O goes. Keeping this separate
 * is what stops `putObject`/`getObject`/`headObject`/`deleteObject` from round-tripping
 * out to the public hostname and back through a CDN or tunnel on every call.
 *
 * In production this is mandatory. Falling back to the public endpoint there would
 * silently restore exactly the hairpin dependency this split exists to remove, and the
 * failure would be invisible: it works, just slowly and with an external dependency.
 */
function resolveInternalEndpoint(publicEndpoint: string): string {
  const configured = process.env.R2_INTERNAL_ENDPOINT?.trim()
  if (configured) return assertS3Origin(configured, 'R2_INTERNAL_ENDPOINT')
  if (isProductionRuntime()) {
    throw new Error(
      'R2_INTERNAL_ENDPOINT is required when NODE_ENV=production. It must be the private, ' +
        'in-network address of the object store (for example http://minio:9000) so server-side ' +
        'S3 I/O does not traverse the public endpoint. R2_ENDPOINT stays the browser/presign ' +
        'endpoint and is intentionally NOT used as a fallback here.',
    )
  }
  return publicEndpoint
}

/**
 * `next build` sets NODE_ENV=production while merely collecting page data, without any
 * runtime secrets present. Enforcing the production rule there would fail the build for a
 * configuration problem that only matters once the server is actually serving — and
 * `next build` runs as NEXT_PHASE=phase-production-build (next/dist/shared/lib/constants.js).
 * A real production server runs as phase-production-server, and the worker / storage-init /
 * scheduler roles never set NEXT_PHASE at all. So the rule applies to any production
 * process that is not a Next build: the standalone server and all three worker roles fail
 * fast, while build-time imports resolve normally.
 */
function isProductionRuntime(): boolean {
  if (process.env.NODE_ENV !== 'production') return false
  return process.env.NEXT_PHASE !== 'phase-production-build'
}

const internalEndpoint = resolveInternalEndpoint(publicEndpoint)

function createS3Client(endpoint: string): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })
}

// Server-side I/O. Never the public endpoint in production.
const internalClient = createS3Client(internalEndpoint)

// Streaming writes receive a live web ReadableStream. The SDK's default
// flexible checksum has to hash the body, and a request body that is already
// flowing cannot be hashed without buffering it — which is exactly what the
// streaming path exists to avoid. These operations do not require a checksum,
// so this client asks for one only when the operation itself requires it.
const streamingClient = new S3Client({
  region: 'auto',
  endpoint: internalEndpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
})

export const BUCKET = bucket

/**
 * Server-enforced presigned-write lifetimes.
 *
 * Callers import these instead of repeating literals so a request can never ask for
 * a longer capability than the arm ledger is willing to record.
 */
export const MAX_PRESIGN_PUT_EXPIRES_SECONDS = 120
export const MAX_PRESIGN_MULTIPART_PART_EXPIRES_SECONDS = 60

/** Exported for tests and diagnostics; production code must not branch on these. */
export const ENDPOINTS = {
  public: publicEndpoint,
  internal: internalEndpoint,
} as const

function isCloudflareR2Endpoint(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('R2_ENDPOINT must be an absolute HTTP(S) URL')
  }
  const hostname = parsed.hostname.toLowerCase()
  return hostname === 'r2.cloudflarestorage.com' || hostname.endsWith('.r2.cloudflarestorage.com')
}

// Derived from the PUBLIC endpoint: it describes what the internet reaches, which is what
// decides whether Cloudflare's non-S3 public-domain caveats apply.
const isR2 = isCloudflareR2Endpoint(publicEndpoint)

function storageErrorCode(error: unknown): string | undefined {
  const value = error as { name?: string; code?: string; Code?: string }
  return value.name ?? value.code ?? value.Code
}

function storageErrorStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
}

function isMissingBucketError(error: unknown): boolean {
  const code = storageErrorCode(error)
  return storageErrorStatus(error) === 404 || code === 'NotFound' || code === 'NoSuchBucket'
}

function isMissingPolicyError(error: unknown): boolean {
  const code = storageErrorCode(error)
  return (
    storageErrorStatus(error) === 404 ||
    code === 'NoSuchBucketPolicy' ||
    code === 'NoSuchLifecycleConfiguration' ||
    code === 'NoSuchPolicy' ||
    code === 'NotFound'
  )
}

/**
 * Unsigned object URL, used only to PROVE that anonymous access is denied. It is not a
 * delivery path — delivery always goes through a presigned URL or an authorized route.
 */
function anonymousObjectUrl(endpoint: string, key: string): string {
  const base = endpoint.replace(/\/$/, '')
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return `${base}/${encodeURIComponent(bucket)}/${encodedKey}`
}

/** Assert an unsigned GET is refused. Returns the observed status for the caller. */
async function assertAnonymousReadDenied(url: string, label: string): Promise<number> {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  try {
    if (response.status >= 200 && response.status < 400) {
      throw new Error(
        `Storage privacy verification failed on the ${label} endpoint: anonymous read returned HTTP ${response.status}`,
      )
    }
    return response.status
  } finally {
    await response.body?.cancel()
  }
}

/**
 * Idempotently establish the storage security baseline.
 *
 * MinIO/S3 buckets are made private by removing their bucket policy, then an
 * unsigned canary read proves the endpoint does not expose objects. Cloudflare
 * R2 public domains are configured outside the S3 API, so production must set
 * R2_PRIVATE_BUCKET_CONFIRMED=true only after r2.dev/custom-domain access has
 * been disabled and independently verified.
 */
export async function ensureBucket(): Promise<void> {
  try {
    await internalClient.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (error) {
    if (!isMissingBucketError(error)) throw error
    await internalClient.send(new CreateBucketCommand({ Bucket: bucket }))
  }
  await ensurePrivateBucketReady()
}

/** Remove anonymous access, configure managed object expiry, and prove privacy. */
export async function ensurePrivateBucketReady(): Promise<void> {
  if (process.env.R2_PUBLIC_URL) {
    throw new Error(
      'R2_PUBLIC_URL must be removed: BeaconHS storage is private and objects are served through authorized or expiring URLs',
    )
  }

  if (isR2) {
    if (process.env.R2_PRIVATE_BUCKET_CONFIRMED !== 'true') {
      throw new Error(
        'R2_PRIVATE_BUCKET_CONFIRMED=true is required after disabling every R2 public development URL and custom domain',
      )
    }
  } else {
    try {
      await internalClient.send(new DeleteBucketPolicyCommand({ Bucket: bucket }))
    } catch (error) {
      if (!isMissingPolicyError(error)) throw error
    }
  }

  let existingRules: LifecycleRule[] = []
  try {
    const lifecycle = await internalClient.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    )
    existingRules = lifecycle.Rules ?? []
  } catch (error) {
    if (!isMissingPolicyError(error)) throw error
  }

  await internalClient.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: withManagedStorageLifecycleRules(existingRules),
      },
    }),
  )

  const probeKey = `_privacy-probe/${randomUUID()}`
  await writeAndRemovePrivacyProbe(probeKey)
  try {
    // Authoritative probe, on the INTERNAL endpoint. Bucket privacy is one object-level
    // fact, and proving it over the private path is sufficient — which is also what lets
    // `storage-init` bootstrap with the public edge/tunnel stopped.
    await assertAnonymousReadDenied(anonymousObjectUrl(internalEndpoint, probeKey), 'internal')
  } finally {
    await writeAndRemovePrivacyProbe(probeKey)
  }
}

/**
 * Write and immediately delete the bucket-privacy probe object, ungated.
 *
 * Phase 6R (E2-A) deliberately exempts this from the freeze gate, and the exemption is
 * narrow on purpose:
 *
 *   * it is not tenant data. The key is `_privacy-probe/<uuid>`, which no tenant owns,
 *     and the gate's tenant derivation therefore cannot authorise it at all;
 *   * `ensureBucket()` must keep working while a tenant is frozen. It is the check that
 *     proves the bucket is private and its lifecycle rules are correct — the
 *     configuration a freeze depends on. Refusing it would let a frozen tenant's
 *     bucket stop being verified;
 *   * it writes exactly one synthetic byte and deletes it in the same call.
 *
 * This is stated as a boundary so it can be reviewed, not hidden: if the intent is ever
 * that bucket bootstrap must also stop during a freeze, this is the line to change.
 */
export async function writeAndRemovePrivacyProbe(key: string): Promise<void> {
  let putError: Error | undefined
  let deleteError: Error | undefined

  // PUT is NOT retried: if the user's write fails, we want to surface that
  // error. The probe is a synthetic byte, so a PUT failure is a problem.
  try {
    await internalClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: new Uint8Array([1]),
        ContentType: 'application/octet-stream',
      }),
    )
  } catch (error) {
    putError = error instanceof Error ? error : new Error(String(error))
    // Continue to DELETE even if PUT failed — we want to clean up if possible.
  }

  // DELETE is retried: S3 delete is idempotent and can fail transiently.
  const maxRetries = 3
  let lastDeleteError: Error | undefined

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await internalClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      // Success: no error to return
      return
    } catch (error) {
      lastDeleteError = error instanceof Error ? error : new Error(String(error))

      // If this was the last attempt, we're done trying.
      if (attempt === maxRetries) {
        deleteError = lastDeleteError
        break
      }

      // Exponential backoff: 100ms, 200ms, 400ms.
      const backoffMs = attempt * 100
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }

  // If we get here, DELETE failed after all retries. The probe object remains
  // in the bucket. Log the error for investigation.
  if (deleteError) {
    console.error(
      '[writeAndRemovePrivacyProbe] DELETE failed after',
      maxRetries,
      'attempts for key:',
      key,
      'error:',
      deleteError.message,
    )
  }

  // If PUT failed and DELETE also failed, the caller will see the PUT error
  // (it propagates). If only DELETE failed, we throw an error that indicates
  // the probe could not be cleaned up.
  if (putError) {
    throw putError
  }

  throw new Error(`Failed to delete privacy probe ${key} after ${maxRetries} attempts`)
}

/**
 * Separately prove the PUBLIC/presign surface denies anonymous reads.
 *
 * This is a distinct check from `ensureBucket()` on purpose. The public endpoint is the
 * attacker-facing one, so it deserves its own proof; but proving it requires that endpoint
 * to be reachable, and `storage-init` must not depend on the edge. So it is exposed here
 * for the operator and the E2E to run explicitly rather than being folded into bootstrap
 * (which would reintroduce the tunnel dependency) or dropped (which would lose coverage).
 */
export async function verifyPublicEndpointPrivacy(): Promise<void> {
  if (publicEndpoint === internalEndpoint) return
  const probeKey = `_privacy-probe/${randomUUID()}`
  // Same narrow exemption as `writeAndRemovePrivacyProbe`: this probe is bucket
  // infrastructure verification on a synthetic non-tenant key, not tenant data, and
  // the public-surface proof must remain runnable independently of a freeze.
  await writeAndRemovePrivacyProbe(probeKey)
  try {
    await assertAnonymousReadDenied(anonymousObjectUrl(publicEndpoint, probeKey), 'public')
  } finally {
    await writeAndRemovePrivacyProbe(probeKey)
  }
}

/**
 * Admit one controlled write, refusing every non-ACTIVE or indeterminate state.
 */
async function admitWrite(operation: GatedStorageOperation, key: string): Promise<void> {
  await assertStorageWriteAllowed({ operation, key })
}

/**
 * Wrap a request body in a stream that must carry EXACTLY `expected` bytes.
 *
 * A streamed upload has no single buffer to measure, so the length is checked
 * as the bytes flow: more than expected fails immediately, and a stream that
 * ends early fails too. Without this, a client could truncate an upload and the
 * object store would hold a corrupt object that still carries a valid upload
 * token — the finalize step would then verify a file nobody uploaded whole.
 */
async function exactLengthStream(
  body: ReadableStream<Uint8Array>,
  expected: number,
): Promise<import('node:stream').Readable> {
  // Imported HERE, not at module load: this module is also part of the Edge
  // instrumentation bundle, where `node:stream` does not exist. The function is
  // only ever called from the Node route handler.
  const { Readable, Transform } = await import('node:stream')
  let seen = 0
  // The object store rejects an aws-chunked upload whose chunks exceed 16 MiB,
  // and a browser (or a test) may hand us one large chunk. Re-chunking here
  // keeps every write valid without buffering the body: each incoming chunk is
  // bounded by the source, and each outgoing chunk is bounded by this constant.
  const MAX_CHUNK_BYTES = 1024 * 1024
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.byteLength
      if (seen > expected) {
        callback(
          new Error(
            `STORAGE_UPLOAD_LENGTH_MISMATCH: received more than the declared ${expected} bytes`,
          ),
        )
        return
      }
      for (let offset = 0; offset < chunk.byteLength; offset += MAX_CHUNK_BYTES) {
        this.push(chunk.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, chunk.byteLength)))
      }
      callback()
    },
    flush(callback) {
      if (seen !== expected) {
        callback(
          new Error(
            `STORAGE_UPLOAD_LENGTH_MISMATCH: received ${seen} of the declared ${expected} bytes`,
          ),
        )
        return
      }
      callback()
    },
  })
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]).pipe(guard)
}

/**
 * The server-side equivalent of a presigned PUT.
 *
 * A presigned PUT hands the WRITE to the browser, which means the object store
 * must be reachable from the public internet. This function performs the same
 * write from the application, over the INTERNAL endpoint, so the object store
 * never needs a public address.
 *
 * The body is a STREAM, not a buffer: a 500 MB video must not be held in the
 * web process's memory. Its length is enforced as it flows, so a truncated or
 * inflated upload is refused rather than stored.
 *
 * The write-arm semantics are identical to `presignPut`: the arm is issued
 * first (so the tenant's freeze state is consulted and the intent is
 * recorded), the arm is activated only once the object is stored, and it is
 * withdrawn if the write fails. The upload token is written into the object's
 * metadata exactly as the presigned path would have done, so the existing
 * `finalizeUpload` verification — which compares the stored object's
 * `upload-token` metadata against the reservation's hash — keeps working
 * unchanged.
 */
export async function putStagedObject(args: {
  key: string
  contentType: string
  uploadToken: string
  body: ReadableStream<Uint8Array>
  contentLength: number
}): Promise<void> {
  await assertStorageWriteAllowed({ operation: 'presignPut', key: args.key })

  const tenantId = tenantIdFromObjectKey(args.key)
  const issuer = getStorageWriteArmIssuer()
  if (!issuer) throw new Error('STORAGE_WRITE_BLOCKED: presigned write arm issuer not registered')
  if (!tenantId)
    throw new Error('STORAGE_WRITE_BLOCKED: presigned write requires a tenant-scoped key')

  const arm = await issuer.issue({
    tenantId,
    key: args.key,
    operation: 'presignPut',
    requestedExpiresInSeconds: MAX_PRESIGN_PUT_EXPIRES_SECONDS,
    uploadToken: args.uploadToken,
  })
  if (!arm) throw new Error('STORAGE_WRITE_BLOCKED: could not issue write arm for tenant')

  try {
    await streamingClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: args.key,
        ContentType: args.contentType,
        ContentLength: args.contentLength,
        Body: await exactLengthStream(args.body, args.contentLength),
        Metadata: { 'upload-token': arm.uploadToken },
        Tagging: 'beaconhs-state=pending',
      }),
    )
    try {
      await issuer.activate({ armId: arm.armId, tenantId })
    } catch (activateError) {
      console.error('[putStagedObject] arm activation failed; row remains issuing', {
        key: args.key,
        armId: arm.armId,
        error: activateError,
      })
    }
  } catch (error) {
    try {
      await issuer.withdraw({
        armId: arm.armId,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      })
    } catch (withdrawError) {
      console.error('[putStagedObject] arm withdraw failed', {
        key: args.key,
        armId: arm.armId,
        error: withdrawError,
      })
    }
    throw error
  }
}

/**
 * The server-side equivalent of a presigned multipart-part upload.
 *
 * The part's bytes travel to the application and are then written to the
 * object store over the internal endpoint. The multipart upload itself was
 * created with the upload-token metadata, so the assembled object keeps the
 * metadata the finalize step verifies.
 *
 * The part is streamed and its length is enforced, so the part size is the one
 * the reservation implies and not one the caller chose.
 */
export async function uploadStagedPart(args: {
  key: string
  uploadId: string
  partNumber: number
  body: ReadableStream<Uint8Array>
  contentLength: number
}): Promise<void> {
  if (!Number.isInteger(args.partNumber) || args.partNumber < 1 || args.partNumber > 10_000) {
    throw new Error('Multipart part number must be between 1 and 10000')
  }
  await assertStorageWriteAllowed({ operation: 'presignMultipartPart', key: args.key })

  const tenantId = tenantIdFromObjectKey(args.key)
  const issuer = getStorageWriteArmIssuer()
  if (!issuer) throw new Error('STORAGE_WRITE_BLOCKED: presigned write arm issuer not registered')
  if (!tenantId)
    throw new Error('STORAGE_WRITE_BLOCKED: presigned write requires a tenant-scoped key')

  const arm = await issuer.issue({
    tenantId,
    key: args.key,
    operation: 'presignMultipartPart',
    requestedExpiresInSeconds: MAX_PRESIGN_MULTIPART_PART_EXPIRES_SECONDS,
    uploadId: args.uploadId,
  })
  if (!arm) throw new Error('STORAGE_WRITE_BLOCKED: could not issue write arm for multipart upload')

  try {
    await streamingClient.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: args.key,
        UploadId: args.uploadId,
        PartNumber: args.partNumber,
        ContentLength: args.contentLength,
        Body: await exactLengthStream(args.body, args.contentLength),
      }),
    )
    try {
      await issuer.activate({ armId: arm.armId, tenantId })
    } catch (activateError) {
      console.error('[uploadStagedPart] arm activation failed', {
        key: args.key,
        armId: arm.armId,
        error: activateError,
      })
    }
  } catch (error) {
    try {
      await issuer.withdraw({
        armId: arm.armId,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      })
    } catch (withdrawError) {
      console.error('[uploadStagedPart] arm withdraw failed', {
        key: args.key,
        armId: arm.armId,
        error: withdrawError,
      })
    }
    throw error
  }
}

/**
 * Internal multipart creation, ungated.
 *
 * `putObject` calls this AFTER its own gate check has passed, so the decision has
 * already been made for this key. Re-checking here would be a second database read
 * that can disagree with the first, and refusing mid-write is a different failure
 * from refusing the write.
 *
 * This is a boundary, not a hole: `createMultipartUploadInternal` is not exported.
 */
async function createMultipartUploadInternal(args: {
  key: string
  contentType: string
  contentDisposition?: 'inline' | 'attachment'
  uploadToken?: string
  lifecycle?: StorageObjectLifecycle
}): Promise<string> {
  const result = await internalClient.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: args.key,
      ContentType: args.contentType,
      ContentDisposition: args.contentDisposition ?? 'attachment',
      Metadata: args.uploadToken ? { 'upload-token': args.uploadToken } : undefined,
      Tagging: args.uploadToken ? 'beaconhs-state=pending' : storageObjectTagging(args.lifecycle),
    }),
  )
  if (!result.UploadId) throw new Error('Storage did not create a multipart upload')
  return result.UploadId
}

export async function createMultipartUpload(args: {
  key: string
  contentType: string
  contentDisposition?: 'inline' | 'attachment'
  uploadToken?: string
  lifecycle?: StorageObjectLifecycle
}): Promise<string> {
  await admitWrite('createMultipartUpload', args.key)

  const tenantId = tenantIdFromObjectKey(args.key)
  const tracker = getInFlightWriteTracker()

  // Phase 6U-B3-B (strict): registration is mandatory.
  if (!tracker) {
    throw new Error(
      'STORAGE_WRITE_BLOCKED: in-flight tracker not registered for tenant storage write',
    )
  }
  if (!tenantId) {
    throw new Error('STORAGE_WRITE_BLOCKED: storage write requires a tenant-scoped object key')
  }

  let writeRecordId: string | null = null
  try {
    writeRecordId = await tracker.register({
      tenantId,
      operation: 'createMultipartUpload',
      key: args.key,
      leaseId: null,
      leaseVersion: 0,
    })
  } catch (regError) {
    throw new Error(
      `STORAGE_WRITE_BLOCKED: in-flight registration failed: ${regError instanceof Error ? regError.message : String(regError)}`,
    )
  }
  if (!writeRecordId) {
    throw new Error('STORAGE_WRITE_BLOCKED: in-flight registration returned null')
  }

  try {
    const uploadId = await createMultipartUploadInternal(args)

    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markCompleted({
          tenantId,
          key: args.key,
          leaseId: null,
          recordId: writeRecordId,
        })
      } catch (markError) {
        console.error('[createMultipartUpload] markCompleted failed', {
          key: args.key,
          error: markError,
        })
      }
    }

    return uploadId
  } catch (error) {
    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markFailed({
          tenantId,
          key: args.key,
          leaseId: null,
          recordId: writeRecordId,
          error: error instanceof Error ? error.message : String(error),
        })
      } catch (markError) {
        console.error('[createMultipartUpload] markFailed failed', {
          key: args.key,
          error: markError,
        })
      }
    }
    throw error
  }
}

export async function completeMultipartUpload(args: {
  key: string
  uploadId: string
}): Promise<void> {
  await admitWrite('completeMultipartUpload', args.key)

  const tenantId = tenantIdFromObjectKey(args.key)
  const tracker = getInFlightWriteTracker()

  // Phase 6U-B3-B (strict): registration is mandatory.
  if (!tracker) {
    throw new Error(
      'STORAGE_WRITE_BLOCKED: in-flight tracker not registered for tenant storage write',
    )
  }
  if (!tenantId) {
    throw new Error('STORAGE_WRITE_BLOCKED: storage write requires a tenant-scoped object key')
  }

  let writeRecordId: string | null = null
  try {
    writeRecordId = await tracker.register({
      tenantId,
      operation: 'completeMultipartUpload',
      key: args.key,
      leaseId: null,
      leaseVersion: 0,
    })
  } catch (regError) {
    throw new Error(
      `STORAGE_WRITE_BLOCKED: in-flight registration failed: ${regError instanceof Error ? regError.message : String(regError)}`,
    )
  }
  if (!writeRecordId) {
    throw new Error('STORAGE_WRITE_BLOCKED: in-flight registration returned null')
  }

  try {
    const parts: Array<{ ETag: string; PartNumber: number }> = []
    let partNumberMarker: string | undefined
    do {
      const page = await internalClient.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: args.key,
          UploadId: args.uploadId,
          PartNumberMarker: partNumberMarker,
        }),
      )
      for (const part of page.Parts ?? []) {
        if (!part.ETag || !part.PartNumber) {
          throw new Error('Storage returned an incomplete multipart part record')
        }
        parts.push({ ETag: part.ETag, PartNumber: part.PartNumber })
      }
      partNumberMarker = page.IsTruncated ? page.NextPartNumberMarker : undefined
    } while (partNumberMarker)

    if (parts.length === 0) throw new Error('Multipart upload contains no parts')
    parts.sort((left, right) => left.PartNumber - right.PartNumber)
    await internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: args.key,
        UploadId: args.uploadId,
        MultipartUpload: { Parts: parts },
      }),
    )

    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markCompleted({
          tenantId,
          key: args.key,
          leaseId: null,
          recordId: writeRecordId,
        })
      } catch (markError) {
        console.error('[completeMultipartUpload] markCompleted failed', {
          key: args.key,
          error: markError,
        })
      }
    }
  } catch (error) {
    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markFailed({
          tenantId,
          key: args.key,
          leaseId: null,
          recordId: writeRecordId,
          error: error instanceof Error ? error.message : String(error),
        })
      } catch (markError) {
        console.error('[completeMultipartUpload] markFailed failed', {
          key: args.key,
          error: markError,
        })
      }
    }
    throw error
  }
}

/**
 * Internal multipart abort, ungated.
 *
 * Used only by `putObject`'s own rollback path. Gating it would mean that a write
 * authorised while ACTIVE, which then fails after a freeze was requested mid-flight,
 * could not clean up — leaving a dangling multipart upload for the lifecycle abort
 * rule to collect later. Undoing an authorised write must not need a fresh
 * authorisation, or the cleanup can be refused while the garbage remains.
 *
 * This is the in-flight-write window described in the Phase 6R report; it is closed
 * by E2-B/E3 draining, not by re-gating the cleanup.
 */
async function abortMultipartUploadInternal(args: {
  key: string
  uploadId: string
}): Promise<void> {
  await internalClient.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: args.key,
      UploadId: args.uploadId,
    }),
  )
}

export async function abortMultipartUpload(args: { key: string; uploadId: string }): Promise<void> {
  await admitWrite('abortMultipartUpload', args.key)

  const tenantId = tenantIdFromObjectKey(args.key)
  const tracker = getInFlightWriteTracker()

  // Phase 6U-B3-B (strict): registration is mandatory.
  if (!tracker) {
    throw new Error(
      'STORAGE_WRITE_BLOCKED: in-flight tracker not registered for tenant storage write',
    )
  }
  if (!tenantId) {
    throw new Error('STORAGE_WRITE_BLOCKED: storage write requires a tenant-scoped object key')
  }

  let writeRecordId: string | null = null
  try {
    writeRecordId = await tracker.register({
      tenantId,
      operation: 'abortMultipartUpload',
      key: args.key,
      leaseId: null,
      leaseVersion: 0,
    })
  } catch (regError) {
    throw new Error(
      `STORAGE_WRITE_BLOCKED: in-flight registration failed: ${regError instanceof Error ? regError.message : String(regError)}`,
    )
  }
  if (!writeRecordId) {
    throw new Error('STORAGE_WRITE_BLOCKED: in-flight registration returned null')
  }

  try {
    await abortMultipartUploadInternal(args)

    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markCompleted({
          tenantId,
          key: args.key,
          leaseId: null,
          recordId: writeRecordId,
        })
      } catch (markError) {
        console.error('[abortMultipartUpload] markCompleted failed', {
          key: args.key,
          error: markError,
        })
      }
    }
  } catch (error) {
    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markFailed({
          tenantId,
          key: args.key,
          leaseId: null,
          recordId: writeRecordId,
          error: error instanceof Error ? error.message : String(error),
        })
      } catch (markError) {
        console.error('[abortMultipartUpload] markFailed failed', {
          key: args.key,
          error: markError,
        })
      }
    }
    throw error
  }
}

/**
 * Server-side direct upload. Used by the worker to push rendered PDFs
 * into MinIO/R2 without having to round-trip through a presigned URL.
 */
export async function putObject(args: {
  key: string
  body: Buffer | Uint8Array
  contentType: string
  contentDisposition?: 'inline' | 'attachment'
  lifecycle?: StorageObjectLifecycle
}): Promise<void> {
  await admitWrite('putObject', args.key)

  const tenantId = tenantIdFromObjectKey(args.key)
  const tracker = getInFlightWriteTracker()

  // Phase 6U-B3-B (strict): tracker registration is mandatory. A missing or
  // failing registration must NOT fall through to a no-tracking write.
  if (!tracker) {
    throw new Error(
      'STORAGE_WRITE_BLOCKED: in-flight tracker not registered for tenant storage write',
    )
  }
  if (!tenantId) {
    throw new Error('STORAGE_WRITE_BLOCKED: storage write requires a tenant-scoped object key')
  }

  let writeRecordId: string | null = null
  try {
    writeRecordId = await tracker.register({
      tenantId,
      operation: 'putObject',
      key: args.key,
      leaseId: null,
      leaseVersion: 0,
    })
  } catch (regError) {
    throw new Error(
      `STORAGE_WRITE_BLOCKED: in-flight registration failed: ${regError instanceof Error ? regError.message : String(regError)}`,
    )
  }
  if (!writeRecordId) {
    throw new Error('STORAGE_WRITE_BLOCKED: in-flight registration returned null')
  }

  try {
    if (shouldUseMultipartUpload(args.body.byteLength)) {
      const uploadId = await createMultipartUploadInternal({
        key: args.key,
        contentType: args.contentType,
        contentDisposition: args.contentDisposition,
        lifecycle: args.lifecycle,
      })
      try {
        const parts: Array<{ ETag: string; PartNumber: number }> = []
        const partCount = multipartPartCount(args.body.byteLength)
        for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
          const offset = (partNumber - 1) * MULTIPART_UPLOAD_PART_SIZE_BYTES
          const result = await internalClient.send(
            new UploadPartCommand({
              Bucket: bucket,
              Key: args.key,
              UploadId: uploadId,
              PartNumber: partNumber,
              Body: args.body.subarray(
                offset,
                Math.min(offset + MULTIPART_UPLOAD_PART_SIZE_BYTES, args.body.byteLength),
              ),
            }),
          )
          if (!result.ETag) throw new Error(`Storage did not confirm multipart part ${partNumber}`)
          parts.push({ ETag: result.ETag, PartNumber: partNumber })
        }
        await internalClient.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: args.key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        )
      } catch (error) {
        // Roll back with the INTERNAL helper: the write was already admitted at the
        // `putObject` boundary, and refusing cleanup because a freeze arrived mid-write
        // would strand an unfinished multipart upload.
        await abortMultipartUploadInternal({ key: args.key, uploadId }).catch(() => undefined)
        throw error
      }
      if (tracker && tenantId && writeRecordId) {
        try {
          await tracker.markCompleted({
            tenantId,
            key: args.key,
            leaseId: null,
            recordId: writeRecordId,
          })
        } catch (markError) {
          console.error('[putObject] markCompleted failed', { key: args.key, error: markError })
        }
      }
      return
    }
    await internalClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: args.key,
        Body: args.body,
        ContentType: args.contentType,
        ContentDisposition: args.contentDisposition ?? 'attachment',
        Tagging: storageObjectTagging(args.lifecycle),
      }),
    )
    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markCompleted({
          tenantId,
          key: args.key,
          leaseId: null,
          recordId: writeRecordId,
        })
      } catch (markError) {
        console.error('[putObject] markCompleted failed', { key: args.key, error: markError })
      }
    }
  } catch (error) {
    // Phase 6U-B3: Mark as failed
    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markFailed({
          tenantId,
          key: args.key,
          leaseId: null,
          recordId: writeRecordId,
          error: error instanceof Error ? error.message : String(error),
        })
      } catch (markError) {
        console.error('[putObject] markFailed failed', { key: args.key, error: markError })
      }
    }
    throw error
  }
}

/**
 * A short-lived signed GET URL for SERVER-SIDE use only.
 *
 * It is signed against the INTERNAL endpoint, because the only remaining
 * consumers are server-side renderers that fetch the object themselves: the
 * worker embedding a PDF, and the PDF renderer embedding a photo or a logo. An
 * internal URL is useless to a browser, which is deliberate — a URL that a
 * browser could use would require the object store to be reachable from the
 * public internet, and that is exactly what this architecture forbids.
 *
 * A browser never receives one of these. The browser-facing URL is
 * `storageObjectUrl()` in the web app, which authorizes the caller and streams
 * the bytes through the application.
 */
export async function presignGet(args: {
  key: string
  expiresInSeconds?: number
  responseContentType?: string
  responseContentDisposition?: string
}): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: args.key,
    ResponseContentType: args.responseContentType,
    ResponseContentDisposition: args.responseContentDisposition,
  })
  return getSignedUrl(internalClient, cmd, { expiresIn: args.expiresInSeconds ?? 600 })
}

export function contentDisposition(
  mode: 'inline' | 'attachment',
  filename: string,
  fallback: string,
): string {
  const original = filename.trim().substring(0, 200) || fallback
  const ascii = original.replace(/["\\\r\n]/g, '_').substring(0, 200) || fallback
  const encoded = encodeURIComponent(original)
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

function decodedUrlPathParts(url: URL): string[] | null {
  const encodedParts = url.pathname.split('/').slice(1)
  if (encodedParts.at(-1) === '') encodedParts.pop()
  const parts: string[] = []
  for (const encodedPart of encodedParts) {
    if (!encodedPart) return null
    let part: string
    try {
      part = decodeURIComponent(encodedPart)
    } catch {
      return null
    }
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      part.includes('/') ||
      part.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(part)
    ) {
      return null
    }
    parts.push(part)
  }
  return parts
}

/**
 * Recover an object key only when a URL points at the configured path-style
 * S3 endpoint and bucket. Other origins are deliberately left to their caller
 * so legitimate public branding URLs continue to work.
 */
export function objectKeyFromStorageUrl(args: {
  url: string
  endpoint: string
  bucket: string
}): string | null {
  let candidate: URL
  let configuredEndpoint: URL
  try {
    candidate = new URL(args.url)
    configuredEndpoint = new URL(args.endpoint)
  } catch {
    return null
  }
  if (
    !['http:', 'https:'].includes(candidate.protocol) ||
    !['http:', 'https:'].includes(configuredEndpoint.protocol) ||
    candidate.username ||
    candidate.password ||
    configuredEndpoint.username ||
    configuredEndpoint.password ||
    candidate.origin !== configuredEndpoint.origin
  ) {
    return null
  }

  const candidateParts = decodedUrlPathParts(candidate)
  const endpointParts = decodedUrlPathParts(configuredEndpoint)
  if (!candidateParts || !endpointParts) return null
  if (endpointParts.some((part, index) => candidateParts[index] !== part)) return null
  const bucketIndex = endpointParts.length
  if (candidateParts[bucketIndex] !== args.bucket) return null
  const keyParts = candidateParts.slice(bucketIndex + 1)
  const key = keyParts.join('/')
  return key && key.length <= 1_024 ? key : null
}

export function assertTenantLogoObjectKey(args: { tenantId: string; key: string }): void {
  if (!UUID_RE.test(args.tenantId)) throw new Error('Tenant id must be a UUID')
  if (!args.key || args.key.length > 1_024 || args.key.includes('\\')) {
    throw new Error('Tenant branding object key is invalid')
  }
  const tenantId = args.tenantId.toLowerCase()
  const parts = args.key.split('/')
  const hasValidParts = parts.every(
    (part) => OBJECT_KEY_PART_RE.test(part) && part !== '.' && part !== '..',
  )
  const ownedBrandingKey =
    hasValidParts &&
    (parts[0] === 'tenants' || parts[0] === 't') &&
    parts[1] === tenantId &&
    parts[2] === 'branding' &&
    parts.length >= 4
  if (!ownedBrandingKey) {
    throw new Error('Tenant branding URL does not belong to the active tenant')
  }
}

/**
 * Return a short-lived URL for a tenant logo stored in BeaconHS private
 * storage. Public HTTPS logo URLs pass through unchanged. Internal keys are
 * tenant-checked before signing so branding cannot become a cross-tenant read.
 */
/**
 * Resolve a stored tenant logo to a URL the browser may use.
 *
 * The `buildUrl` parameter exists so the WEB layer can hand in its own
 * gateway URL builder. Without it the logo would be resolved to a PRESIGNED
 * OBJECT-STORE URL, which the browser would then reach directly — that is
 * what the internal-only object-storage architecture forbids.
 *
 * A server-internal caller (one that never puts the URL in front of a
 * browser) may omit `buildUrl` and get the presigned form.
 */
export async function resolveTenantLogoUrl(args: {
  tenantId: string
  logoUrl: string | null | undefined
  expiresInSeconds?: number
  buildUrl?: (key: string) => string
}): Promise<string | null> {
  const logoUrl = args.logoUrl?.trim()
  if (!logoUrl) return null
  const key = objectKeyFromStorageUrl({ url: logoUrl, endpoint: publicEndpoint, bucket })
  if (!key) return logoUrl
  assertTenantLogoObjectKey({ tenantId: args.tenantId, key })
  if (args.buildUrl) return args.buildUrl(key)
  return presignGet({ key, expiresInSeconds: args.expiresInSeconds ?? 900 })
}

export type StoredObjectMetadata = {
  contentLength: number
  contentType: string | null
  contentDisposition: string | null
  metadata: Readonly<Record<string, string>>
  etag: string | null
}

export async function headObject(args: { key: string }): Promise<StoredObjectMetadata | null> {
  try {
    const result = await internalClient.send(
      new HeadObjectCommand({ Bucket: bucket, Key: args.key }),
    )
    return {
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType ?? null,
      contentDisposition: result.ContentDisposition ?? null,
      metadata: result.Metadata ?? {},
      etag: result.ETag ?? null,
    }
  } catch (error) {
    if (isMissingObjectError(error)) return null
    throw error
  }
}

/**
 * Promote a verified staging object to its immutable attachment key. The copy
 * deliberately strips the upload-token metadata from the final object.
 */
export async function promoteObject(args: {
  sourceKey: string
  sourceEtag: string
  destinationKey: string
  contentType: string
  contentDisposition: 'inline' | 'attachment'
}): Promise<void> {
  if (!args.sourceEtag.trim()) throw new Error('Verified source ETag is required')
  await admitWrite('promoteObject', args.destinationKey)

  const tenantId = tenantIdFromObjectKey(args.destinationKey)
  const tracker = getInFlightWriteTracker()

  // Phase 6U-B3-B (strict): registration is mandatory.
  if (!tracker) {
    throw new Error(
      'STORAGE_WRITE_BLOCKED: in-flight tracker not registered for tenant storage write',
    )
  }
  if (!tenantId) {
    throw new Error('STORAGE_WRITE_BLOCKED: storage write requires a tenant-scoped object key')
  }

  let writeRecordId: string | null = null
  try {
    writeRecordId = await tracker.register({
      tenantId,
      operation: 'promoteObject',
      key: args.destinationKey,
      leaseId: null,
      leaseVersion: 0,
    })
  } catch (regError) {
    throw new Error(
      `STORAGE_WRITE_BLOCKED: in-flight registration failed: ${regError instanceof Error ? regError.message : String(regError)}`,
    )
  }
  if (!writeRecordId) {
    throw new Error('STORAGE_WRITE_BLOCKED: in-flight registration returned null')
  }

  try {
    const source = `${bucket}/${args.sourceKey}`
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/')
    await internalClient.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: args.destinationKey,
        CopySource: source,
        CopySourceIfMatch: args.sourceEtag,
        ContentType: args.contentType,
        ContentDisposition: args.contentDisposition,
        MetadataDirective: 'REPLACE',
        Metadata: {},
        TaggingDirective: 'REPLACE',
        Tagging: '',
      }),
    )

    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markCompleted({
          tenantId,
          key: args.destinationKey,
          leaseId: null,
          recordId: writeRecordId,
        })
      } catch (markError) {
        console.error('[promoteObject] markCompleted failed', {
          key: args.destinationKey,
          error: markError,
        })
      }
    }
  } catch (error) {
    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markFailed({
          tenantId,
          key: args.destinationKey,
          leaseId: null,
          recordId: writeRecordId,
          error: error instanceof Error ? error.message : String(error),
        })
      } catch (markError) {
        console.error('[promoteObject] markFailed failed', {
          key: args.destinationKey,
          error: markError,
        })
      }
    }
    throw error
  }
}

export async function getObjectRange(args: {
  key: string
  start: number
  end: number
  ifMatch?: string
}): Promise<Buffer> {
  if (args.start < 0 || args.end < args.start) throw new Error('Invalid object byte range')
  const result = await internalClient.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: args.key,
      Range: `bytes=${args.start}-${args.end}`,
      IfMatch: args.ifMatch,
    }),
  )
  if (!result.Body) throw new Error(`Object not found: ${args.key}`)
  return Buffer.from(await result.Body.transformToByteArray())
}

function isMissingObjectError(error: unknown): boolean {
  const maybeError = error as {
    name?: string
    code?: string
    Code?: string
    $metadata?: { httpStatusCode?: number }
  }
  return (
    maybeError.$metadata?.httpStatusCode === 404 ||
    maybeError.name === 'NotFound' ||
    maybeError.name === 'NoSuchKey' ||
    maybeError.code === 'NoSuchKey' ||
    maybeError.Code === 'NoSuchKey'
  )
}

export async function objectExists(args: { key: string }): Promise<boolean> {
  return (await headObject(args)) !== null
}

/** Server-side direct download. Returns the object's bytes as a Buffer. */
export async function getObject(args: { key: string }): Promise<Buffer> {
  const res = await internalClient.send(new GetObjectCommand({ Bucket: bucket, Key: args.key }))
  const body = res.Body
  if (!body) throw new Error(`Object not found: ${args.key}`)
  const bytes = await body.transformToByteArray()
  return Buffer.from(bytes)
}

/**
 * Server-side streaming download for large objects (e.g. PowerPoint masters
 * served through the WOPI host) — avoids buffering the whole file in memory.
 */
export async function getObjectStream(args: {
  key: string
}): Promise<{ stream: ReadableStream; contentLength?: number; contentType?: string }> {
  const res = await internalClient.send(new GetObjectCommand({ Bucket: bucket, Key: args.key }))
  const body = res.Body
  if (!body) throw new Error(`Object not found: ${args.key}`)
  return {
    stream: body.transformToWebStream() as ReadableStream,
    contentLength: res.ContentLength,
    contentType: res.ContentType,
  }
}

export async function deleteObject(args: { key: string }): Promise<void> {
  await admitWrite('deleteObject', args.key)

  const tenantId = tenantIdFromObjectKey(args.key)
  const tracker = getInFlightWriteTracker()

  // Phase 6U-B3-B (strict): registration is mandatory.
  if (!tracker) {
    throw new Error(
      'STORAGE_WRITE_BLOCKED: in-flight tracker not registered for tenant storage write',
    )
  }
  if (!tenantId) {
    throw new Error('STORAGE_WRITE_BLOCKED: storage write requires a tenant-scoped object key')
  }

  let writeRecordId: string | null = null
  try {
    writeRecordId = await tracker.register({
      tenantId,
      operation: 'deleteObject',
      key: args.key,
      leaseId: null,
      leaseVersion: 0,
    })
  } catch (regError) {
    throw new Error(
      `STORAGE_WRITE_BLOCKED: in-flight registration failed: ${regError instanceof Error ? regError.message : String(regError)}`,
    )
  }
  if (!writeRecordId) {
    throw new Error('STORAGE_WRITE_BLOCKED: in-flight registration returned null')
  }

  try {
    await internalClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: args.key }))

    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markCompleted({
          tenantId,
          key: args.key,
          leaseId: null,
          recordId: writeRecordId,
        })
      } catch (markError) {
        console.error('[deleteObject] markCompleted failed', { key: args.key, error: markError })
      }
    }
  } catch (error) {
    if (tracker && tenantId && writeRecordId) {
      try {
        await tracker.markFailed({
          tenantId,
          key: args.key,
          leaseId: null,
          recordId: writeRecordId,
          error: error instanceof Error ? error.message : String(error),
        })
      } catch (markError) {
        console.error('[deleteObject] markFailed failed', { key: args.key, error: markError })
      }
    }
    throw error
  }
}

export function newAttachmentKey(args: {
  tenantId: string
  kind: 'image' | 'document' | 'video' | 'audio' | 'signature' | 'other'
  filename: string
}): string {
  return newTenantObjectKey({
    tenantId: args.tenantId,
    scope: args.kind,
    filename: args.filename,
  })
}

export function newPendingUploadKey(args: { tenantId: string; uploadId: string }): string {
  if (!UUID_RE.test(args.uploadId)) throw new Error('Upload id must be a UUID')
  return newTenantObjectKey({
    tenantId: args.tenantId,
    scope: '_pending',
    filename: args.uploadId,
  })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SCOPE_RE = /^[a-z0-9_](?:[a-z0-9_/-]*[a-z0-9_])?$/
const OBJECT_KEY_PART_RE = /^[a-zA-Z0-9._-]+$/

/** Refuse to delete a key that is not canonically owned by the supplied tenant. */
export function assertTenantObjectKey(args: { tenantId: string; key: string }): void {
  if (!UUID_RE.test(args.tenantId)) throw new Error('Tenant id must be a UUID')
  if (!args.key || args.key.length > 1_024 || args.key.includes('\\')) {
    throw new Error('Storage object key is invalid')
  }
  const parts = args.key.split('/')
  if (
    parts.length < 4 ||
    parts[0] !== 't' ||
    parts[1] !== args.tenantId.toLowerCase() ||
    parts.slice(2).some((part) => !OBJECT_KEY_PART_RE.test(part) || part === '.' || part === '..')
  ) {
    throw new Error('Storage object key does not belong to the tenant')
  }
}

export function newTenantObjectKey(args: {
  tenantId: string
  scope: string
  filename: string
}): string {
  if (!UUID_RE.test(args.tenantId)) throw new Error('Tenant id must be a UUID')
  if (!SCOPE_RE.test(args.scope) || args.scope.split('/').some((part) => !part || part === '..')) {
    throw new Error('Object scope is invalid')
  }
  const safe = args.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file'
  return `t/${args.tenantId}/${args.scope}/${randomUUID()}-${safe}`
}

/**
 * Pre-existing escape hatch for the raw S3 client. It resolves to the INTERNAL client:
 * anything holding this handle is doing server-side I/O, and handing out the public one
 * would reintroduce the tunnel hairpin this split removes.
 */
export { internalClient as s3Client }
