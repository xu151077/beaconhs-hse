# Phase CN — Deployment & Regression Report

Date: 2026-10-18

## 1. Code changes

Phase CN implemented the following code changes:

### 1.1 Freeze driver implementation

**File**: `apps/worker/src/bt-freeze-driver.ts`

- Test-only driver for controlling the storage-freeze state machine
- Compile-time gated (TEST_ONLY_DRIVER flag)
- Commands: status, request, drain, freeze, release
- Tenant-scoped to isolated test tenant
- Audit logging support

**File**: `apps/worker/src/bt-freeze-driver.test.ts`

- Unit tests for driver logic
- Compile-time gating verification
- Security boundary verification
- 8/8 tests PASS

### 1.2 Build changes

- Worker build successful
- No changes to web build needed
- Driver code compiled into `dist/index.js`

## 2. Test execution

| Package            | Test files                  | Tests                         | Status |
| ------------------ | --------------------------- | ----------------------------- | ------ |
| `@beaconhs/web`    | 239 (237 passed, 2 skipped) | 2041 (2033 passed, 8 skipped) | PASS   |
| `@beaconhs/db`     | 62 (61 passed, 1 skipped)   | 542 (501 passed, 41 skipped)  | PASS   |
| `@beaconhs/worker` | 1 (8 passed)                | 8 (8 passed)                  | PASS   |

## 3. Environment status

| Item          | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| Image         | `beaconhs:phase-cd-20261018-142237` (`sha256:8feaa82d4aa1…`) |
| HTTPS         | `https://beaconhs-test.xuhaoqing.top` → 200                  |
| Containers    | All healthy                                                  |
| Volumes       | Original external volumes preserved                          |
| Tenant status | ACTIVE (both tenants)                                        |

## 4. Deployment performed

**No deployment performed** — The freeze driver was implemented and tested locally, but could not be deployed to the isolated test environment due to:

- Requires building a new test image
- Requires deploying to test server (10.10.31.30)
- Requires database access and tenant setup

The existing healthy deployment remains in place.

## 5. Freeze driver verification

| Verification     | Status   |
| ---------------- | -------- |
| Code compilation | PASS     |
| Type check       | PASS     |
| Build            | PASS     |
| Unit tests       | 8/8 PASS |
| Security gating  | PASS     |
| Tenant scoping   | PASS     |

## 6. Freeze/Multipart

**NOT RUN** — Freeze driver not deployed. Phase BQ 11/11 results carry forward.

## 7. Collabora/WOPI

**PARTIALLY VERIFIED** — Same results as Phase CL/CM:

- DOCX upload, iframe load, edit, save, download all PASS
- Reopen verification inconclusive (canvas-rendered)
- Freeze write blocking NOT RUN (requires driver deployment)
