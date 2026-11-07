# Phase CD — Rollback Plan

Date: 2026-10-18

## 1. Current state (pre-deployment)

### Running containers

- `beaconhs-phase-aj-web-1` — `beaconhs:phase-bp-20261018-095008` — Up (healthy)
- `beaconhs-phase-aj-worker-1` — `beaconhs:phase-bp-20261018-095008` — Up
- `beaconhs-phase-aj-scheduler-1` — `beaconhs:phase-bp-20261018-095008` — Exited (0)
- `beaconhs-phase-aj-storage-init-1` — `beaconhs:phase-bp-20261018-095008` — Exited (0)
- `beaconhs-phase-aj-collabora-1` — Up (healthy)
- `beaconhs-phase-aj-postgres-1` — Up (healthy)
- `beaconhs-phase-aj-redis-1` — Up (healthy)
- `beaconhs-phase-aj-minio-1` — Up (healthy)
- `beaconhs-phase-aj-mailpit-1` — Up

### Volumes (must remain unchanged)

- `beaconhs-phase-aj_postgres-data`
- `beaconhs-phase-aj_redis-data`
- `beaconhs-phase-aj_minio-data`

### Network

- `beaconhs-phase-aj_default`

## 2. Rollback target

- Image: `beaconhs:phase-bp-20261018-095008` (`sha256:474ccda68ed4…`)
- Compose: `~/beaconhs-phase-cd/compose.yaml` (Phase CD config)
- Rollback = repoint to old image and redeploy

## 3. Rollback procedure

1. Edit `~/beaconhs-phase-cd/compose.yaml`: replace `beaconhs:phase-cd-20261018-142237` with `beaconhs:phase-bp-20261018-095008`
2. Run: `docker compose -f ~/beaconhs-phase-cd/compose.yaml --project-name beaconhs-phase-cd --env-file .env up -d web worker scheduler storage-init`
3. Verify health: `docker compose -f ~/beaconhs-phase-cd/compose.yaml ps` and `curl https://beaconhs-test.xuhaoqing.top/login`

## 4. Data volume protection

- No `docker compose down -v`
- No volume deletion or recreation
- Volumes are referenced by name (`beaconhs-phase-aj_*`) and will be reused

## 5. Verification after rollback

- `docker ps` shows web/worker on `phase-bp-20261018-095008`
- `curl https://beaconhs-test.xuhaoqing.top/login` returns 200
- No data loss (volumes unchanged)
