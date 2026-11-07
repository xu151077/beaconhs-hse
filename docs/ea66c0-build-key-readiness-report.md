# EA-66C.0 — Server Action encryption key preparation and formal build preflight

**Phase type:** key preparation and prebuild authorization check.
**Verdict:** **KEY BLOCKED.** No formal key exists; no application image was
built.
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. Verdict

| Question                                  | Answer                  |
| ----------------------------------------- | ----------------------- |
| `/tmp/beaconhs-server-action-key` exists? | **NO**                  |
| Formal key generated?                     | **NO — not authorized** |
| Temporary key used?                       | **NO**                  |
| Key printed or stored in evidence?        | **NO**                  |
| Key fingerprint recorded?                 | **NONE**                |
| Image prerequisites                       | **READY**               |
| Source archive                            | **VERIFIED**            |
| Deployment id                             | **VERIFIED**            |
| Build script                              | **VERIFIED**            |
| Gate 5 source check                       | **VERIFIED (opt-in)**   |
| Formal application image build            | **NOT RUN**             |
| EA-66C.1                                  | **BLOCKED**             |

---

## 2. Repository protection

Recorded before any EA-66C.0 artifact was written:

| Item               | Value                                          |
| ------------------ | ---------------------------------------------- |
| Branch             | `hse-platform`                                 |
| HEAD               | `51a899b7aac0a942da327222a3eed355fca9798a`     |
| Staged             | 0                                              |
| Modified           | 165                                            |
| Untracked          | 548                                            |
| `git diff --check` | exit 0                                         |
| EA-66A evidence    | 62/62 verified                                 |
| EA-66A.1 evidence  | 31/31 verified                                 |
| EA-66B evidence    | 46/46 verified                                 |
| EA-66B.1 evidence  | 39/39 verified                                 |
| EA-66B.2 evidence  | 29/29 verified                                 |
| EA-66B.3 evidence  | 15/15 verified                                 |
| EA-66B.5 evidence  | 17/17 verified                                 |
| `.env`             | present, mode 664, 576 bytes; content not read |

No repository file was changed. Only `docs/ea66c0-build-key-readiness-report.md` and
`docs/evidence/ea66c0/` were added. No protected file was modified.

---

## 3. Key status

`/tmp/beaconhs-server-action-key` is missing. No formal key was generated, read,
printed or stored. The build entry point exits 2 before any build when this file
is absent.

The authorized procedure is documented in
`docs/evidence/ea66c0/key-status.md` and uses `openssl rand -base64 32` into a
mode-0600 file outside the repository. Only the 32-hex HMAC fingerprint may be
recorded. No key material is in this report or its evidence.

---

## 4. Build prerequisites

All image, source, script and Gate 5 prerequisites are satisfied:

| Item                             | Status                                                |
| -------------------------------- | ----------------------------------------------------- |
| Node base exact digest           | VERIFIED                                              |
| Dockerfile frontend exact digest | VERIFIED                                              |
| PostgreSQL exact digest          | VERIFIED                                              |
| Redis exact digest               | VERIFIED                                              |
| Collabora exact digest           | VERIFIED                                              |
| MinIO local exact digest         | VERIFIED                                              |
| Source archive SHA-256           | VERIFIED — `927062b6…`                                |
| Deployment id                    | VERIFIED — `406f0c00d0e42bc1e578acf0e5af86b14bd7e175` |
| `BUILD_EVIDENCE_DIR`             | VERIFIED                                              |
| Build script guards              | PASS                                                  |
| Server Action secret mechanism   | PASS                                                  |
| Formal Server Action key         | **BLOCKED**                                           |
| Disk space / platform            | PASS                                                  |

---

## 5. Build script verification

`scripts/build-local-image-with-key-gate.sh` was rechecked. It requires the key
file, enforces mode 0600, rejects a key inside the repository, injects the key
through a required BuildKit secret, binds the key fingerprint into the cache key,
extracts and verifies the source archive, derives the deployment id, builds from
the extracted context, sets and verifies image labels, reads the embedded
Next.js deploymentId, scans build log/config/history for the key, and runs the
shared key gate. It does not use ARG or ENV for the key.

---

## 6. Tests and gates

| Check                                           | Result                      |
| ----------------------------------------------- | --------------------------- |
| `source-deployment-id.test.mjs`                 | 10/10 PASS                  |
| `source-identity-wiring.test.mjs`               | 5/5 PASS                    |
| `build-context-guard.test.mjs`                  | 2/2 PASS                    |
| `buildkit-secret-isolation.test.mjs`            | 1/1 PASS                    |
| `compose-deployment-gate.test.mjs`              | 97/97 PASS                  |
| `server-action-key-handling.test.mjs`           | 6/6 PASS                    |
| `build-identity-gate.test.mjs`                  | 31/31 PASS                  |
| `server-action-key-deployment-contract.test.ts` | 17/17 PASS                  |
| `pnpm format:check`                             | exit 0                      |
| `pnpm typecheck --force`                        | exit 0 — 27/27, `Cached: 0` |
| `pnpm lint --force`                             | exit 0 — 1/1, `Cached: 0`   |
| `pnpm deadcode:check`                           | exit 0                      |
| `pnpm turbo run test --force --concurrency=1`   | exit 0 — 25/25, `Cached: 0` |
| `pnpm build --force`                            | exit 0 — 4/4, `Cached: 0`   |
| `git diff --check`                              | exit 0                      |

---

## 7. Unauthorized pull disclosure

EA-66B.2's `docker build --check` downloaded
`docker/dockerfile:1.8.1@sha256:e87caa74…` into the build cache. EA-66C.0 did
not repeat this. The cache record remains; no prune was performed.

---

## 8. Remaining work

1. User authorizes generation of a formal 32-byte Server Action key, or supplies
   an authorized key file.
2. Place it in a mode-0600 file outside the repository.
3. Run the full key-gate shell acceptance test in an environment with the base
   images.
4. Build one `linux/amd64` application image from the verified archive with
   `BUILD_EVIDENCE_DIR` set.
5. Read back and record image ID, platform, deploymentId, labels, digests, key
   fingerprint, build log and SBOM.
6. Run Gate 5 with `--source-deployment-id`.
7. Only then consider EA-66C packaging.

---

## 9. State ledger

| Item                        | Status                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| EA-66A                      | **PARTIAL** — preserved                                             |
| EA-66A.1                    | **COMPLETE** — preserved                                            |
| EA-66B                      | **PREBUILD BLOCKED**                                                |
| EA-66B.1                    | **BLOCKED on image prerequisites; source-identity fix implemented** |
| EA-66B.2                    | **PARTIAL — no image recovered**                                    |
| EA-66B.3                    | **COMPLETE — audit only; no reusable image**                        |
| EA-66B.5                    | **IMAGE PREREQUISITES READY; formal build blocked on key**          |
| EA-66C.0                    | **KEY BLOCKED**                                                     |
| GHCR as deployment source   | **NOT USED**                                                        |
| External Docker image pull  | **PROHIBITED** (one unauthorized cache pull disclosed)              |
| Production                  | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**                   |
| Rollback                    | **FAIL — NO EXECUTABLE ROLLBACK PATH**                              |
| A1–A8                       | **PENDING AUTHORIZATION**                                           |
| Migration 51                | **NOT RUN**                                                         |
| DB / Object Storage restore | **NOT RUN**                                                         |
| WOPI                        | **PAUSED**                                                          |

---

## 10. Evidence index

| File                     | Contents                                                       |
| ------------------------ | -------------------------------------------------------------- |
| `key-status.md`          | key file metadata and authorized generation procedure          |
| `build-prerequisites.md` | image, source, script and Gate 5 checks                        |
| `prebuild-check.md`      | item-by-item preflight                                         |
| `raw/`                   | baseline, key check, allowed verify, tests, gates, final state |
| `SHA256SUMS`             | hashes of every evidence file except itself                    |

Verify:

```bash
cd docs/evidence/ea66c0 && sha256sum -c SHA256SUMS
```
