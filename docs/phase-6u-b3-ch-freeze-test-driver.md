# Phase CH — Freeze Test Driver Analysis

Date: 2026-10-18

## 1. Technical blocker analysis

### Why Playwright cannot drive the freeze state machine

The freeze state machine is implemented in `packages/db/src/storage-freeze-operations.ts` and operates on the `storage_freeze` table via Drizzle ORM. It requires:

1. **Database access with tenant context**: `applyTransition()` takes a `tx: Database` parameter and uses `withTenant` for RLS. This requires running inside the application's database context, not a browser.
2. **Actor ID and permissions**: Each transition requires an `actorId` and `permission` string. These are resolved from the request context (auth session), not from browser cookies alone.
3. **Lease management**: The state machine uses database-level lease constraints. Transitions must happen within a transaction.
4. **Drain verification**: Entering FROZEN requires `readDrainVerification()` which checks for zero in-flight writes — this is a database query that must run within the same transaction.

### Existing test infrastructure (Phase BQ)

Phase BQ used a freeze driver (`bt-freeze-driver.ts`) that:

- Ran inside the worker container via SSH
- Used tsx to execute TypeScript
- Called the production state machine directly
- Required the production source code in the container

### Current blocker

The freeze driver **does not exist** in the current deployment:

- Not in `beaconhs:phase-cd-20261018-142237` (new image)
- Not in `beaconhs:phase-bp-20261018-095008` (old image)
- Not on the host filesystem
- Production source code is not available in the container (compiled image only)

### Could we create a new driver?

Creating a new freeze driver would require:

1. Writing a TypeScript file that imports `@beaconhs/db` and calls `applyTransition`
2. The file must run inside the container (where the compiled code lives)
3. But the container only has compiled `.next` and worker bundles, not TypeScript source

**Conclusion**: A new freeze driver cannot be created without either:

- Rebuilding the image with the driver included (requires code changes + new image)
- Mounting a driver file into the container (requires docker compose changes)
- Adding an HTTP admin endpoint (requires code changes + security review)

### Recommendation

The freeze driver should be added as a **test-only, production-disabled** utility:

- Create `apps/worker/src/freeze-driver.ts` that uses the production state machine
- Gate it behind an environment variable (`ENABLE_FREEZE_TEST_DRIVER=true`)
- Ensure it's never enabled in production (check `NODE_ENV` or a specific flag)
- Add it to the image build (included in the worker bundle)
- Add tests for: interface unavailable, permission denied, cross-tenant access denied, production config disabled

This is a **code change** that requires:

1. Implementation
2. Security review
3. Quality gates
4. New image build
5. Deployment
6. Re-verification

Given the scope, this should be a separate phase (Phase CI) with its own implementation and verification cycle.

## 2. Existing test coverage

The freeze/multipart state machine has extensive unit test coverage:

- `packages/db/src/storage-freeze.test.ts` — pure state machine rules
- `packages/db/src/storage-freeze-operations.test.ts` — database operations
- `apps/web/src/lib/storage-freeze-gate.test.ts` — gate logic
- `apps/web/src/lib/storage-freeze-refusal.test.ts` — refusal messages
- `packages/storage/src/freeze-gate-presign-wopi.test.ts` — WOPI gate
- `packages/storage/src/multipart.test.ts` — multipart upload

Phase BQ verified 11/11 HTTP E2E scenarios on the same isolated test tenant.

## 3. Security boundary analysis

A test driver must:

- Only run when explicitly enabled (env var check)
- Only accept operations for the isolated test tenant (hardcoded tenant ID check)
- Require authentication (actor ID from env or CLI arg)
- Log all operations to audit log
- Be excluded from production builds (conditional compilation or runtime check)

The risk of accidentally exposing this in production is:

- **Low** if properly gated (env var + NODE_ENV check)
- **High** if the gating is bypassed or misconfigured

Recommendation: Use a compile-time flag (`--define` or conditional import) rather than a runtime env var, so the driver code is physically absent from production builds.
