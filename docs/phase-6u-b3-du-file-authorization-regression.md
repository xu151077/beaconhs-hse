# Phase DU-3 — File authorization regression

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Static review of the 32 wrapped routes

All routes under `apps/web/src/app` that call `assertCan` or `requireExportContext` are wrapped
with `withRouteErrors`. A second guard, `assertCanManageModule`, was also used by two route
handlers (`people/[id]/badge` and `people/[id]/badge/print`).

Finding during DU-3: `assertCanManageModule` threw a generic `Error("Forbidden: …")`, not a
`ForbiddenError`. The wrapper only maps `ForbiddenError` and `ImpersonationBlockedError`, so
those two routes would still have rendered 500. This was fixed in DU-3 by making
`assertCanManageModule` throw a `ForbiddenError` while preserving the original message text.
The route contract test still passes (32 wrapped, 0 offenders).

Permission map (extracted from each route):

| Route                                          | Permission gate                              | Expected on denial |
| ---------------------------------------------- | -------------------------------------------- | ------------------ |
| `apps/responses/export.csv`                    | `requireExportContext` (`admin.data.export`) | 403                |
| `corrective-actions/export.csv`                | `requireExportContext`                       | 403                |
| `documents/export.csv`                         | `requireExportContext`                       | 403                |
| `documents/[id]/master`                        | `documents.manage`                           | 403 / 404          |
| `documents/[id]/pdf`                           | `documents.manage`                           | 403 / 404          |
| `documents/[id]/versions/[versionId]/download` | `documents.read`                             | 403 / 404          |
| `documents/management-reviews/[id]/pdf`        | `documents.manage`                           | 403 / 404          |
| `documents/sign-off-sessions/[sessionId]/pdf`  | `documents.manage`                           | 403 / 404          |
| `equipment/export.csv`                         | `requireExportContext`                       | 403                |
| `equipment/qr/labels`                          | `equipment.read.site`                        | 403 / 404          |
| `equipment/vehicle-log/export.csv`             | `requireExportContext`                       | 403                |
| `equipment/vehicle-log/pdf`                    | `requireExportContext`                       | 403                |
| `equipment/work-orders/[id]/pdf`               | `equipment.read.all`                         | 403 / 404          |
| `hazard-assessments/blank/pdf`                 | `hazid.create`                               | 403 / 404          |
| `incidents/export.csv`                         | `requireExportContext`                       | 403                |
| `insights/cards/[id]/export`                   | `requireExportContext`                       | 403                |
| `inspections/export.csv`                       | `requireExportContext`                       | 403                |
| `inspections/records/[id]/pdf`                 | `inspections.read.self`                      | 403 / 404          |
| `journals/export.csv`                          | `requireExportContext`                       | 403                |
| `locations/export.csv`                         | `requireExportContext`                       | 403                |
| `observations/export.csv`                      | `requireExportContext`                       | 403                |
| `people/export.csv`                            | `requireExportContext`                       | 403                |
| `people/[id]/badge`                            | `assertCanManageModule(ctx, 'people')`       | 403 / 404          |
| `people/[id]/badge/print`                      | `assertCanManageModule(ctx, 'people')`       | 403 / 404          |
| `ppe/export.csv`                               | `requireExportContext`                       | 403                |
| `ppe/[id]/inspections/[inspectionId]/pdf`      | `ppe.read.all`                               | 403 / 404          |
| `ppe/[id]/issues/[issueId]/pdf`                | `ppe.read.all`                               | 403 / 404          |
| `reports/definitions/[id]/export`              | `reports.read`                               | 403 / 404          |
| `reports/schedules/[id]/runs/[runId]/pdf`      | `reports.read`                               | 403 / 404          |
| `tools/safe-distance/export.csv`               | `requireExportContext`                       | 403                |
| `training/classes/[id]/pdf`                    | `training.class.manage`                      | 403 / 404          |
| `training/courses/export.csv`                  | `requireExportContext`                       | 403                |

## 2. Denial semantics

| Caller state                                 | Result                                                                    | Mechanism                                                |
| -------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| No session                                   | redirect to `/login` (page routes) or `401` (attachment capability route) | `requireRequestContext` / `validateAttachmentCapability` |
| Authenticated, missing permission            | `403` generic body                                                        | `withRouteErrors`                                        |
| Authenticated, resource absent or RLS-hidden | `404`                                                                     | route handler after the permission check                 |
| Unexpected internal fault                    | 5xx, unchanged                                                            | rethrown by `withRouteErrors`                            |

`404` is used to hide resource existence from cross-tenant callers, consistent with the
existing security design. It is not used to mask a missing permission: a caller without the
permission gets `403` before any RLS lookup.

## 3. Tests that ran

| Test                                        | Command                                                                                | Result                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| Wrapper semantics                           | `pnpm --filter @beaconhs/web exec vitest run src/lib/api/errors.test.ts`               | PASS (4/4)                              |
| Every permission-asserting route is wrapped | `pnpm --filter @beaconhs/web exec vitest run src/lib/api/route-error-contract.test.ts` | PASS (2/2; 32 wrapped, 0 offenders)     |
| Web typecheck                               | `pnpm --filter @beaconhs/web typecheck`                                                | PASS (exit 0)                           |
| Web lint                                    | `pnpm --filter @beaconhs/web lint`                                                     | PASS (exit 0)                           |
| Full web suite                              | `pnpm --filter @beaconhs/web test`                                                     | PASS (246 files, 2054 tests, 8 skipped) |

## 4. Browser E2E

**NOT RUN.** The local dev server was not running and this phase is forbidden from starting
or operating the shared dev stack. The CX spec was corrected and extended in DT and remains
ready to run against an isolated seeded stack with storage states.

The matrix status is unchanged from DT-W3: no surface is marked PASS for the browser
matrix; 12 are PARTIAL and 4 (DOCX import/edit/save, delete/replace, cross-tenant modify,
freeze, WOPI) are NOT RUN.

## 5. Isolated environment

No isolated environment was available in DU-3. Static review and the unit/contract tests
above are the evidence. No shared stack was touched.

## 6. Conclusion

- The 500-as-refusal defect is closed at the shared boundary and now covers the two badge
  routes that previously threw a generic `Error`.
- HTTP denial semantics are documented and tested at the unit level.
- Browser authorization evidence remains **NOT RUN**.
- W3: **PARTIAL**. See `docs/phase-6u-b3-dt-w3-file-authorization.md`.
