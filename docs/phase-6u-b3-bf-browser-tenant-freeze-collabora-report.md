# BF — Browser Tenant Access + Freeze / Collabora E2E Closure Attempt

Date: 2026-10-16 (UTC ~07:33). Branch `hse-platform`.

## 1. Tenant access diagnosis

- Phase AJ Test Tenant remains the only configured browser session target.
- The platform UI provides `Tenant workspace` / `Platform` switching but does **not** expose a tenant-scoped session for
  the newer tenant named in Phase BB (`phase-bb-isolated-freeze-tenant-1792133778134`) on the super-admin shell.
- A tenant existed in the database, but no separate user/membership/role record was visible for isolating
  browser actions to that tenant; creation/membership assignment would require more tenant data handling
  than is safe for this pass.

## 2. Detailed isolation findings

- DB-level isolation is supported by `FORCE RLS` on `attachments` and `app.tenant_id`.
- Two live tenants proof in Phase BD shows tenant A cannot read/write tenant B.
- No tenant-specific user for browser workflows can be created without also creating a user account,
  role assignment and password/magic-link handling.
- The required authorization propagation and session refresh was **not proven**.

## 3. Freeze (NOT RUN)

- No live browser state transition verdict, because switching into the isolated tenant was not proven.
- Audit/inflight/reservation, ACTIVE deposit and reject evidence were not captured against this tenant.
- DB/root-level evidence from Phase AL: storage-freeze state-machine, API gate and RLS behavior remains PASS.

## 4. Collabora (NOT RUN)

- WOPI discovery is valid, but the in-app editor still cannot edit.
- No WOPI token, CheckFileInfo, GetFile, PutFile request was needed because ACTIVE editing never started.
- FROZEN save 423 could not be observed.

## 5. Multipart evidence (preserved)

- 5 public HTTPS part PUTs at 200.
- Attachment 272629760 bytes persisted with SHA-256 `b06e…`, matching source.
- Single-file upload/download with exact SHA already PASS (AS/AX/AZ).
- UI-level `Files (1)` was eventually observed after upload/finalization and before associated
  save state was completed in the drawer (attachment already existed).

## 6. Summary

- Freeze/Collabora E2E still **NOT RUN**.
- File/upload integrity closure PASS remains evidence-backed.
- G2 stays **BLOCKED** because browser write-refusal/edit durability evidence is absent.

No commit, push or additional remote action. Only report output.
