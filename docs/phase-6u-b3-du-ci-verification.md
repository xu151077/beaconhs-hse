# Phase DU-1 — CI workflow verification

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Verification target: **the current working tree** (HEAD `51a899b7…` plus the DT edits).

## 1. Workflow audit: `.github/workflows/ci.yml`

Reviewed the full file. Findings:

- **Triggers**: `push` to `main`, `pull_request` to `main`, `workflow_dispatch`. No `continue-on-error`, no `if:` guards on steps, no `|| true`, no `--passWithNoTests` on the live DB steps.
- **Services**: Postgres 16 + Redis 7 on localhost. Health checks on both.
- **Job env**: `DATABASE_URL`/`MIGRATION_DATABASE_URL`/`SUPERADMIN_DATABASE_URL` for `beaconhs_test`; `REDIS_URL`; `BETTER_AUTH_SECRET`; `ATTACHMENT_CAPABILITY_SECRET`; `BETTER_AUTH_URL`; `APP_URL`. The live `db-runtime` step inherits all of these from the job env.
- **Role provisioning**: creates `beaconhs_owner` (NOLOGIN), migrator, app, super, backup; grants on `beaconhs_test`. Idempotent only on a fresh container (expected for CI).
- **Scratch DB provisioning**: creates `beaconhs_ci_owner`/`_seeded`/`_runtime` owned by `beaconhs_owner`, with the documented grants. Names contain `ci`, satisfying the identity guard.
- **Migration**: `beaconhs_test` migrated twice (idempotency proof); all three scratch DBs migrated; `beaconhs_ci_seeded` seeded.
- **Order**: format → typecheck → lint → deadcode → migration-drift → host safeguards (incl. key-gate test) → migrate → idempotency → migrate/seed scratch → `pnpm test` → four live DB projects → build. A failure at any step stops the job.
- **Live DB steps**: each sets the correct credential class and scratch URL; `db-runtime` and `db-freeze` share `beaconhs_ci_runtime` and are ordered sequentially (not parallel).
- **No cleanup step**: the scratch databases are not dropped at the end. Acceptable because the Postgres service container is destroyed with the job; the databases never reach a shared host.
- **No bypass path found** for any of the six gates or the four live DB projects.

## 2. CI status

**CI NOT RUN.**

This branch is local and unpushed. `.github/workflows/ci.yml` triggers on `push` to `main` or `pull_request` to `main` or `workflow_dispatch`. None of these has run for this commit. The branch is not on `main` and no PR exists.

### Trigger conditions and steps

1. Push this branch to a fork or open a pull request against `main` (requires owner authorisation).
2. Or run `workflow_dispatch` from the GitHub Actions UI on the pushed branch.
3. Watch the `ci` job for the new steps:
   - "Provision isolated scratch databases for live DB suites"
   - "Live database suites — seed bootstrap (owner identity)"
   - "Live database suites — seeded integrity"
   - "Live database suites — tenant and RLS isolation"
   - "Live database suites — storage freeze persistence"
   - "Test deployment host safeguards" (includes `verify-server-action-key-gate.test.sh`)
4. Confirm the four live DB steps report 0 skips and the counts match §3 of
   `docs/phase-6u-b3-dt-w1-db-ci.md` (14, 40, 36, 16).

Do not claim W1 is CI-verified until those steps run green. The local runs in DT are the
current evidence.

## 3. Local-to-CI parity

Every CI step was reproduced locally against three isolated databases with the same
credentials and the same commands, including the `BETTER_AUTH_SECRET`/`REDIS_URL`
prerequisites that a bare shell lacks. Results: 14 + 40 + 36 + 16 = 106 tests, 0 skips,
exit 0. Logs: `/tmp/opencode/dt-w1-*.log`.

## 4. Conclusion

- W1: **local PASS, CI NOT RUN**. The workflow is correctly wired and contains no bypass
  path, but it has not executed on GitHub.
- No change to the "not release-ready" verdict.
