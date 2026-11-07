# Phase 6U-B3-CQ — Deployment

Date: 2026-10-19
Host: `10.10.31.30` (SSH alias `beaconhs-drill`, user `ceshi`)
Domain: `https://beaconhs-test.xuhaoqing.top`
Status: **PASS — the driver image is deployed to the stack that serves the domain,
and a missing worker has been restored.**

## Critical correction: which stack serves the domain

Phase CP assumed the compose project `beaconhs-drill-20261009` was authoritative.
It is not. Both stacks run on the same host:

| Stack                     | Compose file                                                       | Web port | Database                         | Serves the public domain? |
| ------------------------- | ------------------------------------------------------------------ | -------- | -------------------------------- | ------------------------- |
| `beaconhs-drill-20261009` | `/home/ceshi/beaconhs-phase-aj/deploy/drill-20261009.compose.yaml` | 3001     | own volumes                      | **No**                    |
| `beaconhs-phase-aj`       | `/home/ceshi/beaconhs-phase-cd/compose.yaml`                       | 3010     | `beaconhs-phase-aj_*` (external) | **Yes**                   |

Evidence:

```
$ docker inspect beaconhs-phase-aj-web-1 --format '{{json .Config.Labels}}'
com.docker.compose.project = beaconhs-phase-aj
com.docker.compose.project.config_files = /home/ceshi/beaconhs-phase-cd/compose.yaml
com.docker.compose.project.environment_file = /home/ceshi/beaconhs-phase-aj/.env

$ docker exec beaconhs-phase-aj-postgres-1 psql -U beaconhs_super -d beaconhs \
    -c "SELECT id, name, slug FROM tenants ORDER BY created_at;"
 de8a882e-1724-4ea5-ad7d-f5a79b527471 | Phase AJ Test Tenant                          | phase-aj-test
 ea5a149b-ea76-48e0-abbe-fa360f520d8e | Phase BB Isolated Freeze Tenant 1792133778134 | phase-bb-isolated-freeze-tenant-1792133778134
```

The browser context during an E2E run showed
`Super-admin · scoped to Phase BB Isolated Freeze Tenant 1792133778134`, i.e. the
`phase-aj` database. The `beaconhs-drill-20261009` database also contains a tenant
with the same id, which is why the freeze driver "worked" there while the tested
app was unaffected — the classic wrong-target failure. The Phase BQ run against
the drill stack was invalid for this reason and its results were discarded.

The `phase-aj` stack was **missing its `worker` service** (only `web`, `postgres`,
`redis`, `minio`, `mailpit`, `collabora` were running). The driver needs a worker
container in the same database as the app; restoring it also restores background
jobs (scheduled flows, upload reconciliation, write-arm reconciliation).

## Build

Build context `/home/ceshi/beaconhs-phase-aj` (source commit `51a899b7`), using
`Dockerfile.test` to bypass the build-time `next_server_actions_key` secret mount:

```
$ docker buildx build \
    --tag beaconhs:drill-20261018-202804 \
    --file Dockerfile.test \
    --build-arg DEPLOYMENT_VERSION=51a899b7aac0a942da327222a3eed355fca9798a \
    --iidfile /tmp/cq-iid.txt .
...
#28 naming to docker.io/library/beaconhs:drill-20261018-202804 done
BUILD_EXIT=0
IIDFILE=sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370
```

Image (built from the updated `bt-freeze-driver.ts` with `reconcile`):

```
sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370
```

The updated driver was copied to the build context first and the sha256 verified:

```
local  a9b132234573d1f3bbf5b3d24bd31b4e2e15a9e67ba9c12c42b8b3ba57ad0e28
remote a9b132234573d1f3bbf5b3d24bd31b4e2e15a9e67ba9c12c42b8b3ba57ad0e28
```

## Target the correct stack

The existing isolated-test compose config was preserved; only the image tag was
repointed (the new build was tagged rather than overwriting the old version tag):

```
$ docker tag sha256:60dc4841... beaconhs:phase-cq-20261019-driver
$ cp -a /home/ceshi/beaconhs-phase-cd/compose.yaml \
         /home/ceshi/beaconhs-phase-cd/compose.yaml.bak-cq
$ sed -i 's|image: beaconhs:phase-cd-20261018-142237|image: beaconhs:phase-cq-20261019-driver|g' \
         /home/ceshi/beaconhs-phase-cd/compose.yaml
```

Diff (four services: web, worker, scheduler, storage-init):

```diff
   web:
-    image: beaconhs:phase-cd-20261018-142237
+    image: beaconhs:phase-cq-20261019-driver
   worker:
-    image: beaconhs:phase-cd-20261018-142237
+    image: beaconhs:phase-cq-20261019-driver
   scheduler:
-    image: beaconhs:phase-cd-20261018-142237
+    image: beaconhs:phase-cq-20261019-driver
   storage-init:
-    image: beaconhs:phase-cd-20261018-142237
+    image: beaconhs:phase-cq-20261019-driver
```

Deploy (the worker is created; web is recreated because the image tag changed):

```
$ cd /home/ceshi/beaconhs-phase-cd && docker compose -f compose.yaml \
    --project-name beaconhs-phase-aj --env-file /home/ceshi/beaconhs-phase-aj/.env \
    up -d worker
 Container beaconhs-phase-aj-web-1 Recreated
 Container beaconhs-phase-aj-worker-1 Created / Started
```

No new volumes were created; `postgres`, `redis`, `minio` volumes are the existing
external `beaconhs-phase-aj_*` volumes in the compose file. `.env` was not modified.

## Post-deploy verification

```
$ docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep beaconhs-phase-aj
beaconhs-phase-aj-worker-1   Up ...            beaconhs:phase-cq-20261019-driver
beaconhs-phase-aj-web-1      Up ... (healthy)  beaconhs:phase-cq-20261019-driver
beaconhs-phase-aj-redis-1    Up ... (healthy)  redis:7-alpine
beaconhs-phase-aj-postgres-1 Up ... (healthy)  postgres:16-alpine
beaconhs-phase-aj-minio-1    Up ... (healthy)  127.0.0.1:5000/beaconhs-drill/minio:b187417eee0a-drill-20261009
beaconhs-phase-aj-mailpit-1  Up ... (healthy)  axllent/mailpit:latest
beaconhs-phase-aj-collabora-1 Up ... (healthy) 4e983196eb98

$ curl -sS https://beaconhs-test.xuhaoqing.top/api/health/ready
{"status":"ready","version":"51a899b7aac0a942da327222a3eed355fca9798a"}

$ docker exec beaconhs-phase-aj-worker-1 .../tsx /app/apps/worker/src/bt-freeze-driver.ts status
state=ACTIVE version=99 ... lastReason=Phase BT isolated browser freeze proof (test tenant only)
```

Full image id check:

```
$ docker inspect beaconhs-phase-aj-worker-1 --format '{{.Image}}'
sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370
$ docker inspect beaconhs-phase-aj-web-1 --format '{{.Image}}'
sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370
```

## Repairs performed on the drill (non-target) stack

These were done before the wrong-target discovery and are recorded for
completeness. They affect the unused `beaconhs-drill-20261009` stack only:

- Fixed the `beaconhs_super` password to match the stack's `.env`, then aligned
  `beaconhs_app` and `beaconhs_migrator` too:
  `ALTER USER <role> WITH PASSWORD '<value from .env>'` (values never printed).
  Before the fix, the drill web container failed `/api/health/ready` with 503 and
  the worker logged `password authentication failed for user "beaconhs_app"`.
- `beaconhs-drill-20261009-web-1` and `-worker-1` now run the same image id.

The target `phase-aj` database credentials were verified working without change:

```
$ (page-cookie-scoped check) psql -U beaconhs_app  -d beaconhs -h postgres -tAc 'select 1'  → 1
$ (page-cookie-scoped check) psql -U beaconhs_super -d beaconhs -h postgres -tAc 'select 1'  → 1
```

## Outstanding / flagged

- The unused `beaconhs-drill-20261009` stack is still running (NOT as the target).
  Stopping it is a host-owner decision; nothing was deleted.
- In the `phase-aj` compose, `scheduler` has `restart: "no"` and its container
  exited ~18 h ago. Scheduled repeatable jobs are registered in Redis, so the
  restored `worker` executes the ticks (observed in the worker log), but the
  `scheduler` service itself is not managed to stay up. This is a pre-existing
  environment defect, reported not fixed.

## Status

| Item                                                    | Result  |
| ------------------------------------------------------- | ------- |
| Correct stack identified                                | PASS    |
| Image built (id recorded)                               | PASS    |
| Existing compose config reused (tag repointed in place) | PASS    |
| Worker service restored                                 | PASS    |
| Web/worker run the new image id                         | PASS    |
| Readiness 200 via domain                                | PASS    |
| Driver present in worker                                | PASS    |
| Unused drill stack left running (not deleted)           | FLAGGED |
