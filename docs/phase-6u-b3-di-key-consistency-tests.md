# Phase 6U-B3-DI — Server Action key consistency tests

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## Environment

The real production standalone build produced by this phase's `pnpm build`, started with `apps/web/scripts/start-standalone.mjs` against the local Postgres/Redis/MinIO. Three instances ran concurrently on ports 3100, 3101 and 3102. Only disposable test keys were used; no production key was read, and no key material appears in any log, response, or report.

## Results (executed this phase)

| #   | Scenario                          | Instances                                     | Result                                                                                                                                             |
| --- | --------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Two instances, **same** key       | A (3100), B (3101)                            | Identical fingerprint `8493b8ed4a89d304076d95f8b9a34536`; gate `--expect` exit **0**                                                               |
| 2   | Two instances, **different** keys | A (3100), C (3102)                            | Different fingerprints (`8493b8ed…` vs `150e18e90bc37c38ec8f538fe6d366a8`); gate exit **1** ("fingerprint mismatch")                               |
| 3   | Missing runtime override          | standalone without the variable               | Readiness 200; the instance logs "no runtime override; the effective key is the build-time key embedded in the image" (Phase DH result, unchanged) |
| 4   | Invalid runtime override          | standalone with a non-key value               | Readiness 503 (Phase DH result, unchanged)                                                                                                         |
| 5   | Rotation                          | instance on 3102 restarted with the new key   | New fingerprint `8493b8ed…`; gate exit **0**                                                                                                       |
| 6   | Rollback                          | same instance restarted with the previous key | Fingerprint returns to `150e18e9…`; gate against the new expectation exits **1** — the rollback is detected, not silently accepted                 |
| 7   | Output hygiene                    | script `--print`                              | Prints `fingerprint=<hex>` only; the key string appears **0** times in the output                                                                  |

Automated tests: 20 passed (8 key-contract, 4 CLI, 5 readiness, 3 fingerprint), exit 0 —
`pnpm --filter @beaconhs/web exec vitest run src/lib/server-action-key.test.ts scripts/verify-server-action-key-consistency.test.ts src/app/api/health/ready/route.test.ts`.

## Residual limits

- The application cannot observe its peers, so a mixed fleet is only detected when the deployment gate is run. The gate is executable and blocking, but it is an operator/deployment step.
- A bound-argument Server Action executed end-to-end across two instances with different keys was not completed in this environment, so the _runtime_ failure mode of a mixed fleet is still described from the framework contract, not reproduced here.
- The build-time-only mode has no runtime fingerprint; its invariant is the build/deploy secret pipeline.

## Status

Status: **PASS** for the consistency mechanism, the gate, rotation, rollback, and output hygiene. **NOT RUN** for an end-to-end bound-argument action across mismatched instances.
