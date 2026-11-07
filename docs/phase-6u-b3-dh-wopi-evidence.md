# Phase 6U-B3-DH — WOPI evidence

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## Status

Status: **FAIL / BLOCKED** for a proven root cause; the fault boundary is now narrowed to the phase-aj Collabora document session.

## New discriminating evidence (executed this phase, read-only)

Collabora log comparison over the same 24-hour window:

| Signal                                                | Local Collabora | phase-aj Collabora |
| ----------------------------------------------------- | --------------- | ------------------ |
| `client not consuming tiles` (document-session stall) | **0**           | **111**            |
| `Failed to exec coolmount … needs CAP_SYS_ADMIN`      | 8               | 40                 |

- The `coolmount` capability error occurs in **both** environments, so it is **ruled out** as the differentiator.
- The document-session tile stall occurs **only** on phase-aj, and it spans 03:53Z → 07:42Z, with 45 stall lines inside the 07:4x hour.
- At **07:42:13Z** the phase-aj Collabora forkit logged `Child 18682 was killed, with status 9` (`oomkilledcount=0`), in the same minute the Phase CT Scenario 4 navigation hung.
- The local environment ran the same ACTIVE → FROZEN → ACTIVE document flow repeatedly in earlier phases with zero stalls, and the frozen path renders the frozen panel without any WOPI callback.

## What is confirmed, ruled out, and still open

| Item                                                   | State                                                        | Evidence                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Storage-freeze gate blocks a read-only WOPI session    | RULED OUT                                                    | Local FROZEN run renders the frozen panel; no WOPI request is made.            |
| WOPI route hangs                                       | RULED OUT (locally)                                          | Local FROZEN document GET 770 ms; writer-session POST 50 ms; no WOPI callback. |
| Collabora capability error (`coolmount`)               | RULED OUT as the differentiator                              | Present in both environments.                                                  |
| phase-aj Collabora document-session stall / killed kit | CONFIRMED as present on phase-aj only, in the failure window | 111 stall lines, kit killed at 07:42:13Z.                                      |
| Causal link between the stall and the hung navigation  | NOT PROVEN                                                   | No phase-aj trace exists; the stall cannot be reproduced locally.              |

## Next evidence required

1. A Playwright trace/video of Scenario 4 on phase-aj, with the Collabora frame visible.
2. phase-aj `docbroker`/`kit` logs for the exact navigation window, to show whether the browser was still attached to the stalled session.
3. A local reproduction of the stall (phase-aj Collabora resource limits, kit SIGKILL cause, `coolmount`/jail configuration) so the fix can be validated before rollout.

## Change decision

No business code was changed: the failure boundary is not proven, and speculative changes to the freeze gate or the WOPI route would weaken semantics that are currently correct.
