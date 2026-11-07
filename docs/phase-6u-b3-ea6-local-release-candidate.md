# Phase 6U-B3-EA-6 — Local release-candidate audit

Date: 2026-10-21
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform` (start and end: `hse-platform...origin/hse-platform`)
HEAD (start and end, unchanged): `51a899b7aac0a942da327222a3eed355fca9798a`
Previous phase: `docs/phase-6u-b3-ea5-local-deploy-workflow.md`

---

## 0. Verdict

| Area                             | Verdict                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| Local release candidate          | **PASS**                                                   |
| Real deployment                  | **NOT RUN**                                                |
| Multi-node Swarm behaviour       | **NOT RUN** (not verifiable locally)                       |
| GHCR / GitHub-Actions cache path | **NOT RUN**                                                |
| WOPI frozen re-open              | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED` |

The local candidate passes **on the strength of gates that actually ran**, with
one high-severity defect found and fixed during this phase (§3). It does **not**
constitute production release acceptance: no deployment was performed, and none
may be claimed from this evidence.

---

## 1. Phase A — baseline (read-only)

```
git status --short --branch   -> ## hse-platform...origin/hse-platform
git rev-parse HEAD            -> 51a899b7aac0a942da327222a3eed355fca9798a
git diff --stat               -> 154 files changed, 5134 insertions(+), 1919 deletions(-)
git diff --cached --stat      -> (empty)
modified / untracked          -> 154 M / 465 ??
```

This matches the EA-5 exit state exactly (154 modified, 465 untracked, 0 staged).
No file was reset, cleaned or reconstructed to make it match.

All audited paths exist at the locations EA-5 reported:

| Path                                                             | Git state |
| ---------------------------------------------------------------- | --------- |
| `scripts/build-local-image-with-key-gate.sh`                     | untracked |
| `scripts/build-drill-image.sh`                                   | untracked |
| `scripts/ci/verify-server-action-key-gate.sh`                    | untracked |
| `scripts/ci/verify-server-action-key-gate.test.sh`               | untracked |
| `scripts/ci/build-local-image-key-gate.test.sh`                  | untracked |
| `scripts/ci/server-action-key-fingerprint.mjs`                   | untracked |
| `apps/web/src/lib/server-action-key-deployment-contract.test.ts` | untracked |
| `apps/web/src/lib/server-action-key-fingerprint-cli.test.ts`     | untracked |

`docs/PRODUCTION_RUNBOOK.md`, `docs/beaconhs-extension-points.md` and
`docs/project-development-state.md` were already modified before this phase
(mtimes 2026-10-14 / 10-20 / 10-18) and were **not** touched here.

---

## 2. Phase C — static audit of the cache and fingerprint contract

| Question                                                       | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                          | Result |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Is BuildKit secret content excluded from the cache key?        | Yes — it is not hashed, which is the whole defect. The fingerprint arg is the explicit cache input that compensates.                                                                                                                                                                                                                                                                                                                             | PASS   |
| Is the fingerprint build-arg bound to the real secret content? | The value is `HMAC-SHA256(key, label)` truncated to 128 bits; a key change changes the value, which changes the `RUN` layer's cache key.                                                                                                                                                                                                                                                                                                         | PASS   |
| Is there exactly one canonical fingerprint implementation?     | Yes in behaviour: `FINGERPRINT_LABEL`/`FINGERPRINT_LENGTH` exist in exactly two definition sites — `apps/web/src/lib/server-action-key.ts` (canonical) and `scripts/ci/server-action-key-fingerprint.mjs` (dependency-free CLI). The CLI is pinned to the canonical function by 9 tests across 16/24/32-byte keys. `apps/web/scripts/verify-server-action-key-consistency.ts` **imports** the canonical function rather than re-implementing it. | PASS   |
| Can a key change reuse the old-key layer?                      | No. Proven by direct experiment in EA-5 (cached layer with the other key) and re-proven this phase by check 7 of the acceptance suite and the required-arg failure path.                                                                                                                                                                                                                                                                         | PASS   |
| Does a missing secret fail closed?                             | Yes — proven: `secret next_server_actions_key: not found`, exit 1, no image.                                                                                                                                                                                                                                                                                                                                                                     | PASS   |
| Does an invalid key fail closed?                               | Yes — exit 2 before the build starts (the fingerprint is computed pre-build), and the gate refuses it too.                                                                                                                                                                                                                                                                                                                                       | PASS   |
| Does a wrong fingerprint fail closed?                          | Yes — the required-arg guard (`:?…is required`) and the post-build gate both exit non-zero.                                                                                                                                                                                                                                                                                                                                                      | PASS   |
| Is the key ever an `ENV`/`ARG` of the image?                   | No. The only `ARG` is the fingerprint; `docker image inspect` of an existing image shows no `SERVER_ACTION*` variables.                                                                                                                                                                                                                                                                                                                          | PASS   |
| Does the post-build check validate the final artifact?         | Yes — the shared gate copies `server-reference-manifest.json` out of the finished image (`docker create`, no start) and compares its fingerprint.                                                                                                                                                                                                                                                                                                | PASS   |
| Is the build/deploy identity unambiguous?                      | CI deploys by `@sha256` digest; the local entries build one computed tag and use it for gate, ship and deploy.                                                                                                                                                                                                                                                                                                                                   | PASS   |
| Can `build-drill-image.sh` produce inconsistent tags?          | **It could — found and fixed this phase** (§3). After the fix, one tag is created, gated, shipped and pinned at the remote recreate; asserted by a contract test.                                                                                                                                                                                                                                                                                | PASS   |

---

## 3. Defect found and fixed in this phase (EA-5 follow-up)

### E-5a — the drill recreate ran from the **host's stale compose file** (HIGH)

**Evidence (static, then reproduced locally with a fake `ssh`).**

`build-drill-image.sh` edited the compose file with `sed -i` on the **local**
checkout (step 3), but the recreate in step 4 ran on the **drill host**:

```
ssh "$DRILL_HOST" "cd $DRILL_DIR && docker compose -f $DRILL_COMPOSE_FILE \
  --project-name beaconhs-drill-$(date +%Y%m%d-%H%M%S) up -d --force-recreate"
```

The host has its own checkout of the same file, still pinned to the old tag. So
the `sed` never reached the stack that was actually recreated: **the previous
image was redeployed while the new one had just been loaded**. The project name
was also regenerated per run, so every deploy created a **new stack** instead of
updating the running one, and the driver check afterwards inspected the hardcoded
container `beaconhs-phase-aj-worker-1`, which belongs to another stack.

**Fix (scoped to that script).**

- The recreate runs under a stable project (`DRILL_PROJECT`, default
  `beaconhs-drill-20261009`) so it updates the running stack.
- `docker compose … config` runs first on the host; an invalid or unreachable
  compose file aborts **before** any container is recreated.
- `docker compose -C $DRILL_IMAGE_NAME up -d --force-recreate --no-build` pins
  the freshly shipped tag on the host that runs the stack, so the recreate can no
  longer resolve the host's stale tag.
- The driver check resolves this deployment's worker by compose project/service
  labels instead of a hardcoded container name.

**Proof (isolated, no Drill contact).** The block was extracted and run against
a fake `ssh` that records its argv:

```
CMD=cd /repo && docker compose -f deploy/drill-20261009.compose.yaml \
    --project-name beaconhs-drill-20261009 config >/dev/null
CMD=cd /repo && docker compose -f deploy/drill-20261009.compose.yaml \
    --project-name beaconhs-drill-20261009 -C beaconhs:drill-20261021-999999 up -d --force-recreate --no-build
```

and with a failing `config` call: `[deploy] the drill host compose configuration is invalid; nothing was restarted`,
exit 1, **`up` never issued**. The gate still runs before shipping, and the
repository compose file is byte-identical afterwards (`sha256sum -c` pass).

**Contract test added** (`server-action-key-deployment-contract.test.ts`):
recreate pins `-C $DRILL_IMAGE_NAME`, pre-flight `config` present, no per-run
`--project-name … $(date`, no hardcoded `phase-aj` worker in any executable line.
The assertion ignores comment lines so the explanatory comment may name the old
container.

---

## 4. Phase D — deployment contract and replica convergence

`verify_replicas` (called by the workflow's `Verify every web replica's Server
Action key`):

| Requirement                                        | Implementation                                                                                                      | Result |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| Waits for the expected replica count               | Polls up to 300 s until `Spec.Mode.Replicated.Replicas` equals the running task count                               | PASS   |
| Checks the service update state, including failure | Fails unless `UpdateStatus.State` is empty or `completed`; a `paused`/`rollback_*`/`updating` state never certifies | PASS   |
| Non-zero exit when not converged                   | `fail_gate` → exit 1 with `did not settle … refusing to certify a mid-rollout fleet`                                | PASS   |
| Fails on a fingerprint mismatch between instances  | `verify_replica` per task, then `compare_fingerprints`                                                              | PASS   |
| Direct vs Dokploy branch matches the design        | Step gated `if: env.DOKPLOY_DEPLOY_MODE == 'direct'` (EA-5 fix)                                                     | PASS   |
| Dokploy must not run node-only container filtering | It no longer does; the pre-migration **image** gate remains the binding proof there                                 | PASS   |
| Failure blocks later steps                         | Gates run last; any non-zero exit fails the job; the image gate precedes migrations                                 | PASS   |

**Explicitly NOT RUN:** the convergence wait and the label filter have never run
against a real Swarm service or Dokploy. Their decision logic is unit-covered
(11 fixture checks); the live behaviour is not verified. Multi-node Swarm remains
unverified — `verify_replicas` samples the local node's containers, which is
correct only for the single-node stacks both paths deploy today.

---

## 5. Phase B/E — test and gate results (each with its own exit code)

### Core EA-5 evidence, re-run

| #   | Command                                                                                                                                               | Exit | Pass | Fail | Skip | Time  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ---- | ---- | ----- |
| T1  | `bash scripts/ci/verify-server-action-key-gate.test.sh`                                                                                               | 0    | 11   | 0    | 0    | < 1 s |
| T2  | `bash scripts/ci/build-local-image-key-gate.test.sh`                                                                                                  | 0    | 8    | 0    | 0    | 352 s |
| T3  | `pnpm --filter @beaconhs/web exec vitest run src/lib/server-action-key-deployment-contract.test.ts src/lib/server-action-key-fingerprint-cli.test.ts` | 0    | 23   | 0    | 0    | 1 s   |

T2 performs one **real** local image build (its own throwaway tag, removed by the
suite). A key-shape scan of T1/T2/T3 output found no key material; only the
128-bit fingerprint is printed.

After the §3 fix and its new contract test, the targeted re-runs were:
T1 **11/11**, T2 **8/8**, T3 + `server-action-key.test.ts` **35/35** (15 contract
assertions including the new one, 9 CLI, 11 canonical).

### Full local release-candidate gates

| Command               | Exit | Result                                                                                 |
| --------------------- | ---- | -------------------------------------------------------------------------------------- |
| `pnpm format:check`   | 0    | —                                                                                      |
| `pnpm typecheck`      | 0    | 27/27 tasks                                                                            |
| `pnpm lint`           | 0    | 1/1 task                                                                               |
| `pnpm test`           | 0    | web **2105 passed / 8 skipped** (2113); db **506 passed / 41 skipped** (547); 25 tasks |
| `pnpm deadcode:check` | 0    | —                                                                                      |
| `pnpm build`          | 0    | 4/4 tasks                                                                              |

The 41 skipped DB assertions are the live-suite tests that only run in the
explicit `db-owner`/`db-seeded`/`db-runtime`/`db-freeze` projects (EA-2 evidence);
they are unchanged by this phase and were not re-run here.

---

## 6. Phase F — cleanup

| Resource                                                       | State                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| `/tmp/ea6*` (keys, drill compose copy, logs, fake-ssh harness) | 13 entries removed; none remain                                 |
| `beaconhs:drill-20261021-103611`, `beaconhs:drill-latest`      | Removed                                                         |
| `beaconhs:ea4-gate-selftest`                                   | Removed by the suite itself                                     |
| Containers                                                     | None created                                                    |
| Dangling images                                                | 0                                                               |
| Pre-existing images (`dr-mirror`, `local-20261021`)            | Intact                                                          |
| Volumes, databases                                             | Not touched                                                     |
| Drill / `phase-aj` / production                                | Never contacted; recreate logic exercised only via a fake `ssh` |
| Repository compose file                                        | Unchanged (`sha256sum -c` pass)                                 |

---

## 7. Final state

```
branch                -> hse-platform (start and end)
HEAD                  -> 51a899b7aac0a942da327222a3eed355fca9798a (unchanged)
staged                -> 0
modified / untracked  -> 154 M / 465 ??  (unchanged counts)
git diff --stat       -> 154 files changed, 5134 insertions(+), 1919 deletions(-)
```

Nothing committed, pushed, deployed or fetched. Files changed **by this phase**:

- `scripts/build-drill-image.sh` (untracked, modified) — §3 fix.
- `apps/web/src/lib/server-action-key-deployment-contract.test.ts` (untracked, modified) — one new contract test (14 → 15 assertions).
- `docs/phase-6u-b3-ea6-local-release-candidate.md` (this report).

---

## 8. Not verified — stated plainly

1. **Real deployment: NOT RUN.** No GitHub Actions run, no Dokploy call, no
   registry push, no remote host touched.
2. **Multi-node Swarm: NOT RUN.** The replica gate is single-node by design and
   has never seen a real service.
3. **GHCR / GHA cache path: NOT RUN.** The cache-binding mechanism was proven
   against local BuildKit only; the remote cache backend is unexecuted.
4. **Drill deploy steps (ship, recreate, driver probe): NOT RUN.** Only their
   argument construction and failure ordering were exercised locally.
5. **LibreOffice-backed PDF preview** still requires `SOFFICE_PATH` locally
   (EA-4 result, unchanged).
6. `pnpm test` skips 41 DB-backed assertions outside the live-suite projects, as
   before.

---

## 9. Residual risks

- The drill script's remote path (`docker save | docker exec … docker load`) is
  exercised only for its build/gate half; its transport half is unexecuted.
- `.github/*` edits remain uncommitted working-tree changes; nothing is armed.
- Known defects D1–D6 unchanged; WOPI unchanged.
- `PERMISSION_CATALOGUE` is 102 keys while `AGENTS.md` still says 89 (documentation
  drift, recorded, not fixed).

---

## 10. Conclusion

**LOCAL RELEASE CANDIDATE: PASS.**

Every gate that was run locally passed with its own captured exit code, the EA-5
key contracts (secret-only injection, fingerprint cache binding, fail-closed
builds, image-level verification, single-tag identity) have direct evidence, and
the one high-severity issue found during this audit was fixed and covered by a
negative test.

**Production release acceptance: NOT RUN.** A real deployment, multi-node
behaviour and the GHCR/GHA cache path remain unproven and must be verified
separately before any release announcement.
