# Phase DZ-R — Final report

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Status summary

| Work item                   | Status                               | One-line                                                                                                         |
| --------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Environment recovery        | **PASS**                             | Host reachable; identity confirmed by full fingerprint; DX leftovers removed; isolated stack built and torn down |
| W1 — CI database workflow   | **PARTIAL** (local PASS, CI NOT RUN) | 5 live suites re-run: 14/40/36/16, 0 skips; identity guard proven to fail closed; GitHub Actions still unrun     |
| W2 — Server Action Key gate | **PARTIAL**                          | 13/13 script + 8/8 contract; multi-replica proven on two live replicas; deploy workflow still unrun              |
| W3 — file authorization E2E | **PARTIAL**                          | Browser 9/10 (one harness race); server-side matrix complete for the covered surfaces; 4 scenarios NOT RUN       |

Overall verdict: **not release-ready** (unchanged).

## 2. What actually ran

- **Browser E2E**: `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts` against the isolated
  image on `http://localhost:13010` — 9 passed, 1 failed (harness navigation race; the same
  request is a stable 404 server-side).
- **Server-side status matrix**: 16 request/identity combinations measured; no 500 anywhere.
- **Multi-replica key gate**: two live web replicas — pass / fail / restore / invalid / missing /
  no-leakage all exercised, exit codes recorded.
- **Live DB suites**: `db-owner` 14, `db-seeded` 40, `db-runtime` 36, `db-freeze` 16 — 0 skips.
- **CI**: **NOT RUN**. The branch is unpushed and no push is authorised.

## 3. Remaining release blockers

| Blocker                                                               | Severity    | State                                                                                  |
| --------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| GitHub Actions has never executed this commit (W1 CI leg)             | P1          | Open — needs a push/PR with owner authorisation                                        |
| The deploy workflow has never executed the key gate (W2 workflow leg) | P1          | Open — same trigger                                                                    |
| Browser matrix: cross-tenant modify, DOCX edit/save, delete/replace   | P2          | NOT RUN — no isolated fixture or UI path exercised                                     |
| Storage-freeze write denial / recovery over HTTP                      | P2          | NOT RUN — the storage-write surface is a server action behind upload drawers           |
| One browser case is flaky (client-side redirect race)                 | P2          | Open — harness issue, assertion not modified                                           |
| WOPI frozen re-open anomaly                                           | P1-4        | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`                             |
| Drill stack containment/repair                                        | P2-9        | Awaiting owner approval                                                                |
| `phase-aj` and Drill stacks are down on the isolated host             | Operational | Caused by the host reboot before this phase; **not** started or modified by this phase |

## 4. Git state (before → after)

| Metric            | Start of phase                             | End of phase                    |
| ----------------- | ------------------------------------------ | ------------------------------- |
| Branch            | `hse-platform`                             | `hse-platform`                  |
| HEAD              | `51a899b7aac0a942da327222a3eed355fca9798a` | unchanged                       |
| Tracked modified  | 154                                        | 154                             |
| Untracked         | 450                                        | 455 (this phase's five reports) |
| Staged            | 0                                          | 0                               |
| `git diff --stat` | 154 files, +5100/−1919                     | identical                       |

No commit, push, deploy, reset, clean, restore, checkout, or `git add -A` was performed.

### Files changed by this phase

Only documentation. No business code, schema, workflow, or test file was modified.

- `docs/phase-6u-b3-dz-r-environment-recovery.md` (new)
- `docs/phase-6u-b3-dz-r-w1-ci-db.md` (new)
- `docs/phase-6u-b3-dz-r-w2-server-action-key.md` (new)
- `docs/phase-6u-b3-dz-r-w3-file-authorization-e2e.md` (new)
- `docs/phase-6u-b3-dz-r-final-report.md` (new)
- `docs/phase-6u-b3-cv-release-readiness.md` (updated, §16)

Fixture scripts and Playwright storage states were written outside the repository
(`/tmp/opencode/…`) and are not part of the worktree.

## 5. Quality gates (current tree)

| Gate                  | Exit | Detail                                                                                                   |
| --------------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`   | 0    | all files formatted                                                                                      |
| `pnpm typecheck`      | 0    | 27/27 packages                                                                                           |
| `pnpm lint`           | 0    | 1 task (`apps/web`)                                                                                      |
| `pnpm test`           | 0    | 25/25 tasks; db 506 passed/41 skipped, web 2076 passed/8 skipped, auth 78/13, object-store-backup 139/38 |
| `pnpm deadcode:check` | 0    | knip clean                                                                                               |
| `pnpm build`          | 0    | 4/4 tasks                                                                                                |

The 41 db skips in the aggregate run are the DB assertions; they were executed with 0 skips in
the explicit project runs.

## 6. Temporary resources

| Resource                                                   | Created       | Removed         | Verified               |
| ---------------------------------------------------------- | ------------- | --------------- | ---------------------- |
| `/home/ceshi/beaconhs-dx` (DX leftover)                    | Phase DX      | Phase DZ-R      | absent                 |
| `/home/ceshi/dx-sa-key` (DX leftover)                      | Phase DX      | Phase DZ-R      | absent                 |
| `beaconhs:dx-20261020` (DX leftover image)                 | never created | n/a             | absent                 |
| `/home/ceshi/beaconhs-dxr` (source sync)                   | DZ-R          | DZ-R            | absent                 |
| `/home/ceshi/dxr` (compose + env + key)                    | DZ-R          | DZ-R            | absent                 |
| `/home/ceshi/dxr-sa-key` (test key)                        | DZ-R          | DZ-R            | absent                 |
| `beaconhs:dxr-20261020` image                              | DZ-R          | DZ-R            | untagged and deleted   |
| `dxr` compose project (9 containers, 1 network, 3 volumes) | DZ-R          | DZ-R            | none remain            |
| `beaconhs_dxr_scratch_<ts>_{owner,seeded,runtime}` (local) | DZ-R          | DZ-R            | 0 matching databases   |
| `beaconhs_dxr_scratch` (isolated Postgres)                 | DZ-R          | with the volume | dropped with the stack |
| SSH forward (15432/13010/13011/19000/19980)                | DZ-R          | DZ-R            | 0 ports listening      |

The `phase-aj` and Drill containers, images, volumes, networks, and data were not touched.

## 7. Shortest path to the next status change

1. Push `hse-platform` (or open a PR to `main`) with owner authorisation and let CI run — that
   converts W1 to **CI PASS** if the four live DB steps report 0 skips.
2. Run the deploy workflow once so the key gate executes in its real context — that converts the
   W2 workflow leg to proven.
3. Extend the isolated E2E to cover DOCX edit/save, delete/replace, cross-tenant modify, and the
   storage-freeze write denial/recovery, and make the version case deterministic by awaiting the
   post-hydration redirect before `page.evaluate` (a harness fix, not an assertion change).
