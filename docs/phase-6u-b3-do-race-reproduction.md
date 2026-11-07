# Phase 6U-B3-DO — Race reproduction

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Target: `beaconhs-phase-aj`, `sha256:60dc4841…`, Collabora `sha256:4e983196…`, tenant `ea5a149b-ea76-48e0-abbe-fa360f520d8e`

## 1. Result

| Group                                       | Planned | Ran | Attempts that froze | Stalls in window | Outcome                          |
| ------------------------------------------- | ------- | --- | ------------------- | ---------------- | -------------------------------- |
| A (control, settled editor)                 | 2       | 2   | 2                   | 0                | **2/2 PASS**                     |
| B (freeze only under measured backpressure) | up to 4 | 4   | **0**               | 0                | **backpressure not established** |

**Six attempts completed, zero product failures, and the B-group precondition was never satisfied.** Following the declared predicate, no B attempt was allowed to freeze, so the race condition DK may have hit was **not exercised**.

## 2. Group A — controls

| Run  | Time  | Freeze reached | Nav    | `load` | frames | iframes | panel |
| ---- | ----- | -------------- | ------ | -----: | ------ | ------- | ----- |
| doA1 | 08:10 | FROZEN         | 615 ms |    yes | 1      | 0       | 1     |
| doA2 | 08:16 | FROZEN         | 611 ms |    yes | 1      | 0       | 1     |

Matches DN: a settled editor freezes and reopens cleanly.

## 3. Group B — the predicate never matched

Each B run sampled `Performance.getMetrics` `TaskDuration` in **eighteen consecutive 5 s windows** (90 s total) and counted open WebSockets.

| Run  | TaskDuration growth range | Open sockets | Predicate (≥1.5 s in 5 s) |
| ---- | ------------------------- | -----------: | ------------------------- |
| doB1 | 0.23 – 0.32 s             |            1 | not met                   |
| doB2 | 0.23 – 0.33 s             |            1 | not met                   |
| doB3 | 0.22 – 0.45 s             |            1 | not met                   |
| doB4 | 0.22 – 0.32 s             |            1 | not met                   |

**Interpretation**: the page's main thread spent 4–9 % of each window running tasks (0.22–0.45 s per 5 s). That is an idle editor, not a saturated one. The editor WebSocket was open in every sample, so the "socket alive" leg held — but the saturation leg never came close (a 3–5× margin below the 1.5 s threshold).

**Server log in the same windows**: `client not consuming tiles` count = **0** for all six runs (read-only `docker logs --since … --until …`). So neither the browser-side nor the server-side signal of backpressure appeared.

## 4. Why the precondition did not occur

Three plausible reasons, none of them verified here:

1. **The stall in DK was situational.** The 21 warnings in DK came from a session that had been open ~2 minutes while the test did other things; in DO the editor is opened and left alone with a visible tab, so nothing throttles it.
2. **Headless Chromium does not throttle the tab** the way an unfocused/occluded browser might, so the tile queue drains normally.
3. **The stall may need real user inactivity plus a slow client**, which a single headless page on a fast network does not produce.

None of these is a conclusion — they are the next hypotheses, and each needs a different observation.

## 5. What this run does and does not establish

**Established**

- The frozen re-open remains correct with a settled editor (12 passes total across DN+DO: 606–727 ms, panel, 0 iframes).
- Under normal conditions there is **no tile backpressure** on phase-aj: 0 stall lines and ≤0.45 s/5 s main-thread time in four 90 s sessions.
- The failure-capture and freeze-discipline machinery works: every run exited 0, the tenant never left ACTIVE after a run, and each restore was verified.

**Not established**

- Whether backpressure is sufficient to trigger the DK failure, because it was never produced.
- Any root cause. The DO result narrows the DK condition but does not explain it.

## 6. Evidence

| Run  | Trace size | SHA-256 (first 16) | ZIP integrity |
| ---- | ---------: | ------------------ | ------------- |
| doA1 |  8,402,554 | `a85c4c4b11829919` | OK            |
| doA2 |  8,458,223 | `470521cb442e4c54` | OK            |
| doB1 | 16,720,464 | `d67bce1a9a6eb73b` | OK            |
| doB2 | 16,570,810 | `4597700ffef26757` | OK            |
| doB3 | 17,332,397 | `dbabe1a5e5434bce` | OK            |
| doB4 | 16,880,874 | `0fcedc69cecdcfab` | OK            |

Stored under `/tmp/opencode/phase-do/evidence/`, mode `0700`, outside the repository. The per-run CDP timelines (with `taskGrowthSeconds`, socket counts and event lists) are attachments inside each trace. No cookie, token, or signed URL value is reproduced in this report.

## 7. Status

**PASS** for the two controls. **NOT REPRODUCED (valid)** for group B: four valid attempts, precondition not satisfied, no freeze performed by design. **FAIL/BLOCKED** for the root cause.
