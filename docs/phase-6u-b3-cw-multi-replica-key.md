# Phase 6U-B3-CW — Multi-replica Server Action key verification

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Image: `beaconhs:phase-ct-validation-20261019-143743`  
Image digest: `sha256:9aac5ca6720d01c3366ec06eeee443ab78d8f9798a`

## 1. Instances

| Instance   | Container ID                                                       | Port   | Result                                           |
| ---------- | ------------------------------------------------------------------ | ------ | ------------------------------------------------ |
| `keytest2` | `750972435d70ef8a82c49bd3f03f932d5c3f9fee687153631d771c0bd2499d56` | `3013` | Server Action succeeded before and after restart |
| `keytest3` | `08e899127ea1b34f4b3764b0d8b7476ea8fa3e5805a1c4d8668637b50da28709` | `3014` | Server Action succeeded                          |

Both instances used the same controlled runtime key. The embedded build-time key fingerprint was `4155e629f60c0829`; the runtime key differed from it.

## 2. Candidate image scan

- No `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` value was present in image environment variables.
- No key value was present in image history.
- The manifest still contains a build-time `encryptionKey`, but it is a disposable build-time key, not the runtime key.

## 3. Restart and multi-instance result

- Instance 2 invoked a Server Action successfully, was restarted, and invoked the same action successfully again.
- Instance 3 invoked the same Server Action successfully with the same runtime key.
- No key value was printed in logs or diagnostics.

## 4. Inconsistent configuration behavior

Next.js 16.3.5 resolves `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY || serverActionsManifest.encryptionKey` once per process. If instances use different runtime keys, an action reference encrypted by one instance cannot be decrypted by another. This is detectable as a Server Action failure, but it is not a graceful silent fallback.

## 5. Status

Status: **PASS** for runtime override, restart, and two-instance invocation. Rotation and rollback were not fully exercised and remain a documented follow-up.
