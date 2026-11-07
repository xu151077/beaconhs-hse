# Phase 6U-B3-DI — WOPI Scenario 4 evidence

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## Status

Status: **FAIL / BLOCKED**. Scenario 4 was not reproduced and the root cause is still unproven. This phase produced evidence about _what is missing_, and one decisive negative result.

## Evidence available (read-only)

| Source                                | State                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase CT Playwright artifacts         | **Gone.** `apps/web/test-results/` now holds only `.last-run.json`; the diagnostic spec's `video.webm` / `error-context.md` were removed by later Playwright runs. No `trace.zip` was ever produced (the config records traces only `on-first-retry`).  |
| phase-aj web logs (24 h)              | 9 error lines, **0 lines mentioning `wopi`**. The WOPI route logged no error in the failure window.                                                                                                                                                     |
| phase-aj Collabora logs (24 h)        | 111 `client not consuming tiles` lines (03:53Z–07:42Z, 45 in the 07:4x hour) and a kit killed with status 9 at 07:42:13Z (`oomkilledcount=0`). The `coolmount`/CAP_SYS_ADMIN error appears in the local container too, so it is not the differentiator. |
| phase-aj Collabora docbroker database | **Not readable.** The image has no shell (`exec: "sh": executable file not found`) and `docker cp` cannot find `/opt/coolwsd/data`, `/opt/coolwsd/data/docbroker.db` or `/opt/coolwsd`, so the per-document session history could not be extracted.     |

## What the evidence now says

- The WOPI route was never reached with an error while the navigation hung (0 `wopi` lines in the web logs).
- The only environment difference that correlates with the failure is the Collabora document-session stall, which never occurs locally.
- Correlation is still not causation: without a trace there is no evidence that the browser was blocked by that session.

## The single missing artifact

A Playwright trace of Scenario 4 on phase-aj, captured with `trace: 'on'` and **retained** (the current config's `on-first-retry` never produced one), plus the Collabora `docbroker` session record for the same window. Without those, the failure boundary cannot be moved from "the Collabora session" to a specific request.

## Change decision

No business code and no WOPI configuration was changed. The freeze gate, the WOPI route, the authorization checks, and the storage-freeze semantics are all still correct in the evidence available.
