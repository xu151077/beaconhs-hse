# Phase BY — Environment Mapping Recovery

Date: 2026-10-18
Scope: isolated test environment (`beaconhs-phase-aj`), read-only. No deployment performed.

## 1. Goal

Recover the mapping between the host `.env` (`DRILL_*` variables) and the runtime
environment variables the web/worker containers use, so the lost
`phase-aj-compose-final.yaml` can be reconstructed safely.

## 2. Method

Compared each runtime env var's value (from `docker inspect`, keys + values held
in memory, not printed) against each `.env` value. A runtime var is "sourced
from" a `.env` var if the `.env` value appears as a substring of the runtime
value. No secret values are reproduced here.

## 3. Findings

- The host `.env` has 31 lines: `DRILL_POSTGRES_PASSWORD`, `DRILL_MIGRATOR_PASSWORD`,
  `DRILL_SUPER_PASSWORD`, `DRILL_MINIO_SECRET`, `DRILL_ATTACHMENT_CAPABILITY_SECRET`,
  `DRILL_BETTER_AUTH_SECRET`, `DRILL_APP_PASSWORD`, `DRILL_APP_URL`, plus
  `APP_URL`, `APP_VERSION`, `NODE_ENV`, `PORT`, `HOSTNAME`, `PUBLIC_APP_URL`,
  `SMTP_*`, `REDIS_URL`, `DATABASE_OWNER_ROLE`, `R2_*` (non-secret config),
  `COLLABORA_*`, `BETTER_AUTH_TRUSTED_ORIGINS`, `DRILL_APP_PASSWORD`, etc.
- The running containers carry 38 env keys. The following are **direct copies**
  from `.env` (identity mapping): `R2_ACCESS_KEY_ID`, `R2_BUCKET`,
  `R2_ENDPOINT`, `R2_INTERNAL_ENDPOINT`, `R2_PRIVATE_BUCKET_CONFIRMED`,
  `R2_SECRET_ACCESS_KEY` (contains `DRILL_MINIO_SECRET`), `REDIS_URL`,
  `SMTP_HOST`, `SMTP_PORT`, `DATABASE_OWNER_ROLE`, `APP_URL`, `APP_VERSION`,
  `NODE_ENV`, `PORT`, `HOSTNAME`, `PUBLIC_APP_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`,
  `COLLABORA_*`, `ATTACHMENT_CAPABILITY_SECRET` (contains
  `DRILL_ATTACHMENT_CAPABILITY_SECRET`), `BETTER_AUTH_SECRET` (contains
  `DRILL_BETTER_AUTH_SECRET`).
- The following are **constructed** (the `.env` value appears as a substring but
  the full value is a connection string / URL built in the original compose
  `environment:` block): `DATABASE_URL` (contains `DRILL_APP_PASSWORD`),
  `MIGRATION_DATABASE_URL` (contains `DRILL_MIGRATOR_PASSWORD`),
  `SUPERADMIN_DATABASE_URL` (contains `DRILL_SUPER_PASSWORD`).
- The following have **no `.env` source** (constructed or defaulted):
  `APP_ROLE`, `HOME`, `NODE_VERSION`, `PATH`, `PUPPETEER_EXECUTABLE_PATH`,
  `PUPPETEER_SKIP_DOWNLOAD`, `SMTP_FROM`, `VAPID_*`, `YARN_VERSION`.

## 4. Conclusion — env mapping NOT fully recoverable

The original compose's `environment:` block constructed `DATABASE_URL`,
`MIGRATION_DATABASE_URL`, `SUPERADMIN_DATABASE_URL` (and possibly others) from
the `DRILL_*` passwords plus hostnames/usernames that are not themselves in
`.env`. The exact construction formula (host, port, username, database name,
sslmode, etc.) cannot be inferred safely from the running container's values
alone without printing secrets, and guessing risks a broken or insecure
connection string.

The candidate compose therefore cannot be made deployable by editing alone: it
would need the original `environment:` block, which is lost.

## 5. Recommended recovery

1. Search any host backup outside the synced tree for a compose file referencing
   `phase-aj` or `beaconhs-phase-aj` (already done in Phase BW — none found).
2. Inspect the image's `/entrypoint.sh` and any init script for env construction
   (done — entrypoint does not construct them).
3. If still missing, reconstruct the `environment:` block by copying the running
   container's full env into a **host-local** (gitignored) env file and
   referencing it with `env_file:` plus the constructed vars, rather than inlining
   secrets into the compose file. This requires explicit operator action and is
   not automated here.

## 6. Safety

- No secret values were printed or written to the repository.
- No deployment performed. No containers, volumes, or networks changed.
