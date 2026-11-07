# BB — Isolated Tenant + Freeze / Collabora E2E

Date: 2026-10-16 (UTC ~07:17). Branch `hse-platform`.

## 1. Scope attempted

- Verify freezing a **fresh, dedicated tenant** and a full browser Freeze write origin/refusal proof.
- Verify Collabora saves and frozen-state 423 behavior.

## 2. Environment evidence

- Remote app image remains `beaconhs:phase-ap-an-20261016`.
- Runtime env public: `R2_ENDPOINT=https://beaconhs-test.xuhaoqing.top`,
  `APP_URL=https://beaconhs-test.xuhaoqing.top`.
- Live CSP still carries the storage origin.
- Only one existing tenant is present: `Phase AJ Test Tenant` (`de8a882e…`).

## 3. Isolation boundary check

- `Switch workspace` provides only the current `Tenant workspace` or `Platform` scope.
- `/platform/tenants/{id}` returns 404, so a tenant-centered runtime scope switch could not be proven by
  navigation alone. No isolated test tenant was available or created in this pass.
- Therefore freezing an isolated tenant could not be performed safely.

## 4. Freeze status (not run)

- No freeze transition was executed.
- ACTIVE writes were not re-tested in-browser.
- FROZEN 200/423 behaviour remains **NOT RUN** against a live browser (freeze DB-level evidence exists
  from Phase AL/AV).
- Cleanup of any frozen tenant was not applicable.

## 5. Collabora status (not run)

- WOPI discovery responded with XML from `https://beaconhs-test.xuhaoqing.top/hosting/discovery`.
- The app's document editor still surfaced `In-browser editing is not configured`, and no save
  round-trip was achieved.
- No roots or Collaboration changes were made.

## 6. What worked in prior phases

- Security, lint, format, deadcode, unit & gate baseline remain green.
- Single-file and multipart browser deposit ended with attaching rows that validated a 200 PUT and an
  `ar-multipart.pdf` of 272629760 bytes, plus a real 272629760-byte source SHA match.
  Editing still cannot assert page persistence or final attachment list contract before publish click,
  because Save-by-click required an additional operator assignment action (and could not be
  automatistically proven).

## 7. Risk note

- G2 **remains BLOCKED**. No production or shared resources were altered during this probe.
- A truly isolated freeze is the prerequisite before its safe execution, and would need:
  1. a tenant that no other test or user uses; 2. permission to modify its freeze transitions;
  2. enough evidence capture at each phase.
