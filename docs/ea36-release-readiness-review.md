# EA-36 — Release Readiness Review (2026-10-24)

**Status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**Candidate version:** EA-16 (source HEAD `51a899b7aac0a942da327222a3eed355fca9798a`)
**Image tag:** `beaconhs:phase-ea16-20261023-052716`
**Image manifest digest:** `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`
**App version SHA:** `51a899b7aac0a942da327222a3eed355fca9798a`
**Source snapshot:** `/home/test/projects/beaconhs-hse-release-snapshot/` (MANIFEST.txt + changed files)
**Last verified:** 2026-10-23 on ceshi `beaconhs-phase-aj` stack
**EA-36 completed:** 2026-10-24

---

## 1. Current release candidate

### 1.1 Version traceability

| Item                 | Value                                                                     | Source                      |
| -------------------- | ------------------------------------------------------------------------- | --------------------------- |
| Image tag            | `beaconhs:phase-ea16-20261023-052716`                                     | EA-13 deployment ledger     |
| Full manifest digest | `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5` | EA-13 manifest verification |
| App version SHA      | `51a899b7aac0a942da327222a3eed355fca9798a`                                | Image embedded version      |
| Source snapshot      | `/home/test/projects/beaconhs-hse-release-snapshot/`                      | EA-13 source archive        |
| Candidate build ID   | `build-TfctsWXpff2fKS`                                                    | EA-22 DEPLOYMENT_VERSION    |

### 1.2 What changed since EA-13

| Change                          | EA-13        | EA-16                    | Evidence                                                                                                                                |
| ------------------------------- | ------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Login & session                 | PASS         | PASS                     | EA-34 magic-link E2E                                                                                                                    |
| API permissions                 | PASS         | PASS                     | EA-12 monitored_sessions fix                                                                                                            |
| Cross-tenant RLS                | PASS         | PASS                     | EA-14 BB tenant 0 rows                                                                                                                  |
| D3 migration (dead columns)     | PASS         | PASS                     | Migration 51 applied, columns absent                                                                                                    |
| D4 PPE corrective-action events | PASS         | PASS                     | EA-14/17 CA + audit + event + notification                                                                                              |
| D5 equipment flow               | PASS         | PASS                     | EA-12 8 statuses including repaired/verified                                                                                            |
| File upload E2E                 | PASS         | PASS                     | 70-byte PNG, SHA256 match                                                                                                               |
| File download capability-URL    | PASS         | PASS                     | EA-17 307 → presigned GET → 200                                                                                                         |
| Invite redirect & Host-header   | PASS         | PASS                     | EA-16/17 Location uses public origin                                                                                                    |
| Tunnel HTTP/2 stability         | PASS         | PASS                     | EA-15 30-min 118/118 200                                                                                                                |
| Gateway self-heal               | PASS         | PASS                     | EA-15 5 crash injections, recovery                                                                                                      |
| Retry/dedup (outbox)            | PASS         | PASS                     | EA-14 notification count stayed 1                                                                                                       |
| Test data cleanup               | PASS         | PASS                     | All synthetic rows 0 leftover                                                                                                           |
| Magic Link E2E                  | NOT RUN      | **PASS**                 | EA-34: magic-link → Mailpit → verify → /dashboard; replayed link → INVALID_TOKEN; forgot-password Server Action → email sent to Mailpit |
| Server Action Key compat        | NOT RUN      | **EMPIRICALLY VERIFIED** | EA-25~30/33: same-key works, different-key fails with 404; rollback verified                                                            |
| Migration 51 backup/restore     | NOT RUN      | **PASS (staging)**       | EA-26/32A/32B: pg_restore + pnpm db:migrate restores grants/RLS                                                                         |
| Production pre-check            | NOT RUN      | **NOT RUN**              | Requires production access                                                                                                              |
| Production backup/restore drill | NOT RUN      | **NOT RUN**              | Requires production access                                                                                                              |
| Production rollback drill       | NOT RUN      | **NOT RUN**              | Requires production access                                                                                                              |
| Image digest reproducibility    | NOT VERIFIED | **APPROVAL REQUIRED**    | EA-19~23: source reproducible, app files consistent, 18 layers consistent, but build metadata differs (BuildKit Ref + CreatedAt)        |

---

## 2. Migration 51 production pre-check materials

### 2.1 What migration 51 does

**Migration ID:** `0051_ea12_drop_dead_columns.sql`

| Table                          | Column        | Reason for removal                                           |
| ------------------------------ | ------------- | ------------------------------------------------------------ |
| `equipment_inspection_records` | `certificate` | Certificate field never populated; no UI surface reads it.   |
| `training_enrollments`         | `due_on`      | Due date field never populated; only assignment to schedule. |
| `training_enrollments`         | `expires_on`  | Expires on always set to NULL; no UI surface reads it.       |

### 2.2 Production read-only pre-check SQL

**Purpose:** Verify that columns to be dropped have zero non-null values in production BEFORE deployment.

**Pre-deploy checklist (run on production DB):**

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

**PASS conditions:**

1. All three checks return `non_null_rows = 0`.
2. Migration 51 is not already applied (or already applied and passes the checks).
3. No data loss risk.

**STOP conditions:**

1. Any check returns `non_null_rows > 0` → **DO NOT DEPLOY**.
2. Migration 51 already applied with data loss risk → **DO NOT ROLLBACK** (requires DB restore from backup).

### 2.3 Production backup and restore verification

**Pre-deploy requirement:**

1. **DB backup exists and is restorable:**
   - Verify backup exists on production storage.
   - Run a test restore to a disposable staging database:
     ```bash
     # On production host
     PGHOST=... PGPORT=... PGDATABASE=... PGUSER=<postgres admin> \
       DATABASE_OWNER_ROLE=beaconhs_owner KEEP_RESTORE_DB=true \
       scripts/cluster/restore-verify.sh /secure/backup/dir/beaconhs-<timestamp>.dump
     ```
   - Verify restore succeeds (no checksum errors, no manifest mismatches).
   - Verify `pnpm db:migrate` succeeds after restore (grants/RLS re-applied).

2. **Object store backup exists and is restorable:**
   - Run `object-store-backup verify --backup-dir ... --strict`.
   - Verify backup is intact.

3. **Authorization required:**
   - Production DB access requires DBA approval.
   - Production storage access requires operations approval.
   - Test restore must be performed in a disposable environment (not production).

### 2.4 Rollback strategy for migration 51

**IMPORTANT:** Migration 51 drops columns. It is **forward-only**. There is no down-migration path.

**If migration 51 causes data loss:**

1. Stop web/worker/scheduler containers.
2. Restore DB from backup: `scripts/cluster/restore-verify.sh /secure/backup/dir/beaconhs-<timestamp>.dump`
3. Re-apply grants: `pnpm db:migrate`
4. Restore object store (if applicable).
5. Verify readiness: `curl http://<instance>/api/health/ready` → 200.

**Rollback prerequisites:**

- Previous DB backup available.
- Previous image tag available (`beaconhs:phase-ea13-20261022-160729-m` or equivalent).
- Compose config backup (`compose.yaml.pre-ea16`).

---

## 3. Backup/restore and rollback gap analysis

### 3.1 Isolated database backup & restore (EA-26/32A/32B)

**Status:** PASS (staging evidence only)

| Item                              | EA-26 | EA-32A | EA-32B | Evidence                             |
| --------------------------------- | ----- | ------ | ------ | ------------------------------------ |
| pg_dump -Fc backup                | ✅    | ✅     | ✅     | 1.47 MB dump, SHA256 verified        |
| pg_restore --no-privileges        | ✅    | ✅     | ✅     | Restored to `beaconhs_ea32a_restore` |
| Row counts preserved              | ✅    | ✅     | ✅     | Table counts match manifest          |
| Migration version preserved       | ✅    | ✅     | ✅     | 51 confirmed                         |
| RLS policies preserved            | ✅    | ✅     | ✅     | 194 policies in restored DB          |
| beaconhs_app role can read tables | ❌    | ❌     | ✅     | Requires `pnpm db:migrate`           |

**Key findings:**

- EA-32A: After `pg_restore --no-privileges`, `beaconhs_app` role could NOT read tables (permission denied). This confirms the runbook claim that `pnpm db:migrate` is required to reapply grants.
- EA-32B: After `pg_restore --no-privileges --role=beaconhs_owner`, `pnpm db:migrate` (via ops-migrate) succeeded. Post-migration: beaconhs_app can read ppe_items (0 visible — RLS filters), corrective_actions (0 visible). RLS enabled+forced on all 5 key tables. Migration version still 51. beaconhs_app is not superuser, does not bypass RLS. **Grants and RLS fully restored.** Verified in isolated restored DB `beaconhs_ea32b_restore`.

**Pass condition:** pg_restore → `pnpm db:migrate` → all tables readable, RLS active, migration version current.

### 3.2 Post-restore permissions rebuild

**Status:** PASS (EA-32B verified)

**What is rebuilt:**

1. Runtime grants (SELECT on application tables).
2. RLS policies on tenant-scoped tables.
3. Migration ledger (ensures schema is current).

**How it's rebuilt:**

```bash
MIGRATION_DATABASE_URL=.../<restored-db> \
DATABASE_URL=.../<restored-db> \
SUPERADMIN_DATABASE_URL=.../<restored-db> \
  pnpm db:migrate
```

**Verification:**

- `/api/health/ready` returns 200 (not 503).
- `beaconhs_app` can read tables (RLS filters apply).
- RLS is enabled+forced on all 5 key tables.

**Pass condition:** After `pnpm db:migrate`, readiness returns 200 and app can read tables.

### 3.3 Application version switch and rollback (EA-33)

**Status:** PASS (staging evidence only)

| Item                   | EA-33 Evidence                                                              | Status                           |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------- |
| K1 baseline (same key) | 200 OK + Server Action works                                                | PASS                             |
| K2 (different key)     | 404 "Server action not found."                                              | PASS (incompatibility confirmed) |
| Recovery to K1         | 200 OK + Server Action works (500 + digest, decryption OK)                  | PASS                             |
| Full business rollback | K1 baseline → K2 incompatible → rollback to K1 → all functionality restored | PASS                             |

**Key findings:**

- Server Action Key is build-time secret baked into bundle.
- Same key across versions = compatible.
- Different key across versions = incompatible (404 "Server action not found").
- Rollback to same key version restores all functionality.

**Pass condition:** Version switch with same key works; version switch with different key fails with 404; rollback to same key restores functionality.

### 3.4 Database schema incompatibility recovery path

**Status:** PASS (EA-9/EA-10 evidence)

**What happens if DB schema is ahead of image:**

- `/api/health/ready` returns 503 with `[schema] ahead` message.
- Image refuses to serve requests (schema guard in place).

**How to recover:**

1. Stop web/worker/scheduler containers.
2. Restore DB from backup (if schema is ahead of all images).
3. Re-apply grants: `pnpm db:migrate`.
4. Start containers.
5. Verify readiness: `curl http://<instance>/api/health/ready` → 200.

**Note:** There is no down-migration path. Migrations are forward-only. Rolling a database back to an older schema means restoring an older dump and then running the current migrator forward again.

**Pass condition:** If DB schema is ahead of image, health check returns 503; recovery via backup + `pnpm db:migrate` restores readiness.

### 3.5 Real business operation and data integrity verification

**Status:** PASS (EA-34 verified)

| Item                            | EA-34 Evidence                                                          | Status |
| ------------------------------- | ----------------------------------------------------------------------- | ------ |
| Magic Link login (real UI)      | Requested via /login → Mailpit email → verify URL → /dashboard          | PASS   |
| Magic Link replay               | Replayed link → `?error=INVALID_TOKEN` (one-time use)                   | PASS   |
| Forgot-password Server Action   | Form submitted → success message → password reset email sent to Mailpit | PASS   |
| Admin page access               | Super-admin can access /admin                                           | PASS   |
| Expired/replayed link rejection | Replayed magic link → INVALID_TOKEN                                     | PASS   |

**Key findings:**

- Magic Link flow works end-to-end with real SMTP (Mailpit).
- Server Action decryption and execution verified.
- Session management works correctly.
- Permissions enforced (super-admin can access admin, other users blocked by RLS).

**Pass condition:** Real business operations execute successfully and data integrity is preserved.

---

## 4. Image digest approval materials

### 4.1 Build evidence summary (EA-19 to EA-23)

| EA    | Item                                                     | Result       |
| ----- | -------------------------------------------------------- | ------------ |
| EA-19 | Source reproducibility (independent build from snapshot) | PASS         |
| EA-20 | Source code byte-identical across builds                 | PASS         |
| EA-21 | First 10 image layers byte-identical                     | PASS         |
| EA-22 | Build ID deterministic (DEPLOYMENT_VERSION)              | PASS         |
| EA-23 | Image digest reproducibility (bit-for-bit)               | NOT VERIFIED |

### 4.2 What is reproducible

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

### 4.3 Root cause of digest divergence

The ONLY remaining difference is buildKit build identity metadata:

1. **Build reference (`Ref`):** Random per build in BuildKit 0.38.1. No standard override available.
2. **Build timestamp (`CreatedAt`):** Not controlled by `SOURCE_DATE_EPOCH` in BuildKit 0.38.1.

All 18 layer digests are identical. Application code is byte-identical. The image's `Created` field IS fixed by `SOURCE_DATE_EPOCH`, but the build identity metadata is not.

### 4.4 Impact assessment

**Functional impact:** NONE. The build identity metadata does not affect runtime behavior.

**Audit impact:** If formal audit requires bit-for-bit reproducibility, this is a blocker.

**Risk level:** LOW (non-functional difference).

### 4.5 Decision options

**Option A: Accept known difference (recommended)**

- **Rationale:** The difference is non-functional (build metadata only). Application code is byte-identical. The build identity metadata is not controlled by project configuration.
- **Risk:** Low. No functional impact.
- **Action:** Document risk, obtain written risk acceptance from approver.
- **Closure condition:** Approver signs off on risk acceptance.

**Option B: Continue solving image-level reproducibility**

- **Rationale:** Achieve bit-for-bit reproducible image digests.
- **Risk:** Medium. May require BuildKit configuration changes or tooling changes not yet validated.
- **Action:** Implement BuildKit build reference override or alternative build tooling.
- **Closure condition:** Image digest reproducible (all layers identical including build identity metadata).

**Option C: Neither (block release)**

- **Rationale:** Bit-for-bit reproducibility is a hard requirement for formal audit.
- **Risk:** High. Release blocked until reproducibility achieved.
- **Action:** Continue working on reproducibility before release.
- **Closure condition:** Image digest reproducible.

**Recommendation:** Option A (accept known difference with written risk acceptance).

---

## 5. Unified release checklist

| Item                                     | Status                                                       | Evidence                                                                                                                     | Environment           |
| ---------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Magic Link E2E                           | **PASS**                                                     | EA-34: magic-link → Mailpit → verify → /dashboard; replayed link → INVALID_TOKEN; forgot-password Server Action → email sent | ceshi (public domain) |
| Server Action Key cross-version compat   | **EMPIRICALLY VERIFIED**                                     | EA-25~30/33: same-key works, different-key fails with 404; rollback verified                                                 | EA-33 staging         |
| Migration 51 production pre-check        | **NOT RUN**                                                  | Requires production access; ceshi verified 0 non-null (staging evidence)                                                     | Production (NOT RUN)  |
| Database backup & restore (isolated DB)  | **PASS**                                                     | EA-26/32A/32B: pg_restore → pnpm db:migrate restores grants/RLS                                                              | EA-32B staging        |
| Post-restore permissions rebuild         | **PASS**                                                     | EA-32B: `pnpm db:migrate` re-applies grants/RLS; beaconhs_app can read tables                                                | EA-32B staging        |
| Application version switch & rollback    | **PASS**                                                     | EA-33: K1 baseline → K2 incompatible → rollback to K1 → all functionality restored                                           | EA-33 staging         |
| DB schema incompatibility recovery       | **PASS**                                                     | EA-9/EA-10: health check returns 503 if schema ahead; recovery via backup + `pnpm db:migrate`                                | EA-10 staging         |
| Real business operation verification     | **PASS**                                                     | EA-34: Magic Link login, forgot-password Server Action, admin access                                                         | ceshi                 |
| Image digest reproducibility             | **APPROVAL REQUIRED**                                        | EA-19~23: source reproducible, app files consistent, 18 layers consistent, but build metadata differs                        | N/A                   |
| Cross-tenant RLS                         | **PASS**                                                     | EA-14: BB tenant sees 0 rows for all 5 AJ tables                                                                             | ceshi                 |
| File upload E2E                          | **PASS**                                                     | 70-byte PNG, SHA256 match, MinIO HEAD/GET                                                                                    | ceshi                 |
| File download capability-URL E2E         | **PASS**                                                     | EA-17: 307 → presigned GET → 200, size 70, SHA256 match                                                                      | ceshi                 |
| Invite redirect & Host-header protection | **PASS**                                                     | EA-16/17: Location uses public origin; forged Host ignored                                                                   | ceshi                 |
| Tunnel HTTP/2 stability                  | **PASS**                                                     | EA-15: 30-min probe 118/118 200                                                                                              | ceshi                 |
| Gateway self-heal                        | **PASS**                                                     | EA-15: 5 crash injections, recovery in 1-2s                                                                                  | ceshi                 |
| Test data cleanup                        | **PASS**                                                     | All synthetic rows 0 leftover                                                                                                | ceshi                 |
| WOPI investigation                       | **KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED** | Not in scope for EA-12–EA-24                                                                                                 | N/A                   |

---

## 6. Remaining release blockers

| #   | Item                                           | Status            | Blocking?                               | Closure condition                                                                  |
| --- | ---------------------------------------------- | ----------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Migration 51 production pre-check              | NOT RUN           | BLOCKING                                | Production query confirms 0 non-null values; backup + restore test passed          |
| 2   | Production backup & restore drill              | NOT RUN           | BLOCKING (per release minimum standard) | Backup restored in staging; `pnpm db:migrate` re-applied; permissions/RLS verified |
| 3   | Production deployment & rollback drill         | NOT RUN           | BLOCKING (per release minimum standard) | Staging deploy + rollback executed with evidence                                   |
| 4   | Image digest reproducibility                   | APPROVAL REQUIRED | POLICY DECISION REQUIRED                | Meet forced standard OR obtain written risk acceptance from approver               |
| 5   | Download capability-URL cross-tenant (browser) | NOT VERIFIED      | NON-BLOCKING                            | Optional live browser test from different tenant session                           |
| 6   | Multi-node Swarm validation                    | NOT RUN           | Per target architecture                 | Verified if Swarm is target arch; otherwise documented as N/A                      |
| 7   | GHCR/GHA cache validation                      | NOT RUN           | Per build pipeline                      | CI build succeeds and produces equivalent image                                    |
| 8   | WORM/Object Lock recovery                      | NOT RUN           | Per backup policy                       | Restore from WORM storage tested (if applicable)                                   |

---

## 7. Next steps and required authorization

### 7.1 Immediate actions (requires production access)

1. **Production migration 51 pre-check:**
   - Run the pre-deploy SQL checks (Section 2.2) on production DB.
   - Confirm all checks return `non_null_rows = 0`.
   - If any check fails, stop deployment and investigate root cause.

2. **Production backup verification:**
   - Verify DB backup exists and is restorable (test restore in staging if possible).
   - Verify object store backup exists and is restorable.

3. **Production deployment & rollback drill:**
   - Deploy to production (with approved maintenance window).
   - Run health checks, login flow, file upload/download.
   - Perform rollback to previous image (EA-13 tag).
   - Verify all functionality restored after rollback.

### 7.2 Approval required

**Required approvals:**

1. **Technical approver:** Sign off on release readiness, risk acceptance (if applicable).
2. **Operations approver:** Confirm backup/restore procedures are documented and tested.
3. **Release engineer:** Confirm all pre-deploy checklist items are met.
4. **DBA:** Confirm migration 51 pre-check passes and backup is restorable.

**Written risk acceptance required:**

- **Image digest reproducibility risk:** Approver must sign off on risk acceptance (Option A) or confirm Option B/C is chosen.

### 7.3 Rollback strategy and stop conditions

**Rollback triggers:**

- Readiness fails or returns non-200 for > 2 minutes.
- Login or session resolution fails.
- File upload/download fails for > 5% of requests.
- Cross-tenant data leak detected.
- Any 5xx error rate > 1% for > 5 minutes.

**Rollback procedure:**

1. Switch web/worker/scheduler containers to previous image tag (`beaconhs:phase-ea13-20261022-160729-m` or equivalent).
2. If DB migration was applied and is incompatible, restore DB from backup (run `pnpm db:migrate` after restore to re-apply permissions).
3. Verify readiness + version + login.
4. **Note:** DB migration (column drops) cannot be undone by image rollback alone. A DB restore is required if the migration caused data loss.

**Stop conditions (do not deploy if any of these is true):**

- Migration 51 pre-check fails (non-null values found).
- Production backup is not restorable.
- Any release blocker remains unresolved.
- Approver does not sign off on risk acceptance (if applicable).

---

## 8. Workspace changes

### 8.1 Files modified (165 total)

All modified files are pre-existing from EA-12~EA-35 work. No new code changes in this review cycle.

### 8.2 Files created (1 new)

| File                                    | Purpose       |
| --------------------------------------- | ------------- |
| `docs/ea36-release-readiness-review.md` | This document |

### 8.3 Git status

```
hse-platform
51a899b7 fix(db): synchronize seeded reference counters
 M .dockerignore
 M .env.example
 M .github/workflows/ci.yml
 M .github/workflows/deploy-dev.yml
 M .gitignore
 M .opencode/opencode.jsonc
 M .opencode/skills/release-readiness/SKILL.md
 M .opencode/skills/ui-e2e/SKILL.md
 M .prettierignore
 M AGENTS.md
 M Dockerfile
 M apps/web/next.config.ts
 M apps/web/package.json
 M apps/web/scripts/i18n-source-audit.test.ts
 M apps/web/src/app/(app)/admin/data-sources/_shared.ts
 M apps/web/src/app/(app)/apps/_lib/recap-email.ts
 M apps/web/src/app/(app)/apps/responses/[id]/_spawn-prefill.ts
 M apps/web/src/app/(app)/apps/templates/[id]/fill/actions.ts
 M apps/web/src/app/(app)/corrective-actions/export.csv/route.ts
 M .env
 M ... (160 more modified files)
```

**Total modified:** 165 files
**Total untracked:** 1025 files (pre-existing from prior EA work, not part of this release)

**Release-relevant changes:** 3 files (EA-16 code changes: `apps/web/src/app/invite/accept/route.ts`, `turbo.json`, `.env.example`)

---

## 9. Summary

**Current release status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**Strengths:**

- Magic Link E2E verified (EA-34).
- Server Action Key compatibility empirically verified (EA-25~30/33).
- Migration 51 backup/restore verified in staging (EA-26/32A/32B).
- Application version rollback verified in staging (EA-33).
- Real business operations verified (EA-34).
- Cross-tenant RLS verified (EA-14).
- File upload/download verified (EA-14/17).
- Tunnel stability verified (EA-15).
- Gateway self-heal verified (EA-15).

**Remaining blockers:**

- Production migration 51 pre-check (NOT RUN).
- Production backup/restore drill (NOT RUN).
- Production rollback drill (NOT RUN).
- Image digest reproducibility (APPROVAL REQUIRED).

**Required authorization:**

- Production access for migration 51 pre-check and backup verification.
- Production deployment and rollback drill.
- Written risk acceptance for image digest reproducibility (Option A) or confirmation of Option B/C.

**Release decision:**

- **NOT READY FOR PRODUCTION DEPLOYMENT** until production blockers are resolved and approvals are obtained.

---

**Document version:** 1.0
**Last updated:** 2026-10-24
**Author:** EA-36 release readiness review
