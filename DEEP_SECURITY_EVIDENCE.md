# BeaconHS Deep Security Evidence — Round 2

Write-surface probes (all real HTTP against the dev app; every mutating
probe paired with a before/after DB read). Test rows deleted after. Note on
prior key cleanup: an earlier draft of this round's probe deleted audit keys
during cleanup before rerunning; state was rebuilt for the reruns, so all
emitted numbers below are post-rebuild.

## W1 — Write key missing on PATCH → 403

```
PATCH /api/v1/incidents/357a6b1c-9e72-4c0c-8b90-cbdbe06654ed  (K_noperm: ppe.read.all)
Idempotency-Key: audit-w1-001
→ 403 {"error":{"code":"forbidden","message":"This key cannot update \"incidents\" — grant permission incidents.update."}}
DB: incident row untouched.
**PASS**
```

## W2 — Read-only key cannot PATCH → 403

```
PATCH same row (K_inc2: incidents.read.all)
→ 403 "This key cannot update \"incidents\" — grant permission incidents.update."
**PASS**
```

## W3 — Full write key PATCHs → 200 applied

```
PATCH (K_write: incidents.create+incidents.update) {title:"audit patched title"}
→ 200, response reflects the new title.
DB: incidents.title = 'audit patched title' (AUDIT-W1).
**PASS**
```

## W4 — Cross-tenant PATCH invisible → 404, untouched

```
PATCH Acme key over the phase-bs test record id
→ 404 {"error":{"code":"not_found","message":"No incidents with id 52508180-…"}}
DB: AUDIT-WX.title = 'audit cross tenant' (unchanged), deleted_at null.
**PASS**
```

## W5 — DELETE by write key → 200 soft-delete

```
DELETE (K_write, Idempotency-Key: audit-w5-001) AUDIT-W1
→ 200 {"deleted":true}
DB: deleted_at set (count of AUDIT-W1 tombstone = 1 before teardown)
**PASS**
```

## W6 — DELETE by read-only key → 403

```
DELETE (K_inc2) AUDIT-W1
→ 403 "This key cannot delete \"incidents\" — grant permission incidents.update.".
**PASS**
```

## W7 — Mixed valid + invalid body → 400, no partial write

```
PATCH (K_write) {title:"must not persist", status:"not_a_status"}
→ 400 validation: status must be one of reported|under_investigation|pending_review|reopened
DB: title stays 'audit patched title' (the W3 value) — nothing from W7's body persisted.
**PASS**
```

## W8 — tenant_id tamper → silently stripped

```
PATCH (K_write) {title:"tenant tamper attempt", tenant_id: phase-bs-id}
→ 200 {"title":"tenant tamper attempt",…}
DB: incidents.tenant_id stays Acme's.
**PASS**
```

## W8 variant — snake_case wrong key → stripped, site untouched

```
PATCH (K_write) {site_org_unit_id: "00000000-…"}
→ 200; row.site_org_unit_id stays null (unknown key dropped — camelCase is the
accepted name; ensureSite never ran because the field never existed)
**PASS (informational: unknown keys are discarded, not trusted)**
```

## W9 — Cross-tenant real site tamper → 400, no partial write

```
PATCH (K_write) {siteOrgUnitId: <real phase-bs site id>, title:"must not persist"}
→ 400 {"error":{"code":"invalid_request","message":"No org unit with id 0746858c-… in this tenant"}}
DB: title stays 'tenant tamper attempt', site_org_unit_id null.
**PASS**
```

## Teardown (audited data cleaned)

Patched rows hard-deleted after; audit_log retains the 4-write audit trail
entries (principled — the system's own audit record, not test residue).
phase-bs test site deleted. api_keys back to 0. tenants.kiosk_pin already
unset since the Round-1 E2E cleanup.

## Concurrency (C1–C2 combined)

See CONNECTION_POOL_ISOLATION_AUDIT.md.

| run | requests | elapsed | Acme ok | leaks | phase ok | leaks | aborts | DB unchanged |
|---|---|---|---|---|---|---|---|---|
| C1 | 120 | 4.9s | 60 | 0 | 60 | 0 | 20 | yes |
