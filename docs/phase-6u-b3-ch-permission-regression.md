# Phase CH — Permission Regression Report

Date: 2026-10-18

## 1. Test execution

The existing test suite was run to verify no regressions:

| Package         | Test files                  | Tests                         | Status |
| --------------- | --------------------------- | ----------------------------- | ------ |
| `@beaconhs/web` | 239 (237 passed, 2 skipped) | 2041 (2033 passed, 8 skipped) | PASS   |
| `@beaconhs/db`  | 62 (61 passed, 1 skipped)   | 542 (501 passed, 41 skipped)  | PASS   |

## 2. Permission-related test coverage

The existing tests cover:

- Unauthenticated access rejection
- Role-based permission enforcement
- Tenant isolation (RLS)
- Cross-tenant document/file access denial
- File URL authorization checks
- Admin vs. non-admin boundaries
- Storage freeze gate logic
- Storage freeze refusal messages
- WOPI storage refusal

## 3. No new permission code

Phase BU/CF/CG did not modify any permission-related code. The PDF fix adds:

- Server-side trailer validation (no permission change)
- Client-side watchdog (no permission change)
- Task cleanup on unmount (no permission change)

No new permission scopes, roles, or RLS policies introduced.

## 4. Permission regression risk

**Minimal** — no permission code was modified. Existing tests pass. The permission model is unchanged.

## 5. Not verified (blocked by tooling)

- Cross-tenant file download denial (requires a second tenant session)
- Unauthenticated access to protected routes (requires a fresh browser session)
- Role-based access denial (requires a non-admin test account)

These are covered by existing unit/integration tests but not by browser E2E in this phase.
