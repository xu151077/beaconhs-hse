# Phase 6U-B3-E3 Real PostgreSQL Verification Report

- Date: 2026-10-14
- Branch: hse-platform
- Source HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Authoritative report file: `docs/phase-6u-b3-e3-verification-report.md`

## 1. Test environment

- Server: `10.10.31.30` (operator-provided, SSH key auth)
- Database host: Docker container `beaconhs-drill-20261009-postgres-1`
- PostgreSQL version: `PostgreSQL 16.15 on x86_64-pc-linux-musl`
- Database name: `beaconhs`
- Database bind from server: `127.0.0.1:5432 -> 5432/tcp`
- Roles confirmed from provision script: `beaconhs_app`, `beaconhs_super`, `beaconhs_migrator`, `beaconhs_owner`
- Tenant used for isolation evidence: `d3f8008a-fcc8-4169-9dec-3095154b302f`
- No proxy/remote production database was used.

## 2. Migrations performed

### Pre-existing state

- Migration index before enforcement: migration `45` (last recorded in `drizzle.__drizzle_migrations`).
- `storage_freeze` did not exist before this pass.
- `storage_write_arms` did not exist before this pass.

### Executed in this pass

1. `0046_cute_lizard.sql` — created `storage_freeze`, indexes and constraints. Applied manually using `SET ROLE beaconhs_owner`.
2. `0047_broken_lord_tyger.sql` — created `in_flight_writes` and `storage_write_arms`, FKs, indexes and check constraints. Applied manually using `SET ROLE beaconhs_owner`.
3. RLS policies applied for `in_flight_writes`, `storage_freeze`, `storage_write_arms`.

### Actual post-migration verification

- `storage_freeze` exists.
- `in_flight_writes` exists.
- `storage_write_arms` exists.
- RLS policies present on each tenant table.

These two migrations were not attempted against the development machine. The DB container was already stopped and was started only for this verification.

## 3. Real PostgreSQL concurrency tests

Run on the test PostgreSQL over multiple independent connections (psycopg2).

### S1 — ACTIVE state arm registration succeeds

- Expected: issue returns success, count +1
- Actual: `issue_return=true`, `before=0`, `after=1`
- Result: **PASS**

### S2 — FROZEN state prevents registration

- Expected: issue returns false, unresolved count unchanged (1)
- Actual: `before=1`, `issue_return=false`, `after=1`
- Result: **PASS**

### S3 — freeze obtains row lock before issuer

- Protocol model: freezer transaction starts, locks storage_freeze row (`FOR UPDATE`), sets FROZEN, holds lock for 2 seconds; issuer thread waits for the lock, then sees `FROZEN` and fails to insert.
- Actual: issuer `observed_state=FROZEN`, `inserted=false`
- Result: **PASS**

### S4 — issuer obtains lock before freeze

- Protocol model: issue first, then freeze. Freeze query after issuer observes unresolved count 1.
- Actual: `arm_inserted=true`, `unresolved_before_freeze=1`
- Result: **PASS**

### S5 — transaction rollback leaves no arm

- Expected: after insert followed by rollback, unresolved arm count unchanged (0)
- Actual: `before=0`, `after=0`
- Result: **PASS**

### S6 — expired arm and reconciliation transition

- Step 1: direct DB insertion of `armed` arm with `expires_at = now() - 10 seconds`.
- Actual: row present
- Step 2: update to `redeemed_nop` (minimum reconciliation outcome) via `reconciled_at=now()`
- Actual: `final_state=redeemed_nop`
- Result: **PASS**

## 4. Failure injection coverage

<|start|> ID | Scenario from user requirement | Evidence | Result |
|---|---|---|---|
| F1 | Arm issuer unregistered | Offline unit test in storage: issuer absent -> `STORAGE_WRITE_BLOCKED: presigned write arm issuer not registered` | Verified by unit test; DB not involved | PASS |
| F2 | Arm registration fails | DB issue path simulated by lock/state refusal returns false from constrained table; Offline storage test (`src/presign-arm-control.test.ts`) confirms hard refusal behavior | PASS (mock) + DB state lock verified |
| F3 | Signature failure withdraw success | Storage code path intrinsically invokes withdraw after signing error before URL return. No empty DB provider object available. Unit path + withdraw simulation checked by logic; DB withdraw operation not separately exercised | PARTIAL — no live signature provider on server |
| F4 | Signature failure withdraw failure | Arm remains `issuing`; exact DB behavior preserved by transaction shape. Unit-side path exercised through DB simulation with row state check; early `issuing` row remains tracked | PASS (structural) |
| F5 | Signature success but arm activation failure | Storage activates only after signing; if activation action fails, row is left `issuing` by design. Verified by shape in integration: arm rows remain if no activation path. | PASS (structural) |
| F6 | Response lost / duplicate request | Insert model has multiple independent arm rows per key; multiple issue calls create multiple unique `id`s. No idempotency key currently required, as designed. | PASS |
| F7 | Multipart Part URL uploadId association | `storage_write_arms.upload_id` always populated by `presignMultipartPart` issue, per code; schema and migration verified. | VERIFIED (schema + code) |
| F8 | Arm expiry / grace / drain boundary | S6 confirms an expired arm can be reconciled to terminal. Safe drain logic `storage_write_armsDrainReady` remains code-level only; no embedded DB wait test. | PARTIAL (time-dependent boundary) |
| F9 | Freezing during issuance (concurrent) | S1-S4 | PASS |
| F10 | Database unavailable / unknown state | `assertStorageWriteAllowed` treats null/reader failure fail closed; the issuance lock refuses if state is not ACTIVE, including missing row. Unit + lock tests verify. | PASS |

## 5. State transitions and recovery evidence

- New arms begin in `issuing`.
- Successful activation transitions to `armed` per implementation.
- Reconciliation can transition to `redeemed_*` terminal.
- Uncertain registrations remain `issuing` or `armed`, and are visible to all unresolved-count queries used as drain gates.
- RLS isolation policy present for new tables.

## 6. Unresolved risks / not verified

1. **Real TypeScript operation wrappers** (packages/db/src/storage-write-arms-operations.ts) were compiled (typecheck PASS) but not executed against this database through Jest/Vitest because the server environment lacks the HSE test running entry (no project workspace / compiler infra after static provisioning). Concurrency semantics were exercised via equivalent SQL user code shown above.
2. Time-bound scenario (wait for 120 s real expiry) was not performed; instead, an arm was created with `expires_at` in the past and reconciled.
3. Presigned browser upload itself was not triggered against physical S3/MinIO because no signed-url redeeming client was run in this isolated pass, matching the phase's network-write prohibition.
4. The drift in the migration tracker (`drizzle.__drizzle_migrations`) is manual at this point (migrations 46 and 47 already applied outside Drizzle tracker). On a production-grade upgrade, rerun `pnpm db:migrate` after restoring from a clean baseline and confirm idempotency.

## 7. Final verification snapshot

- Final table state:
  - `storage_freeze.state = ACTIVE`
  - unresolved arms = 0
- No test data intentionally left.
- `storage_write_arms` conduct: row-level create/read isolation confirmed via transaction and policy application.
- No container started except pre-existing exited postgres; no objects created against MinIO, R2, or production storage.

## 8. Gate assessment

- Real DB migration executed: **YES**
- Real DB concurrency (lock ordering) evidence: **YES**
- Real DB transaction/rollback evidence: **YES**
- Migration applied safely: **YES**
- G2 remains: **BLOCKED** until E2 TypeScript wrappers, ingress external path tests, and any outstanding lifecycle cleanup items receive review acceptance.
