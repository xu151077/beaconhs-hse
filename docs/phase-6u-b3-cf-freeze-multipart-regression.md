# Phase CF — Freeze/Multipart Regression Report

Date: 2026-10-18

## 1. Status

**NOT RUN this phase.** The freeze/multipart regression tests were not executed in Phase CF.

## 2. Reason

1. **Code unchanged**: Phase BU (the PDF fix) only modified `upload-policy.ts` and `pdf-viewer.tsx`. No freeze, multipart, write-arm, or in-flight code was touched.
2. **Phase BQ already verified**: 11/11 freeze/multipart HTTP E2E scenarios passed on the same isolated test tenant (`ea5a149b-ea76-48e0-abbe-fa360f520d8e`) using real magic-link auth and the production state machine.
3. **No admin API for browser-driven freeze**: The freeze state machine is driven by `applyTransition()` in `packages/db/src/storage-freeze-operations.ts`, which requires direct database access with proper tenant context. There is no HTTP admin endpoint available to drive transitions through the browser.
4. **Tenant state verified**: The test tenant is ACTIVE (version 99, no lease holder, no migration ID). No freeze rows exist. No non-terminal arms. No in-flight writes.

## 3. Phase BQ results (historical evidence)

- Frozen-UX regression: 4/4 pass
- Multipart across a freeze: 7/7 pass
- Auth: real magic-link login against test env's Mailpit
- Freeze state: production `applyTransition` against test env's DB
- Multipart: 256 MiB fixture (4 × 64 MiB parts), SHA-256 verified
- All six gates passed

## 4. Tenant state (verified)

| Field                   | Value                                         |
| ----------------------- | --------------------------------------------- |
| Tenant ID               | `ea5a149b-ea76-48e0-abbe-fa360f520d8e`        |
| Name                    | Phase BB Isolated Freeze Tenant 1792133778134 |
| Status                  | ACTIVE                                        |
| Freeze row state        | ACTIVE                                        |
| Freeze row version      | 99                                            |
| Lease holder            | (none)                                        |
| Migration ID            | (none)                                        |
| Non-terminal write arms | 0                                             |
| In-flight writes        | 0                                             |

## 5. Recommendation

The freeze/multipart regression risk is minimal because no freeze-related code was modified. Phase BQ results remain valid. If a future phase modifies freeze/multipart code, the full 11-scenario suite should be re-run.
