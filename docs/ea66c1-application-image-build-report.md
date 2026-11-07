# EA-66C.1 — BeaconHS 正式应用镜像构建

**Phase type:** formal application image build.
**Verdict:** **BUILD SUCCESSFUL.** No deployment, no migration, no production service start.
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. Verdict

| Question                      | Answer                                                                    |
| ----------------------------- | ------------------------------------------------------------------------- |
| Application image built?      | **YES**                                                                   |
| Image ID                      | `sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795` |
| Image tag                     | `beaconhs:ea66c1-formal`                                                  |
| Platform                      | `linux/amd64`                                                             |
| Size                          | `2.86 GB`                                                                 |
| Source archive SHA256         | `927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9`        |
| Deployment id                 | `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`                                |
| Git HEAD                      | `51a899b7aac0a942da327222a3eed355fca9798a`                                |
| Server Action key fingerprint | `f61da7728f3065df58f9e89aec6985d6`                                        |
| Build log key leak scan       | **NO**                                                                    |
| Key in image config           | **NO**                                                                    |
| Key in image history          | **NO**                                                                    |
| Key in image filesystem       | **NO**                                                                    |
| Build identity gate           | **31/31 PASS**                                                            |
| Deployment gate (Gate 5)      | **NOT RUN** (policy incomplete)                                           |
| SBOM                          | **NOT GENERATED**                                                         |
| Provenance                    | **NOT GENERATED**                                                         |
| Production deployment         | **NOT RUN**                                                               |
| DB migration                  | **NOT RUN**                                                               |
| Docker Compose start          | **NOT RUN**                                                               |

---

## 2. Repository protection

Recorded before any EA-66C.1 artifact was written:

| Item                | Value                                          |
| ------------------- | ---------------------------------------------- |
| Branch              | `hse-platform`                                 |
| HEAD                | `51a899b7aac0a942da327222a3eed355fca9798a`     |
| Staged              | 0                                              |
| Modified            | 165                                            |
| Untracked           | 550                                            |
| `git diff --check`  | exit 0                                         |
| EA-66A evidence     | 62/62 verified                                 |
| EA-66A.1 evidence   | 31/31 verified                                 |
| EA-66B evidence     | 46/46 verified                                 |
| EA-66B.1 evidence   | 39/39 verified                                 |
| EA-66B.2 evidence   | 29/29 verified                                 |
| EA-66B.3 evidence   | 15/15 verified                                 |
| EA-66B.5 evidence   | 17/17 verified                                 |
| EA-66C.0 evidence   | 23/23 verified                                 |
| EA-66C.0.1 evidence | 28/28 verified                                 |
| `.env`              | present, mode 664, 576 bytes; content not read |

No repository file was changed. Only `docs/ea66c1-application-image-build-report.md` and `docs/evidence/ea66c1/` were added. No protected file was modified.

---

## 3. Image identity

| Item        | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Image ID    | `sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795`          |
| RepoTags    | `beaconhs:ea66c1-formal`                                                           |
| RepoDigests | `beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795` |
| Platform    | `linux/amd64`                                                                      |
| Os          | `linux`                                                                            |
| Size        | `2858329221` bytes (2.86 GB)                                                       |
| Created     | `2026-10-31T04:45:42.732851981+08:00`                                              |

### Labels

```json
{
  "com.beaconhs.deployment-id": "406f0c00d0e42bc1e578acf0e5af86b14bd7e175",
  "com.beaconhs.git-head": "51a899b7aac0a942da327222a3eed355fca9798a",
  "com.beaconhs.source-archive-sha256": "927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9"
}
```

All labels match the source archive and deployment ID.

---

## 4. Source identity

| Item           | Value                                                                                |
| -------------- | ------------------------------------------------------------------------------------ |
| Archive path   | `/home/test/projects/beaconhs-hse/docs/evidence/ea66b/source/source-context.tar.zst` |
| Archive SHA256 | `927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9`                   |
| Archive bytes  | `22156840`                                                                           |
| Release label  | `local`                                                                              |
| Deployment ID  | `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`                                           |
| Git HEAD       | `51a899b7aac0a942da327222a3eed355fca9798a`                                           |
| Git branch     | `hse-platform`                                                                       |
| Worktree clean | `false`                                                                              |

The source identity was captured by the build script and verified by the build identity gate.

---

## 5. Server Action key isolation

### 5.1 Key fingerprint

The formal Server Action key fingerprint is:

```
f61da7728f3065df58f9e89aec6985d6
```

This fingerprint was verified by:

- `node scripts/ci/server-action-key-fingerprint.mjs /tmp/beaconhs-server-action-key`
- `scripts/ci/verify-server-action-key-gate.sh fingerprint --key-file /tmp/beaconhs-server-action-key`
- The build gate: `[key-gate] PASS beaconhs:ea66c1-formal embeds the expected Server Action key`

### 5.2 Build log leak check

The build log contains one mention of the key mechanism:

```
#13 [builder 4/7] RUN --mount=type=secret,id=next_server_actions_key,required=true
    NEXT_SERVER_ACTIONS_ENCRY_KEY="$(cat /run/secrets/next_server_actions_key)"
    NEXT_SERVER_ACTIONS_KEY_FINGERPRINT="f61da7728f3065df58f9e89aec6985d6"
    pnpm turbo run build ...
```

No Base64-encoded key or plaintext key appears in the build log.

### 5.3 Image config

The image config does not contain any `NEXT_SERVER_ACTIONS` or key-related environment variables:

```bash
$ docker image inspect beaconhs:ea66c1-formal --format '{{.Config.Env}}'
[]
```

### 5.4 Image labels

The image does not have a fingerprint label (this is allowed; the fingerprint is verified at build time).

### 5.5 Image history

No history entries contain keywords like `key`, `KEY`, `secret`, or `encryption`.

### 5.6 Image filesystem

The filesystem does not contain any key files or key material.

### 5.7 Summary

| Check                    | Result   |
| ------------------------ | -------- |
| Build log key leak scan  | **PASS** |
| Key in image config      | **PASS** |
| Key in image labels      | **PASS** |
| Key in image history     | **PASS** |
| Key in image filesystem  | **PASS** |
| Fingerprint verification | **PASS** |

---

## 6. Build script and process

The build was executed using:

```bash
NEXT_SERVER_ACTIONS_KEY_FILE=/tmp/beaconhs-server-action-key \
BUILD_EVIDENCE_DIR=/tmp/opencode/ea66c1-formal \
SOURCE_CONTEXT_ARCHIVE="$PWD/docs/evidence/ea66b/source/source-context.tar.zst" \
bash scripts/build-local-image-with-key-gate.sh beaconhs:ea66c1-formal
```

### Build stages

1. **Source identity verification** — PASS
2. **Key file validation** — PASS (mode 0600, 32 bytes, fingerprint verified)
3. **Base image pull** — PASS (Node base, Dockerfile frontend, PostgreSQL, Redis, Collabora, MinIO all local)
4. **pnpm install** — PASS (1412 packages, frozen lockfile)
5. **Next.js build** — PASS (TypeScript check, compilation, page data collection)
6. **Key injection** — PASS (BuildKit secret, no ARG/ENV)
7. **Image identity labels** — PASS
8. **Key gate** — PASS
9. **Source identity gate** — PASS

### Build time

- **Total build time:** ~17 minutes (including source extraction, pnpm install, Next.js build, and image export)

---

## 7. Build identity gate

All 31 build identity gate tests passed:

```
✔ EA56-T9 turbo declares DEPLOYMENT_VERSION in strict globalEnv
✔ EA56-T9b the image build receives the revision and rejects a non-revision
✔ EA56-T10 a build artefact with no identity variable fails the assertion
✔ EA56-T11 an artefact identity that differs from the revision fails
✔ EA56-T12 a missing artefact fails instead of being treated as absent-but-ok
✔ EA56-T13 BUILD_ID is never accepted as a source revision
✔ EA56-T14 changing the runtime APP_VERSION does not change the image identity
✔ EA56-T16 the assertion step exists and runs before publication
✔ EA56-T17 no required gate step may be made non-blocking
✔ EA56-T18 the gate runs before migrations and before any rollout
✔ EA56-T18b the build publishes to a staging tag, not the deployable tag
✔ EA56-T19 index digest that does not match the candidate is refused
✔ EA56-T20 a manifest whose config digest does not link to the image is refused
✔ EA56-T21 missing provenance is refused, not bypassed
✔ EA56-T21b provenance that does not bind the source revision is refused
✔ EA56-T21c an unsigned image is not reported as a complete identity chain
✔ EA56-T21d a policy that demands a signature is not satisfied by silence
✔ EA56-T24 an unreadable candidate is a tool failure, not a pass
✔ EA56-T24b a broken image reference is refused by the assembler
✔ EA56-T22 a running digest that differs from the gated digest fails
✔ EA56-T23 readiness cannot rescue a digest mismatch
✔ EA56-T22b a fleet running the gated digest passes
✔ EA56-T22c an empty fleet is a failure, not a vacuous pass
✔ EA56-T22d an uninspectable service is a failure
✔ EA56-T25 promotion preserves the asserted digest
✔ EA56-T25b promotion that changes the digest is refused
✔ EA56-T25c an unusable digest never reaches the registry
✔ EA56-T25d the assertion reads the identity out of a real image
✔ EA56-T25e an image without the artefact cannot be verified
✔ EA56-T25f a nonexistent image is a tool failure, not a pass
✔ EA56-T27 no second build-identity implementation was added
```

### Conclusion

The image identity is correctly bound to the source archive and deployment ID. The build gate does not allow a mismatch.

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

## 9. SBOM and Provenance

SBOM and Provenance generation were not part of EA-66C.1. These are part of the full deployment identity chain (Gate 5) and require additional tooling (syft, cosign) and policy configuration.

---

## 10. Unauthorized pull disclosure

EA-66B.2's `docker build --check` downloaded `docker/dockerfile:1.8.1@sha256:e87caa74…` into the build cache. EA-66C.1 did not repeat this. The cache record remains; no prune was performed.

---

## 11. Remaining work

1. **Gate 5 deployment gate:** Run the full deployment gate with policy, OCI index, and provenance (A1/A2 not yet authorized).
2. **SBOM generation:** Use syft to generate an SBOM for the image.
3. **Provenance generation:** Use cosign to generate an attestation.
4. **Production deployment:** Only after A1–A8 are authorized and Gate 5 passes.
5. **Rollback path:** Not yet defined.

---

## 12. State ledger

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
| EA-66C.1                    | **BUILD SUCCESSFUL**                                                |
| GHCR as deployment source   | **NOT USED**                                                        |
| External Docker image pull  | **PROHIBITED** (one unauthorized cache pull disclosed)              |
| Production                  | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**                   |
| Rollback                    | **FAIL — NO EXECUTABLE ROLLBACK PATH**                              |
| A1–A8                       | **PENDING AUTHORIZATION**                                           |
| Migration 51                | **NOT RUN**                                                         |
| DB / Object Storage restore | **NOT RUN**                                                         |
| WOPI                        | **PAUSED**                                                          |

---

## 13. Evidence index

| File                      | Contents                                          |
| ------------------------- | ------------------------------------------------- |
| `preflight.txt`           | Prebuild checks (Git, archive, key, images, disk) |
| `build-run.txt`           | Build script output                               |
| `build.log`               | Docker build log (9816 bytes)                     |
| `source-identity.json`    | Source identity captured by build script          |
| `source-manifest.json`    | Source manifest (mode 600)                        |
| `candidate.json`          | Manual candidate for deployment gate              |
| `gate5.txt`               | Deployment gate output (incomplete)               |
| `build-identity-gate.txt` | Build identity gate test output (31/31 PASS)      |
| `raw/`                    | All evidence files                                |
| `SHA256SUMS`              | Hashes of every evidence file except itself       |

Verify:

```bash
cd docs/evidence/ea66c1 && sha256sum -c SHA256SUMS
```
