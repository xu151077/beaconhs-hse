# EA-60 — deployment-model confirmation, instance-set completeness, Gate 5 hardening

**Phase type:** authorised repository change (minimal fix + tests + evidence).
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)
**Production changed:** **No.** Nothing was deployed, published, dispatched,
rolled back, migrated or restored.
**Committed / pushed:** **No.** The working tree carries the change, as it has
carried EA-56…EA-59.

---

## 1. Scope

EA-59 recorded four defects and left one of them open by design:

| ID     | Defect                                                                          | EA-60 action                                                                           |
| ------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| F-59-1 | The shipped reconciler passed on an incomplete instance set (EA-59 S12)         | **Fixed**                                                                              |
| F-59-2 | No container inspection path exists                                             | **Not built** — evidence shows the deployment is Swarm, so the path is not needed (§3) |
| F-59-3 | EA-56 report and a workflow comment claim the runner has no running-task access | **Comment corrected**; the historical report is left as history and annotated here     |
| F-59-4 | `RepoDigests` is not registry evidence on a containerd store                    | No code change needed; the gate never uses it                                          |

The authorisation was: read-only probing, `/tmp` prototypes, the minimal
F-59-1 fix with tests and audit docs, and — only if real evidence showed Compose
plain containers — a container path. No production action, no push, no registry
publication, no permission change, no rollback, no migration, no restore.

---

## 2. Baseline

Captured before any edit (`docs/evidence/ea60/baseline.txt`):

```
branch: hse-platform
head:   51a899b7aac0a942da327222a3eed355fca9798a   (expected: match)
status: 165 modified, 521 untracked, 0 staged
git diff --check: clean (exit 0)
```

Pre-edit hashes of the files this phase touches:

| File                                           | Pre-edit SHA256                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `scripts/ci/reconcile-running-digest.sh`       | `535cd2e977684a89091cc8c96d2781b106ca5f15d60d7bd1a1e794641e1acd06`             |
| `.github/workflows/deploy-dev.yml`             | `438f3ef8299b7fe707383d24fbe49b255f6e3862c2074e3056b4e2cb00f2ded3`             |
| `scripts/ci/deploy-control-hardening.test.mjs` | `e8565a651eb37d59716b31744615db37c8ed3bc9effaf358fe69ec944b60fe0c`             |
| `docs/project-development-state.md`            | `6adb6b28cd1a854c2564ed88134da8f284db9db4dbac5b40e98ee3ac4aff125d`             |
| `scripts/ci/build-identity-gate.test.mjs`      | **NOT CAPTURED** — see §11.2                                                   |
| `.github/workflows/ci.yml`                     | `212e07169c0614b23a9084fc432b9252fcf438ac5a7de7f8bb88cd5ef6d833c9` (unchanged) |

`reconcile-running-digest.sh`, `deploy-control-hardening.test.mjs` and
`build-identity-gate.test.mjs` are **untracked** files from EA-56/EA-58, so no
`git diff` exists for them. That is a property of this working tree, not of this
phase; it is why the hashes above are the audit anchor.

---

## 3. Deployment model — what the evidence says

**Conclusion: the BeaconHS deployment is a Swarm stack (`composeType: "stack"`),
not Compose plain containers. Confidence: high, static. Live confirmation is
still `NOT VERIFIED`.**

| #   | Evidence                                                                                                                                                                                    | Tier   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| E1  | `deploy/dokploy-dev.compose.yaml` declares `deploy.replicas` and `deploy.restart_policy` for every service. Plain `docker compose up` ignores `deploy.*`; `docker stack deploy` honours it. | CONFIG |
| E2  | The deploy workflow sends `composeType: "stack"` in `compose.update` (`deploy-dev.yml:473`) and asserts it back in the postcondition (`:494`).                                              | CONFIG |
| E3  | The pre-pull step is named "Pre-pull images onto the swarm manager" and pulls onto the runner's own daemon (`:293-312`).                                                                    | CONFIG |
| E4  | `direct` mode rolls `<stack>_web                                                                                                                                                            | worker | scheduler | storage-init` as Swarm services (`:517-530`); the API-fallback enumerates them by `com.docker.stack.namespace` (`:254-271`). Service naming `<stack>_<role>` is Swarm naming. | CONFIG |
| E5  | Local `docker service ls` exits 1 ("not a swarm manager") — a genuine failing-query shape, and no evidence about the remote host.                                                           | LOCAL  |
| E6  | No Dokploy token, runner registration or network path from this workstation.                                                                                                                | LOCAL  |

What this does **not** prove: that the remote manager currently has those
services converged. That remains `NOT VERIFIED` and is unchanged by this phase.

**Consequence for §5 of the brief:** because the evidence shows Swarm services,
the Compose-container inspection path is **not** justified and was **not built**.
Building it would add a second deployment-shape vocabulary with no deployment
that needs it.

### 3.1 Correction of the EA-56 claim (F-59-3)

`deploy-dev.yml:567-570` said "The Dokploy compose path has no task access from
the runner". The same runner runs `docker service ls/inspect` in `direct` mode
and, per E2, the compose deployment is a stack on that manager. The comment is
now factual: it states that the direct path checks every web task, and that the
compose path's binding proof is the image gate. The EA-56 report is a historical
record and is not rewritten; this section is the correction of record.

---

## 4. F-59-1 — reproduction, then fix

### 4.1 Reproduction (before the fix)

EA-59's S12, re-run against the unmodified reconciler: a stack defined to run
`web`, `worker`, `scheduler` and `storage-init` returns only `web` from the
query; `web` matches the gated digest.

```
$ STUB_SERVICES=$'beaconhs-dev_web\n' STUB_IMAGE=…@sha256:333… \
    bash scripts/ci/reconcile-running-digest.sh beaconhs-dev sha256:333…
beaconhs-dev_web runs the gated digest
Gate 5 PASS: all 1 service(s) run sha256:333…
exit=0
```

Three services were missing and the gate reported success. A filtered query, a
truncated listing, a mid-rollout replica loss and a label mismatch all look
exactly like this.

### 4.2 The fix

`scripts/ci/reconcile-running-digest.sh` now takes a **roster file** as a third
argument and refuses to run without one.

```
Usage: reconcile-running-digest.sh <stack-name> <expected-digest> <roster-file>
```

Roster format (key=value, `#` comments):

```
stack=beaconhs-dev
source=deploy/dokploy-dev.compose.yaml + deploy env (WRITER_REPLICAS=1)
digest=sha256:…
web.replicas=1
web.running=true
worker.replicas=1
worker.running=true
scheduler.replicas=1
scheduler.running=false
storage-init.replicas=1
storage-init.running=false
```

Validation before any fleet query: `stack` must equal the gate's stack; `digest`,
when present, must equal the reconciled digest; every `.replicas` must be a
non-negative integer; every role with `.replicas` must have `.running`; unknown
keys are rejected; an empty roster is rejected. Malformed roster → exit 2.
Missing roster file → exit 1 with an explicit "an unrostered gate cannot detect a
missing service".

Checks after the query:

| #   | Check                                                                                                                            | Failure                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | `docker service ls` succeeded                                                                                                    | exit 1, "query failed" (EA-58 F-4 preserved)                       |
| 2   | Every rostered service exists in the listing                                                                                     | exit 1, "instance set is incomplete"                               |
| 3   | Any unrostered service that **runs the gated image** is rejected                                                                 | exit 1, "absent from the roster"                                   |
| 4   | Every rostered service can be inspected                                                                                          | exit 1, "cannot inspect"                                           |
| 5   | Spec image is digest-addressed and equals the expected digest                                                                    | exit 1                                                             |
| 6   | Long-running roles: `Spec.Mode.Replicated.Replicas` equals the roster                                                            | exit 1, "does not match its own definition"                        |
| 7   | Long-running roles: `service ps` succeeded, every `Running*` task carries the gated digest, and the live count equals the roster | exit 1, "mixed fleet" / "not converged" / "cannot read task state" |
| 8   | One-shot roles: `service ps` succeeded and at least one `Complete*` task carries the gated digest                                | exit 1, "no completed task on the gated digest"                    |
| 9   | At least one service was reconciled                                                                                              | exit 1                                                             |

### 4.2.1 The same scenario after the fix

```
$ … bash scripts/ci/reconcile-running-digest.sh beaconhs-dev sha256:333… roster
::error::Gate 5: rostered service 'beaconhs-dev_storage-init' is not in stack
  'beaconhs-dev' (the query returned 3 service(s)); the instance set is incomplete
::error::Gate 5 failed: the fleet does not match the roster; the instance set is
  not proven complete
exit=1
```

Recorded as E02 in `docs/evidence/ea60/isolated-tests.log`.

### 4.3 One-shot roles are a deliberate part of the contract

`scheduler` and `storage-init` register repeatable jobs and bootstrap storage,
then finish successfully; `restart_policy: on-failure` does not restart them.
After a successful rollout they have **zero live tasks**. Requiring a live task
would make Gate 5 permanently red on a correct deployment. Their identity is
therefore proven by the service spec **and** a completed task on the gated
digest — both facts are recorded, and a one-shot with no completed task on the
digest still fails (E14).

This is the difference between "the fleet has converged" and "the fleet is
allowed to have finished". It is explicit in the roster (`running=false`), not
inferred from a task count.

### 4.4 Where the roster comes from — and why that matters

The workflow generates it in the Gate 5 step from values it already owns:

- `stack` — `DOKPLOY_TARGET_STACK`, resolved from `compose.one` `.appName`;
- `digest` — `IMAGE_DIGEST`, the build job output that was already gated;
- `WRITER_REPLICAS` — the same value the workflow writes into the Dokploy
  environment (`deploy-dev.yml:446`), now declared in the step's `env:`;
- the gated role set — `web`, `worker`, `scheduler`, `storage-init`, which is
  exactly the set both deployment paths roll (`:522-529`) and validate
  (`:263`).

It is **not** derived from `docker service ls`. A roster built from what was
found would agree with any listing, including a truncated one, and would
reintroduce F-59-1.

`minio` and `collabora` are not rostered: they never carry the gated image
(`minio/minio@sha256:b187…`, `collabora/code:26.04.2.1.1@sha256:df33…`). Check 3
still rejects an unrostered service that _does_ carry the gated image.

---

## 5. Shipped changes

| File                                               | Change                                                                                                                                      | Post-edit SHA256                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `scripts/ci/reconcile-running-digest.sh`           | Roster input, completeness, replica/convergence, task-level identity, one-shot semantics                                                    | `18b7e94a51c2adcadddaad14d51558ca26a4765b97869114e92cdc89b9240511` |
| `.github/workflows/deploy-dev.yml`                 | Gate 5 generates and passes the roster; step `env: WRITER_REPLICAS: 1`; stale comment corrected                                             | `cffd9bf1081449bccd482c2727c46e7f31663f915534ae03eb1e99cb4af11c43` |
| `scripts/ci/deploy-control-hardening.test.mjs`     | Stub extended (ps, replica spec, image map); EA-58 tests adapted to the roster contract with their assertions preserved; 16 new EA-60 tests | `f6d817db5878c2e3dfebf2c9acf92f8e3aab94fe9d855e9bdb1355ba4c209f87` |
| `scripts/ci/build-identity-gate.test.mjs`          | Stub extended for the same reason; five EA-56 reconcile tests adapted, assertions preserved                                                 | `29f4351bc6b7db79811ded753b2ee0a105396fb0d37a90ccc5342c1f9758fced` |
| `docs/project-development-state.md`                | EA-60 addendum + §2 phase line                                                                                                              | `aadb317b7ab058a9442899af93ab492a820105c5feeeb31960af0c1db1c39428` |
| `docs/ea60-deployment-gate-completeness-report.md` | this report                                                                                                                                 | hashed in `docs/evidence/ea60/SHA256SUMS`                          |
| `docs/evidence/ea60/`                              | baseline, isolated log, gate logs, hashes                                                                                                   | see §12                                                            |

`ci.yml` is **unchanged**: the new tests live in the suite it already runs at
`ci.yml:120`, and `EA58-T36` pins that wiring.

### 5.1 What was deliberately not changed

- The digest comparison itself, the readiness step, migrations, publication,
  signatures, SBOM, OIDC, permissions, and every other gate.
- No container-inspection path (§3).
- No new queue, table, module, permission or navigation entry. This is CI-only;
  no user-facing UI changed, so the in-app manual and walkthroughs need no edit.
- No `RepoDigests` use anywhere.

---

## 6. Tests

### 6.1 Repository suites (offline, stubs only)

| Suite                                                 | Result                                             |
| ----------------------------------------------------- | -------------------------------------------------- |
| `scripts/ci/deploy-control-hardening.test.mjs`        | **52 / 52 passed**, 0 failed (36 EA-58 + 16 EA-60) |
| `scripts/ci/build-identity-gate.test.mjs`             | **31 / 31 passed**, 0 failed                       |
| `scripts/ci/replica-coverage.test.mjs`                | 17 / 17 passed                                     |
| `scripts/ci/verify-source-origin.test.mjs`            | 11 / 11 passed                                     |
| `scripts/cluster/dokploy-curl.test.sh`                | pass                                               |
| `scripts/ci/require-current-main.test.sh`             | pass                                               |
| `scripts/ci/workflow-repository-immutability.test.sh` | pass                                               |
| `scripts/ci/verify-server-action-key-gate.test.sh`    | pass                                               |

The EA-58 tests were adapted, not weakened: every original assertion still
exists, with the input changed from "one or two services" to "the converged
four-service fleet the workflow now defines". Where a message improved
(`do not run the gated digest` → `do not hold against the roster`), the
assertion follows the new message and keeps the same verdict.

### 6.2 Isolated Gate 5 scenarios (shipped script, docker stub)

`docs/evidence/ea60/isolated-tests.log` — **25 scenarios, 25 matched, 0
mismatched**, each recording input, expected result, actual exit code and the
gate's own message. Coverage of the brief's required cases:

| Required case                         | Scenario                |
| ------------------------------------- | ----------------------- |
| complete instance set, all matching   | E01, E24                |
| instance set missing a service        | E02 (EA-59 S12)         |
| replicas below / above expectation    | E09, E25                |
| query returns a partial result        | E02, E03                |
| query command fails                   | E04                     |
| single inspect fails                  | E05                     |
| mixed versions during a rollout       | E07, E08                |
| identity not reliably mapped          | E12, E13                |
| readiness success but digest mismatch | E11                     |
| target service absent                 | E03                     |
| roster missing or illegal             | E18, E19, E20, E21, E22 |
| evidence stale/incomplete             | E09, E16                |
| full positive control                 | E01, E15, E24           |

These are synthetic Swarm responses. **No Dokploy, Swarm or GitHub Actions
system was contacted**, and the log says so in its header.

### 6.3 Environment note

The host's Docker daemon restarted during this phase (containers showed
`Exited (255)`), so the local dev fixtures (`beaconhs-postgres`, `-redis`,
`-minio`, `-mailpit`) were stopped. They were **started** (not recreated, not
deleted) so the mandated test gate could run against its own fixtures; Postgres
then completed crash recovery. The first full-suite attempt failed in
`@beaconhs/storage` and `@beaconhs/object-store-backup` because MinIO was still
recovering; both packages pass once it was healthy (storage 148/148,
object-store-backup 139 passed / 38 skipped). The fixtures were stopped a second
time by something outside this session (`Exited (0)`, SIGTERM) during a full-suite
run; they were started again and the suite passed. Both incidents are
infrastructure, not code: the same packages pass whenever MinIO is healthy. No
production service was touched.

---

## 7. Workflow control order and fail-closed audit

Order is unchanged and still pinned by `EA58-T35`:

```
origin check → build → assert revision → promote → pre-deploy gate
→ migrations → readiness → per-replica key gate (direct) → Gate 5 (last)
```

Gate 5 remains the final deploy step (`EA58-T3`), unconditional (`EA58-T1`),
non-`continue-on-error` (`EA58-T4`), and cannot exit 0 by fiat (`EA58-T2`).
The new assertions extend T2: the step must build a roster and pass it, and must
not query the fleet to build it (`EA60-T14`).

Fail-closed matrix for the shipped gate:

| Condition                                     | Exit | Message                                    |
| --------------------------------------------- | ---- | ------------------------------------------ |
| missing arguments / bad digest                | 2    | usage / "not a canonical sha256 digest"    |
| roster unreadable                             | 1    | "no roster file"                           |
| roster malformed, wrong stack, wrong digest   | 2    | specific reason                            |
| `service ls` fails                            | 1    | "query failed … not an empty fleet"        |
| listing empty / missing a rostered service    | 1    | "instance set is incomplete"               |
| unrostered service on the gated image         | 1    | "absent from the roster"                   |
| inspect fails                                 | 1    | "cannot inspect"                           |
| spec not digest-addressed / wrong digest      | 1    | "runs …, expected …"                       |
| replica spec ≠ roster                         | 1    | "does not match its own definition"        |
| `service ps` fails                            | 1    | "cannot read task state"                   |
| running task on another digest                | 1    | "mixed fleet"                              |
| live tasks ≠ desired                          | 1    | "not converged"                            |
| one-shot with no completed task on the digest | 1    | "no completed task on the gated digest"    |
| all checks hold                               | 0    | "Gate 5 PASS: all N rostered service(s) …" |

There is no path that prints PASS after a failed check, and no path that treats
a query failure, an empty result or a missing roster as success.

---

## 8. Docker socket and query permissions

Unchanged from EA-59 and restated because this phase depends on it:

- Gate 5 needs `docker service ls`, `docker service inspect`, `docker service ps`
  on the deployment manager. The runner already has this in `direct` mode
  (`deploy-dev.yml:254-271`).
- The Docker Engine API has **no read-only mode**. Socket access is
  root-equivalent: a principal that can list services can also update them. A
  `GET`-only socket proxy reduces the blast radius of a bug in the gate script;
  it is not a Docker permission and does not scope which services are visible.
- Gate 5 reads only `Spec.TaskTemplate.ContainerSpec.Image`,
  `Spec.Mode.Replicated.Replicas` and `service ps` rows for services in the
  target stack. It writes nothing and never calls `update`, `rm` or `exec`.
- The `service ps` rows include task images, which is how a mixed fleet is
  detected. They contain no secrets.

---

## 9. Real CI, GHCR and deployment platform

| Item                                  | Status                                          | Why                                                               |
| ------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| Real GitHub Actions for this revision | `NOT RUN`                                       | nothing committed or pushed; 0 runs exist for `51a899b7` upstream |
| Real GHCR publication                 | `NOT RUN`                                       | no credentials; anonymous pull refused (EA-59)                    |
| Real Dokploy Gate 5                   | `NOT VERIFIED`                                  | no token, no runner, no host access                               |
| Live Swarm confirmation of the model  | `NOT VERIFIED`                                  | requires one read-only command on the deployment host (§3)        |
| Image signature / SBOM                | unchanged                                       | out of scope                                                      |
| Migration 51                          | `NOT RUN`                                       | out of scope                                                      |
| Database / object-store restore       | `NOT RUN`                                       | out of scope                                                      |
| Rollback                              | `FAIL — NO EXECUTABLE ROLLBACK PATH`            | unchanged                                                         |
| Production                            | `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION` | unchanged                                                         |

The static evidence in §3 is strong, but it is configuration evidence. It does
not become a live verification because the tests pass.

---

## 10. Gates

Each command was run separately and its own exit code captured.

| Gate                                          | Result                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm format:check`                           | exit 0 — "All matched files use Prettier code style!"                 |
| `pnpm typecheck --force`                      | exit 0 — 27/27, **`Cached: 0`**, 13.9 s                               |
| `pnpm lint --force`                           | exit 0 — 1/1, **`Cached: 0`**, 42.8 s                                 |
| `pnpm deadcode:check`                         | exit 0 — knip, no findings                                            |
| `pnpm turbo run test --force --concurrency=1` | exit 0 — 25/25, **`Cached: 0`**, 3857 passed / 101 skipped / 0 failed |
| `pnpm build --force`                          | exit 0 — 4/4, **`Cached: 0`**, 51.4 s                                 |
| `git diff --check`                            | exit 0                                                                |

### 10.1 Cache traps caught

`pnpm typecheck` and `pnpm lint` both returned exit 0 from a **FULL TURBO**
cache replay on the first attempt, and the first `pnpm build` returned exit 0
from a 683 ms cache hit with `Cached: 4`. None of those is evidence that
anything ran, so all three were re-run with `--force`; the table above reports
only the forced runs. The full test suite was likewise run with
`--force --concurrency=1` so no result is a replay.

---

## 11. Open items and honest gaps

### 11.1 F-59-1 is closed at the control level, not at the platform level

The gate can now prove completeness **when it can see the fleet**. Whether it
can see the fleet on the Dokploy manager is still `NOT VERIFIED`. If it cannot,
every deployment fails closed — correct, but the release path stays blocked until
someone runs the read-only check in §3 on that host.

### 11.2 Pre-edit hash of `build-identity-gate.test.mjs` was not captured

Same process gap EA-58 recorded. Compensating evidence: the file is untracked, so
no `git diff` exists; the exact edits are described in §5 (stub extension +
five reconcile tests), the post-edit file is hashed, and all 31 of its tests
pass. The pre-edit version was the EA-58 state, whose 31/31 result is recorded in
`docs/ea58-gate5-and-ci-control-hardening-report.md`.

### 11.3 `/tmp` artefacts were lost mid-phase

The environment cleared `/tmp/opencode` twice during EA-60 (the clock advanced
three days between sessions). The EA-59 evidence bundle and the first EA-60
prototype run were lost with it. This report therefore relies on:

- the **shipped** script and tests, which are in the repository and hashed here;
- `docs/evidence/ea60/isolated-tests.log`, regenerated after the loss against the
  shipped script, with all 25 scenarios and exit codes;
- the pre-fix reproduction, which was re-run and is quoted verbatim in §4.1.

Nothing in this report depends on an artefact that no longer exists.

### 11.4 `actionlint` is still not available

Workflow validation remains YAML parsing plus executing the extracted `run:`
block. A workflow-aware linter was not fetched.

### 11.5 Pre-existing defects unchanged

EA-57 `D8` (82 FKs missing from the Drizzle snapshot chain) and `D9`
(`canSeeWidget` default-visible) are untouched and out of scope.

### 11.6 Next step and the authorisation it needs

1. **No authorisation needed, one command:** on the Dokploy manager, run the
   three read-only queries in `docs/evidence/ea60/blockers.md` §1. That converts
   B-60-1 from `NOT VERIFIED` to either "the stack is visible" or "the stack is
   not visible", and it is the only thing standing between this gate and a real
   deployment check.
2. **Authorisation needed — commit and push:** until the change is on a branch
   the upstream repository builds, real GitHub Actions stays `NOT RUN` and the
   new tests never run in CI. This phase was not authorised to commit.
3. **Authorisation needed — a live deployment:** only then can Gate 5 be
   observed end to end, and only then can the rollout/one-shot paths be checked
   against real `docker service ps` output rather than the stub.
4. **Not recommended:** relaxing Gate 5, or adding a container-inspection path
   "just in case". §3 shows the deployment is a Swarm stack; adding a second
   shape would be speculative complexity.

---

## 12. Evidence bundle

`docs/evidence/ea60/`:

| File                                                                            | Contents                                                       |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `baseline.txt`                                                                  | pre-edit repo state and hashes                                 |
| `isolated-cases.sh`                                                             | the 25-scenario driver (re-runnable)                           |
| `isolated-tests.log`                                                            | the 25 scenarios: input, expected, actual, exit code           |
| `gate-test.log`                                                                 | forced serial full suite                                       |
| `gate-build.log`                                                                | production build                                               |
| `gate-format.log`, `gate-typecheck*.log`, `gate-lint*.log`, `gate-deadcode.log` | per-gate output                                                |
| `SHA256SUMS`                                                                    | integrity of every file above                                  |
| `work/`                                                                         | docker stub, roster fixtures, image maps used by the scenarios |

### 12.1 Final gate transcription

| Gate                                     | Exit          | Evidence file        |
| ---------------------------------------- | ------------- | -------------------- |
| `format:check`                           | 0             | `gate-format.log`    |
| `typecheck --force`                      | 0             | `gate-typecheck.log` |
| `lint --force`                           | 0             | `gate-lint.log`      |
| `deadcode:check`                         | 0             | `gate-deadcode.log`  |
| `turbo run test --force --concurrency=1` | 0             | `gate-test.log`      |
| `build --force`                          | 0             | `gate-build.log`     |
| isolated Gate 5 scenarios                | 25/25 matched | `isolated-tests.log` |
| `git diff --check`                       | 0             | —                    |

`local-validation.log` is the single-page summary of all of the above.

### 12.2 Repository state after the phase

```
branch: hse-platform
head:   51a899b7aac0a942da327222a3eed355fca9798a   (unchanged)
status: 165 modified, 522 untracked, 0 staged
git diff --check: exit 0
```

The modified count is unchanged from the baseline because `deploy-dev.yml` and
`docs/project-development-state.md` were already in the modified set; this phase
changed their contents, not the count. The single new untracked entry is this
report plus `docs/evidence/ea60/` (already inside the untracked `docs/evidence/`
tree). No file outside the list in §5 was touched.

`docs/evidence/ea60/SHA256SUMS` verifies 13/13 files, exit 0, including this
report and `docs/project-development-state.md`.

---

## 13. Stop

EA-60 ends here. EA-61 was not started.

- Production: `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
- Rollback: `FAIL — NO EXECUTABLE ROLLBACK PATH`
- Real GitHub Actions: `NOT RUN`
- Real GHCR: `NOT RUN`
- Real Dokploy Gate 5: `NOT VERIFIED`
- A1–A8: `PENDING AUTHORIZATION`
- Migration 51, database and object-store restore: `NOT RUN`
