# Phase 6U-B3-DO — Final report

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Summary

Six attempts ran: two controls passed cleanly, and the four backpressure attempts **never met the declared precondition**, so none of them froze. The test therefore did exactly what it was designed to do — refuse to manufacture the condition — and the answer is that **DK's precondition cannot be produced by simply opening the editor and waiting**. The root cause remains **FAIL/BLOCKED**.

## 2. Results

| Item                                      | Status                   | Evidence                                                                    |
| ----------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| DK/DN precondition comparison             | PASS                     | only differentiator: DK had 21 tile stalls + a 158 s socket before freezing |
| Backpressure predicate defined in advance | PASS                     | `TaskDuration` ≥ 1.5 s / 5 s + stall log line + open socket                 |
| Group A controls                          | PASS                     | 2/2, nav 611–615 ms, panel, 0 iframes                                       |
| Group B attempts                          | **PRECONDITION NOT MET** | 4 runs × 90 s of sampling, 0.22–0.45 s growth (4–9 % busy), 0 stall lines   |
| Product failures                          | none                     | all 6 runs exit 0                                                           |
| Root cause                                | **BLOCKED**              | condition not reproduced                                                    |
| Local mirror / renderer probing           | NOT RUN                  | assessment only; no container created (unchanged from DN)                   |

## 3. What DO proved

1. Under an ordinary editor session there is **no tile backpressure** on phase-aj, measured on both sides: the browser main thread is 4–9 % busy, and Collabora logs zero stalls across four 90-second sessions.
2. The frozen re-open is correct whenever the editor is settled — now **12/12** across DN and DO (606–727 ms).
3. The measurement harness itself is sound: values were stable across 72 samples and the predicate was applied without adjustment after seeing results.

## 4. What DO did not prove

- That backpressure, if present, would cause the DK hang. The condition was never reached.
- Any causal link between tile stalls and the failed navigation. That remains a hypothesis with correlational support only.

## 5. Infrastructure notes (disclosed)

- Two typecheck errors in the temporary spec were caught **before** the batch ran; an earlier batch launch was stopped after ~1 second and never reached a run, with the tenant verified still ACTIVE (v330).
- No shell timeout killed a run this phase: the batch was launched with `nohup` and polled, so every attempt finished its own restore.
- The temporary spec was deleted; `apps/web/test-results/` holds only `.last-run.json`.

## 6. Next hypotheses (each needs a different observation)

| Hypothesis                                                                      | How to test it                                                                           | Blocking need              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| DK's stall required an **unfocused/backgrounded or occluded** tab               | run the editor in a second, unfocused page; measure `TaskDuration` and tiles             | none (test-only)           |
| The stall requires a **slow client**, not a busy one                            | throttle the page's CPU (CDP `Emulation.setCPUThrottlingRate`) and watch for stall lines | none (test-only)           |
| The stall was a **server-side** condition (kit busy / memory), not browser-side | local mirror with Collabora at `information`, plus kit/`docbroker` inspection            | approval: local containers |
| DK's `load` failure was unrelated to tiles entirely                             | renderer health + `Page.frameStoppedLoading` on a reproduced hang                        | a failing run              |

The first two are **test-only** and would be the cheapest next step; they do not touch the remote stack.

## 7. Files changed

- `docs/phase-6u-b3-do-dk-precondition-analysis.md` (new)
- `docs/phase-6u-b3-do-backpressure-observability.md` (new)
- `docs/phase-6u-b3-do-race-reproduction.md` (new)
- `docs/phase-6u-b3-do-final-report.md` (new)
- `docs/phase-6u-b3-cv-release-readiness.md` (updated)
- Temporary `apps/web/e2e/phase-do-race.spec.ts` — created and deleted.

## 8. Git / environment

- Branch `hse-platform`, HEAD `51a899b7aac0a942da327222a3eed355fca9798a`, 0 staged, no commit/push/deploy.
- All pre-existing modifications and untracked files preserved.
- No container, network, volume, log-level or configuration change; no temporary containers, listeners or processes remain.
- Final freeze state: **ACTIVE, version 340**. phase-aj 7 containers, drill 7 containers, both untouched.

## 9. Release status

**Still blocked** by the unexplained phase-aj frozen-navigation failure. DO removed one hypothesis (ordinary editor sessions do not produce backpressure) but did not explain the failure; no code change is justified.
