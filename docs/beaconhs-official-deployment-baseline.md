# BeaconHS — Official Deployment Baseline

> **Status:** deployment attempted against the official Git HEAD baseline.
> **Date:** 2026-09-29 · **HEAD:** `70da27c4` (unmodified) · **Branch:** `main`
> Predecessors: [cleanup inventory](./beaconhs-cleanup-inventory.md) ·
> [cleanup execution](./beaconhs-cleanup-execution.md)
>
> ## **VERDICT: DEPLOYMENT BASELINE NOT VERIFIED — 1 blocking FAIL**
>
> The official object-storage image (`minio/minio:latest`) **no longer exists** in any public
> registry. MinIO deleted its Docker Hub repositories on 2026-09-11. The official compose cannot
> be started as written, so the file-attachment subsystem cannot be verified.
>
> Everything else in the official baseline — compose, PostgreSQL, Redis, Mailpit, Collabora,
> migration, seed, web, login, and 18 authenticated modules — is restored and verified working.
>
> **No SeaweedFS. No source modification. No schema modification. Stopped as instructed.**

## 摘要（中文执行摘要）

**结论：不能报告 DEPLOYMENT BASELINE VERIFIED。存在 1 个阻断性 FAIL。**

**唯一阻断项：官方对象存储镜像 `minio/minio:latest` 已从公网消失。**

MinIO 于 2026-09-11 删除了其在 Docker Hub 的 `minio/minio` 与 `minio/mc` 仓库。实测：

- `hub.docker.com/v2/repositories/minio/minio/` → `object not found`（HTTP 404）
- `quay.io/minio/minio` → HTTP 401（同样不可获取）
- `github.com/minio/minio` → 仓库已 archived（AGPL-3.0，最后推送 2026-04-24）

BeaconHS 官方 `docker-compose.yml` 固定引用 `minio/minio:latest`，因此**官方基线无法按原样启动**。
按第三原则，我没有自行替换为 SeaweedFS 或其他存储。

**已恢复并验证通过的部分：**

| 项目                                                             | 状态                                       |
| ---------------------------------------------------------------- | ------------------------------------------ |
| 官方 Compose（与 Git HEAD 逐字节一致）                           | **PASS**                                   |
| PostgreSQL 16.15（local-db profile，5433）                       | **PASS**                                   |
| Redis 7（6380）                                                  | **PASS**                                   |
| Mailpit（1025 / 8025）                                           | **PASS**                                   |
| Collabora（9980）                                                | **PASS**                                   |
| `pnpm db:migrate`                                                | **PASS**（41 迁移 / 187 表 RLS / 10 视图） |
| `pnpm db:seed`                                                   | **PASS**（202 表 / 种子数据完整）          |
| Web 应用                                                         | **PASS**                                   |
| Magic Link 登录                                                  | **PASS**（真实收信 + 会话 cookie）         |
| 18 个已认证模块页面                                              | **全部 HTTP 200**                          |
| **对象存储 E2E（上传/预签名/metadata/tags/finalize/下载/删除）** | **FAIL — 无存储可测**                      |

**另发现 1 个上游既有缺陷**（非本次部署引入，未修改）：
`/api/v1` 服务发现返回 500 —— `No public API read permission mapped for entity category "compliance"`。

**下一步需要你决策对象存储方案。** 我不会自行选择。

---

# A. Git HEAD official deployment structure

## A.1 Provenance of the restored compose file

Per the "use official files first" principle, the baseline was taken from Git HEAD, not from
memory and not from the previous SeaweedFS working tree:

```bash
$ git show HEAD:docker-compose.yml > /tmp/head-compose.yml
$ md5sum /tmp/head-compose.yml docker-compose.yml.bak
f0a8709aaaa2b1d5873e619d8386c679  /tmp/head-compose.yml
f0a8709aaaa2b1d5873e619d8386c679  docker-compose.yml.bak
$ cmp -s docker-compose.yml.bak /tmp/head-compose.yml
  -> byte-identical
```

**`docker-compose.yml.bak` is byte-for-byte identical to the committed official compose.**
That removed any doubt about whether `.bak` was the right reference.

The active file was then restored with a plain copy — **no Git mutation**:

```bash
$ cp -p docker-compose.yml.bak docker-compose.yml
$ md5sum docker-compose.yml
f0a8709aaaa2b1d5873e619d8386c679    # == official HEAD
```

`git diff --name-only` no longer lists `docker-compose.yml`: the working tree now matches HEAD
for that file.

## A.2 Official services (verbatim from `git show HEAD:docker-compose.yml`)

| #   | Service     | Image                    | Tag policy | Container            | Profile        | Ports                    | Volume                                      | Healthcheck                              |
| --- | ----------- | ------------------------ | ---------- | -------------------- | -------------- | ------------------------ | ------------------------------------------- | ---------------------------------------- |
| 1   | `postgres`  | `postgres:16-alpine`     | **pinned** | `beaconhs-postgres`  | **`local-db`** | `5433:5432`              | `postgres-data`                             | `pg_isready -U beaconhs_app -d beaconhs` |
| 2   | `redis`     | `redis:7-alpine`         | **pinned** | `beaconhs-redis`     | default        | `6380:6379`              | `redis-data`                                | `redis-cli ping`                         |
| 3   | `minio`     | `minio/minio:latest`     | `latest`   | `beaconhs-minio`     | default        | `9000:9000`, `9001:9001` | `minio-data`                                | `curl -f .../minio/health/live`          |
| 4   | `mailpit`   | `axllent/mailpit:latest` | `latest`   | `beaconhs-mailpit`   | default        | `1025:1025`, `8025:8025` | none                                        | **none**                                 |
| 5   | `collabora` | `collabora/code:latest`  | `latest`   | `beaconhs-collabora` | default        | `9980:9980`              | bind-mount `./deploy/collabora-branding.js` | **none**                                 |

**Version policy honoured (Principle 4).** The official compose pins `postgres:16-alpine` and
`redis:7-alpine` and uses `latest` for minio, mailpit, and collabora. Those exact values were
kept — no upgrades, no downgrades, no digest pinning introduced.

## A.3 Official answers to the 17 required questions

| #   | Question                       | Official answer                                                                         | Source                             |
| --- | ------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | Recommended containers         | postgres, redis, **minio**, mailpit, collabora                                          | compose                            |
| 2   | PostgreSQL version             | **`postgres:16-alpine`** (pinned)                                                       | `:6`                               |
| 3   | Redis version                  | **`redis:7-alpine`** (pinned)                                                           | `:27`                              |
| 4   | Object storage scheme          | **S3-compatible via MinIO** (dev); Cloudflare R2 in prod                                | compose `:39`, `README.md:176`     |
| 5   | Object storage image           | **`minio/minio:latest`**                                                                | `:40`                              |
| 6   | Collabora in official compose? | **Yes**, default profile                                                                | `:67-84`                           |
| 7   | Mailpit in official compose?   | **Yes**, default profile                                                                | `:57-62`                           |
| 8   | Profiles                       | only `postgres` is profile-gated (`local-db`); the other four are default               | `:8-9`                             |
| 9   | Dependencies                   | no `depends_on`; postgres bind-mounts `scripts/cluster/local-init.sh` + `provision.sql` | `:18-19`                           |
| 10  | Default ports                  | 5433, 6380, 9000, 9001, 1025, 8025, 9980                                                | compose                            |
| 11  | Volumes                        | `postgres-data`, `redis-data`, `minio-data`                                             | `:86-89`                           |
| 12  | Network                        | implicit project default `beaconhs-hse_default`                                         | compose                            |
| 13  | Healthchecks                   | postgres, redis, minio only                                                             | `:20-24, 33-37, 51-55`             |
| 14  | Init                           | `docker compose --profile local-db up -d`                                               | `QUICKSTART.md:32`                 |
| 15  | Migration                      | `pnpm db:migrate`                                                                       | `package.json`, `QUICKSTART.md:34` |
| 16  | Seed                           | `pnpm db:seed`                                                                          | `package.json`, `QUICKSTART.md:35` |
| 17  | Required `.env`                | 29 keys in `.env.example`                                                               | `.env.example`                     |

## A.4 Storage architecture chain (Principle 3)

```
BeaconHS browser
   → apps/web/src/lib/uploads.ts  requestUpload()
   → @beaconhs/storage  presignPut()        [AWS SDK SigV4]
   → MinIO  (S3-compatible, path-style)
   → attachments.r2_key  →  finalizeUpload() → promoteObject() (CopyObject)
```

The chain is preserved exactly. `packages/storage/**` was **not** touched. `presignPut()` and
`finalizeUpload()` were **not** changed. No attachment business logic was altered.

---

# B. Actual deployed structure

## B.1 Compose restore (Principle 7)

Backups were **not** overwritten or deleted:

| File                                    | Size   | Content                   | Status                           |
| --------------------------------------- | ------ | ------------------------- | -------------------------------- |
| `docker-compose.yml`                    | 2913 B | **MinIO (official HEAD)** | restored via `cp -p` from `.bak` |
| `docker-compose.yml.bak`                | 2913 B | MinIO (official HEAD)     | preserved, read-only source      |
| `docker-compose.yml.pre-cleanup-backup` | 2811 B | SeaweedFS                 | preserved, untouched             |

Forbidden commands not used: `git reset`, `git restore`, `git clean`,
`git checkout -- docker-compose.yml`.

## B.2 Pre-start config validation (Principle 8) — 19/19 PASS

```
$ docker compose config                        -> YAML VALID
$ docker compose config --services             -> redis storage... (pre-restore)
```

Post-restore assertions:

| Assertion                                                                                    | Result  |
| -------------------------------------------------------------------------------------------- | ------- |
| postgres service / image `16-alpine` / profile `local-db` / port 5433                        | PASS ×4 |
| redis image `7-alpine` / port 6380                                                           | PASS ×2 |
| MinIO image / container name / port 9000 / console 9001 / volume / credentials / healthcheck | PASS ×7 |
| mailpit service, collabora service, collabora port 9980                                      | PASS ×3 |
| **NO SeaweedFS anywhere**                                                                    | PASS    |
| **NO legacy `storage-data` volume**                                                          | PASS    |
| **NO `AWS_REQUEST_*` variable**                                                              | PASS    |

Resolved volumes: exactly `minio-data`, `postgres-data`, `redis-data`.

## B.3 Startup (Principle 9)

`docker compose --profile local-db up -d` **failed as a whole** because of MinIO:

```
 Image minio/minio:latest Pulling
 Error pull access denied for minio/minio, repository does not exist or may require 'docker login'
 Image postgres:16-alpine Interrupted
 Image collabora/code:latest Interrupted
 Image axllent/mailpit:latest Interrupted
 Image redis:7-alpine Interrupted
```

The four unobtainable-free services were then started individually, still via the official
compose (no config deviation, only an explicit service list):

```bash
docker compose --profile local-db up -d postgres redis mailpit collabora
```

| Service              | Image                    | Status                                      | Ports                    |
| -------------------- | ------------------------ | ------------------------------------------- | ------------------------ |
| `beaconhs-postgres`  | `postgres:16-alpine`     | **Up (healthy)**                            | `5433:5432`              |
| `beaconhs-redis`     | `redis:7-alpine`         | **Up (healthy)**                            | `6380:6379`              |
| `beaconhs-mailpit`   | `axllent/mailpit:latest` | **Up** (no healthcheck in official compose) | `1025:1025`, `8025:8025` |
| `beaconhs-collabora` | `collabora/code:latest`  | **Up (healthy)**                            | `9980:9980`              |
| `beaconhs-minio`     | `minio/minio:latest`     | **NOT RUNNING — image unobtainable**        | —                        |

Volumes created: `beaconhs-hse_postgres-data`, `beaconhs-hse_redis-data`.
(`minio-data` was never created because the minio service never started.)
Network: `beaconhs-hse_default`.

---

# C. Per-container detail

|                    | postgres                         | redis                         | minio                                      | mailpit                    | collabora                                |
| ------------------ | -------------------------------- | ----------------------------- | ------------------------------------------ | -------------------------- | ---------------------------------------- |
| **image**          | `postgres:16-alpine`             | `redis:7-alpine`              | `minio/minio:latest`                       | `axllent/mailpit:latest`   | `collabora/code:latest`                  |
| **tag policy**     | pinned                           | pinned                        | latest                                     | latest                     | latest                                   |
| **port**           | `5433→5432`                      | `6380→6379`                   | `9000→9000`, `9001→9001`                   | `1025→1025`, `8025→8025`   | `9980→9980`                              |
| **volume**         | `postgres-data`                  | `redis-data`                  | `minio-data`                               | none                       | bind `./deploy/collabora-branding.js:ro` |
| **profile**        | `local-db`                       | default                       | default                                    | default                    | default                                  |
| **healthcheck**    | `pg_isready`                     | `redis-cli ping`              | `curl /minio/health/live`                  | none                       | none                                     |
| **restart policy** | none                             | none                          | none                                       | none                       | `unless-stopped`                         |
| **purpose**        | primary OLTP store, RLS-enforced | BullMQ queues + rate limiting | S3-compatible object store for attachments | dev SMTP sink (Mailpit UI) | in-browser PPTX/Word editing (WOPI)      |
| **verified**       | healthy, v16.15                  | healthy, `PONG`               | **FAIL**                                   | HTTP 200 on 8025           | HTTP 200 on 9980                         |

---

# D. `.env`

## D.1 Comparison with `.env.example`

`.env` was **not** overwritten. It was diffed against the official `.env.example` first.

Before: 1 extra key (`AWS_REQUEST_CHECKSUM_CALCULATION`), 0 missing.
After: **0 extra, 0 missing — 29 keys, exactly matching the official set.**

## D.2 SeaweedFS variable cleanup

Removed — introduced during the failed SeaweedFS verification, and **not present** in
`.env.example`:

| Variable                                         | Action      | Reason                                                                                                                             |
| ------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` | **REMOVED** | SeaweedFS-specific workaround for enforced `x-amz-checksum-crc32`. MinIO does not enforce it. Absent from official `.env.example`. |
| its 5-line explanatory comment                   | **REMOVED** | described the removed variable                                                                                                     |

## D.3 `R2_*` variables — RETAINED (Principle 5, explicitly)

These are **the official BeaconHS storage variables**, not SeaweedFS artefacts.
`.env.example:31-37` (official, unmodified) defines exactly these names:

```
# --- File storage (Cloudflare R2 / S3-compatible) ---
R2_ENDPOINT=http://localhost:9000
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=beaconhs-dev
R2_PRIVATE_BUCKET_CONFIRMED=false
```

They are read by `packages/storage/src/index.ts:38-48` — the same code in both deployments. The
`R2_` prefix refers to **Cloudflare R2, the production target** (`README.md:176`); the package
is S3-compatible and MinIO is the dev backend. Retaining them is correct.

### Important note on the empty-credential trap

`.env.example` ships `R2_ACCESS_KEY_ID=` and `R2_SECRET_ACCESS_KEY=` **empty**, while
`packages/storage/src/index.ts:39-40` uses `??`:

```ts
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? 'beaconhs'
```

An empty string is **not** nullish, so the fallback does not engage. A pristine
`cp .env.example .env` would therefore authenticate with a blank key. The values in use match the
official MinIO credentials exactly:

| Source                        | Value                 |
| ----------------------------- | --------------------- |
| compose `MINIO_ROOT_USER`     | `beaconhs`            |
| compose `MINIO_ROOT_PASSWORD` | `beaconhs-dev-secret` |
| `.env` `R2_ACCESS_KEY_ID`     | `beaconhs`            |
| `.env` `R2_SECRET_ACCESS_KEY` | `beaconhs-dev-secret` |

This was set during the earlier verification phase and **kept** per Principle 5
("保留当前有效的 BeaconHS 凭据设置"). It is a pre-existing upstream inconsistency, not
something introduced here, and it was **not** "fixed" by editing source.

## D.4 Final storage block in `.env`

```
R2_ENDPOINT=http://localhost:9000
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=beaconhs
R2_SECRET_ACCESS_KEY=beaconhs-dev-secret
R2_BUCKET=beaconhs-dev
R2_PRIVATE_BUCKET_CONFIRMED=false
```

`R2_ENDPOINT=http://localhost:9000` and `R2_BUCKET=beaconhs-dev` are the official values and
match the official MinIO port mapping and the app-side default bucket.

---

# E. Database

## E.1 Role provisioning (Principle 10)

`scripts/cluster/local-init.sh` + `scripts/cluster/provision.sql` are bind-mounted into
`/docker-entrypoint-initdb.d/` by the official compose and ran automatically on first boot.

```
beaconhs_app       | login=true  | bypassrls=false   <- runtime DML, FORCE RLS
beaconhs_backup    | login=true  | bypassrls=true    <- read-only logical backup
beaconhs_migrator  | login=true  | bypassrls=false   <- migration only
beaconhs_owner     | login=false | bypassrls=false   <- NOLOGIN object owner
beaconhs_super     | login=true  | bypassrls=true    <- cross-tenant maintenance
```

This matches the documented role model in `provision.sql` exactly.

## E.2 `pnpm db:migrate` — **PASS**

```
✔ Database role preflight passed (beaconhs_migrator → beaconhs_owner; runtime beaconhs_app;
                                  maintenance beaconhs_super; backup beaconhs_backup)
▶ Verifying schema ownership…
▶ Validating migration ledger…
  Fresh database detected; the full migration journal will run
✔ Migration ledger valid: 41 applied, 0 pending, 0 historical
✔ RLS applied atomically (187 tables)
✔ Least-privilege grants applied (runtime beaconhs_app; maintenance beaconhs_super; backup beaconhs_backup)
✔ Kiosk PIN hash invariant verified
✔ Built-in role permissions backfilled
✔ Statistics applied (32 targets)
✔ Views applied atomically (10 statements)
```

Exit code 0.

## E.3 `pnpm db:seed` — **PASS**

```
✔ Seed complete
  · PPE types: 4 · inspection types: 3 (+4 groups) · inspection records: 5
  · hazid: 5 hazard types, 12 hazards, 3 sets, 8 tasks
  · incident taxonomy: 6 classifications, 6 injury types, 4 incidents
  · people: 4 groups (16 memberships), 6 titles, 10 people
  · tenant: Acme Industrial (demo)
  · super-admin: admin@beaconhs.local
  · seeded: 10 people, 5 courses, 4 incidents, 4 CAs, 3 documents, 8 equipment, 6 harnesses
  · canonical templates: 1 · PDF templates: 16 created · Builder app PDF templates: 7
```

Exit code 0. **Seed data was not modified** (per Principle 13).

## E.4 Post-seed database state

| Metric                                 | Value                                       | Expected                                         |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| public tables                          | **202**                                     | ~193 declared + views                            |
| tables with `FORCE ROW LEVEL SECURITY` | **187**                                     | matches `rls.ts` exactly                         |
| reporting views applied                | 10                                          | per migrate output                               |
| tenants                                | 1                                           | Acme Industrial                                  |
| tenant_users                           | 1                                           | super-admin                                      |
| roles                                  | 4                                           | worker / foreman / safety_manager / tenant_admin |
| people                                 | 10                                          | seeded                                           |
| incidents                              | 4                                           | seeded                                           |
| corrective_actions                     | 4                                           | seeded                                           |
| documents                              | 3                                           | seeded                                           |
| equipment_items                        | 9                                           | 8 seeded + 1 gas detector pilot                  |
| ppe_items                              | 6                                           | seeded                                           |
| form_templates                         | 7                                           | seeded                                           |
| audit_log                              | 0                                           | correct — nothing audited yet                    |
| super-admin                            | `admin@beaconhs.local`, `isSuperAdmin=true` | present                                          |

---

# F. Storage — **FAIL (no object store exists)**

## F.1 Root cause: the official image no longer exists

BeaconHS's official compose pins `minio/minio:latest`. That image is gone from every public
registry.

```
$ docker pull minio/minio:latest
Error response from daemon: pull access denied for minio/minio,
repository does not exist or may require 'docker login'

$ curl https://hub.docker.com/v2/repositories/minio/minio/
{"message":"object not found","errinfo":{}}

$ curl https://hub.docker.com/v2/repositories/minio/mc/
{"message":"object not found","errinfo":{}}

$ curl -o /dev/null -w '%{http_code}' https://hub.docker.com/v2/repositories/minio/        -> 200  (org page)
$ curl -o /dev/null -w '%{http_code}' https://hub.docker.com/v2/repositories/minio/minio/ -> 404
$ curl -o /dev/null -w '%{http_code}' https://hub.docker.com/v2/repositories/minio/mc/    -> 404
$ curl -o /dev/null -w '%{http_code}' https://hub.docker.com/v2/repositories/minio/operator/ -> 200

$ docker pull quay.io/minio/minio:latest
Error: failed to resolve reference ... 401 Unauthorized
```

Corroborating external evidence: MinIO archived its repository during 2026 and, on
**2026-09-11**, deleted the `minio/minio` and `minio/mc` Docker Hub repositories. The GitHub
source repository is `archived: true`, AGPL-3.0, last push `2026-04-24`.

**Nothing on this host caused this.** It is an upstream supply-availability change that
invalidates BeaconHS's committed compose file.

## F.2 E2E attempt against the official baseline — every step FAIL

Run through BeaconHS's own `@beaconhs/storage` code path (not a raw CLI):

```
### 01_endpoint_reachable  FAIL  TypeError: fetch failed
### 02_head_bucket         FAIL  Error: connect ECONNREFUSED 127.0.0.1:9000
### 03_put_object          FAIL  Error: connect ECONNREFUSED 127.0.0.1:9000
### 04_get_object          FAIL  Error: connect ECONNREFUSED 127.0.0.1:9000
### 05_delete_object       FAIL  Error: connect ECONNREFUSED 127.0.0.1:9000
```

BeaconHS's own `storage-init` (the repo's real artifact, `apps/worker/dist/storage-init.js`):

```
$ node dist/storage-init.js
[storage-init] failed: connect ECONNREFUSED 127.0.0.1:9000
EXIT=1
```

Nothing is listening on ports 9000/9001 — no object store container exists to listen.

## F.3 Required storage checklist

| #   | Step                 | Result         | Reason                                                           |
| --- | -------------------- | -------------- | ---------------------------------------------------------------- |
| 1   | Create / upload file | **FAIL**       | no store                                                         |
| 2   | Presigned PUT        | **FAIL**       | no store                                                         |
| 3   | Object exists        | **FAIL**       | no store                                                         |
| 4   | metadata             | **UNVERIFIED** | no store                                                         |
| 5   | tags                 | **UNVERIFIED** | no store                                                         |
| 6   | `finalizeUpload`     | **UNVERIFIED** | no store (and would fail on metadata, as proven under SeaweedFS) |
| 7   | Attachment row       | **UNVERIFIED** | no store                                                         |
| 8   | Download             | **UNVERIFIED** | no store                                                         |
| 9   | Delete               | **UNVERIFIED** | no store                                                         |

**Not claimed as passing.** With no object store, none of these can be exercised.

## F.4 Storage configuration (as deployed)

| Field       | Value                              | Source                                              |
| ----------- | ---------------------------------- | --------------------------------------------------- |
| provider    | MinIO (S3-compatible)              | official compose — **but image unobtainable**       |
| endpoint    | `http://localhost:9000`            | `.env` `R2_ENDPOINT` = official default             |
| bucket      | `beaconhs-dev`                     | `.env` `R2_BUCKET` = official default               |
| credentials | `beaconhs` / `beaconhs-dev-secret` | `.env`, matching compose `MINIO_ROOT_*`             |
| SDK         | `@aws-sdk/client-s3` 3.1086.0      | `packages/storage/package.json` — **unmodified**    |
| path style  | `forcePathStyle: true`             | `packages/storage/src/index.ts:53` — **unmodified** |

---

# G. Application verification (Principle 11, 13)

## G.1 Services

| Check               | Result                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| `docker compose ps` | 4 running, 1 failed to start (minio)                                                 |
| PostgreSQL health   | **healthy**; `PostgreSQL 16.15 on x86_64-pc-linux-musl`                              |
| Redis health        | **healthy**; `PONG`                                                                  |
| Collabora           | **healthy**; `http://localhost:9980` → HTTP 200                                      |
| Mailpit             | **running**; `http://localhost:8025` → HTTP 200 (no healthcheck in official compose) |
| Web                 | **ready**; `/api/health/ready` → `{"status":"ready","version":"unknown"}`            |
| **SeaweedFS**       | **absent** — no container, image, or volume anywhere                                 |

## G.2 Login (Principle 13)

Full magic-link chain exercised against the real app and the real Mailpit:

```
1. POST /api/auth/sign-in/magic-link  {"email":"admin@beaconhs.local"}   -> HTTP 200 {"status":true}
2. Mailpit API /api/v1/messages                                          -> total: 1
   recipient: admin@beaconhs.local   subject: "Sign in to BeaconHS"
3. Extracted link: http://localhost:3000/api/auth/magic-link/verify?token=...
4. Followed link                                                          -> HTTP 200
5. Response headers                                                      -> set-cookie: better-auth.session_token=...
                                                                              set-cookie: better-auth.session_data=...
```

**A real authenticated session was established and used for all subsequent checks.**

## G.3 Core pages with the live session

| Page                  | HTTP | Page                  | HTTP |
| --------------------- | ---- | --------------------- | ---- |
| `/login` (public)     | 200  | `/hazard-assessments` | 200  |
| `/` (public)          | 200  | `/ppe`                | 200  |
| `/api/health/ready`   | 200  | `/journals`           | 200  |
| `/dashboard`          | 200  | `/documents`          | 200  |
| `/incidents`          | 200  | `/people`             | 200  |
| `/corrective-actions` | 200  | `/equipment`          | 200  |
| `/inspections`        | 200  | `/training`           | 200  |
| `/compliance`         | 200  | `/insights`           | 200  |
| `/admin`              | 200  | `/reports`            | 200  |
| `/notifications`      | 200  | `/assistant`          | 200  |
| `/help`               | 200  |                       |      |

**18/18 authenticated module pages serve HTTP 200 with a real super-admin session.**

## G.4 Two pre-existing defects (NOT introduced here, NOT fixed)

**1. `/api/v1` returns HTTP 500 — unauthenticated service discovery is broken.**

```
Error: No public API read permission mapped for entity category "compliance"
    at src/app/api/v1/route.ts:64:50
```

`readPermissionForEntity()` throws while walking `REPORT_ENTITIES`. The file is
**unmodified from HEAD** (`git diff --stat HEAD -- apps/web/src/app/api/v1/route.ts` → empty).
Pre-existing upstream bug; not fixed, per the stop condition.

**2. `pnpm dev` does not load `.env` into the worker/scheduler.**

The worker connected to `127.0.0.1:6379` (the hard-coded `LOCAL_REDIS_URL` fallback in
`packages/jobs/src/config.ts:1`) instead of the configured `6380`, because `tsx` does not
auto-load `.env` and Turbo hashes but does not inject env:

```
$ tsx /tmp/envtest.ts              -> REDIS_URL = (unset)
$ tsx --env-file=.env /tmp/envtest.ts -> REDIS_URL = redis://localhost:6380
```

The official launcher (`scripts/launchers/dev-launcher.sh:455`) also just runs `pnpm dev`
without exporting `.env`. This is an upstream dev-experience gap.

**Worked around at the process level only** — no file, no source change:
`setsid bash -c 'set -a; . ./.env; set +a; exec pnpm dev'`. After that, **0 `ECONNREFUSED`**
errors and the worker started cleanly (`[worker] starting beaconhs worker…`).

## G.5 Environment constraint: 3.39 GB RAM

The web dev server was OOM-killed once while compiling `/reports` after eight sequential page
compilations (no JS heap error logged; process vanished). `curl` returned `000` instantly.
Requested `/reports` in isolation on a fresh server: **HTTP 200, consistently, 12/12**.

**This is a host memory constraint, not an application defect.** `total 3391 MB`, with
Collabora at 113 MB and PostgreSQL/Redis/Mailpit together under 45 MB. Next.js dev compiling
this app on ~3.4 GB is marginal. Not a deployment defect; flagged for capacity planning.

---

# H. Differences from official Git HEAD

| #   | Difference                                                       | Cause                                                                                          | Justification                                                                                               |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `minio` service not running                                      | **`minio/minio:latest` deleted from all public registries on 2026-09-11**                      | Not a choice. The image cannot be pulled. Compose left **byte-identical to HEAD**.                          |
| 2   | `beaconhs-hse_minio-data` volume not created                     | consequence of #1                                                                              | n/a                                                                                                         |
| 3   | `.env`: `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` populated    | `.env.example` ships them empty, but `??` at `index.ts:39-40` does not fall back on `""`       | Required for any upload to authenticate; values match official `MINIO_ROOT_*`. Principle 5.                 |
| 4   | `.env`: `AWS_REQUEST_CHECKSUM_CALCULATION` removed               | SeaweedFS-only workaround from the failed migration                                            | Principle 5 cleanup; absent from official `.env.example`.                                                   |
| 5   | `pnpm dev` launched with `.env` exported                         | worker/scheduler do not read `.env` (upstream gap)                                             | Process-level only; no file or source change.                                                               |
| 6   | `apps/web/next-env.d.ts` modified                                | Next.js auto-generated; switched `.next/types` → `.next/dev/types` because `next dev` was used | File says _"This file should not be edited"_ and is in `.prettierignore`. Tool artifact, not a source edit. |
| 7   | 4 services started individually rather than via a single `up -d` | the single `up` aborted on the MinIO pull                                                      | Same official compose; only the service list was made explicit. No config change.                           |

**Zero unapproved source modifications.** `git diff --name-only` lists only
`apps/web/next-env.d.ts` (Next codegen). `git diff --name-only -- apps packages scripts deploy`
excluding that file: **empty**. `packages/storage/**` untouched. No schema change. No
`docker-compose.yml` deviation from HEAD (it is byte-identical).

---

# I. Final checklist against the stop conditions

| #   | Condition                    | Result                                                       |
| --- | ---------------------------- | ------------------------------------------------------------ |
| 1   | Official compose restored    | **PASS** — byte-identical to HEAD (`md5 f0a8709a…`)          |
| 2   | BeaconHS containers running  | **PARTIAL** — 4/5 (minio impossible)                         |
| 3   | PostgreSQL healthy           | **PASS** — 16.15, healthy, 202 tables / 187 FORCE-RLS        |
| 4   | Redis healthy                | **PASS** — `PONG`, 8 queues wired                            |
| 5   | Official object storage      | **FAIL** — image unobtainable                                |
| 6   | Collabora healthy            | **PASS** — HTTP 200 on 9980                                  |
| 7   | Mailpit running              | **PASS** — HTTP 200 on 8025, delivered a real magic link     |
| 8   | migration PASS               | **PASS** — 41 applied, RLS + grants + views                  |
| 9   | seed PASS                    | **PASS** — 202 tables, full demo tenant + super-admin        |
| 10  | Web running                  | **PASS** — health ready, login page renders                  |
| 11  | Login works                  | **PASS** — magic link + real session cookie                  |
| 12  | file upload PASS             | **FAIL** — no object store                                   |
| 13  | Presigned PUT PASS           | **FAIL** — no object store                                   |
| 14  | `finalizeUpload` PASS        | **FAIL** — no object store                                   |
| 15  | file download PASS           | **FAIL** — no object store                                   |
| 16  | file delete PASS             | **FAIL** — no object store                                   |
| 17  | No SeaweedFS                 | **PASS** — absent everywhere                                 |
| 18  | No unapproved source changes | **PASS** — only Next's generated `next-env.d.ts`             |
| 19  | Audit docs intact            | **PASS** — all 7 present, plus inventory + execution reports |

**Conditions 5 and 12–16 FAIL. DEPLOYMENT BASELINE VERIFIED is NOT reported.**

---

# J. Decision required — object storage

The official baseline cannot be completed because the upstream image is gone. I have **not**
substituted anything. Options, for you to choose:

| Option                                        | Notes                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Build MinIO from the archived source**   | `github.com/minio/minio` is archived but present (AGPL-3.0, last push 2026-04-24). Build and tag it locally as `minio/minio:latest`, so the official compose works **unmodified**. Highest fidelity to HEAD; adds a build step. |
| **B. Point at a third-party mirror**          | Unverified provenance = supply-chain risk. Would also require editing the compose image reference.                                                                                                                              |
| **C. Change the compose to another S3 store** | Deviates from Git HEAD and would need a recorded, deliberate decision. SeaweedFS was already measured and **failed** (presigned PUT drops metadata/tags — see [verification §4.3](./beaconhs-seaweedfs-verification.md)).       |
| **D. Use a hosted store (Cloudflare R2)**     | This is the documented **production** target (`README.md:176`), and the app already supports it via `R2_ACCOUNT_ID`. Requires an account; not a local dev baseline.                                                             |
| **E. Point dev storage at the production R2** | Simple, but mixes dev and prod data.                                                                                                                                                                                            |

**Recommendation: A** — it restores the official compose byte-for-byte and keeps the
S3-compatible contract intact with zero source changes. It requires your approval because it
introduces a local build step that the upstream repo no longer ships.

Whichever you choose, the storage E2E (steps 12–16) must be re-run before the baseline can be
declared verified.

---

# K. Current environment state (left running for inspection)

| Resource             | State                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| `beaconhs-postgres`  | running, healthy, 5433                                                  |
| `beaconhs-redis`     | running, healthy, 6380                                                  |
| `beaconhs-mailpit`   | running, 1025 / 8025                                                    |
| `beaconhs-collabora` | running, healthy, 9980                                                  |
| `beaconhs-minio`     | **not running**                                                         |
| volumes              | `beaconhs-hse_postgres-data`, `beaconhs-hse_redis-data`                 |
| network              | `beaconhs-hse_default`                                                  |
| database             | migrated (41) + seeded; 202 tables; 187 FORCE-RLS                       |
| app                  | `pnpm dev` running on :3000 (web + worker + scheduler), `.env` exported |
| session              | magic-link login verified; super-admin `admin@beaconhs.local`           |

---

## Related documents

- [Cleanup execution](./beaconhs-cleanup-execution.md) — the teardown that preceded this
- [Cleanup inventory](./beaconhs-cleanup-inventory.md) — pre-teardown reconnaissance
- [SeaweedFS verification](./beaconhs-seaweedfs-verification.md) — why SeaweedFS was rejected
- [SeaweedFS impact](./beaconhs-seaweedfs-impact.md) — the static migration analysis
- [Storage audit](./beaconhs-storage-audit.md) — the object storage subsystem
- [Architecture audit](./beaconhs-architecture.md) — the wider system
- [HSE gap analysis](./hse-gap-analysis.md) — product capability
