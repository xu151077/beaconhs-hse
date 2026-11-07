# Phase 6U-B3-DN — Final report

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Summary

The batch reproduced nothing: **10 of 10 valid phase-aj runs passed**. What the phase did establish is that the _observation harness_ is now trustworthy — it survives a throwing navigation and still emits CDP evidence, and it no longer strands the tenant. Three harness hangs and one operator abort were found, diagnosed from traces, and removed.

WOPI navigation stays **FAIL/BLOCKED**: no failing run, no root cause.

## 2. Results

| Item                                            | Status             | Evidence                                                                       |
| ----------------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| Failure-first capture proven locally            | PASS               | self-test: thrown `goto` still produced a 4,444-byte trace chunk (`ff31dd3c…`) |
| Harness hang #1 (`Tracing.end`, 166 s)          | FIXED              | trace call timeline `dur=166083`                                               |
| Harness hang #2 (240 s, same cause)             | FIXED              | product calls ended at 180,810 ms; teardown at 347,176 ms                      |
| Harness hang #3 (`ensureActive()` in `finally`) | FIXED              | moved to the batch driver                                                      |
| Batch of 10 valid runs                          | PASS               | 606–727 ms each, panel + 0 iframes, balanced loading events, sockets closed    |
| Scenario 4 reproduction                         | **NOT REPRODUCED** | 0 of 10                                                                        |
| Freeze-state discipline                         | PASS               | ACTIVE before each run, restored after each; final ACTIVE v330                 |
| Local mirror assessment                         | PARTIAL            | same Collabora digest confirmed; mirror not built (needs approval)             |
| Renderer health alignment                       | NOT RUN            | requires a failing run to be meaningful                                        |
| Root cause                                      | **BLOCKED**        | no failing run captured                                                        |

## 3. Product vs infrastructure vs not-reproduced

| Class                      | Records                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Product failure            | none in this phase                                                                           |
| Test-infrastructure abort  | run01/01b/01c (harness hangs), run03 (operator shell timeout) — all excluded from the matrix |
| Not reproduced             | 10 valid runs, all passing                                                                   |
| Historical product failure | Phase DK (`Frame.goto` timeout, no post-navigation snapshot) — still unexplained             |

## 4. The honest state of the WOPI evidence

Retained and valid:

- Frozen re-open returns **200** in ~0.6–0.7 s; **zero** WOPI calls; refusal panel renders; no editor frame.
- In DK the navigation's `load` never resolved and **no post-navigation observation exists**.

Retracted and not to be reused:

- "DK failed with two lingering frames." The DL snapshot was taken _before_ the navigation; corrected in Phase DM and again recorded in `docs/phase-6u-b3-dl-frame-lifecycle.md`.

## 5. What would move this forward

| Option                                                                                            | Needs approval?                                       | Yield                                    |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| Nightly batch (e.g. 30–50 runs) with the now-working capture                                      | no remote change, but long runtime                    | catches a low-rate failure with evidence |
| Local mirror with the identical Collabora digest, same-origin proxy and `information` logging     | yes (new local containers)                            | unrestricted docbroker access            |
| Renderer health metrics (`Performance.getMetrics`, `page.on('crash')`) added to the existing spec | no remote change                                      | tests the "renderer stall" hypothesis    |
| Reproduce DK's _precondition_: freeze while the editor session is stalled by tile backpressure    | no remote change, but needs a way to induce the stall | highest chance of matching DK            |

The last option is the most promising, because DK's only anomaly before the freeze was 21 `client not consuming tiles` warnings; the 10 batch runs froze a **settled** editor.

## 6. Files changed

- `docs/phase-6u-b3-dn-capture-on-failure.md` (new)
- `docs/phase-6u-b3-dn-batch-reproduction.md` (new)
- `docs/phase-6u-b3-dn-local-mirror-assessment.md` (new)
- `docs/phase-6u-b3-dn-final-report.md` (new)
- `docs/phase-6u-b3-cv-release-readiness.md` (updated)
- Temporary specs `phase-dn-capture-on-failure.spec.ts` and `phase-dn-selftest.spec.ts` — created and deleted.

## 7. Remote side effects

- No container, network, volume, mount, log level or configuration change.
- Only the production freeze state machine was driven (ACTIVE → FROZEN → ACTIVE), ending at `ACTIVE` version 330.
- Ten test documents created in the isolated test tenant.
- Three unintended non-ACTIVE states occurred during harness debugging (`FROZEN` ×1, `DRAINING` ×1, plus the operator-kill case); all were restored through legal transitions and are disclosed in the batch report.

## 8. Git / environment state

- Branch `hse-platform`, HEAD `51a899b7aac0a942da327222a3eed355fca9798a`, 0 staged, no commit/push/deploy.
- All pre-existing modifications and untracked files preserved; no destructive git command was run.
- No temporary containers, listeners, or background processes remain; `apps/web/test-results/` contains only `.last-run.json`.
- Evidence: 10 traces (6.9–8.2 MB each) plus the self-test chunk, under `/tmp/opencode/phase-dn/…`, mode `0700`, outside the repository.

## 9. Release status

**Still blocked** by the intermittent phase-aj frozen-navigation failure. Ten passes reduce the estimated failure rate but do not explain the one captured failure, and nothing in this phase justifies a code change.
