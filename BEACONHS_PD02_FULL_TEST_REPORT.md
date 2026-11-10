# PD-02 Stage 8 — Full Test Report (All Phases)

**Scope:** PD-02 cross-tenant audit capability, phases 0–7 (baseline audit → role preflight →
audit connection → role-switch isolation → approval → platform audit access → query limits →
trail verification), at local HEAD after P-6.

**Environment:** isolated local development only — docker `postgres:16-alpine` probe
containers for DB-level tests and the local `beaconhs-postgres` (port 5433) stack for HTTP
tests. The production database `10.10.31.13` was **never** connected from any test.

## 1. Gate results (each gate separately, latest full run)

| Gate      | Command               | Exit code                                                |
| --------- | --------------------- | -------------------------------------------------------- |
| format    | `pnpm format:check`   | 0                                                        |
| typecheck | `pnpm typecheck`      | 0                                                        |
| lint      | `pnpm lint`           | 0                                                        |
| test      | `pnpm test`           | 0 (see §2 for the one load-induced flake and its re-run) |
| deadcode  | `pnpm deadcode:check` | 0                                                        |
| build     | `pnpm build`          | 0                                                        |

## 2. Test inventory by layer (counts are NOT merged)

### 2.1 Real PostgreSQL (docker probe containers; no mocks)

| Suite                                                                                                                                                                                                                                                                                | Cases                                                   | Exit code |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | --------- |
| `packages/db/src/audit-role-preflight.test.ts` (P-1: privilege matrix, SET LOCAL ROLE switch, attribute/preflight negative paths, converge self-heal)                                                                                                                                | 17 passed                                               | 0         |
| `packages/db/src/audit-client.test.ts` (P-2: URL contract incl. no-fallback, pool max 2, service identity, dedicated connection vs business pool, dead-port failure isolation)                                                                                                       | 8 passed                                                | 0         |
| `packages/db/src/audit-query-isolation.test.ts` (P-3 + P-6: cross-tenant read via role switch, scope filters, fail-closed empty scope, timeout pin, identity restoration after commit/rollback/exception, same-`pg_backend_pid` reuse, concurrency, window/row-cap/page-size limits) | 18 passed                                               | 0         |
| `packages/db/src/audit-access.test.ts` (P-4/P-5/P-6: grant lifecycle incl. concurrent-approval race, self-approval rejection, revocation semantics, fail-closed resolution, row budget, `extra_approval` persistence, trigger immutability, privilege matrix)                        | 23 passed                                               | 0         |
| `packages/db/src/connection-pool-isolation.test.ts` (PD-01专项A, still green)                                                                                                                                                                                                        | 7 passed                                                | 0         |
| Remaining `@beaconhs/db` suites (incl. migration-drift, RLS, FK snapshot pins updated for 0059)                                                                                                                                                                                      | 73 files: 73 passed, 1 skipped; 612 passed / 41 skipped | 0         |

`pnpm test` encountered one timeout failure in `@beaconhs/db` `client-lazy.test.ts`
(15 s import timeout) caused by host load while 27 vitest workers ran concurrently — a known,
previously documented flake unrelated to PD-02. Re-runs: the file alone (`4 passed`, 0.9 s)
and the full `@beaconhs/db` suite (`612 passed / 41 skipped`) both exit 0.

### 2.2 HTTP integration (real web server, real PostgreSQL, magic-link sessions; PD-01 + PD-02)

| Suite                                                                                                                                                                                     | Requests     | Result          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------- |
| PD-02 audit matrix (P-6 report §4): auth 403/503 fail-closed, request/approve/reject/revoke lifecycle, self-approval 400, deep-page 400, 31-day window 400, export gating, row budget 400 | 16 scenarios | all as expected |
| Fresh gate-verify run after the i18n refactor: create 201 → approve 200 → query 200 → revoke 200 → query 403                                                                              | 5 requests   | all as expected |
| PD-01 write/patch/delete matrix (prior phase, unchanged)                                                                                                                                  | 60+ requests | all as expected |

### 2.3 Pure logic / unit

Covered inside the suites above (window validation, budget validation, page-size clamping,
permission checks, i18n key hashing). `@beaconhs/i18n` catalogue tests: 5 passed.
`@beaconhs/web` 269 files (2259 passed / 13 skipped) — unit, contract and pin tests, exit 0.

### 2.4 Mock tests

None used in any PD-02 phase. The skip-if-no-docker harness marks Docker-dependent suites
skipped when Docker is unavailable; on this host they all ran for real.

## 3. Phase gate summary

| Phase                        | Report                                           | Verdict |
| ---------------------------- | ------------------------------------------------ | ------- |
| 0 Baseline                   | `BEACONHS_PD02_BASELINE_AUDIT.md`                | PASS    |
| P-1 Role preflight           | `BEACONHS_PD02_P1_ROLE_PREFLIGHT.md`             | PASS    |
| P-2 Audit connection         | `BEACONHS_PD02_P2_AUDIT_DATABASE_CONNECTION.md`  | PASS    |
| P-3 Role-switch isolation    | `BEACONHS_PD02_P3_ROLE_SWITCH_ISOLATION.md`      | PASS    |
| P-4 Approval & authorization | `BEACONHS_PD02_P4_APPROVAL_AND_AUTHORIZATION.md` | PASS    |
| P-5 Platform audit access    | `BEACONHS_PD02_P5_AUDIT_ACCESS.md`               | PASS    |
| P-6 Query limits             | `BEACONHS_PD02_P6_QUERY_LIMITS.md`               | PASS    |
| Stage 7 Trail                | `BEACONHS_PD02_AUDIT_TRAIL_VERIFICATION.md`      | PASS    |

## 4. Statement on production

No production deployment, migration, role creation, data change, RLS change, push or merge
was performed in this task. Production remains at APP_VERSION `62b92b94…` with 58 migrations;
0059 is applied locally only and must ship through the normal migration-before-deploy flow
after approval.
