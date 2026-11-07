# Phase CB — Compose Validation

Date: 2026-10-18

## 1. Candidate compose status

- File: `~/beaconhs-phase-aj/phase-aj-compose-candidate.yaml`
- Parses successfully (exit 0)
- Env mapping unverified → **NOT deployable**

## 2. Validation checklist

| Item                                       | Status                            |
| ------------------------------------------ | --------------------------------- |
| Compose file parses                        | PASS                              |
| All required env vars have verified source | **FAIL** — 3 DB URLs unknown      |
| No hardcoded secrets                       | PASS                              |
| Service ports match running containers     | PASS                              |
| Network aliases match running containers   | PASS                              |
| Mounts match running containers            | PASS                              |
| Health checks match running containers     | PASS                              |
| No `down -v` or destructive operations     | PASS                              |
| Rollback image available                   | PASS (`phase-bp-20261018-095008`) |

## 3. Blocker

The candidate compose file cannot be deployed because the env mapping for `DATABASE_URL`, `MIGRATION_DATABASE_URL`, and `SUPERADMIN_DATABASE_URL` is unverified. These are constructed in the lost original compose file from `DRILL_*` passwords plus hostnames/usernames not present in `.env`.

## 4. Recovery path

1. Reconstruct the `environment:` block from the running container's full env (host-local, gitignored).
2. Update the candidate compose with verified `${DRILL_*}` references.
3. Run `docker compose config` and diff against running container spec.
4. Only deploy if all differences are resolved.

## 5. Safety

- No secret values printed or written to repository.
- No deployment attempted.
- No containers, volumes, or networks changed.
