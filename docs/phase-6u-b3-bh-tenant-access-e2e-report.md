# BH — Native Tenant Delegation & Isolated Freeze / Collabora E2E

Date: 2026-10-16 (UTC ~08:00). Branch `hse-platform`.

## 1. Root cause and exact blocker

- Dedicated tenant `phase-bb-isolated-freeze-tenant-1792133778134`
  (`ea5a149b-ea76-48e0-abbe-fa360f520d8e`) exists in storage-scope.
- Remote DB indicates **zero `tenant_users` and zero `role_assignments`** for that tenant.
- Without a native membership/role scoped to this tenant, there is no authorized browser
  principal and no safe way to own, upload, or recover the test workspace.
- The subsequent Freeze/Collabora phases therefore remain **NOT RUN**.

## 2. Evidence from deployed AJ

- Remote run image: `beaconhs:phase-ap-an-20261016`.
- `R2_ENDPOINT` and `PUBLIC_APP_URL` align to `https://beaconhs-test.xuhaoqing.top`.
- CSP observed includes public origin.
- App tenant enumeration shows one writable shared tenant only and the utility switch at top
  only toggles `Tenant workspace` / `Platform`, without exposing the new test tenant.
- The new tenant has no attached membership or role assignment.
- DB query result for tenant members and role assignments = 0 for tenant `ea5a…`.

## 3. Multipart and file integrity (not repeated)

- Prior phases already proved and retained:
  - five part PUTs = 200 against public HTTPS origin;
  - attachment row size `272629760`;
  - source SHA-256 equals downloaded object SHA-256:
    `b06e1c7663f17e9388643baddb72fb5c9af7b867e58d407cf5c44940333cbf1c`.
- This phase adds no new multipart regressions; existing 148 storage tests remain PASS from prior runs.

## 4. Freeze (NOT RUN)

- No dedicated principal means no safe ACTIVE upload and refusal/restore sequence can be
  executed against this tenant.
- `applyTransition` and DB gate tests remain PASS at the code/routine edge, but that is not browser proof.
- No state was advanced and no freezes were attempted.

## 5. Collabora (NOT RUN)

- `hosting/discovery` returns discovery XML, but app still says `In-browser editing is not configured`.
- No real edit-save-open proof can be provided.
- frozen-write rejection cannot be distinguished from general non-configured editor failure.

## 6. Remaining closure path

1. Create a **dedicated native user + tenant membership + least-privilege role** for the BB tenant
   using the app's official provisioning/auth flow (not arbitrary credential injection).
2. Verify login/session tenant context/database RLS as isolated to that principal.
3. Run the full Freeze sequence only after that boundary is documented.
4. Repair/configure Collabora on the isolated tenant before invoking WOPI save proof.

## 7. Status Matrix

- Single-file + SHA: PASS
- Multipart parts + final object + download SHA: PASS (remote evidence)
- Tenant DB isolation: PASS
- Tenant browser isolation: **NOT PROVEN / NOT RUN**
- Freeze browser E2E: **NOT RUN / FAIL**
- Collabora editing: **NOT RUN / FAIL**
- G2: **BLOCKED**

No repository, production, shared-service or secret data was changed during this pass.
