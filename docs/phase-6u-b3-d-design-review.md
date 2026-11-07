# Phase 6U-B3-D: Presigned Write Credential Control Design Review

- Date: 2026-10-14
- HEAD: 51a899b7aac0a942da327222a3eed355fca9798a
- Branch: hse-platform
- Scope: Read-only design review. No code, schema, or migration changes.

## 1. Objective

Define a verifiable scheme that constrains writes performed by clients that
already hold issued presigned PUT / multipart-part URLs after a freeze has been
requested. The scheme must keep those writes from going unobserved into
`in_flight_writes`, converge well past the largest issued expiry, and remain
correct under crash, retry, and duplicate issuance.

## 2. Vocabulary

- **Arm (write arm):** a server-issued capability whose redemption can occur
  outside the application process (a signed URL or an open multipart session).
- **Redemption:** the client `PUT` of an object by armed capability.
- **Unredeemed arm:** issued, not expired, and not yet matched to a known
  object state.
- **Reconcile:** the server-side process that brings an expired arm to a
  terminal state by contacting the object store (Head + token check).

## 3. Credential lifetimes and the limits of expiry

### 3.1 Observed defaults (Phase 6T)

- `presignPut` (single PUT): `expiresInSeconds ?? 300`.
- `presignMultipartPart` (per-part): passed by caller (SDK default ≈ 300 s).

### 3.2 Proposed business-driven caps

| Operation                   | Suggested cap | Rationale                                                             |
| --------------------------- | ------------- | --------------------------------------------------------------------- |
| Single PUT (attachment)     | 120 s         | R/R to a fresh URL is cheap; a session simply re-mints before expire. |
| Multipart part (single PUT) | 60 s          | Issued at part-upload time; never held across minutes of idle.        |
| Open multipart session      | 1 h hard cap  | Resume-safe; pulls must complete within one hour or abort + restart.  |
| Token refresh cadence       | 30 s before   | Client requests a new URL if >30 s before expiry.                     |

### 3.3 Expiry is NOT a guarantee of termination

- The signed URL signature contains `X-Amz-Date + X-Amz-Expires`; the S3
  service rejects requests whose arrival exceeds it (HTTP 403). In practice
  a request _already accepted by S3_ and streaming at expiry can sometimes
  complete; vendor implementation detail must be verified experimentally and
  is recorded as a residual.
- Client-side timeouts and disconnects are opaque; an intermediate buffer can
  be retried with backoff. The expiration ceiling must carry a **safety
  window** `G` (default 15 s) added to the largest already-issued `expiresAt`.
- A disconnected-but-buffering client cannot be cancelled; the reconciliation
  step defines the only path to terminal per-arm state.

### 3.4 Why expiry alone does not close G2

- Arms may carry up to 120 s of life at freeze request time. The application
  cannot turn them off. The drain has to wait or resolve each one.
- Object state for a redeemed arm is only discoverable through an object-store
  read. Expiry ≠ "did it write?"

Shortening URL lifetimes reduces **maximum** drain latency; it does not
eliminate the obligation to reconcile the whole issuing window.

## 4. Arm state machine

```
               ┌─────────────┐
   issue ──────►│   ARMED    │
               └──────┬──────┘
                       │ expiresAt elapsed
                       ▼
               ┌─────────────┐
              │  EXPIRED_UNRECONCILED  │
               └──┬───────┬──────────┬──┘
                  │ head 404│         │ head 200 + valid token
                  ▼         │         │
           ┌──────────────┐ │         │
           │   REDEEMED_NOP │         │
           │ (no object)    │         │
           └──────────────┘ │         │
                           │         ▼
                           │  ┌─────────────────────┐
                           │  │ REDEEMED_CONFIRMED │  -> attach/reconcile
                           │  └───────────────────┘  to attachment or delete
                           │
                           ▼
               ┌─────────────┐
               │ QUARANTINED  │  (unknown owner / bad metadata)
               └─────────────┘
```

Terminal states: `REDEEMED_NOP`, `REDEEMED_CONFIRMED` (decided), and an
explicit terminal `RECONCILED_*` per decision. Quarantined arms require an
operator decision / soft-quarantine interval and policy.

## 5. Consistency between issue and registry

### 5.1 The ordering requirement

Never sign and return an URL without first durably recording an arm row.

```
BEGIN TRANSACTION
  INSERT storage_write_arms (state='issuing', tenantId, key, uploadToken,
                          issuedAt=NOW(), expiresAt=NOW()+ttl,
                          operation, uploadId=NULL for PUT)
  RETURN id, expiresAt
COMMIT
URL = presignPut(key, metadata.uploadToken=arm.id, ttl=expiresAt-issuedAt)
BEGIN TRANSACTION
  UPDATE storage_write_arms SET state='armed' WHERE id=arm.id
COMMIT
RESPONSE client with URL
```

### 5.2 Crash semantics — exact

- Crash _before first commit_: no row, no URL returned; client request fails or
  no response; no arm exists in the registry. Monetized failure.
- Crash _between first and second commit_: row in `issuing`; no URL delivered
  (second commit has not run), reconciler marks `issuing` arms whose
  `expiresAt` has passed as `FAILED_TO_ACTIVATE` and **never** sees a live
  capability since signing did not return. Strictly: if signing completed in
  process but the update did not commit before crash, the URL was never
  returned (signing is in-process memory), so no live arm; on recovery the
  row flips to `FAILED_TO_ACTIVATE`.
- Crash _after second commit, before HTTP response_: row `armed`, URL never
  delivered; reconciler transitions the arm through normal expiry. No
  live capability leaks beyond what would be needed.
- Crash _during response_: stopgap — same behaviour as after second commit.
- Retry by client re-issues a new arm with a new `id`. No idempotency is
  required; duplicates are correct and will reconcile.

### 5.3 Register-before-sign invariant

The reconciler only inspects arms present in the table. Because every real
arm requires a committed row before the signing code runs, no orphan arms can
exist without a corresponding row. This is the strongest central guarantee of
the scheme.

### 5.4 Lost response / client retry

- If the client never gets the URL, the arm row still times out and
  reconciles to `REDEEMED_NOP`.
- If the client repeats the request, a new row/arm and new token are created;
  both expire and reconcile independently. No durable error surface.

### 5.5 Re-issuing mid-frozen

- `presignPut` / `presignMultipartPart` already call `assertStorageWriteAllowed`
  at API entry (Phase 6T-B). Under a non-`ACTIVE` state they refuse at sign
  time, **and** no arm row is inserted.
- Race between freeze request arrival and an arm insert is safe because the gate
  check runs in the same transaction as the row insert? Current gate is a
  separate DB read (`readStorageFreezeStateForTenant`). To close the cleanest gap,
  Phase 6U-FreezeTrack-X must make the arm insert execute a freeze-state
  check inside a single pinned transaction, re-verifying the state at insert time
  with row locking on the freeze row. This is a concrete required change, noted
  in §10.

## 6. Freeze admission and drain algorithm

### 6.1 State transitions

The freeze state machine gains no new unfrozen transitions beyond today's
numbers.

New definition of drain readiness for transition `DRAINING → FROZEN`:

```
ready(tenant T) iff
  (count(in_flight_writes where tenant=T and completedAt IS NULL) == 0) AND
  (count(arms where tenant=T and state in {'issuing','armed'} and
                     expiresAt > NOW()) == 0) AND
  (all arms for T with state in {'expired_unreconciled'} have been resolved
   through head or moved to quarantined) AND
  (no locked-claim outbox rows are in 'deleting' state for T longer
   than freeze grace 30s)
```

### 6.2 Algorithm

```
ON freeze_requested(T):
  stop presignPut/presignMultipartPart/mulistart admission
  WTR tracked (synchronous in_flight) drain = waiter
  MAX_ARM_EXPIRY = max(expiresAt for T's arms state in armed/expired)
  WAIT_UNTIL(t_max = MAX_ARM_EXPIRY + G, G=15s)
      poll reconcileExpiredArms(T) every 5s
  REQUIRED outcome:
     count of armed AND expiresAt > now must be 0
  THEN attempt FROZEN with drift check.
  ON arm remains unreconciled beyond 10x G:
      abort freeze; RECOVERY_REQUIRED or leave DRAINING, no transition
```

### 6.3 What "waiting" means precisely

- Blocking `/ waiting` is acceptable when at most 120 s + consent (G).
- Arms issued _before_ freeze start naturally expire. Freeze transition readiness
  must not _promote to FROZEN_ during that window but it need not consume a
  thread: the worker polls scheduled ticks.
- If client redeem lands after freeze request, `completeMultipartUpload` /
  any terminal PUT already has gate logic resulting in `STORAGE_WRITE_BLOCKED`,
  returning HTTP 423. The arm remains in inventory though, to record the
  incident/reconcile, and object tagged `beaconhs-state=pending` requires sweep.
- No write performed after freezing may silently attach to an attachment row:
  promote paths (attachment creation) must be paired with the arm ID, so an
  out-of-order completion is detected and quarantined.

### 6.4 Quarantine policy

An object whose arm token metadata does **not** have a corresponding live
arm (e.g. arm expired and reconciled as NOP but object exists, or issued by a
process that crashed) is **quarantined**, tagged, and surfaced to operators;
it is **never** attached to a live attachment / document / anything. Cleanup only
after operator acceptance (or via a quarantinable auto-delete policy wording
equivalent to `beaconhs-state=quarantined`).

## 7. Suggested schema (NOT authorized; no migration in this pass)

### Recommendation A — widen `in_flight_writes`

Add nullable columns (migration required):

| Column         | Type               | Notes                                                     |
| -------------- | ------------------ | --------------------------------------------------------- |
| `source`       | `varchar(32)` null | `'direct' \| 'outbox' \| 'presign_put' \| 'presign_part'` |
| `expires_at`   | `timestamptz` null | Present for armed capabilities.                           |
| `arm_state`    | `varchar(32)` null | Only when source is an armed capability.                  |
| `upload_token` | `text` null        | Same as signed URL's stored metadata; used for reconcile. |
| `upload_id`    | `text` null        | Multipart container.                                      |
| `issued_by`    | `worker_id` text   | Node executing issue.                                     |

### Recommendation B — dedicated `storage_write_arms` table

Prefer **B**. The principal reason: an arm represents a still-unredeemed
capability, which carries completely different completion semantics than a
direct write (where `complete` is server-owned in-process). Mixing them makes
`allInFlightWritesCompleted` overloaded and tempts shortcuts. Arm is its own
lifecycle, covered by its own RLS row on `tenant_id`. Tables:

```sql
CREATE TABLE storage_write_arms (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  operation   varchar(64) not null,
  object_key  text not null,
  upload_token text not null,
  upload_id   text,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  state       varchar(32) not null default 'issuing',
  last_checked_at timestamptz,
  last_error  text,
  constraint tenant_key_ck check (object_key like 't/' || tenant_id::text || '/%')
);
CREATE INDEX storage_write_arms_tenant_state_idx ON storage_write_arms(tenant_id, state);
CREATE INDEX storage_write_arms_expires_state_idx ON storage_write_arms(expires_at, state);
```

Plus RLS v2 policy identical in shape to `in_flight_writes` — register in
`TENANT_SCOPED_TABLES`.

### Stream lifecycle (`expiresAt` / state excludes null-safety)

- `expiresAt` is NOT NULL. Arms that are not issued never become rows. The race
  close summary (§5.5) makes lock order explicit:
  `BEGIN tx FOR UPDATE ON storage_freeze freeze row; assert state active;
INSERT arm row; COMMIT; presign using expiresAt returned.`
  Without the `FOR UPDATE` lock on the freeze row, `active` can flip between
  the gate read and the arm insert; lock avoids it. This schema must add the lock
  in `readFreezeState` or in a freeze-state transactional helper; no code change
  now, but design requirement.

## 8. Multipart Upload special cases

### 8.1 Parts pre-signed and still armed when freeze starts

- Part uploads already in-flight, even the one already uploaded, must be
  discovered after its expiry via HeadObject or `ListParts`:
  - call `ListParts(sess.uploadId)` for container IDs referenced by arms, to
    learn which parts actually exist.
  - if container has no committed `Complete`, the late object is not a
    complete artifact → `AbortMultipartUpload` after expiry + 30 s, then arm
    terminal `DELETED`.
  - if a `Complete` somehow succeeded despite the terminal gate (should not
    happen if the terminal call was after 6U-B3-B's gate — gate runs pre-write
    before any S3 effect), mismatch → quarantine.
- Every part already uploaded but not completed cannot form an accessible
  upload; S3 serves parts only after `Complete`. Safe to abort after expiry.

### 8.2 Arm vs Upload-Id on ARMED rows

- Register an arm only at presign _time_ (`presignMultipartPart`), not at
  `CreateMultipartUpload` time. Since `CreateMultipartUpload` already happened
  during `putObject`/explicit SDK call (currently governed by its own gate),
  policy is still enforceable.
- Early (pre-6U-B3-B) code paths that call `createMultipartUpload` directly
  must be audited and, if unprotected, addressed by preserving the current
  gate (it is).

## 9. External lifecycle and deletion isolation

- Vendor bucket policies that auto-delete objects are outside any gate/min freezes.
- **Recommended containment:**
  - Managed lifecycle rules carry only `beaconhs-state=pending` (staging and
    privacy-probe objects), and explicit minimal expiry policy
    (1 day for `t/*/ _pending/`, 7 days for quarantined prefix).
  - Produced objects carry no `Expiration` rule. Document/govern via a
    test that prevents adding one to the policy in `storage/lifecycle`.
  - Operator access (MinIO console, AWS console) scoped to a role not bound to
    the app's signedURL encryption key; all such access audited to
    `audit_log`.
  - Alert if a `HeadObject` on a live attachment key 404s — indicating an
    out-of-band deletion → dead-letter + pager.
- For SeaweedFS, `Phase 6R` decision already fixed (MinIO built baseline).
  Do not add new SeaweedFS support without a security finding; keep storage
  abstraction (no vendor coupling).

## 10. Required pre-implementation changes beyond 6U-B3-D scope

1. Lock freeze row during arm issuance (this doc, §5.5 and §7).
2. Implement idempotent arm table with `FOR UPDATE` locks at freeze
   transitions.
3. Quarantine uploader endpoint tagged on object metadata extension
   (`x-amz-meta-arm-id`).
4. Worker sweep function `reconcileExpiredWriteArms` with overlap/skip locking
   similar to `claimStorageObjectDeletionBatch`.
5. New scheduled tick registration (no schema if using the existing scheduler)
   that calls reconcile every 15 s.
6. Extension of `allInFlightWritesCompleted` and transitions to include arm
   counts.

## 11. Fault injection test plan (design)

1. **Crash before second commit:** recovered rows count 0 as live; URL count 0. Assert no transactions can retrieve URL.
2. **Crash after response:** arm terminates to `REDEEMED_NOP` if no object, or
   `REDEEMED_CONFIRMED` if object is uploaded. No arm stuck in `armed`.
3. **Double-issue under packet loss:** two unique IDs; both reconcile.
4. **Issuer process STOP during issued-URL download:** URL-facing object
   tagged, not attached.
5. **Freeze races with issued arm (expiry ≤ 120s):** partition freeze
   readiness asserts until `expiresAt+G`; head reconcile executed.
6. **Arms beyond deadline:** freeze fails `RECOVERY_REQUIRED`; no
   transition; unit tests assert attempted→failed and arm count remains.
7. **Tampered redeems ( uploading a file with a different uploadToken ):**
   quarantine & no attach/service attachment list unchanged.
8. **Out-of-process delete of live attachment:** alert path, quarantine
   record.
9. **Multipart part signed but object aborted mid-raise:** orphan sweep cleans.
10. **Clock skew (+30s server):** S3 rejects in the extended window; expired
    arm eventually resolves to `REDEEMED_NOP` at worst-case 2× window + G.

## 12. Acceptance criteria for G2 re-evaluation

1. All application `presignPut` / `presignMultipartPart` requests are row-armed
   with the duration bounded by policy (120s cap, 60s cap respectively).
2. `armed → reconciled` naming logic covers all reachable terminal states above.
3. Freeze drain proves zero armed/unreconciled arms including
   reconciliation completed on the double window; the drain may **never** mark
   an `armed` row that it cannot time-box as closed.
4. Out-of-process lifecycle policy proof (managed, one-documented
   wiki/catalog entry) showing no expiration for produced objects.
5. Quarantined object rate alerting and operator tools verified in tests with
   fixture arms.

## 13. Phase rollout recommendation (implementation phases post-B3-D)

1. **B4-A (readiness of locking):** add `FOR UPDATE` to the freeze row read
   in arm-issuer transactions only (minimal change; no schema).
2. **B4-B:** create dedicated `storage_write_arms` table + RLS + housekeeping
   schedule + task runner hooks (migration authorization required before this).
3. **B4-C:** enter locked freeze checking at weapon code.
4. **B4-D:** reconciliation sweeper + CRC head + quarantine handling.
5. **B4-E:** client token re-mint + WOPI lifetime reduction + dev docs.
6. **B4-F:** lifecycle policy test and quarantined alert; publish green run.

## 14. Extent and guarantees

Read-only deliverable. This design does not modify code, migration, or schema.
It defines the minimal design needed to let any implementation satisfy the G2
freeze-readiness conditions without further design ambiguity.

G2 continues to remain **BLOCKED**. The implementation cannot be certified
against G2 until the design in this document ships and passes its concurrent
plus fault-injection verification on an isolated PostgreSQL environment.
