# EA-41 Final Approval Package — Consistency Fix and Release Readiness Confirmation

**Date:** 2026-10-25
**Based on:** EA-36 to EA-40 completed work
**Status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**Candidate version:** EA-16 (source HEAD `51a899b7aac0a942da327222a3eed355fca9798a`)
**Image tag:** `beaconhs:phase-ea16-20261023-052716`
**Image manifest digest:** `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`
**App version SHA:** `51a899b7aac0a942da327222a3eed355fca9798a`
**Source snapshot:** `/home/test/projects/beaconhs-hse-release-snapshot/` (MANIFEST.txt + changed files)
**Last verified:** 2026-10-23 on ceshi `beaconhs-phase-aj` stack

---

## Executive Summary

This package consolidates EA-36 to EA-40 work and fixes status classification contradictions. All EA-36 to EA-39 completed and documented. Technical verification passed in Staging/ceshi/Local. Production pre-conditions not executed. Authorization items pending. Image reproducibility policy decision not made.

**Key findings:**

- ✅ EA-36 to EA-39 all completed and documented.
- ✅ Staging/ceshi/Local technical verification passed (10 items).
- ✅ Migration 51 backup/restore verified (staging).
- ✅ Application rollback verified (staging).
- ❌ Production migration 51 pre-check NOT RUN (SQL prepared, no authorization yet).
- ❌ Production DB backup and restore drill NOT RUN (plan documented, no authorization yet).
- ❌ Production object store backup and restore drill NOT RUN (plan documented, no authorization yet).
- ❌ Complete deployment and rollback drill NOT RUN (plan documented, no authorization yet).
- ⚠️ Technical Approver review completed, signature pending.
- ⚠️ Release Engineer review completed, signature pending.
- ❌ DBA authorization and signature PENDING (no signature yet).
- ❌ Ops authorization and signature PENDING (no signature yet).
- ❌ Image reproducibility policy decision NOT DECIDED (no written confirmation).

**Release status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

---

## Status Classification Fixes (EA-41)

### Problem Fixed

1. **"已授权但尚未执行"错误** — Changed to "未授权但已准备" (Unauthorized but Prepared) because authorization has not been obtained.
2. **"生产执行并验证项"标题错误** — Changed to "Staging/ceshi/Local 已验证项" (Staging/ceshi/Local Verified Items) because items were verified in Staging/ceshi/Local, not production.

### Files Updated

- ✅ `docs/ea40-approval-execution-record.md` — Work V.5 and V.6 corrected
- ✅ `docs/release-approval-checklist.md` — "已授权但尚未执行" and "生产执行并验证项" sections corrected
- ✅ `docs/project-development-state.md` — EA-40 addendum updated

---

## Final Release Blockers (9 items)

| #   | Item                                                    | Status         | Evidence                             | Responsibility                         | Closure condition                                        |
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

### Status Categories

- ✅ **PASS:** Staging deployment and rollback verified (2)
- ⚠️ **PENDING:** Review completed, signature pending (2)
- ❌ **NOT RUN:** Production pre-conditions not executed (5)
- ❌ **NOT DECIDED:** Image reproducibility decision not made (1)

---

## Technical Verification Passed Items (10 items)

| Item                                  | Status  | Evidence                                                           |
| ------------------------------------- | ------- | ------------------------------------------------------------------ |
| Magic Link E2E                        | ✅ PASS | EA-34: magic-link → Mailpit → verify → /dashboard                  |
| Server Action Key compatibility       | ✅ PASS | EA-25~30/33: same-key works, different-key fails with 404          |
| Migration 51 backup/restore (staging) | ✅ PASS | EA-26/32A/32B: pg_restore → pnpm db:migrate restores grants/RLS    |
| Cross-tenant RLS                      | ✅ PASS | EA-14: BB tenant sees 0 rows for all 5 AJ tables                   |
| File upload/download                  | ✅ PASS | EA-14/17: presign PUT → finalize → SHA256 match                    |
| Tunnel stability                      | ✅ PASS | EA-15: 30-min probe 118/118 200                                    |
| Gateway self-heal                     | ✅ PASS | EA-15: 5 crash injections, recovery in 1-2s                        |
| Real business operations (staging)    | ✅ PASS | EA-34: Magic Link login, forgot-password Server Action             |
| Application rollback (staging)        | ✅ PASS | EA-33: K1 baseline → K2 (diff key) → rollback to K1 → all restored |
| Rollback plan safety                  | ✅ PASS | EA-37/EA-38: All steps clearly documented                          |

---

## Staging/ceshi/Local Verified Items (10 items)

| Item                                          | Status  | Evidence                                                    | Environment   |
| --------------------------------------------- | ------- | ----------------------------------------------------------- | ------------- |
| Staging deployment (EA-26/32A/32B)            | ✅ PASS | pg_restore → pnpm db:migrate restores grants/RLS            | Staging       |
| Staging rollback (EA-33)                      | ✅ PASS | K1 baseline → K2 (diff key) → rollback to K1 → all restored | Staging       |
| Magic Link E2E (EA-34)                        | ✅ PASS | magic-link → Mailpit → verify → /dashboard                  | ceshi         |
| Server Action Key compatibility (EA-25~30/33) | ✅ PASS | same-key works, different-key fails with 404                | EA-33 staging |
| Cross-tenant RLS (EA-14)                      | ✅ PASS | BB tenant sees 0 rows for all 5 AJ tables                   | ceshi         |
| File upload/download (EA-14/17)               | ✅ PASS | presign PUT → finalize → SHA256 match                       | ceshi         |
| Tunnel stability (EA-15)                      | ✅ PASS | 30-min probe 118/118 200                                    | ceshi         |
| Gateway self-heal (EA-15)                     | ✅ PASS | 5 crash injections, recovery in 1-2s                        | ceshi         |
| Real business operations (EA-34)              | ✅ PASS | Magic Link login, forgot-password Server Action             | ceshi         |
| Migration 51 pre-check SQL verification       | ✅ PASS | SQL consistent with migration 51 file                       | Local         |

---

## Unauthorized but Prepared Items (4 items)

| Item                                             | Status     | Evidence                                             | Responsibility | Closure condition                                        |
| ------------------------------------------------ | ---------- | ---------------------------------------------------- | -------------- | -------------------------------------------------------- |
| Migration 51 production pre-check                | ❌ NOT RUN | SQL script prepared, no execution yet                | DBA            | Non_null_rows = 0 for all 3 columns                      |
| Production DB backup and restore drill           | ❌ NOT RUN | Backup and restore plan documented, no test yet      | Ops            | Restore succeeds, no errors                              |
| Production object store backup and restore drill | ❌ NOT RUN | Object store backup plan documented, no test yet     | Ops            | Restore succeeds, integrity verified                     |
| Complete deployment and rollback drill           | ❌ NOT RUN | Deployment and rollback plan documented, no test yet | Ops            | Production deployment and rollback executed successfully |

**Authorization status:** ❌ **No authorization obtained yet.** (All items are NOT RUN because authorization has not been obtained).

---

## Policy Decision Items Still Required (1 item)

| Item                           | Status         | Decision required                      | Evidence    |
| ------------------------------ | -------------- | -------------------------------------- | ----------- |
| Image reproducibility decision | ❌ NOT DECIDED | Option A/B/C with written confirmation | EA-38/EA-39 |

**Decision authority:** Technical Approver or Release Engineer (per release process).

**Required approval:**

- **Option A:** Written risk acceptance (signature or email).
- **Option B:** Confirmation of Option B (signature or email).
- **Option C:** Confirmation of Option C (signature or email).

**Decision options:**

- **Option A (Accept known difference):** Risk LOW. Accept image-level reproducibility difference (build metadata only) with written risk acceptance. No build changes required.
- **Option B (Continue solving):** Risk MEDIUM. Continue fixing image-level reproducibility (remove timestamps, use deterministic build). Requires confirmation of Option B.
- **Option C (Block release):** Risk HIGH. Block release until reproducibility is achieved. Requires confirmation of Option C.

**Audit impact:**

- **Option A:** Audit risk accepted with written risk acceptance.
- **Option B:** Audit risk mitigated by achieving reproducibility.
- **Option C:** Audit risk accepted by blocking release until reproducibility achieved.

---

## Next Steps

1. **DBA:** Run migration 51 pre-check SQL on production DB, record results, sign off.
2. **Ops:** Verify production backup and restore, confirm maintenance window and responsible parties, sign off.
3. **Technical Approver:** Review all documents, sign off, make image digest reproducibility decision (Option A/B/C).
4. **Release Engineer:** Verify all pre-deployment checklist items, sign off, make image digest reproducibility decision (Option A/B/C).

**Stop conditions:**

- Any migration 51 pre-check fails (non_null_rows > 0).
- Any backup/restore test fails.
- Any pre-deployment checklist item is not met.
- Any unaddressed defects found.
- Technical Approver or Release Engineer does not sign off.
- Image digest reproducibility decision is not made (Option A/B/C).

---

## Deliverables

**New:**

- `docs/ea40-approval-execution-record.md` — Complete release decision execution and authorization closure record (§1-6)
- `docs/ea41-final-approval-package.md` — This document

**Updated:**

- `docs/release-approval-checklist.md` — Status classification fixes applied
- `docs/project-development-state.md` — EA-40 addendum updated

---

## Safety Boundaries

- No production database or object store access.
- No production SQL, migration, backup/restore, deployment, or rollback.
- No ceshi modification.
- No backup/snapshot/image deletion.
- No re-investigation of resolved language settings.
- WOPI remains paused for investigation.

---

## Final Determination

Only when all mandatory blocking items have real execution evidence, required approvals are signed, and image policy decision is made can production change window be suggested.

**Current status:**
`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
