# Phase CD — Environment Recovery

Date: 2026-10-18

## 1. Summary

The Phase CB blocker (missing compose env mapping) has been resolved. The original deployment configuration was recovered from the drill compose file (`deploy/drill-20261009.compose.yaml`) on the test host, and the current running container's non-secret env values were used to reconstruct the exact configuration.

## 2. Recovery method

1. Found `deploy/drill-20261009.compose.yaml` on the test host — this is the original drill deployment compose with the complete env construction formula.
2. Compared the drill compose structure with the current running container's env to identify value differences.
3. Built a new Phase CD compose using:
   - The construction formula from the drill compose
   - The current non-secret values from the running container
   - `${DRILL_*}` references for all secrets (no hardcoding)

## 3. Key differences from drill compose

| Variable                      | Drill value                        | Phase CD value                           |
| ----------------------------- | ---------------------------------- | ---------------------------------------- |
| `APP_URL`                     | `${DRILL_APP_URL}`                 | `${APP_URL}` (from .env)                 |
| `BETTER_AUTH_URL`             | `${DRILL_APP_URL}`                 | `${APP_URL}`                             |
| `BETTER_AUTH_TRUSTED_ORIGINS` | `${DRILL_APP_URL}`                 | `${APP_URL}`                             |
| `COLLABORA_URL`               | `http://127.0.0.1:3002`            | `${APP_URL}`                             |
| `R2_ENDPOINT`                 | `http://127.0.0.1:3002`            | `${APP_URL}`                             |
| `R2_INTERNAL_ENDPOINT`        | `http://minio:9000`                | `${R2_INTERNAL_ENDPOINT}` (from .env)    |
| `R2_BUCKET`                   | `beaconhs-drill`                   | `${R2_BUCKET}` (from .env)               |
| `COLLABORA_WOPI_URL`          | `http://web:3000`                  | `${COLLABORA_WOPI_URL}` (from .env)      |
| `COLLABORA_DISCOVERY_URL`     | (not in drill)                     | `${COLLABORA_DISCOVERY_URL}` (from .env) |
| `DATABASE_OWNER_ROLE`         | `beaconhs_owner`                   | `${DATABASE_OWNER_ROLE}` (from .env)     |
| Web port                      | `127.0.0.1:3001`                   | `127.0.0.1:3010`                         |
| Collabora port                | `127.0.0.1:9980`                   | `127.0.0.1:3015`                         |
| MinIO port                    | `127.0.0.1:9000`                   | `127.0.0.1:3011`                         |
| Postgres port                 | `127.0.0.1:5432`                   | `127.0.0.1:3013`                         |
| Redis port                    | (not exposed)                      | `127.0.0.1:3014`                         |
| Mailpit ports                 | `127.0.0.1:8025`, `127.0.0.1:1025` | `127.0.0.1:3016`, `127.0.0.1:3017`       |
| Collabora frame_ancestors     | `http://127.0.0.1:3002`            | `${APP_URL}`                             |

## 4. Secret handling

All secrets are referenced via `${DRILL_*}` from the host `.env` file:

- `DRILL_APP_PASSWORD` — database app user password
- `DRILL_MIGRATOR_PASSWORD` — database migrator user password
- `DRILL_SUPER_PASSWORD` — database super user password
- `DRILL_POSTGRES_PASSWORD` — database postgres user password
- `DRILL_MINIO_SECRET` — MinIO root password
- `DRILL_BETTER_AUTH_SECRET` — Better Auth secret
- `DRILL_ATTACHMENT_CAPABILITY_SECRET` — attachment signing secret

No secrets are hardcoded in the compose file.

## 5. Validation

- Compose file parses successfully with `docker compose config --quiet` (exit 0)
- All variables resolve from `.env` file
- Volume names match existing volumes (`beaconhs-phase-aj_*`)
- Network matches existing network (`beaconhs-phase-aj_default`)
- Port mappings match current container port bindings

## 6. Evidence

- Source: `/home/ceshi/beaconhs-phase-aj/deploy/drill-20261009.compose.yaml`
- Current env: `docker inspect beaconhs-phase-aj-web-1` (non-secret values only)
- Host .env: `/home/ceshi/beaconhs-phase-aj/.env` (variable names only, values not printed)
- New compose: `/home/ceshi/beaconhs-phase-cd/compose.yaml`
