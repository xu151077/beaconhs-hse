# Phase 6U-B3-DP — Race reproduction

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Attempts

Eight attempts, serial, each preceded by an ACTIVE check and followed by a verified restore.

| #    | Condition          | Froze | Frozen re-open               | Result                    |
| ---- | ------------------ | ----- | ---------------------------- | ------------------------- |
| dpA1 | control            | yes   | 667 ms, panel, 0 iframes     | pass                      |
| dpA2 | control            | yes   | 632 ms, panel, 0 iframes     | pass                      |
| dpB1 | second tab focused | no    | —                            | condition not established |
| dpB2 | second tab focused | no    | —                            | condition not established |
| dpC1 | CPU 4×             | no    | —                            | condition not established |
| dpC2 | CPU 10×            | no    | —                            | condition not established |
| dpC3 | CPU 20×            | yes   | **779 ms**, panel, 0 iframes | **pass**                  |
| dpC4 | CPU 20×            | yes   | **691 ms**, panel, 0 iframes | **pass**                  |

**Effective frozen attempts: 4** (two controls, two under CPU starvation). **No DK-type hang in any of them.**

## 2. Failure capture (unchanged contract)

Every run used `trace: 'on'` plus a buffered CDP stream attached from `finally`. No run produced a thrown navigation this phase, so the capture path was not exercised on phase-aj — it was exercised locally in the self-tests, where a thrown `goto` under 10× throttling still produced events and a readable trace.

## 3. Freeze and recovery discipline

- Every run started at `state=ACTIVE`.
- `blockWrites()` drove the production state machine; **`FROZEN` was reached in all four freezing runs** — no drain was forced, no write-arm cleared, no database edit.
- The batch driver restored ACTIVE after every run and verified it: final state **`ACTIVE`, version 360**.
- The CPU throttling rate was reset to **1×** after every sampling phase and in `finally`, and each run opened a fresh browser context.

## 4. What the two 20× runs prove

At 20× throttling the host page's main thread spent **34 % of each 5 s window** in tasks (1.69 s and 1.72 s) — the first time in this investigation that the browser-side leg of the backpressure predicate was met. Under that condition:

- the frozen document GET succeeded;
- `load` fired;
- the refusal panel rendered;
- **no editor iframe remained**;
- no WOPI request was made;
- no DK-type hang occurred.

**Therefore: a CPU-starved host page alone does not reproduce the DK failure.**

## 5. What was never reached

The server-side leg — a `client not consuming tiles` line — never appeared, in any group, at any rate. So the exact combination DK exhibited (stalled session + freeze) was never rebuilt. DP can state that browser slowness is insufficient; it cannot state what is sufficient.

## 6. Classification of every attempt

| Class                                            | Runs                   |
| ------------------------------------------------ | ---------------------- |
| Product failure                                  | none                   |
| Effective frozen attempt, passed                 | dpA1, dpA2, dpC3, dpC4 |
| Condition not established (by design, no freeze) | dpB1, dpB2, dpC1, dpC2 |
| Infrastructure abort                             | none this phase        |
| Not reproduced                                   | all                    |

The occlusion group deserves a note: it failed for a _measurement_ reason, not a product one — Headless Chromium reported `visibilityState: 'visible'` while a second tab had focus, so the "occluded tab" condition does not exist in this configuration at all. That is reported as a limitation of the condition, not as evidence about the product.

## 7. Status

**PASS** for four effective frozen attempts and the freeze discipline. **NOT REPRODUCED** for the DK hang. **FAIL/BLOCKED** for root cause.
