# EA-66B.3 — historical build artifact audit

**Phase type:** read-only historical build artifact audit.
**Verdict:** **NO REUSABLE IMAGE.** The historical BeaconHS application images
and the BuildKit cache do not satisfy EA-66B.1's source-identity, deployment-id
or security requirements.
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. Verdict

| Question                                              | Answer                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Does a historical BeaconHS app image exist?           | **NO usable image.** `beaconhs:ea4-gate-selftest` is absent. |
| Does any image carry EA-66B.1 source labels?          | **NO**                                                       |
| Does any image use the archive-derived deployment id? | **NO**                                                       |
| Is any image reusable as a release candidate?         | **NO**                                                       |
| Is the historical build record genuine?               | **YES**                                                      |
| Is the historical provenance usable for EA-66B.1?     | **NO** — it names Git HEAD, not the source archive           |
| SBOM                                                  | **MISSING**                                                  |
| Signature                                             | **NOT SIGNED**                                               |
| Any image pulled?                                     | **NO**                                                       |
| Any image built or removed?                           | **NO**                                                       |

EA-66B remains **PREBUILD BLOCKED**. EA-66C is not started.

---

## 2. Repository protection

Recorded before any EA-66B.3 artifact was written:

| Item               | Value                                          |
| ------------------ | ---------------------------------------------- |
| Branch             | `hse-platform`                                 |
| HEAD               | `51a899b7aac0a942da327222a3eed355fca9798a`     |
| Staged             | 0                                              |
| Modified           | 165                                            |
| Untracked          | 546                                            |
| `git diff --check` | exit 0                                         |
| EA-66A evidence    | 62/62 verified                                 |
| EA-66A.1 evidence  | 31/31 verified                                 |
| EA-66B evidence    | 46/46 verified                                 |
| EA-66B.1 evidence  | 39/39 verified                                 |
| EA-66B.2 evidence  | 29/29 verified                                 |
| `.env`             | present, mode 664, 576 bytes; content not read |

No repository file was changed. Only `docs/ea66b3-historical-build-artifact-audit.md`
and `docs/evidence/ea66b3/` were added.

---

## 3. Historical build record

`docker buildx history inspect wtohv0m5ypnfrmn8xdybdw8m7` shows:

- builder: default
- build id: `wtohv0m5ypnfrmn8xdybdw8m7`
- context: `.`
- Dockerfile: `Dockerfile`
- VCS repository: `https://github.com/xu151077/beaconhs-hse.git`
- VCS revision: `51a899b7aac0a942da327222a3eed355fca9798a`
- image-resolve-mode: `local`
- build args:
  - `DEPLOYMENT_VERSION=51a899b7aac0a942da327222a3eed355fca9798a`
  - `NEXT_PUBLIC_SENTRY_DSN=`
  - `NEXT_SERVER_ACTIONS_KEY_FINGERPRINT=8b98a636e6ddb018c0c7aef510b80cbd`
- secret: `next_server_actions_key`
- output name: `docker.io/library/beaconhs:ea4-gate-selftest`
- output index digest: `sha256:31418a1b1d95477f4ceee4c123a596f98a5855a3bdfd2f7e6b2eae34948bdc7f`
- platform manifest digest: `sha256:86c10622880a2a5ac118e76f93903379b43547470d1031d82c1e1dd4be25a8da`
- config digest: `sha256:4153feb44d2b4f424ea57010eb3a3122bb02a5749101a8213f6708b4fa53000b`
- materials:
  - `docker/dockerfile@1.7` digest `sha256:a57df69d…`
  - `node@24.18.0-bookworm-slim` digest `sha256:cb4e8f7c…`
- attestation: SLSA provenance v1 (`3c74d72cc9fb…`, 104,886 bytes)
- SBOM: **none**

The build log is still readable and was saved as
`docs/evidence/ea66b3/raw/build-record-inspect.txt`.

---

## 4. Historical BeaconHS image audit

All images whose repository contains `beaconhs` were inspected read-only. No
image was started, tagged, saved, modified or removed.

- **No image** carries `com.beaconhs.deployment-id`,
  `com.beaconhs.source-archive-sha256` or `com.beaconhs.git-head`.
- 8 recent large app images embed `.next/config.deploymentId = 51a899b7…`.
- 5 large app images embed no `deploymentId` at all (the EA-16 defect).
- No scanned image has `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` in its config
  environment.
- No scanned image's config or history contains a key-like string.
- `beaconhs:ea4-gate-selftest` (the build record's output) is absent; it was
  removed by the key-gate test.
- An untagged image `sha256:be54cfce2a45…` (2.87 GB, 4 days old) is present
  but has no labels and no embedded identity.

No image meets the EA-66B.1 source-identity or label requirements.

Full detail: `docs/evidence/ea66b3/historical-image-audit.md` and
`docs/evidence/ea66b3/raw/beaconhs-image-audit.json`.

---

## 5. Reuse classification

| Image / artifact                                             | Classification                 | Reason                                                                     |
| ------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------- |
| Build record `wtohv0m5ypnfrmn8xdybdw8m7`                     | **REAL BUILD EVIDENCE**        | Genuine record, provenance, log and output metadata; output image is gone. |
| SLSA provenance in that record                               | **REAL, BUT FOR OLD IDENTITY** | Names Git HEAD `51a899b7…`, not the EA-66B source archive.                 |
| `beaconhs:ea4-gate-selftest`                                 | **MISSING**                    | Built 7 hours ago and removed by the key-gate test.                        |
| Historical app images with embedded `deploymentId=51a899b7…` | **NOT REUSABLE**               | Old HEAD-derived identity; no source-archive label or archive hash.        |
| Historical app images with no `deploymentId`                 | **NOT REUSABLE**               | EA-16 defect; no source identity.                                          |
| Historical app images generally                              | **NOT REUSABLE**               | No EA-66B.1 labels; no source-archive link; no Gate 5 source check.        |
| `beaconhs:prod-verify`                                       | **NOT REUSABLE**               | No labels; no embedded identity verification.                              |
| `beaconhs:dr-mirror-51a899b7`                                | **NOT REUSABLE**               | Mirror image; no source-archive label.                                     |
| `ea46-tsprobe-1`                                             | **NOT REUSABLE**               | Probe image; no source identity.                                           |
| Containerd amd64 content                                     | **PARTIAL**                    | Manifest/config/layers present, but exact index not reconstructable.       |
| BuildKit cache records                                       | **PARTIAL**                    | Evidence of prior pulls, not images.                                       |
| SBOM                                                         | **MISSING**                    | No SBOM was generated.                                                     |
| Signature                                                    | **NOT SIGNED**                 | No signing key or signature exists.                                        |

No REUSABLE image exists. The only path to a release candidate is a new build
from an authorized local base image and the verified source archive.

Full detail: `docs/evidence/ea66b3/reuse-classification.md`.

---

## 6. Security check

- No scanned image has `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` in its config
  environment.
- No scanned image's config or history contains a key-like string.
- No key value was printed or stored in the audit.
- The historical key fingerprint `8b98a636e6ddb018c0c7aef510b80cbd` is recorded
  as metadata only; it is not the current key and is not used to authorize a
  release.

---

## 7. No-pull statement

No Docker image was obtained in EA-66B.3. EA-66B.2 disclosed one unauthorized
`docker/dockerfile:1.8.1` cache pull from `docker build --check`; EA-66B.3
added no pull. No `docker pull`, `docker compose pull`, `docker build`,
`docker buildx build`, `docker load`, `docker save`, `docker tag`,
`docker commit`, registry proxy or image prune was used. The only container
executed was the read-only `alpine:3.23` inspection of the local containerd
store in EA-66B.2.

---

## 8. Repository gates

EA-66B.3 changed documentation and evidence only. No code, Dockerfile, Compose
file, manifest, lockfile, `turbo.json` or `.env` was changed. The repository
gates were not rerun because no code changed; the last full gate run remains
EA-66B.1 (`pnpm test` 25/25, `pnpm build` 4/4, all exit 0). `pnpm format:check`
and `git diff --check` still pass after the EA-66B.3 evidence was added.

---

## 9. Changed files

No source code was changed. Only the report and `docs/evidence/ea66b3/` were
added.

---

## 10. Remaining work

1. Obtain authorized local archives for the exact Node base and Dockerfile
   frontend images.
2. Verify them with `docker load` + `docker image inspect`.
3. Build one `linux/amd64` application image from the verified archive with
   `BUILD_EVIDENCE_DIR` set.
4. Read back and record image ID, platform, deploymentId, labels, digests, key
   fingerprint, build log and SBOM.
5. Run Gate 5 with `--source-deployment-id`.
6. Only then consider EA-66C packaging.

EA-66B remains **PREBUILD BLOCKED**. EA-66C is not started.

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
| GHCR as deployment source   | **NOT USED**                                                        |
| External Docker image pull  | **PROHIBITED**                                                      |
| Production                  | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**                   |
| Rollback                    | **FAIL — NO EXECUTABLE ROLLBACK PATH**                              |
| A1–A8                       | **PENDING AUTHORIZATION**                                           |
| Migration 51                | **NOT RUN**                                                         |
| DB / Object Storage restore | **NOT RUN**                                                         |
| WOPI                        | **PAUSED**                                                          |

---

## 12. Evidence index

| File                        | Contents                                                     |
| --------------------------- | ------------------------------------------------------------ |
| `environment-inventory.md`  | Docker/BuildKit/containerd state and historical build record |
| `build-record-audit.md`     | build record, provenance, SBOM, log                          |
| `historical-image-audit.md` | label, embedded identity and key-leak audit                  |
| `reuse-classification.md`   | reuse classification                                         |
| `sbom-provenance-status.md` | SBOM and signature status                                    |
| `raw/`                      | read-only command output and audit JSON                      |
| `SHA256SUMS`                | hashes of every evidence file except itself                  |

Verify:

```bash
cd docs/evidence/ea66b3 && sha256sum -c SHA256SUMS
```
