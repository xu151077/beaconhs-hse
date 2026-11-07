# Phase 6U-B3-DN — Capture on failure

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Why the previous phases lost the failing run

Phase DK's failure left no post-navigation frame tree, and Phase DM's batch attempt once left the tenant frozen. Both are harness defects, not product defects:

| Defect                               | Cause                                                                                                                                                                                                          | Fixed by                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| No evidence after a thrown `goto`    | Playwright snapshots a call only when it completes; the failing `Frame.goto` never completed                                                                                                                   | CDP event buffer + a JSON attachment written from `finally`                                  |
| Test held open for the whole timeout | `tracing.startChunk()`/`stopChunk()` and `cdp.send('Tracing.end')` inside `finally` block on a context whose tracing is already owned by `trace: 'on'`; one of them hung for 166 s, another for the full 240 s | removed; Playwright's own `trace: 'on'` writes the trace on failure                          |
| Tenant stranded in FROZEN / DRAINING | an operator shell timeout killed the runner before `ensureActive()`                                                                                                                                            | restoration moved out of the test, into a batch driver that checks and restores between runs |

Each defect was diagnosed from captured traces, not guessed:

- the 166 s hang: `Test.pw:api call start=180155 end=346338 dur=166083, params={}` immediately after the assertions;
- the 240 s hang: the same shape, with the last completed product call at 180,810 ms and `After Hooks` only at 347,176 ms.

## 2. The mechanism (final)

```
CDP session (Page.enable, Network.enable, Page.setLifecycleEventsEnabled)
  → frame / lifecycle / websocket events buffered in memory
`expect(...)` assertions
  → outcome = pass | fail
finally
  → attach the buffered timeline as JSON (always)
  → detach CDP (always)
```

Plus Playwright's `trace: 'on'`, which keeps `trace.zip` (with per-call snapshots, including `before` snapshots for interrupted calls) and `video.webm`.

## 3. Verified locally before use

`apps/web/e2e/phase-dn-selftest.spec.ts` (temporary) routed a document request that never completes, with a 5 s navigation timeout:

```
[DN selftest] events=8 chunkBytes=4444
1 passed (46.1s)
```

The `goto` threw as intended, and the trace chunk still contained `trace.trace`, `trace.network`, a screencast frame and `trace.stacks` (`unzip -t` clean, SHA-256 `ff31dd3c…`). The capture path therefore produces evidence **from a throwing navigation**, which is exactly the DK shape.

Limitation found and accepted: on a **passing** run Playwright discards attachments, so the JSON timeline is only retained for failures — which is what it is for. The trace itself is retained for every run under `trace: 'on'`.

## 4. What a captured failure will contain

| Artefact                                 | Survives a thrown `goto`?  | Survives an operator kill?           |
| ---------------------------------------- | -------------------------- | ------------------------------------ |
| CDP JSON timeline (`events`, paths only) | yes (written in `finally`) | no                                   |
| Playwright `trace.zip` (`trace: 'on'`)   | yes                        | partial (written at teardown)        |
| `video.webm`                             | yes                        | partial                              |
| Freeze state                             | not touched by the test    | checked/restored by the batch driver |

## 5. Status

**PASS** — the failure path was proven locally to emit evidence from a navigation that throws, and three real hang sources in the harness were found and removed.
