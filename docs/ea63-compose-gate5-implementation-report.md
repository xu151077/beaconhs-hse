# EA-63 — Compose Gate 5 implementation

**Phase type:** implementation of an independent verifier, its trusted manifest
and a fixture suite. **No deployment path was switched. No server was contacted.
Nothing was deployed.**

**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. What was built

| File                                               | Status | Purpose                                                                                   |
| -------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `deploy/gate5.manifest.yaml`                       | new    | trusted expectation: project, eight services, counts, one-shot flags, health, image class |
| `scripts/ci/reconcile-compose-digest.sh`           | new    | Compose Gate 5 verifier (658 lines)                                                       |
| `scripts/ci/compose-deployment-gate.test.mjs`      | new    | 37 fixture tests (556 lines)                                                              |
| `docs/ea63-compose-gate5-implementation-report.md` | new    | this report                                                                               |
| `docs/evidence/ea63/*`                             | new    | inventory, test results, control mapping, hashes                                          |

**No existing file was modified.** The Swarm reconciler, the Dokploy workflow,
`ci.yml`, `turbo.json`, business code and every EA-56…EA-62 artefact are
byte-identical to the baseline (§9).

---

## 2. Exit-code contract

The brief's table is authoritative and differs from EA-62 §6.1, which had
`2 = malformed` and `3 = NOT VERIFIED`. This implementation follows the brief:

| Status                  | Exit | Emitted line            |
| ----------------------- | ---- | ----------------------- |
| `PASS`                  | 0    | `VERDICT: PASS`         |
| `FAIL`                  | 1    | `VERDICT: FAIL`         |
| `NOT VERIFIED`          | 2    | `VERDICT: NOT VERIFIED` |
| usage / parameter error | 3    | `VERDICT: USAGE ERROR`  |

**Deviation recorded:** EA-62 §6.1 assigned 2 to a malformed harness input and 3
to `NOT VERIFIED`; EA-63's brief swaps them. The brief wins because it is the
implementation contract. A malformed _manifest_ is `NOT VERIFIED` (2), matching
EA-62's rule that an untrustworthy expectation cannot produce a verdict; only
bad CLI arguments are 3.

`NOT VERIFIED` always outranks `PASS`: the verifier has no path that reaches
`PASS` while a required fact is missing.

---

## 3. How each requirement is implemented

### EA63-CHG-01 — trusted manifest

`deploy/gate5.manifest.yaml`. Strict YAML subset (top-level keys, `services:`,
two mapping levels). The parser rejects tabs, unknown keys, unknown fields,
duplicate services, bad indentation and non-integer counts — all as
`NOT VERIFIED`, never ignored.

Values are validated per field: `required`/`one_shot` booleans, `containers` a
positive integer, `health` `required|none`, `image` `gated|pinned`, `exit_code`
0-255 and required **iff** `one_shot: true`.

The manifest is not derived from anything running. It is the only input that can
detect a missing service.

### EA63-CHG-02 — verifier

`scripts/ci/reconcile-compose-digest.sh`. Order of operations:

1. argument validation (exit 3 on defect);
2. manifest parse and semantic validation (exit 2);
3. manifest project vs `--project` (exit 2);
4. dependency checks: `docker`, `jq`, `flock` (exit 2 if absent);
5. host lock (`flock -n`), contention → `FAIL`;
6. `docker compose version`, `docker info` (exit 2);
7. `docker compose config --no-interpolate --format json` → project name,
   service set and healthcheck presence must match the manifest (exit 2);
8. `docker image inspect repo@D` → `I_exp` (exit 2 if absent);
9. convergence loop: `docker ps` by project label → batch `docker inspect` →
   evaluate; `PENDING` conditions retry until the deadline;
10. on pass: snapshot, re-list, re-inspect, compare → replacement is
    `NOT VERIFIED`.

### EA63-CHG-03 — image identity

Three independent facts per container, all required:

```
.Config.Image == <image>@<digest>      (digest-pinned reference)
.Image        == I_exp                 (image ID resolved from that reference)
label com.beaconhs.image-digest == digest
```

`RepoDigests` is read for the record and never used in a verdict; an empty value
does not fail a complete three-way match (T08). A tag fails (T29). A local image
ID is never compared to a registry digest. If `repo@D` cannot be resolved
locally, the run is `NOT VERIFIED` (T33) — no fallback to "the container looks
fine".

### EA63-CHG-04 — deployment identity

Labels, exactly as EA-62 specified:

```
com.beaconhs.deployment=<40-hex sha>-<run id>-<attempt>
com.beaconhs.image-digest=<digest>
com.beaconhs.role=<role>
```

The `--deployment-id` format is enforced (exit 3 otherwise). Every container
must carry this run's value; a historical container fails (T07, T13, T14). This
is the mechanism that closes EA-61 G-61-1.

### EA63-CHG-05 — concurrency and atomicity

- `flock -n` on the lock path; a second run is refused immediately (T19), never
  queued.
- `--lock-fd <n>` supports a caller that already holds the lock; the fd must be
  open.
- The poll `sleep` runs with the lock fd closed, so a signalled gate cannot
  leave a child holding the lock (T37).
- Batch `docker inspect` gives a single-moment snapshot; after a pass the set,
  image and `StartedAt` are re-read and compared (T18).
- 600 s default deadline; expiry is `FAIL` with the last reasons (T20).

---

## 4. Test results

`node --test scripts/ci/compose-deployment-gate.test.mjs` → **37 tests, 37
passed, 0 failed, 0 skipped, exit 0**.

The twenty required scenarios (T01-T20) and seventeen boundary cases (T21-T37)
are tabulated with expected/actual verdicts in
`docs/evidence/ea63/fixture-test-results.md`.

Highlights:

- the S12-class defect cannot recur: a missing rostered service is `FAIL` (T02);
- a historical one-shot cannot satisfy this deployment (T13);
- empty `RepoDigests` does not fail a complete identity match (T08);
- a tag is rejected even when the image ID happens to match (T29);
- malformed Docker JSON and duplicate container records are `NOT VERIFIED`
  (T27, T28);
- a container replaced mid-verification is `NOT VERIFIED`, not `FAIL` (T18).

**These are fixture tests.** No Docker daemon, Compose deployment or Ubuntu host
was involved. They prove decision logic, not real Docker output shapes.

### 4.1 Real, non-fixture observations (local only)

Two read-only runs against the local Docker daemon:

1. With the real `deploy/local-production.compose.yaml`, the gate passed every
   drift check (project name, eight services, healthcheck presence) and returned
   `NOT VERIFIED` because the expected image is not present on this workstation.
2. With a real local image and no containers for the project, it returned
   `FAIL` — "project 'beaconhs-local-prod' has no containers".

These prove the real `docker compose config`, `docker image inspect` and
`docker ps` paths work. They are **local environment observations**, not
Compose deployment verification.

---

## 5. Gates

| Gate                                                      | Result                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| `node --test scripts/ci/compose-deployment-gate.test.mjs` | 37/37, exit 0                                                     |
| `pnpm format:check`                                       | exit 0                                                            |
| `pnpm typecheck --force`                                  | exit 0 — 27/27, `Cached: 0`                                       |
| `pnpm lint --force`                                       | exit 0 — 1/1, `Cached: 0`                                         |
| `pnpm deadcode:check`                                     | exit 0                                                            |
| `pnpm turbo run test --force --concurrency=1`             | exit 0 — 25/25, `Cached: 0`, 3857 passed / 101 skipped / 0 failed |
| `pnpm build --force`                                      | exit 0 — 4/4, `Cached: 0`                                         |
| `git diff --check`                                        | exit 0                                                            |

`--force` is used deliberately: a cache replay is not a verification. The
existing Swarm suite and the EA-56/EA-58 suites were run unchanged.

### 5.1 Full suite and build

The forced serial suite ran 25/25 tasks with `Cached: 0` and finished
3857 passed / 101 skipped / 0 failed (exit 0). The forced production build ran
4/4 tasks with `Cached: 0` (exit 0). No gate result in this report is a Turbo
cache replay. Raw output is in `/tmp/opencode/ea63/gate-*.log`; the summary is
`docs/evidence/ea63/local-validation.log`.

### 5.2 Defects found and fixed during implementation

Both were caught by the fixture suite before the phase ended; neither survived
into the delivered code.

| Defect                                                                                                                                                                   | Effect                                                                                                                                                                                                                                                                                                      | Fix                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `docker inspect` fields were joined with a tab and read with `IFS=$'\t'`. Bash collapses consecutive whitespace delimiters, so an empty label shifted every later field. | A container with an empty `image-digest` label was diagnosed as having a deployment label equal to its `StartedAt`; a container with no compose-service label was reported as an unregistered service. Both still failed, but for the wrong reason — and a future field could have been misread as a match. | Fields are joined with `\u001f` (unit separator, non-whitespace) and read with `IFS=$'\x1f'`. |
| The test stub used `jq '.flag // true'`, and jq's `//` treats `false` as absent.                                                                                         | `info_ok: false` produced `true`, so the daemon-unreachable test passed when it should have failed.                                                                                                                                                                                                         | Stub uses `.flag != false` / `.flag == true`.                                                 |

The second is a test-harness bug; the first was a real verifier bug that the
tests exposed. Recorded here because "the suite is green" would otherwise hide
that the verifier had to be corrected to get there.

---

## 6. What was not done

| Item                                       | Reason                                                   |
| ------------------------------------------ | -------------------------------------------------------- |
| Switching the deploy workflow              | out of scope for EA-63                                   |
| Wiring the new suite into `ci.yml`         | `ci.yml` is protected; the suite is runnable directly    |
| Removing the Dokploy/Swarm path            | must coexist until EA-66                                 |
| Running the gate against a real deployment | no host access                                           |
| Isolated Docker Compose verification       | not executed; would require creating a throwaway project |
| Any migration, deploy, rollback or restore | forbidden                                                |

---

## 7. Residual risks

| Risk                                                                                         | Status                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture shapes may differ from real `docker inspect` output                                  | open; EA-64                                                                                                                                                                                        |
| `docker compose config --no-interpolate --format json` depends on the host's Compose version | open; EA-65                                                                                                                                                                                        |
| Manifest and compose file can drift                                                          | mitigated: hard `NOT VERIFIED` (T30-T32)                                                                                                                                                           |
| The gate is not yet wired into any pipeline                                                  | by design; EA-66                                                                                                                                                                                   |
| A forged deployment label plus a matching image ID requires daemon control                   | accepted; daemon access is already root-equivalent                                                                                                                                                 |
| `--lock-fd` trusts the caller to hold the lock                                               | documented contract, not enforced                                                                                                                                                                  |
| Worker healthcheck assumption                                                                | resolved against the file: the compose file defines one (line 132), so `health: required` is correct. The brief's statement that worker has no healthcheck does not match the file; the file wins. |

---

## 8. Deliverables

| File                                               | Contents                             |
| -------------------------------------------------- | ------------------------------------ |
| `docs/ea63-compose-gate5-implementation-report.md` | this report                          |
| `docs/evidence/ea63/implementation-inventory.md`   | files, fields, line numbers          |
| `docs/evidence/ea63/fixture-test-results.md`       | 20 scenarios + 17 boundary tests     |
| `docs/evidence/ea63/security-control-mapping.md`   | each control → implementation → test |
| `docs/evidence/ea63/local-validation.log`          | gate commands and results            |
| `docs/evidence/ea63/SHA256SUMS`                    | integrity of the above               |

---

## 9. Repository state

```
branch: hse-platform
head:   51a899b7aac0a942da327222a3eed355fca9798a   (unchanged)
status: 165 modified, 527 untracked, 0 staged
git diff --check: exit 0
```

Baseline was 165 modified / 523 untracked. The four new untracked entries are
exactly the files this phase created:

| New path                                           | Type     |
| -------------------------------------------------- | -------- |
| `deploy/gate5.manifest.yaml`                       | manifest |
| `scripts/ci/reconcile-compose-digest.sh`           | verifier |
| `scripts/ci/compose-deployment-gate.test.mjs`      | tests    |
| `docs/ea63-compose-gate5-implementation-report.md` | report   |

`docs/evidence/ea63/` sits inside the already-untracked `docs/evidence/` tree, so
it does not add a separate entry. The modified count is unchanged because no
existing file was edited.

Hashes of the protected files, identical to the baseline:

| File                                     | SHA256 (prefix)    |
| ---------------------------------------- | ------------------ |
| `scripts/ci/reconcile-running-digest.sh` | `18b7e94a51c2adca` |
| `.github/workflows/deploy-dev.yml`       | `cffd9bf1081449bc` |
| `.github/workflows/ci.yml`               | `212e07169c0614b2` |
| `turbo.json`                             | `a244a31b4c1a1e0a` |

## 10. Status (unchanged)

| Item                        | Status                                          |
| --------------------------- | ----------------------------------------------- |
| Real GitHub Actions         | `NOT RUN`                                       |
| Real GHCR                   | `NOT VERIFIED`                                  |
| Real Ubuntu deployment      | `NOT VERIFIED`                                  |
| Isolated Docker Compose     | `NOT RUN`                                       |
| Compose Gate 5 (real)       | `NOT VERIFIED`                                  |
| Production                  | `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION` |
| A1–A8                       | `PENDING AUTHORIZATION`                         |
| Rollback                    | `FAIL — NO EXECUTABLE ROLLBACK PATH`            |
| Migration 51                | `NOT RUN`                                       |
| DB / object storage restore | `NOT RUN`                                       |
| WOPI                        | paused                                          |

**This phase does not represent a successful Ubuntu deployment, a production
approval, or a verified Gate 5 on any real host.**

---

## 11. Stop

EA-63 ends here. EA-64 was not started and the deployment workflow was not
switched.
