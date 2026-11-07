# Phase 6U-B3-I Design Review

- Date: 2026-10-14
- Branch: `hse-platform`
- Source HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Report: `docs/phase-6u-b3-i-design-review.md`
- Mode: Read-only. No code, tests, schema, migration, config or environment changes.

## 1. Baseline protection

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Worktree contains 170 existing user changes. They were left untouched.
- This phase added only this report. No `git add`, no commit, no push, no reset/checkout/clean/restore.

## 2. I-1 — Freeze drain condition and lock ordering

### Current exact predicate sources

- `packages/db/src/storage-freeze-operations.ts`
  - `countInFlightWrites(tenantId)` counts unresolved rows where `completed_at IS NULL`.
  - `allInFlightWritesCompleted(tenantId)` is `unresolved == 0`.
  - `storageWriteArmsDrainReady(tenantId, now, graceMs = 15_000)` exists but **does not itself short-stop issuance**; it only exposes:
    - `unresolvedCount`
    - `maxExpiresAt`
    - `waitUntil = maxExpiresAt + graceMs`
    - `ready = unresolvedCount == 0 && now >= maxExpiresAt + graceMs`
- `packages/db/src/storage-freeze.ts`
  - `evaluateTransition` blocks always on `FREEZE_DRAIN_UNVERIFIED`: transitioning into `FROZEN` currently requires a drain evidence payload, but no implementation can produce it.
- `packages/storage/src/freeze-gate.ts`
  - `assertStorageWriteAllowed` reads state through the installed `StorageFreezeReader`, then derives tenant from the key. A state other than ACTIVE fails closed.

### Concurrency / locking observed

- Issuer / freeze race is governed by `issueStorageWriteArmUnderFreezeLock` holding `FOR UPDATE` on `storage_freeze`.
- That lock times out and serializes issuer vs freeze transition. It does **not** make later `presignMultipartPart` requests block; each subsequent mint is a new transaction.
- `allInFlightWritesCompleted` is advisory.

### Recommended minimal fix (not implemented)

- Combine `in_flight_writes` unresolved count and `storageWriteArmsDrainReady` into a single tenant freeze transition helper:
  - Candidate predicate:
    - `inflightUnresolved == 0`
    - `count storage_write_arms where state in (issuing, armed, expired, reconciling) == 0`
    - `now >= max(expiresAt of arms previously in issuing/armed/expired) + grace`
    - no claim leases older than the claim timeout.
- Do not mark arms terminal merely because `expiresAt` passed; a revoked/mishandled arm should wait for explicit reconciliation.
- Add retry / timeout collapse: if drain not complete within freeze claim lease (e.g. 2x the largest arm TTL), transition must go `RECOVERY_REQUIRED`. Today `evaluateTransition` still rejects FROZEN entirely, which is fail-closed.

## 3. I-2 — TTL design status

### Actual call chain

- `presignPut(args.expiresInSeconds ?? 300)` calls issuer with default `requested 300`.
- `presignMultipartPart(args.expiresInSeconds ?? 3600)` calls issuer with default `3600`.
- Both calls run through `assertStorageWriteAllowed` (freeze state) and then `StorageWriteArmIssuer.issue`, which caps:
  - put: `120 000` ms
  - multipart part: `60 000` ms
- `getSignedUrl(..., { expiresIn: arm.expiresInSeconds })`
- DB row stores `expires_at`, so freeze sweep can see future times.
- `createNoOpStorageWriteArmIssuer` issues 60 s unrelated to production path but is a test-only no-op.

### Design classification

- 120 s / 60 s caps: **implemented as clamps**, but the caller defaults of 300 / 3600 are misleading and must be aligned at the API surface.
- 1 hour open multipart upload cap: **not implemented** in code; `createMultipartUpload` is call-site-governed but has no lease duration after issuance. Multipart pre-freeze sessions can outlive the stated bound.
- 15 s grace: **implemented** in `storageWriteArmsDrainReady`, but **not invoked** by `evaluateTransition` (which always rejects with `FREEZE_DRAIN_UNVERIFIED`).
- Unrevoked external validity: **unimplemented by design**; pre-redeem lifetime can be up to one hour or client-imposed. Cannot be made safe by TTL alone.

Recommended:

- Make the signature API reject values above cap instead of silently clamping. The current silent behavior is valid for business continuation but hides drift.
- Expose a single `StorageWriteArmLifetimePolicy` in the storage package so all tests and callers use the same shape, then generate expiration diagnostics from it.
- Preserve a client-side renew path before expiry, documenting that expiration only bounds the restart.
- No change to existing presign path is required to enter freeze; the limit is post-issue concealment.

## 4. I-3 — arm lifecycle sweep and recovery

### State inventory

- `issuing`: arm row written before signature.
- `armed`: successfully written row marked active after URL created.
- `expired`: judged expired by issuer/stale sweep.
- `reconciling`: explicitly entered by reconciler.
- Terminal: `redeemed_confirmed`, `redeemed_nop`, `quarantined`, `failed_to_activate`.

### Actual automation status

- `expireStaleStorageWriteArms` exists in `packages/db/src/storage-write-arms-operations.ts` but is only used by the Phase F integration script on a test DB. No scheduler calls it.
- No queue or cron currently reconciliation arms; `evaluateTransition` keeps everything unresolved and blocks FROZEN.
- `updateStorageWriteArmState` is the only recovery lever, with no tenant-scoped audit context or actor safe-path enforcement beyond super-admin.

### Safe minimal recovery design

- Create a worker-side scheduler job `reconcile_expired_storage_write_arms` (like `storage_object_deletion_scan`) with a 15 s tick.
- Candidate selection: `state = 'issuing'` older than 1 hour, or `armed` with `expires_at + grace < now()`.
- Terminal state moves only when evidence exists:
  - Head 404 → `redeemed_nop`.
  - Head 200 + metadata `upload-token` matching and arm is `armed` → `redeemed_confirmed`, then quarantine if object owner is not attachment-bound.
  - metadata mismatch → `quarantined`.
- Deliberately unresolved (token activation failure, connection loss) must remain `issuing` or `expired`, never terminal. This satisfies H2/H4.
- Idempotence: use `update ... where state IN ...` guard with `RETURNING`; retry overlap should skip locked rows.

## 5. I-4 — WOPI token lifespan and freeze behavior

### Actual code

- `apps/web/src/lib/wopi.ts`:
  - `WOPI_TOKEN_TTL_MS = 12 * 60 * 60 * 1000`.
  - `mintWopiToken` returns explicit `exp = now + TTL`.
  - `verifyWopiToken` rejects `expiresAt - issuedAt > WOPI_TOKEN_TTL_MS`, expired, future clock skew.
- `apps/web/src/app/wopi/files/[fileId]/contents/route.ts`:
  - token gate + `tenantIsActive` + `wopiPrincipalIsAuthorized` before and after read/write.
  - `putObject` is the critical write: it is _gated_ and _tracked_; a blocked stage returns async 423 and cleans the staged object.
  - No kill of open collaborative sessions; `getCollaboraEditUrl` only returns URL.

### Design judgement

- This is by far the largest _unrevoked_ external capability. Locking the write path keeps bytes from reaching storage during an active freeze, but the Collabora session remains technically live and may queue save retries, with no evidence that work finished (save failure repeated).
- Shortening token to 30 minutes is not alone sufficient because the client keeps retries; granting fast low-latency arms is for file system writes, but WOPI is app-bearer.
- Best next move is measuring freeze `from → DRAINING` rejection for WOPI, then returned close semantics to Collabora, paired documentation, contract test only. Do not claim token revoke.

## 6. I-5 — Object storage lifecycle and deletion permissions

### Actual evidence

- `packages/storage/src/lifecycle.ts` tags produced objects with either `beaconhs-state=pending` or `transient`; managed expirations are explicit only:
  - pending: 1 day, plus incomplete multipart abort after 1 day.
  - transient: 1 day.
- There is no rule that deletes arbitrary untagged production objects. The policy is safe by construction.
- `packages/storage/src/index.ts:ensureBucket` (see lifecycle integration) installs policy through host-managed external policy and is not validated in code against live bucket state.

### Design recommendations

- Runtime diff checker (read-only compare S3 bucket lifecycle `GetBucketLifecycleConfiguration`) against `withManagedStorageLifecycleRules(policy)`: compare IDs, filters, Expiration, abort policy.
- Add an admin-facing audit artifact (`artifact_type = 'storage_policy_diff'`) in audit log or a `GET /admin/storage/policy-diff` endpoint returning only drift, not full content. This closes H4’s deployment evidence gap.
- Permission separation:
  - application role (MinIO `beaconhs` / R2 scoped user) should have Object `s3:PutObject`, `s3:DeleteObject`, but not `s3:PutLifecycleConfiguration`.
  - ops write role with lifetime configuration should be separately auditable; both recorded in a RLS-accessible audit model if deployment secrets allow.
- Keep all repositories/gates out of vendor-specific clients.

## 7. Recommended fix order and authorization

### Phase I-B: lock and scream

1. `evaluateTransition` freeze predicate addition.
   - Touch: `packages/db/src/storage-freeze.ts`.
   - No schema change.
2. TS wrapper predicate from `countInFlightWrites + storageWriteArmsDrainReady + leases expired`.
3. Contract tests for (1) under `postgres`.
4. Required authorization: none beyond E3.

### Phase I-B2: presign defaults and reconciliation job

5. storage package `presignPut` API TTL policy alignment (`expiresInSeconds` capped, documented).
6. worker scheduler task `reconcile_expired_storage_write_arms`.
7. Read-only S3 policy diff reporting.
8. New Grace tests and counters.

- Seed G2 narrative: “deterministic bounded arm state only”.

### Do NOT do in this cycle

- Full WOPI revoke.
- Lifecycle out-of-process solution.
- Any container lifecycle work.

## 8. G2 threshold with reproducible bar

Tuple must reach zero and remain:

- `issue` cannot happen in non-ACTIVE.
- `count(in_flight_writes where completed_at IS NULL)` enforced explicitly for FROZEN entry.
- Counted unresolved `storage_write_arms` included in that predicate.
- Multipart in-progress handled through bounded expiry sweeper.
- Arrray of quarantine states reserved as known blockers, never silently terminal.
- Policy diff + external lifecycle ownership evidence documented.

Each threshold must be coded so that `evaluateTransition` returns `FREEZE_DRAIN_UNVERIFIED` until this composite evidence exists.

## 9. This phase outputs

- Only report: `docs/phase-6u-b3-i-design-review.md`.
- No application code, migration or runtime changes.
- G2 remains BLOCKED.
