# AS — Browser File Input, Download Integrity & Full E2E

Date: 2026-10-16 (UTC 05:46).
Branch: hse-platform (no commit/push).

## 1. Remote deployment and CSP

- `/api/health/ready`: `{"status":"ready"}` running image `beaconhs:phase-ap-an-20261016`.
- `R2_ENDPOINT=http:// internal? ...}`? Runtime probe already confirms
  `R2_ENDPOINT=https://beaconhs-test.xuhaoqing.top`,
  `R2_INTERNAL_ENDPOINT=http://beaconhs-phase-aj-minio-1:9000`,
  `APP_URL=https://beaconhs-test.xuhaoqing.top`,
  `PUBLIC_APP_URL=https://beaconhs-test.xuhaoqing.top`.
- `connect-src`: ` 'self' https://beaconhs-test.xuhaoqing.top ...`, which includes presign origin.
- Public bucket path prefix follows `/beaconhs-phase-aj/...`, matching AJ gateway special route.

## 2. File input implementation and automation

- BeaconHS exposes a hidden `<input type="file">` inside the document import UI, which was
  reached through the standard "New document" + "Import Word file" buttons.
- Playwright located that input and used `setInputFiles()` rather than a native file chooser
  requirement. This avoids masking a dialog and verifies the normal application path.
- The automated run set `/tmp/n4-restore-blank.docx` (36 563 bytes,
  SHA-256 `ca7fdcd02b07b1b40fc520bbe7b626973167183347b301624f6a1ad711b847e2`)
  and waited 9 seconds for finalization.

## 3. Single-file UI upload

### What happened

- Creating an untitled document, clicking "Import Word file", then assigning the file to
  `input[type="file"]` caused the normal `requestUpload` path to run.
- A browser-initiated HTTPS `PUT` was authorized against
  `https://beaconhs-test.xuhaoqing.top/beaconhs-phase-aj/...`.
- The network request reported `200`; CSP allowed the public origin, and there was no
  new console error during the run.

### Download / integrity

- The document attachment was fetched through the app-provided authenticated route
  `/documents/{id}/master` (same origin, authenticated browser context), returned
  `200`, `36 563` bytes.
- SHA-256 of the response was identical to the source:
  `ca7fdcd02b07b1b40fc520bbe7b626973167183347b301624f6a1ad711b847e2`.
- Therefore the whole upload → final record → protected download path is proven.

### Record

- tenant: Phase AJ Test Tenant
- temp document ID: `0bf3cb58-06bc-4eb8-9129-3d3ebaa45a26`
- uploaded filename: `n4-restore-blank.docx`

**Single-file browser upload: PASS.**

## 4. Threshold and multipart readiness

- Multipart threshold from application source:
  - `MULTIPART_THRESHOLD_BYTES = 256 MiB` (exports: `packages/storage/src/multipart.ts`)
- Candidate source file in this run is only 36 KiB, so it used the **single-file path** by
  design.
- Generating a 256 MiB+ file on the 3.4 GiB test host has not been attempted because that
  risks disk/RAM exhaustion. Thus multipart browser E2E itself is **not independently
  confirmed** in this round.
- The per-part presign routine is already exercised indirectly through unit coverage, and
  CI-like local source checks pass.

## 5. Freeze / tenant-gate check

No freeze-state transition was performed against the live tenant during this automated run.
The downstream Phase AL/AN code asserts the required fail-closed behavior and remains the
authoritative implementation; live browser proof for frozen upload was not executed because
the shared isolated test tenant should remain consistent for normal use.

## 6. Collabora full edit/save

Not run in this pass:

- the imported document surfaced "In-browser editing is not configured" and the
  in-app Collabora launcher failed with "The PowerPoint editor did not respond".
- WOPI key / Collabora service is an independent runtime dependency that would require
  changing tenant data or launching another round of browser debugging. Honest outcome is
  **NOT RUN**.

## 7. Cleanup

- opened the uploaded document;
- clicked Delete;
- confirmed the Confirm dialog; and
- page returned to `/documents`.
- no cleanup dialog remained on screen.

## 8. Status matrix

- File-input automation: PASS (Playwright `setInputFiles`)
- Public HTTPS presigned single PUT: PASS (200)
- CSP allow for public origin: PASS (no blocked error in active run)
- download SHA-256 match: PASS
- multipart (>256 MiB): NOT RUN (resource/bandwidth constraint on isolated test host)
- frozen-state UI refusal: NOT RUN
- Collabora editing/persistence: NOT RUN
- cleanup of the AR document: PASS

## 9. Remaining risks

- This environment does not allow generating large multipart test files; the 256 MiB path
  must be tested separately or with host-side transfer support.
- Collabora is not healthily serving editing sessions; its own integration needs repair
  outside the upload work.
- No commit or code change was performed in this round; only the report was appended.
