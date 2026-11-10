# PD-02 P-5 — Platform-Level `audit_access` (PASS)

Stage gate: **PASS** — the audit authorization data model is platform-level,
protected by privileges and triggers (not RLS), never tenant-scoped.

## 1. Data model

`packages/db/src/schema/audit-access.ts` (schema) +
`packages/db/drizzle/0059_audit_access_platform.sql` (migration).

| Table                       | Purpose                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `audit_access_grants`       | Requests → approvals → revocations; the only source of cross-tenant audit authorization  |
| `platform_audit_access_log` | Append-only trail of every audit-authorization action (12 action values, CHECK-enforced) |

Key decisions (V3 conformance):

- **Not tenant-scoped**: neither table is in `TENANT_SCOPED_TABLES`
  (`packages/db/src/rls.ts` untouched — still 191 tables). Verified by test.
- **No RLS**: protection is privilege-based — `REVOKE ALL ON ... FROM PUBLIC`
  for both tables; only `audit_service` receives runtime privileges via
  `convergeAuditPrivileges`.
- `grantee_tenant_id` / `actor_tenant_id` are **nullable uuid without a tenant
  FK** (platform-scope rows have NULL; avoids RESTRICT conflicts with tenant
  lifecycle), exactly as V3 §P-5 specifies.
- User references are `text` → `"user".id` with `ON DELETE RESTRICT` (Better-Auth
  ids are text): a grant or trail row can never outlive into an ownerless state.
- Trail integrity: `platform_audit_access_log_immutable()` trigger —
  `UPDATE`/`DELETE` allowed **only** for `current_user = 'beaconhs_owner'`,
  everything else raises `platform_audit_access_log is append-only`. TRUNCATE is
  denied by privilege (no owner grant; owner-only per V3).
- CHECK constraints: `scope IN ('tenant','platform')`, `expires_at > starts_at`,
  window ≤ 90 days, purpose 1..500, `approved_by <> grantee`
  (`approver_ck`), revocation pair (`revoked_at`/`revoked_by` both-NULL-or-both-set),
  log `action` ∈ 12 enumerated values.
- Indexes: grantee+scope, window, occurred_at, grant_id, actor+occurred_at.

## 2. Migration 0059

- Authored with `pnpm db:generate` (drizzle snapshot `_0059_snapshot.json` +
  journal entry `0059_audit_access_platform`), then the CHECK/trigger/REVOKE
  statements appended to the generated file — the same pattern as 0056/0057.
  Statement count and names pinned by
  `production-cutover-integrity.test.ts` (migration list + journal tail now
  include 0059).
- `fk-snapshot-coverage.test.ts` baseline advanced 0056 → 0059 snapshot
  (schema 518 → 522 FKs; snapshot and schema agree).
- Pure additive (2 new tables + indexes); no RLS change; no existing-table change.

**Deviation from V3, minimal and recorded**: V3 grants `audit_service`
SELECT/INSERT on grants and SELECT/INSERT on the log. Approval/rejection/revocation
require **UPDATE** on `audit_access_grants` (single-statement atomic approve);
`convergeAuditPrivileges` therefore grants `SELECT, INSERT, UPDATE` on grants and
`SELECT, INSERT` on the log — nothing more. DELETE is denied on both tables and
asserted so.

## 3. Privilege matrix (verified, real PostgreSQL)

| Subject                                               | grants: SELECT | grants: INSERT | grants: UPDATE | grants: DELETE | log: SELECT             | log: INSERT | log: UPDATE/DELETE |
| ----------------------------------------------------- | -------------- | -------------- | -------------- | -------------- | ----------------------- | ----------- | ------------------ |
| `audit_service` (via audit connection)                | ✅             | ✅             | ✅             | ❌             | ✅                      | ✅          | ❌                 |
| `beaconhs_app` / `beaconhs_super` / any business role | ❌             | ❌             | ❌             | ❌             | ❌                      | ❌          | ❌                 |
| `audit_reader` (SET LOCAL ROLE, reads only)           | ❌             | ❌             | ❌             | ❌             | ❌                      | ❌          | ❌                 |
| `beaconhs_owner`                                      | owner          | owner          | owner          | owner          | owner (trigger permits) | owner       | owner              |
| PUBLIC                                                | ❌             | ❌             | ❌             | ❌             | ❌                      | ❌          | ❌                 |

`assertAuditTablePrivileges` (runs in every migration) now asserts the
`audit_service` shape exactly — SEL/INS/UPD on grants (no DEL), SEL/INS on the
log (no UPD/DEL) — and the offender scan treats `(role, table)` pairs outside the
three-entry allowlist as fatal.

## 4. Verified requirements

`packages/db/src/audit-access.test.ts` (23/23) +
`packages/db/src/audit-role-preflight.test.ts` (17/17) + integrity suites, all
exit code 0. Commands:

- `pnpm --filter @beaconhs/db exec vitest run src/audit-access.test.ts`
- `pnpm --filter @beaconhs/db exec vitest run src/audit-role-preflight.test.ts`
- `pnpm --filter @beaconhs/db exec vitest run src/production-cutover-integrity.test.ts src/scripts/check-migration-drift.test.ts src/fk-snapshot-coverage.test.ts`

| Requirement                                             | Evidence                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `audit_access` not in `TENANT_SCOPED_TABLES`            | test asserts the array contents; `rls.ts` diff shows zero change                                                      |
| Ordinary tenant role cannot read/modify platform grants | `app_probe` SELECT/INSERT denied                                                                                      |
| Non-approver cannot approve                             | app check + DB `approver_ck` (23/23 suite)                                                                            |
| Requester cannot self-approve                           | same                                                                                                                  |
| Revoked / expired grants unusable                       | `resolveActiveAuditGrant` → `null`                                                                                    |
| Concurrent approvals produce a single active grant      | race test, exactly one winner                                                                                         |
| No cross-tenant grant leakage                           | scope/tenant mismatch → `null`                                                                                        |
| No path for a normal user to rewrite an approval        | no business-role privileges; UPDATE only via audit connection; log append-only                                        |
| Migration forward path                                  | `pnpm db:migrate` on the local 5433 database: ledger 58 → 59, RLS 191 tables, audit privilege matrix verified, exit 0 |
| Migration drift guard                                   | "proposes NOTHING" test passes with the generated snapshot                                                            |

## 5. Rollback

0059 is additive: dropping the two tables (and the trigger function) restores the
pre-0059 state; the journal entry can be removed while no grant data exists.
No data backfill occurs.

## 6. Residual notes

- The immutability trigger whitelists `current_user = 'beaconhs_owner'`
  literally — the same pattern as the existing `audit_log` trigger (0056/0057);
  the test harness provisions that role for cleanup only.
- `platform_audit_access_log.filter` is `jsonb NOT NULL DEFAULT '{}'` — bound as
  a JSON string from the app layer (postgres.js cannot bind bare objects).
