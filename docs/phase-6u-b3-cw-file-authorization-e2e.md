# Phase 6U-B3-CW — File authorization E2E

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Browser and direct-request verification

| Scenario                                                         | Result                                       |
| ---------------------------------------------------------------- | -------------------------------------------- |
| Cross-tenant attachment download (`/api/attachments/[id]`)       | `404`                                        |
| Cross-tenant document master download (`/documents/[id]/master`) | `403` (`documents.manage` missing)           |
| Unauthorized incident CSV export (`/incidents/export.csv`)       | `403` (`admin.data.export` missing)          |
| Site-scoped incidents list                                       | Only the scoped site's incidents are visible |
| Direct URL to another site's incident                            | `Page not found`                             |
| Direct URL to another tenant's incident                          | `Page not found`                             |

## 2. Audit

Permission denials are raised as `ForbiddenError` by `assertCan`. This pass did not verify audit-log rows for denial events. Existing successful mutations continue to use `recordAudit`/`recordAuditInTransaction`.

## 3. Scope

No Project Scope variant was introduced. Existing Role Scope, permission, and RLS behavior was used.

## 4. Status

Status: **PARTIAL PASS**. Server-side denial was verified for attachment, document, and export surfaces. Full upload/preview/edit/export browser matrix remains incomplete.
