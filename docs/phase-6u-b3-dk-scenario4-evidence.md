# Phase 6U-B3-DK — Scenario 4 evidence (phase-aj)

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Target: `beaconhs-phase-aj` (`beaconhs-test.xuhaoqing.top`), image `beaconhs:phase-cq-20261019-driver` / `sha256:60dc4841…`

## 1. Result

**Scenario 4 failed again — reproduced on phase-aj with a retained trace.** This is the first time the failure has request-level evidence.

```
1 failed (5.6m)
Error: page.goto: Test timeout of 300000ms exceeded.
  navigating to .../documents/692f70a8-e2cb-4af9-b7ff-af6ea3894915, waiting until "load"
```

Command (no remote change of any kind):

```
E2E_BASE_URL=https://beaconhs-test.xuhaoqing.top \
  npx playwright test e2e/phase-bq-frozen-ux.spec.ts --grep "Scenario 4" \
  --workers=1 --trace on --output /tmp/opencode/phase-dk/evidence/run
```

Exit code: **1**. Window: 15:16:05Z → 15:24:38Z (host clock 23:16–23:24 +08:00).

## 2. Freeze state reached

The spec's own driver output:

```
[BQ] released -> ACTIVE
[BQ] freeze state: FROZEN
```

Unlike the local run (which could only reach `DRAINING`), phase-aj **did** reach `FROZEN` — the drain verified there. The freeze was released afterwards and the tenant is back to `ACTIVE` (version 216).

## 3. Timeline from the trace

| Time (UTC)          | Step                                                | Evidence                                              |
| ------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| 15:18:12            | Documents list loaded                               | `GET /documents` 200, 663 ms                          |
| 15:18:19–23         | List, then a batch of document prefetches           | all 200, 505–1073 ms                                  |
| 15:18:29.762        | New document page navigated                         | 4 parallel `GET /documents/692f70a8…` 200, 491–987 ms |
| 15:18:30.253        | Create-document server action                       | `POST /documents/…` 200, 717 ms                       |
| 15:18:31.296        | Detail page load                                    | `GET` 200, 1,376 ms                                   |
| 15:18:37.721        | Detail page re-render                               | `GET` 200, 2,123 ms                                   |
| 15:18:52.747        | **Start blank** action                              | `POST` 200, 2,367 ms                                  |
| 15:18:55.115        | Collabora branding prefetch                         | 200, 834 ms                                           |
| 15:18:55.952        | **Collabora `cool.html` POST**                      | 200, 791 ms                                           |
| 15:18:56–15:19:14   | Collabora assets, `bundle.js` 12.8 s, icons 1–16 s  | all 200                                               |
| 15:19:01.148        | **`wss://…/cool/ws` opened**                        | 101, stays open **158 s**                             |
| 15:19:27 → 15:21:37 | **`client not consuming tiles`** in Collabora       | 21 warnings, `docbroker_01e`, `ToClient-112d`         |
| 15:21:40.031        | **`GET /documents/692f70a8…` (the frozen re-open)** | **200, 4,140 ms**                                     |
| 15:21:40.551        | **Second `wss://…/cool/ws`**                        | 101, 2.4 s                                            |
| 15:21:40+           | **no further document/WOPI requests**               | —                                                     |
| 15:24:38            | Playwright gives up (`load` never fired)            | timeout                                               |

## 4. The decisive finding

- The frozen re-open request **did arrive at the server and returned 200 in 4.1 s**. The page HTML was delivered.
- **WOPI requests in the entire run: 0.** The frozen page never asked for a writer session — correct, and consistent with the local run.
- The browser then opened a **second** `wss://…/cool/ws` socket at the same moment and the main frame's `load` event **never fired**.
- Collabora was concurrently logging `client not consuming tiles` for the **previous** document session (`docbroker_01e`, 21 lines from 15:19:27 to 15:21:37), i.e. the session created by "Start blank" before the freeze.
- The main frame's final DOM snapshot in the trace contains **no BeaconHS document content** (no title, no Write/PDF tabs, no frozen panel) — the document page never finished rendering from the browser's point of view, even though its HTML was served.

So the blocking layer is **the browser's page-load completion**, held by the still-open Collabora WebSocket / iframe teardown, not by the WOPI route, not by the freeze gate, and not by the server response.

## 5. Confirmed / ruled out

| Hypothesis                                                  | State                                   | Evidence                                                                                                         |
| ----------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Frozen request never reaches the server                     | **RULED OUT**                           | `GET /documents/692f70a8…` 200 in 4,140 ms at 15:21:40                                                           |
| WOPI route hangs                                            | **RULED OUT**                           | 0 WOPI requests in the run                                                                                       |
| Freeze gate blocks a read                                   | **RULED OUT**                           | server returned 200; freeze state FROZEN; no WOPI token minted                                                   |
| Server response is slow/hanging                             | **RULED OUT**                           | 4.1 s, complete HTML                                                                                             |
| A stale Collabora session holds the page                    | **CONFIRMED as present and concurrent** | old `wss` open 158 s; 21 tile-stall warnings; new `wss` at the same second as the frozen GET; `load` never fired |
| Frontend waits for a state that never arrives               | **CONFIRMED as the visible symptom**    | DOM snapshot has no document content; no frozen panel rendered                                                   |
| Exact causal mechanism inside the iframe/WebSocket teardown | **UNKNOWN**                             | needs the browser-side frame tree/console around 15:21:40, which the trace records only partially                |

## 6. Historical vs new

- **New this phase**: the phase-aj trace, the 4.1 s/200 frozen GET, the two `wss` sockets with durations, the 21 tile-stall warnings inside the failure window, the empty final DOM snapshot.
- **Historical**: the earlier CT timeout (no trace), the local DRAINING run (Phase DJ), the 111-stall count over 24 h (Phase DH).

## 7. What is still needed

The trace's DOM snapshots stop being useful once the iframe takes over. To move from "the load event is held by the Collabora frame" to a specific defect, the next capture must record the **frame tree** and the **iframe console** for the frozen re-open (e.g. `page.frames()` + `frame.evaluate` polling, and `console`/`pageerror` capture), because Playwright's default trace does not snapshot cross-origin-ish iframe internals deeply enough.

## 8. Evidence artefacts

| Item           | Path / value                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| Trace          | `/tmp/opencode/phase-dk/evidence/run/phase-bq-frozen-ux-Phase-B-1a9f8-gate-refuses-a-WOPI-session-chromium/trace.zip` |
| Size           | 22,755,023 bytes                                                                                                      |
| SHA-256        | `0ebed035170bc863c5928d58383681cbcccd45fe528e3813de924f33ff2dfe05`                                                    |
| ZIP integrity  | `unzip -t` → "No errors detected"                                                                                     |
| Video          | same directory, `video.webm`                                                                                          |
| Error context  | same directory, `error-context.md`                                                                                    |
| Directory mode | `0700`, outside the repository                                                                                        |

Sensitive content present (counts only, no values): 398 `cookie` header entries, 1 `set-cookie`, 2 `access_token` query parameters, 0 presigned-URL signatures.
