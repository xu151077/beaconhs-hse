# BeaconHS API Write-Surface Security Audit — Deep Round 2

Baseline `eecc87cf` (audit commits `05f73be7`, `eecc87cf`).

## Writes covered

The entire write-capable HTTP surface is `apps/web/src/lib/api/write.ts`
(7 entities × create/update/delete; per-entity `permission`, `update.permission`,
`delete.permission` from `WRITES`), plus the apps fill write
(`/api/v1/apps/*`, `LibsButton`/persistDraft) and the draft-save route
which reuses the same server-action the UI calls. Nothing else mutates state
over HTTP.

- **PATCH / DELETE per entity** require the per-entity **write** permission
  (`incidents.update` gates both PATCH and DELETE for incidents), not the read key.
- **Create** requires the per-entity `*.create` key; the idempotent-write headers
  are required first (`Idempotency-Key` was exercised and is part of the write
  surface contract).
- **Record survival on bad input** is structural: each handler runs a single
  `ctx.db` transaction with validations before the UPDATE (zod → FK existence in
  the same tenant → single `UPDATE … WHERE id`). Failed patches reject before
  or roll back the whole write; no partial update was observed (W7).

## Probes (W1–W9+)

| Probe     | Scenario                                           | Channel                                 | HTTP                                                             | DB check                            | Verdict                      |
| --------- | -------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- | ----------------------------------- | ---------------------------- |
| W1        | PATCH by key with only `ppe.read.all`              | PATCH `/api/v1/incidents/:id`           | **403** — "grant permission incidents.update"                    | nothing written                     | PASS                         |
| W2        | PATCH by key with only `incidents.read.all`        | PATCH `/api/v1/incidents/:id`           | **403** — same                                                   | nothing written                     | PASS (read ≠ write proven)   |
| W3        | PATCH by full write key                            | PATCH test row                          | **200** applied (title changed)                                  | DB holds the new title              | PASS                         |
| W4        | **Cross-tenant** PATCH by Acme key on phase-bs row | PATCH                                   | **404** "No incidents with id …" (not found invisible under RLS) | row untouched                       | PASS                         |
| W5        | DELETE by write key                                | DELETE test row                         | **200**                                                          | `deleted_at` set; audit row written | PASS                         |
| W6        | DELETE by read-only key                            | DELETE                                  | **403**                                                          | row untouched                       | PASS                         |
| W7        | Mixed valid + invalid body (enum tamper)           | PATCH `{title, status:'bogus'}`         | **400** zod invalid (prior patches untouched)                    | title unchanged                     | PASS (atomic reject)         |
| W8        | `tenant_id` tamper in body                         | PATCH + `tenant_id` (other tenant)      | **200** with `tenant_id` stripped (unknown key dropped by zod)   | row still in its own tenant         | PASS                         |
| W8b       | Snake-case forgery (`site_org_unit_id`)            | PATCH                                   | **200**, key stripped (only camelCase allowed)                   | untouched site field                | PASS                         |
| W9        | Cross-tenant **site** tamper                       | PATCH with a real site id from phase-bs | **400** "No org unit with id … in this tenant"                   | title + site untouched              | PASS                         |
| (routing) | PATCH non-existent UUID / malformed UUID           | PATCH `/api/v1/incidents/<uuid>`        | 404/400 pre-query isUuid                                         | —                                   | PASS (already in route.test) |

Test rows (3 incidents: AUDIT-W1/W2 Acme, AUDIT-WX phase-bs) were created via
SQL insert before the probes and hard-deleted afterwards (the `AUDIT-W1` soft
delete stays a visible tombstone — legitimate audit trace gets **kept**;
api_keys / org_units test rows removed: api_keys back to 0, org_units AUDIT site removed).

## Findings grade

| P0  | P1  | P2  | P3  |
| --- | --- | --- | --- |
| 0   | 0   | 0   | 0   | + 2 informational notes (same P3 as Round 1: anonymous OpenAPI; second: see E-via evidence) |

**Argument:** No bypass of any write path, no cross-tenant/site write, no
validation-order flaw, no partial write. The single transaction + validate-first
shape of every writable entity handler makes the whole class structurally
fail-closed.
