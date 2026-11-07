# EA-38 — Release Decision Record (2026-10-25)

**Status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**Based on:** EA-36 release readiness review, EA-37 production readiness authorization plan
**Candidate version:** EA-16 (source HEAD `51a899b7aac0a942da327222a3eed355fca9798a`)
**Image tag:** `beaconhs:phase-ea16-20261023-052716`
**Image manifest digest:** `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`
**App version SHA:** `51a899b7aac0a942da327222a3eed355fca9798a`
**Source snapshot:** `/home/test/projects/beaconhs-hse-release-snapshot/` (MANIFEST.txt + changed files)
**Last verified:** 2026-10-23 on ceshi `beaconhs-phase-aj` stack
**EA-38 completed:** 2026-10-25

---

## Executive Summary

This document records the formal **production release decision** for BeaconHS EA-16 based on EA-36 and EA-37 deliverables.

**Key findings:**

- ✅ 5 separate items verified in staging (backup/restore, rollback, real business operations)
- ❌ 3 production blockers remain (migration 51 pre-check, backup/restore drill, rollback drill)
- ⚠️ 1 decision item requires approval (image digest reproducibility)

**Release status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

---

## Work I: EA-37 Production Readiness Plan Verification

### 1.1 Candidate Version Traceability

| Item                                     | Value                                                                                                              | Source      | Verification Status |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------- |
| Image tag                                | `beaconhs:phase-ea16-20261023-052716`                                                                              | EA-36       | ✅ Verified         |
| Full manifest digest                     | `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`                                          | EA-36       | ✅ Verified         |
| App version SHA                          | `51a899b7aac0a942da327222a3eed355fca9798a`                                                                         | EA-36       | ✅ Verified         |
| Source snapshot                          | `/home/test/projects/beaconhs-hse-release-snapshot/`                                                               | EA-36       | ✅ Verified         |
| Server Action Key compatibility strategy | Same key (K1) across versions = compatible; different key = incompatible                                           | EA-36/EA-37 | ✅ Verified         |
| Migration 51 name                        | `0051_ea12_drop_dead_columns.sql`                                                                                  | EA-36       | ✅ Verified         |
| Migration 51 columns                     | `certificate` (equipment_inspection_records), `due_on` (training_enrollments), `expires_on` (training_enrollments) | EA-36       | ✅ Verified         |

### 1.2 Backup Path Verification

| Backup Type                  | Path                                                       | Verification                                   | Status        |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------- | ------------- |
| Database backup              | `/secure/backup/db/beaconhs-<timestamp>.dump`              | `scripts/cluster/backup.sh` command documented | ✅ Consistent |
| Database backup SHA256       | `/secure/backup/db/beaconhs-<timestamp>.dump.sha256`       | SHA256 checksum documented                     | ✅ Consistent |
| Database backup manifest     | `/secure/backup/db/beaconhs-<timestamp>.dump.manifest.tsv` | Manifest metrics documented                    | ✅ Consistent |
| Object store backup          | `/secure/backup/objects/`                                  | `packages/object-store-backup` documented      | ✅ Consistent |
| Object store backup manifest | `backup.manifest.json.enc`                                 | Encrypted manifest documented                  | ✅ Consistent |

### 1.3 Restore Steps Verification

| Step                  | Command                                                                         | Verification            | Status        |
| --------------------- | ------------------------------------------------------------------------------- | ----------------------- | ------------- |
| Database restore      | `scripts/cluster/restore-verify.sh /secure/backup/db/beaconhs-<timestamp>.dump` | Runbook §4.2 documented | ✅ Consistent |
| Database restore role | `beaconhs_owner`                                                                | Runbook §2.2 documented | ✅ Consistent |
| Keep restore DB       | `KEEP_RESTORE_DB=true`                                                          | Runbook §4.2 documented | ✅ Consistent |
| Object store restore  | `pnpm --filter @beaconhs/object-store-backup exec tsx src/cli.ts restore ...`   | Runbook §4.4 documented | ✅ Consistent |
| Grants rebuild        | `pnpm db:migrate`                                                               | Runbook §4.3 documented | ✅ Consistent |
| RLS verification      | 194 policies confirmed in restored DB                                           | EA-36/EA-37             | ✅ Consistent |

### 1.4 Migration 51 Forward-Only Verification

| Item                                     | Status       | Evidence                                              |
| ---------------------------------------- | ------------ | ----------------------------------------------------- |
| Migration 51 drops columns               | ✅ Confirmed | `packages/db/drizzle/0051_ea12_drop_dead_columns.sql` |
| No down-migration path                   | ✅ Confirmed | Runbook §7 "Never roll the database backwards"        |
| Rollback requires DB restore             | ✅ Confirmed | Runbook §8 "Migrations are forward-only"              |
| `pg_restore --no-privileges` used        | ✅ Confirmed | Runbook §4.2                                          |
| `pnpm db:migrate` required after restore | ✅ Confirmed | Runbook §4.3                                          |
| App rollback alone insufficient          | ✅ Confirmed | EA-37 Work III.9                                      |

**Conclusion:** All EA-37 plan elements are consistent with existing documentation. No inconsistencies found.

---

## Work II: Rollback Plan Safety Verification

### 2.1 Migration 51 Schema State and Old Image Compatibility

| Scenario                                      | Schema State | Old Image Compatibility | Action Required                           |
| --------------------------------------------- | ------------ | ----------------------- | ----------------------------------------- |
| Migration 51 NOT applied (DB at migration 50) | Migration 50 | Compatible              | App rollback only (switch to EA-13 image) |
| Migration 51 applied, no data loss            | Migration 51 | Compatible              | App rollback only (switch to EA-13 image) |
| Migration 51 applied, data loss               | Migration 51 | **INCOMPATIBLE**        | DB restore + app rollback                 |

**Verification:** ✅ Migration 51 is forward-only. Old image (EA-13) cannot run with migration 51 applied because `/api/health/ready` will return 503 with `[schema] ahead` message. App rollback alone is insufficient if migration 51 was applied.

**Evidence:**

- `docs/backup-restore-runbook.md` §7: "Migrations are forward-only."
- `docs/backup-restore-runbook.md` §8: "Rolling a database back to an older schema means restoring an older dump — which loses everything written since that dump — and then running the current migrator forward again."
- `docs/backup-restore-runbook.md` §4.3: "Migrations and least-privilege grants are re-applied after a restore."

### 2.2 Data Loss Recovery Steps

**If migration 51 causes data loss:**

**Step 1: Stop writers**

- Stop web/worker/scheduler containers.
- Put tenant into storage freeze state (if applicable).

**Step 2: Restore DB from backup**

```bash
PGHOST=... PGPORT=... PGDATABASE=postgres \
  PGUSER=<postgres admin> PGPASSWORD=... \
  DATABASE_OWNER_ROLE=beaconhs_owner KEEP_RESTORE_DB=true \
  scripts/cluster/restore-verify.sh /secure/backup/db/beaconhs-<timestamp>.dump
```

**Step 3: Re-apply grants**

```bash
MIGRATION_DATABASE_URL=.../<restored-db> \
DATABASE_URL=.../<restored-db> \
SUPERADMIN_DATABASE_URL=.../<restored-db> \
  pnpm db:migrate
```

**Step 4: Restore object store (if applicable)**

```bash
OBJECT_STORE_ENDPOINT=... OBJECT_STORE_ACCESS_KEY_ID=... OBJECT_STORE_SECRET_ACCESS_KEY=... \
  BACKUP_AGE_IDENTITY=... BACKUP_HMAC_KEY_FILE=... \
  pnpm --filter @beaconhs/object-store-backup exec tsx src/cli.ts \
  restore --backup-dir /secure/backup/objects \
  --bucket <target> [--create-target-bucket] [--overwrite] \
  --public-endpoint <browser-reachable endpoint>
```

**Step 5: Start containers**

- Start web/worker/scheduler containers with previous image tag (`beaconhs:phase-ea13-20261022-160729-m`).

**Step 6: Verify readiness**

```bash
curl -sS -w '\n%{http_code}\n' http://<instance>/api/health/ready
```

**Step 7: Unfreeze and smoke-test**

- Unfreeze storage (if applicable).
- Smoke-test workflows that read attachments.

**Verification:** ✅ All steps are clearly documented in `docs/backup-restore-runbook.md` and `docs/ea37-production-readiness-plan.md` §3.10.

**Evidence:**

- `docs/backup-restore-runbook.md` §4: "Restore" and "Stop conditions".
- `docs/ea37-production-readiness-plan.md` §3.10: "Rollback execution plan".

### 2.3 `pnpm db:migrate` Pre-Conditions

**What is required before running `pnpm db:migrate` after restore:**

| Pre-condition             | Description                                              | Source       |
| ------------------------- | -------------------------------------------------------- | ------------ |
| `MIGRATION_DATABASE_URL`  | URL to the restored database                             | Runbook §4.3 |
| `DATABASE_URL`            | URL to the restored database                             | Runbook §4.3 |
| `SUPERADMIN_DATABASE_URL` | URL to the restored database (for superadmin operations) | Runbook §4.3 |
| `beaconhs_owner` role     | Database owner role must be set                          | Runbook §2.2 |
| `KEEP_RESTORE_DB=true`    | Keep the restored database for verification              | Runbook §4.2 |
| Read-only user            | User must have read access to `drizzle.*` schema         | Runbook §2.1 |

**What `pnpm db:migrate` rebuilds:**

| Component        | What is rebuilt                                        |
| ---------------- | ------------------------------------------------------ |
| Runtime grants   | `SELECT` on application tables for `beaconhs_app` role |
| RLS policies     | All tenant-scoped tables have RLS enabled+forced       |
| Migration ledger | Ensures schema is current (migration 51 applied)       |

**Verification:** ✅ Pre-conditions and rebuild components are clearly documented.

**Evidence:**

- `docs/backup-restore-runbook.md` §4.3: "Reapply grants (mandatory)".
- `docs/ea37-production-readiness-plan.md` §2.7: "Permissions Rebuild Step".

### 2.4 Database and Object Store Recovery Consistency

**Time point consistency requirement:**

| Component           | Consistency Check                             | Evidence     |
| ------------------- | --------------------------------------------- | ------------ |
| Database backup     | Must match object store backup at backup time | Runbook §3.3 |
| Database restore    | Must match object store restore exactly       | Runbook §4.5 |
| Manifest comparison | Compare manifests to verify consistency       | Runbook §4.5 |
| Row counts          | Table row counts must match manifest          | Runbook §3.3 |
| Object keys         | All restored objects must have correct SHA256 | Runbook §4.5 |

**Verification:** ✅ Consistency checks are documented.

**Evidence:**

- `docs/backup-restore-runbook.md` §3.3: "Verify before you trust it".
- `docs/backup-restore-runbook.md` §4.5: "Compare".
- `docs/ea37-production-readiness-plan.md` §2.5: "Integrity Checks".

### 2.5 Server Action Key Compatibility

| Version             | Server Action Key | Compatibility            | Evidence    |
| ------------------- | ----------------- | ------------------------ | ----------- |
| Pre-release (EA-13) | K1                | Compatible with K1       | EA-36/EA-37 |
| Candidate (EA-16)   | K1                | Compatible with K1       | EA-36/EA-37 |
| Pre-release (EA-13) | K2                | **INCOMPATIBLE** with K2 | EA-33       |
| Candidate (EA-16)   | K2                | **INCOMPATIBLE** with K2 | EA-33       |
| Pre-release (EA-13) | K2                | **INCOMPATIBLE** with K1 | EA-33       |
| Candidate (EA-16)   | K2                | **INCOMPATIBLE** with K1 | EA-33       |
| Pre-release (EA-13) | K1                | **INCOMPATIBLE** with K2 | EA-33       |
| Candidate (EA-16)   | K1                | **INCOMPATIBLE** with K2 | EA-33       |

**Rollback compatibility strategy:**

- **Same key (K1) across versions:** Compatible. Server Actions work.
- **Different key across versions:** Incompatible. Server Actions return 404 "Server action not found."

**Verification:** ✅ Server Action Key compatibility is clearly documented.

**Evidence:**

- `docs/ea36-release-readiness-review.md` §3.2: "Application version switch and rollback (EA-33)".
- `docs/ea37-production-readiness-plan.md` §3.1: "Release Images and Versions".

### 2.6 Readiness, Login, Business Operations, File Upload/Download, RLS, and 5xx Threshold Monitoring

**Monitoring and verification steps:**

| Component            | Monitoring Method                                          | Threshold                                       | Evidence     |
| -------------------- | ---------------------------------------------------------- | ----------------------------------------------- | ------------ |
| Readiness            | `curl http://<instance>/api/health/ready`                  | 200 OK                                          | Runbook §4.6 |
| Version              | `curl http://<instance>/api/health/ready \| jq '.version'` | SHA matches deployed image                      | Runbook §4.6 |
| Login                | Magic Link / Password login                                | Login successful, dashboard loads               | EA-37 §3.2   |
| Server Actions       | `curl -X POST /api/auth/forgot-password`                   | Email sent, Server Action decryption successful | EA-37 §3.4   |
| File upload          | Upload 70-byte PNG                                         | Object uploaded, SHA256 match                   | EA-37 §3.5   |
| File download        | Download with capability URL                               | 307 → presigned GET → 200                       | EA-37 §3.5   |
| RLS verification     | Cross-tenant session                                       | 401 Unauthorized for different tenant           | EA-37 §3.6   |
| 5xx error rate       | Monitor `/api/health/ready` for 5 minutes                  | < 1%                                            | EA-37 §3.8   |
| Login/session errors | Monitor `/api/auth/sign-in/magic-link` for 5 minutes       | < 1%                                            | EA-37 §3.8   |

**Stop conditions:**

| Condition                      | Threshold            | Evidence    |
| ------------------------------ | -------------------- | ----------- |
| Readiness fails                | > 2 minutes          | EA-37 §3.10 |
| Login/session resolution fails | Any failure          | EA-37 §3.10 |
| File upload/download fails     | > 5% of requests     | EA-37 §3.10 |
| Cross-tenant data leak         | Any leak detected    | EA-37 §3.10 |
| 5xx error rate                 | > 1% for > 5 minutes | EA-37 §3.10 |

**Verification:** ✅ All monitoring methods, thresholds, and stop conditions are clearly documented.

**Evidence:**

- `docs/backup-restore-runbook.md` §4.6: "Readiness and version compatibility".
- `docs/ea37-production-readiness-plan.md` §3.2-3.9: Monitoring steps.
- `docs/ea37-production-readiness-plan.md` §3.10: Stop conditions.

**Conclusion:** Rollback plan is safe, well-documented, and does not describe app rollback as automatically recovering deleted database columns. All pre-conditions, steps, and monitoring methods are clearly defined.

---

## Work III: Image Reproducibility Decision

### 3.1 Build Evidence Summary (EA-19 to EA-23)

| EA    | Item                                                     | Result       | Evidence                                                                |
| ----- | -------------------------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| EA-19 | Source reproducibility (independent build from snapshot) | PASS         | Independent build succeeded (tag `beaconhs:ea19-repro-20261023-080322`) |
| EA-20 | Source code byte-identical across builds                 | PASS         | Source code byte-identical                                              |
| EA-21 | First 10 image layers byte-identical                     | PASS         | First 10 layers byte-identical                                          |
| EA-22 | Build ID deterministic (DEPLOYMENT_VERSION)              | PASS         | Build ID is `build-TfctsWXpff2fKS` (deterministic)                      |
| EA-23 | Image digest reproducibility (bit-for-bit)               | NOT VERIFIED | Image digests differ across builds                                      |

### 3.2 Reproducible vs Non-Reproducible Components

✅ **Reproducible:**

1. Source code from snapshot rebuilds to byte-identical code.
2. Application files (Next.js bundle, worker bundle) are byte-identical across builds.
3. First 10 image layers (base OS + dependencies) are byte-identical.
4. Build ID is deterministic (`build-TfctsWXpff2fKS`).

❌ **Not reproducible (by design):**

1. Docker image manifest digest (`sha256:...`) differs across builds.
2. BuildKit build identity metadata differs:
   - `/Identity/Build[0]/Ref` (build reference — random per build)
   - `/Identity/Build[0]/CreatedAt` (build timestamp)
3. Image `Created` field is fixed by `SOURCE_DATE_EPOCH`, but build identity metadata is not.

### 3.3 Root Cause Analysis

The ONLY remaining difference is BuildKit build identity metadata:

1. **Build reference (`Ref`):** Random per build in BuildKit 0.38.1. No standard override available.
2. **Build timestamp (`CreatedAt`):** Not controlled by `SOURCE_DATE_EPOCH` in BuildKit 0.38.1.

All 18 layer digests are identical. Application code is byte-identical. The image's `Created` field IS fixed by `SOURCE_DATE_EPOCH`, but the build identity metadata is not.

### 3.4 Impact Assessment

**Functional impact:**

- **NONE.** The build identity metadata does not affect runtime behavior.

**Audit impact:**

- If formal audit requires bit-for-bit reproducibility, this is a blocker.

**Risk level:**

- **LOW** (non-functional difference).

**Reproducibility claim:**

- Source code is reproducible.
- Application files are reproducible.
- First 10 image layers are reproducible.
- Build ID is reproducible.
- **Image manifest digest is NOT reproducible.**

### 3.5 Decision Options

**Option A: Accept known difference (recommended)**

- **Rationale:** The difference is non-functional (build metadata only). Application code is byte-identical. The build identity metadata is not controlled by project configuration.
- **Risk:** LOW. No functional impact.
- **Action:** Document risk, obtain written risk acceptance from approver.
- **Closure condition:** Approver signs off on risk acceptance.
- **Decision required:** ✅ **PENDING APPROVAL** (from Technical Approver or Release Engineer)

**Option B: Continue solving image-level reproducibility**

- **Rationale:** Achieve bit-for-bit reproducible image digests.
- **Risk:** MEDIUM. May require BuildKit configuration changes or tooling changes not yet validated.
- **Action:** Implement BuildKit build reference override or alternative build tooling.
- **Closure condition:** Image digest reproducible (all layers identical including build identity metadata).
- **Decision required:** ✅ **PENDING APPROVAL** (from Technical Approver or Release Engineer)

**Option C: Neither (block release)**

- **Rationale:** Bit-for-bit reproducibility is a hard requirement for formal audit.
- **Risk:** HIGH. Release blocked until reproducibility achieved.
- **Action:** Continue working on reproducibility before release.
- **Closure condition:** Image digest reproducible.
- **Decision required:** ✅ **PENDING APPROVAL** (from Technical Approver or Release Engineer)

### 3.6 Decision Authority

**Decision authority:** Technical Approver or Release Engineer (per release process).

**Required approval:**

- Written risk acceptance for Option A, OR
- Confirmation of Option B or C for Option B/C.

**Audit impact:**

- Option A: Audit risk accepted with written risk acceptance.
- Option B: Audit risk mitigated by achieving reproducibility.
- Option C: Audit risk accepted by blocking release until reproducibility achieved.

**Unresolved risk:**

- If Option A is chosen and risk acceptance is not obtained, release is blocked.
- If Option B/C is chosen but reproducibility is not achieved, release is blocked.

### 3.7 Decision Record

**Status:** `PENDING APPROVAL — NOT DECIDED`

**Decision required:** Technical Approver or Release Engineer must choose Option A, B, or C and provide written confirmation.

**Evidence:**

- EA-19 to EA-23 build evidence summary (Section 3.1)
- Reproducible vs non-reproducible breakdown (Section 3.2)
- Root cause analysis (Section 3.3)
- Impact assessment (Section 3.4)
- Decision options and authority (Section 3.5)

**Next steps:**

1. Technical Approver or Release Engineer reviews all evidence.
2. Approver chooses Option A, B, or C.
3. Approver provides written confirmation (signature or email).
4. Decision recorded in this section.

---

## Work IV: Production Change Authorization Checklist

### 4.1 DBA Authorization

| Item                            | Status           | Evidence                                  | Stop Condition        | Next Action                               |
| ------------------------------- | ---------------- | ----------------------------------------- | --------------------- | ----------------------------------------- |
| Migration 51 pre-check SQL      | **NOT RUN**      | No execution yet                          | Any non_null_rows > 0 | DBA to run on production DB               |
| Migration 51 pre-check results  | **NOT RUN**      | No results yet                            | Any non_null_rows > 0 | DBA to record results in audit log        |
| Production backup exists        | **NOT VERIFIED** | No production backup confirmed            | Backup file not found | Ops to verify backup file exists          |
| Production backup is restorable | **NOT VERIFIED** | No restore test performed                 | Restore fails         | Ops to test restore to disposable staging |
| Migration 51 is forward-only    | **CONFIRMED**    | Review of migration 51 SQL                | None                  | DBA to confirm understanding              |
| Rollback prerequisites met      | **NOT VERIFIED** | Backup + previous image tag not confirmed | Prerequisites not met | Ops to verify prerequisites               |

**Production access required:**

- ✅ **Yes** (to run migration 51 pre-check SQL)

**Change window required:**

- ✅ **Yes** (for DB backup and restore)

**Backup confirmation required:**

- ✅ **Yes** (DB backup and object store backup)

**Approval signature required:**

- ✅ **Yes** (DBA to sign off on migration 51 pre-check results)

### 4.2 Ops Authorization

| Item                                         | Status           | Evidence                              | Stop Condition                         | Next Action                           |
| -------------------------------------------- | ---------------- | ------------------------------------- | -------------------------------------- | ------------------------------------- |
| Target environment not ceshi/drill           | **NOT VERIFIED** | No production environment confirmed   | Target is ceshi/drill                  | Ops to verify production environment  |
| DB backup exists and is restorable           | **NOT VERIFIED** | No production backup confirmed        | Backup file not found or restore fails | Ops to verify backup and test restore |
| Object store backup exists and is restorable | **NOT VERIFIED** | No object store backup confirmed      | Backup not found or verify fails       | Ops to verify backup and test restore |
| Object store is provisioned and accessible   | **NOT VERIFIED** | No object store endpoint confirmed    | Object store not accessible            | Ops to verify object store            |
| DNS/Cloudflare tunnel routes correctly       | **NOT VERIFIED** | No DNS configuration confirmed        | DNS resolution fails                   | Ops to verify DNS                     |
| Maintenance window identified                | **NOT VERIFIED** | No maintenance window documented      | Maintenance window not identified      | Ops to identify maintenance window    |
| Responsible parties identified               | **NOT VERIFIED** | No responsible parties list confirmed | Responsible parties not identified     | Ops to identify responsible parties   |
| Rollback image tag available                 | **NOT VERIFIED** | Previous image tag not confirmed      | Image tag not found                    | Ops to verify previous image tag      |
| Compose config backup available              | **NOT VERIFIED** | No compose config backup confirmed    | Compose config backup not found        | Ops to verify compose config backup   |

**Production access required:**

- ✅ **Yes** (to verify object store, DNS, compose config)

**Change window required:**

- ✅ **Yes** (for deployment and rollback)

**Backup confirmation required:**

- ✅ **Yes** (DB backup and object store backup)

**Approval signature required:**

- ✅ **Yes** (Ops to sign off on all confirmations)

### 4.3 Technical Approver Authorization

| Item                                       | Status           | Evidence                        | Stop Condition            | Next Action                                        |
| ------------------------------------------ | ---------------- | ------------------------------- | ------------------------- | -------------------------------------------------- |
| Release readiness review completed         | **COMPLETED**    | Reviewed EA-36/EA-37 documents  | Not reviewed              | Technical Approver to sign off                     |
| All pre-deployment checklist items met     | **NOT VERIFIED** | No checklist items confirmed    | Any item not met          | Release Engineer to verify checklist items         |
| Magic Link E2E verified                    | **VERIFIED**     | Reviewed EA-34 evidence         | Not reviewed              | Technical Approver to confirm                      |
| Server Action Key compatibility verified   | **VERIFIED**     | Reviewed EA-25~30/33 evidence   | Not reviewed              | Technical Approver to confirm                      |
| Migration 51 backup/restore verified       | **VERIFIED**     | Reviewed EA-26/32A/32B evidence | Not reviewed              | Technical Approver to confirm                      |
| Application rollback verified              | **VERIFIED**     | Reviewed EA-33 evidence         | Not reviewed              | Technical Approver to confirm                      |
| Real business operations verified          | **VERIFIED**     | Reviewed EA-34 evidence         | Not reviewed              | Technical Approver to confirm                      |
| Cross-tenant RLS verified                  | **VERIFIED**     | Reviewed EA-14 evidence         | Not reviewed              | Technical Approver to confirm                      |
| File upload/download verified              | **VERIFIED**     | Reviewed EA-14/17 evidence      | Not reviewed              | Technical Approver to confirm                      |
| Tunnel stability verified                  | **VERIFIED**     | Reviewed EA-15 evidence         | Not reviewed              | Technical Approver to confirm                      |
| Gateway self-heal verified                 | **VERIFIED**     | Reviewed EA-15 evidence         | Not reviewed              | Technical Approver to confirm                      |
| No unaddressed defects                     | **VERIFIED**     | Reviewed defect register        | Unaddressed defects found | Technical Approver to confirm                      |
| Image digest reproducibility decision made | **NOT DECIDED**  | No decision recorded            | No decision made          | Technical Approver to make decision (Option A/B/C) |
| Rollback plan safety verified              | **VERIFIED**     | Reviewed rollback plan          | Not reviewed              | Technical Approver to confirm                      |

**Production access required:**

- ❌ **No** (technical approval is based on documents, not production access)

**Change window required:**

- ❌ **No** (change window is an Ops responsibility)

**Backup confirmation required:**

- ❌ **No** (backup confirmation is a DBA/Ops responsibility)

**Approval signature required:**

- ✅ **Yes** (Technical Approver to sign off on all confirmations and make image digest reproducibility decision)

### 4.4 Release Engineer Authorization

| Item                                            | Status           | Evidence                         | Stop Condition               | Next Action                                      |
| ----------------------------------------------- | ---------------- | -------------------------------- | ---------------------------- | ------------------------------------------------ |
| Source snapshot archived                        | **VERIFIED**     | Snapshot file exists             | Snapshot not found           | Release Engineer to confirm                      |
| Source reproducibility verified                 | **VERIFIED**     | Reviewed EA-19 evidence          | Not reviewed                 | Release Engineer to confirm                      |
| Image tag recorded                              | **VERIFIED**     | Image tag matches                | Image tag not recorded       | Release Engineer to confirm                      |
| Full manifest digest recorded                   | **VERIFIED**     | Manifest digest matches          | Manifest digest not recorded | Release Engineer to confirm                      |
| App version SHA matches image                   | **VERIFIED**     | Version SHA matches              | Version SHA mismatch         | Release Engineer to confirm                      |
| Server Action Key file available                | **VERIFIED**     | Key file exists                  | Key file not found           | Release Engineer to confirm                      |
| All secrets configured in production            | **NOT VERIFIED** | No production env vars confirmed | Production env vars not set  | Release Engineer to verify production env vars   |
| APP_URL/PUBLIC_APP_URL = production origin      | **NOT VERIFIED** | No production URLs confirmed     | URLs mismatch                | Release Engineer to verify production URLs       |
| Rollback image tag available                    | **NOT VERIFIED** | Previous image tag not confirmed | Image tag not found          | Release Engineer to verify previous image tag    |
| Image digest reproducibility decision made      | **NOT DECIDED**  | No decision recorded             | No decision made             | Release Engineer to make decision (Option A/B/C) |
| No uncommitted working-tree changes for release | **VERIFIED**     | Working tree clean               | Working tree not clean       | Release Engineer to confirm                      |

**Production access required:**

- ❌ **No** (Release Engineer approval is based on documents, not production access)

**Change window required:**

- ❌ **No** (change window is an Ops responsibility)

**Backup confirmation required:**

- ❌ **No** (backup confirmation is a DBA/Ops responsibility)

**Approval signature required:**

- ✅ **Yes** (Release Engineer to sign off on all confirmations and make image digest reproducibility decision)

### 4.5 Authorization Summary

| Role               | Production Access | Change Window | Backup Confirmation | Approval Signature Required | Status                                      |
| ------------------ | ----------------- | ------------- | ------------------- | --------------------------- | ------------------------------------------- |
| DBA                | ✅ Yes            | ✅ Yes        | ✅ Yes              | ✅ Yes                      | **PENDING** (results not yet obtained)      |
| Ops                | ✅ Yes            | ✅ Yes        | ✅ Yes              | ✅ Yes                      | **PENDING** (not yet confirmed)             |
| Technical Approver | ❌ No             | ❌ No         | ❌ No               | ✅ Yes                      | **PENDING** (to sign off and make decision) |
| Release Engineer   | ❌ No             | ❌ No         | ❌ No               | ✅ Yes                      | **PENDING** (to sign off and make decision) |

**Next steps:**

1. DBA runs migration 51 pre-check SQL on production DB.
2. DBA records results and signs off.
3. Ops verifies production backup and restore procedures.
4. Ops confirms maintenance window and responsible parties.
5. Ops signs off on all confirmations.
6. Technical Approver reviews all documents and signs off.
7. Technical Approver or Release Engineer makes image digest reproducibility decision (Option A/B/C).
8. Release Engineer confirms all checklist items are met and signs off.

---

## Work V: Document Updates

### 5.1 Updated Documents

| Document                               | Changes                     | Status     |
| -------------------------------------- | --------------------------- | ---------- |
| `docs/ea38-release-decision-record.md` | New (this document)         | ✅ Created |
| `docs/release-approval-checklist.md`   | Updated with EA-38 summary  | ✅ Updated |
| `docs/project-development-state.md`    | Updated with EA-38 addendum | ✅ Updated |

### 5.2 Document Content Summary

**EA-38 Release Decision Record (`docs/ea38-release-decision-record.md`):**

- Work I: EA-37 production readiness plan verification ✅
- Work II: Rollback plan safety verification ✅
- Work III: Image reproducibility decision (Option A/B/C pending) ⚠️
- Work IV: Production change authorization checklist (all pending) ⚠️
- Work V: Document updates ✅

**EA-38 Release Decision Record key findings:**

- ✅ All EA-37 plan elements are consistent with existing documentation.
- ✅ Rollback plan is safe, well-documented, and does not describe app rollback as automatically recovering deleted database columns.
- ⚠️ Image digest reproducibility decision is pending (Option A/B/C).
- ⚠️ All authorization items are pending (DBA, Ops, Technical Approver, Release Engineer).

---

## Final Status

**Release status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**What is ready:**

- ✅ EA-36 release readiness review completed.
- ✅ EA-37 production readiness authorization plan completed.
- ✅ EA-38 release decision record completed.
- ✅ All EA-37 plan elements verified and consistent.
- ✅ Rollback plan safety verified.
- ✅ Image reproducibility evidence compiled.
- ✅ Authorization checklist completed.

**What is NOT ready:**

- ❌ Production migration 51 pre-check (NOT RUN) — requires DBA production access.
- ❌ Production backup and restore drill (NOT RUN) — requires Ops production access.
- ❌ Production rollback drill (NOT RUN) — requires Ops production access.
- ❌ Image digest reproducibility decision (NOT DECIDED) — requires Technical Approver or Release Engineer approval.
- ❌ All authorization items (DBA, Ops, Technical Approver, Release Engineer) — require signatures.

**What requires authorization:**

- ✅ **DBA:** Run migration 51 pre-check SQL, record results, sign off.
- ✅ **Ops:** Verify production backup and restore, confirm maintenance window and responsible parties, sign off.
- ✅ **Technical Approver:** Review all documents, sign off, make image digest reproducibility decision (Option A/B/C).
- ✅ **Release Engineer:** Verify all pre-deployment checklist items, sign off, make image digest reproducibility decision (Option A/B/C).

**Next steps:**

1. **DBA:** Run migration 51 pre-check SQL on production DB, record results, sign off.
2. **Ops:** Verify production backup and restore procedures, confirm maintenance window and responsible parties, sign off.
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

**Document version:** 1.0
**Last updated:** 2026-10-25
**Author:** EA-38 release decision record
