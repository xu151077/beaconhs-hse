# Phase 6U-B3-DQ — Tile backpressure method

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

Purpose: define, **before any mirror exists**, how "server-side tile backpressure" will be measured and how it will be _proved_ rather than assumed — because DO and DP both failed to establish it from the browser alone.

## 1. What the failure needs (recap of the evidence)

The DK failure had three coincident facts the later 24 passing runs did not:

1. 21 `client not consuming tiles` warnings over ~2 minutes;
2. an editor WebSocket open for 158 s;
3. the frozen navigation's `load` never resolving.

DP showed browser CPU starvation (34 % main-thread busy) does **not** reproduce it and does **not** produce stall warnings. So the missing ingredient is on the **server** side: the kit producing tiles faster than the client drains them.

## 2. The server-side signal, and what is missing today

At the deployed `warning` level, the only output is the stall line itself:

```
WRN ToClient-<id>: client not consuming tiles; stalled for 10 seconds: removed tracking for N on the fly tiles
```

It gives: time, docbroker id, `ToClient` id, tile count. It does **not** give: document id, client identity, queue depth, why the client stopped.

**In the mirror**, `logging.level=information` plus `logging.disabled_areas` reduced (keeping `WebSocket`/`Socket` enabled) is expected to add the session lifecycle that phase-aj cannot show. That expectation must be **verified from the mirror's own output** — it is a hypothesis about this Collabora build, not a promise.

## 3. The measured quantity

Collabora does not expose a tile-queue depth as a metric. The measurable proxy is the **stall event itself**, which is what the DK evidence contains:

| Metric                        | How obtained                                            | Threshold                  |
| ----------------------------- | ------------------------------------------------------- | -------------------------- |
| Stall events                  | count of `client not consuming tiles` lines in a window | ≥ 1 in the same 5 s window |
| Dropped tile count            | the `removed tracking for N` field                      | reported, not thresholded  |
| Session lifetime before stall | timestamp of `Document_Loaded` → first stall            | recorded                   |
| Socket lifetime               | CDP `Network.webSocketCreated` → `Closed`               | must exceed the stall time |

## 4. The predicate (unchanged; reused verbatim)

An experiment counts as **backpressure established** only when all three hold in the same window:

1. `TaskDuration` ≥ **1.5 s per 5 s** (browser main thread ≥ 30 % busy);
2. a stall line from Collabora;
3. the editor WebSocket still open.

DP reached legs 1 and 3 at 20× throttling. The mirror's job is to reach leg 2.

## 5. How to create server-side pressure in the mirror (and only there)

The mirror may change _Collabora's own configuration_ because it is throwaway — that is the whole point of building it. Candidate levers, in ascending intrusiveness:

| Lever                    | Setting                                                                             | What it tests                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A. Client drain rate     | Playwright `Emulation.setCPUThrottlingRate` 20×, as proved in DP                    | client too slow (already shown insufficient alone)                                                                                    |
| B. Document size         | load a genuinely large DOCX/PPTX (multi-MB, many pages/slides) through the mirror   | kit produces many tiles per viewport                                                                                                  |
| C. Kit resource cap      | run the mirror Collabora with `--cpus` / `--memory` much lower than the host's      | kit starved → slower tile production _and_ longer per-tile time; **changes the failure mechanism**, so it must be labelled separately |
| D. `per_document` limits | lower `cleanup.idle_time_secs` / `limit_dirty_mem_mb` in the mirror's `coolwsd.xml` | makes the "bad document" cleanup path reachable, i.e. kit kill                                                                        |

**Rules for interpreting these:**

- A+B together are the _closest analogue_ of DK's condition (slow client, heavy document). A stall produced this way is the strongest evidence.
- C and D change Collabora's own resource envelope. A stall or a kit kill produced there is a **different mechanism** and must be classified separately — it does not prove DK's cause.
- No lever may be used to "manufacture" the three-leg predicate by faking a log line: the stall must come from coolwsd's own client-session tracking.

## 6. Proving the condition, step by step

1. **Control first.** Frozen re-open on the mirror with a settled editor must pass (panel, 0 iframes). If the mirror cannot pass the control, the mirror is wrong and no experiment is valid.
2. **Instrument.** For each experiment record: `visibilityState`, throttle rate, `TaskDuration` series, socket open/close times, Collabora log slice for the same window, and the frozen navigation's GET/`load`/frame events.
3. **Require all three legs.** A run missing any leg is reported as "pressure applied, condition not established" — never as a reproduction.
4. **Freeze only inside the window.** The freeze request must be issued while the stall is _recent_ (within the same 5 s sample), which is how DK's timeline looked.
5. **Stop at first failure.** Save trace + CDP buffer + the Collabora log slice, then restore ACTIVE and stop.

## 7. What would still be unproven after a mirror success

- That phase-aj's stalls arose from the same cause as the mirror's (Cloudflare, host contention, and the production app image all differ).
- Any statement about the fix until it is confirmed on phase-aj.

The mirror can produce a **mechanism**, not a verdict.

## 8. Status

**PASS** for the method definition. **NOT RUN** — no mirror exists, no lever was applied.
