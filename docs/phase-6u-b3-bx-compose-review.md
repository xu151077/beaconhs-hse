# Phase BX — Candidate Compose Review

Date: 2026-10-18
Verdict: **BLOCKED**

The candidate file cannot be used to deploy the PDF fix image. Critical environment
construction is missing and cannot be recovered without guessing.

## 1. Candidate file

- Path: `~/beaconhs-phase-aj/phase-aj-compose-candidate.yaml` (created in Phase BW,
  not the original path).
- Parses with `docker compose config` (exit 0, 252 lines).
- Base: reconstructed from `docker inspect` of the running web/worker containers
  plus the running infra images and the host `.env`.

## 2. Comparison vs. running containers

### Confirmed identical

| Field                        | Candidate                                                     | Running                    | Match |
| ---------------------------- | ------------------------------------------------------------- | -------------------------- | ----- |
| web image                    | `phase-bp-20261018-095008`                                    | `phase-bp-20261018-095008` | yes   |
| worker image                 | `phase-bp-20261018-095008`                                    | `phase-bp-20261018-095008` | yes   |
| web ports                    | `127.0.0.1:3010:3000`                                         | `127.0.0.1:3010→3000`      | yes   |
| worker ports                 | none                                                          | none                       | yes   |
| web healthcheck              | curl ready, 10s/5s/30s/10                                     | identical                  | yes   |
| restart policy               | (default `no`)                                                | `no`                       | yes   |
| mounts (web/worker)          | none                                                          | none                       | yes   |
| postgres/minio/redis volumes | `beaconhs-phase-aj_*-data`                                    | same                       | yes   |
| postgres bind mounts         | local-init.sh, provision.sql                                  | same                       | yes   |
| depends_on                   | web: mailpit/postgres/redis/minio; worker: postgres/redis/web | same labels                | yes   |
| networks                     | default (`beaconhs-phase-aj_default`)                         | same                       | yes   |
| collabora image              | hash `4e983196eb98`                                           | hash `4e983196eb98`        | yes   |

### Critical unverified / different

1. **Environment variables.** The running containers carry 38 env keys
   (`DATABASE_URL`, `R2_ENDPOINT`, `R2_INTERNAL_ENDPOINT`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `ATTACHMENT_CAPABILITY_SECRET`,
   `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`,
   `MIGRATION_DATABASE_URL`, `SUPERADMIN_DATABASE_URL`, `REDIS_URL`,
   `COLLABORA_*`, `VAPID_*`, `SMTP_*`, `PUBLIC_APP_URL`, `APP_URL`,
   `DATABASE_OWNER_ROLE`, `APP_VERSION`, …). The candidate only sets
   `env_file: .env` plus `APP_ROLE`/`PORT`. The host `.env` has 31 lines and
   only `DRILL_*`-prefixed values plus a handful of others; the entrypoint does
   not construct `DATABASE_URL`/`R2_*` from them. So the original compose must
   have had an `environment:` block (or a different env_file) that mapped the
   `DRILL_*` values into the runtime keys. **The candidate does not.** Deploying
   it as-is would start web/worker with missing `DATABASE_URL`, `R2_*`, etc. and
   break the app.

2. **Secrets handling.** The original almost certainly injected secrets via the
   compose `environment:` block (or a separate env file). The candidate relies on
   `.env` alone, which does not contain them. Cannot be verified without printing
   secret values, which is forbidden.

3. **Extra compose fields.** Cannot confirm the original had no additional fields
   (logging, ulimits, security_opt, deploy.resources). `docker inspect` showed
   only `json-file` logging with defaults, so nothing obvious is missing, but the
   original may have differed.

4. **Collabora image reference.** Candidate uses a digest hash; original may
   have used a tag. Functionally identical but not proven.

5. **Candidate never applied.** `docker compose up` behaviour on it is untested.

## 3. Deployment plan (NOT executed)

- Project name: `beaconhs-phase-aj` (from container labels).
- Services that would be created/recreated: web, worker (and the candidate would
  also manage postgres, redis, minio, mailpit, collabora — risk of touching
  running infra).
- Volumes: named volumes `beaconhs-phase-aj_postgres-data`, `_minio-data`,
  `_redis-data` would be reused if project/volume names match (they do, by
  inspection). But any mismatch creates new empty volumes → data loss.
- Image switch: web/worker `image:` → `beaconhs:phase-bu-20261018-131209`.
- Rollback: revert `image:` to `beaconhs:phase-bp-20261018-095008` and
  `docker compose up -d`. Both images present on the host.
- Still required before deploy: recover the original env mapping (how `DRILL_*`
  becomes `DATABASE_URL`/`R2_*`/etc.), verify `.env` completeness, and confirm
  no extra compose fields.

## 4. Verdict

**BLOCKED.** The candidate cannot be used for deployment because the environment
variable construction is unverified and almost certainly incomplete (the running
containers carry 38 keys that the candidate does not provide). Deploying it
would start web/worker without `DATABASE_URL`/`R2_*`/secrets and break the
environment.

## 5. Required next steps (manual)

1. Recover the original `phase-aj-compose-final.yaml` env mapping. Likely sources:
   - The entrypoint or an env-templating script in the image (`docker run --rm
beaconhs:phase-bp-20261018-095008 cat /entrypoint.sh` already shows no
     construction, so the mapping is in the compose `environment:` block).
   - A host backup outside the synced tree (search `/`, `/root`, `/opt`,
     `/srv`, `/home` for any `*.yaml` referencing `phase-aj`).
   - The original deploy script or its logs (`~/bp-deploy2.log` if retained).
2. Once the env mapping is recovered, update the candidate and re-run
   `docker compose config` + a dry-run diff.
3. Only then repoint to `beaconhs:phase-bu-20261018-131209` and run the HTTPS
   browser checks.

## 6. Safety

- No deployment performed. No containers, volumes, or networks changed.
- No database migration. No destructive git operations.
- All working-tree modifications preserved. No commits, no pushes.
