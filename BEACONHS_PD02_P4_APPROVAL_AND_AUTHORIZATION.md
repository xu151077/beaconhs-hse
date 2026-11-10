# PD-02 P-4 — Audit Authorization & Independent Approval (PASS)

Stage gate: **PASS** — all P-4 V3 constraints implemented and verified against real
PostgreSQL. No executable cross-tenant audit HTTP surface exists yet (per V3, the
query endpoint arrives with P-6; authorization is enforced at the data layer first).

## 1. What was built

### 1.1 Permission keys (`packages/db/src/schema/iam.ts`)

| Key                   | Purpose                                           | Default grant                                       |
| --------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `admin.audit.approve` | Approve/reject/revoke audit-access requests       | **No role** — exported as `AUDIT_DEFAULT_UNGRANTED` |
| `audit.read.tenant`   | Read one tenant's audit trail under a valid grant | No role                                             |
| `audit.read.platform` | Read across tenants under a platform grant        | No role                                             |

- `tenant_admin` = catalogue **minus** `AUDIT_DEFAULT_UNGRANTED`
  (`PERMISSION_CATALOGUE.filter(...)`) — approval capability must be granted
  deliberately, never inherited with the admin role (V3 P-4).
- Catalogue 108 → **111**. Count pins updated with justification
  (`ppe-read-tier-contract.test.ts`, `people-titles-pdf-gate.test.ts`).
- `audit.read.tenant` / `audit.read.platform` are **not** visibility-ladder tiers:
  `permission-catalogue-contract.test.ts` now carries an explicit, documented
  `AUDIT_READ_KEYS` exception (they are checked against `audit_access_grants`
  scope, never through `resolveVisibilityTier`/`readTierCovers`).

### 1.2 Grant lifecycle (`packages/db/src/audit-access.ts`)

- `AUDIT_GRANT_MAX_WINDOW_DAYS = 90`, `AUDIT_GRANT_PURPOSE_MAX = 500`.
- `AuditAccessError` codes: `invalid_request | not_found | already_resolved |
already_revoked | window_expired`.
- `validateAuditGrantWindow` — purpose 1..500 after trim, window 1..90 days,
  `expires_at > starts_at`, scope/tenant consistency
  (`scope='tenant'` requires `granteeTenantId`; `scope='platform'` forbids it).
- `createAuditAccessRequest` — pending grant + trail `grant_requested`.
- `approveAuditAccessRequest` — pre-read distinguishes `not_found` vs
  self-approval (`invalid_request`, also enforced server-side by the
  `audit_access_grants_approver_ck` CHECK constraint); the UPDATE competes on
  `approved_by_user_id IS NULL AND revoked_at IS NULL AND grantee<>approver AND
expires_at > now()` — concurrent approvals: exactly one wins.
- `rejectAuditAccessRequest` — voids a pending request + trail `grant_rejected`.
- `revokeAuditAccess` — revokes an approved, unrevoked grant; repeat →
  `already_revoked`; trail `grant_revoked`.
- `resolveActiveAuditGrant` — fail-closed: approved AND not revoked AND inside
  the window AND scope matches AND (`scope='platform'` OR
  `grantee_tenant_id = tenantId`); latest grant wins; anything else → `null`.
- `insertAccessEvent` — appends to `platform_audit_access_log` (12-value action
  CHECK, filter bound as a JSON string — postgres.js does not bind bare objects).

Every function executes as `audit_service` over the dedicated audit connection
(`GrantExecutor = { sql: Sql }`), never over the business pool.

## 2. Verified authorization scenarios (real PostgreSQL)

`packages/db/src/audit-access.test.ts` — **23/23 passed**, exit code 0.

Command:
`pnpm --filter @beaconhs/db exec vitest run src/audit-access.test.ts`
(NODE_OPTIONS=--max-old-space-size=4096). Harness: throwaway
`postgres:16-alpine` container, real `audit_service`/`app_probe` login roles,
the **real 0059 migration statements** applied verbatim, real
`convergeAuditPrivileges`.

| Scenario                                                                                                                                                       | Result |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Valid request → pending grant + `grant_requested` trail                                                                                                        | ✅     |
| Approval by a different subject → active + `grant_approved`                                                                                                    | ✅     |
| Self-approval → rejected by app logic **and** DB CHECK (`approver_ck`)                                                                                         | ✅     |
| Concurrent approvals (max:2 pool, `Promise.allSettled`) → exactly one winner                                                                                   | ✅     |
| Duplicate approval / duplicate rejection → `already_resolved`                                                                                                  | ✅     |
| Rejection voids a pending request; trail = `[requested, rejected]`; resolve → `null`                                                                           | ✅     |
| Revocation takes effect immediately; repeat revoke → `already_revoked`; trail `[requested, approved, revoked]`                                                 | ✅     |
| Fail-closed resolution: scope mismatch / wrong tenant / unknown subject / expired → `null`                                                                     | ✅     |
| Request validation: empty purpose, 501-char purpose, 91-day window, inverted window, `tenant` without tenant id, `platform` with tenant id → `invalid_request` | ✅     |
| Unknown grant id → `not_found`                                                                                                                                 | ✅     |
| Both platform tables absent from `TENANT_SCOPED_TABLES`                                                                                                        | ✅     |
| `app_probe` (business role): SELECT/INSERT denied on both tables                                                                                               | ✅     |
| `audit_service`: DELETE on grants denied; UPDATE/DELETE on the append-only log denied                                                                          | ✅     |
| Append-only trigger blocks log UPDATE/DELETE for non-owner                                                                                                     | ✅     |
| Forged `action` value rejected by CHECK                                                                                                                        | ✅     |
| Grant rows tied to real users (FK RESTRICT)                                                                                                                    | ✅     |
| `convergeAuditPrivileges` idempotent, heals drifted privileges                                                                                                 | ✅     |
| End-to-end platform grant through the real audit connection                                                                                                    | ✅     |

Not tested here (covered by later stages): requester-without-permission UI flows
(P-6 endpoint + permission wiring), oversize/export approvals (P-6).

## 3. Design conformance to V3

| V3 P-4 constraint                                          | Status                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `admin.audit.approve`, no parallel permission catalogue    | ✅ catalogue key                                       |
| Default-ungranted, deliberate grant only                   | ✅ `AUDIT_DEFAULT_UNGRANTED`, no builtin role holds it |
| Requester ≠ approver enforced                              | ✅ app check + DB CHECK + atomic UPDATE guard          |
| Approval records approver, requester, time, purpose, scope | ✅ grant row + `platform_audit_access_log`             |
| Mandatory validity window, expiry, early revocation        | ✅                                                     |
| Revoked/expired/rejected grants unusable                   | ✅ `resolveActiveAuditGrant` fail-closed               |
| Unknown/unspecified authorization states fail closed       | ✅ `null`/error, never best-effort                     |
| Revocation effective immediately, no caching               | ✅ resolved per request, straight from the table       |
| Trail on request/approve/reject/revoke                     | ✅ verified per lifecycle step                         |

## 4. Test-layer accounting (no merged pass rates)

| Layer                                                   | Command                                             | Count          | Exit code |
| ------------------------------------------------------- | --------------------------------------------------- | -------------- | --------- |
| Real PostgreSQL (grant lifecycle, privileges, triggers) | `vitest run src/audit-access.test.ts`               | 23/23          | 0         |
| Pure logic                                              | window/scope validation cases inside the same suite | (subset of 23) | —         |
| HTTP                                                    | none — endpoint arrives in P-6                      | —              | —         |
| Mock                                                    | none                                                | —              | —         |

## 5. Remaining for P-4 closure

- HTTP-level proof of "user without `admin.audit.approve` cannot approve" lands
  with the P-6 endpoint (the authorization data layer is already fail-closed).
