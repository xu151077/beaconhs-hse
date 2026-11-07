# Phase DV-3 — Real CI trigger preparation

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Trigger conditions

`.github/workflows/ci.yml` runs on:

- `push` to `main`
- `pull_request` to `main`
- `workflow_dispatch`

This branch (`hse-platform`) is not `main` and no pull request exists. No workflow run has
been triggered for this commit.

## 2. Can CI run without a push?

No. GitHub Actions requires the commit to be reachable from a branch or PR on the remote.
`workflow_dispatch` also requires the workflow file to exist on the default branch or the
targeted branch on the remote. There is no alternative that avoids a push.

## 3. Required secrets and services

The `ci` job requires: `DATABASE_URL` (provided by the service), `MIGRATION_DATABASE_URL`,
`SUPERADMIN_DATABASE_URL`, `DATABASE_OWNER_ROLE`, `DATABASE_BACKUP_ROLE`, `REDIS_URL`,
`BETTER_AUTH_SECRET`, `ATTACHMENT_CAPABILITY_SECRET`, `BETTER_AUTH_URL`, `APP_URL`.
All are set in the workflow's job env with CI-only values. No production secret is used.

Services: Postgres 16 and Redis 7 (provided by the workflow). No external service is needed
for the core gates; the live DB suites run against the provisioned scratch databases.

## 4. First real CI run — expected checks

1. `pnpm format:check` → 0.
2. `pnpm typecheck` → 0 (27/27).
3. `pnpm lint` → 0.
4. `pnpm deadcode:check` → 0.
5. `pnpm --filter @beaconhs/db check:migration-drift` → 0.
6. Host safeguards (incl. `verify-server-action-key-gate.test.sh`) → 13/13.
7. `pnpm test` → 0, with 100 skips (41 DB, 38 object-store-backup, 13 auth, 8 web).
8. Four live DB projects → 0 skips: `db-owner` 14, `db-seeded` 40, `db-runtime` 36,
   `db-freeze` 16.
9. `pnpm build` → 0 (4/4).

## 5. Failure triage order

1. Confirm the branch was pushed and the run was triggered by `push`/`pull_request`/
   `workflow_dispatch`.
2. Check "Provision isolated owner, migration, and RLS roles" — role creation must succeed
   on a fresh Postgres.
3. Check "Provision isolated scratch databases" — `CREATE DATABASE` must succeed for all three.
4. Check "Migrate and seed the live-suite scratch databases" — migrations and seed.
5. Check the four "Live database suites" steps for skip counts and assertion failures.
6. Check "Test deployment host safeguards" for the key-gate test.
7. Check `pnpm test` for the 100 expected skips and any unexpected failure.
8. Check `pnpm build` for compilation errors.

## 6. Conclusion

- CI is **NOT RUN**. No push was performed.
- The workflow is correctly wired and has no bypass path.
- The first real run requires a push or PR, which is not permitted in this phase.
