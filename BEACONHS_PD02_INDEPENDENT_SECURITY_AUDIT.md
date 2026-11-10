# PD-02 Cross-Tenant Audit — Independent Security Audit

- **Date:** 2026-11-11
- **Reviewer:** Independent security reviewer (did not participate in implementation)
- **Repo:** /home/test/projects/beaconhs-hse @ local main (PD-02 commits 611ef924…29ac3bdf + docs)
- **Authority:** BEACONHS_PD02_REVISED_ARCHITECTURE.md, BEACONHS_PD02_SECURITY_REVIEW_V3.md, BEACONHS_PD02_P1_P6_CLOSURE_REPORT.md ("方案 A / V3")
- **Method:** Fresh code read of every PD-02 artifact (no reliance on closure reports), plus **live read-only probes** against the local cluster `beaconhs-postgres` (db `beaconhs`, user `postgres`): role attributes, `information_schema.role_table_grants`, `pg_auth_members`, `relrowsecurity`, and authenticated `SET ROLE … SELECT count(*)` proofs. No destructive command was run; no file other than this report was touched.

---

## 1. Per-constraint verification table

| #   | Constraint (approved design)                                                                                                                                                    | Verdict                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | audit_reader NOLOGIN/NOSUPERUSER/BYPASSRLS, ONLY SELECT on audit_log; audit_service sole member; neither in beaconhs_owner; nothing else granted audit_reader                   | **PASS (live-verified)**                | Live DB: audit_reader `rolcanlogin=f, rolsuper=f, rolbypassrls=t`; audit_service `rolcanlogin=t, rolsuper=f, rolbypassrls=f`; sole member of audit_reader is audit_service; no other memberships. `packages/db/src/audit-roles.ts` `assertAuditRoleAttributes` (lines 24-30) + `assertAuditTablePrivileges` enforce the same matrix at migrate time, fail-closed. Deviation noted in §3 F9 (audit_service holds table privileges on grants/log — documented, required).                                                                                                                                                                                                                   |
| 2   | Dedicated AUDIT_DATABASE_URL, pool max 2, prepare:false; blank/missing → 503 fail-closed; never business pool                                                                   | **PASS**                                | `packages/db/src/audit-client.ts`: `readAuditDatabaseUrl` trims and returns null on absent/blank; `createAuditConnection postgres(url,{max:2, idle_timeout:30, connect_timeout:10, prepare:false})`; constant pool size, not configurable; no fallback to DATABASE_URL/SUPERADMIN_DATABASE_URL (pinned by `audit-client.test.ts`); URL never logged. `apps/web/src/lib/audit/cross-tenant.ts` maps `AuditConnectionUnavailableError` → 503 (`ApiError.unavailable`).                                                                                                                                                                                                                      |
| 3   | Single txn `SET LOCAL ROLE audit_reader` + `SET LOCAL statement_timeout '10s'`; fully parameterized; no SECURITY DEFINER                                                        | **PASS (live-verified)**                | `packages/db/src/audit-query.ts` `queryAuditLogAcrossTenants`: one `sql.begin` with `set local role audit_reader` / `set local statement_timeout = '10s'` (constants only, via `tx.unsafe` — not injectable); `buildWhere` uses exclusively tagged-template parameters (`tenant_id = any(${ids}::uuid[])`, empty array → literal `false`, `action = any(${arr})`). Live: zero `prosecdef` functions in schema `public`. Isolation pinned by `audit-query-isolation.test.ts` (SET LOCAL scope, timeout non-persistence, same backend pid reused → no session-state leakage).                                                                                                               |
| 4   | admin.audit.approve strict (super-admin NOT auto-granted); grantee≠approver (app + DB CHECK); mandatory purpose; ≤90d; revocation immediate & uncached; rejected never activate | **PASS with findings**                  | Key check is `ctx.permissions.has(key)` exact Set match — no wildcard, no super-admin bypass (`packages/tenant/src/index.ts:61,99-108`; `can()` never used on audit keys). `approveAuditAccessRequest` (`packages/db/src/audit-access.ts`) does a pre-check plus an atomic guarded UPDATE (`approved_by_user_id is null and revoked_at is null and grantee_user_id <> ${approver}`) — concurrent-approve race pinned by test (exactly one wins); DB CHECK `approver_ck` in 0059. Purpose 1-500 enforced app + CHECK; window ≤90d enforced app + CHECK; resolution is uncached per request; rejected requests are voided. Gaps: F3 (no approved_at column), F4 (approval tenant boundary). |
| 5   | Platform tables not tenant-scoped, REVOKE ALL FROM PUBLIC, only owner+audit_service privileges, append-only trail, 12-value action CHECK                                        | **FAIL — F1 (Critical, live-verified)** | Correct: not in `TENANT_SCOPED_TABLES`/`rls.ts`; 0059 `REVOKE ALL … FROM PUBLIC`; append-only trigger; 12-value action CHECK. **Broken:** live `information_schema.role_table_grants` shows `beaconhs_app` and `beaconhs_super` hold SELECT/INSERT/UPDATE/DELETE on **both** `audit_access_grants` and `platform_audit_access_log`; live `set role beaconhs_app; select count(*) from audit_access_grants` → 9 rows, `platform_audit_access_log` → 77 rows. See F1.                                                                                                                                                                                                                       |
| 6   | window ≤31d, ≤10,000 rows/query, page ≤500, exports/oversize need extra_approval; every access trailed                                                                          | **PASS with low findings**              | `audit-query.ts` constants (31/10000/500/'10s'); session layer clamps pageSize 1..500, validates window (default trailing 24h), `assertAuditRowBudget` (skipped when `extra_approval`), offset+limit ≤ 10000; export path requires `grant.extraApproval` else 403 + `audit_export_requested` trail. Denials, timeouts, failures all trailed. Caveats: F6/F7/F8 (budget race, off-by-one, untraced-read window).                                                                                                                                                                                                                                                                           |
| 7   | audit.read.tenant / audit.read.platform / admin.audit.approve NOT default-granted to tenant_admin (incl. convergeRolePermissions)                                               | **PASS**                                | `packages/db/src/schema/iam.ts:349-353` keys in catalogue; `:394-398 AUDIT_DEFAULT_UNGRANTED`; BUILTIN_ROLES tenant_admin = catalogue minus audit keys; `migrate.ts:186-191` converge subtracts `AUDIT_DEFAULT_UNGRANTED`; no seed path grants the keys; `migrate.ts:369-374` `distinctRoles` must equal exactly 7 or migrations abort (fail-closed).                                                                                                                                                                                                                                                                                                                                     |
| 8   | No /api/v1 exposure; session routes only under (app)/admin/audit/*; tenant scope server-bound                                                                                   | **PASS**                                | No audit code under `apps/web/src/app/api/`; only callers of the audit query/grant primitives are `apps/web/src/lib/audit/cross-tenant.ts` + the 4 route files under `apps/web/src/app/(app)/admin/audit/`; no worker usage. Tenant scope: `tenantIds = scope==='tenant' ? [ctx.tenantId] : params.tenantIds` — server-bound; grant resolution requires `grantee_tenant_id = ctx.tenantId`.                                                                                                                                                                                                                                                                                               |

---

## 2. Findings

### F1 — CRITICAL — beaconhs_app / beaconhs_super hold full CRUD on the platform grant + trail tables (constraint 5 violated)

- **Location:** `scripts/cluster/provision.sql:148-149` (blanket `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO beaconhs_app, beaconhs_super`) and `:181-188` (`ALTER DEFAULT PRIVILEGES FOR ROLE beaconhs_owner` granting CRUD on future tables); `packages/db/drizzle/0059_audit_access_platform.sql` only `REVOKE … FROM PUBLIC`, which does not strip explicit role grants; `packages/db/src/audit-roles.ts` (`convergeAuditPrivileges` / `assertAuditTablePrivileges`) checks only the two audit roles, never `beaconhs_app`/`beaconhs_super`.
- **Live proof (read-only):** `information_schema.role_table_grants` shows both roles with SELECT/INSERT/UPDATE/DELETE on both platform tables; `set role beaconhs_app; select count(*) from audit_access_grants` → 9; `platform_audit_access_log` → 77. Neither table has RLS (`relrowsecurity=f`).
- **Attacker impact:** any SQL that executes on the **business pool** as `beaconhs_app` (server-action bug, SQLi, an over-broad `withTenant`/`withSuperAdmin` query) can, without any grant or approval: read every access grant platform-wide (cross-tenant metadata incl. grantee identities); **forge approval** by `UPDATE audit_access_grants SET approved_by_user_id = <any other user>` — the CHECK only requires approver≠grantee, nothing binds the named approver's consent or their `admin.audit.approve` possession — thereby minting a platform-scope grant for themselves; DELETE grant rows; INSERT forged trail rows (the immutability trigger blocks UPDATE/DELETE but not INSERT).
- **Why the tests missed it:** the P-5 case (`audit-access.test.ts:447`, "ordinary application role has ZERO access") builds a lab cluster that hand-creates roles (synthetic `app_probe`), applies 0059 + `convergeAuditPrivileges`, and **never runs provision.sql** — so it asserts a privilege state production never has. False assurance.
- **Fix direction:** explicit `REVOKE ALL ON audit_access_grants, platform_audit_access_log FROM beaconhs_app, beaconhs_super, beaconhs_backup` in 0059/converge (idempotent), plus a `assertAuditTablePrivileges` extension that **negatively** asserts no non-audit role holds any privilege on the two platform tables; run after every provision. Also fix the P-5 test to run provision.sql (or the real provisioning path) before asserting zero access.
- **Status:** new (introduced by PD-02's own provisioning/convergence contract; undetected by PD-02 tests).

### F2 — HIGH — beaconhs_super (BYPASSRLS) reads cross-tenant audit_log on the business pool with no grant and no trail

- **Location:** role attribute `rolbypassrls=t` on `beaconhs_super` + `GRANT SELECT … ON audit_log` (provision baseline); audit_log RLS is irrelevant to a BYPASSRLS role.
- **Live proof:** `set role beaconhs_super; select count(*) from audit_log` → 88 rows (whole table, all tenants), on the business connection, no `AUDIT_DATABASE_URL`, no grant record, no trail row, no 503. UPDATE/DELETE are blocked by `audit_log_immutable` (whitelist `beaconhs_owner`) — read exposure only.
- **Impact:** contradicts the architecture claim that audit_reader is "the ONLY cross-tenant audit identity" and §6 "超管也需 grant". A super-admin code path (or a bug in a super-pool query) yields silent cross-tenant audit-log reads outside the entire PD-02 approval/trail chain.
- **Fix direction:** either `REVOKE SELECT ON audit_log FROM beaconhs_super` (forcing super through the grant workflow), or consciously amend the design to exempt super and document the exemption; at minimum add a trail on super-pool audit_log reads.
- **Status:** pre-existing baseline (design explicitly left roles unchanged), **newly surfaced** by PD-02's threat model and contradicting PD-02's written claims.

### F3 — MEDIUM — migration 0059 amended in place after being applied

- **Location:** `packages/db/drizzle/0059_audit_access_platform.sql` — commit b530375f added the `extra_approval` line to an already-merged migration; `meta/0059_snapshot.json` id changed (59bd6e65… → 5b24d904…), `_journal.json` `when` rewritten.
- **Impact:** any environment that already applied the original 0059 will never gain `extra_approval` (drizzle tracks by count/tag, not content) → schema drift between environments; exports would then fail or behave differently. Local DB happens to be consistent (59 migrations, amended journal applied).
- **Fix direction:** revert 0059 to its merged form and add `0060` for `extra_approval`; adopt a "migrations immutable after merge" rule.
- **Status:** new (process defect; PD-02 not yet deployed, so fixable now).

### F4 — MEDIUM — approval tenant boundary not enforced (cross-tenant approval and platform grants by tenant-level approvers)

- **Location:** `packages/db/src/audit-access.ts` `approveAuditAccessRequest` / `revokeAuditAccess`; `apps/web/src/app/(app)/admin/audit/grants/[id]/route.ts` — checks only `admin.audit.approve`; no check that the approver's tenant matches the grantee's tenant, and no platform-approver authority distinction for `scope='platform'` grants.
- **Impact:** an `admin.audit.approve` holder in tenant B can approve (or revoke) a grant for a user in tenant A, and any approve-holder can approve **platform-scope** grants — defeating the design's "同租户审批人" requirement for `audit.read.tenant` and leaving platform grants approvable by tenant-level admins. Grants GET also lists other tenants' grants to any approve-holder.
- **Fix direction:** at approval time bind approver↔grantee tenant for tenant-scope grants (grantee_tenant_id = approver's ctx.tenantId) and introduce an explicit platform-approver determination (e.g. dedicated key or super/platform membership) for platform-scope grants; record the approver's tenant on the grant for accountability.
- **Status:** new.

### F5 — MEDIUM — no impersonation guard on any audit path (trail misattribution / access laundering)

- **Location:** `assertNotImpersonating` exists (`packages/tenant/src/index.ts:285-287`) but is **not** called in any of the 4 audit routes, `cross-tenant.ts`, `page.tsx`, or `cross-tenant-section.tsx`.
- **Impact:** impersonation swaps `ctx.userId` and permissions to the impersonated user. Sequence: admin impersonates user A → requests a grant as A → un-impersonates → approves as self → re-impersonates A → runs cross-tenant queries/exports; every trail row then attributes the access to A, and the admin effectively operates under A's grant scope. This defeats both accountability and the impersonation policy (bulk exports are on the guard list).
- **Fix direction:** call `assertNotImpersonating` in all 4 routes (or centrally in `runCrossTenantAuditQuery/Export` and grant mutations) so audit access is never exercised under an impersonated identity.
- **Status:** new.

### F6 — LOW — row-budget check is not atomic with query + trail (concurrent bypass)

- **Location:** `packages/db/src/audit-access.ts` `assertAuditRowBudget` (SUM over trailed rows) vs `cross-tenant.ts` query+trail sequence.
- **Impact:** concurrent requests under one grant each pass the budget check before any of them trail; cumulative rows can exceed the 10,000 cap. Bounded by concurrency, not exploitable for unlimited reads.
- **Fix direction:** a budget-reserving counter (e.g. conditional UPDATE of a running total on the grant row, released on failure), or accept and document the approximation.
- **Status:** new.

### F7 — LOW — budget off-by-one and trail rowCount semantics

- **Location:** `cross-tenant.ts` — query reads `pageSize+1` rows (hasMore probe) while the budget counted `pageSize`; trailed `rowCount` is the post-slice value.
- **Impact:** negligible inflation of actual rows vs budget per request (~1 row); accounting is slightly understated.
- **Fix direction:** count the probe row (or trail the fetched count) for exact accounting.
- **Status:** new.

### F8 — LOW — untraced-read window when the post-query trail insert fails

- **Location:** `cross-tenant.ts` — trail is written **after** the successful query in a separate transaction; if the trail insert fails (pool exhaustion, connectivity), the caller gets a 500 but the read already happened and no `audit_query` row exists.
- **Impact:** "every access (success/failure) trailed" can be violated by partial failure; silent only as an error response.
- **Fix direction:** write the trail in the same transaction as the read (the reader role can't insert into the trail — but the trail can be written by the outer session in the same `sql.begin` via a second connection or by restructuring to trail-first with a completion update), or at minimum retry + alert on trail failure.
- **Status:** new.

### F9 — INFO — audit_service holds real table privileges (doc deviation)

- `packages/db/src/audit-roles.ts:127-136` documents the deviation from architecture §1 ("audit_service 无表权限"): grant management and trail writes run as the audit_service base identity, so it needs SELECT/INSERT/UPDATE on `audit_access_grants` + SELECT/INSERT on `platform_audit_access_log`. Necessary and contained; the architecture doc should be corrected to match.

### F10 — INFO — dead CHECK value `audit_export_approved`

- The 12-value action CHECK includes `audit_export_approved`, which no code path emits. Either emit it when `extra_approval` is exercised, or drop the value from the CHECK in the next migration (live already shipped with it — low priority).

### F11 — INFO — window validation lives only in the session layer

- `queryAuditLogAcrossTenants` itself does not call `validateAuditQueryWindow`; the 31-day cap is enforced by `cross-tenant.ts` for both query and export paths (verified). Safe today because the query function has exactly two callers; an internal lint/test pinning the caller set would prevent future bypass.

---

## 3. Verified vs trusted

**Verified directly (code + live DB):** all 8 constraints against source (audit-roles.ts, audit-client.ts, audit-query.ts, audit-access.ts, migrate.ts, schema/iam.ts, schema/audit-access.ts, rls.ts, drizzle/0059, provision.sql, cross-tenant.ts, 4 route files, errors.ts, page/section components); role attributes, memberships, table grants, RLS flags, immutable-trigger bodies, SECURITY DEFINER absence, and end-to-end `SET ROLE` read proofs against the live local cluster; test files' assertions and their lab-environment construction (including the F1 gap).

**Trusted / not re-derived:** Next.js middleware/session issuance semantics (pre-existing platform, out of PD-02 scope); the docker-compose/MinIO storage baseline; that no other branch carries conflicting PD-02 code (reviewed the checked-out main only). The closure reports were read only to extract the claims — none of their claims were accepted without code/live evidence; notably the closure report predates implementation ("数据库实施尚未开始", line 109) and its P-5 claim is invalidated by F1's test-environment gap.

---

## 4. Clean areas (explicitly stated)

- **SQL injection:** the entire cross-tenant query path is parameterized tagged-template SQL; the only `unsafe()` calls interpolate compile-time constants. Clean.
- **GUC/session leakage across pooled connections:** `SET LOCAL` semantics + dedicated pool (`prepare:false`, max 2) + tests proving timeout non-persistence and same-backend reuse after rollback. Clean.
- **Privilege escalation to audit_reader:** no role other than audit_service can `SET ROLE audit_reader` (live-verified membership); audit_service membership is empty; preflight fails closed on any deviation. Clean.
- **Route authz:** all 4 routes call `requireRequestContext`, wrap `withRouteErrors`, validate UUIDs before use, and gate on exact permission keys with no wildcard/super bypass; the cross-tenant UI section is gated on the three audit keys. Clean (aside from F4/F5).
- **Error/i18n leakage:** server messages are app-controlled constants rendered via translation fallback; unknown errors collapse to generic 500 text; no SQL/internal detail escapes. Clean.
- **Fail-closed connection:** blank/missing `AUDIT_DATABASE_URL` → 503 everywhere; no fallback; URL never logged. Clean.
- **Grant lifecycle:** rejected grants can never activate; revocation immediate and uncached; self-approval blocked at app and DB layers; concurrent-approve race resolved atomically. Clean.
- **Default permission posture:** audit keys absent from tenant_admin defaults, from converge, and from seed. Clean.

---

## 5. FINAL VERDICT

# FAIL

Reason: hard constraint 5 is violated in the live cluster (F1, Critical) — the business and super roles retain full CRUD on the platform grant and trail tables, providing a concrete path to forge approvals and tamper with platform audit state from the business pool, while the P-5 test that claims to pin this property does not reproduce the provisioned environment. Constraint 5's violation is a real bypass, not a documentation nit, and the task bar explicitly forbids passing on a verified constraint violation.

**Conditions to convert to PASS:**

1. (F1, Critical) Strip privileges on `audit_access_grants`/`platform_audit_access_log` from `beaconhs_app`/`beaconhs_super`/`beaconhs_backup` idempotently in the migration/converge path; add a negative privilege assertion for non-audit roles; make the P-5 test run the real provisioning path. Re-verify with live `SET ROLE` probes.
2. (F2, High) Resolve the `beaconhs_super` BYPASSRLS audit_log read exposure (revoke, or amend and document the design exemption).
3. (F3–F5, Medium) Fix the 0059-in-place amendment, enforce the approval tenant boundary, and add the impersonation guard.
4. (F6–F11, Low/Info) Address or explicitly accept with documented rationale.

---

# Re-verification (round 2)

- **Date:** 2026-11-11
- **Scope:** commits `41ff6ea4` (fix) + `4c1c530e` (docs); claims re-verified independently from code and live probes, not from BEACONHS_PD02_STAGE9_REMEDIATION.md.
- **Method:** full read of `git show 41ff6ea4` (provision.sql, 0059, audit-roles.ts, audit-access.ts, cross-tenant.ts, audit-access.test.ts); live read-only probes against `beaconhs-postgres`; re-ran `pnpm --filter @beaconhs/db exec vitest run src/audit-access.test.ts src/audit-role-preflight.test.ts` (**2 files, 48/48 passed**, including the new production-shaped F1 drift tests). Working tree clean; no files modified except this report.

## Per-finding status

### F1 (Critical) — CLOSED, residual nuance → N1

- **Live:** `set role beaconhs_app; select count(*) from audit_access_grants` → `permission denied`; same for `beaconhs_super` on both platform tables. `information_schema.role_table_grants` shows only `audit_service` (SELECT/INSERT/UPDATE grants; SELECT/INSERT log), `beaconhs_owner`, and — residual — `beaconhs_backup` SELECT (see N1).
- **Code:** 0059 appends a `to_regrole`-guarded DO block revoking app/super on both platform tables and super's SELECT on audit_log; `convergeAuditPrivileges` re-enforces on every migrate run; `provision.sql` places the `\gexec` revokes **after** the blanket GRANT (order verified); `assertAuditTablePrivileges` gains a `businessOffenders` gate that fails the migration closed on any app/super privilege — pinned by a new test that **simulates the exact provision-time blanket grant** (the round-1 false-assurance gap) and asserts converge heals it and the gate fails closed when drift is re-injected.
- **Accepted nuance verified:** `beaconhs_app` keeps SELECT on `audit_log` — RLS is `FORCE`d (`relforcerowsecurity=t`) and tenant-scoped, and the per-tenant admin audit page requires it; the gate deliberately exempts app SELECT on audit_log while rejecting super SELECT. Consistent.

### F2 (High) — CLOSED

- **Live:** `set role beaconhs_super; select count(*) from audit_log` → `permission denied`; `has_table_privilege(beaconhs_super, audit_log, INSERT)=t / SELECT=f` (INSERT preserved for platform trail appends).
- Revoked consistently in 0059, converge, and provision.
- **No runtime code path reads audit_log via the super pool:** grep over apps/packages shows only `packages/db/src/audit-query.ts` (dedicated AUDIT_DATABASE_URL connection) and `apps/web/scripts/backfill-tenant-storage-keys.ts` — an offline pre-cutover maintenance script pinned to a fingerprint-checked dev target, not a runtime path. Acceptable.

### F3 (Medium) — CLOSED

- 0059 is now the single final file. The round-2 append is privilege-only raw SQL (DO block), so no snapshot/journal regeneration is required (drizzle snapshots track schema objects, not privileges) — meta consistency holds. PD-02 is undeployed, so every environment will apply this identical file. Local DB matches the final file (live revokes verified; ledger = 59 migrations; `extra_approval` present).

### F4 (Medium) — CLOSED (revoke exception ACCEPTED)

- `decideCrossTenantAuditGrant` now: platform-scope grants require `audit.read.platform`; tenant-scope grants require `granteeTenantId === ctx.tenantId` or `audit.read.platform`; boundary denials are trailed as `audit_access_denied` with the decision reason.
- **No bypass via unknown grant id:** a null grant skips the boundary check but falls through to `approveAuditAccessRequest`/reject, which fail `not_found` (404) — nothing activates.
- **No exploitable TOCTOU:** grant `scope`/`granteeTenantId` are immutable after creation (no code path updates them); the guarded UPDATE still atomically enforces pending-state and grantee≠approver.
- **Unbounded revoke — ACCEPTED with note:** revocation only removes access (fail-safe direction), is trailed (`grant_revoked`), and must not be tenant-blocked in an emergency. Residual: an `admin.audit.approve` holder can revoke other tenants' grants (cross-tenant capability-disruption, bounded and fully trailed). Acceptable; keep under review.

### F5 (Medium) — CLOSED

- `assertAuditSubject(ctx)` → `assertNotImpersonating(ctx, 'cross-tenant audit')` added to all four orchestration entry points (`runCrossTenantAuditQuery`, `runCrossTenantAuditExport`, `requestCrossTenantAuditAccess`, `decideCrossTenantAuditGrant`); the 4 routes invoke only these orchestrators, so coverage is complete. Signature matches `packages/tenant/src/index.ts:285`.

### F6 (Low) — ACCEPTED (documented)

- Remediation doc records the rationale: bounded by in-flight concurrency × ≤500 rows, all consumption trailed, the budget is a runaway guard-rail (not a security boundary — bulk reads need `extra_approval`). Reasonable; atomicity would require coupling the read with the append-only trail in one transaction, disproportionate.

### F7 (Low) — budget semantics verified NOT a bug; second facet is real → N2

- Their claim is correct for the budget boundary itself: `used + requestedRows > MAX` rejects, `=` passes — exact-cap semantics are right; the ≤1-row probe delta is noise.
- However the round-1 off-by-one note also covers a genuine composition edge: the session layer fetches `pageSize + 1` rows, so at the far end of a full window (pageSize=500 → page 20: offset 9500 + limit 501 = 10001 > `AUDIT_QUERY_MAX_ROWS`) `queryAuditLogAcrossTenants` throws `row_cap` and the **last page returns 400 instead of rows**. Fail-closed, functional-only → N2 (Low).

### F8 (Low) — CLOSED (fail-closed by construction, verified in code)

- The success-trail `recordAuditAccessEvent('audit_query')` executes before `return`, with no try/catch swallowing: if the trail insert fails, the caller receives an error and **no rows are returned**. Residual nuance: the server-side read has already occurred at that point (narrow window, dedicated connection, failure observable). Accept.

## New findings from the remediation diff

### N1 — MEDIUM — `beaconhs_backup` (LOGIN, BYPASSRLS) still holds SELECT on both platform audit tables

- **Location:** `scripts/cluster/provision.sql` — `GRANT SELECT ON ALL TABLES IN SCHEMA public TO beaconhs_backup;` runs **after** the PD-02 `\gexec` revoke block, so a provision (re-)run re-grants backup SELECT on `audit_access_grants` and `platform_audit_access_log`; neither the 0059 DO block, `convergeAuditPrivileges`, nor the `businessOffenders` gate (which checks only `beaconhs_app`/`beaconhs_super`) strips or detects it.
- **Live:** `information_schema.role_table_grants` shows `beaconhs_backup | audit_access_grants | SELECT` and `beaconhs_backup | platform_audit_access_log | SELECT` (plus audit_log SELECT); role attributes `LOGIN ... BYPASSRLS`.
- **Impact:** constraint 5's "only owner + audit_service" is still violated for this role. A holder of the backup credential can read the platform-wide grant registry and the access trail, and — via BYPASSRLS — the cross-tenant audit_log. Not reachable from the application runtime pool (the round-1 F1 escalation path), but it is a standing login-capable privilege outside the intended matrix and invisible to the fail-closed gate.
- **Fix direction:** extend the same three remediation points (0059 DO block, converge, provision revoke block, `businessOffenders` query) to `beaconhs_backup` for the two platform tables — or, if backup genuinely must dump them, document that as an explicit design exception and extend the gate to assert backup holds SELECT **only**. audit_log SELECT for logical backup is arguably the role's function but should be stated in the architecture doc alongside the BYPASSRLS caveat.
- **Status:** new (residual of F1's remediation scope).

### N2 — LOW — last page of a full window returns 400 (`row_cap`) due to the +1 probe

- **Location:** `apps/web/src/lib/audit/cross-tenant.ts` (`limit: pageSize + 1`, `offset = (page-1)*pageSize`) vs `packages/db/src/audit-query.ts` (`offset + limit > AUDIT_QUERY_MAX_ROWS` → `row_cap`).
- **Impact:** with pageSize=500, page 20 of a ≥9,501-row window computes 9500+501=10001 > 10000 → AuditQueryLimitError → 400 to the user; the final page of a fully-consumed window is unreachable. Fail-closed (no over-read), functional bug only. Pagination UX defect, not a security issue.
- **Fix direction:** cap the probe at the window boundary (e.g. `limit = min(pageSize + 1, AUDIT_QUERY_MAX_ROWS - offset)`) or exempt the empty tail position in the row-cap check.
- **Status:** new (edge surfaced by round-2 scrutiny of F7).

## Constraint-5 letter check after remediation

Grantee matrix on the three audit tables (live): `audit_owner`-level privileges only for `beaconhs_owner`; SELECT/INSERT/UPDATE for `audit_service` on grants, SELECT/INSERT on log; SELECT for `audit_reader` on audit_log; SELECT for `beaconhs_app` on audit_log (RLS-forced, tenant-scoped); INSERT/UPDATE (no SELECT) for `beaconhs_super` on audit_log; **SELECT for `beaconhs_backup` on all three (N1)**. One residual violation of the "owner + audit_service only" letter, on a maintenance role, undetected by the gate.

## FINAL VERDICT (round 2)

# CONDITIONAL PASS

Round-1 blocking findings are genuinely closed at the application-facing level: the business pool can no longer read or forge platform audit state (F1), super can no longer read cross-tenant audit_log (F2), the approval boundary is enforced and trailed (F4), impersonation is blocked on the whole audit surface (F5), the migration is single-final-file (F3), and F6/F7/F8 dispositions hold as claimed (with N2 carved out). The remediation tests are production-shaped and all 48 pass.

**Condition to reach full PASS:** close N1 — strip (or explicitly allowlist-and-document) `beaconhs_backup`'s SELECT on `audit_access_grants`/`platform_audit_access_log` in the same three enforcement points, and extend `assertAuditTablePrivileges` so the fail-closed gate covers every grantee, not only app/super. N2 is a functional pagination bug; fix at leisure, no security impact.
