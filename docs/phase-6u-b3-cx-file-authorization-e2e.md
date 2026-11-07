# Phase 6U-B3-CX — File authorization E2E

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## Browser E2E matrix

A repeatable Playwright spec was added at `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts`. It passed 7/7.

| Scenario                              | Result                         |
| ------------------------------------- | ------------------------------ |
| Site-scoped incidents list            | PASS                           |
| Cross-site incident URL denial        | PASS                           |
| Cross-tenant attachment download      | PASS (404)                     |
| Cross-tenant document master download | PASS (500 / permission denial) |
| Unauthorized incident export          | PASS (500 / permission denial) |
| Cross-tenant document URL denial      | PASS                           |
| Cross-tenant incident URL denial      | PASS                           |

## Audit

Permission denials surface as `ForbiddenError`. This pass did not verify audit-log rows for denial events. Successful mutations continue to use the existing audit helpers.

## Scope

No Project Scope variant was introduced. Existing Role Scope, permission, and RLS behavior was used.

## Status

Status: **PASS** for the implemented browser matrix. Broader upload/preview/edit surfaces remain future work.
