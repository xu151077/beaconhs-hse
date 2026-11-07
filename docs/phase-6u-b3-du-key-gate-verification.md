# Phase DU-2 — Server Action Key gate verification

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Call-chain trace

### CI

1. `.github/workflows/ci.yml` step "Test deployment host safeguards" runs
   `scripts/ci/verify-server-action-key-gate.test.sh`. This exercises the gate's
   manifest/log/compare paths against two independent keys and asserts no key material
   in stdout/stderr. A failure fails the CI job.

### Deploy (pre-deploy)

2. `.github/workflows/deploy-dev.yml` step "Gate the image's Server Action key":
   - reads `secrets.DEV_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`;
   - runs `fingerprint --env` → only the 128-bit HMAC fingerprint is printed;
   - runs `image <image>@<digest> <expected>` against the pushed image;
   - the gate creates a container without starting it, copies
     `/app/apps/web/.next/server/server-reference-manifest.json`, extracts `encryptionKey`,
     computes its fingerprint, and compares;
   - on mismatch/missing/invalid it exits 1 or 2 and **stops the workflow** before
     migrations and before deployment;
   - persists only the fingerprint as `EXPECTED_SERVER_ACTION_KEY_FINGERPRINT`.

### Deploy (post-rollout)

3. After external readiness, step "Verify every web replica's Server Action key" runs
   `replicas <stack> <fingerprint>`:
   - waits up to 60 s for at least one running `<stack>_web` container;
   - for each container, forces `GET /api/health/ready` (which logs the key state once per
     process) and reads that container's own logs;
   - a task reporting "no runtime override" is accepted only because the image gate already
     proved the embedded key;
   - a task reporting "configuration fingerprint: X" must have X equal to the expected value;
   - any other outcome (no log line, unrecognised state, mismatch) exits 1 and fails the
     deployment.

### Application runtime

4. `apps/web/src/app/api/health/ready/route.ts` calls `assertServerActionKeyUsable` on a
   present runtime override and logs either "no runtime override" or
   "configuration fingerprint: …". An invalid override keeps the instance out of readiness.

## 2. Local verification

All commands run on the current tree; exit codes are process exit codes.

| #   | Scenario                                | Command / method                                | Result                |
| --- | --------------------------------------- | ----------------------------------------------- | --------------------- |
| 1   | Correct configuration passes            | `manifest` with matching expected               | PASS (harness 1)      |
| 2   | Replica key mismatch fails              | `manifest`/`compare` with a different key       | PASS (harness 2–3, 8) |
| 3   | Missing key fails                       | `manifest` without `encryptionKey`              | PASS (harness 4)      |
| 4   | Invalid key fails                       | `manifest` with `not-a-key`                     | PASS (harness 5)      |
| 5   | Rotation passes when all targets move   | `manifest` key two / expected two               | PASS (harness 7)      |
| 6   | Rollback to a mixed configuration fails | manifest one / expected two                     | PASS (harness 8)      |
| 7   | No plaintext key in output              | captures stdout/stderr, greps for both keys     | PASS (harness 13)     |
| 8   | Real image extraction and comparison    | `image` against `beaconhs:dr-mirror-51a899b7`   | PASS                  |
| 9   | Real image rejects a wrong fingerprint  | same image with `000…000`                       | PASS (exit 1)         |
| 10  | Workflow wiring contract                | `server-action-key-deployment-contract.test.ts` | PASS (8/8)            |
| 11  | Live workflow run                       | GitHub Actions                                  | NOT RUN               |
| 12  | Live multi-replica replica check        | running Swarm task                              | NOT RUN               |

Evidence:

- `scripts/ci/verify-server-action-key-gate.test.sh` → `1..13`, all 13 passed, exit 0.
- `pnpm --filter @beaconhs/web exec vitest run src/lib/server-action-key-deployment-contract.test.ts`
  → 8 passed, exit 0.
- Real image: a 32-hex fingerprint was computed from the image manifest; `image` passed with it
  and exited 1 with "fingerprint mismatch" for a wrong value. The temporary manifest was
  removed; no key was printed.

## 3. Multi-replica blocking logic review

- The gate accepts a task that uses the build-time key only because the pre-deploy image gate
  already proved that key. This is a deliberate two-stage design: the image gate is the proof,
  the replica gate is the consistency check.
- A task with a runtime override must log the expected fingerprint; otherwise the deployment
  fails.
- A mixed fleet (some tasks on the old key, some on the new) is detected because at least one
  task's fingerprint differs. The gate fails the deployment.
- The replica check runs **after** external readiness but **before** the job reports success, so a
  failure blocks the release notification. It does not roll traffic back automatically; rollback
  is an operator action.
- Single-node assumption: `replicas` uses the local container list. A future multi-node stack
  needs the task's node in the `docker exec` call.

## 4. Fail-closed review

- Missing build secret: `fingerprint --env` exits 2 (the TS script refuses an empty/invalid key).
- Invalid runtime override: readiness answers 503 and the instance is out of rotation.
- Missing manifest or key in the image: `image` exits 1.
- No log line from a task: `replica` exits 1.
- Empty/malformed expected fingerprint: `compare` exits 2.

No path was found that reports success on a missing, invalid, or mismatched key.

## 5. Leakage review

- The gate prints only the 128-bit HMAC fingerprint. The key is read from a 0600 file or from
  the environment and is never echoed.
- The harness captured stdout and stderr and grepped for both test keys; neither appeared.
- The temporary manifest and key files are removed on every exit path (including failure).
- The deploy workflow persists only the fingerprint in `$GITHUB_ENV`, not the key.

## 6. Conclusion

- The gate has real release-blocking capability on the pre-deploy path, and the consistency
  check is implemented and locally proven.
- Live workflow execution and the multi-replica replica check were **NOT RUN** because no
  push or deploy is permitted in this phase.
- W2: **PARTIAL**. See `docs/phase-6u-b3-dt-w2-key-gate.md` for the full design and risk list.
