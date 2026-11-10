# PD-02 P-6 — Query Limits, Export Approval and HTTP Acceptance Report

**Verdict: PASS.** All P-6 limits from `BEACONHS_PD02_P1_P6_CLOSURE_REPORT.md` §P-6 and
`BEACONHS_PD02_REVISED_ARCHITECTURE.md` are implemented, verified at the DB layer with real
PostgreSQL and end-to-end over real HTTP with session authentication.

## 1. Limits implemented

| V3 requirement                               | Implementation                                                                                                                                                                                                                                | Where                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Window ≤ 31 days                             | `validateAuditQueryWindow` — `to < from` or span > 31 d → `AuditQueryLimitError('window_too_wide')`                                                                                                                                           | `packages/db/src/audit-query.ts`                            |
| Single query ≤ 10,000 rows                   | `offset + limit > AUDIT_QUERY_MAX_ROWS (10_000)` → `AuditQueryLimitError('row_cap')`                                                                                                                                                          | `packages/db/src/audit-query.ts`                            |
| Page ≤ 500 rows                              | `maxPageSize` parameter clamped to `[500, 10000]`; query route rejects `pageSize > 500`                                                                                                                                                       | `audit-query.ts` + `apps/web/src/lib/audit/cross-tenant.ts` |
| `statement_timeout` 10 s                     | `SET LOCAL statement_timeout '10s'` inside the audit-reader transaction                                                                                                                                                                       | `queryAuditLogAcrossTenants`                                |
| Oversized reads need extra approval          | `assertAuditRowBudget` — cumulative `SUM(row_count)` per grant vs 10,000; over → `invalid_request` "Grant has consumed N of the 10000-row budget; request extra approval for larger reads"                                                    | `packages/db/src/audit-access.ts`                           |
| Exports need extra approval                  | `runCrossTenantAuditExport` requires `grant.extraApproval`, else 403 "Exports require a grant with extra approval…"                                                                                                                           | `apps/web/src/lib/audit/cross-tenant.ts`                    |
| Every access (success/failure) trailed       | `audit_query` / `audit_query_failed` / `audit_query_timeout` / `audit_oversize_requested` / `audit_export_requested` / `audit_export_completed` / `audit_access_denied` written to `platform_audit_access_log` with filter JSON and row count | `cross-tenant.ts`                                           |
| No `/api/v1/*` exposure, no SECURITY DEFINER | Routes are session-only under `(app)/admin/audit/*`; the audit pool is a separate connection, role switch is `SET LOCAL ROLE` only                                                                                                            | route files                                                 |
| Super-admin does not auto-receive audit keys | `hasAuditPermission` uses strict `ctx.permissions.has(key)`; `can()` super-admin bypass deliberately not used                                                                                                                                 | `cross-tenant.ts`                                           |

## 2. Server surface (session routes, all `withRouteErrors` + `requireRequestContext`)

| Route                           | Behaviour                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST/GET /admin/audit/grants`  | Create access request (201; missing/invalid `startsAt` → 400 ApiError) / list grants (approver sees all, others see own)              |
| `POST /admin/audit/grants/[id]` | `approve` / `reject` / `revoke`; strict `admin.audit.approve` else 403; non-uuid id → 400 before any data access; self-approval → 400 |
| `GET /admin/audit/query`        | JSON pages ≤ 500 rows; tenant scope server-bound to the caller's tenant; platform scope only for holders of `audit.read.platform`     |
| `GET /admin/audit/export`       | CSV (10,000-row cap) via `csvResponse`; requires grant with `extraApproval`                                                           |

UI: `apps/web/src/app/(app)/admin/audit/cross-tenant-section.tsx` renders on `/admin/audit`
for holders of an audit key; request form, approvals, paged query and CSV export. All copy is
catalogued in `packages/i18n/src/messages/{en,fr,es,zh}.json` (26 new `Generated` entries);
the updated **Admin area** manual article is re-catalogued.

## 3. Test layers (reported separately, not merged)

| Layer                                                   | Command                                                                                                                                                                                                                                                                        | Result                   | Exit code |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | --------- |
| Real PostgreSQL — limits                                | `pnpm --filter @beaconhs/db exec vitest run src/audit-query-isolation.test.ts` (P-6 describe: 31-d window OK, 32 d → window_too_wide, reversed window, `offset+limit>10000` → row_cap, exactly-10000 boundary OK, maxPageSize 499/501 rejected, export `maxPageSize=10000` OK) | 7/7 in file, 18/18 total | 0         |
| Real PostgreSQL — grant/budget                          | `pnpm --filter @beaconhs/db exec vitest run src/audit-access.test.ts` (P-6 describe: budget OK, 9500+501 rejected with budget message, `extraApproval` bypasses budget, `extra_approval` persisted true/false, rejected+extra stays inactive)                                  | 5/5 in file, 23/23 total | 0         |
| HTTP integration (real web + real PG + session cookies) | curl matrix below                                                                                                                                                                                                                                                              | all as expected          | —         |
| Pure logic                                              | covered inside the DB tests above (validation throws before any DB call)                                                                                                                                                                                                       | —                        | —         |
| Mock                                                    | none                                                                                                                                                                                                                                                                           | —                        | —         |

**No layer counts are merged into a single pass rate.**

## 4. HTTP E2E matrix (clean runs; `AUDIT_DATABASE_URL` present, magic-link sessions)

Unauthenticated / no-config phase (before `turbo.json` fix, `AUDIT_DATABASE_URL` absent):
requester without audit keys → **403** "This account has no cross-tenant audit permission.";
approver → query **503**, export **503** (fail-closed when the audit database is not configured);
unauthenticated → **307** login redirect.

Full matrix (grants `dc77b84f…`, `fbf54756…`, plus a fresh gate-verify grant):

| Scenario                           | Expected    | Result                                                             |
| ---------------------------------- | ----------- | ------------------------------------------------------------------ |
| Query without grant                | 403         | ✅ 403 "No active cross-tenant audit grant…"                       |
| Query with pending grant           | 403         | ✅ 403                                                             |
| Self-approval                      | 400         | ✅ 400 "The approver must be a different subject than the grantee" |
| Approve without permission         | 403         | ✅ 403 "This account cannot approve cross-tenant audit grants."    |
| Approve by second approver         | 200         | ✅ 200                                                             |
| Query with active grant            | 200         | ✅ 200 (49 rows, page 2 = 200)                                     |
| Deep page 500×500                  | 400 row cap | ✅ 400                                                             |
| 40-day window                      | 400         | ✅ 400 "Query window exceeds the 31-day maximum"                   |
| Export without extra approval      | 403         | ✅ 403                                                             |
| Approve with `extraApproval: true` | 200         | ✅ 200                                                             |
| Export CSV                         | 200         | ✅ 200 (header `occurred_at,tenant_id,…`)                          |
| Budget exhaustion (9500 + 501)     | 400         | ✅ 400 "Grant has consumed 9999 of the 10000-row budget…"          |
| Revoke                             | 200         | ✅ 200; subsequent query/export **403**; repeat revoke **400**     |

The 503-without-`AUDIT_DATABASE_URL` path is asserted by `audit-client.test.ts` (4 contract
cases) — the error surfaces as HTTP 503 via `auditConnectionOr503`.

## 5. Defects found and fixed during P-6 (all in this phase)

1. **`audit_service` lacked schema USAGE** — resolve/budget/log writes run as the base
   service role → 42P01. Fixed in `convergeAuditPrivileges` + `provision.sql` + preflight test.
2. **postgres.js rejects bare `Date` bindings** — `tsv()` helper, 5 call sites in
   `audit-access.ts` bind `${tsv(v)}::timestamptz`; query `from/to` likewise.
3. **`grants` route parse error → 500** — now `ApiError.invalid` (400).
4. **`migrate.ts` `convergeRolePermissions` granted the full 111-key catalogue to
   `tenant_admin`**, silently re-granting the three PD-02 audit keys on every migration
   (violates V3 P-4 default-not-granted). Fixed with `AUDIT_DEFAULT_UNGRANTED` filter;
   verified `tenant_admin` loses the keys after `db:migrate`.
5. **`occurredAt` serialized as string** — db layer now maps `new Date(r.occurred_at)`.
6. **Deep-page 500** — web layer passes `maxPageSize: max(500, pageSize+1)`; over-cap
   offsets surface as `row_cap` → 400.
7. **Route guards** — canonical `isUuid` helper, `ApiError.invalid` instead of `TypeError`,
   uuid check before `requireRequestContext` (pinned by `dynamic-uuid-route-guards.test.ts`).
8. **`turbo.json` `globalEnv` missing `AUDIT_DATABASE_URL`** — dev server did not pass the
   variable through, producing false 503s.
9. **i18n coverage failures** — 26 catalogue entries added; JSX/attribute literals wrapped in
   `GeneratedText`/`useGeneratedTranslations`; server error strings translated at render via
   `useGeneratedValueTranslations`.
10. **Corrupted statement in `grants/[id]/route.ts`** (duplicate `const { id }` + merged
    line) — repaired; caught by format/typecheck/lint gates.

## 6. Gates (each with its own exit code, final state)

`format:check` 0 · `typecheck` 0 · `lint` 0 · `test` 0 (db 612 passed/41 skipped incl. the
flaky-under-load `client-lazy` re-run green; web 2259 passed/13 skipped; worker, i18n, and all
other packages green) · `deadcode:check` 0 · `build` 0

## 7. Remaining limitations

- `audit_query_timeout` is not reachable over HTTP in a local run (the 10 s statement timeout
  is pinned at the DB layer by the isolation tests instead).
- The audit pool isolation (separate connection, role switch) is proven by
  `audit-query-isolation.test.ts` / `audit-client.test.ts`; no HTTP test can observe the
  physical connection, by design.
