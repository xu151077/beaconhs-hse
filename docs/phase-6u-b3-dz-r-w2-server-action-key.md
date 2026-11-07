# Phase DZ-R — W2: Server Action Key gate and multi-replica consistency

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Implementation reviewed

- `scripts/ci/verify-server-action-key-gate.sh` — `fingerprint` / `image` / `manifest` / `log` /
  `replica` / `replicas` / `compare`; exit 0 pass, 1 mismatch or not-ready, 2 configuration error.
- `scripts/ci/verify-server-action-key-gate.test.sh` — 13 isolated scenarios.
- `.github/workflows/ci.yml` — the shell test runs in the "Test deployment host safeguards" step.
- `.github/workflows/deploy-dev.yml` — "Gate the image's Server Action key" (pre-migration,
  pre-deploy) and "Verify every web replica's Server Action key" (post-rollout).
- `apps/web/src/lib/server-action-key-deployment-contract.test.ts` — 8 workflow-wiring assertions.
- Readiness boundary: `apps/web/src/app/api/health/ready/route.ts` →
  `assertServerActionKeyUsable`, logging either "no runtime override" or
  "configuration fingerprint: …".

## 2. Script and contract tests (local)

| Command                                                                                             | Result              | Exit |
| --------------------------------------------------------------------------------------------------- | ------------------- | ---- |
| `scripts/ci/verify-server-action-key-gate.test.sh`                                                  | 13/13 checks passed | 0    |
| `pnpm --filter @beaconhs/web exec vitest run src/lib/server-action-key-deployment-contract.test.ts` | 8 passed            | 0    |

## 3. Multi-replica verification on the isolated stack

Environment: `beaconhs:dxr-20261020` (`79db4885b1fb`), built from this working tree with
`DEPLOYMENT_VERSION=51a899b7…` and a host-generated 44-byte test key. Two web replicas
(`dxr-web-1` on 13010, `dxr-web-2` on 13011) both labelled
`com.docker.swarm.service.name=dxr_web` so the gate discovers them exactly as it would
discover Swarm tasks.

Expected fingerprint: derived on the host from the image's own
`server-reference-manifest.json` using `HMAC-SHA256(decoded key, "beaconhs:server-action-key:fingerprint:v1")`
truncated to 128 bits. The computation was cross-checked against the repository's own TypeScript
implementation (`verify-server-action-key-consistency.ts --print`) and **matched exactly**
(`FINGERPRINTS_MATCH`).

| #   | Scenario                                   | Command                                                      | Observed                                                                                                                                                                                                                   | Exit |
| --- | ------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Both replicas on the same (build-time) key | `gate.sh replicas dxr <fp>`                                  | "instance uses the verified build-time key" ×2, "all 2 web task(s) match the expected key"                                                                                                                                 | 0    |
| 2   | One replica on a different runtime key     | `gate.sh replicas dxr <fp>`                                  | "fingerprint mismatch: the target does not hold the expected key"                                                                                                                                                          | 1    |
| 3   | Consistent configuration restored          | `gate.sh replicas dxr <fp>`                                  | "all 2 web task(s) match the expected key"                                                                                                                                                                                 | 0    |
| 4   | Invalid runtime key on one replica         | `gate.sh replicas dxr <fp>`                                  | readiness **503** with "[server-action-key] NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is not a valid base64-encoded AES key (16, 24, or 32 bytes). The instance is not ready for traffic." then "web task … did not report ready" | 1    |
| 5   | No runtime override (missing runtime key)  | `gate.sh replicas dxr <fp>`                                  | both replicas fall back to the image's build-time key, already proven by the image gate; readiness 200                                                                                                                     | 0    |
| 6   | Key material in logs                       | `docker logs` of web1/web2/worker grepped for both test keys | `plaintext_key_hits=0` for every container                                                                                                                                                                                 | n/a  |

The mismatched replica logged `configuration fingerprint: c104dec41bdfd3bc3b93f0be7ad965e8`,
which differs from the expected fingerprint — the fingerprint is observable, the key is not.

**Behaviour of a missing runtime key is by design** (the deployed dev stack runs on the
build-time key, which the pre-deploy image gate proves). An _invalid_ runtime key fails closed:
the instance refuses readiness and the gate fails.

## 4. Call chain verification

- Pre-deploy: the image gate runs before migrations and before the deploy step, and a non-zero
  exit stops the workflow.
- Post-rollout: the replica gate runs after external readiness and before the job reports
  success; a mismatch fails the deployment.
- The gate is the same code path exercised in scenario 2–4 above; the workflow wiring is pinned
  by the 8 contract assertions.

**Not proven here**: GitHub Actions has not executed the deploy workflow, and no Swarm stack was
rolled. The gate's _logic_ and _blocking behaviour_ are proven against real containers; the
_workflow execution_ remains unobserved.

## 5. Status

**W2: PARTIAL.** The multi-replica gate is now proven against two live application replicas
(pass, fail, restore, invalid, missing, no-leakage). It is still not proven inside the real
deploy workflow, and CI has not run.
