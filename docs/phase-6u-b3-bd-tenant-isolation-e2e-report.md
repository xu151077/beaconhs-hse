# BC — Isolation Proof, Freeze/Collabora Phase Report

Date: 2026-10-16, branch hse-platform.

## 1. Ongoing isolated environment

- image `beaconhs:phase-ap-an-20261016`
- web environment `R2_ENDPOINT=https://beaconhs-test.xuhaoqing.top`
- CSP exposes the same public origin.
- app currently reports ready.

## 2. Tenant isolation — PASS (application layer)

- Performed:
  - insert test attachment row in tenant A while `app.tenant_id=A`;
  - switch app context to tenant B (`SELECT set_config('app.tenant_id', B, true)`);
  - tenant B count for A's row = 0;
  - attempted cross-tenant insert using tenant B session with tenant A's `tenant_id` throws
    `new row violates row-level security policy for table "attachments"`.
  - switch back to tenant A; deleting A's own row succeeds, final count returns to 0.
- Object storage may share bucket/path, so app-layer data integrity evidence is layer-app only,
  not a claim of physical-isolation. AJ-level bucket and tenant key spaces remain the same partitioning.

Pass classification: tenant database visibility/write boundary through RLS under `FORCE RLS`.
NOT sufficient for production-isolation claims. Place as `PASS (application-level only)`.

## 3. Freeze browser proof — NOT RUN

- An isolated dedicated tenant is required for non-destructive write operations and recovery.
- Available scope only currently includes shared Phase AJ Test Tenant; no isolated browser-scoped
  tenant can be safely confirmed.
- No freeze state transitions executed in browser, so neither freeze browser refusal nor
  download-while-frozen evidence available.
- Additional mining: possible state transition only via remote command execution, but with no safe
  operator-safe action, still blocked from user-facing execution.

## 4. Collabora browser proof — NOT RUN

- WOPI discovery returns valid XML and returns `https://beaconhs-test.xuhaoqing.top/...`.
- App editor behavior points to `COLLABORA_URL` as changed to same-origin domain, but persisted UI
  continues to report "In-browser editing is not configured" and "The PowerPoint editor did not
  respond."
- No real PutFile save was observed. Discovery success does not count as editing.
- No root cause correction attempted under current scope.

## 5. Multipart remains established in prior Phase

- 5 multipart part PUTs to public origin returned HTTP 200 in browser evidence.
- attachment row showed completion and object size matches source (`272629760`).

## 6. Matrix change from prior freeze/collab

- App-level tenant isolation PASS in remote DB RLS proof.
- Freeze state / Collabora full browser acceptance remain NOT RUN.

## 7. G2 status

Still BLOCKED because:

- freeze browser rejection/read-restore/audit evidence not available;
- Collabora complete edit/save not available;
- production R2/IAM, lifecycle, backup/restore and alert network runtime remain not executed.<|end|>
