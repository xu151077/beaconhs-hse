# Phase BZ — Defect Register

Date: 2026-10-18

## Fixed in this phase (Phase BU)

- **D-BQ-2 (High) — FIXED.** pdf.js viewer killed the renderer tab on a 256 MiB
  (malformed) upload. Root cause: `XRef.indexObjects()` recovery walk accumulates
  one JS string per character of the longest token run. Fix: server-side trailer
  validation (`uploadedFileTailError`) + client-side 10 s watchdog with
  `task.destroy()`. Verified by unit tests + browser harness (negative control).

## Open / pre-existing (not fixed, out of scope)

- **D-BQ-1 (Critical)** — fixed in Phase BQ (client/server boundary split).
- **D-BQ-3 (Medium)** — fixed in Phase BQ (restored `values` prop).
- **D1–D6** — on record, untouched (see `docs/hse-development-baseline.md` §21).
- **Deployment config missing** — `phase-aj-compose-final.yaml` removed by
  `rsync --delete` in Phase BU. Candidate file exists; env mapping unverified.
  BLOCKED. See `phase-6u-b3-bx-compose-review.md`.
- **i18n gap in `upload-policy.ts`** — error messages are plain English, not
  catalogued (pre-existing pattern in that module). Flagged, not fixed.
- **`multipart-fixtures.ts` generator inconsistency** — writes `0x42` bytes but
  the on-disk fixture (and `FIXTURE_HASH`) uses `0x41`. Tests pass because the
  file exists; regenerating would change the hash. Flagged.

## No new defects introduced

All six gates pass; no regressions in the 2033 tests. The fix is minimal and
targeted (upload-policy + pdf-viewer + a small policy module).
