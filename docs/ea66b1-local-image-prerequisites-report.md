# EA-66B.1 — local base image preparation and source identity fix

**Phase type:** prerequisite preparation + source-identity remediation.
**Verdict:** **PREBUILD BLOCKED** — no application image was built.
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. Verdict

| Question                                            | Answer                                                    |
| --------------------------------------------------- | --------------------------------------------------------- |
| Node base image available locally?                  | **NO**                                                    |
| Dockerfile frontend available locally?              | **NO**                                                    |
| Authorized image archive or delivery channel found? | **NO**                                                    |
| Any Docker image pulled?                            | **NO**                                                    |
| Any application image built?                        | **NO**                                                    |
| F-66B-01 source identity defect fixed?              | **YES at the build-entry level; image-side NOT VERIFIED** |
| Temporary Server Action secret test                 | **PASS**                                                  |
| Formal Server Action key                            | **NOT CREATED (not authorized)**                          |
| Build preflight                                     | **PREBUILD BLOCKED**                                      |

EA-66B remains **PREBUILD BLOCKED**. The two missing Docker images are a hard
prerequisite that this phase cannot satisfy without an authorized local archive.

---

## 2. Evidence path note

EA-66B.1's instructions name `docs/evidence/ea661/` and
`docs/ea661-local-image-prerequisites-report.md`. `docs/evidence/ea661/` is the
existing **EA-66A.1** evidence set (31 files with its own `SHA256SUMS`). Writing
into it would invalidate that manifest and mix two phases.

To preserve the completed EA-66A.1 evidence, this phase uses:

- report: `docs/ea66b1-local-image-prerequisites-report.md`
- evidence: `docs/evidence/ea66b1/`

No file under `docs/evidence/ea661/` was changed; its 31/31 checksum verification
still passes.

---

## 3. Repository protection

Recorded before any EA-66B.1 change:

| Item                                | Value                                          |
| ----------------------------------- | ---------------------------------------------- |
| Branch                              | `hse-platform`                                 |
| HEAD                                | `51a899b7aac0a942da327222a3eed355fca9798a`     |
| Staged                              | 0                                              |
| Modified                            | 165                                            |
| Untracked                           | 539                                            |
| `git diff --check`                  | exit 0                                         |
| EA-66A evidence                     | **62/62 verified**                             |
| EA-66A.1 evidence                   | **31/31 verified**                             |
| EA-66B evidence                     | **46/46 verified**                             |
| `.env`                              | present, mode 664, 576 bytes; content not read |
| `turbo.json` / `pnpm-lock.yaml`     | unchanged (`a244a31b…` / `2452cd34…`)          |
| Canonical Compose / Gate 5 Manifest | unchanged (`9700f480…` / `6bc70fa0…`)          |

No reset, clean, restore, checkout, add, commit, push, CI trigger, production
connection, `docker compose up` or deployment was performed.

Several modified files were untracked (`scripts/build-local-image-with-key-gate.sh`,
`scripts/ci/reconcile-compose-digest.sh`,
`scripts/ci/compose-deployment-gate.test.mjs`,
`scripts/ci/build-local-image-key-gate.test.sh`,
`apps/web/src/lib/server-action-key-deployment-contract.test.ts`). Their pre-change
copies were extracted from the EA-66B source archive and are preserved under
`docs/evidence/ea66b1/raw/before/`. No user work was discarded.

---

## 4. Node base image — BLOCKED

Target:

```
node:24.18.0-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5
```

`docker image inspect` returns `No such image` for the digest reference, the tag
and the digest alone. The 66-image local inventory has no `node:*` image.

Searched for image archives (`.tar`, `.tar.gz`, `.tgz`, `.tar.zst`, `.tar.xz`,
`.oci`) under `/home/test`, `/tmp`, `/var/tmp`, `/srv`, `/opt`, `/mnt`, `/media`,
the Downloads directories and the repository. No Docker image archive exists.
`docker context ls` shows only the local default socket; there is no authorized
remote delivery context.

No `docker load`, retag, substitute Node version or pull was performed.

Full detail: `docs/evidence/ea66b1/node-image-import.md`.

---

## 5. Dockerfile frontend — BLOCKED

Target:

```
docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
```

`docker image inspect` returns `No such image` for the digest reference, tag and
digest alone. The local inventory has no `docker/dockerfile:*` image.

`docker buildx du --verbose` contains a 35.76 MB `frontend` cache record "pulled
from docker.io/docker/dockerfile:1.7@sha256:a57df69d…". It is **cache metadata, not
an image**, and was not used as a substitute.

The `# syntax=` line was not removed and no frontend version was switched.

Full detail: `docs/evidence/ea66b1/dockerfile-frontend.md`.

---

## 6. F-66B-01 — source identity binding

### 6.1 Algorithm

```
material =
  "beaconhs-source-deployment-id-v1\n"
  "archive_sha256=<archive sha256>\n"
  "release=<release label>\n"

deployment_id = sha256(material)[0:40]
```

Implementation: `scripts/ci/source-deployment-id.mjs`.

The result is 40 lowercase hex, accepted by `Dockerfile:28` and Next.js. Git
HEAD is **not** part of the derivation; it is recorded in the source manifest as
provenance. Thus:

- same archive + same release → same id;
- archive change → id change;
- HEAD change with the same archive → same id.

Current EA-66B archive `927062b6…` with `release=local` yields:

```
406f0c00d0e42bc1e578acf0e5af86b14bd7e175
```

### 6.2 Build entry changes

`scripts/build-local-image-with-key-gate.sh` now:

1. takes `SOURCE_CONTEXT_ARCHIVE` (default: the EA-66B archive) and supports
   `.tar`, `.tar.gz`, `.tgz`, `.tar.zst`;
2. rejects absolute/traversal paths and archives containing `.env`,
   `.env.orig`, `.env.prod-verify`, `node_modules` or `.git`;
3. extracts the archive and checks the archive file count against the extracted
   count;
4. derives the deployment id and writes `source-manifest.json` with HEAD,
   branch, cleanliness and archive SHA-256;
5. builds from the extracted archive, not the ambient working tree;
6. passes `DEPLOYMENT_VERSION=<deployment id>`;
7. sets image labels `com.beaconhs.deployment-id`,
   `com.beaconhs.source-archive-sha256` and `com.beaconhs.git-head`;
8. verifies those labels and reads the embedded Next.js `deploymentId` back out
   with `verify-image-identity.mjs`;
9. requires `BUILD_EVIDENCE_DIR` for a real build;
10. keeps the Server Action key as a BuildKit secret and scans the build
    log/config/history for it.

`PREPARE_ONLY=1` stops after extraction and identity derivation. A prepare-only
run against the EA-66B archive succeeded and wrote the expected manifest; a real
build without `BUILD_EVIDENCE_DIR` failed closed with exit 2.

### 6.3 Gate 5

`scripts/ci/reconcile-compose-digest.sh` accepts optional
`--source-deployment-id <40-hex>`. When supplied:

- `--deployment-id` must start with `<40-hex>-`;
- the gated image must carry a matching `com.beaconhs.deployment-id` label;
- the value is recorded in the JSON evidence.

Existing invocations remain valid. The formal deployment procedure must pass the
flag. `deploy/gate5.manifest.yaml` and the canonical Compose file were not
modified.

### 6.4 Tests

| Test                                                    | Result                   |
| ------------------------------------------------------- | ------------------------ |
| `source-deployment-id.test.mjs`                         | **10/10 PASS**           |
| `source-identity-wiring.test.mjs`                       | **5/5 PASS**             |
| `build-context-guard.test.mjs`                          | **2/2 PASS**             |
| `compose-deployment-gate.test.mjs` (4 new Gate 5 cases) | **97/97 PASS**           |
| `server-action-key-deployment-contract.test.ts`         | **17/17 PASS**           |
| Prepare-only against the real archive                   | **PASS**, id `406f0c00…` |
| Real build without evidence dir                         | **FAIL CLOSED (exit 2)** |

The wiring and unit tests prove the logic. No image exists, so the image-label and
embedded-`deploymentId` checks have **not** run against a real BeaconHS image.

Full detail: `docs/evidence/ea66b1/source-identity-fix.md`.

---

## 7. Temporary Server Action key test

A throwaway 32-byte key was generated in a private temp directory, used as a
BuildKit secret for a `FROM alpine:3.23` fixture, and deleted. The test proved:

- the key is readable during the build;
- it is absent from the next layer and at runtime;
- it is absent from build stdout/stderr, image config and image history;
- the image label is exact;
- the fixture image and key are removed.

Result: **1/1 PASS**. No formal key was created, printed or stored in evidence.
The full application build remains blocked on an authorized formal key.

Full detail: `docs/evidence/ea66b1/server-action-key-secret-test.md`.

---

## 8. Preflight

| Item                            | Status      |
| ------------------------------- | ----------- |
| Node base image                 | **BLOCKED** |
| Dockerfile frontend             | **BLOCKED** |
| BuildKit 0.34.0 / Buildx 0.38.1 | PASS        |
| Source archive + SHA-256        | PASS        |
| Deployment id derivation        | PASS        |
| Source manifest                 | PASS        |
| Archive guard tests             | PASS        |
| Build-context extraction        | PASS        |
| Server Action secret mechanism  | PASS        |
| Formal Server Action key        | **BLOCKED** |
| Disk space 67 G                 | PASS        |
| `linux/amd64`                   | PASS        |
| Formal image build              | **NOT RUN** |

**PREBUILD BLOCKED** because the first two prerequisites are missing.

Full detail: `docs/evidence/ea66b1/prebuild-check.md`.

---

## 9. Repository gates

| Gate                                          | Result         | Cached   |
| --------------------------------------------- | -------------- | -------- |
| `pnpm format:check`                           | exit 0         | n/a      |
| `pnpm typecheck --force`                      | exit 0 — 27/27 | 0 cached |
| `pnpm lint --force`                           | exit 0 — 1/1   | 0 cached |
| `pnpm deadcode:check`                         | exit 0         | n/a      |
| `pnpm turbo run test --force --concurrency=1` | exit 0 — 25/25 | 0 cached |
| `pnpm build --force`                          | exit 0 — 4/4   | 0 cached |
| `git diff --check`                            | exit 0         | n/a      |

The full key-gate shell acceptance test was not run locally because its success
path needs the missing Node base/frontend. Its failure-path subset passed 4/4;
the success path is **NOT RUN**.

---

## 10. Changed files

| File                                                             | Change                                                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `scripts/build-local-image-with-key-gate.sh`                     | archive-derived deployment id; extract/build from archive; labels; identity verification; evidence dir; key scan |
| `scripts/ci/source-deployment-id.mjs`                            | **new** deterministic id helper                                                                                  |
| `scripts/ci/source-deployment-id.test.mjs`                       | **new** 10 tests                                                                                                 |
| `scripts/ci/source-identity-wiring.test.mjs`                     | **new** 5 wiring tests                                                                                           |
| `scripts/ci/build-context-guard.test.mjs`                        | **new** 2 archive-guard tests                                                                                    |
| `scripts/ci/buildkit-secret-isolation.test.mjs`                  | **new** secret-isolation test                                                                                    |
| `scripts/ci/reconcile-compose-digest.sh`                         | optional `--source-deployment-id` and gated image-label check                                                    |
| `scripts/ci/compose-deployment-gate.test.mjs`                    | 4 new Gate 5 cases                                                                                               |
| `scripts/ci/build-local-image-key-gate.test.sh`                  | creates a source archive and evidence dir for the test                                                           |
| `apps/web/src/lib/server-action-key-deployment-contract.test.ts` | pins the new private build directory/log                                                                         |
| `knip.ts`                                                        | registers the new helper entry                                                                                   |
| `docs/project-development-state.md`                              | EA-66B.1 addendum                                                                                                |

No business code, Dockerfile, `.dockerignore`, `turbo.json`, `pnpm-lock.yaml`,
canonical Compose, Gate 5 Manifest, workflow or `.env` was changed.

Before/after hashes are in `docs/evidence/ea66b1/source-identity-fix.md` and
`raw/before-after-hashes.txt`.

---

## 11. Remaining work

1. Supply authorized local archives for the exact Node base and Dockerfile
   frontend; `docker load` and verify image ID/RepoDigest/platform/Node version.
2. Authorize a formal Server Action key, or explicitly authorize a non-release
   test-key build.
3. Commit the existing working-tree `turbo.json` `DEPLOYMENT_VERSION` declaration
   before CI builds; otherwise the new image-identity verifier fails closed.
4. Run the full key-gate shell acceptance test in an environment with the base
   images.
5. Re-run the preflight, then build one `linux/amd64` application image from the
   archive with `BUILD_EVIDENCE_DIR` set.
6. Read back and record image ID, platform, deploymentId, labels, digests, key
   fingerprint, build log and SBOM.
7. Run Gate 5 with `--source-deployment-id`.
8. EA-66C packaging only after a successful build and identity verification.

---

## 12. State ledger

| Item                                | Status                                                              |
| ----------------------------------- | ------------------------------------------------------------------- |
| EA-66A                              | **PARTIAL** — preserved                                             |
| EA-66A.1                            | **COMPLETE** — preserved                                            |
| EA-66B                              | **PREBUILD BLOCKED**                                                |
| EA-66B.1                            | **BLOCKED on image prerequisites; source-identity fix implemented** |
| GHCR as deployment source           | **NOT USED**                                                        |
| External Docker image pull          | **PROHIBITED**                                                      |
| Online tool/dependency installation | **ALLOWED** — not used                                              |
| Production                          | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**                   |
| Rollback                            | **FAIL — NO EXECUTABLE ROLLBACK PATH**                              |
| A1–A8                               | **PENDING AUTHORIZATION**                                           |
| Migration 51                        | **NOT RUN**                                                         |
| DB / Object Storage restore         | **NOT RUN**                                                         |
| WOPI                                | **PAUSED**                                                          |

---

## 13. Evidence index

| File                               | Contents                                           |
| ---------------------------------- | -------------------------------------------------- |
| `environment-inventory.md`         | host/tool/image state                              |
| `node-image-import.md`             | Node base search and BLOCKED decision              |
| `dockerfile-frontend.md`           | frontend search and BLOCKED decision               |
| `source-identity-fix.md`           | F-66B-01 algorithm, script changes, tests, hashes  |
| `server-action-key-secret-test.md` | temp-key BuildKit secret proof                     |
| `prebuild-check.md`                | item-by-item preflight                             |
| `raw/before/`                      | pre-change copies of the untracked files           |
| `raw/`                             | baseline, searches, tests, prepare runs, gate logs |
| `SHA256SUMS`                       | hashes of every evidence file except itself        |

Verify:

```bash
cd docs/evidence/ea66b1 && sha256sum -c SHA256SUMS
```
