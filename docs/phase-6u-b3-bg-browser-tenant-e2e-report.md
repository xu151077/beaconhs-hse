# BG — Browser Tenant Access + Freeze / Collabora E2E

Date: 2026-10-16 (UTC ~07:50). Branch `hse-platform`.

## 1. Tenant-access investigation

- `Phase BB Freezeyba…?` tenant provisioning succeeds and is visible in tenant-local `beaconhs` database.
- However, switching the **super-admin browser session** into that tenant was not proven; the platform-local
  `Switch workspace` control only exposes `Tenant workspace` / `Platform` layers in the visible UI.
- A tenant with no membership or role assignment cannot be used safely for UI tests because the actor
  context cannot be established without violating RBAC or creating ad hoc permissions.
- Therefore no new actor was authorized to write protected uploads or state transitions in this pass.

## 2. Live freeze browser E2E

NOT RUN.

Reason:

- no confirmed writable and newly isolated account to own the test upload;
- creating or elevating a user and assigning a membership was outside the scope of this safe report;
- direct state manipulation would bypass audit and permission expectations.
- Database/API evidence remains PASS from earlier phases, but actual browser HTTP 200/423 flow is **not**
  evidenced.

## 3. Collabora

NOT RUN.

- No runnable account/tenant pair; WOPI discovery response is healthy, but actual editor is still
  `not configured` and no save succeeded.
- Discovery only is not editing evidence.

## 4. Multipart remained PASS at S3 level

- prior valid network evidence shows 5 part PUTs returning 200 on public HTTPS origin, plus DB attachment + 272629760 object SHA `b06e…`.
- UI-level Save file acceptance previously blocked only because the equipment Files list was not
  refreshed after upload. A second verification reached a Files (1) list after waiting
  (but not yet within browser evidence timeframe).

## 5. G2 remaining status

- Still **BLOCKED** because:
  - freeze browser refusal + restore cannot be safely exercised without an isolated browser tenant;
  - Collabora editing not runnable;
  - production IAM/lifecycle/backup/alert/network still need proper authorization.

Report: `docs/phase-6u-b3-bg-browser-tenant-e2e-report.md`; no infra or code change, no commit / push / drop.
