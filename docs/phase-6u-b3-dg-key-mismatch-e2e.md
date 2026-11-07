# Phase 6U-B3-DG — Server Action key mismatch E2E

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## Status

Status: **NOT RUN** as a proven cross-instance failure.

## Evidence

- Two independent instances were started with different controlled runtime keys and both served requests.
- A cross-instance replay of an authenticated bound Server Action was not completed because the test instance could not establish an authenticated session in the containerized production image.
- The framework’s documented behavior is that a payload encrypted by one runtime key cannot be decrypted by another.

## Conclusion

Mixed runtime keys are expected to cause Server Action failures, but this was not separately reproduced in Phase DG. Inconsistent-config detection remains NOT RUN.

## Next step

Establish an authenticated session in an isolated container and replay a bound Server Action request from one instance to another, then record the failure and recovery behavior.
