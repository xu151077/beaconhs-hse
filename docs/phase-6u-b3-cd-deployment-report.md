# Phase CD — Deployment Report

Date: 2026-10-18

## 1. Image built and verified

- Tag: `beaconhs:phase-cd-20261018-142237`
- Image ID: `sha256:8feaa82d4aa1…`
- Size: 2.87 GB
- Built from: dev working tree, HEAD `51a899b7aac0a942da327222a3eed355fca9798a`
- Contains PDF trailer check: verified (`incomplete or damaged` in server SSR bundle)
- Contains viewer watchdog: verified (`Could not load the PDF` in client bundle)

## 2. Compose configuration

- File: `/home/ceshi/beaconhs-phase-cd/compose.yaml`
- Recovered from: `deploy/drill-20261009.compose.yaml` + current running container env
- All secrets referenced via `${DRILL_*}` — no hardcoding
- External volumes: `beaconhs-phase-aj_postgres-data`, `beaconhs-phase-aj_redis-data`, `beaconhs-phase-aj_minio-data`
- Validated: `docker compose config --quiet` (exit 0)

## 3. Pre-deployment state

- Running image: `beaconhs:phase-bp-20261018-095008` (`474ccda68ed4`)
- All base services healthy
- HTTPS: `https://beaconhs-test.xuhaoqing.top/login` → 200

## 4. Deployment executed

- Command: `docker compose -f ~/beaconhs-phase-cd/compose.yaml --project-name beaconhs-phase-aj --env-file .env up -d`
- Result: All containers recreated with new image
- Volume handling: External volumes used (existing data preserved)

## 5. Post-deployment state

| Container                          | Image                                   | Status                           |
| ---------------------------------- | --------------------------------------- | -------------------------------- |
| `beaconhs-phase-aj-web-1`          | `beaconhs:phase-cd-20261018-142237`     | Up (healthy)                     |
| `beaconhs-phase-aj-worker-1`       | `beaconhs:phase-cd-20261018-142237`     | Up                               |
| `beaconhs-phase-aj-scheduler-1`    | `beaconhs:phase-cd-20261018-142237`     | Exited (0) — normal for one-shot |
| `beaconhs-phase-aj-storage-init-1` | `beaconhs:phase-cd-20261018-142237`     | Exited (0) — normal for one-shot |
| `beaconhs-phase-aj-postgres-1`     | `postgres:16-alpine`                    | Up (healthy)                     |
| `beaconhs-phase-aj-redis-1`        | `redis:7-alpine`                        | Up (healthy)                     |
| `beaconhs-phase-aj-minio-1`        | `127.0.0.1:5000/beaconhs-drill/minio:…` | Up (healthy)                     |
| `beaconhs-phase-aj-mailpit-1`      | `axllent/mailpit:latest`                | Up                               |
| `beaconhs-phase-aj-collabora-1`    | `collabora/code@sha256:4e98…`           | Up (healthy)                     |

## 6. Data integrity verified

- Database: 2 tenants, all tables present (account, attachments, audit_log, etc.)
- MinIO: healthy (200 on /minio/health/live)
- HTTPS: `/login` → 200

## 7. Rollback

- Rollback target: `beaconhs:phase-bp-20261018-095008` (still on host)
- Rollback method: edit compose image tag + `up -d`
- Data volumes: preserved (external volumes)

## 8. Notes

- First deploy attempt accidentally created new empty volumes due to missing `external: true` flag — immediately corrected by stopping, fixing compose, removing empty volumes, and redeploying with external volume references.
- No data loss occurred (original volumes were never deleted).
