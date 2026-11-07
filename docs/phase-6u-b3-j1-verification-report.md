# Phase 6U-B3-J1 Verification Report

- Date: 2026-10-14
- Branch: `hse-platform`
- Source HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Report: `docs/phase-6u-b3-j1-verification-report.md`

## Modified files

- `packages/storage/src/index.ts`
  - `presignPut` default TTL changed from 300 s to 120 s.
  - `presignMultipartPart` default TTL changed from 3600 s to 60 s.
  - Added explicit range validation so non-finite, zero, negative or out-of-range TTL values fail closed.
- `packages/db/src/storage-write-arms-operations.ts`
  - `computeStorageWriteArmExpiry` rejects out-of-range/infinite/non-positive input.
  - Added `readStorageFreezeDrainStatus`, which combines `countInFlightWrites`, unresolved arm count, and max arm expiry plus 15 s grace into a read-only composite condition.
- `packages/storage/src/write-arms.ts`
  - Test-only no-op arm issuer now reports TTL from its operation (`presignPut`: 120 s, `presignMultipartPart`: 60 s).
- `packages/storage/src/presign-arm-control.test.ts`
  - Added default/over-limit/invalid TTL tests.

## Gate state

- Storage unit tests: 126 passing.
- Typecheck: 27 workspaces passing.
- Format: passing.
- No migration executed. No Schema change. No production write.

## Drain condition boundary

- `readStorageFreezeDrainStatus` is a read-only composite helper.
- It counts unresolved `in_flight_writes` **and** unresolved `storage_write_arms`.
- It returns `ready = true` only when all these hold:
  - no DB errors;
  - `inFlightCount === 0`;
  - `unresolvedArmCount === 0`;
  - current time is at least `maxArmExpiresAt + 15_000 ms`.
- This helper does **not** by itself drive a state transition. `evaluateTransition` remains fail-closed to `FROZEN`.
- Thus this phase improved the _information available_ to later transitions without broadening freeze acceptance.

## TTL alignment

- Signed URL TTL now always derives from an arm row whose `expires_at` matches the requested seconds.
- Cap remains 120 s for PUT and 60 s for multipart part, matching `maxStorageWriteArmTtlMs`.
- Invalid values now reject before any DB registration or signature.

## What remains for J2

- Timed scheduler worker to sweep/mint/validate expired `storage_write_arms`.
- Signed-URL redeem reconciliation Head/token checks.
- WOPI open-session handling.
- External object-store lifecycle diff.
- Unresolved backflow when activation failures occur outside normal DB failure path.

Not verified externally:

- Live signed URL expiration in S3-like object store.
- `requestExpiresInSeconds` clipping relative to client-specified durations.
- Simulated network expiry greater than 300 s (old caller clamping absent by design).

## G2 status

G2 remains `BLOCKED`.
