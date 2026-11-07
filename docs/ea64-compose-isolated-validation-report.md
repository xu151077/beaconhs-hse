# EA-64 — Compose Gate 5 isolated runtime validation

**Phase type:** isolated runtime validation on the local Docker daemon.
**No production deployment. No Ubuntu target server. No workflow change. No
GHCR access.**

**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. Result in one paragraph

The EA-63 verifier works against a real Docker Compose deployment: **28 of 28
recorded scenarios produced the expected verdict and exit code**, including the
positive control, every identity mismatch, one-shot association, locking,
signals and mid-verification replacement. Two real compatibility defects were
found. The serious one is **F-64-1**: the verifier reads
`.State.RestartCount`, but Docker reports `RestartCount` at the top level, so the
restart-loop signal is always zero; a crash-looping service with no healthcheck
was reported **PASS in 2 of 6 runs**. The verifier was **not modified** — the
defect and its evidence are recorded for an authorised follow-up.

### 1.1 Phase verdict

| Question                                                      | Answer                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Is EA-64 itself complete?                                     | **Yes** — every executable scenario ran on real Docker; nothing was replaced by a fixture |
| Is the Compose Gate 5 verifier ready for production use?      | **No** — F-64-1 is a false-PASS path; it must be fixed and re-tested first                |
| Does this prove anything about the Ubuntu host or production? | **No** — local daemon only                                                                |

---

## 2. Environment

| Field          | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| Host           | `test-Virtual-Machine`                                        |
| Docker Engine  | 29.9.2 (client and server)                                    |
| Docker Compose | v5.6.1                                                        |
| Storage driver | `overlayfs` (containerd snapshotter)                          |
| Swarm          | inactive                                                      |
| Local registry | `registry:2` from the already-present image, `127.0.0.1:5055` |

Full inventory: `docs/evidence/ea64/environment-inventory.md`.

## 3. Isolation

- 28 scenario projects plus one alignment project, all named
  `beaconhs-ea64-*`, each with its own network. (Earlier harness attempts
  created and removed further projects while the driver script was being
  corrected; the recorded run is the final one.)
- Two test images built locally from `alpine:3`; pushed only to the local
  registry. No GHCR pull or push.
- No host production port, no BeaconHS project name, no production volume,
  network, database, object store or credential.
- Every container carried `com.beaconhs.*` labels; the registry carried
  `com.beaconhs.ea64=1`.
- **143 distinct container IDs** appear in the saved `docker inspect` snapshots
  across all harness runs (including the re-runs made while the driver script
  was being corrected); every one was removed. Final state: **0 EA-64
  containers, networks, images or volumes**.

Cleanup detail: `docs/evidence/ea64/cleanup-inventory.md`.

---

## 4. Scenarios and results

| Set                                             | Scenarios | Matched   | Scope                                     |
| ----------------------------------------------- | --------- | --------- | ----------------------------------------- |
| State and identity                              | 15        | **15/15** | real Compose, real Docker                 |
| Replacement, timeout, exceptions, lock, signals | 13        | **13/13** | real Docker / real `flock` / real signals |
| **Total recorded**                              | **28**    | **28/28** |                                           |

Verdict distribution across the 28: **PASS 8, FAIL 13, NOT VERIFIED 6,
USAGE ERROR 1**.

Two additional probes (not pass/fail scenarios):

| Probe                                  | Result                                                   |
| -------------------------------------- | -------------------------------------------------------- |
| crash loop with `health: none`         | **PASS in 2 of 6 runs** — false PASS (F-64-1)            |
| `RepoDigests` on locally tagged images | synthesised `repo@<id>` even without a registry (F-64-4) |

Raw: `docs/evidence/ea64/scenario-results.tsv`,
`scenario2-results.tsv`, `crashloop-falsepass.log`, `repodigests.log`.

### 4.1 Positive control

A real four-service project (`web`, `worker` healthy; `scheduler`,
`storage-init` exited 0) returned:

```
VERDICT: PASS
REASON: all 4 container(s) run ea64/app@sha256:e0cd… (image sha256:e0cd…) and match the manifest
```

This is the first time the Compose gate passed against a real deployment of any
kind. It is a local, throwaway deployment — not production.

---

## 5. Real JSON vs the EA-63 fixtures

Full comparison: `docs/evidence/ea64/real-docker-json-comparison.md`.

Every field the verifier uses matched reality **except one**:

| Field                 | Reality                                        | Verifier                   | Consequence                       |
| --------------------- | ---------------------------------------------- | -------------------------- | --------------------------------- |
| `.State.RestartCount` | absent; the field is top-level `.RestartCount` | `.State.RestartCount // 0` | always 0 → restart detection dead |

Everything else matched: `.Id`, `.Image`, `.Config.Image`, the three
`com.beaconhs.*` labels, the two `com.docker.compose.*` labels, `.State.Status`,
`.State.Health.Status` (absent for one-shots, handled as `none`),
`.State.ExitCode`, `.State.StartedAt`.

`docker compose ps --all --format json` returns a **JSON array** in v5.6.1; the
verifier does not use it, so this is informational.

---

## 6. Defects found (recorded, not fixed)

### F-64-1 — `RestartCount` is read from the wrong path (high, narrow)

- Evidence: `real-inspect-fields.json` (top-level `RestartCount: 6`,
  `.State.RestartCount: absent`), `crashloop-falsepass.log`.
- Impact: a service with `health: none` that crash-loops can be sampled in its
  brief `running` window and reported **PASS**. Observed 2/6.
- Scope: only `health: none` services. In the shipped manifest that is
  `collabora`; `web`/`worker`/infra services require health and fail correctly.
- Fix direction (not applied): read `.RestartCount`; treat a rising count as
  non-convergence; add a fixture with the real path.

### F-64-2 — registry references with a port are rejected (medium)

- Evidence: `--image 127.0.0.1:5055/ea64/app` → `USAGE ERROR` with a misleading
  "must be a repository reference" message.
- Impact: the verifier cannot target a registry addressed by host:port. GHCR has
  no port, so the intended deployment is unaffected; local/self-hosted
  registries are.
- Workaround used here: reference the image by its tag-derived name.

### F-64-3 — the EA-63 fixture encoded the same wrong field (process)

- `EA63-T10` supplied `.State.RestartCount`, so the fixture passed while the
  real field was unread. A fixture that agrees with the implementation but not
  with Docker is worse than no fixture.
- Recommendation: derive fixtures from captured real output, not from the code's
  assumptions.

### F-64-4 — `RepoDigests` is synthesised, so resolution is not provenance

- On this daemon, tagging a `docker commit`ed image produced
  `["ea64/dangling@sha256:9101…"]` with no registry involved.
- The "empty `RepoDigests` + resolvable reference" case in EA-63 T08 is therefore
  **not reproducible**; it is `NOT VERIFIED` on real Docker.
- The verifier never claims provenance from resolution, so this is a limit of the
  evidence, not a false claim in the code.

### 6.1 Recommended fixes (awaiting authorisation)

| Priority | Fix                                                                                                                                               | Why                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1        | Read top-level `.RestartCount`; treat any restart of a long-running service as non-convergence; re-capture the fixture from real `docker inspect` | removes the false-PASS path (F-64-1, F-64-3)       |
| 2        | Accept `host:port/repo` in `--image` validation, or use a strict OCI reference parser                                                             | unblocks local and self-hosted registries (F-64-2) |
| 3        | Add an explicit note/assertion that reference resolution is not provenance                                                                        | keeps the registry boundary honest (F-64-4)        |

None of these was applied in EA-64.

> **Remediated in EA-64.1 (2026-10-30).** F-64-1, F-64-2 and F-64-3 are fixed in
> `scripts/ci/reconcile-compose-digest.sh` and
> `scripts/ci/compose-deployment-gate.test.mjs`; F-64-4 is recorded as an
> evidence-boundary note only and the identity model is unchanged. The findings
> above are preserved as the historical EA-64 record. See
> `docs/ea64-compose-gate5-defect-remediation-report.md` and
> `docs/evidence/ea64/remediation/`.

---

## 7. Image identity: proven and not proven

**Proven on real Docker:** the three-way match (`.Config.Image` reference,
`.Image` ID, `image-digest` label) passes for a correct deployment and fails for
a wrong image, a tag, a missing label and a stale deployment.

**Not proven:** that a **GHCR manifest digest** maps to the running image. The
local registry is not GHCR; on this containerd store the push manifest digest
happened to equal `.Id`, which is a property of the store, not a general
guarantee. Registry provenance remains `NOT VERIFIED`.

---

## 8. Concurrency and replacement

| Behaviour                                    | Result                                        |
| -------------------------------------------- | --------------------------------------------- |
| Lock contention                              | refused immediately (FAIL)                    |
| Release then re-acquire                      | PASS                                          |
| Unheld lock file                             | PASS                                          |
| Independent lock paths                       | independent                                   |
| `--lock-fd` held / not open                  | PASS / USAGE ERROR                            |
| SIGTERM, SIGINT                              | non-zero exit, no leftover process, lock free |
| Container replaced between pass and re-check | **NOT VERIFIED**                              |
| Container replaced with a different image    | **NOT VERIFIED**                              |

Replacement is detected through the re-list/re-inspect comparison. A replacement
that completes _before_ the snapshot is inherently invisible; the deployment
label still ties the observed fleet to this run.

Detail: `docs/evidence/ea64/concurrency-and-replacement-results.md`.

---

## 9. Gates

| Gate                                                                          | Result                                                           |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| EA-63 fixture suite `node --test scripts/ci/compose-deployment-gate.test.mjs` | 37/37, exit 0                                                    |
| `pnpm format:check`                                                           | pass, exit 0                                                     |
| `pnpm typecheck --force`                                                      | 27/27 tasks, 0 cached, exit 0                                    |
| `pnpm lint --force`                                                           | 1/1 tasks, 0 cached, exit 0                                      |
| `pnpm deadcode:check`                                                         | pass, exit 0                                                     |
| `pnpm turbo run test --force --concurrency=1`                                 | 25/25 tasks; 3857 passed, 101 skipped, 0 failed, exit 0          |
| `pnpm build --force`                                                          | 4/4 tasks, 0 cached, exit 0                                      |
| Deployment safeguard suite (same 10 commands as CI)                           | 5 shell scripts exit 0; 148/148 `node --test` assertions, exit 0 |
| `git diff --check`                                                            | exit 0                                                           |

### 9.1 Gate results

Each gate was run with `--force` and its own exit code captured (no piping into
`tail`). Log: `docs/evidence/ea64/local-validation.log`. No code changed in this
phase, so the gates are a regression check on the EA-63 tree.

---

## 10. Evidence classes

| Class                           | What it covers                                        |
| ------------------------------- | ----------------------------------------------------- |
| `LOCAL ENVIRONMENT OBSERVATION` | host, daemon, pre-existing containers                 |
| `REAL DOCKER ENGINE TEST`       | the 28 scenarios, locking, signals, replacement       |
| `REAL COMPOSE TEST`             | project creation, labels, healthchecks, one-shot exit |
| `FIXTURE TEST`                  | the EA-63 37-test suite                               |
| `REGISTRY VERIFICATION`         | **NOT VERIFIED** — local registry only, not GHCR      |
| `UBUNTU TARGET SERVER`          | **NOT RUN**                                           |
| `PRODUCTION`                    | **NOT VERIFIED**                                      |

No fixture result is presented as a real Docker result, and no local Docker
result is presented as an Ubuntu or production result.

---

## 11. Residual risks

| Risk                                                             | Status                               |
| ---------------------------------------------------------------- | ------------------------------------ |
| F-64-1 false PASS for `health: none` services                    | **open** — needs an authorised fix   |
| F-64-2 port-addressed registries unusable                        | open                                 |
| Fixtures derived from implementation rather than captured output | open (process)                       |
| Registry provenance / GHCR digest mapping                        | `NOT VERIFIED`                       |
| A hostile actor with daemon access can forge labels              | accepted (socket is root-equivalent) |
| `--lock-fd` trusts the caller                                    | documented contract                  |
| Verifier not wired into any pipeline                             | by design                            |

---

## 12. Cleanup

Only `beaconhs-ea64-*` containers/networks, `ea64/*` images, the EA-64 registry
container and its anonymous volume were removed. Pre-existing containers,
networks and volumes are in their original state. No `docker system prune` was
used. Detail: `docs/evidence/ea64/cleanup-inventory.md`.

---

## 13. Repository state

`HEAD` unchanged, nothing staged, no existing file modified. New files only:

| File                                              | Purpose                                    |
| ------------------------------------------------- | ------------------------------------------ |
| `docs/ea64-compose-isolated-validation-report.md` | this report                                |
| `docs/evidence/ea64/*`                            | seven evidence documents, raw logs, hashes |

The EA-63 verifier was **not** modified: its hash in `baseline.txt` matches the
EA-63 delivery.

---

## 14. Status (unchanged)

| Item                                | Status                                          |
| ----------------------------------- | ----------------------------------------------- |
| Real GitHub Actions                 | `NOT RUN`                                       |
| Real GHCR                           | `NOT VERIFIED`                                  |
| Real Ubuntu deployment              | `NOT VERIFIED`                                  |
| Isolated Docker Compose             | **`RUN`** — this phase                          |
| Compose Gate 5 on a real deployment | `NOT VERIFIED` (local only)                     |
| Production                          | `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION` |
| A1–A8                               | `PENDING AUTHORIZATION`                         |
| Rollback                            | `FAIL — NO EXECUTABLE ROLLBACK PATH`            |
| Migration 51                        | `NOT RUN`                                       |
| DB / object storage restore         | `NOT RUN`                                       |
| WOPI                                | paused                                          |

**This phase does not represent a successful Ubuntu deployment, a production
approval, or a verified Gate 5 on the target server.**

---

## 15. Stop

EA-64 ends here. EA-65 was not started and the deployment workflow was not
connected.
