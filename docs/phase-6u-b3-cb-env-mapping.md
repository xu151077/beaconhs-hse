# Phase CB — Environment Mapping

Date: 2026-10-18
Scope: read-only investigation. No deployment performed.

## 1. Evidence sources checked

1. Git history / local backups — no compose file found
2. `bp-deploy2.sh` — references `phase-aj-compose-final.yaml` (missing)
3. Docker labels — `com.docker.compose.project.config_files` points to missing file
4. Running container env (names only) — 38 keys
5. Host `.env` (names only) — 31 keys
6. Entrypoint — does not construct connection strings
7. Phase BZ/CA reports — documented same blocker

## 2. Variable source matrix

| Runtime var                                                            | Source type         | Source                                             | Verified? |
| ---------------------------------------------------------------------- | ------------------- | -------------------------------------------------- | --------- |
| `DATABASE_URL`                                                         | constructed         | `DRILL_APP_PASSWORD` + (host/user/db unknown)      | **NO**    |
| `MIGRATION_DATABASE_URL`                                               | constructed         | `DRILL_MIGRATOR_PASSWORD` + (host/user/db unknown) | **NO**    |
| `SUPERADMIN_DATABASE_URL`                                              | constructed         | `DRILL_SUPER_PASSWORD` + (host/user/db unknown)    | **NO**    |
| `R2_SECRET_ACCESS_KEY`                                                 | constructed         | contains `DRILL_MINIO_SECRET`                      | partial   |
| `ATTACHMENT_CAPABILITY_SECRET`                                         | constructed         | contains `DRILL_ATTACHMENT_CAPABILITY_SECRET`      | partial   |
| `BETTER_AUTH_SECRET`                                                   | constructed         | contains `DRILL_BETTER_AUTH_SECRET`                | partial   |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_INTERNAL_ENDPOINT` | direct from `.env`  | `.env`                                             | yes       |
| `REDIS_URL`, `SMTP_HOST`, `SMTP_PORT`                                  | direct from `.env`  | `.env`                                             | yes       |
| `APP_URL`, `PUBLIC_APP_URL`, `COLLABORA_*`                             | direct from `.env`  | `.env`                                             | yes       |
| `NODE_ENV`, `PORT`, `HOSTNAME`                                         | direct from `.env`  | `.env`                                             | yes       |
| `APP_ROLE`, `HOME`, `NODE_VERSION`, `PATH`                             | constructed/default | unknown                                            | **NO**    |
| `PUPPETEER_*`, `SMTP_FROM`, `VAPID_*`, `YARN_VERSION`                  | constructed/default | unknown                                            | **NO**    |

## 3. Three distinct questions

For each key variable:

1. **Current runtime value exists?** Yes — readable from running container.
2. **Current runtime value connects to target?** Yes — containers are healthy.
3. **Original compose construction logic recovered?** **NO** — exact formula unknown.

## 4. Conclusion

The three database connection URLs and several runtime values are constructed in the lost compose file. Their exact construction formula (hostname, port, username, database name, sslmode) cannot be recovered without printing secrets or guessing.

**Status: BLOCKED.** The candidate compose file cannot be made deployable without the original env mapping.

## 5. Minimum next step

Reconstruct the `environment:` block by copying the running container's full env list into a **host-local, gitignored** env file and referencing it via `env_file:` plus `environment:` overrides, OR recover the original compose from a host backup outside the synced tree.
