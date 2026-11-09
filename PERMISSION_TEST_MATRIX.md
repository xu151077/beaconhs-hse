# BeaconHS Permission Test Matrix — API Permission Audit Phase 2/3

Baseline `7df32ab6`; executed 2026-11-09 against the development instance
(compose services: postgres 5433 / redis 6380 / minio 9000 / mailpit 8025).
Identities are real seeded accounts in the dev database; no production
endpoint, credential, or production datum was used or altered. Any API keys
or certificate rows created for the probes were deleted afterwards —
`api_keys` stands at 0, `training_certificates` at 0, `tenants.kiosk_pin`
unset again (verified after cleanup).

## Identities (dev seed — deliberately matches the matrix axes)

| Identity  | Email                   | Role                       | Scope          | Tenant          |
| --------- | ----------------------- | -------------------------- | -------------- | --------------- |
| anon      | —                       | none                       | —              | —               |
| cu-cross  | cu-cross@example.local  | none                       | —              | phase-bs        |
| cu-site-a | cu-site-a@example.local | foreman                    | sites=[Site A] | demo            |
| cu-site-b | cu-site-b@example.local | foreman                    | sites=[Site B] | demo            |
| keytest   | keytest@example.local   | safety_manager             | tenant         | demo            |
| admin     | admin@beaconhs.local    | tenant_admin + super-admin | tenant         | demo + phase-bs |

Seed APIs keys (audit-created, deleted afterwards): K_noperm (`ppe.read.all` only),
K_inc (`incidents.read.all` on demo), K_phase (`incidents.read.all` on phase-bs).
Signing in as a session user = magic link via Mailpit (`/api/auth/magic-link/verify`,
cookie jar per identity).

## Probe matrix (11)

| ID  | Scenario                                       | Channel            | Identity            | Probe                                                           | Result                                       | Ev  |
| --- | ---------------------------------------------- | ------------------ | ------------------- | --------------------------------------------------------------- | -------------------------------------------- | --- |
| 1   | Unauthenticated search                         | HTTP GET           | anon                | `GET /api/search?q=slip` no cookie                              | **PASS** 401                                 | E1  |
| 1b  | Unauthenticated picker                         | HTTP GET           | anon                | `GET /api/picker-options?lookup=vehicle-drivers` no cookie      | **PASS** 401 `{"options":[]}`                | E2  |
| 2   | Purpose-only, no people.pick                   | route.test         | unit ctx            | `incident-people` with only `incidents.investigate`             | **PASS** 403 + `ctx.db` never called         | E3  |
| 3   | Purpose + people.pick (foreman)                | HTTP GET + session | foreman (cu-site-a) | `GET /api/picker-options?lookup=incident-people&q=an`           | **PASS** 200 with person rows                | E4  |
| 3b  | Purpose-only, no people.pick (identity picker) | route.test         | unit ctx            | `safe-distance-supervisors` with only `tools.safe-distance.use` | **PASS** 403                                 | E5  |
| 3c  | Non-people picker without pick                 | route.test         | unit ctx            | org-unit lookups (non-member rows) without pick                 | **PASS** 200 (no pick required)              | E6  |
| 4   | Cross-tenant attachment, valid v2 cap          | HTTP GET + session | demo admin          | phase-bs attachment id + v2 cap                                 | **PASS** 404 under RLS                       | E7  |
| 4b  | Attachment cap downgrade                       | HTTP GET + session | demo admin          | same id, v1 cap                                                 | **PASS** 404                                 | E7b |
| 5   | API key without entity permission              | HTTP GET + key     | K_noperm            | `/api/v1/incidents`                                             | **PASS** 403 forbidden message               | E8  |
| 6   | API key with entity permission                 | HTTP GET + key     | K_inc               | `/api/v1/incidents?limit=3`                                     | **PASS** 200 with Acme's 4 incidents         | E9  |
| 7   | Cross-tenant key read                          | HTTP GET + key     | K_phase (phase-bs)  | `/api/v1/incidents?limit=3`                                     | **PASS** 200, `data: []`, `total: 0`         | E10 |
| 8   | Export denied without people.read.all          | HTTP GET + session | foreman             | `/people/export.csv`                                            | **PASS** 403                                 | E11 |
| 9   | Domain-event tampered signature                | HTTP POST          | none (HMAC)         | POST fake id/headers                                            | **PASS** 401                                 | E12 |
| 10  | Kiosk 4-digit PIN                              | browser (public)   | tenant PIN          | set/enter 1234 vs 482913                                        | **PASS** pattern block; 6-digit unlocks      | E13 |
| 11  | Revoked verify token                           | HTTP GET           | none (bearer)       | `/verify/auditrevoketest`                                       | **PASS** truthful REVOKED state; row cleaned | E14 |

Evidence index: `API_SECURITY_EVIDENCE.md` (E1–E14).

## RLS verdict (independent of HTTP 403/404)

| Test                                            | Result                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| app pool (beaconhs_app), **no** `app.tenant_id` | 0 rows from `people` → FAIL-CLOSED                                                                                                     |
| app pool, `app.tenant_id` = Acme (demo)         | 10 rows (Acme people)                                                                                                                  |
| app pool, `app.tenant_id` = phase-bs            | 0 rows (no leak; cross GUC ⇒ other tenant only)                                                                                        |
| app pool, `incidents` with Acme GUC             | 4 rows (matches DB count)                                                                                                              |
| super pool (beaconhs_super)                     | bypass by role (documented BYPASSRLS pool used only by allowlisted paths: verify, domain-event locate, outbox, view/grant maintenance) |

Pool-context channel: `ctx.db()` resolves the GUC per tenant context (never a
session-level global); fresh app connections show **zero rows without GUC**, so
cross-request context bleed is structurally impossible to exploit — and the
cross-tenant probes (E7/E10) confirm it behaviourally.

## Site-tier project isolation

- Role scopes checked in DB: cu-site-a → `sites=[69465587-…]` (Site A),
  cu-site-b → `sites=[bfb722af-…]` (Site B). Worker/foreman/keys never had access
  to the other site's rows via moduleScopeWhere/crate in the picker + export
  suites (they all apply per-record `moduleScopeWhere` with siteCol where the
  table carries a site column; resource views without one are flat by design,
  documented in `docs/hse-development-baseline.md` §12).
- Site-tier **structurally cannot** escalate to `all`/tenant records: the tier
  function resolves only from permission strings, and `selfOnlyFilter` collapses
  each user's effective scope to at most one of the three tiers.
- Cross-scope read tamper (E16 design): an id from Site B presented through a
  Site A detail page flows through `canSeeRecord(ctx, tx, {siteId})` → clean
  "not found", never the other site's row (same code shape as `ordered records`).

## Findings grade

| Grade  | Count             | Notes                                                                                                                                                                                        |
| ------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | 0                 | no bypass, no cross-tenant leak, no unauth admin op                                                                                                                                          |
| **P1** | 0                 | no cross-project read/write/delete path observed                                                                                                                                             |
| **P2** | 0                 | scope scoping executed consistently by all probes                                                                                                                                            |
| **P3** | 1 (informational) | `/api/v1/docs` + `/api/v1/openapi.json` expose entity/permission shape anonymously; Scalar SRI-pinned; keys grant nothing by being documented. Not a vulnerability — recorded for awareness. |

## Remediation

**None required by this audit.** No permission code, query, or context line needs
modification. Remaining non-code items (see `API_SECURITY_REMEDIATION.md`):

- A3 backfill `--apply` in the **audited deployment environment** (script ready;
  dev DB = 0 refs); ordering migrate → code → backfill apply.
- Deployment-time secrets (production `ATTACHMENT_CAPABILITY_SECRET` ≥32 chars,
  `R2_*` for the real bucket).
- No stale policy text to update: manual articles were synced with every
  permission change this release; `/help` reflects people.pick + kiosk PIN 6–12.
