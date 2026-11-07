# Phase 6U-B3-CU — WOPI frozen-state diagnostics

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Environment: local isolated test environment (`phase-bs-isolated` tenant, `beaconhs-postgres`, `beaconhs-collabora`)

## 1. Result

Status: **BLOCKED / FAIL**. The Phase CT Scenario 4 failure was not reproduced locally, and its root cause was not proven. The frozen WOPI refusal path remains a release risk.

## 2. Local reproduction

ACTIVE and FROZEN states were exercised against the same document (`6362fee2-3339-4fa2-8de4-757b80bfb120`) in the local isolated tenant.

| State  | Browser result                             | Server timings from local web log                                                                                             |
| ------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| ACTIVE | Collabora iframe attached; no frozen panel | `GET /documents/[id]` 684 ms; `POST /documents/[id]` 51 ms; `GET /wopi/files/...` 67 ms; `GET /wopi/files/.../contents` 68 ms |
| FROZEN | Frozen panel rendered; no iframe           | `GET /documents/[id]` 770 ms; `POST /documents/[id]` 50 ms; no WOPI callback                                                  |

The local frozen case correctly rendered `STORAGE_FROZEN_TITLE` / `STORAGE_FROZEN_DETAIL` and did not mint a WOPI session. This demonstrates that the server-side freeze gate itself is functioning.

## 3. Phase-aj log correlation

Phase-aj remained untouched. Read-only log inspection around the Phase CT diagnostic window showed:

- phase-aj web logs contained `STORAGE_FROZEN` refusals for multipart upload operations, consistent with an active freeze.
- phase-aj worker continued scheduled ticks normally.
- phase-aj Collabora logs showed a document broker with `client not consuming tiles` warnings, followed by a kit process killed with status 9 and `coolmount` capability errors.

The phase-aj navigation hang occurred while the prior Collabora editor session was still present. This points to a browser/Collabora iframe teardown or unresponsive editor interaction rather than a WOPI route timeout, but this is correlation, not proof.

## 4. What was not changed

- No `waitUntil` change was made.
- No freeze, tenant authorization, or file-access control was weakened.
- No product code was changed to make the test pass.
- No new regression test was added for the unresolved hang.

## 5. Required follow-up

1. Capture a Playwright trace/video and server-side request timeline for Scenario 4 in a controlled environment.
2. Instrument the document page and `CollaboraEmbed` for session-fetch and navigation timing.
3. Compare phase-aj Collabora resource limits and `coolmount` capability configuration with the local Collabora container.
4. Keep Scenario 4 as **FAIL/BLOCKED** until the hang is reproduced and fixed.
