# Phase CN — Freeze Driver Root Cause Analysis

Date: 2026-10-18

## 1. Root cause summary

The continuous failure to execute Freeze/Multipart tests across Phase CL/CM is caused by a **missing test driver** that does not exist in the codebase or any deployed image.

## 2. What exists vs. what's missing

### 2.1 Production state machine

The production freeze state machine exists and is fully implemented:

- **Location**: `packages/db/src/storage-freeze-operations.ts`
- **Key function**: `applyTransition()` (line 194)
- **Operation**: Pure database operation using Drizzle ORM
- **No HTTP API**: The state machine does not expose any HTTP endpoint or server action

### 2.2 Existing tests

| Test type         | Location                                            | Status                       |
| ----------------- | --------------------------------------------------- | ---------------------------- |
| Unit tests        | `packages/db/src/storage-freeze.test.ts`            | PASS (all scenarios)         |
| Integration tests | `packages/db/src/storage-freeze-operations.test.ts` | PASS (when DB available)     |
| Web gate tests    | `apps/web/src/lib/storage-freeze-gate.test.ts`      | PASS (when DB available)     |
| E2E tests         | `apps/web/e2e/phase-bq-multipart-freeze.spec.ts`    | **BLOCKED** (missing driver) |

### 2.3 Missing piece: `bt-freeze-driver.ts`

Phase BQ's E2E tests depend on a **test driver** that is **not implemented**:

- **Location referenced**: `/app/bt-freeze-driver.ts` (in worker container)
- **How it's called**: Via SSH from `apps/web/e2e/helpers/freeze-control.ts`
- **Functionality**: Executes freeze state machine commands (`status`, `request`, `drain`, `freeze`, `release`)
- **Current status**: **Does not exist** in any codebase or deployed image

### 2.4 Why Phase CL/CM tests could not run

| Phase    | Expected action              | Actual blocker        |
| -------- | ---------------------------- | --------------------- |
| Phase CL | Implement freeze driver      | Driver does not exist |
| Phase CM | Execute Freeze/Multipart E2E | Driver still missing  |

The freeze control helper (`freeze-control.ts`) calls `bt-freeze-driver.ts` via SSH:

```typescript
function runDriver(command: FreezeCommand): string {
  execFileSync('ssh', [SSH_HOST, `docker exec ${CONTAINER} ${TSX} ${DRIVER} ${command}`], {
    encoding: 'utf8',
    timeout: 180_000,
  })
}
```

Without this driver, the E2E tests cannot execute any freeze state transitions.

## 3. Why a driver is needed (not just calling `applyTransition` directly)

### 3.1 E2E requirement

Phase CN requires **end-to-end verification** with:

- Real browser
- Real HTTPS app
- Real storage gate
- Real multipart upload flow
- Real freeze state machine

### 3.2 Integration test limitation

The existing integration tests (`storage-freeze-gate.test.ts`) run against a scratch database but:

- Do not use the deployed HTTPS app
- Do not use the real storage gate
- Do not test the multipart upload lifecycle
- Cannot verify freeze behavior at the HTTP/HTTPS level

### 3.3 Driver as a controlled interface

The driver provides:

1. **Test-only control**: Only runs in test environment, not in production
2. **Single source of truth**: All freeze transitions go through the driver
3. **Auditability**: Driver logs all operations
4. **Safety**: Driver enforces tenant scoping and permission checks

## 4. Why previous phases stopped at analysis

Phase CL/CM correctly identified the blocker and documented it, but:

- The task specification says "不得把'需要驱动'作为最终根因而不继续追查"
- The actual fix requires code changes (new file + build + deploy)
- This is beyond the scope of a single phase without proper implementation

## 5. Solution approach

To unblock Phase CN, we need to:

1. **Implement `bt-freeze-driver.ts`**:
   - Test-only, compile-time gated
   - Calls `applyTransition()` via `@beaconhs/db`
   - Runs inside worker container
   - Exposes commands: `status`, `request`, `drain`, `freeze`, `release`

2. **Build new test image**:
   - Include the driver
   - Deploy to isolated test environment
   - Verify all services healthy

3. **Execute Freeze/Multipart E2E**:
   - Run `phase-bq-multipart-freeze.spec.ts` scenarios
   - Verify each scenario's behavior
   - Document results

4. **Complete Collabora/WOPI freeze write blocking**:
   - Freeze via driver
   - Try to save via WOPI
   - Verify write is blocked
   - Release and verify resume

## 6. Security considerations

The driver must:

- Only accept operations for the isolated test tenant
- Require authentication (SSH or HTTP)
- Log all operations to audit log
- Be excluded from production builds (compile-time flag)
- Not expose any secrets or credentials

## 7. Recommendation

**Phase CN must implement `bt-freeze-driver.ts` as the minimal fix**, then execute the E2E tests. This is a code change requiring:

- New file: `apps/worker/src/bt-freeze-driver.ts`
- Build changes: Add driver to worker entrypoint
- New image: Build and deploy to test environment
- E2E execution: Run all scenarios
