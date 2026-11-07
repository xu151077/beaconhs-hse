# Phase 6U-B3-CS — Drill stack isolation and schema drift

Date: 2026-10-19
Host: `10.10.31.30` (`beaconhs-drill`)
Drill project: `beaconhs-drill-20261009`
Reference project: `beaconhs-phase-aj`

Status: **Inventory and impact assessment complete. The drill stack is
network/volume/database isolated from phase-aj, but it is not idle: its worker
is still running the 13 scheduled ticks and failing upload reconciliation against
a database five migrations behind. Its `APP_URL`/`BETTER_AUTH_URL` are identical
to phase-aj, which is a latent wrong-link/wrong-callback risk. Nothing was
stopped, modified or deleted.**

## 1. What was verified

This phase was read-only on the remote host. It checked:

- Compose project, network, volume, database and port separation;
- container and image identity, including the shared image tag;
- `APP_URL`/`BETTER_AUTH_URL`/`COLLABORA_URL`/`R2_ENDPOINT` values;
- the exact schema difference behind the worker error loop;
- current queue and mail state;
- the smallest reversible operational options.

No drill container, image, network, volume or database was stopped, recreated or
deleted. The only Redis used for the scheduler tests in this phase was a
disposable local container, not the drill Redis.

## 2. Isolation matrix

| Resource        | `beaconhs-phase-aj`                            | `beaconhs-drill-20261009`                    | Shared?               |
| --------------- | ---------------------------------------------- | -------------------------------------------- | --------------------- |
| Compose project | `beaconhs-phase-aj`                            | `beaconhs-drill-20261009`                    | No                    |
| Network         | `beaconhs-phase-aj_default`                    | `beaconhs-drill-20261009_default`            | No                    |
| Web port        | `127.0.0.1:3010`                               | `127.0.0.1:3001`                             | No                    |
| Postgres        | its own container and `phase-aj_postgres-data` | its own container and `drill…_postgres-data` | No                    |
| Redis           | its own container and `phase-aj_redis-data`    | its own container and `drill…_redis-data`    | No                    |
| MinIO           | its own container and `phase-aj_minio-data`    | its own container and `drill…_minio-data`    | No                    |
| Mailpit         | its own container                              | its own container                            | No                    |
| Database        | `beaconhs`, phase-aj tenants                   | `beaconhs`, drill tenants                    | No                    |
| Domain target   | `https://beaconhs-test.xuhaoqing.top`          | none observed; web bound to `127.0.0.1:3001` | **URL values shared** |
| Image tag       | `beaconhs:phase-cq-20261019-driver`            | `beaconhs:drill-20261018-202804`             | **Same image ID**     |

Network membership:

```text
phase-aj: beaconhs-phase-aj-collabora-1 beaconhs-phase-aj-minio-1
          beaconhs-phase-aj-web-1 beaconhs-phase-aj-redis-1
          beaconhs-phase-aj-mailpit-1 beaconhs-phase-aj-worker-1
          beaconhs-phase-aj-postgres-1
drill:    beaconhs-drill-20261009-redis-1 beaconhs-drill-20261009-collabora-1
          beaconhs-drill-20261009-postgres-1 beaconhs-drill-20261009-web-1
          beaconhs-drill-20261009-worker-1 beaconhs-drill-20261009-minio-1
          beaconhs-drill-20261009-mailpit-1
```

There is no container in both networks. The phase-aj and drill MinIO containers
happen to use the same pinned MinIO image from the local registry, but they have
separate volumes and separate networks.

Database contents:

```text
phase-aj:  Phase AJ Test Tenant
           Phase BB Isolated Freeze Tenant 1792133778134
drill:     Drill Construction
           Test Tenant
```

## 3. Image and container identity

```text
beaconhs-phase-aj-web-1       running  image=beaconhs:phase-cq-20261019-driver  id=60dc4841…
beaconhs-phase-aj-worker-1    running  image=beaconhs:phase-cq-20261019-driver  id=60dc4841…
beaconhs-phase-aj-scheduler-1 exited 0 image=beaconhs:phase-cq-20261019-driver  id=60dc4841…
beaconhs-drill-web-1          running  image=beaconhs:drill-20261018-202804    id=60dc4841…
beaconhs-drill-worker-1       running  image=beaconhs:drill-20261018-202804    id=60dc4841…
beaconhs-drill-scheduler-1    exited 0 image=beaconhs:drill-20261018-202804    id=49d64ba0…
```

The drill web/worker tag resolves to the same image ID as the phase-aj stack
(`sha256:60dc4841…`). The tag therefore no longer identifies the build. The drill
scheduler and storage-init are exited and still reference the older
`49d64ba0…` image.

The unmanaged `beaconhs-drill-registry` container is still running on the
default bridge with `registry:2`; it is not part of either Compose project.

## 4. Schema drift and the error loop

### 4.1 Migration gap

```text
phase-aj  drizzle.__drizzle_migrations: 50 applied
drill     drizzle.__drizzle_migrations: 45 applied
```

The drill database is missing migrations **0046–0050**:

| Migration                                        | Purpose                                                  |
| ------------------------------------------------ | -------------------------------------------------------- |
| `0046_cute_lizard.sql`                           | storage write-freeze state model                         |
| `0047_broken_lord_tyger.sql`                     | storage write arms / in-flight writes                    |
| `0048_storage_freeze_tenant_unique.sql`          | one freeze row per tenant                                |
| `0049_attachment_upload_multipart_upload_id.sql` | add `attachment_upload_reservations.multipart_upload_id` |
| `0050_repair_0049_multipart_upload_id.sql`       | idempotent repair for the literal `\n` defect in 0049    |

The column check is decisive:

```text
phase-aj  attachment_upload_reservations.multipart_upload_id  text  nullable
drill     (0 rows) — column absent
```

`packages/db/drizzle/0049_attachment_upload_multipart_upload_id.sql` was written
with literal `\n` sequences in its comment header, so fresh databases could mark
0049 applied without creating the column. Migration 0050 repairs that
idempotently. Phase-aj has both 0049 and 0050; drill has neither.

### 4.2 Runtime symptom

The drill worker is executing scheduled ticks and failing the upload reconciler:

```text
phase-aj worker reconciliation errors (last 15m): 0
drill    worker reconciliation errors (last 15m): 45
```

The latest failed scheduled jobs are all `tick-storage-object-deletion`
occurrences with `Expired upload reconciliation had 1 error(s)`. The drill
`scheduled` failed set contained **1,722** entries at inspection time (it was
1,710 in Phase CR, so the loop is still growing). Waiting and active counts are
0 for all checked queues; emails, notifications, PDFs and reports have 0 failed
jobs. The failure is confined to the drill database/worker; phase-aj has the
column and 0 corresponding errors.

The worker code selects the Drizzle schema for
`attachment_upload_reservations`, which includes `multipart_upload_id`
(`packages/db/src/schema/attachments.ts`), and logs the failure from
`apps/worker/src/lib/attachment-upload-reconciler.ts`. The database is older than
the running image; this is schema/image mismatch, not a transient network error.

### 4.3 Mail

Drill Mailpit: `total=0`, `unread=0`, `messages=0`. Phase-aj Mailpit was also
empty at the time of inspection. No wrong email delivery was observed.

## 5. Shared `APP_URL` / `BETTER_AUTH_URL` impact

The drill web and worker have the same public identity values as phase-aj:

```text
APP_URL=https://beaconhs-test.xuhaoqing.top
BETTER_AUTH_URL=https://beaconhs-test.xuhaoqing.top
BETTER_AUTH_TRUSTED_ORIGINS=https://beaconhs-test.xuhaoqing.top
```

The drill login response confirms the shared origin in its CSP:

```text
connect-src 'self' https://beaconhs-test.xuhaoqing.top ...
frame-src   'self' https://beaconhs-test.xuhaoqing.top ...
```

Code paths that consume these values:

- `apps/web/src/lib/app-base-url.ts` resolves `PUBLIC_APP_URL` / `APP_URL` /
  `NEXT_PUBLIC_APP_URL` for QR codes, emails, equipment labels and kiosk URLs.
- `packages/auth/src/server.ts` uses `BETTER_AUTH_URL` as Better Auth's
  `baseURL` for generated magic links and callbacks; trusted origins come from
  `BETTER_AUTH_TRUSTED_ORIGINS`.
- `apps/web/src/lib/collabora.ts` uses `COLLABORA_WOPI_URL` / `APP_URL` for WOPI
  callbacks.

### Assessment

- **Current wrong delivery observed:** none. The tunnel behaviourally serves
  phase-aj (tenant names and database contents match phase-aj); drill web is on
  `127.0.0.1:3001`; drill Mailpit has 0 messages; no established clients were
  observed on 3001.
- **Latent link/callback risk:** high. If anyone signs in to drill or asks it to
  generate a link, the link points at the phase-aj origin. A drill magic-link
  token belongs to the drill database but would be verified by phase-aj; it may
  fail or land the user in the wrong environment. A drill invitation/QR/email
  would carry the phase-aj origin.
- **Cookie scope:** a browser using `http://127.0.0.1:3001` gets a cookie for
  that host, not the public domain. The dangerous case is accessing drill through
  the public hostname or repointing the tunnel; in that case the same domain
  cookie can be presented to either stack, and only the separate database stops
  cross-tenant access.
- **Collabora/storage are broken in drill:** drill uses
  `COLLABORA_URL=http://127.0.0.1:3002` and
  `R2_ENDPOINT=http://127.0.0.1:3002`; no listener exists on 3002. This is
  consistent with the drill stack not being a working end-user environment.
- **Conclusion:** the shared URL is not currently causing observed email or
  browser misdelivery, but it is not safe to treat the drill stack as an
  independent environment while it shares the public identity. Do not repoint
  the tunnel to 3001 without changing these values first.

## 6. Reversible options (none executed)

The stack was not stopped or changed. If the owner decides to act:

### Option A — keep running

No change. Continues to use about 688 MiB RAM and to produce about 45
reconciliation errors per 15 minutes, and the failed set keeps growing until its
7-day retention trims it.

### Option B — stop only the drill worker

```bash
docker stop beaconhs-drill-20261009-worker-1
```

Stops the scheduled error loop and frees the worker's memory. The web on 3001
and all data remain; `docker start beaconhs-drill-20261009-worker-1` reverses it.
This does not fix the schema drift.

### Option C — stop the whole drill stack

```bash
cd /home/ceshi/beaconhs-phase-aj/deploy
docker compose -f drill-20261009.compose.yaml \
  --project-name beaconhs-drill-20261009 \
  --env-file /home/ceshi/beaconhs-phase-aj/.env \
  stop
```

This stops the seven running containers. Containers, networks, volumes and data
remain; `docker compose start` with the same arguments reverses it. Do **not**
use `down -v`, remove volumes, prune images, or delete the drill database.

### Option D — repair before restarting

Requires explicit owner approval and a backup:

1. back up the drill PostgreSQL database/volume;
2. apply migrations 0046–0050 with the matching image;
3. rebuild/recreate the drill web/worker with an image whose schema matches the
   database;
4. change the drill `APP_URL`/`BETTER_AUTH_URL` to a drill-only origin;
5. point `COLLABORA_URL`/`R2_ENDPOINT` at reachable drill services;
6. verify upload reconciliation and a login link end to end.

This was **not executed**.

## 7. Status summary

| Check                                          | Result                            |
| ---------------------------------------------- | --------------------------------- |
| Network/volume/database/port isolation         | PASS                              |
| Shared `APP_URL` / callback / email assessment | PASS (latent risk recorded)       |
| Migration gap traced to 0049/0050              | PASS                              |
| Drill-only error loop quantified               | PASS                              |
| Phase-aj unaffected by drill schema drift      | PASS                              |
| Stop/repair executed                           | NOT RUN (owner approval required) |
| Resource deletion                              | NOT RUN                           |
