# EA-66C.3 — Gate 5 Validation

**Phase type:** Deployment identity gate validation.
**Verdict:** **NOT RUN.** Gate requires deployed containers with correct project labels.
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. Verdict

| Question                   | Answer                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| Gate 5 validation          | **NOT RUN**                                                            |
| Gate 5 policy completeness | **VERIFIED** (policy manifest exists and is valid)                     |
| Gate 5 execution           | **BLOCKED** (requires deployed containers with correct project labels) |
| Production deployment      | **NOT RUN**                                                            |

---

## 2. Gate 5 policy

### 2.1 Policy manifest

The Gate 5 policy is defined in `deploy/gate5.manifest.yaml`:

- **Project:** `beaconhs-local-prod`
- **Compose file:** `deploy/local-production.compose.yaml`
- **Format:** Strict YAML subset — top-level keys, `services:` and two levels of mapping

### 2.2 Service expectations

The manifest defines the following services:

| Service      | Role         | Image Class | Expected Count | Required | One-shot | Health   |
| ------------ | ------------ | ----------- | -------------- | -------- | -------- | -------- |
| web          | web          | gated       | 1              | true     | false    | required |
| worker       | worker       | gated       | 1              | true     | false    | required |
| scheduler    | scheduler    | gated       | 1              | true     | true     | none     |
| storage-init | storage-init | gated       | 1              | true     | true     | none     |
| postgres     | postgres     | pinned      | 1              | true     | false    | required |
| redis        | redis        | pinned      | 1              | true     | false    | required |
| minio        | minio        | pinned      | 1              | true     | false    | required |
| collabora    | collabora    | pinned      | 1              | true     | false    | none     |

### 2.3 Service fields

Each service has the following expected fields:

- `role`: the service's unique role; must equal its name
- `image_class`: gated | pinned
- `expected_image`: pinned only: repository, no tag and no digest
- `expected_digest`: pinned only: canonical sha256:<64 hex>
- `expected_container_count`: positive integer
- `required`: true | false
- `one_shot`: true | false
- `health`: required | none
- `expected_exit_code`: 0..255; required iff one_shot is true
- `deployment_label_required`: must be true
- `image_digest_label_required`: must be true

---

## 3. Gate script

The Gate 5 validation is performed by `scripts/ci/reconcile-compose-digest.sh`.

### 3.1 Usage

```bash
reconcile-compose-digest.sh \
  --project <compose-project> \
  --image <repository> \
  --digest <sha256:...> \
  --deployment-id <sha-runid-attempt> \
  --manifest deploy/gate5.manifest.yaml \
  [--source-deployment-id <40-hex archive-derived id>] \
  [--compose-file <path>] [--timeout <seconds>] [--poll-interval <seconds>] \
  [--lock <path> | --lock-fd <n>] [--json]
```

### 3.2 Exit codes

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| 0    | PASS — all required checks passed                       |
| 1    | FAIL — evidence contradicts the deployment              |
| 2    | NOT VERIFIED — a required fact could not be established |
| 3    | usage / parameter error                                 |

---

## 4. Attempted execution

### 4.1 Parameters

```bash
bash scripts/ci/reconcile-compose-digest.sh \
  --project beaconhs-local-prod \
  --image beaconhs \
  --digest sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795 \
  --deployment-id 406f0c00d0e42bc1e578acf0e5af86b14bd7e175-1-1 \
  --source-deployment-id 406f0c00d0e42bc1e578acf0e5af86b14bd7e175 \
  --manifest deploy/gate5.manifest.yaml \
  --timeout 600
```

### 4.2 Environment variables

The following environment variables were set for the gate to render the compose configuration:

```bash
APP_VERSION=51a899b7aac0a942da327222a3eed355fca9798a
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/beaconhs
SUPERADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/superadmin
REDIS_URL=redis://localhost:6380
BETTER_AUTH_SECRET=test-secret
ATTACHMENT_CAPABILITY_SECRET=test-capability
APP_URL=http://localhost:3000
R2_ENDPOINT=http://localhost:9000
R2_INTERNAL_ENDPOINT=http://minio:9000
R2_ACCESS_KEY_ID=minioadmin
R2_SECRET_ACCESS_KEY=minioadmin
R2_BUCKET=beaconhs
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<32-byte hex string>
COLLABORA_URL=http://localhost:9980
COLLABORA_WOPI_URL=http://localhost:3000/wopi
BEACONHS_DEPLOYMENT_ID=406f0c00d0e42bc1e578acf0e5af86b14bd7e175-1-1
BEACONHS_IMAGE=beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795
BEACONHS_IMAGE_DIGEST=sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=beaconhs
```

### 4.3 Execution steps

The gate performs the following steps:

1. **Validate parameters** — PASS
2. **Render compose configuration** — PASS
3. **Verify compose config matches manifest** — PASS
4. **Inspect expected images** — PASS
5. **Verify compose labels match manifest** — PASS
6. **Collect running containers** — FAIL

### 4.4 Failure

```
VERDICT: NOT VERIFIED
REASON: project 'beaconhs-local-prod' has no containers
```

---

## 5. Why Gate 5 cannot run

### 5.1 Container collection

The gate collects running containers with the following filter (line 734 in reconcile-compose-digest.sh):

```bash
docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}"
```

This filter requires containers to have the label `com.docker.compose.project=beaconhs-local-prod`.

### 5.2 Current container state

There are containers running with the correct image and labels, but under different project names:

| Container          | Project            | Image                  | Status        |
| ------------------ | ------------------ | ---------------------- | ------------- |
| practical_edison   | practical_edison   | beaconhs:ea66c1-formal | Up 58 minutes |
| infallible_khayyam | infallible_khayyam | beaconhs:ea66c1-formal | Up 58 minutes |

Both containers have the correct labels:

- `com.beaconhs.deployment-id`: `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`
- `com.beaconhs.git-head`: `51a899b7aac0a942da327222a3eed355fca9798a`
- `com.beaconhs.source-archive-sha256`: `927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9`

However, they are not managed by Docker Compose with the project name `beaconhs-local-prod`.

### 5.3 Why deployment is required

The Gate 5 validation is designed to:

1. Verify that the compose configuration matches the Gate 5 manifest
2. Inspect the expected images (gated and pinned)
3. Check that running containers match the expected configuration
4. Verify health checks, exit codes, and labels

The gate is not designed to validate arbitrary containers; it expects containers to be managed by Docker Compose with the correct project name.

Since we are not actually deploying the application (as per requirements), there are no containers with the `com.docker.compose.project=beaconhs-local-prod` label.

### 5.4 Impact

The Gate 5 validation cannot be completed without actually deploying the application. The gate requires:

1. A Docker Compose stack with the project name `beaconhs-local-prod`
2. Running containers with the correct labels and image digests
3. All required environment variables set correctly

The gate is designed to verify the deployment state, not just the configuration. Since we are not deploying the application, the gate cannot verify that containers are running with the correct configuration.

---

## 6. Policy completeness

### 6.1 Gate 5 manifest

The Gate 5 manifest (`deploy/gate5.manifest.yaml`) is complete and valid:

- **Project name:** `beaconhs-local-prod`
- **Compose file:** `deploy/local-production.compose.yaml`
- **Services:** 8 services defined
- **Image classes:** gated and pinned services properly defined
- **Labels:** deployment and image digest labels required

### 6.2 Compose file

The compose file (`deploy/local-production.compose.yaml`) is complete and valid:

- **Services:** 8 services defined (web, worker, scheduler, storage-init, postgres, redis, minio, collabora)
- **Image classes:** gated and pinned services properly defined
- **Labels:** deployment and image digest labels required
- **Environment variables:** all required variables defined

### 6.3 Conclusion

The Gate 5 policy is complete and valid. The gate script is working correctly. The only blocker is the lack of deployed containers with the correct project label.

---

## 7. Remaining work

1. **Gate 5 validation:** Run the full deployment gate with policy, OCI index, and provenance (blocked until deployment is performed)
2. **Production deployment:** Only after A1–A8 are authorized and Gate 5 passes
3. **Rollback path:** Not yet defined

---

## 8. State ledger

| Item                       | Status                                                 |
| -------------------------- | ------------------------------------------------------ |
| EA-66C.1                   | **BUILD SUCCESSFUL**                                   |
| EA-66C.2                   | **PARTIAL SUCCESS** (SBOM/Provenance/Cosign generated) |
| EA-66C.3                   | **NOT RUN** (blocked by deployment requirement)        |
| Gate 5 policy completeness | **VERIFIED** (manifest and compose file are valid)     |
| Gate 5 execution           | **BLOCKED** (requires deployed containers)             |
| Production                 | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**      |
| Rollback                   | **FAIL — NO EXECUTABLE ROLLBACK PATH**                 |
| A1–A8                      | **PENDING AUTHORIZATION**                              |

---

## 9. Evidence index

| File                                     | Contents               |
| ---------------------------------------- | ---------------------- |
| `gate5.manifest.yaml`                    | Gate 5 policy manifest |
| `local-production.compose.yaml`          | Canonical Compose file |
| `ea66c2-supply-chain-evidence-report.md` | EA-66C.2 report        |
| `ea66c3-gate5-validation-report.md`      | This report            |

No gate execution logs are available because the gate could not be completed.
