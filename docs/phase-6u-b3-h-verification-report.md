# Phase 6U-B3-H Verification Report — G2 Freeze Gate Residual Proof Review

- Date: 2026-10-14
- Branch: `hse-platform`
- Source HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Report: `docs/phase-6u-b3-h-verification-report.md`

## 1. Baseline and workspace protection

- `git branch --show-current`: `hse-platform`
- `git rev-parse HEAD`: `51a899b7aac0a942da327222a3eed355fca9798a` (matches required baseline)
- Worktree has 170 modified/untracked files. Those pre-existing user changes were left untouched; **no destructive git operation was performed**.
- This phase wrote only this report file. No application code, tests, Schema, migrations, configuration, or environment changes were made.

## 2. H1 — Evidence review against the G-report

This section reconciles `docs/phase-6u-b3-g-verification-report.md` with the current source.

| Claim in G-report                                             | Current source evidence                                                                                                                                                                                                                                                  | Fit                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| All storage object mutations go through freeze gate / tracker | `packages/storage/src/index.ts` gates every `putObject`, `deleteObject`, `createMultipartUpload`, `completeMultipartUpload`, `abortMultipartUpload`, `promoteObject` via `admitWrite -> assertStorageWriteAllowed` before any S3 request, then registers in-flight work. | Verified at code level                                    |
| Presign entry points lock freeze row before issuing arm       | `packages/storage/src/index.ts` (presign) calls issuer; `packages/db/src/storage-write-arms-operations.ts:issueStorageWriteArmUnderFreezeLock` inserts only after `FOR UPDATE` lock plus `ACTIVE` check.                                                                 | Verified on isolated DB                                   |
| WOPI save blocked on freeze                                   | `apps/web/src/app/wopi/files/[fileId]/contents/route.ts`: `putObject` throws `STORAGE_WRITE_BLOCKED`; 423 response.                                                                                                                                                      | Verified by shape/code                                    |
| Deletion outbox is gated indirectly                           | Uses `deleteObject`, which calls `assertStorageWriteAllowed`. Worker sees `STORAGE_WRITE_BLOCKED` returned as an exception and reschedules.                                                                                                                              | Verified as a property; see §3/§4                         |
| Expired upload reconcile controlled                           | Uses `deleteObject` and `assertTenantObjectKey`; failure (including freeze) increments error and retries.                                                                                                                                                                | Verified as a property                                    |
| Out-of-process deletes isolated                               | `packages/storage/src/lifecycle.ts`: only tag rules `beaconhs-state=pending` (1 day) and `beaconhs-state=transient` (1 day).                                                                                                                                             | Verified at code level only; runtime config not inspected |
| No genuine revocation list for already-issued URLs            | No such table or service exists. Only `StorageWriteArms` tracks issue/expiry, and client capabilities cannot be recalled.                                                                                                                                                | Verified absence by code review                           |

Discrepancies: none between G-report and code; the G-report's "audit and confirmation only" language remains accurate. The H report does **not** assert that lifecycle isolation has been proven at runtime.

## 3. H2 — Presigned TTL and freeze timing

### 3.1 Real code-level bounds versus design targets

| Term                         | Design target                            | Actual value in current code                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Single presigned PUT         | 120 s cap                                | Default caller request 300 s (`index.ts`, `args.expiresInSeconds ?? 300`) but cap `MAX_TTL_MS_PRESIGN_PUT = 120_000` enforced in `issueStorageWriteArmUnderFreezeLock`; request clamped to 120 s |
| Multipart part PUT           | 60 s cap                                 | Default caller request 3600 s (`args.expiresInSeconds ?? 3600`) but cap 60 s enforced                                                                                                            |
| Freeze lock grace            | 15 s                                     | `storageWriteArmsDrainReady` default `graceMs = 15_000`                                                                                                                                          |
| DB-issued signature lifetime | `expiresInSeconds: arm.expiresInSeconds` | Arm expiration is computed server-side (now + clamped TTL), so the URL always inherits the capped value                                                                                          |

Therefore, Phase 6U-B3-D design parameters 120 s / 60 s / 15 s are **actually enforced**, but they are enforcement by cap against larger caller defaults — the stricter posture is now documented as correct, though client behavior is still bounded by the signed-time expiry ceiling.

### 3.2 Issued versus redeemed

- `presignPut` inserts an arm with `state = 'issuing'`, signs the URL **only after** the arm row exists, then calls `activateStorageWriteArm`.
- If activation fails, the row remains `issuing` forever until reconciled; a recent certified run on the DB shows an `issuing` arm persisting in exactly this state.
- `presignMultipartPart` behaves identically; both are protected against a freeze by `assertStorageWriteAllowed`.
- `withdraw` only occurs after a signing throw, using `failStorageWriteArmActivation` (called as `withdraw`) to move `issuing -> failed_to_activate`.
- Important semantic limit: the arm record proves issue time, not redeem completion. It can show _when the capability stopped being newly issued_, never whether a redeem succeeded after that time.

### 3.3 Freeze race analysis

Probable race window:

1. `presignPut` / `presignMultipartPart` gate check → `assertStorageWriteAllowed` → state `ACTIVE`.
2. Concurrent freeze transition takes the same row with optimistic version.
3. Freeze row locked exclusively while the issuer interleaved transaction holds it.
4. The test evidence (DB-E3) shows issuer waiting if freeze obtains the lock first, then refuses; issuer-first leaves an unresolved arm for freeze drain.

Still unsafe in a logical sense: if a freeze is requested but the tenant state is not actually locked before the transaction starts, and `assertStorageWriteAllowed` reads `ACTIVE`, a presign issued _before_ a freeze request can still survive until expiry. This is the expected bounded-but-real window, only 120 s.

## 4. H3 — In-flight and drain conditions

### 4.1 What `allInFlightWritesCompleted` means

```ts
packages/db/src/storage-freeze-operations.ts (approx lines 692–704)
  const count = await countInFlightWrites(tx, { tenantId })
  if (count < 0) return { completed: false, count: -1 }
  return { completed: count === 0, count }
```

- `completed` is `count === 0` after a successful query.
- `count < 0` is a DB error and reported non-complete.
- This does **not** count: arms still within TTL, presigned URLs already redeemed, WOPI open sessions (WOPI saves create synchronous rows), or external delete outbox attempts that the gate blocked.

### 4.2 Conservative preservation rules

- `countInFlightWrites` (until F was fixed) could return a string, so `count === 0` would fail safe. Fixed version converts to number, and `!== undefined` can still leave `NaN`, which again makes it fail closed.
- `cleanupOrphanedWrites` marks records as `success = false` after 24 h, i.e. in-flight, unresolved; it does **not** mark success.
- `countInFlightWrites` excludes only completed rows; this is conservative.

### 4.3 However, arithmetic zero is not proof of stop

- `in_flight_writes` rows are created for several but not all paths. Outbox consumer uses `deleteObject` which has a row. WOPI `putObject` has a row. Expiry reconciliation has rows.
- External presigned URLs are tracked in `storage_write_arms`, **not** in `in_flight_writes`. A row reaching `armed` is **not** "writing right now"; it only says the server created a redeemable capability.
- `allInFlightWritesCompleted` ignores `storage_write_arms` completely. Freeze drain requests on disk do not therefore account for all unsigned URLs, even within `presignPut` scope.

### 4.4 Multipart

- Each per-part URL is issued one at a time through `presignMultipartPart` and armed (with `uploadId`).
- `completeMultipartUpload` is gated and tracked as a normal write. However, a multipart in progress could have parts from pre-freeze presigned URLs already uploaded; the resulting upload only becomes an object after `CompleteMultipartUpload`, which (good) is gated and cannot occur after freeze.
- A pre-freeze `CreateMultipartUpload` has no TTL itself; termination is an explicit `AbortMultipartUpload` absent a happy-path. `completeMultipartUpload` is blocked under freeze, but `abortMultipartUpload` (cleanup) is **also gated if freeze arrives**; the freeze path relies on the eventual reconciliation, not an automatic abort.
- This is conservative enough to prevent a complete object appearing after freeze, but it can leave dangling multipart sessions until expiration; those do not themselves constitute an accessible object in S3's public "GET object" sense.

## 5. H4 — External lifecycle and deletion permission

### 5.1 `lifecycle.ts` exact scope

The only server-managed rules are:

- `PENDING_RULE_ID` (`expire-unfinalized-uploads`): expires objects **tagged** `beaconhs-state=pending` after 1 day, and aborts incomplete multipart uploads after 1 day.
- `TRANSIENT_RULE_ID` (`expire-transient-artifacts`): expires objects tagged `beaconhs-state=transient` after 1 day.

No rule in code expires untagged produced objects (documents, attachments, certificates, training assets, etc.). The default "no expiration" expected outcome is honored for those objects.

### 5.2 Gaps beyond code

What the code evidence **cannot** tell us:

- The server’s actual attached object-store policy is not loaded by the G test environment or validated. We have only the policy generated by code; the bucket may have additional rules installed out of band.
- SeaweedFS and any lifecycle worker behavior were excluded by Phase 6R decision (MinIO baseline); there is no enforceable system gateway in the code path for out-of-band lifecycle.
- Shared library-bucket setup and cold-storage replication are outside the evaluated perimeter.

### 5.3 Permission boundaries

- Outbox deletes are executed as `withSuperAdmin`, but each intent references a tenant-scoped `objectKey`; the application gate still verifies tenant match before S3 DELETE. There is no enforcement at the S3 credential level that limits an admin from unrelated objects, only the internal `assertTenantObjectKey`.
- Audit rows exist, but the report does not establish runtime alerting for `access_denied` or suspicious out-of-band deletes.

## 6. Acceptance matrix (H5)

| ID   | Scenario                                   | Current code evidence                                                                                                | Remaining evidence level        | Status                             |
| ---- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------- |
| H-01 | Freezing blocks new `presignPut`           | `assertStorageWriteAllowed(… presignPut …)` plus E3 evidence                                                         | Code+Test                       | **PASS (design+DB proof)**         |
| H-02 | Freezing blocks new multipart part minting | `presignMultipartPart` gate; E3 DB evidence                                                                          | Code+Test                       | **PASS (design+DB proof)**         |
| H-03 | Pre-freeze presigned URL still redeemable  | No post-issue redeem gate; the app never observes the redeem.                                                        | Runtime impossible / design gap | **NOT VERIFIED — residual risk**   |
| H-04 | Sign succeeds / activate fails             | Arm lingers in `issuing`; F-integration verified transition; no automatic expire or revoke actually runs             | Unit+DB partial                 | **PARTIAL**                        |
| H-05 | Process crash / uncertain write            | `writeAndRemovePrivacyProbe` retry / in-flight rows; `updateStorageWriteArmState` requires explicit operator actions | Unit+DB partial                 | **PARTIAL**                        |
| H-06 | Incomplete multipart                       | Terminal blocked; incomplete parts are not an object. `AbortMultipartUpload` is gated                                | Code structure only             | **PARTIAL**                        |
| H-07 | Outbox drain                               | `deleteObject` called through gate; no runtime freeze drill provided                                                 | Code+Test (shape)               | **PASS (targeting behavior)**      |
| H-08 | Lifecycle safety                           | Source-only manageable tag rules; no configured-bucket inspection evidence                                           | Config assertion only           | **NOT VERIFIED — runtime**         |
| H-09 | Count zero implies all external stops      | `allInFlightWritesCompleted` excludes `storage_write_arms` (issued capabilities) and any out-of-process deletion     | Logical deduction               | **KNOWN-GAP**                      |
| H-10 | Freeze unwind precondition                 | `evaluateTransition` / state checks plus RLS; evidence of successful RECONCILING -> ACTIVE with hash                 | Need manifest and proof         | **Scenario not exercised by test** |

## 7. Residual blocker classification

A blocker is legitimate if it represents a safety-critical failure. Current blockers:

| ID                                  | Classification                                                              | Can code fix fix now?                            | Expected resolution                                                   |
| ----------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| E3-F-style count-prefix             | Already fixed in Phase F                                                    | n/a                                              | Closed via production code                                            |
| Presigned URL lingering             | Structural design limitation                                                | No, separate revoke/reconcile service required   | Out of G2 without `storage_write_arms` expiry loop + HeadObject sweep |
| qOut-of-band bucket delete          | Operational risk                                                            | No, by definition                                | Independent monitoring and ownership controls                         |
| Freeze drain semantics              | Joining issued-arms count not performed                                     | Yes, joins count each attempt                    | E3 rerun / automation                                                 |
| Cycle protection in freeze duration | `STORAGE_WRITE_BLOCKED` is returned without retry semantics to many callers | Yes, add timeout collapse to `RECOVERY_REQUIRED` | Needed before G2                                                      |

## 8. Minimal fixes recommended

1. Add `storage_write_arms` to freeze-readiness query (counts unresolved issuance-tier records against same tenant).
2. Straighten the presign expiry discipline from “default 300/3600 → clamped” to explicit constants passed to browser clients; the confusing default remains a documented footgun.
3. Arm lifecycle reconciliation (code exists in E3 reports but not implementation): sweep late-expiring arms with Head + token verification before treating them as expired.
4. WOPI token life reduction (30 min vs 12 h) after a freeze request is only a policy idea, not implemented; mark residual.
5. Lifecycle verification (managed tags confirmed) still needs a test that parses policy, server-bucket policy diff, and alerting; not needed to move G2 in the code but mandatory for operators.

## 9. Final determination

- **G2 remains `BLOCKED`**.
- Evidence is sufficient to **prove** freeze gating of internal writes and warming of ARM records.
- Evidence is **insufficient** to demonstrate global permission interruption of already-issued client capabilities or vendor lifecycle.

Report produced without code, test, DB migration, or environment changes.
