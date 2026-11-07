# Phase 6U-B3-DL — Final report

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Summary

Three targeted phase-aj runs instrumented the frame, WebSocket and lifecycle events around the frozen re-open. **All three passed** — the failure did not reproduce. Comparing them with the DK failure isolates one structural difference: in DK a Collabora child frame stayed attached and `load` never fired; in every passing run the child frame detached first and `load` completed in 2–8 s. The mechanism behind that difference is still unknown, so WOPI remains **FAIL/BLOCKED**.

## 2. Results

| Item                                         | Status             | Evidence                                                    |
| -------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| Frame/WebSocket instrumentation              | PASS               | listeners in three temporary specs, no product code changed |
| Frozen re-open — DL-1                        | PASS               | panel shown, 0 iframes, `load` fired                        |
| Frozen re-open — DL-2 (original `load` wait) | PASS               | `load` 7.8 s                                                |
| Frozen re-open — DL-3 (DK-like timing)       | PASS               | `load` 2.0 s                                                |
| Scenario 4 reproduction                      | **NOT REPRODUCED** | 0 of 3 runs failed                                          |
| Root cause                                   | **BLOCKED**        | symptom isolated to a lingering child frame; cause unproven |
| Freeze semantics                             | PASS               | FROZEN reached legally; restored to ACTIVE (version 221)    |
| Evidence retention                           | PASS               | 3 traces, ZIP-verified, mode 0700, outside repo             |

## 3. The one new, direct finding

The failing DK run ended with **two live frames** (main + `cool.html`) and no `load`. Every passing run ended with **one** frame. That is the first evidence that ties the hang to a specific frame lifecycle state rather than to the WOPI route, the freeze gate, or server latency — all of which were already ruled out.

## 4. What would close it

The child frame's internal state at the moment `load` is held. A standard Playwright trace records the child frame's URL and screencast but not its `document.readyState`, unload handlers, or WebSocket close timing. The next capture needs:

1. `page.on('crash'|'close')` plus a CDP session (`Network.webSocketClosed`, `Page.frameStoppedLoading`) around the frozen navigation.
2. A loop that repeats the DK sequence until it fails, recording the child frame's `readyState` and `location` on timeout.
3. Optionally, Collabora at `information` level for the window (approval-gated; changes a container).

## 5. Remote side effects

- No configuration, container, network, volume, or log-level change.
- Only the freeze state machine was driven (ACTIVE → FROZEN → ACTIVE) and restored each time.
- Three test documents created in the isolated tenant; no production data touched.
- Temporary specs deleted; no containers or listeners left behind; `apps/web/test-results/` contains only `.last-run.json`.

## 6. Git state

HEAD `51a899b7aac0a942da327222a3eed355fca9798a`, branch `hse-platform`, 0 staged, no commit/push/deploy. Pre-existing modifications and untracked files preserved. New this phase: four reports under `docs/`.

## 7. Release status

**Still blocked** by the intermittent frozen-navigation hang. The problem is now bounded to the Collabora child-frame teardown, with three passing control runs and one failing reference run — a reproducible _condition_ still needs to be found before any fix can be justified.
