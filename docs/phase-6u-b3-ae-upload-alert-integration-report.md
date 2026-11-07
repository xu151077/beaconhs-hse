# Phase AE — Upload and Alert Integration Report

Repository: `/home/test/projects/beaconhs-hse`  
Branch: `hse-platform`  
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## AE1 — Upload-flow diagnosis and repair

### Root cause

Phase AD's upload stopped at `requestUpload()`. Server-side logs and the
Playwright terminal UI state identified three concrete causes:

1. The local database was missing
   `attachment_upload_reservations.multipart_upload_id`; the insert failed
   with Postgres `42703`.
2. `pnpm db:migrate` reported the ledger as current while that column was
   absent from the database. The isolated database required a direct additive
   column repair.
3. The demo tenant had no `storage_freeze` row, so the DB-backed freeze reader
   correctly failed closed with `STORAGE_FREEZE_STATE_UNKNOWN`.
4. The initial disposable fixture was a sparse `.pdf` whose bytes did not start
   with `%PDF-`; the real client-side type-validation correctly rejected it with
   "Document bytes do not match the declared file type".

### Repairs

- Added `ensureActiveStorageFreeze()` to `packages/db/src/seed.ts`. It inserts
  an `ACTIVE` row idempotently for both new and already-existing demo tenants.
- Added a structural seed-contract test for that invariant.
- Repaired the isolated local database additively so the existing migration
  matched the checked-in schema.
- Created the disposable test PDFs with the correct PDF magic header.
- No upload limit, reservation, signing, freeze, write-arm, or authentication
  control was weakened.

## AE2 — Real browser upload and freeze/cleanup evidence

### 2 MiB single-upload UI flow

Through real Playwright + the real equipment files drawer:

- magic-link authentication: PASS
- OS file selection: PASS
- request reservation action: HTTP 200
- direct MinIO PUT: HTTP 200
- finalize action: HTTP 200
- Save file action: HTTP 200
- terminal UI state: filename visible, `Files (1)` shown, drawer closed
- object size: 2,097,152 bytes
- object SHA-256:
  `b52f5d383f87ea99be8f03c520a901d23b6e71d8bb2084e5db8aab77af3be3f6`
- source SHA-256: identical

### 260 MiB browser multipart UI flow

Through the same authenticated UI, using a valid disposable PDF:

- threshold exceeded: 272,629,760 bytes
- five direct MinIO multipart PUTs observed: all HTTP 200
- localhost reservation/part-signing/finalize actions: all HTTP 200
- total captured requests: 97; failures: 0
- terminal UI state: filename visible, `Files (2)` shown, drawer closed
- object size: 272,629,760 bytes
- object SHA-256:
  `ed77d42705e7bef42723f087da648ae40fd8041d20aacc6478da9d7d8376dc29`
- source SHA-256: identical

This is actual browser-driven UI evidence, separate from the earlier 260 MiB
service-level integration.

### Freeze, write-arm and in-flight state

- Browser runs were performed with the DB-backed gate `ACTIVE`.
- In-flight write rows after successful browser uploads: 0 pending.
- Write arms were issued by the real DB-backed issuer.
- The frozen-refusal path is already covered by the real-MinIO AC/AB tests; a
  browser run with a production-persisted FROZEN tenant was **NOT RUN**.

### Cleanup

The run created six test attachments, seven upload reservations, and six local
objects (including intermediate retry attempts). Only those resources were
removed.

Post-cleanup verification:

- attachments matching the disposable filename: 0
- upload reservations matching the disposable filename: 0
- MinIO objects matching the disposable filename: 0
- unintended multipart uploads left by this run: 0
- pending in-flight writes: 0

## AE3 — Isolated alert application entrypoint

### Chain

`emitIsolatedAlertApplicationEvent()` (application library entrypoint) →
`dispatchIsolatedAlert()` → isolated in-memory receiver → ACK.

### Changes

- Added `apps/web/src/lib/isolated-alert-entrypoint.ts`.
- Added `apps/web/src/lib/isolated-alert-entrypoint.test.ts`.
- Added the dispatcher export from `@beaconhs/events`.

### Verified behavior

- disposable event required
- delivery + ACK
- transient failure + retry recovery
- duplicate application event suppression
- cleanup via receiver reset

Production email, SMS, webhook and notification destinations remain
disconnected. There is still no production-domain producer; this is an isolated
application entrypoint, not a durable notification system.

## AE4 — Commands and exit codes

| Command                                                                 | Result          |
| ----------------------------------------------------------------------- | --------------- |
| `pnpm --filter @beaconhs/web test -- isolated-alert-entrypoint.test.ts` | PASS, 3 tests   |
| `pnpm --filter @beaconhs/web typecheck`                                 | PASS            |
| `pnpm --filter @beaconhs/db typecheck`                                  | PASS            |
| `pnpm --filter @beaconhs/db test`                                       | PASS, 499 tests |
| `pnpm --filter @beaconhs/events test`                                   | PASS, 34 tests  |
| `pnpm --filter @beaconhs/storage test`                                  | PASS, 147 tests |
| `pnpm --filter @beaconhs/web build`                                     | PASS, exit 0    |
| targeted web ESLint                                                     | PASS, exit 0    |
| `pnpm deadcode:check`                                                   | PASS            |

## Remaining G2 blockers

- Browser evidence used isolated MinIO, not production R2.
- Production IAM, lifecycle, network, and Collabora/WOPI remain unverified.
- A DB-persisted FROZEN browser upload was not run; refusal is covered only at
  service level.
- The local migration ledger/database drift observed above should be addressed
  before relying on `pnpm db:migrate` for schema repair.

G2 remains **BLOCKED**.

## Worktree

- No reset, clean, restore, stage, commit, or push was performed.
- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
