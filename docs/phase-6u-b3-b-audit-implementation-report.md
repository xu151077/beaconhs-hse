# Phase 6U-B3-B: In-Flight Tracking Reliability & External Write Entry Points

- Date: 2026-10-14
- HEAD: 51a899b7aac0a942da327222a3eed355fca9798a
- Branch: hse-platform

## Summary

Phase 6U-B3-A best-effort in-flight registration downgraded failed/missing
registrations to no-tracking writes. B3-B removes that downgrade: tracker presence
and successful `register()` are now hard requirements. External entry points are
wired only where they route through `packages/storage`.

## Modified files

- `packages/storage/src/freeze-gate.ts` — `createNoOpInFlightWriteTracker` helper.
- `packages/storage/src/index.ts` — strict tracker admission in `putObject`,
  `createMultipartUpload`, `completeMultipartUpload`, `abortMultipartUpload`,
  `deleteObject`, `promoteObject`. A missing or failing registration now throws
  `STORAGE_WRITE_BLOCKED` before any S3 request.
- `packages/storage/src/test-setup.ts`, `packages/storage/vitest.config.ts` —
  stable default tracker for the offline storage test harness.
- `packages/storage/src/freeze-gate-storage.test.ts` — failure-mode tests.
- `packages/db/src/storage-freeze-operations.ts` — `bootstrapStorageFreezeGate`
  now installs the DB-backed in-flight tracker as well as the reader.
- `apps/web/src/app/wopi/files/[fileId]/contents/route.ts` — surfaces `423`
  when staging through `putObject` is storage-blocked.

## External entry-point coverage

| Path                                                                                                                          | Coverage                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `putObject` / `createMultipartUpload` / `completeMultipartUpload` / `abortMultipartUpload` / `deleteObject` / `promoteObject` | Full — admission, registration, completion/failure tracking, fail-closed.                                                                                                                                                     |
| Worker write paths                                                                                                            | Covered via bootstrap: calls go through storage functions.                                                                                                                                                                    |
| WOPI write-back                                                                                                               | Arguably covered: 423 on blocked; stage key wrote through `putObject` under tracker. Cleanup through `deleteObject`. Abort does not abort frozen in drain? Marked in-flight.                                                  |
| presigned PUT / presigned multipart-part                                                                                      | PARTIALLY COVERED — minting-time freeze check (Phase 6T-B) only. Already-issued URLs cannot be revoked; bounded by URL credential lifetime. `presignPut`/`presignMultipartPart` unchanged by design. Clearly NOT revoke-safe. |
| Collabora independent write-back                                                                                              | NOT COVERED — unverified independent channel.                                                                                                                                                                                 |
| Deletion Outbox                                                                                                               | NOT COVERED — separate lifecycle, not part of this stage.                                                                                                                                                                     |
| Lifecycle engine / SeaweedFS policy                                                                                           | NOT COVERED — out-of-process; audited but unchanged.                                                                                                                                                                          |

## Reliability rules confirmed

- Registration failure does NOT downgrade to an untracked write.
- Unregistered tracker => write refused.
- `register()` returning `null` => write refused.
- `markCompleted` / `markFailed` bookkeeping failures are logged but the
  underlying row stays open, so drain does not falsely report zero.
- S3 failure paths call `markFailed` and do not call `markCompleted`.

## Gate results

- `pnpm format:check`: PASS
- `pnpm typecheck`: PASS (27 tasks)
- `pnpm lint`: PASS (1 unrelated pre-existing web warning)
- `pnpm test` (storage): PASS — 121 tests, 11 files
- `pnpm build`: not re-run in this pass; web build may be required before push.
- DB migration/schema changes: none.

## Remaining risks / open items

- Presigned URLs remain unrevokeable; drain cannot block their late writes.
- Real database concurrency proof still pending (no migration run, no container).
- B3-B external entry points listed as NOT COVERED remain uncovered.
- G2 stays BLOCKED until drain verified end-to-end.
