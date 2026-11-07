# Phase 6U-B3-DJ — Playwright trace retention

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Why Phase CT's failure left no evidence

`apps/web/playwright.config.ts` used `trace: 'on-first-retry'` with `retries: 0` outside CI. A trace is recorded **only for a retry**, so the one-shot WOPI failure produced no trace at all. `video: 'retain-on-failure'` did keep a video, but the next Playwright run rewrote `test-results/`, and by Phase DI only `.last-run.json` remained. Nothing in the config, the reporter, or the run script moved evidence somewhere durable.

## 2. Policy change

`apps/web/playwright.config.ts` now uses:

| Option       | Before                 | After                                    | Reason                                                                                                    |
| ------------ | ---------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `trace`      | `on-first-retry`       | `retain-on-failure`                      | records every run, keeps only failures — a one-shot failure still leaves a trace, passing runs stay cheap |
| `screenshot` | `only-on-failure`      | unchanged                                |                                                                                                           |
| `video`      | `retain-on-failure`    | unchanged                                |                                                                                                           |
| `baseURL`    | hardcoded phase-aj URL | `process.env.E2E_BASE_URL ?? <phase-aj>` | lets the same suite target an isolated local stack, which is what the local capture below needed          |

Targeted suites opt into `trace: 'on'` for the specific investigation (the temporary Scenario 4 capture below did), so both their passing and failing runs are retained.

## 3. Cost, sensitivity, retention

- **Size**: the retained Scenario 4 trace is **3,263,652 bytes** (3.1 MiB) for a ~4-minute run with 104 screencast frames. A `retain-on-failure` default costs nothing on green runs; a `trace: 'on'` investigation costs a few MiB per run.
- **Sensitivity**: traces record request headers. The captured trace contains **168 `Cookie` headers and 1 `Set-Cookie`** (names counted; no values are reproduced here) and **2 occurrences of an `access_token` query parameter** (the Collabora/WOPI pattern). A trace is therefore credential material: it must not be attached to a report, pasted into a ticket, or committed.
- **Retention**: traces land in `apps/web/test-results/`, which `.gitignore` already excludes. They are deleted by the next run unless copied out first. The evidence copy for this phase was moved to `/tmp/opencode/phase-dj/evidence/scenario4-local-trace.zip`, and the repo-local directory was deleted after capture **because it contained the session cookie**.

## 4. Verification (executed this phase)

| Check                                                    | Result                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Trace produced for a real ACTIVE → blocking → ACTIVE run | `trace.zip`, 3,263,652 bytes                                                        |
| Archive readable                                         | `unzip -t` → "No errors detected"                                                   |
| SHA-256                                                  | `e4ecb5e311689938c84813be9f3b24158a45d67521772f80b3a7790ddd1f87f9`                  |
| Timeline attachment inside the trace                     | `attachments/b8aeb3…` contains the correlation timeline (see the Scenario 4 report) |
| Contract test                                            | `apps/web/src/lib/e2e-trace-retention-contract.test.ts` — 3 passed, exit 0          |

## 5. Status

Status: **PASS** for the retention policy and for producing a verifiable trace. The trace is local evidence only; no phase-aj trace exists yet, because capturing one requires running the suite against phase-aj with the new config.
