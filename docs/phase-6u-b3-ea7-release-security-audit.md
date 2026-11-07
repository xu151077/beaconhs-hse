# Phase 6U-B3-EA-7 — Local release security audit and residual-risk closure

Date: 2026-10-21
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform` (before and after: `hse-platform...origin/hse-platform`)
HEAD (before and after, unchanged): `51a899b7aac0a942da327222a3eed355fca9798a`
Previous phase: `docs/phase-6u-b3-ea6-local-release-candidate.md`

---

## 0. Verdict

| Area                                        | Verdict                                                    |
| ------------------------------------------- | ---------------------------------------------------------- |
| Local release candidate                     | **PASS**                                                   |
| Real deployment                             | **NOT RUN**                                                |
| Multi-node Swarm                            | **NOT RUN**                                                |
| GHCR / GHA cache path                       | **NOT RUN**                                                |
| Drill deploy path (ship / recreate / probe) | **NOT RUN**                                                |
| WOPI frozen re-open                         | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED` |

EA-7 found **five** defects in the EA-5/EA-6 deployment scripts, including one
that made the EA-6 "fix" non-functional. All were fixed with local negative
tests. No gate was weakened; one **incorrect** assertion was replaced because it
asserted the invalid `-C` behaviour.

---

## 1. Phase A — baseline and change boundary

```
git status --short --branch  -> ## hse-platform...origin/hse-platform
git rev-parse HEAD           -> 51a899b7aac0a942da327222a3eed355fca9798a
git diff --stat              -> 154 files changed, 5134 insertions(+), 1919 deletions(-)
git diff --cached --stat     -> empty (0 staged)
modified / untracked         -> 154 / 466
scripts/build-drill-image.sh -> ?? (still untracked; not in the index)
```

Matches the EA-6 exit state. Nothing was reset, cleaned or reconstructed.
`docs/PRODUCTION_RUNBOOK.md`, `docs/beaconhs-extension-points.md` and
`docs/project-development-state.md` were already modified before this phase and
were **not** touched.

---

## 2. Phase B — audit findings

Ten audit questions were checked against the real scripts. Findings:

### E-7a — `docker compose -C` does not exist (HIGH, invalidates the EA-6 fix)

EA-6 pinned the shipped image with `docker compose … -C "$DRILL_IMAGE_NAME" up …`.
`docker compose` has no `-C` shorthand. Proven against the installed CLI
(v5.6.0) with a throwaway compose file:

```
docker compose -f c.yaml --project-name ea7test -C example.com/app:v9 up --no-start --dry-run
-> unknown shorthand flag: 'C' in -C          (exit 1)
```

So the EA-6 "pin" would have **failed the remote recreate outright** — the deploy
never ran at all. The EA-6 evidence could not catch this because the harness ran
only the block and never executed the real CLI.

**Fix.** The image is pinned where it is actually needed: the host's compose file
is streamed in over stdin, every `image:` line is replaced with the shipped tag,
that exact content is validated with `docker compose -f - config`, and `up` runs
from the same pinned content. `--latest-image` was rejected on purpose — its
behaviour differs across Compose versions and would reintroduce the ambiguity.
The image reference is also validated against `^[A-Za-z0-9._:/-]+$` before it is
interpolated into remote shell strings.

### E-7b — the image copy probed the ssh host with `docker exec` (HIGH)

`docker exec "$DRILL_HOST" docker images` treats the SSH target as a **local
container name**; `DRILL_HOST` is an ssh alias, so it always failed. Both branches
then ran the identical `docker save | docker exec -i … docker load`, so the
"Image exists / does not exist" choice was dead. The copy was also unguarded for
the load side: `set -o pipefail` reports a failed `docker save`, but a failed
`docker load` on the far side was not distinguished.

**Fix.** One guarded copy over the ssh transport (`docker save | ssh … docker
load`), followed by a **presence check** (`docker image inspect` on the host) so a
silently failed load cannot be followed by a recreate that pulls something else.

### E-7c — the local `sed -i` rewrote a file nobody reads (MEDIUM)

Step 3 edited _this_ checkout's `deploy/drill-20261009.compose.yaml`. The drill
host reads its **own** copy, so the edit never reached the deployment and only
dirtied the working tree. Removed; the running stack now gets its pin in step 4.

### E-7d — `${VAR:-default}` silently accepts an explicitly EMPTY override (MEDIUM)

`DRILL_PROJECT=${DRILL_PROJECT:-beaconhs-drill-20261009}` substitutes the default
for an empty value, so `DRILL_DIR=` would have targeted the wrong path and
`DRILL_PROJECT=` the wrong stack instead of stopping. The same applied to
`DRILL_HOST` and `DRILL_COMPOSE_FILE`.

**Fix.** Presence is distinguished from emptiness: an unset variable gets its
default, a **set-but-empty** one exits 2 with
`… is set but empty; refusing to guess the drill target`, before any ssh runs.

### E-7e — the build log was a world-readable file in a shared `/tmp` that outlived the run (MEDIUM)

`build-local-image-with-key-gate.sh` wrote the full BuildKit output to
`/tmp/beaconhs-key-gate-build.log` (observed `-rw-r--r--`) and never deleted it.
BuildKit does redact `RUN --mount=type=secret` values — a shape scan of that file
found **0** key-shaped tokens — but the persistent 0644 file is precisely the
place a future build step that echoes a value would leak it.

**Fix.** The log now lives in a `mktemp -d` directory forced to 0700, the file is
0600, and the directory is removed on **every** exit path via `trap`. On failure
only the last 20 lines are copied to stderr.

### Confirmed clean (no change needed)

| Question                                                     | Evidence                                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Default path cannot reach a remote host unsolicited          | `build-local-image-with-key-gate.sh` never calls ssh; the drill script's remote steps are its documented purpose.      |
| Build → verify → ship → remote `config` → `up` → probe order | Sequential with `set -euo pipefail`; the gate precedes the first remote call.                                          |
| Remote `config` failure prevents `up`                        | Proven with a fake `ssh`: `exit=1`, `up issued: False`.                                                                |
| Image identity consistent across build/verify/ship/run       | One `DRILL_IMAGE_NAME`; CI deploys by `@sha256` digest.                                                                |
| Worker resolved by project/service labels                    | `com.docker.compose.project=$DRILL_PROJECT` + `…service=worker`.                                                       |
| SSH / docker failures propagate                              | Every remote call is `                                                                                                 |     | `-guarded with a specific message and `exit 1`; no bare ` |     | true` remains except none. |
| Secrets in logs / env / args / tracked files                 | Key never in `ENV`/`ARG`; only the 128-bit fingerprint is a build arg; tracked files contain no key material.          |
| Local build bypass paths                                     | Only the four scripts that legitimately call `docker build`; the two Drill helpers build a separate `Dockerfile.test`. |

---

## 3. Fix evidence (local, no Drill contact)

The drill block was extracted and run against a **fake `ssh`** that records argv.

| Scenario                            | Result                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Happy path                          | exit 0; `config` then `up -d --force-recreate --no-build` issued; **9 of 9** `image:` lines in the piped content pinned to the shipped tag |
| Compose `config` fails              | exit 1, `up` **not** issued                                                                                                                |
| `up` fails                          | exit 1, `[deploy] docker compose failed on the drill host`                                                                                 |
| `DRILL_DIR=""`                      | exit 2, **ssh never called**, `DRILL_DIR is set but empty…`                                                                                |
| `DRILL_PROJECT=""`                  | exit 2, **ssh never called**                                                                                                               |
| No overrides                        | defaults applied, deploy proceeds                                                                                                          |
| Image ref with shell metacharacters | exit **2**, ssh never called, `/tmp/ea7-pwn` not created                                                                                   |
| Host file unreadable                | exit 1, nothing restarted                                                                                                                  |

The real compose file was also checked directly: pinning rewrites all nine
`image:` lines (including postgres/redis/minio) to the shipped tag, so sibling
service images are not left stale.

---

## 4. Phase D — regression

| Command                                                           | Exit | Pass | Fail | Skip | Time  |
| ----------------------------------------------------------------- | ---- | ---- | ---- | ---- | ----- |
| `bash scripts/ci/verify-server-action-key-gate.test.sh`           | 0    | 11   | 0    | 0    | <1 s  |
| `bash scripts/ci/build-local-image-key-gate.test.sh` (real build) | 0    | 8    | 0    | 0    | 286 s |
| contract + fingerprint CLI (vitest)                               | 0    | 25   | 0    | 0    | <1 s  |

Contract assertions went 15 → 16: one new test pins the stdin-pinned compose
recreate, the single guarded copy, the absence of `docker exec "$DRILL_HOST"`,
the absence of `sed -i`, and the build-log hardening. One obsolete assertion
that required `-C $DRILL_IMAGE_NAME` was **removed** — it encoded the defect
proven in E-7a, not a requirement.

Full gates (all six, each with its own exit code):

| Command               | Exit | Result                                                                    |
| --------------------- | ---- | ------------------------------------------------------------------------- |
| `pnpm format:check`   | 0    | —                                                                         |
| `pnpm typecheck`      | 0    | 27/27 tasks                                                               |
| `pnpm lint`           | 0    | 1/1 task                                                                  |
| `pnpm test`           | 0    | web **2106 passed / 8 skipped**; db **506 passed / 41 skipped**; 25 tasks |
| `pnpm deadcode:check` | 0    | —                                                                         |
| `pnpm build`          | 0    | 4/4 tasks                                                                 |

---

## 5. Phase C — release risk matrix

| #   | Risk                                      | Level              | Current evidence                                                                                                                              | Unverified scope                                       | Affects local RC?      | Needed to verify                                     |
| --- | ----------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------- | ---------------------------------------------------- |
| 1   | Build-time key vs final-image fingerprint | Low                | `verify-server-action-key-gate.sh image` reads the manifest out of the finished image and compares; 11 fixture checks + real-build acceptance | Behaviour against a registry-pulled image              | No                     | A real registry push + pull                          |
| 2   | BuildKit cache vs key rotation            | Low                | Fingerprint build-arg bound into the secret layer; cached-stale-layer case repelled (EA-5/EA-6)                                               | GHA remote cache backend                               | No                     | An Actions run with a warm GHA cache                 |
| 3   | Multi-instance key consistency            | Medium             | `verify_replicas` + `compare_fingerprints`; two-instance local simulation (4020/4021)                                                         | Real Swarm services; >1 node                           | No                     | A real single-node Swarm deploy, then a 2-node stack |
| 4   | Remote compose vs image tag               | **Low (was High)** | EA-7 E-7a–E-7c fixed; 9/9 image lines pinned; fake-ssh argv verified                                                                          | The actual drill host's file may use anchors/`extends` | No                     | One authorized Drill run                             |
| 5   | Replica convergence check                 | Medium             | `did not settle` on non-convergence; decision logic unit-covered                                                                              | Live `UpdateStatus` transitions                        | No                     | A real rolling update                                |
| 6   | Real multi-node Swarm                     | **High**           | None — `verify_replicas` samples the local node only                                                                                          | Everything                                             | No (single-node today) | A real multi-node environment                        |
| 7   | GHCR / GHA cache path                     | Medium             | Workflow YAML audited; fingerprint step gated                                                                                                 | Executed at all                                        | No                     | An authorized Actions run                            |
| 8   | Drill ship / recreate / probe             | Medium             | Only argv construction + failure ordering verified                                                                                            | Real transport and container state                     | No                     | An authorized Drill deploy                           |
| 9   | Rollback after a failed deploy            | **High**           | No executed rollback path in any local phase                                                                                                  | Entire rollback capability                             | No                     | An approved rollback drill (see §7)                  |
| 10  | WOPI frozen re-open                       | Low (accepted)     | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED` (owner decision pending)                                                           | Root cause                                             | No                     | Owner risk sign-off                                  |

No unverified row is marked PASS.

---

## 6. Cleanup

| Resource                                                                     | State                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------- |
| `/tmp/ea7*` (logs, compose copies)                                           | Removed                                  |
| `/tmp/beaconhs-key-gate-build.log` (EA-6 leftover, 0644)                     | Removed; the script no longer creates it |
| `/tmp/tmp.JZjf5X12pL`, `/tmp/tmp.xsrr6UR4Rk` (my earlier fake-ssh sandboxes) | Removed                                  |
| Test images (`ea4-gate-selftest`, `drill-*` built here)                      | Removed by the suites / this phase       |
| Containers, volumes, databases                                               | None created; none touched               |
| Drill / `phase-aj` / production                                              | Never contacted                          |
| Pre-existing images                                                          | Intact                                   |

---

## 7. Final state

```
branch                -> hse-platform (unchanged)
HEAD                  -> 51a899b7aac0a942da327222a3eed355fca9798a (unchanged)
staged                -> 0
modified / untracked  -> 154 / 467
git diff --stat       -> 154 files changed, 5134 insertions(+), 1919 deletions(-)
```

Nothing committed, pushed, fetched or deployed. Files changed **by this phase**:

- `scripts/build-drill-image.sh` (untracked) — E-7a–E-7d.
- `scripts/build-local-image-with-key-gate.sh` (untracked) — E-7e.
- `apps/web/src/lib/server-action-key-deployment-contract.test.ts` (untracked) — one new test, one obsolete assertion removed.
- `docs/phase-6u-b3-ea7-release-security-audit.md` (this report).

---

## 8. Preconditions before any real deployment

1. **Explicit written authorisation** for that specific deploy (target, commit,
   window) — nothing in EA-1…EA-7 grants it.
2. **A documented, rehearsed rollback**: previous digest, the exact commands to
   re-pin it, and who declares failure. Risk #9 is currently unverified.
3. **Deploy-time checks the operator runs**: build with a 0600 key outside the
   repo, confirm the `[key-gate] PASS` line, confirm the image digest matches the
   commit, and confirm `/api/health/ready` reports the expected `version`.
4. **A named owner** for the WOPI item to accept or schedule the residual risk.
5. For a multi-node stack: extend `verify_replicas` to resolve each task's node
   before that topology is used.

---

## 9. Conclusion

**LOCAL RELEASE CANDIDATE: PASS** — upheld. Five defects were found and fixed
this phase, all below the release-candidate boundary (deployment scripts and the
build log), each with a negative test, and all six gates pass.

**Real deployment: NOT RUN.** The drill ship/recreate/probe path, the GHCR/GHA
cache path and multi-node Swarm remain unverified, and no deployment may be
declared from local evidence.
