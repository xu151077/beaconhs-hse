# Phase 6U-B3-EA-5 — Local deployment-workflow acceptance

Date: 2026-10-21
Repository: `/home/test/projects/beaconhs-hse`
Branch / HEAD (unchanged): `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Scope: static audit of the Server Action key gate and the deployment chain, plus
a **local simulation**. No push, no commit, no deploy, no GitHub, no contact with
Drill (10.10.31.30), `phase-aj` or production.

---

## 0. Verdict

| Area                               | Verdict                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| Build gate (server-action key)     | **PASS** (local simulation)                                   |
| Gate invocation-chain completeness | **PARTIAL → PASS after EA-5 fixes** (see §3 for what changed) |
| Multi-instance local simulation    | **PASS**                                                      |
| Deployment-script static audit     | **PASS after EA-5 fixes**                                     |
| Real deployment                    | **NOT RUN**                                                   |
| Local quality gates                | **PASS** (6/6, exit 0)                                        |
| Cleanup                            | **PASS** (no residue)                                         |

**Local deployment simulation passed. Real deployment has NOT passed and was NOT
run** — there is no evidence of a real deployment in this phase, and none may be
claimed from it.

Four real defects were found and fixed (§3). Two of them would have blocked a
deployment in production, and one silently undermined a pre-existing CI check.

---

## 1. Phase A — read-only baseline

```
git branch --show-current                 -> hse-platform
git rev-parse HEAD                        -> 51a899b7aac0a942da327222a3eed355fca9798a
git status --short | count by status      -> 154 M, 462 ??
git diff --stat | tail -1                 -> 154 files changed, 5101 insertions(+), 1919 deletions(-)
git diff --cached --name-only | wc -l     -> 0
```

Matches the EA-4 exit state exactly. Nothing was reset or reconstructed.

Files read before any change: the EA-4 report, `scripts/build-local-image-with-key-gate.sh`,
`scripts/build-drill-image.sh`, the `Dockerfile` secret declaration and its consumer,
`scripts/ci/verify-server-action-key-gate.sh` (+ its test), `apps/web/scripts/verify-server-action-key-consistency.ts`,
`apps/web/src/lib/server-action-key.ts`, the CI/acceptance test, `.github/workflows/ci.yml`,
`.github/workflows/deploy-dev.yml`, `deploy/*.compose.yaml`, and `apps/web/src/app/api/health/ready/route.ts`.

---

## 2. Phase B — build and gate invocation chain (static)

| #   | Claim to confirm                                               | Evidence                                                                                                                       | Result |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | Key file must be 0600 and outside the repo                     | Both local entries check `stat -c '%a'` = `600` and default to `/tmp/...`; exit **2** otherwise (verified, §4 E-4)             | PASS   |
| 2   | Key injected only through a BuildKit secret                    | `--secret id=next_server_actions_key,src=$KEY_FILE`; contract test asserts no `--build-arg NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | PASS   |
| 3   | The Dockerfile really consumes the secret                      | `RUN --mount=type=secret,id=next_server_actions_key,required=true` (Dockerfile:49)                                             | PASS   |
| 4   | Fingerprint extracted from the final image                     | Shared gate `image <ref> <fp>` copies `server-reference-manifest.json` out of a `docker create` container                      | PASS   |
| 5   | Same gate the deployment uses                                  | `scripts/ci/verify-server-action-key-gate.sh` (the file `deploy-dev.yml` calls)                                                | PASS   |
| 6   | Mismatch terminates non-zero                                   | Verified: drill entry exit **1**, local entry exit **1**, no deploy step reached (§4)                                          | PASS   |
| 7   | No plaintext key in logs                                       | Leak scan across every EA-5 log for each key value: none found; only the 128-bit HMAC fingerprint is printed                   | PASS   |
| 8   | Every local build/deploy entry is gated or explicitly recorded | See the table below                                                                                                            | PASS   |

### Entry-point coverage

| Entry point                                  | State after EA-5                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-local-image-with-key-gate.sh` | Gated: secret + fingerprint cache binding + shared gate                                                                                                     |
| `scripts/build-drill-image.sh`               | **Fixed** (was ungated and unbuildable): secret + fingerprint + shared gate **before** shipping                                                             |
| `.github/workflows/deploy-dev.yml`           | Gated: containerless fingerprint step → build-arg → post-build image gate → replicated check (**NOT RUN**, no GitHub)                                       |
| `scripts/deploy-drill-freeze-driver.sh`      | Remote `docker build` without the secret. **Fails closed**: verified locally, BuildKit errors with `secret next_server_actions_key: not found`, exit 1      |
| `scripts/deploy-drill-freeze-driver-ssh.sh`  | Builds `Dockerfile.test`, which is a separate test-only image (`ENTRYPOINT /entrypoint.sh`, no secret mount, placeholder key). Out of the production chain. |
| `deploy/dokploy-dev.compose.yaml`            | Consumes `${IMAGE}` from the gated CI build                                                                                                                 |
| `deploy/drill-20261009.compose.yaml`         | Hardcoded tag now produced by the fixed `build-drill-image.sh`                                                                                              |
| `deploy/local-production.compose.yaml`       | **Documented build recipe corrected** (was missing the now-required fingerprint arg)                                                                        |
| `deploy/prod-verify.compose.yaml`            | **Documented build recipe added** (had none); `beaconhs:prod-verify` is a throwaway E2E stack                                                               |

---

## 3. Phase E — defects found and fixed

Per the phase rules, a fix was only made where a defect was **reproduced**. Each
fix is scoped, has a negative test, and was proven to block the following step.

### E-A — BuildKit does not hash secret content (HIGH)

**Evidence.** Two consecutive builds of the _same commit_ with **different** keys
produced an image holding the **first** key: the builder layer was `CACHED`.
`verify-server-action-key-gate.sh image` then correctly stopped on it (exit 1).
Before the fix that meant: rotate the key → every deploy fails until someone
clears the builder cache.

This also exposed that `scripts/ci/build-local-image-key-gate.test.sh` check 6
("an image built with a different key is refused") **depended on that cache
behaviour**: it rebuilt with a second key and expected the old key to survive.
On a cold CI runner it would have failed instead.

**Fix.** The Dockerfile takes a REQUIRED build-arg `NEXT_SERVER_ACTIONS_KEY_FINGERPRINT`
and references it inside the secret-consuming `RUN`, so the layer cache key
changes with the key. The value is the 128-bit `HMAC-SHA256(key, label)` that
the gate already computes and prints — a PRF under the key, never the key, not
invertible. Everything feeding it was updated in the same change:

- `scripts/ci/server-action-key-fingerprint.mjs` — dependency-free Node CLI (CI
  needs the value before `pnpm install`), pinned to the canonical
  `serverActionKeyFingerprint` by `server-action-key-fingerprint-cli.test.ts`.
- both local build entries compute it and pass it as a build-arg;
- `deploy-dev.yml` computes it in a dedicated step and passes it as a build-arg;
- the two compose files that document raw `docker build` recipes were corrected.

**Proof it is required.** A build with the secret but without the arg fails:
`NEXT_SERVER_ACTIONS_KEY_FINGERPRINT: the Server Action key fingerprint build-arg is required`, exit 1, no image.

**Proof the test is deterministic again.** The acceptance test now builds once
and asks the shared gate to certify that image against a _different_ key (the
real deployment check). All 8 checks pass on a warm cache, and check 6 no longer
depends on cache state.

### E-B — `build-drill-image.sh` could not build, and never verified the key (HIGH)

**Evidence (static).** It called `docker build` with no `--secret`, against a
Dockerfile where the secret is `required=true`; and after the build it named a
**new** timestamp tag in the compose file while shipping `beaconhs:drill-latest`.
A multi-minute build makes the two `date` values differ, so the compose file
pointed at a tag that had never been built.

**Fix.** Requires the 0600 key file, passes the secret **and** the fingerprint
build-arg, gates with the shared `image` mode, and uses **one** computed tag for
build, gate, ship and deploy. The gate resolves from the repository (not the
copy's directory) and aborts if it cannot.

**Negative proof.** A cached layer carrying the other key →
`[key-gate] FAIL … fingerprint mismatch`, exit 1, **0** deploy steps reached;
`docker save` is never executed and the repository's compose file is byte-identical
afterwards (`sha256sum -c` pass).

### E-C — CI's replicated key check would have passed on the Dokploy path (HIGH)

**Evidence (static against the real variables).** `Verify every web replica's
Server Action key` ran unconditionally. `verify_replicas` calls
`docker ps --filter label=com.docker.swarm.service.name=<stack>_web` on the
running node. On the **Dokploy compose** path the stack lives on another node, so
the filter matches nothing and the gate fails (`no running …_web task was found`)
— i.e. every Dokploy deploy would have failed at the last step.

**Fix.** The step is now scoped to `DOKPLOY_DEPLOY_MODE == 'direct'`, the only
mode in which the runner can reach the tasks. On the Dokploy path the **image
gate before migrations** remains the binding proof, and that stack runs on the
embedded build-time key (`dokploy-dev.compose.yaml` sets no runtime override —
pinned by an existing contract test).

**Also fixed in the same gate:** it used to sample whichever task was visible
during an asynchronous rollout. `verify_replicas` now waits (≤300 s) for the
service to _settle_ — desired replica count, that many running tasks, and
`UpdateStatus.State` empty or `completed` — and fails with
`did not settle … refusing to certify a mid-rollout fleet` otherwise.

### E-D — `deploy/local-production.compose.yaml` build recipe was stale (MEDIUM)

The recipe a human operator follows was missing `NEXT_SERVER_ACTIONS_KEY_FINGERPRINT`,
so following it now fails the build. Corrected to the full, working command plus
the post-build gate. `deploy/prod-verify.compose.yaml` had **no** build recipe at
all; one was added.

---

## 4. Phase D — local simulation results

All resources were isolated: keys in `/tmp` (mode 600), instances on ports
**4020/4021**, throwaway image tags, a **copy** of the drill compose file, and a
non-existent container name as the "drill host". No Drill/`phase-aj`/production
contact.

| #   | Scenario                                                       | Result                                                                                                                                                                              |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Correct key → build and gate pass                              | **PASS** — exit 0, `PASS … embeds the expected Server Action key`, `fingerprint=d74ea3e1…`                                                                                          |
| 2   | Fingerprint mismatch → gate fails, later steps do not run      | **PASS** — exit 1, `fingerprint mismatch`, 0 deploy steps                                                                                                                           |
| 3   | Invalid key → rejected by the contract                         | **PASS** — exit 2 before the build; gate fingerprint mode also rejects it (exit 1 → maps to 2)                                                                                      |
| 4   | No runtime override → build-time key fallback                  | **PASS** — readiness 200, log `no runtime override; the effective key is the build-time key`                                                                                        |
| 5   | Two instances, same configuration → gate passes                | **PASS** — both readiness 200, identical fingerprints, `compare` exit 0                                                                                                             |
| 6   | Two instances, different configuration → gate fails            | **PASS** — fingerprints differ, `compare` exit 1                                                                                                                                    |
| 7   | Restore the correct configuration → gate and readiness recover | **PASS** — fingerprints equal again, readiness 200                                                                                                                                  |
| 8   | Image version identity matches the build artifact              | **PASS** — both instances serve the same standalone build (`readlink /proc/<pid>/cwd`); readiness reports `version: unknown` because `APP_VERSION` is injected at runtime by design |

Additional evidence collected in this phase:

- Ungated build entry (no secret, with `DEPLOYMENT_VERSION`): `secret next_server_actions_key: not found`, exit 1, no image.
- Build with the secret but without the fingerprint arg: required-arg error, exit 1, no image.
- Drill entry, mode 644 key: exit 2, `must be mode 600`.
- Drill entry, missing key: exit 2, `missing or unreadable`.
- Gate fixture suite `verify-server-action-key-gate.test.sh`: **11/11**.
- Build-entry acceptance suite `build-local-image-key-gate.test.sh`: **8/8** (includes one real image build).
- Key-leak scan over every EA-5 log: clean.

---

## 5. Phase C — deployment chain static audit (end state)

```
source → docker build (secret + fingerprint build-arg)
       → post-build image gate (manifest → fingerprint → compare)
       → immutable tag/digest (single computed tag; CI uses digest)
       → ship (docker save|load  /  push to ghcr by digest)
       → instance start (same image for web/worker/scheduler)
       → readiness (/api/health/ready validates the runtime override, reports APP_VERSION)
       → replicated gate (direct mode only, after the fleet settles)
```

- **Gate bypass:** none in the production chain. The only ungated builds are the
  remote `deploy-drill-freeze-driver*.sh` scripts, which fail closed (proven) and
  are not used by the deployment workflow.
- **Tag correctness:** the drill script's split-tag defect is fixed; CI deploys by
  `@digest`.
- **Same artifact for build and runtime:** one image reference for all app roles;
  `APP_VERSION` is runtime-injected to match `deploy-dev.yml`.
- **Replica coverage:** all tasks, after convergence, in the path that can see
  them (see E-C).
- **Readiness catches invalid configuration:** an invalid runtime override keeps
  the instance out of rotation (existing contract, re-verified via the gate's
  refusal of an invalid key).
- **Failure stops the chain:** every failure above was observed to stop later steps.
- **No GitHub/remote dependency** in local paths. `deploy-dev.yml` remains the
  only GitHub-dependent artefact and was **not** executed.

---

## 6. Phase F — regression

Each gate was run on its own and its own exit code captured.

| Command               | Exit | Result                                                                                                       |
| --------------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`   | 0    | —                                                                                                            |
| `pnpm typecheck`      | 0    | 27/27 tasks                                                                                                  |
| `pnpm lint`           | 0    | 1/1 task                                                                                                     |
| `pnpm test`           | 0    | web 2104 passed / 8 skipped; db 506 passed / 41 skipped; 25 tasks                                            |
| `pnpm deadcode:check` | 0    | (failed first with a redundant-entry hint; the entry was unnecessary and was removed rather than suppressed) |
| `pnpm build`          | 0    | 4/4 tasks                                                                                                    |

Targeted re-runs: deployment contract **14/14**, fingerprint CLI **9/9**,
`verify-server-action-key-gate.test.sh` **11/11**, `build-local-image-key-gate.test.sh` **8/8**.

---

## 7. Cleanup

| Resource                                                                                        | State                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Test image tags (`beaconhs:ea5-*`, `beaconhs:ea4-gate-selftest`, `beaconhs:drill-*` built here) | Removed; `docker images` shows none                           |
| Dangling images                                                                                 | 0                                                             |
| Instances on 4020/4021                                                                          | Stopped; no listener on 4020/4021/3000                        |
| Processes (`node server.js`, `next dev`)                                                        | None running                                                  |
| `/tmp/ea5*` (keys, logs, compose copy, script copies)                                           | All removed (22 entries)                                      |
| Repository compose file                                                                         | Unchanged — `sha256sum -c` passed against the pre-test digest |
| Scratch DB (EA-2/EA-3 fixture)                                                                  | Untouched; 1 `beaconhs_al*` database present as before        |
| Pre-existing images/containers                                                                  | Not touched                                                   |

Final git state: branch `hse-platform`, HEAD `51a899b7…`, **0 staged**, 154 modified,
465 untracked, `154 files changed, 5134 insertions(+), 1919 deletions(-)`.
Nothing committed, pushed or deployed.

---

## 8. Files changed in this phase

Modified:

- `Dockerfile` — required `NEXT_SERVER_ACTIONS_KEY_FINGERPRINT` build-arg bound into the secret-consuming layer's cache key.
- `.github/workflows/deploy-dev.yml` — fingerprint step + build-arg; replicated gate scoped to `direct`.
- `deploy/local-production.compose.yaml`, `deploy/prod-verify.compose.yaml` — build recipes corrected/added.
- `scripts/build-local-image-with-key-gate.sh`, `scripts/build-drill-image.sh` — fingerprint build-arg, shared `image` gate, single tag, repository-rooted gate lookup.
- `apps/web/src/lib/server-action-key-deployment-contract.test.ts` — 3 new/updated assertions.
- `scripts/ci/build-local-image-key-gate.test.sh` — check 3 now truly pre-build; check 7 made cache-independent.
- `scripts/ci/verify-server-action-key-gate.sh` — settle-wait before certifying replicas.

New:

- `scripts/ci/server-action-key-fingerprint.mjs`
- `apps/web/src/lib/server-action-key-fingerprint-cli.test.ts`
- `scripts/ci/verify-server-action-key-gate.test.sh` (11 fixtures)
- `docs/phase-6u-b3-ea5-local-deploy-workflow.md` (this file)

---

## 9. Remaining risks — stated plainly

1. **Real deployment: NOT RUN.** No GitHub Actions run, no Dokploy, no registry
   push. The workflow's YAML and shell logic were audited and the gate was
   exercised locally, but the end-to-end job has never executed.
2. **E-A's cache binding is proven locally only.** The mechanism is BuildKit-
   version independent (the arg is an input to the `RUN`), but the GHCR/GHA-cache
   path itself is unexecuted.
3. **`verify_replicas` settle-wait is unexecuted against a real Swarm service.**
   Its no-task and mismatch paths are unit-covered; the convergence wait is not.
4. **Multi-node Swarm limitation (pre-existing, unchanged):** `verify_replicas`
   samples the local node's containers, so it is only valid on a single-node
   Swarm — which is what both paths deploy to today. A future multi-node stack
   would need the task's node in the `docker exec`, as the script's comment says.
5. **WOPI frozen re-open anomaly** remains `KNOWN / UNRESOLVED — LOW PRIORITY —
INVESTIGATION PAUSED`; untouched by this phase.
6. **Known defects D1–D6** unchanged; not fixed here.
7. `.github/*` edits are **untracked working-tree changes like the rest of the
   154-file diff** — they are not committed, so nothing is armed by them.
