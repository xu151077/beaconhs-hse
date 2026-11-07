# Phase CA — Environment Recovery

Date: 2026-10-18
Scope: read-only investigation + recovery attempt. No deployment performed.

## 1. Current state (verified)

- HEAD: `51a899b7` (`hse-platform`), working tree preserved, no commits/pushes.
- Test env: `https://beaconhs-test.xuhaoqing.top/login` → 200.
- Running image: `beaconhs:phase-bp-20261018-095008` (`474ccda68ed4`).
- Ready image: `beaconhs:phase-bu-20261018-131209` (`23dae17b12ae`), on host.
- Deployment compose file `phase-aj-compose-final.yaml`: **missing** (no backup).

## 2. Evidence sources checked

1. Git history / local backups — no compose file found.
2. `bp-deploy2.sh` — references `phase-aj-compose-final.yaml` (missing).
3. Docker labels — `com.docker.compose.project.config_files` points to the missing
   file.
4. Running container env (names only) — 38 keys, including `DATABASE_URL`,
   `R2_*`, `ATTACHMENT_CAPABILITY_SECRET`, `BETTER_AUTH_*`, etc.
5. Host `.env` (names only) — 31 keys, mostly `DRILL_*` plus app config.
6. Entrypoint — does not construct connection strings.
7. Reports — Phase BZ/BX documented the same blocker.

## 3. Variable source matrix

| Runtime var                                                                                                       | Source type         | Source                                             | Verified? |
| ----------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------- | --------- |
| `DATABASE_URL`                                                                                                    | constructed         | `DRILL_APP_PASSWORD` + (host/user/db unknown)      | **NO**    |
| `MIGRATION_DATABASE_URL`                                                                                          | constructed         | `DRILL_MIGRATOR_PASSWORD` + (host/user/db unknown) | **NO**    |
| `SUPERADMIN_DATABASE_URL`                                                                                         | constructed         | `DRILL_SUPER_PASSWORD` + (host/user/db unknown)    | **NO**    |
| `R2_SECRET_ACCESS_KEY`                                                                                            | constructed         | contains `DRILL_MINIO_SECRET`                      | partial   |
| `ATTACHMENT_CAPABILITY_SECRET`                                                                                    | constructed         | contains `DRILL_ATTACHMENT_CAPABILITY_SECRET`      | partial   |
| `BETTER_AUTH_SECRET`                                                                                              | constructed         | contains `DRILL_BETTER_AUTH_SECRET`                | partial   |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_INTERNAL_ENDPOINT`, `R2_PRIVATE_BUCKET_CONFIRMED`             | direct from `.env`  | `.env`                                             | yes       |
| `REDIS_URL`, `SMTP_HOST`, `SMTP_PORT`, `APP_URL`, `PUBLIC_APP_URL`, `COLLABORA_*`, `NODE_ENV`, `PORT`, `HOSTNAME` | direct from `.env`  | `.env`                                             | yes       |
| `APP_ROLE`, `HOME`, `NODE_VERSION`, `PATH`, `PUPPETEER_*`, `SMTP_FROM`, `VAPID_*`, `YARN_VERSION`                 | constructed/default | unknown                                            | **NO**    |

## 4. Conclusion

The three database connection URLs and several runtime values are constructed in the
lost compose file. Their exact construction formula (hostname, port, username,
database name, sslmode, etc.) cannot be recovered without printing secrets or
guessing. Per the safety rules, no deployment was attempted.

**Status: BLOCKED.** The candidate compose file
(`phase-aj-compose-candidate.yaml`) cannot be made deployable without the original
env mapping.

## 5. Minimum next step

Reconstruct the `environment:` block by copying the running container's full env
list into a **host-local, gitignored** env file and referencing it via `env_file:`
plus `environment:` overrides, OR recover the original compose from a host backup
outside the synced tree. Then run `docker compose config` and verify before
deploying. No commits, no pushes.
