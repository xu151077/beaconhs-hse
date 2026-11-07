# Phase 6U-B3-K Verification Report

- Date: 2026-10-14
- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Report: `docs/phase-6u-b3-k-verification-report.md`
- Initial G2 status: `BLOCKED`

## 1. Baseline and protection

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- User worktree: 178 changed/added files; left untouched.
- This phase produced only this report. No destructive git operations, no schema changes, migration, container changes, production access, or object-store mutations.
- Password/secret values were neither printed nor inspected beyond environment keys. External credentials were not tested.

## 2. Audited implementation

### Storage arm and freeze chain

- `packages/storage/src/index.ts`
  - `presignPut` default TTL now clamped to 120 seconds.
  - `presignMultipartPart` default TTL now capped to 60 seconds.
  - Invalid TTLs reject before arm issuance.
- `packages/db/src/storage-write-arms-operations.ts`
  - `computeStorageWriteArmExpiry` rejects non-finite, non-positive, or over-cap values.
  - `readStorageFreezeDrainStatus` counts both unresolved `in_flight_writes` and unresolved `storage_write_arms`.
  - `DRAINING → FROZEN` readiness is `false` unless both counts are zero and rest grace.
- `packages/db/src/storage-freeze.ts`
  - `evaluateTransition` still explicitly rejects `FROZEN` without drain evidence (`FREEZE_DRAIN_UNVERIFIED`).
- `packages/storage/src/freeze-gate.ts`
  - all server-side gated writes, including presign and WOPI, derive tenant only from key and fail closed.

### Reconciliation

- `apps/worker/src/lib/storage-write-arm-reconciler.ts`
  - 100-arm bounded loop.
  - applies 15-second grace.
  - only terminates based on actual object head metadata:
    - absent object → `redeemed_nop`
    - matching upload token → `redeemed_confirmed`
    - present but mismatched/missing token → `quarantined`
  - head read errors keep conservative state and retry.
- `packages/db/src/storage-write-arms-operations.ts:expireStaleStorageWriteArms`
  - now also converts expired `issuing` to `expired`, preventing issuance-only rows from lingering forever.

### Lifecycle

- `packages/storage/src/lifecycle.ts`
  - managed rules are 1-day pending rule and 1-day transient rule.
  - managed diff returns `PASS`, `DRIFT`, or `UNKNOWN`.
  - unreadable rules are `UNKNOWN`, never treated as pass.

## 3. K1: Presigned credential and freeze timing

Evidence:

- `packages/storage/src/index.ts`: `requested = args.expiresInSeconds ?? 120`; validation `No > 120`.
- `packages/storage/src/presign-arm-control.test.ts`: 126→130 storage tests pass; added over-limit and invalid TTL tests.
- `packages/db/src/storage-write-arms-operations.ts`: cap computation is monotonic.
- `storageWriteArmsDrainReady` applies 15-second grace. No shorter safety path is provided.

Conclusion:

- Code-level bound is internally consistent, but actual live object-store acceptance around `expires_at` was **NOT RUN**. K1 is therefore only partially proven. Existing URLs cannot be revoked in code; security depends entirely on external expiration.

K1 verdict: `PARTIAL / UNKNOWN` for actual enforcement, `PASS` for source-bound calculation.

## 4. K2: External object-store permissions and lifecycle

Available evidence:

- Source-review shows managed lifecycle only applies two scoped rules.
- `diffManagedStorageLifecycleRules` detects missing, mismatched, and unreadable configurations.
- Archive policy is not modified automatically by code in this phase.
- Direct bucket access, SeaweedFS or MinIO enforcement, DNS, network, and IAM identities were not inspected or altered.

Verdict:

- Code contrast capabilities: `PASS`.
- Actual bucket policy and external management paths: `UNKNOWN`.
- Lifecycle monitoring runtime evidence: `NOT RUN`. No workflow or alert was executed in this phase.

K2 verdict: `UNKNOWN` externally.

## 5. K3: Freeze and drain integration

Mock/source tests available:

- `packages/storage/src/freeze-gate-reader-contract.test.ts`, `freeze-gate-presign-wopi.test.ts`, and relevant suite:
  - hidden test files 12 pass, 130 tests.
- `apps/worker/src/lib/storage-write-arm-reconciler.ts` has failure handling and preserves unverifiable arms.
- `packages/db/src/storage-write-arms-operations.ts` contains arm read-only reconciliation helpers.
- WOPI save route test relies `SEED_TEST_SCRATCH_DATABASE_URL` and was skipped in most environments; therefore live WOPI freeze behavior through Collabora callback is `NOT RUN`.

Deletion outbox:

- Outbox drainer exists: `drainStorageObjectDeletionOutbox` processes deletes under permission and prefixed keys.
- Lifecycle-controlled runtime evidence absent.

K3 verdict: broad source/unit-level behavior `PASS`; runtime endpoints `NOT RUN`.

## 6. WOPI statement

- Frozen requests are rejected.
- Pre-existing 12-hour token sessions remain alive because code cannot kill them externally.
- Cannot claim immediate WOPI token revocation.
  W OB is residual risk and must remain visible.

## 7. G2 matrix

| Item                          | Evidence                                                    | Status                                  |
| ----------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| Application new write         | Gate and unit tests                                         | PASS                                    |
| Already issued URLs           | TTL calculation and unit bounds only                        | UNKNOWN                                 |
| In-flight drain               | DB count plus transactional lock; tests cover state         | PASS                                    |
| Arm reconciliation            | Worker and scheduler registration; bounded and conservative | PASS source, NOT RUN DB live            |
| Multipart                     | Unit/contract 60 second bound only                          | UNKNOWN actual lifecycle                |
| WOPI                          | Source behavior and skip-able route test; 12h residual      | UNKNOWN                                 |
| Lifecycle                     | Diff utility and shape                                      | PASS source, UNKNOWN live               |
| External delete authorization | No deployment identity/policy access                        | UNKNOWN                                 |
| Monitoring and alerting       | No runner outcome collected                                 | NOT RUN                                 |
| Recovery path                 | State machine + guard                                       | PASS source; UNKNOWN observed operation |

Overall: `BLOCKED`.

## 8. Commands run

- `pnpm --filter @beaconhs/storage test` → exit 0; 12 test files, 130 tests pass.
- `pnpm --filter @beaconhs/worker test` → exit 0; 27 files, 103 tests pass.
- `pnpm --filter @beaconhs/jobs test` → exit 0; 4 files, 19 tests pass.
- `pnpm --filter @beaconhs/db test` → exit 0; 61 files, 495 passed, 35 skipped.
- `pnpm --filter @beaconhs/db test` could not prove production Storage enforcement because it is a local database test only.
- Read-only external traffic was not attempted.

## 9. Remaining external evidence required

1. Confirmation that presigned URLs cannot be renewed after issuance and only natural expiry bounds their redemption window.
2. Isolated test object-store evidence that the actual URL timeout matches 120/60 seconds after issued.
3. Deployment bucket lifecycle configuration, directly compared against managed rules, including absent/emergent policies.
4. Direct-bucket permission evidence proving application identities cannot manage lifecycle or delete directly, separate from app policy enforcement.
5. Alert route verification and production-representative runner evidence.

## 10. Git status

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Working tree remains dirty with 178 changed/untracked files.
- No commits or pushes were made in this phase.

Stopping as required. G2 remains **BLOCKED**.
