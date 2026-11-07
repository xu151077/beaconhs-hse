# Phase CB — Baseline

Date: 2026-10-18
Phase: CB (runtime config recovery + safe compose reconstruction + deployment closure)

## 1. Git and working tree

- Repository: `/home/test/projects/beaconhs-hse`
- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a` (matches expected baseline)
- Working tree: modified (pre-existing HSE work + Phase BU/BV/BW/BX/BZ/CA changes)
- No commits, no pushes performed during this phase

## 2. Code state (PDF fix)

- `apps/web/src/components/pdf-viewer.tsx` — watchdog + destroy on cleanup
- `apps/web/src/lib/pdf-preview-policy.ts` — timeout constant + watchdog helper
- `apps/web/src/lib/upload-policy.ts` — `uploadedFileTailError`, `isPdfUpload`, `PDF_TRAILER_WINDOW_BYTES`
- `apps/web/src/lib/uploads.ts` — bounded tail read + check in finalize
- `apps/web/src/lib/manual/content/knowledge-assets.ts` — completeness note
- i18n catalogue: `ProviderSettings` namespace (en/fr/es/zh), 28 manual-article bodies

## 3. Test environment

- HTTPS: `https://beaconhs-test.xuhaoqing.top` → `/login` returns 200
- SSH alias `beaconhs-drill` works (BatchMode)
- Running containers:
  - `beaconhs-phase-aj-web-1` — `beaconhs:phase-bp-20261018-095008`
  - `beaconhs-phase-aj-worker-1` — `beaconhs:phase-bp-20261018-095008`
  - `beaconhs-phase-aj-collabora-1` — `4e983196eb98`
  - `beaconhs-phase-aj-postgres-1` — `postgres:16-alpine`
- Web binds `127.0.0.1:3010 → 3000`

## 4. Images on host

- `beaconhs:phase-bu-20261018-131209` — `sha256:23dae17b12ae…` — 2.87 GB
  (contains PDF upload check + viewer watchdog — verified by extracting files)
- `beaconhs:phase-bp-20261018-095008` — `sha256:474ccda68ed4…` (running)
- `beaconhs:phase-bp-20261018-091505` — `9ff3ca786e68` (older rollback target)

## 5. Deployment configuration status

- Original `phase-aj-compose-final.yaml`: **missing** (removed by Phase BU rsync `--delete`)
- Candidate `phase-aj-compose-candidate.yaml`: exists, parses, env mapping unverified → **BLOCKED**
- No deployment performed. No containers, volumes, or networks changed.

## 6. Known defects (unchanged)

D1–D6 remain on record. Not touched.

## 7. Quality gates (verified in Phase BU/CA, code unchanged)

All six pass: format 0, typecheck 0, lint 0, test 0 (2033 passed, 8 skipped), deadcode 0, build 0.
