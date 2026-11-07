# Phase 6U-B3-R1-AUTH — Authorization Request & Read-Only Identity Readiness

**Status:** DRAFT AUTHORIZATION REQUEST — **nothing is authorized** until the approvers below sign
**Date:** 2026-10-15
**Branch:** `hse-platform`
**Expected / Actual HEAD:** `51a899b7aac0a942da327222a3eed355fca9798a` ✅
**G2 Status:** `BLOCKED`
**Companion documents:** `docs/phase-6u-b3-r0-authorization-and-readiness-report.md`,
`docs/phase-6u-b3-r1-execution-checklist.md`, `docs/phase-6u-b3-q-evidence-readiness-report.md`,
`docs/phase-6u-b3-p0-verification-report.md`

---

## 0. How to read this document

This is an **authorization request**, not a record of authorization. It enumerates, scope by scope,
what a future Phase R evidence-collection run would need so that an owner can approve or reject each
scope independently.

Two independent approval groups, deliberately **not bundled**:

- **Group A — Read-only inspection:** Scopes 1–4. Only inspection, reads, and diagnostics. No state
  change to any bucket/object.
- **Group B — Active mutation tests:** Scopes 5–8. Writes, deletes, expiry triggers, Collabora
  writes, and alerts. Each requires its own approved rollback plan.

**Approving Group A does NOT approve Group B.** Every scope carries its own `Approval` line to be
filled with the approver's name and an authorization reference. Every unknown approver, resource
identifier, and date is `TBD` — **nothing here is invented.**

---

## 1. Group A — Read-only inspection scopes (1–4)

### Scope 1 — Read production R2 bucket identity and non-secret configuration

| Field                                  | Value                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                            | Confirm the authoritative production bucket name/alias, existence, jurisdiction, and non-secret endpoint pattern for evidence; prove the app's configured intent matches reality |
| **Requested capabilities (read-only)** | S3 `HeadBucket`, `ListBucket`/`ListObjectsV2`; Cloudflare dashboard **read** of bucket settings; IaC read of R2 resources                                                        |
| **Affected resources & boundaries**    | Single production R2 bucket `<PROD_BUCKET_ALIAS>`; account `<ACCOUNT_ALIAS>`. No object bodies required for identity. Must not touch any other bucket or tenant                  |
| **Required identity & permissions**    | Tier B S3 read token for the one bucket **and/or** Tier A Cloudflare account read (see §3 matrix)                                                                                |
| **Acceptable evidence**                | Redacted `inventory` JSON: `bucket_exists:true`, endpoint reduced to `scheme://host:port`, no account id / keys                                                                  |
| **Prohibited actions**                 | Any write/delete/expiry; reading any object body; reading any other bucket/account; printing `.env`                                                                              |
| **Required approval owner**            | `TBD` (platform engineering lead + security approver)                                                                                                                            |
| **Rollback / cleanup**                 | None — read-only, no state change; delete only local evidence if revoked                                                                                                         |
| **Authorization expiry**               | `TBD` — recommend a bounded window (e.g., ≤30 days, single-use) recorded at approval                                                                                             |
| **Approval**                           | `Pending — approver: ______  AUTH-REF: ______  expiry: ______`                                                                                                                   |

### Scope 2 — Read effective IAM and bucket policy

| Field                                  | Value                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                            | Capture the effective policy and principal→operation mapping to verify least privilege for Web, Worker, drill/ops identities (Q-report matrix)                              |
| **Requested capabilities (read-only)** | Cloudflare dashboard/API **read** of IAM roles, account members, and effective policies; **read** of bucket policy if one exists. **Note:** this is NOT an S3-key operation |
| **Affected resources & boundaries**    | Cloudflare account `<ACCOUNT_ALIAS>` IAM surface; bucket policy for `<PROD_BUCKET_ALIAS>`. Read-only; no policy mutation                                                    |
| **Required identity & permissions**    | Tier A Cloudflare account-level read (see §3). An S3 access key **cannot** read account IAM policies — see §3 warning                                                       |
| **Acceptable evidence**                | Redacted effective-policy JSON: principal aliases → allowed actions → effect; `NoSuchBucketPolicy` recorded if none                                                         |
| **Prohibited actions**                 | Creating/editing/deleting IAM roles, tokens, or bucket policy; reading secret material                                                                                      |
| **Required approval owner**            | `TBD` (security/identity team, not platform operations)                                                                                                                     |
| **Rollback / cleanup**                 | None — read-only                                                                                                                                                            |
| **Authorization expiry**               | `TBD` — bounded window recorded at approval                                                                                                                                 |
| **Approval**                           | `Pending — approver: ______  AUTH-REF: ______  expiry: ______`                                                                                                              |

### Scope 3 — Read lifecycle configuration

| Field                                  | Value                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                            | Capture the actual lifecycle rules and their sha256 so configuration vs the managed spec (`withManagedStorageLifecycleRules`) can be compared for drift |
| **Requested capabilities (read-only)** | S3 `GetBucketLifecycleConfiguration`; Cloudflare dashboard read of lifecycle rules; IaC read                                                            |
| **Affected resources & boundaries**    | Bucket `<PROD_BUCKET_ALIAS>` lifecycle config only. No write, no TTL shortening                                                                         |
| **Required identity & permissions**    | Tier B S3 read token **or** Tier A dashboard read (see §3; lifecycle read over S3 for R2 is `UNVERIFIED` — dashboard is authoritative)                  |
| **Acceptable evidence**                | Redacted lifecycle readout (XML/JSON) + inventory lifecycle `sha256`; comparison recorded against the managed spec on `Status`/`Filter`/`Expiration`    |
| **Prohibited actions**                 | `PutBucketLifecycleConfiguration`; shortening TTL to force expiry (that is Scope 6)                                                                     |
| **Required approval owner**            | `TBD` (platform engineering lead)                                                                                                                       |
| **Rollback / cleanup**                 | None — read-only                                                                                                                                        |
| **Authorization expiry**               | `TBD` — bounded window recorded at approval                                                                                                             |
| **Approval**                           | `Pending — approver: ______  AUTH-REF: ______  expiry: ______`                                                                                          |

### Scope 4 — Run approved production network connectivity tests

| Field                                        | Value                                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Purpose**                                  | Prove the Web/Worker → R2 (and Collabora → WOPI) paths connect and correctly **deny** writes under freeze, and capture latency/reliability evidence for the network rows of the Q register |
| **Requested capabilities (read-only class)** | Authorized, rate-limited connectivity/diagnostic probes from Web and Worker identities (e.g., bounded `HEAD`/connection checks); denial-path checks against a non-ACTIVE freeze read       |
| **Affected resources & boundaries**          | Network paths to `<PROD_BUCKET_ALIAS>` and the authorized WOPI endpoint. **No object creation** (creation is Scope 5). Bounds: fixed host/port, fixed probe count, no fuzzing              |
| **Required identity & permissions**          | Reuse approved Tier A/B read identity, or dedicated diagnostic principal `TBD`                                                                                                             |
| **Acceptable evidence**                      | Connection success/failure + latency, denial behavior under freeze; redacted (no endpoint secrets, no account id)                                                                          |
| **Prohibited actions**                       | Load/throughput testing, port scanning beyond authorized host:port, creating objects, any denial-path test that would mutate state                                                         |
| **Required approval owner**                  | `TBD` (network/security approver)                                                                                                                                                          |
| **Rollback / cleanup**                       | None beyond transient connections; close any diagnostic session opened                                                                                                                     |
| **Authorization expiry**                     | `TBD` — bounded, single-test window recorded at approval                                                                                                                                   |
| **Approval**                                 | `Pending — approver: ______  AUTH-REF: ______  expiry: ______`                                                                                                                             |

---

## 2. Group B — Active mutation tests (5–8)

> **Group B is independent of Group A.** Approving any of Scopes 1–4 grants nothing below. Each
> Group B scope needs its own owner, its own rollback plan, and its own expiry.

### Scope 5 — Create disposable objects or test prefixes

| Field                               | Value                                                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                         | Create disposable, uniquely-prefixed, tagged objects to support lifecycle-expiry and hash-before/after evidence                                      |
| **Requested capabilities (write)**  | S3 `PutObject` and/or `CreateMultipartUpload`+parts, **restricted** to an approved disposable prefix                                                 |
| **Affected resources & boundaries** | Approved test prefix `<DISPOSABLE_PREFIX>` under `<PROD_BUCKET_ALIAS>` only. Nothing outside that prefix                                             |
| **Required identity & permissions** | Dedicated disposable-write principal `TBD`; must NOT have delete/lifecycle rights (combine with Scope 6 delete only if explicitly approved together) |
| **Acceptable evidence**             | Object key(s), size, content sha256 before/after, tags (`beaconhs-state=transient`/`pending`)                                                        |
| **Prohibited actions**              | Writing outside the disposable prefix; using production real keys; leaving objects after the test                                                    |
| **Required approval owner**         | `TBD` (platform engineering lead + security approver)                                                                                                |
| **Rollback / cleanup**              | MANDATORY: delete every created key (ties to Scope 6 delete grant or the creating principal's own cleanup); confirm pre/post counts match            |
| **Authorization expiry**            | `TBD` — single-test window (e.g., ≤24h) recorded at approval                                                                                         |
| **Approval**                        | `Pending — approver: ______  AUTH-REF: ______  expiry: ______`                                                                                       |

### Scope 6 — Delete test objects or trigger lifecycle expiry

| Field                               | Value                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                         | Verify object deletion and actual lifecycle expiration execution (the `NOT RUN` Q register item) using disposable objects                |
| **Requested capabilities (delete)** | S3 `DeleteObject` on the disposable prefix; optionally a controlled lifecycle-trigger mechanism approved by the owner                    |
| **Affected resources & boundaries** | Only objects created under `<DISPOSABLE_PREFIX>` for this test. Prohibit any delete of pre-existing/production objects                   |
| **Required identity & permissions** | Disposable-delete principal `TBD`, scoped to the disposable prefix; preferably distinct from the create principal (separation of duties) |
| **Acceptable evidence**             | Before/after `inventory` counts; per-object `DeleteObject 200/204`; lifecycle expiry timing evidence vs configured `Days`                |
| **Prohibited actions**              | Deleting anything outside the prefix; shortening TTL globally; any bulk/bucket-wide delete                                               |
| **Required approval owner**         | `TBD` (platform engineering lead + security approver)                                                                                    |
| **Rollback / cleanup**              | This scope IS the cleanup for Scope 5. Success = bucket returns to pre-test baseline (count + manifest hash)                             |
| **Authorization expiry**            | `TBD` — single-test window recorded at approval                                                                                          |
| **Approval**                        | `Pending — approver: ______  AUTH-REF: ______  expiry: ______`                                                                           |

### Scope 7 — Access production Collabora/WOPI for verification

| Field                               | Value                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                         | Verify a live editor session refuses and preserves content through WOPI PutFile/AutoSave under the freeze gate (the `UNKNOWN` Collabora register item)                |
| **Requested capabilities (write)**  | Open an authorized WOPI editing session on a **disposable** document; exercise PutFile/AutoSave in ACTIVE and non-ACTIVE freeze states                                |
| **Affected resources & boundaries** | A disposable document/attachment under `<DISPOSABLE_PREFIX>` only. No real user documents                                                                             |
| **Required identity & permissions** | A disposable WOPI-capable principal + the production Collabora endpoint `TBD`; freeze-transition capability (`admin.storage.freeze.*`) for the disposable tenant only |
| **Acceptable evidence**             | Object hash/metadata before and after refused writes (byte-identical); HTTP 423 on freeze; audit rows for the disposable entity                                       |
| **Prohibited actions**              | Touching real user documents; bypassing the freeze gate; leaving the disposable tenant non-ACTIVE                                                                     |
| **Required approval owner**         | `TBD` (platform engineering lead + document-module owner)                                                                                                             |
| **Rollback / cleanup**              | Restore disposable document to baseline; return disposable tenant to `ACTIVE` via authorized transition; delete disposable objects                                    |
| **Authorization expiry**            | `TBD` — single-test window recorded at approval                                                                                                                       |
| **Approval**                        | `Pending — approver: ______  AUTH-REF: ______  expiry: ______`                                                                                                        |

### Scope 8 — Send test alerts and acknowledge them

| Field                                     | Value                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**                               | Provide the missing production alert delivery/ACK evidence (currently `NOT RUN`) through an authorized end-to-end test          |
| **Requested capabilities (write/notify)** | Trigger a test alert through the real production delivery path to an approved **disposable** receiver; send an acknowledgement  |
| **Affected resources & boundaries**       | Approved alert channel and a disposable receiver `<RECEIVER_ALIAS>` only. No real user/recipient; no external/incident channels |
| **Required identity & permissions**       | A disposable alert-producer principal `TBD`; receiver config provisioned for the test only                                      |
| **Acceptable evidence**                   | Delivery receipt, ACK record (attributed), retry/timeout behavior, idempotency; all redacted                                    |
| **Prohibited actions**                    | Alerting real users/on-call; leaving a test receiver configured; reusing production incident channels                           |
| **Required approval owner**               | `TBD` (operations/incident-response owner, not platform ops)                                                                    |
| **Rollback / cleanup**                    | Remove the disposable receiver and any test config; confirm no residual scheduled alerts                                        |
| **Authorization expiry**                  | `TBD` — single-test window recorded at approval                                                                                 |
| **Approval**                              | `Pending — approver: ______  AUTH-REF: ______  expiry: ______`                                                                  |

---

## 3. Read-only identity design — proposed permission matrix

Access is resolved on **three distinct tiers**. These are not interchangeable, and the task's
warning stands: **an S3 access key cannot inspect Cloudflare account-level IAM policies.**

### 3.1 Access tiers

| Tier       | Access route                                           | What it can do                                                                                                                 | What it CANNOT do                                                                                |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **Tier A** | Cloudflare dashboard / account API (human read role)   | Read account members/roles, effective policies, bucket settings, lifecycle (authoritative), bucket policy                      | Mutate anything; be replaced by an S3 key                                                        |
| **Tier B** | S3-compatible read token (`OBJECT_STORE_*`/`R2_*` env) | S3 bucket ops: `HeadBucket`, `ListBucket`, `GetObject`/`HeadObject`/`GetObjectTagging`; lifecycle via S3 (`UNVERIFIED` for R2) | Read account IAM or roles; read bucket policy (no such reader exists; see 3.3); any write/delete |
| **Tier C** | Network diagnostics (approved tooling)                 | Authorized connection/denial probes (Scope 4)                                                                                  | Create/modify objects; exceed approved host:port/probe bounds                                    |

### 3.2 S3-compatible read token (Tier B) — minimum allowed vs must-deny

Derived from the exact commands in `packages/storage/src/index.ts` and
`packages/object-store-backup/src/s3.ts`.

| S3 permission                                                                                             | Tier B read-only verdict     | Basis                                                                          |
| --------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| `HeadBucket`                                                                                              | **ALLOW**                    | `bucketExists` read-only                                                       |
| `ListBucket` / `ListObjectsV2`                                                                            | **ALLOW**                    | `listAllObjects` inventory                                                     |
| `GetBucketLifecycleConfiguration`                                                                         | **ALLOW (UNVERIFIED on R2)** | R2 may not expose lifecycle over S3; treat dashboard (Tier A) as authoritative |
| `GetObject`                                                                                               | **ALLOW (optional)**         | Only if content-hash evidence is required                                      |
| `HeadObject`                                                                                              | **ALLOW (optional)**         | Metadata/timestamp evidence                                                    |
| `GetObjectTagging`                                                                                        | **ALLOW (optional)**         | Tag evidence (`beaconhs-state=*`)                                              |
| `PutObject`                                                                                               | **DENY**                     | Mutating (Scope 5)                                                             |
| `DeleteObject`                                                                                            | **DENY**                     | Mutating (Scope 6)                                                             |
| `CopyObject`                                                                                              | **DENY**                     | Mutating                                                                       |
| `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload` / `AbortMultipartUpload` / `ListParts` | **DENY**                     | Mutating                                                                       |
| `CreateBucket`                                                                                            | **DENY**                     | Mutating/infra                                                                 |
| `PutBucketLifecycleConfiguration`                                                                         | **DENY**                     | Mutating config (Scope 3 is read only)                                         |
| `DeleteBucketPolicy`                                                                                      | **DENY**                     | Mutating (app uses it only in the non-R2/dev path)                             |

### 3.3 Account-level IAM & bucket policy (Tier A) — cannot be served by Tier B

- Account-level IAM visibility (roles, members, effective policies) needs **Tier A Cloudflare
  account read**. Exact Cloudflare permission/role names are **`UNVERIFIED`** — none can be
  confirmed from repository sources; they must be supplied by the Cloudflare admins at approval.
- **Bucket policy:** the application stack has **no read capability** for bucket policy. It imports
  `DeleteBucketPolicyCommand` (mutating, used only in the non-R2/dev path of
  `ensurePrivateBucketReady`) but there is **no `GetBucketPolicy`** anywhere in `packages/*` or
  `apps/*` source. Therefore Scope 2 must be satisfied by **Tier A dashboard/IaC**, not by the S3
  token and not by an in-workspace tool.

### 3.4 Network diagnostics (Tier C)

- Uses the approved Tier A/B identity (or a dedicated diagnostic principal `TBD`).
- Provider-specific network diagnostic permissions/utilities are **`UNVERIFIED`**; the approved
  diagnostic method must be defined by the network owner at Scope 4 approval.

---

## 4. Readiness assessment (explicit)

The following are recorded as facts for this phase; none may be treated as authorization:

1. **No production authorization artifact was supplied to this phase.** This document is a
   request only; every scope shows `Approval: Pending`.
2. **No production read-only identity is provisioned or verified.** No Tier A read role and no
   Tier B read-only S3 token exists that this phase could confirm or use.
3. **No in-workspace bucket-policy reader was identified in the prior phase.** Confirmed here by
   source inspection: there is no `GetBucketPolicy` in the application stack (`DeleteBucketPolicy`
   exists only as a mutating, non-R2-path call). Scope 2 depends on Tier A dashboard/IaC.
4. **No production operations may proceed until authorization is independently confirmed.** Drafting
   this request, or approving Group A, does not authorize Group B or any execution.

**Scopes 1–8 are `NOT AUTHORIZED`** (equal to the R0 matrix). Any execution before the named
approver fills in `AUTH-REF` + expiry is out of policy.

---

## 5. Validation

### 5.1 Document checks performed

- ✅ Structure: 8 scopes listed **separately**; each has purpose, capabilities, resources/boundaries,
  identity/permissions, acceptable evidence, prohibited actions, approval owner, rollback, expiry.
- ✅ Separation: **Group A (1–4) read-only** and **Group B (5–8) mutation** are distinct approval
  blocks; not bundled.
- ✅ Placeholders/unknowns: providers, principals, resource identifiers, owners, and dates are
  `<ALIAS>` / `TBD` / blank-approval — **no invented owners, identifiers, or dates.**

### 5.2 Credential / secret scan

```bash
grep -niE 'AKIA|cloudflarestorage/<account>|127\.0\.0\.1:[0-9]|BEGIN [A-Z ]*PRIVATE KEY|X-Amz-Signature=|AKIA[0-9A-Z]{16}' \
  docs/phase-6u-b3-r1-authorization-request.md
```

Expected: no hits (aliases/placeholders only). Any hit would be a STOP.

### 5.3 Final repository state (recorded, not modified)

| Item                   | Value                                                   |
| ---------------------- | ------------------------------------------------------- |
| Branch                 | `hse-platform`                                          |
| HEAD                   | `51a899b7aac0a942da327222a3eed355fca9798a`              |
| Tracked modified       | 93 (unchanged)                                          |
| Untracked              | 120 (+1 = this new authorization request)               |
| Only change this phase | new file `docs/phase-6u-b3-r1-authorization-request.md` |

_(Counts re-verified after creation in the run that produced this file.)_

---

## 6. Stop conditions

STOP if, to proceed further, any of the following would be required:

- Executing any of Scopes 1–8 before its `Approval` line is filled with an approver, `AUTH-REF`,
  and expiry.
- Reading `.env`, provisioning credentials, or editing IAM/bucket policy to satisfy Scope 2.
- Collapsing Group A approval into Group B execution.
- Any step that would touch production without an independently confirmed authorization artifact.

**G2 remains `BLOCKED`.** This phase drafted a request and a read-only identity design only. It
authorized nothing and accessed no production resource. Stopping for approver action.
