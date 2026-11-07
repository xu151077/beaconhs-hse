# EA-66B — BeaconHS local application image build and identity verification

**Phase type:** local build capability verification.
**Verdict:** **PREBUILD BLOCKED** — no image was built.
**Reason:** the two images required by `Dockerfile` are absent locally and
pulling them is prohibited in this phase.
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. Verdict

| Question                                               | Answer                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| Was a build executed?                                  | **NO**                                                                    |
| Did the build succeed?                                 | **NO — not attempted**                                                    |
| Was any Docker image pulled?                           | **NO**                                                                    |
| Were BuildKit cache records used as images?            | **NO**                                                                    |
| Were local base images available?                      | **NO** — Node base and Dockerfile frontend missing                        |
| Were normal build tools/dependencies installed online? | **NO** — stopped before that stage                                        |
| Is `deploymentId` correct?                             | **NOT VERIFIED** — no image; mechanism has an open dirty-worktree finding |
| Is the source identity verifiable?                     | **PARTIAL** — deterministic source archive exists; no image to bind it to |
| Was an SBOM generated?                                 | **NO**                                                                    |
| Was a Server Action key leaked?                        | **NO artifact exists**; no formal key was created                         |
| Were the workspace changes preserved?                  | **YES**                                                                   |

EA-66B cannot be marked COMPLETE. It is **BLOCKED** at the local image
prerequisite gate, before any build, package, SBOM or Gate 5 step.

**EA-66B stops here. EA-66C is not started.**

---

## 2. Repository protection

Recorded before any EA-66B artifact was written
(`docs/evidence/ea66b/raw/baseline.txt`):

| Item                                   | Value                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------ |
| Branch                                 | `hse-platform`                                                           |
| HEAD                                   | `51a899b7aac0a942da327222a3eed355fca9798a`                               |
| Staged                                 | 0                                                                        |
| Modified                               | 165                                                                      |
| Untracked                              | 538                                                                      |
| `git diff --check`                     | exit 0                                                                   |
| EA-66A evidence                        | **62/62 verified**                                                       |
| EA-66A.1 evidence                      | **31/31 verified**                                                       |
| `.env`                                 | present, mode 664, owner `test:docker`, 576 bytes — **content not read** |
| `turbo.json`                           | `a244a31b…` — unchanged                                                  |
| `pnpm-lock.yaml`                       | `2452cd34…` — unchanged                                                  |
| `Dockerfile`                           | `763b5d10…` — unchanged                                                  |
| `.dockerignore`                        | `6c71acd1…` — unchanged                                                  |
| `deploy/local-production.compose.yaml` | `9700f480…` — unchanged                                                  |
| `deploy/gate5.manifest.yaml`           | `6bc70fa0…` — unchanged                                                  |
| `.github/workflows/deploy-dev.yml`     | `7ce5554b…` — unchanged                                                  |

No `git reset`, `clean`, `restore`, `checkout` or `add -A` was used. No commit,
push, CI trigger, production connection, `docker compose up`, `docker save` or
deployment was performed. No business code, Dockerfile, Compose file, manifest,
lockfile or `.env` was modified. Only `docs/evidence/ea66b/` and the report were
added.

---

## 3. Local image prerequisites — the blocker

`Dockerfile` references:

```dockerfile
# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG NODE_IMAGE_DIGEST=sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5
FROM node:24.18.0-bookworm-slim@${NODE_IMAGE_DIGEST} AS base
```

| Dependency                                                                                           | Purpose                    | Local? | Status                     |
| ---------------------------------------------------------------------------------------------------- | -------------------------- | ------ | -------------------------- |
| `node:24.18.0-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5` | all build/runtime stages   | **NO** | **BLOCKED**                |
| `docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e`      | Dockerfile frontend        | **NO** | **BLOCKED**                |
| Debian bookworm userspace                                                                            | inside the Node base image | **NO** | **BLOCKED** (part of base) |

`docker image inspect` returns `No such image` for both the digest-qualified and
tag-only forms. The 66-image local inventory contains no `node:*`, `debian:*` or
`docker/dockerfile:*` image. `Dockerfile.test` uses the same missing references;
it is not the production image target.

### 3.1 BuildKit cache is not image presence

`docker buildx du` contains historical `pulled from …` records for both images,
including a 35.76 MB `frontend` record used 5 hours ago. These are cache
metadata, not local images. They cannot satisfy `FROM`, and EA-66B forbids
substituting them for images. No cache workaround was attempted.

### 3.2 Why no workaround was used

- No suitable local Node image exists; retagging another image would forge
  identity.
- Deleting the `# syntax=` line would modify an untested Dockerfile and still
  leave the base image missing.
- Pulling is explicitly prohibited.
- Importing from another host was not authorized and no image archive was
  supplied.

Per the phase rule, the formal build stopped and the phase is **PREBUILD
BLOCKED**.

Full detail: `docs/evidence/ea66b/local-image-prerequisites.md`.

---

## 4. Build dependency preparation

No software was installed. The host already has Docker 29.9.2, Compose 5.6.1,
Buildx 0.38.1, BuildKit 0.34.0, Node 24.21.0, pnpm 10.30.3, corepack 0.36.0, Git
2.43.0, jq 1.7, rsync 3.2.7, zstd 1.5.5, tar 1.35 and Python 3.12.3.

`yq` and `shellcheck` are **not installed**; neither was needed for the blocked
phase.

The Dockerfile would install, in a real build:

- corepack 0.35.0 and pnpm 10.30.3 in the base stage;
- npm dependencies with `pnpm install --frozen-lockfile`;
- Debian bookworm apt packages, LibreOffice Impress/Writer, poppler-utils and
  headless-browser libraries in the runner stage;
- `chrome-headless-shell@140.0.7339.207` via `npx @puppeteer/browsers@3.0.6`.

None of these steps ran. A future build must record resolved apt versions, the
Chrome archive source and checksum, and the install log.

Full detail: `docs/evidence/ea66b/build-dependency-preparation.md`.

---

## 5. pnpm store integrity

```bash
pnpm store status   # exit 1
```

Four packages are flagged:

- `eslint-import-resolver-typescript@3.10.1`
- `eslint-module-utils@2.13.0`
- `eslint-plugin-import@2.32.0`
- `pagedjs@0.4.3` (patch hash `633a3606…`)

A read-only file-level comparison against the store indexes found:

- the three eslint packages have **zero** indexed-file mismatches; the only
  extras are pnpm peer-dependency `.bin` shims (`eslint`, `semver`), which the
  status check treats as extra files;
- `pagedjs` has **one** mismatch: `package.json` is 2,959 bytes instead of
  2,949. The 10-byte difference is exactly the intended patch that changes
  `exports.import`/`exports.default` from `./src/index.js` to
  `./dist/paged.esm.js`; the patch file hash matches the virtual-store
  `patch_hash`. The other 97 files match.

The store was **not** cleaned, pruned or reinstalled. No `pnpm install --force`
was run; no dependency was upgraded; the lockfile was not edited. The four flags
are explained, but `pnpm store status` still exits 1 and is recorded as an
unresolved environment condition for the next build.

Full detail: `docs/evidence/ea66b/pnpm-store-integrity.md`.

---

## 6. Source identity

The working tree is not HEAD. HEAD alone cannot represent the source.

| Item                          | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| Branch / HEAD                 | `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`        |
| Modified / untracked / staged | 165 / 538 / 0                                                      |
| `git diff HEAD` SHA-256       | `e740047346b310e47325fb3e8852c4befbaeba23b9ac61fbb16d47d47711e896` |
| `git status --short` SHA-256  | `0c60f0c923f3b9907bc0971dab0ec3ce64d679980ce2db86c02dc20bc1e7b41c` |
| Source archive                | `docs/evidence/ea66b/source/source-context.tar.zst`                |
| Archive SHA-256               | `927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9` |
| Archive size / entries        | 22,156,840 bytes (21.1 MiB) / 4,544                                |
| File-list SHA-256             | `b714d665b463cd476028cb0d5753d7adcc16758e4dd1152d908b4b5c691a02c7` |
| Lockfile                      | `2452cd3453162896e651017c2bce5e170868ef5c1f2675efc8f05280fdb46680` |
| Dockerfile                    | `763b5d10e3feb26575a027adbdf770d5b181bc5f2f7448d5dcdf4c1be1c0b5c3` |
| `.dockerignore`               | `6c71acd1dc2282db3b832ae6ec84d2f8fbe6e88d5f2a51694f81e790a249e787` |

The archive is deterministic (`--sort=name`, fixed mtime, owner/group 0) and
filters the tree with `.dockerignore`. It excludes this phase's own evidence
directory and nested Playwright/test output, includes `.env.example`, and
excludes `.env`, `.env.orig` and `.env.prod-verify`. No application source was
excluded.

### 6.1 Finding F-66B-01 — deploymentId vs. dirty worktree

**OPEN.** `apps/web/next.config.ts:19` sets `deploymentId` from
`process.env.DEPLOYMENT_VERSION`. The Dockerfile requires a 40-hex value. The
local build entry passes `$(git rev-parse HEAD)`.

With 165 modified and 538 untracked entries, that would embed `51a899b7…` while
the actual source is the dirty worktree whose archive is `927062b6…`. The image
would claim a revision it was not built from — the EA-16 defect class. This is
pre-existing build-entry behaviour, not introduced by EA-66B, but it prevents a
truthful source-identity claim.

A future build needs one of: a clean checkout at the exact commit; a reviewed
40-hex source-archive-derived deploymentId with a recorded mapping; or a
fail-closed refusal to build a dirty tree. This was not changed in a blocked
phase without an end-to-end build to test it.

Full detail: `docs/evidence/ea66b/source-identity.md`.

---

## 7. Build context audit

`.dockerignore` is unchanged. It correctly excludes `.git`, `.github`,
`node_modules`, build outputs, `.env`, private tooling, `packages/etl`,
credentials-bearing scripts, backups and test output. It does **not** exclude:

| Path                                        | Size       | Needed? |
| ------------------------------------------- | ---------- | ------- |
| `docs/evidence`                             | **63 MB**  | no      |
| `.playwright-mcp`                           | **4.8 MB** | no      |
| `.tmp-cf`, `.tmp-cj`, `.tmp-ck`, `.tmp-e2e` | ~108 KB    | no      |
| `.scratchpad`                               | small      | no      |

These are in the real Docker context. A future build should add `docs/evidence`,
`.playwright-mcp`, `.tmp-*` and `.scratchpad` to `.dockerignore`, then prove with
a build that no runtime asset was removed. The change was **not applied** here
because it alters the context hash and cannot be validated while the build is
blocked.

Full detail: `docs/evidence/ea66b/build-context-audit.md`.

---

## 8. Server Action key

The design from EA-66A.1 is verified against the installed Next.js 16.3.5:

```js
process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY || serverActionsManifest.encryptionKey
```

- The build key is embedded in the server-reference manifest.
- The runtime and build keys must be the same, and all web replicas must share
  one key.
- `Dockerfile:49` mounts the key as a required BuildKit secret; there is no key
  `ENV`, no key build-arg, and only the 32-hex HMAC fingerprint is a build-arg.
- `scripts/build-local-image-with-key-gate.sh` requires a mode-600 key file
  outside the repository, keeps the build log private, and verifies the embedded
  key through `scripts/ci/verify-server-action-key-gate.sh image`.
- `deploy/local-production.compose.yaml:119` requires the runtime override and
  states it must match the build-time key.

Current state:

| Item                              | Status                  |
| --------------------------------- | ----------------------- |
| `/tmp/beaconhs-server-action-key` | **MISSING**             |
| Formal key generated              | **NO — not authorized** |
| Temporary key used in EA-66B      | **NO**                  |
| Key printed / stored in evidence  | **NO**                  |
| Key handling tests                | **6/6 PASS**            |
| Image key fingerprint read-back   | **NOT RUN**             |

The formal build is also blocked by the key gate: even with the base images, the
script exits 2 before `docker build` when the key file is absent. No throwaway
key was created because no build could proceed, and a test image must not be
mistaken for a release candidate.

Full detail: `docs/evidence/ea66b/server-action-key-verification.md`.

---

## 9. Prebuild gate result

| Gate                         | Result                                                |
| ---------------------------- | ----------------------------------------------------- |
| All `FROM` images local      | **FAIL** — Node base and frontend missing             |
| Frontend will not pull       | **FAIL** — image missing                              |
| Builder will not pull        | **FAIL** — default builder would resolve missing refs |
| Lockfile unchanged           | PASS                                                  |
| Context traceable            | PASS                                                  |
| Key injection path verified  | **PARTIAL** — static/tests pass; formal key missing   |
| deploymentId mechanism clear | **PARTIAL** — mechanism known; F-66B-01 open          |
| Target `linux/amd64`         | PASS                                                  |
| Disk space                   | PASS — 67 G free                                      |
| No formal deployment running | PASS — only the local `beaconhs-dev` stack            |

**Result: PREBUILD BLOCKED.** No build command was issued.

---

## 10. Build results and image identity

No build log, image reference, image ID, OS/architecture, size, creation time,
`deploymentId`, config digest or manifest digest exists. The only Docker builds
in this phase were two `FROM scratch` fixtures in
`scripts/ci/build-identity-gate.test.mjs`, removed by the tests; they are not the
application image and pulled nothing.

All ten identity checks in EA-66B §10 are **NOT VERIFIED**, except the
static design fact that one image is intended for all four gated roles.

Gate 5 was **NOT RUN**: there is no image digest or rendered Compose label set
to compare against `deploy/gate5.manifest.yaml`.

Full detail:

- `docs/evidence/ea66b/build-results.md`
- `docs/evidence/ea66b/image-identity-verification.md`

---

## 11. SBOM and provenance

**No SBOM, build-info, source manifest or image manifest was generated.**
`syft`, `trivy`, `grype`, `cosign` and `docker-scout` are not installed, and
there is no image to scan. `pnpm-lock.yaml` is not an SBOM: it omits apt
packages, LibreOffice, poppler, Chrome and base-image libraries.

Signature status: **NOT SIGNED**. No provenance or supply-chain completeness is
claimed.

Full detail: `docs/evidence/ea66b/sbom/NOT-GENERATED.md`.

---

## 12. Completion criteria

| #   | Criterion                                | Status                                                                                        |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | No external Docker image pull            | **PASS**                                                                                      |
| 2   | Local base images verified               | **FAIL / BLOCKED**                                                                            |
| 3   | Build context has a clear SHA-256        | **PASS** — `927062b6…`                                                                        |
| 4   | Dependency versions and sources recorded | **PARTIAL** — host tools recorded; build deps not installed; store flags explained but exit 1 |
| 5   | Build succeeded                          | **NOT RUN**                                                                                   |
| 6   | Image platform correct                   | **NOT VERIFIED**                                                                              |
| 7   | deploymentId correct                     | **NOT VERIFIED**; F-66B-01 open                                                               |
| 8   | Source identity has a verifiable link    | **PARTIAL** — archive exists, no image link                                                   |
| 9   | Server Action key not leaked             | **PASS for this phase** — no build, no key; image check NOT RUN                               |
| 10  | SBOM generated                           | **NO**                                                                                        |
| 11  | build-info complete                      | **NO**                                                                                        |
| 12  | Image ID recorded                        | **NO**                                                                                        |
| 13  | Gate 5 image identity contract passed    | **NOT RUN**                                                                                   |
| 14  | All evidence SHA-256 pass                | **YES** — see `SHA256SUMS`                                                                    |
| 15  | Existing workspace changes preserved     | **PASS**                                                                                      |

Because criteria 2, 5, 6, 7, 10, 11, 12 and 13 are unmet, EA-66B is **BLOCKED**,
not PARTIAL: the phase did not reach a build that could be partially verified.

### 12.1 Repository gates

EA-66B changed documentation and evidence only. The code gates were still run:

| Gate                                          | Result             | Cached                     |
| --------------------------------------------- | ------------------ | -------------------------- |
| `pnpm format:check`                           | **exit 0**         | n/a                        |
| `pnpm typecheck`                              | **exit 0** — 27/27 | 27 cached (no code change) |
| `pnpm lint`                                   | **exit 0** — 1/1   | 1 cached (no code change)  |
| `pnpm deadcode:check`                         | **exit 0**         | n/a                        |
| `pnpm turbo run test --force --concurrency=1` | **exit 0** — 25/25 | **0 cached**               |
| `pnpm build --force`                          | **exit 0** — 4/4   | **0 cached**               |
| `git diff --check`                            | **exit 0**         | n/a                        |

The forced test run executed `scripts/ci/build-identity-gate.test.mjs`
(**31/31 PASS**) and `scripts/ci/server-action-key-handling.test.mjs`
(**6/6 PASS**). Raw logs: `docs/evidence/ea66b/raw/gates/`.

---

## 13. No-pull statement

No Docker image was obtained from any registry in EA-66B. No `docker pull`,
`docker compose pull`, `docker build` (application), `docker buildx build`
(application), `skopeo copy`, `crane pull`, registry proxy or implicit
`FROM`/frontend/builder pull occurred. `docker manifest inspect` was not used in
this phase. The local image count remained 66 before and after.

The only registry-adjacent evidence in the wider repository is EA-66A.1's
read-only `docker manifest inspect` for Collabora metadata, which does not pull
an image and is historical, not part of EA-66B.

---

## 14. Remaining work / next attempt

1. Make the exact `node:24.18.0-bookworm-slim@sha256:cb4e8f7c…` image available
   locally by an approved import, and verify its `RepoDigest`.
2. Make the exact `docker/dockerfile:1.7@sha256:a57df69d…` frontend available
   locally, or approve and test removing the external frontend.
3. Authorize a formal Server Action key (or an explicit test-key exception for a
   non-release build) and place it in a mode-600 file outside the repository.
4. Resolve F-66B-01: build from a clean checkout, or derive a truthful
   deploymentId from the source archive and record the mapping.
5. Apply the `.dockerignore` reductions and validate them with a real build.
6. Re-run the prerequisite gate, then build one `linux/amd64` application image
   shared by `web`, `worker`, `scheduler` and `storage-init`.
7. Read back and record the image ID, platform, size, `deploymentId`, labels,
   config digest, manifest digest, key fingerprint and build log SHA-256.
8. Generate the SBOM and build/source/image manifests; run Gate 5.
9. Only then consider EA-66C packaging. Do not package PostgreSQL, Redis, MinIO
   or Collabora in this phase.

---

## 15. Changed files

| File                                                | Change                                  |
| --------------------------------------------------- | --------------------------------------- |
| `docs/ea66b-local-image-build-report.md`            | new report                              |
| `docs/evidence/ea66b/**`                            | new evidence set                        |
| `docs/evidence/ea66b/source/source-context.tar.zst` | new source-context archive, `927062b6…` |

No application code, Dockerfile, `.dockerignore`, `turbo.json`,
`pnpm-lock.yaml`, Compose file, manifest, workflow, `.env` or Server Action key
file was changed.

---

## 16. State ledger

| Item                                | Status                                               |
| ----------------------------------- | ---------------------------------------------------- |
| EA-66A                              | **PARTIAL** — preserved                              |
| EA-66A.1                            | **COMPLETE** for its three P0 items — preserved      |
| EA-66B                              | **PREBUILD BLOCKED**                                 |
| GHCR as deployment source           | **NOT USED**                                         |
| External Docker image pull          | **PROHIBITED**                                       |
| Online tool/dependency installation | **ALLOWED** — not used in this phase                 |
| Runtime image package               | Only the five canonical runtime images (later phase) |
| Real Ubuntu production deployment   | **NOT VERIFIED**                                     |
| Production                          | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**    |
| Rollback                            | **FAIL — NO EXECUTABLE ROLLBACK PATH**               |
| A1–A8                               | **PENDING AUTHORIZATION**                            |
| Migration 51                        | **NOT RUN**                                          |
| DB / Object Storage restore         | **NOT RUN**                                          |
| WOPI                                | **PAUSED**                                           |

---

## 17. Evidence index

| File                                | Contents                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| `environment-inventory.md`          | host, Docker/Buildx/BuildKit, tools, local state                 |
| `local-image-prerequisites.md`      | exact missing image refs, cache-vs-image analysis, stop decision |
| `build-dependency-preparation.md`   | host tools, Dockerfile install steps, Chrome/apt, no installs    |
| `pnpm-store-integrity.md`           | four flagged packages and file-level comparison                  |
| `source-identity.md`                | HEAD/dirty state, archive hash, deploymentId mechanism, F-66B-01 |
| `build-context-audit.md`            | `.dockerignore` review, context size, recommended exclusions     |
| `server-action-key-verification.md` | Next.js 16.3.5 semantics, secret path, tests, missing key        |
| `build-results.md`                  | prebuild gate, no build, absent records                          |
| `image-identity-verification.md`    | ten identity checks, all unavailable                             |
| `test-results.md`                   | focused tests, repository gates, what was not run                |
| `sbom/NOT-GENERATED.md`             | why no SBOM exists                                               |
| `build-logs/prebuild-blocked.md`    | no-log statement and next-attempt requirements                   |
| `source/source-context.tar.zst`     | deterministic source archive                                     |
| `source/source-context.list`        | archive file list                                                |
| `raw/`                              | raw command output and logs                                      |
| `SHA256SUMS`                        | hashes of every evidence file except itself                      |

Verify:

```bash
cd docs/evidence/ea66b && sha256sum -c SHA256SUMS
```
