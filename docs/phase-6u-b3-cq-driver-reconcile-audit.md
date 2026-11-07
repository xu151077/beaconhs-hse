# Phase 6U-B3-CQ — Freeze driver `reconcile` audit and repair

Date: 2026-10-19
Files:

- `apps/worker/src/bt-freeze-driver.ts`
- `apps/worker/src/bt-freeze-driver.test.ts`
- `apps/web/e2e/helpers/freeze-control.ts`

Status: **PASS — the driver now drives the real state machine through
`FROZEN → RECONCILING → ACTIVE` and releases only with a reconciliation manifest
computed from live database facts.**

## What was wrong

The driver's help text and `switch` advertised `reconcile`, but the `Command`
union and the `validCommands` gate still listed only
`status | request | drain | freeze | release`. The deployed container therefore
answered:

```
$ docker exec beaconhs-phase-aj-worker-1 .../tsx /app/apps/worker/src/bt-freeze-driver.ts reconcile
ERROR: Invalid command "reconcile"
Usage: bt-freeze-driver.ts <command>
Commands:
  status  - Read current freeze state
  request - Request freeze (ACTIVE → FREEZE_REQUESTED)
  drain   - Initiate drain (FREEZE_REQUESTED → DRAINING)
  freeze  - Freeze writes (DRAINING → FROZEN)
  reconcile - Reconcile freeze (FROZEN → RECONCILING)
  release - Release freeze (RECONCILING → ACTIVE)
```

The help text and the accepted-command list disagreed. Fixed by adding
`'reconcile'` to both `type Command` and `validCommands`.

A second, more serious gap: `release` never supplied reconciliation evidence.
`packages/db/src/storage-freeze.ts` refuses any non-`ACTIVE → ACTIVE` release
without a 64-hex manifest (`FREEZE_RECONCILIATION_MISSING`), so a release from
`RECONCILING` could not succeed, and `FROZEN → ACTIVE` is deliberately illegal.
The previous `release` attempted the illegal edge directly.

## Repair

### `reconcile`

Single legal edge `FROZEN → RECONCILING` via the production `applyTransition`,
permission `admin.storage.freeze.reconcile`:

```
$ docker exec .../tsx /app/apps/worker/src/bt-freeze-driver.ts reconcile
state=RECONCILING version=4
```

### `release`

`release` now walks only legal edges and always presents a manifest:

- `ACTIVE` → no-op (idempotent).
- `FROZEN` → refused with `cannot release from FROZEN; run "reconcile" first`
  (the machine has no `FROZEN → ACTIVE` edge on purpose).
- `DRAINING` → `FREEZE_REQUESTED` (abandon the drain), then release.
- `FAILED` → `RECOVERY_REQUIRED` → `FREEZE_REQUESTED`, then release.
- `RECOVERY_REQUIRED` → `FREEZE_REQUESTED`, then release.
- `FREEZE_REQUESTED` / `RECONCILING` → `ACTIVE` with reconciliation evidence.

### Reconciliation manifest

`buildReconciliationManifest()` hashes the **real** evidence read inside the same
transaction that performs the release:

- unfinished rows in `in_flight_writes` for the tenant, and
- `storage_write_arms` still needing external verification
  (`listStorageWriteArmsForReconciliation`).

```
manifestSha256 = sha256(canonical-json({
  tenantId, freezeState, freezeVersion, migrationId,
  inFlightWrites: [...], unresolvedArms: [...]
}))
```

A constant hash would have been fabricated evidence; the state machine's
`FREEZE_RECONCILIATION_MISSING` / `FREEZE_RECONCILIATION_INVALID` checks exist
precisely to prevent "we forgot to check" releases. On the normal test path both
lists are empty and the manifest records that; if work is outstanding, the hash
names exactly what was released against.

### `freeze-control.ts`

Container default corrected to the stack that actually serves the public test
domain (see the deployment report): `beaconhs-phase-aj-worker-1`. The helper's
`reconcile → release` sequence is unchanged and now matches the driver.

## Gating and tenant scoping (unchanged, re-verified)

- `TEST_ONLY_DRIVER = true` compile-time flag retained; the process exits if it is
  ever false.
- All operations are hard-scoped to `TEST_TENANT_ID`
  (`ea5a149b-ea76-48e0-abbe-fa360f520d8e`), overridable only through
  `E2E_TEST_TENANT_ID`.
- Every write goes through `withSuperAdmin(...)` → `applyTransition`
  (compare-and-set on `(id, version, state)`), which writes the audit row. The
  driver never issues ad-hoc SQL and never writes freeze state directly.

## Verification

```
$ pnpm --filter @beaconhs/worker test bt-freeze-driver.test.ts
Test Files  1 passed (1)
     Tests  8 passed (8)

$ pnpm --filter @beaconhs/worker typecheck   → exit 0

$ docker exec beaconhs-phase-aj-worker-1 .../tsx .../bt-freeze-driver.ts status
state=FROZEN version=3 ... lastReason=bt-freeze-driver: manual freeze
$ ... reconcile → state=RECONCILING version=4
$ ... release   → state=ACTIVE version=5 reconciliationManifestSha256=0183a995ca5e85fbd18de51a8bba1f34e580eb7115edf0bfe51b6a3f45fa2b60
$ ... status    → state=ACTIVE version=5 migrationId=null leaseHolderId=null leaseExpiresAt=null
$ ... release   → state=ACTIVE version=5 error=already_active   (idempotent)
```

## Status

| Item                                                   | Result     |
| ------------------------------------------------------ | ---------- |
| `reconcile` accepted and drives `FROZEN → RECONCILING` | PASS       |
| `release` supplies a real reconciliation manifest      | PASS       |
| `FROZEN → ACTIVE` still refused                        | PASS       |
| Release idempotent from `ACTIVE`                       | PASS       |
| Compile-time gate and tenant scoping intact            | PASS       |
| Unit tests                                             | PASS (8/8) |
| Typecheck                                              | PASS       |
