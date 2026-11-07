# Phase 6U-B3-DS — Evidence index

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch / HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Mode: read-only release-acceptance audit. No business code, schema, migration,
container, network, volume, object-store or remote environment was changed.

This document indexes the evidence Phase DS relied on, and states for each item
whether it still proves the **current working tree**. It does not repeat the
findings; see `docs/phase-6u-b3-ds-release-gaps.md` for the assessment and
`docs/phase-6u-b3-ds-next-plan.md` for the remediation plan.

## 1. Baseline actually observed

| Check                             | Observed                                                                    |
| --------------------------------- | --------------------------------------------------------------------------- |
| `git rev-parse --abbrev-ref HEAD` | `hse-platform`                                                              |
| `git rev-parse HEAD`              | `51a899b7aac0a942da327222a3eed355fca9798a`                                  |
| `git diff --cached --name-only`   | 0 files staged                                                              |
| `git status --short` (before DS)  | 124 modified, 415 untracked (412 pre-existing + 3 Phase DR docs)            |
| Working tree vs HEAD              | HEAD plus 124 uncommitted modifications; DS added **only** documentation    |
| Phase-aj / dev stack              | not contacted                                                               |
| Databases / object storage        | read-only queries against the local dev Postgres and no object-store access |

All historical reports below were written against the same HEAD hash. "Applies to
the current tree" therefore distinguishes **code equality** from **runtime
evidence produced on an older image**.

Legend for applicability:

- **YES** — the source it asserts on is byte-identical at the current tree, and
  the assertion is static or reproducible from the tree.
- **CODE-EQUAL / IMAGE-OLDER** — the report is correct for the current source, but
  its runtime evidence came from a different image or remote stack and must be
  re-run before it counts as current runtime acceptance.
- **PARTIAL** — only part of the claim is covered.
- **STALE** — the statement contradicts the current tree.
- **HISTORICAL** — useful context, not current acceptance evidence.

## 2. Release and readiness reports

| Report                                           | Subject                                   | Source / test it asserts on                                                                                                          | Verified on                         | Result                                                   | Applies to current tree                                        |
| ------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `docs/phase-6u-b3-cv-release-readiness.md`       | Consolidated surface matrix               | all rows below                                                                                                                       | 2026-10-19, updated 2026-10-20 (DR) | mixed PASS / FAIL / BLOCKED                              | PARTIAL — §1 overstates the key gate; corrected in DS addendum |
| `docs/phase-6u-b3-cx-release-security-review.md` | Release security review                   | `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts`; key runtime                                                                  | 2026-10-19                          | PASS (runtime) / PARTIAL (rotation)                      | CODE-EQUAL / IMAGE-OLDER                                       |
| `docs/phase-6u-b3-dr-final-report.md`            | WOPI mirror + tile backpressure           | `docs/phase-6u-b3-dr-*.md`; mirror stack (removed)                                                                                   | 2026-10-20                          | 0 reproduced / 6 `NOT_REPRODUCED`                        | YES (source) / HISTORICAL (runtime, stack removed)             |
| `docs/phase-6u-b3-dh-final-report.md`            | Server Action key fail-closed boundary    | `apps/web/src/lib/server-action-key.ts`, `apps/web/src/app/api/health/ready/route.ts`, `apps/web/src/lib/server-action-key*.test.ts` | 2026-10-19                          | PASS (invalid override → 503)                            | YES (static) / CODE-EQUAL (runtime)                            |
| `docs/phase-6u-b3-di-final-report.md`            | Multi-instance key fingerprint + gate     | `apps/web/scripts/verify-server-action-key-consistency.ts`, `apps/web/src/lib/server-action-key-deployment-contract.test.ts`         | 2026-10-19                          | PASS for two-instance equality; **gate not wired**       | PARTIAL — see gap P1-2                                         |
| `docs/phase-6u-b3-dj-final-report.md`            | Trace retention + deployment gate honesty | `apps/web/playwright.config.ts`, `.github/workflows/*.yml`                                                                           | 2026-10-19                          | trace PASS; key gate PARTIAL (workflow does not call it) | YES — confirms P1-2                                            |
| `docs/phase-6u-b3-bo-e2e-closure-report.md`      | Full-system E2E closure                   | `apps/web/e2e/phase-bo-e2e.spec.ts`                                                                                                  | 2026-10-17                          | PASS on `beaconhs:phase-bl-20261017-000000`              | CODE-EQUAL / IMAGE-OLDER                                       |
| `docs/phase-6u-b3-bo-defect-register.md`         | D-BO-1 / D-BO-2                           | download filename + `Content-Disposition`                                                                                            | 2026-10-17                          | fixed in tree, deployed in BP                            | CODE-EQUAL / IMAGE-OLDER                                       |

## 3. Permissions, Role Scope, RLS and tenant isolation

| Evidence                                                                    | Subject                                             | Source / test                                                     | Verified on     | Result                                                                               | Applies to current tree  |
| --------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| `docs/phase-6u-b3-cu-role-scope-e2e.md`                                     | Site scope + cross-tenant list/detail               | browser, isolated local users                                     | 2026-10-19      | PARTIAL — list/detail only; file surfaces not exercised                              | CODE-EQUAL / IMAGE-OLDER |
| `docs/phase-6u-b3-cx-file-authorization-e2e.md` / `cy` / `cz` / `de` / `df` | File authorization matrix (7 cases)                 | `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts`            | 2026-10-19      | PASS 7/7 (local stack) / PARTIAL for full file surface                               | CODE-EQUAL / IMAGE-OLDER |
| `packages/db/src/rls.ts`                                                    | `TENANT_SCOPED_TABLES` + policy installer           | static + live DB                                                  | 2026-10-20 (DS) | 191 tables, 191 RLS+FORCE+policy; schema list matches exactly                        | YES                      |
| Live dev Postgres (read-only)                                               | RLS actually installed                              | `pg_class.relrowsecurity` / `relforcerowsecurity` / `pg_policies` | 2026-10-20 (DS) | 191/191 forced; 0 gaps                                                               | YES (dev DB)             |
| Live dev Postgres (read-only)                                               | Role attributes                                     | `pg_roles`                                                        | 2026-10-20 (DS) | `beaconhs_app` NOBYPASSRLS; `beaconhs_super` BYPASSRLS                               | YES (dev DB)             |
| `packages/tenant/src/index.ts`                                              | `can` / `assertCan` / read-tier coverage / wildcard | unit consumers across the tree                                    | 2026-10-20 (DS) | consistent; `readTierCovers` makes `read.self` reachable from `read.site`/`read.all` | YES                      |
| `apps/web/src/lib/visibility.ts`                                            | `moduleScopeWhere` / `canSeeRecord`                 | `apps/web/src/lib/visibility.ts` + contract tests                 | 2026-10-20 (DS) | tiers `all`/`site`/`self` only; no project tier                                      | YES                      |
| `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts`                      | Denial status contract                              | asserts **500** for document master and unauthorized export       | 2026-10-20 (DS) | denial happens, but as 500 not 403 — see gap P2-2                                    | YES                      |

Cross-tenant negatives in unit/contract tests (12 files reference
`cross-tenant`/`crossTenant`), including
`packages/db/src/storage-object-deletion-integrity.test.ts`,
`packages/storage/src/object-keys.test.ts`,
`packages/storage/src/storage-url.test.ts`,
`packages/db/src/tenant-provisioning.test.ts`.

**Caveat:** `packages/db/src/tenant-provisioning.test.ts`,
`tenant-reference-data.test.ts`, `seed-bootstrap-contract.test.ts`,
`storage-freeze-operations.test.ts` and `phase11e-seed-integrity.test.ts` skip
their database scenarios when `SEED_TEST_SCRATCH_DATABASE_URL` is unset. The
default gate and CI do not set it, so 41 DB-backed assertions are skipped. The
live-DB queries in the table above were run by DS to compensate for RLS policy
presence, but they do not exercise provisioning or freeze persistence.

## 4. File, upload, preview, edit, export

| Evidence                                                | Subject                                              | Source / test                                                                       | Verified on     | Result                              | Applies to current tree  |
| ------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------- | ----------------------------------- | ------------------------ |
| `docs/phase-6u-b3-bo-e2e-closure-report.md`             | Collabora edit → save → re-download; upload/download | `apps/web/e2e/phase-bo-e2e.spec.ts`                                                 | 2026-10-17      | PASS on BO image                    | CODE-EQUAL / IMAGE-OLDER |
| `docs/phase-6u-b3-dr-final-report.md` §3                | Same-origin edit/save/download + freeze control      | mirror evidence (deleted)                                                           | 2026-10-20      | PASS (control)                      | HISTORICAL               |
| `docs/phase-6u-b3-bp-*` / `bq-*`                        | Freeze UX + multipart freeze                         | `apps/web/e2e/phase-bp-freeze-browser.spec.ts`, `phase-bq-multipart-freeze.spec.ts` | 2026-10-19      | PASS in isolated tenant             | CODE-EQUAL / IMAGE-OLDER |
| `apps/web/src/lib/uploads.ts`                           | Upload limits, reservations, PDF trailer validation  | code + `apps/web/src/lib/*upload*test.ts`                                           | 2026-10-20 (DS) | limits + trailer check present      | YES                      |
| `apps/web/src/lib/pdf-preview-policy.ts` + test         | PDF preview timeout / abandonment                    | `pdf-preview-policy.test.ts`                                                        | 2026-10-20 (DS) | PASS unit (10 s watchdog)           | YES                      |
| `apps/web/src/app/(app)/documents/[id]/master/route.ts` | Master download authorization + audit                | `assertCan(ctx,'documents.manage')`, `ctx.db`, `recordAudit`                        | 2026-10-20 (DS) | PASS static                         | YES                      |
| `apps/web/src/app/api/attachments/[id]/route.ts`        | Attachment capability + tenant RLS + short presign   | capability check + `ctx.db` + 60 s presign                                          | 2026-10-20 (DS) | PASS static                         | YES                      |
| `apps/web/src/lib/wopi-access.ts`                       | WOPI grant re-authorization                          | principal + file binding + published-snapshot rules                                 | 2026-10-20 (DS) | PASS static; no current browser run | YES (static)             |
| `apps/web/e2e/phase-bn-full-system.spec.ts`             | Upload / download / preview / editor walk            | browser                                                                             | historical      | HISTORICAL                          | HISTORICAL               |

## 5. Server Action key and build security

| Evidence                                               | Subject                             | Source / test                                              | Verified on     | Result                                             | Applies to current tree  |
| ------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------- | --------------- | -------------------------------------------------- | ------------------------ |
| `docs/phase-6u-b3-cu-server-action-key.md`             | Build-time embed + runtime override | `Dockerfile:39`, `.github/workflows/deploy-dev.yml:78`     | 2026-10-19      | PASS                                               | YES (static)             |
| `docs/phase-6u-b3-cw-multi-replica-key.md`             | Two replicas + restart              | two real containers                                        | 2026-10-19      | PASS                                               | CODE-EQUAL / IMAGE-OLDER |
| `docs/phase-6u-b3-cz-key-consistency.md`               | Rotation + rollback                 | two containers                                             | 2026-10-19      | PASS                                               | CODE-EQUAL / IMAGE-OLDER |
| `docs/phase-6u-b3-dh-key-fail-closed.md`               | Invalid runtime key → 503           | `server-action-key.ts`, `ready/route.ts`                   | 2026-10-19      | PASS                                               | YES (static)             |
| `docs/phase-6u-b3-di-final-report.md`                  | Fingerprint gate                    | `scripts/verify-server-action-key-consistency.ts`          | 2026-10-19      | PASS as a script; **not invoked by CI or deploy**  | PARTIAL                  |
| `.github/workflows/ci.yml`, `deploy-dev.yml`           | Gate wiring                         | grep: no `verify-server-action-key-consistency` reference  | 2026-10-20 (DS) | **NOT WIRED**                                      | YES                      |
| `apps/web/.next/server/server-reference-manifest.json` | Build-time key location             | 545 KB server manifest, contains `encryptionKey`           | 2026-10-20 (DS) | server-side only; 0 key-label matches in `static/` | YES                      |
| `apps/web/.next/static/media/pdf.worker.min.*.mjs`     | `encryptionKey` hit                 | pdf.js PDF-encryption code, unrelated to Server Action key | 2026-10-20 (DS) | false positive                                     | YES                      |

## 6. Scheduler, worker, storage freeze and recovery

| Evidence                                                       | Subject                                        | Source / test                                                    | Verified on     | Result                                                                   | Applies to current tree  |
| -------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------ | ------------------------ |
| `docs/phase-6u-b3-cr-scheduler-reliability.md`                 | One-shot registrar semantics                   | `apps/worker/src/scheduler.ts`                                   | 2026-10-19      | PASS (design correction)                                                 | YES (static)             |
| `docs/phase-6u-b3-cs-scheduler-reliability.md`                 | Read-back + `--check` + recovery               | `packages/jobs/src/queues/scheduled.ts`                          | 2026-10-19      | PASS on disposable Redis; not deployed                                   | CODE-EQUAL / IMAGE-OLDER |
| `docs/phase-6u-b3-ct-scheduler-verification.md`                | Inspector state matrix                         | `inspectRepeatableSchedules`                                     | 2026-10-19      | PASS via ad-hoc scripts; **no committed test**                           | PARTIAL — see P2-3       |
| `apps/worker/src/health.ts`                                    | Worker health reports registry mismatch        | `inspectScheduledRegistration`                                   | 2026-10-20 (DS) | code present, untested                                                   | YES (static)             |
| `packages/db/src/storage-freeze-operations.test.ts`            | Freeze persistence (concurrency, lease, audit) | DB scenarios                                                     | 2026-10-20 (DS) | **14/16 skipped** without `SEED_TEST_SCRATCH_DATABASE_URL`               | PARTIAL                  |
| `packages/storage/src/freeze-gate*.test.ts` (6 files)          | Freeze gate on upload/presign/WOPI             | unit/contract                                                    | 2026-10-20 (DS) | 0 skipped in these files                                                 | YES (unit)               |
| `docs/phase-6u-b3-dr-final-report.md` §3                       | Real freeze lifecycle                          | mirror (FROZEN, frozen re-open, RECONCILING→ACTIVE, 0 leftovers) | 2026-10-20      | PASS (control); experiments stopped at DRAINING while an editor was open | HISTORICAL               |
| `docs/phase-6u-b3-bq-*` / `bp-*`                               | Freeze UX / multipart freeze browser           | E2E                                                              | 2026-10-19      | PASS in isolated tenant                                                  | CODE-EQUAL / IMAGE-OLDER |
| `packages/storage/src/lifecycle.test.ts`, `multipart*.test.ts` | Lifecycle / multipart semantics                | unit/fake                                                        | 2026-10-20 (DS) | PASS unit; real-store behaviour still UNKNOWN                            | PARTIAL                  |

## 7. WOPI Scenario 4

| Evidence                                          | Subject                    | Verified on | Result                                                                       | Applies to current tree |
| ------------------------------------------------- | -------------------------- | ----------- | ---------------------------------------------------------------------------- | ----------------------- |
| `docs/phase-6u-b3-dk-scenario4-evidence.md`       | The one reproduced failure | 2026-10-19  | frozen GET 200 in 4 140 ms, 0 WOPI calls, `load` never fired, 21 tile stalls | HISTORICAL (phase-aj)   |
| `docs/phase-6u-b3-dl-frame-lifecycle.md`          | Frame lifecycle            | 2026-10-19  | conclusion retracted by DM                                                   | STALE (corrected by DM) |
| `docs/phase-6u-b3-dm-frame-websocket-timeline.md` | CDP frame/socket timeline  | 2026-10-19  | no frame snapshot after the failing navigation                               | HISTORICAL              |
| `docs/phase-6u-b3-dn-*`                           | Batch reproduction         | 2026-10-19  | not reproduced                                                               | HISTORICAL              |
| `docs/phase-6u-b3-do-*` / `dp-*`                  | Precondition / throttling  | 2026-10-19  | predicate never met                                                          | HISTORICAL              |
| `docs/phase-6u-b3-dq-*`                           | Mirror + predicate design  | 2026-10-20  | method fixed in advance                                                      | YES (method)            |
| `docs/phase-6u-b3-dr-*`                           | Mirror + 6 experiments     | 2026-10-20  | 0 REPRODUCED, 0 BACKPRESSURE_ONLY, 6 NOT_REPRODUCED                          | HISTORICAL (runtime)    |

WOPI status: **KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED**
(see `docs/phase-6u-b3-ds-release-gaps.md` §5).

## 8. Quality gates actually run by DS

All runs were executed on 2026-10-20 (UTC) against the current working tree
(HEAD `51a899b7` + 124 pre-existing modifications; DS added no code). Logs are
outside the repository under `/tmp/opencode/ds-*.log`.

| Gate       | Command                                 | Exit | Tasks / counts                                                                  | Cached | Evidence force              |
| ---------- | --------------------------------------- | ---: | ------------------------------------------------------------------------------- | ------ | --------------------------- |
| Formatting | `pnpm format:check`                     |    0 | all matched files clean                                                         | n/a    | current tree                |
| Typecheck  | `TURBO_FORCE=true pnpm typecheck`       |    0 | 27/27 tasks                                                                     | 0      | current tree                |
| Lint       | `TURBO_FORCE=true pnpm lint`            |    0 | 1/1 task — **only `apps/web`**                                                  | 0      | current tree, partial scope |
| Tests      | `TURBO_FORCE=true pnpm test --continue` |    0 | 25/25 tasks; 429 test files passed + 6 skipped; 3 793 tests passed, 100 skipped | 0      | current tree, 100 skipped   |
| Dead code  | `pnpm deadcode:check`                   |    0 | no findings                                                                     | n/a    | current tree                |
| Build      | `TURBO_FORCE=true pnpm build`           |    0 | 4/4 tasks; Next compiled in 11.1 s                                              | 0      | current tree                |

Skipped-test breakdown (100 total): `db` 41, `object-store-backup` 38,
`auth` 13, `web` 8. The `db` skips are the DB-backed integration scenarios
(provisioning, seed, reference data, freeze persistence, seed integrity).

Build warnings: four Next.js "A Node.js module is loaded … not supported in the
Edge Runtime" warnings for `node:crypto` imports (kiosk pin, storage write arms,
lifecycle). No route sets `export const runtime = 'edge'`, so they are warnings
only at this tree. They are recorded so a future Edge migration does not silently
break these routes.

No CI run exists for this commit: the branch is local and unpushed, and CI only
triggers on `main`. The gate results above are local, forced (non-cached) runs.

## 9. Evidence that does **not** exist

Named honestly, so it is not inferred from the above:

- No current-tree browser E2E for upload → preview → DOCX edit → save →
  download → re-download, version download, delete/replace, or WOPI token
  boundary.
- No CI execution of any Playwright suite (there is no Playwright job and no
  Playwright in `ci.yml`).
- No CI execution of the Server Action key consistency gate.
- No CI execution of DB-backed integration tests (the suites are skipped).
- No real-object-store verification of lifecycle rules, multipart expiry, or
  backup restore in the current audit.
- No cross-tenant E2E against a deployed environment at the current image.
- No confirmation that the phase-aj scheduler/worker image contains the read-back
  and `--check` changes.
