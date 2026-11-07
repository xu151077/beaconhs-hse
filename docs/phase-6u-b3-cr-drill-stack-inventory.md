# Phase 6U-B3-CR — Unused drill stack inventory and risk

Date: 2026-10-19
Host: `10.10.31.30` (isolated test host)
Stack under review: `beaconhs-drill-20261009`

Status: **Inventory complete. The stack is isolated from
`beaconhs-phase-aj` by Compose project, network, volumes, database and ports, but
it is not idle: its worker is running scheduled ticks and failing every minute
against a drifted schema. Nothing was stopped or deleted.**

## 1. Containers

```
$ docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' \
    | grep beaconhs-drill-20261009 | sort
beaconhs-drill-20261009-collabora-1     Up 16 hours (healthy)   4e983196eb98
beaconhs-drill-20261009-mailpit-1       Up 16 hours (healthy)   axllent/mailpit:latest
beaconhs-drill-20261009-minio-1         Up 16 hours (healthy)   127.0.0.1:5000/beaconhs-drill/minio:b187417eee0a-drill-20261009
beaconhs-drill-20261009-postgres-1      Up 16 hours (healthy)   postgres:16-alpine
beaconhs-drill-20261009-redis-1         Up 16 hours (healthy)   redis:7-alpine
beaconhs-drill-20261009-scheduler-1     Exited (0) 16 hours ago 49d64ba01ea8
beaconhs-drill-20261009-storage-init-1  Exited (0) 16 hours ago 49d64ba01ea8
beaconhs-drill-20261009-web-1           Up 4 hours (healthy)    beaconhs:drill-20261018-202804
beaconhs-drill-20261009-worker-1        Up 4 hours              beaconhs:drill-20261018-202804
```

Seven containers run; two one-shot containers exited 0.

## 2. Ports (all bound to loopback)

| Service   | Port mapping                    |
| --------- | ------------------------------- |
| web       | `127.0.0.1:3001 → 3000`         |
| postgres  | `127.0.0.1:5432 → 5432`         |
| redis     | `127.0.0.1:6379 → 6379`         |
| minio     | `127.0.0.1:9000 → 9000`         |
| mailpit   | `127.0.0.1:8025 → 8025`, `1025` |
| collabora | `127.0.0.1:9980 → 9980`         |

The phase-aj stack uses a different set (`3010`, `3011`, `3013`, `3014`,
`3016`, `3017`, `3015`). There is no port collision.

## 3. Volumes, network and database

| Resource        | Drill stack                                                                               | Phase-aj stack                                                      | Shared? |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------- |
| Network         | `beaconhs-drill-20261009_default`                                                         | `beaconhs-phase-aj_default`                                         | No      |
| Postgres volume | `beaconhs-drill-20261009_postgres-data` (185.5 MB)                                        | `beaconhs-phase-aj_postgres-data` (88.47 MB)                        | No      |
| Redis volume    | `beaconhs-drill-20261009_redis-data` (4.79 MB)                                            | `beaconhs-phase-aj_redis-data` (3.73 MB)                            | No      |
| MinIO volume    | `beaconhs-drill-20261009_minio-data` (71.35 kB)                                           | `beaconhs-phase-aj_minio-data` (6.378 GB)                           | No      |
| Registry volume | `beaconhs-drill-20261009_registry-data` (79.63 MB)                                        | —                                                                   | No      |
| Database        | `beaconhs-phase-aj/deploy/drill-20261009.compose.yaml`, DB `beaconhs` in its own postgres | `beaconhs-phase-cd/compose.yaml`, DB `beaconhs` in its own postgres | No      |
| DB tenants      | `drill`, `test-tenant`                                                                    | `phase-aj-test`, `phase-bb-isolated-freeze-tenant-1792133778134`    | No      |

The two projects use the **same env file**
(`/home/ceshi/beaconhs-phase-aj/.env`, per the container labels), but their
`postgres`, `redis` and `minio` hostnames resolve inside their own Compose
network. The drill database has **0 `tenant_users`**; it is a separate dataset.

## 4. Resource snapshot

`docker stats --no-stream` at inventory time:

| Container | CPU   | Memory        |
| --------- | ----- | ------------- |
| collabora | 0.02% | 31.71 MiB     |
| mailpit   | 5.11% | 14.64 MiB     |
| minio     | 0.08% | 64.52 MiB     |
| postgres  | 0.01% | 42.05 MiB     |
| redis     | 5.13% | 18.86 MiB     |
| web       | 0.02% | 313.2 MiB     |
| worker    | 0.09% | 203.1 MiB     |
| **Total** |       | **≈ 688 MiB** |

Disk: drill volumes total ≈ 270 MB (plus the 79.6 MB registry volume). The
2.87 GB application image is shared with phase-aj; base images are shared too.
The host has **22 GB free (82% used)**. Docker's build cache is **53.5 GB**
(47.58 GB reclaimable) and was not pruned.

An adjacent, unmanaged container also exists:

```
beaconhs-drill-registry   registry:2   Up 5 days   127.0.0.1:5000->5000/tcp
```

It has **no Compose project label**, runs on the default `bridge` network, uses
`beaconhs-drill-20261009_registry-data`, and restarts with
`unless-stopped`. It is not part of either Compose project. It is the source of
the `127.0.0.1:5000/beaconhs-drill/minio:…` image; stopping it does not stop
running containers, but future pulls/rebuilds from that registry would fail.

## 5. Dependency check

- **Public domain:** the domain serves the phase-aj tenant set (see
  `phase-6u-b3-cr-deployment-identity.md`). No established clients were observed
  on `127.0.0.1:3001`.
- **Tunnel:** `cloudflared` is token-managed; the drill web is not the observed
  ingress target.
- **Timers:** the drill stack has its own Redis and its own repeat definitions
  (13). Its worker **is executing them**: `docker logs --since 15m` contains
  **45** `expired reservation reconciliation failed` errors. The drill scheduler
  is an exited one-shot registrar.
- **Registry:** only needed for image pulls; no runtime dependency for existing
  containers.
- **No other host service** was found that requires the drill stack. The drill
  database is not read by phase-aj.

## 6. Defects found in the unused stack (recorded, not fixed)

1. **Schema drift.** The drill `attachment_upload_reservations` table lacks
   `multipart_upload_id` (0 matching columns; phase-aj has 1). The current
   worker image selects that column, so every upload-reconciliation tick fails:
   `Failed query: … multipart_upload_id …`. This repeats about once per minute
   (45 errors in 15 minutes).
2. **Tag provenance is wrong.** `beaconhs:drill-20261018-202804` and
   `beaconhs:phase-cq-20261019-driver` both resolve to
   `sha256:60dc4841…`. The drill web/worker were recreated with the Phase CQ
   image while the drill DB remained on the older schema. The tag no longer
   identifies the build.
3. **Deleted image reference.** The drill scheduler/storage-init containers
   still reference image ID `sha256:49d64ba01ea8…`, which is no longer tagged.
   They are exited, but recreating them would resolve the current tag.
4. **Same public identity.** The drill web has
   `APP_URL=https://beaconhs-test.xuhaoqing.top` and the same
   `BETTER_AUTH_URL`, but it is bound only to `127.0.0.1:3001`. If the tunnel
   were repointed, it would serve a different database under the same domain.
5. **Broken presign endpoint.** The drill web/worker use
   `R2_ENDPOINT=http://127.0.0.1:3002`; nothing listens on 3002. The drill MinIO
   is published on 9000. Uploads/downloads through the drill web are therefore
   not expected to work even if the stack were used.
6. **Readiness is misleading.** The drill web returns
   `{"status":"ready","version":"51a899b7…"}` despite the schema drift and the
   worker error loop.

These are consequences of the earlier wrong-target deployment and the shared
image tag. They were **not repaired** in Phase CR because the stack is out of
scope and the brief forbids modifying or deleting it without approval.

## 7. Risk assessment

| Risk                                 | Severity | Notes                                                                               |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------- |
| Misoperation due to identical domain | High     | `APP_URL`/`BETTER_AUTH_URL` match phase-aj; only the port differs                   |
| Wrong-database command               | High     | Compose project names and container names are similar; ports 5432/6379 vs 3013/3014 |
| Resource consumption                 | Medium   | ≈ 688 MiB RAM, one worker ticking every minute                                      |
| Continuous error/log noise           | Medium   | 45 upload-reconciliation errors / 15 min                                            |
| Disk consumption                     | Low      | ≈ 270 MB volumes + 79.6 MB registry; images shared                                  |
| Schema/version confusion             | High     | Same image, older DB schema; readiness still says ready                             |
| Unmanaged registry                   | Low      | Starts at boot, not in either Compose project                                       |
| Accidental image tag reuse           | High     | `drill-…` tag points at the Phase CQ image                                          |

## 8. Recommended stop (not executed)

Nothing was stopped, removed, or pruned in this phase. If the owner confirms the
stack is no longer needed, the minimal reversible action is **stop**, not
`down`/`rm`:

```
cd /home/ceshi/beaconhs-phase-aj/deploy
docker compose -f drill-20261009.compose.yaml \
  --project-name beaconhs-drill-20261009 \
  --env-file /home/ceshi/beaconhs-phase-aj/.env \
  stop
```

What this stops: the seven running containers (web, worker, postgres, redis,
minio, mailpit, collabora). The scheduler and storage-init are already exited.
Containers, networks, volumes and data remain; `docker compose start` with the
same arguments reverses it.

Impact of stopping:

- frees ≈ 688 MiB RAM and stops the per-minute error loop;
- no impact on phase-aj (separate network, volumes, database, ports and
  tunnel target);
- no image, volume or database deletion;
- the registry keeps running; if it is later stopped, no new pulls from
  `127.0.0.1:5000` are possible, but existing images still run.

Do **not** run `docker compose down -v`, `docker system prune`, or remove the
drill volumes as part of this cleanup. Do not stop the registry until the owner
confirms no image pull/rebuild depends on it.

## 9. Status summary

| Check                                                | Result                            |
| ---------------------------------------------------- | --------------------------------- |
| Container/image/port/volume/network inventory        | PASS                              |
| Network, volume and database isolation from phase-aj | PASS                              |
| Dependency check (domain, timers, registry)          | PASS                              |
| Resource consumption measured                        | PASS                              |
| Schema drift and error loop documented               | PASS                              |
| Domain/APP_URL collision documented                  | PASS                              |
| Stop/delete executed                                 | NOT RUN (requires owner approval) |
| Data loss or resource deletion                       | NOT RUN                           |
