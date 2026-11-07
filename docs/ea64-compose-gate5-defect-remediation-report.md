# EA-64.1 — Compose Gate 5 defect remediation report

**Phase type:** targeted defect fix + fixture rebuild + regression.
**No production deployment. No Ubuntu target server. No workflow change. No
GHCR access. No commit, push or PR.**

**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. Verdict

| Question                             | Answer                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Are F-64-1, F-64-2 and F-64-3 fixed? | **Yes**, with real Docker evidence for F-64-1 and F-64-2                       |
| Is the EA-64 false-PASS path closed? | **Yes** — the same crash-loop probe now returns **0 PASS / 6**                 |
| Does this prove GHCR or production?  | **No** — `NOT VERIFIED`                                                        |
| Phase status                         | **COMPLETE** (all executable scenarios ran; nothing was replaced by a fixture) |

F-64-4 was handled as an evidence-boundary note only; the identity model is
unchanged.

---

## 2. Repository protection

Recorded before any change (`docs/evidence/ea64/remediation/baseline.txt`):

| Item                                                                         | Value                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------ |
| Branch                                                                       | `hse-platform`                             |
| HEAD                                                                         | `51a899b7aac0a942da327222a3eed355fca9798a` |
| Modified / untracked / staged                                                | 165 / 528 / 0                              |
| `git diff --check`                                                           | exit 0                                     |
| EA-64 evidence `SHA256SUMS`                                                  | 17/17 verified, exit 0                     |
| Protected files (`turbo.json`, Swarm reconciler, `deploy-dev.yml`, `ci.yml`) | hashes unchanged                           |

Only these source files changed:

- `scripts/ci/reconcile-compose-digest.sh`
- `scripts/ci/compose-deployment-gate.test.mjs`

Everything else is new documentation/evidence under `docs/`. The manifest, the
workflows, the Swarm reconciler, `turbo.json` and the business code were not
modified.

---

## 3. F-64-1 — `RestartCount` read from the wrong path

### 3.1 Root cause

EA-63 read `.State.RestartCount // 0`. Docker 29.9.2 reports `RestartCount` at
the **top level** and has no `.State.RestartCount` key, so the expression always
produced `0` and the restart-loop signal was dead.

Real evidence (EA-64): `docs/evidence/ea64/real-inspect-fields.json` and
`docs/evidence/ea64/remediation/fixtures/real-fleet-s4-crashloop.json`:

```json
{
  "RestartCount": 6,
  "State": { "Status": "restarting", "Health": { "Status": "unhealthy" } }
}
```

### 3.2 Fix

- The jq projection now reads the top-level `.RestartCount` and emits an explicit
  sentinel for `missing`, `null`, non-integer, fractional and negative values.
- `evaluate()` fails closed: malformed values are **NOT VERIFIED** (exit 2), never
  `0`.
- A non-zero count on a container created by this deployment is a terminal
  **FAIL**. A container that has run continuously since creation has `0`; a
  normal first start therefore cannot be misread as a crash loop.
- `recheck_unchanged()` also compares the restart count, alongside the image ID
  and `StartedAt`.
- `--json` evidence records `restarts: null` when the value is unusable (it
  previously coerced to `0`).
- The now-dead `FIRST_RESTARTS` array was removed.

The EA-63 state rules are unchanged: `restarting` / `created` are still
non-convergent, `starting` health is still pending, and a deadline still ends in
FAIL.

### 3.3 Real Docker proof

The exact EA-64 probe (healthcheck none, `restart: always`, `exit 1`) was re-run
six times:

|              | EA-64 before           | EA-64.1 after                                  |
| ------------ | ---------------------- | ---------------------------------------------- |
| PASS results | **2 / 6**              | **0 / 6**                                      |
| Reason       | brief `running` window | `has restarted 6 time(s) since it was created` |

Raw: `docs/evidence/ea64/remediation/raw/crashloop-ea641.txt`.

### 3.4 Tests

| Test        | Case                                    | Expected     |
| ----------- | --------------------------------------- | ------------ |
| `EA641-T01` | top-level `0`                           | PASS         |
| `EA641-T02` | `1`                                     | FAIL         |
| `EA641-T03` | `6`                                     | FAIL         |
| `EA641-T04` | missing                                 | NOT VERIFIED |
| `EA641-T05` | `null`                                  | NOT VERIFIED |
| `EA641-T06` | string `"3"`                            | NOT VERIFIED |
| `EA641-T07` | `-1`                                    | NOT VERIFIED |
| `EA641-T08` | `1.5`                                   | NOT VERIFIED |
| `EA641-T09` | `health: none` + 6 restarts             | FAIL         |
| `EA641-T10` | `health: required` + 6 restarts         | FAIL         |
| `EA641-T11` | only the old `.State.RestartCount` path | NOT VERIFIED |

---

## 4. F-64-2 — registry references with a port

### 4.1 Root cause

The EA-63 validator rejected any `:` in `--image`, which excluded every registry
addressed as `host:port` (`127.0.0.1:5055/app`, `localhost:5000/app`,
`registry:5000/app`). The error message claimed the reference was invalid.

### 4.2 Fix

`--image` is now parsed with the Docker reference rule:

```
[registry-host[:port]/]path-component[/path-component...]
```

- The first segment is a registry only when it contains a dot or a colon, or is
  `localhost`.
- A colon is a **port** only in the first segment and only when a repository
  path follows; otherwise it is a tag and is rejected.
- Port range 1–65535 is enforced.
- Path components follow the OCI grammar
  (`[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*`).
- A combined `repo@sha256:…` is accepted only when the digest equals `--digest`;
  it is normalised to the bare repository before `EXPECTED_REF` is built.
- IPv6 registry hosts (`[::1]:5000/...`) are **explicitly rejected** rather than
  guessed at. This is a documented limitation, not a silent downgrade.
- No substring or prefix matching is used; the container reference must equal the
  expected `repo@digest` exactly.

### 4.3 Real Docker proof

A real Compose project ran `127.0.0.1:5055/ea64/app@sha256:da71…`:

| Invocation                                           | Verdict  | Exit |
| ---------------------------------------------------- | -------- | ---- |
| `--image 127.0.0.1:5055/ea64/app`                    | **PASS** | 0    |
| `--image ea64/app` (same image, different reference) | **FAIL** | 1    |

Raw: `docs/evidence/ea64/remediation/raw/registry-port-ea641.txt`.

### 4.4 Tests

Accepted: IPv4 + port (`EA641-T15`), combined `repo@digest` (`T16`), GHCR
multi-level path (`T18`), `localhost:port` (`T19`), single-label
`registry:port` (`T20`).

Rejected: digest mismatch (`T17`), GHCR tag (`T21`), bare-repo tag (`T22`), port
70000 (`T23`), port 0 (`T24`), non-numeric port (`T25`), `host:port` without a
path (`T26`), empty path component (`T27`), trailing underscore (`T28`), IPv6
(`T29`), uppercase (`T30`), missing `--digest` (`T31`).

A container created from a tag on a port-addressed registry still fails the
identity check (`T32`).

---

## 5. F-64-3 — fixtures built from real output

The EA-64 captures were projected into minimal fixtures, keeping the original
nesting:

| Fixture                                 | Source                  | Content                                                 |
| --------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `fixtures/real-fleet-s1-healthy.json`   | EA-64 S1 `inspect.json` | 4 containers, all `RestartCount: 0`                     |
| `fixtures/real-fleet-s4-crashloop.json` | EA-64 S4 `inspect.json` | `web` with `RestartCount: 6`, `restarting`, `unhealthy` |

Provenance, source hashes and the extraction command are in
`fixtures/SOURCES.md`. Environment fields, mounts, networks, names and host
paths were dropped.

The synthetic builder in the test file now also puts `RestartCount` at the top
level. A dedicated option (`stateRestartCount`) reproduces the old wrong shape
only to prove it is no longer read (`EA641-T11`).

Structure contract: `EA641-T14` asserts, for every container in both real
fixtures, that `RestartCount` is a non-negative integer at the top level and
that `State.RestartCount` is absent. It also pins the crash-loop sample
(`web`, `6`, `restarting`).

Behavioural replay: `EA641-T12` feeds the real healthy fleet through the gate
and expects PASS; `EA641-T13` feeds the real crash-loop fleet and expects FAIL
on the restart count.

---

## 6. F-64-4 — RepoDigests evidence boundary

`docs/evidence/ea64/remediation/repo-digests-boundary.md` records that:

- local `docker tag` / `docker commit` operations can create or synthesise
  `RepoDigests` entries;
- a present entry does not prove a registry pull;
- a local Docker test cannot prove GHCR provenance;
- registry provenance needs an independent registry digest, signature or
  trusted build chain;
- the verifier still records `RepoDigests` as corroboration only and the
  three-way identity rule is unchanged.

---

## 7. Regression

### 7.1 Fixture suite

`node --test scripts/ci/compose-deployment-gate.test.mjs`

|        | Result |
| ------ | ------ |
| Tests  | **69** |
| Passed | **69** |
| Failed | **0**  |
| Exit   | 0      |

This includes the original 37 EA-63 tests and 32 new EA-64.1 tests.
`EA63-T10` was adapted to exercise the state-only deadline path
(`restarting`, count `0`) so it no longer depends on the counter.

### 7.2 Real Docker / Compose rerun

The EA-64 harness was rebuilt (local registry + two local images) and the
unchanged driver scripts were re-run:

| Set                                             | Scenarios | Matched   |
| ----------------------------------------------- | --------- | --------- |
| State and identity                              | 15        | 15/15     |
| Replacement, timeout, exceptions, lock, signals | 13        | 13/13     |
| **Total**                                       | **28**    | **28/28** |

Distribution: PASS 8, FAIL 13, NOT VERIFIED 6, USAGE ERROR 1. This is a real
Docker Engine / real Compose rerun, not a fixture replay. Detail:
`docs/evidence/ea64/remediation/real-docker-rerun.md`.

### 7.3 Related shell tests (same set as CI)

| Command                                                    | Exit      |
| ---------------------------------------------------------- | --------- |
| `scripts/cluster/dokploy-curl.test.sh`                     | 0         |
| `scripts/ci/require-current-main.test.sh`                  | 0         |
| `scripts/ci/workflow-repository-immutability.test.sh`      | 0         |
| `scripts/ci/verify-server-action-key-gate.test.sh`         | 0         |
| `scripts/ci/build-local-image-key-gate.test.sh`            | 0         |
| `node --test scripts/ci/replica-coverage.test.mjs`         | 0 — 17/17 |
| `node --test scripts/ci/verify-source-origin.test.mjs`     | 0 — 11/11 |
| `node --test scripts/ci/build-identity-gate.test.mjs`      | 0 — 31/31 |
| `node --test scripts/ci/deploy-control-hardening.test.mjs` | 0 — 52/52 |
| `node --test scripts/ci/compose-deployment-gate.test.mjs`  | 0 — 69/69 |

### 7.4 Repository gates

| Gate                                          | Result                                                       | Exit |
| --------------------------------------------- | ------------------------------------------------------------ | ---- |
| `pnpm format:check`                           | clean                                                        | 0    |
| `pnpm typecheck --force`                      | 27/27 tasks, `Cached: 0`                                     | 0    |
| `pnpm lint --force`                           | 1/1 tasks, `Cached: 0`                                       | 0    |
| `pnpm deadcode:check`                         | clean                                                        | 0    |
| `pnpm turbo run test --force --concurrency=1` | 25/25 tasks, `Cached: 0`; 3857 passed, 101 skipped, 0 failed | 0    |
| `pnpm build --force`                          | 4/4 tasks, `Cached: 0`                                       | 0    |
| `git diff --check`                            | clean                                                        | 0    |

---

## 8. Real Docker cleanup

Only EA-64.1 objects were removed: `beaconhs-ea64-*` containers/networks,
`ea64/*` images, the local registry container and its anonymous volume.

Final state: **0** EA-64 containers, networks, images and Compose projects.
Pre-existing `beaconhs-postgres`, `beaconhs-redis`, `beaconhs-minio`,
`beaconhs-mailpit` and `beaconhs-collabora` were not touched. No
`docker system prune` was used.

---

## 9. Residual risks

| Risk                                                               | Status                                        |
| ------------------------------------------------------------------ | --------------------------------------------- |
| GHCR digest → running image provenance                             | `NOT VERIFIED` — local registry only          |
| Ubuntu target host behaviour (Compose version, daemon, filesystem) | `NOT RUN`                                     |
| Real GitHub Actions run                                            | `NOT RUN`                                     |
| IPv6 registry hosts                                                | explicitly unsupported (usage error)          |
| A hostile actor with daemon access can forge labels                | accepted boundary (socket is root-equivalent) |
| `--lock-fd` trusts the caller to hold the lock                     | documented contract                           |
| The verifier is not wired into any pipeline                        | by design; EA-66 scope                        |

No new false-PASS path was observed. The only deliberate strictness increase is
that **any** non-zero restart count fails a fresh deployment; a container that
restarts once and then runs healthily is still rejected, which is the intended
gate semantics for a just-deployed fleet.

---

## 10. Evidence inventory

| Path                                                      | Content                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `docs/evidence/ea64/remediation/baseline.txt`             | pre-change repo/docker/evidence state                                     |
| `docs/evidence/ea64/remediation/code-change-map.md`       | before/after locations and hashes                                         |
| `docs/evidence/ea64/remediation/real-docker-rerun.md`     | 28/28, 0/6, port A/B, cleanup                                             |
| `docs/evidence/ea64/remediation/repo-digests-boundary.md` | F-64-4 boundary                                                           |
| `docs/evidence/ea64/remediation/fixtures/`                | two real-sample fixtures + `SOURCES.md`                                   |
| `docs/evidence/ea64/remediation/raw/`                     | raw scenario TSVs, crash-loop, registry-port, cleanup, fixture-suite logs |
| `docs/evidence/ea64/remediation/SHA256SUMS`               | hashes of all 15 remediation files; `sha256sum -c` exit 0                 |

The EA-64 original evidence is untouched and still verifies: 17/17 entries,
`sha256sum -c` exit 0.

Final re-checks after this report was written: `pnpm format:check` exit 0, the
fixture suite re-ran 69/69 exit 0 against the final formatted test file, HEAD
still `51a899b7…`, staged 0, protected-file hashes unchanged, and no EA-64
Docker container, network, image or Compose project remained.

---

## 11. Status boundaries (unchanged)

| Item                                | Status                                          |
| ----------------------------------- | ----------------------------------------------- |
| Real GitHub Actions                 | `NOT RUN`                                       |
| Real GHCR                           | `NOT VERIFIED`                                  |
| Real Ubuntu deployment              | `NOT VERIFIED`                                  |
| Isolated Docker Compose             | `RUN` (EA-64 and this rerun)                    |
| Compose Gate 5 on a real deployment | `NOT VERIFIED` (local only)                     |
| Production                          | `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION` |
| A1–A8                               | `PENDING AUTHORIZATION`                         |
| Rollback                            | `FAIL — NO EXECUTABLE ROLLBACK PATH`            |
| Migration 51                        | `NOT RUN`                                       |
| DB / object storage restore         | `NOT RUN`                                       |
| WOPI                                | paused                                          |

---

## 12. Stop

EA-64.1 ends here. EA-65 was not started, CI was not connected, the deployment
workflow was not modified and no Ubuntu deployment was attempted.
