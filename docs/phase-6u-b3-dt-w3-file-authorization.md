# Phase DT-W3 — File authorization refusal status and release-image verification

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Verification target: **the current working tree**, including the pre-existing Phase CX
changes and the DT changes below. The current release image (`beaconhs:dr-mirror-51a899b7`)
predates the DT changes and does not contain this fix.

## 1. The defect

`assertCan()` throws `ForbiddenError` from `@beaconhs/tenant`. Route handlers that did not
cross `withRouteErrors` let that exception reach Next.js, which renders an opaque **500**.
The Phase CX file-authorization matrix had encoded that 500 as the expected refusal for:

- `GET /documents/:id/master` — a cross-tenant document master;
- `GET /incidents/export.csv` — a site-scoped user without export permission.

A 500 is not an authorization outcome. It is indistinguishable from a database or rendering
fault, it hides real regressions, and it tells an operator nothing about whether the request
was refused or broken.

## 2. The fix

`apps/web/src/lib/api/errors.ts` already had `withRouteErrors` for the public API envelope.
It now maps **both** authorization refusals to `403`:

- `ForbiddenError` (missing permission);
- `ImpersonationBlockedError` (bulk export while impersonating).

Every other error is rethrown, so a real fault remains a 5xx and is never disguised as a
refusal. The 403 body is the generic `{ error: { code: 'forbidden', message: 'Forbidden' } }`
and does not name the missing permission.

The wrapper was applied to **all 32** authenticated route handlers under `apps/web/src/app`
that call `assertCan` or `requireExportContext` (the six that already used it plus 26 in this
phase). The transformation preserves each handler's signature and body: the existing
function is renamed to `<method>Handler` and re-exported through the wrapper. No handler
logic was rewritten.

The resulting status contract is:

| Caller state                                    | Result                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| No session                                      | `requireRequestContext` redirects to `/login` (the project's established flow); the attachment route returns `401` before the capability check |
| Authenticated, missing permission               | `403` (generic body)                                                                                                                           |
| Authenticated, resource absent or hidden by RLS | `404` (the existing security design)                                                                                                           |
| Unexpected internal fault                       | 5xx, unchanged and logged by the handler                                                                                                       |

## 3. Tests that ran

| Test                                        | Command                                                                                | Result                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| Wrapper semantics                           | `pnpm --filter @beaconhs/web exec vitest run src/lib/api/errors.test.ts`               | **PASS** (4/4)                          |
| Every permission-asserting route is wrapped | `pnpm --filter @beaconhs/web exec vitest run src/lib/api/route-error-contract.test.ts` | **PASS** (2/2; 32 wrapped, 0 offenders) |
| Web typecheck                               | `pnpm --filter @beaconhs/web typecheck`                                                | **PASS** (exit 0)                       |
| Web lint                                    | `pnpm --filter @beaconhs/web lint`                                                     | **PASS** (exit 0)                       |

The contract test is source-based on purpose: a new export or PDF route is covered the
moment it calls `assertCan`, so the 500 cannot silently return.

The Phase CX browser spec was corrected and extended:

- the two `toBe(500)` assertions now accept only `403`/`404` and explicitly assert the status
  is below 500;
- a cross-tenant version-download case was added;
- an unauthenticated group asserts a login challenge (redirect or 401) for the master
  download and the export.

File: `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts`.

## 4. File-surface matrix — honest coverage

The matrix below separates what is proven by a test that ran here from what is only wired
or documented. Nothing marked NOT RUN is being reported as a pass.

| Surface                          | Server authorization                                                                | Browser E2E                                    | Status      |
| -------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- | ----------- |
| Attachment download / capability | `401` when unauthenticated, `404` on bad capability or missing row (existing route) | CX cross-tenant attachment case wired, not run | **PARTIAL** |
| Document master download         | wrapped → `403`/`404`                                                               | CX case updated, not run                       | **PARTIAL** |
| Document PDF preview             | wrapped → `403`/`404`                                                               | not automated                                  | **PARTIAL** |
| DOCX import / edit / save        | not changed in DT                                                                   | not automated                                  | **NOT RUN** |
| DOCX download (version)          | wrapped → `403`/`404`                                                               | CX version case added, not run                 | **PARTIAL** |
| Version access                   | wrapped → `403`/`404`                                                               | CX version case added, not run                 | **PARTIAL** |
| Delete / replace document        | not changed in DT                                                                   | not automated                                  | **NOT RUN** |
| Export (`export.csv`)            | wrapped → `403`/`404`                                                               | CX export case updated, not run                | **PARTIAL** |
| Cross-tenant read                | RLS hides the row → `404`                                                           | CX read cases wired, not run                   | **PARTIAL** |
| Cross-tenant modify              | not changed in DT                                                                   | not automated                                  | **NOT RUN** |
| Cross-tenant download            | wrapped/RLS → `403`/`404`                                                           | CX cases wired, not run                        | **PARTIAL** |
| No session                       | redirect to `/login`; attachment `401`                                              | CX unauthenticated cases added, not run        | **PARTIAL** |
| No permission                    | `403`                                                                               | CX export case updated, not run                | **PARTIAL** |
| Not found                        | `404`                                                                               | CX case wired, not run                         | **PARTIAL** |
| Freeze write denial / recovery   | not exercised in DT                                                                 | not automated                                  | **NOT RUN** |
| WOPI token / callback            | unchanged — see §5                                                                  | not automated                                  | **NOT RUN** |

**Why the browser matrix did not run:** the repository has no E2E job in CI, and the CX spec
depends on pre-authenticated storage states plus a multi-tenant seeded app, object storage,
and Collabora. The local dev server was not running, and this phase is forbidden from
starting or operating the shared dev stack, from using the production database, and from
deploying. The spec is updated and ready, but running it requires a dedicated isolated stack.
That is a real gap, not a skipped assertion inside a passing suite.

**Why the release image does not prove the fix:** `beaconhs:dr-mirror-51a899b7` was built at
the current HEAD before the DT edits. It is useful for the W2 image-key gate, but it cannot
contain the W3 wrapper change. A new image build is required to verify the fix in the release
artifact.

## 5. WOPI status

**KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED.**

The WOPI token/callback boundary was not changed in this phase. The known anomaly remains
recorded in the DS evidence and is not reclassified as fixed, won't-fix, or eliminated. The
WOPI token/callback matrix rows are NOT RUN.

## 6. Honest status

**W3: PARTIAL.**

- The 500-as-refusal contract defect is fixed at the shared boundary and applied to every
  permission-asserting route.
- The source contract, wrapper unit tests, typecheck, and lint pass on the current tree.
- The browser/RBAC file-surface matrix, the current release image, WOPI, and the freeze
  scenarios are **NOT RUN** for the reasons above. No PASS is claimed for them.

## 7. Residual risks

1. **No live browser proof in this phase.** A regression in route wiring, RLS, or the login
   redirect would not be caught by the unit/contract tests. The next environment must run
   `pnpm test:e2e` against an isolated seeded stack and record the results.
2. **`withRouteErrors` is still imported from `lib/api/errors`.** It is shared by page routes
   and the public API; the name is historical, not a behavioural limit. A future cleanup can
   move it to a neutral `lib/route-errors` module without changing behaviour.
3. **403 vs 404.** The status depends on whether the caller holds the permission: a
   cross-tenant user with the permission gets 404 (RLS), one without gets 403. Both are
   intentional and neither reveals resource existence beyond the permission the caller
   already holds.
4. **Non-route server actions.** This phase covers route handlers. Server Actions have their
   own error boundary; they were not audited here.
