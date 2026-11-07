# BE — Writable Test Tenant + Freeze / Collabora E2E

Date: 2026-10-16 (UTC ~07:22). Branch `hse-platform`.

## 1. Environment state already verified

- Remote image `beaconhs:phase-ap-an-20261016`.
- remote `R2_ENDPOINT=https://beaconhs-test.xuhaoqing.top`,
  `R2_INTERNAL_ENDPOINT=http://beaconhs-phase-aj-minio-1:9000`,
  `APP_URL` and `PUBLIC_APP_URL` also HTTPS domain.
- Live CSP includes public storage origin.
- Only two tenants exist in the isolated DB:
  - `phase-aj-test` (`de8a882e…`)
  - `phase-bb-isolated-freeze-tenant-1792133778134`
    (`ea5a149b-ea76-48e0-abbe-fa360f520d8e`).
- The `phase-bb` tenant was provisioned during this series and empty of user data; it could host future tests.
- application-level RLS (as proven in BD) is supported through `app.tenant_id`.

## 2. Isolated boundary and writable access

- DB-level tenant ACL was proven earlier with live SQL (tenant A self row visible, tenant B cannot see/write tenant A row).
- Object storage remains logically partitioned by tenant key prefix (`t/<tenantId>/...`) in the shared AJ bucket.
  Therefore, **physical object-store isolation is not claimed** even though access control and RLS are.
- A dedicated browser-test account was not created this round because enabling it would require
  making a user, assigning a built-in role, more secure secret handling and, then proving it has no
  access beyond the tenant; all without affecting `Phase AJ Test Tenant`.
- As a result, no live freeze browser transition happened.

## 3. Freeze status — **NOT RUN**

- Remote script path exists and was used once in a non-destructive `advance to freeze + release`
  round-trip against isolated tenant `ea5a…` (that execution succeeded to `ACTIVE v5`), but no
  browser-level write refused during `FREEZE_REQUESTED`.
- No `STORAGE_FROZEN` 423 observation in the browser was captured.
- No live tenant is safely available for a repeat verification. Audited, tenant state remains `ACTIVE`.

## 4. Collabora status — still **NOT RUN**

- Current document editor shows "In-browser editing is not configured" and produced no successful
  save/Open loop, plus one completed remote command proven (`hosting/discovery` returns valid XML).
- `COLLABORA_URL` is now set to the same HTTPS origin, but discovery alone is contrary proof, not
  editing.
- No source change was attempted and no configs changed for Collabora in this pass.

## 5. Minimum conditions for a truthful next run

1. Create a **separate writable tenant/account pair** and use it for write-phase tests, then remove it.
2. Add a Playwright script that explicitly performs,
   1. upload while `ACTIVE`,
   2. apply `FREEZE_REQUESTED` via isolated server/DB action directlyunder a SSOT server call,
   3. verify upload refusal and asset SHA unchanged,
   4. restore `ACTIVE` and re-upload.

   and capture every Network request status.

3. Repair and verify Collabora before running any editor verification.
4. Use a real production parameter list, not just isolation AJ test data.

## 6. Status matrix

- Single-file upload PASS
- multipart browser PASS
- download SHA PASS (272629760 / b06e…)
- tenant DB isolation PASS in RLS cross test
- tenant host/bucket **not** PASS; only app-level isolation demonstrated
- freeze browser: **NOT RUN**
- Collabora (ACTIVE save) / NOT RUN
- G2: **not PASS — freeze UI + editing + production evidence remain open**

No commit, push, production side-change or remote action taken. Only report.
