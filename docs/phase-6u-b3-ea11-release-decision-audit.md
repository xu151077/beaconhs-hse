# Phase EA-11 — Release decision audit and change-scope convergence

Date: 2026-10-22
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

Read-only audit. No commit, push, fetch, pull, PR, GitHub call, deploy, rollback,
production/`phase-aj`/Drill contact, or WOPI investigation was performed. The
historical full test suite was not re-run; this phase only read the existing
evidence, performed read-only state checks, and ran the formatting gate after its
own documentation edits.

---

## 0. Verdict

| Question                                             | Verdict                                                    | Boundary                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Local release candidate (EA-1 … EA-10 at `51a899b7`) | **PASS**                                                   | Every locally testable item, with EA-10's final gate run as the latest executed suite. EA-11 adds no code. |
| Conditional deployment (an authorised target)        | **CONDITIONAL — NOT AUTHORISED BY THIS PHASE**             | The local evidence supports a controlled deployment only after the preconditions and authorisations in §5. |
| Production release approval                          | **NOT GRANTED**                                            | Real deploy, real rollback, production restore, multi-node Swarm, GHCR/GHA and WORM are all NOT RUN.       |
| Real deployment                                      | **NOT RUN**                                                | No target was contacted.                                                                                   |
| Real rollback                                        | **NOT RUN**                                                | Only the local EA-8 drill exists.                                                                          |
| Production database restore                          | **NOT RUN**                                                | Only disposable local restores exist.                                                                      |
| Production object-store restore                      | **NOT RUN**                                                | Only local MinIO round trips exist.                                                                        |
| Real multi-node Swarm                                | **NOT RUN**                                                | The replica contract is tested; the topology is not.                                                       |
| GHCR / GitHub Actions cache path                     | **NOT RUN**                                                | Workflows are uncommitted and have never executed this worktree.                                           |
| WORM / object-lock restore                           | **NOT RUN**                                                | Code-level assurance only.                                                                                 |
| WOPI frozen re-open                                  | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED` | Not re-opened, by owner decision.                                                                          |

**These three labels are not interchangeable.** A local release candidate pass is
evidence that the locally testable contract is sound. Conditional deployment is a
permission state: it requires explicit target, window, rollback and risk-owner
authorisation. Production release approval is a business decision backed by a
real deployment, a real rollback, a production restore drill and the operational
gates. EA-11 grants none of the last two.

### 0.1 Evidence attribution

EA-10's final gate run is the latest executed test suite at this HEAD. EA-11 makes
no code changes; it adds this report and updates the working-state document.
Consequently:

- the EA-10 results remain attributable to the same code state;
- they are **not** relabelled as an EA-11 execution;
- EA-11's own checks are the read-only checks and the formatting gate listed in
  §7.

---

## 1. Baseline (Phase A)

Read directly from the working tree, not from an earlier report.

| Item                   | Actual value                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                 | `hse-platform`                                                                                                                                                                      |
| HEAD                   | `51a899b7aac0a942da327222a3eed355fca9798a`                                                                                                                                          |
| Staged                 | 0                                                                                                                                                                                   |
| Tracked modified       | 155                                                                                                                                                                                 |
| Untracked              | 475 `git status` entries (the convention used by all EA reports; `git status` collapses wholly untracked directories — `git ls-files` expands them to 865 files before this report) |
| Tracked diff           | 155 files changed, 5282 insertions(+), 1927 deletions(-)                                                                                                                            |
| Ahead of `origin/main` | 45 commits                                                                                                                                                                          |
| Deleted entries        | None                                                                                                                                                                                |
| `.env`                 | Ignored by `.gitignore:13`; unchanged mtime `2026-10-09 14:12:40`; no production hostnames                                                                                          |
| Docker Swarm           | Inactive; this node is not a swarm manager                                                                                                                                          |
| Running containers     | Only the five local dev services: Postgres, Redis, MinIO, Mailpit, Collabora, up 7 days                                                                                             |
| Dev database           | 50 migration-ledger rows; tenants `demo` and `phase-bs-isolated`; no `ea*` roles                                                                                                    |
| Dev databases          | `beaconhs` and the pre-existing `beaconhs_al_scratch`                                                                                                                               |
| Redis                  | `db9` = 0 keys; only `db0` is populated                                                                                                                                             |
| MinIO buckets          | `beaconhs-dev` and the pre-existing `phase-bs-isolated`; no `ea*` bucket                                                                                                            |

Every EA-1 … EA-10 report names the same HEAD, `51a899b7aac0a942da327222a3eed355fca9798a`.

### 1.1 Count reconciliation

The current counts reconcile exactly with the last phase:

- EA-9 ended at **154 modified / 471 untracked**.
- EA-10 added four untracked files: `scripts/ci/replica-coverage.mjs`,
  `scripts/ci/replica-coverage.test.mjs`, `docs/backup-restore-runbook.md` and
  `docs/phase-6u-b3-ea10-encrypted-restore-readiness.md`.
- EA-10 also modified `scripts/cluster/restore-verify.sh`, the only tracked-file
  increase from 154 to 155.
- The result is the observed **155 / 475**. No unexplained file appears.
- This report adds one untracked file, so the close state is **155 / 476**
  (475 before the report itself).

The earlier working-state document said 154 / 474. That figure was stale: it was
written before the EA-10 report and the `restore-verify.sh` change. It is
corrected in `docs/project-development-state.md` as part of this phase.

---

## 2. Evidence index (EA-1 … EA-10)

### 2.1 Permissions, RLS and cross-tenant isolation

| Item           | Evidence                                                                                                                                                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reports        | `docs/phase-6u-b3-ea2-local-acceptance.md` §1 and §3; `docs/phase-6u-b3-ea3-file-lifecycle-freeze.md` §10; `docs/phase-6u-b3-ea4-pdf-version-key-gate.md` §10; `docs/phase-6u-b3-ea10-encrypted-restore-readiness.md` §2                                                                                                            |
| What ran       | W1 scratch-database isolation guard and fail-closed proof (EA-2); legal/unauthorised/cross-tenant delete and replace (EA-3); freeze write denial over real HTTP, recovery and post-recovery write (EA-3); 13/13 ownership-protection tests (EA-4); restored database reported **191 tables** with RLS re-applied atomically (EA-10) |
| Current status | **PASS locally**                                                                                                                                                                                                                                                                                                                    |
| Boundary       | Local databases only. No production topology, no multi-node authorisation path, and no change to the permission architecture. Known defects D1/D2 remain recorded, not fixed.                                                                                                                                                       |

### 2.2 File lifecycle, version immutability and freeze state machine

| Item           | Evidence                                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reports        | EA-2 §3; EA-3 §10; EA-4 §10; EA-8 §5; EA-10 §4                                                                                                                                                                                                                                                                                        |
| What ran       | Ownership guard 9/9 (EA-3); legal/unauthorised/cross-tenant delete and replace; real HTTP freeze denial and recovery; PDF preview, corrupt input, orphan-object checks, version-level replace, SHA-256 verification and immutability; test-asset ownership 13/13 (EA-4); object/metadata consistency across the rollback drill (EA-8) |
| Current status | **PASS locally**                                                                                                                                                                                                                                                                                                                      |
| Boundary       | WOPI frozen re-open remains unresolved. The real Drill transport was not run, so the remote file path is not proven.                                                                                                                                                                                                                  |

### 2.3 Server Action key, image build and replica gate

| Item           | Evidence                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reports        | EA-2 §2; EA-4 §10; EA-5 §0 and §3; EA-6 §0; EA-7 §0 and §5; EA-8 §3; EA-10 §4                                                                                                                                                                                                                                                                                                                          |
| What ran       | Multi-instance key consistency 5/5 (EA-3); local build gate 7/7 including a real image build (EA-4); BuildKit secret + fingerprint cache binding; four deployment-script defects fixed (EA-5); stale-compose drill defect fixed (EA-6); five security defects fixed with a fake-ssh harness (EA-7); half-rolled-fleet gate defect fixed (EA-8); gate fixtures 13/13 and replica contract 17/17 (EA-10) |
| Current status | **PASS locally**                                                                                                                                                                                                                                                                                                                                                                                       |
| Boundary       | The GHCR/GHA cache path, a real Swarm service, a real rolling update and a genuinely multi-node fleet are NOT RUN. The replica contract is tested with fixtures, not with a live multi-node topology.                                                                                                                                                                                                  |

### 2.4 Database backup, restore and permission rebuild

| Item           | Evidence                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reports        | EA-9 §0 and §4; EA-10 §0, §2 and §5; `docs/backup-restore-runbook.md`                                                                                                                                                                                                                                                                                                    |
| What ran       | Database backup → restore → verification round trip (EA-9); official `restore-verify.sh` restore with identical ownership, RLS, ledger and manifest metrics (EA-10); E10-1 grant gap reproduced and closed operationally by the mandatory migrator step and the script's retained-restore guidance; restored database readable by `beaconhs_app` after `pnpm db:migrate` |
| Current status | **PASS locally**                                                                                                                                                                                                                                                                                                                                                         |
| Boundary       | No production backup was restored, and no production RPO/RTO figure exists. A restore remains dependent on running the current migrator to rebuild grants.                                                                                                                                                                                                               |

### 2.5 Object-store encrypted backup, restore and difference check

| Item           | Evidence                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reports        | EA-9 §3; EA-10 §3; `docs/backup-restore-runbook.md`                                                                                                                                                                                                          |
| What ran       | Object-store backup → restore → verify round trip (EA-9); format-2 suite 31/31 (previously 31 skipped); real encrypted backup, tamper/wrong-key/wrong-format refusal matrix; encrypted restore identical on keys, hashes, metadata and tenant prefix (EA-10) |
| Current status | **PASS locally**                                                                                                                                                                                                                                             |
| Boundary       | WORM/object-lock restore is assured by code audit only and was never exercised. Lifecycle configuration is captured, not applied by default.                                                                                                                 |

### 2.6 Readiness and migration compatibility

| Item           | Evidence                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reports        | EA-9 §2; EA-10 §2.4; `apps/web/src/app/api/health/ready/route.ts`, `apps/web/src/lib/schema-compatibility.ts`, `packages/db/src/migration-state.ts`                                                                                                                                                                                                                         |
| What ran       | Old-build startup guard proven against a real gated image (EA-9); readiness matrix against real databases (EA-10): match **200**, behind **200** with pending migrations logged once, ahead **503**, ledger missing **503**, journal absent **503**, database unreachable **503**. The ahead/behind states were produced with drizzle-applied migrations, not ledger edits. |
| Current status | **PASS locally**                                                                                                                                                                                                                                                                                                                                                            |
| Boundary       | The matrix proves the build-versus-ledger policy, not production availability, load behaviour or a multi-node rollout.                                                                                                                                                                                                                                                      |

### 2.7 Local rollback drill

| Item           | Evidence                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reports        | EA-8 §0, §2, §4, §7 and §10; EA-9 §5                                                                                                                                                                                   |
| What ran       | Ten-scenario rollback decision table and eleven executed fault injections; the half-rolled-fleet defect was reproduced, fixed and covered by a negative fixture; the key rollback boundary was characterised (EA-9 §5) |
| Current status | **PASS locally**                                                                                                                                                                                                       |
| Boundary       | Real deployment rollback remains **High / NOT RUN**. The local drill is not a production rollback rehearsal.                                                                                                           |

### 2.8 Deployment workflow, security audit and CI state

| Item           | Evidence                                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reports        | EA-1; EA-5 §0; EA-6 §0; EA-7 §0 and §5; EA-10 §4 and §6                                                                                                                                                                                      |
| What ran       | Remote/branch state read without a push (EA-1); local deployment simulation (EA-5); local release-candidate gate run (EA-6); five deployment-script security defects fixed (EA-7); CI wiring for the shell gate and replica contract (EA-10) |
| Current status | **Static/local PASS; CI NOT RUN**                                                                                                                                                                                                            |
| Boundary       | EA-1's push was blocked by the sandbox (`permission.rejected`); `hse-platform` triggers no workflow; `gh` is not installed. The `.github` edits are uncommitted, so nothing is armed. GHCR/GHA, Dokploy and the Drill transport are NOT RUN. |

### 2.9 WOPI frozen re-open

| Item           | Evidence                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Reports        | EA-2, EA-3, EA-7, EA-8, EA-9, EA-10 (status carried forward)                                                                           |
| What ran       | Nothing new in EA-11. The item is deliberately paused.                                                                                 |
| Current status | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`                                                                             |
| Boundary       | No re-investigation was performed, by instruction. A named owner must accept or schedule the residual risk before production approval. |

---

## 3. Closed and open items

### 3.1 Closed (within their stated boundary)

| Item                                                     | Closed by                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Browser-test race reported as a product failure          | EA-2 diagnosed a test-driver defect and fixed the driver, not the product                                      |
| Test-asset ownership overwrite                           | EA-3 added `apps/web/src/lib/testing/test-asset-ownership.ts` and its tests                                    |
| PDF preview blocked by missing LibreOffice               | EA-4 proved authorization, conversion and browser render                                                       |
| Version-level replace unverified                         | EA-4 proved legal, unauthorised and cross-tenant replace                                                       |
| Server Action key local build gate unverified            | EA-4 (7/7) and EA-5/EA-6/EA-7 (secret-only injection, cache binding, negative fixtures)                        |
| BuildKit secret content was not part of the cache key    | EA-5 bound the fingerprint build-arg into the secret-consuming layer                                           |
| Drill recreate used the host's stale compose file        | EA-6 fixed the recreate path and added a contract test                                                         |
| Five deployment-script security defects                  | EA-7 (`-C`, ssh probe, dead `sed`, empty override, world-readable build log)                                   |
| Half-rolled fleet could pass the deploy gate             | EA-8 added the per-task commit/key assertion and a negative fixture                                            |
| Old image could report `ready` against a newer schema    | EA-9 added the schema-ahead guard and proved 503 against a real image                                          |
| Restored database was unusable until grants were rebuilt | EA-10 reproduced E10-1, made the migrator step mandatory in the runbook and surfaced it in `restore-verify.sh` |
| Encrypted format-2 backup was not exercised              | EA-10 installed `age` in a disposable container and ran 31/31 tests plus a real drill                          |
| Readiness against a restored database was unverified     | EA-10's six-case matrix                                                                                        |
| Replica decision logic was untested                      | EA-10's `replica-coverage.mjs` and 17/17 contract tests                                                        |

### 3.2 Open

| Item                                                  | Status                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| CI has never executed this worktree                   | **NOT RUN** — push blocked, workflows uncommitted                                  |
| Real deployment and real rollback                     | **NOT RUN** — High                                                                 |
| Production database restore                           | **NOT RUN** — High                                                                 |
| Production object-store restore                       | **NOT RUN** — High                                                                 |
| Real multi-node Swarm                                 | **NOT RUN** — High                                                                 |
| GHCR / GitHub Actions cache path                      | **NOT RUN** — Medium                                                               |
| Drill transport / recreate / probe                    | **NOT RUN** — Medium                                                               |
| WORM / object-lock restore                            | **NOT RUN** — Medium, code-level assurance only                                    |
| WOPI frozen re-open                                   | `KNOWN / UNRESOLVED — LOW PRIORITY — PAUSED`                                       |
| Cross-build key divergence on rollback                | Medium — characterised (`9602b7…` vs `c7840d…`); needs one shared runtime override |
| Restore depends on the current migrator for grants    | Medium — documented, with script guidance; operator discipline required            |
| Lifecycle configuration not applied by default        | Low — MinIO quirk documented                                                       |
| Replica gate fails closed without node labels         | Low — intentional                                                                  |
| Known defects D1–D6                                   | Recorded, not fixed; D2 (ungated `people` nav) deserves explicit risk acceptance   |
| `/api/v1/monitored_sessions` returns 500              | Recorded, not fixed; `apps` category is deliberately unmapped                      |
| `PERMISSION_CATALOGUE` is 102 keys, AGENTS.md says 89 | Documentation drift, recorded                                                      |
| Local test-artefact hygiene                           | Low — see EA11-F1…F3 in §6.6                                                       |

---

## 4. Release blockers before a real deployment

| ID   | Blocker                                                          | Level                    | Why it blocks                                                                                           | Exit criterion                                                                                                              |
| ---- | ---------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| B-1  | CI has never run; worktree is uncommitted                        | **High (process)**       | No remote gate has seen this code; `.github` edits are uncommitted and a push triggers no workflow      | Commit the reviewed tree, push to an authorised branch, run the CI workflow and record exit codes                           |
| B-2  | Real deployment and real rollback                                | **High (authorisation)** | EA-8 is a local drill; no digest was re-pinned on a real target and no rollback was executed            | Authorised deploy to a named target, followed by an authorised rollback with the previous digest and a named decision owner |
| B-3  | Production database restore                                      | **High (authorisation)** | Only disposable local restores exist; no production backup, RPO or RTO was exercised                    | Restore a production backup into an isolated production-like target; record duration, integrity and RPO/RTO                 |
| B-4  | Production object-store restore                                  | **High (authorisation)** | Only local MinIO round trips exist; production bucket policy, lifecycle and credentials differ          | Restore production objects into an isolated target and compare keys, hashes, metadata and tenant prefixes                   |
| B-5  | Real multi-node Swarm                                            | **High (authorisation)** | `verify_replicas` observes the local node only; the contract is tested, the topology is not             | A real multi-node stack; extend the gate to resolve each task's node before certifying the fleet                            |
| B-6  | GHCR / GHA cache path                                            | Medium                   | The workflow YAML and local build are tested; the registry-backed cache build has never executed        | An authorised Actions run with a warm cache, proving the fingerprint gate and image pull                                    |
| B-7  | Drill transport / recreate / probe                               | Medium                   | Only argv construction and failure ordering were verified; the remote transport was never run           | An authorised Drill run (explicitly out of scope for EA-11; no contact was made)                                            |
| B-8  | WORM / object-lock restore                                       | Medium                   | Assured by code audit only                                                                              | Restore into an object-lock/versioned bucket and verify immutability and retrieval                                          |
| B-9  | WOPI frozen re-open                                              | Low (accepted)           | Root cause unresolved and investigation paused by the owner                                             | Named owner accepts the risk or schedules the fix                                                                           |
| B-10 | Cross-build key divergence on rollback                           | Medium                   | Two builds can embed different keys; a rollback can cross the boundary                                  | One shared runtime override, or a rollback procedure that re-pins the matching key and proves it                            |
| B-11 | Restore depends on the migrator for grants                       | Medium                   | A restored database is unusable until `pnpm db:migrate` rebuilds runtime, maintenance and backup grants | The runbook step is mandatory and drilled; operators must treat a restore as incomplete until grants are rebuilt            |
| B-12 | Lifecycle configuration and node-label strictness                | Low                      | Lifecycle is captured but not applied by default; the replica gate fails closed without node labels     | Document the operational choice and verify it on the target                                                                 |
| B-13 | Pre-existing known defects D1–D6, `/api/v1` 500, catalogue drift | Mixed                    | These predate EA-1 and are not fixed by the acceptance series                                           | Fix or explicitly accept each one before production approval; D2 is the most security-relevant                              |

---

## 5. Operations requiring separate authorisation

Nothing below is granted by EA-11.

1. **Commit and push** the reviewed working tree, and run GitHub Actions/CI.
2. **Real deployment** to a named target: commit, image digest, environment,
   window, operator and rollback owner.
3. **Real rollback**: the previous digest, exact commands, data implications and
   the person who declares failure.
4. **Production database backup and restore drill**: backup selection, isolated
   target, RPO/RTO recording and data-retention approval.
5. **Production object-store backup, restore and WORM drill**: bucket selection,
   encryption keys, lifecycle/object-lock policy and comparison criteria.
6. **Multi-node Swarm run**: topology, node labels, replica count and the
   extended replica gate.
7. **GHCR/GHA warm-cache build**: registry push/pull, cache scope and artifact
   retention.
8. **Drill / `phase-aj` access**: explicitly out of scope for this phase; no
   contact was made.
9. **WOPI risk acceptance**: a named owner for the frozen-document behaviour.
10. **Known-defect risk acceptance or fix**: D1–D6, the `apps` API category and
    the permission-catalogue documentation drift.

---

## 6. Change-scope audit (Phase D)

### 6.1 Baseline consistency

- HEAD is unchanged at `51a899b7`; every EA report names the same commit.
- The index is empty; nothing is staged.
- The Phase A counts (155 modified and 475 untracked) reconcile with EA-10
  (§1.1); this report adds the one untracked file that takes the close state to 476.
- No deleted entry exists in `git status`; no tracked file was removed from the
  working tree.
- The pre-existing modifications and untracked files were preserved. This phase
  added only this report and updated the working-state document.
- `.env` is ignored and was not touched; its mtime is still `2026-10-09`.

### 6.2 Files audited

| Area                         | Files                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment scripts/workflows | `.github/workflows/ci.yml`, `.github/workflows/deploy-dev.yml`, `deploy/dokploy-dev.compose.yaml`, `deploy/local-production.compose.yaml`, `deploy/prod-verify.compose.yaml`, `deploy/drill-20261009.compose.yaml`, `scripts/build-drill-image.sh`, `scripts/build-local-image-with-key-gate.sh`, `scripts/ci/*.sh`, `scripts/ci/*.mjs`, `scripts/deploy-drill-freeze-driver*.sh` |
| Test helpers                 | `apps/web/src/lib/testing/test-asset-ownership.ts` and `.test.ts`, `apps/web/src/lib/server-action-key-deployment-contract.test.ts`, `apps/web/src/lib/server-action-key-fingerprint-cli.test.ts`, `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts`                                                                                                                         |
| Database/restore             | `scripts/cluster/restore-verify.sh`, `scripts/cluster/backup.sh`, `packages/db/src/migrate.ts`, `packages/db/src/migration-state.ts`, `packages/db/src/index.ts`, `packages/object-store-backup/src/*`                                                                                                                                                                            |
| Readiness                    | `apps/web/src/app/api/health/ready/route.ts` and its test, `apps/web/src/lib/schema-compatibility.ts` and its test                                                                                                                                                                                                                                                                |
| Documentation                | EA-1 … EA-10 reports, `docs/backup-restore-runbook.md`, `docs/PRODUCTION_RUNBOOK.md`, `docs/project-development-state.md`                                                                                                                                                                                                                                                         |

The audited files are exactly the files named by the phase reports. No
unexplained deployment, restore or test-helper file was added.

### 6.3 Secret and credential audit

| Check                                                        | Result                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Age identities / OpenSSH / RSA / EC private keys in the repo | None found                                                                                                                     |
| Literal Server Action key in scripts, workflows or docs      | None; only variable names, fingerprints and explicit invalid-key test fixtures                                                 |
| `.env`                                                       | Ignored, unchanged, no production hostnames                                                                                    |
| Dockerfile key handling                                      | `RUN --mount=type=secret,id=next_server_actions_key,required=true`; the fingerprint is a build argument, not the key           |
| Image environment variables                                  | No secret-named entries on the locally built `beaconhs:*` images inspected                                                     |
| Image history                                                | No Server Action key reference                                                                                                 |
| Build scripts                                                | Key file must be `0600` and outside the repository; build log in a `0700` temp directory, `0600`, removed on exit; no `set -x` |
| Deploy workflow                                              | Secrets referenced as GitHub secrets; `umask 077`; temporary env file removed on exit; only fingerprints are printed           |
| `/tmp` logs                                                  | No `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<value>`, age key or private key found                                                  |

The untracked local verification harness `deploy/prod-verify.compose.yaml` and
the ignored `.env.prod-verify` (mode `0600`) contain explicit **test-only**
credentials and bind to localhost only. They are not production material and
were not committed. They should not be committed without a deliberate decision.

### 6.4 Production configuration and remote operations

- No production hostname or production credential appears in `.env`.
- The tracked deployment changes are the **dev** workflow and the **dev**
  Dokploy compose. Their diff contains the documented key/replica gate work and
  pre-existing user changes; no literal secret or production endpoint was added.
- `deploy/local-production.compose.yaml` takes every secret from the environment
  and binds published ports to `127.0.0.1` only.
- Docker has no remote context: only `default`. Swarm is inactive. There are no
  services or nodes, and the only running containers are the five local dev
  services.
- No disposable EA drill container, volume, database, bucket or `ea10` image
  remains. Locally built `beaconhs:local-*` and `beaconhs:dr-mirror-*` images are
  retained as local evidence; they are not deployed artefacts. The pre-existing
  `beaconhs:prod-verify` image and the stopped `prod-verify` containers predate
  this series.
- The Drill/`phase-aj` log files under `/tmp/opencode` are dated 2026-10-19,
  before EA-1. They are not evidence of contact during EA-1 … EA-11. The phase
  reports assert that no contact was made.
- This is an evidence-based statement about local traces and recorded
  operations, not a network-forensics proof. EA-11 did not attempt a network
  capture or inspect the remote hosts.

### 6.5 Database and object-store operations

- The dev database is untouched: 50 ledger rows, the two pre-existing tenants,
  no `ea*` roles and no restored database.
- The only non-default database is the pre-existing `beaconhs_al_scratch`.
- Redis `db9` is empty; only `db0` is populated.
- MinIO contains only the two pre-existing buckets; no EA bucket remains.
- The EA-2 report records one historical dev-document overwrite by a legal-write
  test. EA-3 added the ownership guard, and EA-11 did not repeat it. No new
  overwrite was found.
- No production database or object store was contacted or modified.

### 6.6 Findings (reported, not cleaned up)

| ID      | Finding                                                                                                                                                                                                                                                                           | Level                      | Disposition                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| EA11-F1 | 119 `/tmp/server-action-key-*` directories remain from the fingerprint CLI test. Each is `0700`, contains a `0600` `key` file, and holds a deterministic test key. Source: `apps/web/src/lib/server-action-key-fingerprint-cli.test.ts:35` uses `mkdtempSync` without a teardown. | Low (test hygiene)         | Report only. Not in the repo, logs or image. Recommend an `afterAll`/`rmSync` teardown and a one-off cleanup.                     |
| EA11-F2 | `/tmp/next_server_actions_key` is mode `0644`, 34 bytes, dated 2026-10-15 (before EA-1). It is a world-readable local key file.                                                                                                                                                   | Low/Medium (local hygiene) | Report only. Not created by this series and not in the repo. The owner should confirm its purpose, then `chmod 600` or remove it. |
| EA11-F3 | Six `/tmp/ea9-*` fixture directories remain (five migration fixtures and one no-journal fixture), mode `0700`, containing 10-byte SQL files.                                                                                                                                      | Low (cleanup)              | Report only. EA-10's cleanup was scoped to `ea10_*`; these are EA-9 leftovers and contain no secrets.                             |
| EA11-F4 | `deploy/prod-verify.compose.yaml` (untracked) and `.env.prod-verify` (ignored, `0600`) contain explicit throwaway test credentials and localhost endpoints.                                                                                                                       | Informational              | Not production material. Do not commit without review; the files are part of the local verification harness.                      |

No cleanup was performed: the phase is read-only, and deleting pre-existing
files is outside its authority.

### 6.7 Audit limits

- The full historical suite was not re-run; EA-10's final gate run remains the
  executed evidence. EA-11's own checks are in §7.
- The audit scanned for known key formats and literal assignments; it is not a
  general entropy-based secret scanner.
- The `/tmp` review covered secret patterns and the named EA artefacts, not every
  pre-existing file from earlier phases.
- Remote contact is assessed from local traces and the phase reports, not from
  network forensics.

---

## 7. Verification performed in EA-11

Read-only unless noted:

- `git status`, `git rev-parse`, `git diff --stat`, `git diff --cached`,
  `git ls-files --others`, `git check-ignore`, `git remote -v`.
- Read every EA-1 … EA-10 report, `docs/project-development-state.md`,
  `docs/backup-restore-runbook.md` and the relevant sections of
  `docs/PRODUCTION_RUNBOOK.md`.
- `docker info`, `docker service ls`, `docker node ls`, `docker ps -a`,
  `docker images`, `docker volume ls`, `docker network ls`, `docker context ls`.
- `psql` read-only queries against the dev database; `redis-cli INFO keyspace`
  and `DBSIZE` for `db9`; `ls /data` in the MinIO container.
- Secret scans over the repository and `/tmp` logs; image environment and
  history inspection; Dockerfile and build-script inspection.
- File-status reconciliation against the file lists in the phase reports.
- After the documentation edits: `pnpm exec prettier --write` on the two touched
  Markdown files and `pnpm format:check`.

Not run in EA-11: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm deadcode:check`, the replica suite, the gate fixture suite, any deployment,
any rollback, any restore, any GitHub operation. The EA-10 results for those
gates remain the latest executed evidence at this HEAD.

---

## 8. Shortest path to a real release decision

1. **Decide the working tree.** Commit the reviewed 155-file change set in
   focused commits; do not sweep in unrelated files. Push to an authorised
   branch and run CI. B-1 must close first.
2. **Clean the local artefacts.** Fix EA11-F1's test teardown, remove the EA-9
   fixture directories after confirming they are disposable, and resolve
   EA11-F2's key file. This is hygiene, not a release blocker.
3. **Run one authorised single-node staging deployment** through the real
   workflow: verify the image digest, the key gate, the per-task commit, the
   readiness version and the replica gate. Then execute the documented rollback
   with the previous digest. This closes B-2 and exercises B-6's build path.
4. **Run a production-like restore drill** from a fresh encrypted backup into an
   isolated target: database, object store and, if in scope, WORM. Verify the
   mandatory migrator-grant step and record RTO/RPO. This closes B-3, B-4 and
   B-8.
5. **Run the multi-node Swarm test** and extend `verify_replicas` to resolve each
   task's node. This closes B-5.
6. **Obtain explicit risk acceptance** for WOPI and the known defects (D1–D6,
   the `apps` API 500 and the catalogue drift), or fix them. Then, and only then,
   ask for production release approval.

The local candidate does not need to be re-proven to take step 1; it needs a
reviewed commit and a CI run. Steps 3–5 are the real deployment evidence that no
local drill can substitute for.

---

## 9. Final statement

- **Local release candidate: PASS.** The locally testable contract (permissions
  and RLS, file lifecycle and freeze, key/build/replica gates, backup/restore,
  encrypted objects, readiness and the local rollback drill) passed with the
  evidence indexed in §2. EA-10's final gates are the executed evidence; EA-11
  did not re-run them.
- **Conditional deployment: CONDITIONAL — NOT AUTHORISED.** The evidence can
  support a controlled deployment after the §5 authorisations and §4 exit
  criteria. EA-11 does not grant them.
- **Production release approval: NOT GRANTED.** Real deployment, real rollback,
  production database restore, production object-store restore, multi-node
  Swarm, GHCR/GHA, WORM and the Drill transport are all **NOT RUN**. WOPI remains
  `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`.
- No commit, push, GitHub call, deploy, restore or destructive operation was
  performed in this phase.

---

## Appendix A — EA report inventory

| Phase | Report                                                 | Date       | Verdict                                                                                                   |
| ----- | ------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------- |
| EA-1  | `docs/phase-6u-b3-ea1-push-ci.md`                      | 2026-10-20 | Push **BLOCKED** by sandbox; CI **NOT RUN**                                                               |
| EA-2  | `docs/phase-6u-b3-ea2-local-acceptance.md`             | 2026-10-20 | W1/W2/W3 local acceptance; PDF blocked; deploy workflow unverified                                        |
| EA-3  | `docs/phase-6u-b3-ea3-file-lifecycle-freeze.md`        | 2026-10-21 | File lifecycle/freeze PASS; overall **NOT RELEASE-READY** (PDF and deploy workflow open)                  |
| EA-4  | `docs/phase-6u-b3-ea4-pdf-version-key-gate.md`         | 2026-10-21 | PDF, version replace and local key gate PASS; deploy workflow **NOT RUN**                                 |
| EA-5  | `docs/phase-6u-b3-ea5-local-deploy-workflow.md`        | 2026-10-21 | Local simulation PASS; 4 defects fixed; real deployment **NOT RUN**                                       |
| EA-6  | `docs/phase-6u-b3-ea6-local-release-candidate.md`      | 2026-10-21 | Local release candidate **PASS**; one stale-compose defect fixed; real deployment **NOT RUN**             |
| EA-7  | `docs/phase-6u-b3-ea7-release-security-audit.md`       | 2026-10-21 | Local release candidate **PASS**; 5 defects fixed; real deployment **NOT RUN**                            |
| EA-8  | `docs/phase-6u-b3-ea8-rollback-drill.md`               | 2026-10-22 | Local rollback drill **PASS** (10 scenarios / 11 injections); real rollback **NOT RUN**                   |
| EA-9  | `docs/phase-6u-b3-ea9-backup-restore-readiness.md`     | 2026-10-22 | Old-build guard, DB and object round trips **PASS**; real restore **NOT RUN**                             |
| EA-10 | `docs/phase-6u-b3-ea10-encrypted-restore-readiness.md` | 2026-10-22 | Restore, readiness matrix, format-2 and replica contract **PASS**; production/multi-node/WORM **NOT RUN** |
| EA-11 | `docs/phase-6u-b3-ea11-release-decision-audit.md`      | 2026-10-22 | This audit: local RC **PASS**; deployment **CONDITIONAL — NOT AUTHORISED**; production **NOT GRANTED**    |
