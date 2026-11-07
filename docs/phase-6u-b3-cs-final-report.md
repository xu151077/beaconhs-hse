# Phase 6U-B3-CS — Final report

Date: 2026-10-19
Repository: `/home/test/projects/beaconhs-hse`
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Remote test stack: `beaconhs-phase-aj` (domain `https://beaconhs-test.xuhaoqing.top`)
Drill stack: `beaconhs-drill-20261009` (inventoried only)

Status: **Phase CS complete. All six quality gates pass on a fresh run. The two
Phase CR gate failures were fixed at their source. The drill stack was verified
as isolated but schema-drifted and still erroring; nothing was stopped or
deleted. Scheduler registration detection and recovery were implemented and
tested against a disposable Redis, but the new code was not deployed to the test
stack. No commit, push, reset, clean or remote data change was made.**

## 1. Result by phase

| Phase | Area                               | Result                               | Summary                                                                                                                 |
| ----- | ---------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| A     | Baseline                           | PASS                                 | Read the Phase CR reports; HEAD/worktree/stack recorded.                                                                |
| B1    | `deployment-version-skew-contract` | PASS                                 | Real contract regression from the working-tree placeholder; restored the secret mount and added a regression assertion. |
| B2    | `deadcode:check`                   | PASS                                 | Narrow root `.tmp-*` ignore plus a real root `test:e2e` consumer for `@playwright/test`; no files/dependency deleted.   |
| C     | Drill isolation                    | PASS (inventory only)                | Separate network/volumes/database/ports; shared `APP_URL`; drill DB five migrations behind; no stop/delete.             |
| D     | Scheduler reliability              | PASS for code/test; **NOT DEPLOYED** | Exact registry inspector, scheduler read-back, `--check`, worker health detector; idempotent recovery verified.         |
| E     | Quality gates                      | PASS                                 | format, lint, typecheck, test, deadcode and build all exit 0.                                                           |
| F     | Reports                            | PASS                                 | Four CS reports written and format-checked.                                                                             |

## 2. Baseline and safety

- Branch `hse-platform`; HEAD `51a899b7aac0a942da327222a3eed355fca9798a`.
- Baseline worktree: **119** tracked modifications, **615** untracked files
  (`-uall`), **0** staged.
- The remote phase-aj stack, image `60dc4841…`, and the drill stack were
  inspected read-only. No drill container, image, volume, network or database was
  stopped, recreated or deleted.
- No production or C2 resource was touched. No `.env`, SSH key or auth
  configuration was edited.
- The disposable local Redis used for scheduler tests (`cs-scheduler-redis`,
  `127.0.0.1:6399`) was stopped and removed. The local development services were
  not touched.
- No `git add`, commit, push, reset, clean or restore was performed.

## 3. B1 — version-skew contract

### Cause

The test is a genuine deployment contract. The uncommitted working-tree
`Dockerfile` had replaced the BuildKit required secret mount with
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="placeholder-key"`. That key is not stable
across builds, so Server Actions rendered immediately before a rollout could not
be decrypted by the replacement image. The deploy workflow still supplied the
real secret.

### Fix

The ops build targets added by the user were preserved. Only the protected
command was restored:

```dockerfile
RUN --mount=type=secret,id=next_server_actions_key,required=true \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_server_actions_key)" \
    pnpm turbo run build --filter=@beaconhs/web --filter=@beaconhs/worker \
        --filter=@beaconhs/ops-bootstrap-admin --filter=@beaconhs/ops-migrate
```

The contract test gained one negative assertion:

```ts
expect(dockerfile).not.toContain('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="placeholder-key"')
```

No positive assertion or security requirement was removed.

### Verification

```text
$ pnpm --filter @beaconhs/web exec vitest run src/lib/deployment-version-skew-contract.test.ts
Test Files  1 passed (1)
     Tests  2 passed (2)
EXIT=0
```

A real Docker image build with the BuildKit secret was **not run**; the full
`pnpm build` gate builds the application, not the Docker image.

## 4. B2 — dead code

### Cause

`knip` reported 35 untracked `.tmp-*` operator scratch scripts and the root
`@playwright/test` devDependency. The scratch scripts are not shipped code. The
root Playwright dependency had no root consumer, while `apps/web` already
declared and used the same package for its E2E suite.

### Fix

- `knip.ts` root workspace now ignores exactly `.tmp-*/**`.
- `package.json` now has a real root consumer:
  `"test:e2e": "playwright test --config apps/web/playwright.config.ts"`.
- A new contract test (`apps/web/src/lib/deadcode-scope-contract.test.ts`)
  asserts the ignore is exactly `.tmp-*/**`, no broader pattern was added, and
  the Playwright dependency is still genuinely declared and imported.
- No `.tmp-*` file was deleted. No dependency was removed.

```text
$ pnpm deadcode:check
EXIT=0
```

## 5. Drill stack

The drill stack is isolated by Compose project, network, volumes, database and
ports. Its web is on `127.0.0.1:3001`; phase-aj web is on `3010`. Its web/worker
tag resolves to the same `60dc4841…` image as phase-aj, while its scheduler and
storage-init still reference the older `49d64ba0…` image.

The drill database has **45** migrations; phase-aj has **50**. Drill is missing
0046–0050. `attachment_upload_reservations.multipart_upload_id` exists in
phase-aj and is absent in drill. The worker is still executing the 13 scheduled
ticks and failed upload reconciliation **45 times in 15 minutes**; the
`scheduled` failed set was **1,722** jobs at inspection. Phase-aj had **0**
corresponding errors.

Both stacks use the same `APP_URL`, `BETTER_AUTH_URL` and trusted origin. The
drill login CSP names the phase-aj origin. Drill Mailpit has 0 messages and no
clients were observed on 3001, so no wrong delivery was observed; the link,
callback, QR and email risk is latent but high. Drill also points
`COLLABORA_URL`/`R2_ENDPOINT` at `127.0.0.1:3002`, where nothing listens.

No drill resource was stopped, modified or deleted. See
`phase-6u-b3-cs-drill-isolation.md` for the options and the exact reversible
commands.

## 6. Scheduler reliability

The scheduler is a one-shot registrar: register 13 repeatable jobs, exit 0. The
live phase-aj container is `exited 0`, `restart=on-failure:5`, image `60dc4841…`,
and Redis contains 13 repeat members with 0 duplicates.

Phase CS added:

- exact comparison of expected vs actual repeat keys, names and patterns;
- `missing`, `unexpected`, `duplicates` and `mismatched` reporting;
- scheduler read-back: it now exits 1 instead of silently exiting 0 on a
  partial/mismatched registration;
- a read-only `scheduler.js --check` JSON probe with exit 0/1;
- a worker health check that reports the same mismatch as unhealthiness;
- unit tests for exact/missing/extra/mismatch/duplicate states.

Disposable Redis evidence:

```text
first registration   13/13 ok
repeat registration  13/13 ok, 0 duplicates
simulated loss       0/13, ok=false
recovery             13/13 ok
extra schedule       detected, then removed
mismatched pattern   detected, then repaired
```

Recovery is a scheduler rerun; it is idempotent. The new code is **not deployed**
to phase-aj. The live scheduler still runs the old two-line image, and the
ad-hoc test Compose file has no worker healthcheck. See
`phase-6u-b3-cs-scheduler-reliability.md`.

## 7. Fresh quality gates

| Gate      | Command                | Exit | Result | Log                                        |
| --------- | ---------------------- | ---: | ------ | ------------------------------------------ |
| Format    | `pnpm format:check`    |    0 | PASS   | `/tmp/opencode/phase-cs/format.log`        |
| Lint      | `pnpm lint`            |    0 | PASS   | `/tmp/opencode/phase-cs/lint.log`          |
| Typecheck | `pnpm typecheck`       |    0 | PASS   | `/tmp/opencode/phase-cs/typecheck.log`     |
| Test      | `pnpm test --continue` |    0 | PASS   | `/tmp/opencode/phase-cs/test-continue.log` |
| Dead code | `pnpm deadcode:check`  |    0 | PASS   | `/tmp/opencode/phase-cs/deadcode.log`      |
| Build     | `pnpm build`           |    0 | PASS   | `/tmp/opencode/phase-cs/build.log`         |

Test totals:

```text
Tasks: 25 successful, 25 total
@beaconhs/web: Test Files 238 passed | 2 skipped (240)
@beaconhs/web:      Tests 2035 passed | 8 skipped (2043)
@beaconhs/jobs:     20 passed
```

The web total is two tests higher than Phase CR because the new dead-code scope
contract file adds two tests. The deployment contract file still has two tests;
the new negative assertion runs inside the existing second test.

## 8. Changes made

### Repository

| File                                                        | Change                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Dockerfile`                                                | Restored the required BuildKit secret mount; preserved the ops CLI build/deploy targets. |
| `apps/web/src/lib/deployment-version-skew-contract.test.ts` | Added the placeholder-key regression assertion.                                          |
| `knip.ts`                                                   | Added the root `.tmp-*/**` ignore (scoped and commented).                                |
| `package.json`                                              | Added root `test:e2e`, giving the retained `@playwright/test` a real consumer.           |
| `apps/web/src/lib/deadcode-scope-contract.test.ts`          | New test pinning the ignore scope and Playwright usage.                                  |
| `packages/jobs/src/queues/scheduled.ts`                     | Added `inspectRepeatableSchedules` / `inspectScheduledRegistration`.                     |
| `packages/jobs/src/lazy-runtime.test.ts`                    | Added detection tests; retained the existing reconciliation tests.                       |
| `apps/worker/src/scheduler.ts`                              | Added read-back verification and `--check`.                                              |
| `apps/worker/src/health.ts`                                 | Added exact registry check and connection cleanup.                                       |
| `deploy/dokploy-dev.compose.yaml`                           | Added bounded `max_attempts: 5` to the existing on-failure scheduler policy.             |

The tracked file already contained other uncommitted user changes; those were
preserved. `deploy/local-production.compose.yaml` is untracked in this checkout
and was left unchanged after inspection.

### Remote host

No change in Phase CS. The scheduler policy change on the phase-aj test stack was
made in Phase CR and remains in place. No drill resource was modified.

## 9. New defects, pre-existing issues and test-environment issues

### New defects introduced by CS

None known. All six gates pass. The new worker health dependency is a deliberate
behavior change, not a defect: a worker with a missing registry is now unhealthy.

### Pre-existing workspace issues

- 119 tracked files were already modified before CS; the worktree remains
  uncommitted. Three additional tracked files were modified by CS (health,
  scheduler and the deployment contract test).
- 35 `.tmp-*` scratch scripts remain on disk and are ignored only under
  `.tmp-*`.
- The root `@playwright/test` duplicate remains, now used by `test:e2e`.
- The Dockerfile ops CLI targets remain; only the secret mount was restored.
- The untracked drill build helpers
  (`scripts/build-drill-image.sh`, `scripts/deploy-drill-freeze-driver.sh`) do
  not pass `--secret`; they will fail against the restored required mount if
  used.
- The untracked `deploy/local-production.compose.yaml` still has
  `restart: 'no'` for the scheduler; it was not edited in CS.

### Test-environment issues

- The ad-hoc phase-aj test Compose file has no worker healthcheck, so the new
  worker registry detector is not active there.
- The drill stack has schema drift, a growing failed-job set and a shared public
  identity.
- The live phase-aj scheduler/worker run the old image and do not include the new
  detection code.

## 10. Fixed, blocked and not run

### Fixed

- `deployment-version-skew-contract` test failure.
- `deadcode:check` failure.
- Scheduler silent-success gap in code (read-back and probe).
- No worker-side visibility into a missing repeat registry (health check).

### BLOCKED

| Item                                             | Reason                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Stop/repair drill stack                          | Requires explicit owner approval; no resources were touched.                                        |
| Deploy new scheduler/health code to phase-aj     | Requires a new image build and deploy approval; Phase CS is uncommitted.                            |
| Real Docker image build with the BuildKit secret | Not part of the six local gates; requires the deployment build path.                                |
| PDF preview limit change                         | Product decision; Phase CR recommended a preflight/oversize message, not a blind watchdog increase. |
| SSH root cause                                   | Remains UNKNOWN from Phase CR; no new evidence in CS.                                               |

### NOT RUN

- Drill stop, restart, migration repair or deletion.
- Phase-aj image rebuild or scheduler/worker recreate.
- E2E Playwright suite (`pnpm test:e2e`); the script exists but was not executed
  against the remote stack.
- External cron/monitoring wiring for `scheduler.js --check`.
- Any commit or push.

## 11. Final Git state

After the four CS reports were written and formatted:

```text
HEAD: 51a899b7aac0a942da327222a3eed355fca9798a
Branch: hse-platform
Tracked modified: 122
Untracked files (-uall): 620
Staged: 0
```

The increase from the CS baseline is:

- +3 tracked modified files (`apps/worker/src/health.ts`,
  `apps/worker/src/scheduler.ts`,
  `apps/web/src/lib/deployment-version-skew-contract.test.ts`);
- +5 untracked files (the new dead-code scope test and four CS reports).

No pre-existing modification was reverted or overwritten. `docs/project-development-state.md`
was not edited.

## 12. Reviewer checklist

1. **Gates:** run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
   `pnpm test --continue`, `pnpm deadcode:check`, `pnpm build`; all must exit 0.
2. **Contract:** `pnpm --filter @beaconhs/web exec vitest run
src/lib/deployment-version-skew-contract.test.ts` passes 2/2 and the
   Dockerfile contains the required secret mount, not `placeholder-key`.
3. **Dead code:** `pnpm deadcode:check` exits 0; `knip.ts` ignores only
   `.tmp-*/**`; `package.json` has `test:e2e`; no scratch file was deleted.
4. **Scheduler code:** `pnpm --filter @beaconhs/jobs test` passes 20/20; the new
   detection test covers missing, extra, mismatch and duplicate states.
5. **Scheduler behavior (after an approved deploy):**
   `node apps/worker/dist/scheduler.js --check` prints `ok:true` and exits 0;
   deleting `bull:scheduled:repeat` makes it exit 1; rerunning the scheduler
   restores 13/13 without duplicates.
6. **Worker health (after an approved deploy):**
   `node apps/worker/dist/health.js` exits 0 with 13 schedules and exits 1 with a
   `[health] scheduled repeat registry mismatch` log after loss.
7. **Drill stack:** confirm all containers are still present; no volume, image or
   network was deleted; the worker still shows the documented reconciliation
   errors until the owner approves a stop or repair.
8. **Worktree:** HEAD is `51a899b7`; `git status` shows 122 modified and 620
   untracked files, 0 staged; no commit or push exists.
