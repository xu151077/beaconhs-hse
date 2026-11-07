# Phase 6U-B3-CZ — WOPI frozen-state fix and closure

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## Status

Status: **FAIL / BLOCKED**. The phase-aj Scenario 4 hang root cause remains unproven. No speculative business-code fix was applied.

## Evidence

- Local isolated FROZEN case renders the frozen panel and does not mint WOPI.
- Local ACTIVE/FROZEN document request timings are fast and deterministic.
- Phase-aj logs correlate the hang with a prior Collabora editor session, tile stalls, a killed kit process, and `coolmount` capability warnings.
- No server-side WOPI route hang was reproduced locally.

## Coverage note

The existing WOPI unit tests passed 36/36. Those tests validate WOPI token behavior, refusal mapping, storage refusal, and Collabora URL handling. They do not reproduce the phase-aj browser navigation hang.

## Conclusion

The WOPI route and freeze gate behave correctly. The phase-aj hang is consistent with a browser/Collabora iframe or editor-surface issue, but this remains correlation, not proof. Scenario 4 remains FAIL/BLOCKED.

## Next required evidence

- Playwright trace/video for Scenario 4.
- Server request timeline for the hung navigation.
- phase-aj Collabora resource-limit and capability configuration comparison.
- A reproducible local case where Collabora is stalled before navigation.
