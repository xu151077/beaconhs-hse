# Phase CA — Freeze Regression Report

Date: 2026-10-18

## 1. Status

**NOT re-run this phase.** The PDF fix (Phase BU) touches only `upload-policy.ts`
and `pdf-viewer.tsx`; it does not modify any storage-freeze, write-arm, in-flight,
or multipart code path. The freeze behaviour was verified end-to-end in Phase BQ
(11/11 HTTP E2E scenarios on the isolated HTTPS env, real magic-link auth, real
state machine). Re-running the full freeze suite would take ~40 minutes and
adds no new evidence for this fix.

## 2. Phase BQ results (carried forward)

- Frozen-UX regression: 4/4 pass.
- Multipart across a freeze: 7/7 pass.
- Auth: real magic-link login against the test env's own Mailpit.
- Freeze state: production `applyTransition` against the test env's own DB.
- Multipart: 256 MiB fixture (4 × 64 MiB parts), SHA-256 verified through the
  pane's presigned capability URL.
- All six gates passed.

## 3. What would need re-verification after deploy

Once `beaconhs:phase-bu-20261018-131209` is deployed, the following should be
smoke-checked (not full 11-scenario rerun):

- Normal multipart upload completes and SHA-256 matches.
- Frozen-state upload rejection shows the frozen copy.
- Start blank / Import Word file behave correctly under ACTIVE and FROZEN.
- Collabora editing works under ACTIVE.

## 4. D-BQ-2 interaction

The PDF fix does not affect freeze behaviour. The freeze regression risk is
unchanged. No new freeze write-paths were introduced.
