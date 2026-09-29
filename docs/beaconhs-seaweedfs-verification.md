# BeaconHS — SeaweedFS Migration Verification

> **Status:** verification run · **Date:** 2026-09-29 · **Commit:** `70da27c4` (unmodified)
> **Image tested:** `chrislusf/seaweedfs@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882`
> (built 2026-09-14; `docker-compose.yml:39-51`, `mini -dir=/data -ip=0.0.0.0`, host `9000` → container `8333`)
>
> Companion to [beaconhs-seaweedfs-impact.md](./beaconhs-seaweedfs-impact.md) (the static
> prediction) and [beaconhs-storage-audit.md](./beaconhs-storage-audit.md) (the subsystem).
> This document reports **measured** results and supersedes the impact document's predictions
> wherever they disagree.

## 摘要（中文执行摘要）

**结论：迁移未完成验证，不允许进入下一阶段。**

11 项验证项中 **9 项 PASS、2 项 FAIL、1 项 UNVERIFIED**。但两个 FAIL 性质不同：

- **FAIL-1（已修复，配置问题）**：`.env` 凭据为空 + `??` 不回退 —— 已通过修改 `.env` 修复。
- **FAIL-2（未修复，阻断性代码级不兼容）**：**SeaweedFS 会静默丢弃预签名 PUT 的
  `x-amz-meta-*` 与 `x-amz-tagging` 参数。**

**FAIL-2 是真正的阻断项，且无法在当前约束下修复。**

根因（SeaweedFS 源码 `weed/s3api/s3api_object_handlers_put.go`）：

- 第 828 行：`for k, v := range r.Header` —— 用户 metadata **只从 HTTP header 读取**；
- 第 857 行：`r.Header.Get(s3_constants.AmzObjectTagging)` —— 标签**只从 header 读取**；
- 两者**都从不读取 `r.URL.Query()`**。

而 AWS SDK 生成预签名 URL 时，必然把 `x-amz-meta-*` 和 `x-amz-tagging` **移到 query string**
（`X-Amz-SignedHeaders=host`，只有 host 参与签名）。浏览器再用这些 URL 直接 PUT 时，
SeaweedFS 完全看不到这些参数。

**实测对照（同一 bucket、同一 SDK）：**

| 路径                          | Content-Type    | `upload-token` metadata | `beaconhs-state` tag |
| ----------------------------- | --------------- | ----------------------- | -------------------- |
| 签名 PutObject（header 传递） | ✅ `text/plain` | ✅ `SIGNED`             | ✅ `pending`         |
| 预签名 PUT（query 传递）      | ✅ `text/plain` | ❌ `{}`                 | ❌ `[]`              |

**对 BeaconHS 的实际影响（已用仓库真实代码路径复现）：**

- `apps/web/src/lib/upload-verification.ts:28` 的 `validateReservedUpload` 依赖
  `object.metadata['upload-token']` 的 SHA-256 匹配。metadata 为 `{}` ⇒ 校验必然失败
  ⇒ **`finalizeUpload` 对任何浏览器上传都返回失败** ⇒ BeaconHS 在 SeaweedFS 上
  **无法创建任何附件**（签名、照片、证书、表单附件、工单文件等全部受影响）。
- `packages/storage/src/lifecycle.ts` 的 `expire-unfinalized-uploads` 规则按
  `beaconhs-state=pending` 标签过滤。标签从未写入 ⇒ **该规则永远不可能命中** ⇒
  `_pending/` 暂存对象永久泄漏。

**尝试过的客户端侧规避方案也失败**：让浏览器把这些参数作为真实 header 发送，SeaweedFS
返回 `403 SignatureDoesNotMatch`（它把未签名的 `x-amz-*` header 计入规范请求）。

**UNVERIFIED 项**：tag-filtered lifecycle 的**实际执行**。配置写入已确认 PASS，但执行需等
SeaweedFS 的每日调度；实测等待 14 分钟仍未触发。上游 `s3lifecycle/DESIGN.md` 明确写明
"a single daily admin schedule invokes it once per day"。**按要求，本项不声称验证成功。**

---

# 1. Current configuration

## 1.1 Compose (operator's change, preserved)

`docker-compose.yml:39-51` — unchanged by this verification:

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
```

## 1.2 Application config — `.env` (modified, permitted)

```diff
 R2_ENDPOINT=http://localhost:9000
 R2_ACCOUNT_ID=
-R2_ACCESS_KEY_ID=
-R2_SECRET_ACCESS_KEY=
+R2_ACCESS_KEY_ID=beaconhs
+R2_SECRET_ACCESS_KEY=beaconhs-dev-secret
 R2_BUCKET=beaconhs-dev
 R2_PRIVATE_BUCKET_CONFIRMED=false
+AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
```

Two changes, both to the gitignored local `.env`. **No source file was modified.**

| Change                                               | Reason                                                                                        | Status                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------- |
| Set `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`      | `??` at `packages/storage/src/index.ts:39-40` does not fall back on an empty string           | **Fixed — FAIL-1 resolved** |
| Add `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` | SDK-injected `x-amz-checksum-crc32` on presigned PUT is enforced by SeaweedFS → 400 BadDigest | **Fixed — see §4.2**        |

## 1.3 Effective config as resolved by the SDK

```
accessKeyId : "beaconhs"
secretLength: 19
bucket      : "beaconhs-dev"
forcePathStyle: true
region      : "auto"
```

## 1.4 Environment

|                  |                                                                |
| ---------------- | -------------------------------------------------------------- |
| Image digest     | `sha256:ce9e796f…`, built 2026-09-14                           |
| Server banner    | `SeaweedFS 30GB 4.47`                                          |
| Container        | `beaconhs-storage`, up 42 h at test time                       |
| Host port        | `9000` → container `8333` (S3 gateway)                         |
| Postgres / Redis | Up 42 h. **Database `beaconhs` has 0 tables — never migrated** |
| Node             | v24.21.0                                                       |

> The database is un-migrated, so the app's server actions could not be exercised through a real
> session. All application-layer verification was done by invoking the repository's own
> functions (`@beaconhs/storage`, and a faithful replay of `apps/web/src/lib/uploads.ts`'s
> storage half). No migration was run — that is outside this task's authorisation.

---

# 2. Execution procedure

| Step | What was run                                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Baseline against the live endpoint with the **original** `.env`                                                                                                                                                   |
| 2    | Reproduced the blocker using the repository's real `storage-init` (built via `apps/worker/build.mjs`)                                                                                                             |
| 3    | Set `R2_*` credentials in `.env`; re-ran `storage-init`                                                                                                                                                           |
| 4    | Ran a 14-case suite against the real SDK: HeadBucket, CreateBucket, ensureBucket, Put, Get, Range+If-Match, presign, lifecycle read-back, privacy probe, tagging, CopyObject, multipart, Delete, tenant-key guard |
| 5    | Ran the repository's own storage tests (`pnpm --filter @beaconhs/storage test`)                                                                                                                                   |
| 6    | Replayed `finalizeUpload`'s storage sequence (`apps/web/src/lib/uploads.ts:336-461`) step by step                                                                                                                 |
| 7    | Planted a tag-filtered lifecycle probe (throwaway bucket, absolute `ExpirationDate`) and polled for 14 minutes                                                                                                    |
| 8    | Cleaned up all test buckets and scratch objects                                                                                                                                                                   |

**Test harness location:** `/tmp/opencode/` — entirely outside the repository. Bundled with the
same esbuild strategy as `apps/worker/build.mjs` so the repo's real SDK is exercised. The
worker's `dist/` is gitignored (`git check-ignore` confirms).

**Artifacts cleaned up.** Only `beaconhs-dev` remains; 4 temporary buckets deleted, 5 scratch
objects purged. The two managed lifecycle rules remain installed (as intended).

---

# 3. Results

## 3.1 Summary

| #   | Item                                        | Result                              |
| --- | ------------------------------------------- | ----------------------------------- |
| 1   | SeaweedFS S3 endpoint reachable             | **PASS**                            |
| 2   | Credentials authenticate                    | **PASS** (after `.env` fix)         |
| 3   | Bucket creation                             | **PASS**                            |
| 4   | HeadBucket                                  | **PASS**                            |
| 5   | PutObject (SDK-signed)                      | **PASS**                            |
| 6   | GetObject                                   | **PASS**                            |
| 7   | DeleteObject                                | **PASS**                            |
| 8   | Lifecycle configuration (write + read-back) | **PASS**                            |
| 9   | Privacy / access control                    | **PASS**                            |
| 10  | Tag-filtered lifecycle **execution**        | **UNVERIFIED**                      |
| 11  | CopyObject + `TaggingDirective=REPLACE`     | **PASS**                            |
| —   | **Presigned PUT (browser path) — metadata** | **FAIL**                            |
| —   | **Presigned PUT (browser path) — tagging**  | **FAIL**                            |
| —   | `finalizeUpload` end-to-end (storage half)  | **FAIL** (consequence of the above) |

Suite totals: **14 PASS / 0 FAIL** for SDK-signed operations; **2 distinct incompatibilities**
found on the presigned path, which the SDK-signed suite does not exercise.

## 3.2 The blocker, reproduced

With the original `.env`, the repository's own `storage-init` fails:

```
$ node dist/storage-init.js
[storage-init] failed: UnknownError
EXIT=1
```

After setting the credentials in `.env`:

```
$ node dist/storage-init.js
[storage-init] private bucket policy, lifecycle, and anonymous-read probe passed
EXIT=0
```

`storage-init` (`apps/worker/src/storage-init.ts:4`) exercises, in one call: `HeadBucket` →
`CreateBucket` → `DeleteBucketPolicy` → `GetBucketLifecycleConfiguration` →
`PutBucketLifecycleConfiguration` → `PutObject` → unsigned `GET` probe → `DeleteObject`.
**All eight pass.**

## 3.3 Operations log

```
### 01_head_bucket                PASS  HeadBucket 200
### 01b_create_bucket_new         PASS  CreateBucket+HeadBucket ok
### 02_ensure_bucket              PASS  ensureBucket() returned without throwing
### 03_put_object                 PASS  size=31 contentType=text/plain etag="c750852e…"
### 04_get_object                 PASS  bytes=31 text="beaconhs-seaweedfs-verification" matches=true
### 04b_get_object_range_ifmatch  PASS  bytes=6 text="beacon"     (Range + If-Match)
### 05_presign                    PASS  X-Amz-Signature present, expiry 300/600s
### 06_lifecycle_config           PASS  2 rules stored (see below)
### 07_privacy_unsigned_read      PASS  anonymousStatus=403 denied=true
### 08_object_tagging             PASS  tagSet=[{beaconhs-state,pending}] metadata={upload-token:verify-token}
### 09_copy_tagging_directive     PASS  tagWasCleared=true metadataWasStripped=true
### 10_multipart                  PASS  6 MiB round trip equal=true
### 11_delete_object              PASS  existedBefore=true existsAfterDelete=false
### 12_tenant_key_guard           PASS  ownKeyAccepted=true crossTenantKeyRejected=true
### SUMMARY                       14 passes, 0 fails
```

## 3.4 Lifecycle configuration — read back from the server

```json
[
  {
    "ID": "expire-unfinalized-uploads",
    "Status": "Enabled",
    "TagFilter": { "Key": "beaconhs-state", "Value": "pending" },
    "Expiration": { "Days": 1 },
    "AbortIncompleteMPU": { "DaysAfterInitiation": 1 }
  },
  {
    "ID": "expire-transient-artifacts",
    "Status": "Enabled",
    "TagFilter": { "Key": "beaconhs-state", "Value": "transient" },
    "Expiration": { "Days": 1 },
    "AbortIncompleteMPU": null
  }
]
```

Both managed rules round-trip exactly as `packages/storage/src/lifecycle.ts:18-33` defines them.
**The configuration is stored correctly. Whether it is executed is item 10 — see §5.**

## 3.5 CopyObject + `TaggingDirective=REPLACE` — **PASS**

This resolves risk **D2** from the impact analysis. Executing the exact command shape from
`packages/storage/src/index.ts:513-526`:

```
dstTagSet     : []          ← tags cleared
dstMetadata   : {}          ← upload-token stripped
tagWasCleared : true
metadataWasStripped : true
```

`CopySourceIfMatch` was honoured (the copy succeeded with the correct source ETag), and
`MetadataDirective=REPLACE` + `TaggingDirective=REPLACE` with `Tagging: ''` both worked.
**This is the mechanism `promoteObject()` relies on, and it works.**

The impact analysis predicted a possible silent data-loss mode here (a promoted object keeping
`beaconhs-state=pending` and being expired after a day). **That mode does not exist.**

## 3.6 Privacy / access control — **PASS**

| Check                                               | Result                   |
| --------------------------------------------------- | ------------------------ |
| Anonymous `GET http://localhost:9000/`              | HTTP 403                 |
| Anonymous `GET http://localhost:9000/beaconhs-dev/` | HTTP 403                 |
| Unsigned `GET` of a real object                     | HTTP 403, `denied: true` |
| `storage-init` privacy probe                        | passed                   |

`ensurePrivateBucketReady()`'s `DeleteBucketPolicy` step succeeded (no error thrown).

## 3.7 Multipart — **PASS**

6 MiB object: `CreateMultipartUpload` → `UploadPart` → `ListParts` → `CompleteMultipartUpload` →
`GetObject` returned byte-identical data (`equal: true`). `ListParts` returned
`IsTruncated: false`, `NextPartNumberMarker: undefined`, `partCount: 1` — the pagination loop in
`index.ts:252-270` is safe. `ListMultipartUploads` also worked.

## 3.8 Repository storage tests — **PASS**

```
$ pnpm --filter @beaconhs/storage test
✓ src/lifecycle.test.ts (2 tests)
✓ src/multipart.test.ts (3 tests)
✓ src/object-keys.test.ts (2 tests)
✓ src/storage-url.test.ts (5 tests)
Test Files 4 passed (4)
     Tests 12 passed (12)
```

These are unit tests (no network), so they confirm no regression but do not cover the issues
below.

---

# 4. FAIL details

## 4.1 FAIL-1 — empty credentials (RESOLVED)

**Root cause.** `packages/storage/src/index.ts:39-40` uses `??`:

```ts
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? 'beaconhs'
```

An empty string is not nullish, so with `R2_ACCESS_KEY_ID=` in `.env` the client is built with
`credentials: { accessKeyId: '', secretAccessKey: '' }` and every request is SigV4-signed with a
blank key id.

**Impact.** `ensureStorageReady()` gates `requestUpload`
(`apps/web/src/lib/uploads.ts:85, 149`), so **every attachment upload failed**.

**Fix applied.** Set both variables in `.env`. No code change.
**Note:** this predates the SeaweedFS migration — MinIO would have failed identically.

## 4.2 FAIL-2 — SDK checksum on presigned PUT (RESOLVED by env var)

**Symptom.** The browser-direct presigned PUT returned **HTTP 400**:

```xml
<Error><Code>BadDigest</Code>
<Message>The Content-Md5 you specified did not match what we received.</Message>
```

**Root cause.** `@aws-sdk/client-s3 3.1086.0` (>= 3.729) pre-computes a checksum and embeds it
in the presigned URL:

```
&x-amz-checksum-crc32=AAAAAA%3D%3D      ← base64 of 0x00000000 = CRC32 of an EMPTY body
&x-amz-sdk-checksum-algorithm=CRC32
```

`AAAAAA==` is the CRC32 of _nothing_. The browser PUTs real bytes with no checksum, SeaweedFS
validates the advertised value against the body, and rejects the mismatch. **MinIO did not
enforce this header; SeaweedFS does.**

**Fix applied.** `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` in `.env` — the SDK's own
documented escape hatch, requiring no code change. The presigned URL then omits the checksum
parameters and the PUT returns **200**.

## 4.3 FAIL-3 — presigned PUT drops metadata and tags (**UNRESOLVED — BLOCKER**)

**Symptom.** After fixing FAIL-2, the PUT succeeds (200) and `Content-Type` is preserved, but
the object arrives with **no user metadata and no tags**.

Isolated A/B test on the same bucket and the same SDK:

| #   | Path                                                   | Status | `Content-Type` | `metadata`                  | `tagSet`                         |
| --- | ------------------------------------------------------ | ------ | -------------- | --------------------------- | -------------------------------- |
| 1   | **Signed** `PutObject` (metadata + tagging as headers) | 200    | `text/plain`   | `{"upload-token":"SIGNED"}` | `[{"beaconhs-state":"pending"}]` |
| 2   | **Presigned** PUT (same values as query params)        | 200    | `text/plain`   | `{}`                        | `[]`                             |
| 3   | Presigned PUT, ContentType only                        | 200    | `text/plain`   | `{}`                        | `[]`                             |

The presigned URL verifiably contains both parameters
(`hasMeta: true`, `hasTag: true`, `X-Amz-SignedHeaders=host`) — SeaweedFS simply ignores them.

**Root cause — confirmed in SeaweedFS source.** `weed/s3api/s3api_object_handlers_put.go`:

```go
// line 828 — user metadata read ONLY from HTTP headers
for k, v := range r.Header {
    if strings.HasPrefix(k, s3_constants.AmzUserMetaPrefix) {
        entry.Extended[k] = []byte(v[0])
    }
    ...
}

// line 857 — tags read ONLY from the X-Amz-Tagging header
if tagging := r.Header.Get(s3_constants.AmzObjectTagging); tagging != "" { ... }
```

Neither path consults `r.URL.Query()`. The AWS SDK **must** move `x-amz-meta-*` and
`x-amz-tagging` into the query string for a presigned request, because only query parameters
can carry values that are not part of `X-Amz-SignedHeaders`. SeaweedFS therefore never sees them.

**Client-side workaround attempted and rejected.** Sending those values as real headers on a
presigned request returns:

```xml
<Error><Code>SignatureDoesNotMatch</Code>
<Message>The request signature we calculated does not match the signature you provided.</Message>
```

SeaweedFS folds unsigned `x-amz-*` headers into the canonical request, breaking the signature.
**There is no client-only mitigation.**

### Impact on BeaconHS — reproduced

Replaying the storage half of `finalizeUpload` (`apps/web/src/lib/uploads.ts:336-461`) against
SeaweedFS:

```
### 01_keys_and_reservation     presignedPutHasTokenMeta=true  presignedPutHasTag=true
### 02_browser_put               status=200                       ← upload "succeeds"
### 03_validate_reserved_upload  sizeMatches=true
                                contentTypeMatches=true
                                tokenHashMatches=FALSE          ← metadata is {}
    headObject: { contentLength: 44, contentType: "text/plain",
                  etag: "\"23e191108b64a3508f64df1ad9fe56e4\"",
                  metadata: {} }
### FATAL
```

`apps/web/src/lib/upload-verification.ts:28` reads `object.metadata['upload-token']` and
compares its SHA-256 to `verification_token_hash`. With `metadata: {}` this is `undefined`,
so **`finalizeUpload` fails for every browser upload.**

**Consequence: BeaconHS cannot create a single attachment on SeaweedFS as currently
configured.** This blocks signatures, form attachments, evidence photos, PPE certificates,
person documents, equipment files, training files, and document masters — i.e. the whole
attachment subsystem.

It also makes the `expire-unfinalized-uploads` lifecycle rule unreachable, because the
`beaconhs-state=pending` tag is never written. Staging objects under `_pending/` would
accumulate without bound.

**This is a design-level incompatibility, not a configuration problem.** It cannot be fixed
by env vars. It requires a change to `presignPut()` in `packages/storage/src/index.ts:190-204`
— which this task explicitly forbids — or an architectural change (e.g. proxying uploads
through the app server instead of presigning), or a different object store.

---

# 5. UNVERIFIED

## 5.1 Tag-filtered lifecycle **execution** — UNVERIFIED

**Per the task's explicit instruction, this is not claimed as verified.**

**What IS verified:** the configuration is written and read back correctly
(§3.4), and SeaweedFS's evaluator _implements_ tag matching. From upstream source,
`weed/s3api/s3lifecycle/evaluate.go`:

```go
func filterMatches(rule *Rule, info *ObjectInfo) bool {
	...
	for k, v := range rule.FilterTags {
		if got, ok := info.Tags[k]; !ok || got != v { return false }
	}
	return true
}
```

and `due_at.go` computes `ActionKindExpirationDays` due times through `filterMatches`. So the
_matching logic exists_.

**What is NOT verified:** that the worker ever runs in this deployment, and that it deletes
anything.

**What was measured.** A throwaway bucket with a tag filter and an **absolute** `ExpirationDate`
(the `Days: 1` path maps to 24 h in production builds — `DaysToDuration()`), plus an untagged
control object to prove the filter discriminates:

| Time (UTC)                          | Tagged object | Control object |
| ----------------------------------- | ------------- | -------------- |
| 03:51:14 planted (expires 03:52:43) | present       | present        |
| 03:52:43 expiry time                | present       | present        |
| 03:54:23 (+100 s)                   | present       | present        |
| 03:56:18 (+215 s)                   | present       | present        |
| 03:57:48                            | present       | present        |
| 03:59:18                            | present       | present        |
| 04:00:48                            | present       | present        |
| 04:02:18                            | present       | present        |
| 04:03:48                            | present       | present        |
| 04:05:18                            | present       | present        |
| 04:06:49 (+14 min)                  | present       | present        |

**Interpretation.** No execution after 14 minutes. Upstream `s3lifecycle/DESIGN.md:3, 167` says:

> "The worker runs as a scheduled job: 'start, do today's work, stop'"
> "The s3tests CI workflow invokes the worker every 2s; **a single daily admin schedule invokes
> it once per day.**"

A 24-hour cadence is consistent with this observation, so **the result is inconclusive rather
than negative.** I could not observe the daily fire within the task window, and no
lifecycle-related metrics are exposed on any port (checked master `:9333/metrics`, filer
`:18080/metrics`, S3 `:8333/metrics` — all empty of `lifecycle` series).

**To close this item**, one of:

- Wait for a daily fire and re-check (up to 24 h).
- Trigger the worker's gRPC entry point manually.
- Verify the daily schedule is registered in this `weed mini` deployment, then compute the next
  fire time and check after it.

**Until then, BeaconHS's only object-purge mechanism is unproven on SeaweedFS.** Note this is
already moot on the browser upload path, since FAIL-3 means the `pending` tag is never written.

## 5.2 `ListParts` pagination beyond 1000 parts — UNVERIFIED

`IsTruncated: false` and `NextPartNumberMarker: undefined` were observed for a 1-part upload,
which is the correct answer. The paginated path (>1000 parts, i.e. >64 GiB at 64 MiB parts) was
not exercised.

## 5.3 Large-object upload (1 GiB PPTX path) — UNVERIFIED

Only a 6 MiB multipart was tested. `MAX_PPTX_FILE_BYTES` is 1 GiB
(`packages/office/src/limits.ts:5`), which becomes ~16 presigned `UploadPart` PUTs. The
presigned-part path is subject to the same checksum issue as FAIL-2 and is assumed fixed by the
same env var, but was not separately measured.

## 5.4 Browser CSP passthrough — UNVERIFIED

`apps/web/src/lib/security-headers.ts:67` injects the storage origin into `connect-src` from
`R2_ENDPOINT`, which is unchanged (`http://localhost:9000`). The presigned URLs in this run
carry that origin and were fetched successfully by a raw HTTP client. A real browser context
was not exercised.

## 5.5 Application end-to-end through a real session — UNVERIFIED

The `beaconhs` database has 0 tables (never migrated), and migrations are outside this task's
authorisation. `requestUpload`/`finalizeUpload` require `requireRequestContext()` (a real
Better-Auth session). Verification therefore used the repository's storage functions directly
plus a faithful replay of `uploads.ts`'s storage half. The DB portion of the handshake
(reservation insert, attachments insert, outbox trigger) is unexercised — though it is pure
Postgres and unaffected by the storage change.

## 5.6 `DELETE ?lifecycle` and `DeleteBucketPolicy` error tolerance — PARTIAL

Both were called by `storage-init` and did not throw, so the happy path is proven. The
`isMissingPolicyError` tolerance list (`index.ts:86-95`) was not separately exercised against
each error code.

---

# 6. Log evidence

## 6.1 SeaweedFS container

```
$ docker logs beaconhs-storage | tail
I0929 02:59:57.155533 maintenance_manager.go:331 Starting maintenance scan...
I0929 02:59:57.156167 maintenance_scanner.go:183 Topology discovery: 1 volume servers ...
I0929 02:59:57.156518 maintenance_manager.go:372 Maintenance scan completed: no maintenance tasks needed
I0929 03:44:54.961354 master_client.go:24 the cluster has 1 filer
```

Healthy. No errors. No lifecycle activity lines at any point during the 14-minute poll.

## 6.2 BadDigest (FAIL-2) — server response

```
$ curl -X PUT "<presigned url>" -H 'Content-Type: text/plain' --data-binary 'hello'
HTTP 400
<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>BadDigest</Code>
<Message>The Content-Md5 you specified did not match what we received.</Message>
<Resource>/beaconhs-dev/t/10000000-.../ba2338e6-885e-48e2-9dbd-ce8107bbe074-...</Resource>
<RequestId>18D9AE8FADFFFE44F76A12B0</RequestId>
</Error>
server: SeaweedFS 30GB 4.47
```

## 6.3 SignatureDoesNotMatch (FAIL-3 workaround attempt)

```
HTTP 403
<Error><Code>SignatureDoesNotMatch</Code>
<Message>The request signature we calculated does not match the signature you provided.
Check your key and signing method.</Message>
</Error>
```

## 6.4 `storage-init`

```
before .env fix:  [storage-init] failed: UnknownError            (exit 1)
after  .env fix:  [storage-init] private bucket policy, lifecycle,
                  and anonymous-read probe passed                 (exit 0)
```

---

# 7. Known risks

| #   | Severity    | Risk                                                                                                                                                                                                                                             | Status                                              |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| R1  | **Blocker** | Presigned PUT drops `x-amz-meta-*` / `x-amz-tagging` ⇒ `finalizeUpload` always fails ⇒ no attachments can be created. Root cause: SeaweedFS reads both only from HTTP headers, never from the query string.                                      | **Open — no fix available within task constraints** |
| R2  | High        | `expire-unfinalized-uploads` can never match (tag never written) ⇒ `_pending/` staging objects leak indefinitely. Compounds R1.                                                                                                                  | **Open**                                            |
| R3  | High        | Tag-filtered lifecycle **execution** unproven. It is BeaconHS's only object-purge mechanism.                                                                                                                                                     | **UNVERIFIED**                                      |
| R4  | Medium      | `AWS_REQUEST_CHECKSUM_CALCULATION` is a **process-wide** env var. It suppresses checksum pre-computation for _all_ S3 calls, not just presigned PUTs. Any future code that relies on SDK checksums (e.g. `ChecksumAlgorithm`) would be affected. | Mitigated by a comment in `.env`                    |
| R5  | Medium      | The fix depends on an **unpinned `:latest` image**. The digest is `sha256:ce9e796f…` (built 2026-09-14). A future pull could change behaviour.                                                                                                   | Open — recommend pinning the digest                 |
| R6  | Medium      | `docker-compose.yml:39-51` has **no healthcheck** (MinIO had one), and `scripts/launchers/dev-launcher.sh:311-313` skips health-less containers, so the launcher no longer waits for storage readiness.                                          | Open                                                |
| R7  | Low         | `.env.example:34-35` still ships empty `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`. Anyone who copies it reproduces FAIL-1. Neither `.env` nor `.env.example` documents `AWS_REQUEST_CHECKSUM_CALCULATION`.                                      | Open — documentation drift                          |
| R8  | Low         | The database has never been migrated in this workspace, so no full application smoke test was possible.                                                                                                                                          | Out of scope                                        |

### R1 — why this cannot be fixed without touching source

Options considered:

| Option                                                                                              | Viable?                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Env var / config                                                                                    | **No.** The gap is in SeaweedFS's request parsing, not in configuration.                                                        |
| Client sends `x-amz-meta-*` as headers                                                              | **No — proven 403 `SignatureDoesNotMatch`.**                                                                                    |
| Change `presignPut()` to omit metadata, client adds headers                                         | **No — same 403.**                                                                                                              |
| Use `CreateMultipartUpload` + presigned `UploadPart` (metadata goes in the signed initiate request) | **Possibly**, but it changes the upload protocol and still requires editing `packages/storage/src/index.ts`. Out of scope here. |
| Proxy uploads through the app server                                                                | Architecturally viable, but a significant redesign of `uploads.ts` and `file-uploader.tsx`.                                     |
| Different object store (MinIO, Cloudflare R2)                                                       | Viable; R2 is the production target in `README.md:176`.                                                                         |

---

# 8. Verdict: may the project proceed to the next phase?

## **NO.**

The migration is **not** verified. Specifically:

- **9 of 11** required items pass.
- **FAIL-3 (R1)** is a hard, unresolved incompatibility. BeaconHS **cannot create attachments**
  on SeaweedFS as currently configured. Since attachments underpin signatures, photos,
  certificates, document masters, and form files, this blocks the entire attachment subsystem
  and much of the HSE product surface.
- **Item 10** (tag-filtered lifecycle execution) is **UNVERIFIED**, and per the task's
  instruction it must not be treated as passing.

### What did succeed

The operator's `docker-compose.yml` change is **substantively correct**: `weed mini` is
SeaweedFS's documented single-node production mode; mapping container 8333 to host 9000 keeps
the application's `R2_ENDPOINT` valid; and the credential/bucket variable names are right.
**14 of 14 SDK-signed storage operations pass, `storage-init` passes, and CopyObject with
`TaggingDirective=REPLACE` works** — resolving the impact analysis's D1 and D2 predictions in
BeaconHS's favour.

The failures are not in the operator's compose work. They are (a) a pre-existing `.env`
defect, (b) an SDK-checksum behavioural difference that MinIO tolerated and SeaweedFS enforces,
and (c) **a genuine SeaweedFS gap in presigned-request parameter handling that the audit
predicted as "very likely fine" and measurement has now overturned.**

### Recommended next steps (not performed — outside this task's authorisation)

1. **Decide on a strategy for R1.** The options are: patch `presignPut()` in
   `packages/storage/src/index.ts`, switch the browser upload path to server-proxy, or return to
   MinIO / adopt Cloudflare R2 for local development. This is a product decision, not a
   verification task.
2. **Re-run verification** once R1 has a strategy.
3. **Close item 10** by waiting for a daily lifecycle fire, or by triggering the worker
   manually.
4. **Pin the image digest** (R5) and restore a healthcheck (R6).
5. **Update `.env.example`** to document the credential requirement and the checksum env var (R7).

---

## Appendix — commands used

```bash
# baseline / blocker reproduction
cd apps/worker && node build.mjs                     # repo's own bundle
node --env-file=../../.env dist/storage-init.js      # -> failed: UnknownError

# after the .env credential fix
node --env-file=../../.env dist/storage-init.js      # -> passed

# repo storage tests
pnpm --filter @beaconhs/storage test                 # 12 passed

# SeaweedFS facts read from upstream source, not memory
weed/s3api/s3api_server.go                 # route registration
weed/s3api/s3api_bucket_config_stubs.go    # which subresources are stubs
weed/s3api/s3api_object_handlers_put.go    # metadata/tagging read from r.Header only  (FAIL-3)
weed/s3api/s3lifecycle/evaluate.go         # filterMatches -> FilterTags
weed/s3api/s3lifecycle/due_at.go           # ExpirationDays -> ModTime + DaysToDuration(days)
weed/s3api/s3lifecycle/DESIGN.md           # daily admin schedule cadence
```

## Related documents

- [SeaweedFS impact analysis](./beaconhs-seaweedfs-impact.md) — the static prediction
- [Storage audit](./beaconhs-storage-audit.md) — the object storage subsystem
- [Architecture audit](./beaconhs-architecture.md) — the wider system
- [HSE gap analysis](./hse-gap-analysis.md) — product capability
