# Phase 6U-B3-CT — Drill environment assessment

Date: 2026-10-19
Repository: `/home/test/projects/beaconhs-hse`
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Remote host: `10.10.31.30`, SSH alias `beaconhs-drill`
Drill project: `beaconhs-drill-20261009`
Phase-aj project: `beaconhs-phase-aj`

Status: **READ-ONLY ASSESSMENT. The drill stack was not stopped, restarted,
rebuilt, migrated, cleaned, or deleted.** The drill worker is still failing
approximately once per minute. The drill schema is not simply five migrations
behind: its migration ledger says 45, while the physical schema already contains
the 0046/0047 objects and still lacks the 0048 unique index and the
`multipart_upload_id` column. A direct `db:migrate` would therefore try to re-run
0046 and fail. That drift must be reconciled before repair.

## 1. Identity and isolation

| Item            | Evidence                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| Compose project | `beaconhs-drill-20261009`                                                                                  |
| Compose file    | `/home/ceshi/beaconhs-phase-aj/deploy/drill-20261009.compose.yaml`                                         |
| Network         | `beaconhs-drill-20261009_default` (separate bridge)                                                        |
| Volumes         | `beaconhs-drill-20261009_postgres-data`, `_redis-data`, `_minio-data`, `_registry-data`                    |
| Database        | PostgreSQL container `beaconhs-drill-20261009-postgres-1`, database `beaconhs`, host port `127.0.0.1:5432` |
| Web             | `beaconhs-drill-20261009-web-1`, `127.0.0.1:3001->3000`, image `sha256:60dc4841…`                          |
| Worker          | `beaconhs-drill-20261009-worker-1`, no published port, same image digest                                   |
| Scheduler       | `beaconhs-drill-20261009-scheduler-1`, `Exited (0) 19 hours ago`                                           |
| Storage init    | `beaconhs-drill-20261009-storage-init-1`, `Exited (0) 19 hours ago`                                        |
| Redis           | `beaconhs-drill-20261009-redis-1`, `127.0.0.1:6379`                                                        |
| MinIO           | `beaconhs-drill-20261009-minio-1`, `127.0.0.1:9000`                                                        |
| Mailpit         | `beaconhs-drill-20261009-mailpit-1`, `127.0.0.1:8025/1025`                                                 |
| Collabora       | `beaconhs-drill-20261009-collabora-1`, `127.0.0.1:9980`                                                    |

Phase-aj is a separate Compose project with its own network, PostgreSQL, Redis
and MinIO volumes. No drill container, volume, image, network or database was
changed.

### 1.1 Which stack serves the public domain

This was verified behaviourally, not inferred from names:

- Phase-aj uses a separate database. The authenticated Playwright suites ran
  against `https://beaconhs-test.xuhaoqing.top` using a phase-aj session and
  passed (documents, Collabora, uploads, navigation).
- The freeze suites drove the phase-aj worker's real freeze state machine for
  tenant `ea5a149b-ea76-48e0-abbe-fa360f520d8e`; the public pages then showed the
  frozen refusal copy. The drill database was not involved.
- Drill web is published only on `127.0.0.1:3001`, not on the public domain.
- There is no listener on `127.0.0.1:3002`.

Therefore the public domain is the **phase-aj** stack. The drill web is a
loopback-only secondary stack.

### 1.2 Non-secret environment comparison

| Variable                      | Drill value                           | Assessment                                                      |
| ----------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `APP_URL`                     | `https://beaconhs-test.xuhaoqing.top` | Shared with phase-aj; drill links point at the wrong stack.     |
| `BETTER_AUTH_URL`             | `https://beaconhs-test.xuhaoqing.top` | Same; auth callbacks/magic links can target phase-aj.           |
| `BETTER_AUTH_TRUSTED_ORIGINS` | derived from the same public URL      | Same cross-stack risk.                                          |
| `COLLABORA_URL`               | `http://127.0.0.1:3002`               | No listener on 3002; drill Collabora is on `collabora:9980`.    |
| `R2_ENDPOINT`                 | `http://127.0.0.1:3002`               | No listener on 3002; browser-facing presigned URLs cannot work. |
| `R2_INTERNAL_ENDPOINT`        | `http://minio:9000`                   | Correct internal MinIO endpoint.                                |
| `R2_BUCKET`                   | `beaconhs-drill`                      | Isolated bucket name.                                           |
| `COLLABORA_WOPI_URL`          | `http://web:3000`                     | Correct in-network WOPI callback.                               |
| Drill Mailpit                 | 0 messages at inspection              | No wrong delivery observed, but the latent link risk remains.   |

Secrets (`DATABASE_URL`, `BETTER_AUTH_SECRET`, MinIO credentials, etc.) were not
read or printed. Only their presence and the non-secret values above were
checked.

## 2. Migration and schema drift

### 2.1 Ledger

```text
phase-aj: 50 migration rows, max created_at 1792049376543 (0050)
drill:    45 migration rows, max created_at 1791247223846 (0045)
```

The drill ledger stops at 0045. Migration hashes are SHA-256 of the migration
SQL; the ledger hash for 0045 matches the file hash exactly.

### 2.2 Physical schema is not the same as the ledger

The drill database already has:

- `storage_freeze`, `storage_write_arms`, `in_flight_writes`
- the `storage_freeze_state`, `storage_write_arm_operation` and
  `storage_write_arm_state` enums
- the 0046/0047 indexes and constraints
- RLS `tenant_isolation` policies and forced RLS on those tables

But the drill database still lacks:

- the **UNIQUE** `storage_freeze_tenant_ux` index from 0048; it currently has the
  non-unique index from 0046;
- `attachment_upload_reservations.multipart_upload_id` from 0049/0050.

The 0046/0047 objects were therefore applied by some path that did not record
the ledger rows (manual DDL, an earlier push, or an interrupted migration). The
exact path is not proven. The important fact is that **the ledger and physical
schema disagree**.

### 2.3 Consequence for a normal migration

`drizzle-orm` reads `meta/_journal.json` and starts after the last recorded
`created_at`. With the drill ledger at 0045, it will try to apply 0046 next.
0046 begins with unguarded `CREATE TYPE`/`CREATE TABLE` statements. Because those
objects already exist, a direct `pnpm db:migrate` would fail at 0046, not proceed
cleanly to 0049/0050.

A repair must first reconcile the ledger with the verified 0046/0047 physical
schema, or explicitly apply the missing 0048/0050 changes and record them. It
must not simply run `pnpm db:migrate` against this database.

### 2.4 The 0049 defect

`0049_attachment_upload_multipart_upload_id.sql` contains 21 literal backslash-n
sequences and **zero real newlines**. The entire file is therefore a SQL line
comment; its `ALTER TABLE ... ADD COLUMN` is never parsed. `0050` is the additive,
idempotent repair:

```sql
ALTER TABLE "attachment_upload_reservations"
  ADD COLUMN IF NOT EXISTS "multipart_upload_id" text;
```

Phase-aj has the column and the 50-row ledger. Drill has neither.

### 2.5 Data risk and preconditions

- 0048 is a unique-index change on a small table. Drill has **2** rows in
  `storage_freeze`, one per distinct tenant; the migration's duplicate pre-check
  would pass. It still takes a share lock for the build.
- 0049/0050 are additive nullable-column changes; no data rewrite.
- 0046/0047 are already present in drill; re-running them is what fails.
- `storage_write_arms` and `in_flight_writes` are empty in drill (0 rows).
  `storage_freeze` has 2 ACTIVE rows. `attachment_upload_reservations` is empty.
- A full `pg_dump` backup and a tested restore path are required before any
  ledger/DDL repair.
- The repair should run with the worker stopped, so no scheduled tick attempts a
  query against a half-migrated schema.

## 3. Failure analysis

### 3.1 Current snapshot (2026-10-19T15:48:15+08:00)

```text
bull:scheduled:failed zcard = 1813
multipart_upload_id log lines, last 15m = 45
Expired upload reconciliation failures, last 15m = 45
```

The failed set is still growing at approximately one job per minute.

### 3.2 Failure reasons

| Reason                                                     | Count (snapshot) | Observed window                           |
| ---------------------------------------------------------- | ---------------: | ----------------------------------------- |
| `password authentication failed for user "beaconhs_super"` |              240 | 2026-10-18 20:39:30 → 21:17:30            |
| `password authentication failed for user "beaconhs_app"`   |              577 | 2026-10-18 21:18:30 → 2026-10-19 08:38:30 |
| `Expired upload reconciliation had 1 error(s)`             |              997 | 2026-10-18 21:18:30 → 2026-10-19 15:48:30 |

The counts are a live snapshot; the set grew by one between the aggregate and
the cardinality query. The earliest failures were **credential failures**, not
the missing column. The credential failures stopped; the current recurring
failure is the upload reconciliation query.

### 3.3 Failure types

| Job name                       | Count | First (Asia/Shanghai) | Last (Asia/Shanghai) |
| ------------------------------ | ----: | --------------------- | -------------------- |
| `tick:storage_object_deletion` |  1035 | 2026-10-18 20:39:30   | 2026-10-19 15:48:30  |
| `tick:scheduled_flow`          |   605 | 2026-10-18 20:39:30   | 2026-10-19 08:38:30  |
| `tick:form_session`            |    38 | 2026-10-18 20:39:30   | 2026-10-18 21:17:30  |
| `tick:compliance_scan`         |    38 | 2026-10-18 20:39:30   | 2026-10-18 21:17:30  |
| `tick:domain_event_outbox`     |    38 | 2026-10-18 20:39:30   | 2026-10-18 21:17:30  |
| `tick:storage_write_arms`      |    30 | 2026-10-18 20:48:30   | 2026-10-18 21:17:30  |
| `tick:digest`                  |    11 | 2026-10-18 21:05:30   | 2026-10-19 05:25:30  |
| `tick:reports`                 |     8 | 2026-10-18 20:40:30   | 2026-10-18 21:15:30  |
| `tick:office_render_reconcile` |     8 | 2026-10-18 20:40:30   | 2026-10-18 21:15:30  |
| `tick:sync_scan`               |     3 | 2026-10-18 20:45:30   | 2026-10-18 21:15:30  |

All failing jobs had `atm=3`, exponential backoff with a 10 s delay, and
`removeOnFail` age 604800 s (7 days). The queue state at inspection was:

```text
repeat=13  wait=0  active=0  delayed=14  completed=4827  failed=1813
```

Only `bull:scheduled:failed` existed among `bull:*:failed` keys. Other queues had
no failed set at inspection.

### 3.4 Causal link, not just timing

The current recurring failure is directly explained by the missing column:

1. The worker's `storage_object_deletion_scan` tick calls
   `reconcileExpiredAttachmentUploads()`.
2. The reconciler does `tx.select().from(attachmentUploadReservations)`, which
   expands the Drizzle schema to an explicit select list including
   `"multipart_upload_id"`.
3. Drill's `attachment_upload_reservations` has no such column, so PostgreSQL
   rejects the statement even when the table has zero rows.
4. Phase-aj has the column and had **0** matching errors in the last 15 minutes.

The worker log shows the exact select list and the scheduled failure:

```text
[uploads] expired reservation reconciliation failed {
  error: 'Failed query: select ..., "multipart_upload_id", ... from "attachment_upload_reservations" ...'
}
✗ scheduled#repeat:tick-storage-object-deletion:...:
  Expired upload reconciliation had 1 error(s)
```

This is a schema/query mismatch, not a time-correlation guess. The earlier
credential failures are a separate cause and are not attributed to the missing
column.

Phase-aj is not failure-free historically: its `bull:scheduled:failed` set has
270 old jobs, including 163 `Expired upload reconciliation` failures that last
occurred around 2026-10-19 11:35. It has **0** such log lines in the last 15
minutes. The contrast is current-loop versus historical residual, not "phase-aj
has never failed".

## 4. Disposition options — none executed

### Option 1 — stop only the drill worker

**Scope:** `docker stop beaconhs-drill-20261009-worker-1`. Web, PostgreSQL,
Redis, MinIO, Mailpit, Collabora and the already-exited scheduler/storage-init
are untouched. The public phase-aj stack is unaffected.

**Effect:** stops the once-per-minute failed scheduled job and the 45
reconciliation errors per 15 minutes. The drill web stays up but has no worker.

**Risk:** scheduled work accumulates or remains delayed/failed; no drill
background processing. Old failed jobs remain in the 7-day failure window. No
data is deleted.

**Verification:** `docker ps` shows worker stopped; new failed-job count and
worker log lines stop growing; web on 3001 still responds.

**Recovery:** `docker start beaconhs-drill-20261009-worker-1`; the loop returns
until the schema is fixed.

**Prerequisite:** owner approval. Record container ID and image digest before
stopping.

### Option 2 — stop the whole drill stack

**Scope:** stop web, worker, PostgreSQL, Redis, MinIO, Mailpit and Collabora for
project `beaconhs-drill-20261009`. Volumes are preserved.

**Effect:** removes the error loop and frees the drill resources. Drill web on
`127.0.0.1:3001` becomes unavailable. Public phase-aj remains unaffected.

**Risk:** drill is unavailable for testing; a stopped database/Redis/MinIO must
be restarted cleanly. No data loss if volumes are preserved. Compose commands
need the original drill environment file; the current non-interactive shell does
not have the required `DRILL_*` values, so do not run a fresh `docker compose`
command without sourcing that environment.

**Verification:** all seven containers stopped; ports 3001/5432/6379/9000/8025/
1025/9980 closed; volumes still listed.

**Recovery:** start the same project with the original env file; verify web
health, worker logs and queue state.

**Prerequisite:** owner approval and a decision that the drill is not needed in
the short term.

### Option 3 — back up, reconcile the schema, fix drill-only configuration

**Scope:** backup, stop worker, reconcile the ledger/DDL, apply the missing
0048/0050 changes, verify, restart worker, then fix the drill-only URLs and
Collabora/storage endpoints if drill web is to be usable.

**Effect:** restores the current schema and stops the reconciliation failure. It
does not require a new application image because the running image already
expects the current schema.

**Risk:** the ledger/schema mismatch is the main hazard. A naive `db:migrate`
will fail at 0046. A controlled repair must:

1. take a verified `pg_dump` backup;
2. stop the worker;
3. verify the existing 0046/0047 objects match the migration definitions;
4. either backfill the 0046/0047 ledger rows with their real SHA-256 hashes and
   journal timestamps, then run the migrator for 0048–0050; or explicitly apply
   the verified 0048/0050 changes and record them;
5. apply 0048's duplicate pre-check (2 distinct tenants currently), then the
   unique index; apply 0050's additive column;
6. verify the ledger has 50 rows, the unique index exists, and the column exists;
7. restart the worker and verify no new `multipart_upload_id` or reconciliation
   failures;
8. separately change drill `APP_URL`/`BETTER_AUTH_URL` away from the phase-aj
   public origin and point `COLLABORA_URL`/`R2_ENDPOINT` at the drill services
   (not `127.0.0.1:3002`, which has no listener).

**Verification:** schema queries, `pnpm db:migrate` idempotence after the
ledger repair, worker logs for at least 15 minutes, queue failed-count stability,
web health, and a drill-only login/upload smoke test.

**Recovery:** restore the dump and the previous container image if the repair
fails. Keep the old failed set (7-day expiry) until reviewed; do not bulk-clean
it without approval.

**Prerequisite:** owner approval, maintenance window, backup storage, and the
original drill environment file. This option is a deployment/repair action and
was not executed.

## 5. Recommendation

1. **Immediate containment:** Option 1 (stop the drill worker) is the lowest-risk
   action that stops the error loop without touching the database, web, volumes
   or public phase-aj. It is reversible with `docker start`.
2. **Then repair:** Option 3 is required if the drill is to remain a usable test
   environment. It must start with a backup and ledger reconciliation; do not run
   a plain `db:migrate` against this drifted database.
3. **Option 2** is appropriate only if the drill is being decommissioned or is
   not needed for the next test cycle. It is not a schema repair.

No option was executed in Phase CT. The drill remains running and failing; the
public phase-aj stack remains unaffected.

## 6. Remote-change statement

Only read-only inspection was performed on the drill: `docker inspect`,
`docker ps`, `docker logs`, `redis-cli` queries, and PostgreSQL
`SELECT`/`information_schema` queries. No drill container was stopped,
restarted, recreated or deleted. No drill database row or schema was changed. No
drill queue was cleaned. No drill image, network, volume or registry object was
removed. No phase-aj deployment or configuration was changed. Separately, the
Phase CT E2E suite created isolated test-tenant documents/uploads and
transiently toggled that tenant's freeze state; it was restored to `ACTIVE` and
verified (see `phase-6u-b3-ct-e2e-regression.md`). No production or Cloudflare
Tunnel resource was changed.
