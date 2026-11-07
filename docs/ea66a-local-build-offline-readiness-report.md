# EA-66A — local build environment and offline dependency readiness report

**Phase type:** read-only build/offline readiness audit and design.
**No image build. No image pull. No dependency download. No production
deployment. No code, Dockerfile, Compose, workflow, `turbo.json` or `.env`
change.**

**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)
**Target:** `beaconhs-drill` (drill/test host, not production)

---

## 1. Verdict

| Question                                          | Answer                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| Is the local build environment inventoried?       | **YES**                                                                  |
| Are all canonical application images listed?      | **YES** — one gated app image + four pinned images                       |
| Are all base images identified?                   | **YES** — Node 24.18.0 bookworm-slim and Dockerfile frontend 1.7         |
| Are all external dependencies identified?         | **YES at package/source level**; Debian apt versions are unpinned        |
| Is the local cache verified as an offline source? | **NO** — pnpm store has 4 mutated packages; base/frontend are cache-only |
| Is the target platform compatible?                | **YES** — linux/amd64, Docker 29.9.2, Compose 5.6.1                      |
| Is the offline delivery structure designed?       | **YES**                                                                  |
| Is the rollback package designed?                 | **YES as a design**, but no complete previous bundle exists              |
| Are supply-chain evidence rules clear?            | **YES**; the current trust chain is incomplete                           |
| Was any external image pulled?                    | **NO**                                                                   |
| Was any image built or dependency installed?      | **NO**                                                                   |
| Were existing code/deploy files modified?         | **NO**                                                                   |
| HEAD unchanged / staged 0?                        | **YES / YES**                                                            |
| Are report and SHA-256 complete?                  | **YES** — see `docs/evidence/ea66a/SHA256SUMS`                           |

### 1.1 Phase status

**EA-66A: PARTIAL.**

The audit and design are complete, but a **clean offline build is not proven**.
The deployment half of the new architecture (local image tar → offline import →
Compose) is design-ready; the build half has unresolved external inputs:

1. the Node base image and Dockerfile frontend are **not local images** — only
   BuildKit cache records;
2. corepack/pnpm bootstrap has no verified offline path;
3. the pnpm store fails its own integrity check and completeness is unproven;
4. Debian bookworm apt packages are unpinned and not in the host cache;
5. Chrome is downloaded by the Dockerfile despite a local exact copy;
6. no image has been built from the current source; EA-16 is a dirty-worktree
   candidate with no embedded source identity, no build log, no SBOM and no
   signature;
7. the required Server Action key file is missing;
8. no complete previous release bundle exists, so rollback remains
   **FAIL — NO EXECUTABLE ROLLBACK PATH**.

Per the phase rule “if a key dependency cannot be confirmed, mark PARTIAL,” the
status is **PARTIAL**, not COMPLETE.

---

## 2. Repository protection

Recorded before any EA-66A change (`raw/baseline.txt`):

| Item                                       | Value                                                             |
| ------------------------------------------ | ----------------------------------------------------------------- |
| Branch                                     | `hse-platform`                                                    |
| HEAD                                       | `51a899b7aac0a942da327222a3eed355fca9798a`                        |
| Staged                                     | 0                                                                 |
| Modified                                   | 165                                                               |
| Untracked                                  | 532 (baseline; EA-66A adds documentation only)                    |
| `git diff --check`                         | exit 0                                                            |
| `turbo.json`                               | not modified (hash `a244a31b…`)                                   |
| `pnpm-lock.yaml`                           | not modified (`2452cd34…`)                                        |
| `Dockerfile`                               | not modified (`763b5d10…`)                                        |
| Compose files                              | not modified; canonical hash `9700f480…`                          |
| GitHub Actions                             | not modified (`ci.yml` `212e0716…`, `deploy-dev.yml` `cffd9bf1…`) |
| EA-64 / EA-64.1 / EA-65 / EA-65.1 evidence | 17/17, 15/15, 59/59, 38/38 verified                               |

No reset, clean, restore, checkout, add, commit or push was used. No production
server was contacted; the drill host was read-only.

### 2.1 One recorded process deviation

`npm cache verify` was run during cache inventory and garbage-collected 33
unreferenced entries (163,350,523 bytes). No package was downloaded and no
Docker/pnpm store content was deleted. The exact output is in
`raw/cache-deviation.txt`. This is recorded because EA-66A required no cache
deletion.

---

## 3. Current build chain

`Dockerfile` builds **one image** for four Compose roles:

```
base    FROM node:24.18.0-bookworm-slim@sha256:cb4e8f7c…
        npm install -g corepack@0.35.0
        corepack prepare pnpm@10.30.3
builder COPY . .
        pnpm install --frozen-lockfile
        pnpm turbo run build --filter web/worker/ops-bootstrap/ops-migrate
        pnpm deploy --prod --legacy for worker, ops-bootstrap, ops-migrate
runner  FROM base
        apt-get install runtime libs + LibreOffice + poppler
        npx @puppeteer/browsers install chrome-headless-shell@140.0.7339.207
        COPY standalone/static/public/worker/ops/entrypoint
```

The image also contains `APP_ROLE=migrate` and `bootstrap-admin` entrypoints.
`Dockerfile.test` is a test variant with a placeholder key and is **not** a
release artifact.

The build requires:

- Dockerfile frontend `docker/dockerfile:1.7@sha256:a57df69d…`;
- Node base `node:24.18.0-bookworm-slim@sha256:cb4e8f7c…`;
- npm registry for corepack/pnpm and project tarballs;
- Debian bookworm apt repositories for runtime packages;
- Google/npm for Chrome headless shell;
- Server Action key secret (`next_server_actions_key`, mode 600).

---

## 4. Image inventory

Canonical release images:

| Service(s)                        | Class  | Image                                 | Local ID           | Platform    | Offline status                                   |
| --------------------------------- | ------ | ------------------------------------- | ------------------ | ----------- | ------------------------------------------------ |
| web/worker/scheduler/storage-init | gated  | `beaconhs:phase-ea16-20261023-052716` | `sha256:17126c6e…` | linux/amd64 | **MISSING for current source** (stale candidate) |
| postgres                          | pinned | `postgres@sha256:721873c3…`           | same               | linux/amd64 | READY-LOCAL                                      |
| redis                             | pinned | `redis@sha256:858f009f…`              | same               | linux/amd64 | READY-LOCAL                                      |
| minio                             | pinned | `minio/minio@sha256:b187417e…`        | same               | linux/amd64 | READY-LOCAL; target alias mismatch               |
| collabora                         | pinned | `collabora/code@sha256:4e983196…`     | same               | linux/amd64 | READY-LOCAL                                      |

Selected images total **5,452,268,083 bytes (5.08 GiB)**. The app image has 18
compressed layers (578,043,276 bytes) and an OCI index with platform manifest
`43a7dc27…` plus attestation `0f7e823e…`.

The existing app image is not release-grade:

- built from a dirty worktree (165 modified + 1,022 untracked at the time);
- `.next/config.deploymentId` is **`<missing>`**;
- the source SHA appears **0 times** inside `/app`;
- no Docker build log;
- no SBOM, no signature;
- provenance `completeness=false`.

No image was pulled, built, tagged, saved or published in EA-66A.

---

## 5. Dependencies and local caches

Full audit: `base-image-dependency-audit.md`, `local-cache-inventory.md`.

| Dependency            | Local state                                                                  | Offline impact          |
| --------------------- | ---------------------------------------------------------------------------- | ----------------------- |
| Node base image       | **not a local image**; cache records only                                    | blocker for clean build |
| Dockerfile frontend   | **not a local image**; 35.76 MB cache record                                 | blocker for clean build |
| corepack 0.35.0       | npm cache lacks tarball; host corepack 0.36.0                                | blocker                 |
| pnpm 10.30.3          | host and corepack cache have it; Docker build does not mount it              | blocker/partial         |
| Project npm deps      | pnpm store 1.7 GB; `pnpm store status` **exit 1**, 4 mutated packages        | not a verified source   |
| BuildKit pnpm cache   | 1.812 GB cache mount; completeness unverified                                | cache-only              |
| Debian apt runtime    | host apt cache is Ubuntu Noble; LibreOffice absent; apt layer 607.8 MB cache | blocker for clean build |
| Chrome 140.0.7339.207 | exact copy at `/opt/chrome`; Dockerfile still downloads                      | blocker for clean build |
| SBOM / signature      | EA-47/48 SBOMs exist for older images; no EA-16 SBOM/signature               | supply-chain gap        |
| Server Action key     | **missing** at `/tmp/beaconhs-server-action-key`                             | build blocked           |

Cache totals:

- Docker images: 36.5 GB (60 images, 21.77 GB reclaimable);
- BuildKit cache: **109.5 GB** (83.58 GB reclaimable);
- pnpm store: 1.7 GB;
- npm cache: 352 entries / 173 MB;
- apt cache: 703 MB (Ubuntu, not Debian);
- Playwright: 681 MB (dev only);
- disk free: **67 GB**.

No Docker image, BuildKit cache, pnpm store or volume was deleted.

---

## 6. Target platform

**Target:** Ubuntu 24.04.5 LTS, `x86_64`, Docker Engine 29.9.2, Compose v5.6.1,
Buildx v0.38.1, glibc 2.39, storage `overlayfs`, Swarm inactive.

| Compatibility check          | Result                                              |
| ---------------------------- | --------------------------------------------------- |
| Target CPU architecture      | `x86_64` / `amd64`                                  |
| Local build architecture     | `x86_64` / `amd64`                                  |
| App image platform           | `linux/amd64`                                       |
| Pinned images platform       | all `linux/amd64`                                   |
| Cross-build required         | **NO**                                              |
| Target Node needed           | **NO** — deployment only                            |
| Target can import image tars | **YES**, with disk/digest preflight                 |
| Target free disk             | 21 GB; two releases ≈ 8.31 GiB + temp               |
| Target MinIO canonical ref   | **MISSING**; local-registry variant present         |
| Target canonical volumes     | **MISSING** (F-65-2)                                |
| Target canonical project     | **not running**; target Compose copy is pre-EA-65.1 |

Platform compatibility is **PASS**; deployment readiness is **PARTIAL** because
of volumes, MinIO reference, old target Compose and no complete release bundle.

---

## 7. Offline release design

Full design: `offline-release-design.md`.

Key points:

- **One app tar**, not separate web/worker/scheduler tars. The Dockerfile
  builds one image for all four roles.
- Four pinned tars: postgres, redis, minio, collabora.
- `release-manifest.json`, `source-manifest.json`, `image-manifest.json`,
  Compose files, SBOM/provenance, build log, `checksums.sha256`, and three
  scripts (`verify-package.sh`, `import-images.sh`, `verify-deployment.sh`).
- Source manifest records git HEAD **and** source archive SHA-256 because the
  worktree is dirty; the archive is authoritative.
- Image manifest records Image ID/index digest, platform manifest digest,
  config digest, platform, size, source revision/archive, and tar SHA-256.
  `RepoDigests` is corroboration only.
- The Server Action key is supplied separately and never packaged; only its
  fingerprint is recorded.
- Import: `docker load -i` each tar, then `docker image inspect` the exact
  reference, Image ID, platform and digest.
- Pull prevention: `pull_policy: never` + `--pull never` + `--no-build`;
  preflight every image; no `build:` sections; never run `docker compose pull`.
  The canonical Compose file does not have `pull_policy` today; EA-66B must add
  it or use a reviewed offline override. `docker compose config` with
  `pull_policy: never` was verified in read-only mode.
- No production secrets in the bundle.

---

## 8. Rollback design

Full design: `rollback-package-design.md`.
Current status: **FAIL — NO EXECUTABLE ROLLBACK PATH**.

A complete rollback package would require two complete release bundles:
current + previous. Today only the EA-16 app image exists; there is no complete
previous bundle (old Compose/manifest/SBOM/provenance are incomplete), no
signature, no current SBOM, and no executable rollback code path.

Critical constraints:

- image tar availability is necessary but not sufficient;
- migrations are forward-only; Migration 51 is **NOT RUN**; there is no
  down-migration;
- an old image against a newer schema refuses readiness; a database restore may
  be required;
- object-store backup/restore is **NOT RUN**; image rollback does not move
  objects;
- Server Action key compatibility is **NOT VERIFIED**; a different key causes
  404s;
- rollback classes RB-B/C/D are **PENDING AUTHORIZATION** (A8/A7);
- do not claim tar-only rollback.

---

## 9. Supply-chain controls

Full matrix: `supply-chain-controls.md`.

Four layers are separated:

| Layer              | Current state                                                                      |
| ------------------ | ---------------------------------------------------------------------------------- |
| File integrity     | SHA-256 design ready; package not built                                            |
| Image identity     | Image ID/index digest/platform verified locally                                    |
| Build source       | EA-16 has provenance but no embedded source identity; dirty worktree; no build log |
| Supply-chain trust | no signature, no current SBOM, provenance `completeness=false`                     |

SHA-256 proves only that files match the manifest. It does not prove the build
was honest. A retroactive signature over historical provenance must not be
presented as a build-time signature.

---

## 10. Findings

| ID           | Finding                                                                                     | Severity                        | Status                    |
| ------------ | ------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------- |
| **F-66A-1**  | Node base image absent from local image store; cache records only                           | Blocker for clean offline build | OPEN                      |
| **F-66A-2**  | Dockerfile frontend absent from local image store; cache record only                        | Blocker                         | OPEN                      |
| **F-66A-3**  | corepack/pnpm bootstrap has no verified offline path                                        | Blocker                         | OPEN                      |
| **F-66A-4**  | pnpm store integrity fails (4 mutated packages); completeness unproven                      | Blocker                         | OPEN                      |
| **F-66A-5**  | Debian apt packages unpinned and not in host cache; LibreOffice absent                      | Blocker for clean build         | OPEN                      |
| **F-66A-6**  | Chrome downloaded despite exact local copy                                                  | Blocker for clean build         | OPEN                      |
| **F-66A-7**  | No current-source image; EA-16 dirty, no embedded identity/build log/SBOM/signature         | Release blocker                 | OPEN                      |
| **F-66A-8**  | Server Action key file missing                                                              | Blocker                         | OPEN                      |
| **F-66A-9**  | No current SBOM/signature; provenance completeness false                                    | Supply-chain gap                | OPEN                      |
| **F-66A-10** | No complete previous release bundle; rollback not executable                                | Rollback blocker                | OPEN                      |
| **F-66A-11** | Workflow still GHCR/pull; not the offline path                                              | Architecture gap                | OPEN — later phase        |
| **F-66A-12** | `build-drill-image.sh` rewrites every `image:` line, including pinned infra                 | Latent bug                      | OPEN — flagged, not fixed |
| **F-66A-13** | Build context includes docs/evidence and `.playwright-mcp`                                  | Optimization                    | OPEN                      |
| **F-66A-14** | Collabora digest differs between canonical Compose (`4e983196…`) and workflow (`df33af88…`) | Config divergence               | OPEN — later phase        |

F-66A-12 was found by static review: `scripts/build-drill-image.sh:156` applies
a `sed` replacement to every `image:` line, which would replace postgres/redis/
minio/mailpit/collabora in a multi-image drill Compose file. It is not used by
the canonical offline path; it is flagged for a separately authorized fix.

---

## 11. Validation gates

The repository was not modified in code, Dockerfile, Compose, workflow,
`turbo.json` or `.env`. The standard gates were still run to prove the audit
documentation did not disturb the tree:

| Gate                                          | Result             | Cached       |
| --------------------------------------------- | ------------------ | ------------ |
| `pnpm format:check`                           | **exit 0**         | n/a          |
| `pnpm typecheck --force`                      | **exit 0** — 27/27 | **0 cached** |
| `pnpm lint --force`                           | **exit 0** — 1/1   | **0 cached** |
| `pnpm deadcode:check`                         | **exit 0**         | n/a          |
| `pnpm turbo run test --force --concurrency=1` | **exit 0** — 25/25 | **0 cached** |
| `pnpm build --force`                          | **exit 0** — 4/4   | **0 cached** |
| `git diff --check`                            | **exit 0**         | n/a          |

DB-backed tenant-isolation/storage-freeze tests remain skipped because
`SEED_TEST_SCRATCH_DATABASE_URL` is not set; they were not counted as passes.
Raw logs: `docs/evidence/ea66a/raw/gates/`.

---

## 12. Completion criteria

| #   | Criterion                               | Result                                                  |
| --- | --------------------------------------- | ------------------------------------------------------- |
| 1   | Local build environment inventory       | **PASS**                                                |
| 2   | All application images listed           | **PASS**                                                |
| 3   | All base images identified              | **PASS** — identified; local presence missing           |
| 4   | All external dependencies identified    | **PASS at package/source level**; apt versions unpinned |
| 5   | Local cache situation verified          | **PASS** — with recorded npm GC deviation               |
| 6   | Ubuntu platform compatibility analyzed  | **PASS** — amd64                                        |
| 7   | Offline delivery structure designed     | **PASS**                                                |
| 8   | Rollback package design completed       | **PASS as design**; executable rollback still FAIL      |
| 9   | Supply-chain evidence rules clear       | **PASS**; trust chain incomplete                        |
| 10  | No external image pull                  | **PASS**                                                |
| 11  | No existing code/deploy config modified | **PASS**                                                |
| 12  | HEAD unchanged                          | **PASS**                                                |
| 13  | Staged 0                                | **PASS**                                                |
| 14  | Report and SHA-256 complete             | **PASS** — see `SHA256SUMS`                             |

Overall: **PARTIAL** because criteria 3–8 are satisfied as audit/design but the
offline build inputs and rollback bundle are not executable.

---

## 13. EA-66B implementation plan

EA-66B may start only with separate authorization. Recommended order:

1. **Source decision:** clean snapshot/commit or source archive + dirty hash.
2. **Build bundle:** import base/frontend images; seed a verified pnpm store;
   snapshot Debian bookworm apt packages; stage Chrome; obtain the Server
   Action key.
3. **Offline build:** build with `--network=none` (or a verified local mirror),
   capture a redacted log, read `deploymentId` from the image and assert it
   equals the source revision.
4. **Evidence:** generate SBOM, provenance, source binding, image manifest,
   release manifest and checksums.
5. **Release bundle:** one app tar + four pinned tars + Compose/manifest +
   scripts; package twice (current + previous complete bundle).
6. **Target import:** verify package, `docker load`, verify Image ID/digest/
   platform, `docker compose config`, `docker compose up --pull never
--no-build` on an isolated project first.
7. **Gate 5:** run the EA-65.1 verifier against the isolated/canonical project;
   require PASS before any production consideration.
8. **Rollback:** implement EA-52 steps and obtain A8/A7 authorization; do not
   claim rollback from tars alone.

EA-66B must not modify production Compose, workflows, `.env`, database,
object-store data or the target host without the corresponding authorization.

---

## 14. State ledger

| Item                              | Status                                                                 |
| --------------------------------- | ---------------------------------------------------------------------- |
| GHCR as deployment image source   | **NOT USED / NOT A SOURCE**                                            |
| External image pull at deploy     | **PROHIBITED — design enforces `pull_policy: never` / `--pull never`** |
| Real Ubuntu production deployment | **NOT VERIFIED**                                                       |
| Production                        | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**                      |
| Rollback                          | **FAIL — NO EXECUTABLE ROLLBACK PATH**                                 |
| A1–A8                             | **PENDING AUTHORIZATION**                                              |
| Migration 51                      | **NOT RUN**                                                            |
| DB / object store restore         | **NOT RUN**                                                            |
| WOPI                              | **Paused**                                                             |
| EA-66B                            | **NOT STARTED**                                                        |

EA-66A stops here. It does not build, package, pull, deploy, modify workflows or
start EA-66B.

---

## 15. Evidence index

| File                                                   | Contents                                            |
| ------------------------------------------------------ | --------------------------------------------------- |
| `docs/evidence/ea66a/build-environment-inventory.md`   | host/toolchain/source state                         |
| `docs/evidence/ea66a/application-image-inventory.md`   | canonical and auxiliary images                      |
| `docs/evidence/ea66a/base-image-dependency-audit.md`   | Dockerfile/base/external dependency audit           |
| `docs/evidence/ea66a/local-cache-inventory.md`         | Docker/BuildKit/pnpm/npm/apt/Playwright caches      |
| `docs/evidence/ea66a/offline-build-gap-analysis.md`    | blockers and EA-66B options                         |
| `docs/evidence/ea66a/target-platform-compatibility.md` | target amd64/Docker/Compose compatibility           |
| `docs/evidence/ea66a/offline-release-design.md`        | bundle, manifests, import, pull prevention          |
| `docs/evidence/ea66a/rollback-package-design.md`       | two-release retention and constraints               |
| `docs/evidence/ea66a/supply-chain-controls.md`         | integrity/identity/source/trust separation          |
| `docs/evidence/ea66a/raw/`                             | raw command output, image/cache/Dockerfile evidence |
| `docs/evidence/ea66a/SHA256SUMS`                       | SHA-256 of every evidence file except itself        |

Verify:

```bash
cd docs/evidence/ea66a && sha256sum -c SHA256SUMS
```
