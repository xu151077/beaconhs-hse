# Phase CB — Deployment Report

Date: 2026-10-18

## 1. Deployment result

**NOT deployed.** The deployment configuration could not be safely recovered (see `phase-6u-b3-cb-env-mapping.md`).

- Running image (unchanged): `beaconhs:phase-bp-20261018-095008` (`sha256:474ccda68ed4…`)
- Ready image (not deployed): `beaconhs:phase-bu-20261018-131209` (`sha256:23dae17b12ae…`)
- Test env health: `https://beaconhs-test.xuhaoqing.top/login` → 200
- No database migration run. No volumes, networks, or containers changed.

## 2. Image audit

- Built image contains PDF upload check (`incomplete or damaged` in server SSR bundle)
- Built image contains viewer watchdog (`Could not load the PDF` in client bundle)
- Verified by extracting files from image without running it
- Image created: 2026-10-18. Build source: this working tree, `DEPLOYMENT_VERSION=51a899b7…`

## 3. Quality gates

All six gates pass on the fixed code (from Phase BU/CA, code unchanged this phase):

| Gate                  | Result                     |
| --------------------- | -------------------------- |
| `pnpm format:check`   | 0                          |
| `pnpm typecheck`      | 0                          |
| `pnpm lint`           | 0                          |
| `pnpm test`           | 0 (2033 passed, 8 skipped) |
| `pnpm deadcode:check` | 0                          |
| `pnpm build`          | 0                          |

## 4. Rollback

No change was made. Rollback target `beaconhs:phase-bp-20261018-095008` (`474ccda68ed4`) is untouched. New image ready for deploy once compose config is recovered.
