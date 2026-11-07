# Phase 6U-B3-CR — Deployment identity

Date: 2026-10-19
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

Status: **PASS for the tested stack identity**, with **two residual identity
mismatches** recorded in §7. The public domain, Compose project, containers,
images, database, Redis, object store and mail sink all resolve to
`beaconhs-phase-aj`. The unused `beaconhs-drill-20261009` stack is a separate
deployment and is **not** the target of the domain.

## 1. Scope and rules

- Read-only verification of the isolated test stack at `10.10.31.30`.
- No production or C2 resource was touched.
- No `.env`, SSH key or auth configuration was edited.
- No container, image, volume or database of the unused stack was stopped,
  removed or pruned.
- The only remote change in Phase CR is the scheduler restart policy documented
  in `phase-6u-b3-cr-scheduler-reliability.md`; the pre-change Compose file was
  backed up as `/home/ceshi/beaconhs-phase-cd/compose.yaml.bak-cr`.

## 2. Repository baseline (verified this phase)

```
$ git branch --show-current
hse-platform
$ git log --oneline -1
51a899b7 fix(db): synchronize seeded reference counters
$ git status --short | awk '{print $1}' | sort | uniq -c
    301 ??
    119 M
```

`git status --porcelain -uall` expands the 301 untracked directory entries to
608 untracked files; 0 files are staged. The working tree was already in this
state when Phase CR began and was not reset, cleaned or committed.

## 3. Domain → stack identity

| Hop              | Verified value                                                                             | How verified                                                               |
| ---------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Public host      | `https://beaconhs-test.xuhaoqing.top`                                                      | `curl` returns HTTP 200 for `/login` and an authenticated `/documents`     |
| Edge             | Cloudflare (`server: cloudflare`, `cf-ray`)                                                | Response headers                                                           |
| Tunnel           | `cloudflared` systemd unit, token file `/etc/cloudflared/token`, token-managed             | `systemctl cat cloudflared`, process list; token contents were never read  |
| Local app port   | `127.0.0.1:3010`                                                                           | `ss -ltnp`; this is the only app listener in the 3010–3017 range used here |
| Compose project  | `beaconhs-phase-aj`                                                                        | container labels `com.docker.compose.project`                              |
| Compose config   | `/home/ceshi/beaconhs-phase-cd/compose.yaml`                                               | labels `com.docker.compose.project.config_files`                           |
| Env file         | `/home/ceshi/beaconhs-phase-aj/.env`                                                       | labels `com.docker.compose.project.environment_file`                       |
| Web container    | `beaconhs-phase-aj-web-1`                                                                  | `docker ps`, labels                                                        |
| Worker container | `beaconhs-phase-aj-worker-1`                                                               | `docker ps`, labels                                                        |
| Database         | PostgreSQL in `beaconhs-phase-aj-postgres-1`, database `beaconhs`, app user `beaconhs_app` | container env + successful queries under RLS context                       |
| Redis            | `beaconhs-phase-aj-redis-1`                                                                | `redis-cli ping` → `PONG`                                                  |
| Object store     | MinIO `beaconhs-phase-aj-minio-1`, bucket `beaconhs-phase-aj`                              | `/minio/health/live` 200, `/minio/health/ready` 200; presigned URL path    |
| Mail sink        | Mailpit `beaconhs-phase-aj-mailpit-1`                                                      | `/api/v1/messages` → 0 messages                                            |

The tunnel ingress itself is **remote-managed** (token file, no local
`config.yml`), so the ingress rule could not be read directly. The mapping is
established by behaviour, not only by names:

1. The authenticated `/documents` page served by the domain renders the tenant
   name **“Phase BB Isolated Freeze Tenant 1792133778134”** and the phase-aj
   tenant **“Phase AJ Test Tenant”**.
2. The phase-aj database contains exactly those tenants. The drill database
   contains `drill` and `test-tenant` with different names and no phase-aj
   tenant.
3. Port 3010 is the phase-aj web service's published port (Compose label), and
   the drill web is on 3001 with no established clients.

**Tunnel ingress config: NOT VERIFIED directly** (no local config, no
Cloudflare dashboard access). The behavioural evidence above is what prevents
the earlier “container name = target” mistake.

## 4. Container, image and health identity

```
$ docker inspect beaconhs-phase-aj-web-1 beaconhs-phase-aj-worker-1 \
    --format '{{.Name}} {{.Config.Image}} {{.Image}}'
/beaconhs-phase-aj-web-1    beaconhs:phase-cq-20261019-driver sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370
/beaconhs-phase-aj-worker-1 beaconhs:phase-cq-20261019-driver sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370
```

This matches the image digest reported by Phase CQ
(`sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370`).

| Service      | Container                          | Image ID (short)         | State                          |
| ------------ | ---------------------------------- | ------------------------ | ------------------------------ |
| web          | `beaconhs-phase-aj-web-1`          | `60dc4841…`              | running, healthy, 0 restarts   |
| worker       | `beaconhs-phase-aj-worker-1`       | `60dc4841…`              | running, 0 restarts            |
| scheduler    | `beaconhs-phase-aj-scheduler-1`    | `60dc4841…`              | exited 0 (one-shot by design)  |
| storage-init | `beaconhs-phase-aj-storage-init-1` | `8feaa82d…`              | exited 0 (stale image, see §7) |
| postgres     | `beaconhs-phase-aj-postgres-1`     | `postgres:16-alpine`     | running, healthy               |
| redis        | `beaconhs-phase-aj-redis-1`        | `redis:7-alpine`         | running, healthy               |
| minio        | `beaconhs-phase-aj-minio-1`        | local registry           | running, healthy               |
| mailpit      | `beaconhs-phase-aj-mailpit-1`      | `axllent/mailpit:latest` | running, healthy               |
| collabora    | `beaconhs-phase-aj-collabora-1`    | pinned digest            | running, healthy               |

The scheduler was recreated during Phase B and now runs the same image as web
and worker. The storage-init container was created before the Phase CQ image was
built and is still exited against the older `phase-cd` image; the Compose file
itself already references `beaconhs:phase-cq-20261019-driver`, so the next
`docker compose up -d` will align it.

## 5. Runtime health (verified this phase)

```
$ curl -sS https://beaconhs-test.xuhaoqing.top/api/health/ready
{"status":"ready","version":"51a899b7aac0a942da327222a3eed355fca9798a"}

$ docker exec beaconhs-phase-aj-redis-1 redis-cli ping
PONG

$ curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3011/minio/health/live
200
$ curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3011/minio/health/ready
200

$ curl -sS http://127.0.0.1:3016/api/v1/messages
{"total":0,"unread":0,"count":0,...}

$ docker exec beaconhs-phase-aj-redis-1 redis-cli llen bull:emails:wait
0
$ docker exec beaconhs-phase-aj-redis-1 redis-cli zcard bull:emails:failed
0
```

| Component      | Result | Evidence                                                |
| -------------- | ------ | ------------------------------------------------------- |
| web            | PASS   | readiness 200, version matches HEAD, container healthy  |
| worker         | PASS   | running, 0 restarts, scheduled ticks executing          |
| database       | PASS   | readiness + tenant queries + freeze rows                |
| Redis          | PASS   | `PONG`; queues present                                  |
| object storage | PASS   | MinIO live 200, ready 200; presigned GET works          |
| mail queue     | PASS   | Mailpit 0 messages; Bull email queue 0 waiting/0 failed |

The readiness endpoint itself only proves process/database/Redis reachability;
it does **not** validate the database schema version (see §7, drill stack).

## 6. Freeze driver scoping (verified this phase)

`apps/worker/src/bt-freeze-driver.ts` is compile-time gated by
`const TEST_ONLY_DRIVER = true` and scopes every operation to the isolated
tenant:

```
const TEST_TENANT_ID =
  process.env.E2E_TEST_TENANT_ID ?? 'ea5a149b-ea76-48e0-abbe-fa360f520d8e'
```

Deployed status:

```
$ docker exec beaconhs-phase-aj-worker-1 \
    /app/apps/worker/node_modules/.bin/tsx /app/apps/worker/src/bt-freeze-driver.ts status
state=ACTIVE version=191 migrationId=null leaseHolderId=null leaseExpiresAt=null
lastReason=bt-freeze-driver: manual release
```

Database cross-check:

| Tenant slug                                     | State  | Version | Last transition actor |
| ----------------------------------------------- | ------ | ------- | --------------------- |
| `phase-aj-test`                                 | ACTIVE | 2       | `ak-phase-ak-probe`   |
| `phase-bb-isolated-freeze-tenant-1792133778134` | ACTIVE | 191     | `bt-freeze-driver`    |

Only the isolated tenant carries `bt-freeze-driver` transitions. The driver's
`status` is read-only and operated on that tenant only.

## 7. Residual identity mismatches and risks

1. **The drill tag now points at the Phase CQ image.**
   `beaconhs:drill-20261018-202804` and `beaconhs:phase-cq-20261019-driver` both
   resolve to `sha256:60dc4841…`. The drill web/worker were recreated with that
   image, while the drill database was initialised from an older schema. This is
   why the drill worker now fails its upload-reconciliation tick every minute
   (missing `attachment_upload_reservations.multipart_upload_id`). Tag names are
   not provenance; inspect the image ID, not the tag.
2. **`beaconhs-phase-aj-storage-init-1` is stale.**
   The container is exited 0 against the older `8feaa82d…` image even though the
   Compose file references the current image. It is a one-shot initialiser; a
   full `up -d` will recreate it. No action was taken in Phase CR.
3. **Readiness does not validate schema.**
   The drill stack returns `{"status":"ready","version":"51a899b7…"}` while its
   worker is in a schema-mismatch error loop. Readiness is not a deployment
   compatibility check.
4. **The drill stack has the same public `APP_URL`.**
   Its web container carries `APP_URL=https://beaconhs-test.xuhaoqing.top` and
   the same `BETTER_AUTH_URL`, but its `R2_ENDPOINT=http://127.0.0.1:3002` has no
   listener. Repointing the tunnel would silently serve a different database
   under the same domain. See `phase-6u-b3-cr-drill-stack-inventory.md`.
5. **Tunnel ingress is token-managed.**
   There is no local ingress file to audit. Future verification must keep using
   the behavioural tenant/image/database checks, not container names.

## 8. Status summary

| Check                                            | Result                                           |
| ------------------------------------------------ | ------------------------------------------------ |
| Repository branch/HEAD/working-tree baseline     | PASS                                             |
| Domain serves the phase-aj database              | PASS                                             |
| Compose project/config/env labels                | PASS                                             |
| Web/worker image digest matches Phase CQ         | PASS                                             |
| Web readiness and container health               | PASS                                             |
| Worker running, image, no restart loop           | PASS                                             |
| Database target and tenant identity              | PASS                                             |
| Redis / MinIO / Mailpit reachability             | PASS                                             |
| Freeze driver tenant scoping                     | PASS                                             |
| Drill stack isolation (network/volume/DB)        | PASS                                             |
| Tunnel ingress configuration read directly       | NOT VERIFIED                                     |
| Storage-init image aligned to current deployment | FAIL (stale exited container; no runtime impact) |
| Drill tag/image/schema consistency               | FAIL (recorded, not modified)                    |
