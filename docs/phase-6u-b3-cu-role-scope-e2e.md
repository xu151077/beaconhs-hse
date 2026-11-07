# Phase 6U-B3-CU — Role Scope / cross-tenant E2E

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Environment: local isolated environment (`beaconhs-postgres`, demo tenant `8b62c4c2-...`, phase-bs-isolated tenant `aca29e48-...`)

## 1. Scope

No Project Scope variant was introduced. Existing `RoleScope` variants and visibility tiers were used. Site scope was used as the finest existing scope for the “project-restricted user” scenario.

## 2. Browser verification

Isolated local users were provisioned in the demo tenant:

- `cu-site-a@example.local`: built-in `foreman` role, scope `{type:'sites', siteIds:[Site A]}`.
- `cu-site-b@example.local`: built-in `foreman` role, scope `{type:'sites', siteIds:[Site B]}`.
- `cu-cross@example.local`: membership only in `phase-bs-isolated`, no demo-tenant membership.

Verified results:

| Scenario                                                     | Result                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Site A user opens `/incidents`                               | Sees Site A incidents only (`Hand tool dropped from scaffold`, `Cut on right hand while opening crate`) |
| Site A user opens Site B incident by direct URL              | `Page not found`                                                                                        |
| Cross-tenant user opens a demo-tenant incident by direct URL | `Page not found`                                                                                        |

## 3. Not fully covered

File download, preview, edit, and export surfaces were not exercised in the browser in this pass. Existing contract tests (`authorization-bridge-contract`, `moduleScopeWhere`, `canSeeRecord`, export-scope authorization) continue to cover those predicates at the unit level. A future browser spec should add direct attachment-download and export-route checks for site-scoped users.

## 4. Status

Partial pass. Cross-tenant and site-scope list/detail authorization were verified in the browser. File-surface authorization remains covered by unit/contract tests, not by browser E2E.
