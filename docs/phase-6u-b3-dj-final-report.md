# Phase 6U-B3-DJ — Final report

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Summary

- **Trace retention fixed**: the config no longer uses `on-first-retry` (which produced no trace locally, ever). A real ACTIVE → blocking → ACTIVE run now leaves a verifiable trace.
- **Scenario 4**: a full local request-level trace exists and shows the blocking navigation completing in 1.09 s with **0 WOPI calls**. The phase-aj hang is still not reproduced, so the root cause remains **FAIL/BLOCKED**.
- **Docbroker observability**: explained precisely why it cannot be read (no shell, no volume, no DB file, file logging disabled) and specified the three approval-gated ways to capture it.
- **Deployment key gate**: the gate exists and is pinned by contract tests, but the workflow does not call it. Recorded as PARTIAL, not PASS.

## 2. Results

| Item                           | Status            | Notes                                                                   |
| ------------------------------ | ----------------- | ----------------------------------------------------------------------- |
| Trace retention policy         | PASS              | `retain-on-failure` default + targeted `trace: 'on'`; contract test 3/3 |
| Trace produced and readable    | PASS              | 3,263,652 bytes, SHA-256 `e4ecb5e3…`, `unzip -t` clean                  |
| Local Scenario 4 evidence      | PASS (local only) | 7 requests, all 200; 0 WOPI calls; DRAINING panel rendered              |
| phase-aj Scenario 4 root cause | FAIL / BLOCKED    | still not reproducible locally                                          |
| Docbroker session record       | BLOCKED           | image has no shell/volume/DB; file logging disabled                     |
| Deployment key gate            | PARTIAL           | gate + contract tests pass; workflow does not invoke it                 |
| File authorization matrix      | PASS (historical) | Phase CX 7/7, not re-run                                                |
| Drill                          | BLOCKED           | untouched                                                               |

## 3. Quality gates (this phase, after the code changes)

| Gate                                                 |                       Exit code |
| ---------------------------------------------------- | ------------------------------: |
| `pnpm format:check`                                  |                               0 |
| `TURBO_FORCE=true pnpm lint`                         |                               0 |
| `TURBO_FORCE=true pnpm typecheck`                    |                               0 |
| `TURBO_FORCE=true pnpm test --continue`              | 0 (web 2061 passed / 8 skipped) |
| `pnpm deadcode:check`                                |                               0 |
| `TURBO_FORCE=true pnpm build`                        |                               0 |
| targeted trace-contract + deployment-contract vitest |                0 (3 + 5 passed) |

## 4. Files changed this phase

- `apps/web/playwright.config.ts` (modified — retention policy, `E2E_BASE_URL`)
- `apps/web/src/lib/e2e-trace-retention-contract.test.ts` (new)
- `apps/web/src/lib/server-action-key-deployment-contract.test.ts` (new)
- `docs/phase-6u-b3-dj-*.md` (5 new reports)
- `docs/phase-6u-b3-cv-release-readiness.md` (updated)

Temporary: `apps/web/e2e/phase-dj-scenario4-local.spec.ts` was created for the evidence run and deleted afterwards; the trace was moved to `/tmp/opencode/phase-dj/evidence/` and the repo-local copy (which contained the session cookie) was deleted.

## 5. Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`  
Branch: `hse-platform`  
No commit, push, deploy, reset, clean, restore, or checkout. 0 staged files; all pre-existing modifications and untracked files preserved.

## 6. Release status

Still blocked by the unproven phase-aj WOPI navigation failure. The evidence-retention gap that made it un-analysable is now closed; the remaining step is running the suite against phase-aj with the new config (or a temporary diagnostic Collabora container), both of which need approval.
