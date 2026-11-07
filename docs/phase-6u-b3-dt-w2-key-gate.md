# Phase DT-W2 — Server Action key consistency gate

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Verification target: **the current working tree**, not a clean checkout of HEAD. The tree
contains the pre-existing Phase CX/DS changes plus the DT changes listed below.

## 1. What the deployment actually uses

There are two key modes, and the gate handles both:

| Mode                     | Where the effective key comes from                                | Used by                                                                     |
| ------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Build-time (current dev) | `server-reference-manifest.json` embedded by the Docker build     | `deploy/dokploy-dev.compose.yaml` (no runtime override)                     |
| Runtime override         | `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` in the container environment | `deploy/local-production.compose.yaml` (required, must match the build key) |

Next.js 16.3.5 reads `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` first and otherwise
uses the manifest key. A **present but invalid** override silently replaces the valid build
key and breaks every Server Action with bound arguments. The readiness route already
refuses to report ready in that state; this phase adds the fleet-level gate.

## 2. Implementation

### 2.1 Gate script

New: `scripts/ci/verify-server-action-key-gate.sh`

- `fingerprint --env` / `fingerprint --key-file` reuse
  `apps/web/scripts/verify-server-action-key-consistency.ts`; only the 128-bit HMAC
  fingerprint is printed.
- `image <image> <expected>` creates a container without starting it, copies
  `/app/apps/web/.next/server/server-reference-manifest.json` out, extracts
  `encryptionKey`, and compares its fingerprint. A missing manifest or key fails.
- `manifest` and `log` expose the same comparison logic to isolated tests.
- `replica <container>` forces `GET /api/health/ready` on the task (which logs the key state
  once per process), then reads that task's own logs.
- `replicas <stack> <expected>` checks every running `<stack>_web` container.
- Exit codes: `0` pass, `1` mismatch/not-ready, `2` configuration/usage error.
- The key never appears in argv, stdout, stderr, or an artifact. The key file is `0600`,
  removed on every path; the manifest copy is removed too.

### 2.2 Deployment wiring

`.github/workflows/deploy-dev.yml` now has:

1. **Before migrations and before deployment**: compute the expected fingerprint from
   `secrets.DEV_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, verify the pushed image's embedded key,
   and persist only the fingerprint as `EXPECTED_SERVER_ACTION_KEY_FINGERPRINT`.
2. **After the rollout and after external readiness**: `replicas` checks every running web
   task. A task that uses the build-time key is accepted because the image gate already
   proved that key; a task with a runtime override must log the expected fingerprint.

Both steps run before the deploy job reports success. A mismatch stops the workflow.

`.github/workflows/ci.yml` now runs `scripts/ci/verify-server-action-key-gate.test.sh` in
the existing "Test deployment host safeguards" step, so the gate's behaviour is tested on
every CI run, not only when a deployment happens.

## 3. Acceptance results

All commands below were run on the current working tree. Exit codes are the process exit
codes (not a pipeline's).

| #   | Scenario                                     | Command                                         | Result                                                  |
| --- | -------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| 1   | Consistent key passes                        | `manifest` with matching expected               | **PASS** (harness check 1)                              |
| 2   | Replica key mismatch fails                   | `manifest`/`compare` with a different key       | **PASS** (harness checks 2–3, 8)                        |
| 3   | Missing key fails                            | `manifest` without `encryptionKey`              | **PASS** (harness check 4)                              |
| 4   | Invalid key fails                            | `manifest` with `not-a-key`                     | **PASS** (harness check 5)                              |
| 5   | Rotation passes when all targets move        | `manifest` with key two and expected two        | **PASS** (harness check 7)                              |
| 6   | Rollback to a mixed configuration fails      | manifest one with expected two                  | **PASS** (harness check 8)                              |
| 7   | No plaintext key in output                   | captures stdout/stderr and greps for both keys  | **PASS** (harness check 13)                             |
| 8   | Real image extraction and comparison         | `image` against `beaconhs:dr-mirror-51a899b7`   | **PASS**                                                |
| 9   | Real image rejects a wrong fingerprint       | same image with `000…000`                       | **PASS** (exit 1, mismatch)                             |
| 10  | Workflow actually contains the gate          | `server-action-key-deployment-contract.test.ts` | **PASS** (8/8)                                          |
| 11  | Live workflow run / live swarm replica check | GitHub Actions + running Swarm task             | **NOT RUN** — no push/deploy is permitted in this phase |

Evidence:

- `scripts/ci/verify-server-action-key-gate.test.sh` → `1..13`, all 13 checks passed, exit 0.
- `pnpm --filter @beaconhs/web exec vitest run src/lib/server-action-key-deployment-contract.test.ts`
  → 8 passed, exit 0.
- Real image gate: computed a 32-hex fingerprint from
  `beaconhs:dr-mirror-51a899b7`; `image` passed with the correct value and exited 1 with
  "fingerprint mismatch" for a wrong value. The temporary manifest was removed; no key was
  printed.

The image was built from the current HEAD during the earlier release work. It proves the
real Docker extraction path and the comparison. It does **not** prove that the image matches
the repository's production secret, because that secret is not available locally; the
workflow performs that comparison in CI.

## 4. Honest status

**W2: PASS for the gate implementation and the pre-deploy block; PARTIAL for end-to-end
workflow execution.**

- The pre-deploy gate has real release-blocking capability: a non-zero exit prevents the
  migration and deploy steps from running.
- The post-rollout replica check is implemented and its parser/comparator is exercised, but
  no live multi-replica rollout was run in this phase.
- No production configuration, secret, deployment, or container was changed. The only
  container interaction was `docker create`/`cp`/`rm` against a local image and `docker logs`
  is not available because no task was started.

## 5. Residual risks and follow-ups

1. **First real CI run.** The workflow wiring is statically asserted and the exact commands
   are exercised locally, but GitHub Actions has not executed this commit (the branch is
   local and unpushed). The first push must be watched for the two gate steps.
2. **Single-node assumption.** `replicas` uses the local Docker container list. The current
   dev stack is a single-node Swarm; a future multi-node stack needs the task's node in the
   `docker exec` call.
3. **Rollout overlap.** The current stack runs one web replica. If `WRITER_REPLICAS` is
   raised, a rolling update can briefly mix old and new keys unless the deploy uses
   stop-first ordering. The post-rollout gate catches the mixed state and fails the
   deployment, but it cannot prevent the brief overlap. This is a design decision for the
   scale-out work, not a defect in the gate.
4. **Runtime override mode.** The dev stack deliberately uses the embedded build-time key.
   `local-production.compose.yaml` uses the runtime override; the gate supports it, but that
   compose stack was not launched in this phase.
5. **Secret rotation.** Rotating the build secret rebuilds the image; the gate compares the
   new image to the new secret. Rotating a runtime override without rebuilding is safe only
   if every replica receives the same value; the post-rollout gate enforces that.
