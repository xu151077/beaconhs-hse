# Phase 6U-B3-DO — DK precondition analysis

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

Purpose: separate what was **observed** from what was **inferred or retracted**, so the DO race tests aim at a real condition rather than at a story.

## 1. The comparison table

| Condition                                      | DK (failed, 2026-10-19 15:18–15:22Z)            | DL (3 passes)            | DM (5 passes) | DN (10 passes) | Status                                       |
| ---------------------------------------------- | ----------------------------------------------- | ------------------------ | ------------- | -------------- | -------------------------------------------- |
| Editor iframe attached before freeze           | yes                                             | yes                      | yes           | yes            | **observed** (all)                           |
| `client not consuming tiles` before the freeze | 21 warnings, 15:19:27 → 15:21:37                | 2 (DL-1), 0 (DL-2/3)     | not measured  | not measured   | **observed in DK**, not comparable elsewhere |
| Long-lived WebSocket open at freeze instant    | yes — `wss` from 15:19:01 open 158 s            | closed before frozen nav | closed        | closed         | **observed in DK**                           |
| Unfinished frame loading at freeze             | unknown                                         | none                     | none          | none           | **not observed** (no CDP in DK)              |
| Time from freeze request to FROZEN             | unknown (freeze happened, exact gap not logged) | ~ seconds                | ~ seconds     | ~ seconds      | **partly observed**                          |
| Frozen re-open wait condition                  | `page.goto` `waitUntil: 'load'`                 | `load`                   | `load`        | `load`         | **observed**                                 |
| Browser                                        | Chromium via Playwright 1.64.1                  | same                     | same          | same           | **observed**                                 |
| Collabora image                                | `sha256:4e983196…` (26.04.4.2)                  | same                     | same          | same           | **observed**                                 |
| Test driver                                    | `bt-freeze-driver.ts` in the phase-aj worker    | same                     | same          | same           | **observed**                                 |
| App image                                      | `beaconhs:phase-cq-20261019-driver`             | same                     | same          | same           | **observed**                                 |

## 2. What actually differs

Only **one** precondition distinguishes DK from the twenty later passes:

> In DK the freeze landed while the editor session had been emitting **tile stall warnings for ~2 minutes** and its WebSocket had been open for **158 s**. In DL/DM/DN the editor was **settled** — attached, quiet, socket healthy — when the freeze happened.

Everything else (build, image, browser, tenant, wait condition, freeze path) matches.

## 3. Facts vs inference vs retraction

| Claim                                                               | Classification                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| The editor session was tile-stalled for ~2 min before the DK freeze | **observed** (21 log lines with timestamps)          |
| A socket had been open 158 s at the freeze                          | **observed** (trace network duration)                |
| Frozen re-open returned 200 in 4.1 s                                | **observed** (trace network log)                     |
| No WOPI request during DK's frozen run                              | **observed** (network log)                           |
| `load` never resolved                                               | **observed** (call log: `before` with no `after`)    |
| "Two frames lingered at the end of DK"                              | **RETRACTED** — the snapshot predates the navigation |
| "The stalled session caused the hang"                               | **inference, unproven** — correlation only           |
| "A renderer stall blocked `load`"                                   | **unproven** — no renderer metrics were collected    |

## 4. What the stall warning means mechanically

From the Collabora source path in every log line (`wsd/ClientSession.cpp:4289`), the message `client not consuming tiles; stalled for 10 seconds: removed tracking for N on the fly tiles` means: coolwsd produced document tiles for a client WebSocket, the client did **not** acknowledge/consume them for 10 s, and coolwsd dropped its tracking of those tiles to bound memory.

Two readings are possible and DO must distinguish them rather than assume:

- **(a) server-side backpressure** — the host page/iframe is slow (busy main thread, hidden tab, throttled), so tiles queue and are dropped;
- **(b) a stalled/idle session** — the frame is alive but not painting (e.g. the browser deprioritised it), which coolwsd interprets the same way.

Both are _observable_ from the browser side (see the observability report); only (a) suggests the renderer was saturated at freeze time.

## 5. Scope decision for DO

DO will therefore:

1. treat "tile backpressure present" as a **browser-observed** condition, not a log-timestamp guess;
2. run **2 control** attempts with a settled editor, then up to **4** attempts where backpressure is objectively demonstrated before the freeze;
3. refuse to count an attempt as a valid B-group run unless the backpressure evidence exists.

## 6. Status

**PASS** for the analysis. No product code, remote configuration, or test evidence was altered.
