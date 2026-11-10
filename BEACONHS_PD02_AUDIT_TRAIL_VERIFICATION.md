# PD-02 Stage 7 — Audit Trail Verification Report

**Verdict: PASS.** Every cross-tenant audit access leaves a complete, append-only trail in
`platform_audit_access_log`, written through the dedicated audit connection as
`audit_service`, and protected from modification by database triggers.

## 1. Trail requirements (V3 §6/P-5) → evidence

| Requirement                              | Mechanism                                                                                                                                                                                                  | Evidence                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Every access event recorded              | `recordAuditAccessEvent` INSERT via the audit pool (audit_service identity)                                                                                                                                | `audit-access.test.ts` "platform-level round trip", live DB queries below                               |
| Append-only                              | BEFORE UPDATE/DELETE trigger `platform_audit_access_log_immutable()` rejects everything except `current_user = 'beaconhs_owner'` (owner UPDATE returns NEW / DELETE returns OLD for operational lifecycle) | `audit-access.test.ts` append-only cases; live superuser UPDATE rejected (superuser ≠ `beaconhs_owner`) |
| Tenant-scoped roles cannot write or read | `REVOKE ALL FROM PUBLIC`; only owner + audit_service have privileges; `audit_service` has SELECT,INSERT only                                                                                               | `assertAuditTablePrivileges` preflight + `audit-access.test.ts` privilege matrix                        |
| Not tenant-scoped, no tenant FK          | Both tables excluded from `TENANT_SCOPED_TABLES`; `tenant_id`/`actor_tenant_id` nullable columns without tenant FK                                                                                         | `audit-access.test.ts` `TENANT_SCOPED_TABLES` case                                                      |
| Failure paths trailed too                | `audit_query_failed` / `audit_query_timeout` / `audit_access_denied` / `audit_oversize_requested` / `audit_export_requested` (denied) all written with reason                                              | live DB counts below                                                                                    |
| Action vocabulary enforced               | CHECK constraint on 12 action values                                                                                                                                                                       | `audit-access.test.ts` forged-action rejection                                                          |

## 2. Event types observed in the live local environment

```
select action, count(*) from platform_audit_access_log group by action order by 2 desc;

           action           | count
----------------------------+-------
 audit_access_denied        |    18
 audit_query                |    13
 audit_export_requested     |    10
 grant_requested            |     8
 grant_approved             |     7
 audit_query_failed         |     7
 grant_revoked              |     6
 audit_oversize_requested   |     1
 grant_rejected             |     1
 audit_export_completed     |     1
```

`audit_query_timeout` has no HTTP-reachable occurrence in this environment; the 10 s
`statement_timeout` it records is pinned at the database layer by
`audit-query-isolation.test.ts`.

## 3. End-to-end trail for a single grant (fresh gate-verify run)

Grant `085f797a-be42-4055-831d-68b1deb96363` (requester cu-approver2, approver cu-site-a):

```
 grant_requested | dddddddd-0000-4000-8000-0000000000d4
 grant_approved  | 11111111-1111-4111-8111-111111111111
 audit_query     | dddddddd-0000-4000-8000-0000000000d4
 grant_revoked   | dddddddd-0000-4000-8000-0000000000d4
```

HTTP for the same run: create **201** → approve **200** → query **200** → revoke **200** →
query after revoke **403**. Approver ≠ grantee is enforced both in code and by the
`approver_ck` CHECK constraint.

## 4. Verification commands

- HTTP: curl matrix in `BEACONHS_PD02_P6_QUERY_LIMITS.md` §4 (session cookies, real web +
  real PostgreSQL).
- Trail: `docker exec beaconhs-postgres psql -U postgres -d beaconhs -c "select … from
platform_audit_access_log …"` (read-only inspection; the app itself never uses a
  superuser connection for trail writes).
- Automated: `audit-access.test.ts` (23 cases) and `audit-query-isolation.test.ts` (18
  cases), both real PostgreSQL, exit code 0.

## 5. Conclusion

The audit trail requirement is satisfied: every grant lifecycle event and every query/export
attempt (success, denial, oversize, failure) is persisted, immutable to anything except the
`beaconhs_owner` maintenance role, and visible to the P-6 UI. No Mock-based evidence is used
in this report.
