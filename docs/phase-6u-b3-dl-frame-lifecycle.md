# Phase 6U-B3-DL — Frame lifecycle

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Target: `beaconhs-phase-aj` — `beaconhs:phase-cq-20261019-driver` / `sha256:60dc4841…`, Collabora `sha256:4e983196…` (re-confirmed read-only before the runs)

> **Correction (Phase DM).** The comparison in §3 below is retracted. The DK trace has **no frame
> snapshot after the failing navigation** — the snapshot read as "a lingering `cool.html` frame"
> belongs to the assertion _before_ `page.goto`. The passing/failing difference stated here is
> therefore not supported by the evidence. See `docs/phase-6u-b3-dm-frame-websocket-timeline.md` §1.

## 1. What was measured

Three diagnostic runs against the same isolated tenant (`ea5a149b-…`), each driving the production freeze state machine to **FROZEN** (never forced past a failed drain), each opening a freshly created document in ACTIVE, then re-opening it while frozen, then restoring ACTIVE.

Every run installed browser-side listeners: `frameattached`, `framenavigated`, `framedetached`, `domcontentloaded`, `load`, `pageerror`, console error/warning, `requestfailed`, filtered `response`, and WebSocket open/close/error. URLs were stripped of query values before logging.

| Run           | Frozen re-open outcome | `load` fired | Frozen panel | iframes after | Wall time |
| ------------- | ---------------------- | ------------ | ------------ | ------------- | --------- |
| DL-1 (`run`)  | completed              | yes          | **1**        | **0**         | 6.4 min   |
| DL-2 (`run2`) | completed              | yes          | **1**        | **0**         | 6.5 min   |
| DL-3 (`run3`) | completed              | yes          | **1**        | **0**         | 6.3 min   |

All three runs **passed**. The product requirement — a determinate frozen state with no editor — held every time, including DL-3, which deliberately froze 25 s after the editor frame attached to imitate the DK failure conditions.

## 2. The frame lifecycle, from the traces

**ACTIVE (all runs).** Main frame at `/documents/<id>`; one child frame named `collabora-<documentId>` that starts at `about:blank` and navigates to `/browser/<hash>/cool.html`. `load` fires; the editor socket opens; the document renders.

**FROZEN (DL-1 / DL-2 / DL-3).** In the same second as the freeze:

1. `framedetached` for the old `cool.html` child frame (and its blank child).
2. `framenavigated` on the main frame to `/documents/<id>`.
3. `frameattached` for a new blank child, immediately `framedetached`.
4. `domcontentloaded`, then `load` — **8.2 s (DL-1), 7.8 s (DL-2), 2.0 s (DL-3)** after navigation began.
5. Final frame tree: **main frame only**, `iframes: 0`, `frozenPanel: 1`.

No iframe recreation loop, no `pageerror`, no failed document request. The only console errors in every run are the pre-existing Cloudflare Insights CSP block and a 404 for `browser/<hash>/extensions/index.json` — both also present in ACTIVE.

## 3. The DK failure compared with these runs

| Observation                        | DK (failed)                            | DL-1/2/3 (passed)      |
| ---------------------------------- | -------------------------------------- | ---------------------- |
| Frozen document GET                | 200 in 4.1 s                           | 200                    |
| WOPI requests                      | 0                                      | 0                      |
| `load` on the frozen navigation    | **never**                              | 2–8 s                  |
| Final frame tree                   | main **+ lingering `cool.html` child** | main only              |
| Collabora stalls during the window | 21 (15:19:27–15:21:37)                 | 2 (DL-1), 0 (DL-2/3)   |
| Second `wss://…/cool/ws`           | opened, stayed open                    | opened/closed normally |

The single structural difference between the failing and passing cases is the **lingering Collabora child frame** at the end of the run, which corresponds to the `load` event never firing. In the passing runs the child frame is detached _before_ `load`.

## 4. Verdict

- **Not reproduced**: three targeted attempts under the same conditions all completed correctly.
- **Failure is intermittent**, not deterministic, so it cannot be attributed to the frozen state alone.
- **The earliest abnormal event in the DK failure is now identifiable**: the frozen navigation's `load` never fired while a `cool.html` child frame remained attached. Everything before that point (request sent, 200 returned, no WOPI call) is normal.
- **Root cause: still BLOCKED.** A lingering frame is a _symptom_, and correlation with the tile stalls does not establish which side (host page teardown vs. Collabora frame) fails to release.

## 5. Remaining hypotheses and the evidence each needs

| Hypothesis                                                                       | Distinguishing evidence still required                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The host page's iframe removal races the Collabora `beforeunload`/unload handler | Capture `window.performance.getEntriesByType('navigation')` + `document.readyState` inside the _child_ frame at timeout; the trace shows the child frame's URL but not its internal state |
| Collabora holds the frame while a save/lock request is in flight during freeze   | Server-side WOPI/`CheckFileInfo` timing for the _previous_ session at the freeze instant; requires Collabora log level above `warning` (approval-gated)                                   |
| The browser blocks `load` on a long-lived WebSocket that never closes            | A CDP `Network.webSocketClosed` timeline correlated with `load`; available via a Playwright `CDPSession`, not the default trace                                                           |
| Test-side artifact (navigation raced a client-side route change)                 | Repeat until failure with `page.on('crash')` and `page.on('close')` recording; three passes suggest a race, but do not prove one                                                          |

## 6. Status

**FAIL/BLOCKED** for the root cause; **PASS** for the three frozen-state functional checks (determinate panel, no editor, recovery to ACTIVE verified after each run).

## 7. Evidence

| Run         | Trace                                              | Size       | SHA-256                                                            |
| ----------- | -------------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| DL-1        | `/tmp/opencode/phase-dl/evidence/run/…/trace.zip`  | 8,446,041  | `aacaf6e576b7e9c5a5ddfb9cc1739ba287079fbbf4422bf28b2e2a5d55ca23d3` |
| DL-2        | `/tmp/opencode/phase-dl/evidence/run2/…/trace.zip` | 9,315,629  | `49fc16e5b9ad35aa1761cf1b900e965b4216759c232950d9837c7bd3b203d9d0` |
| DL-3        | `/tmp/opencode/phase-dl/evidence/run3/…/trace.zip` | 10,613,188 | `0141f0c0c8a975fc635d95f29ecd9541f74ae3d685fa7eb965a4f0b380b62dad` |
| DK (failed) | `/tmp/opencode/phase-dk/evidence/run/…/trace.zip`  | 22,755,023 | `0ebed035170bc863c5928d58383681cbcccd45fe528e3813de924f33ff2dfe05` |

All four ZIPs pass `unzip -t`; all directories are mode `0700` and outside the repository.
