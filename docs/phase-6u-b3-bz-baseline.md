# Phase BZ — Baseline

Date: 2026-10-18
Phase: BZ (deployment config recovery + PDF fix rollout + acceptance)

## 1. Git and working tree

- Repository: `/home/test/projects/beaconhs-hse`
- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Expected baseline HEAD matches.
- Working tree: heavily modified (pre-existing HSE work + Phase BU/BV/BW/BX changes).
  No commits, no pushes performed during this phase.

## 2. Code state (PDF fix)

- `apps/web/src/components/pdf-viewer.tsx` — watchdog + destroy on cleanup.
- `apps/web/src/lib/pdf-preview-policy.ts` — new (timeout constant + watchdog helper).
- `apps/web/src/lib/upload-policy.ts` — `uploadedFileTailError`, `isPdfUpload`, `PDF_TRAILER_WINDOW_BYTES`.
- `apps/web/src/lib/uploads.ts` — bounded tail read + check in finalize.
- `apps/web/src/lib/manual/content/knowledge-assets.ts` — completeness note.
- `docs/project-development-state.md` — Phase BU addendum.
- `docs/phase-6u-b3-bu-pdf-viewer-report.md` — Phase BU report.
- `docs/phase-6u-b3-bv-pdf-deployment-report.md` — Phase BV/BW/BX report.
- `docs/phase-6u-b3-bx-compose-review.md` — compose review (BLOCKED).
- i18n catalogue: `ProviderSettings` namespace (en/fr/es/zh), 28 manual-article
  bodies, multipart/prose/heading strings, `= computed` translations.

## 3. Test environment

- HTTPS: `https://beaconhs-test.xuhaoqing.top` → `/login` returns 200.
- SSH alias `beaconhs-drill` works (BatchMode).
- Running containers: `beaconhs-phase-aj-web-1`, `beaconhs-phase-aj-worker-1`
  (plus postgres, redis, minio, mailpit, collabora).
- Running image: `beaconhs:phase-bp-20261018-095008` (`474ccda68ed4`).
- Web binds `127.0.0.1:3010 → 3000`.

## 4. Images on host

- `beaconhs:phase-bu-20261018-131209` — `sha256:23dae17b12ae…` — 2.87 GB
  (contains the PDF upload check and viewer watchdog — verified by extracting
  files from the image).
- `beaconhs:phase-bp-20261018-095008` — `sha256:474ccda68ed4…` (running).
- `beaconhs:phase-bp-20261017-111136` — `8d0e44b998bb` (older rollback target).

## 5. Deployment configuration status

- Original `phase-aj-compose-final.yaml`: **missing** (removed by Phase BU rsync
  `--delete`). No backup found on the host or anywhere accessible.
- Candidate `phase-aj-compose-candidate.yaml`: exists, parses, but env mapping
  unverified → **BLOCKED** (see Phase BX report).
- No deployment performed. No containers, volumes, or networks changed.

## 6. Known defects (unchanged)

D1–D6 remain on record (see `docs/hse-development-baseline.md` §21). Not touched.

## 7. Quality gates (verified this phase)

All six pass: format 0, typecheck 0, lint 0, test 0 (2033 passed, 8 skipped),
deadcode 0, build 0. See `docs/phase-6u-b3-bv-pdf-deployment-report.md` §5.
