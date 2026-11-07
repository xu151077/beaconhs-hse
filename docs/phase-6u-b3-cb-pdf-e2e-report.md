# Phase CB — PDF End-to-End Report

Date: 2026-10-18

## 1. Status

**NOT RUN on HTTPS.** Deployment compose file is missing; PDF fix image not deployed.

## 2. Local verification (Phase BU)

| Scenario                                 | Result                | Evidence                                                            |
| ---------------------------------------- | --------------------- | ------------------------------------------------------------------- |
| Normal valid PDF (5/85/255 MiB)          | PASS                  | renders in ≤0.4 s                                                   |
| Large valid PDF (255 MiB, 255 pages)     | PASS                  | resolves 0.3 s, renders page 1                                      |
| Malformed PDF (no xref, 1–32 MiB)        | PASS (graceful error) | `Invalid PDF structure.`                                            |
| Malformed PDF (64 MiB)                   | PASS (graceful, ~6 s) | small heap                                                          |
| Malformed PDF (128 MiB)                  | PASS (graceful, ~9 s) | ~2.7 GB peak                                                        |
| Malformed PDF (256 MiB) without watchdog | FAIL (crash)          | renderer 4.7 GB → kill at 31 s                                      |
| Malformed PDF (256 MiB) with watchdog    | PASS                  | watchdog fires at 10 s, worker destroyed, error shown, tab survives |
| Trailer rejection (server)               | 8 unit tests PASS     | `upload-policy.test.ts`                                             |

## 3. HTTPS scenarios (not run)

All Phase CB §9 scenarios require the deployed image and were NOT executed:

- Normal PDF upload/preview/download/SHA-256
- Large valid PDF preview
- Missing `%%EOF` / `startxref` / header-only rejection
- Over-size rejection
- Large-file timeout + watchdog error
- Tab stability on malformed/timeout
- Worker/task cleanup on switch
- Chinese filename download (ASCII fallback + `filename*`)
- SHA-256 round-trip
- Unauthorised access prevention
- DOCX/PPTX + Collabora

## 4. Verified vs. not

- **Verified (local)**: server trailer rule, viewer watchdog, task cleanup, all six gates
- **Not verified (HTTPS, needs deploy)**: all product-path scenarios

## 5. Recommendation

Recover compose env mapping → deploy `beaconhs:phase-bu-20261018-131209` → run HTTPS browser checks.
