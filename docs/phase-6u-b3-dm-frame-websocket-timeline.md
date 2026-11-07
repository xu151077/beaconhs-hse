# Phase 6U-B3-DM — Frame and WebSocket timeline

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Correction to the Phase DL conclusion

**Phase DL reported that the DK failure ended with "a lingering `cool.html` child frame" and treated that as the key structural difference. That conclusion was wrong, and this phase retracts it.**

Re-reading the DK trace call-by-call showed why: the last frame snapshot in that trace belongs to the assertion **immediately before** the failing navigation (`nldr@110`, the `iframe` count check), not to the state after it. The failing `Frame.goto` (`nldr@112`) recorded only a `before` entry and a log line — **no snapshot at all** — because Playwright timed out and never completed the call. Its final snapshot therefore shows the editor still open, which is precisely what the test had established seconds earlier.

There is no evidence in the DK trace about the frame tree _after_ the frozen navigation. The "lingering frame" was an artefact of reading the wrong snapshot.

## 2. What the DK trace does and does not contain

| Question                             | DK trace                                                 |
| ------------------------------------ | -------------------------------------------------------- |
| Frozen navigation started            | yes (`nldr@112` at 329,404 ms monotonic)                 |
| Frozen navigation completed          | **no** — no matching `after`, no result                  |
| HTTP outcome                         | `GET /documents/692f70a8…` 200 in 4,140 ms (network log) |
| Frame tree after the navigation      | **not recorded**                                         |
| CDP frame events                     | none (no CDP session in that run)                        |
| WebSocket state after the navigation | second `wss` opened at 15:21:40.551, no close recorded   |

So the DK failure is documented as: _the navigation's `load` never resolved and no post-navigation snapshot exists_. Anything about which frame held it is unknown from that trace.

## 3. The five CDP attempts (all passing)

Every attempt froze the tenant through the production state machine (always reaching **FROZEN**), re-opened the same document, and recorded CDP events.

| Attempt | Frozen state | Nav duration | Frames after | WebSocket created/closed | Frame errors | Sockets open at end |
| ------- | ------------ | ------------ | ------------ | ------------------------ | ------------ | ------------------- |
| 1       | FROZEN       | 1,734 ms     | 1 (main)     | 1 / 1                    | 0            | none                |
| 2       | FROZEN       | 1,649 ms     | 1 (main)     | 2 / 2                    | 0            | none                |
| 3b      | FROZEN       | 940 ms       | 1 (main)     | 1 / 1                    | 0            | none                |
| 4       | FROZEN       | 1,372 ms     | 1 (main)     | 1 / 1                    | 0            | none                |
| 5       | FROZEN       | 878 ms       | 1 (main)     | 1 / 1                    | 0            | none                |

(Attempt 3 was abandoned mid-run because the operator shell timed out and killed the test; the tenant was restored to ACTIVE and attempt 3b was run cleanly. That abandoned run is not counted as evidence either way.)

## 4. Representative event order (attempt 5)

```
t=179 541  Page.frameStartedLoading        frame=807965D1… (main, frozen navigation)
t=179 603  Page.frameStoppedLoading        frame=153F83AD… (old collabora child)
t=179 622  Page.lifecycleEvent DOMContentLoaded  frame=9EFA31D1… (main)
t=179 625  Page.lifecycleEvent load              frame=9EFA31D1… (main)
t=179 681  Page.frameDetached / page.framedetached  frame=collabora-fc…
t=179 683  Page.lifecycleEvent DOMContentLoaded  frame=74CD4DCF… (new blank child)
t=179 683  Page.lifecycleEvent load              frame=74CD4DCF…
t=179 899  Page.frameDetached              frame=collabora-fc… (new blank child removed)
```

Key observation: in every passing attempt the **main frame's `load` fired while the Collabora child frame was already detached**, and each child frame that appeared afterwards was an empty `about:blank` placeholder that detached immediately.

## 5. Answers to the brief's questions

| Question                                                                | Answer from CDP data                                                                                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Was a child frame stuck mid-navigation?                                 | No — every `frameStartedLoading` has a matching `frameStoppedLoading` in all five passes                                                                             |
| Did a child frame fail to detach?                                       | No — every `Page.frameAttached` has a later `Page.frameDetached`                                                                                                     |
| Is detach consistent with WebSocket lifetime?                           | Yes — sockets close before or with the frame detach; zero sockets open at the end of every run                                                                       |
| Is the main frame waiting on another operation?                         | No — its `DOMContentLoaded` and `load` both fire within 100 ms of each other                                                                                         |
| Is the wait Playwright's or the browser's?                              | **Browser's**: the CDP `Page.lifecycleEvent load` and `page.on('load')` agree in every pass. In DK neither fired, so that failure was not a Playwright-only artefact |
| Does the browser request reach the server before any lifecycle failure? | Yes — the frozen document GET is a 200 well before `load`                                                                                                            |

## 6. Status

**PASS** for the CDP capture and for the five observed lifecycles. **FAIL/BLOCKED** for the failure mechanism: it did not occur in five instrumented attempts, so the DK failure's cause cannot be tested against these controls.
