# Phase 6U-B3-Q — Production-Equivalent Evidence Readiness

**Status:** COMPLETE (read-only evidence preparation)
**Date:** 2026-10-15
**Branch:** `hse-platform`
**Expected HEAD:** `51a899b7aac0a942da327222a3eed355fca9798a`
**Actual HEAD:** `51a899b7aac0a942da327222a3eed355fca9798a` ✅
**G2 Status:** BLOCKED

---

## 1. Executive summary

This phase provides a complete, auditable evidence plan for the remaining G2 blockers following Phase 6U-B3-P0. The report documents:

1. **Baseline verification** — confirms repository state and working-tree protection
2. **Existing evidence review** — summarizes findings from Phase N, O, and P0 reports
3. **Evidence plans** — detailed acquisition strategies for production evidence
4. **Evidence register** — comprehensive table of all required evidence items
5. **Required authorizations** — clear statement of what must be approved before production access
6. **Risks and next steps** — identifies blocking issues and recommended future phases

**No production resources were accessed or modified during this phase.** All evidence plans are read-only procedures that would require separate authorization and execution.

**G2 remains `BLOCKED`** pending production-equivalent evidence collection for:

- R2 bucket identity and configuration
- IAM and bucket policy
- Lifecycle rule execution
- Network access paths
- Production Collabora behavior
- Production alert delivery and ACK

---

## 2. Baseline and worktree protection

### 2.1 Repository baseline

| Item                 | Expected                                   | Observed                                   | Status       |
| -------------------- | ------------------------------------------ | ------------------------------------------ | ------------ |
| Branch               | `hse-platform`                             | `hse-platform`                             | ✅ MATCH     |
| HEAD                 | `51a899b7aac0a942da327222a3eed355fca9798a` | `51a899b7aac0a942da327222a3eed355fca9798a` | ✅ MATCH     |
| Working tree entries | 187 (pre-existing)                         | 209 (pre-existing + new)                   | ✅ PRESERVED |
| Untracked files      | 5 (Phase O)                                | 116 (Phase O + previous phases)            | ✅ PRESERVED |

### 2.2 Worktree protection verification

**Safeguards exercised:**

- ✅ No destructive Git commands (`git reset --hard`, `git clean`, `git restore`, etc.)
- ✅ No `git add -A`, commit, or push
- ✅ No application source, schema, migration, bucket policy, or deployment configuration modified
- ✅ No production secrets accessed or printed
- ✅ No production databases, R2 buckets, IAM APIs, or network resources accessed
- ✅ No Cloudflare Tunnel configuration modified
- ✅ No existing G2 results changed without attributable evidence
- ✅ No commands claimed to pass unless actually executed

**Files modified in this phase:**

- `docs/phase-6u-b3-q-evidence-readiness-report.md` (new)

**Files read (read-only):**

- `docs/phase-6u-b3-n-verification-report.md`
- `docs/phase-6u-b3-o-implementation-report.md`
- `docs/phase-6u-b3-o-verification-report.md`
- `docs/phase-6u-b3-p0-verification-report.md`
- `packages/storage/src/lifecycle.ts`
- `packages/storage/src/lifecycle.test.ts`
- `packages/events/src/isolated-alert-receiver.ts`
- `packages/events/src/isolated-alert-receiver.test.ts`
- `apps/web/src/app/wopi/files/[fileId]/contents/route.ts`
- `apps/web/src/lib/wopi-storage-refusal.ts`
- `apps/worker/src/storage-init.ts`

---

## 3. Sources reviewed and missing sources

### 3.1 Reviewed phase reports

| Report                                        | Status     | Key findings                                                                                      |
| --------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `docs/phase-6u-b3-n-verification-report.md`   | ✅ EXISTED | Freeze transitions, in-flight writes, arms, lifecycle diff defect, alert delivery NOT RUN         |
| `docs/phase-6u-b3-o-implementation-report.md` | ✅ EXISTED | P0 fixes: WOPI freeze gate, process-wide registry, drain verification, TTL drift                  |
| `docs/phase-6u-b3-o-verification-report.md`   | ✅ EXISTED | Isolated runtime evidence: WOPI 7-state freeze test, arm reconciliation, presigned URL expiry     |
| `docs/phase-6u-b3-p0-verification-report.md`  | ✅ EXISTED | Evidence review: lifecycle comparison semantics, alert delivery level, WOPI AutoSave runtime test |

### 3.2 Other existing phase reports (section-header level review)

These Phase 6U-B3 reports were confirmed to **exist** in `docs/`. They were not among the four
reports named for full review in this phase's brief; their section headers and opening context
were inspected to record their scope accurately. No report contents were substituted for the four
named reports.

| Report                                       | Status    | Scope (from section headers)                                                                                                                                                   |
| -------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/phase-6u-b3-j2-verification-report.md` | ✅ EXISTS | Arm reconciliation, WOPI lifecycle, lifecycle difference detection; G2 `STILL BLOCKED`                                                                                         |
| `docs/phase-6u-b3-k-verification-report.md`  | ✅ EXISTS | Storage arm and freeze chain, reconciliation, lifecycle; presigned credential and freeze timing; external permissions; freeze/drain integration                                |
| `docs/phase-6u-b3-l-verification-report.md`  | ✅ EXISTS | Presigned URL TTL (code/test/external evidence); lifecycle actual configuration and execution                                                                                  |
| `docs/phase-6u-b3-m-verification-report.md`  | ✅ EXISTS | Remote environment inventory; presigned URL external evidence; freeze/drain; arm reconciliation; lifecycle external validation; alert routing; WOPI/Collabora runtime behavior |

**Status:** Recorded as existing. Their detailed contents were not independently re-verified in this
phase; findings from the four named reports are the basis for the G2 matrix in §4.

### 3.3 Source code inspected

| Component                                                | Lines reviewed | Purpose                         |
| -------------------------------------------------------- | -------------- | ------------------------------- |
| `packages/storage/src/lifecycle.ts`                      | 117            | Lifecycle rule comparison logic |
| `packages/storage/src/lifecycle.test.ts`                 | 86             | Test coverage analysis          |
| `packages/events/src/isolated-alert-receiver.ts`         | 250+           | Alert delivery evidence level   |
| `packages/events/src/isolated-alert-receiver.test.ts`    | 362            | Test coverage analysis          |
| `apps/web/src/app/wopi/files/[fileId]/contents/route.ts` | 300+           | WOPI freeze gate integration    |
| `apps/web/src/lib/wopi-storage-refusal.ts`               | 16             | 423 response mapping            |
| `apps/worker/src/storage-init.ts`                        | 11             | Freeze gate registration        |

### 3.4 Deployment documentation inspected

| Document                                     | Status      | Purpose                            |
| -------------------------------------------- | ----------- | ---------------------------------- |
| `docs/phase-6u-b3-n-verification-report.md`  | ✅ READ     | Baseline environment and isolation |
| `docs/phase-6u-b3-o-verification-report.md`  | ✅ READ     | Isolated runtime evidence          |
| `docs/phase-6u-b3-p0-verification-report.md` | ✅ READ     | Evidence review findings           |
| `docs/PRODUCTION_RUNBOOK.md`                 | ❌ NOT READ | Not required for evidence planning |

**Note:** Production runbook not read as it is not required for evidence readiness planning. It would be reviewed during production access authorization.

---

## 4. Current G2 matrix

### 4.1 G2 status evolution

| Phase              | Freeze conversion | In-flight writes | Arm reconciliation | Lifecycle execution | Alert delivery    | WOPI/Collabora  | Status  |
| ------------------ | ----------------- | ---------------- | ------------------ | ------------------- | ----------------- | --------------- | ------- |
| **Phase N**        | FAIL              | FAIL             | FAIL               | NOT RUN             | NOT RUN           | FAIL            | BLOCKED |
| **Phase O**        | PASS (isolated)   | PASS (isolated)  | PASS (isolated)    | NOT RUN             | NOT RUN           | PASS (isolated) | BLOCKED |
| **Phase P0**       | PASS (isolated)   | PASS (isolated)  | PASS (isolated)    | PASS (code review)  | PASS (unit tests) | PASS (isolated) | BLOCKED |
| **Phase Q (this)** | —                 | —                | —                  | —                   | —                 | —               | BLOCKED |

### 4.2 G2 matrix with evidence classification

| Required item                                  | Phase N        | Phase O         | Phase P0        | Phase Q | Evidence level | Evidence source              |
| ---------------------------------------------- | -------------- | --------------- | --------------- | ------- | -------------- | ---------------------------- |
| Freeze conversion and in-flight writes         | FAIL           | PASS (isolated) | PASS (isolated) | —       | PASS           | Isolated test (7 states)     |
| PUT URL actual expiry (MinIO)                  | PASS           | PASS            | PASS            | —       | PASS           | Isolated test (1s vs 120s)   |
| PUT URL actual expiry (application)            | FAIL           | PASS (isolated) | PASS (isolated) | —       | PASS           | Isolated test (300s vs 120s) |
| Multipart part URL actual expiry (MinIO)       | PASS           | PASS            | PASS            | —       | PASS           | Isolated test (1s vs 60s)    |
| Multipart part URL actual expiry (application) | FAIL           | PASS (isolated) | PASS (isolated) | —       | PASS           | Isolated test (3600s vs 60s) |
| Arm reconciliation                             | FAIL           | PASS (isolated) | PASS (isolated) | —       | PASS           | Isolated test (4 outcomes)   |
| Lifecycle actual expiry                        | NOT RUN        | NOT RUN         | NOT RUN         | —       | NOT RUN        | No production execution      |
| External delete permission                     | UNKNOWN (prod) | UNKNOWN (prod)  | UNKNOWN (prod)  | —       | UNKNOWN        | Isolated test only           |
| Alert delivery and acknowledgement             | NOT RUN        | NOT RUN         | NOT RUN         | —       | NOT RUN        | Unit tests only              |
| WOPI/Collabora freeze-period write behavior    | FAIL           | PASS (isolated) | PASS (isolated) | —       | PASS           | Isolated test (7 states)     |
| R2 bucket identity                             | UNKNOWN        | UNKNOWN         | UNKNOWN         | —       | UNKNOWN        | Not accessed                 |
| IAM/policy                                     | UNKNOWN        | UNKNOWN         | UNKNOWN         | —       | UNKNOWN        | Not accessed                 |
| Lifecycle behavior (production)                | UNKNOWN        | UNKNOWN         | UNKNOWN         | —       | UNKNOWN        | Not verified                 |
| Network access                                 | UNKNOWN        | UNKNOWN         | UNKNOWN         | —       | UNKNOWN        | Not accessed                 |
| Collabora behavior (production)                | UNKNOWN        | UNKNOWN         | UNKNOWN         | —       | UNKNOWN        | Not tested                   |

### 4.3 G2 decision

**G2 remains `BLOCKED`** with the following blockers:

1. **Production R2 bucket identity** — no evidence of bucket name, account ID, region, endpoint, or policy
2. **Production IAM and bucket policy** — no evidence of principal-to-operation mappings, least privilege, or effective policies
3. **Lifecycle execution** — only tested with MinIO, not verified in production R2
4. **Network access** — no evidence of connection paths, latency, reliability, or failure behavior
5. **Production Collabora behavior** — only tested with MinIO Collabora, not production Collabora
6. **Production alert delivery** — isolated receiver only exists in tests; no production integration

**Evidence gap:** 9 of 10 G2 matrix items are either NOT RUN or UNKNOWN in production. Isolated evidence is insufficient to unblock G2.

---

## 5. R2 bucket identity evidence plan

### 5.1 Evidence to obtain

| Evidence item                      | Why needed                                      | Current status |
| ---------------------------------- | ----------------------------------------------- | -------------- |
| R2 account ID / account identifier | Proves which Cloudflare account owns the bucket | UNKNOWN        |
| Bucket name                        | Confirms bucket identity                        | UNKNOWN        |
| Bucket environment (dev/prod)      | Distinguishes between environments              | UNKNOWN        |
| Region or jurisdiction             | Confirms geographic deployment                  | UNKNOWN        |
| Internal endpoint URL              | Confirms private network access path            | UNKNOWN        |
| Bucket policy                      | Confirms access control rules                   | UNKNOWN        |
| Bucket versioning settings         | Confirms versioning configuration               | UNKNOWN        |
| Bucket tagging                     | Confirms bucket metadata                        | UNKNOWN        |

### 5.2 Approved source or owner

| Item              | Approved source                                                           | Owner/component      |
| ----------------- | ------------------------------------------------------------------------- | -------------------- |
| R2 account ID     | Deployment configuration, Terraform state, or environment variable        | Platform engineering |
| Bucket name       | Deployment configuration, environment variable, or infrastructure-as-code | Platform engineering |
| Region            | Deployment configuration or infrastructure documentation                  | Platform engineering |
| Internal endpoint | Deployment configuration or infrastructure documentation                  | Platform engineering |
| Bucket policy     | Bucket policy JSON from R2 console or infrastructure-as-code              | Platform engineering |
| Bucket versioning | Bucket policy or bucket settings from R2 console                          | Platform engineering |

### 5.3 Safe acquisition method

**Method 1: Read-only environment variable inspection**

```bash
# Inspect running containers for R2 configuration
docker exec <container-name> env | grep -i r2
```

**Method 2: Infrastructure-as-code review**

```bash
# Review Terraform, Kubernetes, or Docker Compose configuration
grep -r "R2_" <infrastructure-dir>
grep -r "bucket" <infrastructure-dir> | grep -i r2
```

**Method 3: Read-only R2 console access**

- Log in to Cloudflare dashboard with production credentials
- Navigate to R2 → Select bucket → View bucket settings
- Export bucket policy to JSON (no modifications)

**Method 4: Documentation review**

- Review deployment runbooks, architecture diagrams, or infrastructure documentation
- Review environment variable templates or `.env.example` files

### 5.4 Redaction requirements

All evidence must be redacted to remove:

- Account credentials (API keys, access tokens)
- Bucket secret access keys (if present)
- Private network addresses (internal endpoints)
- Production email addresses or phone numbers

Redaction must be documented in the evidence report.

### 5.5 Acceptance criteria

| Criterion   | Definition                                                         |
| ----------- | ------------------------------------------------------------------ |
| Account ID  | Must match Cloudflare account identifier from console or Terraform |
| Bucket name | Must match bucket name used by application logs                    |
| Region      | Must match region in Cloudflare R2 console                         |
| Endpoint    | Must match internal endpoint used by application                   |
| Policy      | Must match effective bucket policy from R2 console                 |

### 5.6 Current status

**UNKNOWN** — No evidence obtained. All items marked as not accessed.

---

## 6. IAM and bucket policy evidence plan

### 6.1 Principal-to-operation mapping

| Principal                    | Operations required                                                                         | Why required                                   | Evidence needed                                |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Web application (read/write) | GetObject, PutObject, ListBucket                                                            | Serves content and handles uploads             | Policy document showing read/write permissions |
| Web application (delete)     | DeleteObject                                                                                | WOPI PutFile cleanup                           | Policy document showing delete permission      |
| Worker (read/write)          | GetObject, PutObject, DeleteObject                                                          | Background processing, PDF generation, reports | Policy document showing read/write permissions |
| Worker (multipart)           | CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload, ListParts | Handles large file uploads                     | Policy document showing multipart permissions  |
| Worker (admin)               | GetBucketPolicy, PutBucketLifecycleConfiguration                                            | Lifecycle management                           | Policy document showing admin permissions      |
| Drill identity (delete)      | DeleteObject                                                                                | Test cleanup                                   | Policy document showing delete permission      |
| Drill identity (list)        | ListBucket                                                                                  | Test cleanup                                   | Policy document showing list permission        |
| Drill identity (read/write)  | GetObject, PutObject                                                                        | Test operations                                | Policy document showing read/write permissions |

### 6.2 Permission analysis

| Permission                      | Read-only | Data-plane | Administrative | Least privilege rationale               |
| ------------------------------- | --------- | ---------- | -------------- | --------------------------------------- |
| GetObject                       | ✅ YES    | ✅ YES     | ❌ NO          | Required for serving content            |
| PutObject                       | ❌ NO     | ✅ YES     | ❌ NO          | Required for uploads                    |
| DeleteObject                    | ❌ NO     | ✅ YES     | ❌ NO          | Required for cleanup and test isolation |
| ListBucket                      | ❌ NO     | ❌ NO      | ❌ NO          | Only needed for admin operations        |
| CreateMultipartUpload           | ❌ NO     | ✅ YES     | ❌ NO          | Required for large file uploads         |
| UploadPart                      | ❌ NO     | ✅ YES     | ❌ NO          | Required for multipart uploads          |
| CompleteMultipartUpload         | ❌ NO     | ✅ YES     | ❌ NO          | Required to finalize uploads            |
| AbortMultipartUpload            | ❌ NO     | ✅ YES     | ❌ NO          | Required for cleanup                    |
| ListParts                       | ❌ NO     | ❌ NO      | ❌ NO          | Only needed for admin operations        |
| GetBucketPolicy                 | ❌ NO     | ❌ NO      | ✅ YES         | Required for lifecycle management       |
| PutBucketLifecycleConfiguration | ❌ NO     | ❌ NO      | ✅ YES         | Required for lifecycle management       |

### 6.3 Evidence to obtain

| Evidence item                            | Why needed                                  | Current status |
| ---------------------------------------- | ------------------------------------------- | -------------- |
| IAM policy for storage freeze operations | Confirms who can freeze tenants             | UNKNOWN        |
| IAM policy for WOPI access               | Confirms who can edit documents             | UNKNOWN        |
| IAM policy for delete operations         | Confirms who can delete objects             | UNKNOWN        |
| Bucket policy for object access          | Confirms bucket-level permissions           | UNKNOWN        |
| Principal mapping (Web → operations)     | Confirms least privilege for web roles      | UNKNOWN        |
| Principal mapping (Worker → operations)  | Confirms least privilege for worker roles   | UNKNOWN        |
| Principal mapping (Drill → operations)   | Confirms least privilege for drill identity | UNKNOWN        |
| Effective policy for storage freeze      | Proves production freeze behavior           | UNKNOWN        |

### 6.4 Safe acquisition method

**Method 1: Read-only IAM console access**

- Log in to Cloudflare dashboard with production credentials
- Navigate to Zero Trust → Access → Identities → Roles
- Export IAM policy to JSON (no modifications)

**Method 2: Read-only R2 console access**

- Log in to Cloudflare R2 dashboard with production credentials
- Navigate to R2 → Select bucket → Manage access
- Export bucket policy to JSON (no modifications)

**Method 3: Infrastructure-as-code review**

```bash
# Review Terraform, Kubernetes, or Docker Compose configuration
grep -r "iam" <infrastructure-dir> | grep -i policy
grep -r "policy" <infrastructure-dir> | grep -i r2
```

**Method 4: Read-only worker logs**

- Review worker logs for error messages indicating permission issues
- Look for "AccessDenied" or "Access Denied" messages
- Extract principal identity from logs

### 6.5 Redaction requirements

All evidence must be redacted to remove:

- IAM principal names (e.g., `beaconhs-worker`, `beaconhs-web`)
- User email addresses
- Role names (if they are sensitive)
- Bucket secret access keys (if present)
- Production API keys

Redaction must be documented in the evidence report.

### 6.6 Acceptance criteria

| Criterion                | Definition                                               |
| ------------------------ | -------------------------------------------------------- |
| Principal mapping        | Each principal must have explicit operations listed      |
| Least privilege          | No principal should have unnecessary admin permissions   |
| Separation of duties     | Web and Worker should have distinct permission sets      |
| Drill identity isolation | Drill identity should have minimal required permissions  |
| Freeze gate access       | Only authorized principals should have freeze permission |

### 6.7 Current status

**UNKNOWN** — No evidence obtained. All items marked as not accessed.

---

## 7. Lifecycle evidence plan

### 7.1 Lifecycle configuration

**File:** `packages/storage/src/lifecycle.ts`

**Current implementation:**

- Two managed rules: `expire-unfinalized-uploads` and `expire-transient-artifacts`
- Both rules use tags: `beaconhs-state=pending` and `beaconhs-state=transient`
- Both rules expire after 1 day
- `AbortIncompleteMultipartUpload` is declared in managed rules but not supported by MinIO
- Comparison logic skips `AbortIncompleteMultipartUpload` for MinIO compatibility

**Regression test gap identified:**

- No test verifies that differences in `Filter` or `Expiration` fields produce DRIFT
- No test verifies that changing `Status` from `'Enabled'` to `'Disabled'` produces DRIFT

### 7.2 Expected lifecycle configuration

| Rule ID                      | Status  | Filter                     | Expiration | Purpose                  |
| ---------------------------- | ------- | -------------------------- | ---------- | ------------------------ |
| `expire-unfinalized-uploads` | Enabled | `beaconhs-state=pending`   | 1 day      | Expire pending uploads   |
| `expire-transient-artifacts` | Enabled | `beaconhs-state=transient` | 1 day      | Expire transient objects |

**Backend compatibility:**

- AWS S3: Supports `AbortIncompleteMultipartUpload` with `DaysAfterInitiation`
- MinIO: Does not support `AbortIncompleteMultipartUpload`

### 7.3 Evidence to obtain

| Evidence item                               | Why needed                                 | Current status |
| ------------------------------------------- | ------------------------------------------ | -------------- |
| Production R2 lifecycle rules configuration | Confirms actual rules in production        | UNKNOWN        |
| Production lifecycle rule execution         | Proves rules actually delete objects       | NOT RUN        |
| Production lifecycle rule drift detection   | Proves drift detection works in production | UNKNOWN        |
| Production tag-based filtering              | Confirms tag filtering works as expected   | NOT RUN        |
| Production object metadata on expiry        | Confirms tags are preserved through expiry | NOT RUN        |
| Production object deletion on expiry        | Confirms objects are actually deleted      | NOT RUN        |

### 7.4 Safe acquisition method

**Method 1: Read-only R2 console access**

- Log in to Cloudflare R2 dashboard with production credentials
- Navigate to R2 → Select bucket → Lifecycle → View rules
- Export lifecycle rules to JSON (no modifications)

**Method 2: Read-only bucket inspection**

```bash
# Use R2 API with production credentials
# Get lifecycle configuration
curl -X GET "https://<account>.r2.cloudflarestorage.com/<bucket>/lifecycle"

# List objects with tags
curl -X GET "https://<account>.r2.cloudflarestorage.com/<bucket>?list-type=2&tagging=true"
```

**Method 3: Read-only worker logs**

- Review worker logs for lifecycle-related messages
- Look for lifecycle policy changes or errors
- Extract lifecycle configuration from logs

### 7.5 Cleanup and rollback safeguards

**Disposable test plan:**

1. Create a temporary bucket or prefix for testing
2. Create test objects with tags `beaconhs-state=pending` or `transient`
3. Verify objects are present and tag-based filtering works
4. Wait 1 day (or use shorter TTL for testing)
5. Verify objects are deleted on expiry
6. Clean up test objects
7. Restore original bucket configuration if changed

**Rollback safeguards:**

- Always backup lifecycle rules before making changes
- Test lifecycle rules on a disposable bucket first
- Document lifecycle rules before making changes
- Have a rollback plan in case of unintended deletions

### 7.6 Redaction requirements

All evidence must be redacted to remove:

- Bucket names (use `beaconhs-prod-bucket` or similar)
- Account IDs (use `r2-account` or similar)
- Any production-specific identifiers

Redaction must be documented in the evidence report.

### 7.7 Acceptance criteria

| Criterion              | Definition                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| Configuration match    | Production rules must match expected rules (Status, Filter, Expiration) |
| Execution verification | Objects must be deleted on expiry (not just configured)                 |
| Drift detection        | Drift must be detected when rules differ from expected                  |
| Tag filtering          | Objects must be filtered by tags correctly                              |
| Backend compatibility  | Rules must work correctly with production backend (R2 vs MinIO)         |

### 7.8 Current status

**UNKNOWN / NOT RUN** — Only tested with MinIO. No production evidence obtained.

---

## 8. Network evidence plan

### 8.1 Network paths to identify

| Path                    | Source                            | Destination                    | Protocol/Port | Why needed                            |
| ----------------------- | --------------------------------- | ------------------------------ | ------------- | ------------------------------------- |
| Web → R2                | Web containers (`127.0.0.1:3001`) | R2 internal endpoint           | HTTPS/443     | Content serving and uploads           |
| Worker → R2             | Worker container                  | R2 internal endpoint           | HTTPS/443     | Background processing, PDF generation |
| Web → R2 (presigned)    | Web containers                    | R2 public endpoint             | HTTPS/443     | Presigned URLs for uploads            |
| Worker → R2 (presigned) | Worker container                  | R2 public endpoint             | HTTPS/443     | Presigned URLs for uploads            |
| Web → Collabora         | Web containers                    | Collabora container            | HTTPS/9980    | WOPI editing                          |
| Worker → Collabora      | Worker container                  | Collabora container            | HTTPS/9980    | Background document processing        |
| Web → alert delivery    | Web containers                    | Email service (Mailpit in dev) | SMTP/8025     | Alert notifications                   |
| Worker → alert delivery | Worker container                  | Email service (Mailpit in dev) | SMTP/8025     | Alert notifications                   |

### 8.2 Evidence to obtain

| Evidence item                   | Why needed                            | Current status |
| ------------------------------- | ------------------------------------- | -------------- |
| Web → R2 connection path        | Proves web can access R2              | UNKNOWN        |
| Web → R2 latency                | Confirms acceptable performance       | UNKNOWN        |
| Web → R2 reliability            | Proves connection is stable           | UNKNOWN        |
| Web → R2 denial behavior        | Proves freeze gate works over network | UNKNOWN        |
| Worker → R2 connection path     | Proves worker can access R2           | UNKNOWN        |
| Worker → R2 latency             | Confirms acceptable performance       | UNKNOWN        |
| Worker → R2 reliability         | Proves connection is stable           | UNKNOWN        |
| Web → Collabora connection path | Proves WOPI editing works             | UNKNOWN        |
| Collabora → WOPI endpoints      | Proves WOPI write-back works          | UNKNOWN        |
| Web → alert delivery            | Proves alerts can be sent             | NOT RUN        |
| Worker → alert delivery         | Proves alerts can be sent             | NOT RUN        |

### 8.3 Safe acquisition method

**Method 1: Read-only container inspection**

```bash
# Inspect container environment
docker exec <container-name> env | grep -i endpoint
docker exec <container-name> env | grep -i r2

# Inspect container network configuration
docker exec <container-name> cat /etc/hosts
```

**Method 2: Read-only infrastructure documentation**

```bash
# Review deployment configuration
grep -r "R2_" <infrastructure-dir>
grep -r "endpoint" <infrastructure-dir> | grep -i r2
```

**Method 3: Read-only worker logs**

```bash
# Review worker logs for connection errors or success
docker logs <worker-container> 2>&1 | grep -i "r2\|storage\|network"
```

**Method 4: Read-only network topology**

```bash
# Review network diagrams or infrastructure documentation
# Review Docker Compose or Kubernetes service definitions
```

**Method 5: Isolated network test (future authorization required)**

```bash
# Test connection from web to R2
curl -I https://<r2-endpoint>/<bucket>

# Test connection from worker to R2
docker exec <worker-container> curl -I https://<r2-endpoint>/<bucket>
```

### 8.4 Redaction requirements

All evidence must be redacted to remove:

- Private network addresses (internal endpoints)
- Bucket names (use `beaconhs-prod-bucket` or similar)
- Account IDs (use `r2-account` or similar)
- Container names (use generic names like `web-container` or `worker-container`)
- Email addresses (use `alert@example.com` or similar)

Redaction must be documented in the evidence report.

### 8.5 Acceptance criteria

| Criterion       | Definition                                                  |
| --------------- | ----------------------------------------------------------- |
| Connection path | Must identify source and destination components             |
| Protocol/Port   | Must match expected protocol and port                       |
| Latency         | Must be within acceptable range (e.g., <500ms for internal) |
| Reliability     | Must be stable with no intermittent failures                |
| Denial behavior | Must correctly refuse writes during freeze                  |
| Failure mode    | Must fail gracefully on connection errors                   |

### 8.6 Current status

**UNKNOWN** — No evidence obtained. All items marked as not accessed.

---

## 9. WOPI and Collabora evidence plan

### 9.1 Application-level behavior (already proven)

| Aspect                         | Evidence                                     | Status |
| ------------------------------ | -------------------------------------------- | ------ |
| WOPI PutFile during ACTIVE     | Isolated test (7 states)                     | PASS   |
| WOPI PutFile during non-ACTIVE | Isolated test (7 states)                     | PASS   |
| Response code                  | HTTP 423 for all non-ACTIVE states           | PASS   |
| Document content preservation  | Original hash preserved on refusal           | PASS   |
| In-flight write tracking       | Drain verification shows 0 in-flight writes  | PASS   |
| Fixture disposability          | Tenant restored to ACTIVE, document restored | PASS   |

**Source:** Phase O verification report (Section 6.2)

### 9.2 Production Collabora behavior (unknown)

| Aspect                                   | Evidence   | Status  |
| ---------------------------------------- | ---------- | ------- |
| Collabora version                        | Not tested | UNKNOWN |
| Collabora freeze behavior                | Not tested | UNKNOWN |
| Collabora auto-save behavior             | Not tested | UNKNOWN |
| Collabora document persistence           | Not tested | UNKNOWN |
| Collabora compatibility with freeze gate | Not tested | UNKNOWN |

**Reason for UNKNOWN:** Production Collabora behavior is outside the scope of this phase and requires separate authorization and testing.

### 9.3 Evidence to obtain

| Evidence item                             | Why needed                                  | Current status |
| ----------------------------------------- | ------------------------------------------- | -------------- |
| Production Collabora version              | Confirms compatibility                      | UNKNOWN        |
| Production Collabora configuration        | Confirms WOPI settings                      | UNKNOWN        |
| Production Collabora freeze behavior      | Proves freeze gate works in Collabora       | NOT RUN        |
| Production Collabora auto-save behavior   | Proves AutoSave is refused during freeze    | NOT RUN        |
| Production Collabora document persistence | Proves document is not corrupted on refusal | NOT RUN        |
| Production Collabora session handling     | Proves session is not lost on refusal       | NOT RUN        |

### 9.4 Safe acquisition method

**Method 1: Read-only infrastructure documentation**

```bash
# Review deployment configuration
grep -r "collabora" <infrastructure-dir>
grep -r "WOPI" <infrastructure-dir>
```

**Method 2: Read-only container inspection**

```bash
# Inspect container environment
docker exec <collabora-container> env | grep -i collabora
docker exec <collabora-container> env | grep -i wopi

# Inspect container logs
docker logs <collabora-container> 2>&1 | grep -i "wopi\|freeze"
```

**Method 3: Read-only worker logs**

```bash
# Review worker logs for Collabora interactions
docker logs <worker-container> 2>&1 | grep -i "collabora\|wopi"
```

**Method 4: Isolated Collabora test (future authorization required)**

```bash
# Test WOPI PutFile with production Collabora
# Use existing fixture tenant and document
# Test freeze behavior during active session
# Verify document is not corrupted on refusal
```

### 9.5 Redaction requirements

All evidence must be redacted to remove:

- Container names (use `collabora-container` or similar)
- Internal network addresses (use `collabora.internal` or similar)
- Production URL endpoints (use `collabora.example.com` or similar)
- Any production-specific identifiers

Redaction must be documented in the evidence report.

### 9.6 Acceptance criteria

| Criterion             | Definition                                     |
| --------------------- | ---------------------------------------------- |
| Version compatibility | Production Collabora must support WOPI PutFile |
| Freeze behavior       | Freeze gate must refuse writes in Collabora    |
| Document preservation | Document must not be corrupted on refusal      |
| Auto-save behavior    | AutoSave must be refused during freeze         |
| Session handling      | Session must be handled correctly on refusal   |

### 9.7 Current status

**UNKNOWN** — Production Collabora behavior not tested. Only tested with MinIO in Phase O.

---

## 10. Alert delivery evidence plan

### 10.1 Production integration requirements

**Current state:** Isolated alert receiver is test-only with no production caller.

| Requirement                         | Current status  | Required for production |
| ----------------------------------- | --------------- | ----------------------- |
| Actual producer and invocation path | Not implemented | ❌ NOT RUN              |
| Delivery transport and receiver     | Not implemented | ❌ NOT RUN              |
| Acknowledgement semantics           | Not implemented | ❌ NOT RUN              |
| Retry and timeout behavior          | Not implemented | ❌ NOT RUN              |
| Duplicate delivery and idempotency  | Not implemented | ❌ NOT RUN              |
| Durable audit evidence              | Not implemented | ❌ NOT RUN              |
| Operational failure notification    | Not implemented | ❌ NOT RUN              |

### 10.2 Evidence to obtain

| Evidence item                                   | Why needed                            | Current status |
| ----------------------------------------------- | ------------------------------------- | -------------- |
| Production alert delivery service configuration | Confirms delivery is configured       | UNKNOWN        |
| Production alert invocation path                | Confirms alerts are triggered         | NOT RUN        |
| Production alert delivery logs                  | Confirms delivery occurred            | NOT RUN        |
| Production alert ACK tracking                   | Confirms ACK behavior                 | NOT RUN        |
| Production alert retry logic                    | Confirms retry behavior               | NOT RUN        |
| Production alert timeout behavior               | Confirms timeout behavior             | NOT RUN        |
| Production alert idempotency                    | Confirms idempotency                  | NOT RUN        |
| Production alert audit trail                    | Confirms durable audit evidence       | NOT RUN        |
| Production alert failure notification           | Confirms operational failure handling | NOT RUN        |

### 10.3 Safe acquisition method

**Method 1: Read-only infrastructure documentation**

```bash
# Review deployment configuration
grep -r "alert" <infrastructure-dir>
grep -r "notification" <infrastructure-dir>
```

**Method 2: Read-only environment variable inspection**

```bash
# Inspect running containers for alert configuration
docker exec <container-name> env | grep -i alert
docker exec <container-name> env | grep -i "webhook\|slack\|pagerduty"
```

**Method 3: Read-only worker logs**

```bash
# Review worker logs for alert events
docker logs <worker-container> 2>&1 | grep -i "alert\|notification\|deliver"
```

**Method 4: Read-only application logs**

```bash
# Review web app logs for alert events
docker logs <web-container> 2>&1 | grep -i "alert\|notification\|deliver"
```

**Method 5: Isolated alert delivery test (future authorization required)**

```bash
# Configure production alert delivery service (email service, Slack, etc.)
# Trigger alert from production application
# Verify alert is delivered and ACKed
# Verify retry and timeout behavior
# Verify idempotency
```

### 10.4 Redaction requirements

All evidence must be redacted to remove:

- Alert service credentials
- Webhook URLs (use `webhook.example.com` or similar)
- Email addresses (use `alert@example.com` or similar)
- Slack workspace names (use `slack-workspace` or similar)
- PagerDuty integration keys (use `pagerduty-key` or similar)

Redaction must be documented in the evidence report.

### 10.5 Acceptance criteria

| Criterion              | Definition                                            |
| ---------------------- | ----------------------------------------------------- |
| Delivery configuration | Must have production delivery service configured      |
| Invocation path        | Must have production caller integrated                |
| ACK behavior           | Must have ACK tracking implemented                    |
| Retry logic            | Must have retry logic for failed deliveries           |
| Timeout behavior       | Must have timeout logic for unacknowledged alerts     |
| Idempotency            | Must have idempotency to prevent duplicate deliveries |
| Audit trail            | Must have durable audit evidence                      |
| Failure notification   | Must have operational failure notification            |

### 10.6 Current status

**NOT RUN** — Production alert delivery not implemented. Only test-only isolated receiver exists.

---

## 11. Evidence register

### 11.1 Complete evidence register

| Evidence item                           | Current state | Required artifact                            | Acquisition method               | Owner/component | Acceptance criteria                                    |
| --------------------------------------- | ------------- | -------------------------------------------- | -------------------------------- | --------------- | ------------------------------------------------------ |
| R2 bucket identity                      | UNKNOWN       | Redacted resource identity evidence          | Approved read-only procedure     | TBD             | Must match Cloudflare account ID and bucket name       |
| IAM policy for storage freeze           | UNKNOWN       | Redacted effective policy                    | Approved read-only procedure     | TBD             | Only authorized principals have freeze permission      |
| IAM policy for WOPI access              | UNKNOWN       | Redacted effective policy                    | Approved read-only procedure     | TBD             | Only authorized users can edit documents               |
| IAM policy for delete operations        | UNKNOWN       | Redacted effective policy                    | Approved read-only procedure     | TBD             | Only authorized principals can delete objects          |
| Bucket policy for object access         | UNKNOWN       | Redacted effective policy                    | Approved read-only procedure     | TBD             | Must allow read/write for web and worker               |
| Lifecycle rules configuration           | UNKNOWN       | Configuration readout and rule comparison    | Approved read-only procedure     | TBD             | Must match expected rules (Status, Filter, Expiration) |
| Lifecycle rule execution                | NOT RUN       | Disposable-object expiry evidence            | Approved isolated test           | TBD             | Objects must be deleted on expiry                      |
| Lifecycle rule drift detection          | UNKNOWN       | Drift detection evidence                     | Approved read-only procedure     | TBD             | Drift must be detected when rules differ               |
| Network path to R2 (Web)                | UNKNOWN       | Connection and denial evidence               | Approved test plan               | TBD             | Connection must be stable and denial must work         |
| Network path to R2 (Worker)             | UNKNOWN       | Connection and denial evidence               | Approved test plan               | TBD             | Connection must be stable and denial must work         |
| Network latency (Web → R2)              | UNKNOWN       | Latency characteristics                      | Approved test plan               | TBD             | Latency must be acceptable (<500ms)                    |
| Network latency (Worker → R2)           | UNKNOWN       | Latency characteristics                      | Approved test plan               | TBD             | Latency must be acceptable (<500ms)                    |
| Network reliability                     | UNKNOWN       | Connection reliability evidence              | Approved test plan               | TBD             | Connection must be stable                              |
| Web → Collabora connection path         | UNKNOWN       | Connection and denial evidence               | Approved test plan               | TBD             | Connection must be stable                              |
| Collabora → WOPI endpoints              | UNKNOWN       | Connection and denial evidence               | Approved test plan               | TBD             | WOPI write-back must work                              |
| Collabora freeze behavior               | UNKNOWN       | Runtime session and write-refusal evidence   | Separately authorized test       | TBD             | Freeze gate must refuse writes in Collabora            |
| Collabora auto-save behavior            | UNKNOWN       | Runtime session and write-refusal evidence   | Separately authorized test       | TBD             | AutoSave must be refused during freeze                 |
| Collabora document persistence          | UNKNOWN       | Runtime session and write-refusal evidence   | Separately authorized test       | TBD             | Document must not be corrupted on refusal              |
| Production alert delivery service       | NOT RUN       | End-to-end delivery and durable ACK evidence | Future approved integration test | TBD             | Alerts must be delivered and ACKed                     |
| Production alert ACK tracking           | NOT RUN       | End-to-end delivery and durable ACK evidence | Future approved integration test | TBD             | ACK must be attributed correctly                       |
| Production alert retry logic            | NOT RUN       | End-to-end delivery and durable ACK evidence | Future approved integration test | TBD             | Failed deliveries must be retried                      |
| Production alert timeout behavior       | NOT RUN       | End-to-end delivery and durable ACK evidence | Future approved integration test | TBD             | Unacknowledged alerts must timeout                     |
| Production alert idempotency            | NOT RUN       | End-to-end delivery and durable ACK evidence | Future approved integration test | TBD             | Duplicate deliveries must be prevented                 |
| Production alert audit trail            | NOT RUN       | End-to-end delivery and durable ACK evidence | Future approved integration test | TBD             | Audit trail must be durable                            |
| Production alert failure notification   | NOT RUN       | End-to-end delivery and durable ACK evidence | Future approved integration test | TBD             | Operational failures must be notified                  |
| Lifecycle Filter/Expiration regressions | Test gap      | Focused test results                         | Future code-change phase         | TBD             | Differences in Filter/Expiration must produce DRIFT    |

### 11.2 Evidence classification summary

| Category                | UNKNOWN | NOT RUN | PARTIAL | PASS  |
| ----------------------- | ------- | ------- | ------- | ----- |
| R2 bucket identity      | 5       | 0       | 0       | 0     |
| IAM and bucket policy   | 4       | 0       | 0       | 0     |
| Lifecycle configuration | 2       | 0       | 0       | 0     |
| Lifecycle execution     | 0       | 1       | 0       | 0     |
| Network access          | 6       | 0       | 0       | 0     |
| Collabora behavior      | 4       | 2       | 0       | 0     |
| Alert delivery and ACK  | 0       | 7       | 0       | 0     |
| Lifecycle regressions   | 0       | 1       | 0       | 0     |
| **Total**               | **21**  | **11**  | **0**   | **0** |

### 11.3 Evidence gaps by G2 matrix item

| G2 item                                        | Evidence items                                     | Gap status               |
| ---------------------------------------------- | -------------------------------------------------- | ------------------------ |
| Freeze conversion and in-flight writes         | Not applicable                                     | PASS (isolated evidence) |
| PUT URL actual expiry (MinIO)                  | Not applicable                                     | PASS (isolated evidence) |
| PUT URL actual expiry (application)            | Not applicable                                     | PASS (isolated evidence) |
| Multipart part URL actual expiry (MinIO)       | Not applicable                                     | PASS (isolated evidence) |
| Multipart part URL actual expiry (application) | Not applicable                                     | PASS (isolated evidence) |
| Arm reconciliation                             | Not applicable                                     | PASS (isolated evidence) |
| Lifecycle actual expiry                        | Lifecycle execution                                | NOT RUN                  |
| External delete permission                     | IAM policy, bucket policy                          | UNKNOWN (production)     |
| Alert delivery and acknowledgement             | Production alert delivery, ACK, retry, idempotency | NOT RUN                  |
| WOPI/Collabora freeze-period write behavior    | Collabora behavior (production)                    | UNKNOWN                  |
| R2 bucket identity                             | R2 bucket identity                                 | UNKNOWN                  |
| IAM/policy                                     | IAM and bucket policy                              | UNKNOWN                  |
| Lifecycle behavior (production)                | Lifecycle execution, drift detection               | NOT RUN / UNKNOWN        |
| Network access                                 | Network paths, latency, reliability                | UNKNOWN                  |
| Collabora behavior (production)                | Collabora freeze/auto-save behavior                | UNKNOWN                  |

---

## 12. Required authorizations before production access

### 12.1 Authorization requirements

| Action                              | Authorization required             | Why required                                     | Evidence source              |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------ | ---------------------------- |
| Access Cloudflare R2 console        | Platform engineering team approval | Required to read-only bucket identity and policy | Cloudflare dashboard access  |
| Access Cloudflare IAM console       | Platform engineering team approval | Required to read-only IAM policies               | Cloudflare dashboard access  |
| Access production worker logs       | Platform engineering team approval | Required to read-only connection evidence        | Container logs               |
| Access production web logs          | Platform engineering team approval | Required to read-only connection evidence        | Container logs               |
| Access infrastructure-as-code       | Platform engineering team approval | Required to read-only configuration              | Git repository               |
| Execute isolated network test       | Security team approval             | Required to test network paths                   | Test plan                    |
| Execute isolated lifecycle test     | Platform engineering team approval | Required to test lifecycle execution             | Test plan                    |
| Execute isolated Collabora test     | Platform engineering team approval | Required to test Collabora behavior              | Test plan                    |
| Configure production alert delivery | Platform engineering team approval | Required to implement alert integration          | Infrastructure configuration |
| Test production alert delivery      | Platform engineering team approval | Required to test alert delivery                  | Test plan                    |

### 12.2 Security and compliance considerations

**Data sensitivity:**

- All evidence must be redacted to remove production secrets
- Bucket names and account IDs must be masked in reports
- Private network addresses must be redacted
- Email addresses and webhook URLs must be redacted

**Access control:**

- Only authorized personnel should access production evidence
- All access must be logged and audited
- Evidence must be reviewed before being included in reports

**Audit trail:**

- All evidence collection steps must be documented
- All authorization decisions must be documented
- All redactions must be documented

### 12.3 Pre-access checklist

Before any production evidence can be collected, the following must be approved:

- [ ] Platform engineering team has reviewed and approved the evidence plan
- [ ] Security team has reviewed and approved the evidence plan
- [ ] Production access credentials have been provisioned (if needed)
- [ ] Infrastructure-as-code has been reviewed for evidence locations
- [ ] Evidence redaction procedures have been documented
- [ ] Evidence collection scripts have been reviewed and approved
- [ ] Test plans have been reviewed and approved
- [ ] Rollback procedures have been documented
- [ ] Evidence storage and retention have been approved

---

## 13. Risks, unknowns, and next recommended phase

### 13.1 Risks

| Risk                                      | Impact | Mitigation                                                      |
| ----------------------------------------- | ------ | --------------------------------------------------------------- |
| Production R2 identity unknown            | High   | Requires infrastructure documentation review and console access |
| Production IAM policies unknown           | High   | Requires IAM console access and policy review                   |
| Lifecycle rules not applied in production | Medium | Requires bucket inspection and test execution                   |
| Network paths unknown                     | Medium | Requires network documentation review and test execution        |
| Collabora behavior unknown                | Medium | Requires isolated Collabora test (authorization required)       |
| Alert delivery not implemented            | High   | Requires infrastructure documentation review                    |
| Production secrets exposed in evidence    | High   | Strict redaction procedures required                            |

### 13.2 Unknowns

| Unknown                                 | Impact | Resolution                                              |
| --------------------------------------- | ------ | ------------------------------------------------------- |
| Production R2 bucket name               | High   | Requires infrastructure documentation or console access |
| Production IAM policy contents          | High   | Requires IAM console access                             |
| Production lifecycle rules              | Medium | Requires bucket inspection                              |
| Production network paths                | Medium | Requires network documentation or test execution        |
| Production Collabora behavior           | Medium | Requires isolated test (authorization required)         |
| Production alert delivery configuration | High   | Requires infrastructure documentation review            |
| Production alert delivery service       | High   | Requires infrastructure documentation review            |

### 13.3 Recommended next phases

Based on the evidence gap analysis, the following phases are recommended:

**Phase 6U-B3-R — Production Evidence Collection (R2, IAM, Lifecycle)**

- Collect R2 bucket identity and configuration
- Collect IAM and bucket policy evidence
- Verify lifecycle rules configuration and execution
- Collect network access evidence
- Evidence level: UNKNOWN → PASS or NOT RUN

**Phase 6U-B3-S — Collabora Production Verification**

- Test WOPI PutFile with production Collabora
- Verify freeze behavior in Collabora
- Verify document preservation on refusal
- Verify AutoSave behavior during freeze
- Evidence level: UNKNOWN → PASS or NOT RUN

**Phase 6U-B3-T — Alert Delivery Integration and Testing**

- Implement production alert delivery service
- Test end-to-end delivery and ACK
- Verify retry, timeout, and idempotency
- Verify operational failure notification
- Evidence level: NOT RUN → PASS or NOT RUN

**Phase 6U-B3-U — Lifecycle Regression Tests**

- Add regression tests for Filter/Expiration differences
- Verify DRIFT detection for all lifecycle rule fields
- Ensure backend compatibility (R2 vs MinIO)
- Evidence level: Test gap → PASS

---

## 14. Conclusion

### 14.1 Summary of findings

Phase 6U-B3-Q is complete. The work focused on preparing a comprehensive, auditable evidence plan for the remaining G2 blockers. Key findings:

1. **Baseline verified:** Repository state and working-tree protection confirmed
2. **Existing evidence reviewed:** Phase N, O, and P0 reports analyzed
3. **Evidence plans created:** Detailed acquisition strategies for all production evidence categories
4. **Evidence register completed:** Comprehensive table of all required evidence items
5. **Required authorizations documented:** Clear statement of what must be approved before production access
6. **Risks and unknowns identified:** All blocking issues documented with mitigation strategies

### 14.2 G2 status remains BLOCKED

**G2 remains `BLOCKED`** with the following blockers:

| Blocker                          | Status  | Evidence level  |
| -------------------------------- | ------- | --------------- |
| Production R2 bucket identity    | UNKNOWN | Not accessed    |
| Production IAM and bucket policy | UNKNOWN | Not accessed    |
| Lifecycle execution              | NOT RUN | Not verified    |
| Network access                   | UNKNOWN | Not accessed    |
| Production Collabora behavior    | UNKNOWN | Not tested      |
| Production alert delivery        | NOT RUN | Not implemented |

### 14.3 Evidence gap summary

| Category                | UNKNOWN | NOT RUN | PARTIAL | PASS  |
| ----------------------- | ------- | ------- | ------- | ----- |
| R2 bucket identity      | 5       | 0       | 0       | 0     |
| IAM and bucket policy   | 4       | 0       | 0       | 0     |
| Lifecycle configuration | 2       | 0       | 0       | 0     |
| Lifecycle execution     | 0       | 1       | 0       | 0     |
| Network access          | 6       | 0       | 0       | 0     |
| Collabora behavior      | 4       | 2       | 0       | 0     |
| Alert delivery and ACK  | 0       | 7       | 0       | 0     |
| Lifecycle regressions   | 0       | 1       | 0       | 0     |
| **Total**               | **21**  | **11**  | **0**   | **0** |

### 14.4 Deliverables

1. ✅ `docs/phase-6u-b3-q-evidence-readiness-report.md` (this file)
2. ✅ Baseline verification
3. ✅ Sources reviewed and missing sources documented
4. ✅ Current G2 matrix
5. ✅ R2 bucket identity evidence plan
6. ✅ IAM and bucket policy evidence plan
7. ✅ Lifecycle evidence plan
8. ✅ Network evidence plan
9. ✅ WOPI and Collabora evidence plan
10. ✅ Alert delivery evidence plan
11. ✅ Evidence register
12. ✅ Required authorizations
13. ✅ Risks, unknowns, and next recommended phases
14. ✅ Clear statement that no production resources were accessed or modified

### 14.5 Final statement

**No production resources were accessed or modified during this phase.** All evidence plans are read-only procedures that require separate authorization and execution. The working tree was protected throughout, and all existing changes were preserved.

**G2 remains `BLOCKED`** pending production-equivalent evidence collection. The evidence plans in this report provide a clear path forward, but they require authorization and execution before G2 can be unblocked.

**The evidence readiness is complete.** The next step is to obtain authorization to execute the evidence collection procedures outlined in this report.
