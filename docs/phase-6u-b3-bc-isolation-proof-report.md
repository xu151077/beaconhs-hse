# BC — Isolation Proof & Freeze / Collabora E2E

Date: 2026-10-16. Branch `hse-platform`.
Report path: `docs/phase-6u-b3-bc-isolation-proof-report.md`.

## 1. Environment snapshot verified (read-only, no secrets)

- Remote web image: `beaconhs:phase-ap-an-20261016`
- Compose project labeled container `beaconhs-phase-aj-web-1`, 7 running services.
- Tenant count in the isolated database: **2**
- Existing shared tenant: `phase-aj-test` (`de8a882e-…`)
- Created BB tenant: `phase-bb-isolated-freeze-tenant-1792133778134`
  (`ea5a149b-ea76-48e0-abbe-fa360f520d8e`) — created earlier in Phase BB.
- Remote runtime `R2_ENDPOINT = https://beaconhs-test.xuhaoqing.top`.
- Remote runtime `R2_INTERNAL_ENDPOINT = http://beaconhs-phase-aj-minio-1:9000`.
- CSP observed earlier in remote response contains the public origin.

## 2. Isolation findings

- Network path through the gateway (`127.0.0.1:3012` -> MinIO `172.18.0.1:3011` only for `BUCKET_PREFIX`) remains the isolation mechanism for AJ.
- At least two tenants now exist in the same isolated database + same isolated bucket prefix.
  Therefore, their runtime separation relies on the application-level tenant ID plus RLS, not on
  physically distinct backends.
- No read proof was collected in this pass showing a separate test tenant identity without exposing another
  tenant's data, attachments, or objects. The super-admin console is still seeded against the
  shared Phase AJ tenant.
- **Isolation boundary therefore remains not proven**, which disallows any freeze write round-trip or
  attachment mutation against the new tenant.

## 3. Freeze browser E2E (NOT RUN)

Status remains **NOT RUN / BLOCKED**:

- Without browser-level confirmation that the session is scoped to the dedicated tenant and cannot leak
  to the shared one, attempting a freeze transition would violate the stated safety boundary.
- Database/API evidence from AL pass (16 DB scenarios, `applyTransition`, `ensureFreezeRow` and the
  gate logic) remains PASS at code/test level, explicitly not equivalent to live browser proof.
- Cleanup was not needed because no freeze transition was executed.

## 4. Collabora status (NOT RUN)

- Remote WOPI discovery still returns a valid discovery document.
- The app still displays `In-browser editing is not configured` and no complete browser save loop
  was observed.
- Only discovery (HTTP 200) is confirmed; **NOT RUN / UNKNOWN** otherwise.

## 5. Evidence roll-up

- Remote deploy proof: PASS.
- Public origin presign + single-file upload + SHA: PASS.
- Multipart browser all-part PUTs: PASS.
- Multipart finalization + download SHA: PASS (Phase AZ).
- Freeze DB/API + tenant attachment RLS: logic PASS in tests, no live browser proof.
- Freeze browser: **NOT RUN**
- Collabora browser editing: **NOT RUN**
- Production IAM/lifecycle/backup/alert/network: **BLOCKED/NOT RUN / UNKNOWN** (still no prod
  authorization).

Conclusion: G2 stays **BLOCKED**. Security-relevant DB and browser evidence is substantial, but the
remaining open categories have not been exercised under confirmed isolation. No repository, remote
configuration, or database value was changed during this BC pass.
