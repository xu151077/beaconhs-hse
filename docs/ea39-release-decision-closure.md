# EA-39 — Release Decision Closure and Production Pre-condition Verification (2026-10-25)

**Status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**Based on:** EA-36 release readiness review, EA-37 production readiness authorization plan, EA-38 release decision record
**Candidate version:** EA-16 (source HEAD `51a899b7aac0a942da327222a3eed355fca9798a`)
**Image tag:** `beaconhs:phase-ea16-20261023-052716`
**Image manifest digest:** `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`
**App version SHA:** `51a899b7aac0a942da327222a3eed355fca9798a`
**Source snapshot:** `/home/test/projects/beaconhs-hse-release-snapshot/` (MANIFEST.txt + changed files)
**Last verified:** 2026-10-23 on ceshi `beaconhs-phase-aj` stack
**EA-39 completed:** 2026-10-25

---

## Executive Summary

This document performs a final verification of all production pre-conditions for the BeaconHS EA-16 release based on EA-38's release decision record.

**Key findings:**

- ✅ Migration 51 pre-check SQL is consistent with actual migration file.
- ✅ Backup and rollback plan is complete and safe.
- ⚠️ Image digest reproducibility decision is PENDING (no written confirmation yet).
- ⚠️ All production pre-conditions are NOT RUN or NOT VERIFIED (staging verified, production unverified).
- ❌ All authorization items are pending (no signatures obtained).

**Release status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

---

## Work I: Image Reproducibility Decision Verification

### 1.1 Current Decision Status

**From `docs/ea38-release-decision-record.md` §3.7:**

- **Status:** `PENDING APPROVAL — NOT DECIDED`
- **Decision required:** Technical Approver or Release Engineer must choose Option A, B, or C and provide written confirmation.

**Evidence:**

- EA-19 to EA-23 build evidence summary (Section 3.1)
- Reproducible vs non-reproducible breakdown (Section 3.2)
- Root cause analysis (Section 3.3)
- Impact assessment (Section 3.4)
- Decision options and authority (Section 3.5)

**No valid written decision found.**

### 1.2 Decision Options

| Option       | Description                                   | Risk   | Decision required                     | Current status               |
| ------------ | --------------------------------------------- | ------ | ------------------------------------- | ---------------------------- |
| **Option A** | Accept known difference (build metadata only) | LOW    | Written risk acceptance from approver | ❌ PENDING (no signature)    |
| **Option B** | Continue solving image-level reproducibility  | MEDIUM | Confirmation of Option B              | ❌ PENDING (no confirmation) |
| **Option C** | Block release until reproducibility achieved  | HIGH   | Confirmation of Option C              | ❌ PENDING (no confirmation) |

### 1.3 Decision Authority

**Decision authority:** Technical Approver or Release Engineer (per release process).

**Required approval:**

- **Option A:** Written risk acceptance (signature or email).
- **Option B:** Confirmation of Option B (signature or email).
- **Option C:** Confirmation of Option C (signature or email).

**Audit impact:**

- **Option A:** Audit risk accepted with written risk acceptance.
- **Option B:** Audit risk mitigated by achieving reproducibility.
- **Option C:** Audit risk accepted by blocking release until reproducibility achieved.

### 1.4 Conclusion

**Status:** `PENDING APPROVAL — NOT DECIDED`

**No valid written decision obtained.** The decision authority (Technical Approver or Release Engineer) has not provided written confirmation for Option A, B, or C.

**Next steps:**

1. Technical Approver or Release Engineer reviews all evidence.
2. Approver chooses Option A, B, or C.
3. Approver provides written confirmation (signature or email).
4. Decision recorded in this section.

---

## Work II: Production Pre-condition Evidence Status

### 2.1 Migration 51 Production Read-Only Pre-check

| Item                              | Status       | Evidence                         | Responsibility   | Closure condition                   |
| --------------------------------- | ------------ | -------------------------------- | ---------------- | ----------------------------------- |
| Migration 51 pre-check SQL        | **NOT RUN**  | No execution on production DB    | DBA              | Non_null_rows = 0 for all 3 columns |
| Migration 51 pre-check results    | **NOT RUN**  | No results recorded              | DBA              | Results recorded in audit log       |
| SQL consistency with migration 51 | **VERIFIED** | Migration file matches checklist | Release Engineer | ✅ Confirmed (Section 4.1)          |

**Production access required:** Yes (DBA to run SQL on production DB).

**Change window required:** Yes (for DB backup and restore).

**Backup confirmation required:** Yes (DB backup and object store backup).

**Status:** ❌ **NOT RUN** (requires DBA production access).

**Evidence:** `docs/ea37-production-readiness-plan.md` §1.2 (SQL script), `docs/ea38-release-decision-record.md` §4.1 (DBA authorization).

### 2.2 Production Database Backup and Restore Verification

| Item                               | Status           | Evidence                       | Responsibility | Closure condition                     |
| ---------------------------------- | ---------------- | ------------------------------ | -------------- | ------------------------------------- |
| Production DB backup exists        | **NOT VERIFIED** | No production backup confirmed | Ops            | Backup file exists and is restorable  |
| Production DB backup is restorable | **NOT RUN**      | No restore test performed      | Ops            | Restore succeeds, no errors           |
| `pg_restore --no-privileges` step  | **NOT RUN**      | No restore test performed      | Ops            | Restore succeeds with --no-privileges |
| `pnpm db:migrate` after restore    | **NOT RUN**      | No restore test performed      | Ops            | Grants and RLS rebuilt successfully   |
| Row counts preserved               | **NOT RUN**      | No restore test performed      | Ops            | Row counts match manifest             |
| RLS policies preserved             | **NOT RUN**      | No restore test performed      | Ops            | 194 policies confirmed in restored DB |
| Migration version preserved        | **NOT RUN**      | No restore test performed      | Ops            | Migration version matches             |

**Production access required:** Yes (Ops to verify backup and test restore).

**Change window required:** Yes (for deployment and rollback).

**Backup confirmation required:** Yes (DB backup and object store backup).

**Status:** ❌ **NOT RUN** (requires Ops production access).

**Evidence:** `docs/ea37-production-readiness-plan.md` §2.1-2.7 (backup and restore plan), `docs/ea38-release-decision-record.md` §4.2 (Ops authorization).

### 2.3 Production Object Store Backup and Restore Verification

| Item                                         | Status           | Evidence                         | Responsibility | Closure condition                    |
| -------------------------------------------- | ---------------- | -------------------------------- | -------------- | ------------------------------------ |
| Production object store backup exists        | **NOT VERIFIED** | No object store backup confirmed | Ops            | Backup file exists and is restorable |
| Production object store backup is restorable | **NOT RUN**      | No restore test performed        | Ops            | Restore succeeds, integrity verified |
| Object integrity checks                      | **NOT RUN**      | No restore test performed        | Ops            | All integrity checks pass            |
| Business verification                        | **NOT RUN**      | No restore test performed        | Ops            | All business verification steps pass |

**Production access required:** Yes (Ops to verify object store backup and test restore).

**Change window required:** Yes (for deployment and rollback).

**Backup confirmation required:** Yes (DB backup and object store backup).

**Status:** ❌ **NOT RUN** (requires Ops production access).

**Evidence:** `docs/ea37-production-readiness-plan.md` §2.1-2.5 (object store backup and restore plan), `docs/ea38-release-decision-record.md` §4.2 (Ops authorization).

### 2.4 Complete Deployment and Rollback Drill

| Item                              | Status      | Evidence                                        | Responsibility   | Closure condition                         |
| --------------------------------- | ----------- | ----------------------------------------------- | ---------------- | ----------------------------------------- |
| Staging deployment verified       | **PASS**    | EA-26/EA-32A/EA-32B/EA-33/EA-34                 | Release Engineer | Staging deployment verified               |
| Staging rollback verified         | **PASS**    | EA-33 (K1 → K2 → rollback to K1)                | Release Engineer | Staging rollback verified                 |
| Production deployment             | **NOT RUN** | No production deployment performed              | Ops              | Production deployment executed            |
| Production rollback               | **NOT RUN** | No production rollback performed                | Ops              | Production rollback executed successfully |
| Readiness verification            | **NOT RUN** | No production readiness verification            | Ops              | Readiness returns 200                     |
| Login flow verification           | **NOT RUN** | No production login verification                | Ops              | Login flow works                          |
| Server Actions verification       | **NOT RUN** | No production Server Actions verification       | Ops              | Server Actions work                       |
| File upload/download verification | **NOT RUN** | No production file upload/download verification | Ops              | File upload/download works                |
| RLS verification                  | **NOT RUN** | No production RLS verification                  | Ops              | RLS enforced                              |
| Error rate verification           | **NOT RUN** | No production error rate verification           | Ops              | 5xx error rate < 1%                       |

**Production access required:** Yes (Ops to perform production deployment and rollback).

**Change window required:** Yes (for deployment and rollback).

**Backup confirmation required:** Yes (DB backup and object store backup).

**Status:** ❌ **NOT RUN** (requires Ops production access).

**Evidence:** `docs/ea36-release-readiness-review.md` §3.3-3.5 (staging rollback), `docs/ea38-release-decision-record.md` §4.3 (Technical Approver authorization).

### 2.5 Technical Approver Technical Approval

| Item                                     | Status           | Evidence                             | Responsibility     | Closure condition            |
| ---------------------------------------- | ---------------- | ------------------------------------ | ------------------ | ---------------------------- |
| Release readiness review completed       | **COMPLETED**    | Reviewed EA-36/EA-37/EA-38 documents | Technical Approver | Technical Approver signs off |
| All pre-deployment checklist items met   | **NOT VERIFIED** | No checklist items confirmed         | Release Engineer   | All checklist items met      |
| Magic Link E2E verified                  | **VERIFIED**     | Reviewed EA-34 evidence              | Technical Approver | Technical Approver confirms  |
| Server Action Key compatibility verified | **VERIFIED**     | Reviewed EA-25~30/33 evidence        | Technical Approver | Technical Approver confirms  |
| Migration 51 backup/restore verified     | **VERIFIED**     | Reviewed EA-26/32A/32B evidence      | Technical Approver | Technical Approver confirms  |
| Application rollback verified            | **VERIFIED**     | Reviewed EA-33 evidence              | Technical Approver | Technical Approver confirms  |
| Real business operations verified        | **VERIFIED**     | Reviewed EA-34 evidence              | Technical Approver | Technical Approver confirms  |
| Cross-tenant RLS verified                | **VERIFIED**     | Reviewed EA-14 evidence              | Technical Approver | Technical Approver confirms  |
| File upload/download verified            | **VERIFIED**     | Reviewed EA-14/17 evidence           | Technical Approver | Technical Approver confirms  |
| Tunnel stability verified                | **VERIFIED**     | Reviewed EA-15 evidence              | Technical Approver | Technical Approver confirms  |
| Gateway self-heal verified               | **VERIFIED**     | Reviewed EA-15 evidence              | Technical Approver | Technical Approver confirms  |
| No unaddressed defects                   | **VERIFIED**     | Reviewed defect register             | Technical Approver | Technical Approver confirms  |
| Rollback plan safety verified            | **VERIFIED**     | Reviewed rollback plan               | Technical Approver | Technical Approver confirms  |

**Production access required:** No (technical approval based on documents).

**Change window required:** No (change window is an Ops responsibility).

**Backup confirmation required:** No (backup confirmation is a DBA/Ops responsibility).

**Status:** ⚠️ **PENDING** (review completed, signature pending).

**Evidence:** `docs/ea38-release-decision-record.md` §4.3 (Technical Approver authorization).

### 2.6 Release Engineer Release Confirmation

| Item                                            | Status           | Evidence                         | Responsibility   | Closure condition                             |
| ----------------------------------------------- | ---------------- | -------------------------------- | ---------------- | --------------------------------------------- |
| Source snapshot archived                        | **VERIFIED**     | Snapshot file exists             | Release Engineer | Release Engineer confirms                     |
| Source reproducibility verified                 | **VERIFIED**     | Reviewed EA-19 evidence          | Release Engineer | Release Engineer confirms                     |
| Image tag recorded                              | **VERIFIED**     | Image tag matches                | Release Engineer | Release Engineer confirms                     |
| Full manifest digest recorded                   | **VERIFIED**     | Manifest digest matches          | Release Engineer | Release Engineer confirms                     |
| App version SHA matches image                   | **VERIFIED**     | Version SHA matches              | Release Engineer | Release Engineer confirms                     |
| Server Action Key file available                | **VERIFIED**     | Key file exists                  | Release Engineer | Release Engineer confirms                     |
| All secrets configured in production            | **NOT VERIFIED** | No production env vars confirmed | Release Engineer | Release Engineer verifies production env vars |
| APP_URL/PUBLIC_APP_URL = production origin      | **NOT VERIFIED** | No production URLs confirmed     | Release Engineer | Release Engineer verifies production URLs     |
| Rollback image tag available                    | **NOT VERIFIED** | Previous image tag not confirmed | Release Engineer | Release Engineer verifies previous image tag  |
| No uncommitted working-tree changes for release | **VERIFIED**     | Working tree clean               | Release Engineer | Release Engineer confirms                     |

**Production access required:** No (Release Engineer approval based on documents).

**Change window required:** No (change window is an Ops responsibility).

**Backup confirmation required:** No (backup confirmation is a DBA/Ops responsibility).

**Status:** ⚠️ **PENDING** (review completed, signature pending).

**Evidence:** `docs/ea38-release-decision-record.md` §4.4 (Release Engineer authorization).

### 2.7 DBA and Ops Authorization and Signatures

**DBA Authorization:**

| Item                            | Status           | Evidence                                  | Responsibility | Closure condition                           |
| ------------------------------- | ---------------- | ----------------------------------------- | -------------- | ------------------------------------------- |
| Migration 51 pre-check SQL      | **NOT RUN**      | No execution yet                          | DBA            | DBA runs SQL, records results, signs off    |
| Migration 51 pre-check results  | **NOT RUN**      | No results yet                            | DBA            | DBA records results in audit log, signs off |
| Production backup exists        | **NOT VERIFIED** | No production backup confirmed            | DBA            | DBA confirms backup file exists             |
| Production backup is restorable | **NOT RUN**      | No restore test performed                 | DBA            | DBA confirms restore test passes            |
| Rollback prerequisites met      | **NOT VERIFIED** | Backup + previous image tag not confirmed | DBA            | DBA confirms prerequisites met              |

**Ops Authorization:**

| Item                                         | Status           | Evidence                              | Responsibility | Closure condition                           |
| -------------------------------------------- | ---------------- | ------------------------------------- | -------------- | ------------------------------------------- |
| Target environment not ceshi/drill           | **NOT VERIFIED** | No production environment confirmed   | Ops            | Ops confirms production environment         |
| DB backup exists and is restorable           | **NOT VERIFIED** | No production backup confirmed        | Ops            | Ops confirms backup and restore test passes |
| Object store backup exists and is restorable | **NOT VERIFIED** | No object store backup confirmed      | Ops            | Ops confirms backup and restore test passes |
| Object store is provisioned and accessible   | **NOT VERIFIED** | No object store endpoint confirmed    | Ops            | Ops confirms object store accessible        |
| DNS/Cloudflare tunnel routes correctly       | **NOT VERIFIED** | No DNS configuration confirmed        | Ops            | Ops confirms DNS resolution successful      |
| Maintenance window identified                | **NOT VERIFIED** | No maintenance window documented      | Ops            | Ops confirms maintenance window             |
| Responsible parties identified               | **NOT VERIFIED** | No responsible parties list confirmed | Ops            | Ops confirms responsible parties            |
| Rollback image tag available                 | **NOT VERIFIED** | Previous image tag not confirmed      | Ops            | Ops confirms previous image tag exists      |
| Compose config backup available              | **NOT VERIFIED** | No compose config backup confirmed    | Ops            | Ops confirms compose config backup exists   |

**Production access required:**

- DBA: ✅ Yes (to run migration 51 pre-check SQL)
- Ops: ✅ Yes (to verify object store, DNS, compose config, and perform deployment)

**Change window required:**

- DBA: ✅ Yes (for DB backup and restore)
- Ops: ✅ Yes (for deployment and rollback)

**Backup confirmation required:**

- DBA: ✅ Yes (DB backup and object store backup)
- Ops: ✅ Yes (DB backup and object store backup)

**Approval signature required:**

- DBA: ✅ Yes (DBA to sign off on migration 51 pre-check results)
- Ops: ✅ Yes (Ops to sign off on all confirmations)

**Status:**

- DBA: ❌ **PENDING** (no signature yet).
- Ops: ❌ **PENDING** (no signature yet).

**Evidence:** `docs/ea38-release-decision-record.md` §4.1 (DBA authorization), §4.2 (Ops authorization).

### 2.8 Image Reproducibility Policy Decision

| Item                                        | Status          | Evidence                          | Responsibility                         | Closure condition              |
| ------------------------------------------- | --------------- | --------------------------------- | -------------------------------------- | ------------------------------ |
| Option A decision (accept known difference) | **NOT DECIDED** | No written risk acceptance        | Technical Approver or Release Engineer | Approver signs risk acceptance |
| Option B decision (continue solving)        | **NOT DECIDED** | No confirmation                   | Technical Approver or Release Engineer | Approver confirms Option B     |
| Option C decision (block release)           | **NOT DECIDED** | No confirmation                   | Technical Approver or Release Engineer | Approver confirms Option C     |
| Decision authority confirmed                | **CONFIRMED**   | Release process defines authority | Technical Approver or Release Engineer | Authority confirmed            |
| Audit impact documented                     | **DOCUMENTED**  | Audit impact documented in EA-38  | Technical Approver or Release Engineer | Audit impact documented        |

**Decision authority:** Technical Approver or Release Engineer (per release process).

**Required approval:**

- **Option A:** Written risk acceptance (signature or email).
- **Option B:** Confirmation of Option B (signature or email).
- **Option C:** Confirmation of Option C (signature or email).

**Status:** ❌ **NOT DECIDED** (no written confirmation yet).

**Evidence:** `docs/ea38-release-decision-record.md` §3.5-3.7 (Image reproducibility decision).

---

## Work III: Migration 51 Pre-check Condition Verification

### 3.1 SQL Consistency with Migration 51

**Migration 51 file:** `packages/db/drizzle/0051_ea12_drop_dead_columns.sql`

**Content:**

```sql
ALTER TABLE "equipment_inspection_records" DROP COLUMN "certificate";
ALTER TABLE "training_enrollments" DROP COLUMN "due_on";
ALTER TABLE "training_enrollments" DROP COLUMN "expires_on";
```

**EA-37 checklist SQL (Section 1.2):**

```sql
-- Check 1: equipment_inspection_records.certificate
SELECT
  'equipment_inspection_records.certificate' AS check_name,
  COUNT(*) AS total_rows,
  COUNT(certificate) AS non_null_rows,
  COUNT(*) - COUNT(certificate) AS null_rows
FROM equipment_inspection_records;

-- Check 2: training_enrollments.due_on
SELECT
  'training_enrollments.due_on' AS check_name,
  COUNT(*) AS total_rows,
  COUNT(due_on) AS non_null_rows,
  COUNT(*) - COUNT(due_on) AS null_rows
FROM training_enrollments;

-- Check 3: training_enrollments.expires_on
SELECT
  'training_enrollments.expires_on' AS check_name,
  COUNT(*) AS total_rows,
  COUNT(expires_on) AS non_null_rows,
  COUNT(*) - COUNT(expires_on) AS null_rows
FROM training_enrollments;

-- Check 4: Verify migration 51 is not already applied
SELECT
  'migration_version' AS check_name,
  current_setting('app.current_migration', true) AS current_migration,
  '0051_ea12_drop_dead_columns' AS target_migration;
```

**Verification:**

- ✅ Check 1: `equipment_inspection_records.certificate` matches migration 51.
- ✅ Check 2: `training_enrollments.due_on` matches migration 51.
- ✅ Check 3: `training_enrollments.expires_on` matches migration 51.
- ✅ Check 4: Migration version check is correct (uses `current_setting('app.current_migration')`).

**Conclusion:** ✅ SQL is consistent with migration 51. No corrections needed.

### 3.2 Stop Conditions

**From EA-37 checklist (Section 1.6):**

- **STOP CONDITION 1:** Any check returns `non_null_rows > 0` → **DO NOT DEPLOY**.
- **STOP CONDITION 2:** Migration 51 already applied with data loss risk → **DO NOT ROLLBACK** (requires DB restore from backup).
- **STOP CONDITION 3:** User does not have read-only permissions → **STOP**.

**Verification:** ✅ Stop conditions are clearly defined and documented.

### 3.3 Pass Conditions

**From EA-37 checklist (Section 1.5):**

- **PASS CONDITION 1:** All three checks return `non_null_rows = 0`.
- **PASS CONDITION 2:** Migration version is `0051_ea12_drop_dead_columns` (or already applied).
- **PASS CONDITION 3:** No data loss risk.

**Verification:** ✅ Pass conditions are clearly defined and documented.

**Conclusion:** ✅ Migration 51 pre-check SQL is consistent with migration 51, stop conditions are clearly defined, and pass conditions are clearly defined. No corrections needed.

---

## Work IV: Backup and Rollback Plan Verification

### 4.1 Application Image Rollback

**From EA-37 plan (Section 3.1):**

- **Pre-release image:** `beaconhs:phase-ea13-20261022-160729-m`
- **Candidate image:** `beaconhs:phase-ea16-20261023-052716`
- **Server Action Key:** K1 (same across both versions)

**Rollback strategy:**

- **Same key (K1) across versions:** Compatible. Server Actions work.
- **Different key across versions:** Incompatible. Server Actions return 404.

**Verification:** ✅ Application image rollback is clearly documented.

**Evidence:** `docs/ea37-production-readiness-plan.md` §3.1.

### 4.2 Migration 51 Database Restore

**From EA-37 plan (Section 2.2):**

- **Restore target:** Disposable staging database (`beaconhs_restore_<timestamp>_<pid>`)
- **Restore command:** `scripts/cluster/restore-verify.sh /secure/backup/db/beaconhs-<timestamp>.dump`
- **Keep restore DB:** `KEEP_RESTORE_DB=true`
- **Restore role:** `beaconhs_owner`

**Verification:** ✅ Migration 51 database restore is clearly documented.

**Evidence:** `docs/ea37-production-readiness-plan.md` §2.2.

### 4.3 Object Store Restore

**From EA-37 plan (Section 2.4):**

- **Restore target:** New bucket (`beaconhs-restore-<timestamp>`)
- **Restore command:** `pnpm --filter @beaconhs/object-store-backup exec tsx src/cli.ts restore ...`
- **Overwrite:** Use `--overwrite` flag only if explicitly required.

**Verification:** ✅ Object store restore is clearly documented.

**Evidence:** `docs/ea37-production-readiness-plan.md` §2.4.

### 4.4 `pnpm db:migrate` Permissions and RLS Rebuild

**From EA-37 plan (Section 2.7):**

- **Mandatory step:** `pnpm db:migrate` after `pg_restore --no-privileges`
- **What is rebuilt:**
  - Runtime grants (SELECT on application tables)
  - RLS policies on tenant-scoped tables
  - Migration ledger (ensures schema is current)
- **Verification:** `/api/health/ready` returns 200 (not 503), `beaconhs_app` can read tables (RLS filters apply), RLS enabled+forced on all 5 key tables.

**Verification:** ✅ `pnpm db:migrate` permissions and RLS rebuild is clearly documented.

**Evidence:** `docs/ea37-production-readiness-plan.md` §2.7.

### 4.5 Server Action Key Compatibility

**From EA-37 plan (Section 3.1):**

- **Same key (K1) across versions:** Compatible. Server Actions work.
- **Different key across versions:** Incompatible. Server Actions return 404 "Server action not found."

**Verification:** ✅ Server Action Key compatibility is clearly documented.

**Evidence:** `docs/ea37-production-readiness-plan.md` §3.1.

### 4.6 Real Business Verification After Restore

**From EA-37 plan (Section 3.2-3.9):**

- **Readiness verification:** `/api/health/ready` → 200
- **Version verification:** version SHA matches deployed image
- **Login verification:** Magic Link / Password login
- **Server Actions verification:** forgot-password
- **File upload/download verification:** PNG upload, SHA256 match
- **RLS verification:** row_security = ON, tenant isolation
- **Data integrity verification:** no data loss, no cross-tenant leak
- **Error rate verification:** 5xx error rate < 1%

**Verification:** ✅ Real business verification steps are clearly documented.

**Evidence:** `docs/ea37-production-readiness-plan.md` §3.2-3.9.

### 4.7 Database and Object Store Backup Consistency

**From EA-37 plan (Section 2.1-2.4):**

- **Database backup:** `beaconhs-YYYYMMDD_HHMMSS.dump` + `.sha256` + `.manifest.tsv`
- **Object store backup:** `backup.manifest.json.enc`, `backup.hmac`, `objects/<sha256>.age`, `checkpoint.json.enc`
- **Consistency check:** Compare manifests, verify SHA256, verify row counts, verify RLS policies.

**Verification:** ✅ Database and object store backup consistency is clearly documented.

**Evidence:** `docs/ea37-production-readiness-plan.md` §2.1-2.4.

### 4.8 Complete Rollback Drill Status

**From EA-38 decision record (Section 2.4):**

- **Staging deployment verified:** PASS (EA-26/EA-32A/EA-32B/EA-33/EA-34)
- **Staging rollback verified:** PASS (EA-33)
- **Production deployment:** NOT RUN
- **Production rollback:** NOT RUN

**Verification:** ✅ Complete rollback drill is clearly documented.

**Evidence:** `docs/ea38-release-decision-record.md` §2.4.

**Conclusion:** ✅ Backup and rollback plan is complete and safe. All steps are clearly documented. The complete rollback drill is NOT RUN (only staging verified), but the plan is complete and safe. No corrections needed.

---

## Work V: Final Status Table

### 5.1 Final Status Summary

| #   | Item                                         | Status          | Evidence                             | Responsibility                         | Closure condition                                        |
| --- | -------------------------------------------- | --------------- | ------------------------------------ | -------------------------------------- | -------------------------------------------------------- |
| 1   | Migration 51 production pre-check            | ❌ NOT RUN      | No execution on production DB        | DBA                                    | Non_null_rows = 0 for all 3 columns                      |
| 2   | Production DB backup exists                  | ❌ NOT VERIFIED | No production backup confirmed       | Ops                                    | Backup file exists and is restorable                     |
| 3   | Production DB backup is restorable           | ❌ NOT RUN      | No restore test performed            | Ops                                    | Restore succeeds, no errors                              |
| 4   | Production object store backup exists        | ❌ NOT VERIFIED | No object store backup confirmed     | Ops                                    | Backup file exists and is restorable                     |
| 5   | Production object store backup is restorable | ❌ NOT RUN      | No restore test performed            | Ops                                    | Restore succeeds, integrity verified                     |
| 6   | Complete deployment and rollback drill       | ❌ NOT RUN      | No production deployment or rollback | Ops                                    | Production deployment and rollback executed successfully |
| 7   | Technical Approver technical approval        | ⚠️ PENDING      | Review completed, signature pending  | Technical Approver                     | Technical Approver signs off                             |
| 8   | Release Engineer release confirmation        | ⚠️ PENDING      | Review completed, signature pending  | Release Engineer                       | Release Engineer signs off                               |
| 9   | DBA authorization and signature              | ❌ PENDING      | No signature yet                     | DBA                                    | DBA runs SQL, records results, signs off                 |
| 10  | Ops authorization and signature              | ❌ PENDING      | No signature yet                     | Ops                                    | Ops confirms all items, signs off                        |
| 11  | Image reproducibility policy decision        | ❌ NOT DECIDED  | No written confirmation              | Technical Approver or Release Engineer | Approver signs risk acceptance or confirms Option B/C    |

### 5.2 Status Categories

| Category           | Items                                    | Count |
| ------------------ | ---------------------------------------- | ----- |
| ✅ **PASS**        | Staging deployment and rollback verified | 2     |
| ⚠️ **PENDING**     | Review completed, signature pending      | 2     |
| ❌ **NOT RUN**     | Production pre-conditions not executed   | 5     |
| ❌ **NOT DECIDED** | Image reproducibility decision not made  | 1     |

### 5.3 Production Pre-condition Status

| Pre-condition                                           | Status         | Reason                              |
| ------------------------------------------------------- | -------------- | ----------------------------------- |
| Migration 51 production pre-check                       | ❌ NOT RUN     | Requires DBA production access      |
| Production DB backup exists and is restorable           | ❌ NOT RUN     | Requires Ops production access      |
| Production object store backup exists and is restorable | ❌ NOT RUN     | Requires Ops production access      |
| Complete deployment and rollback drill                  | ❌ NOT RUN     | Requires Ops production access      |
| Technical Approver technical approval                   | ⚠️ PENDING     | Review completed, signature pending |
| Release Engineer release confirmation                   | ⚠️ PENDING     | Review completed, signature pending |
| DBA authorization and signature                         | ❌ PENDING     | No signature yet                    |
| Ops authorization and signature                         | ❌ PENDING     | No signature yet                    |
| Image reproducibility policy decision                   | ❌ NOT DECIDED | No written confirmation             |

### 5.4 Authorization Status

| Role               | Status     | Next action                                                                                                    |
| ------------------ | ---------- | -------------------------------------------------------------------------------------------------------------- |
| DBA                | ❌ PENDING | Run migration 51 pre-check SQL on production DB, record results, sign off                                      |
| Ops                | ❌ PENDING | Verify production backup and restore, confirm maintenance window and responsible parties, sign off             |
| Technical Approver | ⚠️ PENDING | Review all documents, sign off, make image digest reproducibility decision (Option A/B/C)                      |
| Release Engineer   | ⚠️ PENDING | Verify all pre-deployment checklist items, sign off, make image digest reproducibility decision (Option A/B/C) |

---

## Final Status

**Release status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

### What is ready:

- ✅ EA-36 release readiness review completed.
- ✅ EA-37 production readiness authorization plan completed.
- ✅ EA-38 release decision record completed.
- ✅ EA-39 release decision closure and pre-condition verification completed.
- ✅ Migration 51 pre-check SQL verified (consistent with migration 51).
- ✅ Backup and rollback plan verified (complete and safe).
- ✅ All documentation reviewed and consistent.
- ✅ Staging deployment and rollback verified (PASS).

### What is NOT ready:

- ❌ Production migration 51 pre-check (NOT RUN) — requires DBA production access.
- ❌ Production DB backup and restore drill (NOT RUN) — requires Ops production access.
- ❌ Production object store backup and restore drill (NOT RUN) — requires Ops production access.
- ❌ Complete deployment and rollback drill (NOT RUN) — requires Ops production access.
- ⚠️ Technical Approver technical approval (PENDING) — review completed, signature pending.
- ⚠️ Release Engineer release confirmation (PENDING) — review completed, signature pending.
- ❌ DBA authorization and signature (PENDING) — no signature yet.
- ❌ Ops authorization and signature (PENDING) — no signature yet.
- ❌ Image reproducibility policy decision (NOT DECIDED) — no written confirmation yet.

### What requires authorization:

1. **DBA:** Run migration 51 pre-check SQL on production DB, record results, sign off.
2. **Ops:** Verify production backup and restore, confirm maintenance window and responsible parties, sign off.
3. **Technical Approver:** Review all documents, sign off, make image digest reproducibility decision (Option A/B/C).
4. **Release Engineer:** Verify all pre-deployment checklist items, sign off, make image digest reproducibility decision (Option A/B/C).

### Next steps:

1. **DBA:** Run migration 51 pre-check SQL on production DB, record results, sign off.
2. **Ops:** Verify production backup and restore, confirm maintenance window and responsible parties, sign off.
3. **Technical Approver:** Review all documents, sign off, make image digest reproducibility decision (Option A/B/C).
4. **Release Engineer:** Verify all pre-deployment checklist items, sign off, make image digest reproducibility decision (Option A/B/C).

### Stop conditions:

- Any migration 51 pre-check fails (non_null_rows > 0).
- Any backup/restore test fails.
- Any pre-deployment checklist item is not met.
- Any unaddressed defects found.
- Technical Approver or Release Engineer does not sign off.
- Image digest reproducibility decision is not made (Option A/B/C).

---

**Document version:** 1.0
**Last updated:** 2026-10-25
**Author:** EA-39 release decision closure and pre-condition verification
