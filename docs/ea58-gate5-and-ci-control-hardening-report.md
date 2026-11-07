# EA-58 — Deployment-gate false-positive repair and CI control hardening

Status date: 2026-10-27
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform` · HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Production state: **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**

Status vocabulary, kept separate on purpose: `PASS`, `PARTIAL`, `FAIL`,
`NOT RUN`, `NOT VERIFIED`, `PENDING AUTHORIZATION`.

---

## 0. The one thing this report must not do

It must not let a local result stand in for a remote one. Five tiers are involved
and they are reported separately throughout:

| Tier                                                | What it establishes                                                      | Result in EA-58                  |
| --------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| **A. Local repository gates**                       | The workspace still formats, type-checks, lints, tests and builds        | `PASS` — §4                      |
| **B. Isolated control tests**                       | Each repaired control blocks what it must block, under adversarial input | `PASS` 78/78 — §3, §4            |
| **C. Pre-fix reproduction**                         | The shipped code actually exhibited the four defects before the change   | `PASS` (defects reproduced) — §3 |
| **D. Static workflow audit**                        | The checked-in YAML orders the controls correctly and has no bypass      | `PASS` — §5                      |
| **E. Real GitHub Actions / GHCR / Dokploy / Swarm** | GitHub ran it, the registry served the same bytes, the fleet matched     | `NOT RUN` / `NOT VERIFIED` — §6  |

A, B, C and D are done. E was not executed, and nothing in A–D is offered as
evidence for E.

---

## 1. Baseline, branch, workspace and protection of existing work

### 1.1 Pre-flight (executed before any edit)

```
$ git branch --show-current
hse-platform
$ git rev-parse HEAD
51a899b7aac0a942da327222a3eed355fca9798a
$ git status --short | awk '{print $1}' | sort | uniq -c
    519 ??
    165 M
$ git diff --cached --name-only | wc -l
0
$ git diff --check
(no output, exit 0)
$ stat -c '%y %n' turbo.json
2026-10-23 11:04:04.542871014 +0800 turbo.json
```

Branch and HEAD matched the expected values, so the phase proceeded. All eight
EA-58 delivery paths were confirmed **absent** before creation — nothing that
already existed was overwritten.

### 1.2 What EA-58 changed

Authorized scope only:

| Path                                                 | Change                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/deploy-dev.yml`                   | Gate 5 now runs on every deployment path and fails closed (§2.1); the unused `GITHUB_TOKEN` was removed from the source-origin step (§2.4) |
| `.github/workflows/ci.yml`                           | the new regression suite is invoked in `Test deployment host safeguards`, line 120 (§2.3)                                                  |
| `scripts/ci/reconcile-running-digest.sh`             | query-status propagation and three distinct diagnostics (§2.2)                                                                             |
| `scripts/ci/verify-image-identity.mjs`               | verifier contract validation — exit status, JSON shape, exact verdict, check map (§2.3)                                                    |
| `scripts/ci/deploy-control-hardening.test.mjs`       | **new** — 36 regression tests                                                                                                              |
| `docs/ea58-gate5-and-ci-control-hardening-report.md` | **new** — this report                                                                                                                      |
| `docs/evidence/ea58/**`                              | **new** — evidence bundle                                                                                                                  |

Nothing else was touched. No migration, no restore, no rollback implementation,
no permission widening, no new credential, no commit, no push, no image
publication, no deployment.

### 1.3 What was protected

- No `git reset --hard`, `git clean`, `git restore`, `git checkout`, `git add -A`.
- 165 pre-existing modified and 519 pre-existing untracked entries preserved;
  nothing was reverted or "tidied".
- `turbo.json` keeps its baseline ` M` status and identical mtime.
- No container, image, volume, backup or evidence file was deleted.
- Every prior report and evidence bundle is intact.

### 1.4 One disclosed deviation

The **pre-edit hashes** of the four control files were not captured before the
edits landed. They are reported as `NOT CAPTURED` in
`docs/evidence/ea58/baseline.txt` and in `blockers.md` §4, with the compensating
evidence named there. A hash table reconstructed after the fact would have
presented itself as a baseline; it is not offered.

---

## 2. Root cause, files, lines and method — the four fixes

### 2.1 Fix 1 — the Dokploy compose path reported an unverified Gate 5 as success

**Root cause.** `deploy-dev.yml` special-cased the deployment mode:

```sh
if [ "$DOKPLOY_DEPLOY_MODE" != 'direct' ]; then
  echo "::warning::Gate 5 NOT VERIFIED: the Dokploy compose path exposes no running-task access from this runner, …"
  exit 0
fi
```

The compose branch had no way to read the running digest, so instead of failing
it wrote a warning annotation and exited **0**. Since Gate 5 is the last step of
the `deploy` job, the job and the whole run concluded success. A GitHub annotation
is not a gate: the only signal a release pipeline reliably propagates is the
exit status.

**File / lines.** `.github/workflows/deploy-dev.yml`, old block at 588–595, new
block at **589–595**.

**Method.** The mode special case was removed entirely and the reconciler is now
invoked on every path:

```sh
set -euo pipefail
if ! scripts/ci/reconcile-running-digest.sh "$DOKPLOY_TARGET_STACK" "$IMAGE_DIGEST"; then
  echo "::error::Gate 5 could not prove that stack '${DOKPLOY_TARGET_STACK}' runs ${IMAGE_DIGEST}. The rollout may have been requested, but this run is not a verified release: the running image digest was not read back and matched." >&2
  exit 1
fi
```

Why this shape rather than an unconditional `exit 1` on the compose branch: the
instruction requires the compose path to be able to **pass** when a digest is
genuinely readable and matching (cases 2 and 3). Deleting the branch lets the
reconciler's own fail-closed logic decide:

| Situation                                     | Reconciler result                    | Run conclusion |
| --------------------------------------------- | ------------------------------------ | -------------- |
| stack not visible to the runner               | exit 1 — no matching service         | **failure**    |
| stack visible, digest matches                 | exit 0                               | success        |
| stack visible, digest differs                 | exit 1                               | **failure**    |
| `docker service ls` fails                     | exit 1 — query failure               | **failure**    |
| readiness 200 while the digest cannot be read | exit 1 — readiness is never an input | **failure**    |

Readiness, the expected digest and the release tag are never accepted as
substitutes for the running digest, and the Swarm digest comparison inside the
reconciler was not touched.

**Side effects were analysed before changing the exit code**, as required:
Gate 5 is the final step of the `deploy` job (19 steps, last one is
`Reconcile the running image digest`); no repository-wide rollback, cleanup or
notification job consumes a failed deploy; `concurrency.cancel-in-progress` is
`false`; and `deploy-dev` is the terminal caller job. The only observable
change is the job/run conclusion — which is precisely the intent.

### 2.2 Fix 2 — F-4: a failed Docker query was reported as "no matching service"

**Root cause.** `reconcile-running-digest.sh` fed the listing through a process
substitution:

```sh
done < <(docker service ls --format '{{.Name}}' --filter "label=com.docker.stack.namespace=${stack}")
```

A process substitution discards the producer's exit status, so a daemon
connection failure produced an empty stream, which the loop then reported as
"matched no running BeaconHS service". The operator was told the fleet was
empty when the truth was that the query never ran.

**File / lines.** `scripts/ci/reconcile-running-digest.sh` — the listing block
and the `matched == 0` block.

**Method.** The listing is now captured with its status observable:

```sh
if ! services="$(docker service ls --format '{{.Name}}' \
  --filter "label=com.docker.stack.namespace=${stack}")"; then
  echo "::error::Gate 5 could not list services for stack '$stack': the 'docker service ls' query failed (see the error above). This is a query failure, not an empty fleet; the running digest is unverified." >&2
  exit 1
fi
```

and the loop reads from the captured string (`done <<<"$services"`), so the
counters still live in the current shell. Three outcomes are now distinct:

| Outcome                                                | Diagnostic                                                              | Exit |
| ------------------------------------------------------ | ----------------------------------------------------------------------- | ---- |
| query failed                                           | `could not list services … query failed`, Docker's own stderr preserved | 1    |
| query succeeded, no services                           | `matched no running BeaconHS service … returned no service`             | 1    |
| query succeeded, services present but none is BeaconHS | `found N service(s) … none is a BeaconHS web/worker/scheduler service`  | 1    |

Everything else stayed fail-closed and unchanged: the canonical-digest guard,
`inspect` failure, digest mismatch, partial match, and `matched == 0 → exit 1`.
No secret, token or environment variable is printed on any path.

### 2.3 Fix 3 — F-2: the wrapper trusted the exit code, not the verdict

**Root cause.** `verify-image-identity.mjs` delegated to
`verify-build-identity.mjs` and then wrote:

```js
exitCode = verify.ok ? 0 : 1
```

The verifier's real contract (confirmed by reading its source) is:

```
--json → { dist, expected, embedded, checks: {...}, verdict: "PASS" | "FAIL", reason }
exit 0 iff verdict === "PASS"
```

so the wrapper recorded `result.verdict` from the JSON but never used it. A
verifier build whose exit status and verdict disagree — exit 0 with `FAIL`, a
truncated output, or a rewritten contract — would have promoted an image.

**File / lines.** `scripts/ci/verify-image-identity.mjs`, new exported
`interpretVerifierResult()` and the `main()` call site.

**Method.** The decision is now a contract check, in this order:

1. the verifier exited 0 — otherwise fail, **whatever the output says**;
2. the output parses as exactly one JSON object (not `null`, not an array);
3. `verdict` exists, is a non-empty string, and equals `PASS` **exactly** —
   never a substring test (`NOT PASS`, `PASSING`, `pass`, `" PASS"`, `"PASS "`
   all fail);
4. `checks` is a non-array object containing no `false` value.

The wrapper's own `verdict` is its adjudication (`PASS` only when all four hold);
the verifier's claim is preserved separately as `verifier_verdict` for diagnosis.
The identity fields, the version semantics and the trusted-source rules are
untouched, and the script is now importable without executing (a direct-run
guard), which is what makes the contract unit-testable without Docker. The
Docker end-to-end paths remain covered by EA-56's T25d/T25e/T25f, still passing.

### 2.4 Fix 4 — F-1: an unused `GITHUB_TOKEN` on the source-origin step

**Root cause.** The step carried `env: GITHUB_TOKEN: ${{ github.token }}` but
`verify-source-origin.mjs` reads only `git` state and its own `--expect`,
`--event`, `--ref` flags — no network call, no API call. It was a credential
handed to a process that could not use it: unnecessary blast radius.

**File / lines.** `.github/workflows/deploy-dev.yml`, step now at **89–94**; the
`env:` block was removed.

**Method.** Before removing it, the script was read in full to confirm the token
was genuinely unused (`TOKEN`, `fetch(`, `https://`, `gh`, `curl` — no matches).
The step was replaced with a one-line justification comment:
`# Reads only git state: no network, no API, therefore no credential.`

The four steps that **do** use a token were left exactly as they were:

| Line | Credential             | Why it is needed                                     |
| ---- | ---------------------- | ---------------------------------------------------- |
| 58   | `GITHUB_TOKEN`         | `require-current-main.sh` reads the GitHub API       |
| 65   | `secrets.GITHUB_TOKEN` | `docker/login-action` pulls the private base image   |
| 296  | `GHCR_TOKEN`           | pre-pull proves the package token can read the image |
| 346  | `GHCR_TOKEN`           | the pre-deploy gate reads the OCI index              |

No `permissions:` scope was widened, `packages: write` is unchanged,
`secrets: inherit` is unchanged, and nothing was added to OIDC.

### 2.5 Fix 3 (wiring) — the new suite must actually run

The suite lives outside the Turbo graph, so `pnpm test` alone would never
execute it. It is wired into `.github/workflows/ci.yml:120`, inside the existing
`Test deployment host safeguards` step:

```
node --test scripts/ci/verify-source-origin.test.mjs
node --test scripts/ci/build-identity-gate.test.mjs
node --test scripts/ci/deploy-control-hardening.test.mjs
```

EA58-T36 asserts that wiring, so a future edit cannot silently leave the new
tests unexecuted.

---

## 3. Pre-fix reproduction and post-fix regression

Both halves are stored verbatim in `docs/evidence/ea58/control-reproduction.log`
(PART A pre-fix, PART B post-fix). PART A was executed **before any file was
edited**, so it is a reproduction and not a reconstruction.

### 3.1 Fix 1 — compose path

|                             | Pre-fix (executed on the shipped code)             | Post-fix (executed on the fixed code)                                                                                               |
| --------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| compose, no visible service | `::warning::Gate 5 NOT VERIFIED …` then **exit 0** | `::error::Gate 5 matched no running BeaconHS service …` then `::error::Gate 5 could not prove … not a verified release`, **exit 1** |
| compose, matching digest    | n/a — the branch never reached the reconciler      | `Gate 5 PASS: all 1 service(s) run sha256:3333…`, **exit 0**                                                                        |
| compose, different digest   | n/a                                                | `beaconhs-dev_web runs sha256:7777…, expected sha256:3333…`, **exit 1**                                                             |
| `docker service ls` fails   | n/a                                                | `could not list services … query failed`, Docker's `connection refused` preserved, **exit 1**                                       |

### 3.2 Fix 2 — F-4

|                                 | Pre-fix                                                                                             | Post-fix                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `service ls` exits 1            | `::error::Gate 5 matched no running BeaconHS service in stack 'beaconhs'` — **wrong cause**, exit 1 | `::error::Gate 5 could not list services … query failed … This is a query failure, not an empty fleet`, exit 1 |
| `service ls` succeeds, empty    | `matched no running BeaconHS service`, exit 1                                                       | `matched no running BeaconHS service … the query succeeded and returned no service`, exit 1                    |
| services present, none BeaconHS | (same "no match" message)                                                                           | `found 2 service(s) … none is a BeaconHS web/worker/scheduler service`, exit 1                                 |

Both messages are retained in the pre-fix log exactly as printed, including
Docker's own `connection refused` line.

### 3.3 Fix 3 — F-2

Pre-fix, the shipped decision expression was evaluated against the verifier
results it must reject. It blocks **1 of 5**:

| Input                    | Shipped expression | Should block | Blocked |
| ------------------------ | ------------------ | ------------ | ------- |
| exit 0 + `FAIL`          | exit 0             | yes          | **no**  |
| exit 0 + `PARTIAL`       | exit 0             | yes          | **no**  |
| exit 0 + missing verdict | exit 0             | yes          | **no**  |
| exit 0 + invalid JSON    | exit 0             | yes          | **no**  |
| exit 1 + `PASS`          | exit 1             | yes          | yes     |

This half is an **expression-level** reproduction: the real verifier is
internally consistent today, so an end-to-end image cannot produce "exit 0 +
FAIL". That limitation is stated in the log rather than hidden — the defect is a
missing check, not an exploitable path.

Post-fix, all seven hostile inputs are blocked and the honest control passes:

```
exit 0 + PASS + clean checks    exitCode=0  PASS
exit 0 + verdict FAIL           exitCode=1  BLOCKED
exit 0 + verdict PARTIAL        exitCode=1  BLOCKED
exit 0 + verdict missing        exitCode=1  BLOCKED
exit 0 + invalid JSON           exitCode=1  BLOCKED
exit 1 + verdict PASS           exitCode=1  BLOCKED
exit 0 + PASS + failed check    exitCode=1  BLOCKED
exit 0 + verdict "NOT PASS"     exitCode=1  BLOCKED
```

### 3.4 Fix 4 — F-1

Post-fix the step reads:

```yaml
- name: Verify the source revision matches the checkout
  run: >-
    node scripts/ci/verify-source-origin.mjs
    --expect "${{ github.sha }}"
    --event "${{ github.event_name }}"
    --ref "${{ github.ref }}"
```

`GITHUB_TOKEN` occurrences in the step: **0**. Occurrences that remain in the
file (58, 65, 296, 346) all belong to steps that genuinely use them.

---

## 4. Test results, with actual exit codes

Full detail: `docs/evidence/ea58/regression-tests.log` and
`docs/evidence/ea58/local-validation.log`.

### 4.1 Control suites (run directly with `node --test`, no Turbo cache involved)

| Command                                                        | Tests | Pass | Fail | Skip | Exit  |
| -------------------------------------------------------------- | ----- | ---- | ---- | ---- | ----- |
| `node --test scripts/ci/deploy-control-hardening.test.mjs`     | 36    | 36   | 0    | 0    | **0** |
| `node --test scripts/ci/build-identity-gate.test.mjs` (EA-56)  | 31    | 31   | 0    | 0    | **0** |
| `node --test scripts/ci/verify-source-origin.test.mjs` (EA-56) | 11    | 11   | 0    | 0    | **0** |

### 4.2 Coverage of the instruction's required cases

| Required case                                           | Test                 |
| ------------------------------------------------------- | -------------------- |
| Compose cannot obtain the running digest                | EA58-T5 (plus T1–T4) |
| Compose obtains a digest and it matches                 | EA58-T6              |
| Compose obtains a digest and it differs                 | EA58-T7              |
| The query command errors                                | EA58-T8              |
| Readiness succeeds but the digest is unverifiable       | EA58-T9              |
| A failed Gate 5 must not let downstream declare success | EA58-T3 + T10        |
| Query failure vs empty result vs no BeaconHS service    | T8, T12, T13, T14    |
| Partial match / mismatch / uninspectable service        | T15, T16, T11        |
| Exit 0 + `FAIL` / `PARTIAL` / missing verdict           | T21, T22, T23        |
| Invalid output / non-object / non-zero + `PASS`         | T25, T26, T27        |
| No substring matching on the verdict                    | T30                  |
| The source-origin step carries no credential            | T32                  |
| Steps that need a token keep it                         | T34                  |
| The new suite is executed by CI                         | T36                  |

### 4.3 Repository gates

| Command                                            | Result                                                   | Exit  |
| -------------------------------------------------- | -------------------------------------------------------- | ----- |
| `pnpm format:check`                                | all files formatted                                      | **0** |
| `pnpm typecheck`                                   | 27/27                                                    | **0** |
| `pnpm exec turbo run typecheck --force`            | 27/27, `Cached: 0`                                       | **0** |
| `pnpm lint`                                        | 1/1                                                      | **0** |
| `pnpm exec turbo run lint --force`                 | 1/1, `Cached: 0`                                         | **0** |
| `pnpm deadcode:check`                              | no findings                                              | **0** |
| `pnpm exec turbo run test --force --concurrency=1` | 25/25, `Cached: 0`, 3911 passed / 101 skipped / 0 failed | **0** |
| `git diff --check`                                 | clean                                                    | **0** |
| YAML parse of both workflows (`yaml.safe_load`)    | both parse; `deploy` has 19 steps, last is Gate 5        | **0** |

`pnpm test` was executed with `--force --concurrency=1` **on purpose**: EA-57
caught a prior result that was a Turbo cache replay, and default parallelism is
unstable on this 3.4 GB host. `Cached: 0` is the field that proves the tasks
really ran. Test totals: vitest 3857 passed / 101 skipped, `node --test`
packages 54 passed — 3911 total.

`actionlint` is not installed on this host and was not fetched; workflow
validation was YAML parsing plus executing the extracted step bodies. That gap
is recorded rather than passed over.

---

## 5. Workflow step order and blocking conditions

Full audit: `docs/evidence/ea58/workflow-audit.md`.

### 5.1 Order (post-change line numbers)

```
build:  require CI caller (41) → reject stale runs (56) → key fingerprint (71)
        → verify source origin (89) → build to staging-<sha> (96)
        → assert identity (123) → promote digest (132)
deploy: needs: build (143)
        → validate immutable output (173) → pre-pull (293)
        → Server Action gate (327) → candidate image gate (343)
        → migrations (372) → compose deploy (501) | Swarm rollout (517)
        → readiness (532) → replica verification (571)
        → Gate 5 digest reconciliation (589)
```

No step was reordered. The token removal shifted subsequent line numbers by one.

### 5.2 Blocking conditions, as verified statically

- **origin → build**: a plain `run:` step, no `if:`, no `continue-on-error`;
  non-zero aborts before the build action.
- **assertion → promotion**: both unconditional, assertion first, so a bad
  artefact can never acquire the release tag.
- **promotion → deploy**: `deploy` declares `needs: build` with no job-level
  `if:`, so a failed promotion skips the entire deploy job.
- **gate → migrations → rollout**: same job, later steps, no `always()`; a gate
  failure skips both migration and rollout.
- **Gate 5**: last step of the job, not `continue-on-error`, and the only branch
  on failure is `exit 1`. Nothing downstream exists that could announce success.

### 5.3 The `direct` branches that remain

Two steps still select on `DOKPLOY_DEPLOY_MODE`: `Roll the immutable image
directly on Swarm` (517) and `Verify every web replica's commit and Server
Action key` (571). These choose _how_ the rollout is performed; they are not gate
suppression. In `api` mode Dokploy performs the rollout at 501, so the deployment
still happens and still has to pass Gate 5.

---

## 6. Real CI, GHCR, Dokploy and Swarm — actual status

| Item                                                                    | Status                                              | Basis                                                                                                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Real GitHub Actions execution of `ci.yml` / `deploy-dev.yml`            | **`NOT RUN`**                                       | No `gh`, no `act`, no token; pushing or dispatching is outside the authorization. Nothing was pushed.                                   |
| Real GHCR staging→release digest proof                                  | **`NOT RUN`**                                       | No registry credentials (anonymous inspect returns 401) and no `staging-<sha>` artefact for this revision exists.                       |
| Real deployment-platform Gate 5 (Dokploy compose)                       | **`NOT VERIFIED`**                                  | No access to the `[self-hosted, dokploy]` runner; no live stack to reconcile.                                                           |
| Real deployment-platform Gate 5 (Swarm)                                 | **`NOT VERIFIED`**                                  | Local Swarm is `inactive`; no live fleet to inspect.                                                                                    |
| Dokploy runner `docker buildx` capability                               | **`NOT VERIFIED`**                                  | Runner-side capability, unreachable from here.                                                                                          |
| Signature A1/A2, SBOM A6, observe-only A5 and remaining A1–A8 decisions | **`PENDING AUTHORIZATION`**                         | Not authorized in this phase.                                                                                                           |
| Rollback execution path                                                 | **`FAIL — NO EXECUTABLE ROLLBACK PATH`**            | No rollback implementation exists. EA-58 verified only that no rollback job is triggered, which is what made the exit-code change safe. |
| Migration 51                                                            | **`NOT RUN`**                                       | Explicitly excluded.                                                                                                                    |
| Database and object-store restore                                       | **`NOT RUN`**                                       | Explicitly excluded.                                                                                                                    |
| Production                                                              | **`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`** | No deployment of any kind was performed.                                                                                                |

**No status above was upgraded.** In particular, EA-58 does not claim the compose
false positive is fixed _in production_ — it claims the control now fails closed,
verified locally. The distinction matters because the compose path will, until
the runner gains service readback, fail every deployment at its last step.

---

## 7. Residual risk, required authorization and next steps

### 7.1 Residual risks

| ID  | Severity   | Risk                                                                                                                               | Note                                                                           |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| R-1 | **MEDIUM** | Every Dokploy compose deployment now ends with a failed Gate 5 step until the runner can read the stack's services back.           | Mandated consequence of Fix 1. Must **not** be resolved by restoring `exit 0`. |
| R-2 | LOW        | `actionlint` absent; workflows not linted by a GitHub-aware linter.                                                                | Tooling gap on this host.                                                      |
| R-3 | LOW        | The 36 new tests sit outside the Turbo graph.                                                                                      | Wired into `ci.yml:120`, pinned by EA58-T36.                                   |
| R-4 | LOW        | Pre-edit hashes of the four control files were not captured.                                                                       | Disclosed in `baseline.txt` and `blockers.md` §4.                              |
| R-5 | LOW        | EA-57's `D8` (82 FKs missing from the Drizzle snapshot chain) and `D9` (`canSeeWidget` fail-open for unknown widgets) remain open. | Pre-existing, explicitly out of EA-58 scope.                                   |

### 7.2 Authorization needed to move any remote status

1. **Push the branch / create a PR**, so real GitHub Actions can execute both
   workflows. Without this, tier E stays `NOT RUN` forever.
2. **GHCR read access**, to prove the `staging-<sha>` and release references are
   the same bytes.
3. **Access to the `[self-hosted, dokploy]` runner** (or a representative test
   stack) to execute Gate 5 against a real fleet and determine whether the
   compose path can read services back — the answer decides whether R-1 needs an
   infrastructure change or an architectural one.
4. **Explicit decision on A1–A8** (signing, SBOM, observe-only) before any of
   those can leave `PENDING AUTHORIZATION`.
5. **A rollback design and implementation**, before the rollback status can move
   off `FAIL — NO EXECUTABLE ROLLBACK PATH`.

### 7.3 Recommended next steps

1. Push and let CI run — that is the cheapest way to convert tier E's first row
   from `NOT RUN` to a real result.
2. On the Dokploy runner, run `docker service ls --filter
label=com.docker.stack.namespace=<appName>` and record the answer. That single
   command determines whether Fix 1 lands as a green path or a permanently red
   one.
3. Do **not** relax Gate 5 to make the compose path green. If the runner cannot
   read the stack, the correct fix is to give it that capability, or to move the
   compose deployment to an inspectable service model.
4. Take the EA-57 `D8`/`D9` items as their own scoped phase.

### 7.4 Phase boundary

EA-58 stops here. EA-59 is not started.

---

## 8. Evidence integrity

The evidence bundle is `docs/evidence/ea58/`, covered by
`docs/evidence/ea58/SHA256SUMS`:

| File                       | Contents                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `baseline.txt`             | workspace state, delta, post-fix hashes, the `NOT CAPTURED` disclosure                       |
| `control-reproduction.log` | PART A pre-fix reproduction, PART B post-fix verification, both verbatim                     |
| `regression-tests.log`     | the 78 tests, per-test results and the mapping to the instruction's required cases           |
| `local-validation.log`     | every gate with its exit code, the `Cached: 0` proof, YAML parse, `actionlint` gap           |
| `workflow-audit.md`        | step order, blocking conditions, side-effect analysis, residual observations                 |
| `blockers.md`              | closed-vs-open status, the compose consequence, unchanged remote statuses, process deviation |

Verification procedure (reproducible by the reader):

```
cd /home/test/projects/beaconhs-hse/docs/evidence/ea58
sha256sum -c SHA256SUMS
```

The manifest uses paths relative to `docs/evidence/ea58/` (the report is
referenced as `../../ea58-gate5-and-ci-control-hardening-report.md`), matching
the EA-56/EA-57 convention. The report itself is included in the manifest; a file
cannot contain its own hash, so its integrity is established by the same check
rather than by a self-referential line here.

Result of running that command in this phase: **7/7 entries `OK`, exit 0** —
re-run it to confirm; if any line reports `FAILED`, treat the bundle as tampered.

No token, password, private key or secret value appears in any file listed above.
The only credential-shaped strings are the _names_ `GITHUB_TOKEN` and
`GHCR_TOKEN`, which are GitHub expression syntax, not values.

---

## 9. Condensed summary

| Requirement                                                           | Status                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Gate 5 cannot report success when the running digest is unreadable    | **PASS (local control)** — `deploy-dev.yml:589-595`                                       |
| F-4 distinguishes query failure, empty result and no matching service | **PASS (local control)** — `reconcile-running-digest.sh`                                  |
| F-2 enforces exit code **and** verdict, structurally                  | **PASS (local control)** — `verify-image-identity.mjs`                                    |
| F-1 no longer passes an unused token                                  | **PASS** — `deploy-dev.yml:89-94`                                                         |
| Negative tests for all four                                           | **PASS** — 36 new, 78 total, 0 failed                                                     |
| Repository gates                                                      | **PASS** — format, typecheck, lint, test, deadcode, `diff --check`, YAML parse all exit 0 |
| Existing evidence overwritten                                         | **No** — every delivery path was confirmed absent first                                   |
| Other working-tree changes lost                                       | **No** — 165 M / 519 ?? preserved                                                         |
| Real GitHub Actions                                                   | **`NOT RUN`**                                                                             |
| Real GHCR promotion                                                   | **`NOT RUN`**                                                                             |
| Real deployment-platform Gate 5                                       | **`NOT VERIFIED`**                                                                        |
| Signature / SBOM / observe-only / A1–A8                               | **`PENDING AUTHORIZATION`**                                                               |
| Rollback                                                              | **`FAIL — NO EXECUTABLE ROLLBACK PATH`**                                                  |
| Migration 51, database and object-store restore                       | **`NOT RUN`**                                                                             |
| Production                                                            | **`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`**                                       |
