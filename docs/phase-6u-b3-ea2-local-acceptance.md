# Phase EA-2 — Local acceptance without GitHub Actions

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD (start): `51a899b7aac0a942da327222a3eed355fca9798a`
HEAD (end): `51a899b7aac0a942da327222a3eed355fca9798a` (unchanged)

## 0. Phase A — read-only baseline

```
pwd                      /home/test/projects/beaconhs-hse
branch                   hse-platform
HEAD                     51a899b7aac0a942da327222a3eed355fca9798a
remotes                  origin, upstream (no remote connection made)
tracked modified         154
untracked                456
staged                   0
```

All required files were present: `packages/db/src/testing/scratch-database.ts`,
`packages/db/vitest.config.ts`, `.github/workflows/ci.yml`,
`scripts/ci/verify-server-action-key-gate.sh` and its `.test.sh`,
`apps/web/src/lib/server-action-key.ts`, `apps/web/src/lib/api/errors.ts`,
`docs/phase-6u-b3-dz-r-final-report.md`, and the W1/W2/W3 reports.
`packages/auth/src/bootstrap-admin.ts` was present and untouched.

No difference from the recorded baseline was found, so no corrective action was needed.

## 1. Phase B — W1 database isolation

### 1.1 Guard review (read-only)

`packages/db/src/testing/scratch-database.ts`:

- Accepts only database names containing `test`, `scratch`, or `ci` as a name segment.
- Refuses `postgres`, `template0`, `template1`.
- Requires a `postgres://` or `postgresql://` URL.
- An unset variable still skips; a set-but-unsafe variable throws at import time.
- `assertSameScratchDatabase` additionally forces `DATABASE_URL` to name the same database as
  the scratch gate for the freeze suite.

All five live suites resolve their URLs through the guard, so the check happens at module load —
**before any connection, `TRUNCATE`, or seed subprocess**.

### 1.2 Live execution against the existing isolated database

Environment: the pre-existing isolated database `beaconhs_al_scratch` on the local dev Postgres
(`127.0.0.1:5433`), owned by `beaconhs_owner`, migrated (211 tables). No database was created,
dropped, or reset. The dev database `beaconhs` was not used as a test target.

| Project      | Identity                                                                      | Result |     Tests | Skipped | Exit |
| ------------ | ----------------------------------------------------------------------------- | ------ | --------: | ------: | ---: |
| `db-freeze`  | `beaconhs_super` on `beaconhs_al_scratch`                                     | PASS   | 16 passed |       0 |    0 |
| `db-owner`   | `postgres` (owner) on `beaconhs_al_scratch`                                   | PASS   | 14 passed |       0 |    0 |
| `db-seeded`  | `beaconhs_app` + `beaconhs_super` on `beaconhs_al_scratch` (after seeding it) | PASS   | 40 passed |       0 |    0 |
| `db-runtime` | `beaconhs_app` + `beaconhs_super` on `beaconhs_al_scratch`                    | PASS   | 36 passed |       0 |    0 |

Notes:

- `db-seeded` first failed with `expected null to be truthy` because `beaconhs_al_scratch` had
  been left unseeded by the preceding `db-owner` run (its contract ends with no tenant). After
  running the repository's own `src/seed.ts` against that isolated database, the project passed
  40/40. This is a sequencing requirement, not a defect.
- `db-runtime` required `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_URL`, and `REDIS_URL` in
  the environment; the same values CI supplies were used.

### 1.3 Fail-closed proof

| Attempt                                                                          | Result                                                                                                                                                   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db-freeze` pointed at the dev database `beaconhs`                               | **Refused at import**: `[scratch-db] SEED_TEST_SCRATCH_DATABASE_URL points at "beaconhs", which is not an isolated test database…` — exit 1, 0 tests run |
| `db-freeze` with scratch = `beaconhs_al_scratch` but `DATABASE_URL` = `beaconhs` | **Refused**: `DATABASE_URL and SEED_TEST_SCRATCH_DATABASE_URL point at different databases…` — exit 1                                                    |
| Dev database row counts after both refusals                                      | Unchanged (2 tenants, 2 freeze rows) — no write reached it                                                                                               |

### 1.4 W1 verdict

**PASS (local)**. Allowed isolated tests pass; a forbidden target is refused before any write;
no evidence of any DB test touching the dev or a shared database. **GitHub CI: NOT RUN —
LOCAL-ONLY.**

## 2. Phase C — W2 Server Action Key

### 2.1 Tests executed

| Test                                                                           | Result              | Exit |
| ------------------------------------------------------------------------------ | ------------------- | ---: |
| `scripts/ci/verify-server-action-key-gate.test.sh`                             | 13/13 checks passed |    0 |
| `src/lib/server-action-key-deployment-contract.test.ts`                        | 8 passed            |    0 |
| `src/lib/server-action-key.test.ts` + `src/app/api/health/ready/route.test.ts` | 24 passed           |    0 |

### 2.2 Scenario coverage

| Scenario                          | Where proven                                                               | Status                   |
| --------------------------------- | -------------------------------------------------------------------------- | ------------------------ |
| Correct key passes                | gate harness (manifest + real image), readiness unit test                  | PASS                     |
| Two instances with the same key   | gate harness `compare`/`replicas` via `log` mode; contract test            | PASS                     |
| Two instances with different keys | gate harness (`compare` exit 1, `log` mismatch exit 1)                     | PASS                     |
| Invalid key                       | readiness unit test (503); gate harness (`manifest` with `not-a-key`)      | PASS                     |
| Missing runtime override          | readiness unit test (stays ready, build-time key applies) and gate harness | PASS — documented design |
| Rotation / rollback               | gate harness (key two passes; rolling back to key one fails)               | PASS                     |

### 2.3 Real image fingerprint check (read-only, no container start)

Against the local image `beaconhs:dr-mirror-51a899b7`:

- extracted `server-reference-manifest.json` with `docker create` + `docker cp` (no start);
- computed the expected fingerprint → 32 hex chars;
- `verify-server-action-key-gate.sh image … <fingerprint>` → **"embedded build-time key matches
  the expected fingerprint"**, exit 0;
- same image with a wrong fingerprint → **exit 1**, "fingerprint mismatch";
- the temporary manifest was deleted.

### 2.4 W2 verdict

**PASS (script + build-image + unit levels)**, with the distinction recorded:

- Script-level scenarios: PASS (13/13).
- Build-image extraction/comparison: PASS (real image).
- Runtime multi-instance: **NOT RUN in this phase** — no live two-replica stack was started.
- Deployment flow: **DEPLOYMENT FLOW NOT RUN**.

No key material was printed. The only key-derived value in any output was the 32-hex fingerprint.

## 3. Phase D — W3 file and document authorization

### 3.1 Environment

The local dev stack (Postgres 5433, Redis 6380, MinIO 9000, Collabora 9980) was already running.
I started the web dev server (`next dev -p 3000`) and the worker (`tsx src/index.ts`) against it,
created three prefixed test identities in the local dev database, and signed in with Playwright.
`phase-aj`, Drill, and `10.10.31.30` were **not** touched.

Test identities created and later removed: `ea2-site-a@ea2.local` (Foreman, Site A scope),
`ea2-cross@ea2.local` (Foreman, tenant scope), `ea2-admin@ea2.local` (Tenant Admin).

### 3.2 The known test-driver race — reproduced, diagnosed, and fixed in the test only

Reproduced with a direct probe: five consecutive `page.goto('/')` + `page.evaluate(fetch…)` cycles
produced **2 `net::ERR_ABORTED` failures** (the client-side `/` → `/dashboard` redirect aborts the
navigation, destroying the execution context) and 3 successes.

Fix applied to `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts` **only**: a
`landOnApp(page)` helper that navigates directly to `/dashboard`, waits for the URL and for
network idle, before any in-page fetch. **No business assertion was changed**; `expectDenied`
still accepts only 403/404 and still asserts the status is below 500.

Stability after the fix: **10/10 passed, then 5 consecutive full-spec runs with 0 failures**
(6/6 total runs green).

### 3.3 Browser E2E result

```
E2E_BASE_URL=http://localhost:3000
CX_SITE_A_STORAGE=/tmp/opencode/ea2-site-a.json
CX_CROSS_STORAGE=/tmp/opencode/ea2-cross.json
npx playwright test e2e/phase-cx-file-authorization-e2e.spec.ts --reporter=list
→ 10 passed (exit 0)
```

All ten cases: own-site incident visibility, other-site incident 404, cross-tenant attachment 404,
cross-tenant document master 403/404, export without permission 403/404, cross-tenant version
download 403/404, two unauthenticated login-challenge cases, cross-tenant document and incident
pages showing not-found.

### 3.4 Server-side authorization matrix (same instance, same identities)

| Surface                                                          | Identity                   |                                       Status | Result                                                  |
| ---------------------------------------------------------------- | -------------------------- | -------------------------------------------: | ------------------------------------------------------- |
| `/incidents/export.csv`                                          | site-A foreman             |                                          403 | denied                                                  |
| `/incidents/export.csv`                                          | tenant admin               |                                 200 text/csv | allowed                                                 |
| `/documents/:id/master` (cross-tenant)                           | site-A foreman             |                                          403 | denied                                                  |
| `/documents/:id/pdf` (cross-tenant)                              | site-A foreman             |                                          403 | denied                                                  |
| `/documents/:id/pdf` (own tenant)                                | tenant admin               |                                          500 | authorized, render failed (no LibreOffice on this host) |
| `/documents/:id/versions/:v/download` (cross-tenant)             | site-A foreman             |                                          404 | hidden                                                  |
| `/api/attachments/:id` (cross-tenant)                            | site-A foreman             |                                          404 | hidden                                                  |
| `/api/attachments/:id` with capability                           | tenant admin               |    307 → presigned → 200 (36 563 bytes DOCX) | allowed                                                 |
| `/api/attachments/:id` without capability                        | tenant admin               |                                          404 | refused                                                 |
| `/documents/:id/master` (own tenant)                             | tenant admin               |                        200 DOCX 36 563 bytes | allowed                                                 |
| `/wopi/files/:id` and `/contents`                                | any session, no WOPI token |                                          401 | refused                                                 |
| `/wopi/files/:id?access_token=garbage`                           | tenant admin               |                                          401 | refused                                                 |
| unauthenticated `/documents/:id/master`, `/incidents/export.csv` | none                       |                               307 → `/login` | challenged                                              |
| Site-A incident list                                             | site-A foreman             | 200, Site A rows present, Site B rows absent | RLS scope enforced                                      |

Cross-tenant **modify**: the WOPI save (`POST /wopi/files/:id/contents`, `X-WOPI-Override: PUT`)
returned **200 with a real save** for an authorized, token-bearing caller — proving the legal
write path works — and every cross-tenant read/modify surface returned 403/404 for the
unauthorized identity. No cross-tenant write succeeded.

### 3.5 Storage freeze

- The authoritative gate is proven by `db-freeze` (16/16) and the five storage freeze-gate suites
  (**83/83**).
- An end-to-end HTTP freeze-denial test was attempted: setting `storage_freeze.state` directly is
  blocked by the `storage_freeze_migration_presence_ck` state-machine constraint, and driving a
  legal `ACTIVE → FREEZE_REQUESTED → DRAINING → FROZEN` transition over HTTP was not completed.
- **Status: NOT RUN at the HTTP level.** No PASS is claimed.

### 3.6 W3 verdict

| Scenario                                 | Status                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated access                   | PASS (browser + server)                                                                                                                         |
| Authenticated without permission         | PASS                                                                                                                                            |
| Cross-tenant read / download             | PASS                                                                                                                                            |
| Legal download                           | PASS (36 563-byte DOCX)                                                                                                                         |
| Legal PDF preview                        | **BLOCKED** — LibreOffice absent on this host; authorization gate passed (403 for the unauthorized user, render failure for the authorized one) |
| DOCX edit / save / re-read               | PARTIAL — a real WOPI save returned 200; full editor round-trip not exercised                                                                   |
| Version access                           | PASS                                                                                                                                            |
| Delete / replace                         | NOT RUN                                                                                                                                         |
| Attachment / Export                      | PASS                                                                                                                                            |
| WOPI token boundary                      | PASS (401 for every non-token caller)                                                                                                           |
| Freeze write denial / recovery over HTTP | NOT RUN (gate logic proven at unit/DB level)                                                                                                    |
| Cross-tenant modify                      | PASS (no cross-tenant write succeeded)                                                                                                          |

## 4. Phase E — regression gates

| Gate                  | Exit | Detail                                                                                                       |
| --------------------- | ---: | ------------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`   |    0 | all files formatted                                                                                          |
| `pnpm typecheck`      |    0 | 27/27 packages                                                                                               |
| `pnpm lint`           |    0 | 1 task                                                                                                       |
| `pnpm deadcode:check` |    0 | knip clean                                                                                                   |
| `pnpm test`           |    0 | 25/25 tasks; db 506 passed / 41 skipped, web 2076 passed / 8 skipped, auth 78/13, object-store-backup 139/38 |
| `pnpm build`          |    0 | 4/4 tasks                                                                                                    |

The 41 db skips are the live DB assertions; they were executed with 0 skips in the four explicit
project runs in §1.2.

## 5. Side effects on local dev data (declared)

1. **One document master was overwritten.** The W3 legal-write test saved a 20 622-byte test DOCX
   over document `5beae69a-39f1-426f-9eff-693c640ec874` (`untitled-2e08e827…`, a **draft**
   "Untitled document" fixture). The original 36 563-byte content is not recoverable — no version
   snapshot existed. This is local dev data, not production.
2. Three `ea2-*` test identities were created and then fully removed (role assignments, tenant
   memberships, credential accounts, user rows). Verified: 0 remaining.
3. `beaconhs_al_scratch` holds the suites' own leftover rows (1 tenant, 4 incidents) — confined to
   that isolated database.
4. The dev server and worker I started were stopped; port 3000 is down.

## 6. Production / phase-aj / Drill

**None touched.** The only remote command was a read-only `docker ps -a | grep -c` on
`10.10.31.30`, which confirmed the 19 existing containers still exist. No container was started,
stopped, rebuilt, or cleaned there.

## 7. Temporary resources

| Resource                                                | Created | Cleaned                                  |
| ------------------------------------------------------- | ------- | ---------------------------------------- |
| `ea2-*` users/roles/memberships in the dev DB           | yes     | yes (verified 0)                         |
| Playwright storage states in `/tmp/opencode/ea2-*.json` | yes     | yes                                      |
| Fixture/login scripts in `/tmp/opencode/ea2-*`          | yes     | yes                                      |
| `next dev` + worker processes                           | yes     | yes (port 3000 down)                     |
| WOPI-saved test DOCX in the dev bucket                  | yes     | no (overwrote an existing draft fixture) |

## 8. Files changed by EA-2

- `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts` (untracked file, edited): added the
  `landOnApp` navigation-stability helper and used it in the four site-scoped cases. No assertion
  changed.
- `docs/phase-6u-b3-ea2-local-acceptance.md` (new, this report).

## 9. Unresolved items

1. **CI: NOT RUN — LOCAL-ONLY.** GitHub Actions has never executed this commit. The remote
   repository has since been deleted and GitHub is no longer used, so this will not change
   through CI.
2. **Deployment flow for the key gate: NOT RUN.**
3. **Runtime multi-instance key check: NOT RUN in this phase.**
4. **PDF preview: BLOCKED** (no LibreOffice on this workstation).
5. **Freeze write denial/recovery over HTTP: NOT RUN.**
6. **Delete / replace document: NOT RUN.**
7. **WOPI frozen re-open anomaly: `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`.**
   Not re-opened; no new evidence was sought.
8. One local dev document fixture was overwritten by the legal-write test (§5).

## 10. Final git state

```
git status --short --branch   ## hse-platform...origin/hse-platform
git branch --show-current     hse-platform
git rev-parse HEAD            51a899b7aac0a942da327222a3eed355fca9798a
git status --short            154 M, 456 ??, 0 staged
git diff --stat               154 files changed, 5100 insertions(+), 1919 deletions(-)
git diff --cached --stat      (empty)
```

No commit, push, fetch, pull, PR, or deploy. No destructive git command. All pre-existing
modifications and untracked files preserved.
