// An in-process S3-compatible HTTP server, used only by the tests.
//
// WHY A FAKE INSTEAD OF A LIVE STORE
//
// The properties worth testing here are the tool's own: that it follows pagination,
// that it hashes the bytes it wrote, that it refuses to overwrite, that it detects a
// corrupted file. None of those depend on which store is on the other end, and a unit
// test that needs a live MinIO or SeaweedFS is a test that will not run in CI. Driving
// the real AWS SDK against a real HTTP server exercises the client, the streaming, and
// the XML code paths exactly as production does, while staying hermetic.
//
// WHAT IT IMPLEMENTS
//
// Only the surface this tool uses. Anything else answers 501 with an XML error, which
// is also how the tests confirm the tool reports an unsupported capability rather than
// silently treating it as "no rules".

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** A request whose body has already been read, cached by `readBody`. */
type CachedRequest = IncomingMessage & { body?: Buffer }

type StoredObject = {
  body: Buffer
  contentType?: string
  contentDisposition?: string
  metadata: Record<string, string>
  tags: Record<string, string>
}

type Upload = { parts: Map<number, Buffer> }

export type FakeS3 = {
  endpoint: string
  server: Server
  close: () => Promise<void>
  /** Direct access for assertions. */
  store: Map<string, Map<string, StoredObject>>
  /** Force the next N list requests to be truncated, to exercise pagination. */
  setPageSize: (size: number) => void
  /** Answer the lifecycle GET with an error the store does not support. */
  setLifecycleSupported: (supported: boolean) => void
  /** Access key ids this fake accepts. Anything else, and anonymous, is denied. */
  setAllowedKeys: (keys: readonly string[]) => void
  /** Permit unsigned requests, to model a store that exposes objects publicly. */
  setAllowAnonymous: (allow: boolean) => void
  /**
   * Control whether lifecycle GETs report `AbortIncompleteMultipartUpload`.
   *
   * Set to false to model MinIO RELEASE.2025-10-15T17-29-55Z, which accepts the
   * rule on PUT and omits it from every GET. Modelling it is the only way to test
   * the `--lifecycle-file` recovery path, which exists precisely because of that
   * behaviour.
   */
  setLifecycleReportsAbortRule: (reports: boolean) => void
}

const xmlEscape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

function errorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`
}

/**
 * The access key id a request was signed with, from either the SigV4 Authorization
 * header or the presigned query string.
 */
function credentialFrom(req: CachedRequest, query: URLSearchParams): string | null {
  const authorization = req.headers['authorization']
  if (typeof authorization === 'string') {
    const match = /Credential=([^/]+)\//.exec(authorization)
    return match ? (match[1] ?? null) : null
  }
  const presigned = query.get('X-Amz-Credential')
  return presigned === null ? null : (presigned.split('/')[0] ?? null)
}

async function readBody(req: CachedRequest): Promise<Buffer> {
  if (req.body) return req.body
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  req.body = decodeIfChunked(req, Buffer.concat(chunks))
  return req.body
}

/**
 * Decode an `aws-chunked` request body.
 *
 * The AWS SDK streams upload bodies as `aws-chunked` (awschunk): each chunk is
 * `<hex-size>\r\n<data>\r\n`, terminated by a zero-size chunk followed by
 * trailer lines. A buffered upload arrives plain, which is why seeded objects looked
 * right while streamed ones did not. Real S3 stores — MinIO and SeaweedFS both,
 * verified end to end in Phase 5 — decode this themselves; this fake has to do it
 * explicitly or it stores the framing as if it were object bytes.
 */
function decodeIfChunked(req: CachedRequest, raw: Buffer): Buffer {
  const encoding = String(req.headers['content-encoding'] ?? '')
  if (!/chunked/i.test(encoding)) return raw
  const parts: Buffer[] = []
  let offset = 0
  while (offset < raw.length) {
    const lineEnd = raw.indexOf('\r\n', offset)
    if (lineEnd === -1) break
    const sizeToken = raw.subarray(offset, lineEnd).toString('ascii').split(';')[0] ?? ''
    const size = Number.parseInt(sizeToken, 16)
    if (!Number.isFinite(size) || size < 0) break
    offset = lineEnd + 2
    if (size === 0) break // final chunk; the trailer lines after it are not data
    parts.push(raw.subarray(offset, offset + size))
    offset += size + 2
  }
  return Buffer.concat(parts)
}

export async function startFakeS3(): Promise<FakeS3> {
  const store = new Map<string, Map<string, StoredObject>>()
  const uploads = new Map<string, { bucket: string; key: string; parts: Upload['parts'] }>()
  let pageSize = 1000
  let lifecycleSupported = true
  let allowedKeys = new Set(['test-access-key-0001'])
  let allowAnonymous = false
  let lifecycleReportsAbortRule = true
  let lifecycleXml: string | null = null
  let uploadCounter = 0

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req as CachedRequest, res)
  })

  async function handle(req: CachedRequest, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter((part) => part !== '')
    const bucket = decodeURIComponent(parts[0] ?? '')
    const key = parts.slice(1).map(decodeURIComponent).join('/')
    const query = url.searchParams
    const method = req.method ?? 'GET'

    const send = (
      status: number,
      body: string | Buffer,
      headers: Record<string, string> = {},
    ): void => {
      res.writeHead(status, { 'content-type': 'application/xml', ...headers })
      res.end(body)
    }

    // Credential enforcement. Without it the fake cannot tell the difference between
    // "the tool correctly proved anonymous reads are refused" and "the store lets
    // everyone read everything" — which is precisely the property worth testing.
    if (!allowAnonymous) {
      const credential = credentialFrom(req, query)
      if (credential === null || !allowedKeys.has(credential)) {
        send(
          403,
          errorXml('AccessDenied', `access denied for credential ${credential ?? '<anonymous>'}`),
        )
        return
      }
    }

    try {
      // --- bucket-level ---
      if (key === '') {
        if (method === 'HEAD') {
          send(store.has(bucket) ? 200 : 404, '')
          return
        }
        if (method === 'PUT' && !query.has('lifecycle')) {
          if (!store.has(bucket)) store.set(bucket, new Map())
          send(200, '')
          return
        }
        if (method === 'DELETE') {
          store.delete(bucket)
          res.writeHead(204)
          res.end()
          return
        }
        if (method === 'GET' && query.get('list-type') === '2') {
          const objects = [...(store.get(bucket) ?? new Map()).entries()].sort(([a], [b]) =>
            a < b ? -1 : 1,
          )
          const token = query.get('continuation-token')
          const start = token === null ? 0 : Number(token)
          const size = Math.max(1, pageSize)
          const page = objects.slice(start, start + size)
          const truncated = start + size < objects.length
          const contents = page
            .map(
              ([objectKey, object]) =>
                `<Contents><Key>${xmlEscape(objectKey)}</Key><Size>${object.body.byteLength}</Size></Contents>`,
            )
            .join('')
          send(
            200,
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>` +
              `${truncated ? `<NextContinuationToken>${start + size}</NextContinuationToken>` : ''}` +
              `${contents}</ListBucketResult>`,
          )
          return
        }
        if (method === 'GET' && query.has('lifecycle')) {
          if (!lifecycleSupported) {
            send(501, errorXml('NotImplemented', 'lifecycle is not supported by this fake'))
            return
          }
          if (lifecycleXml === null) {
            send(404, errorXml('NoSuchLifecycleConfiguration', 'no rules'))
            return
          }
          // Model a store that accepts the incomplete-upload rule but never reports
          // it back, so the capture/restore gap can be exercised end to end.
          const reported = lifecycleReportsAbortRule
            ? lifecycleXml
            : lifecycleXml.replace(
                /<AbortIncompleteMultipartUpload>.*?<\/AbortIncompleteMultipartUpload>/g,
                '',
              )
          send(200, reported)
          return
        }
        if (method === 'PUT' && query.has('lifecycle')) {
          lifecycleXml = (await readBody(req)).toString('utf8')
          send(200, '')
          return
        }
        send(501, errorXml('NotImplemented', 'unsupported bucket operation'))
        return
      }

      // --- object-level ---
      const objects = store.get(bucket)
      const uploadId = query.get('uploadId')

      if (method === 'PUT' && uploadId !== null) {
        const upload = uploads.get(uploadId)
        if (!upload) {
          send(404, errorXml('NoSuchUpload', 'unknown upload id'))
          return
        }
        const partNumber = Number(query.get('partNumber'))
        upload.parts.set(partNumber, await readBody(req))
        const etag = `"etag-${uploadId}-${partNumber}"`
        send(200, '', { etag })
        return
      }

      if (method === 'POST' && query.has('uploads')) {
        uploadCounter += 1
        const id = `upload-${uploadCounter}`
        uploads.set(id, { bucket, key, parts: new Map() })
        send(
          200,
          `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        )
        return
      }

      if (method === 'POST' && uploadId !== null) {
        const upload = uploads.get(uploadId)
        if (!upload) {
          send(404, errorXml('NoSuchUpload', 'unknown upload id'))
          return
        }
        const body = await readBody(req)
        const numbers = [...upload.parts.keys()].sort((a, b) => a - b)
        const content = Buffer.concat(numbers.map((n) => upload.parts.get(n) as Buffer))
        // The ETag the tool echoes back was produced by UploadPart, so accept any.
        if (body.byteLength === 0) {
          send(400, errorXml('MalformedXML', 'empty complete request'))
          return
        }
        const existing = objects?.get(key)
        const stored: StoredObject = existing ?? {
          body: content,
          contentType: undefined,
          contentDisposition: undefined,
          metadata: {},
          tags: {},
        }
        stored.body = content
        objects?.set(key, stored)
        uploads.delete(uploadId)
        send(
          200,
          `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Location>${xmlEscape(bucket)}/${xmlEscape(key)}</Location></CompleteMultipartUploadResult>`,
        )
        return
      }

      if (method === 'DELETE' && uploadId !== null) {
        uploads.delete(uploadId)
        res.writeHead(204)
        res.end()
        return
      }

      if (method === 'GET' && uploadId !== null) {
        const upload = uploads.get(uploadId)
        if (!upload) {
          send(404, errorXml('NoSuchUpload', 'unknown upload id'))
          return
        }
        const parts = [...upload.parts.entries()]
          .sort(([a], [b]) => a - b)
          .map(
            ([n]) =>
              `<Part><PartNumber>${n}</PartNumber><ETag>"etag-${uploadId}-${n}"</ETag><Size>${(upload.parts.get(n) as Buffer).byteLength}</Size></Part>`,
          )
          .join('')
        send(
          200,
          `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`,
        )
        return
      }

      if (method === 'PUT') {
        const body = await readBody(req)
        const taggingHeader = req.headers['x-amz-tagging']
        const tags: Record<string, string> = {}
        if (typeof taggingHeader === 'string') {
          for (const pair of taggingHeader.split('&')) {
            const [name, value] = pair.split('=')
            if (name) tags[decodeURIComponent(name)] = decodeURIComponent(value ?? '')
          }
        }
        const metadata: Record<string, string> = {}
        for (const [name, value] of Object.entries(req.headers)) {
          if (name.startsWith('x-amz-meta-') && typeof value === 'string') {
            metadata[name.slice('x-amz-meta-'.length)] = value
          }
        }
        const stored: StoredObject = {
          body,
          contentType: req.headers['content-type'] as string | undefined,
          contentDisposition: req.headers['content-disposition'] as string | undefined,
          metadata,
          tags,
        }
        objects?.set(key, stored)
        send(200, '', { etag: `"${Buffer.byteLength(body)}"` })
        return
      }

      if (method === 'HEAD' || method === 'GET') {
        const object = objects?.get(key)
        if (!object) {
          if (method === 'HEAD') {
            res.writeHead(404)
            res.end()
            return
          }
          send(404, errorXml('NoSuchKey', 'the specified key does not exist'))
          return
        }
        if (method === 'HEAD') {
          const headers: Record<string, string> = {}
          if (object.contentType) headers['content-type'] = object.contentType
          if (object.contentDisposition) headers['content-disposition'] = object.contentDisposition
          headers['content-length'] = String(object.body.byteLength)
          headers['etag'] = `"${object.body.byteLength}"`
          for (const [name, value] of Object.entries(object.metadata)) {
            headers[`x-amz-meta-${name}`] = value
          }
          res.writeHead(200, headers)
          res.end()
          return
        }
        if (query.has('tagging')) {
          const tags = Object.entries(object.tags)
            .map(
              ([name, value]) =>
                `<Tag><Key>${xmlEscape(name)}</Key><Value>${xmlEscape(value)}</Value></Tag>`,
            )
            .join('')
          send(
            200,
            `<?xml version="1.0" encoding="UTF-8"?><Tagging><TagSet>${tags}</TagSet></Tagging>`,
          )
          return
        }
        const range = req.headers.range
        const headers: Record<string, string> = { 'content-length': String(object.body.byteLength) }
        if (object.contentType) headers['content-type'] = object.contentType
        if (object.contentDisposition) headers['content-disposition'] = object.contentDisposition
        for (const [name, value] of Object.entries(object.metadata)) {
          headers[`x-amz-meta-${name}`] = value
        }
        if (typeof range === 'string') {
          const match = /bytes=(\d+)-(\d+)/.exec(range)
          if (match) {
            const from = Number(match[1])
            const to = Number(match[2])
            send(206, object.body.subarray(from, to + 1), headers)
            return
          }
        }
        send(200, object.body, headers)
        return
      }

      if (method === 'DELETE') {
        objects?.delete(key)
        res.writeHead(204)
        res.end()
        return
      }

      send(501, errorXml('NotImplemented', 'unsupported object operation'))
    } catch (error) {
      send(500, errorXml('InternalError', (error as Error).message))
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    endpoint: `http://127.0.0.1:${port}`,
    server,
    store,
    setPageSize: (size) => {
      pageSize = size
    },
    setLifecycleSupported: (supported) => {
      lifecycleSupported = supported
    },
    setAllowedKeys: (keys) => {
      allowedKeys = new Set(keys)
    },
    setAllowAnonymous: (allow) => {
      allowAnonymous = allow
    },
    setLifecycleReportsAbortRule: (reports) => {
      lifecycleReportsAbortRule = reports
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
