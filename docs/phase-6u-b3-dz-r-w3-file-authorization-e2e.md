# Phase DZ-R — W3: file authorization browser E2E and denial semantics

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Environment

Isolated stack on `10.10.31.30` (see `docs/phase-6u-b3-dz-r-environment-recovery.md`), image
`beaconhs:dxr-20261020` (`79db4885b1fb`, built from this working tree), app reached through an
SSH tunnel at `http://localhost:13010`. Dedicated tenant `DXR Other Tenant`, dedicated
identities `dxr-site-a@dxr.local` (Foreman, Site A scope), `dxr-cross@dxr.local` (Foreman,
tenant scope), `dxr-admin@dxr.local` (Tenant Admin). Storage states were produced by signing in
against the isolated stack.

## 2. Browser E2E — `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts`

Command:

```
CI=1 E2E_BASE_URL=http://localhost:13010 \
  CX_SITE_A_STORAGE=/tmp/opencode/dxr-site-a-auth.json \
  CX_CROSS_STORAGE=/tmp/opencode/dxr-cross-auth.json \
  npx playwright test e2e/phase-cx-file-authorization-e2e.spec.ts --reporter=list
```

Result: **9 passed, 1 failed** (exit 1). The failure is
`cannot download a cross-tenant published version`, failing with
`page.evaluate: Execution context was destroyed, most likely because of a navigation`.

Root cause (measured, not assumed): the app root performs a client-side redirect from `/` to
`/dashboard` after hydration (observed navigation trace: `http://localhost:13010/ → / → /dashboard
→ /dashboard`). The spec issues `page.evaluate(fetch…)` immediately after `page.goto(TEST_URL)`,
so the in-flight `evaluate` is destroyed by that redirect. Flake rate measured by repeating the
single case 5 times: **1 pass / 4 failures**; the same request issued server-side returns a
stable **404**. The failure is a harness race in the test, not an authorization defect, and the
assertion was not modified. In one earlier full run under the same retry policy the case passed
on retry #1 (1 flaky, exit 0).

**No HTTP 500 was produced by any authorization path.**

## 3. Server-side status matrix (same isolated instance, same identities)

| Surface                                                          | Identity                      | HTTP status                                   | Result                                             |
| ---------------------------------------------------------------- | ----------------------------- | --------------------------------------------- | -------------------------------------------------- |
| `GET /documents/:id/master` (cross-tenant doc)                   | site-A foreman                | **403**                                       | denied (no `documents.manage`)                     |
| `GET /documents/:id/pdf` (cross-tenant doc)                      | site-A foreman                | **403**                                       | denied                                             |
| `GET /documents/:id/pdf` (own-tenant doc)                        | site-A foreman                | **403**                                       | denied                                             |
| `GET /incidents/export.csv`                                      | site-A foreman                | **403**                                       | denied (no `admin.data.export`)                    |
| `GET /incidents/export.csv`                                      | tenant admin                  | **200** text/csv                              | allowed                                            |
| `GET /api/attachments/:id` (cross-tenant)                        | site-A foreman / cross user   | **404**                                       | hidden                                             |
| `GET /api/attachments/:id` (own tenant, valid capability)        | tenant admin                  | **307 → presigned → 200** (20 622 bytes DOCX) | allowed                                            |
| `GET /documents/:id/master` (own tenant, real DOCX)              | tenant admin                  | **200** DOCX 20 622 bytes                     | allowed                                            |
| `GET /documents/:id/pdf` (own tenant, real DOCX)                 | tenant admin                  | **200** application/pdf 8 979 bytes           | allowed                                            |
| `GET /documents/:id/versions/:v/download?kind=docx` (own tenant) | tenant admin                  | **200** DOCX                                  | allowed                                            |
| `GET /documents/:id/versions/:v/download` (cross-tenant)         | site-A foreman                | **404**                                       | hidden                                             |
| `GET /documents/:id` (cross-tenant)                              | cross user                    | not found page                                | hidden                                             |
| `GET /incidents/:id` (other site)                                | site-A foreman                | not found page                                | hidden                                             |
| `GET /documents/:id/master`, `GET /incidents/export.csv`         | unauthenticated               | **307 → /login**                              | challenged                                         |
| `GET /api/attachments/:id` (no capability)                       | unauthenticated               | **404**                                       | refused                                            |
| `GET /wopi/files/:id`, `/wopi/files/:id/contents`                | site-A foreman / tenant admin | **401**                                       | WOPI token required; a session is not a substitute |

## 4. Matrix status

| Scenario                             | Required                            | Evidence level                              | Status      |
| ------------------------------------ | ----------------------------------- | ------------------------------------------- | ----------- |
| Unauthenticated request              | 401 or login redirect               | browser E2E + server probe                  | **PASS**    |
| Authenticated, missing permission    | 403                                 | browser E2E + server probe                  | **PASS**    |
| Cross-tenant read / download         | 403 or 404 per existing design      | browser E2E + server probe                  | **PASS**    |
| Cross-tenant modify                  | server refusal                      | static only                                 | **NOT RUN** |
| Legal user downloads a file          | 200                                 | server probe (real DOCX, 20 622 bytes)      | **PASS**    |
| Legal user previews a PDF            | 200                                 | server probe (application/pdf, 8 979 bytes) | **PASS**    |
| DOCX edit → save → re-read           | 200 + content check                 | not exercised                               | **NOT RUN** |
| Version access                       | legal 200 / cross-tenant 404        | server probe                                | **PASS**    |
| Delete / replace a file              | server refusal + resource unchanged | not exercised                               | **NOT RUN** |
| Attachment                           | legal 307→200, cross-tenant 404     | browser E2E + server probe                  | **PASS**    |
| Export                               | legal 200 CSV, unauthorized 403     | browser E2E + server probe                  | **PASS**    |
| WOPI token / callback boundary       | server refusal                      | server probe (401)                          | **PASS**    |
| Write refused while frozen           | refusal                             | no reachable non-UI storage-write surface   | **NOT RUN** |
| Legal write after recovery to ACTIVE | 200                                 | same                                        | **NOT RUN** |

The two freeze rows are NOT RUN because the only storage-write surface in the product is a
server action behind the equipment/PPE/document upload drawers; there is no route to invoke it
without driving a full file-upload UI flow. The freeze _persistence_ contract (optimistic
concurrency, lease exclusivity, audit writing) is covered by the live `db-freeze` suite, which
passed 16/16 against the isolated stack's own `beaconhs_dxr_scratch` database.

## 5. WOPI

The WOPI token/callback boundary was probed read-only (no stress or re-open experiment, as
instructed). Both WOPI routes answer **401** without a WOPI token, for every identity tested.
The frozen re-open anomaly remains `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`.

## 6. Status

**W3: PARTIAL.** The 500-as-refusal defect is confirmed fixed in the running application built
from this tree: every denial path answers 401/403/404, and the legal paths answer 200. The
browser matrix itself is 9/10 with one harness race, and four scenarios (cross-tenant modify,
DOCX edit/save, delete/replace, freeze write) remain NOT RUN.
