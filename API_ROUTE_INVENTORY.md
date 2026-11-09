# BeaconHS API Route Inventory — Permission Audit Phase 1

**Baseline:** `7df32ab6` (`hse-platform`), generated 2026-11-09 by `node /tmp/opencode/inventory.mjs`
(derivation pass; hand-annotated afterwards). Method: scripted extraction from every
`apps/web/src/app/**/route.ts` of the exported HTTP methods, the authentication
mechanism, every literal key passed to `assertCan`/`can(ctx, …)`, and the data path
(`ctx.db()` → app.tenant_id GUC → Postgres RLS, vs `withSuperAdmin(db, …)` →
BYPASSRLS role). `NONE-found` means no auth primitive is referenced in the file;
those rows were then read by hand (see hand-check Notes).

## Audited permission chain (as built)

| Stage | Mechanism | File |
|---|---|---|
| **Authentication (session)** | Better-Auth server: `getRequestContext()` resolves the session → tenant membership → permissions + role scopes; missing/expired → 401 (`/api/search`) or redirect (`(app)` pages) | `apps/web/src/lib/auth.ts` |
| **Authentication (API key)** | `authenticateApiKey()` runs first in every `/api/v1` handler; unknown key → 401 before any entity probing | `apps/web/src/lib/api/auth.ts` |
| **Authentication (capability)** | HMAC bearer for attachments (`attachment:v2:`) and storage objects (`object:v1:` + 1h exp); namespace-separated; constant-time | `lib/attachment-url.ts`, `lib/storage-gateway.ts` |
| **Authentication (event)** | `verifyDomainEventRequest(id, x-beaconhs-event-timestamp, x-beaconhs-event-signature)` — HMAC over the event id; the tenant context is then built from the event's own `tenant_id` | `apps/web/src/app/api/internal/domain-events/[id]/route.ts` |
| **Authentication (WOPI)** | `access_token` SDK bearer (paused by owner decision; not audited for behaviour) | `apps/web/src/app/wopi/*` |
| **Authorization** | `assertCan(ctx, '<module>.<action>')` (108-key catalogue in `PERMISSION_CATALOGUE`) or the route's purpose switch (`pickerAuthorized` → purpose + `people.pick`). Nav gating is UX only; server actions/routes re-check. | `packages/db/src/schema/iam.ts` (3), `packages/tenant/src/index.ts` (2) |
| **Role Scope** | 6 variants: tenant / sites / team / people / crews / self. Hierarchy enforced transitively through `RoleScope`; `selfOnlyFilter` collapses unions to the widest scope | `packages/db/src/schema/iam.ts:49-66` |
| **Visibility tier** | `resolveVisibilityTier` → `all / site / self` from permission strings alone; `moduleScopeWhere`/`recordVisibilityWhere` materialise the record filter | `apps/web/src/lib/visibility.ts:106-118` |
| **RLS (Postgres)** | Every tenant table: `tenant_id = current_setting('app.tenant_id')` under FORCE RLS, installed by `packages/db/src/rls.ts`. App pool (`ctx.db()`) connects as `beaconhs_app` (no bypass); `withSuperAdmin` connects as BYPASSRLS `beaconhs_super` — used by a small allowlist of paths (verify, domain-event locate, outbox patch up) | `packages/db/src/client.ts` (3, 6) |

**Structural limit (not a bug):** there is no project/org-unit RoleScope variant;
the `sites` variant over `org_units.level='site'` is the practical proxy used by
all per-site gating (and by every role assignment UI picker). Project-level
isolation in the strict sense cannot be expressed in the RBAC model; every
"project" statement below maps onto the site tier. API keys carry no tenant
column either — they bind to one tenant (`api_keys.tenant_id`) and inherit that
tenant's RLS scope, so cross-tenant reads through a key are blocked below.

## Route inventory (75 route files)

Legend — **Auth**: `session` = Better-Auth session required; `api-key` = key required;
`capability-HMAC` = capability URL; `bearer-token` = token auth. **RLS**: `tenant-ctx.db (RLS)` = query runs under `ctx.db()` GUC; `BYPASSRLS-super-pool` = `withSuperAdmin` without a tenant right; `n/a` = no data access. **Permission**: keys seen in the file (assertCan/can); `—` = purpose-only via picker switch or none found.

| Path | Methods | Auth | Permission | RLS |
|---|---|---|---|---|
| /api/apps/draft-save | POST | session | — | tenant-ctx.db (RLS) |
| /api/attachments/:id | GET | capability-HMAC + session | — | tenant-ctx.db (RLS) |
| /api/auth/:...all | GET, POST | Better-Auth (public by design) | — | n/a |
| /api/health/ready | GET | none needed (public) | — | n/a |
| /api/internal/domain-events/:id | POST | event HMAC | — | withSuperAdmin (row locate) + per-event tenant ctx |
| /api/picker-options | GET | session | purpose switch + people.pick for 18+7 person-identity lookups | tenant-ctx.db (RLS) + purpose scope wheres |
| /api/search | GET | session | per-group read tiers + people.read.all for the directory group | tenant-ctx.db (RLS) + moduleScopeWhere per module |
| /api/storage/object | GET | object capability (1h) | — (capability = authorisation) | n/a (object key + capability, streamed) |
| /api/storage/upload | POST | session | — (attachments reservations enforce tenant in `uploads.ts`) | tenant-ctx.db (RLS) |
| /api/v1/apps | GET | api-key | forms.* (via template access) | tenant-ctx.db (RLS) |
| /api/v1/apps/:templateKey/responses | GET | api-key | forms.response.* | tenant-ctx.db (RLS) |
| /api/v1/apps/:templateKey/responses/:id | GET | api-key | forms.response.* | tenant-ctx.db (RLS) |
| /api/v1/docs | GET | none needed (static ref) | — | n/a |
| /api/v1/:entity | GET, POST | api-key + per-entity permission | read/write per entity | tenant-ctx.db (RLS) + entity column allowlist + 22P02→400 mapping |
| /api/v1/:entity/:id | GET, PATCH, DELETE | api-key | read/write/delete per entity | tenant-ctx.db (RLS) + isUuid + column validation |
| /api/v1/openapi.json | GET | none needed (public spec) | — | n/a |
| /api/v1 | GET | api-key | — | n/a |
| /(app)/apps/by-key/:key/fill | GET | session | forms.response.* (template access) | tenant-ctx.db (RLS) |
| /(app)/apps/responses/export.csv | GET | session | forms.response.* | tenant-ctx.db (RLS) + pickEnum/pickUuid + audit |
| /(app)/apps/responses/:id/pdf | GET | session | forms.response.* | tenant-ctx.db (RLS) |
| /(app)/assistant/chat | POST | session | assistant.use/write | tenant-ctx.db (RLS) |
| /(app)/corrective-actions/export.csv | GET | session | ca.*? + export audit | tenant-ctx.db (RLS) + parseListParams |
| /(app)/corrective-actions/:id/pdf | GET | session | ca.read.* | tenant-ctx.db (RLS) + recordVisibilityWhere |
| /(app)/documents/books/:id/pdf | GET | session | documents.read | tenant-ctx.db (RLS) |
| /(app)/documents/export.csv | GET | session | documents.* + export audit | tenant-ctx.db (RLS) + isUuid + list params |
| /(app)/documents/:id/master | GET | session | documents.read | tenant-ctx.db (RLS) |
| /(app)/documents/:id/pdf | GET | session | documents.read | tenant-ctx.db (RLS) |
| /(app)/documents/:id/versions/:versionId/download | GET | session | documents.read | tenant-ctx.db (RLS) |
| /(app)/documents/management-reviews/:id/pdf | GET | session | documents.read | tenant-ctx.db (RLS) |
| /(app)/documents/sign-off-sessions/:sessionId/pdf | GET | session | documents.read | tenant-ctx.db (RLS) |
| /(app)/equipment/export.csv | GET | session | equipment.read.all | tenant-ctx.db (RLS) + pickEnum |
| /(app)/equipment/:id/pdf | GET | session | equipment.* | tenant-ctx.db (RLS) + visibility |
| /(app)/equipment/:id/qr/pdf | GET | session | equipment.* | tenant-ctx.db (RLS) |
| /(app)/equipment/inspections/:id/pdf | GET | session | equipment.* | tenant-ctx.db (RLS) |
| /(app)/equipment/qr/labels | GET | session | equipment.* | tenant-ctx.db (RLS) |
| /(app)/equipment/vehicle-log/export.csv | GET | session | equipment.read.all | tenant-ctx.db (RLS) + year regex |
| /(app)/equipment/vehicle-log/pdf | GET | session | equipment.read.* | tenant-ctx.db (RLS) + validity (month/driver/vehicle/mode via policy) |
| /(app)/equipment/work-orders/:id/pdf | GET | session | equipment.* | tenant-ctx.db (RLS) |
| /(app)/feedback/turn | POST | session | feedback.use (appkit) | tenant-ctx.db (RLS) |
| /(app)/hazard-assessments/blank/pdf | GET | session | hazid.* | tenant-ctx.db (RLS) |
| /(app)/hazard-assessments/:id/pdf | GET | session | hazid.* | tenant-ctx.db (RLS) |
| /(app)/incidents/export.csv | GET | session | incidents.* + export audit | tenant-ctx.db (RLS) + parseListParams |
| /(app)/incidents/:id/pdf | GET | session | incidents.* | tenant-ctx.db (RLS) + visibility |
| /(app)/insights/cards/:id/export | GET | session | insights.* | tenant-ctx.db (RLS) |
| /(app)/inspections/export.csv | GET | session | inspections.* + export audit | tenant-ctx.db (RLS) + pickUuid ×3 |
| /(app)/inspections/records/:id/pdf | GET | session | inspections.* | tenant-ctx.db (RLS) |
| /(app)/journals/ai | POST | session | journals.* | tenant-ctx.db (RLS) |
| /(app)/journals/export.csv | GET | session | journals.* + export audit | tenant-ctx.db (RLS) |
| /(app)/journals/:id/pdf | GET | session | journals.* | tenant-ctx.db (RLS) |
| /(app)/locations/export.csv | GET | session | admin.org.* | tenant-ctx.db (RLS) |
| /(app)/observations/export.csv | GET | session | journals?observations | tenant-ctx.db (RLS) |
| /(app)/people/export.csv | GET | session | **people.read.all** (D2) | tenant-ctx.db (RLS) |
| /(app)/people/:id/badge/print | GET | session | people.read.all | tenant-ctx.db (RLS) |
| /(app)/people/:id/badge | GET | session | people.read.all | tenant-ctx.db (RLS) |
| /(app)/ppe/export.csv | GET | session | ppe.* + export audit | tenant-ctx.db (RLS) + parseListParams |
| /(app)/ppe/:id/inspections/:inspectionId/pdf | GET | session | ppe.* | tenant-ctx.db (RLS) |
| /(app)/ppe/:id/issues/:issueId/pdf | GET | session | ppe.* | tenant-ctx.db (RLS) |
| /(app)/reports/definitions/:id/export | GET | session | reports.read | tenant-ctx.db (RLS) + format whitelist + isUuid |
| /(app)/reports/schedules/:id/runs/:runId/pdf | GET | session | reports.read/schedule | tenant-ctx.db (RLS) |
| /(app)/tools/safe-distance/export.csv | GET | session | tools.safe-distance.* | tenant-ctx.db (RLS) + parseListParams |
| /(app)/training/assessments/:id/pdf | GET | session | training.* | tenant-ctx.db (RLS) |
| /(app)/training/classes/:id/pdf | GET | session | training.* | tenant-ctx.db (RLS) |
| /(app)/training/courses/export.csv | GET | session | training.* + export audit | tenant-ctx.db (RLS) + pickEnum |
| /(app)/training/credential-designs/preview | GET | session | training.* | tenant-ctx.db (RLS) |
| /(app)/training/pptx/:target/:id/download | GET | session + filing | training.* | tenant-ctx.db (RLS) + filing (found) |
| /(app)/training/records/:id/certificate/print | GET | session | training.* | tenant-ctx.db (RLS) + filing |
| /(app)/training/records/:id/certificate | GET | session | training.* (+ filing) | tenant-ctx.db (RLS) + filing + output id via picker |
| /(app)/training/records/wallet-cards | POST | session | training.* | tenant-ctx.db (RLS) |
| /(app)/training/skills/:id/certificate/print | GET | session | training.* | tenant-ctx.db (RLS) + filing |
| /(app)/training/skills/:id/certificate | GET | session | training.* (+ filing) | tenant-ctx.db (RLS) + filing + output id via picker |
| /favicon.ico | GET | none | — | n/a |
| /invite/accept | GET | session (grant link) | — (grant is bearer, single-use) | tenant ctx built from grant |
| /manifest.webmanifest | GET | none + super-pool lookup of app display name | — | withSuperAdmin (display-name only) |
| /wopi/files/:fileId/contents | GET, POST | bearer token | — | tenant-ctx via access token (paused by owner) |
| /wopi/files/:fileId | GET | bearer token | — | tenant-ctx via access token (paused by owner) |

## Public page surfaces (no auth by design; not route handlers)

| Surface | Why public | Protection |
|---|---|---|
| /login, /forgot-password | sign-in entry | Better-Auth flow only |
| /kiosk?t=<slug> | shared-tablet sign in/out | scoped PIN (scrypt hash, 6–12 now) + rate limit |
| /equipment-kiosk | shared station sign in/out | station PIN (hashed, 6–12 now) + rate limit |
| /verify/:token (certificate) | QR verification of issued credentials | verify_token (high-entropy bearer) + rate limit; tenant-less lookup via BYPASSRLS pool |
| /verify/person/:token (+ record/:recordId, skill/:assignmentId) | QR on ID badges | badge_token bearer + rate limit + isUuid + BYPASSRLS pool |
| /invite/status | post-accept landing (state=expired/invalid/pending/active) | state token |

## Server-action mutation surface (by module; every action asserts its permission)

Action files = `apps/web/src/app/(app)/**/*_actions.ts` + `apps/web/src/app/(app)/**/actions.ts` +
`apps/web/src/lib/*/actions.ts` (≈ 66 files). Every action asserts its `assertCan` /
`assertCanManageModule`/module gate **inside the action** (nav hiding is not the
boundary), performs tenant-scoped reads via `ctx.db()` RLS, validates id/enum/date
inputs through `requireUuidInput` / `pickEnum` / `pickUuid` / `isCalendarDate` /
bounded parsers (the 22P02/22007 sweep), and writes an audit record. High-risk
funnels (`resolveAssessmentAccess`, `lockVisibleAssessment`, `pickerAuthorized`,
`assertCan`) are all precondition-validated. The one exception to flag during
Phase 3: actions reach module-internal `tx` SQL directly; their guard is the
`assertCan` + `resolve*Access` funnel, never the page.

## Phase 2 permission test matrix (to be executed in Phase 3)

Identities (dev seed already provides them):
`cu-site-a`, `cu-site-b` (foreman, site-scoped A / B), `worker`-class role users
(need creation or check roster), `keytest` (safety_manager, tenant-wide),
`cu-cross` (role-less member), `admin@beaconhs.local` (super-admin).

| # | Scenario | Probe | Expected |
|---|---|---|---|
| 1 | `/api/search` unauthenticated | GET no cookie | 401 |
| 2 | picker-options as role-less member | purpose only, no people.pick | 403 + zero DB hits |
| 3 | picker-options `vehicle-drivers` as foreman+people.pick | purpose+pick | 200 (permission delta proven) |
| 4 | v2 attachment URL cross-tenant | other tenant's session | 404 even with valid cap |
| 5 | `/api/v1/:entity` read with key lacking permission | key | 403 |
| 6 | `/api/v1/:entity` read with valid key | key±permission | 200 with tenant-only rows |
| 7 | `/api/v1/:entity` read across tenants | key_A vs key_B | zero B rows, no leak in counts |
| 8 | `/people/export.csv` as foreman | session | 401/403 (needs people.read.all) |
| 9 | `/api/internal/domain-events/:id` wrong signature | HMAC tamper | 401 |
| 10 | kiosk PIN 4-digit (already run, FAIL expected) | public | pattern-block + server 6–12 reject |
| 11 | `/verify/:token` revoked token | public | truthful revoked state, rate-limited |
<!--<phase2>-->

## Environment & test-identity availability (checked 2026-11-09)

- Git clean at `7df32ab6` on `hse-platform` (only gitignored `.env` differs).
- Compose services green: postgres (5433), redis (6380 published, RUNTIME ok),
  minio (9000), mailpit (8025), collabora.
- Dev app starts with `set -a; source .env; REDIS_URL=… pnpm dev` (host env
  must supply DATABASE_URL; turbo does not load the root `.env` for the web
  task — see addendum); `/login` 200.
- Identities available for real API probes: admin (super-admin, magic link via
  Mailpit), cu-site-a / cu-site-b (foreman / sites A,B), keytest (safety_manager).
- Two tenants in dev seed: `demo` (Acme Industrial) + `phase-bs-isolated` — the
  natural Project A / B pair. Phase BS attachment records live under the
  phase-bs tenant for the cross-tenant attachment probe.

## Not covered / known limits

- WOPI: paused by owner; excluded from behaviour verification.
- /api/apps/* / apps fill flows: route-level covered above; the deep fill-page
  flows are in the earlier audits.
- Server-action forms enumerated per module; the per-action assertCan table is
  extracted from source, not re-listed here (see `API_SECURITY_AUDIT_REPORT.md`
  for the deep cut).
- Project (= org-unit-level 2) isolation is expressible only through the site
  tier; this is a documented model limit, not a finding.
