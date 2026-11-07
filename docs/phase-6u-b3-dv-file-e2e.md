# Phase DV-1 — File authorization browser E2E

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Environment check

- Local dev server at `http://localhost:3000`: **not reachable** (`curl` returned 000).
- Playwright config: `apps/web/playwright.config.ts`, `testDir: ./e2e`, `baseURL` from
  `E2E_BASE_URL` (default `https://beaconhs-test.xuhaoqing.top`).
- Storage states from Phase CX exist at
  `/tmp/opencode/phase-cx-site-a-auth.json` and `/tmp/opencode/phase-cx-cross-auth.json`.
- The remote default host and the shared dev stack were **not** contacted. Per the phase
  constraints, shared services are not operated and no new container/database/tenant was
  created without a declared, isolated resource plan.

## 2. Static review of `phase-cx-file-authorization-e2e.spec.ts`

The spec now contains:

- `expectDenied` helper: accepts only 403/404 and asserts status < 500.
- `expectLoginChallenge` helper: accepts 301/302/303/307/308/401.
- Site-scoped user cases: sees only own-site incidents; cannot open another site incident
  by URL (404); cannot download a cross-tenant attachment; cannot download a cross-tenant
  document master (403/404); cannot export incidents without export permission (403/404);
  cannot download a cross-tenant published version (403/404).
- Unauthenticated group (empty storage state): login challenge for the master download and
  the export.

This is a meaningful subset of the required matrix, but it does **not** cover upload, PDF
preview, DOCX import/edit/save/download, delete/replace, Attachment capability, WOPI token
or callback, or storage-freeze write denial/recovery.

## 3. Server-side verification that did run

The HTTP denial semantics were verified at the unit and contract level in DU-3:

- `apps/web/src/lib/api/errors.test.ts`: 4/4 (ForbiddenError → 403, ImpersonationBlockedError → 403,
  unexpected fault rethrows, normal response passes through).
- `apps/web/src/lib/api/route-error-contract.test.ts`: 2/2 (32 wrapped routes, 0 offenders).
- `pnpm --filter @beaconhs/web typecheck` and `lint`: 0.
- `pnpm --filter @beaconhs/web test`: 244 files, 2076 tests passed, 8 skipped.

These prove the boundary behaviour but not the browser flow, RLS at runtime, or the login
redirect path.

## 4. Browser E2E result

**NOT RUN.** No isolated app instance, seeded multi-tenant database, object storage, or
Collabora was available, and the shared dev stack was not started. The remote default host
was not contacted.

## 5. Minimum environment required to run DV-1

1. An isolated Postgres 16 (port not 5433 if the dev DB is in use) with the role provisioning
   and migration applied, plus seed data for at least two tenants with a site-scoped user on
   one site.
2. MinIO/R2 reachable from the app and the browser, with the bucket initialised.
3. Redis on a dedicated port for BullMQ.
4. The app built from the current tree (`pnpm build`) and started with
   `DATABASE_URL`/`SUPERADMIN_DATABASE_URL`/`MIGRATION_DATABASE_URL` pointing at the isolated
   DB, plus `REDIS_URL`, `BETTER_AUTH_SECRET`, `ATTACHMENT_CAPABILITY_SECRET`, and storage
   credentials.
5. Pre-authenticated Playwright storage states for the site-scoped and cross-tenant users.
6. Run: `E2E_BASE_URL=http://localhost:<port> pnpm test:e2e --grep "file authorization"`.

Until that environment exists, the browser matrix remains **NOT RUN** and no PASS is claimed
for it. The spec is ready and the server-side semantics are verified.
