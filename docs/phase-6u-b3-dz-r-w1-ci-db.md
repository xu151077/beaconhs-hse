# Phase DZ-R — W1: CI database test workflow acceptance

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Workflow review (read-only)

`.github/workflows/ci.yml` on the current tree:

- **Triggers**: `push` to `main`, `pull_request` to `main`, `workflow_dispatch`.
- **No bypass**: no `continue-on-error`, no step-level `if:`, no `|| true`.
- **Services**: Postgres 16 (`POSTGRES_USER=postgres`, `POSTGRES_DB=beaconhs_test`) and Redis 7,
  both with health checks.
- **Job env**: `DATABASE_URL`/`MIGRATION_DATABASE_URL`/`SUPERADMIN_DATABASE_URL` for
  `beaconhs_test`, `DATABASE_OWNER_ROLE`, `DATABASE_BACKUP_ROLE`, `REDIS_URL`,
  `BETTER_AUTH_SECRET`, `ATTACHMENT_CAPABILITY_SECRET`, `BETTER_AUTH_URL`, `APP_URL`.
- **Role provisioning**: `beaconhs_owner` (NOLOGIN), migrator/app/super/backup logins, grants on
  `beaconhs_test`, `ALTER SCHEMA public OWNER TO beaconhs_owner`.
- **Scratch provisioning** (new): creates `beaconhs_ci_owner`, `beaconhs_ci_seeded`,
  `beaconhs_ci_runtime` owned by `beaconhs_owner`, with the documented grants.
- **Migration/seed order**: `beaconhs_test` migrated twice (idempotency proof); all three
  scratch databases migrated with the unpooled migrator login; only `beaconhs_ci_seeded` seeded.
- **Live projects** (after `pnpm test`): `db-owner` (postgres/owner identity),
  `db-seeded` (app + super on the seeded database), `db-runtime` (app + super on the runtime
  database), `db-freeze` (super on the same runtime database). `db-runtime` and `db-freeze`
  share `beaconhs_ci_runtime` and are ordered sequentially.
- **Cleanup**: none — the scratch databases live in the job's ephemeral Postgres service and
  die with the runner.

Identity guard (`packages/db/src/testing/scratch-database.ts`): only database names containing
`test`, `scratch`, or `ci` as a segment are accepted; `postgres`/`template0`/`template1` are
refused; `storage-freeze-operations` additionally asserts that `DATABASE_URL` names the same
database as the gate.

## 2. Local execution of the same commands

Temporary databases (declared): `beaconhs_dxr_scratch_<ts>_{owner,seeded,runtime}` on the local
dev Postgres at `127.0.0.1:5433`; the existing `beaconhs` database and every container were
untouched; all three dropped afterwards.

| Project      | Result                         | Exit |
| ------------ | ------------------------------ | ---- |
| `db-owner`   | 14 passed, 0 skipped (85.6 s)  | 0    |
| `db-seeded`  | 40 passed, 0 skipped (1.9 s)   | 0    |
| `db-runtime` | 36 passed, 0 skipped (449.6 s) | 0    |
| `db-freeze`  | 16 passed, 0 skipped (1.0 s)   | 0    |

Migration and seed of the isolated databases: exit 0 (`docs/phase-6u-b3-dz-r-environment-recovery.md` §5).

**All 41 database assertions that CI previously skipped executed and passed with 0 skips.**

## 3. Live proof that the identity guard fails closed

Pointing the freeze suite at the isolated stack's own application database (`beaconhs`) was
**refused at import time**:

```
Error: [scratch-db] SEED_TEST_SCRATCH_DATABASE_URL points at "beaconhs", which is not an
isolated test database. Use a database whose name contains test, scratch, or ci as a segment.
 → Test Files 1 failed (1)   exit 1
```

After creating and migrating `beaconhs_dxr_scratch` inside the same isolated Postgres, the same
command passed: **16 passed, 0 skipped, exit 0**. The guard is therefore enforced, not
decorative, and it works against a real database.

## 4. CI status

**CI NOT RUN.** The branch `hse-platform` is not `main`, no pull request exists, and this phase
is not authorised to push. GitHub Actions has not executed this commit, so the workflow's own
scratch-database creation has not been observed on a runner. The local runs above execute the
same commands with the same credential classes.

Trigger steps for the first real run are in `docs/phase-6u-b3-dv-ci-trigger.md` §4–5.

## 5. Status

**W1: local PASS, CI NOT RUN.** Unchanged from the DT/DU conclusion — the local acceptance was
re-run on this tree and passed again, but the GitHub workflow has still never executed this
commit.
