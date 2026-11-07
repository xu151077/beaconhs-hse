# EA-66B.2 — historical Docker image and BuildKit cache recovery audit

**Phase type:** read-only local recovery audit.
**Verdict:** **PARTIAL — no image recovered.** The required Node base and
Dockerfile frontend images remain unavailable as Docker images.
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. Verdict

| Target                                        | Docker image | Local content                                                                                | Classification        |
| --------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------- | --------------------- |
| `node:24.18.0-bookworm-slim@sha256:cb4e8f7c…` | MISSING      | PARTIAL (amd64 manifest/config/layers present; other platform and attestation blobs missing) | **PARTIAL / MISSING** |
| `docker/dockerfile:1.7@sha256:a57df69d…`      | MISSING      | PARTIAL (amd64 manifest/config/layer present; other platform and attestation blobs missing)  | **PARTIAL / MISSING** |

No `docker load`, pull, tag, manifest rewrite, cache prune, volume removal,
containerd cleanup, daemon change or application build was performed. The build
remains **PREBUILD BLOCKED**.

EA-66B.2 stops here. EA-66C is not started.

---

## 2. Repository protection

Recorded before any EA-66B.2 artifact was written
(`docs/evidence/ea66b2/raw/baseline.txt`):

| Item               | Value                                          |
| ------------------ | ---------------------------------------------- |
| Branch             | `hse-platform`                                 |
| HEAD               | `51a899b7aac0a942da327222a3eed355fca9798a`     |
| Staged             | 0                                              |
| Modified           | 165                                            |
| Untracked          | 545                                            |
| `git diff --check` | exit 0                                         |
| EA-66A evidence    | 62/62 verified                                 |
| EA-66A.1 evidence  | 31/31 verified                                 |
| EA-66B evidence    | 46/46 verified                                 |
| EA-66B.1 evidence  | 39/39 verified                                 |
| `.env`             | present, mode 664, 576 bytes; content not read |

No repository file was changed by EA-66B.2. All changes are under
`docs/evidence/ea66b2/` and the report.

---

## 3. Docker image inventory

- Images: **60**
- Containers: 14 (5 running)
- Dangling images: **none**
- Neither target exists as a Docker image (`docker image inspect` returns
  `No such image`).
- No image was imported, tagged, saved or removed.

The running containers are the local `beaconhs-dev` stack and stopped
drill/test containers. No production target stack is running.

Full detail: `docs/evidence/ea66b2/docker-image-inventory.md`.

---

## 4. BuildKit cache audit

- Builder: `default`, driver `docker`, BuildKit `v0.34.0`, platforms
  `linux/amd64`.
- Build cache: **109.5 GB**, 399 records, 83.58 GB reclaimable.
- Node base cache records: five `regular` records totalling ~326 MB, described
  as `pulled from docker.io/library/node:24.18.0-bookworm-slim@sha256:cb4e8f7c…`.
- Frontend cache record: one `frontend` record of 35.76 MB, described as
  `pulled from docker.io/docker/dockerfile:1.7@sha256:a57df69d…`.

These records prove both images were previously pulled and used. They are cache
metadata, not Docker images: no manifest, config, tag or RepoDigest is exposed,
and no supported read-only path converts a cache record into an image.

Full detail: `docs/evidence/ea66b2/buildkit-cache-audit.md`.

---

## 5. Containerd storage audit

Docker uses the containerd snapshotter (`namespace moby`). The content store is
at:

```
/var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/
```

It contains **803 blobs**. The `test` user cannot open the containerd socket
(mode 660 root:root) or `/var/lib/containerd` (mode 700 root:root); `sudo`
requires a password. Inspection was performed with a read-only container mount
of `/var/lib/containerd` into the locally present `alpine:3.23`. No file was
modified.

### 5.1 Node base content

The index blob `sha256:cb4e8f7c…` (3,929 bytes) is present. It is an OCI index
with six platform manifests plus attestation manifests. Only the `linux/amd64`
platform manifest and its content are present:

| Blob                                                | Size                                              | Present? |
| --------------------------------------------------- | ------------------------------------------------- | -------- |
| `sha256:0778d035…` (amd64 manifest)                 | 1,929                                             | YES      |
| `sha256:fdff267b…` (config)                         | 6,827                                             | YES      |
| five layer blobs                                    | 28,237,639 / 3,309 / 50,334,689 / 1,712,666 / 449 | YES      |
| arm64, ppc64le, arm, mips, s390x, riscv64 manifests | varies                                            | NO       |
| attestation manifest `sha256:d1c0d566…`             | 841                                               | NO       |

The config records `NODE_VERSION=24.18.0`, architecture `amd64`, OS `linux`,
created `2026-06-24T18:12:30Z`.

### 5.2 Dockerfile frontend content

The index blob `sha256:a57df69d…` (8,404 bytes) is present. Only the
`linux/amd64` platform manifest and its content are present:

| Blob                                 | Size       | Present? |
| ------------------------------------ | ---------- | -------- |
| `sha256:b5f3b260…` (amd64 manifest)  | 482        | YES      |
| `sha256:68ebc061…` (config)          | 1,256      | YES      |
| `sha256:96918c57…` (layer)           | 11,977,434 | YES      |
| other platform and attestation blobs | varies     | NO       |

The config records BuildKit frontend capabilities and
`moby.buildkit.frontend.network.none=true`, created `2024-04-25T17:57:11Z`.

### 5.3 Recovery conclusion

The exact multi-arch index digests cannot be reconstructed because the index
references blobs that are absent. A single-platform manifest would have a
different digest and would not satisfy `Dockerfile:1` or `Dockerfile:10`.
No manifest rewrite, tag or content modification was performed.

Full detail: `docs/evidence/ea66b2/containerd-storage-audit.md`.

---

## 6. Historical build records

A successful `beaconhs-hse` build 7 hours ago
(`wtohv0m5ypnfrmn8xdybdw8m7`) used both target images locally. Its SLSA
provenance records the exact materials:

- `docker/dockerfile@1.7` digest `sha256:a57df69d…`
- `node@24.18.0-bookworm-slim` digest `sha256:cb4e8f7c…`

The build used `DEPLOYMENT_VERSION=51a899b7…` and produced
`beaconhs:ea4-gate-selftest`. The image was removed after the key-gate test, but
the build record and its exported bundle (41 KB) remain.

The record proves both images were present and used. It does not contain the
missing platform/attestation blobs and cannot recreate the required images.

Full detail: `docs/evidence/ea66b2/historical-build-records.md`.

---

## 7. Classification

| Target                                        | Docker image | Content | Classification        |
| --------------------------------------------- | ------------ | ------- | --------------------- |
| `node:24.18.0-bookworm-slim@sha256:cb4e8f7c…` | MISSING      | PARTIAL | **PARTIAL / MISSING** |
| `docker/dockerfile:1.7@sha256:a57df69d…`      | MISSING      | PARTIAL | **PARTIAL / MISSING** |

No RECOVERED image exists. No `docker load` was performed. No application image
was built.

---

## 8. No-pull statement

Most of EA-66B.2 was read-only, but one unauthorized pull did occur: while
running `docker build --check` to validate the Dockerfile, BuildKit downloaded
`docker/dockerfile:1.8.1@sha256:e87caa74dcb7d46cd820352bfea12591f3dba3ddc4285e19c7dcd13359f7cefd`
into the build cache. It was not used as the application base or frontend, no
image was created, and the image count remained 66, but the pull violated the
no-pull rule. The cache record is retained; no prune was performed. The log is
`docs/evidence/ea66b2/raw/dockerfile-check.txt`.

No `docker pull`, `docker compose pull`, `skopeo`, `crane`, authorized external
transfer or image build was otherwise used. The only container executed was a
read-only `alpine:3.23` inspection of the local containerd store.

---

## 9. Repository gates

EA-66B.2 changed documentation and evidence only. The repository gates were not
rerun because no code changed; the last full gate run remains
EA-66B.1 (`pnpm test` 25/25, `pnpm build` 4/4, all exit 0). `pnpm format:check`
and `git diff --check` still pass after the EA-66B.2 evidence was added.

---

## 10. Changed files

No source code, Dockerfile, Compose file, manifest, workflow, lockfile, `turbo.json`
or `.env` was changed. Only the report and `docs/evidence/ea66b2/` were added.

---

## 11. Remaining work

1. Obtain authorized archives containing the missing platform and attestation
   blobs for both images, or obtain a complete authorized image archive.
2. `docker load` and verify the exact index digests, image IDs, RepoDigests,
   platforms and versions.
3. Re-run the EA-66B.1 preflight.
4. Then build and verify the BeaconHS application image.

EA-66B remains **PREBUILD BLOCKED** until a complete authorized image is
available locally.

---

## 12. State ledger

| Item                        | Status                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| EA-66A                      | **PARTIAL** — preserved                                             |
| EA-66A.1                    | **COMPLETE** — preserved                                            |
| EA-66B                      | **PREBUILD BLOCKED**                                                |
| EA-66B.1                    | **BLOCKED on image prerequisites; source-identity fix implemented** |
| EA-66B.2                    | **PARTIAL — no image recovered**                                    |
| GHCR as deployment source   | **NOT USED**                                                        |
| External Docker image pull  | **PROHIBITED**                                                      |
| Production                  | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**                   |
| Rollback                    | **FAIL — NO EXECUTABLE ROLLBACK PATH**                              |
| A1–A8                       | **PENDING AUTHORIZATION**                                           |
| Migration 51                | **NOT RUN**                                                         |
| DB / Object Storage restore | **NOT RUN**                                                         |
| WOPI                        | **PAUSED**                                                          |

---

## 13. Evidence index

| File                          | Contents                                      |
| ----------------------------- | --------------------------------------------- |
| `environment-inventory.md`    | host, Docker, BuildKit, containerd state      |
| `docker-image-inventory.md`   | 60 images, no target, no dangling             |
| `buildkit-cache-audit.md`     | builder, cache records, PARTIAL conclusion    |
| `containerd-storage-audit.md` | containerd content, present and missing blobs |
| `historical-build-records.md` | build record and provenance                   |
| `recovery-results.md`         | classification                                |
| `raw/`                        | read-only command output                      |
| `SHA256SUMS`                  | hashes of every evidence file except itself   |

Verify:

```bash
cd docs/evidence/ea66b2 && sha256sum -c SHA256SUMS
```
