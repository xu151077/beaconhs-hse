# Phase EA-3 — File lifecycle, freeze HTTP chain, and test-data protection

Date: 2026-10-21
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD (start): `51a899b7aac0a942da327222a3eed355fca9798a`
HEAD (end): `51a899b7aac0a942da327222a3eed355fca9798a` (unchanged)

All verification ran on the **local dev environment** (Postgres 5433, Redis 6380, MinIO 9000,
Collabora 9980) using a **dedicated test tenant** created for this phase. No commit, push,
deploy, GitHub use, or access to production, `phase-aj`, or Drill.

## 1. Phase A — baseline and the EA-2 overwrite investigation

### 1.1 Baseline

```
branch                   hse-platform
HEAD                     51a899b7aac0a942da327222a3eed355fca9798a
tracked modified         154
untracked                457
staged                   0
```

### 1.2 Root cause of the EA-2 DOCX overwrite

Investigated rather than assumed:

- The EA-2 WOPI write test hardcoded attachment `06eb60ca-…` (document `5beae69a…`).
- At the time, exactly two documents had a DOCX master. `6362fee2…` belonged to the
  `phase-bs-isolated` tenant, so it was invisible to the test identity under RLS; `5beae69a…`
  belonged to `demo` and was therefore the only own-tenant DOCX the test could see.
- Both fixtures are browser-uploaded `untitled-*` drafts from earlier phases, not user documents.
- **The test had no file of its own**, so it reused a pre-existing draft. The WOPI save
  overwrote 36 563 bytes with 20 622 bytes, and no version snapshot existed, so the original
  bytes were unrecoverable.

The defect is in the test, not in the product: the product correctly authorised the save.

### 1.3 Minimal test-side protection implemented

New file `apps/web/src/lib/testing/test-asset-ownership.ts` (test-only; never imported by
product code):

- `testAsset(label)` — unique run id (`ea3-<label>-<base36 time>-<random>`).
- `testObjectKey(asset, tenantId, filename)` — tenant-scoped key carrying the run id; rejects a
  non-UUID tenant.
- `isOwnedByTest` / `assertOwnedByTest` / `assertOwnedRow` — refuse any write or delete whose
  target does not carry this run's id. The offending value is truncated to 24 characters so a
  failure names the target without dumping a whole object key.
- The test file asserts the guard blocks the exact values EA-2 overwrote
  (`untitled-2e08e827…`, `untitled-f148d906…`, `corporate-hs-policy`).

Tests: **9/9 passed, exit 0.**

No existing user document was modified or deleted by this phase.

## 2. Phase B — file delete and replace authorization

Environment: dedicated tenant `ea3-mvgvvtpk-agme9v-tenant` with its own org units, roles,
identities (`…-sitea@ea3.local` Foreman scoped to Site A, `…-admin@ea3.local` Tenant Admin),
documents, and objects. A second tenant `…-other` was created for cross-tenant cases.

| #   | Case                                        | Method                                                                              | Result                                                                                                                                     |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Legal delete of an owned test document      | Real `deleteDocument` server action through the UI (ConfirmButton → confirm dialog) | **PASS** — `deleted_at` set, audit row written, attachment row intact                                                                      |
| 2   | Unauthorized delete (no `documents.manage`) | Same document, site-scoped identity                                                 | **PASS** — the document page itself refuses (`Page not found`, 0 delete forms rendered); document still live                               |
| 3   | Cross-tenant delete                         | Admin identity against the other tenant's document                                  | **PASS** — page refuses, 0 delete forms; document still live                                                                               |
| 4   | Legal replace                               | New object under the run id, new bytes, metadata updated                            | **PASS** — object 20 622 → 20 646 bytes; row size matches object; download through the app returns the new bytes with the sentinel present |
| 5   | Unauthorized replace                        | site-A identity on the replaced document's master                                   | **PASS** — 403                                                                                                                             |
| 6   | Cross-tenant replace                        | other tenant's document                                                             | **PASS** — 403/404                                                                                                                         |
| 7   | Consistency after failure                   | DB checks                                                                           | **PASS** — 0 attachments without a key, 0 reservations without an attachment, 0 documents pointing at a missing attachment                 |

Server-side authorization contract suites (existing, re-run on this tree):
`authorization-bridge-contract`, `document-pdf-url-authorization`,
`document-send-email-authorization`, `documents-facet-authorization`,
`document-version-download-authorization`, `export-scope-authorization`,
`authorization-residual-contract`, `document-version-visibility-contract`,
`route-error-contract` → **166 passed, exit 0.**

## 3. Phase C — freeze write denial and recovery over HTTP

Driven through the **real state machine** (`applyTransition`, which computes drain verification
itself and refuses `FROZEN` without a completed drain). No database state was written directly.

### 3.1 Storage gate (the function every upload/replace/delete path calls)

| State                  | Write attempt | Result                                           |
| ---------------------- | ------------- | ------------------------------------------------ |
| ACTIVE (initial)       | `putObject`   | **ALLOWED**                                      |
| FREEZE_REQUESTED (v11) | `putObject`   | **REFUSED**                                      |
| DRAINING (v12)         | `putObject`   | **REFUSED**                                      |
| FROZEN (v13)           | `putObject`   | **REFUSED**                                      |
| RECONCILING (v14)      | —             | transition accepted with reconciliation evidence |
| ACTIVE (v15)           | `putObject`   | **ALLOWED**                                      |

### 3.2 Real HTTP path through the running app

- Tenant driven to **FROZEN** through legal transitions.
- DOCX upload attempted through the app's real uploader UI →
  **"This workspace is frozen, so files cannot be added or changed until a platform
  administrator finishes work on file storage."**
- Post-condition check: **0 new attachments, 0 new reservations, document master unchanged.**
- Tenant recovered through `RECONCILING → ACTIVE` (reconciliation manifest hash required and
  supplied).
- The same upload retried → **1 attachment, 1 reservation, document now has a master.**
- Final freeze state: **ACTIVE**, version 20.
- Orphan/inconsistency checks: 0.

### 3.3 Phase C verdict — PASS

Frozen refuses real writes with a real contract message; recovery restores legal writes; no
orphan objects or inconsistent metadata; the refused operations were not silently replayed.

## 4. Phase D — PDF preview dependency assessment

- LibreOffice/`soffice` is **not installed** on this workstation, and `SOFFICE_PATH` is unset.
- `packages/office` resolves `soffice` from `SOFFICE_PATH`, `soffice`, `/usr/bin/soffice`, or the
  macOS bundle path — none exist here.
- Installing a system package was **not authorised**, so no system-level change was made and no
  extra long-running service was started.
- Authorization and rendering were measured **separately**:
  - Unauthorized identity → **403** (authorization works).
  - Authorized identity → **500** with `LibreOffice (soffice) is not installed on the worker`
    (authorization passed; the render failed for a missing external dependency).
- **Phase D verdict: BLOCKED** — PDF preview cannot be verified end to end locally. This is a
  dependency gap, **not** an authorization failure, and it is not reported as one.

## 5. Phase E — Server Action Key multi-instance runtime verification

Two **isolated standalone instances** built from this repository's own standalone output, on
ports 3010 and 3011, sharing the isolated dev database. Test keys were generated outside the
repository with mode 0600 and deleted afterwards; no key value appears in any log.

| #   | Case                          | Observed                                                                                                                | Result                                   |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | Same key on both              | both `200`, both log `configuration fingerprint: 2b1436832b02824641f661ad39d9b1dd`                                      | **PASS**                                 |
| 2   | Different key on B            | A `2b143683…`, B `04d9699a…`; the gate reports `fingerprint mismatch` and exits non-zero                                | **PASS** (correctly refused)             |
| 3   | Invalid key on B              | readiness **503**, log `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is not a valid base64-encoded AES key (16, 24, or 32 bytes)` | **PASS** (fails closed)                  |
| 4   | Missing runtime override on B | readiness **200**, log `no runtime override; the effective key is the build-time key embedded in the image`             | **PASS** (documented fallback behaviour) |
| 5   | Restore the same key on B     | both `200`, identical fingerprints again                                                                                | **PASS** (health recovered)              |
| 6   | Leakage scan                  | every raw key value grepped across all six instance logs                                                                | **PASS** — 0 hits                        |

Supporting local evidence: gate script **13/13**, deployment contract **8/8**, key + readiness
unit tests **24/24**.

**Phase E verdict: PASS** for the runtime multi-instance behaviour. The deploy workflow itself
was not executed (`DEPLOYMENT FLOW NOT RUN`).

## 6. Phase F — regression gates

| Gate                  | Exit | Detail                                                                                                                                       |
| --------------------- | ---: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`   |    0 | all files formatted                                                                                                                          |
| `pnpm typecheck`      |    0 | 27/27 packages                                                                                                                               |
| `pnpm lint`           |    0 | 1 task                                                                                                                                       |
| `pnpm deadcode:check` |    0 | knip clean                                                                                                                                   |
| `pnpm test`           |    0 | 25/25 tasks; web 2085 passed / 8 skipped (245 files), db 506 passed / 41 skipped, storage 148 passed, auth 78/13, object-store-backup 139/38 |
| `pnpm build`          |    0 | 4/4 tasks                                                                                                                                    |

The 41 db skips are the live DB assertions; they ran with 0 skips in EA-2's explicit project
runs and were not re-run here.

## 7. Cleanup

| Resource                                                                                                             | Created | Removed | Verified                                                |
| -------------------------------------------------------------------------------------------------------------------- | ------- | ------- | ------------------------------------------------------- |
| 2 `ea3-*` tenants (cascade: org units, roles, documents, attachments, audit, freeze, arms, in-flight writes, outbox) | yes     | yes     | 0 `ea3` tenants, 0 `ea3` documents, 0 `ea3` attachments |
| 3 `ea3-*` identities + credentials + memberships + role assignments                                                  | yes     | yes     | 0 `ea3` users                                           |
| 6 MinIO objects under `ea3-` keys / the deleted tenant                                                               | yes     | yes     | 0 `ea3` leftovers, 7 pre-existing objects untouched     |
| Standalone instances on 3010/3011                                                                                    | yes     | yes     | both ports free                                         |
| Web dev server + worker                                                                                              | yes     | yes     | port 3000 down                                          |
| Temp scripts, storage states, key files (all under `/tmp/opencode`, outside the repo)                                | yes     | yes     | removed                                                 |

**Final dev-database state: 2 tenants, 5 users, 5 documents, 2 attachments — identical to the
pre-phase counts, with all 5 original users present.** The two original DOCX fixtures and their
objects are intact.

## 8. Production / phase-aj / Drill / WOPI

- Not touched. No remote host connection was made at all in EA-3.
- WOPI status unchanged: `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`. The WOPI
  token boundary was probed read-only in EA-2 (401 for every non-token caller); no new
  investigation was started.

## 9. Files changed by EA-3

- `apps/web/src/lib/testing/test-asset-ownership.ts` (new) — the ownership guard.
- `apps/web/src/lib/testing/test-asset-ownership.test.ts` (new) — 9 tests.
- `docs/phase-6u-b3-ea3-file-lifecycle-freeze.md` (new, this report).

## 10. Status summary

| Item                                                             | Status                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Test-data protection (ownership guard)                           | **PASS** (9/9)                                                                                     |
| File delete authorization (legal / unauthorized / cross-tenant)  | **PASS**                                                                                           |
| File replace authorization (legal / unauthorized / cross-tenant) | **PASS**                                                                                           |
| Consistency after failed delete/replace                          | **PASS**                                                                                           |
| Freeze write denial (storage gate + real HTTP)                   | **PASS**                                                                                           |
| Freeze recovery and post-recovery write                          | **PASS**                                                                                           |
| No orphan objects / inconsistent metadata                        | **PASS**                                                                                           |
| PDF preview                                                      | **BLOCKED** — LibreOffice absent; authorization verified separately (403 unauthorized, 500 render) |
| Server Action Key multi-instance runtime                         | **PASS** (5/5 cases + no leakage)                                                                  |
| Key deployment workflow                                          | **NOT RUN**                                                                                        |
| Version delete/replace over HTTP                                 | **NOT RUN** (delete covered; version-level replace not driven)                                     |
| WOPI frozen re-open anomaly                                      | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`                                         |
| Overall                                                          | **NOT RELEASE-READY** — PDF preview and the key deploy workflow remain unverified                  |

## 11. Final git state

```
git branch --show-current     hse-platform
git rev-parse HEAD            51a899b7aac0a942da327222a3eed355fca9798a
git status --short            154 M, 458 ??, 0 staged
git diff --stat               154 files changed, 5100 insertions(+), 1919 deletions(-)
git diff --cached --stat      (empty)
```

No commit, push, fetch, pull, PR, deploy, or destructive git command. All pre-existing
modifications and untracked files preserved.
