# Phase 6U-B3-DO — Backpressure observability

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. The server-side signal (existing logs, read-only)

Every stall line has the same shape:

```
wsd-00001-<pid> <ts> [ docbroker_0XX ] WRN  ToClient-<id>: client not consuming tiles;
stalled for 10 seconds: removed tracking for N on the fly tiles
|.../wsd/ClientSession.cpp:4289
```

Available fields: timestamp, `docbroker` id, `ToClient` id, the 10 s stall threshold, and the number of dropped tiles. **Not** available at the deployed `warning` level: which document, which frame, or why the client stopped consuming.

Consequences for DO:

- the log line proves a **server-side** stall existed, but not whether the browser was saturated;
- it cannot be correlated to a specific iframe without a browser-side record;
- the deployed level cannot be raised (no container changes allowed), so the log alone is insufficient.

## 2. The browser-side signals (what DO uses)

All of these are obtainable from a Playwright CDP session with **no remote change**:

| Signal                 | CDP / API                                                                        | What it tells us                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Main-thread saturation | `Performance.getMetrics` → `TaskDuration`, `ScriptDuration` deltas over a window | whether the page was busy enough to stop consuming tiles (reading (a) in the precondition report) |
| Frame painting         | `Page.startScreencast` (or Playwright trace screencast) → frame timestamps       | whether the editor frame was actually painting                                                    |
| Renderer liveness      | `page.on('crash')`, `page.on('close')`                                           | a dead renderer vs a slow one                                                                     |
| WebSocket state        | `Network.webSocketCreated/Closed/FrameError`                                     | whether the editor socket was still open at the freeze                                            |
| Frame loading          | `Page.frameStartedLoading` / `frameStoppedLoading`                               | whether any frame was mid-navigation                                                              |
| Layout pressure        | `Performance.getMetrics` → `LayoutCount`, `RecalcStyleCount`                     | layout storms that starve tiles                                                                   |

**Objective backpressure predicate used by DO** (all must hold for an attempt to count as B-group):

1. `TaskDuration` grows by **≥ 1.5 s within a 5 s sample window** (30 % main-thread busy), **and**
2. a Collabora `client not consuming tiles` line appears in the server log during that same window, **and**
3. the editor WebSocket is still open at the moment the freeze request is issued.

If a run shows (2) and (3) but not (1), it is classified as **"server stall without browser saturation"** — a different precondition — and is reported separately rather than counted as backpressure.

## 3. Why these thresholds

`TaskDuration` is cumulative main-thread time; a 5 s window with ≥1.5 s of task time means the main thread spent ≥30 % of the window executing tasks, which is the regime where a rendering client stops draining tile messages. The thresholds are deliberately **absolute and stated in advance** so an attempt cannot be counted or dismissed after seeing the outcome.

## 4. Known limits (declared, not discovered later)

- `Performance.getMetrics` is per-page and aggregates the main thread; it does not attribute the load to the Collabora iframe specifically. A saturated main thread is still the mechanism that stops WebSocket consumption, so this is an acceptable proxy — but it is a proxy.
- The server log has second-level granularity and no document id at `warning` level, so "during that same window" is a ±1 s correlation, not a causal link.
- If a run never satisfies the predicate, DO must report **"backpressure condition not established"** and must not weaken the predicate to manufacture a B-group attempt.

## 5. Status

**PASS** for the observability contract. The predicate is defined before any run, from data that is collectable without touching the remote stack.
