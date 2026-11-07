# Phase AC — Signed URL Expiry Investigation & Runtime Closure

Repository: `/home/test/projects/beaconhs-hse`  
Branch: `hse-platform`  
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## Root cause

Phase AB showed an expired multipart PUT returning HTTP 200 because the test did
not directly control the signed expiration duration. `packages/storage`
defaults its built-in test setup to a no-op write-arm issuer that always
returns 60 seconds, even when `presignMultipartPart(... expiresInSeconds: 5)`
requested five seconds. Therefore the original Phase AB signed URL was actually
valid for two minutes, and the eight-second wait was not an expiry test.

After registering a test-only issuer that honors the requested expiration, a
five-second URL accepted an in-lifetime PUT with HTTP 200 and was rejected
with HTTP 403 after six seconds. Fresh URLs accepted before their expiry. URL
strings from separate issuance attempts are distinct.

No production configuration change was made.

## Evidence

Redacted request metadata only; signed URLs and signatures are not reproduced.

| Case               |                          HTTP status | X-Amz-Expires requested (effective) | wait | result                        |
| ------------------ | -----------------------------------: | ----------------------------------: | ---: | ----------------------------- |
| before expiry      |                                  200 |                                   5 |  1 s | accepted                      |
| after expiry       |                                  403 |                                   5 |  6 s | rejected                      |
| fresh after expiry |                                  200 |                                   5 |  1 s | accepted                      |
| new signed URL     | 403 if used after expiry, 200 before |                                   5 |  6 s | accepted/rejected as expected |

Likely conclusion: HTTP 200 in Phase AB was a test defect, not a real
signature-validation failure and not a MinIO clock-skew issue. Once the issue
was corrected, MinIO enforced expiry correctly at HTTP 403.

## Added test coverage

- `packages/storage/src/phase-ab-multipart-runtime.test.ts`: retained
  272,629,760-byte five-part upload, completion, hash, freeze, and cleanup.
- `packages/storage/src/phase-ac-multipart-expiry-retry.test.ts`: focused
  valid/expired retry coverage, including hash-safe completion.

## Command results

- `pnpm --filter @beaconhs/storage test`: PASS (15 files / 147 tests)
- `pnpm --filter @beaconhs/storage typecheck`: PASS
- `pnpm deadcode:check`: PASS
- `pnpm exec prettier --check` for touched files: PASS after writing

## Browser E2E

Browser E2E remains **NOT RUN**. No legitimate authenticated UI route safely
supports >256 MiB without changing production limits. Service-level evidence must
not be presented as browser E2E.

## Cleanup

All disposable keys and abort mounts were deleted in the passing tests. Ending
state does not leave the temporary object from the 260 MiB test.

## G2

G2 remains **BLOCKED**. The specific signed-URL expiry defect has been
resolved and reproduced correctly. Remaining blockers are broader browser/E2E
and production R2/IAM/lifecycle/network/Collabora evidence.
