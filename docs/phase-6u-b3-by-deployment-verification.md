# Phase BY — Deployment Verification

Date: 2026-10-18

## 1. Deployment result

**NOT deployed.** The environment-variable construction in the original compose
file could not be recovered safely (see `phase-6u-b3-by-env-mapping-recovery.md`).
Deploying the candidate would start web/worker without `DATABASE_URL`/`R2_*`/
secrets and break the isolated test environment. Per the Phase BY rules, no
deployment was attempted.

- Running image (unchanged): `beaconhs:phase-bp-20261018-095008`
  (`sha256:474ccda68ed4…`).
- Ready image (not deployed): `beaconhs:phase-bu-20261018-131209`
  (`sha256:23dae17b12ae…`), built from this working tree.
- Test env health: `https://beaconhs-test.xuhaoqing.top/login` → 200.
- No database migration run. No volumes, networks, or containers changed.

## 2. Image audit (Task B)

- The built image contains the PDF upload check (`incomplete or damaged` in the
  server SSR bundle) and the viewer watchdog (`Could not load the PDF` in the
  client bundle). Verified by extracting files from the image without running it.
- Image created: 2026-10-18. Build source: this working tree,
  `DEPLOYMENT_VERSION=51a899b7…`.
- No host-proprietary files were lost beyond `phase-aj-compose-final.yaml`
  (already documented). The build context sync used `--delete` without an exclude
  for host-only compose files; this must not be repeated.

## 3. Quality gates (Task G)

All six gates pass on the fixed code (captured exit codes, all 0):

| Gate                  | Result                     |
| --------------------- | -------------------------- |
| `pnpm format:check`   | 0                          |
| `pnpm typecheck`      | 0                          |
| `pnpm lint`           | 0                          |
| `pnpm test`           | 0 (2033 passed, 8 skipped) |
| `pnpm deadcode:check` | 0                          |
| `pnpm build`          | 0                          |

## 4. PDF verification (Task D)

Performed locally, not on the HTTPS environment (deployment blocked):

- Unit: `upload-policy.test.ts` (8 tests) — trailer rejection, non-PDF kinds
  skipped, trailing whitespace accepted, out-of-order markers rejected.
- Unit: `pdf-preview-policy.test.ts` (3 tests) — fires once at deadline, silent
  after `stop()`, ceiling far above real loads.
- Browser harness (real Chromium, real 256 MiB fixture): valid 255 MiB renders in
  0.4 s; 256 MiB malformed + watchdog fires at 10 s with no crash; same file
  without watchdog crashes at 39.1 s (negative control).
- Product-path E2E on HTTPS: **not run** (image not deployed).

## 5. Storage Freeze / Multipart (Task E)

Not re-run in this phase. The freeze behaviour was verified end-to-end in
Phase BQ (11/11 scenarios on the isolated HTTPS env) and is unchanged by this
fix (the PDF fix touches only upload-policy and pdf-viewer). No new freeze
write-paths were introduced.

## 6. Full system regression (Task F)

Code-level regression covered by the test suite (2033 passed). No new test data
created; no cleanup required. The i18n catalogue additions (ProviderSettings
namespace, 28 manual-article bodies, multipart/prose/heading strings) keep the
i18n gates green.

## 7. Defects / residual risks

- D-BQ-2: **fixed** (this phase's predecessor, Phase BU).
- Deployment config recovery: **blocked** (env mapping not recoverable without
  guessing). See `phase-6u-b3-by-env-mapping-recovery.md`.
- Known defects D1–D6 remain on record, untouched.
- Pre-existing i18n gap in `upload-policy.ts` error messages (plain English,
  not catalogued) — flagged, not fixed here.

## 8. Rollback

No change was made. Rollback target `beaconhs:phase-bp-20261018-095008`
(`474ccda68ed4`) is untouched. New image ready for deploy once the compose
config is recovered.
