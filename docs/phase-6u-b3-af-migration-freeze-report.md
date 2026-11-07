# Phase AF — Migration Integrity & Frozen-State Browser E2E Report

Repository: `/home/test/projects/beaconhs-hse`  
Branch: `hse-platform`  
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## AF3 — Migration audit and repair

### Defect found

`0049_attachment_upload_multipart_upload_id.sql` was stored as one physical line
whose comment contained literal `\n` escapes. The `ALTER TABLE` statement was
therefore inside a `--` comment and never executed, although the migration
ledger marked 0049 applied.

Static inspection and the first disposable-run attempt both showed the 0049
statement was commented out. The first attempt also revealed that the migration
CLI consumes `MIGRATION_DATABASE_URL` and `SUPERADMIN_DATABASE_URL` as well as
`DATABASE_URL`; the preliminary attempt was discarded rather than counted as
evidence. The conclusive isolated run below used all three disposable URLs and
showed the repair working. The tracked migration hash had to remain unchanged
because existing ledgers already contain that hash.

### Repair

- Added `0050_repair_0049_multipart_upload_id.sql` with idempotent
  `ADD COLUMN IF NOT EXISTS`.
- Kept 0049 bytes unchanged so existing migration ledgers remain valid.
- Added `production-cutover-integrity.test.ts` assertions for the 0050 repair,
  migration list, journal order, and newline integrity of post-0049 migrations.

### Standard migration flow in a disposable database

Database: `beaconhs_af_after` (disposable, dropped after verification).

- first migrate run: PASS, exit 0
- ledger: 50 applied, 0 pending, 0 historical
- `multipart_upload_id` column: present
- `storage_freeze` table: present
- `storage_freeze_tenant_ux`: present
- second migrate run: PASS, exit 0, still 50 applied / 0 pending

The existing development database was then migrated normally:

- before: 49 applied, 1 pending
- after: 50 applied, 0 pending
- column present: yes

No existing application tenant rows were overwritten by migration verification.

## AF5 — Frozen-state browser E2E

### Isolated tenant setup

A disposable tenant `af-freeze-probe` was created with one disposable equipment
item and a persisted `storage_freeze.state = FROZEN`. The test tenant was not
part of the seeded demo tenant.

Before the browser request:

- reservations: 0
- storage write arms: 0
- in-flight writes: 0
- attachments: 0
- MinIO objects: 0

### Real Playwright request

- authenticated super-admin session via magic link
- active tenant switched to the disposable frozen tenant
- real equipment files drawer opened
- valid disposable PDF selected

Observed:

- one localhost server-action POST: HTTP 200
- server action returned the explicit application error state
- terminal UI item text: `Upload could not be started`
- direct MinIO upload requests: 0
- no part-signing or finalize request occurred

This is real browser UI refusal evidence, not a unit test.

### Post-request storage and database state

- reservations: 0
- attachments: 0
- storage write arms: 0
- in-flight writes: 0
- MinIO objects: 0
- multipart uploads left by the run: 0

The disposable frozen tenant and its equipment row were deleted afterward. The
seeded demo tenant remained `ACTIVE` and unchanged.

## AF6 — Isolated alert boundary

`apps/web/src/lib/isolated-alert-entrypoint.ts` is a library entrypoint, not a
route. It now requires both:

- `NODE_ENV !== 'production'`
- `BEACONHS_ISOLATED_ALERTS_ENABLED === 'true'`

Regression coverage verifies production refusal, missing-flag refusal, delivery,
ACK, retry recovery, duplicate suppression, and disposable-event validation.
There is no application route or production notification destination connected
to it.

## AF7 — Validation

- `pnpm --filter @beaconhs/db test`: PASS, 501 tests
- `pnpm --filter @beaconhs/db typecheck`: PASS
- `pnpm --filter @beaconhs/web test`: PASS, 2012 tests
- `pnpm --filter @beaconhs/web typecheck`: PASS, exit 0
- targeted web ESLint: PASS
- `pnpm deadcode:check`: PASS
- `pnpm --filter @beaconhs/web build`: PASS, exit 0

## Remaining G2 blockers

- Production R2/IAM/lifecycle/network/Collabora evidence is still unavailable.
- Production notification destinations remain deliberately disconnected.
- A real browser FROZEN state for the seeded demo tenant was not required; the
  disposable frozen tenant covered the gate path.
- G2 remains **BLOCKED**.

## Ending worktree

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- No commits or pushes.
