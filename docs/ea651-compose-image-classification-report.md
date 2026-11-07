# EA-65.1 — Compose gated/pinned image classification and deployment identity report

**Phase type:** targeted fix for F-65-1 and F-65-5; manifest and canonical
Compose redesign; fixture and real Docker/Compose validation.
**No production deployment. No workflow/CI change. No database or object-store
change. No GHCR publish. No commit, push or PR.**

**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. Verdict

| Question                                          | Answer                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Is F-65-1 closed?                                 | **YES** — gated and pinned are separate identity namespaces, verified by fixtures and real Docker                                                      |
| Is F-65-5 closed?                                 | **YES** — all eight canonical services carry deployment/digest/role labels; the verifier checks the rendered Compose config and the running containers |
| Are gated image rules still strict?               | **YES** — digest-pinned only, exact approved digest, image ID, label, deployment and role                                                              |
| Do pinned images have independent identity?       | **YES** — manifest `expected_image` + `expected_digest`, own image ID and digest label; never compared to the gated ref                                |
| Do all services have deployment identity labels?  | **YES** — canonical rendered config shows all 8                                                                                                        |
| Are one-shot tasks tied to this deployment?       | **YES** — same deployment label, exit code and one-shot state checked                                                                                  |
| Did real isolated Docker/Compose validation pass? | **YES** — 6/6 local real tests; 4-service PASS on the drill Ubuntu host                                                                                |
| Did EA-63 / EA-64.1 regression pass?              | **YES** — 93/93 fixture tests, including the original 69 and the real EA-64 samples                                                                    |
| Are existing user changes preserved?              | **YES** — HEAD unchanged, staged 0, no reset/clean/restore/checkout                                                                                    |
| Is evidence hashed?                               | **YES** — `docs/evidence/ea651/SHA256SUMS`                                                                                                             |

### 1.1 Phase status

**EA-65.1: COMPLETE** for the requested code/contract scope.

The phase does **not** claim that the canonical production deployment passes
Gate 5. The target still has the pre-EA-65.1 Compose copy, the canonical external
volumes are missing, the target MinIO image is not under the manifest's
repository name, and no GHCR provenance exists. Those are separate recorded
boundaries (F-65-2/F-65-3/F-65-4), not reasons to leave F-65-1/F-65-5 open.

| Status                      | Value                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| Canonical production Gate 5 | **NOT VERIFIED** — not deployed; target file is older; MinIO ref not local |
| Real BeaconHS gated image   | **NOT VERIFIED** — test image only                                         |
| GHCR provenance / signature | **NOT VERIFIED**                                                           |
| Production                  | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**                          |
| Rollback                    | **FAIL — NO EXECUTABLE ROLLBACK PATH**                                     |
| Real GitHub Actions         | **NOT RUN**                                                                |
| Real Ubuntu deployment      | **NOT VERIFIED**                                                           |
| A1–A8                       | **PENDING AUTHORIZATION**                                                  |
| Migration 51                | **NOT RUN**                                                                |
| DB / object-store restore   | **NOT RUN**                                                                |
| WOPI                        | **Paused**                                                                 |

---

## 2. Repository protection

| Item                               | Value                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------- |
| Branch                             | `hse-platform`                                                          |
| HEAD                               | `51a899b7aac0a942da327222a3eed355fca9798a`                              |
| Staged                             | 0                                                                       |
| Modified                           | 165 (same count as the EA-65 baseline)                                  |
| Untracked                          | 532; deploy/verifier files were already untracked EA-63/EA-64 artifacts |
| `git diff --check`                 | exit 0                                                                  |
| Forbidden git operations           | none used                                                               |
| Business code / workflows / `.env` | not modified                                                            |
| `turbo.json`                       | not modified                                                            |
| EA-56…EA-65 evidence               | not deleted                                                             |

The deploy and verifier files in §3 were **already untracked** in this working
tree before EA-65.1 (EA-63/EA-64 artifacts, never committed). Their content was
updated in place. `docs/project-development-state.md` is the only tracked file
modified. No new file was staged or committed.

---

## 3. What changed

| File                                               | SHA-256           | Change                                                                                                            |
| -------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `scripts/ci/reconcile-compose-digest.sh`           | `a184d4fd…7c654c` | Separate gated/pinned identities; rendered Compose config; per-service role/digest checks; strict manifest parser |
| `scripts/ci/compose-deployment-gate.test.mjs`      | `5eb476f5…c26d7a` | Updated fixtures; 24 new EA-65.1 tests; 93 total                                                                  |
| `scripts/ci/compose-deployment-gate.real.test.mjs` | `70286e38…e8953`  | New real Docker/Compose test suite (6 tests)                                                                      |
| `deploy/gate5.manifest.yaml`                       | `6bc70fa0…dd1ab`  | Explicit role/class/expected-image/digest/count/exit/label fields                                                 |
| `deploy/local-production.compose.yaml`             | `9700f480…082db`  | Digest-pinned postgres/redis/minio/collabora; deployment/digest/role labels on all 8 services                     |

No business code, workflow, `.env`, database, object-store, `turbo.json` or
target host file was modified.

---

## 4. F-65-1 — gated/pinned classification

### 4.1 Gated

A gated service is validated against the run's approved identity:

```
EXPECTED_REF = <--image>@<--digest>
```

The verifier checks the rendered Compose image, the container `Config.Image`,
the container `Image` (resolved ID), the digest label, the deployment label and
the role label. A tag, a different digest or a missing image is never accepted.
A missing gated image is `NOT VERIFIED`; a mismatch on a running container is
`FAIL`.

### 4.2 Pinned

A pinned service is validated against its **own** manifest identity:

```
expected_image@expected_digest
```

The reference is never compared to the gated `EXPECTED_REF`. The verifier
rejects a tag-only or unresolved pinned reference, rejects a pinned reference
that equals the gated reference, requires the pinned image to resolve locally,
and checks the container image ID, `Config.Image`, digest label, deployment
label and role label.

`postgres` and `redis` were tag-only in the previous Compose file; both are now
digest references. `minio` and `collabora` were already digest references.

### 4.3 Manifest strictness

The manifest now declares, for every service: `role`, `image_class`,
`expected_container_count`, `required`, `one_shot`, `health`,
`deployment_label_required`, `image_digest_label_required`, and for pinned
services `expected_image`/`expected_digest`. Gated services must not declare
expected image/digest fields. Duplicate keys, duplicate fields, unknown fields,
invalid indentation, tag-only pinned refs, missing pinned digests, a role that
differs from the service name, a gated service with pinned fields, or a service
that opts out of labels all return `NOT VERIFIED`.

The service mapping key is the service identity; `role` is explicit and must
equal it. The roster is never generated from the running fleet.

Full table: `docs/evidence/ea651/manifest-classification.md`.

---

## 5. F-65-5 — deployment identity labels

Every canonical service now carries:

```yaml
labels:
  com.beaconhs.deployment: '${BEACONHS_DEPLOYMENT_ID:?…}'
  com.beaconhs.image-digest: '${BEACONHS_IMAGE_DIGEST:?…}' # gated
  com.beaconhs.role: '<role>'
```

Pinned services use their own literal digest for `image-digest`. The deployment
ID is required with `:?`; there is no `:-` default and no hard-coded value.
Changing it changes every service's Compose config hash, so Compose recreates
the containers.

The verifier renders the Compose file with the deployment environment and
checks every service's image and three labels **before** inspecting containers,
then re-checks the labels on every running container. An unresolved `${…}`, a
missing label or a wrong label is `NOT VERIFIED` or `FAIL`, never a pass.

Verified Compose v5.6.1 behaviour:

- deployment ID A and B produce different labels on all 8 services;
- removing `BEACONHS_DEPLOYMENT_ID` makes `docker compose config` exit 1;
- the canonical render has all 8 services with all three labels.

Full design: `docs/evidence/ea651/deployment-label-design.md`.

---

## 6. Canonical Compose configuration

The repository `deploy/local-production.compose.yaml` renders to project
`beaconhs-local-prod` with 8 services:

```
web, worker, scheduler, storage-init, postgres, redis, minio, collabora
```

The render has:

- gated `web`/`worker`/`scheduler`/`storage-init` on the approved image;
- pinned `postgres`/`redis`/`minio`/`collabora` on their own digests;
- all three labels on every service;
- healthchecks matching the manifest;
- `restart: 'no'` for the two one-shot services;
- one project network and three external volume names.

Full values: `docs/evidence/ea651/raw/canonical-repo-config.json`.
Automated comparison: `docs/evidence/ea651/raw/canonical-verify.txt`
(`failures=0`).

A verifier run against the repository canonical file, using a present test
gated image, passed the manifest/Compose/image preflight and reached the runtime
stage; it returned `FAIL: project 'beaconhs-local-prod' has no containers`
because the canonical project was deliberately not started. This is recorded in
`docs/evidence/ea651/raw/canonical-verifier-boundary.txt`. It is not a
deployment PASS.

The target's copy is **older** and was not modified; its rendered config is
kept only as drift evidence. The canonical project was not started.

---

## 7. Real Docker / Compose validation

### 7.1 Local Ubuntu

`node --test scripts/ci/compose-deployment-gate.real.test.mjs` → **6/6 PASS**,
no skips. The suite starts a real isolated project with gated `alpine` and
pinned `postgres`, checks a PASS, then proves deployment-ID mismatch, gated
digest mismatch, deployment-ID config change, missing-variable refusal and
missing role label.

### 7.2 Drill Ubuntu host

Independent project `beaconhs-ea651-target-20261030t073808z` on
`beaconhs-drill` (Ubuntu 24.04.5, Docker 29.9.2, Compose v5.6.1) returned
**PASS**, exit 0, with four containers:

- gated `web`, `worker`, `scheduler`;
- pinned `postgres@sha256:721873c3…`;
- all `RestartCount=0`, correct deployment ID, role and per-service digest
  labels; one-shot `scheduler` exited 0.

Raw: `docs/evidence/ea651/raw/target-real/verifier.json`,
`inspect.json`, `run.txt`.

Cleanup: the first `compose down` attempt omitted the interpolation variables
and left 4 containers/1 network/1 volume temporarily. They were removed by exact
project-label/name filters; final `ea651` counts are 0/0/0. Both the failed and
fixed cleanup outputs are retained for honesty. No global prune was run.

---

## 8. Tests and gates

| Gate / suite                                                                       | Result                                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Fixture suite (`node --test scripts/ci/compose-deployment-gate.test.mjs`)          | **93/93**, exit 0                                     |
| Real Docker suite (`node --test scripts/ci/compose-deployment-gate.real.test.mjs`) | **6/6**, exit 0, 0 skipped                            |
| EA-63 / EA-64.1 regression                                                         | Included in the 93; all original scenarios still pass |
| `pnpm format:check`                                                                | exit 0                                                |
| `pnpm typecheck --force`                                                           | exit 0 — 27/27, `Cached: 0`                           |
| `pnpm lint --force`                                                                | exit 0 — 1/1, `Cached: 0`                             |
| `pnpm deadcode:check`                                                              | exit 0                                                |
| `pnpm turbo run test --force --concurrency=1`                                      | exit 0 — 25/25, `Cached: 0`                           |
| `pnpm build --force`                                                               | exit 0 — 4/4, `Cached: 0`                             |
| `git diff --check`                                                                 | exit 0                                                |

The DB-backed tenant-isolation/storage-freeze tests remain **skipped** because
`SEED_TEST_SCRATCH_DATABASE_URL` is not set; they were not counted as passes.
The EA-64 real fixtures predate the role-label requirement, so the regression
adds the role label in memory while preserving every captured image/state field;
this is documented in the test file.

Raw gate logs: `docs/evidence/ea651/raw/gates/`;
fixture results: `docs/evidence/ea651/raw/fixture-results.txt`;
real results: `docs/evidence/ea651/raw/real-docker-results.txt`.

---

## 9. F-65-2 / F-65-3 / F-65-4

These are **recorded, not fixed**, as required.

| ID           | Status                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F-65-2**   | Canonical external volumes `beaconhs-hse_postgres-data`, `beaconhs-hse_redis-data`, `beaconhs-hse_minio-data` are still missing on the target; no volume was created |
| **F-65-3**   | The target's active projects remain drill configurations, not the canonical 8-service deployment; no target project was changed                                      |
| **F-65-4**   | GHCR provenance/signature remains **NOT VERIFIED**; no GHCR login, pull, push or publish; `RepoDigests` is not used as source proof                                  |
| Target drift | The target still has the pre-EA-65.1 `local-production.compose.yaml`; no deployment or target file change                                                            |

The code does not assume these are fixed. A canonical Gate 5 on the current
target would return `NOT VERIFIED` at the MinIO pinned preflight and would still
be blocked by the missing volumes.

---

## 10. Residual risks

| Risk                         | Status                                                                  |
| ---------------------------- | ----------------------------------------------------------------------- |
| Canonical production Gate 5  | **NOT VERIFIED** — not deployed; target file older; MinIO ref not local |
| Real BeaconHS image identity | **NOT VERIFIED** — test image only                                      |
| GHCR provenance/signature    | **NOT VERIFIED**                                                        |
| Pinned upstream provenance   | **NOT VERIFIED** — local image ID + manifest digest only                |
| Target canonical volumes     | Missing (F-65-2)                                                        |
| Target canonical file drift  | Present; not modified                                                   |
| Rollback                     | **FAIL — NO EXECUTABLE ROLLBACK PATH**                                  |
| Production                   | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**                       |

No control was weakened to obtain a PASS.

---

## 11. What remains

1. EA-66 (separate authorization) must deploy the new Compose file and set
   `BEACONHS_DEPLOYMENT_ID`, `BEACONHS_IMAGE`, `BEACONHS_IMAGE_DIGEST` in the
   deployment environment.
2. Create/restore the canonical external volumes under an approved data
   procedure (F-65-2).
3. Resolve the MinIO image reference on the target (local registry vs
   `minio/minio@…`) and verify all pinned images resolve (F-65-4 boundary).
4. Real GHCR provenance/signature remains **NOT VERIFIED** until published
   images and credentials exist.
5. Do not start EA-66 from this phase; do not wire CI; do not deploy.

---

## 12. Evidence index

| File                                                 | Contents                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `docs/evidence/ea651/manifest-classification.md`     | per-service class/ref/digest table and strict parser rules |
| `docs/evidence/ea651/deployment-label-design.md`     | label mechanism and verified Compose behaviour             |
| `docs/evidence/ea651/compose-config-results.md`      | canonical render, labels, health, restart, volumes         |
| `docs/evidence/ea651/gated-image-results.md`         | gated rules, fixture/real results, GHCR boundary           |
| `docs/evidence/ea651/pinned-image-results.md`        | pinned rules, fixture/real results, MinIO boundary         |
| `docs/evidence/ea651/deployment-identity-results.md` | preflight/runtime label checks and one-shot association    |
| `docs/evidence/ea651/real-docker-test-results.md`    | local 6/6 and drill-host PASS                              |
| `docs/evidence/ea651/security-control-mapping.md`    | requirement → control → proof matrix                       |
| `docs/evidence/ea651/raw/`                           | fixture/real logs, canonical config, target PASS, cleanup  |
| `docs/evidence/ea651/SHA256SUMS`                     | hash of every evidence file except itself                  |

Verify:

```bash
cd docs/evidence/ea651 && sha256sum -c SHA256SUMS
```
