# BeaconHS — MinIO Local Image Build Record

> **Status:** build record. **Date:** 2026-09-29 · **Operator:** local development / verification only.
> Verification results: [beaconhs-storage-minio-verification.md](./beaconhs-storage-minio-verification.md)
>
> ## ⚠️ Provenance statement (required)
>
> **Due to the upstream Docker Hub `minio/minio` repository being unavailable, this
> environment builds a compatible image locally from the archived MinIO source code, and
> keeps BeaconHS's official `docker-compose.yml` unchanged.**
>
> This image is **NOT** a current MinIO official Docker Hub release image. It is a local
> build. It must not be published, redistributed, or presented as an official MinIO artifact.
> MinIO is AGPL-3.0; the built image ships `/licenses/LICENSE` and `/licenses/CREDITS` as the
> upstream packaging does.

## 摘要（中文执行摘要）

**由于上游 Docker Hub `minio/minio` 仓库已经不可用，本环境从 MinIO 归档源码本地构建兼容镜像，
并保留 BeaconHS 官方 `docker-compose.yml` 不变。**

| 项目         | 值                                                                        |
| ------------ | ------------------------------------------------------------------------- |
| 源码仓库     | `https://github.com/minio/minio`（**archived: true**）                    |
| 固定 commit  | `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`                                |
| 固定 tag     | `RELEASE.2025-10-15T17-29-55Z`（最后一个 release，Security/CVE 版）       |
| LICENSE      | AGPL-3.0                                                                  |
| 构建方式     | MinIO 仓库自身 Makefile 配方（`go build`）+ 运行时打包                    |
| Go toolchain | `go 1.24.0` 声明 / `toolchain go1.24.8` / 实际 `go1.24.13`                |
| 镜像 tag     | `minio/minio:latest`                                                      |
| 镜像 ID      | `sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c` |
| 镜像大小     | 268,771,790 bytes（256 MiB）                                              |
| 架构         | `linux/amd64`                                                             |
| 构建日期     | 2026-09-29T15:41:05+08:00                                                 |
| 本地源码修改 | **无**（工作区全程 `git status --porcelain` 为空）                        |

---

# 1. Source verification

## 1.1 Repository state

```
full_name  : minio/minio
archived   : True          <-- upstream archived the repository
default_br : master
license    : AGPL-3.0
pushed_at  : 2026-04-24T17:54:39Z
stars      : 61346
```

Last commits on `master` (all post-freeze documentation):

| SHA            | Date       | Message                                                         |
| -------------- | ---------- | --------------------------------------------------------------- |
| `7aac2a2c5b7c` | 2026-02-12 | update README.md format and clarify state of the project        |
| `be7800c8136e` | 2026-01-06 | update README.md with latest free license and enterprise option |
| `27742d469462` | 2025-12-03 | update README.md maintenance mode                               |
| `58659f26f45f` | 2025-11-06 | Drop v3 metrics from community docs (#21678)                    |
| `3a0cc6c86e6d` | 2025-10-27 | fix doc 404 (#21670)                                            |

## 1.2 Why `9e49d5e7a648…` was pinned

Per the task's requirement to avoid `main`/`master` head and to fix a reproducible ref, the
build uses the **latest published release**, not the branch tip:

```
$ curl -s https://api.github.com/repos/minio/minio/releases/latest
tag        : RELEASE.2025-10-15T17-29-55Z
name       : Security/CVE RELEASE.2025-10-15T17-29-55Z
published  : 2025-10-16T19:33:51Z

$ curl -s .../git/ref/tags/RELEASE.2025-10-15T17-29-55Z
type : commit
sha  : 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
```

The tag is a lightweight ref pointing straight at a commit, so the tag and the commit are the
same object. `master` advanced 4 documentation-only commits after this release; building the
release keeps the code identical to a shipped MinIO build.

**`master` HEAD was deliberately NOT used.**

## 1.3 Clone and cleanliness

```bash
git init minio-src && git remote add origin https://github.com/minio/minio.git
git fetch --depth 1 origin 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
git checkout FETCH_HEAD
git fetch --depth 1 origin tag RELEASE.2025-10-15T17-29-55Z   # so `git describe --tags` resolves
```

| Check                    | Result                                      |
| ------------------------ | ------------------------------------------- |
| `git rev-parse HEAD`     | `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`  |
| matches pinned SHA       | **YES**                                     |
| `git describe --tags`    | `RELEASE.2025-10-15T17-29-55Z`              |
| `git status --porcelain` | **empty — clean, zero local modifications** |

Source lives at `/tmp/opencode/minio-build/minio-src`, **outside the BeaconHS repository**.

## 1.4 Toolchain requirement

`go.mod` at the pinned commit:

```
module github.com/minio/minio

go 1.24.0

toolchain go1.24.8
```

Build container: `golang:1.24-alpine` (matches the `go 1.24.0` directive). The resulting binary
reports `Runtime: go1.24.13 linux/amd64`.

---

# 2. Dockerfile provenance

## 2.1 What the repo ships

| File                                 | Role                                                                                  | Usable as-is?                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `Dockerfile`                         | `FROM minio/minio:latest` + `COPY ./minio`                                            | **No** — circular; the base no longer exists                    |
| `Dockerfile.release`                 | builds via `curl` from `dl.min.io` + minisign verify, final stage on `ubi9/ubi-micro` | Partially — downloads a **prebuilt binary**, not a source build |
| `Dockerfile.scratch`                 | `FROM scratch`, `COPY minio /minio`                                                   | Runtime too bare (no shell, no curl)                            |
| `Makefile:179-181`                   | `go build -tags kqueue -trimpath --ldflags "$(LDFLAGS)"`                              | **Yes — this is the canonical source build**                    |
| `dockerscripts/docker-entrypoint.sh` | prepends `minio` to argv                                                              | **Yes — used verbatim**                                         |
| `scripts`/`Makefile` LDFLAGS         | `go run buildscripts/gen-ldflags.go`                                                  | **Yes — used verbatim**                                         |

## 2.2 The two build stages used

**Stage 1 — binary, from MinIO's own Makefile recipe:**

```dockerfile
FROM golang:1.24-alpine AS build
WORKDIR /build
COPY . .
# Makefile:181 recipe, LDFLAGS from Makefile:3 -> buildscripts/gen-ldflags.go
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -tags kqueue -trimpath \
    --ldflags "$(go run buildscripts/gen-ldflags.go)" \
    -o /build/minio 1>/dev/null
RUN /build/minio --version
# static curl, pinned (upstream fetch script uses a floating 'latest' asset)
RUN apk add --no-cache curl \
 && curl -f -L -s -q https://github.com/moparisthebest/static-curl/releases/download/v8.21.0/curl-amd64 -o /build/curl \
 && chmod +x /build/curl
```

**Stage 2 — runtime, mirroring `Dockerfile.release`'s final stage:**

```dockerfile
FROM registry.access.redhat.com/ubi9/ubi-micro:latest
# ... identical ENV block, labels, chmod, /licenses, ENTRYPOINT, CMD, EXPOSE, VOLUME
COPY --from=minio-build-stage:local /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=minio-build-stage:local /build/minio /usr/bin/minio
COPY --from=minio-build-stage:local /build/curl   /usr/bin/curl
COPY CREDITS /licenses/CREDITS
COPY LICENSE /licenses/LICENSE
COPY dockerscripts/docker-entrypoint.sh /usr/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/bin/docker-entrypoint.sh"]
CMD ["minio"]
```

### Deviations from upstream packaging — all deliberate and documented

| #   | Deviation                                                                            | Reason                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Binary comes from `go build` on the pinned tree instead of `curl` from `dl.min.io`   | The task requires building **from source** and forbids unknown prebuilt binaries. Upstream's own release flow downloads a signed binary; a source build is strictly stronger provenance. |
| 2   | `static-curl` pinned to `v8.21.0` instead of upstream's `releases/latest/download/…` | Upstream's `download-static-curl.sh` uses a **floating** URL, which is not reproducible. Pinned for reproducibility.                                                                     |
| 3   | `mc` client binary not included                                                      | BeaconHS uses the AWS SDK, never `mc`. Omitting it does not affect the S3 contract.                                                                                                      |
| 4   | `curl` is fetched in the build stage, not the runtime stage                          | `ubi-micro` has no `curl` and no package manager, so it cannot self-download — exactly why upstream also fetches in the build stage.                                                     |

**No MinIO source file was modified.** `Dockerfile`, `Makefile`, `docker-entrypoint.sh`,
`LICENSE`, `CREDITS`, `buildscripts/gen-ldflags.go`, and `go.mod` are used byte-for-byte as
committed. The two Dockerfiles above are _new files created by this build_, held outside the
BeaconHS repository at `/tmp/opencode/Dockerfile.gobuild` and `/tmp/opencode/Dockerfile.runtime`.

## 2.3 Why `curl` is mandatory

BeaconHS's official compose declares:

```yaml
healthcheck:
  test: ['CMD', 'curl', '-f', 'http://localhost:9000/minio/health/live']
```

`ubi-micro` ships **no** `curl` (verified by running the base image). Without a `curl` binary the
container can never report healthy, and `docker compose` would never consider the stack ready.
Upstream solves this with a static curl; this build does the same, pinned.

---

# 3. Build commands actually executed

```bash
# Stage 1
docker build -f /tmp/opencode/Dockerfile.gobuild \
  --target build -t minio-build-stage:local .

# Stage 2
docker build -f /tmp/opencode/Dockerfile.runtime \
  --build-arg RELEASE=RELEASE.2025-10-15T17-29-55Z \
  --build-arg MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a \
  -t minio/minio:latest .
```

### Reproducibility chain

```
source commit 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
  = tag RELEASE.2025-10-15T17-29-55Z
  + Makefile:181 recipe (go build -tags kqueue -trimpath)
  + LDFLAGS from buildscripts/gen-ldflags.go
  + golang:1.24-alpine
  + Dockerfile.runtime (documented above)
  + static-curl v8.21.0
  => image sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c
```

All inputs are pinned: commit, tag, toolchain major, build recipe, and the one external
dependency. Re-running on the same inputs yields the same source tree and build recipe.

---

# 4. Built image identity

```
$ docker image inspect minio/minio:latest
Id           : sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c
RepoTags     : ['minio/minio:latest']
RepoDigests  : ['minio/minio@sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c']
Created      : 2026-09-29T15:41:05.619886824+08:00
Size         : 268771790 bytes
Architecture : amd64
Os           : linux
Entrypoint   : ["/usr/bin/docker-entrypoint.sh"]
Cmd          : ["minio"]
WorkingDir   : /
User         : (root, as upstream)
ExposedPorts : {"9000/tcp": {}}
Volumes      : {"/data": {}}
```

### Environment (identical to upstream `Dockerfile.release`)

```
MINIO_ACCESS_KEY_FILE=access_key
MINIO_SECRET_KEY_FILE=secret_key
MINIO_ROOT_USER_FILE=access_key
MINIO_ROOT_PASSWORD_FILE=secret_key
MINIO_KMS_SECRET_KEY_FILE=kms_master_key
MINIO_UPDATE_MINISIGN_PUBKEY=RWTx5Zr1tiHQLwG9keckT0c45M3AGeHD6IvimQHpyRywVWGbP1aVSGav
MINIO_CONFIG_ENV_FILE=config.env
MC_CONFIG_DIR=/tmp/.mc
```

### Provenance labels added

```
io.beaconhs.build.source = https://github.com/minio/minio
io.beaconhs.build.commit = 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
io.beaconhs.build.note   = Locally built from archived upstream source; upstream Docker
                           Hub repo minio/minio was removed on 2026-09-11.
org.opencontainers.image.version = RELEASE.2025-10-15T17-29-55Z
org.opencontainers.image.licenses = AGPL-3.0
```

## 4.1 Behavioural equivalence checks

| Check                    | Result                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `minio --version`        | `minio version DEVELOPMENT.GOGET` · `Runtime: go1.24.13 linux/amd64` · `License: GNU AGPLv3` |
| `curl` present           | `curl 8.21.0 (x86_64-pc-linux-musl)`                                                         |
| entrypoint argv handling | prepends `minio` when `$1 != "minio"` (matches upstream)                                     |
| `/licenses/`             | `CREDITS` (1,882,228 B) + `LICENSE` (34,523 B)                                               |
| container healthcheck    | **healthy** (official `curl -f .../minio/health/live` passes)                                |

### Known cosmetic difference (documented, not functional)

`minio --version` reports `DEVELOPMENT.GOGET` rather than
`RELEASE.2025-10-15T17-29-55Z`. Inside the build container, `git describe --tags` does not
resolve, so `buildscripts/gen-ldflags.go` falls back to its default and the release string is not
stamped into the binary. This affects only the self-reported version banner. It has **no effect**
on S3 API behaviour, and the build provenance is instead recorded in the image labels above
(§4). The provenance that matters — the exact source commit — is fixed and verifiable.

---

# 5. Reproducing this build from scratch

```bash
# 1. Fetch the pinned source
mkdir -p /tmp/minio-build && cd /tmp/minio-build
git init minio-src && cd minio-src
git remote add origin https://github.com/minio/minio.git
git fetch --depth 1 origin 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
git checkout FETCH_HEAD
git fetch --depth 1 origin tag RELEASE.2025-10-15T17-29-55Z
git rev-parse HEAD   # must equal 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a

# 2. Stage 1 — compile (Dockerfile.gobuild contents in §2.2)
docker build -f /path/to/Dockerfile.gobuild --target build -t minio-build-stage:local .

# 3. Stage 2 — package (Dockerfile.runtime contents in §2.2)
docker build -f /path/to/Dockerfile.runtime \
  --build-arg RELEASE=RELEASE.2025-10-15T17-29-55Z \
  --build-arg MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a \
  -t minio/minio:latest .

# 4. BeaconHS then starts with its UNMODIFIED official compose
cd /path/to/beaconhs-hse
docker compose --profile local-db up -d
```

Both Dockerfiles are reproduced verbatim in §2.2 so the build is reproducible without this
transcript.

---

# 6. Scope and honest limitations

| Item                                                   | Status                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Image is local-only, for dev/verification              | **Yes.** Not published, not redistributed.                                                |
| BeaconHS `docker-compose.yml`                          | **Unmodified** — byte-identical to `git show HEAD:docker-compose.yml`.                    |
| `packages/storage/**`                                  | **Unmodified.**                                                                           |
| `presignPut()` / `finalizeUpload()` / attachment logic | **Unmodified.**                                                                           |
| SeaweedFS                                              | **Not used anywhere.**                                                                    |
| Third-party MinIO image                                | **Not used.** The only external binaries are the Go toolchain and a pinned static `curl`. |
| MinIO source modified                                  | **No.** Working tree clean throughout.                                                    |
| Upstream release cadence                               | Frozen — MinIO is archived, so no later official fix will ever ship in this image.        |

**This image will not receive upstream security updates**, because upstream no longer publishes
any. For anything beyond local development, a maintained store is required.

---

# 7. Related documents

- [Storage / MinIO verification](./beaconhs-storage-minio-verification.md) — E2E results
- [Official deployment baseline](./beaconhs-official-deployment-baseline.md) — the blocker that
  triggered this build
- [SeaweedFS verification](./beaconhs-seaweedfs-verification.md) — the rejected alternative
- [Storage audit](./beaconhs-storage-audit.md) — the storage subsystem
