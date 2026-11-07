# Phase 6U-B3-DB — Server Action key negative tests

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## Verified in prior phases

- Two independent instances used the same controlled runtime key and invoked a Server Action successfully.
- One instance was restarted with a different controlled runtime key and invoked the Server Action successfully.
- Both instances were restarted with the second key and invoked the Server Action successfully.
- One instance was rolled back to the original key and invoked the Server Action successfully.
- No key value was printed in logs or diagnostics.

## Phase DB status

- Missing-key behavior: An instance without `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` started successfully and served requests. The framework fell back to the embedded build-time key.
- Invalid-key behavior: An instance with `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=not-a-valid-key` started successfully and served requests. The tested `createDocument` action completed; this action has no bound arguments, so it did not exercise bound-argument decryption.
- Inconsistent-config behavior: NOT RUN as a proven cross-instance failure. Mixed runtime keys may cause Server Action failures, but this was not separately reproduced in Phase DB.
- Rotation and rollback: PASS from prior phase evidence.

## Policy

- Missing or invalid runtime key configuration should be treated as a deployment failure before traffic is accepted.
- Configuration consistency must be verified by the deployment system or controlled validation; it cannot be assumed from successful calls.
- Rotation requires restarting instances with the new key. Rollback requires restarting with the previously known good key.
- No-downtime dual-key compatibility is not supported by the current framework behavior and was not implemented.

## Status

Status: **PARTIAL**. Same-key multi-instance invocation, restart, rotation, and rollback are verified. Missing-key, invalid-key, and inconsistent-config detection remain NOT RUN.
