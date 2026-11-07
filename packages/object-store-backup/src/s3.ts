// The store-facing half of the tool: one S3 client, and the small set of
// operations the backup/restore flow needs.
//
// WHY `forcePathStyle: true` AND `region: 'auto'`
//
// These match `packages/storage/src/index.ts` exactly, and they are not cosmetic.
// Path-style (`/{bucket}/{key}`) is what every S3-compatible store that is not AWS
// accepts, and it is what the BeaconHS deployment notes require: with a path prefix
// in the endpoint, the proxy must strip it, which makes the server recompute the
// signature over a different path and every presigned operation fails with
// `SignatureDoesNotMatch`. `region: 'auto'` is the scope both stores accept for a
// non-AWS endpoint. Deviating from either would make a backup taken against one
// store unrestorable against the other.
//
// ONLY THE OPERATIONS THIS TOOL NEEDS ARE IMPORTED. A narrower import surface keeps
// the dependency (and therefore the attack surface) to what is actually used.

import type { LifecycleRule } from '@aws-sdk/client-s3'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import type { StoreConfig } from './config'
import { sha256Hex } from './hash'
import { classifyError, describeError, withRetry } from './retry'

/** Part size and multipart threshold, mirroring `packages/storage/src/multipart.ts`. */
export const MULTIPART_THRESHOLD_BYTES = 256 * 1024 * 1024
export const MULTIPART_PART_SIZE_BYTES = 64 * 1024 * 1024
/** S3 rejects a single PUT above 5 GiB, so anything larger must be multipart. */
const SINGLE_PUT_LIMIT_BYTES = 5 * 1024 * 1024 * 1024

export type ObjectListing = {
  key: string
  size: number
}

export type ObjectMetadata = {
  contentType: string | null
  contentDisposition: string | null
  metadata: Record<string, string>
  tags: Record<string, string>
}

export function createS3Client(config: StoreConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

export function shouldUseMultipart(size: number): boolean {
  return size >= MULTIPART_THRESHOLD_BYTES || size > SINGLE_PUT_LIMIT_BYTES
}

export function partCount(size: number, partSize = MULTIPART_PART_SIZE_BYTES): number {
  if (size <= 0) return 0
  return Math.ceil(size / partSize)
}

/**
 * Enumerate every object in the bucket, following continuation tokens.
 *
 * The caller must not assume a single page. A bucket with more than `max-keys`
 * (default 1000) objects returns `IsTruncated: true` and a `NextContinuationToken`,
 * and a tool that stops there silently backs up a fraction of the data while
 * reporting success — the single most dangerous bug a backup tool can have.
 */
export async function listAllObjects(
  client: S3Client,
  bucket: string,
  pageSize = 1000,
): Promise<ObjectListing[]> {
  const objects: ObjectListing[] = []
  let continuationToken: string | undefined
  let pages = 0
  for (;;) {
    pages += 1
    const response = await withRetry(() =>
      client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: pageSize,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      ),
    )
    for (const entry of response.Contents ?? []) {
      if (entry.Key === undefined) continue
      objects.push({ key: entry.Key, size: entry.Size ?? 0 })
    }
    if (response.IsTruncated !== true) break
    continuationToken = response.NextContinuationToken
    if (continuationToken === undefined) {
      // A store that sets IsTruncated without a token is broken; guessing would
      // silently truncate the backup, so refuse instead.
      throw new Error(
        `store reported a truncated listing at page ${pages} but returned no continuation token`,
      )
    }
  }
  return objects
}

/** HeadObject plus the object's tag set, as one call site. */
export async function readObjectMetadata(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<ObjectMetadata> {
  const head = await withRetry(() =>
    client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
  )
  const metadata: Record<string, string> = {}
  for (const [name, value] of Object.entries(head.Metadata ?? {})) {
    if (value !== undefined) metadata[name] = value
  }
  let tags: Record<string, string> = {}
  try {
    const tagging = await withRetry(() =>
      client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key })),
    )
    tags = Object.fromEntries((tagging.TagSet ?? []).map((tag) => [tag.Key ?? '', tag.Value ?? '']))
  } catch (error) {
    // A store that cannot report tags is a compatibility gap that changes what a
    // restore can reproduce. Surface it rather than recording an empty tag set,
    // which would look like "this object has no tags" and be indistinguishable
    // from the truth.
    throw new Error(
      `could not read tags for ${key}: ${describeError(error)} ` +
        `(classified ${classifyError(error)})`,
      { cause: error },
    )
  }
  return {
    contentType: head.ContentType ?? null,
    contentDisposition: head.ContentDisposition ?? null,
    metadata,
    tags,
  }
}

/** A readable stream of the object body. The caller owns closing it. */
export async function getObjectStream(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<{ stream: Readable; contentLength: number | undefined }> {
  const response = await withRetry(() =>
    client.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
  )
  if (!response.Body) throw new Error(`store returned an empty body for ${key}`)
  // In Node the SDK yields an `IncomingMessage`, which is a `Readable`. The cast is
  // confined to this line so the rest of the tool works with Node stream types
  // rather than the SDK's union of Node/web/browser body types.
  return {
    stream: response.Body as unknown as Readable,
    contentLength: response.ContentLength,
  }
}

export async function bucketExists(client: S3Client, bucket: string): Promise<boolean> {
  try {
    await withRetry(() => client.send(new HeadBucketCommand({ Bucket: bucket })))
    return true
  } catch (error) {
    if (classifyError(error) !== 'permanent') {
      throw new Error(
        `could not determine whether bucket ${bucket} exists: ${describeError(error)}`,
        {
          cause: error,
        },
      )
    }
    return false
  }
}

export async function createBucket(client: S3Client, bucket: string): Promise<void> {
  await withRetry(() => client.send(new CreateBucketCommand({ Bucket: bucket })))
}

export type LifecycleCapture =
  | { status: 'captured'; xml: string; sha256: string }
  | { status: 'none' }
  | { status: 'unsupported'; reason: string }

/**
 * Whether a lifecycle configuration carries the incomplete-upload rule.
 *
 * This is checked because at least one real store accepts the rule and then never
 * reports it back: MinIO RELEASE.2025-10-15T17-29-55Z returns 200 for a lifecycle
 * PUT containing `AbortIncompleteMultipartUpload`, but omits the element from
 * `GetBucketLifecycleConfiguration` (verified against a live instance, raw XML).
 * A backup captured from such a store therefore cannot reproduce incomplete-upload
 * cleanup on restore, and the caller has to be told rather than left to assume the
 * captured configuration is complete.
 */
export function lifecycleHasIncompleteUploadRule(xml: string): boolean {
  return /<AbortIncompleteMultipartUpload\b/.test(xml)
}

/**
 * Read the bucket lifecycle configuration, distinguishing "no rules" from
 * "this store cannot tell me".
 *
 * `NoSuchLifecycleConfiguration` and `NotFound` are both legitimate empty answers.
 * Anything else — `NotImplemented`, a 501, an unrecognised error code — is a store
 * capability gap, and recording it as "no rules" would make a restore silently
 * skip configuration that the source actually had.
 */
export async function readBucketLifecycle(
  client: S3Client,
  bucket: string,
): Promise<LifecycleCapture> {
  try {
    const response = await withRetry(() =>
      client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })),
    )
    const rules = response.Rules ?? []
    if (rules.length === 0) return { status: 'none' }
    const xml = renderLifecycleXml(rules)
    return { status: 'captured', xml, sha256: sha256Hex(xml) }
  } catch (error) {
    const code = errorCodeOf(error)
    if (code === 'NoSuchLifecycleConfiguration' || code === 'NotFound') return { status: 'none' }
    return { status: 'unsupported', reason: `${code ?? 'unknown'}: ${describeError(error)}` }
  }
}

/** Write a lifecycle configuration captured earlier. */
export async function writeBucketLifecycle(
  client: S3Client,
  bucket: string,
  xml: string,
): Promise<void> {
  await withRetry(() =>
    client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: { Rules: parseLifecycleXml(xml) },
      }),
    ),
  )
}

function errorCodeOf(error: unknown): string | undefined {
  const candidate = error as { name?: string; Code?: string; code?: string }
  return candidate?.name ?? candidate?.code ?? candidate?.Code
}

export type PutObjectInput = {
  key: string
  body: Readable | Uint8Array
  size: number
  contentType?: string | null
  contentDisposition?: string | null
  metadata?: Record<string, string>
  tags?: Record<string, string>
}

/**
 * Upload one object, choosing single PUT or multipart by size.
 *
 * The body is always streamed: neither branch buffers the whole object, so a 5 GiB
 * restore costs one part-size buffer rather than one object-size buffer.
 */
export async function putObject(
  client: S3Client,
  bucket: string,
  input: PutObjectInput,
): Promise<void> {
  const tagging =
    input.tags && Object.keys(input.tags).length > 0
      ? new URLSearchParams(input.tags).toString()
      : undefined
  const common = {
    Bucket: bucket,
    Key: input.key,
    ContentType: input.contentType ?? undefined,
    ContentDisposition: input.contentDisposition ?? undefined,
    ...(input.metadata && Object.keys(input.metadata).length > 0
      ? { Metadata: input.metadata }
      : {}),
    ...(tagging ? { Tagging: tagging } : {}),
  }

  if (!shouldUseMultipart(input.size)) {
    const body = input.body
    await withRetry(() => client.send(new PutObjectCommand({ ...common, Body: body })))
    return
  }

  const totalParts = partCount(input.size)
  const { UploadId } = await withRetry(() => client.send(new CreateMultipartUploadCommand(common)))
  if (!UploadId) throw new Error(`store did not create a multipart upload for ${input.key}`)

  const parts: Array<{ ETag: string; PartNumber: number }> = []
  let partNumber = 1
  let uploadedBytes = 0

  try {
    /**
     * Upload exactly one part.
     *
     * Parts must be accumulated across stream-chunk boundaries. A Node file stream
     * emits 64 KiB chunks, so slicing each chunk to the part size turns a 300 MiB
     * object into ~4800 illegal parts instead of 5. Buffering to the part size is
     * the only correct reading of "a multipart upload in N parts".
     */
    let pending: Buffer = Buffer.alloc(0)
    const uploadPart = async (body: Buffer): Promise<void> => {
      const { ETag } = await withRetry(() =>
        client.send(
          new UploadPartCommand({ ...common, UploadId, PartNumber: partNumber, Body: body }),
        ),
      )
      if (!ETag) {
        throw new Error(`store did not return an ETag for part ${partNumber} of ${input.key}`)
      }
      parts.push({ ETag, PartNumber: partNumber })
      partNumber += 1
      uploadedBytes += body.byteLength
    }

    const reader = isReadableStream(input.body)
      ? toAsyncIterable(input.body)
      : singleChunk(input.body)

    for await (const chunk of reader) {
      pending = pending.byteLength === 0 ? toBuffer(chunk) : Buffer.concat([pending, chunk])
      while (pending.byteLength >= MULTIPART_PART_SIZE_BYTES) {
        await uploadPart(Buffer.from(pending.subarray(0, MULTIPART_PART_SIZE_BYTES)))
        pending = pending.subarray(MULTIPART_PART_SIZE_BYTES)
      }
    }
    if (pending.byteLength > 0) await uploadPart(pending)

    if (uploadedBytes !== input.size) {
      throw new Error(
        `multipart upload for ${input.key} received ${uploadedBytes} of ${input.size} bytes`,
      )
    }
    if (parts.length !== totalParts) {
      throw new Error(
        `multipart upload for ${input.key} produced ${parts.length} parts, expected ${totalParts}`,
      )
    }
    await withRetry(() =>
      client.send(
        new CompleteMultipartUploadCommand({
          ...common,
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
      ),
    )
  } catch (error) {
    // An incomplete upload holds storage on the target and shows up in
    // ListMultipartUploads forever. Abort it, then re-raise so the caller records
    // the failure and can retry the whole object.
    await client
      .send(new AbortMultipartUploadCommand({ ...common, UploadId }))
      .catch(() => undefined)
    throw error
  }
}

async function* toAsyncIterable(stream: Readable): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) yield chunk as Uint8Array
}

/** Wrap an in-memory body as a one-element async iterable. */
async function* singleChunk(body: Uint8Array): AsyncGenerator<Uint8Array> {
  yield body
}

/**
 * View a chunk as a Buffer without copying it when it already is one.
 *
 * `Buffer.from(buffer)` copies, which would double the memory of every part for no
 * benefit; the copy is only needed for a genuine Uint8Array view.
 */
function toBuffer(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

/**
 * `Readable.isReadable` returns `boolean`, not a type predicate, so it does not
 * narrow the `Readable | Uint8Array` union. This guard does, which is what lets the
 * multipart loop branch without a cast at each use site.
 */
function isReadableStream(body: Readable | Uint8Array): body is Readable {
  return body instanceof Readable
}

// ---------------------------------------------------------------------------
// Lifecycle XML
//
// The lifecycle configuration is carried as XML rather than as parsed rules so a
// backup taken on one store restores the same request on another. Round-tripping
// through the SDK's typed model would drop fields the SDK does not expose, which is
// exactly the class of silent configuration loss this tool exists to prevent.
// ---------------------------------------------------------------------------

/**
 * The lifecycle rule shape, taken from the SDK's own type rather than re-declared.
 *
 * `Parameters<typeof Command>` does not work here: a command class is not a function
 * type, so TypeScript resolves the indexed access to `never[]` and every field access
 * on it fails. Importing `LifecycleRule` directly is both correct and honest about
 * where the shape comes from.
 */
type Rule = LifecycleRule

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

export function renderLifecycleXml(rules: Rule[]): string {
  const parts = rules.map((rule) => {
    const id = rule.ID ? `<ID>${xmlEscape(rule.ID)}</ID>` : ''
    const status = rule.Status ? `<Status>${xmlEscape(rule.Status)}</Status>` : ''
    const filter = rule.Filter
      ? `<Filter>${
          rule.Filter.Prefix !== undefined
            ? `<Prefix>${xmlEscape(rule.Filter.Prefix)}</Prefix>`
            : ''
        }${
          rule.Filter.Tag
            ? `<Tag><Key>${xmlEscape(rule.Filter.Tag.Key ?? '')}</Key><Value>${xmlEscape(
                rule.Filter.Tag.Value ?? '',
              )}</Value></Tag>`
            : ''
        }</Filter>`
      : ''
    const expiration =
      rule.Expiration?.Days !== undefined
        ? `<Expiration><Days>${rule.Expiration.Days}</Days></Expiration>`
        : ''
    const abort =
      rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation !== undefined
        ? `<AbortIncompleteMultipartUpload><DaysAfterInitiation>${rule.AbortIncompleteMultipartUpload.DaysAfterInitiation}</DaysAfterInitiation></AbortIncompleteMultipartUpload>`
        : ''
    return `<Rule>${id}${status}${filter}${expiration}${abort}</Rule>`
  })
  return `<LifecycleConfiguration>${parts.join('')}</LifecycleConfiguration>`
}

export function parseLifecycleXml(xml: string): Rule[] {
  // Rules are assembled as partial objects because the XML may legitimately omit
  // fields (a rule without <Status> is malformed input, not something to invent a
  // value for). The single cast at the return keeps that decision visible instead
  // of scattering defaults through the loop.
  const rules: Array<Partial<Rule>> = []
  const ruleMatches = xml.matchAll(/<Rule>([\s\S]*?)<\/Rule>/g)
  for (const [, body] of ruleMatches) {
    if (body === undefined) continue
    const id = /<ID>([\s\S]*?)<\/ID>/.exec(body)?.[1]
    const status = /<Status>([\s\S]*?)<\/Status>/.exec(body)?.[1]
    const prefix = /<Prefix>([\s\S]*?)<\/Prefix>/.exec(body)?.[1]
    const tagKey = /<Tag><Key>([\s\S]*?)<\/Key><Value>([\s\S]*?)<\/Value><\/Tag>/.exec(body)?.[1]
    const tagValue = /<Tag><Key>([\s\S]*?)<\/Key><Value>([\s\S]*?)<\/Value><\/Tag>/.exec(body)?.[2]
    const days = /<Expiration><Days>(\d+)<\/Days><\/Expiration>/.exec(body)?.[1]
    const abortDays =
      /<AbortIncompleteMultipartUpload><DaysAfterInitiation>(\d+)<\/DaysAfterInitiation><\/AbortIncompleteMultipartUpload>/.exec(
        body,
      )?.[1]
    const rule: Partial<Rule> = {
      ...(id !== undefined ? { ID: xmlUnescape(id) } : {}),
      ...(status !== undefined ? { Status: xmlUnescape(status) as 'Enabled' | 'Disabled' } : {}),
    }
    if (prefix !== undefined || tagKey !== undefined) {
      rule.Filter = {
        ...(prefix !== undefined ? { Prefix: xmlUnescape(prefix) } : {}),
        ...(tagKey !== undefined
          ? { Tag: { Key: xmlUnescape(tagKey), Value: xmlUnescape(tagValue ?? '') } }
          : {}),
      }
    }
    if (days !== undefined) rule.Expiration = { Days: Number(days) }
    if (abortDays !== undefined) {
      rule.AbortIncompleteMultipartUpload = { DaysAfterInitiation: Number(abortDays) }
    }
    rules.push(rule)
  }
  return rules as Rule[]
}
