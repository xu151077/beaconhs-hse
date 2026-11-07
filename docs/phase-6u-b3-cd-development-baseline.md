# Phase CD — Development Baseline

Date: 2026-10-18

## 1. Git and working tree

- Repository: `/home/test/projects/beaconhs-hse`
- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Working tree: 339 modified/untracked files (pre-existing HSE work + Phase BU/BV/BW/BX/BZ/CA/CB changes)
- No commits, no pushes performed during this phase

## 2. PDF fix code present

- `apps/web/src/components/pdf-viewer.tsx` — watchdog + destroy on cleanup
- `apps/web/src/lib/pdf-preview-policy.ts` — timeout constant + watchdog helper
- `apps/web/src/lib/upload-policy.ts` — `uploadedFileTailError`, `isPdfUpload`, `PDF_TRAILER_WINDOW_BYTES`
- `apps/web/src/lib/uploads.ts` — bounded tail read + check in finalize
- Tests: `upload-policy.test.ts` (8), `pdf-preview-policy.test.ts` (3)

## 3. Build resources

- `Dockerfile` — multi-stage build, Node 24, pnpm 10.30.3
- Server actions key: `.docker/secret/next_server_actions_key` (65 bytes)
- Build args: `DEPLOYMENT_VERSION` (40-hex commit SHA)
- `.dockerignore` — excludes `.git`, `node_modules`, `.next`, `.env`, `packages/etl`

## 4. Quality gates (from Phase BU/CA, code unchanged)

All six pass: format 0, typecheck 0, lint 0, test 0 (2033 passed, 8 skipped), deadcode 0, build 0.

## 5. Test environment (from Phase CB)

- HTTPS: `https://beaconhs-test.xuhaoqing.top` → `/login` returns 200
- Running containers: web-1, worker-1 on `beaconhs:phase-bp-20261018-095008`
- Base services: postgres-1, redis-1, minio-1, mailpit-1, collabora-1 (all healthy)
- Network: `beaconhs-phase-aj_default`
- Volumes: `beaconhs-phase-aj_postgres-data`, `beaconhs-phase-aj_redis-data`, `beaconhs-phase-aj_minio-data`

## 6. Phase CD image build

- Building new image from current working tree
- Tag: `beaconhs:phase-cd-<timestamp>`
- Build started: 2026-10-18
- Build resource: `.docker/secret/next_server_actions_key` (BuildKit secret mount)
