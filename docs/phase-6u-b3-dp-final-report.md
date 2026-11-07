# Phase 6U-B3-DP — Final report

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Summary

Eight controlled attempts ran. **CPU throttling worked and escalates cleanly**; at 20× the host page reached the browser-side leg of the backpressure predicate for the first time (34 % main-thread busy) — and the frozen re-open **still passed, twice**. The server-side stall leg never appeared. So DP establishes a useful negative: **a starved renderer is not sufficient to reproduce the DK failure.** Root cause remains **FAIL/BLOCKED**.

## 2. Results

| Item                                                     | Status                | Evidence                                                                            |
| -------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `Emulation.setCPUThrottlingRate` available and effective | PASS                  | local self-test: same work 1 ms → 2 ms (4×) → 4 ms (10×) → 0–1 ms after reset       |
| Throttling measurement method                            | PASS                  | fixed-work benchmark; the first interval-based benchmark was wrong and was replaced |
| Failure capture under throttling                         | PASS (local)          | thrown `goto` at 10× still produced CDP events + readable trace                     |
| Group A controls                                         | PASS                  | 2/2, 632–667 ms                                                                     |
| Group B occlusion                                        | **CONDITION INVALID** | Headless Chromium kept the page `visible`; no occlusion occurred                    |
| Group C throttling dose-response                         | PASS                  | 0.25 → 0.30–0.51 → 0.81–1.13 → **1.69–1.72** s per 5 s                              |
| Predicate: browser leg                                   | PARTIAL               | met at 20× (legs 1 and 3)                                                           |
| Predicate: server stall leg                              | **NEVER MET**         | 0 stall lines in all 8 windows                                                      |
| Effective frozen attempts                                | PASS                  | 4 (A1, A2, C3, C4), all completed correctly                                         |
| DK failure reproduced                                    | **NOT REPRODUCED**    | 0 of 4                                                                              |
| Root cause                                               | **BLOCKED**           | no failing run                                                                      |

## 3. The key finding

At 20× throttling — 34 % of the main thread busy, 6.8× the baseline — the frozen page still returned, rendered the refusal panel and left no editor frame (779 ms and 691 ms). This is a real boundary: **browser-side CPU starvation alone does not produce the hang.** DK's failure must therefore depend on something else that DP did not recreate — most plausibly the server-side stall (21 lines in DK, zero here), or a factor neither DL/DM/DN/DO/DP touched.

## 4. Honest classification

| Class                     | Records                                                      |
| ------------------------- | ------------------------------------------------------------ |
| Product failure           | none                                                         |
| Infrastructure abort      | none this phase                                              |
| Condition not established | dpB1, dpB2 (occlusion invalid), dpC1, dpC2 (below threshold) |
| Effective attempt, passed | dpA1, dpA2, dpC3, dpC4                                       |
| Unproven                  | cause of the DK hang                                         |

A harness defect was found and fixed mid-phase: the first throttling self-test compared `setInterval`-driven `TaskDuration` and reported 4× as _faster_ than 1×. The benchmark — not the throttling — was wrong; it was replaced with a fixed-work measurement before any remote run.

## 5. What remains blocked

- **Server-side backpressure** cannot be induced from the test browser. Reaching it needs either a Collabora-side condition (kit load, paused kit) or an environment where the tile queue can be starved deliberately — both outside "test-only" scope.
- **Occlusion** as a condition is unavailable in Headless Chromium; a headed browser or a CDP `Page.setWebLifecycleState` experiment would be the way to test it, and that is a different harness.

## 6. Next options (each needs its own decision)

| Option                                                                                                                      | Blocking need                       |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Headed browser with a genuinely backgrounded tab (or `Emulation.setIdleOverride` / `Page.setWebLifecycleState('frozen')`)   | new harness, no remote change       |
| Local mirror with Collabora at `information` + kit control, to create real server stalls                                    | approval for local containers       |
| Accept the intermittent failure as a known risk with a documented mitigation (frozen page is reachable via a direct reload) | product decision, not an experiment |

The first is cheap and closes the gap DP exposed: **nothing has yet produced the server-side stall**, and every attempt to reach it from the browser has failed.

## 7. Files changed

- `docs/phase-6u-b3-dp-browser-throttling.md` (new)
- `docs/phase-6u-b3-dp-backpressure-results.md` (new)
- `docs/phase-6u-b3-dp-race-reproduction.md` (new)
- `docs/phase-6u-b3-dp-final-report.md` (new)
- `docs/phase-6u-b3-cv-release-readiness.md` (updated)
- Temporary specs `phase-dp-race`, `phase-dp-selftest`, `phase-dp-selftest2` — created and deleted.

## 8. Remote side effects

- No container, network, volume, log-level or configuration change.
- Only the production freeze state machine was driven (ACTIVE → FROZEN → ACTIVE), ending at **ACTIVE, version 360**.
- CPU throttling applied only to the local test browser, reset after every run.
- No temporary containers, listeners or processes remain; `apps/web/test-results/` holds only `.last-run.json`.

## 9. Git

Branch `hse-platform`, HEAD `51a899b7aac0a942da327222a3eed355fca9798a`, 0 staged, no commit/push/deploy. All pre-existing modifications and untracked files preserved.

## 10. Release status

**Still blocked** by the unexplained phase-aj frozen-navigation failure. DP removes one more hypothesis (browser CPU starvation) rather than adding a fix, and no code change is justified by the evidence.
