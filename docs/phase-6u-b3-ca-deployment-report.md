# Phase CA — Deployment Report

Date: 2026-10-18

## 1. Deployment result

**NOT deployed.** The deployment configuration could not be safely recovered
(see `phase-6u-b3-ca-env-recovery.md`). Per the Phase CA rules, no deployment
was attempted.

- Running image (unchanged): `beaconhs:phase-bp-20261018-095008`
  (`sha256:474ccda68ed4…`).
- Ready image (not deployed): `beaconhs:phase-bu-20261018-131209`
  (`sha256:23dae17b12ae…`), built from this working tree.
- Test env health: `https://beaconhs-test.xuhaoqing.top/login` → 200.
- No database migration run. No volumes, networks, or containers changed.

## 2. Image audit

- The built image contains the PDF upload check (`incomplete or damaged` in the
  server SSR bundle) and the viewer watchdog (`Could not load the PDF` in the
  client bundle). Verified by extracting files from the image without running it.
- Image created: 2026-10-18. Build source: this working tree,
  `DEPLOYMENT_VERSION=51a899b7…`.

## 3. Quality gates

All six gates pass on the fixed code (from Phase BU, code unchanged this phase):

| Gate                  | Result                     |
| --------------------- | -------------------------- |
| `pnpm format:check`   | 0                          |
| `pnpm typecheck`      | 0                          |
| `pnpm lint`           | 0                          |
| `pnpm test`           | 0 (2033 passed, 8 skipped) |
| `pnpm deadcode:check` | 0                          |
| `pnpm build`          | 0                          |

No code was modified in Phase CA, so these results carry forward.

## 4. Rollback

No change was made. Rollback target `beaconhs:phase-bp-20261018-095008`
(`474ccda68ed4`) is untouched. New image ready for deploy once the compose
config is recovered. No commits, no pushes, no destructive git operations.
