# EA-65 — Ubuntu Server Docker Compose environment validation report

**Phase type:** read-only host investigation, Compose/manifest/registry checks,
isolated Compose trial, real Gate 5 runs and cleanup.
**No production deployment. No production Compose change. No `.env` change. No
database or object-store change. No workflow/CI change. No image publish. No
commit or push.**

**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)
**Target:** `beaconhs-drill` (`10.10.31.30`, user `ceshi`, hostname
`ceshi-Virtual-Machine`) — a **drill/test host**, not production.

---

## 1. Verdict

| Question                                            | Answer                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Is the target Ubuntu host confirmed and reachable?  | **YES** — Ubuntu 24.04.5 LTS, Docker Engine 29.9.2, Compose v5.6.1                               |
| Are Docker Engine and Compose usable on the target? | **YES** — daemon reachable, real containers created and inspected                                |
| Is the actual canonical Compose file confirmed?     | **YES** — byte-identical to the repository copy                                                  |
| Are the project name and service set confirmed?     | **YES** — `beaconhs-local-prod`, 8 services                                                      |
| Is manifest compatibility verified?                 | **PARTIAL** — structure matches; verifier contract does not (F-65-1, F-65-5)                     |
| Is the registry identity boundary clear?            | **YES** — but GHCR provenance is **NOT VERIFIED**                                                |
| Was an isolated Compose trial completed?            | **YES** — 8-service test project, real Gate 5 **PASS**                                           |
| Are Gate 5 real-run results fully evidenced?        | **YES for the isolated trial and negative probes**; canonical production Gate 5 **NOT VERIFIED** |
| Were test resources cleaned up?                     | **YES** — 0 EA-65 containers, networks, volumes, images or temp dirs                             |
| Were existing BeaconHS services affected?           | **NO**                                                                                           |
| Was production data accessed or modified?           | **NO**                                                                                           |
| Are the report and SHA-256 evidence complete?       | **YES** — see `docs/evidence/ea65/SHA256SUMS`                                                    |

### 1.1 Phase status

**EA-65: PARTIAL.**

The target host, Compose file, service set, isolated trial and cleanup are all
complete and evidenced. The phase is **not COMPLETE** because:

1. the shipped Gate 5 verifier cannot pass the canonical Compose file —
   **F-65-1** (pinned images) and **F-65-5** (missing deployment labels);
2. the canonical production Gate 5 was not run, because that would require
   starting the canonical production project, which EA-65 prohibits;
3. GHCR image provenance is **NOT VERIFIED** (no GHCR image, no credentials,
   anonymous registry returns 401);
4. the canonical external volumes are missing, so the canonical project cannot
   start without an operator creating/restoring them.

Per the exit-code contract, `NOT VERIFIED` outranks `PASS`: the isolated
test-image PASS does not upgrade the canonical deployment, the image source or
production.

### 1.2 Gate 5 result summary

| Scope                                                | Result                                |
| ---------------------------------------------------- | ------------------------------------- |
| Isolated 8-service test project on the Ubuntu target | **PASS** (exit 0)                     |
| Restart-loop negative control                        | **FAIL 3/3** (exit 1) — correct       |
| `flock` concurrency guard                            | **FAIL** (exit 1) — correct           |
| Pinned-image probe (F-65-1)                          | **FAIL** (exit 1) — defect reproduced |
| Missing-label probe (F-65-5)                         | **FAIL** (exit 1) — defect reproduced |
| Canonical `beaconhs-local-prod` deployment           | **NOT VERIFIED** — not deployed       |
| Canonical image source / GHCR                        | **NOT VERIFIED**                      |

---

## 2. Repository protection

Recorded before any EA-65 change (`docs/evidence/ea65/baseline.txt`):

| Item                                          | Value                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| Branch                                        | `hse-platform`                                                                 |
| HEAD                                          | `51a899b7aac0a942da327222a3eed355fca9798a`                                     |
| Modified / untracked / staged                 | 165 / 529 / 0                                                                  |
| `git diff --check`                            | exit 0                                                                         |
| EA-64 original evidence                       | 17/17 verified, exit 0                                                         |
| EA-64.1 remediation evidence                  | 15/15 verified, exit 0                                                         |
| Fixture suite                                 | 69/69, exit 0                                                                  |
| `deploy/gate5.manifest.yaml`                  | `33d9e6292fd22512deed2c2dce1abcdf3542123d005eb63357623370abb3d3ec` (unchanged) |
| `scripts/ci/reconcile-compose-digest.sh`      | `dbb6858e5aa2e8747934fb3ab1490994176377759fdb040c71231ef4277026d3` (unchanged) |
| `scripts/ci/compose-deployment-gate.test.mjs` | `7cad32c12a53d61f91945754ba6ac6eb219237e9afca5b795381f1e6dd8d893b` (unchanged) |

Only documentation and evidence were added under `docs/`. No business code,
Compose file, manifest, workflow, `turbo.json`, `.env`, database or object-store
content was modified. Nothing was committed or pushed.

---

## 3. Target host

Full inventory: `docs/evidence/ea65/environment-inventory.md`.

| Field                 | Value                                                           |
| --------------------- | --------------------------------------------------------------- |
| SSH alias / address   | `beaconhs-drill` / `10.10.31.30:22`                             |
| User / authentication | `ceshi`, key-based, `BatchMode=yes`                             |
| Hostname              | `ceshi-Virtual-Machine`                                         |
| OS                    | Ubuntu 24.04.5 LTS (Noble Numbat)                               |
| Kernel                | `7.0.0-42-generic`, `x86_64`                                    |
| Docker Engine         | 29.9.2, API 1.56 (minimum 1.40)                                 |
| containerd / runc     | 2.4.2 / 1.5.2                                                   |
| Docker Compose        | v5.6.1                                                          |
| Storage driver        | `overlayfs` (containerd snapshotter)                            |
| Swarm                 | `inactive`; manager `false`                                     |
| Docker context        | `default` (`unix:///var/run/docker.sock`); `DOCKER_HOST` unset  |
| Required tools        | `docker`, `flock`, `jq`, `sha256sum`, `curl` — all present      |
| Disk / memory         | 124 GB total, 21 GB available; 7,934 MB RAM, 6,473 MB available |

The local workstation (`test-Virtual-Machine`) runs the same versions but was
**not** used as the target. All target evidence came from the SSH host above.

### 3.1 Pre-existing state (unchanged)

| Resource         | Observation                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Compose projects | `beaconhs-drill-20261009` (`exited(9)`), `beaconhs-phase-aj` (`exited(9), running(1)`), `beaconhs-phase-cd` (`created(5)`) |
| Containers       | 26 total, including the local registry and one unrelated stopped container                                                 |
| Networks         | 3 project networks + `bridge`, `host`, `none`                                                                              |
| Volumes          | drill/phase-aj project volumes + 2 anonymous volumes                                                                       |
| Local registry   | `beaconhs-drill-registry` (`registry:2`, `127.0.0.1:5000`, Up)                                                             |

No `beaconhs-local-prod` containers and no `beaconhs-hse_*` volumes existed.

---

## 4. Actual Compose configuration

Full results: `docs/evidence/ea65/compose-configuration-results.md`.

### 4.1 Files and hashes

| File                                                                 | SHA-256                                                            | Role                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| `/home/ceshi/beaconhs-phase-aj/deploy/local-production.compose.yaml` | `0337d38eab280b1abb1541dbe394c8e08f21565cf419a4f7fd0798b535be1f36` | canonical production-shaped file; **not deployed** |
| `/home/ceshi/beaconhs-phase-cd/compose.yaml`                         | `0a7197a23c6ab350915e539280087839806ead6a25e1ccc498e86cdb0ad121aa` | active drill projects                              |
| `/home/ceshi/beaconhs-phase-aj/deploy/drill-20261009.compose.yaml`   | `164e528fa6f93617227763b25a97d77cc2f2a35e90b4ac0207ad884ea8bc0dfb` | older drill project                                |

The repository `deploy/local-production.compose.yaml` has the **same SHA-256**
as the target canonical copy. There is no overlay and no extra `-f` file. The
target `.env` contains no `COMPOSE_FILE` or `COMPOSE_PROJECT_NAME` line; the
canonical file declares `name: beaconhs-local-prod` itself.

### 4.2 Canonical service set

`docker compose config --services` returns exactly:

```
web, worker, scheduler, storage-init, postgres, redis, minio, collabora
```

The project has **0 containers**. The file declares three **external** volumes:

| External name                | State       |
| ---------------------------- | ----------- |
| `beaconhs-hse_postgres-data` | **MISSING** |
| `beaconhs-hse_redis-data`    | **MISSING** |
| `beaconhs-hse_minio-data`    | **MISSING** |

Because they are external, `docker compose up` would fail before creating a
container until they exist. No attempt was made to create them.

### 4.3 Active host projects are not canonical

`beaconhs-phase-cd` uses 10 services (adds `aj-gateway` and `mailpit`), different
project name, different images, different ports, different volumes and a
**missing `worker` healthcheck**. `beaconhs-drill-20261009` uses a third mix.
They are drill/test configurations and are not evidence about the canonical
deployment.

`--no-interpolate` is supported by Compose v5.6.1 (exit 0). The target `.env`
exists but its values were never printed or copied; environment reporting was
redacted to key names.

---

## 5. Manifest compatibility

Full results: `docs/evidence/ea65/manifest-compatibility-results.md`.
**The manifest was not modified.**

The structural contract matches the canonical file: project name, 8 services,
required services, gated vs pinned classification, healthcheck presence and
one-shot roles. Two runtime-contract defects remain.

### 5.1 F-65-1 — verifier ignores `image: pinned`

`deploy/gate5.manifest.yaml:56-79` marks `postgres`, `redis`, `minio` and
`collabora` as `image: pinned`, meaning “the reference in the compose file”.
The verifier parses `SVC_IMAGE[$role]` but never uses it; every container is
compared to the single gated `EXPECTED_REF`
(`scripts/ci/reconcile-compose-digest.sh:651-657`). A pinned upstream image can
therefore never pass.

Real target proof: an isolated 8-service project with `postgres:16-alpine` (and
the other services on the gated alpine digest) returned:

```
VERDICT: FAIL
REASON: postgres container 62fa9d53dcd5 was created from 'postgres:16-alpine', expected 'alpine@sha256:294b683c…'
exit 1
```

The canonical file uses `postgres:16-alpine`, `redis:7-alpine`, a MinIO digest
and a Collabora digest, so the canonical deployment would fail at the first
pinned service.

The fixture suite did not catch this because `healthyFleet()` models all eight
services on the same expected image; the pinned path is untested.

### 5.2 F-65-5 — canonical Compose carries no deployment labels

The EA-62/EA-63 design requires every service to carry
`com.beaconhs.deployment`, `com.beaconhs.image-digest` and
`com.beaconhs.role`. The verifier enforces the first two on every container
(`scripts/ci/reconcile-compose-digest.sh:643-648`). The canonical
`deploy/local-production.compose.yaml` has **no `labels:` block at all**, and no
in-repo deployment script or override adds one.

Real target proof: the same 8-service alpine project with all label blocks
removed returned:

```
VERDICT: FAIL
REASON: postgres container 56429262e878 was created by deployment '<none>', not 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-6500000004-1'
exit 1
```

All eight containers were healthy or exited 0 and ran the correct digest; only
the labels were absent. Even after F-65-1 is fixed, Gate 5 cannot pass the
canonical file until the deployment path injects these labels.

### 5.3 Other findings

- **F-65-2:** the three canonical external volumes are missing (see §4.2).
- **F-65-3:** the active host projects are drill configurations, not the
  canonical deployment; `beaconhs-phase-cd` has a `worker` health mismatch and
  two extra services.
- **F-65-4:** GHCR provenance is unverified (see §6).

---

## 6. Registry identity

Full results: `docs/evidence/ea65/registry-identity-results.md`.

| Check                                      | Result                                                           |
| ------------------------------------------ | ---------------------------------------------------------------- |
| GHCR image present on target               | **NO**                                                           |
| Docker auth config entries                 | **none**                                                         |
| Anonymous `https://ghcr.io/v2/`            | **HTTP 401**                                                     |
| Local registry catalog                     | only `beaconhs-drill/minio`                                      |
| Local registry OCI index digest            | `sha256:b187417eee0a…`; matches the local image ID/`RepoDigests` |
| Local registry index platforms             | `linux/amd64` + `unknown/unknown`                                |
| Locally built `beaconhs:phase-ea16-…`      | `RepoDigests` synthesised from the local image ID                |
| GHCR source / signature / build provenance | **NOT VERIFIED**                                                 |

`RepoDigests` is not treated as registry-source evidence. The local registry
consistency check is local only. No pull, push, login, tag or publish was
performed. The Gate 5 image-source check for the canonical deployment therefore
remains **NOT VERIFIED**, not PASS.

---

## 7. Isolated Gate 5 trial

Full results: `docs/evidence/ea65/gate5-runtime-results.md`.

### 7.1 Positive control

| Field         | Value                                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| Project       | `beaconhs-ea65-20261030t065255z`                                                 |
| Image         | `alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6` |
| Deployment ID | `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-6500000001-1`                          |
| Services      | 8, one container each                                                            |
| Verdict       | **PASS**, exit 0                                                                 |

All eight containers carried the correct digest and deployment ID, had
`RestartCount=0`, the five required healthchecks were `healthy`, and
`scheduler`/`storage-init` exited 0. The verifier’s post-pass re-read found no
container replacement. This proves the verifier mechanics on the target Ubuntu
host with real Docker and Compose.

### 7.2 Negative controls

| Probe                                    | Project                                  | Result                                          |
| ---------------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| `flock` contention                       | PASS project                             | **FAIL**, exit 1 — “another deployment holds …” |
| Restart loop (`restart: always`, exit 1) | `beaconhs-ea65-crash-20261030t065335z`   | **FAIL 3/3**, exit 1; `RestartCount` 5, 5, 6    |
| Pinned image (F-65-1)                    | `beaconhs-ea65-shipped-20261030t065353z` | **FAIL**, exit 1 at `postgres:16-alpine`        |
| Missing labels (F-65-5)                  | `beaconhs-ea65-nolabel-20261030t070059z` | **FAIL**, exit 1 — deployment `<none>`          |

The restart-loop rule from EA-64.1 is live: non-zero `RestartCount` is a
terminal FAIL, not a PASS.

### 7.3 Canonical deployment

The canonical `beaconhs-local-prod` project was **not started**. Starting it
would be a production deployment and is prohibited. Its external volumes are
also missing. The canonical Gate 5 is therefore **NOT VERIFIED**.

---

## 8. Cleanup

Full results: `docs/evidence/ea65/cleanup-inventory.md`.

All four EA-65 projects were removed with
`docker compose … down -v --remove-orphans`; temp directories were deleted with
`find … -depth -delete`. No `docker system prune`, `docker volume prune` or
`docker network prune` was run.

Post-cleanup state:

```
containers_total=26
ea65_containers=0
ea65_networks=0
ea65_volumes=0
```

The 26 containers match the pre-EA-65 inventory. The three pre-existing Compose
projects, the local registry, all pre-existing networks/volumes and the
`beaconhs-phase-*` / `beaconhs-drill-*` resources are unchanged. No image was
built, pulled, published or removed.

---

## 9. Validation gates

Run locally on the repository after the EA-65 documentation and evidence were
written. Each gate was captured with its own exit code.

| Gate      | Command                                       | Result                                                              | Cached       |
| --------- | --------------------------------------------- | ------------------------------------------------------------------- | ------------ |
| Format    | `pnpm format:check`                           | **exit 0** — all matched files use Prettier style                   | n/a          |
| Typecheck | `pnpm typecheck --force`                      | **exit 0** — 27/27 tasks                                            | **0 cached** |
| Lint      | `pnpm lint --force`                           | **exit 0** — 1/1 task                                               | **0 cached** |
| Dead code | `pnpm deadcode:check`                         | **exit 0** — no findings                                            | n/a          |
| Tests     | `pnpm turbo run test --force --concurrency=1` | **exit 0** — 25/25 tasks; web 2,118 passed / 9 skipped; no failures | **0 cached** |
| Build     | `pnpm build --force`                          | **exit 0** — 4/4 tasks                                              | **0 cached** |

DB-backed tenant-isolation and storage-freeze scenarios were **skipped**, not
passed, because `SEED_TEST_SCRATCH_DATABASE_URL` is not set in this environment.
That is recorded as an environment limitation; no test was disabled or skipped
by this change.

`git diff --check` also returned exit 0.

---

## 10. Findings register

| ID         | Finding                                                                                                                                                                                                                                             | Severity                         | Status                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| **F-65-1** | Gate 5 verifier ignores `image: pinned`; every container must equal the gated `EXPECTED_REF`. Canonical `postgres`/`redis`/`minio`/`collabora` are pinned, so the canonical deployment cannot pass.                                                 | **Blocker for canonical Gate 5** | Recorded; **not fixed in EA-65** — requires verifier + fixture change and a re-run    |
| **F-65-2** | Canonical external volumes `beaconhs-hse_postgres-data`, `beaconhs-hse_redis-data`, `beaconhs-hse_minio-data` are missing on the target.                                                                                                            | **Environment readiness**        | Recorded; not created (would touch production data)                                   |
| **F-65-3** | Active host projects (`beaconhs-phase-aj`, `beaconhs-phase-cd`, `beaconhs-drill-20261009`) are drill configurations, not the canonical deployment. `beaconhs-phase-cd` has 10 services, different images/ports/volumes and no `worker` healthcheck. | **Evidence boundary**            | Recorded; not modified                                                                |
| **F-65-4** | GHCR provenance is unverified: no GHCR image, no auth, anonymous 401. Local `RepoDigests` are not registry-source proof.                                                                                                                            | **Image-source boundary**        | Recorded; Gate 5 image source remains NOT VERIFIED                                    |
| **F-65-5** | Canonical Compose has no `com.beaconhs.deployment` / `com.beaconhs.image-digest` labels; the verifier requires both on every container.                                                                                                             | **Blocker for canonical Gate 5** | Recorded; **not fixed in EA-65** — requires a deployment-label mechanism and a re-run |

F-65-1 and F-65-5 are code/contract defects, not Compose-file defects. They must
not be “fixed” by editing the manifest or weakening the verifier. The correct
follow-up is a separately authorized change to the verifier and its fixtures,
plus a decision on how the canonical deployment injects labels, followed by a
fresh Gate 5 validation.

---

## 11. Acceptance criteria mapping

| #   | Criterion                              | Result                                                                     |
| --- | -------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Target Ubuntu host confirmed           | **PASS** — `beaconhs-drill`, Ubuntu 24.04.5                                |
| 2   | Docker Engine and Compose available    | **PASS** — 29.9.2 / v5.6.1, real runs                                      |
| 3   | Actual Compose file confirmed          | **PASS** — canonical hash matches repo; active drill files identified      |
| 4   | Project name and service set confirmed | **PASS** — `beaconhs-local-prod`, 8 services                               |
| 5   | Manifest compatibility verified        | **PARTIAL** — structure matches; F-65-1 and F-65-5 block runtime           |
| 6   | Registry identity boundary clear       | **PASS** — boundary documented; GHCR provenance NOT VERIFIED               |
| 7   | Isolated trial completed or justified  | **PASS** — 8-service test project, real Gate 5 PASS                        |
| 8   | Gate 5 real-run evidence complete      | **PASS for isolated/probes**; canonical production Gate 5 **NOT VERIFIED** |
| 9   | Test resources cleaned up              | **PASS** — 0 EA-65 artefacts                                               |
| 10  | Existing BeaconHS services unaffected  | **PASS** — pre-existing inventory unchanged                                |
| 11  | Production data not accessed/modified  | **PASS** — no DB/object-store access                                       |
| 12  | Report and SHA-256 complete            | **PASS** — this report + `docs/evidence/ea65/SHA256SUMS`                   |

Because criteria 5 and 8 are not fully satisfied for the canonical deployment,
the phase verdict is **PARTIAL**, not COMPLETE.

---

## 12. Status ledger (unchanged)

| Item                      | Status                                            |
| ------------------------- | ------------------------------------------------- |
| Real GitHub Actions       | **NOT RUN**                                       |
| Real GHCR                 | **NOT VERIFIED**                                  |
| Real Ubuntu deployment    | **NOT VERIFIED**                                  |
| Production                | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION** |
| A1–A8                     | **PENDING AUTHORIZATION**                         |
| Rollback                  | **FAIL — NO EXECUTABLE ROLLBACK PATH**            |
| Migration 51              | **NOT RUN**                                       |
| DB / object-store restore | **NOT RUN**                                       |
| WOPI                      | **Paused**                                        |

EA-65 does not start EA-66, does not wire CI, does not change the deployment
path and does not deploy production.

---

## 13. What remains

1. **Separate authorization** to fix F-65-1 (honour `image: pinned`) and F-65-5
   (inject/require the deployment labels) in the verifier, its fixtures and the
   deployment path.
2. Re-run the canonical Gate 5 on the target after those fixes, with the
   canonical external volumes created or restored under an approved data
   procedure.
3. Real GHCR provenance and signature verification remain **NOT VERIFIED** until
   credentials and published images exist.
4. Real GitHub Actions and real Ubuntu production deployment remain **NOT RUN /
   NOT VERIFIED**.
5. Production remains **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**.

---

## 14. Evidence index

All paths are relative to the repository root.

| File                                                   | Contents                                                 |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `docs/evidence/ea65/environment-inventory.md`          | host, Docker, Compose, tools, pre-existing state         |
| `docs/evidence/ea65/compose-configuration-results.md`  | actual files, project/service set, volumes, ports        |
| `docs/evidence/ea65/manifest-compatibility-results.md` | field-by-field manifest comparison, F-65-1, F-65-5       |
| `docs/evidence/ea65/registry-identity-results.md`      | GHCR/local-registry boundary, `RepoDigests` limits       |
| `docs/evidence/ea65/gate5-runtime-results.md`          | isolated PASS, lock, crash, pinned/label probes          |
| `docs/evidence/ea65/cleanup-inventory.md`              | created/removed resources, final inventory               |
| `docs/evidence/ea65/raw/`                              | raw target output, Compose/manifest files, verifier JSON |
| `docs/evidence/ea65/SHA256SUMS`                        | SHA-256 of every evidence file except itself             |

Verify the evidence set from the repository root:

```bash
cd docs/evidence/ea65 && sha256sum -c SHA256SUMS
```
