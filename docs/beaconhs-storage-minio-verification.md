# BeaconHS — Storage / MinIO Verification

> **Status:** verification complete · **Date:** 2026-09-29 · **HEAD:** `70da27c4` (unmodified)
> Build provenance: [beaconhs-minio-build.md](./beaconhs-minio-build.md)
> Baseline that motivated this: [beaconhs-official-deployment-baseline.md](./beaconhs-official-deployment-baseline.md)
>
> **Verdict: STORAGE BASELINE VERIFIED** — 25/25 acceptance conditions met.

## 摘要（中文执行摘要）

**从 MinIO 归档源码本地构建的镜像完全兼容 BeaconHS 的对象存储协议，
25 项验收条件全部通过。**

关键对比：此前 SeaweedFS 失败的两个关键点，在 MinIO 上**全部正常**：

| 关键字段                                | SeaweedFS（失败） | MinIO（本次）             |
| --------------------------------------- | ----------------- | ------------------------- |
| 预签名 PUT 返回码                       | 400 `BadDigest`   | **200**                   |
| `upload-token` metadata                 | ❌ 静默丢失       | ✅ **保留**               |
| `beaconhs-state` tag                    | ❌ 静默丢失       | ✅ **写入 `pending`**     |
| `CopyObject` `TaggingDirective=REPLACE` | 未验证            | ✅ **pending 标签被清除** |

**三层验证全部 PASS：**

1. SDK 层 —— presignPut / raw HTTP PUT / headObject / promoteObject / presignGet / delete
2. 业务层 —— 真实 server action `requestUpload()` + `finalizeUpload()`，**写入真实 `attachments` 行**
3. 浏览器层 —— 真实 HTTP 路由 `/api/attachments/[id]?cap=…` → 307 → 预签名 GET → 内容一致

**另外发现 1 个 BeaconHS 既有缺陷（与对象存储无关，但影响 dev 部署）：**
`turbo.json` 的 `globalEnv` 缺少 `R2_ENDPOINT` 和 `ATTACHMENT_CAPABILITY_SECRET`，
Turbo 严格环境过滤会把它们从 `pnpm dev` 的子进程环境中剥离，导致 dev 模式下存储客户端
回退到 Cloudflare R2 生产端点。**未修改**（属于 BeaconHS 配置），仅报告。

---

# A–M. Verification results

## A. MinIO source version — **PASS**

| Field        | Value                                                 |
| ------------ | ----------------------------------------------------- |
| Repository   | `https://github.com/minio/minio`                      |
| Archived     | `true`                                                |
| Fixed commit | `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`            |
| Tag          | `RELEASE.2025-10-15T17-29-55Z` (Security/CVE release) |
| License      | AGPL-3.0                                              |
| Working tree | clean, zero local modifications                       |

`master` head was **not** used. See [build record §1.2](./beaconhs-minio-build.md#12-why-9e49d5e7a648-was-pinned).

## B. Commit SHA — **PASS**

`git rev-parse HEAD` → `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`, matches the pinned SHA.
Tag ref resolves to the same commit object.

## C. Image ID / digest — **PASS**

```
Id          : sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c
RepoTags    : ['minio/minio:latest']
RepoDigests : ['minio/minio@sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c']
Created     : 2026-09-29T15:41:05.619886824+08:00
Size        : 268771790 bytes
Arch/OS     : amd64 / linux
```

**This is a locally built image, not a Docker Hub release.** The upstream `minio/minio` Docker
Hub repository was deleted on 2026-09-11.

## D. BeaconHS Compose — **PASS (unmodified)**

```bash
$ git show HEAD:docker-compose.yml > /tmp/head.yml
$ cmp -s docker-compose.yml /tmp/head.yml   -> identical
$ git diff --quiet HEAD -- docker-compose.yml -> exit 0
```

`docker compose --profile local-db config` resolves all five services and three volumes with
`minio/minio:latest`, no edits.

| Service              | Image                    | Profile    | Status      |
| -------------------- | ------------------------ | ---------- | ----------- |
| `beaconhs-postgres`  | `postgres:16-alpine`     | `local-db` | **healthy** |
| `beaconhs-redis`     | `redis:7-alpine`         | default    | **healthy** |
| `beaconhs-minio`     | `minio/minio:latest`     | default    | **healthy** |
| `beaconhs-mailpit`   | `axllent/mailpit:latest` | default    | **healthy** |
| `beaconhs-collabora` | `collabora/code:latest`  | default    | **healthy** |

## E. `R2_*` configuration — **PASS**

| Variable                      | Value                   | Source                                |
| ----------------------------- | ----------------------- | ------------------------------------- |
| `R2_ENDPOINT`                 | `http://localhost:9000` | `.env` (official default)             |
| `R2_BUCKET`                   | `beaconhs-dev`          | `.env` (official default)             |
| `R2_ACCESS_KEY_ID`            | `beaconhs`              | matches compose `MINIO_ROOT_USER`     |
| `R2_SECRET_ACCESS_KEY`        | `beaconhs-dev-secret`   | matches compose `MINIO_ROOT_PASSWORD` |
| `R2_ACCOUNT_ID`               | _(empty)_               | empty ⇒ not Cloudflare R2             |
| `R2_PRIVATE_BUCKET_CONFIRMED` | `false`                 | not R2, so not required               |

`AWS_REQUEST_CHECKSUM_CALCULATION` is **absent** — the SeaweedFS-only workaround was removed and
is not needed: MinIO does not enforce the SDK's pre-computed `x-amz-checksum-crc32`.
`.env` key set matches `.env.example` exactly (29/29, 0 extra, 0 missing).

## F. Bucket — **PASS**

`ensureBucket()` (BeaconHS's own function) completed:

```
[storage-init] private bucket policy, lifecycle, and anonymous-read probe passed   (exit 0)
```

| Step                              | Result                              |
| --------------------------------- | ----------------------------------- |
| `HeadBucket`                      | 200                                 |
| Bucket exists / created           | `beaconhs-dev`                      |
| `DeleteBucketPolicy`              | accepted                            |
| `GetBucketLifecycleConfiguration` | 2 rules read back                   |
| `PutBucketLifecycleConfiguration` | accepted                            |
| Unsigned read probe               | **denied** (privacy baseline holds) |

Lifecycle rules installed by BeaconHS, read back from MinIO:

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
    "Expiration": { "Days": 1 }
  }
]
```

## G. Presigned PUT — **PASS** (raw HTTP, not SDK PutObject)

Generated by BeaconHS's own `presignPut()` (`packages/storage/src/index.ts:190-204`) and
consumed by a **raw `fetch(..., {method:'PUT'})`**, exactly as
`packages/ui/src/file-uploader.tsx:92-110` does in the browser.

```
01_presigned_put_url_generated   URL carries X-Amz-Signature + X-Amz-Credential, expiresIn=300s
02_raw_http_put_to_presigned_url fetch(PUT) -> HTTP 200
```

**This is the control the SeaweedFS run failed** (400 `BadDigest`). MinIO returns 200 with the
SDK's default checksum behaviour intact — no `AWS_REQUEST_CHECKSUM_CALCULATION` needed.

## H. Metadata (`upload-token`) — **PASS** ✅ _the critical field_

```
headObject(staging).metadata = {"upload-token":"UP4UnI50wnqa9mOcQHdRweWuD84r54Ufwhz8O6C7zK0"}
upload-token present = true
sha256(upload-token) matches attachment_upload_reservations.verification_token_hash = true
```

MinIO **preserves `x-amz-meta-*` on a presigned PUT** (where the value travels in the query
string). SeaweedFS read metadata only from HTTP headers and dropped it.

## I. Tags (`beaconhs-state`) — **PASS** ✅ _the critical field_

```
GetObjectTagging(staging) = [{"Key":"beaconhs-state","Value":"pending"}]
beaconhs-state = pending   (expected "pending")
```

MinIO applies `x-amz-tagging` from a presigned PUT. SeaweedFS ignored it.

And the counterpart — `promoteObject()` (`CopyObject` + `TaggingDirective: 'REPLACE'`) clears it:

```
promoted object tags = []      (pending tag must be cleared -> PASS)
```

## J. `finalizeUpload` — **PASS** (real server action)

Executed `requestUpload()` and `finalizeUpload()` from `apps/web/src/lib/uploads.ts` verbatim.
Only the auth gate (`requireRequestContext`) was stubbed, with a context built from the real
seeded super-admin + demo-tenant rows. **No BeaconHS file was modified.**

| Check                                              | Result                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `requestUpload()`                                  | mode=single; presigned PUT URL issued                                   |
| `attachment_upload_reservations` row               | written; `staging_key`, `r2_key`, `verification_token_hash` all present |
| magic-byte `getObjectRange(0..511, If-Match)`      | returned `"BeaconHS storage E2E v"`                                     |
| `validateReservedUpload`                           | sizeMatches=true, contentTypeMatches=true, token hash matches           |
| `promoteObject()` (CopyObject + CopySourceIfMatch) | succeeded                                                               |
| re-verify promoted object                          | length, contentType, disposition all match                              |
| `finalizeUpload()`                                 | **ok**                                                                  |
| staging object deleted post-commit                 | gone                                                                    |
| reservation consumed                               | `consumedAt` set, `attachmentId` linked                                 |

## K. Attachment record — **PASS** (real database row)

```
attachments: id=b6b5ad97-e940-4045-bd19-9dc8fd18ad4a
             kind=document
             r2_key=t/85df8265-…/document/f65fab80-…-beaconhs-real-attachment.txt
             size_bytes=44
             content_type=text/plain
             tenant_id=85df8265-e62d-43ac-9455-e80a2a81efc9
             uploaded_by=44bc0cf1-69ae-4ed4-9779-97768d4a6bd4
```

Row written by BeaconHS's own SQL under `FORCE ROW LEVEL SECURITY`, scoped to the real tenant.

## L. Download / Presigned GET — **PASS** (two independent paths)

**Path 1 — storage layer:**

```
presignGet(60s) -> GET HTTP 200; bytes=44; contentMatchesUpload=true
```

**Path 2 — the real browser route** `apps/web/src/app/api/attachments/[id]/route.ts`:

| Check                                                 | Result                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/attachments/[id]?cap=…` with a real session | **HTTP 307**                                                           |
| `Location`                                            | `http://localhost:9000/beaconhs-dev/t/<tenant>/document/…` ← **MinIO** |
| `Cache-Control`                                       | `private, no-store`                                                    |
| Follow the presigned GET                              | **HTTP 200**, 40 bytes, **content matches upload**                     |
| Bad capability                                        | **404** (capability enforced)                                          |
| No session                                            | **401** (session enforced)                                             |

## M. Delete — **PASS**

| Check                                    | Result        |
| ---------------------------------------- | ------------- |
| `deleteObject(stagingKey)`               | gone          |
| `deleteObject(r2Key)`                    | gone          |
| `ListObjectsV2(beaconhs-dev)` after both | **0 objects** |

---

# N. Acceptance checklist

| #   | Condition                    | Result                                                            |
| --- | ---------------------------- | ----------------------------------------------------------------- |
| 1   | MinIO local build succeeded  | **PASS** — `minio/minio:latest` built from source                 |
| 2   | Source commit fixed          | **PASS** — `9e49d5e7a648…` (= tag `RELEASE.2025-10-15T17-29-55Z`) |
| 3   | Image fixed                  | **PASS** — `sha256:b187417eee0a…`                                 |
| 4   | Compose unmodified           | **PASS** — byte-identical to `git show HEAD:docker-compose.yml`   |
| 5   | Storage package unmodified   | **PASS** — `git diff -- packages/storage/` empty                  |
| 6   | PostgreSQL                   | **PASS** — 16.15, healthy, 202 tables, 187 FORCE-RLS              |
| 7   | Redis                        | **PASS** — healthy, `PONG`                                        |
| 8   | Mailpit                      | **PASS** — healthy; delivered real magic links                    |
| 9   | Collabora                    | **PASS** — healthy, HTTP 200 on 9980                              |
| 10  | migration                    | **PASS** — 41 applied, RLS + grants + 10 views                    |
| 11  | seed                         | **PASS** — demo tenant + super-admin present                      |
| 12  | MinIO                        | **PASS** — healthy, console 9001 → 200, health → 200              |
| 13  | Presigned PUT                | **PASS** — raw HTTP PUT → 200                                     |
| 14  | Metadata                     | **PASS** — `upload-token` preserved                               |
| 15  | Tags                         | **PASS** — `beaconhs-state=pending` applied                       |
| 16  | `upload-token`               | **PASS** — present, hash matches reservation                      |
| 17  | `beaconhs-state`             | **PASS** — present on staging, cleared on promote                 |
| 18  | `finalizeUpload`             | **PASS** — real server action succeeded                           |
| 19  | Attachment                   | **PASS** — real `attachments` row under RLS                       |
| 20  | Presigned GET                | **PASS** — 307 → MinIO → 200                                      |
| 21  | Download                     | **PASS** — content byte-identical to upload                       |
| 22  | Delete                       | **PASS** — bucket empty afterwards                                |
| 23  | No SeaweedFS                 | **PASS** — no container, image, or volume                         |
| 24  | No third-party MinIO image   | **PASS** — only Go toolchain + pinned static curl                 |
| 25  | No unapproved source changes | **PASS** — only `apps/web/next-env.d.ts` (Next codegen)           |

---

# STORAGE BASELINE VERIFIED

All 25 acceptance conditions are met. The official BeaconHS Compose runs **unmodified** against
a locally built MinIO, and the complete attachment lifecycle — presigned PUT → validation →
promote → attachment row → presigned GET → delete — passes through BeaconHS's own code.

---

# O. Additional finding — pre-existing `turbo.json` defect

Found while verifying the browser route. **Not caused by the MinIO build. Not fixed.**

## O.1 Symptom

Under the official `pnpm dev`, the app's capability download route returned a 307 whose
`Location` was:

```
https://.r2.cloudflarestorage.com/beaconhs-dev/t/<tenant>/document/…
```

That is the **Cloudflare R2 production endpoint with an empty account ID** — not local MinIO.
Attachment capabilities minted by a process reading `.env` also failed validation against the
dev server.

## O.2 Root cause

`turbo.json` `globalEnv` (lines 4-26) lists the storage variables **except two**:

| Variable                                                                 | In `globalEnv`? | Present in dev child process? |
| ------------------------------------------------------------------------ | --------------- | ----------------------------- |
| `R2_ACCOUNT_ID`                                                          | yes             | yes                           |
| `R2_ACCESS_KEY_ID`                                                       | yes             | yes                           |
| `R2_SECRET_ACCESS_KEY`                                                   | yes             | yes                           |
| `R2_BUCKET`                                                              | yes             | yes                           |
| `R2_PRIVATE_BUCKET_CONFIRMED`                                            | yes             | yes                           |
| **`R2_ENDPOINT`**                                                        | **NO**          | **absent**                    |
| **`ATTACHMENT_CAPABILITY_SECRET`**                                       | **NO**          | **absent**                    |
| `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `APP_URL`, `NODE_ENV` | yes             | yes                           |

The correlation is exact: every variable Turbo is told about arrives; every variable it is not
told about is stripped. With `R2_ENDPOINT` missing and `R2_ACCOUNT_ID=''`,
`packages/storage/src/index.ts:44-48` falls through to
`https://${accountId}.r2.cloudflarestorage.com` → `https://.r2.cloudflarestorage.com`.

## O.3 Impact

- Under `pnpm dev`, the storage client targets Cloudflare R2 instead of local MinIO, so
  presigned URLs and the capability HMAC are computed against the wrong secret/endpoint.
- This is **independent of which S3 backend is deployed** — it would equally break the official
  MinIO setup and production R2. It is a dev-tooling defect, not a storage-protocol defect.
- It was flagged as item **R4/low** in the original storage audit
  ([beaconhs-storage-audit.md](./beaconhs-storage-audit.md#risks--open-questions)); this run
  demonstrates it has a concrete, reproducible consequence.

## O.4 Workaround used for verification (no file changed)

Turbo's env filter was relaxed with a **CLI flag only**:

```bash
pnpm exec turbo run dev --parallel --env-mode=loose
```

With the flag, `next-server` receives `R2_ENDPOINT=http://localhost:9000` and
`ATTACHMENT_CAPABILITY_SECRET`, and the browser-route test passes end to end. `turbo.json` was
**not** modified — a permanent fix would add both variables to `globalEnv`, which is a BeaconHS
source change and therefore out of scope for this task.

---

# P. Limitations and honest notes

| #   | Note                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The MinIO image is a **local build**, not an official Docker Hub release. See the provenance statement in [beaconhs-minio-build.md](./beaconhs-minio-build.md).                                                                                                                                                                                                                                      |
| 2   | `minio --version` reports `DEVELOPMENT.GOGET` instead of the release string, because `git describe` does not resolve inside the build container. Cosmetic; provenance is in the image labels and recorded in the build doc.                                                                                                                                                                          |
| 3   | The image **will never receive upstream security fixes** — MinIO is archived and publishes nothing further. Acceptable for local dev; not for production.                                                                                                                                                                                                                                            |
| 4   | The business-path E2E stubbed **only** the auth gate (`requireRequestContext`), supplying a context built from the real seeded super-admin + demo tenant. All upload SQL and storage calls were BeaconHS's real code. The browser-path E2E used a **genuine** magic-link session over real HTTP.                                                                                                     |
| 5   | Tag-filtered lifecycle **execution** remains **UNVERIFIED**, as it was under SeaweedFS: the rules are stored and read back correctly, but MinIO's expiry worker is driven by a schedule that did not fire within the test window. Note this is now _unreachable in practice anyway_ if uploads never carry the tag — which they do, so the rule is meaningful; only its timed execution is unproven. |
| 6   | `POST /api/v1` returns HTTP 500 (`No public API read permission mapped for entity category "compliance"`). Pre-existing upstream bug in an unmodified file. Not fixed.                                                                                                                                                                                                                               |
| 7   | The host has 3.39 GB RAM; Next dev was OOM-killed once when compiling several pages sequentially. Requested individually, all pages return 200. Host capacity, not an application defect.                                                                                                                                                                                                            |
| 8   | The app must be run with `--env-mode=loose` (or `turbo.json` fixed) for the web/worker process to see `R2_ENDPOINT`. Otherwise storage points at R2. See §O.                                                                                                                                                                                                                                         |

---

# Q. Final git state

```
$ git status --short
 M apps/web/next-env.d.ts
?? docker-compose.yml.bak
?? docker-compose.yml.pre-cleanup-backup
?? docs/beaconhs-architecture.md
?? docs/beaconhs-capability-matrix.md
?? docs/beaconhs-cleanup-execution.md
?? docs/beaconhs-cleanup-inventory.md
?? docs/beaconhs-extension-points.md
?? docs/beaconhs-minio-build.md
?? docs/beaconhs-official-deployment-baseline.md
?? docs/beaconhs-seaweedfs-impact.md
?? docs/beaconhs-seaweedfs-verification.md
?? docs/beaconhs-storage-audit.md
?? docs/beaconhs-storage-minio-verification.md
?? docs/hse-gap-analysis.md
```

| Check                                                               | Result                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml` vs `git show HEAD:docker-compose.yml`          | **identical**                                                                                                  |
| `git diff -- packages/storage/`                                     | **empty**                                                                                                      |
| `turbo.json`, `package.json`, `pnpm-workspace.yaml`, `.env.example` | **unmodified**                                                                                                 |
| `docker-compose.yml` modified?                                      | **NO** — not in the diff at all                                                                                |
| Only tracked modification                                           | `apps/web/next-env.d.ts` — Next.js generated (file states "should not be edited", listed in `.prettierignore`) |
| Audit documents (7)                                                 | **intact, unmodified**                                                                                         |

---

# R. Environment left running

| Resource              | State                                                |
| --------------------- | ---------------------------------------------------- |
| `beaconhs-postgres`   | healthy, 5433                                        |
| `beaconhs-redis`      | healthy, 6380                                        |
| `beaconhs-minio`      | **healthy**, 9000 (S3) / 9001 (console)              |
| `beaconhs-mailpit`    | healthy, 1025 / 8025                                 |
| `beaconhs-collabora`  | healthy, 9980                                        |
| volumes               | `beaconhs-hse_{postgres,redis,minio}-data`           |
| database              | 41 migrations, seeded, 202 tables, 187 FORCE-RLS     |
| app                   | `turbo run dev --parallel --env-mode=loose` on :3000 |
| bucket `beaconhs-dev` | exists, 0 objects                                    |

---

## Related documents

- [MinIO build record](./beaconhs-minio-build.md) — source, commit, image identity
- [Official deployment baseline](./beaconhs-official-deployment-baseline.md) — the blocker
- [SeaweedFS verification](./beaconhs-seaweedfs-verification.md) — the rejected alternative
- [Storage audit](./beaconhs-storage-audit.md) — the storage subsystem
- [Architecture audit](./beaconhs-architecture.md) — the wider system
- [HSE gap analysis](./hse-gap-analysis.md) — product capability
