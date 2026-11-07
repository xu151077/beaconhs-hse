# EA-57 — CI execution, deployment-gate verification, and release-blocker convergence

Status date: 2026-10-27
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform` · HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Production state: **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**

Status vocabulary, kept separate on purpose: `PASS`, `PARTIAL`, `FAIL`,
`NOT RUN`, `NOT VERIFIED`, `PENDING AUTHORIZATION`.

---

## 0. The one thing this report must not do

It must not let a local result stand in for a remote one. Six tiers are involved
and they are reported separately throughout:

| Tier                            | What it establishes                                                            | Result in EA-57           |
| ------------------------------- | ------------------------------------------------------------------------------ | ------------------------- |
| **A. Local tests**              | The code builds, type-checks, lints and the suites pass on this host           | `PASS` (serially) — §2    |
| **B. Isolated tests**           | Each control blocks the thing it is supposed to block, under adversarial input | `PASS` 13/13 — §4         |
| **C. Static workflow audit**    | The checked-in YAML orders the controls correctly and has no bypass            | `9 PASS + 1 PARTIAL` — §3 |
| **D. Real GitHub Actions**      | GitHub actually ran it, on GitHub's runner, with real secrets                  | `NOT RUN`                 |
| **E. Real GHCR promotion**      | The staging and release references are provably the same bytes                 | `NOT RUN`                 |
| **F. Real deployment platform** | Dokploy runner has buildx; the live Swarm fleet matches the gated digest       | `NOT VERIFIED`            |

Tiers A, B and C are done. D, E and F were not executed, and nothing in A, B or
C is offered as evidence for D, E or F.

---

## 1. Authorization scope

Authorized: run local checks, statically audit the workflows, probe capabilities,
run isolation-level negative tests reusing the EA-54/55/56 machinery, and produce
this report plus an evidence bundle.

**Not authorized, and not done:** production deploy; image publication; Migration
51; production rollback; database or object-store restore; any change to the
A1–A8 decisions; any change to production or `ceshi`; any commit, push, PR or
workflow dispatch.

Notably, the instruction explicitly said that if real CI would require a branch
push, a workflow dispatch, GHCR access or external credentials, the agent must
first check existing authorization and, absent explicit authorization, perform
static checks and local simulation only — **never bypass**. §5 documents that no
such authorization exists in this environment.

## 2. Workspace state

|                             | At EA-57 start                               | At report time                                                                     |
| --------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Branch / HEAD               | `hse-platform` / `51a899b7`                  | unchanged                                                                          |
| Modified tracked files      | 165                                          | 165 (the addendum went into `docs/project-development-state.md`, already modified) |
| Untracked entries           | 518                                          | 519 (`docs/ea57-…report.md`; `docs/evidence/ea57/` collapses to one `??`)          |
| Staged                      | 0                                            | 0                                                                                  |
| `turbo.json` status / mtime | ` M` / `2026-10-23 11:04:04.542871014 +0800` | identical                                                                          |
| `git diff --check`          | clean                                        | clean                                                                              |

EA-57 created no tracked source change. It added files under `docs/` only, exactly
as the instruction required.

Protections observed: no `git reset --hard`, `git clean`, `git restore`,
`git checkout` or `git add -A`; no container, image, volume, backup, snapshot or
evidence file deleted. Four previously-stopped local containers were **started**
(reusing their volumes) so the test suite could reach its dependencies — see §2.2.

### 2.1 EA-56 artefacts and evidence re-verified first

All eleven artefacts named in the instruction were confirmed present with their
sizes, and the EA-56 bundle verified:

```
$ cd docs/evidence/ea56 && sha256sum -c SHA256SUMS
authorization-scope.md: OK      baseline.txt: OK
build-identity-tests.log: OK    gate-integration-tests.log: OK
source-origin-tests.log: OK     validation-summary.md: OK
../../ea56-build-identity-and-gate-integration-report.md: OK
exit 0   (7/7, no self-reference)
```

### 2.2 A correction to a prior claim

`pnpm test` returned 0 on the first attempt **with `Cached: 25 cached, 25 total`**.
No test process ran; Turbo replayed a stored result. A forced rerun then failed.

The forced rerun was diagnosed rather than dismissed:

| Run | Command                                  | Result            | Cause                                                                                                                                      |
| --- | ---------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| B   | `turbo run test --force`                 | exit 1, 6/25      | `@beaconhs/storage` → `ECONNREFUSED 127.0.0.1:9000` (MinIO down)                                                                           |
| C   | `turbo run test --force` (MinIO up)      | exit 1, 13/25     | `@beaconhs/jobs` "Test timed out in 5000ms"; `@beaconhs/integrations` "Promise resolution is still pending"; Turbo then cancelled 12 tasks |
| D   | `turbo run test --force --concurrency=1` | **exit 0, 25/25** | serial execution removes the contention                                                                                                    |

Run D is the valid result: **25/25 tasks, `Cached: 0`, 3911 tests passed, 101
skipped, 0 failed.**

Run C's failures are contention-shaped — a 5-second wall-clock timeout on a
module import and a `node --test` event-loop abort — and touch no file changed by
EA-56 or EA-57. This host's available memory has been observed between roughly
3.4 and 5.9 GiB while 25 test packages run concurrently.

**Consequence:** any earlier `pnpm test` pass in this series that carried
`Cached: 25 cached` was a cache replay and must not be cited as test evidence
again. That correction is recorded here rather than quietly repaired.

## 3. Local gates — tier A

| Gate                      | Command                                                | Exit | Detail             |
| ------------------------- | ------------------------------------------------------ | ---- | ------------------ |
| Format                    | `pnpm format:check`                                    | 0    | —                  |
| Typecheck                 | `pnpm typecheck`                                       | 0    | 27/27              |
| Typecheck, cache bypassed | `turbo run typecheck --force`                          | 0    | 27/27, `Cached: 0` |
| Lint                      | `pnpm lint`                                            | 0    | 1/1                |
| Lint, cache bypassed      | `turbo run lint --force`                               | 0    | 1/1, `Cached: 0`   |
| Dead code                 | `pnpm deadcode:check`                                  | 0    | —                  |
| Build                     | `pnpm build`                                           | 0    | 4/4, `Cached: 4`   |
| Tests                     | `turbo run test --force --concurrency=1`               | 0    | 25/25, 3911 passed |
| Diff hygiene              | `git diff --check`                                     | 0    | —                  |
| Identity suites           | `node --test scripts/ci/verify-source-origin.test.mjs` | 0    | 11/11, 0 skipped   |
| Identity suites           | `node --test scripts/ci/build-identity-gate.test.mjs`  | 0    | 31/31, 0 skipped   |

`pnpm build` being cached is not a shortcut: a Turbo cache hit means the task
inputs hash identically to a previously recorded success (EA-56 ran real forced
`@beaconhs/web` builds three times), and no file under `apps/` or `packages/`
changed between EA-56 and now. The cache hit _is_ the input-unchanged proof.

The two identity suites were run with `node --test` directly, so they cannot be a
cache replay regardless of Turbo state.

## 4. Isolated negative probes — tier B

Thirteen probes, **13/13 PASS, exit 0**, executed against the checked-in EA-56
controls using a temporary git repository, temporary dist directories, generated
gate candidates and a stub `docker` on PATH. No registry, cluster or production
service was touched.

| Probe | Attack / condition                      | Observed                                                                   |
| ----- | --------------------------------------- | -------------------------------------------------------------------------- |
| P1a   | matching revision (control)             | exit 0                                                                     |
| P1b   | foreign revision                        | exit 1 — `checkout.matches_expected` FAIL                                  |
| P2    | artefact with no identity               | exit 1                                                                     |
| P3    | unusable digest to publication          | exit 1 — refused before any registry call                                  |
| P4    | manifest config digest ≠ image config   | exit 1 — `G1.config_digest_matches_manifest` FAIL                          |
| P5a   | current policy, unsigned image          | exit 0, but `G4.identity_chain_complete = PARTIAL`, "INCOMPLETE by policy" |
| P5b   | `require_signature: true`, no signature | exit 1                                                                     |
| P6    | truncated / unparseable artefact        | exit 2 — documented "IO error" class; any non-zero blocks                  |
| P7    | running digest mismatch                 | exit 1                                                                     |
| P8    | readiness 200 + digest mismatch         | exit 1                                                                     |
| P9    | empty fleet                             | exit 1 — not a vacuous pass                                                |
| P10   | matching fleet (control)                | exit 0                                                                     |
| P11   | Dokploy compose path                    | emits `Gate 5 NOT VERIFIED`, never `PASS`                                  |

P1a, P5a and P10 are the positive controls: they show the harness can produce an
"allow" outcome, so the "block" outcomes are not artefacts of a broken harness.

P5a deserves emphasis. It is the machine-readable statement that **A1/A2/A6 are
unapproved**, not a passing supply-chain verification. The gate reports `PARTIAL`
and says the chain is incomplete _by policy_.

## 5. Static workflow audit — tier C

Full detail with file, line, condition and conclusion for all ten required
checks: `docs/evidence/ea57/workflow-audit.md`.

Observed control order in `deploy-dev.yml`, which matches the mandated order:

```
caller gate (41) → stale-run check (56) → source verification (88) → build to
staging-<sha> (96) → post-build assert (124) → promote to release tag (133)
→ [job boundary: deploy needs build, 144] → digest validated (174)
→ SAK gate (328) → identity gate (344) → migrations (373)
→ rollout (502 compose / 518 direct) → readiness (533)
→ replica verification (572) → running-digest reconcile (588)
```

| #   | Check                                                 | Result           |
| --- | ----------------------------------------------------- | ---------------- |
| 1   | Source-check failure blocks the build                 | `PASS`           |
| 2   | Post-build assertion failure blocks promotion         | `PASS`           |
| 3   | Promotion failure or digest drift blocks deploy       | `PASS`           |
| 4   | Gate failure blocks migrations and rollout            | `PASS`           |
| 5   | No `continue-on-error`, `always()`, or wrong `needs`  | `PASS`           |
| 6   | No critical step skippable while a later job succeeds | `PASS`           |
| 7   | Staging tag cannot be deployed                        | `PASS`           |
| 8   | Promotion is genuinely digest-addressed               | `PASS`           |
| 9   | Running-digest reconciliation is fail-closed          | `PASS` (see F-4) |
| 10  | Compose path declared NOT VERIFIED, not PASS          | `PARTIAL`        |

Supporting facts:

- `grep -rn continue-on-error .github/workflows/` → **none**.
- `always()` / `failure()` / `cancelled()` → **none anywhere**.
- Exactly four `if:` expressions exist in `deploy-dev.yml`, all route selection
  (`api` vs `direct`), none suppressing a gate.
- `staging-` appears in exactly three places: the build tag (108), the assertion
  (127), and the regression test that pins them. Every deployment reference is
  `@${IMAGE_DIGEST}`.
- `promote-verified-image.sh` rejects a non-canonical digest, rejects a
  `tag@digest` release ref, copies server-side, re-inspects, and compares the
  digest — there is no warning path.
- `reconcile-running-digest.sh` exits 1 on mismatch, partial match, empty fleet,
  uninspectable service and non-canonical expected digest. Readiness is not an
  input, which is why P8 can only fail.

### 5.1 Findings from the audit

**F-4 (LOW) — misleading diagnostic on a `docker service ls` failure.**
`reconcile-running-digest.sh` consumes `docker service ls` through process
substitution, so a failure of that command is not propagated; the loop sees no
input, `matched` stays 0, and the script exits 1 with "matched no running
service" instead of the real docker error. It still fails closed; only the
operator message is less precise.

**Check 10 (PARTIAL) — honest log, green run.**
`deploy-dev.yml:591-593` emits `::warning::Gate 5 NOT VERIFIED …` and then
`exit 0`. The log cannot be misread as a pass, and the step never fabricates a
digest comparison. But the _job and run conclude success_, so a dashboard, a
required-status check or a release bot reading only the conclusion would see
green. This satisfies "must not report PASS" at log level and fails it at
run-signal level. Safety impact is zero (the artefact is still identity-gated
before rollout); release-signalling impact is real.

**F-1 (LOW) — unused credential.** `deploy-dev.yml:90` passes
`GITHUB_TOKEN: ${{ github.token }}` to the source-origin step, but
`verify-source-origin.mjs` never reads a token. Unnecessary exposure in a step
that only reads the checkout.

**F-2 (LOW, defence-in-depth) — wrapper trusts exit code, not verdict.**
`verify-image-identity.mjs:121` records `parsed.verdict`, but line 125 computes
`exitCode = verify.ok ? 0 : 1`. If the verifier ever emitted exit 0 with a
non-`PASS` verdict, the wrapper would pass while printing a failing verdict. No
exploitable path exists today (`verify-build-identity.mjs:113` exits
`verdict === 'PASS' ? 0 : 1`). Suggested hardening:
`verify.ok && parsed.verdict === 'PASS'`.

**F-5 (INFO)** `cache-to: type=gha,mode=max,ignore-error=true` — deliberate; the
image is pushed before the cache write, so a cache hiccup cannot affect artefact
integrity.

**F-6 (INFO, pre-existing)** `ci.yml:185` uses `secrets: inherit`. Pre-existing,
same repository, out of EA-57 scope; recorded so it is not mistaken for an EA-56
addition.

### 5.2 Why F-2 was not patched

EA-57 is a verification phase, and the instruction scopes the workflow audit to
read-only. Editing the control being audited would invalidate the audit and the
EA-56 evidence bundle, and the gap has no exploitable path today. It is recorded
with a proposed patch for a scoped follow-up rather than silently changed.

## 6. Real CI capability — tier D/E/F

Probed, with no credential printed:

| Capability                                            | Result             |
| ----------------------------------------------------- | ------------------ |
| `gh` CLI                                              | absent (exit 127)  |
| `act`                                                 | absent             |
| `GH_TOKEN` / `GITHUB_TOKEN` / `GITHUB_ACTIONS` in env | absent             |
| `~/.docker/config.json`                               | absent             |
| GHCR anonymous read of the deployment package         | `401 Unauthorized` |
| Local Swarm                                           | `inactive`         |
| Access to `runs-on: [self-hosted, dokploy]`           | not available      |

Repository topology matters here: `origin` is `xu151077/beaconhs-hse` (a fork),
while `deploy-dev.yml:28` publishes to `ghcr.io/braedonsaunders/beaconhs`
(upstream). Real execution therefore needs write access to the **upstream**
package, which this environment does not have.

Consequently:

- **D. Real GitHub Actions — `NOT RUN`.** No push authorization, no dispatch
  authorization, no `gh`, no token.
- **E. Real GHCR staging → release — `NOT RUN`.** No credentials (401), and no
  `staging-<sha>` artefact exists because the build has never run for this commit
  in CI.
- **F. Real deployment platform — `NOT VERIFIED`.** The Dokploy runner's buildx
  state is unknown; the live fleet is unreachable and local Swarm is inactive.

A local `act` replay would not discharge D even if `act` were installed: it runs
on this host, not GitHub's runners, and does not use the repository's real
secrets or the upstream package.

### 6.1 Exact commands a future authorized run needs

```bash
# 1. push (requires: branch-push authorization to braedonsaunders/beaconhs)
git push upstream hse-platform:main

# 2. observe, do not assume (requires: GH_TOKEN with repo + read:packages)
gh run list --repo braedonsaunders/beaconhs --workflow ci.yml --limit 5
gh run watch --repo braedonsaunders/beaconhs <run-id>

# 3. prove the two references are the same bytes
docker buildx imagetools inspect ghcr.io/braedonsaunders/beaconhs:staging-<sha>
docker buildx imagetools inspect ghcr.io/braedonsaunders/beaconhs:<sha>

# 4. prove the gate's prerequisite on the real runner (deploy-dev.yml:359)
ssh <dokploy-runner> 'docker buildx version'
```

Missing authorizations: (1) push to upstream, (2) a token with
`repo` + `read:packages`, (3) approval to run a workflow that publishes an image
(the workflow has no dry-run path), (4) access to the Dokploy runner.

## 7. Release blocker register — tier result

| Blocker                     | Required evidence                               | Status                               |
| --------------------------- | ----------------------------------------------- | ------------------------------------ |
| Real CI workflow execution  | actual run + conclusion                         | `NOT RUN`                            |
| GHCR staging → release tag  | both digests, proven equal                      | `NOT RUN`                            |
| Dokploy runner buildx       | check on the real runner                        | `NOT VERIFIED`                       |
| Swarm Gate 5                | running-digest reconciliation on the real stack | `NOT VERIFIED`                       |
| Signature policy A1/A2      | formal approval record                          | `PENDING AUTHORIZATION`              |
| SBOM policy A6              | approval + implementation evidence              | `PENDING AUTHORIZATION`              |
| Observe-only window A5      | dates, owner, exit criteria                     | `PENDING AUTHORIZATION`              |
| Rollback execution path     | executable code + negative tests                | `FAIL — NO EXECUTABLE ROLLBACK PATH` |
| Migration 51                | production pre-check + approval                 | `NOT RUN`                            |
| DB and object-store restore | real restore drill                              | `NOT RUN`                            |

Detail and exit conditions: `docs/evidence/ea57/blockers.md`.

Two points that must not be softened:

1. **A1–A8 are decisions, not tests.** `require_signature: false` and
   `require_sbom: false` in `deploy-gate-policy.json` are the encoded statement
   that the decisions are open. The gate's `PARTIAL` verdict is that statement
   rendered machine-readably. No technical result in this report substitutes for
   an approval.
2. **EA-16's historical provenance is not signature, SBOM, or cross-version
   compatibility proof.** Provenance attestation proves what was built from what;
   it does not prove who signed it, what is inside it, or that it interoperates.

The rollback blocker is a `FAIL` rather than a `NOT RUN` because the object does
not exist: a repository-wide search finds no rollback script and no rollback step
in any workflow, and `docs/ea52-build-identity-and-rollback-design-report.md:202`
states that the 10-step contract was designed and **no rollback code was
written**, with RB-1…RB-13 all `NOT RUN`.

## 8. What EA-57 proves, and what it does not

**Proves:**

- The checked-in workflow orders its controls correctly and contains no bypass
  (`continue-on-error`, `always()`, or a wrong `needs`).
- Each control blocks the attack it exists for, under adversarial input, with
  positive controls confirming the harness works (13/13).
- Publication is digest-addressed and refuses unusable input before contacting a
  registry.
- Gate 5 fails closed on mismatch, partial match and an empty fleet, and cannot
  be rescued by readiness.
- The repository's test gate passes on this host when run serially: 3911 tests.

**Does not prove:**

- That GitHub Actions can execute the workflow (D).
- That the staging and release digests match in GHCR (E).
- That the Dokploy runner has buildx, or that the deployed fleet runs the gated
  digest (F).
- That A1/A2/A5/A6 are approved, or that a signature, SBOM or observation window
  exists.
- That a rollback can be executed — the opposite is established.
- That Migration 51 or any restore is safe in production.

## 9. Deliverables

| File                                                      | Purpose                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `docs/ea57-ci-and-deployment-gate-verification-report.md` | this report                                                                   |
| `docs/evidence/ea57/baseline.txt`                         | workspace state, EA-56 re-verification, protections                           |
| `docs/evidence/ea57/local-tests.log`                      | every local command with its exit code, including the cache-replay correction |
| `docs/evidence/ea57/workflow-audit.md`                    | the ten checks with file, line, condition, conclusion                         |
| `docs/evidence/ea57/environment-capabilities.md`          | capability matrix, no secrets                                                 |
| `docs/evidence/ea57/blockers.md`                          | the register with exit conditions                                             |
| `docs/evidence/ea57/SHA256SUMS`                           | integrity of the above                                                        |

Integrity: `cd docs/evidence/ea57 && sha256sum -c SHA256SUMS` → all OK, exit 0.

The probe harness lives at `/tmp/opencode/ea57/` and is deliberately **not**
added to the repository: a second checked-in control surface would be a shadow
system. The probes call the checked-in EA-56 scripts, so the behaviour verified
is the shipped behaviour.

## 10. Final state

Local, isolated and static verification are complete and green. Every remote tier
is unexecuted for a stated, non-bypassable reason. No code was committed, pushed,
published or deployed; no A1–A8 decision was changed; Migration 51 and every
restore remain untouched.

**PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**

EA-57 ends here. EA-58 is not started.
