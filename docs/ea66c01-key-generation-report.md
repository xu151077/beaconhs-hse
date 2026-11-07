# EA-66C.0.1 — Server Action encryption key generation and verification

**Phase type:** authorized key generation and prebuild verification.
**Verdict:** **KEY READY.** No application image was built.
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-30 (UTC)

---

## 1. Verdict

| Question                                  | Answer                                          |
| ----------------------------------------- | ----------------------------------------------- |
| `/tmp/beaconhs-server-action-key` exists? | **YES**                                         |
| Formal key generated?                     | **YES — authorized**                            |
| Temporary key used?                       | **NO**                                          |
| Key printed or stored in evidence?        | **NO**                                          |
| Key fingerprint                           | `f61da7728f3065df58f9e89aec6985d6`              |
| Key permission                            | **PASS** — mode 0600, 32 bytes                  |
| Key isolation                             | **PASS**                                        |
| Image prerequisites                       | **READY**                                       |
| Source archive                            | **VERIFIED**                                    |
| Deployment id                             | **VERIFIED**                                    |
| Formal application image build            | **NOT RUN**                                     |
| EA-66C.1                                  | **READY to start after explicit authorization** |

---

## 2. Repository protection

Recorded before any EA-66C.0.1 artifact was written:

| Item               | Value                                          |
| ------------------ | ---------------------------------------------- |
| Branch             | `hse-platform`                                 |
| HEAD               | `51a899b7aac0a942da327222a3eed355fca9798a`     |
| Staged             | 0                                              |
| Modified           | 165                                            |
| Untracked          | 549                                            |
| `git diff --check` | exit 0                                         |
| EA-66A evidence    | 62/62 verified                                 |
| EA-66A.1 evidence  | 31/31 verified                                 |
| EA-66B evidence    | 46/46 verified                                 |
| EA-66B.1 evidence  | 39/39 verified                                 |
| EA-66B.2 evidence  | 29/29 verified                                 |
| EA-66B.3 evidence  | 15/15 verified                                 |
| EA-66B.5 evidence  | 17/17 verified                                 |
| EA-66C.0 evidence  | 23/23 verified                                 |
| `.env`             | present, mode 664, 576 bytes; content not read |

No repository file was changed. Only `docs/ea66c01-key-generation-report.md` and
`docs/evidence/ea66c01/` were added. No protected file was modified.

---

## 3. Key status

| Item                     | Value                                                  |
| ------------------------ | ------------------------------------------------------ |
| Path                     | `/tmp/beaconhs-server-action-key`                      |
| Exists                   | **YES**                                                |
| Type                     | regular file                                           |
| Symlink                  | no                                                     |
| Mode                     | **0600**                                               |
| Owner UID                | 1000                                                   |
| Group GID                | 1000                                                   |
| Size                     | 45 bytes (44 base64 characters + one trailing newline) |
| Base64 valid             | yes                                                    |
| Decoded bytes            | **32**                                                 |
| Round-trip valid         | yes                                                    |
| Single trailing newline  | yes                                                    |
| Location                 | outside the repository                                 |
| Content read in evidence | **NO**                                                 |
| Fingerprint              | `f61da7728f3065df58f9e89aec6985d6`                     |

## 4. Generation method

- Python `secrets.token_bytes(32)`.
- `base64.b64encode(...)` plus one trailing newline.
- Created with `os.open(..., O_WRONLY | O_CREAT | O_EXCL, 0o600)`; mode was
  explicitly set to 0600.
- No shell tracing, no command-line key argument, no environment variable, no
  temporary plaintext file, no Git or evidence copy.
- The file existed only after the atomic create; no overwrite occurred.

## 5. Verification

| Check                    | Result                                    |
| ------------------------ | ----------------------------------------- |
| File exists              | PASS                                      |
| Regular file             | PASS                                      |
| Not a symlink            | PASS                                      |
| Mode 0600                | PASS                                      |
| Base64 valid             | PASS                                      |
| Decoded length 32 bytes  | PASS                                      |
| Round-trip valid         | PASS                                      |
| Single trailing newline  | PASS                                      |
| Fingerprint CLI          | PASS — `f61da7728f3065df58f9e89aec6985d6` |
| Gate fingerprint command | PASS — same value                         |
| Key printed or stored    | NO                                        |

No key material appears in this report or its evidence.

---

## 6. Server Action key isolation

| Test                                            | Result         |
| ----------------------------------------------- | -------------- |
| `server-action-key-handling.test.mjs`           | **6/6 PASS**   |
| `buildkit-secret-isolation.test.mjs`            | **1/1 PASS**   |
| `server-action-key-deployment-contract.test.ts` | **17/17 PASS** |

The isolated fixture proved the key is readable during the build, absent from the
next layer and runtime, absent from build output, image config and image
history, and that the image label is exact. The temporary fixture image and key
were removed.

---

## 7. Build prerequisites

| Item                             | Status                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Node base exact digest           | VERIFIED                                                                        |
| Dockerfile frontend exact digest | VERIFIED                                                                        |
| PostgreSQL exact digest          | VERIFIED                                                                        |
| Redis exact digest               | VERIFIED                                                                        |
| Collabora exact digest           | VERIFIED                                                                        |
| MinIO local exact digest         | VERIFIED                                                                        |
| Source archive SHA-256           | VERIFIED — `927062b6…`                                                          |
| Deployment id                    | VERIFIED — `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`                           |
| `BUILD_EVIDENCE_DIR`             | VERIFIED                                                                        |
| Formal Server Action key         | **READY** — mode 0600, 32 bytes, fingerprint `f61da7728f3065df58f9e89aec6985d6` |
| Disk space / platform            | PASS                                                                            |

A `PREPARE_ONLY=1` run with the formal key succeeded, wrote the expected source
manifest, and left no key in the build log.

---

## 8. Tests and gates

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

## 9. Unauthorized pull disclosure

EA-66B.2's `docker build --check` downloaded
`docker/dockerfile:1.8.1@sha256:e87caa74…` into the build cache. EA-66C.0.1 did
not repeat this. The cache record remains; no prune was performed.

---

## 10. Remaining work

1. Explicitly authorize the formal BeaconHS application image build.
2. Run the full key-gate shell acceptance test in an environment with the base
   images.
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
| EA-66C.0                    | **KEY BLOCKED**                                                     |
| EA-66C.0.1                  | **KEY READY; formal build not run**                                 |
| GHCR as deployment source   | **NOT USED**                                                        |
| External Docker image pull  | **PROHIBITED** (one unauthorized cache pull disclosed)              |
| Production                  | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**                   |
| Rollback                    | **FAIL — NO EXECUTABLE ROLLBACK PATH**                              |
| A1–A8                       | **PENDING AUTHORIZATION**                                           |
| Migration 51                | **NOT RUN**                                                         |
| DB / Object Storage restore | **NOT RUN**                                                         |
| WOPI                        | **PAUSED**                                                          |

---

## 12. Evidence index

| File                     | Contents                                                                    |
| ------------------------ | --------------------------------------------------------------------------- |
| `key-status.md`          | key file metadata, fingerprint, authorized generation procedure             |
| `build-prerequisites.md` | image, source, script and Gate 5 checks                                     |
| `prebuild-check.md`      | item-by-item preflight                                                      |
| `raw/`                   | baseline, key metadata, fingerprint, prepare run, tests, gates, final state |
| `SHA256SUMS`             | hashes of every evidence file except itself                                 |

Verify:

```bash
cd docs/evidence/ea66c01 && sha256sum -c SHA256SUMS
```
