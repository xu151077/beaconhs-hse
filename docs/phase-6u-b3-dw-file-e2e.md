# Phase DW-2 — File authorization browser E2E

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Result

**NOT RUN.** No isolated environment was available and the shared dev stack was not started.
See `docs/phase-6u-b3-dw-environment.md` for the minimum environment request.

## 2. Static review of the spec

`apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts` currently covers:

- Site-scoped user sees only own-site incidents.
- Site-scoped user cannot open another site incident by URL (404).
- Cross-tenant attachment download denied.
- Cross-tenant document master download denied (403/404, not 500).
- Incidents export without export permission denied (403/404, not 500).
- Cross-tenant published version download denied (403/404).
- Unauthenticated caller gets a login challenge (redirect or 401) for the master download
  and the export.

Not covered by the spec: upload, PDF preview, DOCX import/edit/save/download, delete/replace,
Attachment capability, WOPI token/callback, storage-freeze write denial/recovery. These remain
NOT RUN.

## 3. Server-side evidence that did run

- `apps/web/src/lib/api/errors.test.ts`: 4/4.
- `apps/web/src/lib/api/route-error-contract.test.ts`: 2/2 (32 wrapped, 0 offenders).
- `pnpm --filter @beaconhs/web typecheck`: 0.
- `pnpm --filter @beaconhs/web lint`: 0.
- `pnpm --filter @beaconhs/web test`: 244 files, 2076 tests passed, 8 skipped.

These prove the HTTP boundary behaviour but not the browser flow, RLS at runtime, or the
login redirect path.

## 4. Conclusion

Browser file-authorization E2E: **NOT RUN**. The spec is ready and the server-side semantics
are verified. No PASS is claimed for the browser matrix.
