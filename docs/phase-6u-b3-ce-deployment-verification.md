# Phase CE — Deployment Verification

Date: 2026-10-18

## 1. Running containers

| Container                          | Image                                   | Status              |
| ---------------------------------- | --------------------------------------- | ------------------- |
| `beaconhs-phase-aj-web-1`          | `beaconhs:phase-cd-20261018-142237`     | Up (healthy)        |
| `beaconhs-phase-aj-worker-1`       | `beaconhs:phase-cd-20261018-142237`     | Up                  |
| `beaconhs-phase-aj-scheduler-1`    | `beaconhs:phase-cd-20261018-142237`     | Exited (0) — normal |
| `beaconhs-phase-aj-storage-init-1` | `beaconhs:phase-cd-20261018-142237`     | Exited (0) — normal |
| `beaconhs-phase-aj-postgres-1`     | `postgres:16-alpine`                    | Up (healthy)        |
| `beaconhs-phase-aj-redis-1`        | `redis:7-alpine`                        | Up (healthy)        |
| `beaconhs-phase-aj-minio-1`        | `127.0.0.1:5000/beaconhs-drill/minio:…` | Up (healthy)        |
| `beaconhs-phase-aj-mailpit-1`      | `axllent/mailpit:latest`                | Up                  |
| `beaconhs-phase-aj-collabora-1`    | `collabora/code@sha256:4e98…`           | Up (healthy)        |

## 2. Image verification

- Running image: `beaconhs:phase-cd-20261018-142237` (`sha256:8feaa82d4aa1…`)
- Matches Phase CD report
- Image ID: `8feaa82d4aa1`
- Size: 2.87 GB

## 3. Data integrity

- Database: 2 tenants, all tables present
- MinIO: healthy (200 on /minio/health/live)
- Volumes: `beaconhs-phase-aj_postgres-data`, `beaconhs-phase-aj_redis-data`, `beaconhs-phase-aj_minio-data` — all original volumes, no empty duplicates

## 4. HTTPS health

- `https://beaconhs-test.xuhaoqing.top/login` → 200

## 5. No anomalies

- No empty/duplicate volumes
- No data integrity issues
- Running image matches Phase CD report
