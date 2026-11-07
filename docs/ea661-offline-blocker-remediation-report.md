# EA-66A.1 — offline blocker remediation report

**Phase type:** targeted P0 remediation + static/isolated tests.
**No image build. No image pull. No `docker compose up`. No deployment. No CI
trigger. No production connection.**

**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. Verdict

**EA-66A.1: COMPLETE for the three P0 items.**
**EA-66A overall: PARTIAL** — the local build/offline package has not been
executed; this phase only closes the three blockers.

| P0   | Finding                                                       | Status                                                    |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------- |
| P0-1 | F-66A-12 — `build-drill-image.sh` rewrites all `image:` lines | **CLOSED**                                                |
| P0-2 | F-66A-14 — Canonical vs workflow Collabora digest             | **CLOSED**                                                |
| P0-3 | F-66A-8 — Server Action key missing / unsafe handling         | **CLOSED for design and controls**; no formal key created |

The Server Action key remains an operator-supplied pre-deployment gate. That is
intentional: a formal key must not be generated into the repository, image,
release bundle or evidence.

---

## 2. Repository protection

Recorded before any EA-66A.1 change (`docs/evidence/ea661/raw/baseline.txt`):

| Item                                   | Value                                            |
| -------------------------------------- | ------------------------------------------------ |
| Branch                                 | `hse-platform`                                   |
| HEAD                                   | `51a899b7aac0a942da327222a3eed355fca9798a`       |
| Staged                                 | 0                                                |
| Modified                               | 165                                              |
| Untracked                              | 533 at baseline; EA-66A.1 adds docs/tests only   |
| `git diff --check`                     | exit 0                                           |
| EA-66A evidence                        | **62/62 verified**, exit 0                       |
| `.env`                                 | present, mode 664, **not read and not modified** |
| `turbo.json`                           | `a244a31b…` — **unchanged**                      |
| `pnpm-lock.yaml`                       | `2452cd34…` — **unchanged**                      |
| `Dockerfile`                           | `763b5d10…` — **unchanged**                      |
| `deploy/local-production.compose.yaml` | `9700f480…` — **unchanged**                      |
| `deploy/gate5.manifest.yaml`           | `6bc70fa0…` — **unchanged**                      |

No reset, clean, restore, checkout, add, commit or push was used. No production
server was contacted; the drill host was not used in this phase.

`deploy-dev.yml` was already modified in the working tree before this phase
(user changes). EA-66A.1 changed **only** the `COLLABORA_IMAGE` line; the other
diff content is pre-existing work and was preserved.

---

## 3. F-66A-12 — application image replacement scope

### 3.1 Original state

`scripts/build-drill-image.sh` used:

```bash
sed "s|^\([[:space:]]*image:[[:space:]]*\)[^[:space:]]*\(.*\)$|\1${DRILL_IMAGE_NAME}\2|"
```

This replaced every `image:` line in the streamed drill Compose file, including
`postgres`, `redis`, `minio`, `mailpit` and `collabora`. The stack would have run
the application image for every service.

Pre-fix SHA-256: `e9daec374d07c4d0e900224cd12cad859b94716ecaf359a8b550aa657cbb1f4e`.

### 3.2 Fix

New helper `scripts/ci/pin-compose-app-image.mjs`:

- reads `deploy/gate5.manifest.yaml` and collects only `image_class: gated`
  services (`web`, `worker`, `scheduler`, `storage-init`);
- parses the Compose `services:` block strictly;
- replaces only those four `image:` lines;
- preserves every other byte;
- rejects missing gated services, duplicate services/images, unsafe image refs,
  a changed service count/set, or a changed non-application image;
- writes nothing on failure.

`scripts/build-drill-image.sh` now:

1. reads the host Compose file read-only over SSH;
2. renders it through the helper into a local mode-600 temp file;
3. validates the exact file with the target’s `docker compose config`;
4. runs `docker compose up -d --force-recreate --no-build --pull never` from the
   same validated file;
5. removes the temp file on exit; the host’s Compose file is never written.

### 3.3 Tests

`node --test scripts/ci/pin-compose-app-image.test.mjs` → **8/8 PASS**, no skips:
only app services pinned; pinned/other images unchanged; service count/set
unchanged; every non-application line preserved; missing/duplicate/unsafe
inputs fail without output; rendered file passes `docker compose config`.

The rendered drill file changed only `web`, `worker`, `scheduler`,
`storage-init`; `postgres`, `redis`, `minio`, `mailpit`, `collabora` retained
their images; service count remained 9.

Post-fix SHA-256: `4150da2affc88af40f9bbdee772c45fb8be1ca9421bf990dac1c87576320cdd2`.

Full detail: `docs/evidence/ea661/build-drill-image-image-scope.md`.

---

## 4. F-66A-14 — Collabora digest

### 4.1 Two references

| Source                                              | Reference                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Canonical Compose + Gate 5 manifest + drill Compose | `collabora/code@sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c`             |
| Legacy `deploy-dev.yml` before                      | `collabora/code:26.04.2.1.1@sha256:df33af88c59e26b7335ea98d91e65f1edf13f33369ce6115941b8d59d3409cb5` |

### 4.2 Evidence

Read-only `docker manifest inspect`:

- `4e983196…` is a **multi-platform index** with a `linux/amd64` platform
  manifest `b1845bd69719…` and an arm64 manifest;
- `df33af88…` is a valid single-platform `linux/amd64` manifest, but an older
  image and **not present locally**;
- the local/target image is `4e983196…`, linux/amd64, label `version=26.04.4.2`;
- Canonical Compose, Gate 5 manifest and drill Compose all use `4e983196…`.

The old workflow reference was valid but not the canonical deployment. The
canonical choice is supported by four independent sources (Compose, Manifest,
local image, target image), not by the workflow alone. Upstream signature /
provenance remains **NOT VERIFIED**.

### 4.3 Fix and test

`deploy-dev.yml:29` now uses:

```yaml
COLLABORA_IMAGE: collabora/code@sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c
```

Canonical Compose and Gate 5 manifest were already correct and were not changed.

`node --test scripts/ci/collabora-image-consistency.test.mjs` → **5/5 PASS**:
Compose/Manifest/workflow agree; digest format valid; no tag-only fallback; local
image is linux/amd64 when present.

Post-change workflow SHA-256: `7ce5554bcaad9edabf5911d6c2373ed670c13b5550444ea06949cb7a18030db7`
(pre-change `cffd9bf1081449bccd482c2727c46e7f31663f915534ae03eb1e99cb4af11c43`;
the file also contains pre-existing user modifications).

Full detail: `docs/evidence/ea661/collabora-digest-verification.md`.

---

## 5. F-66A-8 — Server Action key

### 5.1 Build-time or runtime?

**Both; the build-time and runtime values must be the same key.**

Next.js 16.3.5 resolves:

```js
process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY || serverActionsManifest.encryptionKey
```

(`apps/web/node_modules/next/dist/server/app-render/encryption-utils.js:78`).

The Dockerfile mounts the key as a required BuildKit secret for `next build`
(`Dockerfile:48-52`), so the key is embedded in the server-reference manifest.
The canonical Compose requires the runtime override for `web`, explicitly
“must match the build-time key” (`deploy/local-production.compose.yaml:119`).

Official Next.js 16 docs confirm the key must be consistent for the build and
all server instances, must be base64 AES with 16/24/32-byte decoded length, and
document `openssl rand -base64 32`.

### 5.2 Safe scheme

1. Generate one 32-byte key with `umask 077; openssl rand -base64 32` into a
   mode-600 file **outside the repository**.
2. Keep the durable copy in the secret manager/escrow; the build host gets a
   temporary copy over an authenticated encrypted channel.
3. Build with `NEXT_SERVER_ACTIONS_KEY_FILE=/secure/...`; the existing script
   passes `--secret` and only the fingerprint as a build arg.
4. Runtime uses a separate mode-600 env file/systemd `EnvironmentFile`; all web
   replicas share the same value. No per-instance key.
5. Record only the 32-hex fingerprint in build/deployment records.
6. Rotate only with a coordinated rebuild + all-replica env update; keep the old
   key in escrow for rollback to an older image.
7. Never place the key in Git, image layers, build logs, release manifests,
   offline packages or command-line arguments.

### 5.3 Tests and status

`node --test scripts/ci/server-action-key-handling.test.mjs` → **6/6 PASS**:
BuildKit secret/no key ENV/build-arg; both build entry points; mandatory runtime
override; legacy Dokploy stack has no per-instance key; documented path/mode;
temporary-key fingerprint agreement. The temporary key is generated in a private
temp dir, never printed, and removed.

Existing contract tests: **19/19 PASS** (2 files).

**F-66A-8: CLOSED for design and static controls.** No formal key was generated;
that is a deliberate operator pre-deployment gate, not an unresolved design.
Actual image build/deployment with the key is **NOT RUN**.

Full detail: `docs/evidence/ea661/server-action-key-design.md`.

---

## 6. Runtime image packaging scope

Canonical Compose has 8 services:

| Class  | Services                                     | Package               |
| ------ | -------------------------------------------- | --------------------- |
| gated  | `web`, `worker`, `scheduler`, `storage-init` | **one app image tar** |
| pinned | `postgres`, `redis`, `minio`, `collabora`    | **four pinned tars**  |

The Node base image, Dockerfile frontend, build tools, mailpit, registry,
python/aj-gateway, old experiment images and CI-only images are **not** release
package items. The app image is built once and serves all four gated roles; there
is no separate web/worker/scheduler image.

Selected runtime images total **5.08 GiB** uncompressed. The target has 21 GB
free; keep two app images + one shared pinned set for rollback.

Full detail: `docs/evidence/ea661/image-packaging-scope.md`.

---

## 7. Online build/tool policy

EA-66A’s fully-offline build blockers are downgraded: Docker/Compose/Buildx/
Node/corepack/pnpm/Git/curl/jq/yq/rsync/shellcheck, apt packages, npm/pnpm
dependencies, base images, the Dockerfile frontend and Chrome may be installed
online from official/trusted sources during the build.

Required records:

- actual tool versions;
- full base/frontend `repo:tag@sha256:…` + platform;
- lockfile SHA + `pnpm install --frozen-lockfile`;
- Debian release and package versions/snapshot;
- Chrome version + archive SHA;
- redacted build log + SHA;
- SBOM;
- image identity and source archive/dirty state.

No silent dependency updates, no lockfile edits, no build tool image in the
runtime package. Deployment remains strictly `docker load` + `docker image
inspect` + `docker compose config` + `up --pull never --no-build`.

Full detail: `docs/evidence/ea661/online-tool-install-policy.md`.

---

## 8. Changed files

| File                                              | Before                    | After       | Note                                              |
| ------------------------------------------------- | ------------------------- | ----------- | ------------------------------------------------- |
| `scripts/build-drill-image.sh`                    | `e9daec37…`               | `4150da2a…` | app-only image scope + temp file + `--pull never` |
| `scripts/ci/pin-compose-app-image.mjs`            | —                         | `902f845b…` | new strict helper                                 |
| `scripts/ci/pin-compose-app-image.test.mjs`       | —                         | `b7ccc80d…` | 8 tests                                           |
| `scripts/ci/collabora-image-consistency.test.mjs` | —                         | `9e1e0b4c…` | 5 tests                                           |
| `scripts/ci/server-action-key-handling.test.mjs`  | —                         | `c7796a6c…` | 6 tests                                           |
| `.github/workflows/deploy-dev.yml`                | `cffd9bf1…`               | `7ce5554b…` | only `COLLABORA_IMAGE` line changed by this phase |
| `knip.ts`                                         | pre-existing modified     | `0be782a4…` | this phase added helper entry + `tsx` ignore      |
| `deploy/local-production.compose.yaml`            | `9700f480…`               | `9700f480…` | unchanged                                         |
| `deploy/gate5.manifest.yaml`                      | `6bc70fa0…`               | `6bc70fa0…` | unchanged                                         |
| `Dockerfile`                                      | `763b5d10…`               | `763b5d10…` | unchanged                                         |
| `turbo.json` / `pnpm-lock.yaml`                   | `a244a31b…` / `2452cd34…` | same        | unchanged                                         |

`knip.ts` was updated only so the new build helper and its `tsx` test invocation
are recognised by the dead-code gate; it also contains pre-existing user
modifications. No business code, Compose, manifest, Dockerfile, `.env`,
`turbo.json` or lockfile was changed.

---

## 9. Test summary

| Suite                                       | Result                                        |
| ------------------------------------------- | --------------------------------------------- |
| App-image scope tests                       | **8/8 PASS**                                  |
| Collabora consistency tests                 | **5/5 PASS**                                  |
| Server Action key tests                     | **6/6 PASS**                                  |
| Existing key/deployment contract vitest     | **19/19 PASS**                                |
| `bash -n build-drill-image.sh`              | exit 0                                        |
| `node --check` helper/tests                 | exit 0                                        |
| PyYAML drill Compose before/after           | 9 services both; only app images differ       |
| `docker compose config` rendered drill file | exit 0; 9 services; pinned unchanged          |
| GitHub Actions YAML parse                   | both files parse; canonical `COLLABORA_IMAGE` |
| `shellcheck`                                | **not installed**; not run                    |

No image build, pull, `up`, `create`, CI trigger or deployment was performed.

### 9.1 Repository gates

| Gate                                          | Result             | Cached       |
| --------------------------------------------- | ------------------ | ------------ |
| `pnpm format:check`                           | **exit 0**         | n/a          |
| `pnpm typecheck --force`                      | **exit 0** — 27/27 | **0 cached** |
| `pnpm lint --force`                           | **exit 0** — 1/1   | **0 cached** |
| `pnpm deadcode:check`                         | **exit 0**         | n/a          |
| `pnpm turbo run test --force --concurrency=1` | **exit 0** — 25/25 | **0 cached** |
| `pnpm build --force`                          | **exit 0** — 4/4   | **0 cached** |
| `git diff --check`                            | **exit 0**         | n/a          |

Raw logs: `docs/evidence/ea661/raw/gates/`.

Full detail: `docs/evidence/ea661/test-results.md`.

---

## 10. Remaining issues

| Item                                             | Status                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| Formal Server Action key provisioning            | **OPERATOR GATE** — no key created; must be provisioned before build/deploy |
| Actual local image build from current source     | **NOT RUN**                                                                 |
| Offline release bundle creation                  | **NOT RUN**                                                                 |
| EA-66A offline build gaps (base/apt/pnpm/Chrome) | Downgraded to online build work items; not resolved here                    |
| GHCR / legacy workflow path                      | Still present; not the offline deployment path                              |
| MinIO canonical ref on target                    | Still missing under `minio/minio@b187…`; local-registry variant exists      |
| Canonical external volumes                       | Missing (F-65-2)                                                            |
| Real Ubuntu production deployment                | **NOT VERIFIED**                                                            |
| Rollback                                         | **FAIL — NO EXECUTABLE ROLLBACK PATH**                                      |
| EA-66B                                           | **NOT STARTED**                                                             |

---

## 11. State ledger

| Item                              | Status                                                 |
| --------------------------------- | ------------------------------------------------------ |
| GHCR as deployment image source   | **NOT USED**                                           |
| External image pull at deploy     | **PROHIBITED**                                         |
| Build tools/dependencies          | **MAY BE INSTALLED ONLINE during build, with records** |
| Runtime release package           | **Only the five canonical images**                     |
| Real Ubuntu production deployment | **NOT VERIFIED**                                       |
| Production                        | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**      |
| Rollback                          | **FAIL — NO EXECUTABLE ROLLBACK PATH**                 |
| A1–A8                             | **PENDING AUTHORIZATION**                              |
| Migration 51                      | **NOT RUN**                                            |
| DB / Object Storage restore       | **NOT RUN**                                            |
| WOPI                              | **PAUSED**                                             |

EA-66A.1 stops here. EA-66B is not started.

---

## 12. Evidence index

| File                                                   | Contents                                              |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `docs/evidence/ea661/build-drill-image-image-scope.md` | F-66A-12 original/fix/tests                           |
| `docs/evidence/ea661/collabora-digest-verification.md` | F-66A-14 digest evidence and selection                |
| `docs/evidence/ea661/server-action-key-design.md`      | F-66A-8 build/runtime key design                      |
| `docs/evidence/ea661/image-packaging-scope.md`         | runtime image package boundaries                      |
| `docs/evidence/ea661/online-tool-install-policy.md`    | online build/tool policy                              |
| `docs/evidence/ea661/test-results.md`                  | all test commands/results                             |
| `docs/evidence/ea661/raw/`                             | raw test logs, Compose/YAML output, registry metadata |
| `docs/evidence/ea661/SHA256SUMS`                       | hash of every evidence file except itself             |

Verify:

```bash
cd docs/evidence/ea661 && sha256sum -c SHA256SUMS
```
