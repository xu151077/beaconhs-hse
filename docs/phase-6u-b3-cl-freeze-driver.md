# Phase CL — Freeze Driver Analysis

Date: 2026-10-18

## 1. Technical blocker analysis

### Why the freeze state machine cannot be driven through the browser

The freeze state machine is implemented in `packages/db/src/storage-freeze-operations.ts` and operates on the `storage_freeze` table via Drizzle ORM. It requires:

1. **Database access with tenant context**: `applyTransition()` takes a `tx: Database` parameter and uses `withTenant` for RLS.
2. **Actor ID and permissions**: Each transition requires an `actorId` and `permission` string.
3. **Lease management**: Database-level lease constraints.
4. **Drain verification**: Entering FROZEN requires `readDrainVerification()` within the same transaction.

### Existing test infrastructure (Phase BQ)

Phase BQ used a freeze driver (`bt-freeze-driver.ts`) that ran inside the worker container via SSH. This driver **does not exist** in any current image:

- Not in `beaconhs:phase-cd-20261018-142237` (new image)
- Not in `beaconhs:phase-bp-20261018-095008` (old image)
- Not on the host filesystem
- Production source code is not available in the container (compiled image only)

### Could we create a new driver?

**No** — the container only has compiled `.next` and worker bundles. The driver would need to import `@beaconhs/db` which requires TypeScript source. Creating a driver would require:

1. Adding a driver file to the source code
2. Rebuilding the image
3. Deploying
4. Running tests

This is a code change that requires its own phase (Phase CL implementation) with security review, quality gates, and deployment.

### Recommendation

The freeze driver should be added as a **test-only, production-disabled** utility:

- Create `apps/worker/src/freeze-driver.ts` using the production state machine
- Gate behind compile-time flag (not runtime env var)
- Ensure excluded from production builds
- Add security tests (unauthorized, cross-tenant, production-disabled)
- Add audit logging

This is a **code change** requiring a separate implementation phase.

## 2. Existing test coverage

| Test file                                               | Status |
| ------------------------------------------------------- | ------ |
| `packages/db/src/storage-freeze.test.ts`                | PASS   |
| `packages/db/src/storage-freeze-operations.test.ts`     | PASS   |
| `apps/web/src/lib/storage-freeze-gate.test.ts`          | PASS   |
| `apps/web/src/lib/storage-freeze-refusal.test.ts`       | PASS   |
| `packages/storage/src/freeze-gate-presign-wopi.test.ts` | PASS   |
| `packages/storage/src/multipart.test.ts`                | PASS   |

Phase BQ verified 11/11 HTTP E2E scenarios on the same isolated test tenant.

## 3. Security boundary analysis

A test driver must:

- Only run when explicitly enabled (compile-time flag)
- Only accept operations for the isolated test tenant
- Require authentication
- Log all operations to audit log
- Be excluded from production builds

Recommendation: Use compile-time flag rather than runtime env var, so driver code is physically absent from production builds.
