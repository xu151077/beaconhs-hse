# Phase 6U-B3-DL — Browser events

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Instrumentation used (test-side only)

A temporary Playwright spec installed listeners on the page — no product code changed:

```ts
page.on('frameattached' | 'framenavigated' | 'framedetached', …)
page.on('domcontentloaded' | 'load' | 'pageerror', …)
page.on('console', msg => error/warning only)
page.on('requestfailed', …)   // method + redacted URL + errorText
page.on('response', …)        // only /documents/, /wopi/, /browser/, /cool/, /hosting/
page.on('websocket', ws => open / close / socketerror)
```

URLs are reduced to `origin + pathname` before logging; query parameter **names** are kept only when they are not credential-like (`token|key|sig|cap|secret` are dropped). No header is read. The raw timeline is attached to the trace as JSON.

The frozen navigation was bounded (90 s) and, on timeout, the **rendered state was sampled** rather than abandoning the page — so a timeout alone can never be reported as a pass.

## 2. Event order — frozen re-open (passing run DL-3)

```
15:54:03.139  freeze:state=FROZEN
15:54:04.109  framedetached   about:blank                 (old iframe inner frame)
15:54:04.109  framedetached   /browser/201368fc8d/cool.html (old editor frame)
15:54:05.039  frameattached   (unnamed)
15:54:05.043  framedetached   about:blank
15:54:05.043  frameattached   (unnamed)
15:54:05.132  domcontentloaded /documents/6af7e18d…
15:54:05.135  load             /documents/6af7e18d…
15:54:05.167  navigate-ms=2028  loadFired=true
15:54:05.361  framedetached   about:blank
15:54:05.649  framedetached   about:blank
```

Final DOM: `iframes: 0`, `frozenPanel: 1`, title `Document · 6af7e18d · BeaconHS`.

DL-1 and DL-2 show the same order with `load` at 8.2 s and 7.8 s respectively.

## 3. Event order — the DK failure (historical, for contrast)

```
15:21:40.031  GET /documents/692f70a8…   → 200 (4,140 ms)
15:21:40.551  websocket-open  wss://…/cool/ws
…             no domcontentloaded, no load, ever
              main-frame DOM snapshot: no document content
```

In DK, the previous session's socket had been open 158 s and Collabora logged 21 tile-stall warnings in the preceding two minutes. In every DL run the socket closed and the child frame detached before `load`.

## 4. What the events do and do not prove

| Question                                           | Answer from events                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Did the frozen request reach the server?           | Yes — 200 responses recorded in both DK and DL.                                                                                      |
| Was a WOPI request made?                           | No — zero in every run, frozen or active-then-frozen.                                                                                |
| Does the frozen page render the refusal panel?     | Yes, in all three DL runs (`frozenPanel: 1`).                                                                                        |
| Does an iframe remain after the frozen navigation? | No in DL; **yes** in DK.                                                                                                             |
| Was there an iframe creation/removal loop?         | No — one attach/detach pair per navigation in DL; two transient attach/detach pairs in DK at the same instant, then a lingering one. |
| Did an iframe script throw?                        | No `pageerror` in any run.                                                                                                           |
| Does `load` correlate with a specific frame?       | Yes — `load` fires only after the `cool.html` child frame is detached; in DK that frame never detached.                              |

Not proven: _why_ the frame failed to detach in DK. The events show the boundary, not the mechanism.

## 5. Noise that is not a defect

Present in every run, active or frozen, and therefore excluded:

- CSP block of `static.cloudflareinsights.com/beacon.min.js` (Cloudflare injects it; the app's CSP correctly refuses it).
- `404 /browser/<hash>/extensions/index.json` — Collabora's optional extension discovery; it warns and continues.
- `net::ERR_ABORTED` on `?_rsc` prefetches during navigation — normal Next.js prefetch cancellation.
- `MaxListenersExceededWarning` on the server (Gzip) — server-side, unrelated to the browser.

## 6. Status

Status: **PASS** for the instrumentation and the recorded event timelines. **BLOCKED** for root cause: the child-frame state at the moment of the hang is not visible in a standard Playwright trace, which is the next artefact required.
