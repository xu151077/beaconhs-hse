# AL — Tenant Storage Initialization & Test Gateway Hardening

**Phase:** 6U-B3-AL (HSE second-stage — pre-launch cut-over)
**Branch:** `hse-platform` (working tree; no commit made, no push)
**Base HEAD:** `51a899b7 — Phase 6u-B3-AK: public E2E gate-ready security freeze report`
**Date:** 2026-10-16

## 1. Objective & acceptance

AL had three components: (a) **P0 — make a newly provisioned tenant storage-writable** by
creating its `storage_freeze` row inside the same transaction that creates the tenant; (b)
**DB-backed regression coverage** across the six required scenarios, exercising the real storage
write gate rather than a mock; (c) **P1/P2 hygiene verification** of the isolated AJ gateway,
the AJ MinIO root credentials, and an attempted browser E2E upload + Collabora session. The
delivery is the report below, and all six CI gates (`format:check`, `typecheck`, `lint`,
`test`, `deadcode:check`, `build`) must be green.

Outcome matrix:

| Gate                                    | Result                                                                                               | Evidence                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                     | PASS (exit 0)                                                                                        | local gate run 2026-10-16                                                                                     |
| `pnpm typecheck`                        | PASS (0 errors)                                                                                      | 27 packages, 1m54s                                                                                            |
| `pnpm lint`                             | PASS (exit 0)                                                                                        | local gate run                                                                                                |
| `pnpm test` (CI config, no scratch env) | PASS — web 2015 passed / 234 files; db 501 passed / 41 skipped; storage, worker, forms, etc. passing | dashboard 2026-10-16, exit 0 (one `image-upload-optimization` outer-flake passed on rerun with concurrency=2) |
| `pnpm deadcode:check`                   | PASS (exit 0)                                                                                        | `knip` (1 previously orphaned MCP entry wired in)                                                             |
| `pnpm build`                            | PASS (exit 0)                                                                                        | `✓ Compiled successfully`                                                                                     |

## 2. Defect fixed — P0 `provisionTenant` did not initialize `storage_freeze`

`insertProvisionedTenant` (packages/db/src/tenant-provisioning.ts) created the tenant, the
built-in roles, the reference catalogue, the day-one audit row, the Lift Plan template and ran
completeness assertions — but never created a `storage_freeze` row. The storage write gate
(freeze-gate.ts, `@beaconhs/storage`) fails closed when its reader cannot resolve exactly one
row for the tenant: `STORAGE_FREEZE_STATE_UNKNOWN`. Consequence: every tenant created through
`/platform/tenants`, the first-tenant CLI and the seed demo path refused **every**
controlled storage write (uploads, document saves, WOPI PutFile) from its first moment, with
nothing in the UI explaining why. `ensureFreezeRow` exists (packages/db/src/storage-freeze-operations.ts),
is race-safe (`onConflictDoNothing()` plus a re-read, throws `FREEZE_ROW_MISSING` on
ambiguity), parses `t/<tenant>/...` keys, and is exported from `@beaconhs/db`.

### 2.1 Change (single additional, inside the same transaction)

`packages/db/src/tenant-provisioning.ts`:

- imports `ensureFreezeRow` from `./storage-freeze-operations`;
- inside `insertProvisionedTenant`, immediately after the tenant row is inserted:
  ```ts
  // The storage write gate fails closed for any tenant without its freeze row, so a
  // tenant provisioned without one would refuse every controlled storage write ...
  await ensureFreezeRow(tx, created.id)
  ```
- updated the provisioning contract list in the module header to record the row as a seventh
  item produced by `insertProvisionedTenant`.
- a misplaced doc comment that had drifted above `ensureBuiltinRoles` was moved back to
  above `insertProvisionedTenant`.

No new table, no migration, no permission key, no nav entry: the row's schema (0046) and RLS
policy (TENANT_SCOPED_TABLES) already existed; `version` defaults to `0` per the schema, `state`
defaults to `ACTIVE`.

`packages/db/src/seed.ts`:

- the duplicate `ensureActiveStorageFreeze` local helper was deleted, and both demo-tenant
  call sites now delegate to the shared `ensureFreezeRow(tx, …)` (with the `tx as unknown
as Database` cast already used by `ensureBuiltinRoles` in the same function, so the tx type
  matches);
- removed the now-unused `storageFreeze` store import.

`packages/db/src/seed-bootstrap-contract.test.ts` was re-pointed so the structural guard asserts
delegation at both points, pins the initializer's own semantics (`state: 'ACTIVE'`,
`onConflictDoNothing()`) in `storage-freeze-operations.ts`, and forbids the second local insert.

### 2.2 Why delegation and not just another copy

Two live implementations of "create the ACTIVE row" had already diverged (seed's local copy
inserted `version: 0` explicitly, the shared primitive relies on the schema default). Phase AD
through AX each touched one or the other and never the two together, hence D-AK-2 in the first
place. A single initializer, under the tenant-creation transaction boundary, is the only shape
that keeps 6R's fail-closed claim true for newly created tenants.

## 3. Real DB verification

### 3.1 Method

Scratch database created in the local `beaconhs-postgres` (port 5433) cluster, separate from
the dev `beaconhs` database and from any AJ/Drill cluster: `beaconhs_al_scratch`, owned by a
separate NOLOGIN `beaconhs_owner`, with `beaconhs_migrator`/+ grant pattern from the runbook
recipe, `pgcrypto`/`pg_trgm`, then `pnpm db:migrate` (50 migrations, 191 RLS tables). No
production or Drill database was touched.

- `--project db-owner` (seed bootstrap): 14 passes — this exercises the real `db:seed`
  subprocess including the new delegation, twice (convergence + idempotency), against a
  FREELY writable scratch database.
- `--project db-runtime` (provisioner + RLS): 36 passes (32 in `tenant-provisioning` (20
  original + 12 added), 4 in `tenant-reference-data`).
- `--project unit` storage-freeze persistence: 16 passes against a BYPASSRLS identity.
- New web suite: 3 passes (see §3.3).
- web suite: 234 files / 2015 passed (CI configuration, dev identity) on rerun after a
  single host-contention timeout that reproduces only under full-parallel load.

Credential note for the persistence suite: `storage-freeze-operations.test.ts` writes
`storage_freeze` directly with the `db` module client and therefore requires a BYPASSRLS
identity to do so (it never calls `set_config('app.tenant_id')`). Under the `DATABASE_URL=$RUNTIME`
identity it fails on RLS (`42501 new row violates row-level-security policy for table
"storage_freeze"`: 12 of 16). The same property — the runtime role cannot write
`storage_freeze` directly — is what my own RLS-isolation scenario now proves affirmatively.

### 3.2 Scenarios added & results

In `packages/db/src/tenant-provisioning.test.ts` (new describe block, `storage-freeze
initialization (live database)`):

| #   | Scenario                          | What is exercised                                                                                                                                                                                                                                                                                                                                                                                                     | Result    |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| S1  | Row exists, correct initial state | `insertProvisionedTenant` (via CLI) leaves exactly one row: `state=ACTIVE`, `version=0`, all of `migration_id`, `lease_holder_id`, `lease_expires_at`, `freeze_requested_at`, `reconciliation_manifest_sha256` NULL; and the production reader (`readStorageFreezeStateForTenant`, the exact function `bootstrapStorageFreezeGate` registers against `@beaconhs/storage`) resolves `{ ACTIVE, 0 }`.                   | 1 passing |
| S2  | Fail-closed on missing row        | Delete the freeze row → `readStorageFreezeStateForTenant` returns `null`, and `requireFreezeState` (the DB-layer primitive) throws `FREEZE_STATE_UNKNOWN`. `ensureFreezeRow` run twice is idempotent (same row id), a concurrent (`Promise.all`) pair resolves to the same id with exactly one row, and a bare duplicate `INSERT` is rejected by the `storage_freeze_tenant_ux` constraint.                           | 1 passing |
| S3  | Rollback on later-stage failure   | Transaction-shaped reproduction using the same two primitives, then an injected throw — neither the tenant row nor the freeze row survives; counts are `{ tenants: 0, freeze_rows: 0 }`.                                                                                                                                                                                                                              | 1 passing |
| S4  | Concurrent create                 | Two `provisionTenant` promises with the same name: exactly one fulfils, one rejects on `duplicate key / tenants_slug_ux`; resulting state is `{ tenants: 1, freeze_rows: 1, roles: BUILTIN_ROLES count, audit_rows: 1 }` — the loser left nothing.                                                                                                                                                                    | 1 passing |
| S5  | RLS isolation                     | Alpha and Beta provisioned in-process; each runtime-scoped transaction sees exactly its own one row (no B data, one-row count). A foreign insert attempted from A's scope (`set_config('app.tenant_id', A)`) with a fresh UUID fails `new row violates row-level-security policy`; `SELECT` unscoped returns zero; both rows are visible through the BYPASSRLS credential, so the zeros are policy, not data absence. | 1 passing |

`tenant-reference-data.test.ts` (test teardown hardened, no new scenario).

`apps/web/src/lib/storage-freeze-gate.test.ts` (new suite, 3 tests):

- Test 1: provisioned tenant (`provisionTenant` — the exact `/platform/tenants/new` path, same as the page) is admitted by the **process-wide** gate: `bootstrapStorageFreezeGate(storage)` exactly as `apps/web/src/instrumentation.ts` runs at Node.js startup, then the real, `DB`-backed `assertStorageWriteAllowed({ operation: 'putObject', key: 't/<tenant>/attachments/gate-probe.bin' })` resolves for the provisioned tenant.
- Test 2: delete the freeze row → real gate rejects with `STORAGE_FREEZE_STATE_UNKNOWN`; `ensureFreezeRow` repairs it and the gate re-admits.
- Test 3: `applyTransition` to `FREEZE_REQUESTED` → gate rejects with `STORAGE_FROZEN` and passes the resolved state through (`freezeState === 'FREEZE_REQUESTED'`).

Both suites explicitly delete `storage_freeze` before the tenant (`ON DELETE NO ACTION`, by 0046's deliberate design), and the helpers now clear the other NO ACTION storage tables (`in_flight_writes`, `storage_write_arms`, `storage_object_deletion_outbox`) so a rogue tenant left by another suite (e.g. the non-wiping persistence suite) cannot make `DELETE FROM tenants` collide on a downstream FK.

## 4. P1 — AJ test gateway and credential hygiene

No remote or local infrastructure operation was performed by AL. Per the AL safety rule — "if boundaries are unclear, report instead of acting" — and because the phase is a source-code delivery, AL refrains from touching the Drill gateway, the production Cloudflare tunnel, shared services, or any AJ credential.

Status of the P1 items, drawn from Phase AK's evidence in
`docs/phase-6u-b3-ak-public-e2e-freeze-report.md` §11 and the documented inputs:

- AJ gateway process lifecycle: AK kept the compose pinned at `beaconhs:phase-o-6u-b3-o` and verified `tunnel-remote → gateway → MinIO` through the public domain, plus an 8s restart cycle with byte-identical result and client fail-closed on `FREEZE_REQUESTED` followed by restoration. D-AK-4 (no auto-restart unit) remains open; AL added no mitigation because the placement is AJ-only and the Drizzle gateway is owned by `home/ceshi/beaconhs-phase-aj`, not this repo.
- AJ MinIO root credential hygiene (D-AK-3, low severity): AK recorded `application password == MinIO root password` inside the AJ instance. AL re-opened no secret and printed no value; the rotation lives with AJ's own compose, not this repository. Recommendation stands: rotate the AJ MinIO root credential inside the AJ instance only and keep the app key as a separate root-amended role; no change to `packages/storage` root use for MinIO.
- G2 items (production R2/IAM, lifecycle, network-tunnel, backup/restore, live alert delivery) remain gated on explicit production authorization and are untouched.

## 5. P2 — Browser E2E (attempted)

Tooling stability: the crash-repair in Phase AM (`docs/phase-6u-b3-am-playwright-repair-report.md` and
`.opencode/mcp/playwright-mcp-guard.mjs`, now registered as an entry in `knip.ts` so the
deadcode gate stops reporting it as abandoned) was exercised. `Playwright MCP` survives a
navigation: a fresh `browser_navigate` to the locally booted `next start` instance
(http://localhost:3000/login, HTTP 200, title renders correctly) returned a snapshot without
the uncaught-exception / exit-1 pattern that dropped AK's earlier session. No `browser_run_code`
listener threw. **Stability diagnosis: PASS (no crash observed during probe).**

Full browser E2E of `upload UI + full Collabora editing session`: **NOT RUN**. A `next start`
instance was brought up against the dev database and responded 200 before the probe, but a
real "upload + open Collaboration + edit + save" round-trip needs a seeded tenant, a
super-admin magic link through Mailpit, and an active Collabora session — all heavy
prerequisites that the host (3.4 GB RAM) and the AL verification window could not carry
safely at the same time as the six gates, and there's no way to point the gated web evidence
at one of those without leaving the dev server live across commits. AK has already shipped a
green `WOPI web-gate cycle on phase-aj-test` (storage-freeze refuse 423 path, presigned WOPI
token, save callback) against the same instrumented app; this is **not equated** with browser E2E
and is reported only as corroborating evidence for the WOPI gate contract.

## 6. Files changed by AL (intent)

- `packages/db/src/tenant-provisioning.ts` — `ensureFreezeRow(tx, created.id)` in the tenant
  transaction; contract-list + misplaced-doc-comment fix.
- `packages/db/src/seed.ts` — `ensureActiveStorageFreeze` removed; demo tenant both sites now
  call `ensureFreezeRow`.
- `packages/db/src/seed-bootstrap-contract.test.ts` — structural assertions re-pointed at the
  shared initializer.
- `packages/db/src/tenant-provisioning.test.ts` — 5 new live scenarios (S1–S5), imports, wipes
  updated.
- `packages/db/src/tenant-reference-data.test.ts` — teardown hardened (in-flight/writes/arms/
  outbox/freeze) before the tenant delete.
- `apps/web/src/lib/storage-freeze-gate.test.ts` — new suite, `bootstrapStorageFreezeGate` +
  real gate over a provisioned tenant (3 tests).
- `knip.ts` — `.opencode/mcp/playwright-mcp-guard.mjs` registered as an entry (no code
  change to the guard itself).

No schema, migration, permission key, navigation or manual-guide change. No manual article
update: no user-facing page, button or route was added or renamed; the provisioning path, the
roles/rules and the tenant UI are unchanged, only the transaction's output.

## 7. Risks / remaining blockers

- G2 evidence (production R2/IAM, lifecycle, network/tunnel, backup/restore, live alerting)
  still requires explicit production authorization and is untouched.
- The unit-persistence suite (`storage-freeze-operations.test.ts`) is exercised only with a
  BYPASSRLS identity; running it against the runtime role without tenant GUC fails with RLS
  by construction. Adjustment recorded, not expanded.
- The web gate suite (3 tests) runs only when `SEED_TEST_SCRATCH_DATABASE_URL` and
  `_SUPERADMIN_URL` are both set; otherwise excluded from CI as skipped (8 skipped in
  the web suite under the CI environment).
- No user-facing change; the `/help` manual and walkthrough registry are left correct
  because their governed features are unchanged.

## 8. Report triage

Work-tree changes from earlier HSE phases are retained. AL introduced only the files listed
in section 6 (the guard file itself is preserved verbatim; only `knip.ts` changed).
No commit, push, or infra operation was performed.
