# Phase 6U-B3-CU — Drill containment and schema-repair preparation

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Scope: read-only drill inspection and containment planning only. No container, volume, network, database, schema, queue, tenant, or phase-aj resource was changed.

## 1. Drill worker identity

| Field               | Value                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| Compose project     | `beaconhs-drill-20261009`                                                 |
| Target worker       | `beaconhs-drill-20261009-worker-1`                                        |
| Container ID        | `bc5fef35aab9c6b9741e82c9a2adfd24a14108813b9606c3499f0b235ddc5bae`        |
| Image               | `beaconhs:drill-20261018-202804`                                          |
| Image digest        | `sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370` |
| Network             | `beaconhs-drill-20261009_default` (isolated from phase-aj)                |
| Published ports     | `3000/tcp` only (web is `127.0.0.1:3001`)                                 |
| State at inspection | `running`                                                                 |

The drill stack is isolated from `beaconhs-phase-aj`: separate Compose project, network (`b6f7ae40ac25` vs `66d2643c932f`), PostgreSQL data volume, Redis data volume, MinIO data volume, and image digest usage. The phase-aj web container uses a different image digest (`phase-cq-20261019-driver`) even though the underlying digest is the same base.

## 2. Read-only failure snapshot

| Metric                | Value     |
| --------------------- | --------- |
| Failed scheduled jobs | `1924`    |
| Delayed jobs          | `13`      |
| Waiting jobs          | `0`       |
| Active jobs           | `0`       |
| Repeat registrations  | `13`      |
| Completed jobs        | `5519`    |
| Worker state          | `running` |

Recurring failure classes recorded in Phase CT and unchanged in this pass:

- `beaconhs_super` authentication failures.
- `beaconhs_app` authentication failures.
- `Expired upload reconciliation had 1 error(s)`.
- Missing `multipart_upload_id` column in `attachment_uploads` (0049/0050 drift).

No stop, restart, rebuild, migrate, clean, or delete operation was performed.

## 3. Containment order (approval required before execution)

Execute only after explicit owner approval. Stop only the worker container; do not stop web, PostgreSQL, Redis, MinIO, Mailpit, Collabora, or any phase-aj service.

```bash
docker stop bc5fef35aab9c6b9741e82c9a2adfd24a14108813b9606c3499f0b235ddc5bae
```

Expected effect:

- All BullMQ consumers in the drill worker stop.
- New scheduled ticks are not consumed; existing delayed/waiting jobs remain in Redis.
- Failed-job growth stops.
- Drill web remains available on `127.0.0.1:3001`.
- PostgreSQL, Redis, MinIO, Mailpit, and Collabora remain running.
- phase-aj is untouched.

Paused capabilities:

- Background PDF rendering, email, notifications, push, scheduled reports, compliance scans, form-session overdue scans, storage-object deletion, storage-write-arm reconciliation, office rendering, domain-event outbox delivery, and any async import work.

Recovery command after approval and repair:

```bash
docker start bc5fef35aab9c6b9741e82c9a2adfd24a14108813b9606c3499f0b235ddc5bae
```

Do not use `docker compose stop` for containment; it would stop web, database, Redis, and storage.

## 4. Schema-repair preparation (not executed)

Drill migration ledger stops at `0045`; physical schema contains 0046/0047 objects but lacks the 0048 unique index and the 0049/0050 `multipart_upload_id` column.

Before any repair:

1. Back up the drill PostgreSQL database and MinIO volume.
2. Verify the backup by restore into an isolated database/volume.
3. Reconcile 0046/0047 ledger entries by evidence, not by manual ledger edits.
4. Verify 0048–0050 idempotency, constraints, and indexes.
5. Apply 0048–0050 in order.
6. Verify the unique index and `multipart_upload_id` column.
7. Repair drill-only `APP_URL`, `BETTER_AUTH_URL`, `COLLABORA_URL`, and `R2_ENDPOINT` values.
8. Restart only the worker and verify `--check`, worker health, and failed-job growth.

`pnpm db:migrate` must not be run directly against drill. Manual ledger edits are prohibited.

## 5. Approval status

Containment and schema repair remain **BLOCKED** pending explicit owner approval. No drill resource was changed during Phase CU.
