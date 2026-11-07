# Phase 6U-B3-DS — Release gaps

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch / HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Basis: static source inspection, live read-only dev-DB queries, and forced
re-execution of all six quality gates. Evidence paths are indexed in
`docs/phase-6u-b3-ds-evidence-index.md`.

Verdict: **not release-ready.** No P0 security defect was found, but four P1
acceptance requirements are unverified at the current tree, and several recorded
defects remain. The gaps are evidence-and-wiring gaps, not newly discovered
cross-tenant holes.

Status vocabulary: PASS, PARTIAL, NOT RUN, FAIL, STALE — as defined in
`docs/phase-6u-b3-cv-release-readiness.md`. "Known defect" means already recorded
in `AGENTS.md` / `docs/project-development-state.md`; DS records it and does not
fix it (per the standing rule).

## A. Permissions, Role Scope, RLS and tenant isolation

### A.1 What is verified

| Control                                   | Result | Evidence                                                                                                                     |
| ----------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| RLS is the primary isolation mechanism    | PASS   | `packages/db/src/rls.ts`; every tenant query runs inside `withTenant` → `ctx.db()`; `withSuperAdmin` uses the BYPASSRLS role |
| Every tenant table is covered             | PASS   | 191 tables with `tenant_id`; `TENANT_SCOPED_TABLES` has 191; static parse found 0 missing / 0 extra                          |
| RLS is enabled **and forced** in the DB   | PASS   | live dev Postgres: 191/191 `relrowsecurity` + `relforcerowsecurity`, 191 `tenant_isolation` policies                         |
| The app role cannot bypass RLS            | PASS   | `beaconhs_app` = `NOBYPASSRLS`, not superuser; `SUPERADMIN_DATABASE_URL` uses `beaconhs_super` (`BYPASSRLS`)                 |
| Wildcard + read-tier permission semantics | PASS   | `packages/tenant/src/index.ts` — `can`, `assertCan`, `readTierCovers`, `moduleScopeWhere`                                    |
| Native permission keys are the gate       | PASS   | `PERMISSION_CATALOGUE` (102 keys, parsed from the array); nav and actions use catalogue keys                                 |
| Cross-tenant attachment download denied   | PASS   | CX E2E: 404 (local stack)                                                                                                    |
| Cross-tenant document URL denied          | PASS   | CX E2E: "Page not found" (local stack)                                                                                       |
| Cross-tenant incident list/detail denied  | PASS   | CX E2E + CU role-scope E2E                                                                                                   |
| Site-scoped list/detail visibility        | PASS   | CU role-scope E2E (local)                                                                                                    |

### A.2 What is only static / unit

- `apps/web/src/lib/wopi-access.ts` re-authorizes every WOPI call against the
  live document/version/lesson binding and the current role. This is strong
  static evidence; it has no current-tree browser run.
- `apps/web/src/lib/visibility.ts` (`moduleScopeWhere`, `canSeeRecord`) is
  covered by unit/contract tests, not by a browser matrix for every module.
- Export routes use `requireExportContext`, per-module read tiers, and
  `recordAudit` (verified by reading `incidents/export.csv/route.ts`). Other
  export routes were not individually read in this pass.

### A.3 What is not covered

- No **deployed-environment** cross-tenant E2E at the current image. The CX/CU
  evidence was produced against a local stack.
- No browser coverage for attachment **upload**, **preview**, **version
  download**, **delete/replace**, or **WOPI token** cross-tenant edges.
- API keys have no project/org-unit scope column
  (`packages/db/src/schema/api-keys.ts`). This is a documented design limit, not
  a bug, but "API key limited to project X" must not be implied.
- `RoleScope` has six variants and none is project/org-unit
  (`packages/db/src/schema/iam.ts`). Project-level scoping is **not expressible**;
  no module may simulate it with an ad-hoc filter.
- Only 11 of 25 nav entries carry `requiredPermission`. Pages such as
  `/journals` and `/feed` rely on per-query scoping (journals default to
  self-only; feed delegates to `moduleScopeWhere`). This is not a proven bypass,
  but it means nav gating is not a complete permission map.

### A.4 Denial contract defect (real, non-security)

Non-`/api/v1` route handlers let `ForbiddenError` escape, so Next renders an
opaque **500** instead of 403/404:

- `apps/web/src/lib/api/errors.ts:76-92` documents the behaviour and provides
  `withRouteErrors`, but the wrapper is only used by the public API.
- `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts:39,48` **asserts 500**
  for the document master and unauthorized export, which locks the wrong
  contract in place.

Impact: the caller is still denied (no data leak), but error monitoring cannot
distinguish a refusal from a fault, and the E2E would not catch a route that
returned 500 for the wrong reason. Classified P2.

## B. Files, upload, preview, edit, export

| Surface                                 | Status            | Evidence / reason                                                                                                 |
| --------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Upload size/kind limits                 | PASS (static)     | `apps/web/src/lib/uploads.ts` — per-kind `MAX_UPLOAD_BYTES`, PB limits, 25 pending per user                       |
| PDF format validation                   | PASS (static)     | PDF trailer check on finalize (`uploadedFileTailError`)                                                           |
| PDF preview timeout / cleanup           | PASS (unit)       | `pdf-preview-policy.ts` 10 s watchdog + test                                                                      |
| DOCX edit → save → download → re-verify | PARTIAL           | Phase BO PASS (old image); Phase DR control PASS (mirror, deleted); no current-tree run                           |
| PPTX/lesson editor                      | PARTIAL           | Phase BN historical only                                                                                          |
| Attachment download authorization       | PASS (local E2E)  | CX: cross-tenant 404; capability + tenant RLS + 60 s presign                                                      |
| Document master download                | PASS (local E2E)  | CX: denial; route requires `documents.manage`, uses `ctx.db`, audits export                                       |
| Export CSV/PDF authorization + audit    | PARTIAL           | `incidents/export.csv` verified; other 10 export routes not individually read                                     |
| Version access / replace / delete       | NOT RUN           | no current-tree browser or route-level test                                                                       |
| Frozen-state write refusal              | PASS (historical) | Phase BP/BQ + DR control; DR experiments stayed `DRAINING` while an editor was open (gate refuses writes in both) |
| Frozen-state recovery                   | PASS (DR control) | `RECONCILING → ACTIVE`, leftovers 0                                                                               |
| WOPI token / file binding               | PASS (static)     | `wopi-access.ts` — HMAC mint + live re-authorization + published-snapshot rule                                    |
| Preview of very large PDFs              | PARTIAL           | Phase BU measurement and 10 s watchdog; no current-tree large-file run                                            |
| Non-ASCII download filename             | PARTIAL           | Fixed in `content-disposition`; Phase BO FAIL was on an older image                                               |

The E2E that exists is **not** run by CI and was aimed at a local stack, not at
a deployed target. It must not be read as "the deployed file surface is verified".

## C. Server Action key and build security

Four levels, stated separately:

| Level                                     | Status      | Evidence                                                                                               |
| ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| Script/function exists                    | PASS        | `apps/web/src/lib/server-action-key.ts`; `apps/web/scripts/verify-server-action-key-consistency.ts`    |
| Unit / contract tests pass                | PASS        | `server-action-key*.test.ts`, `server-action-key-deployment-contract.test.ts` (in the forced test run) |
| CI actually executes the consistency gate | **NOT RUN** | `.github/workflows/ci.yml` and `deploy-dev.yml` contain no reference to the script                     |
| Deploy environment actually executes it   | **NOT RUN** | no deploy step, no init probe, no sidecar invokes `--expect`                                           |

Consequences:

- The readiness endpoint correctly fails closed on a **present-but-invalid**
  runtime key (503) and never prints the value.
- Cross-instance equality is **provable**, not **enforced**. The deploy path
  relies entirely on every replica sharing the BuildKit-secret key; a
  per-instance override would only surface later as "Failed to find Server
  Action".
- The deployment-contract test asserts the script _exists with the right flags_;
  it does not assert that any workflow calls it. `docs/phase-6u-b3-di-final-report.md`'s
  "blocking deployment gate" wording therefore describes a tool, not a wired
  gate. Phase DJ recorded the same as PARTIAL; DS confirms DJ, not DI.

Build artifacts:

- The build-time key **is** embedded in
  `apps/web/.next/server/server-reference-manifest.json` by Next.js. That is a
  server-side artifact and is required by the framework.
- No Server Action key label or value appears in `apps/web/.next/static/**`
  (0 matches for `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` / the fingerprint label).
  The only `encryptionKey` hit in `static/` is pdf.js PDF-encryption code.
- The literal criterion "no key material in the image" is **unmet by design** and
  should be restated as "no key material in client-accessible artifacts and no
  key value in env/history/logs". That restatement needs owner sign-off.

Documentation defect: `apps/web/src/lib/server-action-key.ts:20-22` still says
the value is "never … derived into a fingerprint", which the module itself
contradicts at lines 93-149. Cosmetic, but it misleads a security reviewer.

## D. Scheduler, worker, storage freeze and recovery

| Item                                                       | Status        | Evidence / reason                                                                                     |
| ---------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| Scheduler is a one-shot registrar (exit 0 by design)       | PASS          | `apps/worker/src/scheduler.ts`; Phase CR                                                              |
| Registration read-back fails closed                        | PASS (code)   | `inspectScheduledRegistration()` throws on mismatch                                                   |
| `--check` machine-readable probe                           | PASS (code)   | `process.argv.includes('--check')`, exit 0/1                                                          |
| Worker health reports registry mismatch                    | PASS (code)   | `apps/worker/src/health.ts`                                                                           |
| Exact / missing / unexpected / duplicate / mismatch states | PARTIAL       | Phase CT exercised them with ad-hoc scripts; **no committed test** for `inspectRepeatableSchedules`   |
| Recovery after Redis loss                                  | PASS (script) | Phase CT disposable Redis; not deployed                                                               |
| Deployed stack contains these changes                      | NOT RUN       | phase-aj image predates them; no staging verification                                                 |
| Freeze state machine                                       | PASS (DR)     | `ACTIVE → DRAINING → FROZEN → RECONCILING → ACTIVE`; legal-edge driver                                |
| Freeze persistence (optimistic concurrency, lease, audit)  | PARTIAL       | `storage-freeze-operations.test.ts` skips 14/16 DB scenarios without `SEED_TEST_SCRATCH_DATABASE_URL` |
| Freeze gate on upload / presign / WOPI                     | PASS (unit)   | 6 `freeze-gate*.test.ts` files                                                                        |
| Multipart + lifecycle semantics                            | PARTIAL       | unit/fake pass; real MinIO/R2 behaviour not re-verified                                               |
| Backup/restore                                             | PARTIAL       | `object-store-backup` unit 139 pass / 38 skipped (no real store)                                      |
| Alerts / delivery                                          | NOT RUN       | no verification that a production alert is delivered                                                  |

**CI skips the DB-backed tests.** `.github/workflows/ci.yml` provisions a
Postgres service and runs migrations twice, but never sets
`SEED_TEST_SCRATCH_DATABASE_URL`. The suites therefore skip: `db` 41 skipped
(`storage-freeze-operations` 14, `tenant-provisioning` 15, `tenant-reference-data`
4, `seed-bootstrap-contract` 4, `phase11e-seed-integrity` 4). The test output
says so explicitly ("SKIPPED, not passed"). RLS policy _presence_ was verified by
DS against the live dev DB, but RLS _enforcement under writes_ and freeze
persistence are not exercised by the gate.

## E. WOPI Scenario 4

Status: **KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED.**

Recorded facts:

- One phase-aj failure with request-level evidence: frozen `GET` returned 200 in
  4 140 ms, **0** WOPI calls, `load` never fired, 21 tile stalls
  (`docs/phase-6u-b3-dk-scenario4-evidence.md`).
- It has not been reproduced since: DN batch, DO/DP, and DR (six instrumented
  runs) never met the pre-registered three-leg predicate.
- Phase DR eliminated three server-side levers (20× client throttle, 0.5 CPU,
  `per_document.max_concurrency=1`) as sufficient causes **in the mirror**. It
  did **not** prove backpressure is impossible, and it did not transfer any
  conclusion to phase-aj.
- No confirmed data loss, corruption, or authorization impact.
- The predicate never fired, so its reachability remains unproven.

Decision required: whether this is accepted as a known low-frequency defect for
release. There is **no written risk-acceptance record**, so DS marks it
"needs owner decision" and does not declare release approved.

## F. Priority matrix

### P0 — confirmed high-risk security / cross-tenant / data-integrity

**None found.** RLS is installed and forced on every tenant table; the app role
cannot bypass it; cross-tenant read attempts exercised in the local matrix were
denied. This is a statement about the evidence reviewed, not a proof that no P0
exists.

### P1 — release-required, not verified

#### P1-1 — CI skips every DB-backed integration test

1. **Problem:** `pnpm test` and CI skip 41 DB assertions because
   `SEED_TEST_SCRATCH_DATABASE_URL` / `SCRATCH_URL` is unset, even though CI
   provisions and migrates a database.
2. **Evidence:** `/tmp/opencode/ds-test.log`; `packages/db/src/storage-freeze-operations.test.ts:35`;
   `.github/workflows/ci.yml` env block.
3. **Impact:** RLS write-enforcement, tenant provisioning, seed integrity and
   freeze persistence (concurrency, lease, audit) can regress without a red CI.
4. **Confidence:** high (the suites print "SKIPPED, not passed").
5. **Release blocking:** yes.
6. **Next step:** point the suites at the CI database (`SEED_TEST_SCRATCH_DATABASE_URL`
   or read `DATABASE_URL`), keep the role split, and run them.
7. **Acceptance:** the `db` suite reports 0 skipped under `pnpm test`; the five
   files above pass against a migrated database.

#### P1-2 — Server Action key consistency is not enforced by the pipeline

1. **Problem:** the fingerprint gate is a script plus contract test; neither CI
   nor deploy invokes it.
2. **Evidence:** grep of `.github/workflows/*.yml`; `docs/phase-6u-b3-di-final-report.md`;
   `docs/phase-6u-b3-dj-final-report.md`; `server-action-key-deployment-contract.test.ts`.
3. **Impact:** a per-instance key override passes every existing gate and fails
   later, only on requests that cross instances.
4. **Confidence:** high (static, exhaustive grep).
5. **Release blocking:** yes for multi-replica deploys.
6. **Next step:** run `--print` on every replica at rollout and compare, or run
   `--expect <fingerprint>` as an init/pre-stop probe; fail the rollout on exit 1/2.
7. **Acceptance:** a deploy workflow step (or startup probe) calls the gate,
   a mismatch demonstrably fails the rollout, and the run is recorded.

#### P1-3 — File-surface browser authorization is not covered at the current tree

1. **Problem:** the committed matrix is 7 cases against a local stack and
   asserts 500 for denials; upload, preview, DOCX edit/save/download, version
   access and WOPI edges have no current-tree browser run. CI has no Playwright.
2. **Evidence:** `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts`;
   `docs/phase-6u-b3-cu-role-scope-e2e.md` §3; `.github/workflows/ci.yml`.
3. **Impact:** a regression in a file path can ship without any gate detecting it.
4. **Confidence:** high.
5. **Release blocking:** yes for the file/Office surface.
6. **Next step:** run the file-surface matrix against a deployed stage, then add
   it to the release checklist (or CI with a seeded fixture).
7. **Acceptance:** documented PASS for upload, preview, edit→save→download,
   version download, delete/replace, cross-tenant deny, and export deny at the
   release image.

#### P1-4 — WOPI frozen-refusal remains FAIL/BLOCKED

1. **Problem:** one real phase-aj hang is unresolved; the predicate never fired
   in the mirror.
2. **Evidence:** §E above.
3. **Impact:** an operator can be stuck on a frozen document; no proven data or
   auth impact.
4. **Confidence:** the failure is real; the cause is unknown.
5. **Release blocking:** requires an explicit, written risk acceptance. DS does
   not grant it.
6. **Next step:** owner decision; if accepted, record the risk and keep the
   instrumentation.
7. **Acceptance:** either a written acceptance with monitoring, or a reproduction
   with root cause and fix.

### P2 — important coverage / operational reliability

| ID   | Problem                                                                                                 | Evidence                                                                                                                        | Impact                                    | Confidence | Release blocking | Next step / acceptance                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| P2-1 | `GET /api/v1` returns 500 because `monitored_sessions` (category `apps`) has no read permission mapping | `apps/web/src/lib/api/permissions.ts`; `apps/web/src/lib/api/permissions.test.ts:56-93`; `packages/reports/src/entities.ts:413` | public API discovery broken               | high       | no (functional)  | map `apps` to a dedicated permission or exclude the entity from discovery; acceptance: authenticated `GET /api/v1` → 200 with a test |
| P2-2 | Authorization refusals return 500 on non-`/api/v1` routes; CX asserts 500                               | `apps/web/src/lib/api/errors.ts`; CX spec lines 39/48                                                                           | noisy 5xx, wrong contract, weak test      | high       | no               | wrap page route handlers or share the error mapper; acceptance: denial → 403/404, E2E asserts it                                     |
| P2-3 | Scheduler registry inspector has no committed test                                                      | `packages/jobs/src/queues/scheduled.ts:292`; no matching `*.test.ts`                                                            | mismatch detection can regress unnoticed  | high       | no               | unit-test exact/missing/unexpected/duplicate/mismatch; acceptance: tests in `packages/jobs`                                          |
| P2-4 | Scheduler read-back/`--check`/health not deployed or stage-verified                                     | Phase CR/CS/CT; phase-aj image older                                                                                            | recovery relies on an unverified path     | high       | no               | deploy to a stage, `--check` 13/13 exit 0, simulate Redis loss; record                                                               |
| P2-5 | PPE failed inspection → CA omits `recordDomainEvent` (D4)                                               | `apps/web/src/app/(app)/ppe/_lib.ts:57-108`                                                                                     | CA owner is never notified                | high       | no               | emit the event; test the outbox row exists                                                                                           |
| P2-6 | `DATABASE_URL` role identity is not asserted; a BYPASSRLS URL would silently disable RLS                | `packages/db/src/client.ts:32-39`; deploy uses injected secrets                                                                 | catastrophic if misconfigured             | medium     | no               | startup check that `current_user` is NOBYPASSRLS (and super is BYPASSRLS)                                                            |
| P2-7 | `pnpm lint` only lints `apps/web`                                                                       | `turbo run lint` → 1 task; only `apps/web/package.json` has `lint`                                                              | backend/worker lint rules never run       | high       | no               | add lint tasks for packages/worker; acceptance: lint task count > 1 and exit 0                                                       |
| P2-8 | Real-store lifecycle/multipart/backup behaviour remains unverified                                      | `docs/phase-6u-b3-dr-final-report.md`; object-store skips                                                                       | operational surprises on the target store | medium     | no               | run against the target store and record                                                                                              |
| P2-9 | Drill stack is running with 1 958 failed jobs and schema drift                                          | `docs/phase-6u-b3-cz-drill-status.md`                                                                                           | shared-environment noise / data risk      | high       | no (needs owner) | owner chooses containment option; acceptance: drill stopped or repaired with a backup                                                |

### P3 — low-frequency, diagnostics, documentation

| ID   | Problem                                                                                                                                      | Evidence                                                         | Next step / acceptance                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| P3-1 | WOPI Scenario 4 diagnostics                                                                                                                  | §E                                                               | keep trace/socket/tile capture; re-evaluate only on recurrence        |
| P3-2 | Stale comment claims no fingerprint is derived                                                                                               | `apps/web/src/lib/server-action-key.ts:20-22` vs `:93-149`       | correct the comment; no behaviour change                              |
| P3-3 | `AGENTS.md` defect register is partly stale (D1/D2 fixed; D3/D4/D5/D6 present; "compliance" is really `apps`; catalogue is 102 keys, not 89) | `AGENTS.md`; source checks                                       | update the register to match the tree                                 |
| P3-4 | `docs/project-development-state.md` is stale (Phase 11-F summary, no DR/DS)                                                                  | `docs/project-development-state.md:1-60`                         | refresh at the next sizeable change                                   |
| P3-5 | D3 dead columns still present                                                                                                                | `training-lms.ts:216-217`; `equipment-inspection-records.ts:111` | remove with a migration, or document retention                        |
| P3-6 | D5 equipment flow profile omits `repaired`/`verified`                                                                                        | `apps/web/src/lib/flows/module-profiles.ts:577`                  | decide the status set and align the flow profile                      |
| P3-7 | D6 stale "four canonical form templates" comment                                                                                             | `packages/db/src/seed.ts:1722`                                   | correct the comment                                                   |
| P3-8 | Edge Runtime warnings for `node:crypto`                                                                                                      | build log; no `runtime='edge'` route                             | document; re-check before any Edge migration                          |
| P3-9 | Nav permission coverage is inconsistent (11/25 entries)                                                                                      | `apps/web/src/lib/nav/registry.ts`                               | align nav gates with page scoping; no behaviour change without review |
