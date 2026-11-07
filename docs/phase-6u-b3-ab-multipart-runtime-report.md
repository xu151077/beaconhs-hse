# Phase AB — Multipart Runtime Report

Repository: `/home/test/projects/beaconhs-hse`  
Branch: `hse-platform`  
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`  
Date: current repository state

## Summary

Phase AB executed a real, service-level multipart upload test against the local
MinIO-compatible object store. This was not a browser UI E2E test. It used the
actual `packages/storage` freezable, multipart, preservation and object/I/O
functions. The single test run uploaded 272,629,760 bytes (260 MiB), verified
download bytes and SHA-256, and cleaned only the disposable key and abort
key.

## Test file added

- `packages/storage/src/phase-ab-multipart-runtime.test.ts` (service-level,
  not browser-level)

## Call chain exercised

1. `ensureBucket()`
2. tenant object key minting with a UUID tenant id
3. `shouldUseMultipartUpload(260 MiB)` → true
4. `registerStorageFreezeReader(active state)`
5. `createMultipartUpload()` with in-flight tracker and write-arm no-op
   issuer from `packages/storage/src/test-setup.ts`
6. Multiple `presignMultipartPart()` calls
7. Browser/server direct HTTP `PUT` uploads to each presigned MinIO URL
8. `completeMultipartUpload()` with real parts listed from S3
9. `headObject()` + `getObject()` for size and SHA-256 verification
10. `deleteObject()` cleanup for the completed object
11. `createMultipartUpload()` + `abortMultipartUpload()` cleanup for a
    separate abort key
12. storage freeze refusal via `registerStorageFreezeReader(frozen state)` and
    `presignMultipartPart()`

## Test resources

- Object key: `t/550e8400-e29b-41d4-a716-446655440000/_phase_ab_<timestamp>/phase-ab-260m.bin`
- Abort key: separate `_phase_ab_abort` key
- Freeze key: separate `_phase_ab_freeze` key
- Source payload shape: one buffer of 272,629,760 bytes whose first byte of
  each 64 MiB part differs from zero (`1..5`)
- Source SHA-256:
  `a8df774a87f8ee78ebb6a26715be5a86c1606839aeca9a83f6ba6c73cbc15e6e`

## Evidence captured

- Multipart threshold exceeded:
  - `shouldUseMultipartUpload(260 MiB)` was true
  - `MULTIPART_UPLOAD_PART_SIZE_BYTES` = 67,108,864 bytes (64 MiB)
  - result: 5 parts of 64 MiB + 4 MiB
- Final size:
  - head content length = 272,629,760
  - expected = 272,629,760
  - PASS
- Final SHA-256:
  - actual = `a8df774…`
  - expected = `a8df774…`
  - PASS
- Concurrent multipart:
  - five part URLs were signed and uploaded successfully
  - all returned HTTP 200
  - PASS
- URL switching:
  - two presigned URLs for part 1 differed textually
  - both PUT uploads returned HTTP 200
  - PASS at URL-issuance / issuance-distinguishability level
- URL expiry:
  - a 6-second URL received HTTP 200 after an 8-second wait
  - therefore expiry refusal was **not** demonstrated under local MinIO
  - this item remains **NOT RUN / unverified**
- Freeze control:
  - presigned part request under `FROZEN` refused with
    `STORAGE_WRITE_BLOCKED (...) (state=FROZEN)`
  - PASS
- Cleanup:
  - completed object `existsAfterDelete` = false
  - PASS
- Abort:
  - a separate disposable empty multipart upload was created and aborted
  - abort path did not leave the tested object
  - PASS at code admissibility level only

## Browser E2E

Browser E2E remains **NOT RUN** because no legitimate UI surface safely
supports a >256 MiB upload without weakening production upload limits. This
service-level result must not be represented as browser E2E.

## Additional checks

- `pnpm --filter @beaconhs/storage test`: PASS (13 files / 145 tests)
- `pnpm --filter @beaconhs/storage typecheck`: PASS
- `pnpm deadcode:check`: PASS
- `pnpm exec prettier --check` for the touched test: PASS after write

## Remaining blockers for G2

- Browser/E2E multipart evidence remains unavailable.
- Signed-URL expiry refusal under local MinIO was not reproduced.
- 260 MiB E2E UI environment and request capture remain unavailable.
- G2 remains **BLOCKED**.
