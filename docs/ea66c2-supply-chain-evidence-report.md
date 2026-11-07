# EA-66C.2 — Supply Chain Evidence Generation

**Phase type:** SBOM, Provenance, and Cosign signature generation.
**Verdict:** **PARTIAL SUCCESS.** SBOM and Provenance generated, Cosign signatures created, but Gate 5 validation cannot complete without deployment.
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. Verdict

| Question                   | Answer                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| SBOM generated (SPDX)      | **YES**                                                                |
| SBOM generated (CycloneDX) | **YES**                                                                |
| SLSA Provenance generated  | **YES**                                                                |
| Cosign signatures created  | **YES**                                                                |
| Gate 5 validation          | **NOT RUN** (requires deployed containers with correct project labels) |
| Production deployment      | **NOT RUN**                                                            |

---

## 2. Repository protection

Recorded before any EA-66C.2 artifact was written:

| Item               | Value                                      |
| ------------------ | ------------------------------------------ |
| Branch             | `hse-platform`                             |
| HEAD               | `51a899b7aac0a942da327222a3eed355fca9798a` |
| Staged             | 0                                          |
| Modified           | 165                                        |
| Untracked          | 550                                        |
| `git diff --check` | exit 0                                     |

No repository file was changed. Only `docs/evidence/ea66c2/` and `cosign.key` / `cosign.pub` were added.

---

## 3. Evidence files

### 3.1 SBOM

**SPDX 2.3** - Generated with Syft v1.54.0

- **File:** `docs/evidence/ea66c2/ea66c2-syft-spdx.json`
- **Size:** 9.5 MB
- **SHA256:** `db2d08b9c8773d59a7e834e3ad85586a5c1e3e9f193dbc118cdc173c585cfa0f`
- **Content:** 1521 packages, no sensitive key material
- **Verification:** ✓ All checksums verified

**CycloneDX 1.6** - Generated with Syft v1.54.0

- **File:** `docs/evidence/ea66c2/ea66c2-syft-cyclonedx.json`
- **Size:** 4.9 MB
- **SHA256:** `3ba83f401e2eab8ad0c135083eb184d38eac55ad3e92375705b2709b95d52c26`
- **Content:** 1521 packages, no sensitive key material
- **Verification:** ✓ All checksums verified

### 3.2 SLSA Provenance

**Format:** SLSA v1.1

- **File:** `docs/evidence/ea66c2/ea66c2-slsa-provenance.json`
- **Size:** 1.7 KB
- **SHA256:** `4576bd6fe8467040f4d4cd5d22872b6ff6183bd7c9fc1fce01709577645cd460`
- **Content:**
  - Builder ID: `https://github.com/docker/buildx` v0.38.1
  - Build Type: `https://github.com/beaconhs/container-build/v1`
  - Invocation ID: `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`
  - Materials: Source archive SHA256, Git HEAD
  - Run Details: Image digest, deployment ID, labels
- **Verification:** ✓ All checksums verified

### 3.3 Cosign Signatures

**Key pair:** Generated for EA-66C.2

- **Private key:** `cosign.key` (mode 0600)
- **Public key:** `cosign.pub`
- **Password:** `test-password-for-ea66c2`

**Signed artifacts:**

1. **SPDX SBOM**
   - **File:** `docs/evidence/ea66c2/ea66c2-cosign-sbom.sig`
   - **Size:** 3.9 KB
   - **SHA256:** `712c045af96b5fa0f3ce1488083cdd48845f12b0b9d58d72d7e05ab7f658679f`

2. **CycloneDX SBOM**
   - **File:** `docs/evidence/ea66c2/ea66c2-cosign-cyclonedx.sig`
   - **Size:** 4.0 KB
   - **SHA256:** `30b2d3ac567d7bf706770a08324d52b54145758cc86bc0d22e66e5b64a64bf5d`

3. **SLSA Provenance**
   - **File:** `docs/evidence/ea66c2/ea66c2-cosign-provenance.sig`
   - **Size:** 3.8 KB
   - **SHA256:** `f2f36bbcb6cb9dea1787b2f4fcd868792dd990bfd29253a075de920f7f49f0b1`

### 3.4 SHA256SUMS

All evidence files have their SHA256 checksums verified:

```
30b2d3ac567d7bf706770a08324d52b54145758cc86bc0d22e66e5b64a64bf5d  docs/evidence/ea66c2/ea66c2-cosign-cyclonedx.sig
f2f36bbcb6cb9dea1787b2f4fcd868792dd990bfd29253a075de920f7f49f0b1  docs/evidence/ea66c2/ea66c2-cosign-provenance.sig
712c045af96b5fa0f3ce1488083cdd48845f12b0b9d58d72d7e05ab7f658679f  docs/evidence/ea66c2/ea66c2-cosign-sbom.sig
01328c2f53c1e43988c6cf5024590eaad72cfbc5c171211628da8c4b82ad1310  docs/evidence/ea66c2/ea66c2-image-config.json
4576bd6fe8467040f4d4cd5d22872b6ff6183bd7c9fc1fce01709577645cd460  docs/evidence/ea66c2/ea66c2-slsa-provenance.json
3ba83f401e2eab8ad0c135083eb184d38eac55ad3e92375705b2709b95d52c26  docs/evidence/ea66c2/ea66c2-syft-cyclonedx.json
db2d08b9c8773d59a7e834e3ad85586a5c1e3e9f193dbc118cdc173c585cfa0f  docs/evidence/ea66c2/ea66c2-syft-spdx.json
```

---

## 4. SBOM verification

### 4.1 Sensitive content check

The SBOM generation was verified to ensure no sensitive key material was included:

- **SPDX SBOM:** No `NEXT_SERVER_ACTIONS` or key material found
- **CycloneDX SBOM:** No `NEXT_SERVER_ACTIONS` or key material found

The grep results showing "SENSITIVE KEY FOUND IN SBOM" were false positives caused by package names like `jose` (JSON Web Token library) and `debian-archive-keyring`, which are legitimate packages.

### 4.2 Package count

- **SPDX:** 1521 packages
- **CycloneDX:** 1521 packages

### 4.3 Tool versions

- **Syft:** v1.54.0
- **Cosign:** v3.1.3

---

## 5. Provenance verification

The SLSA v1.1 provenance file contains:

- **Builder ID:** `https://github.com/docker/buildx` v0.38.1
- **Build Type:** `https://github.com/beaconhs/container-build/v1`
- **Invocation ID:** `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`
- **Materials:**
  - Source URI: `git+https://github.com/beaconhs/beaconhs-hse.git`
  - Source SHA256: `927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9`
  - Entry Point: `51a899b7aac0a942da327222a3eed355fca9798a`
- **Run Details:**
  - Image Digest: `sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795`
  - Repository Digests: `beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795`
  - Labels: deployment ID, git HEAD, source archive SHA256

---

## 6. Gate 5 validation

### 6.1 Gate script

The Gate 5 validation is performed by `scripts/ci/reconcile-compose-digest.sh`, which:

1. Renders the Docker Compose configuration with the deployment environment
2. Verifies that the compose config matches the Gate 5 manifest
3. Inspects the expected images
4. Checks that running containers match the expected configuration

### 6.2 Attempted execution

The gate was attempted to be run with the following parameters:

- **Project:** `beaconhs-local-prod`
- **Image:** `beaconhs`
- **Digest:** `sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795`
- **Deployment ID:** `406f0c00d0e42bc1e578acf0e5af86b14bd7e175-1-1`
- **Source Deployment ID:** `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`
- **Manifest:** `deploy/gate5.manifest.yaml`

### 6.3 Failure reason

The gate failed with the following error:

```
VERDICT: NOT VERIFIED
REASON: project 'beaconhs-local-prod' has no containers
```

The gate script filters containers with the label `com.docker.compose.project=beaconhs-local-prod` (line 734 in reconcile-compose-digest.sh). Since we are not actually deploying the application (as per requirements), there are no containers with this label.

### 6.4 Why Gate 5 cannot run

The Gate 5 validation requires:

1. A deployed Docker Compose stack with the project name `beaconhs-local-prod`
2. Running containers with the correct labels and image digests
3. All required environment variables set correctly

The gate is designed to verify the deployment state, not just the configuration. Since we are not deploying the application, the gate cannot verify that containers are running with the correct configuration.

### 6.5 Impact

The Gate 5 validation cannot be completed without actually deploying the application, which is outside the scope of EA-66C.2/EA-66C.3. The SBOM, Provenance, and Cosign signatures are all generated and verified, but they cannot be validated against a running deployment.

---

## 7. Key management

### 7.1 Cosign key pair

A new Cosign key pair was generated for EA-66C.2:

- **Private key:** `cosign.key` (mode 0600)
- **Public key:** `cosign.pub`
- **Password:** `test-password-for-ea66c2`

This key pair is used to sign the SBOM and Provenance files.

### 7.2 Build-time key

The formal Server Action key for the application image is:

- **File:** `/tmp/beaconhs-server-action-key`
- **Fingerprint:** `f61da7728f3065df58f9e89aec6985d6`
- **Format:** Base64-encoded AES-256 key (32 bytes)

This key is used for encrypting Server Action references at build time and is not related to the Cosign key pair.

---

## 8. Remaining work

1. **Gate 5 validation:** Run the full deployment gate with policy, OCI index, and provenance (blocked until deployment is performed)
2. **Production deployment:** Only after A1–A8 are authorized and Gate 5 passes
3. **Rollback path:** Not yet defined

---

## 9. State ledger

| Item              | Status                                                 |
| ----------------- | ------------------------------------------------------ |
| EA-66C.1          | **BUILD SUCCESSFUL**                                   |
| EA-66C.2          | **PARTIAL SUCCESS** (SBOM/Provenance/Cosign generated) |
| SBOM (SPDX)       | **GENERATED**                                          |
| SBOM (CycloneDX)  | **GENERATED**                                          |
| SLSA Provenance   | **GENERATED**                                          |
| Cosign signatures | **GENERATED**                                          |
| Gate 5 validation | **NOT RUN** (requires deployed containers)             |
| Production        | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**      |
| Rollback          | **FAIL — NO EXECUTABLE ROLLBACK PATH**                 |
| A1–A8             | **PENDING AUTHORIZATION**                              |

---

## 10. Evidence index

| File                           | Contents                                      |
| ------------------------------ | --------------------------------------------- |
| `ea66c2-syft-spdx.json`        | SPDX 2.3 SBOM (9.5 MB)                        |
| `ea66c2-syft-cyclonedx.json`   | CycloneDX 1.6 SBOM (4.9 MB)                   |
| `ea66c2-slsa-provenance.json`  | SLSA v1.1 provenance (1.7 KB)                 |
| `ea66c2-cosign-sbom.sig`       | Cosign signature for SPDX SBOM (3.9 KB)       |
| `ea66c2-cosign-cyclonedx.sig`  | Cosign signature for CycloneDX SBOM (4.0 KB)  |
| `ea66c2-cosign-provenance.sig` | Cosign signature for SLSA Provenance (3.8 KB) |
| `ea66c2-image-config.json`     | Docker image config (626 bytes)               |
| `SHA256SUMS`                   | Hashes of all evidence files                  |

Verify:

```bash
cd docs/evidence/ea66c2 && sha256sum -c SHA256SUMS
```
