# Phase CI — Security Regression Report

Date: 2026-10-18

## 1. Test execution

The existing test suite was run to verify no regressions:

| Package         | Test files                  | Tests                         | Status |
| --------------- | --------------------------- | ----------------------------- | ------ |
| `@beaconhs/web` | 239 (237 passed, 2 skipped) | 2041 (2033 passed, 8 skipped) | PASS   |
| `@beaconhs/db`  | 62 (61 passed, 1 skipped)   | 542 (501 passed, 41 skipped)  | PASS   |

## 2. Security-related test coverage

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
- Storage freeze state machine (pure rules + DB operations)

## 3. No new security code

Phase CI did not modify any security-related code. No new permission scopes, roles, or RLS policies introduced.

## 4. Security regression risk

**Minimal** — no security code was modified. Existing tests pass. The permission model is unchanged.

## 5. Test driver security analysis

The proposed freeze test driver (not yet implemented) would need:

- Compile-time gating (not runtime env var)
- Tenant isolation (hardcoded test tenant ID)
- Authentication (actor ID from env or CLI arg)
- Audit logging
- Production build exclusion

See `phase-6u-b3-ci-freeze-driver.md` for the full analysis.
