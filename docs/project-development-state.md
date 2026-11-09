# BeaconHS HSE — Project Development State

> **This file is the single durable record of where the project is.**
> Update it at the end of every sizeable development task, in the same change.

---

## 中文摘要

**当前阶段：EA-12 本地缺陷修复已完成。**

本轮完成：`/api/v1/monitored_sessions` 的 500（`apps` category 复用
`forms.response.read.all`：monitored sessions 就是 `form_responses` 数据，
不新增权限、不扩大角色）；D1/D2 文档与回归覆盖校正；D3 删除
`training_enrollments.expires_on` / `due_on` 与
`equipment_inspection_records.certificate`（migration 0051）；D4 PPE 失败检查→
纠正措施补发 `corrective_action.created`；D5 equipment flow status 补齐
`repaired` / `verified`；D6 canonical template 注释校正；CLI 测试临时目录改为
`try/finally` 清理。`PERMISSION_CATALOGUE` = 107，migration journal = 51，
`REPORT_ENTITIES` = 18。**未 commit、未 push、未部署。**

BeaconHS 官方部署基线已完整恢复并通过运行时验证（PostgreSQL / Redis /
Mailpit / Collabora / MinIO、migration、seed、Web、登录、Storage E2E、
Presigned PUT/GET、Attachment）。HSE 二次开发的**分析基线已完成**；EA-12 只做
本地缺陷修复，**新功能开发尚未开始**。

**三份关键文档已就绪：**

| 文档                               | 内容                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `docs/hse-development-baseline.md` | HSE 能力基线、17 项能力矩阵、三个数据模型深挖、开发顺序 |
| `docs/opencode-*.md`               | OpenCode V2 基础设施基线（9 份）                        |
| 本文件                             | 项目状态、缺陷登记、下一步                              |

**最重要的结论（已实测）：** BeaconHS 记录 HSE 事件的能力很强，但**不管理
它们的闭环**——不存在 `findings` 表、不存在 `hazards` 表、不存在 `risks`
表，存在 8 条互相独立的残缺生命周期，只有 `corrective_actions` 一条同时具备
责任人 + 截止日期 + 验证 + 通知。

**下一任务：** EA-12 已完成本地修复；部署、真实 rollback、生产 restore、多节点
Swarm 与 GHCR/GHA 路径仍因授权和环境未执行（见 §5）。D8 已在 2026-11-09 的全项目审计中解决（0055 迁移 + `fk-snapshot-coverage.test.ts` 回归覆盖）；WOPI frozen-document 行为仍按 owner 要求暂停。

---

## EA-13 addendum (2026-10-22)

EA-13 built a release candidate from the uncommitted EA-12-complete working
tree, deployed it to the ceshi host `10.10.31.30` (`beaconhs-phase-aj` stack),
ran the real-environment acceptance matrix, cleaned all test data it created,
and re-captured every gate. No commit, push, PR, production deployment or Drill
contact occurred; production release still requires separate approval.

Two code repairs were needed to make the deployment pipeline itself work. Both
are uncommitted working-tree changes:

| Repair                                 | What changed                                                                                                                                                                                                                                                                                                      | Verification                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-action key gate `fingerprint()` | `scripts/ci/verify-server-action-key-gate.sh` now derives the fingerprint through the dependency-free CLI `scripts/ci/server-action-key-fingerprint.mjs` (contract: prints `fingerprint=<hex>`; `--env` mode writes through a 0600 mktemp file), so the gate no longer needs `tsx`/node_modules on a remote host. | Parity PASS in all four modes (key-file, env, unset → exit 2, invalid → exit 2); manifest-mode positive and negative controls; remote image gate exit 0. |
| ops-migrate migrations folder          | `packages/db/src/migrate.ts` exports `resolveMigrationsDir()`, preferring the packaged `node_modules/@beaconhs/db/drizzle` journal (image layout) and falling back to the source-layout `../drizzle`. No Dockerfile change.                                                                                       | `APP_ROLE=migrate` one-shot container in the rebuilt image: ENOENT gone, ledger applied cleanly (50 → 51).                                               |
| Formatting                             | `pnpm exec prettier --write packages/db/src/migrate.ts`.                                                                                                                                                                                                                                                          | `pnpm format:check` exit 0.                                                                                                                              |

Deployment ledger: image `beaconhs:phase-ea13-20261022-160729-m` (image gate
PASS, OPS-CHECK PASS), manifest sha256:1907e277…, embedded key fingerprint
`06b5f60d7906ee9414a27cae54173db4`, version
`51a899b7aac0a942da327222a3eed355fca9798a`; compose image refs switched in 4
places with a backup at `/home/ceshi/beaconhs-phase-cd/compose.yaml.bak-ea13`;
migration ledger 50 → 51 with RLS 194 policies over 191 tables applied
atomically; tenants 2.

Acceptance matrix (full evidence in
`docs/phase-6u-b3-ea13-final-deployment-report.md`): login/session
**RUNTIME PASS**; P1 API grant/deny matrix **RUNTIME PASS** (catalogue,
authorised list, missing-grant 403 carrying the explicit permission message —
a zero-permission key is rejected by design with "Choose at least one
permission.", so the counterfactual uses a docs-only key); cross-tenant
isolation **RUNTIME PASS** (unknown UUID 403, existence-hiding 404 for
documents, and the `lift-plan` templateKey collision resolved only in the
calling tenant); Builder-app-grant semantics **RUNTIME PASS**; D3
**RUNTIME PASS**; D5 **RUNTIME PASS** (work-order status palette contains
`repaired` and `verified`; the rejected draft left `flow_gates` = 0 and
`form_automations` = 0); migration **RUNTIME PASS**; restart persistence
**RUNTIME PASS**; log scan **PASS** (0 error-class lines in web/worker over
75 minutes); D4 **STATIC VERIFIED** (AJ tenant has 0 `ppe_items` and 0
`people`, so driving the flow would fabricate ≥ 4 records; EA-12 regression
coverage plus the `corrective_action.created` string in the deployed web
chunks and worker bundle); browser upload **PARTIAL** (presign produced the
correct public gateway URL with metadata and tagging, and a manual OPTIONS
probe returned 204 with the correct `Access-Control-Allow-Origin` echo, but
the browser PUT was blocked twice by the tunnel flap; no orphan attachment
rows); public-domain readiness **PASS, intermittent**; cleanup **PASS**.

Cleanup ledger: all three EA13 API keys revoked (`revoked_at` set; curl
returns 401 "API key has been revoked"), the acceptance incident soft-deleted
(0 live rows), attachments stayed at the baseline 59, no flow or automation
rows, local and remote scratch artifacts removed (the 0600 manifest last).

Environment defects on record (not fixed here): the cloudflared QUIC egress
has degraded since the host boot at 11:47 and cycles registration and loss
(public errors 530/1033/502); `aj-gateway.py` was started manually with
nohup (pid 25212) and has no auto-restart — D-AK-4 stays open; the ceshi host
disk is at 90% (106G/124G), with old `phase-cq`/`phase-cd` images present as
clean-up candidates pending approval.

All six local gates were re-run after the code changes and each captured its
own exit code: `format:check` 0, `typecheck` 0, `lint` 0, `test` 0 (25 Turbo
tasks; web 2118 passed / 9 skipped; db 508 passed / 41 skipped),
`deadcode:check` 0, `build` 0.

---

## EA-12 addendum (2026-10-22)

EA-12 fixes the remaining defects that could be reproduced and verified locally.
No production, `phase-aj`, Drill, GitHub, commit, push or deployment contact
occurred.

| Fix                                      | What changed                                                                                                                                                                                                                                                                                                                                                                       | Verification                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 — `/api/v1/monitored_sessions` 500    | `apps` now maps to the existing `forms.response.read.all` gate. Monitored sessions are `form_responses` rows and are the same data the Builder apps API already exposes, so this is a same-module alias, not a second permission ladder. The duplicate-invariant test now permits only this documented pair.                                                                       | Catalogue/allow/deny tests; authorised route test; unauthorised route test proves refusal before data access; live scratch-database RLS test proves tenant A cannot read tenant B's row. |
| D1 — invalid nav permission              | Confirmed already fixed in the current code; stale defect text removed and the regression coverage remains.                                                                                                                                                                                                                                                                        | Nav/module-admin catalogue-key test.                                                                                                                                                     |
| D2 — ungated `/people`                   | Confirmed already fixed: `people.read.all` gates navigation and direct access; export is gated too.                                                                                                                                                                                                                                                                                | `/people` access and export tests.                                                                                                                                                       |
| D3 — three dead columns                  | Removed `training_enrollments.due_on`, `training_enrollments.expires_on` and `equipment_inspection_records.certificate` from the Drizzle schema; added `0051_ea12_drop_dead_columns.sql`. The only references were two write-only enrollment assignments (a compliance due date no surface read, and `expires_on` always set to null); those writes were removed with the columns. | All three columns had **0 non-null rows** before applying the migration. Migration applied locally (51 applied, 0 pending); schema/migration regression test added.                      |
| D4 — PPE corrective actions not notified | The failed-inspection → corrective-action path now records the same `corrective_action.created` domain event as inspections, with notification, integration and web-flow payloads.                                                                                                                                                                                                 | Unit test asserts the event, subject, dedup key and notification payload.                                                                                                                |
| D5 — missing work-order flow states      | `equipment` flow profile now offers all eight real work-order statuses, including `repaired` and `verified`.                                                                                                                                                                                                                                                                       | Test compares the profile against `workOrderStatus.enumValues`.                                                                                                                          |
| D6 — stale template comment              | Corrected the comment to match the single current canonical template and the deliberately non-canonical built-ins.                                                                                                                                                                                                                                                                 | Source comment update; no runtime path.                                                                                                                                                  |
| Test temp-directory hygiene              | The fingerprint CLI test writes key files through a `withKey()` helper that removes the directory in `finally`, including when a key is rejected.                                                                                                                                                                                                                                  | Success and rejection cleanup assertions.                                                                                                                                                |

The live RLS test (`monitored-sessions-tenant-isolation.test.ts`) is skipped when
`SEED_TEST_SCRATCH_DATABASE_URL` is absent. It was run against a dedicated
`beaconhs_ea12_scratch` database with all 51 migrations applied, and passed.

All six local gates were run separately and captured their own exit codes:

| Gate                  | Result   |
| --------------------- | -------- |
| `pnpm format:check`   | **PASS** |
| `pnpm typecheck`      | **PASS** |
| `pnpm lint`           | **PASS** |
| `pnpm test`           | **PASS** |
| `pnpm deadcode:check` | **PASS** |
| `pnpm build`          | **PASS** |

`pnpm test` reported 25 successful Turbo tasks; the web package reported 2118
passed and 9 skipped conditional database tests. The live RLS test was run
separately against the scratch database and passed, as recorded above. Real
deployment, rollback, production restore, multi-node Swarm and the GHCR/GHA path
remain **NOT RUN**.

---

## Phase BO addendum (2026-10-17)

Phase BO ran a full-system coverage audit and attempted to close three key
end-to-end scenarios against the live test environment
(`https://beaconhs-test.xuhaoqing.top`, image `beaconhs:phase-bl-20261017-000000`):

- **Collabora edit → save → re-download: PASS** (the edit persists into the
  master DOCX; verified by inspecting `word/document.xml`).
- **Upload → download SHA-256 integrity: PASS.** **Non-ASCII download filename:
  FAIL** on the running image (`测试文档.docx` → `_.docx`, no RFC 5987
  `filename*`). Root cause: HEAD's download route sanitizes with `[^\w.\- ]+`;
  the fix exists only in the uncommitted working tree and is **not deployed**.
- **Storage Freeze state machine: BLOCKED** — no web surface drives the
  transitions (they live in `packages/db/src/storage-freeze-operations.ts`), so
  there is no browser flow to test.

All six gates pass. Full detail:

- `docs/phase-6u-b3-bo-coverage-audit.md`
- `docs/phase-6u-b3-bo-e2e-closure-report.md`
- `docs/phase-6u-b3-bo-defect-register.md`

New defects: **D-BO-1** (non-ASCII filename destroyed — fix undeployed),
**D-BO-2** (`Content-Disposition` duplicated across many routes).

The §1 baseline table below predates the current HSE development branch and is
not updated by this addendum.

---

## Phase BP addendum (2026-10-17)

Phase BP closed the two Phase BO blockers by **building and deploying** the
working tree to the isolated test service and then verifying against the running
image. Two builds were needed: `beaconhs:phase-bp-20261017-101904`
(`a39c78d0bc4b`, the D-BO-1 fix) and the final
`beaconhs:phase-bp-20261017-111136` (`8d0e44b998bb`, D-BO-1 **plus** the D-BP-2
worker fix). Source: HEAD `51a899b7` + uncommitted working-tree changes
(fingerprint `d17f0656…`). No commit, no push; the shared C2 drill and production
were untouched.

**D-BO-1 closed (deployed + verified).** `测试文档.docx` downloads as
`Content-Disposition: attachment; filename="_.docx"; filename*=UTF-8''%E6%B5%8B…`,
the whole header is printable ASCII, the bytes round-trip at 20 622 B with
SHA-256 `d86b84b4…`, and the BO E2E suite is **4/4**.

**Storage Freeze verified (was BLOCKED in BO).** Verified in three separate
layers, reported separately: a test-only driver calling the real production
functions on the live isolated DB (**31/31 checks**: illegal transition, stale
version, all six operation classes refused while frozen, in-flight registration
refused, restart does not resume writes, `FROZEN` refused with an open in-flight
write or an unresolved arm, `→ ACTIVE` refused without a valid reconciliation
hash, full `ACTIVE → … → ACTIVE` traversal); live HTTPS (**WOPI SaveFile = 423
while frozen / 200 as a positive control**); and browser E2E (Start blank and
Word import, `allowed` vs `refused`, **4/4**). No production operation entry
point and no new business UI was added.

**New defects:**

- **D-BP-2 (High) — FIXED.** The bundled worker never registered the storage
  freeze gate: `bootstrapStorageFreezeGate()` with no module argument falls back
  to a dynamic import that resolves to raw TypeScript under `node_modules`, which
  Node refuses to type-strip, so the gate stayed unregistered and **every worker
  storage operation failed closed** (`STORAGE_FREEZE_STATE_UNKNOWN`) — e.g.
  expired-upload cleanup failed every minute. Fixed by passing the statically
  imported module at both worker call sites (the pattern the web app already
  used), with a worker source-audit regression test.
- **D-BP-1 (Medium) — OPEN.** Freeze refusals are correctly enforced but badly
  explained: **Start blank** surfaces a masked `Minified React error #441`
  (the action `throw`s instead of returning the app's own
  `{ ok: false, error: 'workspace_frozen' }` shape), and **Import Word file**
  says only `Upload could not be started`. Not fixed — it changes a core document
  flow and needs an explicit decision.

**Carried forward, unchanged:** D-BO-2 (`Content-Disposition` duplication),
D-BO-4, D-BO-5, D1–D6.

All six gates pass. Full detail:

- `docs/phase-6u-b3-bp-deployment-verification.md`
- `docs/phase-6u-b3-bp-storage-freeze-report.md`
- `docs/phase-6u-b3-bp-defect-register.md`

---

## Phase BQ addendum (2026-10-18)

Phase BQ ran the eleven storage-freeze browser scenarios against the isolated
HTTPS test service as **real HTTP E2E**, on a freshly built and deployed image.

- **Build and deploy**: `beaconhs:phase-bp-20261018-095008` (`474ccda68ed4`),
  built from this working tree and deployed to the isolated `beaconhs-phase-aj`
  compose project on the test host. Source: HEAD `51a899b7` + the uncommitted HSE
  working tree. No commit, no push; the shared C2 drill and production were
  untouched.
- **Result: 11/11.** Frozen-UX regression 4/4, multipart upload across a freeze
  7/7. Auth was a real magic-link login against the test environment's own
  Mailpit. Freeze state came from the production state machine
  (`applyTransition`) running against that environment's own database — never a
  direct state write. The multipart scenarios uploaded a 256 MiB fixture
  (4 × 64 MiB parts) and verified the stored object's SHA-256 through the pane's
  own presigned capability URL.
- **D-BQ-1 (Critical) — FIXED.** Every document page crashed in a production
  build. `components/collabora-embed.tsx` is a `'use client'` component that
  imported `@/lib/storage-freeze-refusal`, which imports the `@beaconhs/storage`
  root; that module validates the server-only `R2_INTERNAL_ENDPOINT` at import
  time and throws whenever it is absent — which is always true in a browser
  bundle. Split into a client-safe copy module
  (`apps/web/src/lib/storage-freeze-copy.ts`) plus the server-side predicate.
  Verified: `R2_INTERNAL_ENDPOINT is required` no longer appears in any client
  chunk.
- **D-BQ-2 (High) — OPEN.** The PDF pane's pdf.js viewer cannot render a 256 MiB
  PDF; the renderer is killed about 80 s after the viewer mounts. The upload and
  the stored bytes are unaffected. A PDF up to `MAX_PPTX_FILE_BYTES` (1 GiB) is
  accepted as a document source, so this is reachable. Not fixed here.
- **D-BQ-3 (Medium) — FIXED.** `collabora-embed.tsx` rendered the
  `workspace_unavailable` detail as `<GeneratedText id="m_130320500eeb16" />`
  without its `values`, so the user saw the literal `{value0}` placeholder.
  Restored the `values` prop (an unrelated error path that the freeze work had
  regressed).
- **D-BP-1 — CLOSED (verified in the browser).** Both frozen-document refusals now
  surface the product's own frozen copy: **Start blank** shows the frozen action
  toast, **Import Word file** shows the frozen inline error. No masked React error.
- **Finding (no fix; `packages/storage/**` needs an explicit request):** the
  `freeze-gate.ts` header comment claims `presignPut` and `presignMultipartPart`
  are **not** gated, but `index.ts` gates both.
- **Finding (no fix):** `apps/web/scripts/i18n-source-audit.test.ts` only checks
  for duplicate generated keys, so dropping a `values` prop (D-BQ-3) fails no
  gate.

All six gates pass. Full detail: `docs/phase-bq-e2e-test-report.md`.

---

## Phase BU addendum (2026-10-18)

Phase BU investigated and fixed **D-BQ-2** — the PDF pane's pdf.js viewer killing
the renderer tab on a 256 MiB upload. No assumption about the root cause was
made first; the cause was measured and traced to pdf.js source.

- **Root cause (measured, not assumed)**: a 256 MiB file that is **not** a usable
  PDF (no xref / `%%EOF` trailer — the BQ fixture was a `%PDF-1.7` header
  followed by 256 MiB of a single byte). pdf.js enters its `recoveryMode`
  (`"Warning: Indexing all PDF objects"`), where `XRef.indexObjects()` calls
  `readToken()`, which accumulates one JavaScript string per character of the
  longest run between delimiters. The cost scales with the run length:
  - 1–32 MiB malformed → graceful `Invalid PDF structure.` (sub-second to a few
    seconds, small heap).
  - 64 MiB malformed → graceful, but ~6 s, and the Node probe OOM'd a 2 GiB heap.
  - 128 MiB malformed → graceful, ~9 s, renderer peaked ~2.7 GB.
  - 256 MiB malformed → **renderer crash** at ~31 s, renderer peaked ~4.7 GB.
  - Same 64 MiB bytes with a newline every 1000 bytes → graceful in 0.8 s.
  - `stopAtErrors` did not bound the path.
  - **Valid PDFs are fine at every size**: 5 MiB / 85 MiB / 255 MiB documents
    resolve and render page 1 in ≤0.4 s with negligible heap. So a size cap
    would have broken a working capability for no reason; the defect is feeding
    pdf.js a file that is not a PDF, not file size.
- **Fix 1 — server (`upload-policy.ts` / `uploads.ts`)**: reject any
  `application/pdf` whose last 2 KiB lacks a `startxref` + `%%EOF` trailer
  (`uploadedFileTailError`, bounded read). The BQ fixture and every truncated /
  renamed / damaged file now fail at upload with a real error instead of reaching
  the viewer. Verified by 8 unit tests.
- **Fix 2 — client (`pdf-viewer.tsx` + `pdf-preview-policy.ts`)**: the loading
  task is now held and `destroy()`-ed on unmount / replacement, and a 10 s load
  watchdog terminates the worker and shows `Could not load the PDF.` when the
  recovery path runs. Verified in the browser: the 256 MiB fixture no longer
  crashes — the watchdog fires at 10 s, the worker is destroyed, and the error
  surface is shown; the same file with the watchdog disabled still crashes at
  ~39 s (negative control).
- **Option A (lower the upload cap) was evaluated and rejected** on the evidence
  above; Option B's "lazy/paged rendering" is already implemented in the
  viewer, so the only remaining gap was the pathological recovery path.
- **E2E**: the Phase BQ harness was reused (trailer rejection + normal preview).
  Full detail: `docs/phase-6u-b3-bu-pdf-viewer-report.md`.
- **Manual**: `knowledge-assets.ts` ("Uploaded PDFs") now states the completeness
  requirement.

All six gates pass. No commit, no push; working-tree changes preserved.

---

## 1. Current baseline

| Item                             | State                                                  |
| -------------------------------- | ------------------------------------------------------ |
| Git HEAD                         | `51a899b7`                                             |
| Node / pnpm / Git                | `v24.21.0` / `10.30.3` / `2.53.0`                      |
| OpenCode                         | **v2.0.18**                                            |
| TypeScript                       | `^6.0.3`                                               |
| Compose baseline                 | see `git diff -- docker-compose.yml` (working tree)    |
| Containers                       | local Postgres + Collabora used for EA-12 verification |
| Migrations applied               | 51                                                     |
| Public tables                    | 197                                                    |
| `FORCE ROW LEVEL SECURITY`       | 192 (191 tenant-scoped + `tenants`)                    |
| `TENANT_SCOPED_TABLES`           | 191                                                    |
| `PERMISSION_CATALOGUE`           | **107 unique keys**                                    |
| Report entities / seeded reports | 18 / 35                                                |
| Dashboard widgets                | 30                                                     |
| Form field types                 | 46                                                     |
| Flow triggers / actions          | 6 / 13                                                 |

Storage baseline: **MinIO**, built from pinned archived source commit
`9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a` (tag `RELEASE.2025-10-15T17-29-55Z`).
25/25 acceptance conditions passed. **No SeaweedFS. `packages/storage/**`
unmodified.**

Tenant isolation proven live:

```
beaconhs_app, no app.tenant_id  -> people = 0
beaconhs_app, app.tenant_id set -> people = 10
beaconhs_super (BYPASSRLS)      -> people = 10
```

## 2. Current phase

**EA-66D.18 — ID badge: portrait upload and CJK rendering (2026-11-07).**
Two of the three reported badge problems were real defects. `people.photo_attachment_id` was read by the badge renderer, the verify pages and the detail page but had no writer anywhere, so a portrait could never be set — there is now a manage-or-self uploader on the person page. And the render container had no CJK font, so tenant/person/department names showed as tofu boxes; `fonts-noto-cjk` is installed and every PDF font stack gained a CJK fallback. The third report — extra white lines on the left of the printed PDF — was pixel-checked and the render is clean; a screenshot is needed to locate it. Image `sha256:627424c1…`, deployment `4920a680…-20261101-001`, Gate 5 PASS. See the EA-66D.18 addendum below.

**Historical — EA-66D.17 portrait-phone sweep: shared chrome now wraps (2026-11-07).**
A 390×844 scan of 24 pages found three overflow spots: the hazard-assessment header's action group reached 428px, and the module/tab strips scrolled off-screen (Equipment to 468px, Compliance to 402px). The shared `PageHeader` now drops its actions below the title on phones, and `ModuleSubNav`/`SectionNav`/`TabNav` wrap at every breakpoint instead of scrolling; a contract test pins the wrapping. Verified zero overflow on the affected pages. Image `sha256:df2cc065…`, deployment `24129c13…-20261101-001`, Gate 5 PASS. See the EA-66D.17 addendum below.

**Historical — EA-66D.16 out-of-the-box foundations completed (2026-11-07).**
The remaining empty catalogues were filled: PPE criteria banks (5), starter email templates (4), data sources (4: sites, contractors, work-permit responses, lift-plan responses), the Toolbox Talk app, and report definitions. Banks, person groups and the skill catalogue were already extracted in EA-66D.15; this pass adds the last reference seeders, wires them into provisioning with completeness assertions, and adds a replayable `backfill:reference-catalogues` command. The backfill's name-matching recreated Chinese/English duplicates once more; they were deduplicated in the tenant, and the PPE seeder now matches by category. Image `sha256:31c2f27f…`, deployment `723e0cb9…-20261101-001`, Gate 5 PASS. See the EA-66D.16 addendum below.

**Historical — EA-66D.15 reference catalogues backfilled (2026-11-07).**
An audit found the production tenant missing whole reference catalogues: inspection banks (0), inspection criteria (0 — one hand-made type with an empty checklist), equipment types/categories (0), person groups (0), skill catalogue (0), PDF templates (0). Inspection banks, person groups and the skill catalogue were extracted from the demo seed into idempotent reference seeders; `seedInspectionTypes` now backfills criteria per type instead of skipping wholesale; provisioning seeds all of the above plus the already every-tenant equipment/register/PDF/work-permit seeders; and a `backfill:reference-catalogues` CLI replays the same set for existing tenants. Backfill deduplicated the Chinese/English PPE and document-category pairs it exposed. Image `sha256:7d75cd67…`, deployment `a8d370ff…-20261101-001`, Gate 5 PASS. See the EA-66D.15 addendum below.

**Historical — EA-66D.14 first-run setup uses the shared region catalogue (2026-11-06).**
`/setup` took its region as free text while the platform form had a dropdown. It now renders the same `TENANT_REGIONS` catalogue, which grew to 25 entries with `cn-north-1` (Beijing), `cn-northwest-1` (Ningxia) and `ap-southeast-4` (Melbourne), all with Chinese labels. Image `sha256:91979e0b…`, deployment `33c414b3…-20261101-001`, Gate 5 PASS; production shows 25 options including the new ones. See the EA-66D.14 addendum below.

**Historical — EA-66D.13 tenant region dropdown expanded (2026-11-06).**
The create-tenant form hard-coded three regions (Canada Central, US East, EU West) even though `tenants.region` is free text and `/setup` accepts anything. A shared `TENANT_REGIONS` catalogue (22 regions, APAC first) now drives the dropdown with Chinese labels; the default is unchanged. Image `sha256:eccc4d1c…`, deployment `b12e7364…-20261101-001`, Gate 5 PASS; verified 22 options in production. See the EA-66D.13 addendum below.

**Historical — EA-66D.12 orphaned responses could not be deleted (2026-11-02).**
Response `0c531151` was stuck: its parent HazID assessment had been deleted, and the shared parent-first lock throws an integrity error when the parent is gone. The delete action did not catch it, so the whole operation failed. A missing parent now means "nothing to lock, proceed"; a parent that still exists but is locked is a real refusal with its own message; anything else still throws. Classification is a tested pure function. Image `sha256:da9e8687…`, deployment `5cf66954…-20261101-001`, Gate 5 PASS, all six gates green; the response was deleted in production with `deleted_at` set and an audit row. See the EA-66D.12 addendum below.

**Historical — EA-66D.11 role scope picker saved every tenant-wide choice as self (2026-11-02).**
The scope picker's serializer handled self/sites/crews/people/team but not `tenant`, so "Everyone in the tenant" fell through to the default and was stored as `{ type: 'self' }` — which is why both options showed "Own records only". The serializer is now a pure `toRoleScope()` with a tenant branch and a regression test, and the picker's six labels/helps plus the summary strings are translated. Verified in production: the dropdown shows six distinct Chinese options and selecting tenant serializes `{"type":"tenant"}`. Image `sha256:406de487…`, deployment `ab6af13a…-20261101-001`, Gate 5 PASS, all six gates green. See the EA-66D.11 addendum below.

**Historical — EA-66D.10 app and response deletion with permissions (2026-11-02).**
Neither deletion existed: the permission keys `forms.template.delete` and `forms.response.delete` were declared but no action or button used them. Both are now implemented as guarded soft deletes — the app card's Delete action refuses while responses or automations exist, the response row/detail Delete refuses for responses that are compliance evidence, both take the shared parent lock for responses, both write audit rows, and refusals return to the list with a translated message. A new manual article covers the flows. Image `sha256:0d6d7c9a…`, deployment `285e328c…-20261101-001`, Gate 5 PASS, all six gates green; production verified the refusal path, a response delete and an app delete. See the EA-66D.10 addendum below.

**Historical — EA-66D.9 builder designer layout on portrait phones (2026-11-02).**
The app designer (`/apps/templates/[id]/designer`) overflowed at 390 px — header controls reached 496 px, the 288 px element palette squeezed the canvas, and the title collapsed into a vertical strip. Below 1024 px the palette is now a full-width block capped at 45vh with its own scroll, the canvas sits below at full width, and both toolbars wrap. The new-app picker's five structure blurbs and two labels were also catalogued in Chinese. Verified at 390×844 (`scrollWidth 390`, zero overflow, palette 390×380) and 1440×900 (288 px side panel preserved). Image `sha256:ff4adf7b…`, deployment `31424542…-20261101-001`, Gate 5 PASS, all six gates green. See the EA-66D.9 addendum below.

**Historical — EA-66D.8 document preview/upload layout on portrait phones (2026-11-02).**
The document detail page kept its fixed "details 1/3 + preview 2/3" split at 390 px, squeezing the preview to about 100 px and pushing the toolbar off-screen. Below 1024 px it now stacks vertically — full-width details, then a 70vh preview — while the top bar and both toolbars wrap instead of clipping. Verified at 390×844 (scrollWidth 390, zero overflowing elements, details 390×575) and 1440×900 (split preserved). Image `sha256:a7abb9c0…`, deployment `84b57345…-20261101-001`, Gate 5 PASS, all six gates green. See the EA-66D.8 addendum below.

**Historical — EA-66D.7 hazard-assessment and module-manage localization (2026-11-02).**
The hazard assessment module still showed English after EA-66D.6, from two sources the earlier sweep did not cover: the tenant's `hazid_*` reference data (assessment types, hazard types, 12 hazards with controls, 8 tasks, 3 sets) and the `MODULE_ADMIN` registry labels/descriptions, which are configuration-object literals rendered through `GeneratedValue`. Both are fixed — reference rows are Chinese in the production tenant, and about 100 registry strings are catalogued, which also clears every module's Manage hub. Image `sha256:553f4113…`, deployment `6181321b…-20261101-001`, Gate 5 PASS, all six gates green, and `/hazard-assessments`, `/hazards`, `/tasks`, `/hazard-assessments/manage`, `/documents/manage`, `/equipment/manage`, `/ppe/manage` each contain zero English-only lines. See the EA-66D.7 addendum below.

**Historical — EA-66D.6 Chinese localization repair and the PPE reflective vest (2026-11-01).**
Switching to Chinese left English in three places that the i18n audit did not cover: the `allLabel` filter attribute (30 occurrences), description strings held in page config objects (`/admin`, `/platform`, training editor, vehicle-log settings — about 75), and reference data stored in English (PPE types, document types and categories). All are fixed, the audit now includes `allLabel`, and the production tenant's reference names are Chinese. PPE gained a **反光衣** type (plus `Reflective vest` in the canonical seed), and the new Writing-documents help article has a full Chinese body. Image `sha256:2a4ccda6…`, deployment `a57eac5b…-20261101-001`, Gate 5 PASS, all six gates green, and every audited page now has zero English-only lines. See the EA-66D.6 addendum below.

**Historical — EA-66D.5 Word, PowerPoint and Excel as document masters (2026-11-01).**
The documents module now accepts `.docx`, `.pptx` and `.xlsx` as the working master. The editor is chosen by type (Collabora Writer / Impress / Calc), publishing snapshots the source in its real type, and the worker renders the PDF of record with LibreOffice — which required adding `libreoffice-calc` to the image. Image `beaconhs@sha256:cec17683…`, deployment `e7895e6d…-20261101-001`, Gate 5 PASS, 8/8 services healthy, data unchanged (`users=1, tenants=1, migrations=51`); all six gates pass. Browser confirmation of a real PPT and Excel import is the last step. See the EA-66D.5 addendum below.

**Historical — EA-66D.4 production deployment at https://hse.xuhaoqing.top (2026-11-01).**
The verified EA-66D.3.1 image (`sha256:d5d72545…`) now runs on the production host `10.10.31.13` (Ubuntu 26.04, Docker 29.1.3, Compose 2.40.3) with Gate 5 PASS, deployment `b2e5f385…-20261101-001`, 51 migrations applied and a cold volume snapshot taken before business initialization. The public entry answers 200 and `/setup` now reports "Setup complete / The platform is initialized". The web host port is now a variable (`BEACONHS_WEB_PORT`, default 3000, production 8000) so one Canonical Compose serves both hosts. **Business initialization is complete and was performed by the user in the browser:** administrator `admin@example.com`, workspace 「马来西亚项目群」 (`slug=cccc`), SMTP configured with a successful test send. The agent created no account and holds no password. Rollback has a snapshot but no executed restore, so it remains `FAIL — NO EXECUTABLE ROLLBACK PATH`. See the EA-66D.4 addendum below.

**Historical — EA-66D.3.1 internal-only object storage and lifecycle scripts (2026-10-31).**

**Historical — release-readiness hardening, EA-60 Gate 5 instance completeness (2026-10-30).**
The deployment was confirmed to be a **Swarm stack** (`composeType: "stack"`, `deploy.replicas` in the compose file, both rollout paths acting on `<stack>_<role>` services), so no Compose-container inspection path was built. The EA-59 defect **F-59-1** is fixed: Gate 5 now requires a roster file describing the stack, digest, provenance and per-role replica/liveness expectations, refuses to run without one, and fails closed when a rostered service is missing, an unrostered service runs the gated image, the replica spec disagrees with the roster, a live task carries another digest, a one-shot role has no completed task on the gated digest, or any query fails. The roster is generated by the workflow from values it already owns and is never derived from the fleet query. Verified by 52 deployment-control tests (16 new), 31 build-identity tests, and 25 isolated scenarios against the shipped script, all passing. **Nothing remote was executed:** real GitHub Actions `NOT RUN`, GHCR `NOT RUN`, Dokploy Gate 5 and live Swarm confirmation `NOT VERIFIED`. Rollback remains `FAIL — NO EXECUTABLE ROLLBACK PATH`; production remains `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`. See the EA-60 addendum below; the EA-59 investigation that found F-59-1 is summarised in that addendum, and the EA-58 repair it builds on in the EA-58 addendum.

**Phase 0 — Infrastructure and baseline. Complete.**

Specifically: storage audit and MinIO restoration, SeaweedFS incompatibility
investigation, HSE development baseline analysis, and OpenCode V2 project
infrastructure.

**Phase 11-F — HSE reporting / dashboard coverage. Complete (working tree; not
committed).**

Delivered in this round:

| Item                            | What actually changed                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Report projections → real VIEWs | `compliance_status`, `monitored_sessions` and `hazid_signatures` were authored `from` subqueries. The report engine honours `from`; the public API does not — `apps/web/src/lib/api/query.ts` emits `FROM "${entity.table}"` literally — so each resolved a relation that was never created. All three are now real views. |
| `compliance` API permission     | `READ_PERMISSION_BY_CATEGORY` gained `compliance: 'compliance.read.all'` — an **existing** catalogue key, matching the ladder `TABLE_SCOPE` already binds. No new permission; no catalogue, RoleScope or RLS change.                                                                                                       |
| Environment report              | `report_environmental_monitoring`, keyed by the stable `form_templates.key = 'environmental-monitoring-log'`. Reuses the existing `forms` category.                                                                                                                                                                        |
| Statutory report                | `report_statutory_compliance`, keyed by `form_templates.key = 'statutory-compliance-register'`. Same category, same ladder.                                                                                                                                                                                                |
| API default-limit fix           | `clampInt` read an absent `?limit=` as `0` (because `Number(null) === 0` is finite) and clamped it to `min`, so every `/api/v1/{entity}` list call ran `LIMIT 1`. Now `LIMIT 50`.                                                                                                                                          |
| Work Permit Expiry widget       | `op-work-permit-expiry-7d`, on the existing `forms.response.read.*` ladder and the existing `TRUSTED_RESPONSE_KPI` group. No new permission.                                                                                                                                                                               |

Resulting counts:

| Metric            | Value                                                        |
| ----------------- | ------------------------------------------------------------ |
| `REPORT_ENTITIES` | **18**                                                       |
| `report_*` views  | **14** — 1:1 with the 14 `report_`-prefixed curated entities |
| Migration journal | **44** entries, last `0044_inspection_type_fk_snapshot`      |
| New migrations    | **0** in this round                                          |
| Functional gates  | all green                                                    |
| `format:check`    | exit 1 — only the 3 pre-existing baseline files, untouched   |

**No new migration was created for any of this.** Report-view DDL belongs to
`REPORT_VIEWS_SQL` in `packages/db/src/views.ts`, which `applyReportingViews()`
applies idempotently on every `db:migrate` — the same mechanism as the RLS
policies — so a view is not a journal event. Verified on a throwaway database:
the full chain applied with 0 errors and all 14 views present.

**Local release acceptance (EA-1 … EA-11). Complete in the working tree; no
deployment was performed.**

The release candidate at `51a899b7` was exercised locally end to end: database
and tenant isolation, the authorization matrix, file lifecycle and storage
freeze, PDF preview and version-level replacement, the local build/deploy key
gates, a release security audit, a ten-scenario rollback drill, readiness and
database backup/restore, and a full format-2 (encrypted) object-store backup,
tamper matrix and restore. EA-11 then indexed that evidence, re-checked every
release blocker and audited the change scope without re-running the suites or
permitting a deploy: `docs/phase-6u-b3-ea11-release-decision-audit.md`. Evidence:
`docs/phase-6u-b3-ea1-push-ci.md` …
`docs/phase-6u-b3-ea10-encrypted-restore-readiness.md`. Production deployment, a
real production restore, a genuinely multi-node Swarm run and the GHCR/GHA cache
path remain **NOT RUN**; the local drills are not production approval.

**EA-12 — local defect fixes. Complete in the working tree; no deployment.**

Fixed the public-API `monitored_sessions` 500, confirmed D1/D2 already fixed and
removed their stale documentation, removed the three D3 dead columns via
migration `0051`, repaired the D4 PPE notification path, completed the D5
equipment flow status list, corrected D6, and made the fingerprint CLI test clean
up its temporary directories. The live cross-tenant test passed against a
dedicated scratch database with all 51 migrations applied. The full six-gate
result is recorded in the EA-12 addendum.

## 3. Completed

| Work                                                                                                                                                 | Evidence                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Official compose baseline restored                                                                                                                   | `docs/beaconhs-official-deployment-baseline.md`                                                                      |
| Storage subsystem audit                                                                                                                              | `docs/beaconhs-storage-audit.md`                                                                                     |
| SeaweedFS impact analysis + runtime verification                                                                                                     | `docs/beaconhs-seaweedfs-impact.md`, `docs/beaconhs-seaweedfs-verification.md`                                       |
| MinIO rebuilt from pinned archived source                                                                                                            | `docs/beaconhs-minio-build.md`                                                                                       |
| Storage E2E verification (25/25)                                                                                                                     | `docs/beaconhs-storage-minio-verification.md`                                                                        |
| Cleanup inventory and execution                                                                                                                      | `docs/beaconhs-cleanup-inventory.md`, `docs/beaconhs-cleanup-execution.md`                                           |
| Architecture and capability audit                                                                                                                    | `docs/beaconhs-architecture.md`, `docs/beaconhs-capability-matrix.md`                                                |
| Extension points                                                                                                                                     | `docs/beaconhs-extension-points.md`                                                                                  |
| HSE gap analysis                                                                                                                                     | `docs/hse-gap-analysis.md`                                                                                           |
| **HSE development baseline** (17-capability matrix, 3 data-model deep dives, phase plan)                                                             | `docs/hse-development-baseline.md`                                                                                   |
| **OpenCode V2 infrastructure** (config, permissions, 3 MCP, 12 skills, 9 agents, 9 baselines)                                                        | `docs/opencode-*.md`                                                                                                 |
| Phase 11-F Step 1 — seed-only reports (work permit expiry, safety observations, contractor register)                                                 | `packages/db/src/seed/report-definitions.ts` (35 seeds)                                                              |
| Phase 11-F Step 2 — safety observations dashboard metric + widget                                                                                    | `apps/web/src/app/(app)/dashboard/_metrics.ts`, `_safety-observations-metric.test.ts`                                |
| Phase 11-F close-out — 3 authored projections promoted to real `report_*` views                                                                      | `packages/db/src/views.ts`, `packages/reports/src/entities.ts`, `packages/db/src/reporting-view-cutover.test.ts`     |
| Phase 11-F close-out — `compliance` API read gate                                                                                                    | `apps/web/src/lib/api/permissions.ts`, `apps/web/src/lib/api/permissions.test.ts`                                    |
| Phase 11-F close-out — Environment + Statutory reports                                                                                               | `REPORT_VIEWS_SQL` in `packages/db/src/views.ts`; `report_environmental_monitoring`, `report_statutory_compliance`   |
| Phase 11-F close-out — API default-limit fix (`LIMIT 1` → `LIMIT 50`)                                                                                | `apps/web/src/lib/api/query.ts:43`, `apps/web/src/lib/api/list-pagination.test.ts`                                   |
| Phase 11-F close-out — Work Permit Expiry dashboard widget                                                                                           | `_metrics.ts`, `_widget-registry.ts`, `_widget-views.tsx`, `_widget-access.ts`, `_work-permit-expiry-metric.test.ts` |
| Phase 12-A — **D7 fixed**: `report_monitored_sessions` site column is now a real org-unit uuid                                                       | `packages/db/src/views.ts`, `packages/db/src/reporting-view-cutover.test.ts`                                         |
| Phase 12-B — **D10 fixed**: `report_monitored_sessions` self-scope column is now a real person uuid                                                  | `packages/db/src/views.ts`, `packages/db/src/reporting-view-cutover.test.ts`                                         |
| Phase 12-C — Employee display rebound to `subject_person_name`, self-scope column left as the raw uuid                                               | `packages/reports/src/entities.ts`, `packages/reports/src/phase11f-report-integrity.test.ts`                         |
| Phase 12-D — lifecycle audit: Work Permit, Inspection→CA, Observation→CA, Contractor all verified E2E                                                | `apps/worker/src/workers/scheduled.ts`, `apps/web/src/lib/flows/spawn.ts`, `adapters/{inspections,journals}.ts`      |
| EA-1 … EA-6 — push/CI state, local acceptance, file lifecycle/freeze, PDF + key gate, local deploy workflow, local release candidate                 | `docs/phase-6u-b3-ea1-push-ci.md` … `docs/phase-6u-b3-ea6-local-release-candidate.md`                                |
| EA-7 — release security audit (5 defects fixed)                                                                                                      | `docs/phase-6u-b3-ea7-release-security-audit.md`                                                                     |
| EA-8 — ten-scenario rollback drill, eleven fault injections, half-rolled-fleet gate fixed                                                            | `docs/phase-6u-b3-ea8-rollback-drill.md`                                                                             |
| EA-9 — readiness schema guard (DB-ahead fails closed), database and object-store round trips                                                         | `docs/phase-6u-b3-ea9-backup-restore-readiness.md`                                                                   |
| EA-10 — format-2 encrypted backup/tamper/restore, restored-DB readiness, replica coverage contract                                                   | `docs/phase-6u-b3-ea10-encrypted-restore-readiness.md`, `docs/backup-restore-runbook.md`                             |
| EA-11 — release-decision audit: evidence index, blocker review, change-scope/secret/remote-operation audit                                           | `docs/phase-6u-b3-ea11-release-decision-audit.md`                                                                    |
| EA-12 — local defect fixes: API 500, D1/D2 stale-doc correction, D3 dead-column drop, D4 notification, D5 flow states, D6 comment, test temp cleanup | `docs/phase-6u-b3-ea12-fix-summary.md`; `packages/db/drizzle/0051_ea12_drop_dead_columns.sql`                        |

## 4. In progress

**Nothing.** The local release acceptance series (EA-1 … EA-11) and EA-12 local
fixes are complete in the working tree; no deployment has been performed. HEAD
is `51a899b7` on `hse-platform` (45 commits ahead of `origin/main`), with 164
modified and 874 untracked files, 0 staged — nothing has been committed or
pushed. The untracked count includes generated/local-only material and is not a
claim that all of it is part of EA-12.

## 5. Blocked

| Blocker                               | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase start not authorised            | HSE feature development has not been authorised to begin. All plans are ready; nothing is in flight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| LSP unavailable (platform)            | OpenCode V2 does not run language servers or expose LSP tools. Substitute is `pnpm typecheck` + `lint` + `test`. Not fixable in this environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GitHub MCP (resolved 2026-11-08)      | **Connected** — 46 `github_*` tools; `github.get_me()` returns `xu151077`. Auth is a PAT in `~/.config/opencode/github-token`, not OAuth; the 2026-11-07 401 "credential expired" was an expired token, refresh path in `docs/opencode-mcp-baseline.md` §6.                                                                                                                                                                                                                                                                                                                                                                               |
| Host memory                           | ~3.4 GB RAM. Next.js page compiles have OOM-killed the dev server under parallel load. Compile one route at a time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| No E2E suite                          | No Playwright dependency, config or checked-in tests. Browser verification is via the playwright MCP and the built-in `browser` tool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Contractor headcount widget           | **Not implemented — no data.** `companies` = 0 rows and `people.company_id` = 0 of 12 active people. The substrate is ready (`companies` is in `TENANT_SCOPED_TABLES`, `FORCE ROW LEVEL SECURITY`), so this is purely a data gap. A tile would read a permanent `0`, indistinguishable from "no contractors". The seeded `contractor_company_register` report is equally empty.                                                                                                                                                                                                                                                           |
| Calibration / Fire reports            | **Not implemented — no data.** `Calibrated Instruments` and `Fire protection` have 5 equipment _types_ each but **0 items**; `equipment_inspection_records` = **0 rows**; the 3 non-Calibration schedules carry a NULL `inspection_type_id`. No fixtures were manufactured.                                                                                                                                                                                                                                                                                                                                                               |
| Work Permit Expiry verified E2E       | **Complete, and now proven against real rows.** The production flow action `start_monitored_session` was driven through `createFormFlowAdapter`; it set `monitor_status=active`, the interval and grace it was given, `next_checkin_due_at` and `expected_end_at`. The row then appeared in `report_monitored_sessions` with a readable Employee, the `work_permit_expiry` seed returned it through the production executor, and the dashboard tile counted it (`total 6, overdue 1` after one session was pushed past its end). That was a throwaway fixture, since dropped — the dev tenant still has no monitored sessions of its own. |
| 82 FKs absent from the snapshot chain | Pre-existing systemic gap (513 in the snapshot vs 596 in Postgres). Only the `equipment_inspection_schedules.inspection_type_id` composite FK was reconciled (`0044_inspection_type_fk_snapshot`). The other 82 remain **out of scope**.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tag-filtered lifecycle execution      | Rules store and read back correctly; expiry worker did not fire in-window. Runtime behaviour of that path is UNVERIFIED.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Production deploy + rollback NOT RUN  | EA-8 proved rollback locally; the real `deploy-dev.yml` path, the Dokploy service update and the real rollback have not been executed. Needs explicit authorisation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Production restore NOT RUN            | EA-9/EA-10 restored local dumps and an encrypted object-store backup. No production backup was restored, and no production RPO/RTO figure exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Real multi-node Swarm NOT RUN         | `verify_replicas` can only enumerate tasks on the local node. EA-10 extracted the task/coverage contract and tested it with fixtures; it does not prove multi-node placement.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GHCR / GHA cache path NOT RUN         | The registry-backed build and Actions cache path were never exercised; local images were built from the local Dockerfile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| WOPI frozen re-open                   | Known / unresolved, low priority, investigation paused by the owner. `SaveFile` returned 423 on the frozen document in EA-2/EA-3; no further investigation is authorised.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 6. Defect register

Open defects are recorded here. **Do not fix an open defect as a side effect of
unrelated work, and do not silently work around it.** Fixed entries stay in the
register with their verification evidence.

| ID      | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Location / status                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | **FIXED (EA-12).** The nav and module-admin references were corrected to catalogue keys and are pinned by a regression test; the previous text was stale.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `apps/web/src/lib/nav/registry.ts`, `apps/web/src/lib/module-admin/registry.ts`; catalogue-key test                                            |
| **D2**  | **FIXED (EA-12).** The `people` nav entry and direct route require `people.read.all`; workforce master data is no longer visible to every authenticated user, and the export is gated too. The previous text was stale.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `/people` access and export tests                                                                                                              |
| **D3**  | **FIXED (EA-12).** Removed the dead columns `training_enrollments.expires_on` / `due_on` and `equipment_inspection_records.certificate`. The only code references were two write-only enrollment assignments (a due date no surface read, and `expires_on` always set to null); those writes were removed with the columns. All three had zero non-null rows before the drop; migration `0051` applied locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `packages/db/drizzle/0051_ea12_drop_dead_columns.sql`; `packages/db/src/ea12-dead-columns.test.ts`                                             |
| **D4**  | **FIXED (EA-12).** The PPE failed-inspection → corrective-action path now records `corrective_action.created` with the same notification, integration and web-flow payloads as inspections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `apps/web/src/app/(app)/ppe/_lib.ts`; `_lib.test.ts`                                                                                           |
| **D5**  | **FIXED (EA-12).** The `equipment` flow profile now offers all eight real work-order statuses, including `repaired` and `verified`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `apps/web/src/lib/flows/module-profiles.ts`; `module-profiles.test.ts`                                                                         |
| **D6**  | **FIXED (EA-12).** The stale "four canonical form templates" comment now describes the single current canonical template and the deliberate non-canonical built-ins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `packages/db/src/seed.ts`                                                                                                                      |
| **D7**  | **FIXED (Phase 12-A).** `report_monitored_sessions` projected `location.name AS site_org_unit_id` — a display name in the column `TABLE_SCOPE` filters as an org-unit UUID, so site-scoped callers could never narrow it (a name never equals a uuid, and casting one is a hard `invalid input syntax for type uuid` error). `site_org_unit_id` now carries the real `form_responses.site_org_unit_id` and the label moved to its own `site_name`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `packages/db/src/views.ts`; verified live: `read.site` + Site A → 1 row, + Site B → 1 row, `read.site` with no sites → 0                       |
| **D10** | **FIXED (Phase 12-B).** `report_monitored_sessions` projected the resolved NAME as `subject_person_id`, but `PERSON_COLUMNS` falls back to that column and compares it against a person **uuid**, so a self-tier caller could never match their own sessions — proven live: 0 rows before, correct rows after, and casting the name as a uuid raises `invalid input syntax for type uuid`. It now carries the real `person.id` (NULL when there is no person); the readable name moved to `subject_person_name`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `packages/db/src/views.ts`; verified live: self as Alice → only Alice's 2 sessions, self as Bob → only Bob's 2, `read.self` with no person → 0 |
| ~~D11~~ | **RETRACTED — this was a false finding, not a defect.** `inspection_records` DOES carry the composite FK `inspection_records_tenant_type_fk FOREIGN KEY (tenant_id, type_id) REFERENCES inspection_types(tenant_id, id)`, declared in the Drizzle schema, recorded in every snapshot from `0005` onward, created by `0005_production_cutover.sql`, and present in Postgres as `convalidated = t`, NOT DEFERRABLE, `ON DELETE NO ACTION`. It is already pinned by `packages/db/src/inspection-relational-integrity.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | see §Audit corrections                                                                                                                         |
| **D8**  | **FIXED (full-project audit, 2026-11-09; migration `0055`).** A live-database audit showed the snapshot chain is a strict subset of Postgres (517 in snapshot vs 599 in DB; 82 db-only). Of those 82: nine single-column CASCADE leftovers (`ai_conversation_shares_*`, `ai_messages_*`, `report_runs_schedule_*`, `role_assignments_*`, `role_dashboard_layouts_role_*`, `user_permission_overrides_tenant_user_id_*`) were exact duplicates of composite tenant FKs already declared in schema and were dropped by `0055_drop_redundant_single_col_fks.sql` (`DROP CONSTRAINT IF EXISTS`). The same audit found the reverse gap — `ATTACHMENT_TENANT_REFERENCES` named `att_tenant_ppe_inspection_attachments_attachment_id_3b75c366` but 0005 never installed it — so 0055 also installs that tenant-attachment FK (`NOT VALID` + `VALIDATE`). The residual 73 (+1) stay intentionally SQL-only: 67 partial `ON DELETE SET NULL (col)` keys (Drizzle cannot express the partial form; tenant_id is NOT NULL so full SET NULL would be wrong) plus attachment-manifest CASCADE keys. They are pinned as an allowlist by `packages/db/src/fk-snapshot-coverage.test.ts`, and schema FK count == snapshot FK count (517). Only `equipment_inspection_schedules.inspection_type_id` remains reconciled via `0044_inspection_type_fk_snapshot`. | `packages/db/drizzle/meta/*.json`; `0055_drop_redundant_single_col_fks.sql`; `packages/db/src/fk-snapshot-coverage.test.ts`                    |
| **D9**  | **FIXED (full-project audit, 2026-11-09).** `canSeeWidget` no longer falls through to "visible to everyone" for an unmapped registered widget: only `personal-*` widgets are ungated, registered org widgets without a `WIDGET_PERMISSIONS` entry are hidden, and non-UUID unknown ids are denied instead of being treated as Insights cards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `apps/web/src/app/(app)/dashboard/_widget-access.ts`; `_widget-access.test.ts`                                                                 |
| **D12** | **FIXED (full-project audit, 2026-11-09).** Unvalidated list/export filter values reached Postgres enum and UUID columns, so crafted query strings could produce HTTP 500s. List/export pages now use `pickEnum`/`pickUuid`, the public API maps Postgres data exceptions to 400, and inline field actions validate record IDs, foreign-key IDs and calendar dates before writing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `apps/web/src/lib/list-params.ts`; `apps/web/src/lib/api/query.ts`; affected list/export and inline-edit actions                               |
| **D13** | **FIXED (full-project audit, 2026-11-09).** The **Send email** People-group server actions required only a signed-in context, so any authenticated tenant member could enumerate group e-mail addresses. Both actions now require `people.read.all`; manual addresses still work for other senders, and the manual states the picker boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/web/src/lib/notifications/person-group-emails-action.ts`; `apps/web/src/lib/manual/content/oversight-admin.ts`                           |
| **D14** | **FIXED (full-project audit, 2026-11-09).** `requestMultipartPartUrl` accepted an upload token without comparing it to the reservation hash. It now verifies the token before issuing a part URL, matching the check already performed by the storage upload route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `apps/web/src/lib/uploads.ts`                                                                                                                  |
| **D15** | **FIXED (full-project audit, 2026-11-09).** The signed internal domain-event route returned the raw exception message to the caller. It now returns a fixed 500 message while keeping the detailed error in server logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `apps/web/src/app/api/internal/domain-events/[id]/route.ts`                                                                                    |
| **D16** | **FIXED (full-project audit, 2026-11-09).** Encrypted object-store backups advertised `--resume`, but the format-2 checkpoint is age-encrypted and the old resume path tried to parse it as plaintext, so resume silently started over. The resume path now decrypts the checkpoint with the age identity before parsing it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `packages/object-store-backup/src/backup.ts`                                                                                                   |

### Tooling and environment defects

| ID     | Issue                                                                                                                                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1** | **FIXED (full-project audit, 2026-11-09).** `turbo.json` `globalEnv` now passes the runtime environment keys used by web/worker tasks, including `R2_ENDPOINT` and `ATTACHMENT_CAPABILITY_SECRET`, instead of stripping them from Turbo child processes. |
| **T2** | `packages/storage/src/index.ts:39-40` uses `??`, which does **not** fall back on an empty string, while `.env.example` ships empty R2 credentials.                                                                                                       |
| **T3** | Node is under nvm and not on the default PATH: `export PATH="/home/test/.nvm/versions/node/v24.21.0/bin:$PATH"`.                                                                                                                                         |
| **T4** | `docker-compose.yml` ships empty R2 credentials that must be filled to match compose `MINIO_ROOT_*`.                                                                                                                                                     |
| **T5** | Only `apps/web` has an eslint script, so `pnpm lint` (turbo) covers one package.                                                                                                                                                                         |

### Audit corrections (self-corrections vs the earlier audit)

**Composite-FK verification pitfall (cost a false defect report).** `pg_constraint.conkey` holds **column attnums**, not names. For a composite FK it is an array like `{2,4}`, so a name filter such as `conkey::text LIKE '%type_id%'` can NEVER match — it silently returns zero rows and reads as "no foreign key exists". `information_schema` is unreliable here for a different reason (it omits composite FKs). Resolve the columns by name against `pg_attribute`, or look the constraint up by `conname`, before concluding anything about a relationship's existence. Data checks should also join explicitly:

```sql
-- orphans / cross-tenant, the way to actually ask the question
select count(*) from inspection_records r
 where not exists (select 1 from inspection_types t where t.id = r.type_id);
select count(*) from inspection_records r
  join inspection_types t on t.id = r.type_id
 where t.tenant_id <> r.tenant_id;
```

| Prior claim                                   | Actual at HEAD                            |
| --------------------------------------------- | ----------------------------------------- |
| 92 permission keys                            | **107**                                   |
| 12 report entities                            | **18**                                    |
| 39 form field types                           | **46**                                    |
| "equipment inspections lack inspector fields" | They have **3**; the real gap is narrower |

## 7. Architecture decisions

| #      | Decision                                                                                                                                                                                                                                                                                                                           | Rationale                                                                                                                                                                                                                                                                                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADR-1  | **Builder-first.** Native modules only for a complex state machine, dedicated API, dedicated permission, transactional cross-model logic, performance, or an authoritative queryable record.                                                                                                                                       | The form engine already has 46 field types, 6 triggers, 13 actions and a gate store.                                                                                                                                                                                                                                                                                     |
| ADR-2  | **Only two NEW native modules** are justified: `findings` and `risks`. Plus one new table, `machinery_certificates`.                                                                                                                                                                                                               | Every other HSE capability reuses an existing module. See `docs/hse-development-baseline.md` §15.                                                                                                                                                                                                                                                                        |
| ADR-3  | **No second lifecycle.** Modules that can link to `corrective_actions` must, rather than re-inventing owner/due/verification.                                                                                                                                                                                                      | Eight partial lifecycles exist today; that is the failure mode to avoid repeating.                                                                                                                                                                                                                                                                                       |
| ADR-4  | **Never persist a computed risk score.** Persist likelihood/severity inputs; derive the score at render.                                                                                                                                                                                                                           | Matches the existing design at `apps/web/src/components/risk-matrix.tsx:120-123`.                                                                                                                                                                                                                                                                                        |
| ADR-5  | **Project scoping is additive, not a new subsystem.** Reuse `people_assignments` + validity window (the precedent at `packages/compliance/src/audience.ts:89-104`).                                                                                                                                                                | Avoids re-creating User/Organization/Permission concepts.                                                                                                                                                                                                                                                                                                                |
| ADR-6  | **Storage stays abstract.** MinIO is the local baseline, Cloudflare R2 the production target. No module may couple to a vendor.                                                                                                                                                                                                    | `docs/beaconhs-seaweedfs-verification.md` proved vendor coupling is a real correctness risk.                                                                                                                                                                                                                                                                             |
| ADR-7  | **MinIO image built from pinned archived source**, not a floating tag or unknown prebuilt binary.                                                                                                                                                                                                                                  | The official `minio/minio` Docker Hub image was deleted 2026-09-11.                                                                                                                                                                                                                                                                                                      |
| ADR-8  | **Gate suppression is denied in configuration, not merely discouraged.** `--no-verify`, `eslint-disable`, `ts-ignore` are `deny` in `.opencode/opencode.jsonc`.                                                                                                                                                                    | `AGENTS.md` rule 8 is enforced mechanically rather than by trust.                                                                                                                                                                                                                                                                                                        |
| ADR-9  | **Destructive git is `deny` at the permission layer**, with judgement guidance in the `git-safety` skill.                                                                                                                                                                                                                          | Mechanical blocks belong in permissions, not in a plugin hook that can fail open.                                                                                                                                                                                                                                                                                        |
| ADR-10 | **No custom tools yet.** MCP + skills + agents are sufficient.                                                                                                                                                                                                                                                                     | See `docs/opencode-tools-evaluation.md`.                                                                                                                                                                                                                                                                                                                                 |
| ADR-11 | **No plugins.** Built-ins plus skills and agents cover every need.                                                                                                                                                                                                                                                                 | See `docs/opencode-plugin-baseline.md`.                                                                                                                                                                                                                                                                                                                                  |
| ADR-12 | **Report-view DDL lives in `REPORT_VIEWS_SQL`, never in a migration.** `packages/db/src/views.ts` is applied idempotently by `applyReportingViews()` on every `db:migrate`, exactly like the RLS policies, so a view is not a journal event.                                                                                       | All 9 pre-existing `report_*` views already lived there. A first attempt put the new views in migration `0045`; that would have created a **second, parallel mechanism** for the same DDL, which AGENTS.md rules 4/5/6 forbid, so it was reverted. `report_ppe_items` appears in both `views.ts` and migration `0034`, but `views.ts` is the maintained source of truth. |
| ADR-13 | **A curated entity may not hide its relation behind an authored `from`.** The report engine honours `entity.from`; the public API does not, so an authored subquery published an endpoint resolving a relation that never existed.                                                                                                 | `/api/v1/hazid_signatures` shipped a real 500 (`relation "report_hazid_signatures" does not exist`). Enforced by test in `packages/reports/src/phase11f-report-integrity.test.ts`.                                                                                                                                                                                       |
| ADR-14 | **Report projections select real filters, and every payload cast is regex-guarded.** The two Builder-backed views derive columns only from keys that actually occur in the payloads, keep the raw `payload` jsonb, and guard numeric/date casts so one malformed legacy value yields `NULL` instead of failing the whole relation. | Payloads are free text written by a form filler. Verified by injecting `"not-a-number"` into `reading_value`: the view still returned its rows.                                                                                                                                                                                                                          |

## 8. Next task

**The local release acceptance series (EA-1 … EA-11) and EA-12 local fixes are
closed out; nothing is in flight.** Nothing has been committed or pushed, so the
immediate next step is a decision about the working tree, not new development.
The release itself is blocked on authorisation for the real deployment and
rollback, a real production restore, a genuinely multi-node Swarm run and the
GHCR/GHA cache path. The WOPI frozen-document behaviour is an open, deliberately
paused risk.

The blocked and deferred items are all **data- or decision-blocked, not
code-blocked**:

| Item                        | Unblocked by                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Calibration / Fire reports  | Real `equipment_items` in the two categories, or real `equipment_inspection_records`. The FK is already reconciled and validated, so the projection is structurally safe to build.                                                                                                                                                         |
| Contractor headcount widget | At least one `companies` row with `people.company_id` populated.                                                                                                                                                                                                                                                                           |
| D8 snapshot FKs             | Resolved 2026-11-09: the 9 redundant single-column FKs were dropped by `0055_drop_redundant_single_col_fks.sql`, the missing `ppe_inspection_attachments` tenant-attachment FK was installed there, and the 73 (+1) intentional SQL-only keys are pinned by `packages/db/src/fk-snapshot-coverage.test.ts`. `check:migration-drift` green. |

Note for whoever picks this up: the Work Permit Expiry widget and the
`work_permit_expiry` report are both **finished and correct** — they read `0`
only because the dev tenant has never used monitored sessions. Do not "fix" that
by inserting rows.

**Historical context — the phase plan this sits inside:**

<details>
<summary>Phase 1-10 sequence from <code>docs/hse-development-baseline.md</code> §17</summary>

When authorised, the sequence from `docs/hse-development-baseline.md` §17:

| Phase | Scope                                                                                                                                        | Exit criterion                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **1** | Data model unification — remove dead columns, unify expiry-status and expiry-derivation helpers, fix the `equipment` flow `statusValues` gap | Dead columns gone; one expiry-status function; `pnpm test` and `pnpm typecheck` green |
| **2** | Certificate ADAPT — add `machinery_certificates`, native expiry notifier, missing report columns/entities                                    | Certificate table migrated; notification path proven                                  |
| **3** | Finding NEW — the canonical ancestor table + typed links from all 8 lifecycles                                                               | `findings` exists; every lifecycle links; manual articles updated                     |
| **4** | Risk Register NEW — `risks` seeded from hazard rows; risk report entity/view                                                                 | Risk queryable across projects                                                        |
| 5     | _Machinery certificate — folded into Phase 2_                                                                                                | —                                                                                     |
| 6     | Action/Verification convergence — wire `flow_gates` as the generic verifier                                                                  | Work orders have due + verifier                                                       |
| 7     | Incident/Investigation completion                                                                                                            | Due date, reviewer, CA link                                                           |
| 8     | HSE Dashboard / Reports                                                                                                                      | Risk/finding datasets visible                                                         |
| 9     | Notifications completion                                                                                                                     | All module paths notified                                                             |
| 10    | ~~Permission / Project Scope~~ — **withdrawn**; removed as a permanent decision                                                              | Authorization is Permission → Role Scope → Visibility Tier only                       |

</details>

**One independent item can proceed first, without waiting for phase approval:**

- **GitHub MCP is connected** (46 tools, verified with `github.get_me()`), so
  repository and issue work is unblocked. It authenticates with a PAT stored
  outside the repo, not OAuth; see `docs/opencode-mcp-baseline.md` §6 for the
  refresh path when that token expires.

## EA-34 addendum (2026-10-24) — Magic Link E2E & release blocker re-review

- **Magic Link login:** PASS. Requested via /login UI → Mailpit email captured → verify URL → /dashboard (admin accessible). Replayed link → INVALID_TOKEN (one-time use confirmed).
- **Real business operation:** forgot-password Server Action executed successfully → password reset email sent to Mailpit (verified: "Reset your BeaconHS password" email received). Server Action decryption + execution confirmed.
- **Admin access:** super-admin can access /admin (title "Admin · BeaconHS"). ✓
- **Expired/replayed link:** replayed magic link → `?error=INVALID_TOKEN` (redirected to /dashboard?error=INVALID_TOKEN). ✓
- **Release blocker re-review:** Magic Link E2E now PASS (was NOT RUN). Other blockers unchanged: Migration 51 production pre-check (NOT RUN), production recovery & rollback drill (NOT RUN), binary reproducibility (APPROVAL REQUIRED).
- **No Git commits, pushes, or production deployments.**

## EA-35 addendum (2026-10-24) — release approval prep & settings/language investigation

- **EA-35A:** Release approval evidence consolidated in `docs/release-approval-checklist.md` §10.7. Passed items (staging/ceshi) separated from NOT RUN items (production).
- **EA-35B:** "Settings" grayed / Chinese language issue root cause found: tenant `enabled_languages = ["en"]` (Chinese not enabled); super-admin without membership → language selector disabled by design. Fix: enable Simplified Chinese via `/admin/settings` → Languages (tenant config, no code change). Full report: `docs/ea35-settings-language-investigation.md`.
- **No Git commits, pushes, or production deployments.**

## EA-38 addendum (2026-10-25) — release decision record & authorization confirmation

- **EA-38A:** EA-37 production readiness plan verified (Work I) — All plan elements consistent with existing documentation. Image tag, digest, migration 51 name, Server Action Key compatibility strategy, backup path, restore steps all verified.
- **EA-38B:** Rollback plan safety verified (Work II) — Migration 51 forward-only confirmed, data loss recovery steps documented, `pnpm db:migrate` pre-conditions clarified, DB/object store consistency confirmed, Server Action Key compatibility confirmed, readiness/login/business/file/RLS/5xx monitoring methods and stop conditions documented.
- **EA-38C:** Image reproducibility decision prepared (Work III) — Option A (accept known difference, risk LOW), Option B (continue solving, risk MEDIUM), Option C (block release, risk HIGH). Decision authority: Technical Approver or Release Engineer. Status: PENDING APPROVAL — NOT DECIDED.
- **EA-38D:** Production change authorization checklist completed (Work IV) — DBA, Ops, Technical Approver, Release Engineer roles and required confirmations listed. All authorization items pending.
- **EA-38E:** Document updates completed (Work V) — `docs/ea38-release-decision-record.md` created, `docs/release-approval-checklist.md` updated, `docs/project-development-state.md` updated.
- **No Git commits, pushes, or production deployments.**

## EA-36 addendum (2026-10-24) — release readiness review & risk consolidation

- **EA-36A:** Release approval evidence consolidated in `docs/ea36-release-readiness-review.md` §1-5. Passed items (staging/ceshi) separated from NOT RUN items (production).
- **EA-36B:** Migration 51 production pre-check materials prepared (Section 2.2 SQL, stop conditions, backup/restore verification requirements).
- **EA-36C:** Backup/restore and rollback gap analysis (EA-26/32A/32B/33/34 evidence, 5 separate items: isolated DB backup/restore, post-restore permissions rebuild, app version switch/rollback, DB schema incompatibility recovery, real business operation verification).
- **EA-36D:** Image digest approval materials prepared (Section 4: source reproducible, app files consistent, 18 layers consistent, but build metadata differs; 3 decision options; risk level LOW).
- **EA-36E:** Unified release checklist completed (all items marked PASS/PARTIAL/FAIL/NOT RUN/NOT VERIFIED/APPROVAL REQUIRED).
- **EA-36F:** Next steps and required authorization documented (production migration 51 pre-check, production backup/restore drill, production rollback drill, image digest reproducibility approval).
- **No Git commits, pushes, or production deployments.**

## EA-37 addendum (2026-10-25) — production readiness authorization plan

- **EA-37A:** Production migration 51 check preparation (Work I) — SQL script prepared, read-only permissions defined, results format documented, pass/stop conditions clarified.
- **EA-37B:** Backup and restore acceptance preparation (Work II) — Database and object store backup objects listed, restore targets defined, integrity checks and business verification standards defined, `pg_restore --no-privileges` + `pnpm db:migrate` step clarified, migration 51 forward-only note documented.
- **EA-37C:** Full rollback acceptance preparation (Work III) — Release images and versions listed, readiness/login/Server Actions/file upload/download/RLS/data integrity/error rate verification steps defined, app rollback vs DB restore distinction clarified, rollback execution plan with evidence/stop conditions documented.
- **EA-37D:** Image policy approval preparation (Work IV) — Build evidence summary (EA-19 to EA-23), reproducible vs non-reproducible breakdown, root cause analysis, impact assessment, 3 decision options (Option A/B/C) with risk levels, decision materials prepared.
- **EA-37E:** Authorization checklist completed (Work V) - DBA, Ops, Technical Approver, Release Engineer roles and required confirmations listed, production access, change window, backup confirmation, approval signature requirements clarified.
- **No Git commits, pushes, or production deployments.**

## EA-38 addendum (2026-10-25) — release decision record & authorization confirmation

- **EA-38A:** EA-37 production readiness plan verified (Work I) — All plan elements consistent with existing documentation. Image tag, digest, migration 51 name, Server Action Key compatibility strategy, backup path, restore steps all verified.
- **EA-38B:** Rollback plan safety verified (Work II) — Migration 51 forward-only confirmed, data loss recovery steps documented, `pnpm db:migrate` pre-conditions clarified, DB/object store consistency confirmed, Server Action Key compatibility confirmed, readiness/login/business/file/RLS/5xx monitoring methods and stop conditions documented.
- **EA-38C:** Image reproducibility decision prepared (Work III) — Option A (accept known difference, risk LOW), Option B (continue solving, risk MEDIUM), Option C (block release, risk HIGH). Decision authority: Technical Approver or Release Engineer. Status: PENDING APPROVAL — NOT DECIDED.
- **EA-38D:** Production change authorization checklist completed (Work IV) — DBA, Ops, Technical Approver, Release Engineer roles and required confirmations listed. All authorization items pending.
- **EA-38E:** Document updates completed (Work V) — `docs/ea38-release-decision-record.md` created, `docs/release-approval-checklist.md` updated, `docs/project-development-state.md` updated.
- **No Git commits, pushes, or production deployments.**

## EA-39 addendum (2026-10-25) — release decision closure and pre-condition verification

- **EA-39A:** Image reproducibility decision verified (Work I) — Decision status: PENDING APPROVAL — NOT DECIDED. No valid written decision obtained. Decision authority: Technical Approver or Release Engineer. Options: Option A (accept known difference, risk LOW, written risk acceptance required), Option B (continue solving, risk MEDIUM, confirmation required), Option C (block release, risk HIGH, confirmation required).
- **EA-39B:** Production pre-condition evidence status verified (Work II) — 8 items verified (migration 51 pre-check, DB backup/restore, object store backup/restore, deployment/rollback drill, Technical Approver approval, Release Engineer confirmation, DBA/Ops authorization, image reproducibility decision). Status breakdown: PASS (2), PENDING (2), NOT RUN (5), NOT DECIDED (1).
- **EA-39C:** Migration 51 pre-check condition verified (Work III) — SQL consistency with migration 51 file verified (3 ALTER TABLE statements), stop conditions clearly defined, pass conditions clearly defined, migration version check correct.
- **EA-39D:** Backup and rollback plan verified (Work IV) — All steps clearly documented (app image rollback, migration 51 DB restore, object store restore, pnpm db:migrate permissions/RLS rebuild, Server Action Key compatibility, real business verification, backup consistency). Complete rollback drill status: NOT RUN (only staging verified).
- **EA-39E:** Final status table completed (Work V) — Final status summary (release status: PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION), status categories (PASS 2, PENDING 2, NOT RUN 5, NOT DECIDED 1), production pre-condition status (9 items), authorization status (DBA PENDING, Ops PENDING, Technical Approver PENDING, Release Engineer PENDING).
- **No Git commits, pushes, or production deployments.**

## EA-40 addendum (2026-10-25) — approval execution and authorization closure

- **EA-40A:** Pre-execution check (Work I) — All EA-36 to EA-39 completed and documented, no new code changes in EA-40, release status consistent with EA-39, no re-execution of already verified tests.
- **EA-40B:** Image reproducibility decision verification (Work II) — No new written approval records found. Decision status: PENDING APPROVAL — NOT DECIDED. No valid written decision obtained.
- **EA-40C:** Production pre-check authorization verification (Work III) — DBA authorization: PENDING (no signature). Ops authorization: PENDING (no signature). Production access required for both.
- **EA-40D:** Approval record verification (Work IV) — Technical Approver: PENDING (review completed, signature pending). Release Engineer: PENDING (review completed, signature pending). DBA: PENDING (no signature). Ops: PENDING (no signature). All authorizations pending.
- **EA-40E:** Final status table (Work V) — 9 items with status breakdown: PASS (2), PENDING (2), NOT RUN (5), NOT DECIDED (1). Technical verification passed items (10), Staging/ceshi/Local verified items (10), Unauthorized but prepared items (4), Policy decision items still required (1), Unresolved release blockers (9).
- **EA-40F:** Document updates (Work VI) — `docs/ea40-approval-execution-record.md` created, `docs/release-approval-checklist.md` updated, `docs/project-development-state.md` updated.
- **No Git commits, pushes, or production deployments.**

## EA-41 addendum (2026-10-25) — final approval package consistency fix and release readiness confirmation

- **EA-41A:** Workspace check (Work I) — Branch `hse-platform`, HEAD `51a899b7`, 658 modified files, 1025 untracked files. No new code changes. No destructive Git operations.
- **EA-41B:** Status classification contradictions fix (Work II) — Fixed "已授权但尚未执行" (Authorized but Not Executed) → "未授权但已准备" (Unauthorized but Prepared) because authorization has not been obtained. Fixed "生产执行并验证项" (Production Executed and Verified) → "Staging/ceshi/Local 已验证项" (Staging/ceshi/Local Verified Items) because items were verified in Staging/ceshi/Local, not production.
- **EA-41C:** Unified final release blockers table (Work III) — 9 items with status, evidence, responsibility, and closure condition. All items accurately classified: PASS (2), PENDING (2), NOT RUN (5), NOT DECIDED (1).
- **EA-41D:** Image reproducibility decision materials organized (Work IV) — Option A/B/C with risk levels, audit impact, and decision authority clearly documented. No decision made yet.
- **EA-41E:** Final approval package output (Work V) — `docs/ea41-final-approval-package.md` created with one-page decision summary, blockers, and responsibility list.
- **EA-41F:** Documentation updates (Work VI) — `docs/ea40-approval-execution-record.md` (Work V.5 and V.6 corrected), `docs/release-approval-checklist.md` (status classification fixes applied), `docs/project-development-state.md` (EA-40 addendum updated, EA-41 addendum added).
- **No Git commits, pushes, or production deployments.**

## EA-42 addendum (2026-10-26) — reproducible build fix

- **EA-42A:** Pre-execution check (Work I) — All EA-36 to EA-41 completed and documented, no new code changes in EA-42, release status consistent with EA-41, no re-execution of already verified tests. EA-22 DEPLOYMENT_VERSION config exists (apps/web/src/lib/app-version.ts, apps/web/next.config.ts). Dockerfile frontend 1.7, Docker 29.9.2, Buildx 0.38.1. Source snapshot HEAD `51a899b7`, base image digest pinned.
- **EA-42B:** Root cause analysis (Work II) — Based on EA-36 release readiness review (EA-19~23): source reproducible, app files consistent, 18 layers consistent, but build metadata differs (BuildKit Ref + CreatedAt). Root cause: BuildKit build identity metadata (`/Identity/Build[0]/Ref` and `/Identity/Build[0]/CreatedAt`) is non-deterministic.
- **EA-42C:** Experiment A (Work III) — Fixed build time with `SOURCE_DATE_EPOCH` (1729728000). Two independent builds with identical SOURCE_DATE_EPOCH: Layers 100% identical (18 layers), Size 100% identical (2,869,365,148 bytes), Image Created field 100% identical (2024-10-24T00:00:00Z), but manifest digest differs (BuildKit build identity metadata differs). Experiment B and C not executed (redundant).
- **EA-42D:** Verification standards (Work V) — Source code SHA-256, complete build commands, builder/frontend/base image versions, two image digests, manifest/config/layers comparison, application file consistency and quality gates all verified.
- **EA-42E:** Document updates (Work VI) — `docs/ea42-reproducible-build-report.md` created, `docs/release-approval-checklist.md` updated, `docs/project-development-state.md` updated.
- **No Git commits, pushes, or production deployments.**

## EA-43 addendum (2026-10-26) — buildkit provenance investigation and risk acceptance draft

- **EA-43A:** Workspace check (Phase 1) — Branch `hse-platform`, HEAD `51a899b7`, 165 modified files, 1025 untracked files, empty staging. EA-42 report has EVIDENCE GAP (no original JSON evidence).
- **EA-43B:** Independent experiment environment (Phase 2) — Fixed input confirmed (HEAD `51a899b7`, base image digest, Dockerfile frontend 1.7, build tool versions). Experiment baseline not created (to avoid overwriting existing images).
- **EA-43C:** Provenance difference experiment (Phase 3, simplified) — ~~Default provenance behavior verified (BuildKit does not generate provenance without `--attest` flag). Explicit provenance configuration not executed (redundant based on EA-42 conclusion). BuildKit build identity metadata identified as non-deterministic (`/Identity/Build[0]/Ref` and `/Identity/Build[0]/CreatedAt`). Provenance impact on digest cannot be confirmed (EVIDENCE GAP).~~ 🔴 **SUPERSEDED by EA-44:** default builds **do** generate a SLSA provenance v1 attestation; `Identity.Build[0].Ref`/`CreatedAt` are Docker-local bookkeeping and enter no digest; provenance **is** the sole non-deterministic input to the index digest.
- **EA-43D:** Option A risk acceptance draft (Phase 4) — Risk acceptance draft created in `docs/ea43-image-reproducibility-risk-acceptance.md`. Compensation controls identified (6 categories: build traceability, image identity, signature verification, deployment, rollback, audit trail). Option A decision boundary documented (draft does not constitute approval).
- **EA-43E:** Release approval materials update (Phase 5) — `docs/ea43-provenance-investigation-report.md` created, `docs/ea43-image-reproducibility-risk-acceptance.md` created, `docs/release-approval-checklist.md` updated, `docs/project-development-state.md` updated.
- **EA-43F:** Quality check (Phase 6) — Markdown format correct, links and references correct, digest and experiment tags accurate, results consistent with original evidence, no incorrect claims of production verification or risk approval, no secrets included, no changes to other phase documents' historical conclusions, Git diff only contains expected changes.
- **No Git commits, pushes, or production deployments.**

## EA-44 addendum (2026-10-26) — image reproducibility evidence recovery and provenance verification

- **EA-44A:** Pre-execution state — Branch `hse-platform`, HEAD `51a899b7`, 165 modified + 497 untracked entries, empty staging. Docker 29.9.2, Buildx v0.38.1, BuildKit v0.34.0, containerd image store.
- **EA-44B:** Raw evidence recovery — EA-42 experiment images still present with digests matching the EA-42 report. Extracted OCI index, image manifest, config, 18 layers, attestation manifest and SLSA provenance via read-only `docker save`. **EA-42 EVIDENCE GAP CLOSED.**
- **EA-44C:** Root cause (VERIFIED) — Compared digest is the OCI **image index**. Image manifest (`6b255d15…`) and config (`35e841b9…`) are byte-identical across both EA-42 builds. Only the attestation manifest differs, because SLSA provenance varies in exactly four fields: `startedOn`, `finishedOn`, `invocationId`, `subject.name` (contains the tag).
- **EA-44D:** Corrected two EA-42/EA-43 errors — (1) default builds **do** emit provenance, no `--attest` needed; (2) `Identity.Build[0].Ref`/`CreatedAt` are Docker-local bookkeeping and enter no digest. The "BuildKit inherent, unfixable" claim is withdrawn.
- **EA-44E:** Minimal experiments (VERIFIED) — A: default provenance, 2× `--no-cache` → index `6313fe79…` vs `6e37f789…`, manifest both `141e5a28…`. B: `--provenance=false`, 2× `--no-cache` → index `141e5a28…` both, bit-for-bit identical. C: NOT RUN (A/B sufficient).
- **EA-44F:** Conclusion — `PARTIAL — LAYERS REPRODUCIBLE` + `PARTIAL — PROVENANCE EFFECT IDENTIFIED`. Image manifest digest is reproducible (including across tags); index digest is not under default flags. Disabling provenance would restore index reproducibility but removes the supply-chain attestation, so it is **not** recommended. A security-preserving path (identity = image manifest digest, to which provenance `subject.digest` binds) is `PROPOSED — NOT VERIFIED` for deployment tooling.
- **EA-44G:** New finding — EA-16 candidate image was built **without** `SOURCE_DATE_EPOCH` (config `created` = `2026-10-23T05:31:46…`), so the candidate itself does not yet have reproducible-build properties.
- **EA-44H:** Documents — `docs/ea44-provenance-evidence-report.md` created; `docs/evidence/ea44/` created (32 files, SHA256SUMS verified); `docs/ea42-reproducible-build-report.md`, `docs/ea43-provenance-investigation-report.md`, `docs/ea43-image-reproducibility-risk-acceptance.md`, `docs/release-approval-checklist.md` updated.
- **Release status unchanged:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; all 9 blockers remain open.
- **No Git commits, pushes, or production deployments.**

## EA-45 addendum (2026-10-26) — candidate reproducibility and deployment identity verification

- **EA-45A:** Pre-execution state — Branch `hse-platform`, HEAD `51a899b7`, 165 modified + 499 untracked entries, empty staging. Docker 29.9.2, Buildx v0.38.1, BuildKit v0.34.0, containerd image store. `docs/evidence/ea44/SHA256SUMS` re-verified 33/33 (exit 0).
- **EA-45B:** EA-16 identity re-confirmed from the local store — index `17126c6e…`, manifest `43a7dc27…`, config `7e6139af…`, attestation `0f7e823e…`, provenance `15358431…`, 18 layers / 578,043,276 B, config `created` `2026-10-23T05:31:46.447606116+08:00`. **No SBOM attestation.**
- **EA-45C:** Strict reproduction ruled out — `MANIFEST.txt` proves EA-16 was a dirty-working-tree build (165 modified + 1,022 untracked); the snapshot archives only 3 changed files; **no EA-16 build log exists**. Two of the three archived files (both `docs/`) no longer match their recorded SHA-256. EA-16 is therefore `NOT VERIFIED` for strict reproduction, not "failed".
- **EA-45D:** Build-input drift proven — `turbo.json` was modified `2026-10-23T11:04:04`, **5 h 32 min after** the EA-16 build finished, adding `DEPLOYMENT_VERSION` to `globalEnv`. Turbo 2.10.5 runs `envMode: "strict"` and `@beaconhs/web#build` declares no `env`/`passThroughEnv`, so EA-16's `next build` never saw `DEPLOYMENT_VERSION` → no `deploymentId` → random build id `T79KItdA9zMY3BiGlR7x1`. Current builds carry `deploymentId=51a899b7…` → deterministic build id `build-TfctsWXpff2fKS`. Consequence: 46 renamed chunks and 1,653/8,658 files differ between EA-16 and every rebuild. Exact-`--no-cache` reproduction of EA-16 is impossible without reverting that input.
- **EA-45E:** Four independent `--no-cache` full-image builds (A1/A2 without `SOURCE_DATE_EPOCH`, B1/B2 with `SOURCE_DATE_EPOCH=1729728000`), all exit 0, all on tags that did not previously exist (323 s / 327 s / 339 s / 363 s). Each build had exactly two `CACHED` steps (internal metadata load, base-image `FROM`); no `RUN`/`COPY` was served from cache.
- **EA-45F:** Result — `FAIL` at every identity level. Four different index digests, four different manifests, four different configs; **10 of 18 layers differ in every pairing**, and the differing set is always layers 6, 7, 9–16. `SOURCE_DATE_EPOCH` only fixes config `created` and history timestamps: B1 vs B2 configs are identical apart from `rootfs.diff_ids`, yet index/manifest/config still differ. `PARTIAL` for SDE, `FAIL` for reproducibility.
- **EA-45G:** Content-level attribution (`PASS`) — no application source, compiled chunk or dependency binary differs between independent builds. Layer 11: 1 of 8,704 files differs (`.next/prerender-manifest.json`, three randomly generated Next.js preview-mode keys). Layer 9: 10 of 5,320 files (fontconfig caches, `ldconfig` aux-cache, apt/dpkg logs — no package files). Layers 14–16: `.modules.yaml` key ordering plus `.turbo/turbo-build.log` elapsed milliseconds. Layers 6/10: npm cache index, npm debug log, V8 `node-compile-cache`. Layer 7: mtime only.
- **EA-45H:** **EA-44's `PARTIAL — LAYERS REPRODUCIBLE` and "manifest digest reproducible" are withdrawn.** They were an artifact of EA-42's second build reusing cache; the EA-42 cache state was never logged. Corrected in `docs/ea44-provenance-evidence-report.md` §6.0 and `docs/ea43-image-reproducibility-risk-acceptance.md` §1.1.
- **EA-45I:** Deployment identity — `.github/workflows/deploy-dev.yml:39` captures `steps.build-image.outputs.digest`, i.e. the **OCI index digest**, and `docs/PRODUCTION_RUNBOOK.md` deploys/rolls back by `IMAGE@sha256:…` only (`PASS`, process level). Because that digest is not reproducible, "rebuild and compare the digest" is **not usable as a release control** (`FAIL`). Locally the containerd store resolves the index digest but not the manifest/config digest as an image reference, so **Option M is `FAIL`** on both its premises; registry-side behaviour stays `NOT VERIFIED`.
- **EA-45J:** Option A remains `PROPOSED — NOT VERIFIED` / `DRAFT — PENDING SIGNATURE`. Its claim "应用内容本身稳定" was narrowed to "application code byte-stable, image layer artifacts not stable". Control 3 → `PASS`, control 4 → `FAIL`, control 8 → `PARTIAL`, new control 9 (content attribution) → `PASS`. Nothing was signed for any approver role.
- **EA-45K:** Defects — `EA45-1` `.playwright-mcp/` (63 files) is not in `.dockerignore` (open); `EA45-2` duplicate `## 11` heading in `docs/release-approval-checklist.md` (fixed: renumbered to `## 12. Approval status`); `EA45-3` no SBOM attestation (open); `EA45-4` buildx 0.38.1 has no `--rewrite-timestamp` (open); `EA45-5` Next.js random preview-mode keys (open).
- **EA-45L:** Documents — `docs/ea45-candidate-reproducibility-report.md` created; `docs/evidence/ea45/` created (26 files + `SHA256SUMS`, `sha256sum -c` exit 0, Server Action key fingerprint occurrences 0); `docs/ea43-image-reproducibility-risk-acceptance.md`, `docs/ea44-provenance-evidence-report.md`, `docs/release-approval-checklist.md` (§10.17) updated.
- **Release status unchanged:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; all 9 blockers remain open. WOPI unchanged (`KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`).
- **EA-45M:** Gates (documentation-only change) — `format:check` 0, `typecheck` 0, `lint` 0, `deadcode:check` 0, `build` 0. `pnpm test` default parallelism exits 1 because `@beaconhs/jobs`, `@beaconhs/storage` and `@beaconhs/db` time out / hit `EPIPE` under concurrent load on this host; all three pass in isolation (20/20, 508 passed, 148/148) and `turbo run test --concurrency=1` exits 0 with 25/25 tasks. Those packages carry pre-existing uncommitted changes; the failures are not caused by this change.
- **No Git commits, pushes, or production deployments.**

## EA-39 addendum (2026-10-25) — release decision closure and pre-condition verification

- **EA-39A:** Image reproducibility decision verified (Work I) — Decision status: PENDING APPROVAL — NOT DECIDED. No valid written decision obtained. Decision authority: Technical Approver or Release Engineer. Options: Option A (accept known difference, risk LOW, written risk acceptance required), Option B (continue solving, risk MEDIUM, confirmation required), Option C (block release, risk HIGH, confirmation required).
- **EA-39B:** Production pre-condition evidence status verified (Work II) — 8 items verified (migration 51 pre-check, DB backup/restore, object store backup/restore, deployment/rollback drill, Technical Approver approval, Release Engineer confirmation, DBA/Ops authorization, image reproducibility decision). Status breakdown: PASS (2), PENDING (2), NOT RUN (5), NOT DECIDED (1).
- **EA-39C:** Migration 51 pre-check condition verified (Work III) — SQL consistency with migration 51 file verified (3 ALTER TABLE statements), stop conditions clearly defined, pass conditions clearly defined, migration version check correct.
- **EA-39D:** Backup and rollback plan verified (Work IV) — All steps clearly documented (app image rollback, migration 51 DB restore, object store restore, pnpm db:migrate permissions/RLS rebuild, Server Action Key compatibility, real business verification, backup consistency). Complete rollback drill status: NOT RUN (only staging verified).
- **EA-39E:** Final status table completed (Work V) — Final status summary (release status: PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION), status categories (PASS 2, PENDING 2, NOT RUN 5, NOT DECIDED 1), production pre-condition status (9 items), authorization status (DBA PENDING, Ops PENDING, Technical Approver PENDING, Release Engineer PENDING).
- **No Git commits, pushes, or production deployments.**

## EA-38 addendum (2026-10-25) — release decision record & authorization confirmation

- **EA-38A:** EA-37 production readiness plan verified (Work I) — All plan elements consistent with existing documentation. Image tag, digest, migration 51 name, Server Action Key compatibility strategy, backup path, restore steps all verified.
- **EA-38B:** Rollback plan safety verified (Work II) — Migration 51 forward-only confirmed, data loss recovery steps documented, pnpm db:migrate pre-conditions clarified, DB/object store consistency confirmed, Server Action Key compatibility confirmed, readiness/login/business/file/RLS/5xx monitoring methods and stop conditions documented.
- **EA-38C:** Image reproducibility decision prepared (Work III) — Option A (accept known difference, risk LOW), Option B (continue solving, risk MEDIUM), Option C (block release, risk HIGH). Decision authority: Technical Approver or Release Engineer. Status: PENDING APPROVAL — NOT DECIDED.
- **EA-38D:** Production change authorization checklist completed (Work IV) — DBA, Ops, Technical Approver, Release Engineer roles and required confirmations listed. All authorization items pending.
- **EA-38E:** Document updates completed (Work V) — `docs/ea38-release-decision-record.md` created, `docs/release-approval-checklist.md` updated, `docs/project-development-state.md` updated.
- **No Git commits, pushes, or production deployments.**

## EA-37 addendum (2026-10-25) — production readiness authorization plan

- **EA-37A:** Production migration 51 check preparation (Work I) — SQL script prepared, read-only permissions defined, results format documented, pass/stop conditions clarified.
- **EA-37B:** Backup and restore acceptance preparation (Work II) — Database and object store backup objects listed, restore targets defined, integrity checks and business verification standards defined, pg_restore --no-privileges + pnpm db:migrate step clarified, migration 51 forward-only note documented.
- **EA-37C:** Full rollback acceptance preparation (Work III) — Release images and versions listed, readiness/login/ServerActions/file upload/download/RLS/data integrity/error rate verification steps defined, app rollback vs DB restore distinction clarified, rollback execution plan with evidence/stop conditions documented.
- **EA-37D:** Image policy approval preparation (Work IV) — Build evidence summary (EA-19 to EA-23), reproducible vs non-reproducible breakdown, root cause analysis, impact assessment, 3 decision options (Option A/B/C) with risk levels, decision materials prepared.
- **EA-37E:** Authorization checklist completed (Work V) - DBA, Ops, Technical Approver, Release Engineer roles and required confirmations listed, production access, change window, backup confirmation, approval signature requirements clarified.
- **No Git commits, pushes, or production deployments.**

## EA-36 addendum (2026-10-24) — release readiness review & risk consolidation

- **EA-36A:** Release approval evidence consolidated in `docs/ea36-release-readiness-review.md` §1-5. Passed items (staging/ceshi) separated from NOT RUN items (production).
- **EA-36B:** Migration 51 production pre-check materials prepared (Section 2.2 SQL, stop conditions, backup/restore verification requirements).
- **EA-36C:** Backup/restore and rollback gap analysis (EA-26/32A/32B/33/34 evidence, 5 separate items: isolated DB backup/restore, post-restore permissions rebuild, app version switch/rollback, DB schema incompatibility recovery, real business operation verification).
- **EA-36D:** Image digest approval materials prepared (Section 4: source reproducible, app files consistent, 18 layers consistent, but build metadata differs; 3 decision options; risk level LOW).
- **EA-36E:** Unified release checklist completed (all items marked PASS/PARTIAL/FAIL/NOT RUN/NOT VERIFIED/APPROVAL REQUIRED).
- **EA-36F:** Next steps and required authorization documented (production migration 51 pre-check, production backup/restore drill, production rollback drill, image digest reproducibility approval).
- **No Git commits, pushes, or production deployments.**

## EA-33 addendum (2026-10-24) — staging full business rollback verification

- **Scenario A (K1 baseline):** K1 healthy (200), forgot-password Server Action captured (action ID `606c1040...`), action executes (500 + digest error = decryption OK, business logic fails due to no SMTP).
- **Scenario B (switch to K2):** K2 healthy (200). Old K1 client action replayed to K2 → 404 "Server action not found." (decryption fails). K2's own client action → K2 → 500 + digest error (decryption OK). K2 action replayed to K1 → 404 (decryption fails). Service remains available (login/API work).
- **Scenario C (rollback to K1):** K1 restarted, health 200. Server Action (K1 action → K1) → 500 + digest error (decryption OK). Recovery verified.
- **Conclusion:** Same key = compatible Server Actions. Different key = incompatible (404). Rollback to same-key version restores full functionality. Empirical evidence complete.
- **No Git commits, pushes, or production deployments.**

## EA-32C addendum (2026-10-24) — staging deployment & rollback drill

- **Staging environment:** Local postgres (port 15436) + redis (port 16382) + app containers. K1 (phase-ea16) healthy on port 3300. Full migration chain (0000-0051) applied.
- **Deployment verified:** K1 container healthy (200 readiness), schema match (51 migrations). Candidate version deployed successfully.
- **Rollback test:** K2 (different key) started on port 3301, healthy (200). Server Action compatibility verified: same key works, different key → 404 "Server action not found."
- **Recovery:** K1 remained healthy after cross-key test. K2 restarted successfully after crash.
- **No Git commits, pushes, or production deployments.**

## EA-32B addendum (2026-10-24) — permission rebuild & RLS verification on restored DB

- **Environment:** isolated restored DB `beaconhs_ea32b_restore` on ceshi postgres (created from backup, `--role=beaconhs_owner`).
- **Pre-migration baseline:** migration version 51, 194 RLS policies, beaconhs_app can login, not superuser/bypassrls, cannot read ppe_items (grants missing).
- **pnpm db:migrate:** PASS (via ops-migrate container). Converged role permissions, applied 32 statistics targets, 15 views. Migration version still 51.
- **Post-migration verification:** beaconhs_app can read ppe_items (0 visible — RLS filters), corrective_actions (0 visible). RLS enabled+forced on all 5 key tables. beaconhs_app is not superuser, does not bypass RLS. Grants fully restored.
- **Conclusion:** Restore + migration flow verified. `pg_restore --no-privileges` + `pnpm db:migrate` correctly restores grants and RLS. Production recovery procedure is validated (in isolated test DB).
- **No Git commits, pushes, or production deployments.**

## EA-32A addendum (2026-10-24) — Migration 51 pre-check & staging recovery

- **Environment identity:** ceshi DB confirmed as test environment (tenants: "Phase AJ Test Tenant", "Phase BB Isolated Freeze Tenant"). Migration version 51 (hash d8ff1c5b…). PostgreSQL 16.15.
- **Migration 51 pre-check:** All 3 target columns already absent (ALREADY APPLIED). Table row counts: equipment=0, training=0. Non-null count = 0 (columns don't exist).
- **Backup/restore verified:** pg_dump -Fc (1.47 MB) → pg_restore --no-privileges → separate DB. Row counts preserved. Migration version 51 confirmed. RLS policies: 194. Migration 51 columns confirmed absent. beaconhs_app role could NOT read tables after restore (permission denied) — confirms runbook claim.
- **Leftover cleanup:** Deleted 1 leftover EA-15 ppe_item (EA15DL-0001) that was missed in earlier cleanup.
- **No production access.** No Git commits, pushes, or production deployments.

## EA-31 addendum (2026-10-24) — release blocker convergence & final approval prep

- **Unified blocker list:** 15 items classified (BLOCKING / APPROVAL REQUIRED / NON-BLOCKING / NOT VERIFIED / NOT RUN). Binary reproducibility marked as APPROVAL REQUIRED (POLICY DECISION REQUIRED — no explicit policy found).
- **Blocking items:** Migration 51 production pre-check (NOT RUN), production recovery & rollback drill (NOT RUN), Server Action Key cross-version compat (mechanism confirmed, container-level empirical test PASS).
- **Release decision:** PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION. No formal approval granted.
- **EA-22/EA-23 experiment versions:** NOT deployed to ceshi. Ceshi still runs `beaconhs:phase-ea16-20261023-052716` (digest `sha256:17126c6e…`).
- **No Git commits, pushes, or production deployments.**

## EA-30 addendum (2026-10-24) — Playwright Server Action capture & cross-version verification

- **Server Action request captured:** `Next-Action: 606c1040c984bdf8d2a6103e14a82dde8525c94906` (40-char hex) from `/forgot-password` page on K1 container.
- **Empirical results:**
  - K1 action → K1 (same key): 500 + digest error (decryption OK, business logic fails) ✓
  - K2 action → K2 (same key): 500 + digest error (decryption OK, business logic fails) ✓
  - K1 action → K2 (different key): 404 "Server action not found." (decryption fails) ✓
  - K2 action → K1 (different key): 404 "Server action not found." (decryption fails) ✓
- **Conclusion:** Same key = compatible Server Actions. Different key = incompatible (404 "Server action not found."). Safe rollback: same key or full redeploy with old key + DB restore.
- **No Git commits, pushes, or production deployments.**

## EA-29 addendum (2026-10-24) — Server Action Key rollback empirical test

- **Isolated test environment:** Established successfully. Local postgres (port 15434) with full migration chain (0000-0051), redis (port 16380), K1 (phase-ea16) and K2 (ea25-k2) containers both healthy (200 readiness).
- **Scenarios A-F:** NOT RUN. Server Action request extraction/replay not completed via browser automation. Mechanism confirmed via build-time log evidence + Next.js documentation.
- **Key compatibility:** Same key = compatible (documented Next.js behavior). Different key = incompatible Server Actions (decryption fails). Safe rollback: same key or full redeploy with old key + DB restore.
- **No Git commits, pushes, or production deployments.**

## EA-28 addendum (2026-10-24) — isolated test DB connection & rollback prep

- **Connection issue root cause (EA-27):** SSH tunnel bound to 127.0.0.1 only; app containers couldn't reach it via host.docker.internal. Fixed by binding tunnel to 0.0.0.0. But app readiness still failed due to DB connection issues (postgres-js connection pool / RLS context).
- **Solution:** Local PostgreSQL container (ea28-test-pg) with full migration chain (0000-0051) applied. Created roles (beaconhs_owner, beaconhs_app, beaconhs_super, beaconhs_migrator, beaconhs_backup) with correct permissions. App connects successfully (health 200, schema match, 51 migrations).
- **Environment verified:** DB health PASS, app connection PASS, login/basic queries PASS (via ceshi DB tunnel after host networking fix), container restart recovery PASS.
- **EA-27 container-level scenarios:** Still NOT RUN (app containers started but Server Action extraction/replay not attempted due to time constraints). Mechanism confirmed via build-time evidence + Next.js docs.
- **No Git commits, pushes, or production deployments.**

## EA-27 addendum (2026-10-24) — Server Action Key rollback empirical test

- **Scenarios A-F:** NOT RUN. App containers could not reach the ceshi postgres through SSH tunnel (connection closed). Mechanism confirmed via build-time log evidence ("the effective key is the build-time key embedded in the image") and Next.js documentation.
- **Key compatibility:** Same key = compatible (documented Next.js behavior). Different key = incompatible Server Actions (decryption fails). Safe rollback requires same key or full redeploy with old key + DB restore.
- **Migration 51 recovery:** PASS (verified in EA-26, isolated test DB).
- **K2 image:** retained (`beaconhs:ea25-k2-20261024-052018`, digest `sha256:a0f31d36…`).
- **No Git commits, pushes, or production deployments.**

## EA-26 addendum (2026-10-24) — rollback & database recovery drill

- **Migration 51 verified (isolated test DB):** Columns dropped (`certificate`, `due_on`, `expires_on`), row counts preserved (2 each). Backup (`pg_dump -Fc`) and restore (`pg_restore --no-privileges`) succeeded. Runbook confirms `pnpm db:migrate` is the only supported way to reapply grants after restore.
- **Server Action Key:** Mechanism confirmed (build-time secret, baked into bundle). Same key = compatible; different key = incompatible. Safe rollback requires same key or full redeploy with old key + DB restore.
- **Scenarios A/B (same/different key rollback):** Mechanism verified via Next.js documentation and build artifact analysis. Full container-level test NOT RUN (requires full app stack with DB — isolated test DB created but app containers not started to avoid risk).
- **Scenarios C (Migration 51 recovery):** PASS (isolated test DB, backup + restore + row count verified).
- **No Git commits, pushes, or production deployments.**

## EA-25 addendum (2026-10-24) — Server Action Key cross-version compatibility

- **Mechanism:** Server Action Key is a build-time secret (`next_server_actions_key`) mounted via BuildKit secret. It is baked into the compiled bundle (not a runtime env var). Different keys produce different encrypted action IDs → cross-version incompatibility. Same key = compatible.
- **Evidence:** EA-16 image (key K1) and EA-25 test image (key K2) both built successfully. Key fingerprints: K1 = `a1f4acf2…`, K2 = `382c8e16…` (fingerprints only, no secrets printed). K2 image digest: `sha256:a0f31d36…`.
- **Scenarios tested:** Mechanism confirmed via Next.js documentation and build-time analysis. Full container-level scenario testing (A-F) was not performed — the key compatibility behavior is a documented Next.js characteristic. Same key = compatible; different key = incompatible Server Actions.
- **Safe rollback strategy:** Use the same Server Action Key across compatible versions. Rollback to a version built with a different key requires a full redeploy with the old key (and potentially a DB restore if migration was applied).
- **Risk classification:** KNOWN RISK → updated to BLOCKING or APPROVAL REQUIRED (depends on rollback strategy).
- **No Git commits, pushes, or production deployments.**

## EA-24 addendum (2026-10-24) — release blocker classification & approval preparation

- **Release decision matrix** added to `docs/release-approval-checklist.md` (§10.5 risk classification + §11 decision matrix).
- **Risk classification:** 15 items classified as BLOCKING / APPROVAL REQUIRED / NON-BLOCKING / NOT VERIFIED / NOT RUN. Binary reproducibility marked as POLICY DECISION REQUIRED (no explicit policy found; cannot self-exempt).
- **Blocking items:** Migration 51 production pre-check (NOT RUN), production recovery & rollback drill (NOT RUN), Server Action Key cross-version compat (KNOWN RISK).
- **Approval status:** remains `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`.
- **No Git commits, pushes, or production deployments.**

## EA-23 addendum (2026-10-23) — Docker image metadata reproducibility experiment

- **SOURCE_DATE_EPOCH:** Set as env var (not build arg) — fixes image `Created` timestamp. But build identity `CreatedAt` and `Ref` still differ between builds.
- **Build reference (Ref):** Random per build, generated by BuildKit 0.38.1. No standard override mechanism found.
- **Conclusion:** Even with SOURCE_DATE_EPOCH, image digests still differ. Root cause at Level 2 is CONFIRMED: `/Identity/Build[0]/Ref` + `/Identity/Build[0]/CreatedAt`. All 18 layer digests identical. Application code byte-identical.
- **Remediation (not applied):** SOURCE_DATE_EPOCH (partially effective) + build reference override (not available in current BuildKit). Full bit-for-bit reproducibility requires BuildKit configuration or tooling changes.
- **No Git commits, pushes, or production deployments.**

## EA-22 addendum (2026-10-23) — deterministic build ID applied

- **Change applied:** `turbo.json` — added `"DEPLOYMENT_VERSION"` to `globalEnv` (single-line addition, minimal diff). No other files modified.
- **Verification:** `pnpm --filter @beaconhs/web build` with `DEPLOYMENT_VERSION=51a899b7...` → BUILD_ID = `build-TfctsWXpff2fKS` (deterministic). Format check PASS, typecheck PASS.
- **Impact:** Build ID is now deterministic across builds (when DEPLOYMENT_VERSION is set). Application code and layer digests remain byte-identical. Image digest still differs due to build timestamp/ref (Level 2, not addressed).
- **Ceshi image unchanged:** still `beaconhs:phase-ea16-20261023-052716`.
- **No Git commits, pushes, or production deployments.**

## EA-21 addendum (2026-10-23) — deterministic build ID feasibility

- **Root cause of build ID non-determinism (Level 1):** `DEPLOYMENT_VERSION` not in turbo's `globalEnv` → `deploymentId` unset → random build ID. Fix: add `DEPLOYMENT_VERSION` to `turbo.json` globalEnv (tested in experiment, not applied to main repo).
- **Level 2 (image digest):** Even after fixing turbo.json, image digests still differ. The ONLY remaining difference is `/Identity/Build[0]/Ref` (build reference) and `/Identity/Build[0]/CreatedAt` (build timestamp). All 18 layer digests identical. Application code byte-identical.
- **Remediation (not applied):** (a) Add `DEPLOYMENT_VERSION` to turbo.json globalEnv. (b) Set `SOURCE_DATE_EPOCH` for timestamp reproducibility. Both are config changes requiring testing and approval.
- **Conclusion:** Source reproducible = PASS. Binary reproducible = NOT VERIFIED (build metadata only). Application code is byte-identical across all builds.
- **No Git commits, pushes, or production deployments.**

## EA-20 addendum (2026-10-23) — image non-determinism root cause

- **Root cause: CONFIRMED.** Next.js build ID non-determinism. Out of 5187 files in `.next/`, only 10 differ between EA-16 and EA-19 rebuild (all build-ID-derived: BUILD_ID, build-manifest.json, prerender-manifest.json, _global-error.*, middleware-build-manifest.js, pages/500.html). Application code is byte-identical. Layer digests diverge from layer 11.
- **Remediation (not applied):** set deterministic build ID in `next.config.ts` or `SOURCE_DATE_EPOCH`. Requires testing.
- **Impact:** binary reproducibility is FAIL (cosmetic differences only — build metadata, not application logic). Source reproducibility is PASS.
- **No Git commits, pushes, or production deployments.**

## EA-19 addendum (2026-10-23) — build reproducibility verification

- **Source snapshot:** `/home/test/projects/beaconhs-ea19-snapshot/` (2871 files, excludes .git/node_modules/.next/.env/secrets/caches). route.ts SHA256 matches original (`eeee2ba2…`).
- **Independent build:** PASS. Built from snapshot with unique tag `beaconhs:ea19-repro-20261023-080322`, same key/fingerprint/build-args. Build succeeded, all layers present (18).
- **Source reproducibility:** PASS — build succeeded from archived snapshot with no unrecorded dependencies.
- **Binary reproducibility:** NOT VERIFIED — rebuild digest `sha256:1908e00b…` ≠ candidate `sha256:17126c6e…`. Layer digests diverge from layer 11 (build step). Likely cause: non-deterministic build output (timestamps, Next.js build IDs). Dockerfile does not set `SOURCE_DATE_EPOCH`.
- **EA-16 image unchanged** on ceshi (still `beaconhs:phase-ea16-20261023-052716`, digest `sha256:17126c6e…`).
- **No Git commits, pushes, or production deployments.**

## EA-18 addendum (2026-10-23) — release approval preparation

- **Release approval checklist created:** `docs/release-approval-checklist.md` (PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION).
- **Source snapshot:** `/home/test/projects/beaconhs-hse-release-snapshot/` (MANIFEST.txt + 3 changed files + SHA256).
- **Candidate image:** `beaconhs:phase-ea16-20261023-052716`, digest `sha256:17126c6e…`, version `51a899b7…`.
- **Build reproducibility:** NOT VERIFIED (image built from working tree). Flagged as blocking for formal audit.
- **No Git commits, pushes, or production deployments.**

## EA-60 addendum (2026-10-30) — deployment-model confirmation, Gate 5 instance completeness

- **EA-60A:** Authorized scope was the deployment-model determination, the minimal F-59-1 fix with its tests, and a container path **only if** real evidence showed Compose plain containers. Nothing was deployed, rolled back, migrated, restored, pushed, published, dispatched, or granted. Branch/HEAD stayed `hse-platform` @ `51a899b7`.
- **EA-60B (deployment model):** The deployment is a **Swarm stack**, not Compose plain containers — static evidence, high confidence. `deploy/dokploy-dev.compose.yaml` uses `deploy.replicas`/`deploy.restart_policy` (Swarm-only semantics); the workflow sends and asserts `composeType: "stack"` (`deploy-dev.yml:473,494`); the pre-pull step is "Pre-pull images onto the swarm manager" (`:293`); both deployment paths roll and validate `<stack>_{web,worker,scheduler,storage-init}` Swarm services (`:263,517-530`). Live confirmation on the deployment host remains `NOT VERIFIED`. **Consequence:** the Compose-container inspection path is not justified and was not built; F-59-2 is closed as "not needed by evidence", not as "implemented".
- **EA-60C (F-59-1 fixed):** `scripts/ci/reconcile-running-digest.sh` now requires a roster file and refuses to run without one. The roster states stack, digest, provenance, and per-role `replicas`/`running`. The gate validates the roster (stack/digest mismatch, non-integer replicas, missing `.running`, unknown keys, empty roster → exit 2; unreadable roster → exit 1) before querying, then checks: query succeeded; every rostered service exists; no unrostered service runs the gated image; every service inspects; spec image is digest-addressed and matches; long-running roles match the replica spec and have exactly the expected live tasks, each on the gated digest; one-shot roles have a completed task on the gated digest. Reproduction before the fix: a three-of-four listing printed `Gate 5 PASS` and exited 0 (EA-59 S12). After: exit 1, "instance set is incomplete".
- **EA-60D (roster provenance):** The workflow generates the roster in the Gate 5 step from values it already owns — `DOKPLOY_TARGET_STACK`, `IMAGE_DIGEST`, `WRITER_REPLICAS` (now declared in the step `env:`, matching the value written to the Dokploy environment at `:446`), and the gated role set both paths already roll. It is **never** derived from `docker service ls`; a roster built from the fleet would agree with any listing, including a truncated one. `minio`/`collabora` are excluded because they never carry the gated image; an unrostered service that does carry it is still rejected.
- **EA-60E (one-shot semantics):** `scheduler` and `storage-init` finish successfully and are not restarted by `restart_policy: on-failure`, so they have zero live tasks after a correct rollout. The roster marks them `running=false` and their identity is proven by the service spec plus a completed task on the gated digest. Requiring a live task would make Gate 5 permanently red on a healthy deployment; accepting the spec alone would not prove the task ran the gated image. Both facts are required.
- **EA-60F (tests):** `deploy-control-hardening.test.mjs` 52/52 (36 EA-58 + 16 EA-60), `build-identity-gate.test.mjs` 31/31, `replica-coverage` 17/17, `verify-source-origin` 11/11, plus the five shell suites. EA-58/EA-56 tests were adapted to the roster contract with every original assertion preserved; the docker stubs gained `service ps`, replica-spec and image-map support. The isolated scenario log covers 25 cases (25/25 matched) including the S12 regression, rolling deploys, replica shortfall/excess, readiness-vs-digest, tag refs, one-shot roles, malformed rosters and a full positive control.
- **EA-60G (workflow):** Gate 5 remains the final deploy step, unconditional, non-`continue-on-error`, and unable to exit 0 by fiat; the step now builds and passes the roster, and `EA60-T14` pins that the roster is not derived from a fleet query. The stale "compose path has no task access" comment was corrected to match `:254-271`.
- **EA-60H (gates):** `format:check` 0; `typecheck` 27/27 and forced 27/27 `Cached: 0`; `lint` 1/1 and forced 1/1 `Cached: 0`; `deadcode:check` 0; forced serial full suite and `pnpm build` recorded in `docs/evidence/ea60/`; `git diff --check` 0. Environment note: the host Docker daemon restarted mid-phase, stopping the local dev fixtures; they were started (not recreated or deleted) so the suite could run against them, and Postgres completed crash recovery. No production service was touched.
- **EA-60I (process gap):** the pre-edit hash of `scripts/ci/build-identity-gate.test.mjs` was not captured before editing (same gap EA-58 recorded). It is untracked, so no `git diff` exists; the edits are described in the report and the post-edit file is hashed in `docs/evidence/ea60/SHA256SUMS`. The `/tmp` prototype artefacts were also lost when the environment cleared `/tmp` mid-phase; the isolated log was regenerated against the shipped script and nothing in the report depends on a lost artefact.
- **EA-60J:** Remote tiers remain untouched: real GitHub Actions `NOT RUN`, GHCR `NOT RUN`, Dokploy Gate 5 and live Swarm confirmation `NOT VERIFIED`, A1–A8 `PENDING AUTHORIZATION`, rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`, Migration 51 and database/object-store restore `NOT RUN`, production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`. EA-57 `D8`/`D9` unchanged.
- **EA-60K:** Report: `docs/ea60-deployment-gate-completeness-report.md`; evidence: `docs/evidence/ea60/`. EA-60 stops here; EA-61 was not started.

## EA-58 addendum (2026-10-27) — deployment-gate repair and CI control hardening

- **EA-58A:** Authorized scope was exactly four defects plus the regression tests they need, and nothing else. No production deploy, GHCR publication, push, PR, Migration 51, database or object-store restore, rollback implementation, A1–A8 decision, org-level permission change or new credential. Nothing was committed, pushed, dispatched, published or deployed, and the branch/HEAD stayed `hse-platform` @ `51a899b7`.
- **EA-58B (fix 1):** The Dokploy compose path returned `exit 0` after printing `Gate 5 NOT VERIFIED`, so an unverified deployment concluded green. `deploy-dev.yml:588-595` → `589-595`: the `DOKPLOY_DEPLOY_MODE != 'direct'` branch was deleted and the reconciler now runs on **every** path, with an explicit `::error::` and `exit 1` when it fails. Chosen over an unconditional `exit 1` on the compose branch because the compose path must still be able to pass when a digest is genuinely read and matches. The Swarm digest comparison itself was not touched.
- **EA-58C (fix 2 / F-4):** `reconcile-running-digest.sh` read the service list through a process substitution, which discards the producer's exit status, so a daemon failure surfaced as "matched no running BeaconHS service". The listing is now captured with `if ! services="$(…)"`, and three outcomes are distinct: query failure (Docker's own stderr preserved), query succeeded with no services, and services present but none BeaconHS. `done <<<"$services"` keeps the counters in the current shell. Every existing fail-closed path is unchanged.
- **EA-58D (fix 3 / F-2):** `verify-image-identity.mjs:125` computed `exitCode = verify.ok ? 0 : 1` and never consulted `parsed.verdict`. A new exported `interpretVerifierResult()` validates, in order: exit 0; output is one JSON object; `verdict` is a non-empty string equal to `PASS` **exactly** (never substring); `checks` is a non-array object with no `false`. The wrapper's `verdict` is its own adjudication and the verifier's claim is preserved as `verifier_verdict`. A direct-run guard makes the contract testable without Docker. Identity fields, version semantics and trusted-source rules are unchanged.
- **EA-58E (fix 4 / F-1):** `GITHUB_TOKEN` was removed from the source-origin step (`deploy-dev.yml:89-94`) after reading `verify-source-origin.mjs` in full and confirming it reads only git state — no token, no network, no API. The four steps that genuinely use a token (58, 65, 296, 346) were left untouched; no `permissions` scope was widened, and `packages: write`, `secrets: inherit` and OIDC are unchanged.
- **EA-58F (evidence discipline):** PART A of `control-reproduction.log` was executed against the **unmodified** code before any edit and records the real pre-fix exit codes: compose → exit 0 with a warning; `service ls` failure → the wrong "no match" message; the shipped verdict expression blocks 1 of 5 hostile inputs; the origin step carries an unused token. PART B records the post-fix behaviour under the same conditions. The F-2 half of PART A is explicitly labelled an **expression-level** reproduction, because the real verifier is internally consistent today — the defect is a missing check, not an exploitable path.
- **EA-58G (tests):** New `scripts/ci/deploy-control-hardening.test.mjs` — 36 tests, 36 passed, 0 failed, 0 skipped, exit 0. It extracts and executes the shipped `run:` block from `deploy-dev.yml`, so it exercises the code that will run in CI. EA-56's suites were re-run unchanged: `build-identity-gate` 31/31, `verify-source-origin` 11/11. Total 78 passed, 0 failed. The new suite is wired into `ci.yml:120` and pinned by EA58-T36 so it cannot be silently dropped.
- **EA-58H (gates):** `format:check` 0; `typecheck` 27/27 and forced 27/27 `Cached: 0`; `lint` 1/1 and forced 1/1 `Cached: 0`; `deadcode:check` 0; `turbo run test --force --concurrency=1` 25/25 `Cached: 0`, **3911 passed / 101 skipped / 0 failed**; `git diff --check` 0; both workflows parse as YAML with Gate 5 as the final deploy step. `actionlint` is not installed and was not fetched — recorded as a gap, not a pass.
- **EA-58I (deliberate consequence):** On a compose path where the runner cannot read the stack back, **every** deployment now ends with a failed Gate 5 step although the rollout succeeded. That is the mandated behaviour. It must not be "fixed" by restoring `exit 0`; the correct remedy is to give the runner service readback, or to move the compose deployment to an inspectable service model. Recorded as R-1 in `docs/evidence/ea58/blockers.md`.
- **EA-58J (process deviation):** The pre-edit hashes of the four control files were not captured before the edits landed and are recorded as `NOT CAPTURED` rather than reconstructed after the fact. Compensating evidence: the pre-fix execution in `control-reproduction.log` PART A and the pre-fix text quoted in `docs/evidence/ea57/workflow-audit.md`, hashed under EA-57 before EA-58 began.
- **EA-58K:** Remote tiers remain untouched and un-upgraded: real GitHub Actions `NOT RUN`, GHCR staging→release proof `NOT RUN`, Dokploy runner buildx and live-Swarm Gate 5 `NOT VERIFIED`, A1/A2/A5/A6 and the remaining A1–A8 decisions `PENDING AUTHORIZATION`, rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`, Migration 51 and database/object-store restore `NOT RUN`, production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`. EA-57 `D8`/`D9` are unchanged and out of scope.
- **EA-58L:** Report: `docs/ea58-gate5-and-ci-control-hardening-report.md`; evidence: `docs/evidence/ea58/` (`baseline.txt`, `control-reproduction.log`, `regression-tests.log`, `local-validation.log`, `workflow-audit.md`, `blockers.md`, `SHA256SUMS`). EA-58 stops here; EA-59 was not started.

## EA-57 addendum (2026-10-27) — CI execution, deployment-gate verification, blocker convergence

- **EA-57A:** Scope was verification only. No authorization existed for a production deploy, image publication, Migration 51, production rollback, database/object-store restore, any A1–A8 decision, or any production/`ceshi` change. Nothing was committed, pushed, dispatched, published or deployed.
- **EA-57B:** EA-56 evidence was re-verified first: all eleven artefacts present, `sha256sum -c SHA256SUMS` → 7/7 OK, exit 0, no self-reference. EA-57 then added no tracked source change; the only repository writes are files under `docs/`.
- **EA-57C (correction):** An earlier `pnpm test` "pass" was a **Turbo cache replay** (`Cached: 25 cached`), not an execution. A forced rerun failed: first on `@beaconhs/storage` → `ECONNREFUSED 127.0.0.1:9000` (MinIO down), then on host contention (`@beaconhs/jobs` "Test timed out in 5000ms", `@beaconhs/integrations` event-loop pending). `turbo run test --force --concurrency=1` → exit 0, 25/25, `Cached: 0`, **3911 tests passed, 101 skipped, 0 failed**. The gate passes here, but only serially; the cached result must not be cited as test evidence again.
- **EA-57D:** Local gates all exit 0: `format:check`, `typecheck` (also forced, 27/27 `Cached: 0`), `lint` (also forced, `Cached: 0`), `deadcode:check`, `build` (4/4, cache hit = inputs unchanged since EA-56's real forced builds), `git diff --check`. Identity suites run directly with `node --test`: `verify-source-origin` 11/11, `build-identity-gate` 31/31, both 0 skipped.
- **EA-57E:** 13/13 isolated deployment-blocking probes PASS (exit 0), reusing the checked-in EA-56 controls: foreign revision rejected; missing identity rejected; publication refuses an unusable digest before any registry contact; manifest/config mismatch refused; unsigned image yields `G4.identity_chain_complete = PARTIAL` ("INCOMPLETE by policy"), never `PASS`; `require_signature: true` + absent signature refused; truncated artefact non-zero; Gate 5 fails on mismatch, partial match and empty fleet; readiness cannot rescue a mismatch; a matching fleet passes. Positive controls (matching revision, current policy, matching fleet) confirm the harness can produce an "allow".
- **EA-57F:** Read-only audit of all ten required workflow checks: **9 `PASS` + 1 `PARTIAL`**. Confirmed by inspection: no `continue-on-error` anywhere; no `always()`/`failure()`/`cancelled()`; only four `if:` expressions, all api/direct route selection; `deploy.needs: build` and `deploy-dev.needs: ci`; control order origin (88) → build (96) → assert (124) → promote (133) → gate (344) → migrations (373) → rollout (518) → reconcile (588); `staging-` appears only in the build tag (108), the assertion (127) and its regression test — never in a deployment reference; `promote-verified-image.sh` is digest-addressed and re-verifies the digest; `reconcile-running-digest.sh` is fail-closed on every case.
- **EA-57G:** The one `PARTIAL` is the Dokploy compose path (Check 10): `deploy-dev.yml:591-593` emits `Gate 5 NOT VERIFIED` and then `exit 0`, so the log is honest but the run concludes green. Safety impact is zero (the artefact is identity-gated before rollout); release-signalling impact is real, because a dashboard reading only the conclusion would see success.
- **EA-57H:** Three low-severity findings recorded, not patched (EA-57 is verification, and editing the audited control would invalidate the audit): **F-4** `docker service ls` failure is not propagated, so `reconcile-running-digest.sh` reports "matched no running service" instead of the real error while still failing closed; **F-1** `GITHUB_TOKEN` is passed to the source-origin step (`deploy-dev.yml:90`) although `verify-source-origin.mjs` never reads a token; **F-2** `verify-image-identity.mjs:125` computes `exitCode = verify.ok ? 0 : 1` and ignores `parsed.verdict`, a defence-in-depth gap with no exploitable path today (the verifier exits `verdict === 'PASS' ? 0 : 1`).
- **EA-57I:** Remote tiers are unexecuted and unbundled: real GitHub Actions `NOT RUN` (no `gh`, no `act`, no token, no push/dispatch authorization), GHCR staging→release proof `NOT RUN` (no credentials; anonymous inspect → 401; no `staging-<sha>` artefact exists), Dokploy runner buildx and live-Swarm Gate 5 `NOT VERIFIED` (no access to `[self-hosted, dokploy]`; local Swarm inactive). `origin` is a fork while `deploy-dev.yml:28` publishes to `ghcr.io/braedonsaunders/beaconhs`, so real execution needs upstream package write access this environment does not have.
- **EA-57J:** Blocker register unchanged in substance: rollback remains `FAIL — NO EXECUTABLE ROLLBACK PATH` (no rollback script or step exists anywhere; `docs/ea52-build-identity-and-rollback-design-report.md:202` confirms no rollback code was written and RB-1…RB-13 are all `NOT RUN`); A1/A2, A5, A6 remain `PENDING AUTHORIZATION`; Migration 51, DB restore and object-store restore remain `NOT RUN`.
- **EA-57K:** A1–A8 were not substituted by technical tests. `require_signature: false` / `require_sbom: false` are the encoded statement that the decisions are open, and the gate's `PARTIAL` verdict is that statement rendered machine-readably. EA-16 historical provenance remains not-signature, not-SBOM and not cross-version proof.
- **EA-57L:** Production state **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**. Report: `docs/ea57-ci-and-deployment-gate-verification-report.md`; evidence: `docs/evidence/ea57/`.

## EA-56 addendum (2026-10-27) — trusted source identity, build assertion, deployment gate integration

- **EA-56A:** Authorization `EA56-CHG-1…6` was granted in conversation. No production/`ceshi` access, no deploy, no Migration 51, no DB/object-store restore, no A1–A8 approval, no commit/push/PR/publication.
- **EA-56B:** `turbo.json` was **not** edited. The working tree already declared `DEPLOYMENT_VERSION` in `globalEnv` (pre-existing ` M`, mtime `2026-10-23 11:04:04.542871014 +0800`, unchanged). Verified instead of re-applied: three real uncached `@beaconhs/web` builds produced `config.deploymentId` equal to the supplied revision, and a different revision produced a different artefact, so no identity-stale artefact is reused. The `Dockerfile` already rejects a non-40-hex value, so no Dockerfile change was needed either.
- **EA-56C (Step C):** `scripts/ci/verify-source-origin.mjs` establishes origin from a second, independent source **before** the build: expected = `GITHUB_SHA` from the platform event, actual = `git rev-parse HEAD` from the bytes being built. It refuses missing/malformed values, HEAD ≠ expected, shallow clones, dirty trees, and any trigger without defined SHA semantics (`pull_request*`, `merge_group`, unknown, missing) rather than defaulting. Motivated directly by EA-55 T5a: build and post-build assertion compare the artefact against the same caller-supplied value, so both pass for a foreign revision and only an independent origin check can catch it. 11/11 tests pass.
- **EA-56D (Step B):** EA-53 `verify-build-identity.mjs` is reused unchanged as the single identity parser; `scripts/ci/verify-image-identity.mjs` extracts the artefact from the built image and delegates every decision to it. Rejects absent, empty, malformed, `BUILD_ID`, unreadable and mismatched identity; never falls back to `APP_VERSION`. `EA56-T27` fails if a second parser appears.
- **EA-56E (Step D):** EA-54 `deployment-gate.mjs` reused unchanged. New glue is limited to `assemble-gate-candidate.mjs` (the only registry reader), `promote-verified-image.sh` (digest-preserving publication), `reconcile-running-digest.sh` (Gate 5) and `deploy-gate-policy.json`. The index is read with `buildx imagetools inspect --raw` because `docker manifest inspect` strips `annotations`, which is where the provenance subject binding lives.
- **EA-56F:** Publication is now genuinely gated. The build pushes only `staging-<sha>`; the deployable tag is created by a server-side manifest copy **after** the identity assertion, and the promotion verifies the digest did not change. `--load` was rejected because it discards the BuildKit provenance attestation.
- **EA-56G:** Chain order, enforced in `deploy-dev.yml`: origin → build → assert → publish → gate → deploy → reconcile. No `continue-on-error` exists in that workflow. The pre-deploy gate runs before migrations and rollout.
- **EA-56H:** Supply chain remains **incomplete by policy**, and says so: `require_signature`/`require_sbom` are false because A1/A2/A6 are `NOT FOUND`, so the gate emits `G3.signature_required_by_policy` and `G4.identity_chain_complete` as `PARTIAL` with "INCOMPLETE by policy". An unsigned image is never reported as a complete chain. Choosing Rekor vs. private Sigstore, an observe-only window, a `buildkit_completeness=false` exception, or an unsigned-history rollback exception was **not** decided.
- **EA-56I:** Gate 5 uses only capability the deploy job already had (`docker service inspect`, already used for target resolution) and is binding in direct mode. On the Dokploy compose path the runner cannot read running tasks, so the step emits an explicit `Gate 5 NOT VERIFIED` warning instead of passing quietly. No new credential or permission was added.
- **EA-56J:** Three real defects were found and fixed during validation: (1) `reconcile-running-digest.sh` reported "no running service" when every matched service was mismatched, because the guard used the pass counter; (2) the assembler lost the provenance subject by reading the index with `docker manifest inspect`; (3) the assembler depended on `crane`, absent on both runners, now replaced with buildx/docker.
- **EA-56K:** Verification — `verify-source-origin` 11/11, `build-identity-gate` 31/31, isolated end-to-end build→assemble→gate `PASS` plus a negative control refused; `format:check`, `typecheck` (also forced), `lint` (also forced), `test` (25/25 tasks), `deadcode:check`, `build` all exit 0; existing CI host-safeguard scripts exit 0.
- **EA-56L:** Not verified: real GitHub Actions execution of the modified workflows, GHCR push/promotion, OIDC/Sigstore/Rekor, SBOM, and Gate 5 against a live Swarm — all `NOT RUN`/`NOT VERIFIED` because no push, publication or platform access is authorized. Rollback remains `FAIL — NO EXECUTABLE ROLLBACK PATH`. Migration 51 remains `NOT RUN`.
- **EA-56M:** Production state **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**. Report: `docs/ea56-build-identity-and-gate-integration-report.md`; evidence: `docs/evidence/ea56/`.

## EA-52 addendum (2026-10-27) — build identity remediation design and rollback execution path

- **EA-52A:** EA-51 evidence re-verified — 12/12 SHA-256 pass; `extract_identities.py` re-run reproduces all eight object identities. D1 (`deploymentId: undefined` on EA-16, source SHA absent from `/app`), D2 (HEAD `globalEnv` has 21 entries and no `DEPLOYMENT_VERSION`; the working tree has 25 and does) and D3 (`ready/route.ts:145` reads `process.env.APP_VERSION`) were each re-read from source, not inherited from EA-51 prose.
- **EA-52B:** D2 reproduced end to end in an isolated Next+Turbo workspace: a HEAD-shaped `turbo.json` yields `deploymentId: undefined`, a random `BUILD_ID`, and **0** files containing the source SHA. Declaring the variable in `globalEnv` **or** in a task-level `env` yields `deploymentId: "51a899b7…"` and **22** files containing it.
- **EA-52C:** Three new hazards isolated. **(1)** `envMode: "loose"` would "fix" D2 but forwards _every_ exported variable into tasks — the log shows `APP_VERSION`, withheld under strict mode, becoming task-visible. **(2)** `BUILD_ID` is **not** a revision fingerprint: Next returns the constant `build-TfctsWXpff2fKS` whenever `deploymentId` is configured, so two different commits share it (`next/dist/build/index.js`, `getBuildId()`). **(3)** a missing `DEPLOYMENT_VERSION` produces a **successful** build (exit 0) with no identity — silent degradation, not fail-closed, even though `Dockerfile:28` correctly rejects malformed values.
- **EA-52D:** Identity contract expanded to 10 fields with producer, immutability, format, verification, missing-value behaviour and — the decisive column — **whether the field can prove the source revision**. Only `deployment_version`, read back from the artefact, can. `source_revision`, `runtime_app_version` and every digest cannot.
- **EA-52E:** Remediation options compared (A commit the Turbo declaration, B inject the revision into a file, C separate build identity from runtime identity). Recommendation `PROPOSED`: **A first** (one line, closes D1 and D2 at the root, and is the change the working tree already contains but never committed), **C second** (D3 is a semantic problem A cannot fix), **B not primary** (fixes the symptom, leaves D2 as a trap). Regardless of choice, a missing identity must become a build failure.
- **EA-52F:** Deployment validation specified as ten ordered steps; **only step 1 (index digest) is implemented**. Step 9 — reading the image's embedded identity and comparing it to `source_revision` — is the pivot, because steps 1–8 are all assertions _about_ the image by systems outside it. Step 9 cannot pass today.
- **EA-52G:** Rollback execution contract written (10 steps, 4 classes). Step 10 requires a **business-critical path**, not readiness 200 — readiness only proves the process booted. RB-A may be automatic; **RB-B/C/D remain `PENDING AUTHORIZATION`** (A8, plus A7 for RB-C) and therefore have no executable path today.
- **EA-52H:** Server Action Key and Migration 51 limits restated with evidence: the key is baked at build time so a rollback target carries whatever key it was built with (different key → 404, EA-33 staging); the forward deploy gate has no rollback equivalent; `EA-16 → current` same-key is `NOT VERIFIED`; migrations are forward-only so an image rollback cannot undo one, and the Migration 51 production pre-check, DB restore and object-store restore are all `NOT RUN`.
- **EA-52I:** Recovery timing — build is 342 s mean (six existing cold builds, 323–363 s), but registry push, image pull, application start, schema verification, object-store recovery and business-path verification are all `NOT RUN`. **342 s must not be quoted as a recovery time.**
- **EA-52J:** Test matrices — build identity BI-1…BI-12: 6 `PASS`, 4 `FAIL` (each recording current repository behaviour, i.e. the defects themselves), 2 `NOT RUN`; rollback RB-1…RB-13: **all `NOT RUN`**, because no rollback code path exists. D1/D2 are therefore `PARTIAL — MECHANISM CONFIRMED`, not fixed.
- **EA-52K:** Readiness for a formal fix — D2: ready (root cause known, fix verified, one line). D1: ready together with D2 plus a build-time assertion. D3: partially ready (design complete; needs a new application surface and Technical Approver approval). Rollback: **not ready** (needs DI-7 and A8).
- **EA-52L:** Gates — only `pnpm format:check` was run (exit 0); typecheck/lint/deadcode/test/build are `NOT RUN` because no code, dependency, schema or build input changed and EA-47 already ran all six with `--force` at this HEAD. Evidence: `docs/evidence/ea52/`.
- **EA-52M:** Documents — `docs/ea52-build-identity-and-rollback-design-report.md` created; `docs/evidence/ea52/{design,tests,environment}` created; the release checklist gained §10.24 and a status line only. **`turbo.json` was neither committed nor reverted** (still the same `M` with mtime 2026-10-23T11:04), all probes ran under `/tmp/opencode/ea52/`, and EA-43's signature and risk-level fields remain empty. No workflow, Dockerfile or application code was modified; no pipeline ran; no registry was contacted; no deployment or rollback occurred. Final status unchanged: `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`.

## EA-51 addendum (2026-10-27) — deployment identity chain and legacy recovery feasibility

- **EA-51A:** EA-50 evidence re-verified — 13/13 SHA-256 pass and the consistency script still reports `CONSISTENT`; A1–A8 remain `0 APPROVED / 8 NOT FOUND`.
- **EA-51B:** Identity chain traced end to end (8 links). **Four do not exist**: the platform manifest digest (no manifest parsing anywhere in `deploy-dev.yml`), the image config digest, any deployment record, and any rollback record. Of the ten required checks: 2 `PASS`, 2 `PARTIAL`, 6 `FAIL`.
- **EA-51C:** Contract defined — 17 fields marked mandatory / conditional / optional, each annotated with whether a **producer exists**. Most do not. Rules: full digests only, never derive a digest from a tag, absent ≠ empty (never substitute a neighbouring field), all subjects must resolve to one digest, and index-vs-manifest are wrapper-vs-content (EA-47 measured the index changing while the manifest did not).
- **EA-51D:** **New defect D1 — the image does not corroborate its own source revision.** EA-16 has `deploymentId: undefined` and the source SHA appears **0** times in `/app`; the EA-45 image built with the corrected tree has `deploymentId: "51a899b7…"` and **295** matching files. Measured read-only against two pre-existing local images; no new build was run.
- **EA-51E:** **New defect D2 — root cause is an uncommitted `turbo.json` edit.** Turbo 2.10.5 filters the task environment to `globalEnv`; `git show HEAD:turbo.json` does **not** declare `DEPLOYMENT_VERSION`, while the working tree does — and that edit has mtime 2026-10-23T11:04, _after_ the EA-16 build at 05:31. So a CI build from committed `51a899b7` reproduces EA-16's behaviour, not the EA-45 images'. Confirmed with a three-variant isolated probe (declared → passes; undeclared → `undefined`; task-level `env` → passes). EA-43 fact 19 and EA-45 §4.3 described this as a _reproducibility_ note; it is also an identity defect.
- **EA-51F:** **New defect D3 — the readiness check is close to tautological.** `ready/route.ts:145` reports `process.env.APP_VERSION`, which the deploy injects from the same `$GITHUB_SHA`, rather than the image-baked `DEPLOYMENT_VERSION`. It proves the orchestrator told the container the expected SHA, not that the image was built from it.
- **EA-51G:** Historical evidence matrix — 8 objects, every digest **recomputed from raw bytes** (script `tests/extract_identities.py`). All internally coherent (config matches manifest, provenance subject equals manifest, index contains the manifest), but **none has a signature and none has an SBOM**. EA-13 and earlier are `NOT VERIFIED`. Note: the extraction script hit the same prefixed-vs-bare digest bug as EA-48 G1 on its first run; comparisons now go through a single `norm()`.
- **EA-51H:** Server Action Key — same-key works, different-key yields 404, K1→K2→K1 restores functionality, all `PASS — SPECIFIC SCENARIO VERIFIED` in staging; the forward deploy gate is implemented; **EA-16 → current same-key is `NOT VERIFIED`** and rollback across a key rotation is `NOT RUN`. No key material was read or derived.
- **EA-51I:** Rebuild time recovered from six existing cold-build ledgers: **323–363 s, mean 342 s (5 m 42 s)**, all `--no-cache`. But "cold build → serving" is `PARTIAL`: the ledgers exclude registry push, target pull, migrations, convergence and readiness (the deploy job allows 600 s for readiness alone). No new build was executed.
- **EA-51J:** Rollback options re-evaluated (Revision 2). The decisive finding is that **no rollback code path exists**, so R1 (verify), R3 (exception) and R4 (prohibit) are currently statements of intent rather than enforceable controls; R2 can only produce a declaration. Recommendation stays R3 with an expiry plus R2 as a strictly custodial statement, now sequenced **after** DI-7 and with "we can rebuild instead" treated as unproven until cold-build→serving is measured. Marked `RECOMMENDATION ONLY — NOT APPROVED`.
- **EA-51K:** Test matrix T1–T14 — **4 `PASS` (isolated only), 2 `PARTIAL`, 8 `NOT RUN`**. T9/T10/T14 are blocked by the same missing rollback path; T3/T7 need A1/A2 and the keyless identity; T12/T13 need database and storage drills.
- **EA-51L:** Gates — only `pnpm format:check` was run (exit 0); typecheck/lint/deadcode/test/build are `NOT RUN` because no code, dependency, schema or build input changed and EA-47 already ran all six with `--force` at this HEAD. Evidence: `docs/evidence/ea51/` (13 files, 12/12 hashes).
- **EA-51M:** Documents — `docs/ea51-deployment-identity-and-rollback-report.md` created; `docs/evidence/ea51/{design,rollback,tests,environment}` created; the release checklist gained §10.23 and a status line only. The uncommitted `turbo.json` was left exactly as found (neither committed nor reverted), and EA-43's signature and risk-level fields remain empty. **No workflow, Dockerfile or turbo config was modified; no pipeline ran; no registry was contacted; no deployment or rollback occurred.** Final status unchanged: `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`.

## EA-50 addendum (2026-10-27) — decision closure and legacy-image rollback risk

- **EA-50A:** EA-49 evidence re-verified — 18/18 SHA-256 pass and the EA-49 consistency script still reports `CONSISTENT`.
- **EA-50B:** Stricter approval scan — EA-49's scanner reported 6 hits on re-run; all six are rule descriptions or status sentences, not approvals. EA-50 added `strict_approval_scan.py`, which accepts only a decision block naming the owning role, the subject and a date, and rejects fixtures/summaries. Result on the repository: **0 qualifying approvals**. Positive control detects a synthetic signed block; three crafted near-misses are rejected.
- **EA-50C:** Register (A1–A8) — **`APPROVED` 0 · `PENDING AUTHORIZATION` 0 · `REJECTED` 0 · `NOT FOUND` 8**. Every item now has its own record with background, options, consequences, available evidence, missing evidence, a recommendation labelled `RECOMMENDATION ONLY — NOT APPROVED`, and **empty** decision-maker / date / record fields. Nothing was upgraded just because a request package now exists.
- **EA-50D:** Legacy rollback analysis — EA-16's identity is recomputable offline (index `17126c6e…`, manifest `43a7dc27…`, attestation `0f7e823e…`, provenance `15358431…`, `subject.digest = 43a7dc27…`, `vcs.revision = 51a899b7…`). The image is **unsigned, has provenance, and has no SBOM** — not "provenance-free", which matters because it makes retroactive attestation look more authoritative than it is.
- **EA-50E:** Four rollback options compared (R1 verify-before-rollback, R2 retroactive provenance attestation, R3 scoped time-bounded exception, R4 no unsigned rollback). R2 is flagged as the option most likely to be misread later: a signature over historical provenance is indistinguishable at a glance from a build-time signature. The recommendation (R3 with an expiry date plus R2 restricted to a clearly labelled custodial re-attestation) is marked `RECOMMENDATION ONLY — NOT APPROVED`. Until A8 is decided the operative default is the strictest reading (R1), and the gap is live **today**, independent of whether the gate ships.
- **EA-50F:** OIDC pre-check plan — six non-substitutable acceptance items (O1 approved · O2 configured · O3 repository can obtain an identity · O4 Fulcio issues · O5 identity matches · O6 signature verifies). All are `NOT FOUND`/`NOT VERIFIED`; nothing was executed. The plan fixes permissions (id-token + contents only), trigger (workflow_dispatch on a scratch branch, no `environment:`), runner (never the self-hosted dokploy runner), what may be recorded (claims and SAN only, never tokens or ephemeral keys), and six stop conditions.
- **EA-50G:** Observe-only start checklist — 7 blocking gates (A1, A2, A5 with dates, OIDC probe, named owner, declared workflow scope, evidence destination) and 11 configuration gates. Start status **`NOT STARTED — PENDING AUTHORIZATION`**; observation remains **0 days / 0 builds**. Two hard constraints recorded: observe steps must be non-blocking, and the deployed digest must not change because of them.
- **EA-50H:** Gate transition assessment — **0 of 9 met**, 1 `PARTIAL` (negative tests remain offline-only). No criterion was reworded or relaxed. Real OIDC and GHCR verification are still `NOT VERIFIED`; no observation has run; SBOM coverage has no formal policy; A8 is undecided; and the failure-blocking mechanism is proven only in simulation (`tests/T12-blocked.log`).
- **EA-50I:** Newly isolated defect — the pipeline deploys by **index digest** and never records or cross-checks the **platform manifest digest** that signatures, SBOM and provenance actually name, so "release and rollback identity are the same object" is a document convention rather than an enforced invariant (`deploy-dev.yml:39,262,366,450`). Recorded in the transition assessment §2; fixing it requires a workflow change, which this phase may not make.
- **EA-50J:** Decision request package — per-item question, options, consequences, existing evidence, missing evidence, recommendation (labelled), approver role, empty decision fields, and a copy-paste decision record template. Routing summary states which owner unblocks what.
- **EA-50K:** Cross-document consistency — `decisions/check_consistency.py` treats the register as the source of truth and asserts the narrative, the start checklist and the transition assessment agree; also fails if the rollback recommendation loses its `NOT APPROVED` label or if A8 flips without reconciliation. Verdict `CONSISTENT`.
- **EA-50L:** Gates — only `pnpm format:check` was run (exit 0); typecheck/lint/deadcode/test/build are `NOT RUN` because no code, dependency, schema or build input changed and EA-47 already ran all six with `--force` at this HEAD. Evidence: `docs/evidence/ea50/` (14 files, 13/13 hashes).
- **EA-50M:** Documents — `docs/ea50-approval-and-rollback-readiness-report.md` created; `docs/evidence/ea50/{decisions,rollback,environment}` created; the release checklist gained §10.22 and a status line only. The EA-43 signature and risk-level fields remain empty. **No workflow file was modified, no pipeline was triggered, no GHCR access occurred, no deployment or rollback was performed.** Final status unchanged: `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`.

## EA-49 addendum (2026-10-27) — observe-only phase A readiness and authorization verification

- **EA-49A:** EA-48 evidence re-verified — 81/81 SHA-256 pass and 7/7 decompressed payloads match; the design inputs are intact and no original evidence was overwritten.
- **EA-49B:** Authorization register (A1–A8) — **0 `APPROVED`, 0 `PENDING AUTHORIZATION`, 0 `REJECTED`, 8 `NOT FOUND`**. Three independent searches (approval-marker scan over every `*.md`, signature-table audit with column discipline, git history/tags/branches) all came back empty; a synthetic signed row proves the scanner does mark a real signature (`docs/evidence/ea49/authorization/scanner-positive-control.json`).
- **EA-49C:** Column-discipline trap documented — the tables at `release-approval-checklist.md:299-304` and `:350-355` are headed "is a signature **required**"; their `✅ Yes` cells mean _a signature is still needed_, not _signed_. Reading them as signatures would have fabricated four approvals. The auditor therefore only accepts a real signature column (签字/签署/signature) and rejects bare ✅/❌.
- **EA-49D:** Prior approval material confirms the same state rather than reversing it — `ea39:505-520` (items 7–11 `PENDING`/`NOT DECIDED`), `ea40:89-140` ("No valid written approval obtained"), `ea43` §8 signature table entirely empty.
- **EA-49E:** Observe-only plan — defined meaning (collect only, no decision authority, no auto-blocking, no retroactive signing, no gate bypass, no secret collection, no environment mutation), a conditional 14-day/≥10-build window with unset dates, 14 metrics with machine-checkable definitions, 8 negative tests with the level each may run at, and exit criteria. Two clarifications are stated up front: a non-blocked deployment is **not** a passing control, and an existing mandatory check keeps failing under current rules.
- **EA-49F:** Observation reality — **0 days, 0 builds**. No window has started; signature metrics (M9–M11) cannot be observed at all until A1/A2 exist.
- **EA-49G:** Executable capability boundary — `proposal/capability_matrix.py` classifies 24 capabilities and fails if anything needing authorization reads as allowed. Result: **10 allowed (offline only) / 11 design-allowed, execution pending authorization / 3 prohibited outright** (editing workflows, triggering a deployment, touching production/ceshi/GHCR credentials).
- **EA-49H:** Readiness checklist (P1–P11) — `APPROVED` 0 · `PENDING AUTHORIZATION` 6 · `NOT VERIFIED` 2 · `PROPOSED` 2. The single genuinely new technical finding is **P3**: granting `id-token: write` does not guarantee the repository can obtain a GitHub OIDC identity, so an approved A2 can still produce a permanently red pipeline. A read-only capability pre-check is required before any workflow edit is proposed — and it is itself `NOT RUN`.
- **EA-49I:** Transition criteria (9) — **0 of 9 met**; criterion 7 (negative tests) is `PARTIAL` because all eight classes were rejected only in isolation. Anti-criteria are listed (unclassified `UNKNOWN` failure, extrapolating under 10 builds, `PASS` with a zero denominator, greening a check by loosening it, reused signatures, rollback without A8).
- **EA-49J:** Cross-document consistency — `authorization/check_consistency.py` parses the register and asserts the readiness checklist, transition criteria and status line agree; verdict `CONSISTENT` (register is the single source of truth).
- **EA-49K:** Operational risk surfaced — until A8 is decided there is **no compliant path to redeploy a pre-policy (unsigned) image during a rollback**. That is independent of whether the gate ever ships.
- **EA-49L:** Gates — only `pnpm format:check` was run (exit 0); typecheck/lint/deadcode/test/build are `NOT RUN` with the reason recorded (no code, dependency, schema or build input changed; EA-47 already ran all six with `--force` at this HEAD). Evidence: `docs/evidence/ea49/` (19 files, 18/18 hashes).
- **EA-49M:** Documents — `docs/ea49-observe-only-readiness-report.md` created; `docs/evidence/ea49/{authorization,proposal,environment}` created; the release checklist gained §10.21 plus two EA-49 status rows (no existing production blocker was altered). **No workflow file was modified, no pipeline was triggered, no GHCR access occurred.** Final status unchanged: `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`.

## EA-48 addendum (2026-10-26/27) — CI supply-chain gate audit and isolated verification

- **EA-48A:** EA-47 evidence re-verified — 49/49 SHA-256 pass and 5/5 decompressed payloads match, so the design inputs are intact.
- **EA-48B:** CI audit (read-only, 14 checks) — the pipeline **does** deploy by immutable index digest (`deploy-dev.yml:262,366,450`) and **does** forbid `contents: write` (enforced by `scripts/ci/workflow-repository-immutability.test.sh` at `ci.yml:114`). It generates **no SBOM**, **no signature**, performs **no verification**, uses **no OIDC**, and **never records the platform manifest digest** — even though signatures, SBOM and provenance all name that digest. 2 `PASS`, 6 `PARTIAL`, 4 `FAIL`.
- **EA-48C:** Publication ordering defect — `push: true` sits inside the build step (`deploy-dev.yml:82-99`), so any post-build gate can only block the _deploy_, never the _publication_. The proposal therefore moves proof generation into the build job.
- **EA-48D:** Permission findings — `packages: write` is granted to the caller job (`ci.yml:177-183`) and `secrets: inherit` materialises every repository secret in the reusable workflow. Proposed: `packages: write` only on the build job, enumerated secrets, `id-token: write` + `attestations: write` on the build job only, deploy job stays read-only.
- **EA-48E:** Gate reference implementation — 7 stages: index digest → platform manifest → signature → SBOM attestation → component coverage → provenance subject/revision → SBOM root checksum. Fail-closed, prints only digests and booleans, never key material. Lives in `docs/evidence/ea48/gate/supply-chain-gate.sh`, **not** in `.github/workflows/`.
- **EA-48F:** Isolated verification T1–T14 — all pass: unsigned image rejected (exit 10), appended layer rejected, transplanted signature rejected (`provided artifact digest does not match any digest in statement`), wrong signing identity rejected, provenance revision mismatch rejected, ambiguous/absent platform rejected, repointed tag rejected while the digest reference still passes, missing component rejected, and a failing gate provably blocks the simulated publish step. 14/14 including 8 negative cases.
- **EA-48G:** SBOM determinism trap — two scans of the same immutable digest produce different bytes (SPDX `0e91a7f8…` vs `0f91b0d6…`, CycloneDX `782b1054…` vs `42c414ef…`) because of random document UUIDs, while the canonical component digest (`0064dce9…`) is identical. CI must compare canonical digests, never raw SBOM hashes; a negative control confirms mutating one version changes the canonical digest.
- **EA-48H:** Chrome Headless Shell — syft 1.55.0 emits no package for it, only five `files[]` entries. A declared-component enrichment mechanism (version from the Dockerfile ARG, evidence paths must exist in the image, duplicates not re-added) was verified to add, be idempotent, and reject a declaration whose files are absent.
- **EA-48I:** Proposal delivered but **not applied** — `docs/evidence/ea48/proposal/` holds `ci-supply-chain-design.md`, `workflow-change-plan.md` (C1–C11 with exact insertion points), `permissions-matrix.md`, `verification-matrix.md`, `rollback-plan.md`, and `example-deploy-steps.yml.snippet` (banner: PROPOSAL — NOT FOR PRODUCTION — NOT APPLIED). No workflow file was modified.
- **EA-48J:** Three defects were found **in the gate itself** by the negative tests (mixed `sha256:` prefixes in digest comparison, `repo@sha@sha` reference construction, misleading "ambiguous (found 0)" message) and fixed before the final runs.
- **EA-48K:** Gates — only `pnpm format:check` was run (exit 0); typecheck/lint/deadcode/test/build are `NOT RUN` with the reason recorded: no application code, dependency, schema or build input changed, and EA-47 already ran all six with `--force` at this same HEAD. Evidence: `docs/evidence/ea48/` (82 files, 81/81 hashes).
- **EA-48L:** Documents — `docs/ea48-ci-supply-chain-gate-report.md` created; EA-43 moved to Revision 5 (§1.4 facts 36–42, controls 19–24); the release checklist gained §10.20, four supply-chain blockers in §11, and an EA-48 status line. Final status unchanged: `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`.

## EA-47 addendum (2026-10-26/27) — supply-chain closure on an isolated registry

- **EA-47A:** EA-46 evidence re-verified — 25/25 SHA-256 pass; the 17/18-layer result, the preview-key residual and the digest relationship all still have their original evidence. EA-46 did not contain SBOM/signature/registry results (it recorded their absence), and that is accurate.
- **EA-47B:** CI audit — `ci.yml`, `deploy-dev.yml` and `security.yml` contain **zero** references to sbom/cosign/sigstore/attest/provenance/notation. Deployment still pins `IMAGE_NAME@${IMAGE_DIGEST}` (index digest) with a `^sha256:[0-9a-f]{64}$` check.
- **EA-47C:** Test vehicle — a throw-away `registry:2` (`sha256:a3d8aaa6…`) on `127.0.0.1:5055`. EA-45's `beaconhs:ea45-repro-1` was retagged to `127.0.0.1:5055/beaconhs-ea47:a1`; `docker push` **preserved** the index digest `9b2156ac…`. No existing image was overwritten, retagged in place, or deleted.
- **EA-47D:** SBOM — syft 1.55.0 (pinned, upstream checksum verified) produced SPDX 2.3 and CycloneDX 1.7 for the registry object (bound to `source.id = be54cfce…`, 1,521 packages) and for EA-46's OCI archive (`41a45fae…`, 1,504 packages). Structural validation: 0 errors; only duplicate-purl warnings caused by multiple `pnpm deploy` trees. Coverage is Debian 12 (267 deb), 1,250 npm packages (38 `@beaconhs/*`, next 16.3.5, react 19.2.7, sharp 0.35.4) and node 24.18.0 — but **`chrome-headless-shell 140.0.7339.207` is not a component**, only five file entries.
- **EA-47E:** Signing — cosign 3.1.4 with a throw-away key and a no-Fulcio/no-Rekor/no-TSA signing config (cosign v3 rejects `--tlog-upload=false`). Signing the platform manifest and the index digest both verify; `verify-attestation --type spdxjson` binds the SBOM to `be54cfce…`. `cosign verify` against the tag fails (`no signatures found`) because the tag resolves to the unsigned index — a deployment-identity trap now written into the policy.
- **EA-47F:** Tamper tests — unsigned digest → `no signatures found` (exit 10); appending an empty layer (new digest `d603c1ee…`) → `no signatures found`; transplanting the original signature artifact onto the new digest → `provided artifact digest does not match any digest in statement` (exit 1).
- **EA-47G:** Provenance — the registry's attestation descriptor (`530bbc28…`) and provenance blob (`c990513f…`) are byte-identical to `docs/evidence/ea45/builds/`; `subject.digest` equals the amd64 manifest in the same index; `vcs.revision = 51a899b7…`. The provenance itself is unsigned and `buildkit_completeness=false`.
- **EA-47H:** Digest strategy — publishing the same amd64 manifest with and without the attestation descriptor yields index digests `9b2156ac…` and `e3e7d6f8…` while the manifest digest stays `be54cfce…`. **Index digest is a wrapper identity; the platform manifest digest is the content identity.** Recommendation: deploy by index digest, verify by manifest digest, never by tag.
- **EA-47I:** Deployment behaviour — both index-digest and manifest-digest pulls return the requested digest (the daemon then reports that digest as the image `Id`); a tag can be repointed while digest-addressed pulls stay stable; the registry rejects content/digest mismatches (`400 DIGEST_INVALID`). Real deployment and rollback remain `NOT RUN`.
- **EA-47J:** Verdicts — SBOM/signature/tamper/provenance/digest-pull are `PASS (LOCAL VERIFIED)`; SBOM completeness and preview keys are `PARTIAL`; CI implementation is `FAIL`; GHCR and real CI remain `NOT VERIFIED` / `NOT RUN`.
- **EA-47K:** Documents — `docs/ea47-supply-chain-closure-report.md` and `docs/evidence/ea47/` created; EA-46 gained an EA-47 banner plus §7/§8 notes and §8.4 corrections; EA-43 moved to Revision 4 (§1.3 facts 28–35, revised inferences/gaps, controls 13–18); the release checklist gained §10.19. Final status unchanged: `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`.

## EA-46 addendum (2026-10-26) — image determinism root cause and supply-chain verification

- **EA-46A:** EA-45 evidence re-verified — 26/26 SHA-256 pass, the four builds' index/manifest/config identities match the ledger, and the layer matrix is reproduced (10/18 differ; set always 6, 7, 9–16).
- **EA-46B:** EA-42 cache reuse proven (was inference) — exp1/exp2 have **0 differing layers**, and layer 6 contains `root/.npm/_logs/<ISO-8601-ms>-debug-0.log`, a filename that embeds the build instant; two independent builds cannot produce the same name.
- **EA-46C:** Build context — `.playwright-mcp/` holds 537 files / 3,530,121 B; **464 files / 3,423,084 B enter the Docker context** (`**/*.log` drops 73); **0 entries reach the final image** (18-layer scan). One `.dockerignore` line removes exactly 464 files (context 3,416 → 2,952), verified in isolation with `<dockerfile>.dockerignore`.
- **EA-46D:** Next.js preview keys — generated in `next/dist/build/preview-key-utils.js:43-49` via `crypto.randomBytes(16/32/32)`; reused only from `.next/cache/.previewinfo` (14-day expiry). BuildKit reports `is-docker()=false` (`/.dockerenv` absent, cgroup has no `docker`), so Next does write the cache file, but `.next` never survives between builds → new keys every build. They appear in exactly one file (`prerender-manifest.json`) and no compiled chunk; the app never calls `draftMode`. No env/config override exists.
- **EA-46E:** Layer root cause quantified — **600 content differences + 4 file add/remove + 83,458 mtime-only entries** (83.4% of 100,066 layer entries) across nine artefact classes: V8 compile cache, npm cache, npm debug logs, fontconfig cache, ldconfig aux-cache, apt/dpkg logs, `.modules.yaml`, `turbo-build.log`, preview keys.
- **EA-46F:** Correction to EA-45 — `--output type=…,rewrite-timestamp=true` **exists** (exporter attribute, not a CLI flag) and, together with `SOURCE_DATE_EPOCH`, makes two independent probe builds produce identical manifest/config/layer digests. EA-45's "toolchain does not support it" is withdrawn.
- **EA-46G:** Group D remediation (isolated copies only, repository untouched) — same-layer cleanup of npm cache/logs, V8 cache, fontconfig/ldconfig caches, apt logs, turbo logs and `.modules.yaml`, plus `rewrite-timestamp`: two cold builds give **17/18 byte-identical layers**. The only difference is `apps/web/.next/prerender-manifest.json` (3,889 B, three preview keys); configs differ only at `rootfs.diff_ids[10]`, while `history` and `created` are identical. Layer bytes 578,133,721 → 576,299,009 (−1.75 MB).
- **EA-46H:** Supply chain — **no SBOM** (the attestation manifest carries only the in-toto provenance layer; CI sets no `sbom:`); **CI has no signing step**; provenance is SLSA v1 with `subject` = platform manifest digest, `buildkit_completeness={request:false,resolvedDependencies:false}` and `vcs:revision` recorded.
- **EA-46I:** Verdict — `PARTIAL — APPLICATION CONTENT REPRODUCIBLE; IMAGE CONTENT NOT REPRODUCIBLE`. The manifest digest is still unreproducible solely because of the preview keys; the index digest is additionally unreproducible because provenance `invocationId`/timestamps vary, so **index digest must not be used as the reproducible identity**.
- **EA-46J:** Documents — `docs/ea46-image-determinism-investigation.md` and `docs/evidence/ea46/` created; EA-45 report gained a correction banner + §14; EA-43 risk acceptance gained §1.2 (facts 20–27) and controls 10–12; the release checklist gained §10.18.
- **Release status unchanged:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`. No repository `Dockerfile`, `.dockerignore` or workflow change was made.
- **No Git commits, pushes, or production deployments.**

## EA-17 addendum (2026-10-23) — download full E2E & release candidate archive

- **Download capability-URL full browser E2E: PASS.** 70-byte PNG uploaded via PPE inspection photo; browser followed 307 → presigned MinIO GET → 200, size 70, SHA256 `0fbc91e1…df96a02` (matches source). Invalid cap → 404. Cross-tenant covered by RLS probe.
- **Test data cleanup:** verified (MinIO object deleted, all DB rows removed, 0 leftover).
- **Release candidate:** image `beaconhs:phase-ea16-20261023-052716` (digest `sha256:17126c6e…`), version `51a899b7…`. All acceptance items PASS. No Git commits, pushes, or production deployments.

## EA-16 addendum (2026-10-23) — final closure & release candidate acceptance

- **Host-header redirect: FIXED & DEPLOYED.** `apps/web/src/app/invite/accept/route.ts` now uses `appBaseUrl()` (3 edits). Gates: format/typecheck/lint PASS, app-base-url tests 3/3, web build PASS. Deployed to ceshi as image `beaconhs:phase-ea16-20261023-052716` (digest `sha256:17126c6e…`). Web container healthy, readiness 200, version `51a899b7…`. Redirect now uses `https://beaconhs-test.xuhaoqing.top/...` (no more `0.0.0.0:3000`); forged Host does not change target.
- **Download capability-URL E2E:** PARTIAL. Capability gate (invalid→404) + storage-level download (SHA256 match) verified. Full browser redirect chain NOT RUN (requires signed session cookie).
- **Tunnel stability:** PASS (carried from EA-15, http2, 30-min probe 0 failures).
- **Test data cleanup:** verified (no orphans).
- **No Git commits, pushes, or production deployments.**

## EA-15 addendum (2026-10-23) — tunnel fix re-verification & final acceptance

- **Tunnel stability: PASS (CLOSED).** cloudflared now runs with `--protocol http2` (confirmed in process args, PID 151643, 6h+ uptime, NRestarts=0). 30-min external probe: 118/118 requests returned 200, 0 failures, p50=0.155 s. Journal: 0 QUIC timeouts in the new process lifetime (only pre-fix process had them).
- **Gateway Host-header redirect:** fixed in `apps/web/src/app/invite/accept/route.ts` (now uses `appBaseUrl()` instead of `req.url`). Code change; takes effect on next image build.
- **Download capability-URL E2E:** storage-level PASS (MinIO GET bytes match); full redirect chain NOT RUN (requires signed session cookie — not available in standalone container).
- **Cross-tenant RLS, monitored_sessions unauth (401), container health:** all PASS.
- **Test data cleanup:** verified (no orphans; 70-byte PNG removed from `.playwright-mcp/`).
- **No Git commits, pushes, or production deployments.**

## EA-14 addendum (2026-10-22) — closure verification on ceshi AJ stack

- **D-AK-4 (gateway self-heal):** CLOSED. aj-gateway moved into compose (host network, `restart: unless-stopped`, healthcheck script). 5 crash injections all recovered in 1–2 s.
- **D4 PPE event chain:** PASS (real E2E). Failed pre-use inspection (critical criterion) → `corrective_actions` (CA-2026-0001) + audit + status transition to out_of_service + `corrective_action.created` outbox event + notification to foreman. Retry dedup and cross-tenant RLS verified.
- **Upload E2E:** PASS. 70-byte PNG uploaded via presign PUT; MinIO HEAD/GET size=70; SHA256 matches original.
- **Tunnel stability:** OPEN (root cause: cloudflared QUIC egress degraded, 838+ timeouts, 0 http2 attempts). Fix requires root (`--protocol http2`); command documented in `docs/phase-6u-b3-ea14-final-report.md` §4.
- **Test data:** all synthetic rows cleaned; AJ tenant restored to pre-test state.
- **No code changes** to the repository; verification was operational on the ceshi host.

## EA-65 addendum (2026-10-30) — Ubuntu Server Compose environment validation

- **Verdict: PARTIAL.** The target `beaconhs-drill` (`10.10.31.30`) was confirmed: Ubuntu 24.04.5 LTS, Docker Engine 29.9.2, Compose v5.6.1, Swarm inactive, `overlayfs`. The canonical `/home/ceshi/beaconhs-phase-aj/deploy/local-production.compose.yaml` is byte-identical to the repository copy (`0337d38e…`), declares `beaconhs-local-prod`, 8 services, and has **0 containers**. Its three external volumes (`beaconhs-hse_*`) are missing.
- **Isolated Gate 5 PASS:** 8-service `beaconhs-ea65-20261030t065255z` project on `alpine@sha256:294b683c…`, exit 0; all 8 containers matched the manifest, `RestartCount=0`, required healthchecks healthy, one-shots exited 0. Crash-loop probe FAIL 3/3; `flock` contention FAIL exit 1.
- **Defects recorded, not fixed:** **F-65-1** — the verifier ignores `image: pinned` and requires every container to run the gated `EXPECTED_REF`; real probe failed at `postgres:16-alpine`. **F-65-5** — canonical Compose has no `com.beaconhs.deployment` / `image-digest` labels, but the verifier requires them; real probe failed with deployment `<none>`. **F-65-2** — canonical external volumes missing. **F-65-3** — active host projects are drill configs, not canonical (`phase-cd`: 10 services, no `worker` healthcheck). **F-65-4** — GHCR provenance NOT VERIFIED (no GHCR image/auth; anonymous 401).
- **Cleanup:** all four EA-65 projects removed with `down -v`; 0 EA-65 containers, networks, volumes or temp dirs. Pre-existing 26 containers, three Compose projects, registry and volumes unchanged.
- **Gates:** `format:check` 0; `typecheck --force` 27/27 `Cached: 0`; `lint --force` 1/1 `Cached: 0`; `deadcode:check` 0; `turbo run test --force --concurrency=1` 25/25 `Cached: 0`; `build --force` 4/4 `Cached: 0`; `git diff --check` 0.
- **Statuses unchanged:** real GitHub Actions `NOT RUN`; real GHCR `NOT VERIFIED`; real Ubuntu deployment `NOT VERIFIED`; production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; A1–A8 `PENDING AUTHORIZATION`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; Migration 51 `NOT RUN`; DB/object-store restore `NOT RUN`; WOPI paused. No commit, push, CI wiring, deployment-path change, image publish or production deployment. EA-66 was not started.
- **Evidence:** `docs/ea65-ubuntu-compose-validation-report.md`, `docs/evidence/ea65/` (59 hashed files).

## EA-65.1 addendum (2026-10-30) — gated/pinned image classification and deployment identity

- **Status: COMPLETE** for the code/contract scope. F-65-1 and F-65-5 are closed in the repository; production remains undeployed.
- **F-65-1:** `scripts/ci/reconcile-compose-digest.sh` now validates **gated** services against the run's `--image`/`--digest` and **pinned** services against their own manifest `expected_image`/`expected_digest`. Pinned refs are never compared to the gated `EXPECTED_REF`. The manifest requires explicit `role`, `image_class`, `expected_container_count`, `required`, `one_shot`, `health`, `expected_exit_code`, `deployment_label_required`, `image_digest_label_required`, and pinned `expected_image`/`expected_digest`. Tag-only pinned refs, missing digests, class conflicts and duplicate/unknown fields are NOT VERIFIED.
- **F-65-5:** all 8 canonical services carry `com.beaconhs.deployment`, `com.beaconhs.image-digest` and `com.beaconhs.role`. `BEACONHS_DEPLOYMENT_ID` is required with `:?` (no default); gated services use `BEACONHS_IMAGE_DIGEST`, pinned services use their own literal digest. The verifier renders the Compose config with the deployment environment and checks every service's image/labels before inspecting containers, then re-checks running containers.
- **Canonical Compose:** `postgres`/`redis` are now digest-pinned; `minio`/`collabora` remain digest-pinned. The repository render has 8 services, all labels, matching healthchecks, one-shot `restart: 'no'`, and the three external volume names. Target copy remains pre-EA-65.1 and was not modified.
- **Tests:** fixture suite 93/93 (includes original EA-63/EA-64.1); new real Docker suite 6/6 locally; independent 4-service gated+pinned project on `beaconhs-drill` returned Gate 5 PASS with `RestartCount=0` and correct labels. Gated mismatch, pinned mismatch, missing pinned image, missing role, missing deployment env and deployment-ID change are all covered.
- **Gates:** `format:check` 0; `typecheck --force` 27/27 `Cached: 0`; `lint --force` 1/1 `Cached: 0`; `deadcode:check` 0; `turbo run test --force --concurrency=1` 25/25 `Cached: 0`; `build --force` 4/4 `Cached: 0`; `git diff --check` 0.
- **Boundaries:** F-65-2 (canonical external volumes missing), F-65-3 (target active projects are drill configs), F-65-4 (GHCR provenance NOT VERIFIED), target canonical file drift and real BeaconHS image absence remain recorded, not fixed. Canonical production Gate 5 is **NOT VERIFIED**; production stays `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; rollback stays `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51 and DB/object-store restore `NOT RUN`; WOPI paused. No commit, push, CI wiring, target deployment or GHCR publish. EA-66 not started.
- **Evidence:** `docs/ea651-compose-image-classification-report.md`, `docs/evidence/ea651/`.

## EA-66A addendum (2026-10-30) — local build and offline dependency readiness

- **Status: PARTIAL.** The audit and designs are complete, but a clean offline build is not proven. No image was built, pulled, tagged, saved or published; no dependency was downloaded; no production server, database or object store was contacted.
- **Build chain:** one `Dockerfile` image for web/worker/scheduler/storage-init, built from `node:24.18.0-bookworm-slim@sha256:cb4e8f7c…` with Dockerfile frontend `docker/dockerfile:1.7@sha256:a57df69d…`; corepack 0.35.0/pnpm 10.30.3; `pnpm install --frozen-lockfile`; Turbo/Next/esbuild builds; Debian bookworm apt runtime (LibreOffice/poppler/fonts/libs); Chrome headless shell 140.0.7339.207; one app image + four pinned images.
- **Local images:** app candidate `beaconhs:phase-ea16-20261023-052716` (`sha256:17126c6e…`, linux/amd64), pinned postgres `721873c3…`, redis `858f009f…`, minio `b187417e…`, collabora `4e983196…`; selected total 5.08 GiB. EA-16 is a dirty-worktree candidate: embedded `deploymentId` missing, source SHA 0 matches in `/app`, no Docker build log, no SBOM/signature, provenance `completeness=false`.
- **Offline gaps:** Node base and Dockerfile frontend are **not local images** (BuildKit cache records only); corepack/pnpm bootstrap has no verified offline path; pnpm store `status` exits 1 with 4 mutated packages; Debian apt packages are unpinned and host apt cache is Ubuntu (no LibreOffice); Chrome is downloaded despite an exact local `/opt/chrome` copy; Server Action key file is missing. pnpm store 1.7 GB, BuildKit cache 109.5 GB (83.58 GB reclaimable), Docker images 36.5 GB, disk 67 GB free.
- **Target:** `beaconhs-drill` is Ubuntu 24.04.5, x86_64, Docker 29.9.2, Compose v5.6.1, Buildx v0.38.1, glibc 2.39; platform matches (`linux/amd64`). Target free 21 GB. It has app/pinned images except `minio/minio@b187…` (only the local-registry variant); canonical external volumes are missing and the target Compose copy is pre-EA-65.1.
- **Design:** release bundle with one app tar + four pinned tars, source/image/release manifests, SBOM/provenance, checksums and verify/import/deploy scripts; `pull_policy: never` + `--pull never` + `--no-build` + image preflight. Rollback requires two complete bundles plus DB/object-store/key checks; tar-only rollback is explicitly rejected. Current rollback remains **FAIL — NO EXECUTABLE ROLLBACK PATH**.
- **Findings F-66A-1…14** are recorded in `docs/evidence/ea66a/offline-build-gap-analysis.md`; the legacy `build-drill-image.sh` every-image rewrite and the workflow/canonical Collabora digest divergence are flagged but not fixed. No `.github`, Dockerfile, Compose, `.env`, `turbo.json` or business file was changed. HEAD unchanged; staged 0; no commit/push. EA-66B not started.
- **Evidence:** `docs/ea66a-local-build-offline-readiness-report.md`, `docs/evidence/ea66a/`.

## EA-66A.1 addendum (2026-10-30) — P0 blocker remediation

- **Status: COMPLETE for the three P0 items; EA-66A overall remains PARTIAL.** No image build, pull, Compose up, deployment or CI trigger. EA-66B not started.
- **F-66A-12 CLOSED:** `scripts/build-drill-image.sh` no longer globally rewrites every `image:` line. New `scripts/ci/pin-compose-app-image.mjs` reads the Gate 5 manifest's gated services (`web`, `worker`, `scheduler`, `storage-init`) and replaces only those image lines; pinned postgres/redis/minio/collabora and auxiliary mailpit are preserved. It writes a private temp file, validates with `docker compose config`, then runs `up -d --force-recreate --no-build --pull never`; the host Compose file is never written. Tests 8/8.
- **F-66A-14 CLOSED:** canonical `collabora/code@sha256:4e983196…` (26.04.4.2) is backed by Compose, Gate 5 manifest, local/target image and read-only registry metadata (amd64 platform manifest `b1845bd6…`). The legacy workflow `df33af88…` (26.04.2.1.1) was a valid but older image, not local; `deploy-dev.yml` now uses the canonical digest. Tests 5/5. Upstream signature/provenance remains NOT VERIFIED.
- **F-66A-8 CLOSED for design/controls:** Next.js 16.3.5 resolves `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` or the embedded build-time manifest key; the key must be identical at build and runtime and across all web replicas. Design: one `openssl rand -base64 32` key in a mode-600 file outside the repo; build via required BuildKit secret + fingerprint build-arg; runtime via a mode-600 env/systemd `EnvironmentFile`; only the 32-hex fingerprint is recorded. No formal key generated. Tests 6/6 plus 19/19 existing contract tests.
- **Packaging policy:** only the five runtime images (one app image + postgres/redis/minio/collabora) are in the release package; Node base, Dockerfile frontend, build tools, mailpit/registry/python and experiment images are excluded. Build-time tools/dependencies may be installed online with versions, digests, lockfile, log and SBOM recorded; deployment remains `docker load` + `docker image inspect` + `docker compose config` + `up --pull never --no-build`.
- **Verification:** app-image scope 8/8, Collabora 5/5, key 6/6, existing contract 19/19, PyYAML/Compose config/`bash -n`/`node --check` pass. `shellcheck` is not installed and was not run. Gates: format 0; typecheck 27/27 `Cached: 0`; lint 1/1 `Cached: 0`; deadcode 0; tests 25/25 `Cached: 0`; build 4/4 `Cached: 0`.
- **Preserved:** HEAD `51a899b7…`; staged 0; 165 modified; `turbo.json`, `pnpm-lock.yaml`, `Dockerfile`, canonical Compose and Gate 5 manifest unchanged; `.env` not read/modified. `deploy-dev.yml` had pre-existing user modifications; this phase changed only the `COLLABORA_IMAGE` line. `knip.ts` had pre-existing user modifications; this phase added only the helper entry and `tsx` ignore so the dead-code gate recognises the new test. No commit/push.
- **Statuses unchanged:** GHCR not a deployment source; external pull prohibited at deploy; production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; real Ubuntu deployment `NOT VERIFIED`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; WOPI paused. EA-66B not started.
- **Evidence:** `docs/ea661-offline-blocker-remediation-report.md`, `docs/evidence/ea661/`.

## EA-66B addendum (2026-10-30) — local image build verification

- **Status: PREBUILD BLOCKED.** No application image was built, because both images required by `Dockerfile` are absent locally and pulling is prohibited: `node:24.18.0-bookworm-slim@sha256:cb4e8f7c…` and `docker/dockerfile:1.7@sha256:a57df69d…`. `docker image inspect` returns `No such image`; the 66-image local inventory has no `node:*` or `docker/dockerfile:*` image. BuildKit cache records for both exist but are not local images and were not used.
- **No pull, no build, no package:** no `docker pull`, `docker compose pull`, application `docker build`/`buildx build`, `docker save`, `docker tag`, registry push, `docker compose up` or deployment. The only Docker builds were two `FROM scratch` fixtures in `scripts/ci/build-identity-gate.test.mjs`, removed by the test; image count remained 66.
- **Source identity:** deterministic context archive `docs/evidence/ea66b/source/source-context.tar.zst`, SHA-256 `927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9`, 4,544 entries, 21.1 MiB; list SHA `b714d665…`. HEAD `51a899b7…`; 165 modified, 538 untracked, 0 staged; `git diff HEAD` SHA `e7400473…`; status SHA `0c60f0c9…`. Archive excludes `.env`, `.env.orig`, `.env.prod-verify`, this phase's evidence directory and nested test output; includes `.env.example` and all application source.
- **F-66B-01 OPEN — deploymentId vs dirty worktree:** `build-local-image-with-key-gate.sh` passes `git rev-parse HEAD` while the source is a dirty tree, so a build would embed `51a899b7…` but contain `927062b6…` source. The image identity would not prove the source. A future build needs a clean checkout, a reviewed archive-derived 40-hex ID, or a fail-closed dirty-tree refusal.
- **Server Action key:** static design re-verified against Next.js 16.3.5; `server-action-key-handling.test.mjs` 6/6 and `build-identity-gate.test.mjs` 31/31 pass. `/tmp/beaconhs-server-action-key` is missing and no formal key was authorized, so the formal build is also blocked at the key gate. No key was created, printed or written to evidence.
- **pnpm store:** `pnpm store status` exit 1 with four flags. File-level comparison found zero indexed-file mismatches for the three eslint packages (extra nested peer `.bin` shims) and one intended `pagedjs` `package.json` patch difference (2,959 vs 2,949 bytes; patch hash `633a3606…`). Store not cleaned or reinstalled; lockfile unchanged.
- **Context:** `.dockerignore` unchanged. It includes 63 MB `docs/evidence`, 4.8 MB `.playwright-mcp` and `.tmp-*` scratch state; recommended additions documented but not applied because a build is blocked and the context hash cannot be re-validated. No application source excluded.
- **No artifacts:** no build log, image ID, platform, size, deploymentId read-back, config/manifest digest, SBOM, build-info or Gate 5 result. Signature status `NOT SIGNED`. The ten identity checks are NOT VERIFIED.
- **Verification:** EA-66A evidence 62/62 and EA-66A.1 evidence 31/31 verified at start; key tests 6/6; build-identity tests 31/31; no image pull. Evidence SHA-256 manifest is `docs/evidence/ea66b/SHA256SUMS`.
- **Preserved:** HEAD `51a899b7…`; staged 0; 165 modified; `turbo.json`, `pnpm-lock.yaml`, `Dockerfile`, `.dockerignore`, canonical Compose, Gate 5 manifest and workflow unchanged; `.env` not read/modified. No commit/push, no CI trigger, no production connection.
- **Statuses unchanged:** GHCR not a deployment source; external pull prohibited at deploy; production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; real Ubuntu deployment `NOT VERIFIED`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; WOPI paused. EA-66C not started.
- **Evidence:** `docs/ea66b-local-image-build-report.md`, `docs/evidence/ea66b/`.

## EA-66B.1 addendum (2026-10-30) — base image prerequisites and source identity

- **Status: PREBUILD BLOCKED.** No authorized archive or delivery channel was found for `node:24.18.0-bookworm-slim@sha256:cb4e8f7c…` or `docker/dockerfile:1.7@sha256:a57df69d…`; both remain absent locally. No pull, `docker load`, retag or substitute Node version was used. BuildKit cache records were not treated as images. EA-66B remains PREBUILD BLOCKED.
- **F-66B-01 fixed at the build-entry level:** `scripts/ci/source-deployment-id.mjs` derives `deployment_id = sha256("beaconhs-source-deployment-id-v1\\narchive_sha256=<sha>\\nrelease=<label>\\n")[0:40]`. HEAD is provenance only, not identity. EA-66B archive `927062b6…` with `release=local` yields `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`.
- **Build script:** `scripts/build-local-image-with-key-gate.sh` now extracts the source archive into a private directory, rejects traversal/secret/VCS entries, checks archive-vs-extracted file counts, derives the id, writes `source-manifest.json`, builds from the extracted context, passes `DEPLOYMENT_VERSION=<id>`, sets `com.beaconhs.deployment-id` / `source-archive-sha256` / `git-head` labels, verifies them, reads the embedded Next.js `deploymentId` back with `verify-image-identity.mjs`, requires `BUILD_EVIDENCE_DIR` for a real build, and keeps the key as a BuildKit secret with log/config/history scanning. `PREPARE_ONLY=1` stops before `docker build`.
- **Gate 5:** `reconcile-compose-digest.sh` accepts optional `--source-deployment-id <40-hex>`; when supplied, `--deployment-id` must start with it and the gated image must carry the matching label. The canonical manifest/Compose were not modified, so the formal deployment procedure must pass the flag.
- **Secret test:** a throwaway `FROM alpine:3.23` fixture proved the key is readable during build, absent from the next layer/runtime, and absent from build output, image config and history; the temp image/key were removed. 1/1 PASS. No formal key was created.
- **Tests:** source-deployment-id 10/10; wiring 5/5; archive guards 2/2; Gate 5 97/97; key handling 6/6; build identity 31/31; contract 17/17. Prepare-only against the real archive passed with id `406f0c00…`; a real build without `BUILD_EVIDENCE_DIR` failed closed (exit 2). The full key-gate shell test success path was not run locally because the base images are missing; its failure-path subset passed 4/4.
- **Gates:** format 0; typecheck 27/27 `Cached: 0`; lint 1/1 `Cached: 0`; deadcode 0; tests 25/25 `Cached: 0`; build 4/4 `Cached: 0`; `git diff --check` 0.
- **Path note:** the requested `docs/evidence/ea661/` is the existing EA-66A.1 evidence set; it was not touched. EA-66B.1 evidence is `docs/evidence/ea66b1/`, report `docs/ea66b1-local-image-prerequisites-report.md`. EA-66A/EA-66A.1/EA-66B evidence still verify 62/62, 31/31, 46/46.
- **Preserved:** HEAD `51a899b7…`; staged 0; 165 modified; `turbo.json`, `pnpm-lock.yaml`, `Dockerfile`, `.dockerignore`, canonical Compose and Gate 5 manifest unchanged; `.env` not read/modified. Pre-change copies of the untracked edited files are in `docs/evidence/ea66b1/raw/before/`. No commit/push.
- **Remaining risks:** no image built, so label/embedded-deploymentId checks are not image-verified; a fresh CI checkout needs the existing working-tree `turbo.json` `DEPLOYMENT_VERSION` declaration committed or the new verifier will fail closed; `scripts/build-drill-image.sh` still uses HEAD and was not changed; Gate 5's new check is opt-in.
- **Statuses unchanged:** GHCR not a deployment source; external pull prohibited at deploy; production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; real Ubuntu deployment `NOT VERIFIED`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; WOPI paused. EA-66C not started.

## EA-66B.2 addendum (2026-10-30) — historical Docker image and cache recovery audit

- **Status: PARTIAL — no image recovered.** The Node base and Dockerfile frontend images remain MISSING as Docker images. Their amd64 platform content is present in containerd, but the exact multi-arch index digests cannot be reconstructed because referenced platform/attestation blobs are missing.
- **Read-only audit:** `docker image ls --digests --no-trunc` shows 60 images and no target; no dangling images. BuildKit has 109.5 GB cache, 399 records, including 5 Node-base records (~326 MB) and one 35.76 MB frontend record. A successful `beaconhs-hse` build 7 hours ago used both targets locally and its SLSA provenance records the exact digests.
- **Containerd:** the content store has 803 blobs. The Node index `cb4e8f7c…` and frontend index `a57df69d…` are present, but only their amd64 platform manifests/config/layers are present; other platform and attestation blobs are missing. `/var/lib/containerd` is root-owned mode 700 and the containerd socket is 660 root:root; it was inspected read-only through a local `alpine:3.23` container. No storage was modified.
- **No recovery action:** no `docker pull`, `docker load`, tag, manifest rewrite, cache prune, volume/containerd cleanup, daemon change, application build or deployment. The cache records and historical build record are evidence, not images.
- **Classification:** Node base and Dockerfile frontend are `PARTIAL` as content and `MISSING` as required Docker images. EA-66B remains PREBUILD BLOCKED.
- **Verification:** format 0; `git diff --check` 0; repository gates unchanged from EA-66B.1; prior evidence remains 62/62, 31/31, 46/46, 39/39.
- **Preserved:** HEAD `51a899b7…`; staged 0; 165 modified; no protected file changed. Only `docs/ea66b2-local-image-cache-recovery-report.md` and `docs/evidence/ea66b2/` were added.
- **Statuses unchanged:** GHCR not a deployment source; external pull prohibited at deploy; production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; real Ubuntu deployment `NOT VERIFIED`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; WOPI paused. EA-66C not started.
- **Evidence:** `docs/ea66b2-local-image-cache-recovery-report.md`, `docs/evidence/ea66b2/`.

## EA-66B.3 addendum (2026-10-30) — historical build artifact audit

- **Status: COMPLETE (audit only) — no reusable image.** Historical BuildKit record `wtohv0m5ypnfrmn8xdybdw8m7` is genuine build evidence: SLSA provenance, log, materials and output metadata are still readable. Its output image `beaconhs:ea4-gate-selftest` is absent. The provenance names Git HEAD `51a899b7…`, not the EA-66B source archive, so it cannot satisfy EA-66B.1.
- **Image audit:** all BeaconHS images were inspected read-only. No image carries `com.beaconhs.deployment-id`, `com.beaconhs.source-archive-sha256` or `com.beaconhs.git-head`. 8 recent app images embed `.next/config.deploymentId = 51a899b7…`; 5 embed no deploymentId (EA-16). No image has `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` in config or a key-like string in history. An untagged 2.87 GB image `sha256:be54cfce2a45…` exists with no labels or embedded identity.
- **Classification:** all historical BeaconHS app images are `NOT REUSABLE`; build record is real evidence; SLSA provenance is real but for old identity; SBOM `MISSING`; signature `NOT SIGNED`; containerd content `PARTIAL`; BuildKit cache `PARTIAL`.
- **No mutation:** no pull, build, load, save, tag, commit, prune, volume/containerd cleanup, daemon change or deployment. Only `docs/ea66b3-historical-build-artifact-audit.md` and `docs/evidence/ea66b3/` were added.
- **Verification:** format 0; `git diff --check` 0; prior evidence remains 62/62, 31/31, 46/46, 39/39, 29/29.
- **Statuses unchanged:** GHCR not a deployment source; external pull prohibited at deploy; production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; real Ubuntu deployment `NOT VERIFIED`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; WOPI paused. EA-66C not started.
- **Evidence:** `docs/ea66b3-historical-build-artifact-audit.md`, `docs/evidence/ea66b3/`.

## EA-66B.5 addendum (2026-10-30) — image acquisition policy and prebuild preparation

- **Status: IMAGE PREREQUISITES READY; FORMAL BUILD BLOCKED ON KEY.** MinIO is VERIFIED locally with no pull. PostgreSQL, Redis, Collabora, Node 24.18.0 bookworm-slim and Dockerfile frontend 1.7 are all locally present with their exact configured digests; Node and the frontend were pulled with `--platform linux/amd64` using their exact digests. Formal application build still cannot start because `/tmp/beaconhs-server-action-key` is missing.
- **MinIO:** local image ID `b187417eee0a…` equals the canonical Compose/Gate 5 digest. The running `beaconhs-minio` container uses the same image ID. No pull, replacement, volume change or restart occurred.
- **Source identity:** EA-66B archive `927062b6…`, deployment ID `406f0c00…`, build script guards and Gate 5 `--source-deployment-id` support remain in place and tested.
- **Secret test:** isolated BuildKit secret fixture 1/1 PASS; temp key removed; no formal key generated.
- **Unauthorized pull disclosure:** EA-66B.2's `docker build --check` downloaded `docker/dockerfile:1.8.1` into the build cache. No image was created and the image count stayed at 66 until the authorized EA-66B.5 pulls; no prune was performed. EA-66B.5 did not repeat it.
- **Gates:** format 0; typecheck 27/27; lint 1/1; deadcode 0; tests 25/25; build 4/4; `git diff --check` 0.
- **Preserved:** HEAD `51a899b7…`; staged 0; 165 modified; `turbo.json`, `pnpm-lock.yaml`, `Dockerfile`, `.dockerignore`, canonical Compose and Gate 5 manifest unchanged; `.env` not read/modified. No commit/push.
- **Statuses unchanged:** GHCR not a deployment source; external pull prohibited at deploy; production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; real Ubuntu deployment `NOT VERIFIED`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; WOPI paused. EA-66C not started.
- **Evidence:** `docs/ea66b5-image-policy-and-prebuild-report.md`, `docs/evidence/ea66b5/`.

## EA-66C.0 addendum (2026-10-30) — Server Action key readiness

- **Status: KEY BLOCKED.** `/tmp/beaconhs-server-action-key` is missing. No formal key was generated, read, printed or stored. All other image, source, script and Gate 5 prerequisites are ready.
- **Key procedure:** authorized generation is `umask 077; openssl rand -base64 32 > /tmp/beaconhs-server-action-key; chmod 600 ...`; only the 32-hex fingerprint may be recorded. The existing build script enforces mode 600, rejects a key inside the repository, uses a required BuildKit secret, scans logs/config/history, and runs the key gate.
- **Image prerequisites:** Node base, Dockerfile frontend, PostgreSQL, Redis, Collabora and MinIO are all locally present with exact digests; Node reports `v24.18.0`.
- **Source identity:** EA-66B archive `927062b6…`, deployment ID `406f0c00…`; build script guards and Gate 5 `--source-deployment-id` support are tested.
- **Tests/gates:** format 0; typecheck 27/27; lint 1/1; deadcode 0; tests 25/25; build 4/4; `git diff --check` 0. Focused tests 10/10, 5/5, 2/2, 1/1, 97/97, 6/6, 31/31, 17/17.
- **Preserved:** HEAD `51a899b7…`; staged 0; 165 modified; protected files unchanged; `.env` not read/modified. No commit/push.
- **Remaining risks:** no formal key; full key-gate shell success path not run; `turbo.json` declaration not committed; drill script still uses HEAD; Gate 5 source check opt-in; unauthorized EA-66B.2 cache pull remains disclosed.
- **Statuses unchanged:** GHCR not a deployment source; external pull prohibited at deploy; production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; real Ubuntu deployment `NOT VERIFIED`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; WOPI paused. EA-66C not started.
- **Evidence:** `docs/ea66c0-build-key-readiness-report.md`, `docs/evidence/ea66c0/`.

## EA-66C.0.1 addendum (2026-10-30) — Server Action key generation and verification

- **Status: KEY READY; FORMAL BUILD NOT RUN.** The authorized formal Server Action key now exists at `/tmp/beaconhs-server-action-key`: regular file, mode 0600, owner/group `test:test`, 45 bytes, base64 of 32 bytes, one trailing newline. Fingerprint: `f61da7728f3065df58f9e89aec6985d6`. The key value, base64 content and full key file were not printed or stored in evidence.
- **Verification:** fingerprint CLI and `verify-server-action-key-gate.sh fingerprint --key-file` both returned `f61da7728f3065df58f9e89aec6985d6`; `PREPARE_ONLY=1` with the formal key succeeded and left no key in the build log.
- **Isolation tests:** `server-action-key-handling.test.mjs` 6/6, `buildkit-secret-isolation.test.mjs` 1/1, `server-action-key-deployment-contract.test.ts` 17/17.
- **Build prerequisites:** Node base, Dockerfile frontend, PostgreSQL, Redis, Collabora and MinIO are locally verified; source archive `927062b6…`; deployment ID `406f0c00…`; build script and Gate 5 source check ready.
- **Gates:** format 0; typecheck 27/27; lint 1/1; deadcode 0; tests 25/25; build 4/4; `git diff --check` 0.
- **Preserved:** HEAD `51a899b7…`; staged 0; 165 modified; `turbo.json`, `pnpm-lock.yaml`, `Dockerfile`, `.dockerignore`, canonical Compose and Gate 5 manifest unchanged; `.env` not read/modified. No commit/push.
- **Remaining risks:** no application image built, so label/embedded-deploymentId and image key fingerprint are not image-verified; full key-gate shell success path not run; `turbo.json` declaration not committed; drill script still uses HEAD; Gate 5 source check opt-in; EA-66B.2 unauthorized cache pull remains disclosed.
- **Statuses unchanged:** GHCR not a deployment source; external pull prohibited at deploy; production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; real Ubuntu deployment `NOT VERIFIED`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; WOPI paused. EA-66C not started.
- **Evidence:** `docs/ea66c01-key-generation-report.md`, `docs/evidence/ea66c01/`.

## EA-66C.1 addendum (2026-10-31) — Formal application image build

- **Status: BUILD SUCCESSFUL; NOT DEPLOYED.** A formal linux/amd64 BeaconHS application image was built from the verified source archive (927062b6…) with the authorized Server Action key (fingerprint f61da7728f3065df58f9e89aec6985d6). Image: beaconhs:ea66c1-formal, digest sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795, 2.86GB, platform linux/amd64. Labels: com.beaconhs.deployment-id=406f0c00d0e42bc1e578acf0e5af86b14bd7e175, com.beaconhs.git-head=51a899b7aac0a942da327222a3eed355fca9798a, com.beaconhs.source-archive-sha256=927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9.
- **Key isolation:** Build log key leak scan PASS; no key in image config, labels, history, or filesystem; fingerprint verified at build time; build identity gate 31/31 PASS.
- **Build script:** Used BUILD_EVIDENCE_DIR, source archive extraction, BuildKit secret injection, key fingerprint cache binding, label embedding, key gate, and source identity gate. No key ARG/ENV; no production deployment; no DB migration; no docker compose up.
- **Tests/gates:** format 0; typecheck 27/27; lint 1/1; deadcode 0; tests 25/25; build 4/4; `git diff --check` 0. Build identity gate 31/31 PASS. Deployment gate not run (policy incomplete; requires OCI index, provenance, signature).
- **Preserved:** HEAD `51a899b7…`; staged 0; 165 modified; protected files unchanged; `.env` not read/modified. No commit/push.
- **Remaining risks:** no SBOM/provenance generated; no Gate 5 deployment gate run; no production deployment; rollback path undefined; A1–A8 pending; Migration 51/DB/object-store restore not run.
- **Statuses unchanged:** GHCR not a deployment source; external pull prohibited at deploy; production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; real Ubuntu deployment `NOT VERIFIED`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; WOPI paused. EA-66C packaging pending Gate 5 and A1–A8 authorization.
- **Evidence:** `docs/ea66c1-application-image-build-report.md`, `docs/evidence/ea66c1/`.

## EA-66C.2–66D.2 addendum (2026-10-31) — supply chain, offline package, target import and preflight

- **Status: PREFLIGHT READY WITH CONDITIONS.** The five runtime images are built, signed, packaged, imported on the ceshi target and audited against the canonical Compose. Production remains undeployed.
- **EA-66C.4 (Cosign audit): PASS.** Cosign keys live outside the repository at mode 0600 and are untracked; all three signatures verify; no key material is in Git history; provenance is post-build reconstructed (MEDIUM trust).
- **EA-66D.0 (offline package): PASS.** Five runtime tars exported with exact digests (app `1834f867…`, postgres `721873c3…`, redis `858f009f…`, minio `b187417e…`, collabora `4e983196…`); SHA256SUMS created and verified; no sensitive file included.
- **EA-66D.1 (target import): PASS.** Target `ceshi-Virtual-Machine` (10.10.31.30, Ubuntu 24.04, x86_64, Docker 29.9.2, Compose v5.6.1). 26 containers, 10 volumes and 49.03 GB build cache removed; five images imported offline; every Image ID matches source; all linux/amd64; no pull, no Compose run, no production connection.
- **EA-66D.2.0 (preflight audit): READY WITH CONDITIONS.** All eight canonical services identified and mapped to the five images; every service digest-pinned; healthcheck commands verified present in the images; all ports loopback-only; no privileged/host-network/socket exposure; Gate 5 manifest consistent with the Compose file.
- **EA-66D.2.1 (startup preparation): READY WITH CONDITIONS.** Three external volumes created on the target (`beaconhs-hse_postgres-data`, `beaconhs-hse_redis-data`, `beaconhs-hse_minio-data`), all empty and container-free. `scripts/cluster/provision.sql` audited: idempotent, superuser-only, needs four `-v` password variables — the earlier command in the EA-66D.2.0 report omitted them and is corrected in that report.
- **EA-66D.2.2 (runtime key + runtime env): READY FOR POSTGRESQL START AUTHORIZATION.** The runtime Server Action key was transferred over the SSH channel to `~/.beaconhs/next_server_actions_key` (0600) and its canonical fingerprint is now `f61da7728f3065df58f9e89aec6985d6`, identical to the build-time key; the mismatching previous key is retained as `~/.beaconhs/next_server_actions_key.previous` (0600). All 21 required environment variables are present (25 in `local-prod.env` plus the key in a separate 0600 file), 0 missing. Four database role passwords are distinct, map consistently to the URLs, and are injected by `~/.beaconhs/scripts/provision-db.sh` (PGPASSWORD plus a 0600 psql `\set`/`\i` wrapper) so no secret reaches argv or shell history.
- **Canonical Compose deployed to the target.** All three pre-existing target checkouts held the pre-EA-65.1 Compose (`0337d38e…`, `02d93723…`) with no `com.beaconhs.deployment` labels and floating `postgres:16-alpine`/`redis:7-alpine` tags. The canonical files were copied byte-identically (SHA-256 verified) into a new independent directory `~/beaconhs-canonical/` (0700). No existing checkout was modified.
- **Compose `.env` lookup (measured).** Compose reads `.env` from the directory of the first `-f` file, not the project root; a root-only `.env` is NOT read. The runtime env is therefore supplied through explicit `--env-file` flags pointing at `~/.beaconhs/runtime/` (0700), keeping sensitive files out of the 0775 `deploy/` directory.
- **Offline digests survive import.** RepoDigests are retained after `docker load` for all five images, so the earlier concern that Gate 5 would lose the pinned references is unfounded.
- **Fingerprint algorithm correction.** EA-66D.2.1 reported the old runtime fingerprint as `aac818abd1505f96`, computed with a plain SHA-256 of the key text. The canonical algorithm is `HMAC-SHA256(keyBytes, "beaconhs:server-action-key:fingerprint:v1")` truncated to 128 bits (`apps/web/src/lib/server-action-key.ts`); the correct value for that old key is `06b5f60d7906ee9414a27cae54173db4`. The mismatch conclusion is unchanged; the compared value is corrected in the EA-66D.2.1 report.
- **Open items before PostgreSQL may start:** (1) verify the `PGPASSWORD` + `\set`/`\i` injection path against a live PostgreSQL; (2) decide how migrations run — the canonical Compose has no `migrate` role although `docker/entrypoint.sh` supports `APP_ROLE=migrate`; (3) decide how the first platform administrator is created (`bootstrap-admin` is also outside Compose); (4) production must replace the test `APP_URL`, `R2_ENDPOINT` and `COLLABORA_URL` values.
- **Statuses unchanged:** production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; Gate 5 not run; no commit, push or CI.
- **Evidence:** `docs/ea66c4-cosign-security-audit-report.md`, `docs/ea66d0-offline-package-report.md`, `docs/ea66d1-offline-import-validation-report.md`, `docs/ea66d2-preflight-audit-report.md`, `docs/ea66d2-1-startup-preparation-report.md`, `docs/ea66d2-2-runtime-configuration-readiness-report.md`, `docs/evidence/ea66d0/`.

## EA-66D.2.3 addendum (2026-10-31) — migration and bootstrap-admin scheme audit

- **Status: READY WITH CONDITIONS.** The four initialization steps — Provision, Migration, Bootstrap Admin, Storage initialization — are each audited for mechanism, idempotency, failure behaviour and preconditions. All four run from images that already exist; no new build is required.
- **No service runs migrations automatically.** `migrate()` is called only at `packages/db/src/migrate.ts:538`. web starts `apps/web/scripts/start-standalone.mjs` (Sentry + storage-freeze gate only), worker starts BullMQ workers, scheduler registers Redis repeatable jobs, storage-init bootstraps the bucket. The Canonical Compose has no `migrate` service even though `docker/entrypoint.sh:24-26` supports `APP_ROLE=migrate`.
- **`apps/ops-migrate` is usable as-is.** `/app/apps/ops-migrate/dist/migrate.js` (562,433 B) and the packaged drizzle directory with a 51-entry journal are present in `beaconhs:ea66c1-formal` (Dockerfile:110). The bundle does not reimplement the migration; it wraps `packages/db/src/migrate.ts`.
- **Migration safety verified from source.** drizzle applies every migration plus its ledger row inside one `session.transaction` (`drizzle-orm/pg-core/dialect.js:60-71`), so a failure leaves no partial state. Re-runs are skipped by the `created_at` comparison; `packages/db/src/migration-state.ts` additionally validates each file's SHA-256 against the ledger and refuses to guess when a tracker is missing. `pg_advisory_lock('beaconhs:schema-migration')` blocks concurrent runs.
- **Migration requires provision first.** `assertDatabaseRoles()` demands five distinct roles with exact attributes, and `assertSchemaOwnership()` demands every `public` object be owned by `beaconhs_owner` — only `provision.sql` establishes that. All nine preflight attributes map one-to-one onto provision.sql statements, including `default_transaction_read_only=on` for the backup role.
- **Migration 0051 is low risk.** Three `DROP COLUMN` statements on columns EA-12 already classified as dead; no data transformation, no index rebuild, no cascade. Covered by `packages/db/src/ea12-dead-columns.test.ts`.
- **Bootstrap admin is native and idempotent.** `packages/auth/src/bootstrap-admin.ts` writes exactly two rows (`user` with `isSuperAdmin`, `account` with a scrypt credential hash) using Better Auth's own hasher. `disableSignUp` stays true, no permission key, role, scope, table or migration is touched, and the runtime `DATABASE_URL` suffices because `user`/`account` carry no RLS. Idempotency is by refusal: an existing super-admin, or a taken address, writes nothing.
- **No default administrator or password.** `packages/db/src/seed.ts` uses `admin@beaconhs.local` but it is the demo seed and creates a demo tenant — a different path that must not run here. The recommended test identity is `platform-admin@beaconhs-test.local` with a `--password-stdin` secret; the `.test` TLD is reserved by RFC 2606 and cannot collide with production.
- **No audit-log row, by schema necessity.** `audit_log.tenant_id` is `notNull()` and references `tenants.id`, while bootstrap deliberately leaves the database with zero tenants, so no tenant-scoped audit row can exist yet. Command exit codes and CLI output carry the trail instead; production should rely on orchestration logs.
- **Two defects found and fixed.** (1) `provision-db.sh` ended in `exec psql`, and a replaced shell never runs its EXIT trap, so the 0700 temporary directory holding the four role passwords in plaintext survived every run — proven with an isolated `bash` probe, then fixed by invoking psql as a child so the trap stays armed; verified on the target for both the success and failure paths (exit code propagated, zero residue). (2) `DATABASE_OWNER_ROLE` and `DATABASE_BACKUP_ROLE` were absent from the runtime env; both now appear explicitly. The runtime env now carries 27 variables.
- **Isolated fixture proves the injection.** The `\set` + `\i` mechanism was exercised against a throwaway local PostgreSQL with placeholder values only: the positive case passed with all four variables intact and nothing printed, and the negative case (two variables missing) failed with a non-zero exit rather than silently substituting an empty value — so a missing password makes `provision.sql` fail rather than create an empty-password role.
- **Ordering change.** Redis must start before the bootstrap admin, because `sendAuthEmail` runs in `NODE_ENV=production` and enqueues through BullMQ (`packages/jobs/src/queues/email.ts:73`). The administrator row is still created (dispatch sits outside the transaction) and the CLI exits 1 with a `--resend-magic-link` hint.
- **Recommended scheme: C — a standalone ops-migrate deployment.** `docker/entrypoint.sh:17-23` states the migration driver must never enter the worker runtime and only that target receives `MIGRATION_DATABASE_URL`; scheme B would hand the migration credential to web/worker/scheduler and violate that. Scheme C needs no image rebuild, changes neither the Canonical Compose nor any business code, keeps the one-shot container out of Gate 5's `--filter label=com.docker.compose.project` count through a separate project name, and lets `--env-from-file` keep the credential out of argv. Scheme A (reusing an existing service via `run`) is the fallback but injects a password-bearing URL on the command line.
- **Gap: `bootstrap-email-provider` has no in-image entry point.** It exists only as a `tsx` script in `packages/auth/package.json:16`, with no ops deploy target, so no bundle exists in the image. The magic-link can still be enqueued without it, so this blocks the SMTP delivery step rather than the administrator creation.
- **Boundary note.** One `docker compose run … --dry-run` was issued to check the `APP_ROLE=migrate` routing. That flag does not prevent container creation in Compose v5: a one-shot container ran and failed fast on the missing `MIGRATION_DATABASE_URL`, and a Compose network was created. The container was removed by `--rm`; the network was removed explicitly by this phase. The host was verified back to 0 containers / 3 default networks / 3 volumes. Nothing else was started and no database write occurred.
- **Verification:** `packages/db` 5 files 83 passed 19 skipped; `packages/auth` 3 files 51 passed 13 skipped; `bash -n` on the script locally and on the target; isolated `\set`/`\i` fixture positive and negative; trap cleanup on the success and failure paths on the target; Compose static render clean; target state 0 containers, 3 networks, 3 volumes, 25 images, 69 GB free, all sensitive files 0600 under 0700 directories.
- **Open before startup:** decide and implement the standalone migration and bootstrap-admin carriers (scheme C); confirm the email-provider path; keep Redis ahead of the bootstrap admin; approve the provisioning run; supply the test platform-admin password file; replace the test endpoints before production.
- **Statuses unchanged:** production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; Gate 5 not run; no commit, push or CI.
- **Evidence:** `docs/ea66d2-3-migration-bootstrap-audit-report.md`.

## EA-66D.2.4 addendum (2026-10-31) — PostgreSQL start and database provisioning

- **Status: PASS.** PostgreSQL runs healthy on the ceshi target and the five database roles are provisioned and verified. The database is in a pure post-provision state: no migration, no seed, no administrator, no business table.
- **Preflight:** host `ceshi-Virtual-Machine` / 10.10.31.30 confirmed; the Canonical Compose on the target hashes to `9700f480…`, byte-identical to the repository; the three external volumes exist and `beaconhs-hse_postgres-data` was verified empty (0 entries) before any write; the PostgreSQL image ID equals the pinned digest on linux/amd64; all runtime env files are 0600 owned by `ceshi`; the Server Action key fingerprint is `f61da7728f3065df58f9e89aec6985d6`. The task named `~/beaconhs-canonical/local-production.compose.yaml`; the real path is `~/beaconhs-canonical/deploy/local-production.compose.yaml` and that is what was used.
- **Start:** `up -d --pull never --no-build postgres` with project `beaconhs-local-prod` and both env files. Container `1eae9bab6c53…`, Image `sha256:721873c3…`, RestartCount 0, published on `127.0.0.1:5433` only, external volume mounted at `/var/lib/postgresql/data` and `provision.sql` bind-mounted read-only at `/opt/beaconhs/provision.sql`. All three deployment labels match the rendered Compose.
- **Healthcheck semantics stated honestly.** The probe logs `FATAL: role "beaconhs_app" does not exist` before provisioning because `pg_isready` only tests liveness — verified in-container that it exits 0 for a missing role and a missing database alike. `healthy` therefore means "the server accepts connections", and the authoritative authentication check is the post-provision role test, which passed.
- **Provision script defect found and fixed.** The audited script invoked a host `psql`, but the host has no `postgresql-client`; the first run exited 127, so the EA-66D.2.3 scheme was not executable on the target. The script was rewritten to run psql inside the already-pinned PostgreSQL container over its local socket, which `pg_hba.conf` grants as `trust` — so no superuser secret is transmitted at all — with the four role passwords streamed through stdin into a `\set`/`\i` wrapper. The plaintext now exists only in process memory, never on the host disk, never in the container writable layer, never in argv and never in a log, and the script no longer creates a temporary file at all. Deployed by `scp` to a `.new` path, `bash -n` checked on the target, then replaced by an atomic `mv`.
- **Mechanism verified before the real run.** The exact wrapper-generation loop was exercised against a harmless probe that compared lengths and non-emptiness only: all four variables arrived intact at length 32, and no value was printed. The probe was removed afterwards.
- **Provision exit code 0.** Five roles, the `beaconhs` database, `pgcrypto` and `pg_trgm`, the `etl` schema, the grants, the default privileges and the connection-hygiene parameters were all applied; the output contained no password.
- **Role verification.** `beaconhs_owner` NOLOGIN/NOINHERIT-independent; `beaconhs_migrator`, `beaconhs_app` LOGIN and non-BYPASSRLS; `beaconhs_super` and `beaconhs_backup` BYPASSRLS; exactly five non-system roles. The only business membership is `beaconhs_owner → beaconhs_migrator`, so no runtime role is an owner member. `beaconhs_backup` carries `default_transaction_read_only=on`. Every `migrate.ts` preflight attribute is satisfied.
- **Authentication proven, not assumed.** Each of the four LOGIN roles authenticated over TCP (the scram-sha-256 path) with its provisioned password, delivered through a 0600 pgpass file written by stdin so no secret reached argv. `beaconhs_backup` reported `transaction_read_only = on` on a live connection; the other three reported `off`. The superuser password differs from the app-role password.
- **No unexpected data.** `beaconhs` holds 0 user tables; `drizzle.__drizzle_migrations` does not exist, so no migration ran; no `tenants` table, so neither seed nor bootstrap ran; the `postgres` database holds 0 user objects. The volume carries only a fresh 46.2 MB PGDATA; the Redis and MinIO volumes remain at 0 entries.
- **Production isolation.** Published on loopback only; every socket in `/proc/net/tcp` is loopback to 5432; container DNS resolves only its own Compose-network address; the runtime env endpoints are all local, in-network or `*.beaconhs-test.local`, with no production hostname.
- **Verification:** Compose static render clean; role attribute, membership, config, database, schema, extension and ownership queries all as tabulated; role authentication over TCP 4/4; mechanism probe; `bash -n` on the script locally and on the target.
- **Target end state:** 1 running container (`beaconhs-local-prod-postgres-1`, healthy, RestartCount 0); web, worker, scheduler, storage-init, redis, minio and collabora not started; 3 networks; 3 volumes; 25 images unchanged; 69 GB free; every sensitive file 0600 under 0700 directories. No `down -v`, no volume deleted, no image pulled, no Migration executed, no administrator created, no Gate 5 run, no commit/push/CI.
- **Statuses unchanged:** production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; Migration 51/DB/object-store restore `NOT RUN`; Gate 5 not run.
- **Evidence:** `docs/ea66d2-4-postgres-provision-report.md`.

## EA-66D.2.5 addendum (2026-10-31) — Redis start and independent Migration 51

- **Status: PASS.** Redis runs healthy and the full migration journal was applied by the standalone `APP_ROLE=migrate` task, exit code 0.
- **Preflight:** host, container state, the three image IDs (PostgreSQL `721873c3…`, Redis `858f009f…`, BeaconHS `1834f867…`), the three volumes with `beaconhs-hse_redis-data` verified empty, the Canonical Compose hash `9700f480…`, all three runtime env files at 0600/ceshi, the key fingerprint `f61da7728f3065df58f9e89aec6985d6`, and the production-endpoint scan all passed. The database was confirmed pre-migration: 0 user tables, schemas `etl,public` only, 5 non-system roles, no `drizzle` schema, no `user` table.
- **Redis:** started with `--pull never --no-build redis`. Container `e347ed572c2a…`, Image `sha256:858f009f…`, RestartCount 0, healthy on the first poll, published on `127.0.0.1:6380` only, external volume `beaconhs-hse_redis-data` at `/data`, network `beaconhs-local-prod_default` (172.18.0.3), all three deployment labels correct. `redis-cli ping` returns PONG, `requirepass` is empty (matching the service's absent environment and `REDIS_URL=redis://redis:6379`), `/data` is fresh, and the in-network name `redis` resolves and answers PONG — the exact connection the application uses.
- **Migration path audited before execution.** The image entrypoint routes `migrate)` to `exec node apps/ops-migrate/dist/migrate.js`; that bundle is 562,433 bytes; the packaged drizzle directory carries a 51-entry `postgresql` journal ending at `0051_ea12_drop_dead_columns`. No rebuild and no web/worker/scheduler start is involved.
- **`APP_ROLE=migrate` proven.** A probe run that printed only variable names confirmed `APP_ROLE=migrate` (overriding the carrier service's `storage-init`), `NODE_ENV=production`, the two role-name variables, all three database URLs, and that the Server Action key was deliberately not injected.
- **Secrets kept off every command line.** The three URLs were copied verbatim from the canonical runtime env into a dedicated 0600 `migration.env` holding exactly seven variables, and were injected with `--env-from-file` rather than `-e VAR=value`; byte-equality was confirmed by SHA256 prefix. The target database was verified to be `beaconhs`, not the `postgres` maintenance database.
- **Preflight proven as the migration login.** Over TCP with the password delivered through a 0600 pgpass file written by stdin, `beaconhs_migrator` could `SET ROLE beaconhs_owner`; it was neither superuser nor BYPASSRLS; the owner was NOLOGIN/NOSUPERUSER/NOBYPASSRLS; the runtime, maintenance and backup role checks each returned 1; there were 0 stray objects and 0 advisory-lock holders, so no concurrent migration existed.
- **Migration exit code 0.** The role preflight passed, the ledger reported `51 applied, 0 pending, 0 historical`, RLS was applied atomically across 191 tables, least-privilege grants were applied, the kiosk-PIN invariant verified, built-in role permissions were backfilled, 32 statistics targets and 15 reporting views were applied. The output contained no password, key or full connection string.
- **Ledger verified against the files.** Recomputing `sha256(file text)` inside the image — the exact algorithm of `packages/db/src/migration-state.ts:46` — produced 51 `created_at|hash` pairs that diffed clean against the 51 `drizzle.__drizzle_migrations` rows: 51/51 byte-identical, with 51 distinct hashes and 51 distinct timestamps. The same diff after a repeat run was again clean.
- **Migration 0051 complete.** `equipment_inspection_records.certificate`, `training_enrollments.due_on` and `training_enrollments.expires_on` are gone, while both parent tables survive.
- **Schema and permissions as designed.** `public` holds 197 tables and 14 views, `drizzle` holds only the ledger, `etl` is empty. 191 tables have RLS and 192 have FORCE RLS; the six without RLS are exactly the expected global tables (`user`, `account`, `session`, `verification`, `platform_settings`, `tenants`). The five role attributes are unchanged from the post-provision state. The `etl` schema stays invisible to `beaconhs_app`; table grants are 844 for app and super, 211 (SELECT only) for backup, and the three runtime roles hold SELECT-only on the ledger.
- **Transactions and lock clean.** The advisory lock shows 0 holders, there is no `idle in transaction` session and no deadlock. Every migration statement and its ledger row share one drizzle transaction, so a failure would roll back whole.
- **Idempotency proven by a sequential re-run.** The second run exited 0, revalidated the ledger as `51 applied, 0 pending`, skipped all 51 migrations, and left the ledger and its hashes unchanged — so the hash validation is effective against a populated ledger and the migration is safe to repeat. No concurrent second task was ever started.
- **Honest limitation.** The migration did not fail, so no failure-rollback was observed live; the all-or-nothing guarantee comes from the verified drizzle implementation, not from an observed failure.
- **No administrator and no tenant.** `admins=0`, `total_users=0`, `tenants=0`.
- **Target end state:** running `beaconhs-local-prod-postgres-1` (healthy, 127.0.0.1:5433) and `beaconhs-local-prod-redis-1` (healthy, 127.0.0.1:6380); 0 one-shot container residue; web, worker, scheduler, storage-init, minio and collabora all at 0 containers; 4 networks; 3 volumes (minio still empty); 25 images unchanged; 69 GB free. No compose file or manifest edited, no business code changed, no image rebuilt or pulled, no restore, no volume deleted, no `down -v`, no production contact, no commit/push/CI.
- **Statuses unchanged:** production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; DB/object-store restore `NOT RUN`; Gate 5 not run.
- **Evidence:** `docs/ea66d2-5-migration-execution-report.md`.

## EA-66D.2.6 addendum (2026-10-31) — MinIO start and object-storage initialization

- **Status: PASS.** MinIO runs healthy, `storage-init` completed with exit code 0, the bucket is private with the two managed lifecycle rules, and a sequential re-run left the state byte-identical.
- **Two-environment comparison first, as the highest priority.** `deploy/local-production.compose.yaml` (`9700f480…`), `deploy/gate5.manifest.yaml` (`6bc70fa0…`), `deploy/collabora-branding.js` (`730d1827…`) and `scripts/cluster/provision.sql` (`e6de5f65…`) are byte-identical between the repository and `~/beaconhs-canonical/`. Inside the image, `/entrypoint.sh` matches `docker/entrypoint.sh` (`1ee60ca6…`) and `/app/apps/worker/dist/storage-init.js` matches the repository build output `3d205248…`, which proves the image carries the current working-tree source including the uncommitted user edits.
- **No code change was needed and none was made.** The object's configuration and the initialization logic were audited from the repository rather than assumed, and the image proved already in sync, so no meaningless modification was manufactured. The only writes are this report, four sanitized evidence logs and the state ledger.
- **Protected user edits untouched.** `packages/storage/src/index.ts` (+1007/−143), `packages/storage/src/lifecycle.ts` (+236), `apps/worker/src/storage-init.ts` (+9/−2) and `docker/entrypoint.sh` (+21) remain uncommitted and unmodified; nothing was staged, committed, restored or reset, and `git add -A` was never used.
- **MinIO image identity confirmed.** Image ID `sha256:b187417eee0a…` equals the EA-66D.1 value; `minio/minio@sha256:b187417e…` is the canonical reference; linux/amd64; server reports `DEVELOPMENT.GOGET` / go1.24.13. Nothing was pulled, upgraded or replaced.
- **MinIO start.** `up -d --pull never --no-build --no-deps minio`. Container `82ef421c3241…`, RestartCount 0, healthy on the first poll, external volume `beaconhs-hse_minio-data` at `/data`, published on `127.0.0.1:9000` with the console 9001 deliberately not published, all three deployment labels correct. The upstream image runs the process as root and the canonical Compose sets no `user:`; that is upstream behaviour and the compose file was not edited.
- **Storage configuration taken from the code.** `packages/storage/src/index.ts:173-180` builds the S3 client with `region: 'auto'` and `forcePathStyle: true`, which MinIO requires; the internal endpoint is the in-network service name `http://minio:9000` rather than a host address, the browser-facing endpoint is `https://minio.beaconhs-test.local`, the bucket is `beaconhs-local-prod`, and the credentials come from `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, which equal `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`. `isCloudflareR2Endpoint` (`index.ts:204-217`) does not match the public endpoint, so the MinIO branch runs and deletes the bucket policy. `R2_PUBLIC_URL` is absent, which is required.
- **Authentication proved with the application's own client configuration.** An independent script using the same region/path-style/credentials built `ListBuckets` successfully (0 buckets before initialization, 1 after) and `HeadBucket` on `beaconhs-local-prod` succeeded, while an anonymous request returned HTTP 403. Credentials were injected from a 0600 file, never through argv, a log, a report or a temporary plaintext file.
- **Network isolation.** The host listens only on `127.0.0.1:5433`, `127.0.0.1:6380` and `127.0.0.1:9000`; inside the container MinIO binds `127.0.0.1:9000` on IPv4 plus `[::]:9000` and the container-local console; from the same Compose network `minio` resolves to 172.18.0.4 and `/minio/health/live` returns HTTP 200. No external connections.
- **storage-init scope audited before running.** The service receives only `APP_ROLE`, `NODE_ENV` and the six `R2_*` variables — no `DATABASE_URL`, no `REDIS_URL`, no Server Action key — so it structurally cannot reach PostgreSQL, Redis or the key. `bootstrapStorageFreezeGate` (`packages/db/src/storage-freeze-operations.ts:443`) only registers in-memory callbacks and never queries the database. `ensureBucket` creates the bucket when absent, `ensurePrivateBucketReady` deletes the bucket policy, merges the two managed lifecycle rules while preserving existing ones, and writes then deletes a single one-byte probe whose anonymous read it proves is denied. It creates no user, no tenant, deletes no pre-existing object and performs nothing irreversible.
- **storage-init exit code 0**, output `[storage-init] private bucket policy, lifecycle, and anonymous-read probe passed`, one-shot container residue 0.
- **Bucket and policy.** Exactly one bucket, `beaconhs-local-prod`, matching `R2_BUCKET`; no bucket was created beyond what the code defines; `GetBucketPolicy` reports `NoSuchBucketPolicy`, so anonymous access is not granted; location is empty, matching `region: 'auto'`; two lifecycle rules are enabled (`expire-unfinalized-uploads` on the `pending` tag and `expire-transient-artifacts` on the `transient` tag, one day each); object count 0 and privacy-probe residue 0; the bucket directory holds only MinIO's own metadata.
- **Idempotency proven by a sequential re-run.** The second invocation also exited 0 and the full state snapshot diffed clean against the first: bucket count and name, policy, lifecycle rule identifiers, tags and expiry, location, object count and probe residue were all identical. The volume grew from 192.0K/20 files to 216.0K/24 files; every added file is under MinIO's own `.minio.sys/tmp/.trash/` bookkeeping for the deleted probes, invisible through the S3 API and reclaimed by MinIO's GC — not a leftover object.
- **Application connection.** The internal path the application uses for put/get/head/delete is reachable and authenticating, and storage-init's probe already exercised that write-and-delete path end to end. The browser-facing presigned path could not be exercised because `minio.beaconhs-test.local` does not resolve in an isolated environment with no public hostname or tunnel; that limitation is recorded rather than claimed as verified.
- **Volume state.** `beaconhs-hse_minio-data` holds 216.0K of MinIO metadata with no objects; the PostgreSQL and Redis volumes are unchanged from the earlier phases. No volume was deleted or rebuilt and no `down -v` was run.
- **Evidence synced back.** Four sanitized execution logs (storage-init run 1, storage-init idempotency re-run, migration run 1, migration idempotency re-run) were copied into `docs/evidence/ea66d2-6/logs/` with a `password|secret|postgresql://|redis://|r2_secret|access_key` scan returning zero hits. No sensitive file was copied and no directory of the host was overlaid onto the repository.
- **Gates:** format 0; typecheck 27/27; lint 1/1; deadcode 0; tests 2118 passed 9 skipped; build 4/4.
- **Target end state:** running `beaconhs-local-prod-postgres-1` (healthy, 127.0.0.1:5433), `beaconhs-local-prod-redis-1` (healthy, 127.0.0.1:6380) and `beaconhs-local-prod-minio-1` (healthy, 127.0.0.1:9000); web, worker, scheduler, storage-init and collabora all at 0 containers; one-shot residue 0; 4 networks; 3 volumes; 25 images unchanged; 69 GB free; every sensitive file 0600 under 0700 directories.
- **Next:** bring up scheduler, web, worker and collabora and then run Gate 5, after settling the outstanding bootstrap-admin carrier and the email-provider path from EA-66D.2.3.
- **Statuses unchanged:** production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; WOPI `PAUSED`; DB/object-store restore `NOT RUN`; Gate 5 not run. No commit, push or CI.
- **Evidence:** `docs/ea66d2-6-minio-storage-init-report.md`, `docs/evidence/ea66d2-6/logs/`.

## EA-66D.2.7 addendum (2026-10-31) — application startup, end-to-end verification and Gate 5

- **Status: PASS (Gate 5 exit code 0), with two BLOCKED areas that are task boundaries rather than defects.** The eight canonical services run, the platform super-admin authenticates over the public tunnel, and the Gate 5 deployment gate passes on its own unmodified contract.
- **Pre-start audit.** PostgreSQL, Redis and MinIO healthy with the EA-66D.1 image IDs; the three external volumes mounted; the MinIO bucket, absent policy, two lifecycle rules and zero objects identical to the EA-66D.2.6 baseline; no unexpected container and no one-shot residue. `AUTH_URL` and `NEXTAUTH_URL` do not apply — BeaconHS uses Better Auth, not NextAuth. Every SMTP_* variable is absent, which is what blocks email delivery rather than a missing mandatory setting.
- **Web port and tunnel verified against each other.** The Compose publishes `127.0.0.1:3000:3000` and cloudflared — a host process in token mode, not a container — logs the live ingress `{"hostname":"beaconhs-test.xuhaoqing.top","service":"http://127.0.0.1:3000"},{"service":"http_status:404"}`. The fallback is `http_status:404`, so PostgreSQL, Redis, MinIO and Collabora are not publicly exposed.
- **Two defects found and fixed, both mine.** (1) `APP_URL`/`PUBLIC_APP_URL` were `http://127.0.0.1:3000`, and Better Auth trusts only `BETTER_AUTH_URL` plus `BETTER_AUTH_TRUSTED_ORIGINS`, so the public origin was not in the CSRF trust list and public login would have been refused; both variables were changed to the public origin exactly as the Canonical Compose's own comment prescribes, without touching `127.0.0.1:3000` into the trusted origins so the CSRF boundary stays narrow. (2) The deployment id `…-ea66d2-001` chosen in EA-66D.2.2 broke Gate 5's `^[0-9a-f]{40}-[0-9]{1,20}-[0-9]{1,10}$` contract because the run id contained letters; Gate 5 correctly answered `USAGE ERROR` with exit code 3, and the id became `…-20261031-001` with the eight services recreated so their labels match, external volumes untouched and all data intact.
- **Bootstrap admin executed through the native path.** The image's `bootstrap-admin.cli.js` is byte-identical to the repository build output (`61e676161e496e82…`). A dedicated 0600 env file carried only `APP_ROLE`, `NODE_ENV`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, `REDIS_URL` and the three URL variables — no migration credential, no superadmin credential, no Server Action key. Dry run reported zero super-admins; the write run exited 0 and created exactly one `user` row (`isSuperAdmin=true`, `emailVerified=false`) plus one `account` row with a 161-character scrypt hash, while `tenants`, `roles`, `role_assignments` and `org_units` all stayed at zero. A repeat run answered `already bootstrapped — nothing written`, proving the refuse-by-design idempotency. The password travelled through `--password-stdin` from a 0600 file and never reached argv, a log or the report.
- **EMAIL_DELIVERY = BLOCKED, proven rather than assumed.** `platform_settings` holds zero rows, the production send path resolves only through that database-managed provider, and `bootstrap-email-provider` still has no in-image bundle. The magic link was enqueued — one job on `bull:emails:wait`, its URL carrying the public origin — and the worker then logged `Email delivery is not configured: configure an enabled platform or tenant provider.` No Mailpit image was added, no mail service was pulled, no Compose file was changed and no existing SMTP credential was touched. Password authentication is unaffected because `requireEmailVerification` is false.
- **Application startup.** `up -d --pull never --no-build`; six services Up and healthy, `scheduler` and `storage-init` Exited (0), RestartCount 0 everywhere, one-shot `run` residue 0, twenty-five images unchanged, volumes preserved. Two runtime proofs are worth recording: the web process printed `[server-action-key] configuration fingerprint: f61da7728f3065df58f9e89aec6985d6`, confirming in a live process that the EA-66D.2.2 runtime-key fix took effect, and `[schema] match: {"state":"match","applied":51}`, confirming no schema drift and no automatic migration — the ledger still holds 51 rows with an unchanged maximum timestamp. The worker ran all six scheduled tick families; the scheduler verified 13/13 repeat schedules; the storage initializer re-ran idempotently; Collabora reported readiness on port 9980. Sensitive scanning of all seven container logs returned zero hits.
- **Public access verified.** DNS resolves to Cloudflare, the certificate is a valid Google Trust Services leaf for `CN = xuhaoqing.top`, the homepage and `/login` return HTTP 200, three `/_next/static` chunks return 200, the login POST establishes `__Secure-better-auth.session_token` and `__Secure-better-auth.session_data`, and the CSP the app itself emits already allow-lists `https://minio.beaconhs-test.local` and `https://collabora.beaconhs-test.local`. A first attempt returned HTTP 530 / error 1033 because cloudflared lost all four edge connections at 11:40:38 and had not yet reconnected; it recovered by itself at 11:43:47-48 without any configuration change, restart or host-side fault (no OOM, 5.2 GiB free).
- **Authentication tests pass.** Sign-in with the password succeeds; the session survives a full reload; sign-out leaves zero rows in the server-side `session` table; `/dashboard`, `/incidents`, `/platform/tenants` and `/admin/users` all redirect an unauthenticated visitor to `/login`; an invalid password yields "Invalid email or password" and creates no session. The single browser console error is the expected 401 from that deliberate invalid-password attempt.
- **Zero-tenant boundary is a documented design property, not a defect.** `apps/web/src/lib/auth.ts:190-193` states the app shell requires a tenant-bound RequestContext even for platform administration, and `docs/PRODUCTION_RUNBOOK.md:98-107` states plainly that "a platform with no tenant cannot be used through its own UI" and that `/platform/tenants/new` is itself gated, so the first workspace is created by `provision:first-tenant` rather than by a form — "this is not a workaround". The super-admin therefore lands on `/auth/continue` with "Access is not active", exactly as designed. Because the task forbids creating a tenant, the UI-level permission, role-scope, RLS and file-lifecycle tests are BLOCKED by that boundary. The database-level equivalents all pass: 191 tenant tables with RLS and 192 with FORCE RLS, the runtime role non-superuser/non-BYPASSRLS/non-owner-member, the backup role read-only, the only business membership being owner→migrator, and the super-admin path using the native `withSuperAdmin` pool. No permission, role, scope or RLS policy was relaxed to make anything pass.
- **Presigned URL mechanism passes; public reachability fails, and the cause is isolated.** The URL the application mints uses the same SDK and the same client configuration: `https` , default port 443, path-style `/<bucket>/<key>` with the bucket segment matching `R2_BUCKET`, nine SigV4 parameters, `X-Amz-SignedHeaders: host`, 600-second expiry and the signed Host equal to the URL host. Publicly it fails with a DNS resolution error; over the internal path the same credential, bucket and key sign and fetch successfully with HTTP 200 and one byte, and a PUT of the same shape succeeds. The sole difference is the hostname of `R2_ENDPOINT`. Two minimal remedies were proposed and neither was implemented: a dedicated public object-storage hostname routed to `127.0.0.1:9000`, or the canonical compose's documented `^/beaconhs(/.*)?$` path route — which additionally requires the bucket to be named `beaconhs`, since path-style URLs put the bucket in the first path segment and `beaconhs-local-prod` does not match that pattern. Both need a Cloudflare dashboard change; the tunnel, the canonical compose, the MinIO exposure and the bucket name were left alone, and the presigned URL is not described as passing.
- **Collabora read-only audit.** Healthy, image `4e983196eb98…`, running as uid 1001 rather than root, branding mounted read-only, published only on `127.0.0.1:9980`, and the in-network WOPI discovery document returns HTTP 200. `COLLABORA_WOPI_URL` correctly points at `http://web:3000`. WOPI stays `PAUSED`; no full business test was attempted and none is claimed.
- **Gate 5: PASS, exit code 0.** The unmodified `scripts/ci/reconcile-compose-digest.sh` — synced from the repository to the target with SHA-256 verification and an atomic rename, because none of the three legacy target checkouts contained it — verified all eight services against `deploy/gate5.manifest.yaml`: gated image `beaconhs@sha256:1834f867…`, four pinned digests, the deployment id on every container, `image_source_deployment_id` `406f0c00…` from the image's own label, RepoDigests retained after the offline import, RestartCount 0, the two one-shots exited 0, the three external volumes, the loopback-only port bindings and no unauthorized container. The manifest, the script, the labels and the digests were not edited to obtain the pass.
- **Environment synchronization.** Canonical Compose `9700f480…`, Gate 5 Manifest `6bc70fa0…`, the image's `/entrypoint.sh` `1ee60ca6…`, the bundled `storage-init.js` `3d205248…` and the bundled `bootstrap-admin.cli.js` `61e676161e496e82…` all match the repository byte for byte. The only dev→target code sync was the Gate 5 script. Five sanitized evidence files were copied back, with a zero-hit sensitive scan. No runtime secret, env file, admin password or Server Action key was copied, and no host directory was overlaid onto the repository.
- **Gates:** format 0; typecheck 27/27; lint 1/1; deadcode 0; tests 2118 passed 9 skipped; build 4/4.
- **Workspace protection:** HEAD `51a899b7…` unchanged; staged 0; the user's uncommitted edits to `packages/storage/src/index.ts`, `packages/storage/src/lifecycle.ts`, `apps/worker/src/storage-init.ts` and `docker/entrypoint.sh` are intact; no `reset --hard`, `clean`, `restore`, `checkout` or `add -A`; no commit, push or CI; `turbo.json`, `pnpm-lock.yaml`, `Dockerfile`, `.dockerignore`, the canonical compose and the manifest are untouched; no `.env` content was read.
- **Open items:** authorize creating the first test tenant through `provision:first-tenant` so the UI-level permission, RLS and file tests can run; choose between the two presigned-URL remedies; decide how `bootstrap-email-provider` gets an executable entry point and whether an SMTP test service is acceptable; keep WOPI paused until it is explicitly lifted and tested.
- **Statuses unchanged:** production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; WOPI `PAUSED`; DB/object-store restore `NOT RUN`; Gate 5 PASS on the isolated test environment.
- **Evidence:** `docs/ea66d2-7-application-startup-gate5-report.md`, `docs/evidence/ea66d2-7/logs/`.

## EA-66D.3.0 addendum (2026-10-31) — launch readiness and web first-run onboarding

- **Status: READY WITH CONDITIONS.** The first-run onboarding capability, the SMTP configuration path and the guard behaviour are built, gated and verified. The object-storage public route and the tunnel's stability need a Cloudflare dashboard operation and a root-level tunnel restart respectively. The platform is NOT business-initialized: no administrator, no workspace, no real SMTP credential.
- **The initialization gap was a lifecycle gap, not a missing write.** The business layer already had everything — `bootstrapFirstAdmin` (two Better Auth rows, Better Auth's own scrypt hasher, transactional, with a database-level `DO $$ … RAISE EXCEPTION 'a super-admin already exists'` concurrency guard) and `provisionFirstTenant` (refuses when ANY workspace exists, creates the built-in roles, the reference catalogue and the day-one audit row in one transaction). What did not exist was the LIFECYCLE around them: the surface had no server-side open/closed state, no rate limit, no first-run password policy, no audit, and no web entry — because a greenfield platform cannot reach its own tenant-scoped pages. `getRequestContext()` returns null for a super-admin while no tenant exists, by design (`apps/web/src/lib/auth.ts:190-193`), and `docs/PRODUCTION_RUNBOOK.md:98-107` states the consequence plainly: "A platform with no tenant cannot be used through its own UI … This is not a workaround."
- **A public `/setup` flow was built on that business layer rather than beside it.** It reuses `bootstrapFirstAdmin` and `provisionFirstTenant` unchanged, and adds only the missing lifecycle: the open state is DERIVED from the database (no administrator means open), so the surface closes the instant the first administrator exists, with no flag to flip and no public way to reopen it. The create action is rate limited to 5 attempts per 10 minutes per client through the repository's own atomic Redis limiter, the first administrator's password floor is stricter than Better Auth's sign-in floor (12 characters, three character classes, no spaces, no repetition), and every step is audited without ever recording a password or a credential.
- **Authorization for the post-admin steps uses the platform's EXISTING `isSuperAdmin` flag.** A new `getSignedInSuperAdminId()` helper resolves the session and reads that flag on the BYPASSRLS pool, because a tenant-bound RequestContext does not exist yet. No role, scope, permission key or RLS policy is created, relaxed or bypassed; the setup flow can only ever write the flag the product already honours.
- **The SMTP configuration capability already existed and was audited as complete.** `apps/web/src/lib/email-settings-actions.ts` and `apps/web/src/lib/email-config.ts` satisfy all ten requirements: super-admin gating, `sealSecret` AES-256-GCM at rest, a `hasKey: boolean` read shape that never returns the plaintext, a test send through the SAVED config, errors sanitised to provider plus error NAME, no credential in logs, no plain-credential read for ordinary users, transactional saves that preserve the working configuration on failure, updates, and six explicit test outcomes. The one gap was reachability — `/platform/email` sits in the `(app)` layout and needs a tenant context — which the setup flow closes. The shared parsing, validation, transport resolution and delivery logic was extracted to `apps/web/src/lib/email-settings-core.ts` (not a `'use server'` module, so it stays server-side only) so the setup path and the native path cannot drift.
- **No circular dependency between onboarding and email.** The administrator is created with a password and `requireEmailVerification` is false, so account creation never depends on a successful email; the SMTP configuration follows the login; the workspace is created last; and the password-reset flow reports an unconfigured provider instead of pretending to succeed.
- **Object storage: the mechanism passes, the public route is blocked.** The presigned URL is `https` with path-style `/<bucket>/<key>`, nine SigV4 parameters, `X-Amz-SignedHeaders: host`, a 600-second expiry and the signed Host equal to the URL host; the same credential and signature fetch successfully over the internal path, so the failure is purely that `R2_ENDPOINT`'s hostname has no public DNS record. The candidate `s3-test.xuhaoqing.top` does not resolve, and the tunnel ingress carries a single hostname with an `http_status:404` catch-all, so PostgreSQL, Redis, MinIO and Collabora stay unexposed. Two remedies are specified and NEITHER was applied: a dedicated object-storage public hostname routed to `127.0.0.1:9000` with `R2_ENDPOINT` repointed (recommended, keeps the bucket name), or the canonical compose's documented `^/beaconhs(/.*)?$` path route — which additionally requires the bucket to be named `beaconhs`, because path-style URLs put the bucket in the first path segment and `beaconhs-local-prod` does not match that pattern. Both need a Cloudflare dashboard change.
- **One HIGH regression was introduced by the refactor and fixed before it shipped.** The extracted transport resolver initially dropped the platform `global_only` check, which would have let a tenant-scoped test send route around the platform's enforced provider. The resolver now checks the platform policy for BOTH scopes in the original order — unknown mode, kill switch, `global_only` — and refuses a tenant send BEFORE the tenant credential is even read. The existing test that pins this behaviour failed and was restored.
- **A second regression was masked by the turbo cache and is now closed.** EA-66D.2.6 added `docs/evidence/*/raw/**` to the root workspace's knip ignore list, which violates `deadcode-scope-contract.test.ts` — that contract asserts the root workspace ignores ONLY the operator scratch directories, so a real source directory can never hide from the scan. The evidence ignore moved to knip's TOP level, leaving the contract assertion untouched, and every gate in this phase ran with `--force` so no cached result could hide a failure again.
- **The guards were verified against a real, isolated database.** A dedicated throwaway PostgreSQL container (own container, own anonymous volume, port 55433) was prepared with the REAL `scripts/cluster/provision.sql` and the REAL migration runner, and the integration suite observed four guards: the role attributes the flow depends on, the refusal of a second administrator, the refusal of BOTH racers in a concurrent creation, and the provisioning of the first workspace exactly once. The acceptance database was re-checked afterwards and is unchanged (`users=1 superadmins=1 tenants=0 migrations=51`), and the temporary container and its volume were removed.
- **Audit trail, honestly described.** `audit_log.tenant_id` is `NOT NULL` and references `tenants`, so the pre-tenant steps CANNOT write to it. The durable record for those steps is the database itself — the `user` row, the `platform_settings.email` row and the new workspace's own day-one `audit_log` row — plus a structured stdout event line carrying no secret. A platform-level audit table would need a schema migration, which this phase does not introduce.
- **Deployment state is unchanged and was not touched.** Eight services healthy with RestartCount 0, the two one-shots exited 0, 25 images, three volumes, no rebuild, no pull, no re-run of Migration or Provision, no `down -v`. **Because §10 forbids rebuilding the application image, the new `/setup` route is not inside the running image** — deploying it needs a separate authorised build, sign, import and Gate 5 cycle.
- **Gate 5: PASS, exit code 0.** The unmodified verifier matched all eight services, five pinned digests, the deployment id, the image's own `com.beaconhs.deployment-id` (`406f0c00…`), the retained RepoDigest, RestartCount 0, the external volumes, the loopback-only bindings and zero unauthorised containers.
- **The tunnel was intermittently unavailable throughout, and the origin never was.** Cloudflare's edge reset the cloudflared control stream repeatedly: the public entry returned 530 and 502, while `http://127.0.0.1:3000/` stayed 200 with the web container healthy and RestartCount 0, the ingress configuration never changed from version 12, there was no OOM, and the edge ports stayed reachable. The tunnel self-recovered twice — once during this phase, on the first probe. `systemctl restart cloudflared` was refused with "Interactive authentication required" because the unit runs as root and `ceshi` cannot signal it, so the recovery needs a root restart. Public access itself was verified this phase: `/`, `/login`, `/api/health/ready` and `/api/auth/get-session` all returned 200 over a valid Google Trust Services certificate for `CN = xuhaoqing.top`.
- **Gates:** format 0; typecheck 27/27; lint 1/1; deadcode 0; tests 25/25 packages re-run with `--force` (web 251 files, 2126 passed); build 4/4 with `Cached: 0`. The host's memory ceiling forces `NODE_OPTIONS=--max-old-space-size` for typecheck and build, which AGENTS.md already records.
- **Synchronisation.** Thirteen files were copied to `~/beaconhs-setup-source/` on the target through a temporary path, SHA-256 verification and an atomic rename, into a fresh 0700 directory that overlays nothing; every hash matches the repository. No runtime `.env`, password, Server Action key or MinIO secret was copied. The canonical compose and the manifest are byte-identical on both ends and `turbo.json`, `pnpm-lock.yaml`, the Dockerfile and `.dockerignore` are untouched.
- **Open items for the user and operations:** (1) authorise a build cycle so the setup route reaches the target; (2) add the `s3-test.xuhaoqing.top` DNS record and the tunnel public hostname, then repoint `R2_ENDPOINT`; (3) restart cloudflared as root; (4) supply a real SMTP credential and send a test email; (5) create the first administrator and then the first workspace in the browser; (6) decide on a platform-level audit table in a later migration.
- **Statuses unchanged:** production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; WOPI `PAUSED`; DB/object-store restore `NOT RUN`; new Migration and Provision `NOT RUN`. The test environment passing does not mean the platform is business-initialized.
- **Evidence:** `docs/ea66d3-0-launch-readiness-report.md`.

## EA-66D.3.1 addendum (2026-10-31) — internal-only object storage, lifecycle scripts, and the onboarding image

- **Status: READY.** One public entry point (`https://beaconhs-test.xuhaoqing.top`), every other service internal, the browser never talks to MinIO, and start/stop/status scripts manage the whole system. The new image — which contains `/setup`, the SMTP configuration path and the internal storage gateway — is running on the test host and Gate 5 passes. The platform is still NOT business-initialized: no administrator, no workspace and no SMTP credential were created by this phase.
- **The object store is no longer reachable by a browser, by construction.** `presignPut`, `presignMultipartPart` and `presignExistingGet` were DELETED (they had no callers left and existed only to hand a write or a read to a browser). `presignGet` now signs against the INTERNAL endpoint and is documented as server-side only. The browser-facing URL is `storageObjectUrl()` → `/api/storage/object?k=…&cap=…`, where the capability is a server-minted HMAC-SHA256 over `object:v1:<key>` verified in constant time, namespaced away from the attachment capability so the two can never be replayed for each other.
- **Uploads stream through the application.** `/api/storage/upload` authorizes the reservation (owner, tenant, unconsumed, unexpired), verifies the upload token in constant time, enforces the exact byte count and the exact part number, and pipes the request body to `putStagedObject`/`uploadStagedPart`. Nothing buffers the file; `exactLengthStream` counts as the bytes flow, fails on one byte too many or too few, and re-chunks to 1 MiB because MinIO rejects larger aws-chunked chunks. The write-arm semantics and the `upload-token` metadata are unchanged, so `finalizeUpload` verifies exactly as before.
- **Downloads stream through the application.** `/api/attachments/[id]` no longer 307-redirects to a presigned MinIO URL; it streams. The object gateway sets `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, and never returns an object-store host, bucket or credential.
- **The last two browser-facing presigned reads and the email link were found and removed.** The assistant document reader and the document PDF action still returned `presignExistingGet` URLs, and the scheduled-report email carried a 7-day presigned MinIO link. All three now point at the application; the email links to the run record and the PDF is attached.
- **The setup page had a real defect that only a browser could find.** `apps/web/src/app/setup/page.tsx` passed an inline arrow function to the client `EmailTestButton`, which React refuses to serialize; the page therefore crashed at the `create_tenant` stage — the stage that only becomes reachable once an administrator exists. The action is now passed by reference. A second regression was introduced and fixed in the same pass: a static `node:stream` import in `packages/storage` broke the Edge instrumentation bundle and made the setup server action return 500; the import is dynamic and the streaming input is a web `ReadableStream`.
- **The image is built from the final source and verified inside the image.** Archive `f8137e47…` (3474 entries, no forbidden entries), deployment id `b2e5f385…`, image digest `sha256:d5d72545…`, Server Action key fingerprint `f61da7728f3065df58f9e89aec6985d6` unchanged. The image contains `/setup`, `/api/storage/object`, `/api/storage/upload`, the `object:v1:` capability and the streaming guard. The old image `sha256:1834f867…` is retained; the MinIO image ID is unchanged.
- **Lifecycle scripts are installed and tested.** `scripts/deployment/{lib.sh,beaconhs-start.sh,beaconhs-stop.sh,beaconhs-status.sh}` plus a 30-case fixture suite (all pass), installed at `~/.beaconhs/bin/` with `~/.beaconhs/lifecycle.env` (layout only, parsed never executed) and byte-identical SHA-256 on both hosts. The scripts never pull, never build, never migrate, never remove a volume and never run `down -v`; the stop script only `docker compose stop`s and verifies the volumes, images and the stopped Postgres container afterwards.
- **Idempotency was measured, not assumed.** Three consecutive starts: no container recreated, `scheduler` and `storage-init` reported `already complete for this image`, no migration, no provisioning, Gate 5 PASS each time. A full start → status → stop → start cycle left `users=1, tenants=0, migrations=51`, the three external volumes and the MinIO bucket intact; the public entry answered 502 while stopped and 200 after the restart.
- **Object storage was verified end to end in a browser against an isolated scratch database, never the acceptance database.** A throwaway PostgreSQL (port 55433, real `provision.sql`, real migration runner, 51 migrations) was used to complete `/setup`: create the administrator, sign in, reach the SMTP step (password field empty and explicitly "encrypted, never echoed"), create the first workspace, create a document, upload a 212-byte PDF and preview it. The browser's Network contained `POST /api/storage/upload` and `GET /api/storage/object` and NO request to `:9000` or `minio`; the object was found in MinIO at `t/<tenantId>/document/…`. The acceptance database was re-checked afterwards: `users=1, tenants=0, migrations=51`.
- **Public `/setup` before and after the image.** The old image returned 404 for `/setup`; the new image returns 200 and correctly reports "The platform administrator has been created. Sign in to finish the remaining setup steps", which is the initialized-state guard doing its job without creating anything.
- **Gate 5: PASS, exit code 0**, with the new digest `sha256:d5d72545…` and deployment `b2e5f385…-20261031-001`. The verifier needed both env files (the runtime settings and the Server Action key) to render the Compose file; that was a defect in the lifecycle script, fixed.
- **Gates:** format 0; typecheck 27/27; lint 0; tests 25/25 packages with `--force` (web 2159, storage 141 including a real 130 MiB multipart upload, db 549); deadcode 0; build 4/4.
- **The tunnel remains the one unstable piece, and it is not the origin.** Cloudflare reset the cloudflared control stream at 20:25 (all four connections lost, public 502/530) and the tunnel self-recovered at 20:27; a later probe saw 530 then 200. `127.0.0.1:3000` stayed 200 throughout. `systemctl restart cloudflared` still needs root, which `ceshi` does not have.
- **Statuses unchanged:** production `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`; rollback `FAIL — NO EXECUTABLE ROLLBACK PATH`; A1–A8 `PENDING AUTHORIZATION`; WOPI `PAUSED`. The test host passing does not mean the platform is business-initialized.
- **Evidence:** `docs/ea66d3-1-internal-storage-lifecycle-report.md`.

## EA-66D.4 addendum (2026-11-01) — production deployment at hse.xuhaoqing.top

- **Status: DEPLOYED AND INITIALIZED.** The EA-66D.3.1 image runs on a second, previously bare host with the SAME digest (`sha256:d5d72545…`, deployment `b2e5f385…-20261101-001`), Gate 5 PASS, and the public entry `https://hse.xuhaoqing.top` answering 200. Nothing was rebuilt, nothing was pulled, and no administrator, workspace or SMTP credential was created by the agent.
- **The user completed business initialization in the browser, and the result was verified read-only.** Administrator `admin@example.com` (`isSuperAdmin=true`, display name 系统管理员), workspace 「马来西亚项目群」 (`slug=cccc`, `917a11db-467a-48ae-abf0-81d90eb06b51`), SMTP saved as `mode=global_only` with the credential sealed inside `platform_settings.email` (349 bytes of JSONB, never plaintext), and a real test email delivered successfully. `/setup` flipped from "Step 1" to "Setup complete / The platform is initialized", so the public entry can no longer create an administrator. `migrations=51` and Gate 5 PASS were re-checked afterwards; the agent still holds no password and created no row.
- **The host was prepared, not assumed.** `10.10.31.13` (`xuhaoqing-ThinkPad-E470`, Ubuntu 26.04.1, 4 cores / 15 GB RAM / 851 GB free) had no Docker at all, so `docker.io 29.1.3` and `docker-compose-v2 2.40.3` were installed from the distribution, the daemon was confirmed enabled/active on overlayfs with the systemd cgroup driver, the operator account was added to the `docker` group, and Node.js 22 was installed so the Server Action key fingerprint can be computed on the host.
- **Images moved offline, digest-for-digest.** The five images were streamed `docker save | zstd` from the test host through the operator workstation into `docker load` on production — no intermediate tar on disk, no registry. Loading by digest loses the repository tags, so the same names were re-applied and `docker compose config --images` was used to prove every `repo@sha256:…` reference resolves.
- **One Canonical Compose, two hosts.** The web publish line became `127.0.0.1:${BEACONHS_WEB_PORT:-3000}:3000` (protected-file change, separately authorised, reason stated: the production tunnel targets 8000 while the test tunnel targets 3000). Production sets `BEACONHS_WEB_PORT=8000`; the test host sets nothing and keeps 3000. The container still listens on 3000, so the healthcheck is untouched, and both hosts were re-verified with Gate 5 PASS after the change.
- **Production secrets were generated on the production host and never left it.** Four distinct database role passwords, `BETTER_AUTH_SECRET`, `ATTACHMENT_CAPABILITY_SECRET` and the MinIO credentials were produced with `openssl rand` into 0600 files; no value was printed, logged or returned. The ONE secret that is not new is the Server Action key, because it must equal the key baked into the image at build time — its fingerprint `f61da7728f3065df58f9e89aec6985d6` was verified on the host with the canonical script.
- **Database initialized by the real, audited path.** `provision-db.sh` created the five roles with passwords piped over stdin (never argv, never a file), then an `APP_ROLE=migrate` one-shot applied **51 migrations**, 191 RLS tables, least-privilege grants, the 15 reporting views and the planner statistics targets, exit 0. The acceptance/test databases were not touched.
- **Snapshot rollback was agreed and taken.** With every container stopped, the three external volumes were tarred from inside a root container into `~/beaconhs-snapshots/20261101-preinit/` with `SHA256SUMS` (postgres 12 MB cold, redis 14 KB, minio 9.5 KB). This is rollback MATERIAL, not a rehearsed rollback: no restore was executed, so rollback stays `FAIL — NO EXECUTABLE ROLLBACK PATH`.
- **Lifecycle scripts were exercised on production, not just unit-tested.** `start` (8 services healthy, Gate 5 PASS) → `stop` (8 exited, volumes kept, public 502) → snapshot → `start` again (Gate 5 PASS, `users=0 tenants=0 migrations=51` unchanged) → `status` (correct deployment id, digest, volumes, `web 3000 → 127.0.0.1:8000`, public entry). The 30-case fixture suite still passes.
- **Two real defects were found and fixed.** (1) `beaconhs-start.sh` and `beaconhs-status.sh` printed a hard-coded `https://beaconhs-test.xuhaoqing.top` instead of `$BEACONHS_PUBLIC_ORIGIN`, so production announced the wrong domain — both now read the configured origin, the suite still passes, and the corrected files were re-synced to both hosts with matching SHA-256. (2) Loading images by digest erased their tags, which would have made Compose unable to resolve `postgres@sha256:…`; tags were restored and every reference verified before the first start.
- **Public surface verified.** `/` 200, `/setup` 200 showing "Step 1: create the platform administrator", `/api/health/ready` → `{"status":"ready","version":"51a899b7…"}`; the CSP allowlists only `https://hse.xuhaoqing.top`. The tunnel itself is configured and run outside this host, so `beaconhs-status.sh` correctly reports "no cloudflared unit here".
- **Known risks, stated plainly.** The production host is a laptop with one disk and no UPS; RDP `:3389` listens on `0.0.0.0` and should be firewalled (not changed — host security policy needs separate authorisation); SMTP is configured (`mode=global_only`) and a real test email was delivered, so mail-dependent flows are live rather than silently failing; WOPI stays `PAUSED` and the Collabora routes were not exercised; A1–A8 stay `PENDING AUTHORIZATION`; nothing was committed or pushed.
- **Evidence:** `docs/ea66d4-production-deployment-report.md`.

## EA-66D.5 addendum (2026-11-01) — Word, PowerPoint and Excel as document masters

- **Status: DEPLOYED.** The documents module no longer accepts only Word and PDF. A working master may be `.docx`, `.pptx` or `.xlsx`; the editor is chosen by type (Collabora Writer, Impress, Calc); publishing snapshots the source **in its real type**; the worker renders the PDF of record with LibreOffice. Image `sha256:cec17683…`, deployment `e7895e6d…-20261101-001`, Gate 5 PASS, 8/8 services healthy, data unchanged (`users=1, tenants=1, migrations=51`).
- **Three independent causes, all needed fixing.** (1) The upload policy and the `accept` list were DOCX-only. (2) The publish/render chain forced `.docx` names and the DOCX MIME, and the worker's `assertOfficeInput` refused every other type. (3) The runtime image shipped LibreOffice **Writer and Impress only** — no Calc — so an `.xlsx` could never have rendered to PDF even after the policy changed. `libreoffice-calc` is now installed and `calc.xcd` is present in the running container.
- **One source class, not three parallel flows.** `MAX_OFFICE_SOURCE_BYTES`, `officeSourceExtension()` and `officeSourceMimeFromFilename()` live in `@beaconhs/office/limits`, so upload, WOPI naming and the worker conversion share one definition. The extension must agree with the declared MIME type: Collabora picks the editor from the file name, so a mislabelled file would open the wrong app.
- **The WOPI editor follows the file, not a hard-coded app.** `collaboraAppForMime()` maps DOCX→Writer, PPTX→Impress, XLSX→Calc; the WOPI `BaseFileName` fallback now derives its extension from the attachment type (previously an xlsx master would have been presented to Collabora as `docx`).
- **The AI assistant is deliberately Word-only.** Its precision edit path round-trips a DOCX through Flat ODT; exposing it for a presentation or spreadsheet would corrupt the format. The button is hidden for non-DOCX masters rather than degraded silently.
- **Conversion was proven inside the built image, not assumed.** In `beaconhs:ea66d4-2`: CSV→XLSX→PDF produced a real `%PDF-` file, and the registry contains `calc.xcd`, `impress.xcd` and `writer.xcd`. Production then ran the same conversion path through the worker.
- **Deployment and evidence.** Source archive `d8de7eee…` (3477 entries, no forbidden entries), 40-hex source id `e7895e6d…`, Server Action key fingerprint unchanged (`f61da772…`). Six gates each captured `exit=0` (`docs/evidence/ea66d4-2/gates/exit-codes.txt`); `test --force` ran 25/25 packages with `Cached: 0` (web 2152 passed), `build --force` 4/4.
- **Boundaries stated plainly.** PPT/Excel PDF fidelity depends on LibreOffice import filters and can differ slightly from Microsoft Office; the 100 MB conversion ceiling still applies; the browser confirmation with the user's real deck and workbook is the last open item. Rollback remains `FAIL — NO EXECUTABLE ROLLBACK PATH`; nothing was committed or pushed.
- **Evidence:** `docs/ea66d5-office-document-masters-report.md`.

## EA-66D.6 addendum (2026-11-01) — Chinese localization repair and the PPE reflective vest

- **Status: DEPLOYED.** After switching the workspace to Chinese, the remaining English was not one bug but four independent gaps, plus one missing PPE catalogue entry. All are fixed and verified on the production host: image `sha256:2a4ccda6…`, deployment `a57eac5b…-20261101-001`, Gate 5 PASS, 8/8 services healthy, data unchanged.
- **The audit had a blind spot, so the UI leaked English through props.** `allLabel` was missing from `USER_FACING_ATTRIBUTES` in `apps/web/scripts/i18n-source-audit.ts`, which let 30 filter dropdowns ship as "All statuses", "All PPE types", "All holders" and so on. Adding it to the audit surfaced every one; each now uses a catalogued key, and a future hard-coded `allLabel` fails the i18n test instead of reaching production.
- **Page configuration objects were never audited at all.** `/admin`, `/platform`, the training course editor, vehicle-log settings and the platform invite form hold their descriptions in `desc:` / `label:` / `title:` literals. They render through `GeneratedValue`/`tGeneratedValue`, so cataloguing the strings was enough — about 75 entries added in en/zh/fr/es. After the deploy, `/admin` and `/platform` contain zero English-only lines.
- **Reference data was English because it is data, not copy.** The production tenant's PPE types, document types and document categories were renamed to Chinese (安全帽 / 全身式安全带 / 护目镜 / 防割手套, 表单 / 模板 … , 运营 / 个人防护用品 …). The canonical seeds stay English for English tenants; this is tenant-level localization, not a model change.
- **The PPE reflective vest was genuinely absent.** `反光衣` was added to the production tenant with category `body`, a 30-day cycle, sizes S–XXL and four Chinese inspection criteria, and `Reflective vest` was added to the canonical seed so future tenants get it too.
- **The new help article had no Chinese body.** `/help/documents-authoring` was fully English because its body changed with EA-66D.5 and translations are keyed by the source hash. A complete Chinese body is now in the catalogue; a crawl of all 42 help articles found it was the only English one (the rest were already translated, and the four "page not found" slugs are not articles).
- **Verification was evidence-driven, not assumed.** Logged in as the user in a Chinese session and scraped `document.body.innerText` per page, counting lines with Latin letters and no CJK: `/dashboard`, `/documents`, `/ppe`, `/ppe/types`, `/inspections/records`, `/equipment`, `/training/records`, `/people`, `/admin`, `/platform`, `/platform/users`, `/reports`, `/training/courses`, `/equipment/vehicle-log/settings` all returned zero. The only Latin text left on `/account` is the IANA time-zone identifiers.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; test `--force` 25/25 with `Cached: 0`; build `--force` 4/4. Evidence in `docs/evidence/ea66d4-5/gates/exit-codes.txt`.
- **Boundaries stated plainly.** The platform administrator still has no `tenant_users` membership (a deliberate provisioning rule), so `/account`'s per-user language selector is disabled even though the tenant default is Chinese; server-action validation messages and stored audit summaries remain English; fr/es copy for the new configuration strings is translated but not human-reviewed; the Writing-documents article summary still says "Word editor" while its body covers all three formats.
- **Evidence:** `docs/ea66d6-localization-report.md`.

## EA-66D.7 addendum (2026-11-02) — hazard-assessment and module-manage localization

- **Status: DEPLOYED.** The user found English still present in Hazard Assessments. It came from two sources EA-66D.6 did not cover, both now fixed and verified in production: image `sha256:553f4113…`, deployment `6181321b…-20261101-001`, Gate 5 PASS, 8/8 services healthy.
- **The tenant's hazard reference data was English in the database.** `hazid_assessment_types` (Arc Flash JSHA / Confined Space JSHA / Quick FLRA / Standard JSHA), `hazid_hazard_types` (Biological … Physical), 12 `hazid_hazards` with their `standard_controls`, 8 `hazid_tasks` with descriptions and 3 `hazid_hazard_sets` were renamed to Chinese for the `cccc` tenant. The canonical English seeds are untouched, so this is tenant data localization, not a model change.
- **`MODULE_ADMIN` was the second blind spot.** The registry in `apps/web/src/lib/module-admin/registry.ts` holds every module's section labels and descriptions as object literals. They never pass through the JSX audit, but the Manage hubs render them through `GeneratedValue`/`tGeneratedValue`, so a missing catalogue entry is simply English. About 100 strings were catalogued (en/zh; fr/es inherit English), which fixed the hazard Manage hub and, in the same change, `/documents/manage`, `/equipment/manage`, `/ppe/manage` and the rest.
- **Verification was per-page, not per-claim.** Scraping `document.body.innerText` and counting Latin-only lines returned zero for `/hazard-assessments`, `/hazard-assessments/hazards`, `/hazard-assessments/tasks`, `/hazard-assessments/manage`, `/documents/manage`, `/equipment/manage` and `/ppe/manage`.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; test `--force` 25/25 with `Cached: 0`; build `--force` 4/4. Evidence in `docs/evidence/ea66d4-6/gates/exit-codes.txt`.
- **One honest delta.** The running image was built before the fr/es catalogue structural completion; those missing keys fall back to English at runtime and Chinese is unaffected. The working tree passes the i18n structure test and the next build will include it. The Writing-documents article summary was also corrected to describe the Office editor.
- **Still open from EA-66D.6:** the platform administrator has no `users` membership so `/account`'s language selector is disabled; server-action validation strings and stored audit summaries remain English.
- **Evidence:** `docs/ea66d6-localization-report.md` §6.

## EA-66D.8 addendum (2026-11-02) — document preview/upload layout on portrait phones

- **Status: DEPLOYED.** The document detail page (details, PDF preview and the upload/replace toolbar) did not adapt to a 390 px portrait viewport: the desktop split stayed in place, the right pane was squeezed to roughly 100 px and its controls rendered outside the viewport. Image `sha256:a7abb9c0…`, deployment `84b57345…-20261101-001`, Gate 5 PASS, 8/8 services healthy.
- **The layout now stacks below 1024 px.** The page body is a column on phones — full-width details, then a 70vh preview — and returns to the 1/3 + 2/3 split at `lg`. The details column is `shrink-0` on phones so flex cannot collapse it (the first attempt produced a 1 px column), and the preview keeps an explicit minimum height.
- **Chrome wraps instead of clipping.** The page top bar, the Write/PDF toolbar and the PDF toolbar all moved from fixed `h-14` rows to `min-h-14` + `flex-wrap`, with the action groups right-aligned and wrapping. Nothing is hidden behind the viewport edge any more.
- **Measured, not assumed.** At 390×844: `scrollWidth = 390`, zero elements past the right edge, details 390×575 with the preview below; screenshot confirms the full form and the PDF pane. At 1440×900: app sidebar 240 px, details 400 px, preview flexible, zero overflow, split unchanged.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; test `--force` 25/25 with `Cached: 0`; build `--force` 4/4. Evidence in `docs/evidence/ea66d4-8/gates/exit-codes.txt`.
- **Boundary:** on a phone the top bar (title plus Read/Publish/Delete) stays pinned and takes about 200 px; the details and preview scroll underneath. Collapsing that bar or its action menu is a possible follow-up, not part of this fix. The PDF.js zoom logic is unchanged — 100% fits the container width.
- **Evidence:** `docs/ea66d6-localization-report.md` §7.

## EA-66D.9 addendum (2026-11-02) — builder designer layout on portrait phones

- **Status: DEPLOYED.** `/apps/templates/[id]/designer` was unusable on a 390 px portrait screen: the header's action group extended to 496 px, the fixed 288 px element palette left almost no canvas, and the app title rendered as a vertical strip. Image `sha256:ff4adf7b…`, deployment `31424542…-20261101-001`, Gate 5 PASS, 8/8 services healthy.
- **The designer now stacks below 1024 px.** The palette becomes a full-width block capped at `45vh` with its own scroll so it stays usable without swallowing the canvas; the canvas follows at full width with a `60vh` minimum; both toolbars wrap their controls instead of overflowing. At `lg` the original 288 px side panel and flexible canvas return.
- **The new-app picker was localized in the same change.** Its five structure blurbs (form / wizard / checklist / register / mini-app) plus "Ready-made starting points" and "App name" were configuration-object literals rendered through `GeneratedValue`; they are now catalogued in en/zh/fr/es.
- **Measured at both ends.** 390×844: `scrollWidth = 390`, zero elements past the viewport, palette 390×380 with the canvas below. 1440×900: app sidebar 240 px, designer panel 288 px, zero overflow, three-column layout intact.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; test `--force` 25/25 with `Cached: 0`; build `--force` 4/4. Evidence in `docs/evidence/ea66d4-9/gates/exit-codes.txt`.
- **Boundaries:** on a phone the palette occupies the top 45vh and the canvas requires scrolling; adding an element still favours tapping "add to selected section" over touch drag-and-drop, which was not separately tuned.
- **Evidence:** `docs/ea66d6-localization-report.md` §8.

## EA-66D.10 addendum (2026-11-02) — app and response deletion with permissions

- **Status: DEPLOYED.** The user asked where app deletion and in-app response deletion live. They did not exist: `forms.template.delete` and `forms.response.delete` were in the permission catalogue but no Server Action or button referenced them. Both are implemented, gated and verified in production. Image `sha256:0d6d7c9a…`, deployment `285e328c…-20261101-001`, Gate 5 PASS, 8/8 services healthy.
- **Deletion is a guarded soft delete, never a cascade.** An app can only be deleted when it has no responses and no automations; the card shows the reason it cannot be removed and the app stays. A response can be deleted unless it satisfies a scheduled compliance obligation, in which case it is evidence and is refused. Nothing is physically removed: `deleted_at` hides the row from lists, reports, the builder and the sidebar's pinned-form resolver, and the audit log records the actor.
- **Permissions are enforced server-side, not by hiding buttons.** `assertCan(ctx, 'forms.template.delete')` and `assertCan(ctx, 'forms.response.delete')` run in the actions; the UI only hides the controls to keep the surface honest. Super-admins pass through their `*` permission.
- **Response deletion joins the parent-lock contract.** The new writer calls `lockFormResponseForMutation` before its update, and `form-response-parent-lock-contract.test.ts` now inventories `apps/responses/_actions.ts` with one update and one lock — so a future writer cannot skip the lock silently.
- **The refusal is visible and translated.** The action redirects back with `?deleteError=`, the list renders it through `GeneratedValue`, and both the policy messages and the confirmations are in the catalogue (Chinese included). The manual has a new article, "Delete an app or a response", in both English and Chinese.
- **Production was exercised end to end.** Deleting Lift Plan (which has responses) was refused with the Chinese explanation; a throwaway response was deleted and disappeared from the list with its `deleted_at` set and an audit row; a throwaway app was created, deleted, and its card disappeared with an audit row. The other five apps and their responses were untouched; a test app that was deleted by a mis-targeted click during the exercise was restored and re-checked.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; test `--force` 25/25 with `Cached: 0`; build `--force` 4/4. Evidence in `docs/evidence/ea66d4-10/gates/exit-codes.txt`.
- **Boundaries:** there is no restore button — recovery means clearing `deleted_at` in the database, with the audit trail intact; deletion deliberately has no cascade so one click cannot erase a register; compliance exports that read a row directly still see a soft-deleted response while lists and reports filter it out.
- **Evidence:** `docs/ea66d6-localization-report.md` §9.

## EA-66D.11 addendum (2026-11-02) — role scope picker saved every tenant-wide choice as self

- **Status: DEPLOYED.** The scope picker wrote `{ type: 'self' }` when the user chose "Everyone in the tenant", because the serialization `switch` in `scope-picker.tsx` had no `tenant` case and fell through to the default. This was a data-write defect, not a label defect: the assignment really was saved as self, which is why both options displayed "Own records only". Image `sha256:406de487…`, deployment `ab6af13a…-20261101-001`, Gate 5 PASS, 8/8 services healthy.
- **The serializer is now pure and tested.** `toRoleScope()` lives in `admin/users/_scope-serialization.ts`, handles all six scope types, keeps the safe `self` fallback for unknown input, and is covered by four unit tests including the tenant regression.
- **The picker reads from the catalogue.** Its six option labels and six help lines now go through `tGeneratedValue`, and the summary strings (`Everyone in the tenant`, `Own records only`) have Chinese entries. The dropdown renders 仅他们自己的记录 / 租户内所有人 / 特定项目现场 / 部门或分组 / 指定人员 / 指定班组.
- **Verified against the running app.** In `/admin/roles` → bulk role assignment, the select shows six distinct Chinese options, and choosing 租户内所有人 makes the hidden field serialize `{"type":"tenant"}` — previously `{"type":"self"}`.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; test `--force` 25/25 with `Cached: 0`; build `--force` 4/4. Evidence in `docs/evidence/ea66d4-11/gates/exit-codes.txt`.
- **Boundary:** existing assignments that were saved as self by this bug stay self. They are not rewritten, because the stored value cannot distinguish "intended self" from "silently coerced self"; an administrator must re-select tenant-wide on the affected role members.
- **Evidence:** `docs/ea66d6-localization-report.md` §10.

## EA-66D.12 addendum (2026-11-02) — orphaned responses could not be deleted

- **Status: DEPLOYED.** The user reported form `0c531151` could not be deleted. It is a response (a draft on Arc Flash Work Plan), and its parent HazID assessment had already been deleted. `lockFormResponseForMutation` throws `FormResponseParentIntegrityError` when the parent is missing, and the delete action did not catch it, so the action failed instead of removing the row. Image `sha256:da9e8687…`, deployment `5cf66954…-20261101-001`, Gate 5 PASS, 8/8 services healthy.
- **A missing parent is not a reason to keep the record.** `classifyParentLockError()` maps the lock helper's failures to three outcomes: `parent-gone` (proceed — there is no live parent to protect), `parent-locked` (refuse with "The parent hazard assessment is locked. Unlock it before deleting this response."), and `unknown` (rethrow). The rule is covered by three unit tests, and the action still takes the shared lock exactly once, so `form-response-parent-lock-contract` stays green.
- **Verified on the live record.** `0c531151…` was deleted from `/apps/responses`: the row disappeared, `deleted_at` is set, and `audit_log` records `delete / Deleted Arc Flash Work Plan response`.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; test `--force` 25/25 with `Cached: 0`; build `--force` 4/4. Evidence in `docs/evidence/ea66d4-12/gates/exit-codes.txt`.
- **Boundary:** orphaned responses are deletable one by one, not swept automatically; a locked parent still blocks deletion until it is unlocked. During the review the "测试" app was found soft-deleted again by an earlier verification click and was restored — there are now no soft-deleted apps.
- **Evidence:** `docs/ea66d6-localization-report.md` §11.

## EA-66D.13 addendum (2026-11-06) — tenant region dropdown expanded

- **Status: DEPLOYED.** The create-tenant region select had three hard-coded options from the product's earliest market footprint, while the database column is free text and `/setup` takes any string. A shared `TENANT_REGIONS` catalogue (22 entries, APAC first, Chinese labels) now renders the dropdown; the default stays `ca-central-1`. Image `sha256:eccc4d1c…`, deployment `b12e7364…-20261101-001`, Gate 5 PASS.
- **Verified in production:** `/platform/tenants/new` shows 22 options starting with 新加坡 (ap-southeast-1), with the stored values unchanged in shape, so existing tenants are unaffected.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; build 0. `test --force` passed except one pre-existing environment-sensitive timeout in `@beaconhs/object-store-backup` (untouched by this change; passed in earlier full runs).
- **Boundary:** `/setup` still takes free text for the same field, and region remains descriptive metadata rather than a deployment selector.
- **Evidence:** `docs/ea66d6-localization-report.md` §12.

## EA-66D.14 addendum (2026-11-06) — first-run setup uses the shared region catalogue, with China and SEA added

- **Status: DEPLOYED.** `/setup` now renders the shared `TENANT_REGIONS` dropdown instead of a free-text region input, and the catalogue grew from 22 to 25 entries with mainland China (`cn-north-1` Beijing, `cn-northwest-1` Ningxia) and `ap-southeast-4` (Melbourne). Image `sha256:91979e0b…`, deployment `33c414b3…-20261101-001`, Gate 5 PASS, 8/8 services healthy.
- **Verified in production.** `/platform/tenants/new` lists 25 options including all three new values; the running image's server chunks contain the new codes for the setup path as well. Production `/setup` shows "Setup complete", so the dropdown itself could not be scraped live, but it shares the exact component data with the platform form.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; build 0. `test --force` is 24/25: the sole failure is the pre-existing `@beaconhs/object-store-backup` 180 s timeout flake under host load, in a package this change does not touch; it passed in earlier full runs and the web package passes alone.
- **Boundary:** only AWS region codes are offered; no Alibaba/Huawei naming. Malaysia still maps to Singapore (`ap-southeast-1`) as the nearest AWS region.
- **Evidence:** `docs/ea66d6-localization-report.md` §13.

## EA-66D.15 addendum (2026-11-07) — reference catalogues backfilled for the production tenant

- **Status: DEPLOYED.** The production tenant (KUTS) was missing entire reference catalogues. They are now seeded and verified: inspection banks 2, inspection type criteria 14, equipment categories/types/inspection-types 2/10/15, person groups 4, skill types 3, PDF templates 22, form templates 7. Image `sha256:7d75cd67…`, deployment `a8d370ff…-20261101-001`, Gate 5 PASS, 8/8 services healthy.
- **The gap was structural, not an oversight in one place.** Tenant provisioning ran only 5 of the reference seeders. Inspection types were deliberately deferred because their banks lived inline in the demo seed; equipment, register apps, PDF templates and the work permit were classified as demo content even though their seeders are already add-only for every tenant. All are now in `seedTenantReferenceData`, and the deferred note is removed.
- **Seeds were unified, not copied.** Inspection banks, person groups and the skill catalogue were extracted into idempotent reference modules and the demo flow now calls them, so the catalogue has one source of truth. `seedInspectionTypes` no longer returns early when any type exists; it imports criteria for every type that has none. A new `backfill:reference-catalogues` CLI replays the same set for existing tenants and is safe to re-run.
- **The backfill exposed a real duplication.** Because the PPE/document-category names had been renamed to Chinese while the seeders match by name, the backfill added 5 English PPE types and 5 English document categories. The English PPE types had no items and were removed with their criteria; document-category children were reparented to the Chinese categories before the English rows were deleted. Final state: 5 PPE types / 24 criteria, 7 document categories.
- **Verification:** counts per catalogue after backfill; `/ppe/types` and `/documents/categories` have no English-only lines; the three seeded inspection type names and descriptions were localized in the tenant.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; build 0. `test --force` has one pre-existing timing flake in `@beaconhs/storage` (freeze-gate lease takeover) that passes alone (13/13) and is untouched by this change.
- **Known approximation:** the reference seeders match by name, so renaming seeded rows to Chinese will recreate English duplicates on the next backfill. The durable fix is a stable key on those catalogues; until then the backfill is run once deliberately.
- **Evidence:** `docs/ea66d6-localization-report.md` §14.

## EA-66D.16 addendum (2026-11-07) — out-of-the-box foundations completed

- **Status: DEPLOYED.** The last empty reference catalogues are seeded and verified: PPE criteria banks 5, starter email templates 4, data sources 4, Toolbox Talk app added, report definitions covering every built-in report. Image `sha256:31c2f27f…`, deployment `723e0cb9…-20261101-001`, Gate 5 PASS, 8/8 services healthy.
- **What was deliberately not seeded:** `flow_gates` (runtime approval state, empty is correct), custom field definitions (tenant-specific; guessing field names would be wrong), compliance obligations beyond the existing one (statutory lists are jurisdiction-specific), and people/items (business records are never invented).
- **New seeders:** `seed/ppe-criteria-banks.ts` (banks derived per category from the shared `PPE_TYPES` constant so they cannot drift), `seed/email-templates.ts` (four record-agnostic starters with generic merge fields), `seed/data-sources.ts` (reference sources mirroring org units and companies, plus responses-bound sources for Work Permit and Lift Plan). All idempotent by key/name and wired into provisioning with completeness assertions.
- **The backfill ran twice and deduped twice.** Name-matched seeders recreate English rows after the tenant's names are localized. PPE now matches by category, which stops that specific loop; document categories and inspection types still match by name, so their duplicates were removed by hand (children reparented, criteria re-imported into the user's empty type). The durable fix is a stable key on those catalogues.
- **Verification:** per-catalogue counts after backfill; `/ppe/banks`, `/admin/email-templates` and `/admin/data-sources` have no English-only prose lines (only enum values and keys remain).
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; build 0. `test --force` is 24/25 with two pre-existing 5 s timeout flakes in the web package that pass alone (9/9).
- **Evidence:** `docs/ea66d6-localization-report.md` §15.

## EA-66D.17 addendum (2026-11-07) — portrait-phone sweep: shared chrome now wraps

- **Status: DEPLOYED.** A 390×844 scan of 15 list pages and 9 new/edit pages found three overflow spots, all in shared chrome. The `PageHeader` action group overflowed to 428px on Hazard Assessments (list and new), and the module/tab strips scrolled off-screen up to 468px on Equipment and 402px on Compliance. Image `sha256:df2cc065…`, deployment `24129c13…-20261101-001`, Gate 5 PASS, 8/8 services healthy.
- **Two shared fixes cover every affected page.** `PageHeader` now takes a wrapping header with the actions at full width below the title under `sm` (desktop unchanged), and `ModuleSubNav`, `SectionNav` and `TabNav` wrap at every breakpoint instead of hiding pills in a horizontal scroll. A new `mobile-wrap-contract.test.ts` pins both behaviours so the overflow cannot silently return.
- **Measured after the fix:** `/hazard-assessments`, `/hazard-assessments/new`, `/equipment` and `/compliance` all report zero overflowing links/buttons at 390px, and the screenshot confirms the stacked header and wrapped filters.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; build 0. `test --force` is 24/25 with one pre-existing 5 s timeout flake in the web image-optimization test (passes alone, 3/3).
- **Boundary:** wide data tables still scroll horizontally inside their containers, which is the intended phone pattern for tables; only controls and strips were made to wrap.
- **Evidence:** `docs/ea66d6-localization-report.md` §16.

## EA-66D.18 addendum (2026-11-07) — ID badge: portrait upload and CJK rendering

- **Status: DEPLOYED.** Two of the three reported badge problems were real defects; the third did not reproduce. Image `sha256:627424c1…`, deployment `4920a680…-20261101-001`, Gate 5 PASS, 8/8 services healthy.
- **The portrait could never be set.** `people.photo_attachment_id` is read by the badge renderer, three verify pages and the person detail page, but nothing in the repository ever wrote it — the badge always showed the dashed placeholder. A manage-or-self uploader now lives under the avatar on the person page (`setPersonPhoto`, image-kind check, audit, removable), and the badge renders the uploaded portrait.
- **Chinese showed as tofu because the container had no CJK font.** The image shipped only `fonts-liberation`. With the user's explicit authorisation for the protected Dockerfile, `fonts-noto-cjk` is installed and every PDF font stack (design studio, certificates, wallet cards) gained a `'Noto Sans CJK SC'` fallback. Verified on the rendered badge: tenant name, person name and department all display in Chinese.
- **The reported white lines did not reproduce.** The badge PDF was downloaded and pixel-inspected: both pages are clean at the left edge, and every element position matches the default CR80 design (the tenant's stored design is the normalized default). A screenshot showing where the lines appear would be needed to fix this one; no guess was shipped.
- **Gates:** format 0; deadcode 0; lint 0; typecheck 0; build 0. `test --force` is 24/25 with one pre-existing 5 s timeout flake in the worker email/notify tests (pass alone, 5/5).
- **Boundary:** equipment photos (`equipment_items.photo_attachment_id`) have the same missing-writer gap and were not part of this request; the badge's own photo placeholder remains until a portrait is uploaded.
- **Evidence:** `docs/ea66d6-localization-report.md` §17.

## Full-project audit addendum (2026-11-09)

A repository-wide audit found and fixed the input-validation and authorization gaps
recorded as D9 and D12–D16 in the defect register. List and CSV export filters now
use shared enum/UUID validators; the public API converts uncastable filter values
from HTTP 500 to HTTP 400; inline field editors validate record, foreign-key and
calendar-date inputs; People-group e-mail resolution requires `people.read.all`;
multipart part URLs now verify the reservation token; the internal domain-event
route no longer echoes raw exception text; and encrypted object-store backups can
now resume from their encrypted checkpoint. `turbo.json` also passes the runtime
environment keys used by web/worker child processes.

Gates were run after the final edits: format 0, typecheck 0, lint 0, test 0,
deadcode 0 and build 0. The first full-test run exposed one false positive in this
audit (a Better Auth text primary key was incorrectly guarded as a UUID) and one
parallel-load test timeout; both were resolved and the full test suite was rerun
green.

Known residual risks not changed in this pass: D8 (82 foreign keys absent from the
Drizzle snapshot chain), stable attachment capabilities, the 4-digit minimum kiosk
PIN policy, and purposeful candidate lists returned by module-authorized picker
lookups. Those need separate product/security decisions rather than silent broad
changes.

## 8b. Execution addendum — 2026-11-09 follow-up (hse-platform)

The four residual decisions above were then taken, in order, as separate atomic
commits (`6feca20e` D8, `b3e65ef6` capability v2, `2d3355bf` kiosk PIN 6–12,
`15cc7074` `people.pick`). This addendum records their execution against the
live dev environment and what was proven where.

**Host storage reclaim (cleanup script updated to kill the material leak).**
The host ran at 98% (5.6GB free of 250GB). Leakage audit found, in order:
(1) **282 × `/tmp/objstore-*` test scratch dirs (~25GB total)** — the
object-store test suite left every scratch dir behind; (2) **old Docker images
(~69GB reclaimable)** — 68 `beaconhs:*` build tags, only ~newest-3 needed;
(3) builder cache (58GB total, ~43GB reclaimable). `scripts/cleanup-local-junk.sh`
was extended to cover (1) (`cache` category, regenerated by tests) and to sweep
_every_ repo's candidates (`docker-images`, newest-3 + container-referenced
kept; `--yes` batches the sweep). Volumes remain untouched by construction.
Pruned **168GB: 98% → 27% free**, all safety properties preserved (no volumes,
no referenced images, no untracked deletions). Note the leak is dominated by
_deltas an agent/session creates over days_: image tags per experiment and
test scratch per test run. Consider candidates automatically after merges.

**Dev environment repair (needed before anything could be driven).** The local
`.env` (git-ignored) pointed its three `*_DATABASE_URL`s at `localhost:15437`,
which does not exist: the repo's own `docker-compose.yml` publishes Postgres on
`127.0.0.1:5433` and nothing maps 15437. The `.env` values were repointed to
5433 and the container roles (`beaconhs_app` / `beaconhs_migrator` /
`beaconhs_super`) were given the passwords already present in `.env`, so the
`.env` stayed the single credential truth instead of acquiring new secrets.
`pnpm db:migrate` then ran end-to-end (exit 0). Two stale stopped containers
(`beaconhs-redis`, `beaconhs-mailpit`) were holding their names; they were
removed and the services started. The dev app also needs `REDIS_URL` pointing at
the published 6380 (the `packages/jobs` 6379 local default does not match
compose) and env vars passed into the process (`set -a; source .env`); Turbo's
`dev` task does not load the repo-root `.env` itself.

**0055 ledger.** 0055 had been applied by hand with `psql`, leaving the
drizzle ledger unaware of it. The ledger row was recorded with the file's
content hash (`b63fd97d…`) and the journal `when` (1794177839709), and
`pnpm db:migrate`'s own tracker validation confirmed it: 55 applied, 0 pending,
0 historical (the journal has 55 entries — idx 42 was never used — and the
ledger was one row short before the backfill). Physical state was re-verified:
591 FKs, db-only set exactly the 74 pinned SQL-only keys.

**people.pick.** `pnpm db:migrate` ran `convergeRolePermissions`; querying the
Acme tenant's built-ins then showed `people.pick` present in worker, foreman,
safety_manager and tenant_admin (tenant_admin = full 108-key catalogue).

**Browser E2E (Playwright MCP against dev, super-admin session; numbers and
screens observed, not assumed).**

- Login → dashboard → Roles list shows Tenant Admin with 108 permissions;
  Worker detail → Permissions tab shows **Pick people** checked; Playwright login
  flow itself exercised the magic link.
- `/admin/settings`: the kiosk field label renders "Kiosk PIN (6–12 digits)"
  with a 6-digit example; entering 1234 and saving submits nothing (HTML
  `pattern="[0-9]{6,12}"` blocks it, no network request fired); saving 482913
  persisted a `bhs_pin_scrypt_v1$` hash (verified in Postgres), and I restored
  the unset seed state afterwards.
- `/kiosk?t=demo`: 4-digit PIN never reaches the server (pattern block); 6-digit
  unlocks the directory search.
- Attachment v1 URL → 404 in the browser; v2 URL passes cap validation and
  reaches the storage step (275ms vs ~65ms for v1), then 404s because this
  host's MinIO bucket (`beaconhs-dev`) does not match the app's configured
  `R2_BUCKET=test` — a pre-existing environment mismatch, not a change in the
  route. Positive-path byte streaming is therefore STATIC VERIFIED only.

**Not runnable here.** `backfill-attachment-capability-v2.ts` needs the audited
cutover environment (its `BEACONHS_CUTOVER_TARGET`, database and capability
fingerprints are digest-bound); this container matches none of them. The
script is ready for the deployment environment; the dev database holds zero
persisted attachment-route references on all five rewrite surfaces.

**Identity pickers converged onto people.pick (2026-11-09, after the addendum
above).** Follow-up inventory found seven more lookups returning account-identity
rows (`tenantUsers` + e-mail hints) under purpose-only gates: `training-class-instructors`,
`inspection-record-filter-inspectors`, `safe-distance-supervisors`,
`corrective-action-owners`, `management-review-members`, `equipment-work-order-assignees`,
`equipment-work-order-filter-assignees`. The sharpest case was
`safe-distance-supervisors`: its purpose (`tools.safe-distance.use`) is held by
every worker, so any account could enumerate the tenant's login accounts with
e-mails. Decision: one convergence key, not two — the seven were folded into
`people.pick` (members cannot distinguish the two enumerations anyway). All
built-ins already hold the key, so the picker UX is unchanged and no catalogue
or migration delta was needed. Org-unit lookups (locations/sites) and
module-record filters still run on purpose alone: they return no member rows.

## 9. Update protocol

On completing a sizeable task, update in the same change:

1. **§2 Current phase** — where the project now is.
2. **§3 Completed** — what shipped, with evidence.
3. **§4 In progress** — what is in flight.
4. **§5 Blocked** — anything newly blocked.
5. **§6 Known defects** — new defects, and any that were fixed (move them out).
6. **§7 Architecture decisions** — any new ADR, with rationale.
7. **§8 Next task** — the updated immediate next step.

Keep the format. A future agent reads this file first.
