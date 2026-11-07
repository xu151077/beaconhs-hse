# EA-56 — Trusted source identity, build assertion, and deployment gate integration

Status date: 2026-10-27
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform` · HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Authorized changes: `EA56-CHG-1` … `EA56-CHG-6`
Production state: **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**

Status vocabulary used in this report, kept separate on purpose: `PASS`,
`PARTIAL`, `FAIL`, `NOT RUN`, `NOT VERIFIED`, `PROPOSED`,
`PENDING AUTHORIZATION`, `NOT FOUND`.

---

## 1. Actual authorization scope

The user authorized `EA56-CHG-1` … `EA56-CHG-6` in conversation: fix the
`DEPLOYMENT_VERSION` declaration, reuse the EA-53 post-build verifier, add a
trusted source-revision cross-check, make only unavoidable Dockerfile changes,
wire the gates into CI minimally, and add the tests and evidence.

Not authorized and not done: production/`ceshi` changes, production deploy or
rollback, Migration 51, database or object-store restore, approving A1–A8,
bypassing signature/provenance/SBOM policy, a public identity API, changing
readiness semantics, Server Action Key rotation, and any commit, push, PR or
image publication.

Full register: `docs/evidence/ea56/authorization-scope.md`.

## 2. Workspace state before and after

|                             | Before                                       | After            |
| --------------------------- | -------------------------------------------- | ---------------- |
| Branch / HEAD               | `hse-platform` / `51a899b7`                  | unchanged        |
| Modified tracked files      | 165                                          | 165              |
| Untracked files             | 507                                          | 518              |
| Staged                      | 0                                            | 0                |
| `turbo.json` status / mtime | ` M` / `2026-10-23 11:04:04.542871014 +0800` | ` M` / identical |
| `git diff --check`          | —                                            | clean            |

No file was reverted, cleaned, restored or checked out. No `git add -A`, no
commit, no push. The 11 additional untracked entries are the EA-56 files
themselves (one report, ten under `scripts/ci/`); the seven files under
`docs/evidence/ea56/` do not raise the count because `docs/evidence/` is already
an untracked tree that git reports as a single entry.

Only **two** lines were deleted anywhere in the tracked tree, and both were
replaced deliberately:

```
-      image_digest: ${{ steps.build-image.outputs.digest }}
-          tags: ${{ env.IMAGE_NAME }}:${{ github.sha }}
```

Detail: `docs/evidence/ea56/baseline.txt`.

## 3. `turbo.json` — the pre-existing diff was preserved, not re-applied

`turbo.json` was already ` M` when EA-56 started, owning an uncommitted
`globalEnv` declaration of `R2_ENDPOINT`, `R2_INTERNAL_ENDPOINT`,
`PUBLIC_APP_URL` and `DEPLOYMENT_VERSION`. EA-56 did **not** touch it: the mtime
is byte-identical to the pre-EA-56 value and the diff is unchanged.

Verification instead of re-declaration (`EA56-CHG-1`):

- `DEPLOYMENT_VERSION` is in `globalEnv`, so Turbo's strict filter passes it to
  `next build` (`EA56-T9`).
- No task sets `envMode: "loose"` (`EA56-T9`).
- Three real uncached builds proved propagation: with the revision set, the
  artefact carries `config.deploymentId = 51a899b7…`; with a different value it
  carries that value, so no stale artefact is reused (`EA56-T15`).
- The Dockerfile already validates `^[0-9a-f]{40}$` before the build runs, so
  `EA56-CHG-4` required no change.

## 4. Step C — trusted source origin (the first work, per instruction)

Implemented as `scripts/ci/verify-source-origin.mjs`. The contract exists
because a build and a post-build assertion that compare the artefact against the
same caller-supplied string are **both blind to a foreign revision**
(EA-55 T5a: `build=PASS` and `identity-assert=PASS` for a forged revision).
Origin must therefore come from a second, independent source _before_ the
build.

| Role     | Value                                     | Why it is independent                                 |
| -------- | ----------------------------------------- | ----------------------------------------------------- |
| expected | `GITHUB_SHA`                              | set by the platform from the event, not by the caller |
| actual   | `git rev-parse HEAD` in the build context | read from the bytes that will actually be built       |

`PASS` requires: present, 40 lowercase hex, a trigger with defined SHA
semantics, a ref, readable HEAD, HEAD == expected, a full clone, and a clean
tracked tree. Everything else fails closed. Exit codes: `0` verified, `1`
rejected, `2` usage, `3` environment unreadable.

Trigger policy is explicit rather than assumed:

- `push`, `workflow_dispatch` → supported.
- `pull_request`, `pull_request_target`, `merge_group` → **refused**. A PR's
  `GITHUB_SHA` is an ephemeral merge commit that exists on no branch, so a
  release built from it cannot be traced. It is refused rather than silently
  accepted; PR builds are already excluded from the deploy path.
- anything else, or a missing event → refused, never defaulted.

The validator does not accept a SHA on format alone: a well-formed value that
does not equal the checked-out HEAD is rejected (`EA56-T2`).

Evidence: `docs/evidence/ea56/source-origin-tests.log` — 11/11 pass.

## 5. Step B — post-build identity assertion

`scripts/ci/verify-build-identity.mjs` is the EA-53 implementation copied in
unchanged (portable; no `/tmp` dependency). It is the single parser for
`required-server-files.json`; `EA56-T27` fails if a second one appears under
`scripts/`.

`scripts/ci/verify-image-identity.mjs` is a thin CI adapter: it extracts the
one file that carries the identity from the **built image** and delegates every
decision to the verifier. It contains no verification logic of its own, because
in CI the artefact is an image, not a local build tree, and the image is what
will actually run.

Assertions enforced: output present, identity present, well-formed 40-hex, not
a `BUILD_ID`, and equal to the revision Step C verified. `APP_VERSION` is never
a fallback.

Evidence: 31/31 pass in `docs/evidence/ea56/build-identity-tests.log`, plus the
real-artefact run in `validation-summary.md` §3.

## 6. Step D — deployment gate integration

Reused unchanged: EA-54 `deployment-gate.mjs` (policy engine) and the EA-54
six-gate structure. New, minimal glue:

- `assemble-gate-candidate.mjs` — the only component that reads the registry.
  Reads the index with `buildx imagetools inspect --raw` (plain
  `docker manifest inspect` strips `annotations`, which holds the provenance
  subject binding), resolves index → platform manifest → config, reads the
  SLSA predicate from the index, and reads the embedded revision from the image.
  It never synthesises evidence: a missing proof stays missing so the gate
  rejects it.
- `promote-verified-image.sh` — creates the release tag by server-side manifest
  copy and **verifies the digest did not change**, so publication is provably
  the same bytes that were asserted.
- `reconcile-running-digest.sh` — Gate 5, reads the running service spec rather
  than readiness.
- `deploy-gate-policy.json` — records that A1/A2/A6 are unapproved (§7).

### 6.1 CI workflow change map (`.github/workflows/deploy-dev.yml`)

| Line | Step                                                 | Position rationale                        |
| ---- | ---------------------------------------------------- | ----------------------------------------- |
| 88   | Verify the source revision matches the checkout      | before the build                          |
| 96   | build-image — `push: true`, tag `staging-<sha>`      | staging tag is not deployable             |
| 124  | Assert the built image carries the verified revision | **before** publication                    |
| 133  | Promote the verified digest to its release tag       | the only publication point                |
| 344  | Gate the candidate image before deployment           | before migrations (373) and rollout (518) |
| 588  | Reconcile the running image digest                   | after rollout                             |

Ordering invariant: **origin → build → assert → publish → gate → deploy →
reconcile**. A failure at any stage stops the job, so later stages do not run.
There is no `continue-on-error` in this workflow (`EA56-T17`).

Publication is genuinely gated because the deployable tag does not exist until
the assertion passes. The image does reach a `staging-<sha>` tag first; that tag
is not referenced by compose or Swarm, so it cannot be deployed.

`.github/workflows/ci.yml` gains two lines (118–119) so both new suites run on
every CI push.

## 7. Supply-chain policy and the honest chain state

`deploy-gate-policy.json` sets `require_signature: false`, `require_sbom:
false`. This states that A1/A2 (signing) and A6 (SBOM) are **not approved** —
no signing key, no approved signer identity, no SBOM generator exists. The gate
still requires provenance, and when signature/SBOM are not required it records:

- `G3.signature_required_by_policy` → `PARTIAL`, "the identity chain is
  INCOMPLETE by policy, not by defect".
- `G4.identity_chain_complete` → `PARTIAL`, never `PASS`.

So an unsigned image is never reported as a complete identity chain
(`EA56-T21c`), and a policy that demands a signature cannot be satisfied by
silence (`EA56-T21d`).

## 8. Test results

| Suite                                                   | Result                        |
| ------------------------------------------------------- | ----------------------------- |
| `verify-source-origin.test.mjs` (EA56-T1…T8 + 3 guards) | **11/11 PASS**, 0 skipped     |
| `build-identity-gate.test.mjs` (EA56-T9…T25, T27)       | **31/31 PASS**, 0 skipped     |
| Isolated end-to-end (build → assemble → gate)           | **PASS** (synthetic/isolated) |
| Isolated negative control (foreign revision)            | **PASS** — refused, exit 1    |
| `pnpm format:check`                                     | 0                             |
| `pnpm typecheck` (and forced)                           | 0                             |
| `pnpm lint` (and forced)                                | 0                             |
| `pnpm test`                                             | 0 (25/25 tasks)               |
| `pnpm deadcode:check`                                   | 0                             |
| `pnpm build`                                            | 0                             |
| Existing CI host-safeguard scripts                      | 0                             |

Not every matrix row maps to a distinct test id because several rows were
deliberately merged where one assertion proves both (e.g. `T22`/`T23` both
exercise the "readiness cannot rescue a digest mismatch" property).

**EA56-T26 (existing workspace modifications preserved)** is an audit result,
not a unit test: verified by the before/after counts and by confirming only two
deletions exist, both intentional.

## 9. Real-environment evidence status

| Capability                            | Status                                | Why                                                                                                                                           |
| ------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Real CI run of the modified workflows | `NOT RUN`                             | Pushing or dispatching is not authorized in this phase                                                                                        |
| GHCR build, push, digest promotion    | `NOT RUN`                             | Publication is out of scope                                                                                                                   |
| OIDC / Sigstore / Rekor               | `NOT RUN`                             | A1/A2 `NOT FOUND`; no signer                                                                                                                  |
| SBOM generation / verification        | `NOT RUN`                             | A6 `NOT FOUND`; no generator                                                                                                                  |
| Gate 5 against a live Swarm           | `NOT VERIFIED`                        | No platform access from this environment; the logic is proved with a stub `docker` (`T22`–`T22d`)                                             |
| Gate 5 in Dokploy compose mode        | `NOT VERIFIED` — recorded in-workflow | The runner has no running-task access on that path, so the step emits an explicit `::warning::Gate 5 NOT VERIFIED` instead of passing quietly |
| Registry-backed assembler             | `PASS` — synthetic/isolated           | Local registry only (`gate-integration-tests.log`)                                                                                            |

Gate 5 in direct mode is implemented using only capability the deploy job
already has (`docker service inspect`, already used at the pre-existing
target-resolution step). No new credential or permission was added.

## 10. Unresolved risks carried forward

- **Rollback: `FAIL — NO EXECUTABLE ROLLBACK PATH`.** Unchanged. No rollback
  code was written and no rollback was executed. A failed gate now blocks a
  rollout, but there is still no executable path to return a bad rollout.
- **Migration 51: `NOT RUN`.** No pre-check, no execution.
- **Signing and SBOM: `PENDING AUTHORIZATION`.** The chain is knowingly
  incomplete. Until A1/A2/A6 are decided, "identity verified" must not be read
  as "supply chain verified".
- **Provenance revision field.** BuildKit emits no `vcs.revision` for a
  local-path build context, so the assembler uses the recorded
  `build-arg:DEPLOYMENT_VERSION` and records
  `source_revision_field: "build-arg:DEPLOYMENT_VERSION"` so the weaker source
  is auditable. It is only trusted because Step C independently validated the
  same value against the checkout. Adopting a git context would give
  `vcs.revision` directly; that changes build semantics and was not done here.
- **Staging tag residue.** Each build leaves a `staging-<sha>` tag in GHCR. It is
  not deployable, but nothing prunes it yet.
- **Workflow changes are unexecuted.** They are statically validated (YAML
  parse, ordering, no `continue-on-error`) but have not run in Actions. This is
  the largest residual risk in this change.
- **`buildx` on the self-hosted `dokploy` runner.** The deploy job runs on
  `[self-hosted, dokploy]`; the build job (which uses
  `docker/setup-buildx-action`) is on `ubuntu-latest`. The pre-deploy gate needs
  `docker buildx imagetools inspect --raw` to read the index annotations that
  bind provenance to the manifest. If that plugin is absent on the Dokploy
  runner the gate cannot run, so the step now fails with an explicit
  `install docker-buildx-plugin on this runner` error instead of a confusing
  "no attestation manifest". Whether it is present is `NOT VERIFIED` — it
  requires a real deploy run to confirm.

## 11. New files

| File                                                      | Purpose                               |
| --------------------------------------------------------- | ------------------------------------- |
| `scripts/ci/verify-source-origin.mjs`                     | Step C validator                      |
| `scripts/ci/verify-image-identity.mjs`                    | image → verifier adapter              |
| `scripts/ci/verify-build-identity.mjs`                    | EA-53 verifier, reused unchanged      |
| `scripts/ci/deployment-gate.mjs`                          | EA-54 policy engine, reused unchanged |
| `scripts/ci/assemble-gate-candidate.mjs`                  | registry/image → gate candidate       |
| `scripts/ci/promote-verified-image.sh`                    | digest-preserving publication         |
| `scripts/ci/reconcile-running-digest.sh`                  | Gate 5                                |
| `scripts/ci/deploy-gate-policy.json`                      | policy record (A1/A2/A6 unapproved)   |
| `scripts/ci/verify-source-origin.test.mjs`                | Step C tests                          |
| `scripts/ci/build-identity-gate.test.mjs`                 | identity + gate tests                 |
| `docs/evidence/ea56/*`                                    | this evidence bundle                  |
| `docs/ea56-build-identity-and-gate-integration-report.md` | this report                           |

Modified: `.github/workflows/deploy-dev.yml`, `.github/workflows/ci.yml`.
Unchanged: `turbo.json`, `Dockerfile`, all application and database code.

`docs/evidence/ea56/SHA256SUMS` lists every artifact with relative paths and no
self-reference; verify with `cd docs/evidence/ea56 && sha256sum -c SHA256SUMS`.

## 12. Production release state

Every check above is either isolated, static, or a local build. Nothing was
pushed, promoted, deployed or approved. Approval items A1–A8 remain
`NOT FOUND`.

**PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**
