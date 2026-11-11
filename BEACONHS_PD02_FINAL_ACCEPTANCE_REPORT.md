# BeaconHS PD-02 — Final Acceptance Report (Production)

**Status: DEPLOYED & ACCEPTED (production)** — 2026-11-11
**Author:** Build agent (PD-02 implementer)
**Independent security review:** PASS (round 3, `BEACONHS_PD02_INDEPENDENT_SECURITY_AUDIT.md`)
**Release candidate:** READY (`BEACONHS_PD02_RELEASE_CANDIDATE_REVIEW.md`)

This report records the production cutover of the PD-02 cross-tenant audit
capability and the evidence that it satisfies the V3 architecture
(`BEACONHS_PD02_REVISED_ARCHITECTURE.md`) and the stage-0 through stage-10
gates. Every claim below was verified on the live production host, not assumed,
unless explicitly marked as validated in the isolated local environment.

---

## 1. Deployment facts (production)

| Item               | Value                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git HEAD deployed  | `e35af979279a70c120a85dedc0d1caacd20b6cd9`                                                                                                                                                   |
| Image              | `beaconhs@sha256:2a3df5f86ea7fbff257bb1cb6d94437e0c2738f119c373fa4d84f8788e3206a3`                                                                                                           |
| Deployment id      | `be18ae586874141e9f0eab7dcad1ba16e15c3cef-20261111-001`                                                                                                                                      |
| Migration ledger   | 59 / 59 applied (was 58; 0059 added)                                                                                                                                                         |
| AUDIT_DATABASE_URL | injected into web/worker (compose `x-app-env`, optional → 503 if absent)                                                                                                                     |
| Pre-cutover backup | `daily-20261111T035915Z` (encrypted, 2.9 MB)                                                                                                                                                 |
| Deploy sequence    | backup → stop → sync provision.sql+compose → generate `audit_service_password` → `provision-db.sh` → start postgres → migrate 0059 → update env identity vars → `beaconhs-start.sh` (Gate 5) |

The new migrator fails closed if the audit roles are missing (advisory lock is
taken only after the role preflight in `packages/db/src/migrate.ts`), so an
old image pointed at a DB that has been migrated by the new migrator will still
start; the reverse (new image + old DB without 0059) is blocked by the
migration ledger. Rollback = revert the four env identity vars + redeploy the
previous image; if the old migrator is re-run it re-widens business-pool
privileges, so re-run `provision-db.sh` + the new migration to re-converge
(see `docs/PRODUCTION_RUNBOOK.md`).

---

## 2. Production verification evidence

### 2.1 Availability & identity

- `GET /api/health/ready` → `200`, body `{"status":"ready","version":"e35af979…"}`.
- `beaconhs-start.sh` Gate 5 → **PASS**; all eight services healthy.
- Public routes mounted and gated: `GET /admin/audit/query` → **307** (redirect
  to login), `GET /admin/audit/grants` → **307** (unauthenticated, no 500/503).
- Web container logs: no error / exception / audit lines in the 15-minute window
  after cutover.
- `drizzle.__drizzle_migrations` row count = **59** (superuser direct query).

### 2.2 Audit roles (P-1)

```
audit_reader  | rolcanlogin=f | rolbypassrls=t     -- NOLOGIN, BYPASSRLS
audit_service | rolcanlogin=t | rolbypassrls=f     -- LOGIN, NOBYPASSRLS
service_member_of_reader = 1                        -- sole membership
```

### 2.3 Privilege matrix (P-1 / P-5 / F1 / F2 / N1)

`information_schema.role_table_grants` for the three audit-relevant tables and
the five database roles:

| grantee           | table                       | privileges                                                     |
| ----------------- | --------------------------- | -------------------------------------------------------------- |
| `audit_reader`    | `audit_log`                 | SELECT only                                                    |
| `audit_service`   | `audit_access_grants`       | SELECT, INSERT, UPDATE                                         |
| `audit_service`   | `platform_audit_access_log` | SELECT, INSERT                                                 |
| `beaconhs_backup` | `audit_access_grants`       | SELECT only                                                    |
| `beaconhs_backup` | `platform_audit_access_log` | SELECT only                                                    |
| `beaconhs_backup` | `audit_log`                 | SELECT only (by design, 0056)                                  |
| `beaconhs_app`    | `audit_log`                 | SELECT, INSERT, UPDATE, DELETE (tenant-bound RLS — legitimate) |
| `beaconhs_super`  | `audit_log`                 | INSERT, UPDATE, DELETE — **NO SELECT**                         |

Confirmed:

- **F1 CLOSED** — `beaconhs_app` and `beaconhs_super` hold **no** privilege on
  `audit_access_grants` or `platform_audit_access_log`. They cannot forge an
  approval, delete a grant, or forge a trail row.
- **F2 CLOSED** — `beaconhs_super` no longer has `SELECT` on `audit_log`; the
  business pool cannot read the cross-tenant audit trail directly.
- **N1 CLOSED** — `beaconhs_backup` is SELECT-only on the two platform tables
  (write pin enforced by provision.sql, 0059 `DO` block, and
  `convergeAuditPrivileges`). Backup retains full `audit_log` read by design
  (0056); this is documented and accepted by the independent reviewer.

### 2.4 Platform tables hardening (P-5)

- `REVOKE ALL FROM PUBLIC` effective: **zero** PUBLIC grants on either table.
- Append-only trigger present: `platform_audit_access_log_immutable_trigger`.
- All CHECK constraints applied:
  - `audit_access_grants`: `approver_ck`, `max_window_ck`, `purpose_ck`,
    `revocation_ck`, `scope_ck`, `window_ck`.
  - `platform_audit_access_log`: `action_ck`, `scope_ck`.

### 2.5 Cross-tenant read proof (P-3, the core primitive)

Connected as `audit_service`, within a transaction:

```
BEGIN;
SET LOCAL ROLE audit_reader;
SELECT count(*) FROM audit_log;              -- 285 rows (BYPASSRLS, all tenants)
SELECT count(*) FROM incidents;              -- permission denied
ROLLBACK;
SELECT count(*) FROM audit_log;              -- permission denied (service alone)
```

This proves, on the live database:

1. The cross-tenant read works **only** through the controlled
   `SET LOCAL ROLE audit_reader` switch (BYPASSRLS bypasses tenant RLS).
2. `audit_service` has **no** direct grant on `audit_log` — the read is
   impossible without the role switch, exactly per V3 P-3.
3. `audit_reader` / `audit_service` cannot read any business table
   (`incidents` denied) — the audit connection cannot exfiltrate operational
   data.

The single distinct `tenant_id` in the 285 rows reflects current production
data (one populated tenant); the mechanism is tenant-agnostic and was exercised
across two tenants in the isolated local suite (`b20`).

---

## 3. Validated in the isolated local environment (not re-run in production)

To avoid leaving test artifacts (grant rows, role assignments, seeded users) in
the production database, the following were validated exhaustively against an
isolated local Postgres + the same image, and the identical code path is now
live in production with the verified configuration above:

- **HTTP session matrix (16 scenarios)** — request → approve → query (200,
  paginated) → export (403 without extra approval, 200 with) → revoke → 403;
  self-approval 400; out-of-tenant approval 403; >31-day window 400; deep page
  > 10,000 rows 400; row-budget exceeded 400; no-grant 403; unauthenticated 307.
- **503 fail-closed** — with `AUDIT_DATABASE_URL` absent the query/export
  endpoints return 503 and the rest of the app is unaffected.
- **68 database-layer tests** across `audit-role-preflight`,
  `audit-query-isolation`, `audit-client`, `audit-access` (role attributes,
  privilege matrix, isolation, budget, windows, append-only trigger, F1/F2/N1
  convergence).
- **Independent security review round 3 → PASS** (F1–F5, F8 CLOSED; F6, F7
  accepted/non-bug; N1, N2 documented).

A production session-level HTTP run would require provisioning a real
`audit_officer` grant and user, which is intentionally left to operators who
will issue genuine access grants.

---

## 4. Gate summary (stage 8 + stage 10)

| Gate                          | Result                                                   |
| ----------------------------- | -------------------------------------------------------- |
| `pnpm format:check`           | 0                                                        |
| `pnpm typecheck`              | 0                                                        |
| `pnpm lint`                   | 0                                                        |
| `pnpm deadcode:check` (knip)  | 0                                                        |
| `pnpm test`                   | 0 (db 73 passed / 1 skipped; web 269 passed / 4 skipped) |
| `pnpm build`                  | 0                                                        |
| CI (run 42942872233)          | success (24 steps, incl. live-db suites)                 |
| Security CI (run 42942872228) | success                                                  |
| Independent review            | PASS                                                     |
| Release candidate             | READY → deployed                                         |

Two CI failures earlier in the pipeline (round 1 `db-runtime`, round 3
`db-freeze`) were expired test pins that read `audit_log` as `beaconhs_super`
after the F2 privilege revocation; both were fixed to read via
`beaconhs_owner` + tenant GUC and re-verified (36/36 and 16/16). They are
documented in `BEACONHS_PD02_RELEASE_CANDIDATE_REVIEW.md`.

---

## 5. Residual / non-blocking items (carried forward, not waived silently)

- **N2 (Low)** — At the last page, a request spanning exactly 10,001 rows
  returns 400 (`row_cap`) instead of a 10,000-row page. Fail-closed; UX only.
- **Backup credential stewardship (ops)** — `beaconhs_backup` can read all
  `audit_log`. Mitigated by encrypted off-host backups and restricted
  credential distribution; no code action required.
- **F4 revoke boundary (accepted)** — Revoke has no tenant boundary (any
  approver may revoke any grant). Fail-safe direction; revisit if approval
  volume grows.
- **F6 budget race (accepted)** — The 10,000-row budget check is not atomic
  with the query; a concurrent burst could marginally overshoot. Bounded and
  non-exploitable for cross-tenant disclosure.

---

## 6. Sign-off

PD-02 is **accepted for production**. The cross-tenant audit capability is
deployed with the authoritative role chain (`audit_reader` ← `audit_service`),
an isolated connection pool, a 503 fail-closed when unconfigured, a full
append-only platform trail, strict approval (self-approval and out-of-tenant
approval denied), and the default-not-granted permission model (super-admins do
**not** automatically receive `admin.audit.approve` / `audit.read.*`). All six
engineering gates are green, CI is green, and the independent security review
returned PASS.

No production gate was bypassed, no secret was echoed, and no test artifact was
left in the production database.
