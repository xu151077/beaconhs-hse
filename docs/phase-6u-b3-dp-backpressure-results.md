# Phase 6U-B3-DP — Backpressure results

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Target: `beaconhs-phase-aj`, `sha256:60dc4841…`, Collabora `sha256:4e983196…`, tenant `ea5a149b-ea76-48e0-abbe-fa360f520d8e`

## 1. The predicate (fixed before the batch, unchanged)

All three must hold, in the same window:

1. `TaskDuration` growth ≥ **1.5 s** per 5 s sample;
2. a Collabora `client not consuming tiles` line;
3. the editor WebSocket still open.

## 2. Matrix and results

| Run  | Group    | Rate | TaskDuration growth (s / 5 s) | Sockets | Stall log | Predicate                            | Froze | Outcome           |
| ---- | -------- | ---- | ----------------------------- | ------: | --------: | ------------------------------------ | ----- | ----------------- |
| dpA1 | control  | 1×   | —                             |       — |         0 | control                              | yes   | **pass** (667 ms) |
| dpA2 | control  | 1×   | —                             |       — |         0 | control                              | yes   | **pass** (632 ms) |
| dpB1 | occluded | 1×   | 0.26                          |       0 |         0 | **no**                               | no    | not established   |
| dpB2 | occluded | 1×   | 0.29                          |       0 |         0 | **no**                               | no    | not established   |
| dpC1 | throttle | 4×   | 0.30 – 0.51                   |       1 |         0 | **no**                               | no    | not established   |
| dpC2 | throttle | 10×  | 0.81 – 1.13                   |       1 |         0 | **no**                               | no    | not established   |
| dpC3 | throttle | 20×  | **1.69**                      |       1 |         0 | **partial** (legs 1+3, no stall log) | yes   | **pass** (779 ms) |
| dpC4 | throttle | 20×  | **1.72**                      |       1 |         0 | **partial** (legs 1+3, no stall log) | yes   | **pass** (691 ms) |

## 3. What each group actually showed

**Controls (A)** — reproduced DN exactly: 632–667 ms, panel, 0 iframes.

**Occlusion (B)** — the hypothesis failed on its own terms. Bringing a second tab to the front left the editor page **`visibilityState: 'visible'`, `document.hidden: false`**, so the browser never treated it as hidden. Main-thread time stayed at 0.26–0.29 s per 5 s. This was **not** occlusion — Headless Chromium does not background a page merely because another tab is focused. The condition was not established.

**CPU throttling (C)** — a clean dose-response:

| Rate | Growth (s / 5 s) | Share of the main thread |
| ---- | ---------------: | -----------------------: |
| 1×   |            ~0.25 |                     ~5 % |
| 4×   |      0.30 – 0.51 |                 6 – 10 % |
| 10×  |      0.81 – 1.13 |                16 – 23 % |
| 20×  |  **1.69 – 1.72** |                 **34 %** |

At 20× the CPU-time leg of the predicate was reached for the first time in this investigation. **The server-side stall leg never appeared** — zero `client not consuming tiles` lines in all eight run windows.

## 4. The important result

**At 20× throttling, with the main thread at 34 % busy, the frozen re-open still passed twice (779 ms and 691 ms).**

This is the strongest boundary statement the project has produced so far:

- the host page can be measurably starved of CPU and the frozen navigation still completes;
- so a merely **slow** renderer is not sufficient to reproduce DK's hang;
- and the one leg of DK's precondition that DP could measure in the browser (main-thread busyness) can be made to match **without** the failure appearing.

The leg DP could **not** produce is the server-side stall. Every DK run had 21 stall lines; every DP run had zero — even at 20× throttling, because the throttling applied to the browser's _renderer_, not to the WebSocket consumer's ability to drain tiles fast enough for coolwsd's 10 s threshold.

## 5. Interpretation (stated as inference, not fact)

The dose-response suggests the DK condition needs **both** sides:

- the client slow enough to fall behind, **and**
- a server-side queue (kit producing tiles faster than the client drains) that actually crosses coolwsd's 10 s stall threshold.

20× browser throttling alone did not cross it in 10 s samples. That is consistent with DK's stall having been a _server-side_ condition (kit load, memory, or a paused kit) rather than pure browser slowness — but DP did not prove that, and must not be read as doing so.

## 6. Evidence retained

| Run  | Trace size | SHA-256 (first 16) |
| ---- | ---------: | ------------------ |
| dpA1 |  8,528,084 | `2da9e012ae38ecab` |
| dpA2 |  9,017,614 | `a7cf3325c10f69e0` |
| dpB1 | 10,518,962 | `d4c62d023f19f4eb` |
| dpB2 |  9,506,786 | `5165194ea1a452bd` |
| dpC1 | 12,937,504 | `23f28000fa202010` |
| dpC2 | 12,472,803 | `39caa4583b69b838` |
| dpC3 |  9,444,089 | `5a14ab04cff9f23f` |
| dpC4 |  8,112,743 | `dc172b95dcdc5136` |

All under `/tmp/opencode/phase-dp/evidence/`, mode `0700`, outside the repository. Per-run CDP timelines (growth series, socket counts, events) are attachments inside each trace.

## 7. Status

**PASS** for the control group. **PARTIAL** for the backpressure predicate: legs 1 and 3 were reached at 20×, leg 2 (server stall) was never produced. **NOT REPRODUCED** for the DK failure — two valid frozen attempts under CPU starvation both completed correctly. **FAIL/BLOCKED** for root cause.
