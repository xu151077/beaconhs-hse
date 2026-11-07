# Phase 6U-B3-DK — Final report

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Summary

The phase-aj Scenario 4 failure was **reproduced with a retained trace** — the first request-level evidence in this whole investigation. It moves the fault boundary from "somewhere around Collabora" to a specific observable: **the frozen page's HTML is served (200 in 4.1 s), zero WOPI requests are made, and the browser's `load` event never fires while a second Collabora WebSocket opens at the same instant and the previous document session is still logging tile stalls.**

The root cause is still **not** proven at the code level, so WOPI remains **FAIL/BLOCKED**.

## 2. Target identity — PASS

| Item                    | Verified                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| SSH                     | `ceshi@10.10.31.30`, ED25519 `SHA256:fkdz2n4B…`                                             |
| Compose project / file  | `beaconhs-phase-aj` / `/home/ceshi/beaconhs-phase-cd/compose.yaml`                          |
| Web / worker image      | `beaconhs:phase-cq-20261019-driver`, `sha256:60dc4841…`                                     |
| Collabora image         | `collabora/code@sha256:4e983196…`                                                           |
| Public hostname → stack | readiness returns `version=51a899b7…`, matching `APP_VERSION` on the phase-aj web container |
| Test tenant             | `ea5a149b-ea76-48e0-abbe-fa360f520d8e` (cookie and DB agree)                                |
| Drill project           | separate, running, untouched                                                                |

## 3. Scenario 4 — FAIL (reproduced), root cause BLOCKED

| Observation              | Value                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| Freeze state reached     | **FROZEN** (driver-verified; released to ACTIVE afterwards, version 216)   |
| Frozen re-open request   | `GET /documents/692f70a8…` → **200 in 4,140 ms**                           |
| WOPI requests in run     | **0**                                                                      |
| Second `wss://…/cool/ws` | opened 15:21:40.551, 2.4 s                                                 |
| Prior session `wss`      | open **158 s**, 21 `client not consuming tiles` warnings 15:19:27–15:21:37 |
| Final main-frame DOM     | **no document content** (no title, tabs, or frozen panel)                  |
| Playwright outcome       | `page.goto` `load` timeout at 300 s, exit 1                                |

Ruled out with evidence: request never arriving, WOPI hang, freeze gate blocking reads, slow server response. Confirmed: a concurrent stale Collabora session and a `load` that never completes. Unknown: the precise browser-side mechanism.

## 4. Logs (read-only, same window)

- **Web** (`beaconhs-phase-aj-web-1`, 15:17–15:23Z): only 3 lines, all `MaxListenersExceededWarning` — the Next.js standalone server does not log request lines for these routes, so the web log cannot corroborate the trace. This is a logging gap, not evidence the request was absent (the trace shows the 200).
- **Worker**: normal scheduled ticks, 0 write-arm errors.
- **Collabora**: 21 tile-stall warnings from `docbroker_01e`/`ToClient-112d` (15:19:27–15:21:37), then `coolmount`/CAP_SYS_ADMIN errors at 15:21:40.240–15:21:44 (also present locally, so not the differentiator).
- **docbroker session record**: still unavailable (no shell, no volume, no DB file — Phase DJ finding unchanged).

## 5. Evidence protection

- Trace: 22,755,023 bytes, SHA-256 `0ebed035170bc863c5928d58383681cbcccd45fe528e3813de924f33ff2dfe05`, `unzip -t` clean.
- Stored at `/tmp/opencode/phase-dk/evidence/run/…`, directory mode `0700`, **outside** the repository. `apps/web/test-results/` still contains only `.last-run.json`.
- Sensitive content present (counts only): 398 `cookie`, 1 `set-cookie`, 2 `access_token`, 0 presigned signatures. No values reproduced anywhere.

## 6. Status list

| Item                        | Status                                                                   |
| --------------------------- | ------------------------------------------------------------------------ |
| Target identity             | PASS                                                                     |
| Scenario 4 reproduction     | FAIL (reproduced)                                                        |
| WOPI root cause             | BLOCKED                                                                  |
| Trace retention in practice | PASS                                                                     |
| Log correlation             | PARTIAL (web request logging absent; Collabora corroborates the session) |
| Docbroker session record    | BLOCKED                                                                  |
| File authorization matrix   | PASS (historical 7/7, not re-run)                                        |
| Drill                       | BLOCKED (untouched)                                                      |

## 7. Remote side effects

- No config, `.env`, container, network, volume, or deployment change.
- Only the freeze state machine was driven through its production API by the spec itself (ACTIVE → FROZEN → ACTIVE), which is the test's designed precondition and was restored to ACTIVE (version 216).
- No containers created/removed; no logs levels changed; no diagnostic container started.
- The test created one document (`692f70a8…`) in the isolated test tenant.

## 8. Git state

HEAD `51a899b7aac0a942da327222a3eed355fca9798a`, branch `hse-platform`, 0 staged, no commit/push/deploy. Pre-existing modifications and untracked files preserved. New files this phase: three reports under `docs/`.

## 9. Release status

**Still blocked** by the WOPI frozen-navigation failure. The next actionable step is a frame-tree/console capture around the frozen re-open (see the evidence report §7); the current trace proves where the page stops, but not why.
