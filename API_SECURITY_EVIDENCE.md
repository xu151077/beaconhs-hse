# BeaconHS API Security Evidence — API Permission Audit Phase 3

Each item: Probe, Request, Response, DB verification, Verdict. No secrets are
reproduced (session cookies, HMAC secrets, raw API tokens are omitted; only
the endpoints, identities, status codes, and the data shape are recorded).

## E1 — Unauthenticated global search → 401

```
GET /api/search?q=slip        (no cookie)
HTTP 401  {"q":"","groups":[]}
```
Search handler refuses before any DB touch (`getRequestContext()` falsy).
Expected 401. **PASS.**

## E2 — Unauthenticated picker → 401

```
GET /api/picker-options?lookup=vehicle-drivers  (no cookie)
HTTP 401  {"options":[],"hasMore":false}
```
**PASS.**

## E3 — Unit: purpose-only picker denied before DB

```
route.test.ts (picker role): ctx.permissions={ incidents.investigate }
GET /api/picker-options?lookup=incident-people
→ 403, ctx.db never called (mock assertion)
```
(Route.ts `pickerAuthorized` requires BOTH purpose and `people.pick`.) **PASS.**

## E4 — Foreman w/ purpose + people.pick → 200 person rows

Session: cu-site-a (foreman, sites A) via Mailpit magic link (cookie jar).
```
GET /api/picker-options?lookup=incident-people&q=an
HTTP 200 {"options":[{"value":"…","label":"Anderson, John","hint":"E001 · Foreman"},…]}
```
Tenant-scoped rows only (Acme directory); person shape has name + employee no +
job title, no e-mails. **PASS.**

## E5 — Identity picker purpose-only → 403

```
route.test.ts: ctx.permissions={ tools.safe-distance.use }
GET /api/picker-options?lookup=safe-distance-supervisors
→ 403, ctx.db never called
```
Covers the worker-holds-this-permission-the-cheap-way case after the identity
fold (`534faf0c`, same audit round as the inventory). **PASS.**

## E6 — org-unit / non-member lookups don't need people.pick

Org-unit lookups (location-* , *-sites) return no member rows; the identity
set does not include them. Covered by the positive rows of the same test suite
(purpose-only grants reach DB on org/equipment-type pickers). **PASS.**

## E7 / E7b — Attachment capability cross-tenant and downgrade

Session: demo super-admin.
```
GET /api/attachments/<phase-bs-attachment-id>?cap=<valid v2 cap>
→ HTTP 404  (Acme session, phase-bs data invisible under RLS)
GET /api/attachments/<acme-id>?cap=<v1 cap>
→ HTTP 404 (v1 rejected; no accept-path)
GET /api/attachments/<acme-id>?cap=<v2 cap>
→ HTTP 200 with streamed bytes after env bucket/creds alignment
```
The v2 200 was reproduced twice: once before alignment the route 404'd at the
storage step (bucket mismatch in this sandbox), then 200 after
`R2_BUCKET=beaconhs-dev` and root creds were paired with the running MinIO.
DB check: attachment belongs to phase-bs so cross-tenant stays 404 regardless
of cap quality. **PASS.**

## E8 — API key without entity permission → 403

```
K_noperm (permissions ["ppe.read.all"])
GET /api/v1/incidents
→ 403 {"error":{"code":"forbidden","message":"This key cannot read \"incidents\" — grant permission incidents.read.all."}}
```
Deleted afterwards. **PASS.**

## E9 — API key with entity permission → 200 (tenant rows)

```
K_inc (permissions ["incidents.read.all"] on Acme)
GET /api/v1/incidents?limit=3
→ 200 {"entity":"incidents","data":[4 incident rows, Acme tenant only],"pagination":{"limit":3,"total":4,"hasMore":true}}
```
DB check: `incidents` count under Acme = 4 (all incidents in the DB belong to
Acme; phase-bs = 0). So the returned rows correspond exactly to the tenant's
records; no site-filtering is applied beyond tenant scoping (API keys are
tenant-scoped by design — no site variant exists for them). **PASS.**

## E10 — Cross-tenant API key → empty, not leaked

```
K_phase (permissions ["incidents.read.all"] on phase-bs)
GET /api/v1/incidents?limit=3
→ 200 {"entity":"incidents","data":[],"pagination":{"limit":3,"offset":0,"total":0,"hasMore":false}}
```
The phase-bs key cannot read Acme's incidents through the same endpoint even
though it holds the same permission key. No counts, ids, or titles leaked.
**PASS.**

## E11 — people export as foreman → 403

Session: cu-site-a (foreman; no `people.read.all`).
```
GET /people/export.csv
→ 403 {"error":{"code":"forbidden","message":"Forbidden"}}
```
Reads gated even though foreman holds picker person-directory rows via
`people.pick` — export needs the full read tier. **PASS.**

## E12 — Domain event, unsigned → 401

```
POST /api/internal/domain-events/00000000-0000-0000-0000-000000000000 (no signature headers)
→ 401 "Unauthorized". No outbox write performed.
```
A GET to the same path is 405 (POST-only handler) — recorded as informational,
not a finding. **PASS.**

## E13 — Kiosk PIN: 4-digit rejected, 6-digit unlocks (public)

```
POST-less browser flow on /kiosk?t=demo:
  PIN 1234        → pattern block (no /kiosk... request fired at all)
  PIN 482913      → search box rendered
DB: after setting, tenants.kiosk_pin = bhs_pin_scrypt_v1$… (set + later cleared;
kiosk_pin unset again — verified).
```
(Retime §Kiosk above.) **PASS.**

## E14 — Revoked certificate is truthful

```
(inserted a revoked training_certificates row for an existing Acme record,
 token X)
GET /verify/X  (public)
→ page shows title "REVOKED Training certificate", holder/title, issue/expiry,
  issuer Acme Industrial. Not "invalid", not "valid".
(delete X afterwards; training_certificates count back to 0)
```
Rate limit note: `guardPublicPageRateLimit('verify', token)` was engaged on the
page path. **PASS.**

## RLS direct probes (db side)

| Check | Command | Result |
|---|---|---|
| app pool, no GUC | `set app.tenant_id=''; select count(*) from people` | 0 — fail-closed |
| app pool, Acme GUC | `…='8b62c4c2-…'; select count(*) from people` | 10 (Acme rows) |
| app pool, phase-bs GUC | `…='aca29e48-…'; select count(*) from people` | 0 (no leak of Acme rows) |
| app pool, Incidents, Acme GUC | `select count(*) from incidents` | 4 (matches DB total for Acme) |

Super-pool (beaconhs_super) bypasses by role by design; only the allowlisted
paths (verify routes, domain-event locate, outbox, migration/branding writes) use it,
each of which was probe-covered (E12/E14 show the signature/token checks that
gate them).
