# Phase 6U-B3-DI — Server Action key consistency contract

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Three conclusions that must not be conflated

| Conclusion                                            | Who can answer it                     | Mechanism                                                       |
| ----------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| Is THIS instance's key usable?                        | the instance                          | `assertServerActionKeyUsable` in readiness (Phase DH)           |
| Do two instances hold the SAME key?                   | the deployment, not a single instance | keyed fingerprint comparison (this phase)                       |
| Does a cross-instance Server Action actually succeed? | a request that crosses instances      | not automatable in the app; bounded by the deployment invariant |

## 2. The consistency mechanism

`fingerprint = HMAC-SHA256(key, "beaconhs:server-action-key:fingerprint:v1")`, truncated to 128 bits, exposed as hex.

Why a keyed MAC and not a plain hash:

- A plain hash of the key would be an offline verification oracle for a guessed key and would let a holder of the hash confirm a candidate key without the deployment. The HMAC has the key as its MAC key, so the output is a PRF under the key.
- The fingerprint cannot be inverted into the key, and it reveals exactly one thing: whether two configurations hold the same key.
- It is not a credential: it authenticates nothing and cannot be replayed, because nothing accepts it as input.
- It is not published on a public endpoint (the readiness endpoint is reachable by the load balancer). It is written to the instance log once per process and printed by the deployment script.

## 3. Where the check lives

- `apps/web/src/lib/server-action-key.ts` — `serverActionKeyFingerprint()`.
- `apps/web/src/app/api/health/ready/route.ts` — logs the fingerprint once per process (`[server-action-key] configuration fingerprint: <hex>`), never in the HTTP response.
- `apps/web/scripts/verify-server-action-key-consistency.ts` — the deployment gate:
  - `--print` prints the fingerprint of the configured key;
  - `--expect <fingerprint>` exits **0** on a match and **1** on a mismatch, so a rollout can be blocked;
  - `--key-file <path>` verifies the build-time key from the same file the build uses as its BuildKit secret.

## 4. Deployment invariant

Every web instance must present the same effective Server Action key. Next.js states the requirement ("all instances must use the same encryption key") but offers no detection, so the invariant is enforced **outside** the application:

1. Deploy one instance; read its fingerprint from the log (or run the script with `--print`).
2. Run `verify-server-action-key-consistency.ts --expect <fingerprint>` against every other instance's environment; a non-zero exit blocks the rollout.
3. In the build-time-only mode (no runtime override) the application cannot fingerprint the embedded key; the invariant is then enforced by the build/deploy secret pipeline, and the script verifies that pipeline input with `--key-file`.

A rotation is a coordinated restart with the new key: instances that keep the old key produce a different fingerprint and are blocked by the gate. Rolling back restores the previous fingerprint.

## 5. Status

Status: **PASS** for the mechanism and the gate. **PARTIAL** for the residual risk that a mixed fleet is only detected when the operator runs the gate — the application cannot observe its peers.
