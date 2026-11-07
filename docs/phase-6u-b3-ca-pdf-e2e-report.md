# Phase CA — PDF End-to-End Report

Date: 2026-10-18

## 1. Status

**NOT RUN on HTTPS.** The deployment compose file is missing and the PDF fix image
was not deployed (see `phase-6u-b3-ca-env-recovery.md`). The fix was verified
locally in Phase BU.

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

The Phase CA §8 scenarios require the deployed image and were NOT executed. They
are identical to the Phase BV list: normal PDF upload/preview/download/SHA-256,
large valid PDF, missing `%%EOF`/`startxref` rejection, header-only rejection,
over-size rejection, large-file timeout, watchdog error, tab stability, Chinese
filename download, unauthorised access, DOCX/PPTX + Collabora.

## 4. Verified vs. not

- Verified (local): server trailer rule, viewer watchdog, task cleanup, all six gates.
- Not verified (HTTPS, needs deploy): product-path upload rejection, preview,
  download, filename handling, tab stability.

## 5. Recommendation

Recover the compose env mapping, deploy `beaconhs:phase-bu-20261018-131209`, then
run the HTTPS browser checks. No commits or pushes until verification complete.
