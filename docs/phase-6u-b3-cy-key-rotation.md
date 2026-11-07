# Phase 6U-B3-CY — Server Action key rotation and rollback

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Image: `beaconhs:phase-ct-validation-20261019-143743`  
Image digest: `sha256:9aac5ca6720d01c3366ec06eeee443ab78d8f9776dbd12e7e0e8fd2317ee3445`

## Verified behavior

- Two independent instances used the same controlled runtime key and invoked a Server Action successfully.
- One instance was restarted with a different controlled runtime key and invoked the Server Action successfully.
- Both instances were then restarted with the second key and invoked the Server Action successfully.
- One instance was rolled back to the original key and invoked the Server Action successfully.
- No key value was printed in logs or diagnostics.

## Build artifact scan

- No runtime key was present in image environment variables.
- No runtime key was present in image history.
- The embedded build-time key remained present in `server-reference-manifest.json` with fingerprint `4155e629f60c0829`.

## Limitations

- Inconsistent-config detection between mixed instances was not proven as a user-visible failure in this pass.
- Full no-downtime rotation and rollback orchestration remain operational follow-ups.

## Status

Status: **PASS** for same-key multi-instance invocation, restart, rotation, and rollback. **PARTIAL** for inconsistent-config detection and no-downtime orchestration.
