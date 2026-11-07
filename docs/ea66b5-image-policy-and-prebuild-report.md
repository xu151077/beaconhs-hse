# EA-66B.5 — image acquisition policy adjustment and EA-66C prebuild preparation

**Phase type:** policy adjustment, image verification and prebuild preparation.
**Verdict:** **IMAGE PREREQUISITES READY; FORMAL BUILD BLOCKED ON KEY.**
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. Verdict

| Question                       | Answer                                                             |
| ------------------------------ | ------------------------------------------------------------------ |
| MinIO policy                   | **Local only** — no pull                                           |
| MinIO local image              | **VERIFIED** against canonical digest                              |
| PostgreSQL                     | **VERIFIED** (already local, exact digest)                         |
| Redis                          | **VERIFIED** (already local, exact digest)                         |
| Collabora                      | **VERIFIED** (already local, exact digest)                         |
| Node 24.18.0 bookworm-slim     | **VERIFIED** after authorized pull                                 |
| Dockerfile frontend 1.7        | **VERIFIED** after authorized pull                                 |
| Source archive                 | **VERIFIED** — SHA-256 `927062b6…`                                 |
| Deployment id                  | **VERIFIED** — `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`          |
| Build script guards            | **PASS**                                                           |
| Server Action secret mechanism | **PASS**                                                           |
| Formal Server Action key       | **BLOCKED** — `/tmp/beaconhs-server-action-key` missing            |
| Formal application image build | **NOT RUN**                                                        |
| EA-66C readiness               | **READY for image-build preparation; not authorized to build yet** |

EA-66B remains **PREBUILD BLOCKED** because no application image has been built or
identity-verified. EA-66C is not started.

---

## 2. Repository protection

Recorded before any EA-66B.5 artifact was written:

| Item               | Value                                          |
| ------------------ | ---------------------------------------------- |
| Branch             | `hse-platform`                                 |
| HEAD               | `51a899b7aac0a942da327222a3eed355fca9798a`     |
| Staged             | 0                                              |
| Modified           | 165                                            |
| Untracked          | 547                                            |
| `git diff --check` | exit 0                                         |
| EA-66A evidence    | 62/62 verified                                 |
| EA-66A.1 evidence  | 31/31 verified                                 |
| EA-66B evidence    | 46/46 verified                                 |
| EA-66B.1 evidence  | 39/39 verified                                 |
| EA-66B.2 evidence  | 29/29 verified                                 |
| EA-66B.3 evidence  | 15/15 verified                                 |
| `.env`             | present, mode 664, 576 bytes; content not read |

No repository file was changed by EA-66B.5. Only `docs/ea66b5-image-policy-and-prebuild-report.md`
and `docs/evidence/ea66b5/` were added. No protected file was modified.

---

## 3. Image acquisition policy

| Image                      | Policy                          |
| -------------------------- | ------------------------------- |
| BeaconHS application image | Local source build only         |
| PostgreSQL                 | Online pull allowed             |
| Redis                      | Online pull allowed             |
| MinIO                      | **Local only** — no online pull |
| Collabora                  | Online pull allowed             |
| Node 24.18.0 bookworm-slim | Online pull allowed             |
| Dockerfile frontend 1.7    | Online acquisition allowed      |
| Other build dependencies   | Online installation allowed     |

Rules applied:

- MinIO is the only image that must not be pulled. It was already present locally
  and was verified against the canonical digest.
- Allowed images were pulled only with their exact configured digest and
  `--platform linux/amd64`.
- No floating `latest` tag was introduced as a formal reference.
- PostgreSQL, Redis and Collabora were already present locally with the exact
  configured digest; they were verified and **not** pulled.
- Mailpit, Registry, Python/AJ Gateway, CI-only images and other non-runtime
  images were not pulled.

---

## 4. MinIO verification — VERIFIED

MinIO is the only image that must not be pulled. It was already present locally
and matches the canonical Compose and Gate 5 Manifest.

| Item                               | Value                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Canonical Compose                  | `minio/minio@sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c`     |
| Gate 5 Manifest                    | `minio/minio` + `sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c` |
| Local image ID                     | `sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c`                 |
| RepoDigests                        | `minio/minio@sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c`     |
| OS / architecture                  | `linux` / `amd64`                                                                         |
| Created                            | 2026-09-29T15:41:05.619886824+08:00                                                       |
| Size                               | 268,771,790 bytes                                                                         |
| Running container `beaconhs-minio` | image ID `sha256:b187417eee0a…`, config image `minio/minio:latest`                        |

The running container uses the same image ID as the canonical digest. No
`docker pull`, `docker compose pull`, image replacement, volume change or
container restart was performed.

Full detail: `docs/evidence/ea66b5/minio-verification.md`.

---

## 5. Runtime and build image verification

All images were verified by `docker image inspect` using their exact digest
reference.

| Image               | Reference                                     | Image ID           | OS / Arch   | Created              | Size          | Status            |
| ------------------- | --------------------------------------------- | ------------------ | ----------- | -------------------- | ------------- | ----------------- |
| Node base           | `node:24.18.0-bookworm-slim@sha256:cb4e8f7c…` | `sha256:cb4e8f7c…` | linux/amd64 | 2026-06-24T18:12:30Z | 325,774,884   | VERIFIED (pulled) |
| Dockerfile frontend | `docker/dockerfile:1.7@sha256:a57df69d…`      | `sha256:a57df69d…` | linux/amd64 | 2024-04-25T17:57:11Z | 35,764,644    | VERIFIED (pulled) |
| PostgreSQL          | `postgres@sha256:721873c3…`                   | `sha256:721873c3…` | linux/amd64 | 2026-09-17T21:31:24Z | 419,072,015   | VERIFIED (local)  |
| Redis               | `redis@sha256:858f009f…`                      | `sha256:858f009f…` | linux/amd64 | 2026-09-17T21:32:46Z | 57,300,241    | VERIFIED (local)  |
| Collabora           | `collabora/code@sha256:4e983196…`             | `sha256:4e983196…` | linux/amd64 | 2026-09-24T07:13:22Z | 1,842,964,014 | VERIFIED (local)  |
| MinIO               | `minio/minio@sha256:b187417e…`                | `sha256:b187417e…` | linux/amd64 | 2026-09-29T15:41:05Z | 268,771,790   | VERIFIED (local)  |

Node verification:

```bash
docker run --rm --platform linux/amd64 node:24.18.0-bookworm-slim@sha256:cb4e8f7c… node --version
# v24.18.0
```

The frontend image is a BuildKit frontend; running it standalone is not a
validity test. Its identity is verified by digest, config and platform.

Full detail: `docs/evidence/ea66b5/runtime-image-verification.md`.

---

## 6. Source and build readiness

- Source archive: `docs/evidence/ea66b/source/source-context.tar.zst`
  - SHA-256: `927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9`
  - entries: 4,544
  - uncompressed: 22,156,840 bytes
- Git HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Deployment id: `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`
- Prepare-only run: PASS, wrote `source-manifest.json` with HEAD, branch,
  cleanliness and archive SHA-256.
- Build script guards: `bash -n` PASS; missing key exits 2; invalid key exits 2
  before build; `.env` archive exits 2; missing Dockerfile exits 2; real build
  without `BUILD_EVIDENCE_DIR` exits 2.
- Server Action secret mechanism: isolated `FROM alpine:3.23` fixture, 1/1 PASS.
- Formal Server Action key: **BLOCKED** — `/tmp/beaconhs-server-action-key` is
  missing.

Full detail: `docs/evidence/ea66b5/source-build-readiness.md`.

---

## 7. Unauthorized pull disclosure

During EA-66B.2 verification, `docker build --check` caused BuildKit to download
`docker/dockerfile:1.8.1@sha256:e87caa74dcb7d46cd820352bfea12591f3dba3ddc4285e19c7dcd13359f7cefd`
into the build cache. This was an unauthorized pull of a non-target frontend.
No image was created and the image count remained 66, but the pull violated the
no-pull rule. The cache record remains; no prune was performed. The log is
`docs/evidence/ea66b2/raw/dockerfile-check.txt`.

EA-66B.5 did not repeat this. All pulls in EA-66B.5 were authorized and used
exact digests with `--platform linux/amd64`.

---

## 8. Repository gates

EA-66B.5 changed documentation and evidence only. No code was changed. The last
full gate run remains EA-66B.1:

| Gate                                          | Result                      |
| --------------------------------------------- | --------------------------- |
| `pnpm format:check`                           | exit 0                      |
| `pnpm typecheck --force`                      | exit 0 — 27/27, `Cached: 0` |
| `pnpm lint --force`                           | exit 0 — 1/1, `Cached: 0`   |
| `pnpm deadcode:check`                         | exit 0                      |
| `pnpm turbo run test --force --concurrency=1` | exit 0 — 25/25, `Cached: 0` |
| `pnpm build --force`                          | exit 0 — 4/4, `Cached: 0`   |
| `git diff --check`                            | exit 0                      |

Focused tests:

- `source-deployment-id.test.mjs`: **10/10 PASS**
- `source-identity-wiring.test.mjs`: **5/5 PASS**
- `build-context-guard.test.mjs`: **2/2 PASS**
- `buildkit-secret-isolation.test.mjs`: **1/1 PASS**
- `compose-deployment-gate.test.mjs`: **97/97 PASS**
- `server-action-key-handling.test.mjs`: **6/6 PASS**
- `build-identity-gate.test.mjs`: **31/31 PASS**
- `server-action-key-deployment-contract.test.ts`: **17/17 PASS**

---

## 9. Changed files

No source code, Dockerfile, `.dockerignore`, `turbo.json`, `pnpm-lock.yaml`,
canonical Compose, Gate 5 Manifest, workflow or `.env` was changed. Only the
report and `docs/evidence/ea66b5/` were added.

---

## 10. Remaining work

1. Provision an authorized formal Server Action key, or explicitly authorize a
   non-release test-key build.
2. Re-run the full key-gate shell acceptance test in an environment with the
   base images.
3. Build one `linux/amd64` application image from the verified archive with
   `BUILD_EVIDENCE_DIR` set.
4. Read back and record image ID, platform, deploymentId, labels, digests, key
   fingerprint, build log and SBOM.
5. Run Gate 5 with `--source-deployment-id`.
6. Only then consider EA-66C packaging.

---

## 11. State ledger

| Item                        | Status                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| EA-66A                      | **PARTIAL** — preserved                                             |
| EA-66A.1                    | **COMPLETE** — preserved                                            |
| EA-66B                      | **PREBUILD BLOCKED**                                                |
| EA-66B.1                    | **BLOCKED on image prerequisites; source-identity fix implemented** |
| EA-66B.2                    | **PARTIAL — no image recovered**                                    |
| EA-66B.3                    | **COMPLETE — audit only; no reusable image**                        |
| EA-66B.5                    | **IMAGE PREREQUISITES READY; formal build blocked on key**          |
| GHCR as deployment source   | **NOT USED**                                                        |
| External Docker image pull  | **PROHIBITED** (one unauthorized cache pull disclosed in EA-66B.2)  |
| Production                  | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**                   |
| Rollback                    | **FAIL — NO EXECUTABLE ROLLBACK PATH**                              |
| A1–A8                       | **PENDING AUTHORIZATION**                                           |
| Migration 51                | **NOT RUN**                                                         |
| DB / Object Storage restore | **NOT RUN**                                                         |
| WOPI                        | **PAUSED**                                                          |

---

## 12. Evidence index

| File                            | Contents                                        |
| ------------------------------- | ----------------------------------------------- |
| `image-policy.md`               | new image acquisition policy                    |
| `minio-verification.md`         | MinIO identity and running container            |
| `runtime-image-verification.md` | all runtime/build image identities              |
| `source-build-readiness.md`     | archive, deployment id, build script and Gate 5 |
| `prebuild-check.md`             | item-by-item preflight                          |
| `raw/`                          | pull logs, inspect output, preflight and tests  |
| `SHA256SUMS`                    | hashes of every evidence file except itself     |

Verify:

```bash
cd docs/evidence/ea66b5 && sha256sum -c SHA256SUMS
```
