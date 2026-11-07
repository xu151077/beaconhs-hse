# Phase DT — Final report (W1, W2, W3)

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Verification target: **the current working tree**, not a clean checkout of HEAD. The tree
contains the pre-existing Phase CX/DS changes plus the DT changes listed below.

## 1. Status summary

| Work item                                | Status                        | One-line                                                                                               |
| ---------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| W1 — DB test credibility in CI           | **PASS** (local) / CI NOT RUN | 5 live suites executed against isolated real databases, 0 skips; CI provisioned and wired              |
| W2 — Server Action key gate              | **PARTIAL**                   | Gate implemented, locally proven (image + 13 scenarios); live workflow and replica check not run       |
| W3 — File authorization denial semantics | **PARTIAL**                   | 500-as-refusal fixed across 32 routes; unit/contract pass; browser matrix, image, WOPI, freeze NOT RUN |

Overall verdict: **not release-ready.** Unchanged from DS.

## 2. W1 — DB test credibility

- 41 DB-backed assertions that were skipped in CI now run to 0 skips in the four explicit
  `db-*` project runs: `db-owner` 14, `db-seeded` 40, `db-runtime` 36, `db-freeze` 16
  (106 tests total).
- `packages/db/src/testing/scratch-database.ts` refuses a scratch URL whose database name is
  not an isolated test database, and refuses a `DATABASE_URL` that disagrees with the gate
  for the freeze suite.
- `.github/workflows/ci.yml` creates `beaconhs_ci_owner`, `beaconhs_ci_seeded`, and
  `beaconhs_ci_runtime`, migrates all three, seeds one, and runs each project with its
  required credential class. A failure fails the job.
- `pnpm test` still skips the DB suites by design (no scratch variables); CI now proves them.
- The bare local shell needs `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_URL`, and
  `REDIS_URL` for `db-runtime`; CI provides them. Documented in the runbook.
- 59 non-DB skips (object-store-backup 38, auth 13, web 8) remain, explicitly recorded as
  skipped, not as passing.
- Detail: `docs/phase-6u-b3-dt-w1-db-ci.md`.

## 3. W2 — Server Action key consistency gate

- `scripts/ci/verify-server-action-key-gate.sh` reuses the fingerprint primitive and adds
  `image`, `manifest`, `log`, `replica`, `replicas`, and `compare` modes. Exit codes 0/1/2.
- No key material is printed; temporary manifest and key files are removed.
- `.github/workflows/deploy-dev.yml` verifies the image before deploy and every running web
  replica after rollout, before the job reports success.
- `.github/workflows/ci.yml` runs `scripts/ci/verify-server-action-key-gate.test.sh` in the
  existing host-safeguards step.
- Evidence: 13/13 harness scenarios; 8/8 deployment-contract tests; real image extraction
  against `beaconhs:dr-mirror-51a899b7` passes with the correct fingerprint and exits 1 with
  a wrong one.
- Live workflow execution and multi-replica rollout NOT RUN (no push/deploy permitted).
- Detail: `docs/phase-6u-b3-dt-w2-key-gate.md`.

## 4. W3 — File authorization denial semantics

- `withRouteErrors` now maps `ForbiddenError` and `ImpersonationBlockedError` to 403; every
  other error rethrows (real 5xx preserved). The 403 body is generic and does not name the
  permission.
- Applied to all 32 permission-asserting routes (6 already wrapped + 26 in this phase),
  without rewriting handler bodies.
- Status contract: no session → redirect to `/login` (attachment route returns 401 before the
  capability check); authenticated without permission → 403; absent or RLS-hidden → 404;
  unexpected fault → 5xx.
- Wrapper unit 4/4 and source contract 2/2 pass; typecheck and lint pass.
- The CX spec no longer expects 500; it accepts only 403/404 and adds version and
  unauthenticated cases. It did not run.
- Browser/RBAC matrix, current release image, WOPI, and freeze scenarios NOT RUN.
- WOPI remains `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`.
- Detail: `docs/phase-6u-b3-dt-w3-file-authorization.md`.

## 5. Quality gates (current working tree)

| Gate                  | Result | Notes                                                                                                     |
| --------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`   | 0      | all matched files formatted                                                                               |
| `pnpm typecheck`      | 0      | 27/27 packages                                                                                            |
| `pnpm lint`           | 0      | 29 packages, `apps/web` only (pre-existing scope)                                                         |
| `pnpm test`           | 0      | 25/25 tasks; 3 793 + 9 web assertions passed; 100 skipped (41 DB, 38 object-store-backup, 13 auth, 8 web) |
| `pnpm deadcode:check` | 0      | knip clean                                                                                                |
| `pnpm build`          | 0      | 4/4 tasks                                                                                                 |

DB-specific runs (isolated): `db-owner` 14/0 skipped, `db-seeded` 40/0, `db-runtime` 36/0,
`db-freeze` 16/0.

## 6. Whether CI truly executes each gate

- The CI workflow runs `format:check`, `typecheck`, `lint`, `test`, `deadcode:check`, and
  `build` on every push to `main` (unchanged).
- The four live DB projects are now explicit steps with isolated databases; a failure fails
  the job. CI has not executed them because the branch is local and unpushed.
- The key-gate shell test runs in the existing host-safeguards step; the deploy gate runs in
  the deploy workflow. Neither has executed on GitHub.
- No Playwright/E2E job exists in CI; the CX spec is not executed there. Recorded as NOT RUN.

## 7. Whether all 41 DB assertions ran

Yes, in the four explicit project runs: 0 skips, and the 41 tests that were skipped in the
aggregate run are inside those projects. They did not run in the aggregate `pnpm test`, which
is intentional and documented.

## 8. Whether the key gate can really block release

Yes. The pre-deploy step runs `fingerprint --env` and `image` against the pushed image; a
non-zero exit stops the workflow before migrations and before deployment. The post-rollout
step checks every running web replica and fails the deployment on a mixed fleet. The
comparison is a 128-bit HMAC fingerprint; the key never reaches a log or artifact. The
blocking behaviour is proven by the local harness (13 scenarios) and the real image extraction
path, but GitHub Actions has not executed it.

## 9. File authorization matrix

See `docs/phase-6u-b3-dt-w3-file-authorization.md` §4. Summary: 16 surfaces, none marked
PASS for the browser matrix; 6 are PARTIAL (server side proven, browser not run) and 4 are
NOT RUN (DOCX import/edit/save, delete/replace, cross-tenant modify, freeze, WOPI). Server
authorization tests and unit/contract tests pass.

## 10. Remaining P1 / P2

- P1-4 WOPI: `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`. Unchanged.
- P2-9 drill stack containment/repair: awaits owner approval. Unchanged.
- P2 (file auth): browser/RBAC matrix, current release image, WOPI, freeze NOT RUN.
- P1 (DB/CI): first push must be watched for the new steps and the 41 assertions.
- P2 (key gate): live workflow and multi-replica rollout not demonstrated.

## 11. Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Branch: `hse-platform`
153 tracked files modified, 427 untracked files. No commit, push, reset, clean, restore, or
checkout was performed. The working tree retains the pre-existing 124 modified / 419
untracked files plus the DT edits.

## 12. Changed files (DT)

New files:

- `packages/db/src/testing/scratch-database.ts`
- `packages/db/src/testing/scratch-database.test.ts`
- `scripts/ci/verify-server-action-key-gate.sh`
- `scripts/ci/verify-server-action-key-gate.test.sh`
- `apps/web/src/lib/api/errors.test.ts`
- `apps/web/src/lib/api/route-error-contract.test.ts`
- `docs/phase-6u-b3-dt-w1-db-ci.md`
- `docs/phase-6u-b3-dt-w2-key-gate.md`
- `docs/phase-6u-b3-dt-w3-file-authorization.md`
- `docs/phase-6u-b3-dt-final-report.md`

Modified (tracked) by DT:

- `.github/workflows/ci.yml`
- `.github/workflows/deploy-dev.yml`
- `apps/web/src/lib/api/errors.ts`
- `apps/web/src/lib/authorization-residual-contract.test.ts`
- `apps/web/src/lib/download-audit-prefetch-contract.test.ts`
- `apps/web/src/lib/dynamic-uuid-route-guards.test.ts`
- `apps/web/src/lib/server-action-key-deployment-contract.test.ts`
- `packages/db/src/storage-freeze-operations.test.ts`
- `packages/db/src/tenant-provisioning.test.ts`
- `packages/db/src/tenant-reference-data.test.ts`
- `packages/db/src/seed-bootstrap-contract.test.ts`
- `packages/db/src/phase11e-seed-integrity.test.ts`
- `packages/db/vitest.config.ts`
- `docs/PRODUCTION_RUNBOOK.md`
- `docs/phase-6u-b3-cv-release-readiness.md`
- 26 route handlers under `apps/web/src/app/(app)` (see `docs/phase-6u-b3-dt-w3-file-authorization.md`)

Modified (untracked, pre-existing, edited by DT):

- `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts`

## 13. Temporary resource cleanup

- Three scratch databases created on the local dev Postgres and dropped after the gates:
  `beaconhs_dt_scratch_1792475929_{owner,seeded,runtime}`. Verified absent.
- One manifest extracted from `beaconhs:dr-mirror-51a899b7` into a temporary file and removed.
- No container, service, or production resource was created or modified. The existing
  `beaconhs-postgres` and `beaconhs-redis` containers were used read-only for the test runs.

## 14. Known risks

1. No CI run for this commit; first push must be watched for the new steps and the 41
   assertions.
2. Browser/RBAC matrix, release image, WOPI, and freeze scenarios are NOT RUN.
3. The `db-freeze` and `db-runtime` projects share `beaconhs_ci_runtime` and are ordered
   sequentially; parallelising them would destroy fixtures.
4. The identity guard is name-based; a real database deliberately named with `test`/`scratch`/
   `ci` would pass. Isolated databases must still be created per run.
5. `lint` covers only `apps/web` (pre-existing scope limitation, not changed by DT).
