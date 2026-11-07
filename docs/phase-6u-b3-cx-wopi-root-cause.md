# Phase 6U-B3-CX — WOPI frozen-state root-cause analysis

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## Status

Status: **FAIL / BLOCKED**. The exact phase-aj navigation hang was not reproduced in the isolated environment, and its root cause is not proven.

## Evidence

Local isolated verification used the same document in `phase-bs-isolated`:

| State  | Result                                     | Key timings                                                                                   |
| ------ | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| ACTIVE | Collabora iframe attached; no frozen panel | document GET 684 ms; writer session POST 51 ms; WOPI CheckFileInfo 67 ms; WOPI contents 68 ms |
| FROZEN | Frozen panel rendered; no iframe           | document GET 770 ms; writer session POST 50 ms; no WOPI callback                              |

The frozen path is fast and deterministic locally. It does not hang.

Phase-aj read-only log correlation showed:

- phase-aj web logs contained `STORAGE_FROZEN` refusals.
- phase-aj worker continued scheduled ticks.
- phase-aj Collabora logs contained `client not consuming tiles`, a killed kit process, and `coolmount` capability warnings.

## Interpretation

The observed phase-aj hang is more consistent with a browser/Collabora iframe teardown or an unresponsive editor surface than with a server-side WOPI route timeout. The WOPI route itself returns quickly and denies correctly when frozen.

This remains correlation, not proof.

## Changes made

No business code was changed. No timeout or wait condition was weakened. Existing frozen-refusal behavior and authorization semantics remain unchanged.

## Missing evidence

- Playwright trace/video for the phase-aj Scenario 4 hang.
- Server request timeline for the hung navigation.
- phase-aj Collabora resource-limit and capability configuration comparison.
- A reproducible local case where Collabora is stalled before navigation.

## Next step

Capture a Playwright trace and server-side timeline for Scenario 4, then compare phase-aj Collabora configuration and resource limits with the local Collabora container. Keep Scenario 4 as FAIL/BLOCKED until proven.
