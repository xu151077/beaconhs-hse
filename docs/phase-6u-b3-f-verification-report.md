# Phase 6U-B3-F Verification Report

- Date: 2026-10-14
- Branch: `hse-platform`
- Source HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## Real PostgreSQL TS Integration

An isolated PostgreSQL 16.15 database on `10.10.31.30` was used. The TS wrappers in `packages/db` were executed through `tsx` against the migrated schema.

### Verified scenarios

1. ACTIVE state and issue success.
2. activate after issuance.
3. FROZEN state rejection.
4. activation failure recording in `failed_to_activate`.
5. `countUnresolvedStorageWriteArmsForTenant` returns a value (runtime may be string).
6. cleanup restored database to ACTIVE with 0 unresolved arms.

Result: **PASS** (`{"ok": true}`).

## Defect discovered and fixed

- Database clients may return PostgreSQL `COUNT(*)` as a string. The previous `?? 0` fallback did not convert numeric values from string `COUNT(*)`.
- Fixed in:
  - `packages/db/src/storage-freeze-operations.ts`
  - `packages/db/src/storage-write-arms-operations.ts`
- Each count is now converted via `Number(...)` if not already a number.

## Code-level compatibility

- `packages/storage/src/index.ts` stays blocked unless issuer issue succeeds.
- `presignPut` and `presignMultipartPart` retain the arm row even when activation update fails. These rows remain unresolved in inventory, matching the safe-only interpretation of the design.
- No migration was added or modified in this phase beyond the existing 0046/0047 migrations.

## Remaining risk

- True multipart completion/abort/freeze interaction still requires end-to-end WOPI/browser upload flow evidence.
- Presigned-url unrevocableness remains outside the authoritative post-issuance path of any real redeeming client.
- External lifecycle risks remain governed separately (Phase 6U-B3-C).

## Git state

- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Branch: `hse-platform`
- No commits, no pushes; all work aligned with statutory revert constraints.
