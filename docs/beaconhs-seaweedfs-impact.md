# BeaconHS — SeaweedFS Migration Impact Analysis

> **Status:** read-only audit. **Audited:** 2026-09-29 · **Commit:** `70da27c4`
> The operator has **already made** the MinIO → SeaweedFS change in `docker-compose.yml`
> (uncommitted). This document analyses what that change requires, what it breaks, and what
> still needs verification. **No code was modified.**
>
> Companion to [beaconhs-storage-audit.md](./beaconhs-storage-audit.md), which audits the
> object storage subsystem as it exists.

## 摘要（中文执行摘要）

**结论：docker-compose 的改动本身是正确的，应用代码零改动即可运行。**

应用端从未读取 `S3_*` / `AWS_*`，只读取 `R2_*`。由于 compose 保持了宿主机端口 9000，
`R2_ENDPOINT=http://localhost:9000` 与新的 `9000:8333` 映射仍然吻合，CSP 白名单、
所有 URL 拼接逻辑、预签名 URL 格式**全部无需修改**。

我已对照 SeaweedFS master 分支的 S3 路由源码核实：BeaconHS 用到的每一个 S3 操作
（lifecycle 读写、bucket policy 删除、对象 tagging、完整 multipart 集合、CopyObject、
Range + If-Match、HeadObject）**都已注册**。未实现的只有 analytics / inventory /
intelligent-tiering / metrics 四类，而 BeaconHS 完全不使用它们。

**但存在一个阻断级缺陷，与 MinIO/SeaweedFS 切换无关：**

> `.env` 中 `R2_ACCESS_KEY_ID` 与 `R2_SECRET_ACCESS_KEY` 为空字符串，
> 而 `packages/storage/src/index.ts:39-40` 使用 `??`。空字符串**不触发**默认值回退，
> 因此 SDK 使用**空凭据**签名，所有请求被拒绝（403）。切换前后都存在，必须修复。

**分类结论：**

| 分类              | 数量 | 要点                                                                                 |
| ----------------- | ---- | ------------------------------------------------------------------------------------ |
| **A. 已完成**     | 4    | compose 服务定义、端口映射、凭据变量名、bucket 名称，全部正确                        |
| **B. 必须修改**   | 1    | `.env` 凭据（唯一的阻断项）                                                          |
| **C. 可保持不变** | 20+  | 应用代码、CSP、全部 38 个消费方、路径风格寻址、数据库表                              |
| **D. 存在风险**   | 7    | tag 过滤 lifecycle 的实际执行、CopyObject 的 TaggingDirective、缺失的 healthcheck 等 |
| **E. 待验证**     | 8    | 需实际运行确认，本审计**未做任何运行时验证**                                         |

**必须强调：本次审计是纯静态的。没有任何一项经过实际运行验证。**

---

# 0. Method and evidence basis

Two independent sources were used, and I have deliberately separated what each can prove.

**Source 1 — the repository itself (read directly).** Every application-side claim below cites
a `path:line` in this repo.

**Source 2 — SeaweedFS upstream (read directly, not from memory).** I fetched SeaweedFS's own
`README.md` and the S3 router source from `master` to establish which operations are registered.
This is stated explicitly so you can weigh the evidence: **I read `master`, not the exact digest
behind the `chrislusf/seaweedfs:latest` tag your compose pins.** `latest` is built from master,
so this is a good proxy — but it is a proxy, and item **E1** below exists precisely to close the
gap.

**I did not run anything.** No container was started, no request was issued, no response was
observed. Every claim about runtime behaviour is a _prediction from source_, and is labelled as
such.

---

# A. Already completed and correct

The operator's change, verbatim from `docker-compose.yml:39-51`:

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

Each element verified against SeaweedFS's own documentation and source:

## A1. The image and command — `chrislusf/seaweedfs:latest`, `mini -dir=/data -ip=0.0.0.0`

**Correct.** SeaweedFS's README, lines 67–87:

> ```
> S3_BUCKET=my-bucket \
> ./weed mini -dir=./data
> ```
>
> "That's it. The S3 endpoint is at http://localhost:8333, `my-bucket` exists, and
> `admin`/`secret` are valid credentials"
> "The same process also runs the master, a volume server, the filer, WebDAV, the Iceberg REST
> catalog, and the Admin UI."
> "`weed mini` is auto-tuned for one node and is fine for single-node production, such as an
> S3 gateway that issues presigned URLs."

`mini` is an all-in-one mode, so a single container provides master + volume + filer + S3. The
`-ip=0.0.0.0` flag is needed for the container network to work and is correct.

Critically, the README explicitly endorses this use case: _"fine for single-node production,
such as an S3 gateway that issues presigned URLs"_ — which is exactly what BeaconHS is.

## A2. Port mapping `9000:8333`

**Correct.** SeaweedFS's S3 gateway listens on **8333**, not 9000. The README states the endpoint
is `http://localhost:8333`.

**This is the single most important reason the change is cheap:** mapping host **9000** to
container **8333** preserves the host-side address that `.env` already points at, so
`R2_ENDPOINT=http://localhost:9000` keeps working untouched. Had the operator mapped 8333
directly, `.env` and every documented URL would have needed changing.

## A3. Credential variable names — `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`

**Correct.** These are SeaweedFS's documented server-side credential variables. The README's
example notes _"Drop the AWS keys to run without authentication for development"_, confirming
they are the auth mechanism.

The values `beaconhs` / `beaconhs-dev-secret` are deliberately identical to the MinIO
credentials from `docker-compose.yml.bak:44-45`, so no data or credential migration is implied.

**Important distinction that is often gotten wrong:** these are **SeaweedFS's** variables, not
the application's. The application reads `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
(`packages/storage/src/index.ts:39-40`) and has never read `AWS_*`. No `NEXT_PUBLIC_*`
equivalent exists. See **B1** for the consequence of that split.

## A4. `S3_BUCKET: beaconhs-dev` — and why it is _not_ dead config

**Correct, and load-bearing.** This is worth stating explicitly because it is easy to
misdiagnose as a no-op: SeaweedFS's README line 72 shows `S3_BUCKET=my-bucket` as the bucket
pre-creation mechanism for `weed mini`, and line 76 confirms _"my-bucket exists"_ afterwards.

The name `beaconhs-dev` matches the application's `R2_BUCKET` default
(`packages/storage/src/index.ts:41`) and the value in `.env:36`. So the bucket the container
creates on boot is the bucket the application addresses.

There is also an independent application-side fallback: `ensureBucket()` issues
`CreateBucketCommand` when `HeadBucket` returns 404 (`index.ts:112-120`). The two mechanisms
are belt-and-braces, not contradictory.

---

# B. Must be modified

## B1. `.env` — empty storage credentials (**BLOCKER**)

**This is the one blocking defect, and it is the only required change.**

`.env:31-37` and `.env.example:31-37`:

```
# --- File storage (Cloudflare R2 / S3-compatible) ---
R2_ENDPOINT=http://localhost:9000
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=            ← empty
R2_SECRET_ACCESS_KEY=        ← empty
R2_BUCKET=beaconhs-dev
R2_PRIVATE_BUCKET_CONFIRMED=false
```

`packages/storage/src/index.ts:38-41`:

```ts
const accountId = process.env.R2_ACCOUNT_ID ?? 'local'
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? 'beaconhs'
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? 'beaconhs-dev-secret'
```

**The defect: `??` is nullish coalescing, and an empty string is not nullish.**

```
'' ?? 'beaconhs'  →  ''        // what the code does
'' || 'beaconhs'  →  'beaconhs' // what was presumably intended
```

And dotenv parses `R2_ACCESS_KEY_ID=` to `""`, not `undefined`. So the `S3Client` at
`index.ts:50-55` is constructed with `credentials: { accessKeyId: '', secretAccessKey: '' }`.
Every request is SigV4-signed with an **empty access-key id**, and the store rejects it.

**Blast radius — this is why it is a blocker, not a warning.** `ensureStorageReady()` is called
at the top of `requestUpload` (`apps/web/src/lib/uploads.ts:85, 149`), so:

- **every** attachment upload fails,
- including signatures, form attachments, evidence photos, PPE certificates, incident photos,
  equipment documents, and training files — ~20 call sites,
- and the failure cascades: because the signer's failure is a _credentials_ failure rather than
  a _bucket_ failure, `ensureBucket()` never even reaches `CreateBucketCommand`.

**This predates the SeaweedFS change.** With MinIO it would have failed identically, since
MinIO also requires credentials and `docker-compose.yml.bak:44-45` set them. The likely
explanation is that local development either populated `.env` by hand or never exercised the
real S3 path in a way that surfaced it.

**Two independent fixes, either is sufficient:**

| Option                | Change                                                                                                 | Note                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Set the values** | `R2_ACCESS_KEY_ID=beaconhs`, `R2_SECRET_ACCESS_KEY=beaconhs-dev-secret` in `.env` (and `.env.example`) | Matches `docker-compose.yml:44-45`. **Recommended** — no code change, and it makes the dev credentials explicit rather than hidden in source. |
| 2. Fix the operator   | `??` → `\|\|` at `index.ts:39-40` (and `:38` for `R2_ACCOUNT_ID`)                                      | Restores the intended fallback, but keeps dev credentials hard-coded in source.                                                               |

**Option 2 alone is not recommended**, but note that `R2_ACCOUNT_ID` at `:38` has the identical
defect: with `R2_ACCOUNT_ID=` (empty), the `accountId === 'local'` branch at `:46-48` is dead.
It is currently harmless _only_ because `R2_ENDPOINT` is set explicitly, which short-circuits
the expression at `:45`. The same class of issue is handled correctly in
`packages/forms-pdf/src/util.ts:82-83`, which tests `!== 'local'` rather than relying on `??`.

**A hardening suggestion (not required):** nothing validates that the application's credentials
match the container's. A silent mismatch is indistinguishable from a network failure at the
application layer. A startup assertion would convert a confusing 403 into a clear config error.

---

# C. Can stay unchanged

Everything in this section was verified to be independent of the object-store implementation.

## C1. The application's S3 client — no change needed

`packages/storage/src/index.ts:50-55`:

```ts
const client = new S3Client({
  region: 'auto',
  endpoint, // http://localhost:9000  (unchanged)
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
})
```

| Setting                       | SeaweedFS compatibility                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `forcePathStyle: true`        | **Supported.** SeaweedFS's router is mounted at `PathPrefix("/{bucket}")` (`weed/s3api/s3api_server.go:832`), which _is_ path-style addressing. |
| `region: 'auto'`              | **Irrelevant.** SeaweedFS does not enforce region; the value is never validated.                                                                |
| Custom `endpoint`             | **Supported.** This is the documented S3-gateway mode.                                                                                          |
| `@aws-sdk/client-s3 3.1086.0` | Standard SigV4 client; SeaweedFS implements SigV4 (`auth_signature_v4.go`, plus SigV2 support).                                                 |

## C2. The S3 operations BeaconHS uses are all registered

I read SeaweedFS master `weed/s3api/s3api_server.go` to enumerate the registered routes. Every
operation `packages/storage` issues is present:

| BeaconHS operation               | Call site                     | SeaweedFS route (`s3api_server.go`)                                                                                                                                                      |
| -------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HeadObject`                     | `index.ts:483`                | `:904-907` (HEAD)                                                                                                                                                                        |
| `GetObject`                      | `index.ts:362, 579, 593, 537` | `:910-913` (GET)                                                                                                                                                                         |
| `PutObject`                      | `index.ts:347`                | `:918` (PUT)                                                                                                                                                                             |
| `DeleteObject`                   | `index.ts:604`                | `:920` (DELETE)                                                                                                                                                                          |
| **`CopyObject`**                 | `index.ts:514`                | `:916` — requires `X-Amz-Copy-Source` to contain `/` or `%2F`; `promoteObject` builds `` `${bucket}/${sourceKey}` `` (`index.ts:509-512`), which always contains a slash. **Satisfied.** |
| `CreateMultipartUpload`          | `index.ts:213`                | `:865` (`?uploads`)                                                                                                                                                                      |
| `UploadPart`                     | `index.ts:238, 318`           | `:861` (`?partNumber&uploadId`)                                                                                                                                                          |
| `CompleteMultipartUpload`        | `index.ts:275, 333`           | `:863` (`?uploadId`)                                                                                                                                                                     |
| `AbortMultipartUpload`           | `index.ts:285`                | `:867` (`?uploadId`)                                                                                                                                                                     |
| **`ListParts`**                  | `index.ts:256`                | `:869` (`?uploadId`)                                                                                                                                                                     |
| **Object tagging** (write)       | `index.ts:201, 220, 353, 523` | `:876-880` (`?tagging` GET/PUT/DELETE)                                                                                                                                                   |
| **Bucket lifecycle** (read)      | `index.ts:147`                | `:949` (`GET ?lifecycle`)                                                                                                                                                                |
| **Bucket lifecycle** (write)     | `index.ts:155`                | `:951` (`PUT ?lifecycle`)                                                                                                                                                                |
| **Bucket policy** (delete)       | `index.ts:138`                | `:939` (`DELETE ?policy`)                                                                                                                                                                |
| `CreateBucket`                   | `index.ts:117`                | registered in the bucket section                                                                                                                                                         |
| `HeadBucket`                     | `index.ts:114`                | registered in the bucket section                                                                                                                                                         |
| `ListObjectsV2`                  | **not used**                  | n/a                                                                                                                                                                                      |
| Presigned PUT / GET / UploadPart | `index.ts:203, 236, 363`      | SigV4 presigning supported (`auth_presigned_semicolon_test.go`)                                                                                                                          |

**SeaweedFS stubs only four sub-resources** — `weed/s3api/s3api_bucket_config_stubs.go`
(`GetAnalyticsConfiguration`, `ListBucketAnalyticsConfigurations`, `GetInventoryConfiguration`,
`ListBucketInventoryConfigurations`, `GetIntelligentTieringConfiguration`,
`ListBucketIntelligentTieringConfigurations`, `GetMetricsConfiguration`,
`ListBucketMetricsConfigurations`). The file's own comment explains why:

> "Stub responses for bucket configuration sub-resources that SeaweedFS does not store
> (analytics, inventory, intelligent-tiering, metrics). AWS SDKs probe these on bucket
> discovery; returning a well-formed empty list keeps them happy instead of failing with
> MethodNotAllowed."

**BeaconHS uses none of these.** Confirmed by grepping
`analytics|inventory|intelligent.?tier|metrics` against every S3 command in
`packages/storage/src` — zero matches.

## C3. The privacy probe should pass

`packages/storage/src/index.ts:163-187` writes a canary object then performs an **unsigned**
`fetch` against `http://localhost:9000/<bucket>/_privacy-probe/<uuid>`, failing if the status
is 2xx or 3xx.

Since the compose sets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, SeaweedFS requires
authentication. An unauthenticated GET should return **403**, which is not in the 2xx/3xx
range, so the probe passes.

> Note: the runtime probe is looser than the cutover script, which requires exactly 401 or 403
> (`apps/web/scripts/cutover-target.ts:158`). A 3xx redirect to a public CDN would pass the
> runtime probe. Not a SeaweedFS-specific issue, but worth tightening.

## C4. Browser CSP — unchanged

`apps/web/src/lib/security-headers.ts:61-74` injects the storage origin into `connect-src`
(from `R2_ENDPOINT` via `apps/web/src/proxy.ts:10`). Because `R2_ENDPOINT` is still
`http://localhost:9000`, the CSP still matches the presigned PUT destination. **No change
required** — and this is the failure mode the comment at `:63-66` warns about.

## C5. Path-style addressing — unchanged, and everything coupled to it holds

`forcePathStyle: true` produces `http://localhost:9000/beaconhs-dev/t/<uuid>/…`. Four
independent places reconstruct exactly that shape, and all still work:

| Consumer                            | Line                                         |
| ----------------------------------- | -------------------------------------------- |
| `objectKeyFromStorageUrl()`         | `packages/storage/src/index.ts:398-432`      |
| `loadBrandingLogoDataUrl()`         | `apps/worker/src/workers/pdf.ts:94-100`      |
| `assertCutoverObjectPrivate()`      | `apps/web/scripts/cutover-target.ts:150-151` |
| The PDF renderer's egress allowlist | `packages/forms-pdf/src/util.ts:106-125`     |

## C6. All 38 application call sites — unchanged

The full consumer inventory is in
[the storage audit §8](./beaconhs-storage-audit.md#8-consumer-inventory). Because every one of
them goes through the `@beaconhs/storage` abstraction, and the endpoint/bucket values are
unchanged, **none requires modification**: `apps/web/src/lib/uploads.ts`,
`lib/signature-storage.ts`, `lib/pdf-route.ts`, the 8 `lib/flows/adapters/*`, the WOPI routes,
`apps/worker/src/workers/{pdf,document-render,reports}.ts`, and
`packages/forms-pdf/src/training-credentials.ts`.

## C7. The database layer — entirely independent

`attachments`, `attachment_upload_reservations`, and `storage_object_deletion_outbox`
(`packages/db/src/schema/attachments.ts`, `storage-object-deletions.ts`) store **keys**, not
endpoints. The delete-outbox worker
(`apps/worker/src/lib/storage-object-deletion-outbox.ts`) calls `deleteObject()` through the
same abstraction. **No schema or migration change is required.**

## C8. Bucket privacy posture

`ensurePrivateBucketReady()` (`index.ts:123-188`) calls `DeleteBucketPolicyCommand`
(`:138`). SeaweedFS registers `DELETE ?policy` (`s3api_server.go:939`), and the error handling
at `index.ts:86-95, 137-141` tolerates `404` / `NoSuchBucketPolicy` / `NotFound`. A bucket with
no policy configured should therefore return 404 and be tolerated. **Predicted to pass — see
E2.**

## C9. Deployment configuration

`deploy/dokploy-dev.compose.yaml:26-30, 79-83, 112-129` injects `R2_*` into `web`, `worker`,
and the one-shot `storage-init` role. These are **application** variables and are untouched by
the change. The `storage-init` bootstrap (`apps/worker/src/storage-init.ts:4`, dispatched by
`docker/entrypoint.sh:14-16`) continues to work.

## C10. Documentation of the contract is still accurate

`docs/PRODUCTION_RUNBOOK.md:82-91` documents the `R2_*` variables — all still the real variable
names. Only the MinIO _branding_ is stale (see D6).

---

# D. Risks

## D1. Tag-filtered bucket lifecycle — **the highest functional risk**

`packages/storage/src/lifecycle.ts:18-33` installs two rules that are BeaconHS's **only**
purge mechanism:

```ts
{ ID: 'expire-unfinalized-uploads', Status: 'Enabled',
  Filter: { Tag: { Key: 'beaconhs-state', Value: 'pending' } },
  Expiration: { Days: 1 },
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }
{ ID: 'expire-transient-artifacts', Status: 'Enabled',
  Filter: { Tag: { Key: 'beaconhs-state', Value: 'transient' } },
  Expiration: { Days: 1 } }
```

**The API is registered** (`s3api_server.go:951`) and **the XML is stored** — I read
`weed/s3api/s3api_bucket_lifecycle_config.go`, which persists the configuration to the bucket's
config via `storeBucketLifecycleConfiguration()`.

**What is not established is whether the _executor_ honours all three specifics**: (i) a
`Filter: { Tag: … }` predicate, (ii) `Expiration: { Days: 1 }` measured from the tag match, and
(iii) `AbortIncompleteMultipartUpload`. SeaweedFS has a dedicated
`s3lifecycle/scheduler` package and a file named `s3api_bucket_lifecycle_fastpath_warn.go`,
which suggests a known caveat in the fast path. **I have not read the scheduler's rule-matching
code, so I am not going to guess.**

**Two failure modes, both bad:**

| Failure mode                                          | Consequence                                                                                                                                                                                                         | Severity           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `PutBucketLifecycleConfiguration` returns an error    | `ensureBucket()` throws → **every upload fails**, exactly as B1 would. Note `index.ts:154-161` is **unguarded** — the error tolerance at `:86-95` applies only to the _read_.                                       | **Blocker**        |
| The PUT succeeds but tag filters are silently ignored | Staging objects and transient PDFs accumulate **forever**. Not user-visible; a storage-cost and disk-pressure problem. Also leaves `AbortIncompleteMultipartUpload` unapplied, so abandoned multipart uploads leak. | **Medium, silent** |

The second mode is the dangerous one, because nothing in BeaconHS would detect it — the
`storage_object_deletion_scan` tick cleans up _finalized_ objects via the outbox, but nothing
observes the lifecycle rules at all.

**Verification:** E3. **Mitigation if it fails:** BeaconHS already has a reconciler for
expired upload _reservations_ (`apps/worker/src/lib/attachment-upload-reconciler.ts`, run by the
same `storage_object_deletion_scan` tick at `workers/scheduled.ts:109`). Extending it to delete
the corresponding S3 staging objects would make the system independent of lifecycle support.

## D2. `CopyObject` with `TaggingDirective: 'REPLACE'` and an empty `Tagging` value

`packages/storage/src/index.ts:513-526`:

```ts
new CopyObjectCommand({
  Bucket: bucket,
  Key: args.destinationKey,
  CopySource: source,
  CopySourceIfMatch: args.sourceEtag,
  MetadataDirective: 'REPLACE',
  Metadata: {},
  TaggingDirective: 'REPLACE',
  Tagging: '',
})
```

This is **the only mechanism that turns a staging object into its final attachment object**
(`apps/web/src/lib/uploads.ts:387-393`). It simultaneously:

- carries a conditional copy guard (`CopySourceIfMatch`) — a security-relevant check,
- strips the `upload-token` metadata (`MetadataDirective: 'REPLACE'`, `Metadata: {}`),
- clears the `beaconhs-state=pending` tag (`TaggingDirective: 'REPLACE'`, `Tagging: ''`).

**`CopyObject` is registered** (`s3api_server.go:916`), and SeaweedFS has substantial copy
support (`s3api_object_handlers_copy*.go`, including `_unified.go`, `_etag_test.go`,
`_checksum_test.go`, `_collection_test.go`). **But the `?tagging` _sub-resource_ is a separate
route** from the plain copy route, and `Tagging: ''` — an empty tag set with `REPLACE` — is a
degenerate case that a lenient implementation may either ignore or reject.

**Why it matters more than it looks.** If the copy succeeds but silently ignores
`TaggingDirective: 'REPLACE'`, the final object keeps `beaconhs-state=pending` and would then be
**expired by the D1 lifecycle rule after 1 day** — deleting a live attachment and leaving a
dangling `attachments` row. That is a data-loss failure mode, not just a config mismatch.

**Verification:** E4. **Mitigation:** re-read the promoted object's tags after the copy. The
code already re-verifies length, content type, and disposition
(`apps/web/src/lib/uploads.ts:397-407`); a tag assertion fits the same pattern. `HeadObject`
may or may not return tags, which is itself worth establishing.

## D3. `ListParts` pagination fields

`packages/storage/src/index.ts:252-270` loops on `PartNumberMarker`, `IsTruncated`, and
`NextPartNumberMarker`. `ListParts` is registered (`:869`), and SeaweedFS has
`s3api_nextmarker_test.go` and `s3api_list_parts_action_test.go`, which is encouraging. If
`IsTruncated` were always false, the loop would still work for the common case of ≤1000 parts
at 64 MiB (i.e. ≤64 GiB per object) — the AWS default page size. So the practical risk is low,
but it is untested against this client.

**Verification:** E5.

## D4. 64 MiB multipart part size and 1 GiB objects

`packages/storage/src/multipart.ts:1-2` sets a 256 MiB threshold and 64 MiB parts;
`MAX_PPTX_FILE_BYTES` is 1 GiB (`packages/office/src/limits.ts:5`), so a large PPTX becomes
~16 presigned `UploadPart` PUTs. 64 MiB is above the S3 5 MiB minimum, which
`multipartPartCount` itself validates (`multipart.ts:15-17`) — but only against _its own_
input, not against the server.

SeaweedFS supports SSE-S3 multipart and multipart ETags (there is a dedicated
`filer_multipart_etag_test.go`), so multipart is clearly a supported path. No concern predicted,
but the largest-object case is untested against this deployment.

**Verification:** E6.

## D5. The removed healthcheck

The MinIO service had:

```yaml
healthcheck:
  test: ['CMD', 'curl', '-f', 'http://localhost:9000/minio/health/live']
```

SeaweedFS has none. Consequence: `scripts/launchers/dev-launcher.sh:299-331` iterates compose
containers and **skips any without a healthcheck** (`if [[ "$status" == "none" ]]; then continue; fi`
at `:311-313`). So the dev launcher **no longer waits for object storage readiness at all**.

With MinIO it would block until storage was ready. Now the app may start before SeaweedFS is
listening. Combined with B1 this could produce a confusing first-failure: the developer sees an
upload error and may blame startup ordering rather than the empty credentials.

**Mitigation (optional):** SeaweedFS exposes a filer/S3 status endpoint; a healthcheck could be
added. Not required for correctness — the upload path retries via `ensureStorageReady()`'s
memoized promise, which resets on failure (`uploads.ts:85-88`) — but it removes a class of
confusing local failures.

## D6. Stale MinIO console documentation (7 files)

The `:9001` console URL is documented but no longer exists. These are **all wrong now**:

| File:line                                     | Content                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `AGENTS.md:26`                                | "starts Postgres on 5433, Redis on 6380, MinIO on 9000/9001, and Mailpit on 8025"                    |
| `AGENTS.md:76`                                | "`packages/storage`: S3-compatible storage client for MinIO/R2."                                     |
| `README.md:176`                               | Tech-stack table: "Storage — S3-compatible (MinIO in dev, Cloudflare R2 in prod)"                    |
| `README.md:239`                               | "# 3. Bring up local infra (Postgres, Redis, MinIO, Mailpit)"                                        |
| `README.md:256`                               | Service table: "MinIO console — http://localhost:9001"                                               |
| `docs/QUICKSTART.md:32`                       | "docker compose --profile local-db up -d # postgres:5433, redis:6380, minio:9000/9001, mailpit:8025" |
| `docs/QUICKSTART.md:46`                       | "MinIO console: <http://localhost:9001> (login `beaconhs` / `beaconhs-dev-secret`)"                  |
| `scripts/launchers/dev-launcher.sh:294`       | "Docker is required for Redis, MinIO, and Mailpit."                                                  |
| `scripts/launchers/dev-launcher.sh:442`       | `log "MinIO console: http://localhost:9001"`                                                         |
| `scripts/launchers/dev-launcher.ps1:283, 430` | same two messages                                                                                    |
| `scripts/launchers/README.md:17`              | "start Redis, MinIO, Mailpit, and optionally local Postgres"                                         |

**`README.md:256` and `docs/QUICKSTART.md:46` are the worst**, because they instruct a new
developer to open a console that will not respond — the first interaction a new contributor has
with the storage layer. This violates AGENTS.md rule 7.

**Nothing was changed.** These are recorded for a follow-up pass.

## D7. The runtime privacy probe is looser than the cutover script

Already noted under C3, repeated here as a migration risk: if SeaweedFS's unauthenticated
response were, say, a 302 to an HTML page, `index.ts:177-181` (which rejects only 2xx/3xx —
actually 3xx _would_ be rejected, since the check is `status >= 200 && status < 400`) would fail
correctly. So the probe is adequate for SeaweedFS's expected 403. The looseness is that it
accepts 4xx from _any_ cause, not specifically 401/403. Low risk, low value to change.

---

# E. Requires further verification

**None of the following was tested. This audit performed no runtime verification of any kind.**

Recommended order — E1 first, since it gates the rest.

| #      | Item                                                                            | How to verify                                                                                                                                                                                                                                                                                                         | Priority |
| ------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **E1** | The `chrislusf/seaweedfs:latest` tag actually contains the `master` code I read | Pin a digest instead of `latest`: `chrislusf/seaweedfs@sha256:…`. Reproducibility matters for a dev dependency, and it removes the entire class of "works on my machine" drift.                                                                                                                                       | **High** |
| **E2** | `ensureBucket()` succeeds end to end                                            | Fix B1, then run the upload path once. `ensureBucket()` exercises `HeadBucket` → `CreateBucket` → `DeleteBucketPolicy` → `GetBucketLifecycleConfiguration` → `PutBucketLifecycleConfiguration` → the unsigned privacy probe. **This single call is the highest-value smoke test** — it covers D1, D8, and C8 at once. | **High** |
| **E3** | Tag-filtered lifecycle rules are actually _executed_                            | Write a `beaconhs-state=pending` object, wait >1 day (or force the scheduler), and check it is deleted. **A 1-day wait is impractical in a dev loop** — consider temporarily shortening the rule, or checking SeaweedFS's `s3lifecycle/scheduler` source for tag-filter support.                                      | **High** |
| **E4** | `CopyObject` honours `TaggingDirective: 'REPLACE'` with `Tagging: ''`           | Complete one real upload, then inspect the final object's tags. If the tag is still `beaconhs-state=pending`, the D2 data-loss mode is live.                                                                                                                                                                          | **High** |
| **E5** | `ListParts` pagination fields                                                   | Upload an object with more than 1000 parts, or inspect a SeaweedFS `ListParts` response for `IsTruncated`/`NextPartNumberMarker`.                                                                                                                                                                                     | Low      |
| **E6** | 64 MiB parts and a 1 GiB object                                                 | Upload a large PPTX through the normal training-PPTX path.                                                                                                                                                                                                                                                            | Low      |
| **E7** | Presigned URLs work through the CSP                                             | Upload a file from the browser and confirm no "Network error" in the console. This validates the `connect-src` entry at `security-headers.ts:67`.                                                                                                                                                                     | Medium   |
| **E8** | Collabora (WOPI) still functions                                                | `docker-compose.yml:63-80` serves Collabora on 9980, and WOPI callbacks reach the app at `host.docker.internal:3000` — **unrelated to storage**, but it is the other service in the same compose file, so it is worth confirming the compose edit did not disturb it.                                                 | Low      |

## E2 suggested smoke test (read-only in intent; run only when authorised)

The `storage-init` role already exists for exactly this purpose — it is a one-shot process
(`apps/worker/src/storage-init.ts`) that calls `ensureBucket()` and exits non-zero on failure
(`:8-10`), dispatched by `docker/entrypoint.sh:14-16` and used in
`deploy/dokploy-dev.compose.yaml:112-129`.

Running it against the local stack would validate HeadBucket, CreateBucket, DeleteBucketPolicy,
Get+PutBucketLifecycleConfiguration, and the unsigned privacy probe in one shot. **I have not
run it** — that would modify state (creating a bucket, installing lifecycle rules), which this
audit is not authorised to do.

---

# Summary table

| Class                       | Items                                                                                                                                                                                         | Action required                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **A — completed & correct** | compose image + `mini` command; port `9000:8333`; `AWS_*` credential vars; `S3_BUCKET`                                                                                                        | **None.** Keep as is.                                  |
| **B — must modify**         | `.env` `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (empty)                                                                                                                                    | **Set both.** Only required change.                    |
| **C — unchanged**           | S3 client config; all 18 registered operations; privacy probe; CSP; path-style addressing and its 4 coupled consumers; all 38 call sites; the database layer; deploy config                   | **None.**                                              |
| **D — risks**               | tag-filtered lifecycle execution; `CopyObject` + `TaggingDirective: 'REPLACE'`; `ListParts` pagination; 64 MiB parts; removed healthcheck; 11 stale MinIO doc references; loose privacy probe | Evaluate; D1/D2 are the material ones.                 |
| **E — unverified**          | image digest; `ensureBucket()` end to end; lifecycle execution; copy tagging; list-parts paging; large objects; CSP passthrough; Collabora                                                    | **Run before relying on it.** Nothing here was tested. |

## Net assessment

The migration itself is **well executed**. The operator chose `weed mini` (SeaweedFS's
documented single-node production mode, explicitly endorsed for presigned-URL gateways), mapped
**8333 to host port 9000** so the application's existing `R2_ENDPOINT` keeps working, and reused
the previous MinIO credentials — meaning **no application code change, no database change, and
no credential migration is required**. BeaconHS's deliberately narrow S3 surface (§9.1 of the
[storage audit](./beaconhs-storage-audit.md)) also happens to sit comfortably inside SeaweedFS's
support window.

Two things stand between this and "working":

1. **A one-line configuration fix that predates the migration** — the empty `R2_*` credentials
   defeated by `??` (B1). Without it, nothing works, and it is easy to misattribute to the
   storage change.
2. **Two unverified behaviours that gate correctness** — whether tag-filtered lifecycle rules
   actually execute (D1), and whether `CopyObject` honours `TaggingDirective: 'REPLACE'` (D2).
   The second has a silent data-loss failure mode and deserves a deliberate check.

Running the existing `storage-init` role once (E2) after fixing B1 would validate most of the
"must work" surface in a single step.

---

## Related documents

- [Storage audit](./beaconhs-storage-audit.md) — the subsystem as it exists
- [Architecture audit](./beaconhs-architecture.md) — the wider system
- [Extension points](./beaconhs-extension-points.md) — attaching files from a new module
- [HSE gap analysis](./hse-gap-analysis.md) — what to build
