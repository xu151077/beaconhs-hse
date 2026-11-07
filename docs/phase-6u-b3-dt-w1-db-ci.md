# Phase DT-W1 — Make the live database suites actually run in CI

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Verification target: **the current working tree**, not a clean checkout of HEAD. The tree
contains the pre-existing Phase CX/DS changes plus the DT changes listed below.

## 1. The defect

Five `@beaconhs/db` suites talk to a real PostgreSQL. Each one is gated on
`SEED_TEST_SCRATCH_DATABASE_URL`; when it is unset, the suite skips its database scenarios
loudly instead of failing.

`.github/workflows/ci.yml` never set that variable. The aggregate `pnpm test` therefore
reported **41 database-backed assertions as skipped** on every CI run:

| Suite                       | DB assertions skipped | Project      |
| --------------------------- | --------------------: | ------------ |
| `seed-bootstrap-contract`   |                     4 | `db-owner`   |
| `phase11e-seed-integrity`   |                     4 | `db-seeded`  |
| `tenant-provisioning`       |                    15 | `db-runtime` |
| `tenant-reference-data`     |                     4 | `db-runtime` |
| `storage-freeze-operations` |                    14 | `db-freeze`  |
| **Total**                   |                **41** |              |

The suites are mutually destructive: `seed-bootstrap-contract` truncates every tenant table
and finishes with no tenant, while `phase11e` asserts on the seeded demo rows. A single
database cannot satisfy both.

## 2. What changed

### 2.1 Explicit database identity guard

New: `packages/db/src/testing/scratch-database.ts`

The old precondition was "the variable is set". That is not enough: exporting the development
URL would destroy it and the run would still look like a pass. The guard now validates the
**identity** of the target:

- the URL must be `postgres://` or `postgresql://`;
- the database name must contain `test`, `scratch`, or `ci` as a name segment;
- `postgres`, `template0`, and `template1` are refused;
- an unset variable still means "skip", preserving `pnpm test` on a machine without Postgres;
- a set but unsafe variable **throws at import time**, so the suite fails instead of skipping.

All five suites now resolve their scratch URL through the guard. The owner and superadmin
companion URLs are validated too. `storage-freeze-operations` additionally asserts that the
shared `db` client's `DATABASE_URL` names the **same database** as the scratch URL, because
that suite writes through `db` rather than through its gate.

### 2.2 A project for the freeze suite

`packages/db/vitest.config.ts` previously ran `storage-freeze-operations` inside the generic
`unit` project, where its 14 database assertions skipped with no indication that a live
credential class was missing. It is now the `db-freeze` project, excluded from `unit` and run
with a BYPASSRLS identity on the runtime scratch database.

### 2.3 CI provisioning and execution

`.github/workflows/ci.yml` now:

1. creates three isolated databases owned by `beaconhs_owner` —
   `beaconhs_ci_owner`, `beaconhs_ci_seeded`, `beaconhs_ci_runtime` — with the same grants
   the runbook documents;
2. migrates all three;
3. seeds only `beaconhs_ci_seeded`;
4. runs each project explicitly with its required credential class:

| Step         | Identity                                             | Starting state          |
| ------------ | ---------------------------------------------------- | ----------------------- |
| `db-owner`   | `postgres` (owner-capable, TRUNCATE)                 | migrated only           |
| `db-seeded`  | `beaconhs_app` reads / `beaconhs_super` cross-tenant | migrated **and** seeded |
| `db-runtime` | `beaconhs_app` + `beaconhs_super`                    | migrated only           |
| `db-freeze`  | `beaconhs_super` (BYPASSRLS) on the same DB          | migrated only           |

The database names deliberately contain `ci`, which is what the identity guard requires. A
misconfigured step that points at `beaconhs` fails closed before any row is touched.

`pnpm test` itself still leaves the scratch variables unset. That is intentional: the
aggregate run must stay usable on a machine without Postgres, and CI now proves the suites in
explicit steps whose failure is a job failure.

## 3. Local acceptance run

Scope declaration for the run: **three newly created databases** on the local dev Postgres at
`127.0.0.1:5433`, named `beaconhs_dt_scratch_<timestamp>_{owner,seeded,runtime}`. Isolation:
only those databases were created and written; the existing `beaconhs` database and every
container were left untouched. Cleanup: the three databases are dropped after the gates (see
the final report).

### 3.1 Setup

- Created the three databases owned by `beaconhs_owner` and applied the runbook grants.
- Migrated all three with the unpooled `beaconhs_migrator` login (`SET ROLE beaconhs_owner`).
- Seeded `beaconhs_dt_scratch_*_seeded` with the real `src/seed.ts`.
- Exit code 0 for the migration/seed script.

### 3.2 Results

All commands were run on the current tree. Exit codes are the process exit codes.

| Project      | Command                                      | Result                   | Exit |
| ------------ | -------------------------------------------- | ------------------------ | ---- |
| `db-owner`   | `vitest run --project db-owner`              | **14 passed**, 0 skipped | 0    |
| `db-seeded`  | `vitest run --project db-seeded`             | **40 passed**, 0 skipped | 0    |
| `db-runtime` | `vitest run --project db-runtime` (full env) | **36 passed**, 0 skipped | 0    |
| `db-freeze`  | `vitest run --project db-freeze`             | **16 passed**, 0 skipped | 0    |

Totals: **106 tests passed, 0 skipped** across the four projects. The 41 assertions that were
skipped in the aggregate run are inside these projects and therefore executed.

This includes the high-risk paths:

- `seed-bootstrap-contract` ran the real seed against an owner-capable database and truncated
  every tenant table between scenarios;
- `tenant-provisioning` ran the real CLI as a subprocess and exercised the RLS-bound
  create/delete paths;
- `tenant-reference-data` asserted the catalogue and reference data under runtime RLS;
- `phase11e` asserted the seeded Fire / Environment / Calibration / Statutory rows and the
  negative "no shadow module" structures;
- `storage-freeze-operations` asserted optimistic concurrency, lease exclusivity, and audit
  writing against a real database.

### 3.3 The one prerequisite the run exposed

The first `db-runtime` attempt failed 2 tests. The failure was **not** a product fault: the
suite drives `bootstrap-admin.cli.ts` with `NODE_ENV=production`, which requires
`BETTER_AUTH_SECRET`, and it queues a magic-link job, which requires `REDIS_URL`. A bare
local shell had neither. CI already provided both at the job level.

After adding the same values CI provides, the full `db-runtime` project passed 36/36. The
runbook now documents these non-DB prerequisites so a local operator does not repeat the
investigation. This is a test-environment prerequisite, not a database or authorization
weakening.

## 4. What is still skipped, and why

`pnpm test` still reports **59 non-database skips**:

- 38 in the object-store backup suite — needs a real S3-compatible endpoint;
- 13 in the auth package — needs a running auth/provider stack;
- 8 in the web package — opt-in integration cases.

Those are outside W1 (database credibility). They remain explicitly recorded as skipped, not
as passing. The 41 DB skips are now zero in the explicit CI project runs.

## 5. Honest status

**W1: PASS for local execution and CI wiring; the CI run itself is NOT RUN.**

- All five live suites executed against isolated real databases with the intended credential
  classes and **0 skips**.
- The CI workflow contains the provisioning and four explicit project steps; a failure in any
  suite fails the job.
- CI has not executed this commit: the branch is local and this phase forbids pushing. The
  first push must be watched for the new steps.
- The CI steps mirror the commands verified locally, including the `BETTER_AUTH_SECRET` and
  `REDIS_URL` prerequisites.

## 6. Residual risks

1. **Name-based identity guard.** A real database deliberately named `..._test` would pass
   the guard. The guard is a last line of defence, not a substitute for creating isolated
   databases; the CI workflow creates dedicated databases by name.
2. **Superuser for the owner/seeded suites.** The owner suite needs `TRUNCATE` and a
   BYPASSRLS identity, and the CI service only provides the `postgres` superuser. This is
   confined to the throwaway `beaconhs_ci_*` databases; the runtime suite still proves RLS
   with `beaconhs_app` and `beaconhs_super`.
3. **CI duration.** The four live projects add several minutes (the runtime suite alone took
   about 7 minutes locally). That is the cost of no longer skipping 41 assertions.
4. **No parallel project runs against the same database.** `db-runtime` and `db-freeze` share
   `beaconhs_ci_runtime` and are ordered sequentially in the workflow; a future matrix that
   parallelises them would destroy fixtures.
