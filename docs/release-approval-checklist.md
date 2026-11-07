# BeaconHS Release Approval Checklist

**Status: PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**

**Candidate version:** EA-16 (source HEAD `51a899b7aac0a942da327222a3eed355fca9798a`)
**Image tag:** `beaconhs:phase-ea16-20261023-052716`
**Image manifest digest:** `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`
**App version SHA:** `51a899b7aac0a942da327222a3eed355fca9798a`
**Source snapshot:** `/home/test/projects/beaconhs-hse-release-snapshot/` (MANIFEST.txt + changed files)
**Last verified:** 2026-10-23 on ceshi `beaconhs-phase-aj` stack
**EA-36 completed:** 2026-10-24
**EA-37 completed:** 2026-10-25
**EA-38 completed:** 2026-10-25
**EA-39 completed:** 2026-10-25
**EA-40 completed:** 2026-10-25
**EA-41 completed:** 2026-10-25
**EA-42 completed:** 2026-10-26
**EA-43 completed:** 2026-10-26
**EA-44 completed:** 2026-10-26

---

## 1. Candidate version & traceability

- [x] Image tag recorded: `beaconhs:phase-ea16-20261023-052716`
- [x] Full manifest digest recorded: `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`
- [x] App version SHA matches image: `51a899b7…`
- [x] Container image ID on ceshi matches digest
- [x] Source snapshot archived at `/home/test/projects/beaconhs-hse-release-snapshot/`
- [x] Source reproducibility verified (EA-19): independent build from snapshot succeeded (tag `beaconhs:ea19-repro-20261023-080322`)
- [ ] Binary reproducibility NOT VERIFIED: rebuild digest `sha256:1908e00b…` ≠ candidate `sha256:17126c6e…` (layer divergence from build step 11; non-deterministic build output, likely timestamps)

## 2. Verified features & evidence

| Feature                                                | Status        | Evidence source                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login & session (Magic Link)                           | PASS          | EA-34: magic-link request → Mailpit email → verify URL → /dashboard; admin accessible; replayed link → INVALID_TOKEN; real business operation (forgot-password Server Action) executed → email sent to Mailpit verified |
| API permissions (unauth → 401)                         | PASS          | monitored_sessions returns 401 without session                                                                                                                                                                          |
| Cross-tenant RLS                                       | PASS          | EA-14: BB tenant sees 0 rows for all 5 AJ tables                                                                                                                                                                        |
| D3 migration (dead columns dropped)                    | PASS (static) | Image unchanged vs EA-13 baseline; migration 0051 applied                                                                                                                                                               |
| D4 PPE corrective-action event chain                   | PASS          | EA-14/EA-17: CA + audit + event + notification + RLS + dedup                                                                                                                                                            |
| D5 equipment flow (8 statuses incl. repaired/verified) | PASS (static) | Image unchanged vs EA-13                                                                                                                                                                                                |
| File upload E2E                                        | PASS          | 70-byte PNG, SHA256 match, MinIO HEAD/GET                                                                                                                                                                               |
| File download capability-URL E2E                       | PASS          | EA-17: 307 → presigned GET → 200, size 70, SHA256 match; invalid cap → 404                                                                                                                                              |
| Invite redirect & Host-header protection               | PASS          | EA-16/EA-17: Location uses public origin; forged Host ignored                                                                                                                                                           |
| Tunnel HTTP/2 stability                                | PASS (CLOSED) | EA-15: 30-min probe 118/118 200, 0 failures                                                                                                                                                                             |
| Gateway self-heal (D-AK-4)                             | CLOSED        | 5 crash injections, 1–2 s recovery                                                                                                                                                                                      |
| Retry/dedup (outbox)                                   | PASS          | EA-14: notification count stayed 1 after republish                                                                                                                                                                      |
| Test data cleanup                                      | PASS          | All synthetic rows verified 0 leftover                                                                                                                                                                                  |

## 3. Known risks & unverified items

1. **Build reproducibility not verified** — image built from working tree (165 modified + 1022 untracked files from prior EA work), not a clean checkout. Source snapshot archived but clean rebuild not validated.
2. **Legacy images on ceshi** — ~10 beaconhs images (~2.86 GB each) retained. Disk at 82%. No prune performed (per policy).
3. **`/home/ceshi/aj-gateway-healthcheck.py`** — host-level script, not in any volume. Must be preserved across host rebuilds.
4. **Gateway Host-header forwarding** — fixed at app level (`appBaseUrl()`). Gateway-level Host rewrite not implemented; if future routes use `req.url`, they may exhibit the same issue.
5. **Download capability-URL cross-tenant** — verified via RLS probe (BB tenant sees 0 rows), not via a live browser session from a different tenant.

## 4. Database migration & recovery requirements

- **Migration 51** (`0051_ea12_drop_dead_columns.sql`): drops 3 dead columns (`certificate` from `equipment_inspection_records`, `due_on` and `expires_on` from `training_enrollments`). Idempotent per existing migration style.
- **Pre-deploy (EA-32A verified on ceshi staging):** all 3 target columns already absent (ALREADY APPLIED). Table row counts: equipment_inspection_records=0, training_enrollments=0. Ceshi DB is at migration 51 (hash `d8ff1c5b…`). Ceshi tenants: "Phase AJ Test Tenant", "Phase BB Isolated Freeze Tenant" — confirmed test environment, not production.
- **EA-32A backup/restore verified:** `pg_dump -Fc` (1.47 MB) → `pg_restore --no-privileges` → separate DB `beaconhs_ea32a_restore`. Row counts preserved. Migration version 51 confirmed. RLS policies: 194 in public schema. Migration 51 columns confirmed absent. `beaconhs_app` role could NOT read tables after restore (permission denied) — confirms runbook claim that `pnpm db:migrate` is required to reapply grants.
- **Pre-deploy (production):** confirm target DB backup exists and is restorable. Verify 3 target columns have zero non-null values in production (do not assume ceshi's zero records represent production).
- **Post-restore:** run `pnpm db:migrate` to restore necessary permissions (per `pg_restore --no-privileges` workflow). **EA-32B verified:** after `pg_restore --no-privileges --role=beaconhs_owner`, `pnpm db:migrate` (via ops-migrate) succeeded. Post-migration: beaconhs_app can read ppe_items (0 visible — RLS filters), corrective_actions (0 visible). RLS enabled+forced on all 5 key tables. Migration version still 51. beaconhs_app is not superuser, does not bypass RLS. **Grants and RLS fully restored.** Verified in isolated restored DB `beaconhs_ea32b_restore`.
- **RLS:** all tenant tables have RLS policies in `TENANT_SCOPED_TABLES`. Verify via `packages/db/src/rls.ts`. 194 policies confirmed in restored DB.
- **Rollback caveat:** DB migration cannot be undone by switching back to an old image. Schema changes (column drops) are forward-only. Rollback requires a DB restore from backup.
- **Production data check:** before deploying, verify that columns being dropped have zero non-null values in production.

## 5. Secrets & runtime environment

- **Server Action Key:** build-time secret (`--secret id=next_server_actions_key`), mode 600 key file. Baked into image; not an env var. Cross-version rollback requires the same key (or re-build). Key file location: operator-managed (not in repo).
- **BETTER_AUTH_SECRET:** from `DRILL_BETTER_AUTH_SECRET` env (ceshi). Production must have its own.
- **ATTACHMENT_CAPABILITY_SECRET:** from `DRILL_ATTACHMENT_CAPABILITY_SECRET`. Production must have its own (≥32 chars).
- **R2/MinIO:** `R2_ENDPOINT` = public origin, `R2_INTERNAL_ENDPOINT` = private in-network address. Production must use its own object store.
- **APP_URL / PUBLIC_APP_URL:** must be set to the production origin.
- **HOSTNAME=0.0.0.0, PORT=3000:** container bind config. Do not change (Next.js uses for bind address).

## 6. Pre-deployment checklist

- [ ] Confirm target environment (production) is not ceshi/drill.
- [ ] Verify DB backup exists and is restorable (test restore in staging if possible).
- [ ] Verify migration 51 columns have zero non-null values in production.
- [ ] Confirm all secrets are configured in production env (BETTER_AUTH_SECRET, ATTACHMENT_CAPABILITY_SECRET, R2__, SMTP__, etc.).
- [ ] Confirm APP_URL/PUBLIC_APP_URL = production origin.
- [ ] Confirm Server Action key file is available for build (mode 600).
- [ ] Confirm object store (R2/MinIO) is provisioned and accessible.
- [ ] Confirm DNS/Cloudflare tunnel (if used) routes to the new deployment.
- [ ] Confirm maintenance window and responsible parties are identified.
- [ ] Confirm rollback image tag is available (`beaconhs:phase-ea13-20261022-160729-m` or equivalent).

## 7. Post-deployment health checks

- [ ] Readiness endpoint returns HTTP 200: `GET /api/health/ready`
- [ ] App version SHA matches deployed image.
- [ ] Login flow works (magic-link or password).
- [ ] `/api/v1/monitored_sessions` returns 401 without auth, 200 with valid session.
- [ ] File upload: presign PUT → finalize → object exists in storage.
- [ ] File download: capability URL → 307 → presigned GET → file bytes match.
- [ ] Invite accept redirect uses production origin (no `0.0.0.0:3000`).
- [ ] Cross-tenant RLS: verify with a test tenant.
- [ ] Tunnel stability: monitor for 30+ minutes, check for QUIC timeouts.

## 8. Rollback criteria & procedure

**Rollback triggers:**

- Readiness fails or returns non-200 for > 2 minutes.
- Login or session resolution fails.
- File upload/download fails for > 5% of requests.
- Cross-tenant data leak detected.
- Any 5xx error rate > 1% for > 5 minutes.

**Rollback procedure:**

1. Switch web/worker/scheduler containers to the previous image tag (`beaconhs:phase-ea13-20261022-160729-m` or equivalent).
2. If DB migration was applied and is incompatible, restore DB from backup (run `pnpm db:migrate` after restore to re-apply permissions).
3. Verify readiness + version + login.
4. **Note:** DB migration (column drops) cannot be undone by image rollback alone. A DB restore is required if the migration caused data loss.

**Rollback prerequisites:**

- Previous image tag available on the target host.
- DB backup available and tested.
- Compose config backup (e.g., `compose.yaml.pre-ea16`).

## 9. Quality gates (latest run)

| Gate                       | Result  | Notes                                            |
| -------------------------- | ------- | ------------------------------------------------ |
| `pnpm format:check`        | PASS    | Run on `apps/web/src/app/invite/accept/route.ts` |
| `pnpm typecheck` (web)     | PASS    | `tsc --noEmit`, no errors                        |
| `pnpm lint` (web)          | PASS    | `eslint .`, no errors                            |
| `pnpm test` (app-base-url) | PASS    | 3/3 tests                                        |
| `pnpm build` (web)         | PASS    | Full Next.js build succeeded                     |
| `pnpm deadcode:check`      | NOT RUN | No code changes beyond route.ts; knip not re-run |

**Note:** These results are from the EA-16 build cycle. They are not re-run in EA-18/EA-19 (no code changes this cycle). EA-19 added an independent rebuild from source snapshot: build PASS, source reproducible PASS, binary reproducible NOT VERIFIED (digest mismatch).

## 10. Known risks & open items

1. **Binary reproducibility status (EA-19 through EA-23):**
   - **Level 1 (Next.js build ID): RESOLVED (EA-22).** `DEPLOYMENT_VERSION` added to `turbo.json` globalEnv. Build ID is now deterministic (`build-TfctsWXpff2fKS`). Verified: local build produces `build-TfctsWXpff2fKS`. Application code byte-identical across all builds.
   - **Level 2 (Docker image metadata): NOT RESOLVED (EA-23).** Even with `SOURCE_DATE_EPOCH` set as env var, image digests still differ. The ONLY remaining difference is `/Identity/Build[0]/Ref` (build reference — random per build, generated by BuildKit) and `/Identity/Build[0]/CreatedAt` (build timestamp — not controlled by SOURCE_DATE_EPOCH in BuildKit 0.38.1). All 18 layer digests identical. Application code byte-identical. The image's `Created` field IS fixed by `SOURCE_DATE_EPOCH`, but the build identity metadata is not.
   - **Remediation applied (EA-22):** (a) Added `DEPLOYMENT_VERSION` to turbo.json globalEnv. ✓
   - **Remediation tested (EA-23):** (b) Set `SOURCE_DATE_EPOCH` as env var — PARTIALLY EFFECTIVE (fixes image `Created` timestamp but not build identity `CreatedAt`/`Ref`). (c) Build reference (`Ref`) — no standard override in BuildKit 0.38.1.
   - **BLOCKING for formal audit if bit-for-bit reproducibility is required.** Application code is byte-identical; only build metadata (build ref + build timestamp in build identity) differs. These are non-functional differences. Full bit-for-bit reproducibility would require BuildKit configuration or tooling changes not yet validated.
2. **Source reproducibility verified (EA-19/EA-20)** — independent build from snapshot succeeded (source reproducible = PASS). No unrecorded dependencies. First 10 image layers byte-identical.
3. **Download capability-URL cross-tenant** — verified via RLS probe only, not live browser session from a different tenant.
4. **Legacy images on ceshi** — ~10 images (~2.86 GB each) retained. Disk at 82%.
5. **Gateway healthcheck script** — host-level, not in volume. Must be preserved.
6. **No production secrets configured** — production env vars must be set before deploy.

## 10.5 Risk classification (EA-24)

| #   | Item                                           | Category                                                 | Evidence source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Impact                                           | Disposition                                                              | Owner role             | Closure condition                                                                                                                                                      |
| --- | ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Binary reproducibility (image digest)          | APPROVAL REQUIRED                                        | EA-19/20/21/22/23: layer digests identical (18/18), application code byte-identical; only build metadata (build ref + timestamp in build identity) differs. SOURCE_DATE_EPOCH partially effective (fixes image Created but not build identity CreatedAt/Ref). Build reference is random per build in BuildKit 0.38.1 with no standard override.                                                                                                                                                                                                                                                                                      | Audit traceability; does not affect runtime      | Accept risk or fix build metadata                                        | Build/Release engineer | Obtain written risk acceptance from approver, or fix BuildKit build reference + SOURCE_DATE_EPOCH                                                                      |
| 2   | Migration 51 production pre-check              | BLOCKING                                                 | EA-12: migration drops dead columns; ceshi verified 0 non-null; production data state unknown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Data loss if non-null values exist in production | Must verify production columns before deploy                             | DBA / Release engineer | Production query confirms 0 non-null values; backup + restore test passed                                                                                              |
| 3   | Production DB backup & restore                 | NOT RUN                                                  | No production restore drill performed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Cannot recover from migration failure            | Must complete before deploy                                              | DBA / Ops              | Backup restored in staging; `pnpm db:migrate` re-applied; permissions/RLS verified                                                                                     |
| 4   | Production deployment & rollback drill         | NOT RUN                                                  | No production deployment performed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Unknown failure modes in production              | Must complete before deploy                                              | Ops / Release engineer | Staging deploy + rollback executed with evidence                                                                                                                       |
| 5   | Multi-node Swarm validation                    | NOT RUN                                                  | Single-node ceshi only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Unknown behavior under multi-node                | If target arch includes Swarm, must verify                               | Ops / Release engineer | Swarm deploy + health check + rollback verified (or documented as N/A)                                                                                                 |
| 6   | GHCR/GHA cache validation                      | NOT RUN                                                  | Build uses local Docker, not GHCR/GHA                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Cache invalidation unknown                       | If CI uses GHCR/GHA, must verify                                         | CI/CD engineer         | Build via CI pipeline succeeds and produces equivalent image                                                                                                           |
| 7   | WORM/Object Lock recovery                      | NOT RUN                                                  | No WORM storage tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Backup integrity unverified                      | If backup policy requires WORM, must verify                              | Ops / Backup admin     | Restore from WORM storage tested and verified                                                                                                                          |
| 8   | Server Action Key cross-version compat         | EMPIRICALLY VERIFIED (EA-25/26/27/28/29/30/33)           | Key is build-time secret baked into bundle. EA-30 empirical test: K1 action→K1 (same key) = 500 + digest error (decryption OK); K2 action→K2 (same key) = 500 + digest error; K1 action→K2 (diff key) = 404 'Server action not found.' (decryption fails); K2 action→K1 (diff key) = 404. EA-33 full business rollback: K1 baseline healthy (200) + Server Action works; K2 (different key) → 404 'Server action not found.' (incompatibility confirmed); recovery to K1 → 200 + Server Action works (500 + digest, decryption OK). Same key = compatible; different key = incompatible. EA-26 verified Migration 51 backup/restore. | Rollback with different key fails Server Actions | Use same key across versions, or full redeploy with old key + DB restore | Build/Release engineer | Key management policy documented; Migration 51 restore verified; container-level empirical test PASS (same-key works, different-key fails with 404, recovery verified) |
| 9   | Legacy images on ceshi                         | NON-BLOCKING                                             | ~10 images (~2.86 GB each), disk 82%                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Disk space                                       | No action required for release                                           | Ops                    | N/A (informational)                                                                                                                                                    |
| 10  | Gateway healthcheck script (host-level)        | NON-BLOCKING                                             | Script at `/home/ceshi/aj-gateway-healthcheck.py`, not in volume                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Lost on host rebuild                             | Document in runbook                                                      | Ops                    | Added to backup/restore runbook                                                                                                                                        |
| 11  | Gateway Host-header (app-level fix only)       | NON-BLOCKING                                             | Fixed in `appBaseUrl()`; gateway still forwards Host byte-for-byte                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Future routes using `req.url` may hit same issue | Monitor; fix gateway if needed                                           | Dev / Ops              | No action required for this release                                                                                                                                    |
| 12  | Download capability-URL cross-tenant (browser) | NOT VERIFIED                                             | Verified via RLS probe (BB tenant sees 0 rows), not live browser session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Theoretical cross-tenant leak                    | Low risk; RLS covers it                                                  | QA / Security          | Live browser test from different tenant session (optional)                                                                                                             |
| 13  | WOPI investigation                             | KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED | Not in scope for EA-12–EA-24                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | No impact on release                             | No action                                                                | —                      | Out of scope                                                                                                                                                           |
| 14  | Source snapshot completeness                   | PASS                                                     | `/home/test/projects/beaconhs-hse-release-snapshot/` (MANIFEST.txt + 3 changed files + SHA256)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Traceability                                     | No action                                                                | Build/Release engineer | N/A                                                                                                                                                                    |
| 15  | Git workspace cleanliness                      | NOT RUN                                                  | 165 modified + 1023 untracked files (pre-existing from prior EA work)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Confusion about what's in the release            | Document which files are release-relevant                                | Release engineer       | Release delta clearly documented (3 files)                                                                                                                             |
| 16  | Migration 51 production pre-check materials    | NOT RUN                                                  | EA-36: Production read-only pre-check SQL prepared (Section 2.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Data loss risk if non-null values exist          | Must verify production columns before deploy                             | DBA / Release engineer | Production query confirms 0 non-null values; backup + restore test passed                                                                                              |
| 17  | Backup/restore and rollback gap analysis       | PASS (staging)                                           | EA-26/32A/32B/33/34: Isolated DB backup/restore (PASS), post-restore permissions rebuild (PASS), app version switch/rollback (PASS), DB schema incompatibility recovery (PASS), real business operation verification (PASS)                                                                                                                                                                                                                                                                                                                                                                                                          | Recovery capability                              | Must complete before deploy                                              | DBA / Ops              | Staging backup/restore and rollback verified; production backup/restore drill NOT RUN                                                                                  |
| 18  | Image digest reproducibility decision          | APPROVAL REQUIRED                                        | EA-36: Source reproducible (PASS), app files consistent (PASS), 18 layers consistent (PASS), build metadata differs (BuildKit Ref + CreatedAt). Risk level LOW.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Audit traceability; no functional impact         | Accept risk (Option A) or fix build metadata (Option B)                  | Build/Release engineer | Obtain written risk acceptance from approver (Option A) or implement build metadata fix (Option B)                                                                     |

## 10.7 EA-35A release approval evidence consolidation (2026-10-24)

**已通过项目（staging/ceshi 证据，非生产验证）：**

- Magic Link E2E（EA-34）✅ — 公网域实测
- Server Action Key 兼容性机制（EA-25~30/33）✅ — 容器级实测
- Migration 51 隔离数据库验证（EA-26/32A/32B）✅ — 备份恢复+权限重建+RLS
- 跨租户 RLS（EA-14）✅ — BB 租户 0 行
- 上传/下载 capability-URL（EA-14/17）✅ — SHA256 验证
- 隧道 HTTP/2 稳定性（EA-15）✅ — 30 分钟 118/118
- Gateway 自恢复（EA-15）✅ — 5 次 crash 注入
- Host-header 修复（EA-16）✅ — 已部署 ceshi

**未完成项目（不能以 staging 证据代替生产验证）：**

1. 生产 migration 51 前置检查 — **NOT RUN**（需生产数据预检查）
2. 生产备份恢复与完整部署回滚验收 — **NOT RUN / PARTIAL**（staging 已验证，生产未验证）
3. 镜像 digest 可复现性 — **APPROVAL REQUIRED**（无明确政策要求 bit-for-bit）

**发布状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

## 10.8 EA-35B "设置"灰色 & 中文语言选择问题（2026-10-24）

- **根因：** 租户 `enabled_languages = ["en"]`（仅英文），中文未在租户语言设置中启用；超级管理员无租户成员身份导致语言选择器按设计禁用。
- **详细报告：** `docs/ea35-settings-language-investigation.md`
- **修复方案：** 通过 `/admin/settings` → Languages → 勾选 "Simplified Chinese"（租户配置变更，无需代码修改）。
- **代码中中文支持完整：** `SUPPORTED_LOCALES` 包含 zh，`zh.json` 翻译文件存在且覆盖测试通过。

## 10.9 EA-36 Release Readiness Review（2026-10-24）

**完整报告：** `docs/ea36-release-readiness-review.md`

### 已通过项目（staging/ceshi 证据，非生产验证）

- Magic Link E2E（EA-34）✅
- Server Action Key 兼容性（EA-25~30/33）✅
- Migration 51 隔离数据库验证（EA-26/32A/32B）✅
- 跨租户 RLS（EA-14）✅
- 上传/下载 capability-URL（EA-14/17）✅
- 隧道 HTTP/2 稳定性（EA-15）✅
- Gateway 自恢复（EA-15）✅
- Host-header 修复（EA-16）✅

### 未完成项目（不能以 staging 证据代替生产验证）

1. 生产 migration 51 前置检查 — **NOT RUN**
2. 生产备份恢复与完整部署回滚验收 — **NOT RUN / PARTIAL**
3. 镜像 digest 可复现性 — **APPROVAL REQUIRED**

### 剩余发布阻断项

| #   | 项目                              | 状态              | 阻断                     |
| --- | --------------------------------- | ----------------- | ------------------------ |
| 1   | Migration 51 production pre-check | NOT RUN           | BLOCKING                 |
| 2   | Production backup & restore drill | NOT RUN           | BLOCKING                 |
| 3   | Production rollback drill         | NOT RUN           | BLOCKING                 |
| 4   | Image digest reproducibility      | APPROVAL REQUIRED | POLICY DECISION REQUIRED |

### 下一步行动（需生产访问授权）

1. 生产 migration 51 预检查（运行 Section 2.2 SQL，确认 0 非空值）。
2. 生产备份验证（确认备份可恢复）。
3. 生产部署 + 回滚演练（staging 已验证，生产未验证）。
4. 审批人签署镜像 digest 可复现性风险接受书（Option A）或确认 Option B/C。

### 发布状态

`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

## 10.10 EA-37 Production Readiness Authorization Plan（2026-10-25）

**完整报告：** `docs/ea37-production-readiness-plan.md`

### 工作一：生产 migration 51 检查准备

- **SQL 脚本：** Section 1.2（3 个检查，只读权限，结果留档格式，通过/停止条件）
- **权限：** Read-only (beaconhs_migrator role 或 pg_read_only)
- **结果格式：** 表格记录 check_name, total_rows, non_null_rows, null_rows, pass/fail, timestamp, executor, notes
- **通过条件：** 所有检查 non_null_rows = 0
- **停止条件：** 任何检查 non_null_rows > 0 → 禁止部署

### 工作二：备份恢复验收准备

- **数据库备份对象：** dump + .sha256 + .manifest.tsv
- **对象存储备份对象：** backup.manifest.json.enc, backup.hmac, objects/*.age, checkpoint.json.enc
- **恢复目标：** Disposable staging DB (`beaconhs_restore_<timestamp>_<pid>`) + 新 bucket
- **完整性检查：** SHA256 match, manifest metrics match, row counts match, RLS policies match
- **业务验证：** Migration version, RLS enabled, beaconhs_app 可读, 对象访问
- **权限重建：** `pnpm db:migrate`（必需步骤）
- **迁移前向性：** Migration 51 是仅前向迁移，不能假设存在自动 schema 回滚

### 工作三：完整回滚验收准备

- **镜像：** Pre-release (EA-13) vs Candidate (EA-16)，digest, Server Action Key (K1)
- **验证步骤：**
  - Readiness: `/api/health/ready` → 200
  - Version: version SHA matches deployed image
  - Login: Magic Link / Password
  - Server Actions: forgot-password
  - File upload/download: PNG upload, SHA256 match
  - RLS verification: row_security = ON, tenant isolation
  - Data integrity: no data loss, no cross-tenant leak
  - Error rate: 5xx < 1%
- **回滚策略：** App rollback (image switch) vs DB restore (备份恢复)
  - App rollback only: 如果 migration 51 未应用
  - DB restore + app rollback: 如果 migration 51 导致数据丢失
  - DB restore only: 如果 DB schema ahead of 所有镜像
- **执行人/证据/停止条件：** 每个回滚步骤详细记录

### 工作四：镜像政策审批准备

- **可复现部分：** Source code byte-identical, app files byte-identical, first 10 layers byte-identical, Build ID deterministic
- **不可复现部分：** Image manifest digest, BuildKit build identity metadata (Ref + CreatedAt)
- **根因：** BuildKit 0.38.1 build reference 随机，CreatedAt 不受 SOURCE_DATE_EPOCH 控制
- **影响评估：** 功能影响 NONE，审计影响 blocker（如果要求 bit-for-bit），风险等级 LOW
- **决策选项：**
  - Option A（推荐）：接受已知差异，签署风险接受书
  - Option B：继续解决可复现性，实现 BuildKit 配置更改
  - Option C：不部署，继续解决直到可复现

### 工作五：授权清单

| 角色               | 生产访问 | 变更窗口 | 备份确认 | 审批签字 |
| ------------------ | -------- | -------- | -------- | -------- |
| DBA                | ✅ Yes   | ✅ Yes   | ✅ Yes   | ✅ Yes   |
| Ops                | ✅ Yes   | ✅ Yes   | ✅ Yes   | ✅ Yes   |
| Technical Approver | ❌ No    | ❌ No    | ❌ No    | ✅ Yes   |
| Release Engineer   | ❌ No    | ❌ No    | ❌ No    | ✅ Yes   |

### 下一步行动（需授权）

1. **DBA：** 运行 migration 51 pre-check SQL，记录结果，签署审批签字
2. **Ops：** 验证生产备份和恢复，确认维护窗口和负责人，签署审批签字
3. **Technical Approver：** 审查所有文档，签署审批签字
4. **Release Engineer：** 确认所有前置检查项已满足，签署审批签字
5. **Approver：** 做出镜像 digest 可复现性决策（Option A/B/C）

### 发布状态

`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

## 10.11 EA-38 Release Decision Record（2026-10-25）

**完整报告：** `docs/ea38-release-decision-record.md`

### 工作一：EA-37 计划验证

- **镜像 tag、完整 digest、migration 51 名称、Server Action Key 兼容性策略、备份路径和恢复步骤：** 全部一致 ✅
- **migration 51 前向性：** 确认仅前向迁移，不能假设存在自动 schema 回滚 ✅
- **`pg_restore --no-privileges` + `pnpm db:migrate`：** 确认必需步骤 ✅
- **数据库与对象存储恢复一致性：** 确认完整性检查 ✅
- **Server Action Key 对应关系：** Same key = compatible, different key = incompatible ✅
- **Readiness/登录/业务操作/文件上传下载/RLS/5xx 阈值监测：** 确认监测方式、责任人、停止条件 ✅

### 工作二：回滚方案安全性检查

- **migration 51 应用前后的 schema 状态及旧镜像兼容性：** 确认 app rollback alone 不足 ✅
- **仅前向迁移发生数据丢失时的恢复步骤：** 确认完整恢复流程（停止→恢复 DB→重建 grants→恢复对象存储→启动→验证）✅
- **`pnpm db:migrate` 前置条件：** 确认所有必需条件（MIGRATION_DATABASE_URL, DATABASE_URL, SUPERADMIN_DATABASE_URL, beaconhs_owner role, KEEP_RESTORE_DB=true）✅
- **数据库与对象存储恢复时间点一致性：** 确认完整性检查 ✅
- **Server Action Key 对应关系：** 确认 same key = compatible, different key = incompatible ✅
- **监测方式/责任人/停止规则：** 确认所有监测步骤和停止条件 ✅

### 工作三：镜像可复现性决策

- **Option A（接受已知差异）：** 风险 LOW，签署风险接受书，决策权归属 Technical Approver 或 Release Engineer
- **Option B（继续整改）：** 风险 MEDIUM，实现 BuildKit 配置更改，决策权归属 Technical Approver 或 Release Engineer
- **Option C（不部署）：** 风险 HIGH，继续解决直到可复现，决策权归属 Technical Approver 或 Release Engineer
- **决策状态：** `PENDING APPROVAL — NOT DECIDED`
- **证据：** EA-19 to EA-23 build evidence, reproducible vs non-reproducible breakdown, root cause analysis, impact assessment

### 工作四：生产变更授权清单

| 角色               | 生产访问 | 变更窗口 | 备份确认 | 审批签字 | 状态        |
| ------------------ | -------- | -------- | -------- | -------- | ----------- |
| DBA                | ✅ Yes   | ✅ Yes   | ✅ Yes   | ✅ Yes   | **PENDING** |
| Ops                | ✅ Yes   | ✅ Yes   | ✅ Yes   | ✅ Yes   | **PENDING** |
| Technical Approver | ❌ No    | ❌ No    | ❌ No    | ✅ Yes   | **PENDING** |
| Release Engineer   | ❌ No    | ❌ No    | ❌ No    | ✅ Yes   | **PENDING** |

### 工作五：文档更新

- `docs/ea38-release-decision-record.md` — 新增
- `docs/release-approval-checklist.md` — 更新
- `docs/project-development-state.md` — 更新

### 已关闭事项

- ✅ EA-37 计划与现有文档完全一致
- ✅ 回滚方案安全，不描述 app rollback 为自动恢复已删除列
- ✅ 镜像可复现性证据已编译，决策选项已准备
- ✅ 授权清单已完成

### 尚未执行的生产检查和演练

- ❌ 生产 migration 51 pre-check (NOT RUN)
- ❌ 生产备份恢复演练 (NOT RUN)
- ❌ 生产回滚演练 (NOT RUN)

### 镜像可复现性审批结果

- **状态：** `PENDING APPROVAL — NOT DECIDED`
- **决策选项：** Option A (接受已知差异), Option B (继续整改), Option C (不部署)
- **决策权归属：** Technical Approver 或 Release Engineer
- **所需：** 书面确认（签字或邮件）

### 进入生产变更窗口前仍缺少的授权

1. DBA: 运行 migration 51 pre-check SQL，记录结果，签署审批签字
2. Ops: 验证生产备份和恢复，确认维护窗口和负责人，签署审批签字
3. Technical Approver: 审查所有文档，签署审批签字，做出镜像可复现性决策 (Option A/B/C)
4. Release Engineer: 验证所有前置检查项，签署审批签字，做出镜像可复现性决策 (Option A/B/C)

### 当前发布状态

`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

## 10.12 EA-39 Release Decision Closure and Pre-condition Verification（2026-10-25）

**完整报告：** `docs/ea39-release-decision-closure.md`

### 工作一：镜像可复现性决策核验

- **决策状态：** `PENDING APPROVAL — NOT DECIDED`
- **决策权归属：** Technical Approver 或 Release Engineer
- **决策选项：**
  - Option A（接受已知差异）：风险 LOW，需要书面风险接受书
  - Option B（继续整改）：风险 MEDIUM，需要确认 Option B
  - Option C（不部署）：风险 HIGH，需要确认 Option C
- **有效书面决策：** ❌ 未找到
- **证据：** EA-38 §3.1-3.7

### 工作二：生产前置条件证据状态核验

| #   | 项目                        | 状态           | 证据                                 | 责任角色                               | 关闭条件                                                 |
| --- | --------------------------- | -------------- | ------------------------------------ | -------------------------------------- | -------------------------------------------------------- |
| 1   | Migration 51 生产只读预检查 | ❌ NOT RUN     | No execution on production DB        | DBA                                    | Non_null_rows = 0 for all 3 columns                      |
| 2   | 生产数据库备份及恢复验证    | ❌ NOT RUN     | No restore test performed            | Ops                                    | Restore succeeds, no errors                              |
| 3   | 生产对象存储备份及恢复验证  | ❌ NOT RUN     | No restore test performed            | Ops                                    | Restore succeeds, integrity verified                     |
| 4   | 完整部署与回滚演练          | ❌ NOT RUN     | No production deployment or rollback | Ops                                    | Production deployment and rollback executed successfully |
| 5   | Technical Approver 技术审批 | ⚠️ PENDING     | Review completed, signature pending  | Technical Approver                     | Technical Approver signs off                             |
| 6   | Release Engineer 发布确认   | ⚠️ PENDING     | Review completed, signature pending  | Release Engineer                       | Release Engineer signs off                               |
| 7   | DBA 和 Ops 授权及签署       | ❌ PENDING     | No signature yet                     | DBA/Ops                                | DBA/Ops sign off                                         |
| 8   | 镜像可复现性政策决策        | ❌ NOT DECIDED | No written confirmation              | Technical Approver or Release Engineer | Approver signs risk acceptance or confirms Option B/C    |

**分类统计：**

- ✅ PASS: Staging deployment and rollback verified (2)
- ⚠️ PENDING: Review completed, signature pending (2)
- ❌ NOT RUN: Production pre-conditions not executed (5)
- ❌ NOT DECIDED: Image reproducibility decision not made (1)

### 工作三：Migration 51 预检查条件核对

- **SQL 一致性：** ✅ SQL 与 migration 51 完全一致（3 个 ALTER TABLE 语句）
- **停止条件：** ✅ 清晰定义（non_null_rows > 0 → 禁止部署）
- **通过条件：** ✅ 清晰定义（所有检查 non_null_rows = 0）
- **迁移版本检查：** ✅ 正确（使用 `current_setting('app.current_migration')`）

### 工作四：备份与回滚计划核对

- **应用镜像回滚：** ✅ 清晰定义（Same key = compatible, different key = incompatible）
- **Migration 51 数据库恢复：** ✅ 清晰定义（Disposable staging DB, `pg_restore --no-privileges`, `KEEP_RESTORE_DB=true`）
- **对象存储恢复：** ✅ 清晰定义（New bucket, `--overwrite` flag）
- **`pnpm db:migrate` 权限与 RLS 重建：** ✅ 清晰定义（Runtime grants, RLS policies, Migration ledger）
- **Server Action Key 兼容性：** ✅ 清晰定义
- **恢复后真实业务验证：** ✅ 清晰定义（Readiness, Login, Server Actions, File upload/download, RLS, Error rate）
- **数据库与对象存储备份时间点一致性：** ✅ 清晰定义（Manifest comparison, SHA256, row counts, RLS policies）
- **完整回滚演练：** ❌ NOT RUN（仅 staging 已验证，生产未验证）

### 工作五：最终状态表

**发布状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**已就绪：**

- ✅ EA-36/EA-37/EA-38/EA-39 全部完成
- ✅ Migration 51 预检查 SQL 已验证
- ✅ 备份与回滚计划已验证
- ✅ 所有文档已审查并一致
- ✅ Staging 部署和回滚已验证（PASS）

**未就绪：**

- ❌ Production migration 51 pre-check (NOT RUN)
- ❌ Production DB backup and restore drill (NOT RUN)
- ❌ Production object store backup and restore drill (NOT RUN)
- ❌ Complete deployment and rollback drill (NOT RUN)
- ⚠️ Technical Approver technical approval (PENDING)
- ⚠️ Release Engineer release confirmation (PENDING)
- ❌ DBA authorization and signature (PENDING)
- ❌ Ops authorization and signature (PENDING)
- ❌ Image reproducibility policy decision (NOT DECIDED)

**需要授权：**

1. **DBA：** 运行 migration 51 pre-check SQL，记录结果，签署审批签字
2. **Ops：** 验证生产备份和恢复，确认维护窗口和负责人，签署审批签字
3. **Technical Approver：** 审查所有文档，签署审批签字，做出镜像可复现性决策 (Option A/B/C)
4. **Release Engineer：** 验证所有前置检查项，签署审批签字，做出镜像可复现性决策 (Option A/B/C)

**下一步操作：**

1. **DBA：** 运行 migration 51 pre-check SQL，记录结果，签署审批签字
2. **Ops：** 验证生产备份和恢复，确认维护窗口和负责人，签署审批签字
3. **Technical Approver：** 审查所有文档，签署审批签字，做出镜像可复现性决策 (Option A/B/C)
4. **Release Engineer：** 验证所有前置检查项，签署审批签字，做出镜像可复现性决策 (Option A/B/C)

**停止条件：**

- 任何 migration 51 pre-check 失败（non_null_rows > 0）
- 任何备份/恢复测试失败
- 任何前置检查项未满足
- 发现任何未解决的缺陷
- Technical Approver 或 Release Engineer 不签署
- 镜像可复现性决策未做出（Option A/B/C）

## 10.13 EA-40 Approval Execution and Authorization Closure（2026-10-25）

**完整报告：** `docs/ea40-approval-execution-record.md`

### 工作一：执行前检查

- **文档审查：** ✅ EA-36/EA-37/EA-38/EA-39 全部完成并文档化
- **Git 状态：** ✅ 无新代码变更，所有修改均为 pre-existing
- **发布状态：** ✅ 与 EA-39 文档一致
- **重复测试：** ✅ EA-25 至 EA-39 的测试已有充分证据，无需重复执行

### 工作二：镜像可复现性决策核验

- **新书面审批记录：** ❌ 未找到
- **决策状态：** `PENDING APPROVAL — NOT DECIDED`
- **决策权归属：** Technical Approver 或 Release Engineer
- **决策选项：**
  - Option A（接受已知差异）：风险 LOW，需要书面风险接受书
  - Option B（继续整改）：风险 MEDIUM，需要确认 Option B
  - Option C（不部署）：风险 HIGH，需要确认 Option C
- **审计影响：** Option A（书面风险接受书接受），Option B（实现可复现性缓解），Option C（阻止发布）
- **结论：** ❌ **未获得有效的书面决策**

### 工作三：生产前置检查授权核验

- **DBA 授权：** ❌ **PENDING**（无签名）
  - Migration 51 pre-check SQL 准备完成，但未执行
  - 无书面授权确认
  - 需要 DBA 运行 SQL，记录结果，签署审批签字
- **Ops 授权：** ❌ **PENDING**（无签名）
  - 备份和恢复计划已文档化，但未验证
  - 无书面授权确认
  - 需要 Ops 验证备份和恢复，确认维护窗口和负责人，签署审批签字
- **生产访问要求：** ✅ DBA 和 Ops 均需要生产访问权限

### 工作四：审批记录核验

- **Technical Approver：** ⚠️ **PENDING**（review completed, signature pending）
  - Release readiness review completed ✅
  - 所有技术验证项 verified ✅
  - 但无签名
- **Release Engineer：** ⚠️ **PENDING**（review completed, signature pending）
  - Source snapshot archived ✅
  - Source reproducibility verified ✅
  - Image tag/digest/app version SHA verified ✅
  - Server Action Key file available ✅
  - 但无签名
- **DBA：** ❌ **PENDING**（no signature yet）
- **Ops：** ❌ **PENDING**（no signature yet）
- **结论：** ❌ 所有授权均未获得（无签名）

### 工作五：最终状态表

| #   | 项目                                                    | 状态           | 证据                                 | 责任角色                               | 关闭条件                                                 |
| --- | ------------------------------------------------------- | -------------- | ------------------------------------ | -------------------------------------- | -------------------------------------------------------- |
| 1   | Migration 51 production pre-check                       | ❌ NOT RUN     | No execution on production DB        | DBA                                    | Non_null_rows = 0 for all 3 columns                      |
| 2   | Production DB backup exists and is restorable           | ❌ NOT RUN     | No restore test performed            | Ops                                    | Restore succeeds, no errors                              |
| 3   | Production object store backup exists and is restorable | ❌ NOT RUN     | No restore test performed            | Ops                                    | Restore succeeds, integrity verified                     |
| 4   | Complete deployment and rollback drill                  | ❌ NOT RUN     | No production deployment or rollback | Ops                                    | Production deployment and rollback executed successfully |
| 5   | Technical Approver technical approval                   | ⚠️ PENDING     | Review completed, signature pending  | Technical Approver                     | Technical Approver signs off                             |
| 6   | Release Engineer release confirmation                   | ⚠️ PENDING     | Review completed, signature pending  | Release Engineer                       | Release Engineer signs off                               |
| 7   | DBA authorization and signature                         | ❌ PENDING     | No signature yet                     | DBA                                    | DBA runs SQL, records results, signs off                 |
| 8   | Ops authorization and signature                         | ❌ PENDING     | No signature yet                     | Ops                                    | Ops confirms all items, signs off                        |
| 9   | Image reproducibility policy decision                   | ❌ NOT DECIDED | No written confirmation              | Technical Approver or Release Engineer | Approver signs risk acceptance or confirms Option B/C    |

### 工作六：文档更新

- `docs/ea40-approval-execution-record.md` — 新增 ✅
- `docs/release-approval-checklist.md` — 更新 ✅
- `docs/project-development-state.md` — 更新 ✅

### 技术验证通过项（10 项）

- ✅ Magic Link E2E
- ✅ Server Action Key compatibility
- ✅ Migration 51 backup/restore (staging)
- ✅ Cross-tenant RLS
- ✅ File upload/download
- ✅ Tunnel stability
- ✅ Gateway self-heal
- ✅ Real business operations (staging)
- ✅ Application rollback (staging)
- ✅ Rollback plan safety

### Staging 已验证项（10 项）

- ✅ Staging deployment (EA-26/32A/32B)
- ✅ Staging rollback (EA-33)
- ✅ Migration 51 pre-check SQL verification
- ✅ Backup and rollback plan verification
- ✅ All documentation completed
- ✅ No unaddressed defects found

### 未授权但已准备事项（4 项）

- ❌ Production migration 51 pre-check (NOT RUN — SQL prepared, no authorization yet)
- ❌ Production DB backup and restore drill (NOT RUN — plan documented, no authorization yet)
- ❌ Production object store backup and restore drill (NOT RUN — plan documented, no authorization yet)
- ❌ Complete deployment and rollback drill (NOT RUN — plan documented, no authorization yet)

### Staging/ceshi/Local 已验证项（10 项）

- ✅ Staging deployment (EA-26/32A/32B)
- ✅ Staging rollback (EA-33)
- ✅ Magic Link E2E (EA-34)
- ✅ Server Action Key compatibility (EA-25~30/33)
- ✅ Cross-tenant RLS (EA-14)
- ✅ File upload/download (EA-14/17)
- ✅ Tunnel stability (EA-15)
- ✅ Gateway self-heal (EA-15)
- ✅ Real business operations (EA-34)
- ✅ Migration 51 pre-check SQL verification

### 仍需审批的政策决策项（1 项）

- ❌ Image reproducibility policy decision
  - **决策要求：** Option A/B/C with written confirmation
  - **决策权归属：** Technical Approver 或 Release Engineer
  - **所需：** 书面确认（签字或邮件）

### 未关闭的发布阻断项（9 项）

1. Production migration 51 pre-check (BLOCKING)
2. Production DB backup and restore drill (BLOCKING)
3. Production object store backup and restore drill (BLOCKING)
4. Complete deployment and rollback drill (BLOCKING)
5. Technical Approver technical approval (BLOCKING)
6. Release Engineer release confirmation (BLOCKING)
7. DBA authorization and signature (BLOCKING)
8. Ops authorization and signature (BLOCKING)
9. Image reproducibility policy decision (POLICY DECISION REQUIRED)

### 当前发布状态

`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**EA-41 status:** Status classification contradictions fixed. No new code changes. All EA-36 to EA-39 completed. Technical verification passed in Staging/ceshi/Local. Production pre-conditions not executed. Authorization items pending. Image reproducibility policy decision not made.

### 10.14 EA-42 Reproducible Build Fix（2026-10-26）

**完整报告：** `docs/ea42-reproducible-build-report.md`

### 工作一：执行前检查

- **文档审查：** ✅ EA-36 release readiness review 已完成
- **Git 状态：** ✅ 无新代码变更，所有修改均为 pre-existing
- **DEPLOYMENT_VERSION 配置：** ✅ 存在（apps/web/src/lib/app-version.ts, apps/web/next.config.ts）
- **Dockerfile frontend：** ✅ docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
- **构建工具：** ✅ Docker 29.9.2, Buildx 0.38.1
- **源码快照：** ✅ HEAD `51a899b7` (no snapshot checkout)
- **基础镜像 digest：** ✅ sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5

### 工作二：定位差异

- **EA-19~23 实验结果：**
  - Source reproducible: PASS
  - Source code byte-identical: PASS
  - First 10 image layers byte-identical: PASS
  - Build ID deterministic: PASS
  - Image digest reproducibility: NOT VERIFIED
- **差异根因：** BuildKit build identity metadata differs (`/Identity/Build[0]/Ref` and `/Identity/Build[0]/CreatedAt`)

### 工作三：实验 A（固定构建时间）

- **SOURCE_DATE_EPOCH：** 1729728000 (2024-10-24T00:00:00Z)
- **Image 1：** beaconhs:ea42-exp1-20261026-064516, digest: sha256:0f2a69c06f600436c395dfefa6fc78120a9d5a09d45f519301f3372e6aa1a56c
- **Image 2：** beaconhs:ea42-exp2-20261026-065040, digest: sha256:33cd283e461ec35557578c84c1dea37ce9d45128dcb3ce79422a729710c4d5c6
- **Layers：** 18 layers 100% identical
- **Size：** 2,869,365,148 bytes (100% identical)
- **Image Created：** 2024-10-24T00:00:00Z (100% identical)
- **Manifest digest：** Different (BuildKit build identity metadata differs)

### 工作四：实验 B/C（未执行）

- **实验 B（BuildKit provenance）：** ❌ 未执行（冗余）
- **实验 C（构建器检查）：** ❌ 未执行（已确认版本一致）

### 工作五：验证标准

- ✅ 源码快照及其 SHA-256 清单
- ✅ 完整构建命令与非敏感参数
- ✅ 构建器、frontend、基础镜像及依赖版本
- ✅ 两次构建的完整镜像 digest
- ✅ manifest、config、layers 逐项比较
- ✅ 应用文件一致性及质量门禁结果

### 工作六：文档更新

- ✅ `docs/ea42-reproducible-build-report.md` 添加
- ✅ `docs/release-approval-checklist.md` 更新
- ✅ `docs/project-development-state.md` 更新

### 关键发现

- ✅ Source code, application files, image layers are 100% reproducible
- ✅ Image Created field is fixed by SOURCE_DATE_EPOCH
- ❌ Manifest digest is NOT reproducible (BuildKit build identity metadata differs)
- ✅ Layers: 18 layers 100% identical
- ✅ Size: 2,869,365,148 bytes 100% identical

### 根因

BuildKit build identity metadata (`/Identity/Build[0]/Ref` and `/Identity/Build[0]/CreatedAt`) 是非确定性的，即使使用 `SOURCE_DATE_EPOCH` 也会不同。Docker manifest digest 包含这些元数据，因此 manifest digest 是非确定性的。

### 结论

**状态：** ❌ **NOT REPRODUCIBLE (bit-for-bit)**

**推荐选项：** **Option A（接受已知差异）**

- 风险等级：LOW
- 保留 source code、application files、image layers 的可复现性
- 审计团队接受 manifest digest 差异是 BuildKit 固有行为

### 未解决问题

- Manifest digest 是非确定性的（BuildKit build identity metadata）
- 需要签署书面风险接受书（Option A）

### 10.15 EA-43 BuildKit Provenance Investigation and Risk Acceptance Draft（2026-10-26）

**完整报告：** `docs/ea43-provenance-investigation-report.md`
**风险接受草案：** `docs/ea43-image-reproducibility-risk-acceptance.md`

### 阶段 1：工作区和历史证据检查

- **工作区状态：** ✅ Branch `hse-platform`, HEAD `51a899b7`, 165 modified files, empty staging
- **EA-42 证据缺口：** 🔴 Revision 1 记录为 EVIDENCE GAP — **EA-44 已闭合**（`docs/evidence/ea44/`）

### 阶段 2：独立实验环境

- **固定输入：** ✅ 确认（HEAD `51a899b7`, 基础镜像 digest, Dockerfile frontend 1.7, 构建工具版本）
- **实验基线：** 🔴 Revision 1 未建立实验镜像；**EA-44 已用 `--no-cache` 探针补齐**（A/B 各 2 次）

### 阶段 3：Provenance 差异实验

- ~~**默认 provenance 行为：** ✅ VERIFIED — BuildKit 默认不生成 provenance（未使用 `--attest` 标志）~~
  🔴 **错误（EA-44 更正）：** 默认构建**会**生成 SLSA provenance v1 attestation，`--attest` 只是自定义开关
- ~~**显式 provenance 配置：** ❌ NOT EXECUTED — 基于EA-42结论，manifest digest 差异来自 build identity metadata~~
  ✅ **EA-44 已执行：** `--provenance=false` 两次独立构建 index digest 完全相同（`sha256:141e5a28…`）
- ~~**BuildKit build identity metadata：** ❌ NOT DETERMINISTIC — `/Identity/Build[0]/Ref` 和 `/Identity/Build[0]/CreatedAt` 是非确定性的~~
  🔴 **错误（EA-44 更正）：** 二者是 Docker 本地 image-store 记账字段，不在任何 OCI 对象内，**不参与任何 digest**
- ~~**Provenance 对 digest 的影响：** ⚠️ PARTIAL (EVIDENCE GAP) — 无法确认（缺少原始 JSON 证据）~~
  ✅ **EA-44 已确认：** provenance 是 index digest 唯一的非确定输入

### 阶段 4：评估 Option A 是否可接受

- **风险接受草案：** ✅ CREATED — `docs/ea43-image-reproducibility-risk-acceptance.md`
- **补偿控制措施：** ✅ IDENTIFIED — 6大类补偿措施（构建追溯、镜像身份、签名验证、部署、回滚、审计轨迹）
- **Option A 决策边界：** ✅ DOCUMENTED — 明确声明草案不构成风险接受或生产发布批准

### 阶段 5：更新发布审批材料

- **新增文档：** ✅ `docs/ea43-provenance-investigation-report.md`, `docs/ea43-image-reproducibility-risk-acceptance.md`
- **修改文档：** `docs/release-approval-checklist.md`, `docs/project-development-state.md`

### 阶段 6：质量检查

- ✅ Markdown 格式正确
- ✅ 链接与引用路径正确
- ✅ digest 和实验标签准确
- ✅ 结果与原始证据一致
- ✅ 未错误宣称生产验证或风险批准
- ✅ 未包含秘密
- ✅ 未改变其他阶段文档的历史结论
- ✅ Git diff 只包含本阶段预期修改

### 关键发现

**Provenance 结论（Revision 2，EA-44）：**

- ✅ **LAYERS REPRODUCIBLE:** 18 layers 100% byte-identical
- ✅ **PROVENANCE EFFECT IDENTIFIED:** 默认构建即生成 SLSA provenance v1；其 `startedOn`/`finishedOn`/`invocationId`/`subject.name` 是 index digest 唯一的非确定输入
- ❌ **BIT-FOR-BIT REPRODUCIBILITY NOT ACHIEVED:** index digest 在默认参数下不可复现（但 image manifest digest 可复现）
- ✅ **EVIDENCE GAP CLOSED:** 原始 OCI JSON 已保存至 `docs/evidence/ea44/`

**可复现性结论（Revision 2）：**

- ✅ **LAYERS REPRODUCIBLE:** 18 layers 100% byte-identical
- ✅ **APPLICATION FILES REPRODUCIBLE:** Source code、application files、config 逐字节相同
- ✅ **IMAGE MANIFEST REPRODUCIBLE:** `sha256:6b255d15…`，且跨 tag 可复现
- ❌ **IMAGE INDEX DIGEST NOT REPRODUCIBLE:** 唯一原因是 provenance attestation

**Option A 风险接受草案状态:**

- ✅ **DRAFT CREATED:** `docs/ea43-image-reproducibility-risk-acceptance.md`（Revision 2）
- ⚠️ **PENDING SIGNATURE:** Technical Approver、Release Engineer、DBA、Ops、Audit 均未签署
- ⚠️ **风险等级未填:** Revision 1 曾预填 LOW，Revision 2 已移除

### 未解决问题

- index digest 在默认构建下非确定（当前工具链未找到保留 provenance 的确定化选项）
- 按 image manifest digest 部署/回滚的可行性未验证（`PROPOSED — NOT VERIFIED`）
- Option A 风险接受草案需要审批人签署
- EA-16 候选镜像未使用 `SOURCE_DATE_EPOCH`，自身不具备可复现构建属性

### 证据缺口（剩余）

1. EA-42 构建日志未保存 → 两次构建是否冷构建 `NOT VERIFIED`
2. 未在真实应用镜像上做 `--no-cache` 可复现实验（仅探针层面验证）
3. 无 registry 访问 → 外部 attestation 副本 `NOT VERIFIED`

### 发布阻断项（保持不变）

9 个发布阻断项仍然存在（基于 EA-41）：

1. Migration 51 production pre-check (BLOCKING)
2. Production DB backup and restore drill (BLOCKING)
3. Production object store backup and restore drill (BLOCKING)
4. Complete deployment and rollback drill (BLOCKING)
5. Technical Approver technical approval (BLOCKING)
6. Release Engineer release confirmation (BLOCKING)
7. DBA authorization and signature (BLOCKING)
8. Ops authorization and signature (BLOCKING)
9. Image reproducibility policy decision (POLICY DECISION REQUIRED)

### 安全边界确认

- ✅ No production database access
- ✅ No production SQL execution
- ✅ No production deployment execution
- ✅ No production rollback execution
- ✅ No ceshi modification
- ✅ No overwriting existing images
- ✅ No destructive Git operations
- ✅ No commits, pushes, or PRs
- ✅ WOPI remains paused

### 最终判定

**当前状态:**
`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**技术结论（Revision 2，EA-44）:**
⚠️ **PARTIAL — LAYERS REPRODUCIBLE** + **PARTIAL — PROVENANCE EFFECT IDENTIFIED**

- ✅ Source code: 100% byte-identical
- ✅ Application files: 100% byte-identical
- ✅ Image layers: 100% byte-identical (18 layers)
- ✅ Image Created field: 100% identical (`SOURCE_DATE_EPOCH`)
- ✅ Image size: 100% identical (2,869,365,148 bytes)
- ✅ Image manifest digest: identical (`sha256:6b255d15…`)，跨 tag 亦可复现
- ❌ Image index digest: Different（唯一原因是 provenance attestation）

**推荐方案:** Option A（接受已知差异）with compensation controls

**下一步操作:**

1. Technical Approver 和 Release Engineer 审查并签署 Option A 风险接受草案
2. DBA 运行 migration 51 pre-check SQL on production DB，记录结果，签署审批签字
3. Ops 验证生产备份和恢复，确认维护窗口和负责人，签署审批签字

### 10.16 EA-44 Image Reproducibility Evidence Recovery and Provenance Verification（2026-10-26）

**完整报告：** `docs/ea44-provenance-evidence-report.md`
**原始证据：** `docs/evidence/ea44/`（33 个文件，`sha256sum -c` 全部通过）

#### 阶段 1：执行前状态

- Branch `hse-platform`, HEAD `51a899b7`, 165 修改 + 497 未跟踪条目, 暂存区空
- Docker 29.9.2 / Buildx v0.38.1 / BuildKit v0.34.0 / containerd image store

#### 阶段 2：原始证据补齐

- ✅ **EA-42 镜像仍存在且 digest 与报告一致** → 只读提取，未重建
- ✅ 提取 index / manifest / config / 18 层 / attestation manifest / SLSA provenance
- ✅ **EVIDENCE GAP CLOSED**

#### 阶段 3：构建输入确认

- ✅ frontend `a57df69d…`、base image `cb4e8f7c…`、`vcs:revision` `51a899b7…`（来自 provenance）
- ⚠️ EA-42 构建缓存状态未保存 → 冷构建属性 `NOT VERIFIED`

#### 阶段 4：最小化 provenance 实验

| 组  | 配置                                    | 结果                                                            |
| --- | --------------------------------------- | --------------------------------------------------------------- |
| A   | 默认 provenance，2 次 `--no-cache`      | index `6313fe79…` vs `6e37f789…` ❌；manifest 均 `141e5a28…` ✅ |
| B   | `--provenance=false`，2 次 `--no-cache` | index 均 `141e5a28…` ✅ **相同**                                |
| C   | 改变导出方式                            | `NOT RUN`（A/B 已足够）                                         |

#### 阶段 5：判定

- `PARTIAL — LAYERS REPRODUCIBLE` ✅
- `PARTIAL — PROVENANCE EFFECT IDENTIFIED` ✅
- `PASS — BIT-FOR-BIT`（default）❌
- `FAIL — REPRODUCIBILITY REGRESSION` ❌ 无

#### 关键结论

- ✅ **应用内容可复现**：18 层 + config + image manifest 逐字节相同，跨 tag 亦然
- ✅ **index digest 差异的唯一原因是 provenance**（4 个字段：`startedOn`、`finishedOn`、`invocationId`、`subject.name`）
- ✅ `SOURCE_DATE_EPOCH` **不约束** provenance 时间戳
- ❌ 当前工具链未找到"保留 provenance 且 index 可复现"的受支持选项
- ⚠️ `subject.name` 内嵌 tag → 同一内容不同 tag 也会产生不同 index digest
- ⚠️ **EA-16 候选镜像未使用 `SOURCE_DATE_EPOCH`**，自身不具备可复现构建属性

#### 更正的技术错误（EA-42/EA-43 Revision 1）

| 原陈述                                         | 更正                                                    |
| ---------------------------------------------- | ------------------------------------------------------- |
| "默认不生成 provenance"                        | 默认**会**生成                                          |
| "差异来自 `Identity.Build[0].Ref`/`CreatedAt`" | 那是 Docker 本地记账，不参与 digest                     |
| "manifest digest 不可复现"                     | image manifest digest **可复现**；index digest 不可复现 |
| "BuildKit 固有、无法修复"                      | 应表述为"当前工具链未找到确定化选项"                    |

#### 发布阻断项（未变）

9 项全部保持不变；EA-44 仅提升第 9 项的**技术输入质量**，未改变其待决策状态。

#### 安全边界

- ✅ 未访问生产 / 未改动 ceshi / 未覆盖任何既有镜像
- ✅ 未删除任何资源 / 未执行破坏性 Git / 未提交 / 未推送
- ✅ 未代替审批人签字 / 未把推荐写成批准 / WOPI 保持暂停

### 10.17 EA-45 Candidate Reproducibility and Deployment Identity Verification（2026-10-26）

**完整报告：** `docs/ea45-candidate-reproducibility-report.md`
**原始证据：** `docs/evidence/ea45/`（26 个文件，`sha256sum -c` 退出码 0）
**状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

#### 阶段 1–2：工作区与 EA-44 清单

- Branch `hse-platform`, HEAD `51a899b7`, 165 modified + 499 untracked, 暂存区空
- ✅ `docs/evidence/ea44/SHA256SUMS` 33/33 通过
- ⚠️ 任务描述中的 `nested-index-exp*.json` 实际位于 `historical-ea42/`（描述偏差，非证据缺失）

#### 阶段 3：EA-16 构建输入

- ✅ 身份完整：index `17126c6e…`、manifest `43a7dc27…`、config `7e6139af…`、attestation `0f7e823e…`、provenance `15358431…`、18 层 / 578,043,276 B
- ❌ **严格复现不可能**：脏工作区构建；快照仅存 3 个变更文件；**无构建日志**
- ❌ **构建输入已漂移**：`turbo.json` 于 `2026-10-23T11:04`（构建后 5h32m）把 `DEPLOYMENT_VERSION` 加入 `globalEnv`
  → EA-16 镜像**无 `deploymentId`**、build id 为 `T79KItdA9zMY3BiGlR7x1`（随机）；
  → 2026-10-26 构建**有** `deploymentId=51a899b7…`、build id 为 `build-TfctsWXpff2fKS`（确定）
  → 造成 46 个 chunk 重命名、1 653/8 658 个文件内容不同

#### 阶段 4：四次独立构建（全部 `--no-cache`）

| 组  | Tag                     | SDE        | Index       | Manifest    | 层字节      |
| --- | ----------------------- | ---------- | ----------- | ----------- | ----------- |
| A1  | `beaconhs:ea45-repro-1` | —          | `9b2156ac…` | `be54cfce…` | 578,133,721 |
| A2  | `beaconhs:ea45-repro-2` | —          | `d76edbad…` | `8d9813e4…` | 578,143,907 |
| B1  | `beaconhs:ea45-sde-1`   | 1729728000 | `ad6266ce…` | `9142bb14…` | 578,134,447 |
| B2  | `beaconhs:ea45-sde-2`   | 1729728000 | `80ac7a1a…` | `20fa0a57…` | 578,138,109 |

#### 阶段 5：判定

- `FAIL — LAYERS REPRODUCIBLE`：每次 10/18 层不同，差异层集合恒为 6、7、9–16
- `FAIL — MANIFEST REPRODUCIBLE`：四次四个不同 digest
- `FAIL — INDEX REPRODUCIBLE`
- `PARTIAL — SOURCE_DATE_EPOCH`：只固定 config `created` 与 history 时间戳
- `PASS — CONTENT ATTRIBUTION`：无应用源码 / chunk / 依赖二进制差异
- `PASS — DEPLOYMENT PINNING (process)`：`deploy-dev.yml:39` 取 `build-push-action` 的 digest，runbook 只用 `IMAGE@sha256:…`
- `FAIL — REBUILD-VERIFIES-DIGEST`：部署固定 index digest，而它不可复现

#### 发现的缺陷

| ID     | 缺陷                                                   | 状态                                                             |
| ------ | ------------------------------------------------------ | ---------------------------------------------------------------- |
| EA45-1 | `.playwright-mcp/`（63 个文件）不在 `.dockerignore` 中 | 未修复（构建上下文变更，需独立评估）                             |
| EA45-2 | 本文件曾有两个 `## 11` 标题                            | ✅ 已修复（`## 11. Approval status` → `## 12. Approval status`） |
| EA45-3 | 镜像无 SBOM attestation（仅 provenance）               | 未修复                                                           |
| EA45-4 | buildx v0.38.1 无 `--rewrite-timestamp`                | 未修复（工具链能力限制）                                         |
| EA45-5 | Next.js 每次构建随机生成 3 个 preview-mode 密钥        | 未修复                                                           |

#### 与 EA-44 的关系

EA-44 的 `PARTIAL — LAYERS REPRODUCIBLE` 与"image manifest digest 可复现"
**均已撤回**：那是 EA-42 缓存命中的产物，非可复现性。

#### 质量门禁（文档改动）

- `format:check` 0 / `typecheck` 0 / `lint` 0 / `deadcode:check` 0 / `build` 0
- `pnpm test` 默认并行 **1**（`jobs`/`storage`/`db` 在本机并发负载下超时或 `EPIPE`；均为既有未提交改动，单包运行全部通过）
- `turbo run test --concurrency=1` **0**（25/25）

#### 安全边界

- ✅ 未访问生产 / 未改动 ceshi / 未覆盖或删除任何既有镜像
- ✅ 未删除任何资源 / 未执行破坏性 Git / 未提交 / 未推送
- ✅ 未修改业务代码、schema、权限模型、Role Scope、RLS
- ✅ 未泄漏 Server Action Key（证据目录中指纹出现次数 0）
- ✅ 未禁用 provenance / SBOM / 签名换取 digest 相等
- ✅ 未代替审批人签字 / 未把推荐写成批准 / WOPI 保持暂停

### 10.18 EA-46 Image Determinism Root-Cause Remediation and Supply-Chain Verification（2026-10-26）

**完整报告：** `docs/ea46-image-determinism-investigation.md`
**原始证据：** `docs/evidence/ea46/`（`sha256sum -c SHA256SUMS` 退出码 0）
**状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

#### 阶段 1：EA-45 证据复核

- ✅ 26/26 SHA-256 通过；四次构建身份与台账逐位一致；层差异矩阵复算一致
- ✅ **EA-42「两次构建层完全相同」被证明是缓存复用**：0 层差异 + 层 6 含毫秒时间戳文件名的 npm 日志

#### 阶段 2：三处 EA-45 结论更正

| 原文                                   | 更正                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| buildx 无 `--rewrite-timestamp`        | 该能力是 **exporter 属性**：`--output type=…,rewrite-timestamp=true` + `SOURCE_DATE_EPOCH`，实测可完全固定层 |
| 层 7 = 架构断言、层 8 = `ENV`          | 层 7 = `WORKDIR /app`；层 8 = 32 字节空层                                                                    |
| `is-docker=true` 导致 preview 密钥随机 | BuildKit 内 `is-docker=false`；真实原因是 `.next/cache/.previewinfo` 从不跨构建保留                          |

#### 阶段 3：构建上下文（`.playwright-mcp`）

- ✅ 真实 `.dockerignore` 下：**464 个文件 / 3,423,084 B 进入上下文**（537 − 73 个 `.log`）
- ✅ 最终镜像 18 层逐层扫描：**0 命中**
- ✅ 一行 `.dockerignore` 修复（隔离验证）：上下文 3,416 → 2,952（**−464**），其余规则不变
- ⚠️ 内容敏感性：42 个 YAML 含邮箱样字符串、8 个含 `bearer`、1 个 `.log` 含 `Authorization`（该 `.log` 已被排除）
- 更正：EA-45 记的"63 个文件"不准确，实际为 537（磁盘）/ 464（上下文）

#### 阶段 4：Next.js preview 密钥

- 来源：`next/dist/build/preview-key-utils.js:43-49`，`crypto.randomBytes(16/32/32)`
- 复用条件：`.next/cache/.previewinfo` 存在且未过期（14 天）；容器内该目录从不跨构建保留
- 影响面：仅 `prerender-manifest.json` 1 个文件、0 个编译 chunk；应用未使用 `draftMode`
- 官方确定性方案：**不存在**（预置 `.previewinfo` 等于写入固定密钥，被本阶段边界禁止）→ `NOT RUN`

#### 阶段 5：层根因

- 600 个内容差异 + 4 个文件增删 + **83,458 个仅 mtime 差异**（占 100,066 条目的 83.4%）
- 归入 9 类：V8 缓存、npm 缓存、npm 日志、fontconfig、ldconfig、apt 日志、`.modules.yaml`、turbo 日志、preview 密钥

#### 阶段 6：实验（每次均 `--no-cache`）

| 组  | 变更                                 | 构建数    | 结果                                          |
| --- | ------------------------------------ | --------- | --------------------------------------------- |
| A   | 基线（EA-45 A1/A2）                  | 2         | 18 层中 10 层不同                             |
| B   | `.dockerignore` + `.playwright-mcp`  | 1（探针） | 上下文 −464 文件，最终镜像不变                |
| C   | `SOURCE_DATE_EPOCH`（EA-45 B1/B2）   | 2         | 仍 10 层不同（SDE 不固定层内 mtime）          |
| D   | 同层清理 + `rewrite-timestamp` + SDE | 2         | **17/18 层逐字节相同**，唯一残留 preview 密钥 |
| E   | preview manifest 确定化              | 0         | `NOT RUN`（无官方方案）                       |

#### 阶段 7：供应链

- ❌ SBOM：**不存在**（attestation manifest 仅 1 层 in-toto provenance；CI 未启用 `sbom:`）
- ❌ 签名：CI **无签名步骤**；registry 侧验证 `NOT VERIFIED`
- ⚠️ provenance：SLSA v1，`subject` = 平台 manifest digest，`buildkit_completeness=false`，记录 `vcs:revision`

#### 判定

- ⚠️ `PARTIAL — APPLICATION CONTENT REPRODUCIBLE; IMAGE CONTENT NOT REPRODUCIBLE`
  （D 组：17/18 层一致，manifest 仍不同）
- ❌ `FAIL — MANIFEST REPRODUCIBLE`（唯一阻断：`prerender-manifest.json`）
- ❌ `FAIL — INDEX REPRODUCIBLE`（attestation 的 `invocationId`/时间戳每次不同）
- ❌ `FAIL — SBOM` / ❌ `FAIL — IMAGE SIGNING` / ⚠️ `NOT VERIFIED — SIGNATURE CHAIN`
- ✅ `PASS — DEPLOYMENT PINNING (process)`、`PASS — CONTENT ATTRIBUTION`

#### 发现的缺陷

| ID     | 缺陷                                                   | 状态                                 |
| ------ | ------------------------------------------------------ | ------------------------------------ |
| EA46-1 | `.playwright-mcp` 进入构建上下文（464 文件 / 3.42 MB） | 修复已验证，**未实施**               |
| EA46-2 | 镜像无 SBOM                                            | 未修复                               |
| EA46-3 | CI 无镜像签名                                          | 未修复                               |
| EA46-4 | index digest 因 attestation 不可复现                   | 需改验收口径（改用 manifest digest） |
| EA46-5 | Next.js preview 密钥每次随机                           | 无官方方案，记录为已知非确定性       |

#### 质量门禁（文档改动）

全部使用 `--force` 绕过 Turbo 缓存（首次默认运行命中 EA-45 缓存，不算执行）。

| 门禁   | 命令                                               | 退出码 | 耗时  |
| ------ | -------------------------------------------------- | ------ | ----- |
| 格式   | `pnpm format:check`                                | 0      | 27 s  |
| 类型   | `pnpm exec turbo run typecheck --force`            | 0      | 11 s  |
| Lint   | `pnpm exec turbo run lint --force`                 | 0      | 43 s  |
| 死代码 | `pnpm deadcode:check`                              | 0      | 3 s   |
| 测试   | `pnpm exec turbo run test --concurrency=1 --force` | 0      | 276 s |
| 构建   | `pnpm build --force`                               | 0      | 73 s  |

- 测试 25/25 任务通过（`@beaconhs/web` 2,118 通过 / 9 跳过），0 缓存
- 首次强制测试因本地 MinIO 未启动在 6 s 内失败（3 个存储集成测试 `ECONNREFUSED`）；
  重启本地基础设施后重跑通过 —— 环境问题，非代码问题
- 汇总证据：`docs/evidence/ea46/logs/gates.txt`

## 10.19 EA-47 发布策略与供应链安全闭环验证（2026-10-26 实验 / 2026-10-27 定稿）

- **报告：** `docs/ea47-supply-chain-closure-report.md`
- **证据：** `docs/evidence/ea47/`（51 文件，`sha256sum -c SHA256SUMS` 49/49 通过；`UNCOMPRESSED-SHA256SUMS` 5/5）
- **环境：** 隔离本地 registry `127.0.0.1:5055`（`registry:2@sha256:a3d8aaa6…`）。**未访问生产 / 未改动 ceshi / 未使用 GHCR 凭据**
- **对象：** `beaconhs:ea45-repro-1`（index `9b2156ac…` / manifest `be54cfce…` / config `e35ca534…`）

#### 阶段结论

- **SBOM：** syft 1.55.0 对 registry 对象与 EA-46 OCI 归档生成 SPDX 2.3 / CycloneDX 1.7；
  `source.id` 精确等于平台 manifest digest；结构校验 0 错误；**`chrome-headless-shell` 未被识别为组件**（仅文件清单）
- **签名：** cosign 3.1.4 临时密钥、无 tlog 配置；manifest 与 index 均签名并验签通过；SBOM attestation 的
  `subject.digest` 等于 manifest digest
- **篡改：** 未签名 digest → `no signatures found`；追加空层 → 失败；**签名 artifact 移植 → `provided artifact digest does not match any digest in statement`**
- **Provenance：** registry 内 attestation manifest（`530bbc28…`）与 provenance blob（`c990513f…`）与 EA-45 证据逐字节相同；
  `subject.digest` = 同一 index 内 amd64 manifest；`buildkit_completeness=false`，且 provenance 无组织签名
- **digest 策略：** 同一 manifest 下，"含 attestation"的 index `9b2156ac…` 与"不含 attestation"的 index `e3e7d6f8…` 不同，
  manifest 不变 ⇒ index digest 的不可复现性来自 attestation descriptor
- **按 digest 拉取：** index 与 manifest digest 均可拉取且 digest 一致；tag 可改指、digest 不变；registry 拒绝
  digest/内容不匹配（`400 DIGEST_INVALID`）
- **Registry API：** 本地 `registry:2` 无 OCI 1.1 referrers API（`404`），cosign 回退到 `sha256-<digest>` 标签方案
- **preview 密钥：** 维持 `PARTIAL — PREVIEW SECRET NON-DETERMINISM UNRESOLVED`（未修复、未用固定密钥）
- **CI：** 三个 workflow 中 sbom/sigstore/attest/provenance 关键字命中 **0**，签名与验签**未实施**

#### 判定

| 项目                                | 判定                                       |
| ----------------------------------- | ------------------------------------------ |
| SBOM 生成 / 结构校验 / digest 绑定  | ✅ `PASS`（`LOCAL VERIFIED`）              |
| SBOM 组件完整性                     | ⚠️ `PARTIAL`（Chrome 缺失）                |
| 镜像签名 + 验签 + SBOM attestation  | ✅ `PASS`（`LOCAL VERIFIED`）              |
| 篡改检测                            | ✅ `PASS`                                  |
| provenance 与 index/manifest 的关联 | ✅ `PASS`（本地） / `NOT VERIFIED`（GHCR） |
| index vs manifest digest 边界       | ✅ `PASS`（实验证明）                      |
| 按 digest 拉取 / 不可变性           | ✅ `PASS`（本地）                          |
| 真实部署与回滚                      | `NOT RUN`                                  |
| GHCR / 真实 CI 侧签名与 SBOM        | `NOT VERIFIED` / `NOT RUN`                 |
| CI 内实施                           | ❌ `FAIL`                                  |
| preview 密钥                        | ⚠️ `PARTIAL`                               |

#### 缺陷

| ID     | 缺陷                                     | 状态                                  |
| ------ | ---------------------------------------- | ------------------------------------- |
| EA47-1 | CI 无 SBOM 生成、无签名、无部署前验签    | 未修复（技术路径已验证）              |
| EA47-2 | SBOM 未识别 `chrome-headless-shell` 组件 | 未修复（需显式声明或换扫描器）        |
| EA47-3 | index digest 因 attestation 不可复现     | 设计属性；需书面口径（EA-47 §6.4）    |
| EA47-4 | 按 tag 验签必然失败（index 未签名场景）  | 已记录；部署校验须先解析平台 manifest |

#### 质量门禁（本次仅文档与隔离实验产物）

全部绕过 Turbo 缓存（`--force`）；原始日志见 `docs/evidence/ea47/gates/`。

| 门禁   | 命令                                               | 退出码 | 耗时  |
| ------ | -------------------------------------------------- | ------ | ----- |
| 格式   | `pnpm format:check`                                | 0      | 26 s  |
| 类型   | `pnpm exec turbo run typecheck --force`            | 0      | 11 s  |
| Lint   | `pnpm exec turbo run lint --force`                 | 0      | 43 s  |
| 死代码 | `pnpm deadcode:check`                              | 0      | 2 s   |
| 测试   | `pnpm exec turbo run test --concurrency=1 --force` | 0      | 345 s |
| 构建   | `pnpm build --force`                               | 0      | 69 s  |

- 测试 25/25 任务通过（`@beaconhs/web` 2,118 通过 / 9 跳过），0 缓存
- 证据哈希：`docs/evidence/ea47` 49/49 通过；`UNCOMPRESSED-SHA256SUMS` 5/5
- 无门禁被禁用、跳过或抑制

## 10.20 EA-48 CI 供应链安全门禁审查与隔离验证（2026-10-26 实验 / 2026-10-27 定稿）

- **报告：** `docs/ea48-ci-supply-chain-gate-report.md`
- **证据：** `docs/evidence/ea48/`（82 文件，`sha256sum -c SHA256SUMS` 81/81 通过；`UNCOMPRESSED-SHA256SUMS` 7/7）
- **提案：** `docs/evidence/ea48/proposal/`（5 份设计文档 + 1 个 YAML 片段，**未应用到 `.github/workflows/`**）
- **环境：** 复用隔离本地 registry `127.0.0.1:5055`，新建仓库 `beaconhs-ea48`；EA-47 仓库只读未写
- **边界：** 未访问 GHCR / 生产 / ceshi；未修改正式工作流、Dockerfile、业务代码；未提交、未推送

#### 阶段结论

- **CI 现状（14 项审查）：** `PASS` 2 项（不可变 digest 部署、构建输出含 index digest）、`PARTIAL` 6 项、`FAIL` 6 项（平台 manifest digest 未记录、无 SBOM、无签名、无验签、tag 改指潜在绕过、无 OIDC）
- **SBOM：** CI **无**（`sbom:` 未设置，无 syft/trivy）；生成/校验/绑定路径已在隔离环境验证
- **签名 / 验签：** CI **无**（无 cosign/notation，无 `id-token`，无 `attestations`）
- **OIDC：** **未使用**（`id-token`/`oidc` 关键字 0 命中）
- **manifest digest：** **未记录**，而签名/SBOM/provenance 的 subject 都是它 ⇒ 即使加签名也无法验签
- **发布时序：** `push: true` 与 build 同一步 ⇒ 任何后置门禁**只能阻止部署，不能阻止发布**
- **SBOM 确定性：** 同一 digest 两次扫描原始字节不同（随机 UUID），**规范组件摘要相同** ⇒ 验收必须用规范摘要
- **Chrome Headless Shell：** syft 不识别为组件；声明式补充机制已验证（幂等 + 拒绝缺失证据）
- **门禁实现：** 7 阶段（index→manifest→签名→SBOM→覆盖→provenance→SBOM 内容），T1–T14 全部按预期

#### 判定

| 项目                                           | 判定                          |
| ---------------------------------------------- | ----------------------------- |
| CI 现状审查                                    | ✅ `PASS`（审查完成）         |
| 不可变 digest 部署                             | ✅ `PASS`                     |
| 最小权限（无 contents: write）                 | ✅ `PASS`（有脚本强制）       |
| 最小权限（secrets: inherit / packages: write） | ⚠️ `PARTIAL`                  |
| SBOM / 签名 / 验签 / OIDC / manifest digest    | ❌ `FAIL`（CI 未实施）        |
| 门禁设计（SBOM / 签名 / provenance / 回滚）    | ✅ `PROPOSED`                 |
| 隔离验证 T1–T14                                | ✅ `PASS`（`LOCAL VERIFIED`） |
| GitHub OIDC 真实签发                           | `NOT RUN`                     |
| GHCR 侧签名 / attestation                      | `NOT VERIFIED`                |
| 真实流水线耗时与稳定性                         | `NOT RUN`                     |
| 正式工作流修改                                 | **未应用**（按阶段边界）      |

#### 缺陷

| ID     | 缺陷                                        | 状态                                 |
| ------ | ------------------------------------------- | ------------------------------------ |
| EA48-1 | CI 不生成 SBOM、不签名、不验签、不使用 OIDC | 未修复（提案已交付）                 |
| EA48-2 | 流水线不记录平台 manifest digest            | 未修复（提案 C2 覆盖）               |
| EA48-3 | 镜像在门禁之前即已推送，门禁无法阻断发布    | 未修复（提案 C1/C5/C6 前移证明生成） |
| EA48-4 | SBOM 原始字节不可复现，直接比较哈希会误判   | 已提供机制（规范摘要），CI 未实施    |
| EA48-5 | syft 未识别 chrome-headless-shell           | 已提供机制（声明式补充），CI 未实施  |

#### 质量门禁（文档 + 隔离实验产物）

本阶段未改应用代码/依赖/构建配置，六项标准门禁中仅运行 `format:check`：

| 门禁                  | 状态      | 说明                        |
| --------------------- | --------- | --------------------------- |
| `pnpm format:check`   | ✅ 0      | 全部 Markdown 通过 Prettier |
| `pnpm typecheck`      | `NOT RUN` | 无 TS/TSX 改动              |
| `pnpm lint`           | `NOT RUN` | 无源码改动                  |
| `pnpm deadcode:check` | `NOT RUN` | 无导入/导出改动             |
| `pnpm test`           | `NOT RUN` | 无行为改动                  |
| `pnpm build`          | `NOT RUN` | 无构建输入改动              |

- 专项：证据哈希 81/81；解压载荷 7/7；YAML 解析 4/4；秘密扫描 0 命中
- 说明：EA-47 在相同 HEAD、相同依赖、相同构建配置下已 `--force` 跑通全部六项（`docs/evidence/ea47/gates/`），本阶段未触碰任何被其覆盖的输入

## 10.21 EA-49 Observe-only 阶段 A 实施准备与授权核验（2026-10-27）

- **报告：** `docs/ea49-observe-only-readiness-report.md`
- **证据：** `docs/evidence/ea49/`（19 文件，`sha256sum -c SHA256SUMS` 18/18 通过）
- **实施包：** `docs/evidence/ea49/proposal/`（observe-only 方案、实施前置清单、升级条件、决策请求包、可执行能力矩阵）
- **边界：** 未访问 GHCR / 生产 / ceshi；未使用真实 OIDC / Fulcio / Rekor / registry 凭据；**未修改 `.github/workflows/*`**；未触发任何流水线；未提交、未推送

#### 阶段结论

- **八项授权（A1–A8）：** `APPROVED` 0 · `PENDING AUTHORIZATION` 0 · `REJECTED` 0 · **`NOT FOUND` 8**
  - 三种独立搜索（批准标记扫描 / 签署表列审计 / git 历史）全部为空，且有正向对照证明扫描器有效
  - 既有审批材料（EA-38/39/40/41/43）一致显示 `PENDING`，未提供任何 A1–A8 授权
- **Observe-only 窗口：** **0 天 / 0 构建**，起止日期未设定；签名类指标（M9–M11）在 A1/A2 之前完全无法观察
- **无授权下的能力边界（可执行分类）：** 允许 10 项（全离线）· 仅设计 11 项 · 彻底禁止 3 项
- **实施前置条件（P1–P11）：** `APPROVED` 0 · `PENDING AUTHORIZATION` 6 · `NOT VERIFIED` 2 · `PROPOSED` 2
- **强制门禁进入条件（9 项）：** **0 / 9**（第 7 项"负向测试"为 `PARTIAL`，仅离线）
- **新增技术发现 P3：** `id-token: write` 获批 ≠ 能取得 GitHub OIDC 身份；需先做只读能力预检，否则会出现"已批准但永远红"的流水线

#### 判定

| 项目                             | 判定                        |
| -------------------------------- | --------------------------- |
| 工作区与 EA-48 证据复核          | ✅ `PASS`                   |
| 授权核验方法可信度               | ✅ `PASS`（含正向对照）     |
| A1–A8 授权                       | ❌ `NOT FOUND`（全部 8 项） |
| Observe-only 方案                | ✅ `PROPOSED`               |
| Observe-only 实际执行            | `NOT RUN`（0 天 / 0 构建）  |
| 实施前置条件                     | ❌ `NOT READY`（0/11 已批） |
| 强制门禁进入条件                 | ❌ `NOT MET`（0/9）         |
| 授权状态跨文档一致性             | ✅ `CONSISTENT`（脚本校验） |
| 正式 CI 修改 / 真实流水线 / GHCR | `NOT RUN` / `NOT VERIFIED`  |

#### 缺陷与受阻项

| ID     | 项目                                               | 状态                          |
| ------ | -------------------------------------------------- | ----------------------------- |
| EA49-1 | A1–A8 全部无授权记录（既无批准，也无正式待批工单） | `NOT FOUND`                   |
| EA49-2 | `id-token` 能力未预检（P3）                        | `NOT VERIFIED`                |
| EA49-3 | 旧未签名镜像回滚路径未决定                         | `PENDING AUTHORIZATION`（A8） |
| EA49-4 | Observe-only 未启动                                | `NOT RUN`                     |
| EA49-5 | 签名类指标无法观察                                 | `NOT RUN`（依赖 A1/A2）       |

#### 质量门禁（仅文档与审查产物）

本阶段未修改应用代码/依赖/schema/构建输入，六项标准门禁中仅运行 `format:check`：

| 门禁                  | 状态      | 说明                        |
| --------------------- | --------- | --------------------------- |
| `pnpm format:check`   | ✅ 0      | 全部 Markdown 通过 Prettier |
| `pnpm typecheck`      | `NOT RUN` | 无 TS/TSX 改动              |
| `pnpm lint`           | `NOT RUN` | 无源码改动                  |
| `pnpm deadcode:check` | `NOT RUN` | 无导入/导出改动             |
| `pnpm test`           | `NOT RUN` | 无行为改动                  |
| `pnpm build`          | `NOT RUN` | 无构建输入改动              |

- 专项：EA-49 证据 18/18；EA-48 证据 81/81 仍通过；内部链接 0 缺失；审批状态一致性 `CONSISTENT`；秘密扫描 0 命中
- 未运行项的理由已记录：EA-47 在相同 HEAD、相同依赖、相同构建配置下已 `--force` 跑通全部六项

## 10.22 EA-50 审批决策闭环与旧镜像回滚风险处置（2026-10-27）

- **报告：** `docs/ea50-approval-and-rollback-readiness-report.md`
- **证据：** `docs/evidence/ea50/`（14 文件，`sha256sum -c SHA256SUMS` 13/13 通过）
- **决策登记表：** `docs/evidence/ea50/decisions/decision-register.md`（A1–A8 逐项建档，决定字段全空）
- **决策请求包：** `docs/evidence/ea50/decisions/decision-request-package.md`
- **回滚风险分析：** `docs/evidence/ea50/rollback/unsigned-image-rollback-risk.md`
- **OIDC 预检方案：** `docs/evidence/ea50/oidc-precheck-plan.md`
- **观察启动清单：** `docs/evidence/ea50/observe-only-start-checklist.md`
- **转换条件评估：** `docs/evidence/ea50/gate-transition-assessment.md`
- **边界：** 未访问生产 / ceshi / 生产 DB / 对象存储 / GHCR；未使用真实 OIDC / Fulcio / Rekor 凭据；**未修改 `.github/workflows/*`**；未触发流水线；未执行部署或回滚；未提交、未推送

#### 阶段结论

- **A1–A8：** `APPROVED` 0 · `PENDING AUTHORIZATION` 0 · `REJECTED` 0 · **`NOT FOUND` 8**
  - 采用比 EA-49 更严格的判定（决策行 + 所有权人 + 日期 + 主题，排除 fixture 与状态摘要句），结果 0 项合格
  - EA-49 扫描器在复跑时报告的 6 条命中，逐条核实均为规则描述或状态句，**不是**批准
- **旧镜像回滚：** EA-16 身份可离线复算（index `17126c6e…` / manifest `43a7dc27…`），**未签名、无 SBOM、有 provenance**；R1–R4 四方案已比较；推荐标 `RECOMMENDATION ONLY — NOT APPROVED`；**A8 未决定前默认适用最严格读法，该暴露今天已存在**
- **OIDC 预检：** 拆为六个互不等价验收项（O1–O6），全部 `NOT FOUND` / `NOT VERIFIED`；**未执行**，状态 `NOT VERIFIED — PENDING AUTHORIZATION (A2)`
- **Observe-only：** **`NOT STARTED — PENDING AUTHORIZATION`**，观察记录 0 天 / 0 构建；7 项阻断门 + 11 项配置门
- **强制门禁转换条件：** **0 / 9 met**（第 7 项负向测试为 `PARTIAL`，仅离线），未放宽任何标准
- **新增缺陷：** 流水线只记录 index digest，从不记录/交叉校验 manifest digest ⇒ "发布与回滚身份一致"目前只是文档约定

#### 判定

| 项目                        | 判定                                    |
| --------------------------- | --------------------------------------- |
| 工作区与 EA-49 证据复核     | ✅ `PASS`                               |
| 严格审批扫描（含正/反对照） | ✅ `PASS`（结论：0 项合格）             |
| A1–A8 授权                  | ❌ `NOT FOUND`（全部 8 项）             |
| 决策登记表 / 决策请求包     | ✅ `PROPOSED`（决定字段全空）           |
| 旧镜像回滚风险分析          | ✅ `PASS`（分析完成）                   |
| 回滚方案选择                | ⚠️ `PROPOSED` / `PENDING AUTHORIZATION` |
| OIDC 预检                   | `NOT VERIFIED`（未执行）                |
| Observe-only 启动           | ❌ `NOT STARTED`                        |
| 强制门禁转换条件            | ❌ `NOT MET`（0/9）                     |
| 发布/回滚身份一致性         | ❌ `FAIL`（新增，见 §10.22 阶段结论）   |
| 审批状态跨文档一致性        | ✅ `CONSISTENT`（脚本校验）             |

#### 缺陷与受阻项

| ID     | 项目                                         | 状态                          |
| ------ | -------------------------------------------- | ----------------------------- |
| EA50-1 | A1–A8 全部无授权记录                         | `NOT FOUND`                   |
| EA50-2 | 旧未签名镜像回滚路径未定                     | `PENDING AUTHORIZATION`（A8） |
| EA50-3 | OIDC 能力未验证（O3–O6）                     | `NOT VERIFIED`                |
| EA50-4 | Observe-only 未启动                          | `NOT STARTED`                 |
| EA50-5 | 流水线不记录 manifest digest，身份未强制一致 | `FAIL`（本阶段新识别）        |
| EA50-6 | 重建耗时（冷构建→可服务）未测量              | `NOT RUN`                     |

#### 质量门禁（仅文档与审查产物）

本阶段未修改应用代码/依赖/schema/构建输入，六项标准门禁中仅运行 `format:check`：

| 门禁                  | 状态      | 说明                        |
| --------------------- | --------- | --------------------------- |
| `pnpm format:check`   | ✅ 0      | 全部 Markdown 通过 Prettier |
| `pnpm typecheck`      | `NOT RUN` | 无 TS/TSX 改动              |
| `pnpm lint`           | `NOT RUN` | 无源码改动                  |
| `pnpm deadcode:check` | `NOT RUN` | 无导入/导出改动             |
| `pnpm test`           | `NOT RUN` | 无行为改动                  |
| `pnpm build`          | `NOT RUN` | 无构建输入改动              |

- 专项：EA-50 证据 13/13；EA-49 证据 18/18 仍通过；内部链接 0 缺失；审批状态一致性 `CONSISTENT`；秘密扫描 0 命中
- 未运行项理由已记录：EA-47 在相同 HEAD、相同依赖、相同构建配置下已 `--force` 跑通全部六项

## 10.23 EA-51 部署/回滚身份一致性设计与旧镜像恢复可行性评估（2026-10-27）

- **报告：** `docs/ea51-deployment-identity-and-rollback-report.md`
- **证据：** `docs/evidence/ea51/`（13 文件，`sha256sum -c SHA256SUMS` 12/12 通过）
- **身份链追踪：** `docs/evidence/ea51/design/deployment-identity-chain-trace.md`
- **身份契约：** `docs/evidence/ea51/design/deployment-identity-contract.md`
- **历史镜像矩阵：** `docs/evidence/ea51/rollback/historical-image-evidence-matrix.md`
- **回滚风险（Rev 2）：** `docs/evidence/ea51/rollback/unsigned-image-rollback-risk.md`
- **测试矩阵：** `docs/evidence/ea51/tests/deployment-identity-test-matrix.md`
- **边界：** 未访问生产 / ceshi / GHCR / 生产 DB / 对象存储；未使用真实 OIDC / Fulcio / Rekor 凭据；**未修改 `.github/workflows/*`、`Dockerfile`、`turbo.json`**；未触发流水线；未执行部署、回滚、迁移或备份恢复；未提交、未推送

#### 阶段结论

- **身份链（8 环节）：** **4 个环节不存在**——平台 manifest digest、image config digest、部署记录、回滚记录
- **十项必查项：** 2 `PASS` · 2 `PARTIAL` · **6 `FAIL`**
- **身份契约：** 17 字段（M/C/O），**绝大多数字段无生产者**；`PROPOSED`，0 项已强制
- **新缺陷 D1：** **镜像不自证源码版本**——EA-16 `deploymentId=undefined`，`/app` 内源码 SHA **0** 命中；EA-45 镜像 295 命中
- **新缺陷 D2：** 根因是 **HEAD 的 `turbo.json` 未声明 `DEPLOYMENT_VERSION`**（工作区那份是 EA-16 构建之后才做的未提交改动）；Turbo 2.10.5 严格过滤任务环境
- **新缺陷 D3：** 就绪检查读运行时 `APP_VERSION`（部署注入），非镜像内嵌身份，近乎同义反复
- **历史镜像：** 8 对象 digest **全部由原始字节复算**；内部自洽，但**无一有签名、无一有 SBOM**；EA-13 及更早 `NOT VERIFIED`
- **重建耗时：** 6 次既有冷构建 **323–363 s，均值 342 s**；**"冷构建→可服务"仍 `NOT RUN`**
- **回滚：** R1–R4 **四方案当前均无强制路径**（回滚代码不存在）；推荐 `RECOMMENDATION ONLY — NOT APPROVED`
- **测试矩阵：** 4 `PASS`（仅隔离）· 2 `PARTIAL` · **8 `NOT RUN`**

#### 判定

| 项目                        | 判定                                   |
| --------------------------- | -------------------------------------- |
| 工作区与 EA-50 证据复核     | ✅ `PASS`                              |
| 身份链追踪                  | ❌ `FAIL`（4/8 环节缺失）              |
| 身份一致性契约              | ✅ `PROPOSED`（未强制）                |
| 历史镜像证据矩阵            | ✅ `PASS`（复算）                      |
| 镜像自证源码版本（D1）      | ❌ `FAIL`（新识别）                    |
| turbo.json 构建声明（D2）   | ❌ `FAIL`（新识别）                    |
| 就绪检查身份语义（D3）      | ⚠️ `PARTIAL`（新识别）                 |
| Server Action Key 兼容性    | ⚠️ `PARTIAL`（前向已验证，EA-16 未知） |
| Migration 51 / 对象存储依赖 | ⚠️ `PARTIAL`（生产侧 `NOT RUN`）       |
| 重建耗时                    | ⚠️ `PARTIAL`（构建已测，部署侧未测）   |
| R1–R4 回滚方案              | ⚠️ `PROPOSED`（且当前无强制路径）      |
| 测试矩阵 T1–T14             | ⚠️ `PARTIAL`（8 项 `NOT RUN`）         |
| 正式 CI / 真实部署 / 回滚   | `NOT RUN`                              |

#### 缺陷

| ID     | 项目                                                 | 状态                            |
| ------ | ---------------------------------------------------- | ------------------------------- |
| EA51-1 | 身份链缺 4 环节（manifest/config/部署记录/回滚记录） | `FAIL`                          |
| EA51-2 | 镜像不自证源码版本（D1）                             | `FAIL`（本阶段新识别）          |
| EA51-3 | `turbo.json` 声明未提交（D2）                        | `FAIL`（本阶段新识别）          |
| EA51-4 | 就绪检查读运行时变量（D3）                           | `PARTIAL`（本阶段新识别）       |
| EA51-5 | 回滚代码路径不存在                                   | `FAIL`（使 R1–R4 无法强制执行） |
| EA51-6 | A1–A8 仍无授权记录                                   | `NOT FOUND`                     |

#### 质量门禁（仅文档与只读检查）

本阶段未修改应用代码/依赖/schema/构建输入，六项标准门禁中仅运行 `format:check`：

| 门禁                  | 状态      | 说明                        |
| --------------------- | --------- | --------------------------- |
| `pnpm format:check`   | ✅ 0      | 全部 Markdown 通过 Prettier |
| `pnpm typecheck`      | `NOT RUN` | 无 TS/TSX 改动              |
| `pnpm lint`           | `NOT RUN` | 无源码改动                  |
| `pnpm deadcode:check` | `NOT RUN` | 无导入/导出改动             |
| `pnpm test`           | `NOT RUN` | 无行为改动                  |
| `pnpm build`          | `NOT RUN` | 无构建输入改动              |

- 专项：EA-51 证据 12/12；EA-50 证据 13/13 仍通过；内部链接 0 缺失；秘密扫描 0 命中
- 未运行项理由已记录：EA-47 在相同 HEAD、相同依赖、相同构建配置下已 `--force` 跑通全部六项

## 10.24 EA-52 构建身份缺陷修复方案与回滚执行路径设计（2026-10-27）

- **报告：** `docs/ea52-build-identity-and-rollback-design-report.md`
- **证据：** `docs/evidence/ea52/`（`sha256sum -c SHA256SUMS` 见报告 §11）
- **身份契约：** `docs/evidence/ea52/design/build-identity-contract.md`（10 字段）
- **修复方案：** `docs/evidence/ea52/design/build-identity-remediation.md`（A/B/C + E1–E9 实测）
- **部署校验：** `docs/evidence/ea52/design/deployment-identity-validation.md`（10 步）
- **回滚路径：** `docs/evidence/ea52/design/rollback-execution-contract.md`（10 步 + RB-A~D）
- **测试矩阵：** `docs/evidence/ea52/tests/build-identity-test-matrix.md`、`rollback-test-matrix.md`
- **边界：** 未访问生产 / ceshi / GHCR；未使用真实 OIDC / Fulcio / Rekor 凭据；**未修改 `.github/workflows/*`、`Dockerfile`、`turbo.json`、业务代码**；未触发流水线；未执行部署或回滚；全部实验在 `/tmp/opencode/ea52/probe/**`

#### 阶段结论

- **D1/D2/D3 复核：** 三条均从原始文件重新读取（非沿用 EA-51 结论）
- **D2 端到端复现（新增）：** HEAD 形态 `turbo.json` → `deploymentId: undefined`、源码 SHA **0** 命中；声明到 `globalEnv` 或 task `env` → `deploymentId` 正确、**22** 文件命中
- **新陷阱 1：** `envMode: "loose"` 能"修复"D2，但把**所有**导出变量送进任务（日志显示 `APP_VERSION` 变为可见）——不得作为修复方案
- **新陷阱 2：** `BUILD_ID` **不是** revision 指纹；配置 `deploymentId` 后为常量，两个不同 commit 共用 `build-TfctsWXpff2fKS`
- **新陷阱 3：** 缺失 `DEPLOYMENT_VERSION` 时构建 **exit 0**，产出无身份镜像——静默降级，非 fail-closed
- **推荐（`PROPOSED`）：** A 先行（1 行，关闭 D1+D2）→ C 随后（关闭 D3）；B 不作主方案
- **部署校验：** 10 步中**仅第 1 步已实现**；第 9 步（读取镜像内嵌身份）**今天不可能通过**
- **回滚：** 10 步与 RB-A~D 已定义，**无任何回滚代码**；RB-B/C/D 为 `PENDING AUTHORIZATION`（A8/A7）
- **恢复耗时：** 构建 342 s（六次冷构建均值）；**其余六段全部 `NOT RUN`**，不得作为恢复承诺

#### 判定

| 项目                    | 判定                                        |
| ----------------------- | ------------------------------------------- |
| EA-51 证据复核          | ✅ `PASS — EVIDENCE REPRODUCED`             |
| D1 / D2 / D3 复核       | ✅ `PASS — EVIDENCE REPRODUCED`             |
| D2 端到端复现与修复形态 | ✅ `PASS — MECHANISM CONFIRMED`             |
| D1 / D2 修复状态        | ⚠️ `PARTIAL`（根因与修复已验证，仓库未改）  |
| D3 修复状态             | ⚠️ `PROPOSED`（需改业务代码）               |
| 缺失身份 fail-closed    | ❌ `FAIL`（当前静默成功）                   |
| 身份契约                | ✅ `PROPOSED`                               |
| 部署身份校验（10 步）   | ❌ `FAIL`（1/10 已实现，第 9 步不可能通过） |
| 回滚执行路径            | ⚠️ `PROPOSED`（RB-B/C/D 待授权）            |
| 构建身份测试 BI-1~BI-12 | ⚠️ `PARTIAL`（6 PASS / 4 FAIL / 2 NOT RUN） |
| 回滚测试 RB-1~RB-13     | `NOT RUN`（无回滚代码）                     |
| 正式 CI / 部署 / 回滚   | `NOT RUN`                                   |

#### 缺陷

| ID     | 项目                                | 状态                            |
| ------ | ----------------------------------- | ------------------------------- |
| EA52-1 | D1 镜像不自证源码版本               | `PARTIAL — MECHANISM CONFIRMED` |
| EA52-2 | D2 HEAD 未声明 `DEPLOYMENT_VERSION` | `PARTIAL — MECHANISM CONFIRMED` |
| EA52-3 | D3 就绪读运行时值                   | `PROPOSED`                      |
| EA52-4 | 缺失身份静默成功（非 fail-closed）  | `FAIL`（本阶段新识别）          |
| EA52-5 | `envMode: loose` 泄漏陷阱           | `FAIL`（记录，禁止使用）        |
| EA52-6 | `BUILD_ID` 被误用为身份             | `FAIL`（记录，禁止使用）        |
| EA52-7 | 回滚代码路径不存在                  | `FAIL`                          |

#### 质量门禁（仅文档与隔离实验）

本阶段未修改应用代码/依赖/schema/构建输入，六项标准门禁中仅运行 `format:check`：

| 门禁                  | 状态      | 说明                        |
| --------------------- | --------- | --------------------------- |
| `pnpm format:check`   | ✅ 0      | 全部 Markdown 通过 Prettier |
| `pnpm typecheck`      | `NOT RUN` | 无 TS/TSX 改动              |
| `pnpm lint`           | `NOT RUN` | 无源码改动                  |
| `pnpm deadcode:check` | `NOT RUN` | 无导入/导出改动             |
| `pnpm test`           | `NOT RUN` | 无行为改动                  |
| `pnpm build`          | `NOT RUN` | 无构建输入改动              |

- 专项：EA-52 证据哈希通过；EA-51 证据 12/12 仍通过；内部链接 0 缺失；秘密扫描 0 命中
- 探针全部在 `/tmp/opencode/ea52/probe/**`，仓库 `turbo.json` 未提交也未回退
- 未运行项理由已记录：EA-47 在相同 HEAD、相同依赖、相同构建配置下已 `--force` 跑通全部六项

## 11. Release decision matrix (EA-24)

| Item                                           | Current status                              | Blocking?                               | Closure condition                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Full image digest reproducibility              | FAIL                                        | POLICY DECISION REQUIRED                | Meet forced standard OR obtain written risk acceptance from approver                                                                  |
| Migration 51 production pre-check              | NOT RUN                                     | BLOCKING                                | Production data pre-check + backup + restore verified                                                                                 |
| Production recovery & rollback drill           | NOT RUN                                     | BLOCKING (per release minimum standard) | Completed with auditable evidence                                                                                                     |
| Multi-node Swarm validation                    | NOT RUN                                     | Per target architecture                 | Verified if Swarm is target arch; otherwise documented as N/A                                                                         |
| GHCR/GHA cache validation                      | NOT RUN                                     | Per build pipeline                      | CI build succeeds and produces equivalent image                                                                                       |
| WORM/Object Lock recovery                      | NOT RUN                                     | Per backup policy                       | Restore from WORM storage tested (if applicable)                                                                                      |
| Server Action Key cross-version compat         | EMPIRICALLY VERIFIED (EA-25/26/27/28/29/30) | APPROVAL REQUIRED                       | Use same key across compatible versions, or full redeploy with old key + DB restore (container-level empirical test PASS)             |
| Download capability-URL cross-tenant (browser) | NOT VERIFIED                                | NON-BLOCKING                            | Optional live browser test                                                                                                            |
| Legacy images / disk space                     | NON-BLOCKING                                | NON-BLOCKING                            | Informational                                                                                                                         |
| Gateway healthcheck script (host-level)        | NON-BLOCKING                                | NON-BLOCKING                            | Documented in runbook                                                                                                                 |
| Gateway Host-header (app-level fix)            | NON-BLOCKING                                | NON-BLOCKING                            | No action required for this release                                                                                                   |
| WOPI investigation                             | KNOWN / UNRESOLVED                          | NON-BLOCKING                            | Out of scope                                                                                                                          |
| Migration 51 production pre-check materials    | NOT RUN                                     | BLOCKING                                | Production SQL checks prepared; production query confirms 0 non-null values                                                           |
| Backup/restore and rollback gap analysis       | PASS (staging)                              | NON-BLOCKING                            | Staging backup/restore and rollback verified; production drill NOT RUN                                                                |
| Image digest reproducibility decision          | APPROVAL REQUIRED                           | POLICY DECISION REQUIRED                | Obtain written risk acceptance (Option A) or implement build metadata fix (Option B)                                                  |
| SBOM generation & publication in CI            | FAIL (technique verified locally, EA-47)    | BLOCKING (supply-chain requirement)     | CI generates SPDX/CycloneDX bound to the platform manifest digest, publishes it, and asserts key components (EA-47 §3)                |
| Image signing & pre-deploy verification        | FAIL (technique verified locally, EA-47)    | BLOCKING (supply-chain requirement)     | CI signs the platform manifest, deployment verifies signature + SBOM attestation + provenance subject before rollout (EA-47 §4, §6.4) |
| Registry-side signature/attestation (GHCR)     | NOT VERIFIED                                | BLOCKING (per supply-chain requirement) | Verify with read-only GHCR credentials; local-registry results are not a substitute (EA-47 §14)                                       |
| CI supply-chain gate implementation            | FAIL (design + local verification complete) | BLOCKING (supply-chain requirement)     | Apply the EA-48 proposal: SBOM + keyless signing + deploy-side gate; staged observe → block deploy → block publish (EA-48 §4–§7)      |
| Platform manifest digest recorded in pipeline  | FAIL                                        | BLOCKING                                | Pipeline resolves and records the platform manifest digest; signatures/SBOM/provenance are verified against it (EA-48 §3.2, §8)       |
| GitHub Actions OIDC + least-privilege tokens   | FAIL                                        | BLOCKING                                | `id-token: write` + `attestations: write` scoped to the build job; drop caller `packages: write` and `secrets: inherit` (EA-48 §5)    |
| Rekor transparency-log policy decision         | DECISION REQUIRED                           | POLICY DECISION REQUIRED                | Approver chooses public Rekor or private Sigstore with a compensating control (EA-48 §5, §14)                                         |
| Observe-only phase A authorization (A1–A8)     | NOT FOUND (0 of 8 recorded)                 | BLOCKING (for the supply-chain phase)   | Written, dated, attributed approvals recorded in `docs/evidence/ea49/authorization/authorization-register.md` (EA-49 §3)              |
| Legacy unsigned-image rollback path            | PENDING AUTHORIZATION (A8)                  | BLOCKING (operational)                  | Rollback exception decided and audited before any pre-policy image is redeployed (EA-49 §11 item 8)                                   |

## 12. Approval status

**PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**

This document is a preparation artifact. Final deployment requires:

- Independent review of the source snapshot vs. the image.
- Confirmation of production secrets and environment.
- DB backup verification.
- Sign-off from technical, operations, and business approvers.

No approval is implied by this document. No deployment has been performed.

**EA-36 status:** Release readiness review completed. 5 separate items verified (backup/restore, rollback, real business operations). 3 blockers remain (production migration 51 pre-check, production backup/restore drill, production rollback drill). 1 decision item (image digest reproducibility) requires approval.

**EA-52 status:** Build-identity fix designed and measured, **not applied** — D2 was reproduced end to end in an isolated workspace (HEAD-shaped Turbo config yields `deploymentId: undefined` and zero source-SHA matches; declaring the variable in `globalEnv` or a task `env` yields the correct identity and 22 matches). Three hazards were newly isolated: `envMode: "loose"` would "fix" D2 while forwarding every exported variable into tasks, `BUILD_ID` is a constant whenever `deploymentId` is set (so it cannot fingerprint a revision), and a missing `DEPLOYMENT_VERSION` produces a **successful** build with no identity. Recommendation `PROPOSED`: commit the declaration (A) first, separate build identity from runtime identity (C) second. Deployment validation is 1 of 10 steps implemented; step 9 — reading the image's embedded identity — cannot pass today. The rollback contract is specified but **no rollback code exists**, so all 13 rollback tests are `NOT RUN` and RB-B/C/D remain `PENDING AUTHORIZATION`. `turbo.json` was neither committed nor reverted; all probes ran under `/tmp`. No workflow, Dockerfile or application code was modified; no pipeline ran; no registry was contacted; no deployment or rollback occurred. No approval is implied.

**EA-51 status:** Deployment/rollback identity traced end to end and **found incomplete** — of eight links, the platform manifest digest, image config digest, deployment record and rollback record do not exist, so signatures/SBOM/provenance name an object the pipeline never derives (2 `PASS` / 2 `PARTIAL` / 6 `FAIL` across the ten required checks). Three defects were newly isolated: **D1** the EA-16 candidate image carries no build-time source identity (`deploymentId: undefined`; source SHA absent from `/app`), **D2** the root cause is `turbo.json` declaring `DEPLOYMENT_VERSION` only in an _uncommitted_ edit made after that build, so a CI build from committed `51a899b7` reproduces the defect, and **D3** the readiness check reads a deploy-time `APP_VERSION` rather than the baked value. Historical digests were all recomputed from raw bytes; none of the eight objects has a signature or an SBOM. Rebuild time is 323–363 s (mean 342 s) from six existing cold builds, but cold-build→serving is `NOT RUN`. Because **no rollback code path exists**, R1–R4 are presently statements of intent rather than enforceable controls. No workflow, Dockerfile or turbo config was modified; no pipeline ran; no registry was contacted; no deployment or rollback occurred. No approval is implied.

**EA-50 status:** Decision closure prepared, still **nothing approved** — A1–A8 remain `0 APPROVED / 8 NOT FOUND` under a stricter decision-record test (owning role + subject + date, fixtures and status sentences excluded). The legacy-image rollback risk is now analysed rather than merely noted: EA-16 is unsigned with provenance and no SBOM, four disposal options are compared, and until A8 is decided the strictest reading applies — **that exposure exists today, independent of the gate**. Newly identified: the pipeline records only the index digest and never the platform manifest digest that signatures/SBOM/provenance name, so release and rollback identity are a convention, not an invariant. Observe-only remains `NOT STARTED` at 0 days / 0 builds; transition criteria remain 0/9. No workflow file was modified, no pipeline triggered, no GHCR access, no deployment or rollback. No approval is implied.

**EA-49 status:** Observe-only phase A preparation complete but **not started** — the authorization register records **0 of 8** approvals (A1–A8 all `NOT FOUND`), the observation window is at 0 days / 0 builds, 0 of 11 implementation preconditions are approved, and 0 of 9 transition criteria are met. A new technical blocker (P3: `id-token` capability unverified) means an approved A2 can still produce a permanently red pipeline. Two rows were added to §11. No workflow file was modified, no pipeline was triggered, no GHCR access occurred. No approval is implied.

**EA-48 status:** CI supply-chain audit complete — the pipeline deploys by immutable index digest and forbids `contents: write`, but generates no SBOM, signs nothing, verifies nothing, uses no OIDC, and never records the platform manifest digest that signatures/SBOM/provenance actually name. A 7-stage gate reference implementation and a complete change proposal were delivered and verified against an isolated registry (T1–T14, 14/14). **No workflow file was modified.** Four supply-chain blockers were added to §11. No approval is implied.

**EA-47 status:** Supply-chain closure verified on an **isolated local registry only**. SBOM generation/validation, image signing, tamper detection, provenance association and digest-addressed pulling are `PASS (LOCAL VERIFIED)`. CI still generates no SBOM, signs nothing, and verifies nothing (`FAIL`); GHCR-side signatures/attestations remain `NOT VERIFIED`; production deployment and rollback remain `NOT RUN`. Three supply-chain blockers were added to §11. No approval is implied.
