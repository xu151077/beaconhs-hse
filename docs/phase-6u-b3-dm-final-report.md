# Phase 6U-B3-DM — Final report

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Summary

Five CDP-instrumented frozen re-opens on phase-aj all completed correctly. **The failure did not reproduce**, and this phase also **retracted a wrong conclusion from Phase DL**: the "lingering Collabora frame" was an artefact of reading the snapshot taken _before_ the failing navigation, not after it. WOPI navigation therefore stays **FAIL/BLOCKED**, but with a cleaner evidence base: the only facts about the DK failure are that the navigation's `load` never resolved and no post-navigation observation exists.

## 2. Results

| Item                             | Status             | Evidence                                                                            |
| -------------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| CDP event availability           | PASS               | all requested events present in Playwright 1.64.1's Chromium protocol               |
| CDP capture implementation       | PASS               | `Page.frame*`, `Page.lifecycleEvent`, `Network.webSocket*` recorded, paths only     |
| Frozen re-open attempts 1–5      | PASS               | 5 valid runs, nav 0.88–1.73 s, panel shown, 0 iframes                               |
| Scenario 4 reproduction          | **NOT REPRODUCED** | 0 of 5                                                                              |
| Phase DL "lingering frame" claim | **RETRACTED**      | the snapshot was pre-navigation; no post-navigation snapshot exists in the DK trace |
| Root cause                       | **BLOCKED**        | no failing run with CDP data                                                        |
| Freeze semantics                 | PASS               | FROZEN reached legally in every run; tenant restored to ACTIVE (version 261)        |
| Evidence retention               | PASS               | 5 traces, ZIP-verified, mode 0700, outside the repo                                 |

## 3. The corrected picture of the DK failure

| Fact                                               | Source                                                  |
| -------------------------------------------------- | ------------------------------------------------------- |
| Frozen `GET /documents/…` returned 200 in 4,140 ms | DK network log                                          |
| Zero WOPI requests                                 | DK network log                                          |
| `load` never resolved                              | DK call log: `Frame.goto` has a `before` and no `after` |
| Frame tree after the navigation                    | **not captured**                                        |
| CDP frame/socket events                            | **not captured**                                        |

Anything beyond that, including the earlier "child frame held the load" reading, is unsupported.

## 4. What five passing runs do show

Every pass: main frame `load` fired while the old Collabora child frame was already detached; each later child was an empty `about:blank` that detached immediately; every WebSocket closed; no frame errors; no socket open at the end. That is the correct lifecycle, and it is now captured with CDP rather than inferred.

## 5. Incident disclosure

Attempt 3 was killed by the operator's own shell timeout mid-test, leaving the tenant in **FROZEN** until it was noticed and repaired (`reconcile` → `release` → ACTIVE, version 246). It is excluded from the evidence matrix, and the subsequent runs used a longer timeout. No remote configuration was changed; only the production freeze state machine was driven.

## 6. Files changed

- `docs/phase-6u-b3-dm-cdp-event-contract.md` (new)
- `docs/phase-6u-b3-dm-frame-websocket-timeline.md` (new)
- `docs/phase-6u-b3-dm-reproduction-results.md` (new)
- `docs/phase-6u-b3-dm-final-report.md` (new)
- `docs/phase-6u-b3-cv-release-readiness.md` (updated)
- Temporary `apps/web/e2e/phase-dm-cdp-frozen.spec.ts` — created for the runs and deleted.

## 7. Git state

HEAD `51a899b7aac0a942da327222a3eed355fca9798a`, branch `hse-platform`, 0 staged, 124 modified, 393 untracked. No commit, push, deploy, reset, clean, restore, or checkout. `apps/web/test-results/` contains only `.last-run.json`.

## 8. Release status

**Still blocked** by the intermittent phase-aj frozen-navigation failure. To make progress, the next attempt must capture a _failing_ run (batch repetition, local mirror, or renderer-health observation), because five passing instrumented runs cannot explain a failure that did not occur.
