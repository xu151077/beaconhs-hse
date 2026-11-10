# BeaconHS Release Candidate Review — PD-02 (Cross-Tenant Audit, 17 unpushed commits)

**Review baseline:** HEAD `81fec4c3`, branch `hse-platform`, clean working tree, **17** commits
ahead of `origin/hse-platform` (origin sits at `62b92b94`, the PD-01 release). Nothing is pushed;
**CI has NOT run on any of these commits.**

**Nature:** read-only review plus this one deliverable file. No push / merge / rebase / reset,
no production connection, no code changes outside this document.

**Independent security review:** 3 rounds by a separate security-reviewer agent, final verdict
**PASS** (`BEACONHS_PD02_INDEPENDENT_SECURITY_AUDIT.md`): F1–F5/F8 closed, F6 accepted (documented
risk), F7 verified not-a-bug, N1 closed via allowlist-and-document, N2 Low non-blocking.

---

## 1. Scope & commit inventory (oldest → newest)

| #   | Commit     | Purpose                                                                                                                                                             | Face        | RC assessment                                                                                                                        |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `dade26a7` | PD-01 production deployment record (PD-01 follow-up)                                                                                                                | docs only   | ✅                                                                                                                                   |
| 2   | `611ef924` | PD-02 stage-0 baseline audit                                                                                                                                        | docs only   | ✅                                                                                                                                   |
| 3   | `0c2dd294` | **P-1**: audit roles `audit_reader` (NOLOGIN/BYPASSRLS) / `audit_service` (LOGIN), migration preflight, `provision.sql`, CI role setup                              | db + ci     | ✅ see §2/§3                                                                                                                         |
| 4   | `310e3546` | P-1 report                                                                                                                                                          | docs only   | ✅                                                                                                                                   |
| 5   | `6f01da6a` | **P-2/P-3**: dedicated `AUDIT_DATABASE_URL` pool (max 2, no fallback, 503 semantics) + `SET LOCAL ROLE` query executor                                              | db          | ✅                                                                                                                                   |
| 6   | `8acb59fb` | P-2/P-3 reports                                                                                                                                                     | docs only   | ✅                                                                                                                                   |
| 7   | `c180761b` | **P-4/P-5**: audit access grants, platform trail, migration `0059`, 3 permission keys                                                                               | db + schema | ✅ see §2                                                                                                                            |
| 8   | `be8c6713` | P-4/P-5 reports                                                                                                                                                     | docs only   | ✅                                                                                                                                   |
| 9   | `1f198b2d` | P-6 + stage-7 audit trail verification reports                                                                                                                      | docs only   | ✅                                                                                                                                   |
| 10  | `b530375f` | **P-6**: query limits (31-day window, 10k-row cap, 500 page, cumulative budget, `extra_approval`), audit-service USAGE grants, tenant_admin permission converge fix | db          | ✅ see §2/§4                                                                                                                         |
| 11  | `29ac3bdf` | Cross-tenant audit UI, 4 session routes, orchestration layer, i18n (en/es/fr/zh), manual article                                                                    | web         | ✅                                                                                                                                   |
| 12  | `427d342f` | Stage-8 full test report                                                                                                                                            | docs only   | ✅ **note: the task brief cites `c07c4b33`; the actual stage-8 report commit is `427d342f`. `c07c4b33` does not exist in the repo.** |
| 13  | `41ff6ea4` | **Stage-9 remediation F1/F2/F4/F5**: business/super pool REVOKE on platform tables, super `audit_log` SELECT revoke, approval tenant boundary, impersonation guard  | db + web    | ✅                                                                                                                                   |
| 14  | `4c1c530e` | Independent security audit + stage-9 remediation report                                                                                                             | docs only   | ✅                                                                                                                                   |
| 15  | `31f620f0` | **N1**: pin `beaconhs_backup` SELECT-only on platform audit tables                                                                                                  | db          | ✅                                                                                                                                   |
| 16  | `f7a9bd20` | N1 deviation documentation                                                                                                                                          | docs only   | ✅                                                                                                                                   |
| 17  | `81fec4c3` | Independent audit round-3 adjudication — verdict PASS                                                                                                               | docs only   | ✅                                                                                                                                   |

**Hash discrepancy found:** the review brief listed `c07c4b33` (stage-8 test report) — no such
commit exists; the correct hash is `427d342f`. Content is present and correct; this is a brief
typo, not a missing commit.

---

## 2. Per-commit code review (code commits read in full)

| Commit     | Checks performed                                                                                                                                                                           | Result                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0c2dd294` | `packages/db/src/audit-roles.ts` (attributes + membership gate), `migrate.ts` preflight wiring, `scripts/cluster/provision.sql`, CI postgres role setup, `local-init.sh`                   | ✅ No debug leftovers; scope confined; roles created only by superuser via provision.sql; preflight fails closed (see §3)                                                                                                                                        |
| `6f01da6a` | `packages/db/src/audit-client.ts`, `audit-query.ts`, `.env.example`                                                                                                                        | ✅ No fallback to business pools; URL never logged; pool max 2 not configurable; `prepare:false`; query fully parameterized, `SET LOCAL ROLE` inside single transaction; no session-level `SET ROLE`                                                             |
| `c180761b` | `0059_audit_access_platform.sql`, `schema/audit-access.ts`, `schema/iam.ts`, `audit-access.ts` service, permission-catalogue contract test updates                                         | ✅ Platform tables carry CHECK constraints, append-only trigger, `REVOKE ALL FROM PUBLIC`; grant service enforces approver ≠ grantee at app + DB CHECK, ≤90-day window, atomic guarded approval UPDATE; keys added to catalogue but granted to nobody by default |
| `b530375f` | Query limit constants, `assertAuditRowBudget`, `extra_approval` column, `turbo.json` globalEnv `AUDIT_DATABASE_URL`                                                                        | ⚠️ 0059 amended in place (audit finding F3) — accepted because nothing is deployed and the only applied copy is the local dev DB which was replayed to the final version; process rule adopted                                                                   |
| `29ac3bdf` | `cross-tenant.ts` orchestration, 4 route files, `cross-tenant-section.tsx`, i18n, manual article                                                                                           | ✅ Strict `ctx.permissions.has()` (no super-admin bypass, no wildcards); 503 mapping; grant re-resolved fresh every request; tenant scope server-bound (`tenantIds = scope==='tenant' ? [ctx.tenantId] : params.tenantIds`); manual article truthful             |
| `41ff6ea4` | REVOKE enforcement in 0059 DO block + `convergeAuditPrivileges` + `assertAuditTablePrivileges` negative assertions; `assertNotImpersonating` on every audit path; approval tenant boundary | ✅ Fixes verified present at all enforcement points; F1 escalation path closed                                                                                                                                                                                   |
| `31f620f0` | `beaconhs_backup` SELECT-only pin in 0059 + converge + provision + `businessOffenders` gate query                                                                                          | ✅ Backup keeps SELECT by documented design (N1); any write privilege fails the migration                                                                                                                                                                        |

**Horizontal checks (all code commits):**

- `console.log / debugger / TODO / FIXME / as any / ts-ignore / eslint-disable` across
  `packages/db/src/audit-*.ts`, `apps/web/src/lib/audit/`, `apps/web/src/app/(app)/admin/audit/`:
  **0 hits**. No dead code observed; no parallel permission system introduced (audit keys ride the
  existing `PERMISSION_CATALOGUE` / `permissions.has()` machinery; DB privileges ride the existing
  provision/migrate grant stack).
- **Tenant isolation intact:** `audit_access_grants` and `platform_audit_access_log` are
  **intentionally platform-level** and are **NOT** in `TENANT_SCOPED_TABLES`
  (`packages/db/src/rls.ts` — verified: zero mentions). They are protected instead by:
  `REVOKE ALL … FROM PUBLIC` (0059:111-112), explicit REVOKEs on `beaconhs_app`/`beaconhs_super`
  (0059 DO block :122-132, converge self-heal `audit-roles.ts:160-193`, provision.sql :156-161),
  the append-only trigger (0059 :102-105), the 12-value action CHECK, and the fail-closed
  `assertAuditTablePrivileges` migration gate which now also negatively asserts that no
  business-pool role holds any privilege on them and that `beaconhs_backup` holds SELECT only.
  Business tables and RLS were not touched.

---

## 3. Migration compatibility matrix (verified against the code, not assumed)

Key facts verified in `packages/db/src/migrate.ts`:

- `assertDatabaseRoles` (:293-419) requires exactly **7 distinct roles** (migrator, owner,
  runtime, maintenance, backup, `audit_reader`, `audit_service`) — the two audit roles are added
  as literal strings, so this check alone does **not** detect a missing audit role.
- **`assertAuditRoleAttributes` (:546) runs BEFORE the advisory lock (:548), BEFORE schema
  ownership checks and BEFORE `migrate()` (:558)** → any audit-role failure aborts the migration
  with **zero DDL applied**. Fail-closed ordering confirmed.
- `assertAuditTablePrivileges` runs **after** migrations (:575) as a second fail-closed gate on
  the final privilege matrix (including the negative business-pool assertions).
- `convergeRolePermissions` (:184-253) converges `tenant_admin` to
  `PERMISSION_CATALOGUE − AUDIT_DEFAULT_UNGRANTED` on every run — a stale pre-PD-02 row loses the
  three audit keys, and a drifted row is repaired.

| Scenario                                                          | Result                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Old image (58 migrations) + DB at 59**                          | ✅ Compatible                                                     | Old code never imports `audit-access`/`audit-client` (verified absent at `62b92b94`); `beaconhs_app`/`beaconhs_super` have no privileges on the new tables so nothing accidental is reachable; old migrate's `distinctRoles` check is a Set of **5** (old `migrate.ts:348-355`) — passes; old `validateMigrationState` counts the unknown 0059 tracker row as `unknownTrackerRows` (reported, **not** thrown — `migration-state.ts:104-122`); drizzle's migrator iterates only the old journal's 58 files. Old `convergeRolePermissions` strips only keys outside the old 108-key catalogue — `tenant_admin`'s 108 current keys are all inside it, so built-in roles are untouched (custom roles that were deliberately granted the 3 new audit keys would lose them if the **old migrator** were re-run — acceptable rollback caveat, listed in §7) |
| **New image + DB at 58, provision NOT re-run**                    | ❌ Migration aborts, **fail-closed, nothing applied**             | `assertAuditRoleAttributes` throws "audit_reader/audit_service missing … Re-run scripts/cluster/provision.sql" at `migrate.ts:546`, before the advisory lock and before any DDL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **New image + DB at 58, provision re-run**                        | ✅ Works (the intended path)                                      | Preflight passes on the fresh roles; `migrate()` applies 0059; post-migrate privilege gates pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **New image + DB at 59, provision NOT run**                       | ❌ Migration aborts identically                                   | Same preflight failure at `migrate.ts:546` — again before any DDL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **New image + DB at 59, roles exist, `AUDIT_DATABASE_URL` unset** | ✅ App boots; audit features 503                                  | `getAuditConnection()` is a lazy singleton (`audit-client.ts:71-78`); nothing at boot requires the audit pool or the new tables; `auditConnectionOr503()` maps `AuditConnectionUnavailableError` → `ApiError.unavailable` (`cross-tenant.ts:70-81`); no import-time or layout-time access to the audit tables; nav entry is permission-gated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Rollback: old image after DB migrated to 59**                   | ✅ Safe for the app; one caveat if the old **migrator** is re-run | App: old code never touches the new tables/roles. Migrator: old `applyRuntimeGrants` runs a blanket `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public` (old `migrate.ts:422`) which **would re-broaden business-pool privileges onto the two platform tables**, and old converge would strip deliberately-granted audit keys from custom roles. Mitigation: after any rollback that re-runs migrations, re-run the new image's migrate (or `provision.sql`) to re-converge. The append-only trigger still blocks UPDATE/DELETE by non-owner in the meantime; INSERT/SELECT exposure is bounded and no old-code path queries these tables                                                                                                                                                                                             |

### Required production ordering (all three steps, in order)

1. **Re-run `scripts/cluster/provision.sql` as superuser** (idempotent: creates `audit_reader` /
   `audit_service` if absent, pins attributes and the sole-membership invariant, strips stray
   memberships, converges grants) — requires a new `-v audit_service_password=…`. This must come
   first because the new migrator refuses to run without the roles.
2. **Run the migration** (`0059` via `pnpm db:migrate` / ops-migrate image). Creates the two
   platform tables + constraints + trigger, applies the REVOKE matrix, and runs both audit
   preflight gates.
3. **Deploy the new image.** `AUDIT_DATABASE_URL` is **optional at boot** (feature 503s without
   it) but **required for audit feature function** (`postgresql://audit_service:…@…/beaconhs`);
   `turbo.json` globalEnv and `.env.example` already carry it.

`AUDIT_DATABASE_URL` must authenticate as `audit_service` (it is the only CONNECT-granted login
besides the four existing roles, and the only member of `audit_reader`).

---

## 4. Permission / role verification

| Claim                                                                                                                                    | Verified | Evidence                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_reader` NOLOGIN / BYPASSRLS, sole member `audit_service`                                                                          | ✅       | `provision.sql:68-113` (CREATE + membership-repair `\gexec` loop that strips any other member); `assertAuditRoleAttributes` fails closed on attribute drift, unexpected members, or missing sole member (`audit-roles.ts:57-120`)                                                                                                                              |
| `audit_service` LOGIN / NOBYPASSRLS, minimal table surface (S/I/U on grants, S/I on trail, no DELETE anywhere)                           | ✅       | `provision.sql:73-80`; `convergeAuditPrivileges` strips-then-grants the exact allowlist (`audit-roles.ts:140-194`); `assertAuditTablePrivileges` asserts the exact shape incl. `!delete` (`audit-roles.ts:202-288`)                                                                                                                                            |
| Business pools blind to platform tables (`beaconhs_app`, `beaconhs_super` hold nothing; super keeps INSERT on `audit_log`, loses SELECT) | ✅       | Enforced at all four points: provision.sql :156-164, 0059 DO block :122-132, converge self-heal :160-193, and the negative `businessOffenders` gate :298-320 (runs on every migration — any leak is a fail-closed error)                                                                                                                                       |
| `beaconhs_backup` SELECT-only on platform tables (N1 documented deviation)                                                               | ✅       | Pinned in 0059 :137-140, converge :186-191, provision :174-179; gate asserts no non-SELECT privilege :307-310                                                                                                                                                                                                                                                  |
| `tenant_admin` never auto-grants the 3 audit keys                                                                                        | ✅       | `AUDIT_DEFAULT_UNGRANTED = ['audit.read.tenant','audit.read.platform','admin.audit.approve']` (`iam.ts:394-398`); `BUILTIN_ROLES.tenant_admin` = catalogue minus those keys (`iam.ts:578-580`); `convergeRolePermissions` subtracts the same list on every migration (`migrate.ts:186-193`)                                                                    |
| Catalogue counts: 108 → 111, tenant_admin stays 108                                                                                      | ✅       | Executed the schema with tsx: `PERMISSION_CATALOGUE.length === 111`; tenant_admin baseline `=== 108` with zero audit keys; **no built-in role holds any of the 3 keys** (only `admin.audit.read`, the pre-existing per-tenant key, on tenant_admin — pre-PD-02, unchanged)                                                                                     |
| Audit permission checks bypass super-admin/wildcards                                                                                     | ✅       | `hasAuditPermission` = strict `ctx.permissions.has(key)` (`cross-tenant.ts:56-58`); `can()`/`assertCan()` deliberately not used on audit keys                                                                                                                                                                                                                  |
| Approver ≠ grantee, approvals need `admin.audit.approve` + tenant boundary                                                               | ✅       | Route gate `grants/[id]/route.ts:18-20`; orchestrator boundary (`cross-tenant.ts:403-426`): platform grants need `audit.read.platform`, tenant grants need same-tenant or platform review; revoke deliberately unbounded (fail-safe, emergency revocation); service + DB CHECK both enforce approver ≠ grantee (`audit-access.ts:287-292`, 0059 `approver_ck`) |
| Impersonation guard                                                                                                                      | ✅       | `assertNotImpersonating(ctx, 'cross-tenant audit')` on all 4 entry points (`cross-tenant.ts:95-97,151,264,365,394`)                                                                                                                                                                                                                                            |
| Grant revocation immediate, no cache                                                                                                     | ✅       | `resolveActiveAuditGrant` re-queried on every request, uncached by design (`audit-access.ts:439-466`); `revocation_ck` all-or-nothing CHECK in 0059                                                                                                                                                                                                            |

---

## 5. Docs truthfulness spot-check

All 10 PD-02 reports exist at repo root. Spot-checked claims vs code:

- `BEACONHS_PD02_P1_ROLE_PREFLIGHT.md` ("audit_reader NOLOGIN+BYPASSRLS, only SELECT audit_log;
  provision.sql is the only CREATE ROLE path; preflight fails closed") — matches
  `provision.sql` and `audit-roles.ts`. ✅
- `BEACONHS_PD02_P2_AUDIT_DATABASE_CONNECTION.md` ("trim-empty treated as missing; never falls
  back; pool max 2 not configurable; URL never logged; 503 semantics") — matches
  `audit-client.ts:42-46,59-68,25`. ✅
- `BEACONHS_PD02_P6_QUERY_LIMITS.md` (31-day window, offset+limit ≤ 10 000, page ≤ 500, 10 s
  `SET LOCAL statement_timeout`, budget via trail SUM, exports gated on `extra_approval`, no
  `/api/v1` exposure, super-admin bypass not used) — matches `audit-query.ts:21-60,151-162`,
  `audit-access.ts:414-431`, `cross-tenant.ts:271-284`. ✅
- `BEACONHS_PD02_FULL_TEST_REPORT.md` (gate table all 0; per-suite counts; production host never
  connected from tests) — matches the gate evidence supplied for this round. ✅
- `BEACONHS_PD02_INDEPENDENT_SECURITY_AUDIT.md` — F1..F8/N1/N2 table present; round-2 verdict
  CONDITIONAL PASS explicitly superseded by round-3 **PASS** after N1 closure
  (`31f620f0` + `f7a9bd20` + `81fec4c3`). Commit sequence and review record correspond 1:1. ✅

---

## 6. Test & gate summary

| Gate             | This round on HEAD                                                                   | CI          |
| ---------------- | ------------------------------------------------------------------------------------ | ----------- |
| `format:check`   | 0                                                                                    | **not run** |
| `typecheck`      | 0                                                                                    | **not run** |
| `lint`           | 0                                                                                    | **not run** |
| `test`           | 0 — db: 73 files passed / 1 skipped; web: 269 passed / 4 skipped; all packages green | **not run** |
| `deadcode:check` | 0                                                                                    | **not run** |
| `build`          | 0                                                                                    | **not run** |

**Caveats:**

1. **CI has not executed on any of the 17 commits.** Local gates were verified 0 on HEAD, but the
   GitHub Actions pipeline — including the updated postgres role bootstrap in `ci.yml`
   (`0c2dd294`) — has never run against this branch state. This is a blocking condition.
2. Several `@beaconhs/db` suites spin up **temporary PostgreSQL containers via Docker**
   (`audit-role-preflight`, `audit-client`, `audit-query-isolation`, `audit-access` probes).
   CI must have Docker available (it did for PD-01's equivalent suites; the updated ci.yml
   bootstrap was written for exactly this).
3. The stage-8 report documents one known load-induced flake (`client-lazy.test.ts` import
   timeout under 27 parallel workers), re-run green — unrelated to PD-02.

---

## 7. Known limitations (accepted, documented)

| ID  | Limitation                                                                                                                                                                                        | Disposition                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N2  | Deep pagination: a page whose `offset+limit` crosses the 10 000-row cap returns 400 `row_cap` instead of an empty last page — fail-closed UX wart, no security impact                             | Accepted, Low                                                                                                                                                                    |
| F6  | `assertAuditRowBudget` (trail SUM) is not atomic with the subsequent query — two concurrent queries can jointly overshoot the budget slightly                                                     | Accepted risk, bounded (10 000-row cap per query still applies) and fully trailed                                                                                                |
| N1  | `beaconhs_backup` keeps SELECT (whole-database read incl. platform audit tables and `audit_log`) — documented deviation required for complete backups; all WRITE privileges pinned off and gated  | Closed via allowlist-and-document                                                                                                                                                |
| —   | `audit_query_timeout` trail action was not exercised over real HTTP (10 s wait); covered by db-level `statement_timeout` tests and the timeout-classification branch in `cross-tenant.ts:215-221` | Accepted, covered at db layer                                                                                                                                                    |
| F3  | Migration 0059 amended in place (b530375f) instead of adding 0060                                                                                                                                 | Safe **only** because nothing is deployed and no external DB ever applied the original 0059; process rule (migrations immutable after merge) noted — watch this on future phases |

## 8. Risks

1. **CI unverified (blocking)** — see §6.
2. **Rollback re-running old migrator** re-broadens business-pool grants onto the platform tables
   and strips deliberately-granted audit keys from custom roles (§3). Mitigation exists (re-run
   new migrate / provision) and must appear in the deployment runbook.
3. **`audit_service` credential handling** — a new password enters the secret inventory at step 1
   of deployment; ensure it lands in the secret manager, not just the psql invocation.
4. **F6 budget race** — acceptable; if abuse is observed, move budget accounting into the query
   transaction on the audit connection.

---

## 9. Final verdict

# CONDITIONAL READY

The change set itself is release-quality: every claim in the brief that could be verified against
code **was verified and held** (fail-closed preflight ordering, 7-role matrix, privilege
allowlist, REVOKE enforcement points, permission catalogue 111/108, no parallel permission
system, tenant isolation intact, docs truthful). No contradiction with the supplied claims was
found other than the `c07c4b33` → `427d342f` hash typo in the brief.

**Blocking conditions (must clear before merge/push):**

1. **Run CI on the branch** (push or CI-trigger) and confirm all six gates green — including the
   updated `ci.yml` postgres bootstrap with the audit roles and the Docker-dependent db suites.
2. **Re-confirm the local gate set on final HEAD** immediately before push
   (`format:check`, `typecheck`, `lint`, `test`, `deadcode:check`, `build` — each with its own
   exit code), in case any post-review commit lands.

**Deployment preconditions (not merge blockers, but required at release time):**

- Production ordering: provision.sql (with `audit_service_password`) → migration 0059 → new
  image; `AUDIT_DATABASE_URL` optional at boot (503 without it), required for audit features.
- Runbook note: after any rollback that re-runs the **old** migrator, re-run the new image's
  migrate (or provision.sql) to re-converge platform-table grants and role permissions.

---

_Review method: read-only. Verified by direct code read (`migrate.ts`, `audit-roles.ts`,
`audit-client.ts`, `audit-query.ts`, `audit-access.ts`, `cross-tenant.ts`, all 4 route files,
`0059_audit_access_platform.sql`, `provision.sql`, `iam.ts`, `rls.ts`, `migration-state.ts`),
tsx execution of the permission catalogue, and diff-level inspection of the old image at
`62b92b94`. Not verified: live CI run (§6), HTTP timeout trail branch (db-level coverage only)._
