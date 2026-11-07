# Phase 6U-B3-DS — Final report

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch / HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Mode: **read-only release-acceptance audit.** No business code, schema,
migration, container, network, volume, object store, secret, or remote
environment was modified. No commit, push, reset, clean, restore, checkout or
deploy was performed.

Deliverables:

- `docs/phase-6u-b3-ds-evidence-index.md` — what evidence exists, and whether it
  still proves the current tree.
- `docs/phase-6u-b3-ds-release-gaps.md` — area assessment + P0–P3 matrix.
- `docs/phase-6u-b3-ds-next-plan.md` — work packages, acceptance criteria,
  release checklist.
- `docs/phase-6u-b3-cv-release-readiness.md` — historical conclusions preserved;
  a dated DS addendum records the corrections.

## 1. Git state actually observed

```
branch          hse-platform
HEAD            51a899b7aac0a942da327222a3eed355fca9798a
staged          0
modified        124
untracked       415  (before DS; 412 pre-existing + 3 Phase DR docs)
```

The working tree is HEAD plus 124 uncommitted modifications. Phase DS added
**only** four `docs/phase-6u-b3-ds-*.md` files and one CV addendum; it added no
code and did not touch the 124 modified files. All gate results below describe
this working tree, not HEAD in isolation.

## 2. Verdict

**Not release-ready.** No P0 security defect was found. Four P1 acceptance items
are unverified, and nine P2 items (one is a known-broken public endpoint) are
open. The dominant pattern is **controls that exist but are not wired into the
pipeline**, not missing controls.

## 3. Release blockers (P1)

| ID   | Blocker                                                                                      | Why it blocks                                                                                   | Evidence path                                                                      |
| ---- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P1-1 | CI and `pnpm test` skip all 41 DB-backed assertions (`SEED_TEST_SCRATCH_DATABASE_URL` unset) | RLS write enforcement, provisioning, seed integrity and freeze persistence can regress silently | `docs/phase-6u-b3-ds-release-gaps.md` §D; `/tmp/opencode/ds-test.log`              |
| P1-2 | Server Action key fingerprint gate is a script only; no CI/deploy step invokes it            | A per-replica key override passes every gate and fails later, only cross-instance               | `docs/phase-6u-b3-ds-release-gaps.md` §C; `.github/workflows/*.yml`                |
| P1-3 | File-surface browser authorization is 7 local cases, asserts 500, and does not run in CI     | Upload/preview/edit/save/version/delete/WOPI regressions can ship untested                      | `docs/phase-6u-b3-ds-release-gaps.md` §B; `apps/web/e2e/phase-cx-*.spec.ts`        |
| P1-4 | WOPI frozen re-open remains FAIL/BLOCKED; no written risk acceptance                         | One real hang; cause unknown; must be accepted explicitly or fixed                              | `docs/phase-6u-b3-dk-scenario4-evidence.md`; `docs/phase-6u-b3-dr-final-report.md` |

P1-4 is a decision, not a code task. DS does **not** approve release on the
owner's behalf.

## 4. P0–P3 summary

| Priority | Count | Items                                                                                                                                                                              |
| -------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       |     0 | none found (RLS forced on 191/191 tenant tables; app role NOBYPASSRLS)                                                                                                             |
| P1       |     4 | DB tests skipped; key gate unwired; file-surface coverage; WOPI decision                                                                                                           |
| P2       |     9 | `/api/v1` 500; denial returns 500; scheduler inspector untested; scheduler not stage-verified; D4 no event; DB role unchecked; lint only web; real-store unverified; drill blocked |
| P3       |     9 | WOPI diagnostics; stale key comment; stale defect register; stale project-state doc; D3/D5/D6; Edge warnings; nav-gate drift                                                       |

Full definitions, confidence, impact and acceptance criteria are in
`docs/phase-6u-b3-ds-release-gaps.md` §F.

## 5. Evidence for the headline conclusions

| Conclusion                                        | Evidence                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RLS is installed and forced on every tenant table | live dev Postgres read-only query: 191 tables with `tenant_id`, 191 with `relrowsecurity` + `relforcerowsecurity` + a `tenant_isolation` policy; 0 gaps |
| The app role cannot bypass RLS                    | `pg_roles`: `beaconhs_app` `rolbypassrls=f`, `rolsuper=f`; `beaconhs_super` `rolbypassrls=t`                                                            |
| Schema and RLS list cannot drift                  | static parse of `packages/db/src/schema/*.ts` vs `TENANT_SCOPED_TABLES`: 191 vs 191, 0 missing, 0 extra                                                 |
| DB-backed tests are skipped, not passing          | `db` 41 skipped; the suite prints "SKIPPED, not passed" for freeze persistence, provisioning, reference data, seed integrity                            |
| Key gate is not invoked by CI/deploy              | exhaustive grep of `.github/workflows/*.yml` for the script name → 0 matches                                                                            |
| No key material reaches client bundles            | 0 matches for `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` and the fingerprint label in `apps/web/.next/static/**`; the one `encryptionKey` hit is pdf.js       |
| `/api/v1` discovery is broken                     | `REPORT_ENTITIES` includes `monitored_sessions` (category `apps`); `readPermissionForEntity` throws for `apps`; the route maps every entity → 500       |
| Lint does not cover backend packages              | `turbo run lint` executes 1 task; only `apps/web/package.json` defines `lint`                                                                           |
| D1/D2 are fixed in the tree; D3/D4/D5/D6 remain   | nav uses `equipment.read.site` + `people.read.all`; PPE CA path has no `recordDomainEvent`; dead columns and the stale seed comment are present         |

## 6. Gate evidence at the current tree

Executed 2026-10-20 (UTC), forced (non-cached) except formatting and dead-code
which have no cache:

| Gate           | Command                                 | Exit | Counts                                                                     |
| -------------- | --------------------------------------- | ---: | -------------------------------------------------------------------------- |
| `format:check` | `pnpm format:check`                     |    0 | all matched files clean                                                    |
| `typecheck`    | `TURBO_FORCE=true pnpm typecheck`       |    0 | 27/27 tasks, 0 cached                                                      |
| `lint`         | `TURBO_FORCE=true pnpm lint`            |    0 | 1/1 task — **only `apps/web`**                                             |
| `test`         | `TURBO_FORCE=true pnpm test --continue` |    0 | 25/25 tasks; 429 files passed + 6 skipped; 3 793 tests passed, 100 skipped |
| `deadcode`     | `pnpm deadcode:check`                   |    0 | no findings                                                                |
| `build`        | `TURBO_FORCE=true pnpm build`           |    0 | 4/4 tasks; Next compiled in 11.1 s; 4 Edge-Runtime warnings                |

Caveats that limit the proof:

- The runs cover the **working tree** (HEAD + 124 modifications), not a clean
  checkout of HEAD.
- 100 tests are skipped (db 41, object-store-backup 38, auth 13, web 8). A green
  `test` gate is not a statement about the skipped assertions.
- There is no CI record for this commit (local branch, unpushed; CI runs on
  `main`). The DR phase's six-gate pass was on the same tree.

## 7. WOPI legacy anomaly

Status recorded exactly as required:

**KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED.**

- One phase-aj failure with request-level evidence (frozen GET 200 in 4 140 ms,
  0 WOPI calls, `load` never fired, 21 tile stalls).
- Not reproduced since; the fixed three-leg predicate never fired in six Phase DR
  experiments (0 `REPRODUCED`, 0 `BACKPRESSURE_ONLY`).
- No evidence of data loss, corruption, or unauthorized access.
- Root cause neither proven nor excluded; three server-side levers were excluded
  **in the mirror** only.
- No business code was changed. On recurrence: retain the browser trace,
  WebSocket events, Collabora logs, and request timeline before re-evaluating.
- Not marked FIXED, WONTFIX, or eliminated.
- Whether it blocks release is an owner decision under a written risk-acceptance
  mechanism. DS found no such written record and does not declare release
  approved.

## 8. Items needing explicit owner confirmation

1. WOPI frozen re-open: accept with monitoring, or authorize another experiment.
2. The literal "no key material in the image" criterion: accept the restated
   criterion ("no key material in client-accessible artifacts, env, history or
   logs"; the server manifest must embed it).
3. The C2 drill stack: choose containment/repair; DS did not touch it.
4. Whether `monitored_sessions` is a public API entity (drives P2-1).
5. Whether to fund the file-surface release run and the DB-test wiring before the
   cutover.

## 9. What DS changed

- Added four DS documents and one dated addendum to the CV readiness report.
- No production code, tests, schema, migration, workflow, compose file, `.env`,
  secret, or infrastructure.
- No phase-aj, dev-stack, drill, database-write, object-store, or network
  operation. The only database access was read-only catalog queries against the
  local dev Postgres.
- `.turbo`/`.next` caches were refreshed by the gate runs; both are git-ignored,
  so `git status` is unchanged apart from the new docs.

## 10. Next steps

Follow `docs/phase-6u-b3-ds-next-plan.md`:

1. **W1** — set `SEED_TEST_SCRATCH_DATABASE_URL` in CI; require `db: 0 skipped`.
2. **W2** — invoke the key gate on every replica; prove a mismatch fails the
   rollout.
3. **W3** — fix the denial status (P2-2), then run the full file-surface matrix
   at the release image.
4. **W4** — obtain the WOPI risk decision.
5. **W5–W9** — close the P2 items; **W10–W13** — hygiene.

Release may be declared only when the checklist in
`docs/phase-6u-b3-ds-next-plan.md` §3 is fully ticked.
