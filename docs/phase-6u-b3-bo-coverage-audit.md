# Phase 6U-B3 / BO — System Test-Coverage Audit

- **Date:** 2026-10-17
- **Environment under test:** `https://beaconhs-test.xuhaoqing.top` (Phase AJ Test Tenant)
- **Deployed image (verified, not assumed):** `beaconhs:phase-bl-20261017-000000`
  (container `beaconhs-phase-aj-web-1`, `docker ps` image column)
- **Source under audit:** working tree at HEAD `51a899b7aac0a942da327222a3eed355fca9798a`
  plus the uncommitted Phase BL/BK/BN/BO changes. The working tree is **not** the
  running image — see "Deploy gap" below.
- **Companion documents:**
  - `docs/phase-6u-b3-bo-e2e-closure-report.md` (scenario results, counts)
  - `docs/phase-6u-b3-bo-defect-register.md` (defects found)

## 1. Method

The inventory is derived from the navigation registry
(`apps/web/src/lib/nav/registry.ts`), which is the single source of truth for
authenticated modules, then cross-checked against the route folders under
`apps/web/src/app/(app)`.

Three levels of verification are reported, and they are **not** conflated:

| Level               | Meaning                                                                                                                                                                                                               | How it was produced                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **E2E**             | A real browser loaded the surface, JS executed, the final URL was asserted.                                                                                                                                           | Playwright (`apps/web/e2e/phase-bo-e2e.spec.ts`, Coverage test) |
| **Interface-probe** | An authenticated HTTP GET reached the route and returned `< 400`. Because the app authenticates **client-side** (the SSR shell answers `200` and the shell then navigates), this does **not** prove the page renders. | `page.request.get(...)`                                         |
| **Compiler-level**  | The route exists and typechecks/builds.                                                                                                                                                                               | `pnpm typecheck`, `pnpm build`                                  |

A green interface-probe is explicitly **not** claimed as a passing E2E test.

## 2. Module coverage matrix

All 24 navigation modules were **E2E-verified** (rendered in a real browser for
the authenticated super-admin). Result: **24 / 24 rendered**.

| Group           | Module              | Route                 | Verification | Result      |
| --------------- | ------------------- | --------------------- | ------------ | ----------- |
| Overview        | Dashboard           | `/dashboard`          | E2E          | ✅ rendered |
| Overview        | Assistant           | `/assistant`          | E2E          | ✅ rendered |
| Overview        | Feed                | `/feed`               | E2E          | ✅ rendered |
| Overview        | Workspace           | `/my`                 | E2E          | ✅ rendered |
| Overview        | Inbox               | `/notifications`      | E2E          | ✅ rendered |
| Frontline       | Site Inspections    | `/inspections`        | E2E          | ✅ rendered |
| Frontline       | Hazard Assessments  | `/hazard-assessments` | E2E          | ✅ rendered |
| Frontline       | Journals            | `/journals`           | E2E          | ✅ rendered |
| Frontline       | Safety observations | `/observations`       | E2E          | ✅ rendered |
| Frontline       | Incidents           | `/incidents`          | E2E          | ✅ rendered |
| Frontline       | Corrective Actions  | `/corrective-actions` | E2E          | ✅ rendered |
| Frontline       | Tools               | `/tools`              | E2E          | ✅ rendered |
| Knowledge       | Training            | `/training`           | E2E          | ✅ rendered |
| Knowledge       | Documents           | `/documents`          | E2E          | ✅ rendered |
| Knowledge       | User Guide          | `/help`               | E2E          | ✅ rendered |
| Assets & People | People              | `/people`             | E2E          | ✅ rendered |
| Assets & People | Locations           | `/locations`          | E2E          | ✅ rendered |
| Assets & People | Equipment           | `/equipment`          | E2E          | ✅ rendered |
| Assets & People | PPE                 | `/ppe`                | E2E          | ✅ rendered |
| Assurance       | Compliance          | `/compliance`         | E2E          | ✅ rendered |
| Assurance       | Insights            | `/insights`           | E2E          | ✅ rendered |
| Assurance       | Reports             | `/reports`            | E2E          | ✅ rendered |
| Administration  | Admin               | `/admin`              | E2E          | ✅ rendered |
| Administration  | Builder             | `/apps`               | E2E          | ✅ rendered |

### Administration sub-routes — interface-probe only

These were HTTP-probed (all `200`) but were **not** driven in a browser, so they
are reported as interface-probe, **not** E2E:

| Route               | Probe result          |
| ------------------- | --------------------- |
| `/admin/roles`      | 200 (interface-probe) |
| `/admin/users`      | 200 (interface-probe) |
| `/platform`         | 200 (interface-probe) |
| `/platform/tenants` | 200 (interface-probe) |

## 3. Non-navigation surfaces exercised

| Surface                                                                            | Level           | Result                                                      |
| ---------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------- |
| Documents master download (`GET /documents/{id}/master`)                           | E2E             | ✅ returned the exact stored bytes                          |
| Collabora Writer (`cool.html` WOPI frame, edit + Ctrl+S)                           | E2E             | ✅ edit persisted into the master DOCX (see closure report) |
| Anonymous access guard (`/dashboard`, `/documents`, `/admin`, `/platform/tenants`) | E2E             | ✅ each redirected to `/login`                              |
| Collab{ora} discovery (`/hosting/discovery`)                                       | interface-probe | ✅ returns HTTPS action URLs after the environment fix      |

## 4. Coverage gaps (honest, not skips)

- **Storage Freeze state machine** — `ACTIVE → FREEZE_REQUESTED → DRAINING →
FROZEN → RECONCILING → ACTIVE` was **not** executed E2E. Reason: the
  transitions live only in `packages/db/src/storage-freeze-operations.ts`; there
  is **no web page or server action** that drives them, so no browser flow
  exists to test. Both test tenants are currently `ACTIVE` in `storage_freeze`.
  The most recent traversal on record was **script-driven** (row
  `tenant_id=ea5a149b…`, `last_transition_by=phase-bb-freeze-script`). Marked
  **BLOCKED** — see the closure report.
- **Database-gated unit scenarios** — the `test` gate reports
  `SEED_TEST_SCRATCH_DATABASE_URL`-dependent scenarios as **skipped, not
  passed** (the harness prints this explicitly). These are counted as skipped.
- **Module business logic** (per-module CRUD lifecycles) — audited at the
  route/render level, not exercised record-by-record in this phase.
- **Performance** — measured with the Navigation Timing API on three pages
  (see closure report §4). No load testing was performed.

## 5. Deploy gap (must be stated)

The running image `beaconhs:phase-bl-20261017-000000` was built from **HEAD**,
not from the working tree. Concretely, `HEAD`'s
`apps/web/src/app/(app)/documents/[id]/master/route.ts` sanitizes download
filenames with `filename.replace(/[^\w.\- ]+/g, '_')`, which is why Chinese
names download as `_.docx`. The corrected routes exist **only in the working
tree** and are **not deployed**. Coverage claims in this document therefore
describe the working tree's intent while scenario results describe the running
image; where the two differ (filenames) the closure report reports the running
image's behaviour.
