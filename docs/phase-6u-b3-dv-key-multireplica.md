# Phase DV-2 — Server Action Key multi-replica verification

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Gate call chain (reviewed)

1. **Image gate (pre-deploy)** — `deploy-dev.yml` computes the expected fingerprint from
   `secrets.DEV_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, then runs
   `verify-server-action-key-gate.sh image <image>@<digest> <expected>`. A non-zero exit stops
   the workflow before migrations and before deployment.
2. **Deploy** — migrations run, the compose stack is redeployed.
3. **External readiness** — the workflow polls `/login` until a healthy response.
4. **Replica gate (post-rollout)** — `verify-server-action-key-gate.sh replicas <stack> <expected>`
   waits up to 60 s for a running `<stack>_web` container, forces `GET /api/health/ready` on
   each, and inspects that container's own logs. A task using the build-time key is accepted
   (the image gate already proved it); a task with a runtime override must log the expected
   fingerprint; anything else fails the deployment.
5. **Failure behaviour** — a failure exits 1 and the deploy job does not report success. It does
   not roll traffic back automatically; rollback is an operator action.

## 2. Local verification performed

| Scenario                                | Method                                            | Result                   |
| --------------------------------------- | ------------------------------------------------- | ------------------------ |
| Consistent configuration passes         | harness `manifest`/`compare`                      | PASS (scenarios 1, 7)    |
| Replica key mismatch fails              | harness `manifest`/`compare` with a different key | PASS (scenarios 2, 3, 8) |
| Missing key fails                       | `manifest` without `encryptionKey`                | PASS (scenario 4)        |
| Invalid key fails                       | `manifest` with `not-a-key`                       | PASS (scenario 5)        |
| Rotation passes when all targets move   | `manifest` key two / expected two                 | PASS (scenario 7)        |
| Rollback to a mixed configuration fails | manifest one / expected two                       | PASS (scenario 8)        |
| No plaintext key in output              | captures stdout/stderr, greps for both keys       | PASS (scenario 13)       |
| Real image extraction and comparison    | `image` against `beaconhs:dr-mirror-51a899b7`     | PASS                     |
| Real image rejects a wrong fingerprint  | same image with `000…000`                         | PASS (exit 1)            |
| Workflow wiring                         | `server-action-key-deployment-contract.test.ts`   | PASS (8/8)               |

Evidence:

- `scripts/ci/verify-server-action-key-gate.test.sh` → `1..13`, all 13 passed, exit 0.
- Real image: a 32-hex fingerprint was computed from the image manifest; `image` passed with it
  and exited 1 with "fingerprint mismatch" for a wrong value. The temporary manifest was
  removed; no key was printed.

## 3. Multi-replica result

**MULTI-REPLICA NOT RUN.**

No isolated multi-container environment was available. The `replicas` mode requires running
containers labelled `com.docker.swarm.service.name=<stack>_web` that expose
`/api/health/ready` and emit the `[server-action-key]` log line. Creating such a setup would
require either deploying the app image (with its database, Redis, storage, and auth
dependencies) or building a synthetic responder; both are outside the safe scope of this phase
and would risk the shared host. The `replicas` parser and comparator were exercised through
the `log` mode in the harness, but not against a live container.

## 4. Conclusion

- The gate's blocking capability is proven on the pre-deploy path and its logic is proven by
  the harness.
- The multi-replica runtime check remains **NOT RUN**. W2: **PARTIAL**.
