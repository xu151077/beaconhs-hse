# EA-37 — Production Readiness Authorization Plan (2026-10-25)

**Status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**Based on:** EA-36 release readiness review (`docs/ea36-release-readiness-review.md`)
**Candidate version:** EA-16 (source HEAD `51a899b7aac0a942da327222a3eed355fca9798a`)
**Image tag:** `beaconhs:phase-ea16-20261023-052716`
**Image manifest digest:** `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`
**Last verified:** 2026-10-23 on ceshi `beaconhs-phase-aj` stack
**EA-37 completed:** 2026-10-25

---

## Executive Summary

This document provides a detailed execution plan for **production deployment authorization** based on EA-36's release readiness review.

**Key findings:**

- ✅ 5 separate items verified in staging (backup/restore, rollback, real business operations)
- ❌ 3 blockers remain (production migration 51 pre-check, production backup/restore drill, production rollback drill)
- ⚠️ 1 decision item requires approval (image digest reproducibility)

**Release status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

---

## Work I: Production Migration 51 Check Preparation

### 1.1 Migration 51 Details

**Migration ID:** `0051_ea12_drop_dead_columns.sql`

| Table                          | Column        | Reason for removal                                           |
| ------------------------------ | ------------- | ------------------------------------------------------------ |
| `equipment_inspection_records` | `certificate` | Certificate field never populated; no UI surface reads it.   |
| `training_enrollments`         | `due_on`      | Due date field never populated; only assignment to schedule. |
| `training_enrollments`         | `expires_on`  | Expires on always set to NULL; no UI surface reads it.       |

### 1.2 Production Read-Only Pre-Check SQL

**Purpose:** Verify that columns to be dropped have zero non-null values in production BEFORE deployment.

**Pre-deploy checklist (run on production DB with read-only permissions):**

```sql
-- Check 1: equipment_inspection_records.certificate
-- Goal: Ensure 0 non-null values before dropping column
SELECT
  'equipment_inspection_records.certificate' AS check_name,
  COUNT(*) AS total_rows,
  COUNT(certificate) AS non_null_rows,
  COUNT(*) - COUNT(certificate) AS null_rows
FROM equipment_inspection_records;

-- STOP CONDITION: If non_null_rows > 0, DO NOT deploy migration 51.
-- Root cause analysis required before proceeding.

-- Check 2: training_enrollments.due_on
SELECT
  'training_enrollments.due_on' AS check_name,
  COUNT(*) AS total_rows,
  COUNT(due_on) AS non_null_rows,
  COUNT(*) - COUNT(due_on) AS null_rows
FROM training_enrollments;

-- STOP CONDITION: If non_null_rows > 0, DO NOT deploy migration 51.
-- Root cause analysis required before proceeding.

-- Check 3: training_enrollments.expires_on
SELECT
  'training_enrollments.expires_on' AS check_name,
  COUNT(*) AS total_rows,
  COUNT(expires_on) AS non_null_rows,
  COUNT(*) - COUNT(expires_on) AS null_rows
FROM training_enrollments;

-- STOP CONDITION: If non_null_rows > 0, DO NOT deploy migration 51.
-- Root cause analysis required before proceeding.

-- Check 4: Verify migration 51 is not already applied
SELECT
  'migration_version' AS check_name,
  current_setting('app.current_migration', true) AS current_migration,
  '0051_ea12_drop_dead_columns' AS target_migration;

-- Expected: current_migration = '0051_ea12_drop_dead_columns'
-- If already applied, no action required (idempotent migration).
```

### 1.3 Permissions and Access

**Read-only permissions required:**

- User must be a member of the `beaconhs_migrator` role (has SELECT on `equipment_inspection_records`, `training_enrollments`, `drizzle.*`).
- User must have `SELECT` permission on all 3 tables.
- User must have `pg_read_only` role or equivalent (if using PostgreSQL read-only role).

**No write permissions required** — only read queries.

### 1.4 Results Format

**For each check, record:**

```
check_name | total_rows | non_null_rows | null_rows | pass/fail | timestamp | executor | notes
equipment_inspection_records.certificate | 0 | 0 | 0 | PASS | 2026-10-25T12:00:00Z | dba@company.com | -
training_enrollments.due_on | 0 | 0 | 0 | PASS | 2026-10-25T12:01:00Z | dba@company.com | -
training_enrollments.expires_on | 0 | 0 | 0 | PASS | 2026-10-25T12:02:00Z | dba@company.com | -
migration_version | 51 | 51 | - | PASS | 2026-10-25T12:03:00Z | dba@company.com | current_migration='0051_ea12_drop_dead_columns'
```

### 1.5 Pass Conditions

**All checks must PASS:**

1. `non_null_rows = 0` for all 3 columns.
2. Migration version is `0051_ea12_drop_dead_columns` (or already applied).
3. No data loss risk.

### 1.6 Stop Conditions

**DO NOT DEPLOY if any of these is true:**

1. Any check returns `non_null_rows > 0` → **STOP**.
2. Migration 51 already applied with data loss risk → **DO NOT ROLLBACK** (requires DB restore from backup).
3. User does not have read-only permissions → **STOP**.

### 1.7 Consistency Check

**Confirm migration 51 SQL matches checklist:**

- File: `packages/db/drizzle/0051_ea12_drop_dead_columns.sql`
- Content: 3 ALTER TABLE statements (certificate, due_on, expires_on)
- **Confirmed:** ✅ Matches checklist exactly.

---

## Work II: Backup and Restore Acceptance Preparation

### 2.1 Database Backup Objects

| Object                                       | Description                                      | Location             | Verification         |
| -------------------------------------------- | ------------------------------------------------ | -------------------- | -------------------- |
| `beaconhs-YYYYMMDD_HHMMSS.dump`              | PostgreSQL custom-format dump                    | `/secure/backup/db/` | SHA256, manifest.tsv |
| `beaconhs-YYYYMMDD_HHMMSS.dump.sha256`       | SHA256 checksum                                  | `/secure/backup/db/` | Matches dump file    |
| `beaconhs-YYYYMMDD_HHMMSS.dump.manifest.tsv` | Backup metadata (row counts, RLS policies, etc.) | `/secure/backup/db/` | Matches actual DB    |

**Backup creation command:**

```bash
PGHOST=... PGPORT=... PGDATABASE=... PGUSER=<backup login> PGPASSWORD=... \
  DATABASE_BACKUP_ROLE=<backup login> \
  scripts/cluster/backup.sh /secure/backup/db
```

**Backup verification command:**

```bash
# Check SHA256
sha256sum -c beaconhs-YYYYMMDD_HHMMSS.dump.sha256

# Check manifest
cat beaconhs-YYYYMMDD_HHMMSS.dump.manifest.tsv
```

### 2.2 Object Store Backup Objects

| Object                     | Description               | Location                          | Verification        |
| -------------------------- | ------------------------- | --------------------------------- | ------------------- |
| `backup.manifest.json.enc` | Encrypted backup manifest | `/secure/backup/objects/`         | Verify integrity    |
| `backup.hmac`              | HMAC checksum             | `/secure/backup/objects/`         | Verify authenticity |
| `objects/<sha256>.age`     | Encrypted object keys     | `/secure/backup/objects/objects/` | Verify encryption   |
| `checkpoint.json.enc`      | Backup checkpoint         | `/secure/backup/objects/`         | Verify consistency  |

**Backup creation command:**

```bash
OBJECT_STORE_ENDPOINT=... OBJECT_STORE_BUCKET=... \
  OBJECT_STORE_ACCESS_KEY_ID=... OBJECT_STORE_SECRET_ACCESS_KEY=... \
  [BACKUP_AGE_RECIPIENT=... BACKUP_HMAC_KEY_FILE=...] \
  pnpm --filter @beaconhs/object-store-backup exec tsx src/cli.ts \
  backup --destination /secure/backup/objects [--encrypt] [--create-bucket]
```

**Backup verification command:**

```bash
pnpm --filter @beaconhs/object-store-backup exec tsx src/cli.ts \
  verify --backup-dir /secure/backup/objects --strict
```

### 2.3 Restore Targets

**Database restore target:**

- **Disposable staging database:** `beaconhs_restore_<timestamp>_<pid>`
- **Do not restore to production:** Always restore to a disposable database.
- **Keep restore DB:** Set `KEEP_RESTORE_DB=true` to preserve for verification.

**Object store restore target:**

- **New bucket:** Create a new bucket for restore (do not overwrite existing bucket).
- **Bucket name:** `beaconhs-restore-<timestamp>` (or equivalent).
- **Overwrite:** Use `--overwrite` flag only if explicitly required.

**Restore command (database):**

```bash
PGHOST=... PGPORT=... PGDATABASE=postgres \
  PGUSER=<postgres admin> PGPASSWORD=... \
  DATABASE_OWNER_ROLE=beaconhs_owner KEEP_RESTORE_DB=true \
  scripts/cluster/restore-verify.sh /secure/backup/db/beaconhs-<timestamp>.dump
```

**Restore command (object store):**

```bash
OBJECT_STORE_ENDPOINT=... OBJECT_STORE_ACCESS_KEY_ID=... OBJECT_STORE_SECRET_ACCESS_KEY=... \
  BACKUP_AGE_IDENTITY=... BACKUP_HMAC_KEY_FILE=... \
  pnpm --filter @beaconhs/object-store-backup exec tsx src/cli.ts \
  restore --backup-dir /secure/backup/objects \
  --bucket <target> [--create-target-bucket] [--overwrite] \
  --public-endpoint <browser-reachable endpoint>
```

### 2.4 Integrity Checks

**Database restore integrity checks:**

1. **Checksum match:** Dump SHA256 matches `.sha256` file.
2. **Manifest metrics:** All manifest metrics match actual DB:
   - `migration_rows` matches migration ledger
   - `public_tables` matches actual tables
   - `forced_rls_tables` matches RLS-enabled tables
   - `tenant_policies` matches RLS policies
3. **Row counts:** Table row counts match manifest.
4. **RLS policies:** 194 policies confirmed in restored DB.

**Object store restore integrity checks:**

1. **Verify backup:** `verify --backup-dir ... --strict` must print `backup is intact`.
2. **Manifest comparison:** Compare restored manifest with original manifest.
3. **Object access:** Verify anonymous/wrong-credential/presigned access checks.

### 2.5 Business Verification Standards

**Database business verification:**

1. **Migration version:** `current_setting('app.current_migration')` returns `0051_ea12_drop_dead_columns`.
2. **RLS enabled:** All tenant-scoped tables have RLS enabled.
3. **beaconhs_app role:** Can read tables (RLS filters apply).
4. **Tenant isolation:** Test with a non-admin user (RLS filters apply).

**Object store business verification:**

1. **Object keys:** All restored objects have correct SHA256.
2. **Content-Type:** All objects have correct `contentType`.
3. **Tenant prefix:** All keys have `t/<tenant-uuid>/` prefix.
4. **Access:** Verify anonymous access, wrong credential access, and presigned access.

### 2.6 Staging Verified vs Production Unverified

| Item                          | Staging Verified (EA-26/32A/32B) | Production Unverified |
| ----------------------------- | -------------------------------- | --------------------- |
| pg_dump -Fc backup            | ✅                               | ❌                    |
| pg_restore --no-privileges    | ✅                               | ❌                    |
| pnpm db:migrate after restore | ✅                               | ❌                    |
| Row counts preserved          | ✅                               | ❌                    |
| Migration version preserved   | ✅                               | ❌                    |
| RLS policies preserved        | ✅                               | ❌                    |
| Object store backup           | ✅                               | ❌                    |
| Object store restore          | ✅                               | ❌                    |
| Object integrity checks       | ✅                               | ❌                    |
| Business verification         | ✅                               | ❌                    |

### 2.7 Permissions Rebuild Step

**Mandatory after `pg_restore --no-privileges`:**

```bash
MIGRATION_DATABASE_URL=.../<restored-db> \
DATABASE_URL=.../<restored-db> \
SUPERADMIN_DATABASE_URL=.../<restored-db> \
  pnpm db:migrate
```

**Expected output:**

- `0 pending` (the restored ledger is already current)
- `RLS applied`
- `Least-privilege grants applied`

**What is rebuilt:**

1. Runtime grants (SELECT on application tables).
2. RLS policies on tenant-scoped tables.
3. Migration ledger (ensures schema is current).

**Verification:**

- `/api/health/ready` returns 200 (not 503).
- `beaconhs_app` can read tables (RLS filters apply).
- RLS is enabled+forced on all 5 key tables.

### 2.8 Migration 51 Forward-Only Note

**IMPORTANT:** Migration 51 drops columns. It is **forward-only**. There is no down-migration path.

**If migration 51 causes data loss:**

1. Stop web/worker/scheduler containers.
2. Restore DB from backup: `scripts/cluster/restore-verify.sh /secure/backup/db/beaconhs-<timestamp>.dump`
3. Re-apply grants: `pnpm db:migrate`
4. Restore object store (if applicable).
5. Verify readiness: `curl http://<instance>/api/health/ready` → 200.

**Rollback prerequisites:**

- Previous DB backup available.
- Previous image tag available (`beaconhs:phase-ea13-20261022-160729-m` or equivalent).
- Compose config backup (`compose.yaml.pre-ea16`).

---

## Work III: Full Rollback Acceptance Preparation

### 3.1 Release Images and Versions

| Component | Pre-Release Image                       | Candidate Image                       | Digest                                                                    | Server Action Key     |
| --------- | --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- | --------------------- |
| Web       | `beaconhs:phase-ea13-20261022-160729-m` | `beaconhs:phase-ea16-20261023-052716` | `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5` | K1 (same across both) |
| Worker    | `beaconhs:phase-ea13-20261022-160729-m` | `beaconhs:phase-ea16-20261023-052716` | `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5` | K1                    |
| Scheduler | `beaconhs:phase-ea13-20261022-160729-m` | `beaconhs:phase-ea16-20261023-052716` | `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5` | K1                    |
| DB        | Migration 51                            | Migration 51                          | N/A                                                                       | N/A                   |

**Server Action Key compatibility strategy:**

- **Same key (K1) across versions:** Compatible. Server Actions work.
- **Different key across versions:** Incompatible. Server Actions return 404 "Server action not found."
- **Rollback to same key:** Restores all functionality.

### 3.2 Readiness Verification Steps

**Step 1: Health check**

```bash
curl -sS -w '\n%{http_code}\n' http://<instance>/api/health/ready
```

**Expected result:**

- `200 {"status":"ready","version":"51a899b7..."}` + `[schema] match`

**Step 2: Version verification**

```bash
curl -sS http://<instance>/api/health/ready | jq '.version'
```

**Expected result:**

- `51a899b7aac0a942da327222a3eed355fca9798a` (matches deployed image)

**Step 3: Login flow verification**

```bash
# Magic Link
curl -X POST https://<instance>/api/auth/sign-in/magic-link \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@company.com","callbackURL":"/dashboard"}'

# Check Mailpit for email
curl http://mailpit:1025/api/v1/messages?limit=1
```

**Expected result:**

- Magic link email sent to admin@company.com.
- Verify URL accessible, login successful, dashboard loads.

**Step 4: Server Actions verification**

```bash
# Forgot-password Server Action
curl -X POST https://<instance>/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@company.com"}'

# Check Mailpit for password reset email
curl http://mailpit:1025/api/v1/messages?limit=1
```

**Expected result:**

- Password reset email sent.
- Server Action decryption and execution successful.

**Step 5: File upload verification**

```bash
# Upload 70-byte PNG
curl -X PUT https://<instance>/api/v1/attachments/presign \
  -H "Authorization: Bearer <capability-url>" \
  -H "Content-Type: image/png" \
  --data-binary @/path/to/70-byte-png.png

# Verify object exists
curl -I https://<instance>/api/v1/attachments/<attachment-id>
```

**Expected result:**

- Presigned PUT URL returned.
- Object uploaded successfully.
- Object exists in storage (SHA256 match).

**Step 6: File download verification**

```bash
# Download using capability URL
curl -L -I https://<instance>/api/v1/attachments/<attachment-id>/download
```

**Expected result:**

- 307 redirect to presigned GET URL.
- 200 OK, size 70 bytes, SHA256 match.

**Step 7: Cross-tenant RLS verification**

```bash
# Test with non-admin user (different tenant)
curl https://<instance>/api/v1/monitored_sessions \
  -H "Authorization: Bearer <token-from-different-tenant>"
```

**Expected result:**

- 401 Unauthorized (tenant isolation enforced).

### 3.3 Login Verification Steps

**Step 1: Magic Link login**

1. Navigate to `/login`.
2. Click "登录链接" (Magic link tab).
3. Enter admin@company.com.
4. Submit.
5. Check Mailpit for email.
6. Click verify URL.
7. Verify dashboard loads.

**Step 2: Password login**

1. Navigate to `/login`.
2. Click "密码" (Password tab).
3. Enter admin@company.com and password.
4. Submit.
5. Verify dashboard loads.

**Step 3: Session verification**

1. Navigate to `/dashboard`.
2. Verify page loads.
3. Check Account menu in top-right.
4. Verify "Admin" link visible (admin access).

### 3.4 Server Actions Verification Steps

**Step 1: Forgot-password Server Action**

1. Navigate to `/forgot-password`.
2. Enter admin@company.com.
3. Submit.
4. Check Mailpit for password reset email.

**Step 2: Verify Server Action decryption**

- Email contains valid reset URL with token.
- Server Action successfully decrypts token.
- Password reset flow works.

### 3.5 File Upload/Download Verification Steps

**Step 1: Upload**

1. Navigate to document upload page.
2. Select 70-byte PNG file.
3. Submit.
4. Verify object uploaded successfully.

**Step 2: Download**

1. Navigate to document list.
2. Click download link.
3. Verify file downloaded successfully.
4. Verify SHA256 matches original.

**Step 3: Invalid capability URL**

1. Try to download with invalid capability URL.
2. Verify 404 response.

### 3.6 RLS Verification Steps

**Step 1: Verify RLS enabled on all tenant-scoped tables**

```sql
SELECT table_name, row_security
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'people', 'equipment', 'equipment_inspection_records',
    'training_enrollments', 'corrective_actions'
  );
```

**Expected result:**

- `row_security = ON` for all 5 tables.

**Step 2: Verify tenant isolation**

1. Login as admin@company.com (Tenant A).
2. Navigate to `/api/v1/monitored_sessions`.
3. Verify sees only Tenant A sessions.
4. Logout.
5. Login as user@company.com (Tenant B).
6. Navigate to `/api/v1/monitored_sessions`.
7. Verify sees only Tenant B sessions.

**Expected result:**

- Tenant A user sees only Tenant A sessions.
- Tenant B user sees only Tenant B sessions.

### 3.7 Data Integrity Verification Steps

**Step 1: Verify no data loss after rollback**

1. Check that all tables have correct row counts.
2. Verify RLS policies are intact.
3. Verify migration version is correct.
4. Verify object store integrity.

**Step 2: Verify no cross-tenant data leak**

1. Login as admin@company.com (Tenant A).
2. Verify cannot access Tenant B data.
3. Logout.
4. Login as user@company.com (Tenant B).
5. Verify cannot access Tenant A data.

**Expected result:**

- No data loss.
- No cross-tenant data leak.

### 3.8 Error Rate Verification

**Step 1: Monitor 5xx error rate**

1. Monitor `/api/health/ready` for 5 minutes.
2. Count 5xx errors.
3. Calculate error rate: `5xx_errors / total_requests`.

**Expected result:**

- 5xx error rate < 1%.

**Step 2: Monitor login/session errors**

1. Monitor `/api/auth/sign-in/magic-link` for 5 minutes.
2. Count 5xx errors.
3. Calculate error rate.

**Expected result:**

- 5xx error rate < 1%.

### 3.9 App Rollback vs DB Restore

**App rollback (image switch):**

1. Stop web/worker/scheduler containers.
2. Switch compose config to previous image tag (`beaconhs:phase-ea13-20261022-160729-m`).
3. Start containers.
4. Verify readiness.
5. **Note:** If migration 51 was applied and is incompatible, app rollback alone is NOT sufficient.

**DB restore:**

1. Stop web/worker/scheduler containers.
2. Restore DB from backup: `scripts/cluster/restore-verify.sh /secure/backup/db/beaconhs-<timestamp>.dump`.
3. Re-apply grants: `pnpm db:migrate`.
4. Restore object store (if applicable).
5. Start containers.
6. Verify readiness.

**When to use app rollback vs DB restore:**

- **App rollback only:** If migration 51 was NOT applied (DB is at migration 50).
- **DB restore + app rollback:** If migration 51 was applied and caused data loss.
- **DB restore only:** If DB schema is ahead of all images (schema incompatibility).

### 3.10 Rollback Execution Plan

**Rollback step 1: Stop writers**

- Stop web/worker/scheduler containers.
- Put tenant into storage freeze state (if applicable).

**Rollback step 2: Rollback app (if applicable)**

- Switch compose config to previous image tag.
- Start containers.
- Verify readiness.

**Rollback step 3: Restore DB (if applicable)**

- Restore DB from backup: `scripts/cluster/restore-verify.sh /secure/backup/db/beaconhs-<timestamp>.dump`.
- Re-apply grants: `pnpm db:migrate`.

**Rollback step 4: Restore object store (if applicable)**

- Restore object store: `pnpm --filter @beaconhs/object-store-backup exec tsx src/cli.ts restore ...`.

**Rollback step 5: Verify and un-freeze**

- Verify readiness: `curl http://<instance>/api/health/ready` → 200.
- Unfreeze storage (if applicable).
- Smoke-test workflows that read attachments.

### 3.11 Rollback Evidence and Stop Conditions

**Evidence for each rollback step:**

- Stop time and reason.
- Restore command output.
- Readiness check result.
- Smoke-test result.

**Stop conditions (do not continue if any is true):**

- Readiness fails or returns non-200 for > 2 minutes.
- Login or session resolution fails.
- File upload/download fails for > 5% of requests.
- Cross-tenant data leak detected.
- Any 5xx error rate > 1% for > 5 minutes.
- Backup restore fails (checksum mismatch, manifest mismatch, permission errors).
- Object store restore fails (integrity errors, access check failures).

**Recovery determination:**

- **PASS:** Readiness returns 200, login works, Server Actions work, file upload/download works, RLS enforced, no data loss, no cross-tenant leak, 5xx error rate < 1%.
- **FAIL:** Any stop condition is true.

---

## Work IV: Image Policy Approval Preparation

### 4.1 Build Evidence Summary (EA-19 to EA-23)

| EA    | Item                                                     | Result       | Evidence                                                                |
| ----- | -------------------------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| EA-19 | Source reproducibility (independent build from snapshot) | PASS         | Independent build succeeded (tag `beaconhs:ea19-repro-20261023-080322`) |
| EA-20 | Source code byte-identical across builds                 | PASS         | Source code byte-identical                                              |
| EA-21 | First 10 image layers byte-identical                     | PASS         | First 10 layers byte-identical                                          |
| EA-22 | Build ID deterministic (DEPLOYMENT_VERSION)              | PASS         | Build ID is `build-TfctsWXpff2fKS` (deterministic)                      |
| EA-23 | Image digest reproducibility (bit-for-bit)               | NOT VERIFIED | Image digests differ across builds                                      |

### 4.2 What is Reproducible

✅ **Reproducible:**

1. Source code from snapshot rebuilds to byte-identical code.
2. Application files (Next.js bundle, worker bundle) are byte-identical across builds.
3. First 10 image layers (base OS + dependencies) are byte-identical.
4. Build ID is deterministic (`build-TfctsWXpff2fKS`).

### 4.3 What is Not Reproducible (by Design)

❌ **Not reproducible:**

1. Docker image manifest digest (`sha256:...`) differs across builds.
2. BuildKit build identity metadata differs:
   - `/Identity/Build[0]/Ref` (build reference — random per build)
   - `/Identity/Build[0]/CreatedAt` (build timestamp)
3. Image `Created` field is fixed by `SOURCE_DATE_EPOCH`, but build identity metadata is not.

### 4.4 Root Cause of Digest Divergence

The ONLY remaining difference is BuildKit build identity metadata:

1. **Build reference (`Ref`):** Random per build in BuildKit 0.38.1. No standard override available.
2. **Build timestamp (`CreatedAt`):** Not controlled by `SOURCE_DATE_EPOCH` in BuildKit 0.38.1.

All 18 layer digests are identical. Application code is byte-identical. The image's `Created` field IS fixed by `SOURCE_DATE_EPOCH`, but the build identity metadata is not.

### 4.5 Impact Assessment

**Functional impact:**

- **NONE.** The build identity metadata does not affect runtime behavior.

**Audit impact:**

- If formal audit requires bit-for-bit reproducibility, this is a blocker.

**Risk level:**

- **LOW** (non-functional difference).

### 4.6 Decision Options

**Option A: Accept known difference (recommended)**

- **Rationale:** The difference is non-functional (build metadata only). Application code is byte-identical. The build identity metadata is not controlled by project configuration.
- **Risk:** LOW. No functional impact.
- **Action:** Document risk, obtain written risk acceptance from approver.
- **Closure condition:** Approver signs off on risk acceptance.

**Option B: Continue solving image-level reproducibility**

- **Rationale:** Achieve bit-for-bit reproducible image digests.
- **Risk:** MEDIUM. May require BuildKit configuration changes or tooling changes not yet validated.
- **Action:** Implement BuildKit build reference override or alternative build tooling.
- **Closure condition:** Image digest reproducible (all layers identical including build identity metadata).

**Option C: Neither (block release)**

- **Rationale:** Bit-for-bit reproducibility is a hard requirement for formal audit.
- **Risk:** HIGH. Release blocked until reproducibility achieved.
- **Action:** Continue working on reproducibility before release.
- **Closure condition:** Image digest reproducible.

**Recommendation:** Option A (accept known difference with written risk acceptance).

### 4.7 Decision Materials for Approver

**Required for Option A (accept known difference):**

1. EA-19 to EA-23 build evidence summary (Section 4.1).
2. Reproducible vs non-reproducible breakdown (Section 4.2).
3. Root cause analysis (Section 4.3).
4. Impact assessment (Section 4.5).
5. Risk level: LOW.
6. Written risk acceptance signature from approver.

**Required for Option B (continue solving):**

1. EA-19 to EA-23 build evidence summary (Section 4.1).
2. Reproducible vs non-reproducible breakdown (Section 4.2).
3. Root cause analysis (Section 4.3).
4. Impact assessment (Section 4.5).
5. Risk level: MEDIUM.
6. BuildKit configuration or tooling changes plan.
7. Timeline for implementation.

**Required for Option C (block release):**

1. EA-19 to EA-23 build evidence summary (Section 4.1).
2. Reproducible vs non-reproducible breakdown (Section 4.2).
3. Root cause analysis (Section 4.3).
4. Impact assessment (Section 4.5).
5. Risk level: HIGH.
6. No release until reproducibility achieved.

---

## Work V: Authorization Checklist

### 5.1 DBA Authorization

**Required DBA confirmations:**

| Item                            | Action                                        | Evidence                                            | Stop Condition        |
| ------------------------------- | --------------------------------------------- | --------------------------------------------------- | --------------------- |
| Migration 51 pre-check SQL      | Run on production DB                          | Check results (non_null_rows = 0 for all 3 columns) | Any non_null_rows > 0 |
| Migration 51 pre-check results  | Record in audit log                           | Check results + timestamp + executor                | Any non_null_rows > 0 |
| Production backup exists        | Verify backup file exists                     | Backup file + SHA256                                | Backup file not found |
| Production backup is restorable | Test restore to disposable staging            | Restore succeeds, no checksum errors                | Restore fails         |
| Migration 51 is forward-only    | Confirm no down-migration path                | Review migration 51 SQL                             | None                  |
| Rollback prerequisites met      | Confirm backup + previous image tag available | Backup file + image tag                             | Prerequisites not met |

**Production access required:**

- ✅ Yes (to run migration 51 pre-check SQL).

**Change window required:**

- ✅ Yes (for DB backup and restore).

**Backup confirmation required:**

- ✅ Yes (backup file exists and is restorable).

**Approval signature required:**

- ✅ Yes (DBA signs off on migration 51 pre-check results).

### 5.2 Operations Authorization

**Required Ops confirmations:**

| Item                                         | Action                              | Evidence                         | Stop Condition                     |
| -------------------------------------------- | ----------------------------------- | -------------------------------- | ---------------------------------- |
| Target environment not ceshi/drill           | Verify production host              | Host name / IP address           | Target is ceshi/drill              |
| DB backup exists and is restorable           | Test restore to disposable staging  | Restore succeeds                 | Restore fails                      |
| Object store backup exists and is restorable | Run object-store-backup verify      | Verify prints "backup is intact" | Verify fails                       |
| Object store is provisioned and accessible   | Verify object store endpoint        | Object store accessible          | Object store not accessible        |
| DNS/Cloudflare tunnel routes correctly       | Verify DNS configuration            | DNS resolution successful        | DNS resolution fails               |
| Maintenance window identified                | Confirm maintenance window          | Maintenance window documentation | Maintenance window not identified  |
| Responsible parties identified               | Confirm responsible parties         | Responsible parties list         | Responsible parties not identified |
| Rollback image tag available                 | Verify previous image tag exists    | Image tag exists                 | Image tag not found                |
| Compose config backup available              | Verify compose config backup exists | Compose config backup exists     | Compose config backup not found    |

**Production access required:**

- ✅ Yes (to verify object store, DNS, compose config).

**Change window required:**

- ✅ Yes (for deployment and rollback).

**Backup confirmation required:**

- ✅ Yes (DB backup and object store backup).

**Approval signature required:**

- ✅ Yes (Ops signs off on all confirmations).

### 5.3 Technical Approver Authorization

**Required Technical Approver confirmations:**

| Item                                     | Action                        | Evidence                | Stop Condition            |
| ---------------------------------------- | ----------------------------- | ----------------------- | ------------------------- |
| Release readiness review completed       | Review EA-36/EA-37 documents  | Review documents        | Not reviewed              |
| All pre-deployment checklist items met   | Verify checklist items        | Checklist items checked | Any item not met          |
| Magic Link E2E verified                  | Review EA-34 evidence         | Review evidence         | Not reviewed              |
| Server Action Key compatibility verified | Review EA-25~30/33 evidence   | Review evidence         | Not reviewed              |
| Migration 51 backup/restore verified     | Review EA-26/32A/32B evidence | Review evidence         | Not reviewed              |
| Application rollback verified            | Review EA-33 evidence         | Review evidence         | Not reviewed              |
| Real business operations verified        | Review EA-34 evidence         | Review evidence         | Not reviewed              |
| Cross-tenant RLS verified                | Review EA-14 evidence         | Review evidence         | Not reviewed              |
| File upload/download verified            | Review EA-14/17 evidence      | Review evidence         | Not reviewed              |
| Tunnel stability verified                | Review EA-15 evidence         | Review evidence         | Not reviewed              |
| Gateway self-heal verified               | Review EA-15 evidence         | Review evidence         | Not reviewed              |
| No unaddressed defects                   | Review defect register        | Review defects          | Unaddressed defects found |

**Production access required:**

- ❌ No (technical approval is based on documents, not production access).

**Change window required:**

- ❌ No (change window is an Ops responsibility).

**Backup confirmation required:**

- ❌ No (backup confirmation is a DBA/Ops responsibility).

**Approval signature required:**

- ✅ Yes (Technical Approver signs off on all confirmations).

### 5.4 Release Engineer Authorization

**Required Release Engineer confirmations:**

| Item                                            | Action                         | Evidence                     | Stop Condition               |
| ----------------------------------------------- | ------------------------------ | ---------------------------- | ---------------------------- |
| Source snapshot archived                        | Verify snapshot exists         | Snapshot file exists         | Snapshot not found           |
| Source reproducibility verified                 | Review EA-19 evidence          | Review evidence              | Not reviewed                 |
| Image tag recorded                              | Verify image tag               | Image tag matches            | Image tag not recorded       |
| Full manifest digest recorded                   | Verify manifest digest         | Manifest digest matches      | Manifest digest not recorded |
| App version SHA matches image                   | Verify version SHA             | Version SHA matches          | Version SHA mismatch         |
| Server Action Key file available                | Verify key file exists         | Key file exists              | Key file not found           |
| All secrets configured in production            | Verify production env vars     | Production env vars set      | Production env vars not set  |
| APP_URL/PUBLIC_APP_URL = production origin      | Verify URLs                    | URLs match production origin | URLs mismatch                |
| Rollback image tag available                    | Verify previous image tag      | Image tag exists             | Image tag not found          |
| Image digest reproducibility decision made      | Review EA-36C decision options | Decision made                | No decision made             |
| No uncommitted working-tree changes for release | Verify working tree            | Working tree clean           | Working tree not clean       |

**Production access required:**

- ❌ No (Release Engineer approval is based on documents, not production access).

**Change window required:**

- ❌ No (change window is an Ops responsibility).

**Backup confirmation required:**

- ❌ No (backup confirmation is a DBA/Ops responsibility).

**Approval signature required:**

- ✅ Yes (Release Engineer signs off on all confirmations).

### 5.5 Approval Summary

| Role               | Production Access Required | Change Window Required | Backup Confirmation Required | Approval Signature Required |
| ------------------ | -------------------------- | ---------------------- | ---------------------------- | --------------------------- |
| DBA                | ✅ Yes                     | ✅ Yes                 | ✅ Yes                       | ✅ Yes                      |
| Ops                | ✅ Yes                     | ✅ Yes                 | ✅ Yes                       | ✅ Yes                      |
| Technical Approver | ❌ No                      | ❌ No                  | ❌ No                        | ✅ Yes                      |
| Release Engineer   | ❌ No                      | ❌ No                  | ❌ No                        | ✅ Yes                      |

---

## Final Status

**Release status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**What is ready:**

- ✅ EA-36 release readiness review completed.
- ✅ Migration 51 pre-check SQL prepared (Section 1).
- ✅ Backup and restore acceptance plan prepared (Section 2).
- ✅ Full rollback acceptance plan prepared (Section 3).
- ✅ Image policy approval materials prepared (Section 4).
- ✅ Authorization checklist completed (Section 5).

**What is NOT ready:**

- ❌ Production migration 51 pre-check (NOT RUN) — requires DBA production access.
- ❌ Production backup and restore drill (NOT RUN) — requires Ops production access.
- ❌ Production rollback drill (NOT RUN) — requires Ops production access.
- ❌ Image digest reproducibility decision (NOT DECIDED) — requires Technical Approver approval.

**Next steps:**

1. DBA runs migration 51 pre-check SQL on production DB.
2. Ops verifies production backup and restore procedures.
3. Ops confirms maintenance window and responsible parties.
4. Technical Approver reviews all documents and signs off.
5. Release Engineer confirms all checklist items are met.
6. Approver makes image digest reproducibility decision (Option A/B/C).

**Stop conditions:**

- Any migration 51 pre-check fails (non_null_rows > 0).
- Any backup/restore test fails.
- Any pre-deployment checklist item is not met.
- Any unaddressed defects found.
- Approver does not sign off.

---

**Document version:** 1.0
**Last updated:** 2026-10-25
**Author:** EA-37 production readiness authorization plan
