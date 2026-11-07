# EA-12 — Local Defect Fix Summary

Date: 2026-10-22

## Scope

EA-12 fixed the defects that could be reproduced and verified locally after the
EA-11 release-decision audit. It did not deploy, commit, push, touch production,
`phase-aj`, Drill or GitHub, and it did not change the permission architecture.

## Fixes

| ID  | Fix                                                                                                                                                                                                                                                                                 | Evidence                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P1  | `/api/v1/monitored_sessions` no longer throws. The `apps` report category now maps to the existing `forms.response.read.all` key because monitored sessions are `form_responses` rows, the same module already exposed by the Builder apps API.                                     | `apps/web/src/lib/api/permissions.ts`, `permissions.test.ts`, `monitored-sessions-route.test.ts`            |
| D1  | Confirmed already fixed. Removed stale defect documentation and kept the catalogue-key regression coverage.                                                                                                                                                                         | Nav / module-admin tests                                                                                    |
| D2  | Confirmed already fixed. `/people` requires `people.read.all`; direct access redirects/404s and export is gated.                                                                                                                                                                    | People access / export tests                                                                                |
| D3  | Removed `training_enrollments.expires_on`, `training_enrollments.due_on` and `equipment_inspection_records.certificate` from the Drizzle schema. Added `0051_ea12_drop_dead_columns.sql`. The only references were two write-only enrollment assignments, removed with the columns. | `packages/db/src/ea12-dead-columns.test.ts`; all three columns had zero non-null rows before the local drop |
| D4  | PPE failed-inspection → corrective-action now writes the same `corrective_action.created` domain event as inspections, including notification, integration and web-flow payloads.                                                                                                   | `apps/web/src/app/(app)/ppe/_lib.test.ts`                                                                   |
| D5  | Equipment flow profile now offers all eight real work-order statuses, including `repaired` and `verified`.                                                                                                                                                                          | `apps/web/src/lib/flows/module-profiles.test.ts`                                                            |
| D6  | Corrected the canonical-template seed comment to match `CANONICAL_TEMPLATES`.                                                                                                                                                                                                       | `packages/db/src/seed.ts`                                                                                   |
| T   | Fingerprint CLI tests now remove temporary key directories in `finally`, including rejected keys.                                                                                                                                                                                   | `apps/web/src/lib/server-action-key-fingerprint-cli.test.ts`                                                |

## Verification

Affected suites, run before the full gates:

- Web: 6 files, 5 passed and 1 skipped; 25 passed and 1 skipped. The skipped file
  is the live RLS suite, which ran separately below.
- DB: 3 files, 53 passed / 4 skipped.

Live tenant-isolation verification:

- Created a dedicated `beaconhs_ea12_scratch` database.
- Applied the full migration chain: 51 applied, 0 pending.
- Ran `monitored-sessions-tenant-isolation.test.ts` against it: 1 passed.
- The test creates two tenants, inserts one monitored session for each, reads
  through each tenant's real `ctx.db`, and proves tenant A cannot see tenant B's
  row.
- Without `SEED_TEST_SCRATCH_DATABASE_URL` this suite is skipped, not passed.

## Migration safety

`0051_ea12_drop_dead_columns.sql` drops three columns. Before applying it, each
was queried in the local dev database and had **0 non-null rows**. The migration
was applied locally and the ledger reached 51 applied, 0 pending. The scratch
database also applied the full chain successfully. No production migration was
run.

## Full gates

Each command was run separately; each exit code was captured from the gate itself.

| Gate                  | Result   | Evidence                                                     |
| --------------------- | -------- | ------------------------------------------------------------ |
| `pnpm format:check`   | **PASS** | `All matched files use Prettier code style!`; exit 0.        |
| `pnpm typecheck`      | **PASS** | 29 packages in scope (27 tasks); exit 0.                     |
| `pnpm lint`           | **PASS** | 1 lint task (`@beaconhs/web`); exit 0.                       |
| `pnpm test`           | **PASS** | 25 Turbo tasks; web reported 2118 passed, 9 skipped; exit 0. |
| `pnpm deadcode:check` | **PASS** | `knip --treat-config-hints-as-errors`; exit 0.               |
| `pnpm build`          | **PASS** | 4 Turbo tasks; Next.js production build completed; exit 0.   |

The nine skipped web tests are the conditional database suites (live RLS, WOPI
contents and storage-freeze) that require `SEED_TEST_SCRATCH_DATABASE_URL`. They
are recorded as skipped, not passed. The live RLS suite was run separately
against `beaconhs_ea12_scratch` and passed.

## Not run / blocked

- Real deployment, real rollback, production restore, multi-node Swarm, GHCR/GHA
  cache path: **NOT RUN** (environment/authorisation blocked).
- WOPI frozen-document behaviour: unresolved, investigation paused by the owner.
- D8 (82 snapshot FKs absent): out of scope.
- `/tmp/next_server_actions_key`: ownership/purpose not proven; no action taken.

## Risks

- The `apps` → `forms.response.read.all` alias is intentional and limited to the
  same underlying `form_responses` data. The duplicate-gate test fails if any
  other two categories start sharing a permission.
- The live RLS suite requires an isolated scratch database; CI without that
  variable records it as skipped, not as a pass.
- The D3 drop is destructive by nature. It is safe only after the zero-non-null
  check; re-adding the columns would not restore dropped values.
