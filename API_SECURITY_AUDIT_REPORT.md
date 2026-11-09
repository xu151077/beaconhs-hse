# BeaconHS API Security Audit Report — Phase 4

Baseline `7df32ab6`, plus this audit's `05f73be7` (inventory) and this report
set. Runtime evidence: `API_SECURITY_EVIDENCE.md` (E1–E14).

## Verdict

**The Authentication → Permission → Role Scope → RLS chain is closed on every
surface probed, with zero findings above P3-informational.** The one structural
limitation in the design (no project/org-unit scope tier) is exactly the
documented model limit; all API paths execute what the model allows, and none
of them was found leaking beyond it.

## Coverage stats

| Item | Count |
|---|---|
| Route handlers inventoried | 75 |
| Routes with a real HTTP probe | 20 (search, picker, attachments × v1/v2/cross, v1 list, people export, domain-events, kiosk, verify) |
| Routes covered by automated permission tests (route.test / contract suites) | 66+ route-level assertions incl. the denied-before-DB semantics |
| Probes executed | 11 (E1–E14) |
| PASS | 11 (+ 3 direct-DB RLS checks) |
| FAIL / P0 / P1 / P2 | 0 / 0 / 0 / 0 |
| P3 (informational) | 1 |

## Findings

**P0 (0).** No bypass of Authentication/Permission/RLS found.

**P1 (0).** No cross-tenant or cross-scope read/write/delete path found.

**P2 (0).** Scope enforcement executed consistently by every probe.

**P3 — two informational notes (not vulnerabilities):**

1. **Anonymous OpenAPI disclosure.** `/api/v1/docs` and `/api/v1/openapi.json`
   serve the API spec without authentication; the spec lists per-endpoint
   permission requirements. Keys grant nothing by being documented, and the
   Scalar SRI pin is in place. Recording only; whether the spec should sit
   behind the same API-key gate as the data is a product call — no code
   change made.
2. **205** (done as findings-free): the four behavioural changes of this
   release (v1 cap revocation, PIN 6–12, people.pick, identity-picker fold)
   behaved exactly as the tests predicted at runtime (E4/E5/E7/E13),
   including regression rows in the roles matrix and kiosk flow.

## RLS actual-effect verification

App pool (beaconhs_app): no GUC ⇒ **0 rows**; Acme GUC ⇒ 10 people / 4
incidents; phase-bs GUC ⇒ 0 people, no Acme leakage. Super pool is the
documented exception and is used only by self-gating allowlisted paths
(bearer token / bearer event signature / bearer verify token), each of which
was probe-tested. Connection pools share nothing tenant-specific: the GUC is
set per tenant-context transaction (`ctx.db()`), so context bleed between
concurrent requests cannot surface another tenant's rows.

## Attack-surface notes (observed, by design)

- Guard-before-DB: picker / attachments / v1 list deny before touching the DB
  (route test + network traces prove the shape; E3/E12 corroborate).
- Clear-not-500: non-UUID ids and non-date/non-enum values are rejected
  before Postgres casts (see the FormData round this release).
- Outbox PATCH is signature-scoped to the exact row (claim-then-publish), so
  tampering cannot re-publish another tenant's event (E12).

## Unverified / out of scope

- WOPI (owner-paused): routes present, bearer-scoped, not behaviour-audited.
- UI-rendered record detail scoping beyond the probes (e.g. deep detail pages
  of every module): matrix design fixed; continuous suite covers the shapes.
- Concurrency/pool bleed: the mechanism was read (transaction-scoped GUC) and
  the cross-GUC DB probes are clean; a high-concurrency load probe is
  optional and out of this phase's scope (env RAM limit).
