# Phase BZ — PDF End-to-End Report

Date: 2026-10-18
Scope: PDF upload validation, preview, watchdog, download, filename handling.

## 1. Status

**BLOCKED on deployment.** The HTTPS browser E2E could not be run against the
fixed image because the deployment compose file is missing and the image was not
deployed (see `phase-6u-b3-by-env-mapping-recovery.md` and
`phase-6u-b3-bx-compose-review.md`). The fix was verified locally in Phase BU.

## 2. Local verification (Phase BU)

| Scenario                                 | Result                  | Evidence                                                            |
| ---------------------------------------- | ----------------------- | ------------------------------------------------------------------- |
| Normal valid PDF (5/85/255 MiB)          | PASS                    | renders in ≤0.4 s                                                   |
| Large valid PDF (255 MiB, 255 pages)     | PASS                    | resolves 0.3 s, renders page 1                                      |
| Malformed PDF (no xref, 1–32 MiB)        | PASS (graceful error)   | `Invalid PDF structure.`                                            |
| Malformed PDF (64 MiB)                   | PASS (graceful, ~6 s)   | small heap                                                          |
| Malformed PDF (128 MiB)                  | PASS (graceful, ~9 s)   | ~2.7 GB peak                                                        |
| Malformed PDF (256 MiB) without watchdog | FAIL (crash)            | renderer 4.7 GB → kill at 31 s                                      |
| Malformed PDF (256 MiB) with watchdog    | PASS                    | watchdog fires at 10 s, worker destroyed, error shown, tab survives |
| `stopAtErrors` option                    | does not bound recovery | measured                                                            |
| Trailer rejection (server)               | 8 unit tests PASS       | `upload-policy.test.ts`                                             |

## 3. HTTPS scenarios (not run)

The following Phase BZ §7.2 scenarios require the deployed image and were NOT
executed:

1. Normal PDF upload + preview + download + SHA-256 — NOT RUN
2. Large valid PDF preview — NOT RUN
3. Missing `%%EOF` rejected at upload finalize — NOT RUN (server rule verified by unit tests)
4. Missing `startxref` rejected — NOT RUN
5. Header-only file rejected — NOT RUN
6. Over-size file rejected — NOT RUN (existing `MAX_UPLOAD_BYTES` rule)
7. Large-file preview timeout + watchdog error — NOT RUN (verified in harness)
8. Timeout then reopen valid file — NOT RUN
9. Worker/task release on repeated switches — NOT RUN
10. No tab crash on malformed/timeout — NOT RUN (verified in harness)
11. Chinese filename download (ASCII fallback + `filename*`) — NOT RUN (pre-existing code path, unchanged)
12. SHA-256 round-trip — NOT RUN (pre-existing, BQ verified)

## 4. What is verified vs. not

- Verified (local): server trailer rule, viewer watchdog, task cleanup, all six gates.
- Not verified (HTTPS, needs deploy): product-path upload rejection, preview, download, filename handling, tab stability.

## 5. Recommendation

Complete the deployment (recover compose env mapping, repoint to
`beaconhs:phase-bu-20261018-131209`), then run the Phase BV HTTPS checklist.
