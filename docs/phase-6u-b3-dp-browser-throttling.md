# Phase 6U-B3-DP — Browser throttling

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. What was checked before any remote run

| Item                                                                    | Result                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Emulation.setCPUThrottlingRate` exists in Playwright 1.64.1's protocol | yes (2 references in `protocol.d.ts`)                                                      |
| Throttling applies to the **test browser only**                         | yes — a CDP command on our own page's session; the server is untouched                     |
| Visibility / focus observability                                        | `document.hidden` / `document.visibilityState` / `document.hasFocus()` via `page.evaluate` |
| Failure-first evidence under throttling                                 | verified: a thrown `goto` still produced CDP events and a trace (see §3)                   |

## 2. First self-test: the benchmark was the problem, not the throttling

Self-test #1 drove a `setInterval`-based busy page and compared `TaskDuration` across rates. It **failed**, reporting `4x = 1.50 s` against a `1x` baseline of `1.83 s`. Read naively, that would say throttling made the page _faster_, which is impossible.

Two defects in the harness, both mine:

1. **`setInterval` does not survive throttling unchanged.** A `setInterval(fn, 1000)` whose callback is CPU-throttled fires less often, so the _total_ work per wall-clock second falls. The metric was measuring the benchmark's own scheduling, not the renderer's throughput.
2. **The assertion threshold was derived from a noisy first sample.** No repeat measurement was taken.

The test then also hit its 30 s budget, because the earlier phase's lesson (a blocking call inside `finally`) had been repeated: `cdp.send('Emulation.setCPUThrottlingRate')` in `finally` plus a 30 s route delay.

## 3. Second self-test: throttling is real and reversible

Fixed-work benchmark — the same loop, timed, at each rate:

| Rate             |    Timed work |
| ---------------- | ------------: |
| 1× (baseline)    |          1 ms |
| 4×               | 2 ms (+100 %) |
| 10×              | 4 ms (+300 %) |
| 1× (after reset) |        0–1 ms |

Result: **passed**, and the reset returns to baseline. Throttling therefore takes effect on the test browser exactly as documented, and `TaskDuration`-style measurements are meaningful **only** when the workload is fixed by work rather than by interval.

Evidence for the failure-first path: self-test #1 ended with a thrown `goto` (`timeout: 4_000`) and the trace still contained `Frame.goto` `before`/`after` entries and the CDP events — the capture mechanism works under throttling.

## 4. Parameters chosen for the race batch

| Parameter       | Value                                       | Reason                                                                     |
| --------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| Rates           | 4×, 10×, 20×, 20×                           | escalate gradually; stop escalating once the predicate is met              |
| Sample window   | 5 s, up to 10 samples                       | bounded; matches the Phase DO predicate window                             |
| Reset           | after every sampling phase and in `finally` | no leaked throttling between runs                                          |
| Occlusion group | second tab brought to front for 20 s        | tests the "backgrounded tab" hypothesis separately from CPU                |
| Predicate       | unchanged from DO                           | `TaskDuration` ≥ 1.5 s/5 s **and** a stall log line **and** an open socket |

## 5. What throttling does **not** prove

A page slowed by CPU throttling is **not** backpressure. Backpressure requires the three-part predicate, including a server-side stall line in the same window. A run where the page is measurably slower but the predicate is unmet is reported as **"throttling applied, pattern not established"**, never as a reproduction.

## 6. Status

**PASS** for the throttling mechanism and the fix to the measurement method. **PARTIAL** for the occlusion condition (observable, but whether it produces backpressure is exactly what the batch measures).
