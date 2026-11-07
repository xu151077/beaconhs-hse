# EA-62 — BeaconHS Docker Compose deployment architecture correction

**Phase type:** read-only architecture review, design and test planning.
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

**No business code, workflow or deployment file was modified. Nothing was
deployed, migrated, rolled back or restored. No server was contacted.**

---

## 1. Architecture conclusion

The target deployment is **Ubuntu Server + Docker Engine + Docker Compose** on a
single host. The repository does not yet implement that target: its deploy
workflow is built around **Dokploy + Docker Swarm**, and its Gate 5 can only
speak Swarm.

The repository already contains the correct Compose model, unused by CI:

| File                                   | Model                                                                                         | Status                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `deploy/dokploy-dev.compose.yaml`      | Swarm stack (24 `deploy.*` keys, external networks, `dokploy-mgr` placement)                  | the one the workflow uses — **wrong for the target** |
| `deploy/local-production.compose.yaml` | plain Compose (`name:`, `restart:`, healthchecks, loopback publish, one-shot `restart: 'no'`) | **correct model, not wired into CI**                 |

`deploy/local-production.compose.yaml:1-13` already states the distinction, in
the repository's own words:

> `deploy/dokploy-dev.compose.yaml` is NOT this file. That one is a remote Docker
> SWARM stack for Dokploy … On a single local host with Swarm inactive and
> neither network present, `deploy.restart_policy` is ignored (it is Swarm-only)
> and no host port is ever published.

**The correction is therefore a transport migration, not a redesign of the
security model.** Every control that is not tied to Swarm or Dokploy survives
unchanged.

---

## 2. Evidence base

| Fact                                                              | Source                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Deploy job runs on `[self-hosted, dokploy]`                       | `.github/workflows/deploy-dev.yml:147`                                               |
| Dokploy split-DNS step                                            | `:182-213`                                                                           |
| `compose.one` target resolution (`.serverId == null`, `.appName`) | `:219-288`                                                                           |
| Pre-pull "onto the swarm manager"                                 | `:293-312`                                                                           |
| Collabora restart via `docker service update --force`             | `:383-400`                                                                           |
| `compose.update` with `composeType: "stack"`                      | `:405-499`                                                                           |
| `compose.deploy`                                                  | `:501-515`                                                                           |
| `docker service update` rollout                                   | `:517-530`                                                                           |
| Per-replica key gate on Swarm labels                              | `:571-576`, `scripts/ci/verify-server-action-key-gate.sh:271-311`                    |
| Gate 5 on `docker service ls/inspect/ps`                          | `:596-625`, `scripts/ci/reconcile-running-digest.sh:117-252`                         |
| Swarm-only compose keys                                           | `deploy/dokploy-dev.compose.yaml:57-66, 111-117, 162-168, 194-200, 213-222, 250-256` |
| Compose-native definition                                         | `deploy/local-production.compose.yaml:58, 85-118, 163-195`                           |
| Build → digest chain                                              | `deploy-dev.yml:96-107, 126-139, 150`, `scripts/ci/promote-verified-image.sh`        |
| Dokploy helper + CI wiring                                        | `scripts/cluster/dokploy-curl.sh`, `.github/workflows/ci.yml:112`                    |
| No `docker compose` deploy anywhere in CI                         | `grep -rn "docker compose" .github/workflows/` → no match                            |

Full inventory: `docs/evidence/ea62/architecture-inventory.md`.

### 2.1 Evidence classes

| Class                           | What it covers                                                             |
| ------------------------------- | -------------------------------------------------------------------------- |
| `STATIC CONFIGURATION EVIDENCE` | everything in §2 and the inventory                                         |
| `LOCAL ENVIRONMENT OBSERVATION` | EA-60/EA-61 test runs on this workstation                                  |
| `ISOLATED TEST`                 | EA-60 25/25, EA-61 realistic-shape 7/7 (about the Swarm gate, not Compose) |
| `REAL UBUNTU SERVER`            | **none**                                                                   |
| `PRODUCTION`                    | **none**                                                                   |

No static fact is presented as runtime evidence. "The workflow intends a Swarm
stack" and "a Swarm stack is running" remain different claims; the second is
`NOT VERIFIED` and, per the phase premise, is not even the target.

---

## 3. Incompatible assumptions

34 items classified in `docs/evidence/ea62/incompatible-assumptions.md`.

| Class           | Count | Meaning                                                                                                                                                     |
| --------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KEEP**        | 11    | valid as-is (origin check, build identity, policy gate, promotion, readiness, migrations, prune, tests, roster concept, fail-closed rules, Compose file, …) |
| **REPLACE**     | 16    | same control, different mechanism (service discovery/inspect/ps, replicas, identity, one-shot, Gate 5, rollout, key gate, runner label, roster source, …)   |
| **REMOVE**      | 5     | Dokploy API path; `DOKPLOY_*` secrets; `dokploy-dev.compose.yaml`; `dokploy-curl.sh` + test + `ci.yml:112`; the Swarm-only `deploy.*` keys                  |
| **INVESTIGATE** | 2     | whether the host uses the file verbatim or an overlay; whether its Compose honours `deploy.replicas` (only relevant if scaling)                             |

The eight functions the brief names:

| Function                                               | Fate        |
| ------------------------------------------------------ | ----------- |
| Deployment management (Dokploy)                        | **REMOVE**  |
| Service discovery (`docker service ls`)                | **REPLACE** |
| Service config verification (`docker service inspect`) | **REPLACE** |
| Task status (`docker service ps`)                      | **REPLACE** |
| Replica verification (Swarm replicas)                  | **REPLACE** |
| Image identity (service spec digest)                   | **REPLACE** |
| One-shot tasks (completed task)                        | **REPLACE** |
| Gate 5 (Dokploy/Swarm)                                 | **REPLACE** |

**What is not deleted:** the control order, the digest chain, the roster concept,
the fail-closed verdicts, the readiness gate, the migrations step, and both
regression suites. Removing Dokploy does not imply removing the controls that
were merely _hosted_ next to it.

---

## 4. Recommended Compose Gate 5

Full specification: `docs/evidence/ea62/compose-gate5-design.md`.

### 4.1 Shape

```
trusted manifest (deploy/gate5.manifest.yaml)
   ⇅ must agree with  docker compose config --format json
expected digest  repo@D
   → docker image inspect repo@D → I_exp
   → per container: .Image == I_exp  ∧  .Config.Image == repo@D  ∧  label digest == D
```

Three independent facts per container. None alone is sufficient; the design
states why for each.

### 4.2 Trusted manifest

A reviewed file lists project name, services, required/optional, expected
container count, one-shot or long-running, health requirement and exit code. It
is **not** derived from the running fleet — that is the EA-59 S12 defect.

Drift is a hard `NOT VERIFIED`: if the manifest's service set or project name
disagrees with `docker compose config`, neither is trusted.

### 4.3 Deployment identity

Every service carries `com.beaconhs.deployment=<sha-runid-attempt>`,
`com.beaconhs.image-digest=<D>` and `com.beaconhs.role=<role>`.

Two consequences, both load-bearing:

- a changed label forces Compose to recreate the container, so no service can
  silently keep a pre-deployment container;
- a one-shot container carrying this run's label was necessarily created by this
  run — **EA-61 G-61-1 is closed by construction**, without timestamps.

### 4.4 Verdicts

`PASS` / `FAIL` / `NOT VERIFIED` with `NOT VERIFIED` outranking `FAIL`; exit
codes 0/1/2/3. Twenty conditions are enumerated with their verdict in §6 of the
design. Readiness is recorded and never consulted for identity. A mutable tag
fails. `RepoDigests` is corroboration only.

### 4.5 Atomicity

Host `flock` around deploy + verify; batch `docker inspect` snapshot with a
post-check re-read; 600 s convergence deadline; failure leaves the failed
deployment labelled and visible. No blue/green, no distributed lock, no
Swarm-style update config — each omission is justified in the design.

---

## 5. Test coverage

`docs/evidence/ea62/test-matrix.md` — all 20 required scenarios, each mapped to
the level that can prove it:

| Level                              | Scenarios                              | Proves                                                         |
| ---------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| Fixture (`docker` stub)            | 1–16, 18, 20                           | decision logic, verdict precedence, exit codes                 |
| Isolated Docker (this workstation) | 1–14, 16–20                            | real JSON shape, labels, health, restart, `flock`, replacement |
| Real Ubuntu host                   | 1 only (plus the whole suite as smoke) | the deployment actually runs the approved digest               |

Every EA-60 Swarm case has a Compose equivalent (§4 of the test matrix); none is
dropped. **The suite is designed, not implemented, and nothing was executed for
this phase.**

---

## 6. Implementation plan

Four phases, each independently reviewable. None is authorised yet.

| Phase     | Scope                                                                                                                                                                   | Needs                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **EA-63** | Implement `scripts/ci/reconcile-compose-digest.sh` + `deploy/gate5.manifest.yaml` + fixture suite (20 scenarios)                                                        | code authorisation              |
| **EA-64** | Isolated-Docker verification on a workstation: labels, health, restart loop, one-shot exit, `flock`, replacement                                                        | code + local Docker             |
| **EA-65** | Add a Compose deploy path alongside the existing one (not replacing it), with the host lock and the manifest check; dry-run on the Ubuntu host with a throwaway project | host access + approval          |
| **EA-66** | Switch the deploy workflow to Compose, remove the Dokploy path and `dokploy-dev.compose.yaml`, retarget the runner label                                                | change approval + rollback plan |

Ordering matters: the Compose gate must exist and pass its fixture suite before
the deploy path changes, otherwise the migration would temporarily have no
binding image-identity check.

---

## 7. Open issues

| #   | Issue                                                                        | Blocks                                         | Owner           |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------- | --------------- |
| 1   | No access to the Ubuntu host; every runtime fact is `NOT VERIFIED`           | EA-65 onward                                   | platform owner  |
| 2   | Whether the host runs `local-production.compose.yaml` verbatim or an overlay | manifest project/service set                   | platform owner  |
| 3   | Compose version on the host (`config --format json`, label interpolation)    | drift check                                    | platform owner  |
| 4   | `worker` has no healthcheck in `local-production.compose.yaml`               | `health: required` for worker                  | design decision |
| 5   | Registry credentials on the host for `--pull always`                         | deploy reliability                             | platform owner  |
| 6   | EA-61 G-61-1 (one-shot association)                                          | **closed by this design**, not yet implemented | EA-63           |
| 7   | EA-61 G-61-2 (stale `WRITER_REPLICAS=0` comment)                             | goes away with `dokploy-dev.compose.yaml`      | EA-66           |
| 8   | Rollback remains unimplemented                                               | production approval                            | separate phase  |

---

## 8. Risks and approvals

| Risk                                                  | Mitigation                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Manifest drifts from the compose file                 | hard `NOT VERIFIED` on disagreement (§2.1)                                    |
| A deployment is verified against a fleet that changed | snapshot + re-read; `NOT VERIFIED`                                            |
| Two deployments interleave                            | host `flock`; second run refused                                              |
| `compose up` returns before convergence               | health + restart count + 600 s deadline                                       |
| A tag sneaks in as the image reference                | `.Config.Image` must contain `@sha256:`                                       |
| The old Dokploy path is removed before Compose works  | phased plan: Compose path first, removal last                                 |
| Loss of Swarm's atomic convergence guarantee          | accepted; replaced by explicit checks, documented in the compatibility matrix |

**Approvals required before any of this is built:** code change authorisation
(EA-63), host access (EA-65), and change approval with a rollback plan (EA-66).
No approval exists for production deployment.

---

## 9. Status (unchanged)

| Item                                  | Status                                          |
| ------------------------------------- | ----------------------------------------------- |
| Real GitHub Actions                   | `NOT RUN`                                       |
| Real GHCR                             | `NOT VERIFIED`                                  |
| Real Ubuntu deployment                | `NOT VERIFIED`                                  |
| Compose Gate 5                        | `NOT VERIFIED`                                  |
| A1–A8                                 | `PENDING AUTHORIZATION`                         |
| Rollback                              | `FAIL — NO EXECUTABLE ROLLBACK PATH`            |
| Migration 51, DB/object-store restore | `NOT RUN`                                       |
| Production                            | `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION` |
| WOPI                                  | paused — not investigated                       |

---

## 10. Deliverables

| File                                                   | Contents                                                 |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `docs/ea62-compose-architecture-correction-report.md`  | this report                                              |
| `docs/evidence/ea62/architecture-inventory.md`         | what the repository actually contains, with line numbers |
| `docs/evidence/ea62/incompatible-assumptions.md`       | 34 items, KEEP/REPLACE/REMOVE/INVESTIGATE                |
| `docs/evidence/ea62/compose-gate5-design.md`           | the full Compose Gate 5 specification                    |
| `docs/evidence/ea62/test-matrix.md`                    | 20 scenarios, fixture vs isolated Docker vs real host    |
| `docs/evidence/ea62/ea56-ea61-compatibility-matrix.md` | every prior control and its fate                         |
| `docs/evidence/ea62/SHA256SUMS`                        | integrity of the above                                   |

---

## 11. Stop

EA-62 ends here. EA-63 was not started. Nothing was deployed, and this phase does
not represent a successful Ubuntu deployment or an approved production state.
