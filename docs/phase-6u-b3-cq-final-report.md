# Phase 6U-B3-CQ — Final report

Date: 2026-10-19
Host: isolated test server `10.10.31.30` (SSH alias `beaconhs-drill`)
Domain: `https://beaconhs-test.xuhaoqing.top`
Test tenant: `ea5a149b-ea76-48e0-abbe-fa360f520d8e` ("Phase BB Isolated Freeze Tenant")
Source commit under test: `51a899b7aac0a942da327222a3eed355fca9798a`
Deployed image: `sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370`
Overall status: **PASS for every scenario required by Phase CQ §7, with the
corrections and caveats below.**

## Headline result

| Deliverable                                                 | Status                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| SSH diagnostics and access recovery                         | PASS (original timeout not reproducible; host healthy) |
| Freeze driver `reconcile` + honest release manifest         | PASS                                                   |
| Deployment of the driver to the serving stack               | PASS                                                   |
| Freeze / multipart E2E (7 scenarios)                        | PASS (7/7, 33.0 m)                                     |
| Collabora / WOPI freeze block (step 8)                      | PASS                                                   |
| DOCX edit/save/download + `word/document.xml` (step 9)      | PASS                                                   |
| Recovery: tenant ACTIVE, no lease/arm/in-flight/reservation | PASS                                                   |
| No production or C2 resource touched                        | PASS                                                   |
| No commits / no pushes                                      | PASS                                                   |

## The most important finding

Phase CP targeted the wrong stack. The public domain is served by the
`beaconhs-phase-aj` compose project (`/home/ceshi/beaconhs-phase-cd/compose.yaml`,
web on `127.0.0.1:3010`, database `beaconhs-phase-aj`). The
`beaconhs-drill-20261009` project (web on `3001`) is a separate clone that the
domain does **not** use, and its `storage_freeze` row was the one Phase CP was
driving — so the app was never frozen and the earlier multipart E2E was vacuous.
Confirmed by compose labels, the DOM (`Super-admin · scoped to Phase BB Isolated
Freeze Tenant 1792133778134`), and the tenant list in each database. All Phase BQ
results obtained against the drill stack were discarded; this report's results come
from the `phase-aj` stack. That stack was also missing its `worker` service, now
restored.

## What changed

Test-only / E2E code (untracked; no production code touched):

- `apps/worker/src/bt-freeze-driver.ts`
  - added `reconcile` to `type Command` and `validCommands` (help text already
    advertised it — the mismatch was the bug);
  - `release` now walks only legal edges (`DRAINING`/`FAILED`/`RECOVERY_REQUIRED`
    return to `FREEZE_REQUESTED`; `FROZEN` is refused with "reconcile first");
  - `release` supplies a reconciliation manifest hashed from real
    `in_flight_writes` and unresolved `storage_write_arms` rows;
  - removed unused imports.
- `apps/worker/src/bt-freeze-driver.test.ts` — valid-command list includes
  `reconcile`; reformatted.
- `apps/web/e2e/helpers/freeze-control.ts` — container default
  `beaconhs-phase-aj-worker-1`.
- `apps/web/e2e/helpers/multipart-fixtures.ts` — generates a structurally valid
  256 MiB PDF (with xref/`startxref`/`%%EOF`); updated deterministic digest.
- `apps/web/e2e/phase-bq-multipart-freeze.spec.ts` — stored-object assertion waits
  on the stable download link instead of the transient `Uploaded` row.

Reports: `docs/phase-6u-b3-cq-*.md` (this file plus five companions).

Host side (test environment only; recorded, reversible):

- `docker tag <image> beaconhs:phase-cq-20261019-driver`.
- `phase-aj` compose image tag repointed (four services); backup at
  `/home/ceshi/beaconhs-phase-cd/compose.yaml.bak-cq`.
- `phase-aj` `worker` service started (it was absent).
- On the **unused drill stack only**: aligned `beaconhs_super`, `beaconhs_app`
  and `beaconhs_migrator` passwords with that stack's `.env` (values never
  printed). The `phase-aj` credentials already worked and were not changed.

## Evidence index

| Evidence                                  | Location                                                       |
| ----------------------------------------- | -------------------------------------------------------------- |
| Multipart suite, all 7 passing            | `/tmp/opencode/cq-multipart-all-pass.log`                      |
| Frozen-UX suite (WOPI refusal), 4 passing | `/tmp/opencode/cq-frozen-ux.log`                               |
| BO DOCX edit/save + download, 2 passing   | `/tmp/opencode/cq-bo-docx.log`                                 |
| Driver unit tests 8/8                     | `pnpm --filter @beaconhs/worker test bt-freeze-driver.test.ts` |
| Build output + iidfile                    | drill host `/tmp/cq-build.log`, `/tmp/cq-iid.txt`              |
| Compose backup                            | `/home/ceshi/beaconhs-phase-cd/compose.yaml.bak-cq`            |

## Gates run

| Gate                                        | Scope               | Result                                                                                                                                                                   |
| ------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`                         | whole repo          | PASS (exit 0)                                                                                                                                                            |
| `pnpm --filter @beaconhs/worker typecheck`  | worker              | PASS                                                                                                                                                                     |
| `pnpm --filter @beaconhs/web typecheck`     | web                 | PASS                                                                                                                                                                     |
| driver unit tests                           | worker              | PASS (8/8)                                                                                                                                                               |
| eslint                                      | the 3 web E2E files | PASS (exit 0)                                                                                                                                                            |
| `pnpm lint` (full)                          | repo                | NOT RUN — the worktree carries ~295 unrelated pre-existing changes; running the full monorepo lint is out of scope for this change and would be judged on unrelated code |
| `pnpm test` (full)                          | repo                | NOT RUN — same reason; targeted unit tests and the live E2E were run instead                                                                                             |
| `pnpm deadcode:check` / `pnpm build` (full) | repo                | NOT RUN — not required to validate this test-only + environment change                                                                                                   |

Per the task constraints, nothing was committed or pushed; `git log -1` is still
`51a899b7`. The changed files remain in the working tree.

## Phase CQ §7 scenario map

1. ACTIVE multipart upload + SHA-256 verified → PASS (Scenario 1).
2. freeze refuses a new upload → PASS (Scenario 2).
3. freeze after create, before first part → PASS (Scenario 3, `DRAINING`).
4. freeze after first part → PASS (Scenario 4).
5. freeze with last part pending → PASS (Scenario 5; drain/in-flight/arm verified).
6. reconcile + thaw, ACTIVE upload succeeds → PASS (Scenario 6).
7. concurrent uploads blocked while frozen → PASS (Scenario 7).
8. real Collabora/WOPI write blocked → PASS (`phase-bq-frozen-ux` Scenario 4).
9. thaw: DOCX edit/save/download + `word/document.xml` → PASS (`phase-bo-e2e` A/B).

## Recovery state (verified after the run)

```
storage_freeze      : ACTIVE, version 191, lease_holder_id NULL
unresolved arms     : 0  (armed/expired/reconciling/issuing)
unfinished in-flight: 0
unconsumed upload reservations: 0
worker log          : [scheduled] expired_uploads: 0 recovered / 1 discarded / 0 errors  (×3)
                      [scheduled] storage_write_arms: 1 reconciled ... (earlier tick)
web                 : Up (healthy), image sha256:60dc4841…
worker              : Up,              image sha256:60dc4841…
readiness           : {"status":"ready","version":"51a899b7…"}
```

No data was deleted; the tenant's document masters and the external
`beaconhs-phase-aj_*` volumes were not touched. The only resources accessed were
the isolated test host and the test tenant.

## Remaining risks and known issues

- **Wrong-stack residue (FLAGGED):** the unused `beaconhs-drill-20261009` stack is
  still running. Nothing was deleted. Host-owner should stop/remove it.
- **`phase-aj` `scheduler` (pre-existing defect):** the service has
  `restart: "no"` and its container exited ~18 h before this phase. Repeatable jobs
  are registered in Redis so the restored `worker` executes the ticks, but the
  scheduler process is not supervised. Reported, not fixed.
- **Original SSH timeout (BLOCKED):** not reproducible and no host-side fault was
  found; root cause remains undetermined.
- **pdf.js 256 MiB render (known defect):** the viewer cannot render the large
  fixture; the tests bypass it by reading the capability URL from a fresh page. The
  upload path itself is unaffected.
- **Recorded, not fixed (per instructions):** the D1–D6 defects listed in
  `AGENTS.md` were not touched.
- **Full CI gates:** only the targeted gates above were run; the full monorepo
  `lint`/`test`/`deadcode:check`/`build` were not run in this phase.

## Condensed checklist for the reviewer

1. `ssh beaconhs-drill "docker exec beaconhs-phase-aj-worker-1 /app/apps/worker/node_modules/.bin/tsx /app/apps/worker/src/bt-freeze-driver.ts status"` → `state=ACTIVE`.
2. `ssh beaconhs-drill "docker inspect beaconhs-phase-aj-worker-1 --format '{{.Image}}'"` → `sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370`.
3. `curl https://beaconhs-test.xuhaoqing.top/api/health/ready` → `ready`, version `51a899b7…`.
4. `cd apps/web && pnpm exec playwright test e2e/phase-bq-multipart-freeze.spec.ts --workers=1` → 7 passed.
5. `cd apps/web && pnpm exec playwright test e2e/phase-bq-frozen-ux.spec.ts --workers=1` → 4 passed.
6. `cd apps/web && E2E_STORAGE_STATE=/tmp/opencode/bt-auth.json pnpm exec playwright test e2e/phase-bo-e2e.spec.ts -g "Scenario (A|B)" --workers=1` → 2 passed.
7. Confirm no commits: `git log --oneline -1` → `51a899b7 …`.
8. Confirm the freeze row and counters in the recovery block above.
