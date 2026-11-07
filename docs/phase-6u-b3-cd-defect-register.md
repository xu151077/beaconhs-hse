# Phase CD — Defect Register

Date: 2026-10-18

## Fixed in Phase BU (carried forward)

- **D-BQ-2 (High) — FIXED.** pdf.js viewer killed renderer tab on 256 MiB malformed upload. Root cause: `XRef.indexObjects()` recovery walk. Fix: server-side trailer validation (`uploadedFileTailError`) + client-side 10 s watchdog with `task.destroy()`. Verified by 8 unit tests + browser harness (negative control).

## Open / pre-existing (not fixed, out of scope)

- **D-BQ-1 (Critical)** — fixed in Phase BQ
- **D-BQ-3 (Medium)** — fixed in Phase BQ
- **D1–D6** — on record, untouched
- **Deployment config missing** — **RESOLVED in Phase CD** (recovered from drill compose + running container env)
- **i18n gap in `upload-policy.ts`** — error messages plain English, not catalogued. Flagged
- **`multipart-fixtures.ts` generator inconsistency** — writes `0x42` bytes but on-disk fixture uses `0x41`. Flagged

## No new defects introduced

All six gates pass; no regressions in 2033 tests.
