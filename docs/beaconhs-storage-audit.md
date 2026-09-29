# BeaconHS — Object Storage Audit

> **Status:** read-only audit snapshot. **Audited:** 2026-09-29 · **Commit:** `70da27c4`
> Working-tree delta: the operator's `docker-compose.yml` change from MinIO to SeaweedFS,
> which this document treats as the current state. See
> [beaconhs-seaweedfs-impact.md](./beaconhs-seaweedfs-impact.md) for the migration analysis.

## 摘要（中文执行摘要）

BeaconHS 的对象存储是**直连浏览器预签名 URL** 架构，不是服务端中转。完整链路已逐行审计。

**数据流：**
用户 → 前端组件（`FileUploader`）→ server action（`requestUpload`）→ 预签名 PUT 直传对象存储
→ server action（`finalizeUpload`）→ `CopyObject` 提升到正式 key → 写入 `attachments` 表。
下载有 5 种模式，其中 3 种把预签名 URL 交给浏览器，1 种通过邮件发送 **7 天有效期**的 URL。

**最重要的三个发现：**

1. **【阻断级】`.env` 中 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` 为空**，而
   `packages/storage/src/index.ts:39-40` 使用 `??` 而非 `||`。空字符串**不会**触发默认值回退，
   因此 SDK 会用**空凭据**签名，所有请求被对象存储拒绝（403）。这是当前对象存储不可用的
   根因，且与 MinIO/SeaweedFS 无关 —— 切换前后都存在。
2. **预签名 URL 会泄露给浏览器和邮件收件人**。`/api/attachments/[id]` 走 60 秒 capability
   跳转；server action 走 300 秒；公开验证页走 300 秒；**定时报告邮件里的下载链接是 7 天**
   （`apps/worker/src/workers/reports.ts:70`）。这在 HSE 场景下需要重新评估。
3. **无对象级 ACL**。文件权限完全由应用层控制，存储侧的兜底只有 key 前缀 `t/<tenantId>/`。
   一旦签名发出，RLS 不再参与。

**值得肯定的设计**：上传采用「服务端签发预留 → 暂存 key → 校验后 `CopyObject` 提升」的
三段式，配合数据库触发器保证 `r2_key` 必须属于该租户、且与待删除对象冲突时拒绝写入。
这套机制在 SeaweedFS 上是兼容的。

---

# 1. Docker Compose

## 1.1 Current — `docker-compose.yml:39-51` (SeaweedFS)

```yaml
storage:
  image: chrislusf/seaweedfs:latest
  container_name: beaconhs-storage
  command: mini -dir=/data -ip=0.0.0.0
  environment:
    AWS_ACCESS_KEY_ID: beaconhs
    AWS_SECRET_ACCESS_KEY: beaconhs-dev-secret
    S3_BUCKET: beaconhs-dev
  ports:
    - '9000:8333'
  volumes:
    - storage-data:/data
  restart: unless-stopped
```

Volume declaration: `docker-compose.yml:85` → `storage-data:`.

## 1.2 Previous — `docker-compose.yml.bak:39-55` (MinIO)

```yaml
minio:
  image: minio/minio:latest
  container_name: beaconhs-minio
  command: server /data --console-address ":9001"
  environment:
    MINIO_ROOT_USER: beaconhs
    MINIO_ROOT_PASSWORD: beaconhs-dev-secret
  ports:
    - '9000:9000'
    - '9001:9001'
  volumes:
    - minio-data:/data
  healthcheck:
    test: ['CMD', 'curl', '-f', 'http://localhost:9000/minio/health/live']
    interval: 5s
    timeout: 5s
    retries: 10
```

Volume declaration: `docker-compose.yml.bak:89` → `minio-data:`.

The `.bak` file is otherwise byte-identical to the original committed `docker-compose.yml`
except the storage block.

## 1.3 Deltas

| Aspect          | MinIO                      | SeaweedFS                                 |
| --------------- | -------------------------- | ----------------------------------------- |
| Service name    | `minio`                    | `storage`                                 |
| Container name  | `beaconhs-minio`           | `beaconhs-storage`                        |
| Host port       | `9000:9000`                | `9000:8333` (SeaweedFS S3 gateway)        |
| Console         | `9001:9001`                | **removed**                               |
| Credential env  | `MINIO_ROOT_USER/PASSWORD` | `AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY` |
| Bucket env      | —                          | `S3_BUCKET` (pre-creates the bucket)      |
| Volume          | `minio-data`               | `storage-data`                            |
| **Healthcheck** | present                    | **removed**                               |

## 1.4 Other infrastructure

| File                                                    | Storage content                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Dockerfile`                                            | No storage env. References the `storage-init` role at `:4`                                                                                 |
| `docker/entrypoint.sh:14-16`                            | `storage-init) exec node apps/worker/dist/storage-init.js`                                                                                 |
| `deploy/dokploy-dev.compose.yaml:26-30, 79-83, 112-129` | `R2_*` injected into `web`, `worker`, and the one-shot `storage-init`. Comment at `:107-111` mentions "anonymous MinIO/S3 bucket policies" |
| `.env:31-37` / `.env.example:31-37`                     | The `R2_*` block                                                                                                                           |

**No `S3_`, `MINIO_`, or `AWS_` variable appears anywhere in the application source.** They are
container-side only.

---

# 2. `packages/storage`

Files: `src/index.ts` (662 lines), `src/lifecycle.ts`, `src/multipart.ts`, and 4 test files.
Source-only package — `main`/`types`/`exports` all point at `./src/index.ts`
(`package.json:6-10`).

## 2.1 SDK

```json
"@aws-sdk/client-s3": "^3.1086.0",
"@aws-sdk/s3-request-presigner": "^3.1086.0"
```

Resolved to exactly **3.1086.0** (`pnpm-lock.yaml`). Both are listed in
`serverExternalPackages` (`apps/web/next.config.ts:56-57`).

## 2.2 Client construction — `src/index.ts:38-55`

```ts
const accountId = process.env.R2_ACCOUNT_ID ?? 'local'
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? 'beaconhs'
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? 'beaconhs-dev-secret'
const bucket = process.env.R2_BUCKET ?? 'beaconhs-dev'

const endpoint =
  process.env.R2_ENDPOINT ??
  (accountId === 'local'
    ? 'http://localhost:9000'
    : `https://${accountId}.r2.cloudflarestorage.com`)

const client = new S3Client({
  region: 'auto',
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
})
```

`forcePathStyle: true` and `region: 'auto'` are unconditional. Path-style addressing means URLs
are always `http://localhost:9000/<bucket>/<key>`.

## 2.3 Environment variables read

| Variable                       | Default                                                                               | Read at                                                                                                                                             | Server-only?   |
| ------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `R2_ENDPOINT`                  | `http://localhost:9000` (local) or `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com` | `index.ts:45`; `forms-pdf/src/util.ts:81`; `apps/web/src/proxy.ts:10`; `apps/worker/src/workers/pdf.ts:94`; `apps/web/scripts/cutover-target.ts:71` | **yes**        |
| `R2_ACCOUNT_ID`                | `'local'`                                                                             | `index.ts:38`; `forms-pdf/src/util.ts:82-83`                                                                                                        | **yes**        |
| `R2_ACCESS_KEY_ID`             | `'beaconhs'`                                                                          | `index.ts:39`; `cutover-target.ts:82`                                                                                                               | **yes**        |
| `R2_SECRET_ACCESS_KEY`         | `'beaconhs-dev-secret'`                                                               | `index.ts:40`; `cutover-target.ts:83`                                                                                                               | **yes**        |
| `R2_BUCKET`                    | `'beaconhs-dev'`                                                                      | `index.ts:41`; `workers/pdf.ts:95`; `cutover-target.ts:84`                                                                                          | **yes**        |
| `R2_PRIVATE_BUCKET_CONFIRMED`  | unset; must be exactly `'true'` on R2                                                 | `index.ts:131`; `cutover-target.ts:90`                                                                                                              | **yes**        |
| `R2_PUBLIC_URL`                | **retired** — its presence is a hard error                                            | `index.ts:124-128`                                                                                                                                  | **yes**        |
| `ATTACHMENT_CAPABILITY_SECRET` | throws in production if missing                                                       | `apps/web/src/lib/attachment-url.ts:4-8`                                                                                                            | **yes**        |
| `AWS_ACCESS_KEY_ID`            | `beaconhs`                                                                            | `docker-compose.yml:44` only                                                                                                                        | container only |
| `AWS_SECRET_ACCESS_KEY`        | `beaconhs-dev-secret`                                                                 | `docker-compose.yml:45` only                                                                                                                        | container only |
| `S3_BUCKET`                    | `beaconhs-dev`                                                                        | `docker-compose.yml:46` only                                                                                                                        | container only |

**There are no `NEXT_PUBLIC_*` storage variables.** Grepped
`NEXT_PUBLIC_[A-Z_]*(S3|R2|STORAGE|UPLOAD|CDN|BUCKET|ENDPOINT)` — zero matches. The browser
never receives credentials, only signed URLs.

> **Note:** `turbo.json:4-26` lists `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
> `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `R2_PRIVATE_BUCKET_CONFIRMED` in `globalEnv`, but
> **omits `R2_ENDPOINT`**. Changing the storage endpoint does not invalidate the Turbo task
> cache. Minor defect; see Risks.

## 2.4 Exported API

| Export                        | Line    | Notes                                                                                                                                                      |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUCKET`                      | 57      | Module-level constant, read once at import                                                                                                                 |
| `ensureBucket()`              | 112-120 | `HeadBucket` → on 404/`NoSuchBucket` → `CreateBucket`; then `ensurePrivateBucketReady()`                                                                   |
| `ensurePrivateBucketReady()`  | 123-188 | See §2.6                                                                                                                                                   |
| `presignPut()`                | 190-204 | `PutObjectCommand` with `Metadata: {'upload-token'}` and `Tagging: 'beaconhs-state=pending'`; default expiry **300 s**                                     |
| `createMultipartUpload()`     | 206-225 | `ContentDisposition` default `'attachment'`; returns `UploadId`                                                                                            |
| `presignMultipartPart()`      | 227-246 | Validates part number 1..10000; default expiry **3600 s**                                                                                                  |
| `completeMultipartUpload()`   | 248-282 | **Server-side** `ListParts` pagination loop (`PartNumberMarker` / `IsTruncated` / `NextPartNumberMarker`, 253-270), sorts, completes                       |
| `abortMultipartUpload()`      | 284-292 |                                                                                                                                                            |
| `putObject()`                 | 298-356 | Auto-switches to multipart at ≥256 MiB; sequential `UploadPart`; aborts on failure                                                                         |
| `presignGet()`                | 358-364 | Default expiry **600 s**                                                                                                                                   |
| `objectKeyFromStorageUrl()`   | 398-432 | Decodes an object key from a path-style URL; rejects other origins, other buckets, `.`/`..`, encoded separators, control chars; caps the key at 1024 chars |
| `assertTenantLogoObjectKey()` | 434-453 | Requires `t/<tenantId>/branding/…` or `tenants/<tenantId>/branding/…`                                                                                      |
| `resolveTenantLogoUrl()`      | 460-471 | Public URLs pass through unchanged; internal keys are tenant-checked then presigned (900 s)                                                                |
| `headObject()`                | 481-495 | Returns `contentLength, contentType, contentDisposition, metadata, etag`, or `null` on 404                                                                 |
| `promoteObject()`             | 501-527 | `CopyObject` with `CopySourceIfMatch`, `MetadataDirective: 'REPLACE'`, `Metadata: {}`, `TaggingDirective: 'REPLACE'`, `Tagging: ''`                        |
| `getObjectRange()`            | 529-546 | `Range: bytes=a-b` with optional `IfMatch`                                                                                                                 |
| `objectExists()`              | 564-566 |                                                                                                                                                            |
| `presignExistingGet()`        | 568-575 | Returns `null` when the object is gone                                                                                                                     |
| `getObject()`                 | 578-584 | Buffers the whole object                                                                                                                                   |
| `getObjectStream()`           | 590-601 | `transformToWebStream()` — used for large artifacts (PPTX masters via WOPI)                                                                                |
| `deleteObject()`              | 603-605 | **Unconditional** — no `IfMatch`                                                                                                                           |
| `newAttachmentKey()`          | 607-617 | Delegates to `newTenantObjectKey` with `scope = kind`                                                                                                      |
| `newPendingUploadKey()`       | 619-626 | `scope = '_pending'`, filename = uploadId (UUID-validated)                                                                                                 |
| `assertTenantObjectKey()`     | 633-647 | Requires `t/<tenantId>/…` with ≥4 parts, each matching `OBJECT_KEY_PART_RE`                                                                                |
| `newTenantObjectKey()`        | 649-660 | `t/${tenantId}/${scope}/${randomUUID()}-${safeName}`; filename sanitized to `[A-Za-z0-9._-]`, truncated to 80 chars                                        |
| `s3Client`                    | 662     | **Dead export — zero consumers**                                                                                                                           |
| `export * from './multipart'` | 36      | Threshold 256 MiB, part size 64 MiB, `shouldUseMultipartUpload`, `multipartPartCount`                                                                      |

**There is no `ListObjectsV2` function anywhere.** Grepped
`(ListObjects|ListBuckets|ListObjectVersions|ListMultipartUploads)Command` — zero matches
outside `ListPartsCommand`.

## 2.5 Key construction — the tenant boundary

`newTenantObjectKey()` (`index.ts:649-660`) is the single canonical builder:

```ts
return `t/${args.tenantId}/${args.scope}/${randomUUID()}-${safe}`
```

Guarding regexes (`index.ts:628-630`):

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SCOPE_RE = /^[a-z0-9_](?:[a-z0-9_/-]*[a-z0-9_])?$/
const OBJECT_KEY_PART_RE = /^[a-zA-Z0-9._-]+$/
```

Every key is `t/<tenantId>/…`. This is asserted at mint time (`assertTenantObjectKey`), at
delete time (`storage-object-deletion-outbox.ts:33`), and **in the database itself** (see §5.3).

## 2.6 Bucket bootstrap and privacy

`ensureBucket()` (`:112-120`) then `ensurePrivateBucketReady()` (`:123-188`):

1. Throws if `R2_PUBLIC_URL` is set (`:124-128`) — a retired name that is now a hard error.
2. If the endpoint is Cloudflare R2 (`:59-70`, `:130-135`), requires
   `R2_PRIVATE_BUCKET_CONFIRMED=true`.
3. Otherwise issues `DeleteBucketPolicyCommand` (`:138`), tolerating only 404 /
   `NoSuchBucketPolicy` / `NoSuchLifecycleConfiguration` / `NoSuchPolicy` / `NotFound` (`:86-95`).
4. Reads existing lifecycle rules (`:146-152`), then `PutBucketLifecycleConfiguration` (`:154-161`)
   with `withManagedStorageLifecycleRules(existingRules)`.
5. Writes a canary object and performs an **unsigned** `fetch` against the path-style URL with
   `redirect: 'manual'`, failing if the response is 2xx/3xx (`:163-187`).

### Lifecycle rules — `src/lifecycle.ts`

```ts
export function storageObjectTagging(lifecycle) {
  return lifecycle === 'transient' ? `${STATE_KEY}=transient` : undefined
}
export function withManagedStorageLifecycleRules(existingRules) {
  return [
    ...existingRules.filter((r) => r.ID !== PENDING_RULE_ID && r.ID !== TRANSIENT_RULE_ID),
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
  ]
}
```

Operator-supplied rules are preserved; only the two BeaconHS-managed IDs are replaced. This is
**the only purge mechanism in the system** — there is no worker-based object sweep.

## 2.7 Signed URL expiry summary

| Operation              | Default | Call-site overrides         |
| ---------------------- | ------- | --------------------------- |
| `presignPut`           | 300 s   | —                           |
| `presignGet`           | 600 s   | 60 / 300 / 900 / **604800** |
| `presignMultipartPart` | 3600 s  | —                           |

**`ResponseContentDisposition` is never set on any presigned GET.** Grepped — zero matches.
Inline-vs-attachment is decided by the object's stored `ContentDisposition` header (set at PUT
time, `index.ts:218, 352`) or by the route handler setting its own header.

---

# 3. Database tables

## 3.1 `attachments` — `packages/db/src/schema/attachments.ts:26`

| Column                             | Type                   | Notes                                                      |
| ---------------------------------- | ---------------------- | ---------------------------------------------------------- |
| `id`                               | uuid                   |                                                            |
| `tenant_id`                        | uuid                   | FK tenants, cascade (`:30-32`)                             |
| `uploaded_by`                      | text                   | FK users                                                   |
| `kind`                             | `attachment_kind` enum | image, document, video, audio, signature, other (`:17-24`) |
| **`r2_key`**                       | text **NOT NULL**      | Unique index `attachments_r2_key_ux` (`:55`)               |
| `content_type`                     | text NOT NULL          |                                                            |
| `size_bytes`                       | bigint NOT NULL        |                                                            |
| `filename`                         | text NOT NULL          |                                                            |
| `width` / `height` / `duration_ms` | bigint                 | Media metadata                                             |
| `captured_at`                      | timestamptz            |                                                            |
| `geo_lat` / `geo_lng`              | double                 |                                                            |
| `exif`                             | jsonb                  |                                                            |
| `annotations`                      | jsonb                  | `Annotation[]` — drawn over an image                       |
| `caption`                          | text                   |                                                            |
| `created_at` / `updated_at`        | timestamptz            |                                                            |

**There is no `deleted_at`** — no soft delete. **No `checksum` column, no `bucket` column, no
`status` column, no `etag` column.** Integrity is carried by the S3 ETag, not stored.

## 3.2 `attachment_upload_reservations` — `attachments.ts:64`

The server-issued upload handshake. `staging_key` (75), `r2_key` (76), `filename`,
`content_type`, `size_bytes`, `verification_token_hash` (80), `expires_at` (81), `consumed_at`
(82), `attachment_id` (83), `requested_by`. Unique on `staging_key` (95) and `r2_key` (96).

Doc comment (`:59-63`): _"Browser uploads always land on a staging key; finalization verifies
this row and the object's immutable metadata, promotes the bytes to r2Key, and consumes the
reservation in one DB tx."_

## 3.3 `storage_object_deletion_outbox` — `schema/storage-object-deletions.ts:30`

> Note: the table is `storage_object_deletion_outbox`, not `storage_object_deletions`.

`tenant_id` (FK tenants, **no cascade**, `:34-39`), `attachment_id` NOT NULL, `object_key` NOT
NULL, `status` enum `pending | deleting`, `attempts`, `available_at`, `lease_id`, `claimed_at`,
`last_error`. Check constraint `object_key like ('t/' || tenant_id || '/%')` (`:69-72`),
`attempts >= 0` (`:73`), and a lease-state check (`:74-81`). Unique on `attachment_id` (55)
and `object_key` (56).

## 3.4 Pointer tables

`person_files` (`person-files.ts:15`) holds **no storage columns** — only an optional
`attachment_id` plus `label`/`kind`/`uploaded_by`. Its header comment (`:1-6`) states it
deliberately does not hold bytes.

`documents.ts` also holds pointers only: `documents.source_attachment_id` (`:53`),
`document_versions.content_attachment_id` (`:100`), `.docx_attachment_id` (`:104`),
`.pdf_attachment_id` (`:105`), `.render_status`/`.render_error` (`:109-110`),
`document_acknowledgments.signature_attachment_id` (`:215`).

**Attachment pointer columns** appear in ~20 schema files, including
`training-skills.ts:90,169` · `forms.ts:284,453,640` · `journals.ts:125` ·
`training-lms.ts:126,132,314,436,437` · `ppe.ts:150,307` · `inspection-records.ts:73,178` ·
`safe-distance.ts:82` · `equipment-inspection-records.ts:217,289` · `org.ts:165,173` ·
`reports.ts:198` · `training-extras.ts:43` · `ppe-annual-records.ts:56` ·
`corrective-actions.ts:143,174` · `inspection-record-criteria.ts:105` ·
`equipment.ts:142,143` · `hazid-assessments.ts:239,346` · `training.ts:138,229,297` ·
`incidents.ts:393` · `job-title-tasks.ts:66` · `hazid-libraries.ts:72`.

**Model:** `attachments` is the single storage-row table; everything else is a tenant-composite
FK to it. Deleting the `attachments` row triggers object deletion.

**RLS coverage** (`packages/db/src/rls.ts:118-120`): `attachments`,
`attachment_upload_reservations`, `storage_object_deletion_outbox`.

---

# 4. Upload path (end to end)

**There is no `/api/upload` route and no multipart POST route.** The protocol is server actions
for the handshake plus **direct presigned PUT / UploadPart from the browser** for the bytes.

```
┌──────────┐
│  Browser │  packages/ui/src/file-uploader.tsx
└────┬─────┘
     │ ①  requestUpload({kind, filename, contentType, sizeBytes})   [server action]
     ▼
┌──────────────────────────────────────────────────────────┐
│ apps/web/src/lib/uploads.ts  (module-level 'use server')   │
│  requireRequestContext()  → zod validate → per-kind caps   │
│  ensureStorageReady() → ensureBucket()                    │
│  cap 25 pending reservations per user                      │
│  INSERT attachment_upload_reservations (staging + final)   │
└────┬─────────────────────────────────────────────────────┘
     │ ②  { mode, putUrl | {multipartUploadId, partSize, partUrls}, uploadId }
     ▼
┌──────────┐
│  Browser │  XHR PUT straight at the presigned URL          [file-uploader.tsx:92-110]
└────┬─────┘   object lands at t/<tenantId>/_pending/<uploadId>
     │ ③  finalizeUpload({uploadId, multipartUploadId?})    [server action]
     ▼
┌──────────────────────────────────────────────────────────────────┐
│ finalizeUpload                                                      │
│  CompleteMultipartUpload → headObject(stagingKey)                 │
│  validateReservedUpload: metadata['upload-token'] hash matches,   │
│                          exact contentLength, normalized type     │
│  getObjectRange(0..511, ifMatch: etag) → magic-byte sniff         │
│  images: full getObject + optimizeUploadedImage (re-encode)       │
│  promoteObject  (CopyObject, CopySourceIfMatch)  ─or─  putObject   │
│  re-verify headObject (length, type, disposition)                 │
│  INSERT attachments + consume reservation  — ONE TRANSACTION      │
│  commit → deleteObject(stagingKey)                                │
└────┬─────────────────────────────────────────────────────────────┘
     │ ④  { ok: true, id, url: "/api/attachments/<id>?cap=<hmac>" }
     ▼
┌──────────┐   GET  →  capability check → session → RLS select
│  Browser │   307  →  presigned GET (60 s)  →  object store
└──────────┘
```

## 4.1 Server actions

`apps/web/src/lib/uploads.ts` — `'use server'` at line 1.

**`requestUpload(input)`** (`:131`):

- `requireRequestContext()` (`:143`).
- `ensureStorageReady()` → `ensureBucket()` (`:149`).
- Zod validation (`:56-75`) with per-kind caps (`:41-48`): image 50 MB, signature 10 MB,
  audio 200 MB, document = `MAX_PPTX_FILE_BYTES` = **1 GiB**
  (`packages/office/src/limits.ts:5`), video/other 500 MB.
- Caps concurrent pending reservations at 25 per user (`:50`, `:151-165`).
- `uploadId = randomUUID()`, `uploadToken = randomBytes(32).toString('base64url')` (`:167-168`).
- TTL 10 min single / 60 min multipart (`:51-52`, `:176-178`).
- Single → `presignPut(..., 300 s)` (`:225-230`).
  Multipart → `createMultipartUpload` + one `presignMultipartPart` per part at 3600 s
  (`:198-223`).
- On failure: `abortMultipartUpload` + delete the reservation row (`:232-244`).

**`finalizeUpload(input)`** (`:251`):

- Multipart: re-verify reservation ownership (`requestedBy !== ctx.userId` → 404-style, `:282-284`),
  `completeMultipartUpload` (`:287-290`), falling back to `headObject` if complete throws
  (`:291-294`).
- `SELECT … FOR UPDATE` on the reservation (`:298-303`); idempotent re-entry returns the
  already-linked attachment (`:307-331`).
- `headObject` + `validateReservedUpload` — verifies the `upload-token` metadata hash, exact
  `contentLength`, and normalized `contentType` (`:336-343`; `lib/upload-verification.ts:24-38`).
- Requires an ETag (`:344-346`), then magic-byte sniffing via `getObjectRange` (`:347-354`).
- Images: full `getObject` + `optimizeUploadedImage` (`:356-373`).
- `promoteObject` (CopyObject) or `putObject` if re-encoded (`:375-396`).
- Re-verify with `headObject` (`:397-407`).
- INSERT `attachments` + consume the reservation **in one transaction** (`:409-440`).
- Compensation on failure (`:441-456`) plus `compensateUncommittedFinal` (`:92-129`).
- After commit: `deleteObject(stagingKey)` (`:461`).
- Returns `attachmentUrl(attachmentId)` — a **capability URL, not a presigned URL** (`:472`).

## 4.2 Client components

**Primary** — `packages/ui/src/file-uploader.tsx`:

- `uploadWithXhr` (`:92-110`): raw `XMLHttpRequest` **PUT** at the presigned URL, with a
  `Content-Type` header and `xhr.upload.onprogress`.
- `uploadReservedFile` (`:112-145`): single mode PUTs the whole `File`; multipart slices with
  `file.slice(...)` and PUTs each part sequentially.
- `FileUploader` (`:147-345`) wires `requestUpload` → `uploadReservedFile` → `finalizeUpload`.
- Client-side size mirror: `packages/ui/src/upload-limits.ts:7-18`.

**Secondary** — `apps/web/src/components/file-upload.tsx:66-100` (`uploadOne`), same triple.

**~20 call sites** including `people/[id]/_files-drawers.tsx:181-182`,
`ppe/[id]/_certificate-drawer.tsx:234-235`, `training/courses/[id]/_lesson-surface.tsx:798-799`,
`training/_editor/ribbon.tsx:420-428` (manual), `slide-deck-editor.tsx:70-71`,
`apps/templates/[id]/fill/form-renderer.tsx:4574-4661` (manual),
`equipment/[id]/_files-drawer.tsx:172-173`.

**Server-side (non-browser) uploads** bypass presigning and call `putObject` directly:
`app/wopi/files/[fileId]/contents/route.ts:180-189` (Collabora save),
`lib/signature-storage.ts:70-75`, `(app)/account/actions.ts:166-167`,
`(app)/training/pptx/_actions.ts:307-308`, `(app)/documents/[id]/_master-actions.ts:144-145,302-303`,
`(app)/documents/[id]/_ai-actions.ts`, `apps/worker/src/workers/{pdf,document-render,reports}.ts`.

## 4.3 CSP gate

`apps/web/src/lib/security-headers.ts:61-74` adds the storage origin to `connect-src` (`:67`)
and `frame-src` (`:50`). The comment at `:63-66` explains why:

> "Browser uploads use short-lived presigned PUT/part URLs against the configured private
> S3-compatible store. Without this origin, CSP turns every shared FileUpload request into a
> generic browser 'Network error' before MinIO/R2 ever receives it."

The origin is injected from `R2_ENDPOINT` in `apps/web/src/proxy.ts:10`. **Because the compose
change kept the host port at 9000, this continues to work unchanged.**

---

# 5. Download path

Five distinct patterns. **Both presigned and proxied delivery are used.**

## Pattern A — capability URL → 307 redirect (60 s)

`apps/web/src/app/api/attachments/[id]/route.ts` (46 lines), the primary download path:

```ts
const cap = request.nextUrl.searchParams.get('cap') ?? ''
if (!validateAttachmentCapability(parsedId.data, cap)) return 404   // capability FIRST
const ctx = await getRequestContext()
if (!ctx) return 401
const attachment = await ctx.db(...)                                // RLS-scoped select
const signedUrl = await presignGet({ key: attachment.r2Key, expiresInSeconds: 60 })
const response = NextResponse.redirect(signedUrl, 307)
response.headers.set('Cache-Control', 'private, no-store')
response.headers.set('Referrer-Policy', 'no-referrer')
```

Capability minted at `lib/attachment-url.ts:18-20` — HMAC-SHA256 over
`attachment:v1:${attachmentId}` with `ATTACHMENT_CAPABILITY_SECRET`, base64url, verified with
`timingSafeEqual` (`:10-25`). Test coverage at `route.test.ts:39-69` proves the capability is
checked **before** auth and that a valid capability without a tenant still 404s.

Used in `href`/`src` across ~20 pages (`people/[id]`, `ppe/[id]`, `incidents/[id]`,
`journals/_data.ts:313`, `feed/_data.ts:538`, `corrective-actions/[id]`, `my/wallet`,
`documents/[id]/sign-off`, …). `components/raw-image.tsx:20-31` uses a bare `<img>` with reason
`'authenticated'`, bypassing the Next optimizer.

## Pattern B — server proxies the bytes (no URL to the client)

- `(app)/documents/[id]/versions/[versionId]/download/route.ts:64-72` — `getObjectStream`,
  gated by `assertCan(ctx, 'documents.read')` (`:28`) and published-or-`documents.manage` (`:43`),
  audited as `export` (`:56-62`).
- `(app)/documents/[id]/master/route.ts:51-61` — `documents.manage` only (`:26`).
- `(app)/training/pptx/[target]/[id]/download/route.ts:49-59` — `requireModuleManage('training')` (`:27`).
- `app/wopi/files/[fileId]/contents/route.ts:77-83` — WOPI token auth (`:57-67, 90-98`).
- `lib/pdf-route.ts` — `pdfBufferResponse` (`:25-34`), `storedPdfArtifactResponse` (`:36-41`),
  `renderOnDemandPdfResponse` (`:43-69`, which also `deleteObject`s the temp file at `:55`).
- ~30 further `/pdf/route.ts` and `/export.csv/route.ts` handlers build on these.

## Pattern C — presigned URL returned by a server action

- `(app)/documents/[id]/_actions.ts:128, 152` → `presignExistingGet(..., 300)`, returned to the
  browser and used at `_pdf-pane.tsx:184, 191` and `_read-only-pdf-modal.tsx:166-169`.
- `(app)/assistant/_document-reader-actions.ts:90` → `presignExistingGet(..., 300)`, rendered
  into an `<iframe src>` (`_components/document-reader.tsx:255, 262`).
- `lib/person-badge.ts:88` → `presignGet(..., 900)`.
- `packages/forms-pdf/src/training-credentials.ts:65` → `presignGet(..., 900)`;
  `:106, :178` → `resolveTenantLogoUrl`.
- **Public unauthenticated verify pages** — `app/verify/person/[token]/page.tsx:116` (300 s),
  `…/record/[recordId]/page.tsx:103`, `…/skill/[assignmentId]/page.tsx:111`.

## Pattern D — presigned URL in email (7 days)

`apps/worker/src/workers/reports.ts`:

```ts
const PDF_LINK_EXPIRY_SECONDS = 7 * 24 * 3600 // :70
const pdfLink = await presignGet({ key, expiresInSeconds: PDF_LINK_EXPIRY_SECONDS }) // :291-294
// :305 HTML  →  <a href="${escapeHtml(pdfLink)}">Download PDF</a>
// :312 plaintext
```

A 7-day bearer token to the raw object is emailed to external recipients.

## Pattern E — flows adapters presign for PDF embedding

`lib/flows/adapters/journals.ts:113`, `ppe.ts:181`, `equipment-inspections.ts:259`,
`corrective-actions.ts:149,155`, `hazid.ts:292,298`, `document-signoffs.ts:113`,
`incidents.ts:329`, `inspections.ts:221,252` — all `presignGet(..., 900)`. Plus
`apps/_lib/form-flow-adapter.ts:163`.

The PDF renderer's egress allowlist is `packages/forms-pdf/src/util.ts:106-125`; a storage URL
is fetched only if it carries an AWS signature (`hasAwsSignature`, `:98-102`, used at `:122`).

## Server-side reads (no URL involved)

`lib/assistant/document-content.ts:15` · `lib/flows/spreadsheet-attachments.ts:7` (XLSX → email
attachment) · `apps/_lib/analyze-photos.ts:11` (head + get for AI vision) ·
`(app)/journals/_actions.ts:22` · `(app)/documents/[id]/_master-actions.ts:283` ·
`apps/worker/src/workers/pdf.ts:106, 431, 441` · `reports.ts:431, 441` ·
`document-render.ts:247`.

---

# 6. Delete path

## 6.1 Soft vs. hard

- **`attachments` has no `deleted_at`** — deletion is a **hard DELETE**, and a database trigger
  enqueues the object deletion in the same transaction.
- `attachment_upload_reservations` rows are hard-deleted (`uploads.ts:238-242`).
- `storage_object_deletion_outbox` rows are never terminal — completed intents are
  compare-and-deleted (`packages/db/src/storage-object-deletion-outbox.ts:104-119`).
- Downstream entity tables (`documents`, `person_files`, …) do soft-delete, but that is
  entity-level, not object-level.

## 6.2 The database trigger

`packages/db/drizzle/0005_production_cutover.sql:2945-2968`:

```sql
CREATE OR REPLACE FUNCTION "enqueue_attachment_storage_object_deletion"() ...
  INSERT INTO public.storage_object_deletion_outbox (tenant_id, attachment_id, object_key)
  VALUES (OLD.tenant_id, OLD.id, OLD.r2_key);
CREATE TRIGGER "attachments_enqueue_storage_object_deletion"
  AFTER DELETE ON "attachments" FOR EACH ROW ...
```

And a write guard at `:2974-3007`:

```sql
IF NEW.r2_key NOT LIKE ('t/' || NEW.tenant_id::text || '/%') THEN RAISE EXCEPTION ...  -- :2980
IF EXISTS (SELECT 1 FROM storage_object_deletion_outbox ...) THEN RAISE EXCEPTION ...     -- :2987
CREATE TRIGGER "attachments_guard_storage_object_key"
  BEFORE INSERT OR UPDATE OF "tenant_id", "r2_key" ON "attachments" ...                    -- :3004
```

**This is a strong design**: the database itself enforces that every attachment key belongs to
its tenant and cannot collide with an in-flight deletion.

Tests: `packages/db/src/storage-object-deletion-integrity.test.ts:22-55`,
`packages/db/src/migration-rls-preflight.test.ts:69-77`.

## 6.3 The draining worker

`apps/worker/src/lib/storage-object-deletion-outbox.ts` (58 lines):

```ts
const BATCH_SIZE = 50
const DELETE_CONCURRENCY = 10
const claimed = await withSuperAdmin(db, tx => claimStorageObjectDeletionBatch(tx, {now, limit: BATCH_SIZE}))
  assertTenantObjectKey({ tenantId: intent.tenantId, key: intent.objectKey })   // :33
  await deleteObject({ key: intent.objectKey })                                  // :34
  const completed = await withSuperAdmin(db, tx => completeStorageObjectDeletion(tx, {...}))
  const released = await withSuperAdmin(db, tx => retryStorageObjectDeletion(...))
```

Lease/retry primitives in `packages/db/src/storage-object-deletion-outbox.ts`: 15 s initial
lease, exponential to a 1 h cap, 5-minute stale-lease reclaim, `SKIP LOCKED` (`:68`),
`gen_random_uuid()` lease (`:76`). Comment at `storage-object-deletion-outbox.ts:19`:

> "Retry forever: a storage outage must never turn committed deletion into lost work."

Scheduled by `apps/worker/src/workers/scheduled.ts:102-119` (tick `storage_object_deletion_scan`,
`* * * * *`), which also runs the expired-upload reconciler (`:109`) and throws if
`uploads.errors > 0` (`:115-117`).

## 6.4 Expired upload reservations

`apps/worker/src/lib/attachment-upload-reconciler.ts` (212 lines): batch 50 (`:7`),
`SKIP LOCKED` (`:132`), asserts both keys with `assertTenantObjectKey` (`:136-137`), then
`applyExpiredUploadReconciliation` (`:59-76`) — always deletes `stagingKey` (`:68`), then either
recovers the reservation link (`:70`) or deletes `r2Key` and the row (`:73-74`). Mismatches
fail closed (`:29-56`).

## 6.5 Retention

**Tag-based expiry is the only purge mechanism** (§2.6). Transient producers:
`apps/worker/src/workers/pdf.ts:597` and `workers/document-render.ts:267`; keys use scope
`_transient/pdfs/documents` (`document-render.ts:259`).

There is **no `DeleteObjects` (batch) API** — deletions are one at a time.

## 6.6 Ad-hoc direct deletes (bypassing the outbox)

`packages/storage/src/index.ts:186` (privacy probe) · `apps/web/src/lib/uploads.ts:127, 405, 447, 461` ·
`lib/signature-storage.ts:107` · `lib/pdf-route.ts:55` ·
`app/wopi/files/[fileId]/contents/route.ts:42` · `(app)/documents/[id]/_master-actions.ts:166, 343` ·
`(app)/training/pptx/_actions.ts:336` · `apps/worker/src/workers/pdf.ts:576, 615` ·
`reports.ts:232, 244` · `document-render.ts`.

---

# 7. File permission control

## 7.1 The deciding code

**Read** — `app/api/attachments/[id]/route.ts:13-39`. The comment at `:13-17` states the design:

> "Both the unforgeable capability and the caller's active tenant RLS scope must match;
> neither a session nor an attachment UUID alone authorizes delivery."

**Write** — `lib/uploads.ts:143` `requireRequestContext()`, `:151-165` pending cap,
`:157` and `:304` `requestedBy === ctx.userId`, all DB access via `ctx.db`.

**Delete** — `storage-object-deletion-outbox.ts:33` `assertTenantObjectKey` before every delete,
plus the DB check constraint and trigger (§6.2).

**Download routes** — `assertCan` / `requireModuleManage` / WOPI token verification.

## 7.2 Does presigning bypass RLS?

**Yes — by design, with layered compensating controls.** Once a URL is signed the object store
does not know who holds it; RLS applied only at mint time. The compensating layers:

1. **Key structure is the tenant boundary** — enforced at mint, at delete, and in the database.
2. **Bucket is private** — `ensurePrivateBucketReady` deletes the policy and proves an unsigned
   read fails (`:170-184`).
3. **Short TTLs** — 60 s (capability route), 300–900 s (server actions and public verify pages).
   **Exception: the 7-day email link.**
4. **Capability token** on the primary route — a knowledge-only UUID is insufficient.
5. **Upload-token metadata binding** — the staged object must carry a SHA-256-matched token
   before promotion.

**There is no per-file ACL.** No `GetObjectAcl` / `PutObjectAcl` / `PutBucketPolicy` calls
anywhere — grep confirms zero. All authorization is per-tenant, enforced in the application
layer, with the key prefix as the storage-side backstop.

## 7.3 A weakness worth flagging

`docs/PRODUCTION_RUNBOOK.md:61-66` describes anonymous-read denial as the guarantee, but
`ensurePrivateBucketReady()` is only ever invoked from `uploads.ts:85` and
`storage-init.ts:4` — **never from a read path**. If the bucket were re-publicized, reads would
continue to work; only an upload or a `storage-init` run would detect it. The cutover script is
stricter than the runtime probe (`cutover-target.ts:158` requires exactly 401 or 403, while the
runtime probe only rejects 2xx/3xx).

---

# 8. Consumer inventory

`@beaconhs/storage` is declared in `apps/web/package.json:36`, `apps/worker/package.json:35`,
`packages/forms-pdf/package.json:20`, and is `transpilePackages`-listed at
`apps/web/next.config.ts:32`.

**Web app (32 importers)** — `lib/uploads.ts` (core protocol) · `lib/signature-storage.ts` ·
`lib/pdf-route.ts` · `lib/person-badge.ts` · `lib/assistant/document-content.ts` ·
`lib/flows/spreadsheet-attachments.ts` · `lib/flows/adapters/*` (8 adapters) ·
`app/api/attachments/[id]/route.ts` · `app/wopi/files/[fileId]/contents/route.ts` ·
`(app)/account/actions.ts` · `(app)/documents/[id]/{_actions,_ai-actions,_master-actions}.ts` ·
`(app)/documents/[id]/master/route.ts` ·
`(app)/documents/[id]/versions/[versionId]/download/route.ts` ·
`(app)/training/pptx/_actions.ts` · `(app)/training/pptx/[target]/[id]/download/route.ts` ·
`(app)/training/credential-designs/preview/route.ts` · `(app)/reports/_run.ts` ·
`(app)/apps/_lib/{form-flow-adapter,analyze-photos}.ts` · `(app)/journals/_actions.ts` ·
`(app)/assistant/_document-reader-actions.ts` · `app/verify/person/[token]/*` (3 public pages) ·
`(app)/my/wallet/page.tsx` · `(app)/admin/settings/page.tsx` · `src/proxy.ts` ·
`scripts/{backfill-private-attachment-urls,backfill-tenant-storage-keys,backfill-signatures-to-storage,cutover-target}.ts` ·
`next.config.ts` · 2 test files.

**Worker (6 importers)** — `storage-init.ts` · `workers/{pdf,document-render,reports}.ts` ·
`lib/{storage-object-deletion-outbox,attachment-upload-reconciler}.ts` ·
`scripts/convert-documents-to-letter.ts` · 1 test.

**Package (1)** — `packages/forms-pdf/src/training-credentials.ts` (+ `util.ts` for env only).

**Confirmed NOT consumers** — `packages/appkit-feedback` (the in-app reporter has **no file
attachment support**; grepped, zero matches); `app/kiosk/*` (no storage access); plugins / ETL /
sync (export routes stream from the DB or `pdf-route.ts`).

---

# 9. S3 features used vs. vendor-specific features

## 9.1 Advanced features USED

| Feature                                                            | Location                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **Multipart upload** (server + presigned parts)                    | `multipart.ts:1-2` (256 MiB threshold, 64 MiB parts); `index.ts:206-292, 305-345`; `file-uploader.tsx:127-140` |
| **`ListParts` pagination**                                         | `index.ts:252-281` using `PartNumberMarker` / `IsTruncated` / `NextPartNumberMarker`                           |
| **`CopyObject` with `CopySourceIfMatch`**                          | `index.ts:513-526` — the _only_ mechanism that promotes a staging object to its final attachment key           |
| **`MetadataDirective: 'REPLACE'` + `TaggingDirective: 'REPLACE'`** | `index.ts:521-524` — strips the upload token and pending tag                                                   |
| **Object tagging on PUT / MPU / COPY**                             | `index.ts:201, 220, 353, 523-524`; `lifecycle.ts:9-13`                                                         |
| **Bucket lifecycle with tag filters**                              | `index.ts:146-161`; `lifecycle.ts:18-33` — includes `AbortIncompleteMultipartUpload`                           |
| **Bucket policy deletion**                                         | `index.ts:137-141`                                                                                             |
| **Range GET + `If-Match`**                                         | `index.ts:536-542` — the magic-byte sniff at `uploads.ts:347-352`                                              |
| **Custom object metadata (`x-amz-meta-`)**                         | `index.ts:200` writes `upload-token`; read at `upload-verification.ts:28`                                      |
| **HeadObject / HeadBucket**                                        | `index.ts:114, 483`                                                                                            |
| **Presigned PUT / GET / UploadPart (SigV4)**                       | `index.ts:203, 236-245, 363`                                                                                   |

## 9.2 Features confirmed ABSENT

Grepped each explicitly across the whole repository — **all zero matches**:

| Feature                                                                                          | Result                                                         |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Presigned POST policy (`@aws-sdk/s3-presigned-post`)                                             | **does not exist**                                             |
| Bucket versioning (`PutBucketVersioning`)                                                        | **does not exist**                                             |
| Object Lock / retention / legal hold                                                             | **does not exist**                                             |
| SSE, SSE-KMS, SSE-C (customer keys)                                                              | **does not exist** — no `ServerSideEncryption` is ever set     |
| SelectObjectContent                                                                              | **does not exist**                                             |
| Tagging read APIs (`GetObjectTagging` / `PutObjectTagging` / `DeleteObjectTagging`)              | **does not exist** — tags are only ever _written_              |
| ACL APIs (`GetBucketAcl` / `PutBucketAcl` / `GetObjectAcl` / `PutObjectAcl` / `PutBucketPolicy`) | **does not exist** — only `DeleteBucketPolicy`                 |
| `Content-MD5`                                                                                    | **does not exist** — integrity is via ETag and a local SHA-256 |
| Checksum headers / algorithms (`x-amz-checksum-crc32`, `ChecksumAlgorithm`)                      | **does not exist**                                             |
| `DeleteObjects` (batch delete)                                                                   | **does not exist**                                             |
| `ListObjectsV2` / `ListBuckets` / `ListObjectVersions` / `ListMultipartUploads`                  | **does not exist**                                             |
| Conditional delete (`IfMatch` on `DeleteObject`)                                                 | **not used** — `index.ts:603-605` is unconditional             |

**This is a favourable finding for the SeaweedFS migration:** BeaconHS uses a deliberately
narrow slice of S3, and every item in §9.1 is supported by SeaweedFS's S3 gateway. See
[beaconhs-seaweedfs-impact.md](./beaconhs-seaweedfs-impact.md).

## 9.3 Notable absences and design consequences

1. **`promoteObject` is a full intra-store copy of the entire object** (`CopyObject` with
   `CopySourceIfMatch`). For a 500 MiB video that is a complete server-side copy on every
   upload finalization. A design that avoided the copy (e.g. recording the final key first)
   would be cheaper, but the staging/promote design is what makes token verification safe.
2. **No SSE is configured anywhere.** Data at rest relies entirely on the object store's own
   default encryption.
3. **`forcePathStyle: true` is unconditional**, so every guard in the codebase
   (`objectKeyFromStorageUrl` at `index.ts:398-432`, `loadBrandingLogoDataUrl` at
   `pdf.ts:94-100`, `assertCutoverObjectPrivate` at `cutover-target.ts:150-151`) reconstructs
   exactly the `/{bucket}/{key}` path shape. All are coupled to path-style addressing.
4. **No tenant-level object purge.** `storage-object-deletions.ts:35-39` says a hard tenant
   delete "is intentionally blocked until its attachments are explicitly deleted and this
   outbox has drained" — but no code implements that block. Tenant deletion would have to be
   preceded by explicit attachment deletion.
5. **The bucket is a module-level constant** read once at import. There is no per-call override
   and no multi-bucket support.

---

# Risks & Open Questions

## Defects (documented only — nothing was changed)

| #   | Severity    | Finding                                                                                                                                                                                                                                                                                                                             | Location                                                                                                                                                                          |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Blocker** | **Empty credentials.** `.env:34-35` sets `R2_ACCESS_KEY_ID=` / `R2_SECRET_ACCESS_KEY=` (empty). `packages/storage/src/index.ts:39-40` uses `??`, which does **not** fall back on an empty string. The SDK is constructed with blank credentials and every request is SigV4-signed with an empty access-key id → 403 from the store. | `index.ts:39-40`, `.env:34-35`                                                                                                                                                    |
| 2   | High        | **7-day presigned URL emailed to external recipients** — a long-lived bearer token to the raw object leaves the tenant trust boundary.                                                                                                                                                                                              | `apps/worker/src/workers/reports.ts:70, 291-294, 305, 312`                                                                                                                        |
| 3   | Medium      | **`ensurePrivateBucketReady()` never runs on a read path** — a re-publicized bucket would serve reads undetected.                                                                                                                                                                                                                   | `uploads.ts:85`, `storage-init.ts:4`                                                                                                                                              |
| 4   | Medium      | **`R2_ENDPOINT` is missing from `turbo.json` `globalEnv`**, so changing the storage endpoint does not invalidate the task cache.                                                                                                                                                                                                    | `turbo.json:4-26`                                                                                                                                                                 |
| 5   | Medium      | `R2_ACCOUNT_ID=` (empty) makes the `accountId === 'local'` fallback at `index.ts:47` dead. Currently harmless only because `R2_ENDPOINT` is set explicitly. The same class of issue is handled correctly in `forms-pdf/src/util.ts:82-83`.                                                                                          | `index.ts:38, 47`                                                                                                                                                                 |
| 6   | Low         | **Dead MinIO references.** The `:9001` console URL is documented but no longer exists.                                                                                                                                                                                                                                              | `AGENTS.md:26,76`; `README.md:176,239,256`; `docs/QUICKSTART.md:32,46`; `scripts/launchers/dev-launcher.sh:294,442`; `dev-launcher.ps1:283,430`; `scripts/launchers/README.md:17` |
| 7   | Low         | **The dev launcher no longer waits for object storage.** The SeaweedFS service has no healthcheck, and `dev-launcher.sh:311-313` skips health-less containers. MinIO had one.                                                                                                                                                       | `docker-compose.yml:39-51`, `dev-launcher.sh:299-331`                                                                                                                             |
| 8   | Low         | **`s3Client` is exported with zero consumers** — a dead export, relevant to the `deadcode:check` gate.                                                                                                                                                                                                                              | `index.ts:662`                                                                                                                                                                    |
| 9   | Low         | The runtime privacy probe only rejects 2xx/3xx, while the cutover script requires exactly 401/403. A 3xx redirect to a public CDN would pass the runtime probe.                                                                                                                                                                     | `index.ts:177-181` vs `cutover-target.ts:158`                                                                                                                                     |
| 10  | Low         | **CI provisions no object store at all** (`.github/workflows/ci.yml` has only Postgres + Redis services), so none of the S3 surface is regression-tested.                                                                                                                                                                           | `.github/workflows/ci.yml:16-36`                                                                                                                                                  |

## Open questions

1. **Is the 7-day report email link acceptable?** For HSE documents that may include incident
   photographs or medical detail, a bearer URL valid for a week and forwarded to arbitrary
   recipients is likely unacceptable. Consider short expiry + authenticated download.
2. **Is there a data-residency requirement?** The current design ties an attachment to exactly
   one global bucket. A tenant requiring a specific region or a customer-managed key would need
   per-tenant bucket or SSE-KMS support, neither of which exists.
3. **Is there a retention/legal-hold requirement for attachments?** Deletion is a hard DELETE
   plus a best-effort outbox. There is no legal hold, and no way to prevent deletion of an
   attachment that is evidence in an open incident.
4. **Expected object volume and largest single object?** The multipart threshold is 256 MiB and
   `MAX_PPTX_FILE_BYTES` is 1 GiB, so the architecture assumes occasional very large uploads.
   Confirm this matches the HSE use case (site photos and videos) and that the chosen store
   handles it.

## Related documents

- [Architecture audit](./beaconhs-architecture.md) — the wider system
- [SeaweedFS impact](./beaconhs-seaweedfs-impact.md) — MinIO → SeaweedFS migration analysis
- [Extension points](./beaconhs-extension-points.md) — attaching files from a new module
