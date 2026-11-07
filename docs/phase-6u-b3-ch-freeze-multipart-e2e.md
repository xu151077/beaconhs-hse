# Phase CH — Freeze/Multipart E2E Report

Date: 2026-10-18

## 1. Status

**NOT RUN this phase.** The freeze/multipart regression tests were not executed.

## 2. Technical blocker

The freeze driver (`bt-freeze-driver.ts`) does not exist in any deployed image. The production source code is not available in the container (compiled image only). There is no HTTP admin API to drive the state machine through the browser.

See `phase-6u-b3-ch-freeze-test-driver.md` for the full analysis.

## 3. Phase BQ results (historical evidence — NOT counted as Phase CH)

Phase BQ verified 11/11 freeze/multipart HTTP E2E scenarios on the same isolated test tenant (`ea5a149b-ea76-48e0-abbe-fa360f520d8e`):

- Frozen-UX regression: 4/4 pass
- Multipart across a freeze: 7/7 pass
- Auth: real magic-link login
- Freeze state: production `applyTransition`
- Multipart: 256 MiB fixture (4 × 64 MiB parts), SHA-256 verified

These results are from Phase BQ, not Phase CH. They are provided as historical context only.

## 4. Code verification

The freeze/multipart code has not changed since Phase BQ. The Phase BU PDF fix only modified:

- `apps/web/src/lib/upload-policy.ts`
- `apps/web/src/lib/uploads.ts`
- `apps/web/src/components/pdf-viewer.tsx`
- `apps/web/src/lib/pdf-preview-policy.ts`

None of these files touch freeze, multipart, write-arm, or in-flight logic.

## 5. Unit test coverage

| Test file                                               | Tests | Status |
| ------------------------------------------------------- | ----- | ------ |
| `packages/db/src/storage-freeze.test.ts`                | 50+   | PASS   |
| `packages/db/src/storage-freeze-operations.test.ts`     | 30+   | PASS   |
| `apps/web/src/lib/storage-freeze-gate.test.ts`          | 10+   | PASS   |
| `apps/web/src/lib/storage-freeze-refusal.test.ts`       | 5+    | PASS   |
| `packages/storage/src/freeze-gate-presign-wopi.test.ts` | 5+    | PASS   |
| `packages/storage/src/multipart.test.ts`                | 10+   | PASS   |

All pass as part of the 2033 web tests and 542 db tests.

## 6. Tenant state (verified)

| Field                   | Value                                  |
| ----------------------- | -------------------------------------- |
| Tenant ID               | `ea5a149b-ea76-48e0-abbe-fa360f520d8e` |
| Status                  | ACTIVE                                 |
| Freeze row state        | ACTIVE (version 99)                    |
| Lease holder            | (none)                                 |
| Non-terminal write arms | 0                                      |
| In-flight writes        | 0                                      |
