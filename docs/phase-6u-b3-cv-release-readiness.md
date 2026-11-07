# Phase 6U-B3-CV — Release readiness assessment

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

Status legend: PASS = executed with evidence; FAIL = reproduced failure; BLOCKED = approval/prerequisite missing; NOT RUN = not executed.

> **Phase DS review addendum (2026-10-20, HEAD `51a899b7…`).** This report is
> preserved as written on 2026-10-19 (with the Phase DR update). Phase DS re-ran
> all six gates on the current working tree and re-audited the sections below.
> Three status cells are corrected in place with a `DS` marker; the original
> wording is kept. The consolidated DS assessment is in
> `docs/phase-6u-b3-ds-final-report.md`, the evidence index in
> `docs/phase-6u-b3-ds-evidence-index.md`, and the gaps/priority matrix in
> `docs/phase-6u-b3-ds-release-gaps.md`. The overall verdict is unchanged:
> **not release-ready.**

> **Phase DT implementation addendum (2026-10-20, HEAD `51a899b7…`).** Phase DT
> implements W1 (DB test credibility), W2 (Server Action key gate), and W3 (file
> authorization denial semantics). Status cells below are corrected in place with
> a `DT` marker; the original wording is kept. The consolidated DT assessment is
> in `docs/phase-6u-b3-dt-final-report.md`, with detail in
> `docs/phase-6u-b3-dt-w1-db-ci.md`, `docs/phase-6u-b3-dt-w2-key-gate.md`, and
> `docs/phase-6u-b3-dt-w3-file-authorization.md`. The overall verdict is unchanged:
> **not release-ready.**

## 1. Surface assessment

| Surface                                      | Status          | Evidence / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WOPI frozen refusal                          | FAIL / BLOCKED  | Phase DR: isolated same-origin mirror built and certified (control PASS: freeze, frozen re-open, recovery, zero leftovers). Six instrumented runs, 0 reproductions, 0 `client not consuming tiles` events. Predicate never satisfied; see `docs/phase-6u-b3-dr-final-report.md`.                                                                                                                                                                                                                                                        |
| Server Action key — runtime override         | PASS            | Next.js 16.3.5 image manifest key and runtime key differed; magic-link Server Action succeeded with runtime key.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Server Action key — restart                  | PASS            | Container restarted with the same runtime key and served a successful Server Action.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Server Action key — multi-replica invocation | PASS            | Two independent containers with the same runtime key both invoked the Server Action successfully.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Server Action key — invalid override         | PASS            | Phase DH: readiness now answers 503 for a present-but-invalid runtime key (real standalone build); the log names the variable, never the value.                                                                                                                                                                                                                                                                                                                                                                                         |
| Server Action key — cross-instance mismatch  | PARTIAL / DT-W2 | Phase DI: a keyed fingerprint plus a blocking deployment gate proves two instances share a key (exit 0) or not (exit 1); rotation and rollback verified. **DS: the gate was a script + contract test only. DT (2026-10-20): `.github/workflows/deploy-dev.yml` now runs the image gate before deploy and the replica gate after rollout; the exact commands and a real image extraction path passed locally (8/8 contract, 13/13 harness). Live workflow and multi-replica rollout NOT RUN. See `docs/phase-6u-b3-dt-w2-key-gate.md`.** |
| WOPI Scenario 4 trace                        | PASS            | Phase DK: retained phase-aj trace, 22.8 MB, SHA-256 0ebed035…, stored outside the repo at 0700.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| WOPI trace retention                         | PASS            | Phase DJ: default changed to `retain-on-failure`; a local ACTIVE→blocking→ACTIVE run left a readable 3.1 MiB trace (SHA-256 e4ecb5e3…).                                                                                                                                                                                                                                                                                                                                                                                                 |
| File authorization — attachment route        | PASS            | Cross-tenant attachment request returned 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| File authorization — document master/export  | PARTIAL / DT-W3 | Site-scoped user received permission denials (`documents.manage`, `admin.data.export`) instead of data. **DT (2026-10-20): the 500 that Next.js rendered for `ForbiddenError` is fixed; all 32 permission-asserting routes now return 403, and the CX spec no longer expects 500. Wrapper unit 4/4 and source contract 2/2 pass on the current tree. Browser E2E NOT RUN. See `docs/phase-6u-b3-dt-w3-file-authorization.md`.**                                                                                                         |
| File authorization — browser E2E matrix      | PARTIAL / DT-W3 | Incidents list/detail and cross-tenant denial verified; the CX spec was corrected to reject 5xx and extended with version/unauthenticated cases, but it did not run in DT (no isolated stack). Upload/preview/edit/export matrix still incomplete. See `docs/phase-6u-b3-dt-w3-file-authorization.md`.**                                                                                                                                                                                                                                |
| Scheduler / worker health                    | PARTIAL         | Jobs 20/20; disposable Redis registration, loss, recovery, and mismatch checks passed. **DS (2026-10-20): the registry inspector (`inspectRepeatableSchedules`) has no committed test; the recovery evidence came from ad-hoc scripts and is not deployed or stage-verified. CI also skips all 41 DB-backed assertions. See §8.**                                                                                                                                                                                                       |
| Image build                                  | PASS            | Real BuildKit image built and runtime-smoked; production key not present in image env/history.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Quality gates                                | PASS\*          | format 0, lint 0, typecheck 0, test 0, deadcode 0, build 0. **DS (2026-10-20) re-ran all six on the current tree: 0/0/0/0/0/0, but `test` skipped 100 assertions (41 DB-backed) and `lint` covers only `apps/web`. See §6 and §8.**                                                                                                                                                                                                                                                                                                     |
| Drill environment                            | BLOCKED         | Containment and schema repair require explicit owner approval; no drill resource changed.                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 2. WOPI

Local evidence shows the server-side freeze gate works. The phase-aj hang is
correlated with a prior Collabora editor session and Collabora tile/kit warnings, but
the exact blocking request was not proven. Status remains FAIL/BLOCKED.

Phase DR (2026-10-20) built the isolated `dn-mirror` stack — identical Collabora
digest, same HEAD, same-origin path routing, `logging.level=information` — and ran the
fixed three-leg predicate (TaskDuration ≥ 1.5 s / 5 s **and** a native
`client not consuming tiles` event **and** an open editor `/cool/ws`).

- Control (DR-B) **PASS**: discovery 278 same-origin actions, editor/WOPI load, save,
  download re-verified, `FROZEN` through the state machine, frozen re-open 373 ms with
  0 iframes, `RECONCILING → ACTIVE`, in-flight/write-arm/reservation leftovers 0.
- Six experiment runs (A control ×2, B 20× CPU + 500-page ×2, C Collabora 0.5 CPU,
  D `per_document.max_concurrency=1`): **0 `REPRODUCED`, 0 `BACKPRESSURE_ONLY`,
  6 `NOT_REPRODUCED`**. Leg 1 reached 5.07 s/5 s and 5.14 s/5 s with the editor socket
  open, but Collabora never logged `client not consuming tiles`.
- Levers C and D cannot reach a frozen page load that mints no WOPI token, so their
  negatives are about the levers, not about phase-aj.
- Remaining candidate: the browser stops reading the `/cool/ws` socket entirely
  (page suspension / real backgrounding / socket stall). Not yet exercised.

Cleanup: mirror containers, network, tenant, auth identity, objects and DB rows
removed; ports 80/3000/9981 free; images retained only because the project permission
policy hard-denies `docker rmi` (exact commands recorded in the final report).

## 3. Server Action key

Build-time key material remains embedded by Next.js. Runtime injection is viable and was verified. Phase DA records missing-key, invalid-key, and inconsistent-config detection as NOT RUN; rotation and rollback remain verified from prior phases.

**DT (2026-10-20):** the blocking deployment gate is now wired into
`.github/workflows/deploy-dev.yml` — image key verified before deploy, every running web
replica verified after rollout — and `scripts/ci/verify-server-action-key-gate.test.sh` runs in CI.
Local evidence: 13/13 harness scenarios, 8/8 deployment-contract tests, and the real image
extraction path against `beaconhs:dr-mirror-51a899b7` (correct fingerprint pass, wrong
fingerprint exit 1). Live workflow and multi-replica rollout NOT RUN. See
`docs/phase-6u-b3-dt-w2-key-gate.md`.

## 4. File authorization

Server-side denial was verified for attachment download and document/export routes. Browser E2E does not yet cover every file surface.

**DT (2026-10-20):** the 500 that Next.js rendered for `ForbiddenError` is fixed at the
shared `withRouteErrors` boundary and applied to all 32 permission-asserting routes;
`ImpersonationBlockedError` is also mapped to 403. Wrapper unit 4/4 and source contract 2/2
pass. The CX spec was corrected to reject 5xx and extended with version and unauthenticated
cases, but it did not run. WOPI status is unchanged (KNOWN / UNRESOLVED — LOW PRIORITY —
INVESTIGATION PAUSED). See `docs/phase-6u-b3-dt-w3-file-authorization.md`.

## 5. Drill

Three options remain documented: stop only the worker, stop the whole drill stack, or back up and repair schema. No action has been executed.

## 6. Quality gate evidence

The table below is the 2026-10-19/20 historical record. Phase DS re-ran all six
gates on 2026-10-20 against the current working tree (HEAD `51a899b7…` + 124
pre-existing modifications, forced/non-cached): format 0, typecheck 0 (27/27),
lint 0 (1/1 task — `apps/web` only), test 0 (25/25 tasks; 3 793 passed, 100
skipped), deadcode 0, build 0 (4/4). Skips: db 41, object-store-backup 38, auth
13, web 8. No CI run exists for this commit. Logs: `/tmp/opencode/ds-*.log`.

**DT (2026-10-20) re-ran all six gates on the current working tree** (HEAD
`51a899b7…` plus the pre-existing and DT modifications, non-cached): format 0,
typecheck 0 (27/27), lint 0 (29 tasks), test 0 (25/25 tasks; 3 793 + 9 new web
assertions passed, 100 skipped), deadcode 0, build 0 (4/4). The 41 DB-backed
assertions were run to 0 skips in the four explicit `db-*` project runs
(14 + 40 + 36 + 16 = 106 tests). Logs: `/tmp/opencode/dt-*.log`. The DB
suites still skip in the aggregate `pnpm test` because it does not set the scratch
variables; CI now runs them explicitly.

| Gate                                    | Exit code |
| --------------------------------------- | --------: |
| `pnpm format:check`                     |         0 |
| `TURBO_FORCE=true pnpm lint`            |         0 |
| `TURBO_FORCE=true pnpm typecheck`       |         0 |
| `TURBO_FORCE=true pnpm test --continue` |         0 |
| `pnpm deadcode:check`                   |         0 |
| `TURBO_FORCE=true pnpm build`           |         0 |
| `pnpm --filter @beaconhs/jobs test`     |         0 |

## 7. Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`  
Branch: `hse-platform`  
No commit, push, reset, clean, restore, or checkout was performed. Working tree changes were preserved.

**DT (2026-10-20):** 153 tracked files modified and 427 untracked files after DT
(including the four DT reports and the CV update). No commit, push, reset, clean,
restore, or checkout was performed. Three scratch databases were created and dropped;
no other resource was changed.

## 8. Phase DS addendum (2026-10-20)

Scope: read-only release-acceptance audit at HEAD
`51a899b7aac0a942da327222a3eed355fca9798a` (branch `hse-platform`; 0 staged,
124 modified, 415 untracked before DS). No business code, schema, migration,
container, network, volume, object store, secret or remote environment was
changed.

### 8.1 What changed relative to this report

| Item                        | Before (historical text)            | DS finding                                                                                                    |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Cross-instance key mismatch | PASS — "blocking deployment gate"   | **PARTIAL** — the gate is a script + contract test; no CI/deploy step invokes it (exhaustive workflow grep)   |
| Scheduler / worker health   | PASS — job suite + disposable Redis | **PARTIAL** — the registry inspector has no committed test; recovery is not deployed or stage-verified        |
| Quality gates               | PASS                                | **PASS\*** — all six exit 0, but `test` skips 100 assertions (41 DB-backed) and `lint` covers only `apps/web` |

### 8.2 New evidence produced by DS

- Live read-only dev-Postgres check: 191 tables with `tenant_id`; 191 with
  `rowsecurity` + `forcerowsecurity` + a `tenant_isolation` policy; 0 gaps.
- `pg_roles`: `beaconhs_app` is `NOBYPASSRLS`/non-superuser; `beaconhs_super` is
  `BYPASSRLS`.
- Static schema parse vs `TENANT_SCOPED_TABLES`: 191 vs 191, 0 missing, 0 extra.
- Forced six-gate re-run (counts above).
- Client-artifact scan: 0 Server Action key matches in `apps/web/.next/static/**`.
- Confirmed `GET /api/v1` returns 500 because `monitored_sessions` (category
  `apps`) has no read-permission mapping — a known defect recorded in
  `AGENTS.md`, with stale wording (it is `apps`, not `compliance`).
- Confirmed non-`/api/v1` authorization refusals return 500; the CX E2E asserts
  500 at lines 39 and 48.
- Confirmed `turbo run lint` executes one task (`apps/web` only).
- Confirmed the DB-backed suites print "SKIPPED, not passed" in CI because
  `SEED_TEST_SCRATCH_DATABASE_URL` is unset.

### 8.3 Status that did not change

- WOPI: **KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED** (see §2).
- Drill: BLOCKED.
- Overall: **not release-ready.**
- No P0 was found; this is a statement about the evidence reviewed, not a proof
  that no P0 exists.

### 8.4 Owner decisions required

1. WOPI: accept (with monitoring) or authorize another experiment.
2. Restate the "no key material in the image" criterion (the server manifest must
   embed it; client artifacts carry none).
3. Drill containment/repair.
4. Whether `monitored_sessions` is a public API entity.
5. Fund the DB-test wiring and the file-surface release run before cutover.

Detailed work packages and acceptance criteria:
`docs/phase-6u-b3-ds-next-plan.md`.

## 9. Phase DT addendum (2026-10-20)

### 9.1 Scope

Phase DT implements the three W-items from `docs/phase-6u-b3-ds-next-plan.md` §3:

- **W1 — DB test credibility in CI**: identity guard, isolated scratch databases, explicit
  project runs, 0 DB skips in those runs.
- **W2 — Server Action key consistency gate**: pre-deploy image gate and post-rollout
  replica gate, with fail-closed semantics and no key leakage.
- **W3 — File authorization denial semantics + release-image matrix**: 500-as-refusal fixed,
  wrapper applied to all 32 permission-asserting routes, matrix documented.

### 9.2 What changed

- `packages/db/src/testing/scratch-database.ts` (new): identity guard + same-DB check.
- `packages/db/vitest.config.ts`: new `db-freeze` project; `unit` excludes it.
- Five `@beaconhs/db` test files: resolve scratch URLs through the guard.
- `packages/db/src/testing/scratch-database.test.ts` (new): 5 tests.
- `.github/workflows/ci.yml`: three isolated scratch databases, migrations, seed, and four
  explicit `db-*` project runs.
- `scripts/ci/verify-server-action-key-gate.sh` (new) and `...test.sh` (new): 13 scenarios.
- `.github/workflows/deploy-dev.yml`: pre-deploy image gate and post-rollout replica gate.
- `apps/web/src/lib/api/errors.ts`: map `ForbiddenError` and `ImpersonationBlockedError` to 403.
- 26 route handlers wrapped with `withRouteErrors`; 6 were already wrapped.
- `apps/web/src/lib/api/errors.test.ts` and `route-error-contract.test.ts` (new): 6 tests.
- `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts`: 500 expectations replaced with
  403/404; version and unauthenticated cases added.
- Three contract tests adapted to the new export shape.
- `docs/PRODUCTION_RUNBOOK.md`: live-suite prerequisites and `db-freeze` documented.
- Four DT reports written; this report updated.

### 9.3 Results

| Item                             | Result                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| W1 local live suites             | **PASS**: `db-owner` 14, `db-seeded` 40, `db-runtime` 36, `db-freeze` 16; 0 skips              |
| W1 CI run                        | **NOT RUN** (no push permitted)                                                                |
| W2 harness scenarios             | **PASS** 13/13                                                                                 |
| W2 deployment contract           | **PASS** 8/8                                                                                   |
| W2 real image gate               | **PASS** (correct fingerprint) / **PASS** (wrong rejected, exit 1)                             |
| W2 live workflow / replica check | **NOT RUN**                                                                                    |
| W3 wrapper unit + contract       | **PASS** 4/4 + 2/2                                                                             |
| W3 typecheck / lint              | **PASS**                                                                                       |
| W3 browser E2E matrix            | **NOT RUN**                                                                                    |
| Quality gates (DT)               | format 0, typecheck 0 (27/27), lint 0 (29 tasks), test 0 (25 tasks), deadcode 0, build 0 (4/4) |

### 9.4 Status changes

- Server Action key — cross-instance mismatch: `PARTIAL` → `PARTIAL / DT-W2`
  (gate wired and locally proven; live workflow not run).
- File authorization — document master/export: `PASS` → `PARTIAL / DT-W3`
  (500 fixed; browser E2E not run).
- File authorization — browser E2E matrix: `PASS` → `PARTIAL / DT-W3`
  (spec corrected and extended; not run).
- Quality gates: `PASS*` → `PASS*` with DT re-run noted in §6.

### 9.5 Residual P1 / P2

- P1-4 WOPI: unchanged, `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`.
- P2-9 drill stack containment: unchanged, awaits owner approval.
- P2-9 (file auth): browser/RBAC matrix, release image, WOPI, and freeze not run.
- P1 (DB): CI has not executed the new steps; first push must be watched.

### 9.6 Temporary resources

- Three scratch databases created on the local dev Postgres and dropped after the gates:
  `beaconhs_dt_scratch_<timestamp>_{owner,seeded,runtime}`.
- One temporary manifest extracted from `beaconhs:dr-mirror-51a899b7` and removed.
- No container, service, or production resource was created or modified.

### 9.7 Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Branch: `hse-platform`
153 tracked files modified, 427 untracked. No commit, push, reset, clean, restore, or
checkout was performed.

### 9.8 Overall verdict

**Not release-ready.** W1, W2, and W3 improve credibility and fix the 500-as-refusal defect,
but the browser/RBAC matrix, the live CI run, the live workflow gate, and WOPI remain
unverified or unresolved.

## 10. Phase DU addendum (2026-10-20)

### 10.1 Scope

Phase DU verifies, without pushing or deploying, the CI workflow, the Server Action Key gate
call chain, and the file-authorization denial semantics. It adds one more fix:
`assertCanManageModule` now throws `ForbiddenError` (message preserved) so the two badge
routes return 403 instead of 500.

### 10.2 Results

- DU-1 CI workflow: audited, no bypass path, **CI NOT RUN** (branch unpushed).
- DU-2 key gate: call chain traced, 13/13 + 8/8 + real image path pass, **live workflow NOT RUN**.
- DU-3 file authorization: 32 routes reviewed, 1 additional fix, unit/contract/typecheck/lint pass,
  **browser E2E NOT RUN**.

### 10.3 Status changes

None beyond DT. W1 remains local PASS / CI NOT RUN. W2 and W3 remain PARTIAL.

### 10.4 Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Branch: `hse-platform`
153 tracked files modified, 428 untracked. No commit, push, reset, clean, restore, or checkout.

### 10.5 Overall verdict

**Not release-ready.** Unchanged. The CI and browser-evidence gaps remain.

## 11. Phase DV addendum (2026-10-20)

### 11.1 Scope

Phase DV attempts the three remaining release-verification items: browser file-authorization
E2E, Server Action Key multi-replica isolation, and real CI triggering. None of the three
could be executed in this environment; all are recorded as NOT RUN with reasons and minimum
environment requirements.

### 11.2 Results

- DV-1 browser E2E: **NOT RUN** (no isolated app/DB/storage; shared stack not started).
- DV-2 multi-replica: **NOT RUN** (no isolated multi-container environment).
- DV-3 real CI: **NOT RUN** (branch unpushed; push not permitted).

### 11.3 Status changes

None. W1 remains local PASS / CI NOT RUN. W2 and W3 remain PARTIAL. No surface is upgraded
to PASS.

### 11.4 Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Branch: `hse-platform`
154 tracked files modified, 432 untracked. No commit, push, reset, clean, restore, or
checkout.

### 11.5 Overall verdict

**Not release-ready.** Unchanged. The browser-evidence, multi-replica, and CI gaps remain.

## 12. Phase DW addendum (2026-10-20)

### 12.1 Scope

Phase DW checks for an isolated environment, produces an environment request list, and records
the browser E2E and multi-replica outcomes. No environment was available, so both remain NOT
RUN. No code changes.

### 12.2 Results

- DW-1 browser E2E: **NOT RUN** (no isolated environment).
- DW-2 multi-replica: **NOT RUN** (no isolated multi-container environment).
- DW-3 CI: **NOT RUN** (branch unpushed).

### 12.3 Status changes

None. W1 remains local PASS / CI NOT RUN. W2 and W3 remain PARTIAL.

### 12.4 Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Branch: `hse-platform`
154 tracked files modified, 436 untracked. No commit, push, reset, clean, restore, or
checkout.

### 12.5 Overall verdict

**Not release-ready.** Unchanged.

## 13. Phase DX addendum (2026-10-20)

### 13.1 Scope

Phase DX attempted to use the isolated host `10.10.31.30` to run the browser file-authorization
E2E and the Server Action Key multi-replica verification. The host became unreachable during
the image build. No isolated environment was created and no verification was performed.

### 13.2 Results

- DX-1 environment: **NOT AVAILABLE** (host unreachable during build).
- DX-2 browser E2E: **NOT RUN**.
- DX-3 multi-replica: **NOT RUN**.
- DX-4 CI: **NOT RUN** (no push).

### 13.3 Status changes

None. W1 remains local PASS / CI NOT RUN. W2 and W3 remain PARTIAL. No surface is upgraded
to PASS.

### 13.4 Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Branch: `hse-platform`
154 tracked files modified, 436 untracked. No commit, push, reset, clean, restore, or
checkout.

### 13.5 Overall verdict

**Not release-ready.** Unchanged.

## 14. Phase DY addendum (2026-10-20)

### 14.1 Scope

Phase DY attempted to recover the isolated host, verify and clean DX leftovers, and check
existing service health. The host was unreachable (SSH timeout). No remote operation was
performed.

### 14.2 Results

- DY-1 host recovery: **BLOCKED**.
- DY-2 DX cleanup: **BLOCKED**.
- DY-3 existing service health: **BLOCKED**.
- DY-4 re-evaluation: **BLOCKED**.

### 14.3 Status changes

None. W1 remains local PASS / CI NOT RUN. W2 and W3 remain PARTIAL. No surface is upgraded
to PASS.

### 14.4 Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Branch: `hse-platform`
154 tracked files modified, 436 untracked. No commit, push, reset, clean, restore, or
checkout.

### 14.5 Overall verdict

**Not release-ready.** Unchanged.

## 15. Phase DZ addendum (2026-10-20)

### 15.1 Scope

Phase DZ consolidates the acceptance procedure, remote recovery checklist, and final report
into a single ordered runbook. No code changes, no remote operations, no new resources.

### 15.2 Results

- DZ-1 W1 CI checklist: complete.
- DZ-2 W2 multi-replica steps: complete.
- DZ-3 W3 browser E2E steps: complete.
- DZ-4 remote recovery checklist: complete.
- DZ-5 unified acceptance runbook: complete.

### 15.3 Status changes

None. W1 remains local PASS / CI NOT RUN. W2 and W3 remain PARTIAL. No surface is upgraded
to PASS.

### 15.4 Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Branch: `hse-platform`
154 tracked files modified, 440 untracked. No commit, push, reset, clean, restore, or
checkout.

### 15.5 Overall verdict

**Not release-ready.** Unchanged.

## 16. Phase DZ-R addendum (2026-10-20)

### 16.1 Scope

Phase DZ-R ran on the isolated host `10.10.31.30` (fingerprint
`SHA256:fkdz2n4BCf6BzcIV3DubIvJgXw4JRx9C9SG34u2fJXU`), removed the DX leftovers, built an
isolated acceptance stack from the current working tree, and executed W1, W2 and W3 against it.

### 16.2 Results

- Environment recovery: **PASS** (host reachable, identity confirmed, DX leftovers removed,
  isolated stack created and fully torn down).
- W1: local **PASS** (14/40/36/16, 0 skips) and the identity guard proven to fail closed in
  practice; **CI NOT RUN**.
- W2: **PARTIAL** — 13/13 script, 8/8 contract, and the multi-replica gate proven against two
  live replicas (pass / fail / restore / invalid / missing / no-leakage); deploy workflow unrun.
- W3: **PARTIAL** — browser 9/10 (one harness race), server-side matrix complete for the
  covered surfaces, 4 scenarios NOT RUN.
- Quality gates: format 0, typecheck 0 (27/27), lint 0, test 0 (25/25), deadcode 0, build 0.

### 16.3 Status changes

None of the four headline statuses is upgraded. W1 remains local PASS / CI NOT RUN; W2 and W3
remain PARTIAL; WOPI remains `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`;
overall remains **not release-ready**.

### 16.4 Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Branch: `hse-platform`
154 tracked files modified, 455 untracked (450 at the start of the phase plus this phase's
five reports), 0 staged. No tracked file was modified by this phase.
No commit, push, deploy, reset, clean, restore, or checkout.

### 16.5 Overall verdict

**Not release-ready.** Unchanged. The remaining blockers are the real CI run, the deploy
workflow run, and four file-authorization scenarios that still have no executed evidence.
