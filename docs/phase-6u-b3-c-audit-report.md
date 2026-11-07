# Phase 6U-B3-C: Audit of External Write and Deletion Paths

- Date: 2026-10-14
- HEAD: 51a899b7aac0a942da327222a3eed355fca9798a
- Branch: hse-platform
- Note: Phase 6U-B3-C is read-only. No code, schema, or migration changes were made.

## 1. Executive summary

Three of the four audited paths already execute their storage effect through
`packages/storage` (`deleteObject` or WOPI `putObject`). Under the changes
landed in 6U-B3-A/B those effects are now tracked by `InFlightWriteTracker`
and blocked by the freeze gate. Two residual classes are not closed by this
work:

- **Already-issued presigned PUT / multipart-part URLs**: the browser writes
  directly to the object store, so the application never sees the write and
  cannot close it cooperatively during a freeze. These MUST be bounded by URL
  expiry and, ideally, capped with short lifetimes plus a post-freeze
  reconciliation pass.
- **Operator / externally triggered deletes (S3 lifecycle policy, raw bucket
  access, SeaweedFS auto-expiry)**: these run entirely outside the application
  process and cannot be gated at all.

The freeze barrier (gate + tracker + outbox) is therefore only a _partial_
system boundary: it protects application-initiated writes and can drain the
tracked ones, but it cannot stop already-armed client capabilities or
out-of-process deletions.

## 2. Paths audited

### 2.1 Collabora independent write-back channel

- Entry: Collabora container → app WOPI route
  `apps/web/src/app/wopi/files/[fileId]/contents/route.ts` `POST` with
  `X-WOPI-Override: PUT`.
- Process: web (nodejs runtime), inside the authenticated app process.
- Auth: `verifyWopiToken` + `wopiPrincipalIsAuthorized` + `tenantIsActive`
  re-checked immediately before `putObject`.
- Tenant source: `grant.tenantId` carried in the 12-hour WOPI token.
- Storage effect: `putObject({ key: stagedKey, body })`.
- Freeze interaction (after 6U-B3-B): `putObject` gate checks freeze state
  _before_ the S3 write and `register` is called before S3; on a mid-flight
  freeze `putObject` throws `STORAGE_WRITE_BLOCKED`, which the route now
  translates to HTTP 423. The record remains in `in_flight_writes` if the write
  was admitted but failed.
- Residual: token lifetime is 12 hours; returning HTTP 423 on save does not
  terminate an already-open Collabora session. Collabora retries saves and may
  queue a queued POST. Classify as a _client-corrected_ channel: the barrier
  controls the write but not the session lifetime.

### 2.2 Deletion Outbox (`storage_object_deletion_outbox`)

- Schema: `packages/db/src/schema/storage-object-deletions.ts`
  (`pending` ↔ `deleting`, lease columns, retry delay).
- Claim/release functions: `packages/db/src/storage-object-deletion-outbox.ts`
  (`claimStorageObjectDeletionBatch`, `completeStorageObjectDeletion`,
  `retryStorageObjectDeletion`).
- Worker executor: `apps/worker/src/lib/storage-object-deletion-outbox.ts`
  `drainStorageObjectDeletionOutbox`, invoked from the scheduled worker tick
  `storage_object_deletion_scan` (`apps/worker/src/workers/scheduled.ts`).
- Effect: `deleteObject({ key })` **after** claim, with lease-grant and
  `compare-and-delete` completion.
- Freeze interaction: the claim is _cross-tenant_ and _unconditional_; it does
  not consult `readFreezeState`. As of 6U-B3-B, `deleteObject` is gated and
  tracked. If a tenant is frozen mid-execution, `deleteObject` throws,
  `retryStorageObjectDeletion` releases the lease with `availableAt`
  exponentially backed off — safe, the object remains on the store. Cleanup
  retry (lease timeout 5 min) covers a dead worker.
- Gaps: (a) the worker does not pause claims when a tenant is frozen, so scan
  concurrency is wasted against blocked deletes; (b) each delete is **not**
  recorded in `in_flight_writes`, so drain/freeze verification cannot see
  outbox deletes. This is deliberate today (the outbox is its own drain), but
  freeze-count reports will not include them.

### 2.3 Expired attachment upload reconciliation

- `apps/worker/src/lib/attachment-upload-reconciler.ts`
  `reconcileExpiredAttachmentUploads` discards or recovers expired `pending`
  keys, deleting `stagingKey` (always) and `r2Key` (on discard).
- Effect through `deleteObject({ key })`, so gated/tracked after 6U-B3-B.
- Freeze interaction: on a frozen tenant `deleteObject` throws mid-reconcile →
  the reservation is counted as an error and retried next tick. Retry behavior
  exhausts no earlier than before. Safe.

### 2.4 Lifecycle / in-process and out-of-process sweepers

- In-process (app): `ensureBucket`, managed lifecycle policy, privacy probe
  (`writeAndRemovePrivacyProbe`). No tenant object deletion.
- Worker: `db_maintenance`, `journal_analysis_scan`, `office_render_reconcile`,
  `report_schedule_scan`, etc. Some call `deleteObject` indirectly (e.g.
  expired uploads). No direct MinIO retention or S3 `Expiration` scheduled
  action inspection found that crosses tenants.
- Storage lifecycle (put lifecycle rules — `storageObjectTagging`,
  `withManagedStorageLifecycleRules`) is _per-object_ expiration embedded on
  PUT for non-authoritative previews, not a cross-tenant sweeper. Cannot be
  gates at runtime; audited as out-of-band.
- Note: `apps/worker/src/storage-init.ts` calls `ensureBucket` only.

### 2.5 Presigned PUT / multipart-part URLs

Source: `packages/storage/src/index.ts` `presignPut` and `presignMultipartPart`.

- `presignPut`: TTL default **300 s**, Tagging `pending`, `upload-token`
  metadata; does not limit size or prevent an overwrite (single object).
- `presignMultipartPart`: mints one part URL; actual PUT is constrained to one
  part of a pre-created multipart session. Browser can `PUT` directly.
- Gate behavior: freeze state check at _issue time_ only (Phase 6T-B). No
  re-check on redeem (impossible — redeem bypasses the app). Already-minted
  URLs survive a freeze until expiry.
- Risk: even a short refusal window leaves in-flight client writes that the
  barrier cannot observe or drain. The drain protocol (`allInFlightWritesCompleted`)
  sees them as zero.

### 2.6 Multipart upload lifecycle (cross-request)

- `createMultipartUpload`, `presignMultipartPart` (x N), `completeMultipartUpload`,
  `abortMultipartUpload`: each terminal is individually gated and now tracked
  (6U-B3-B).
- An orphan `CreateMultipartUpload` sits in `upload-initialized` state with no
  parts; if a freeze lands between `create…` and `complete…`, the parts already
  stored remain. Sweep is performed by object-store orphan cleanup (vendor) —
  outside the app. Not tracked beyond the gate.

## 3. Ingress inventory

| Path                                    | Trigger                              | Process    | Tenant source        | Side effect     | Tracked by new tracker? | Revocable after issue?  |
| --------------------------------------- | ------------------------------------ | ---------- | -------------------- | --------------- | ----------------------- | ----------------------- |
| Direct app `putObject`                  | user request                         | web        | tenant ctx           | PUT/Copy        | Yes                     | N/A (synchronous)       |
| `deleteObject`                          | user request, outbox, worker cleanup | web/worker | tenant ctx / outbox  | DELETE          | Yes                     | No (retry-driven)       |
| WOPI save                               | Collabora → WOPI                     | web        | grant.tenantId       | PUT (stage key) | Yes                     | Bounded by 12h token    |
| Presigned PUT URL                       | browser direct                       | browser    | key prefix           | PUT             | No (app unseen)         | Only by expiry          |
| Presigned multipart part                | browser direct                       | browser    | key prefix           | PUT part        | No                      | Only by expiry / cancel |
| Outbox drain                            | scheduled tick                       | worker     | intent.tenantId      | DELETE          | Only outbox lease       | Lease retry (5 min)     |
| Expired upload reconcile                | scheduled tick                       | worker     | reservation.tenantId | DELETE(s)       | Only per call           | At claim boundary       |
| Bucket lifecycle policy / vendor expiry | storage system internal              | external   | none                 | DELETE          | No                      | No                      |

## 4. Failure-state observations

- **Freeze after issue, before redeem of a presigned URL**: freeze state is
  not consulted at redeem time and cannot be (no app involvement).
- **Complete a multipart upload whose parts were signed pre-freeze**: the
  terminal `completeMultipartUpload` is gated (6U-B3-B), so it will be blocked
  if the _worker_ is running while the tenant is frozen. If the app instance
  had frozen and later thaws, the terminal call will succeed.
- **Deletion outbox while frozen**: the object `deleteObject` call fails, the
  intent retries after `5 min` minimum; no data is double-deleted and
  `compare-and-delete` on completion prevents a stale claim from deleting a
  record after a retry successfully completed. Safe.
- **WOPI abort (token revocation)**: same as above; an in-flight save is
  marked failed and not completed — blocking freeze until retry/reconciliation
  handles the open record (`cleanupOrphanedWrites` at 24 h).
- **Out-of-process deletion**: impossible to stop with the applications barrier.

## 5. Proposed integration scheme (design only — not implemented)

### 5.1 Presigned URLs (explicitly NOT revoke-safe today)

Minimum safe plan:

1. **Reduce mint lifetime.** Current defaults: presigned PUT = 300 s,
   multipart part = short-lived (SDK default). Adopt TENANT-FREEZE-AWARE caps:
   maximum 60 s per signed URL; multipart-part URLs must be re-minted on each
   part but are bounded by session lifetime.
2. **Track outstanding arms at issue time.** Extend `in_flight_writes` to record
   an arm for each issued presigned URL with `source='presign_put'` / `source='presign_part'`,
   `expiresAt`, `uploadId` and `key`. Gated at `presignPut`/`presignMultipartPart` time.
3. **Reconciliation worker.** A scheduled sweeper enumerates arms that have
   passed their latest allowed expiry and (a) attempts a `HeadObject` to
   discover an object that was actually written, (b) on positive, reconciles it
   to the claimant (with the upload token metadata), (c) deletes the object if
   reconcile fails the probe/consistency checks, (d) marks the arm expired only
   once the object state is known. Arms must be reconciled, not silently dropped.
4. **Split `createMultipartUpload` from terminal admission.** Terminal gets the
   tracker gate but the session (already armed) still needs a `lifecycle`
   reconcile or an `abortMultipartUpload` at expiry (SDK `AbortMultipartUpload`).
5. **Schema additions (NOT YET AUTHORIZED):**
   - `in_flight_write_arms` (or widen `in_flight_writes` with
     `source varchar`, `expiresAt timestamptz`, `armId uuid`, `uploadId text`)
   - `tenant freeze` must never read rows without RLS; register table in
     `TENANT_SCOPED_TABLES`.
     A separate migration authorization is required.
6. **Abuse cases to cover:** arm with future `expiresAt` → skipped until expiry;
   arm with unknown end state → head + optional delete; two workers
   reconciling one arm → idempotent; freeze requested while arm still live →
   resolution against expiry deadline only (the drain for a tenant freeze
   cannot wait on absolute arm expiry if >freeze timeout).

### 5.2 WOPI (close residual, not a code change in this phase)

1. Token lifetime must be reduced from 12 h to a configurable value (e.g.
   2–4 h) for freeze-sensitive operations, used more aggressively when the
   workspace records a freeze request. Freeze time is observed by the save
   path already.
2. Save handler QoS: return HTTP 503 (vs the current 423) with a
   `Retry-After` negotiated with Collabora's retry; document the client side.
3. Idempotency: identity of an open session from `grant.sessionId` added to
   the in-flight row so `cleanupOrphanedWrites`/freeze drain can reconcile
   cancelled sessions.
4. Collabora itself is out-of-process and will retry save; that is fine and
   does not untrack the operation. No additional infrastructure needed.

### 5.3 Deletion Outbox (tighten coupling with freeze)

1. **Admission of the sweep itself**: `drainStorageObjectDeletionOutbox` and
   `reconcileExpiredAttachmentUploads` should be **paused** per frozen tenant
   via checking `readFreezeStateForTenant(tenantId)` at the worker: if the tenant
   is in `FROZEN` (or any non-`ACTIVE` state), do not `claim…` for that tenant's
   rows. The claim query will need a join/filter on tenants or filter post-claim
   (safer: pre-filter with tenant subquery against `tenants` for non-ACTIVE).
2. Each claimed intent should be recorded in `in_flight_writes` when the worker
   begins the actual `deleteObject`, so freeze verification sees it. Today a
   claim under a frozen tenant is possible and wasted; after the change the
   intent waits until thaw.
3. Outbox is the authoritative drain for objects; together with tracking
   ad-hoc deletes and presigned-arms this completes the accounting needed for
   `FROZEN` transition.

### 5.4 Lifecycle engine (no gating possible; monitor instead)

1. Vendor lifecycle / S3 policy deletes happen outside app control and will
   never consult any freeze gate.
2. Mitigation: app-attached lifecycle must be limited strictly to the
   `beaconhs-state=pending` rehearsal-tagged objects (privacy probe / staging
   uploads). All _produced_ objects carry NO server-side expiration; deletion is
   always through the outbox, or a tracked `deleteObject`.
3. Compliance: write a test + pre-commit check that rejects adding
   `Expiration`/`Days` lifecycle rules to the bucket policy managed in code.

## 6. Schema change set (NOT yet authorized)

1. Migration A — widen `in_flight_writes` (or new `write_arms` table) with
   `armId`, `source`, `expiresAt`, `uploadId`, partial indexes on `expiresAt`.
2. Migration B — tenant filtering on the two outbox tables: add columns to
   `tenants` for an authoritative freeze pointer if a simpler join is not
   available. NOT recommended; favor RLS-visible join through `storageObjectDeletionOutbox.tenantId`.
3. Seed/migration/RLS registration: new tables added to `TENANT_SCOPED_TABLES`.

## 7. Verification plan for implementation

1. SQL + application tests for presigned arms reconciliation:
   - arm expires; run sweeper; terminal state exactly one of
     `reconciled`/`expired`/`deleted`.
   - Retry under lock contention.
   - Head-positive full chain.
   - Idempotence across workers.
   - Arm for frozen tenant does not block freeze forever when expiry
     exceeds the drain timeout (defined with a ceiling).
2. Deletion outbox pause: freeze a tenant; confirm claim attempt rows remain
   pending and no `deleteObject` is invoked for that tenant; thaw re-drains.
3. WOPI token lifetime contract test.
4. Failing `markCompleted` assertions in `allInFlightWritesCompleted`.
5. Real DB concurrency (gated authorization required — PostgreSQL only):
   producer of presigned arms + freeze request with `SKIP LOCKED` —
   preflight using existing transactional test harness.
6. Live object storage verification against MinIO (stage with `MINIO`) for
   orphan multipart and storage arms.

## 8. Acceptance criteria for G2 re-evaluation

- Every application code path that can mutate or delete an object is either
  tracked or has a documented unrevoke-able bound (`presigned arms`) with a
  sweeper that finishes within a deterministic ceiling.
- `allInFlightWritesCompleted` returns 0 in all four-state transitions under
  the failure-mode test set.
- Database schema changes, migration review, and RLS registrations verified
  against an isolated PostgreSQL.
- No container created, stopped, or modified as part of this audit.

## 9. Deliverables and repository state

- This report: `docs/phase-6u-b3-c-audit-report.md`
- HEAD: 51a899b7aac0a942da327222a3eed355fca9798a
- Branch: hse-platform
- Workspace changes: pre-existing + this report only (no code modified).

## 10. Next stop

Awaiting explicit implementation authorization. G2 remains BLOCKED.
