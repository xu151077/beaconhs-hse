# Phase 6U-B3-DN — Batch reproduction

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Target: `beaconhs-phase-aj` — `sha256:60dc4841…`, Collabora `sha256:4e983196…`, tenant `ea5a149b-ea76-48e0-abbe-fa360f520d8e`

## 1. Result

**10 of 10 valid runs passed.** The failure did not reproduce.

| Run | Time (local) | Outcome | State  |    Nav | `load` | frames | iframes | panel | WS open/close | WS errors | loading pairs | crash | Events |
| --- | ------------ | ------- | ------ | -----: | ------ | -----: | ------- | ----- | ------------- | --------: | ------------- | ----- | -----: |
| 01  | 06:53        | pass    | FROZEN | 635 ms | yes    |      1 | 0       | 1     | 1/1           |         0 | 11/11         | no    |    154 |
| 02  | 07:03        | pass    | FROZEN | 606 ms | yes    |      1 | 0       | 1     | 1/1           |         0 | 11/11         | no    |    149 |
| 03  | 07:11        | pass    | FROZEN | 674 ms | yes    |      1 | 0       | 1     | 1/1           |         0 | 10/10         | no    |    151 |
| 04  | 07:17        | pass    | FROZEN | 649 ms | yes    |      1 | 0       | 1     | 1/1           |         0 | 11/11         | no    |    152 |
| 05  | 07:23        | pass    | FROZEN | 727 ms | yes    |      1 | 0       | 1     | 1/1           |         0 | 10/10         | no    |    150 |
| 06  | 07:30        | pass    | FROZEN | 677 ms | yes    |      1 | 0       | 1     | 1/1           |         0 | 11/11         | no    |    152 |
| 07  | 07:36        | pass    | FROZEN | 620 ms | yes    |      1 | 0       | 1     | 1/1           |         0 | 12/12         | no    |    161 |
| 08  | 07:43        | pass    | FROZEN | 660 ms | yes    |      1 | 0       | 1     | 1/1           |         0 | 10/10         | no    |    150 |
| 09  | 07:49        | pass    | FROZEN | 671 ms | yes    |      1 | 0       | 1     | 2/2           |         0 | 11/11         | no    |    155 |
| 10  | 07:55        | pass    | FROZEN | 650 ms | yes    |      1 | 0       | 1     | 2/2           |         0 | 10/10         | no    |    154 |

Every run: `FROZEN` reached through the production state machine, refusal panel rendered, no editor iframe, every `frameStartedLoading` matched by `frameStoppedLoading`, every WebSocket closed, no frame error, no renderer crash.

## 2. Excluded attempts (disclosed, not counted)

Before the batch could run cleanly, four attempts were spent on **harness** defects — none of them a product failure:

| Attempt        | What happened                                                                                  | Classification                |
| -------------- | ---------------------------------------------------------------------------------------------- | ----------------------------- |
| run01 (06:36)  | product passed (goto 619 ms, panel, 0 iframes); test hung 166 s in `Tracing.end`               | harness hang                  |
| run01b (06:46) | same product result; hung the whole 240 s in the same place                                    | harness hang                  |
| run01c (06:52) | product passed (window showed `outcome: pass`); hung in `ensureActive()` SSH call in `finally` | harness hang                  |
| run03 (07:07)  | killed by the operator shell timeout mid-run                                                   | operator/infrastructure abort |

After the third harness defect was removed, the batch ran unattended in the background and completed 10 valid runs.

**Disclosure**: the shell-timeout kill at 07:07 left the tenant in `DRAINING` (version 288). It was detected immediately and restored through the legal path (`release`) to `ACTIVE` (version 290) before the batch continued.

## 3. Freeze-state discipline

The batch driver checked the state before every run and restored it after every run:

- every run started at `state=ACTIVE`;
- every run ended at `state=FROZEN` (the spec never releases — by design, after the harness defects);
- the driver released back to `ACTIVE` each time (`FROZEN` → `reconcile`/`release`, or `release` for other blocking states);
- final state after run 10: **`ACTIVE`, version 330**.

No drain was forced, no write-arm was cleared, no database row was edited at any point.

## 4. What 10 passes mean — and what they do not

**Established** (new this phase):

- The frozen re-open works correctly and consistently on phase-aj: 10/10, 606–727 ms.
- The freeze gate is right: zero WOPI calls, zero editor frames, panel rendered.
- The browser lifecycle is clean: balanced loading events, sockets closed, no crash, no frame error.
- The **harness** can now survive a throwing navigation and still emit evidence (proven locally).

**Not established**:

- This does **not** exclude the root cause. Ten passes on a fresh document with a settled editor do not reproduce DK's condition, which included a previously stalled Collabora session (21 tile stalls before the freeze).
- No failing run was captured, so the DK failure's mechanism remains untested.
- The DK trace itself still contains no post-navigation frame tree; nothing in this phase retroactively supplies one.

## 5. Statistics

Ten consecutive passes at the observed failure rate would be expected if the true failure probability were below roughly 26 % (95 % confidence bound via the rule of three, 3/10 ≈ 0.26). The DK failure therefore has a plausibly low but non-zero rate under _these_ conditions — and possibly a much higher rate under the conditions DK actually had.

## 6. Status

**FAIL/BLOCKED** for root cause: no reproduction in 10 valid runs. **PASS** for the ten functional frozen-state checks, the freeze-state discipline, and the failure-capture mechanism.
