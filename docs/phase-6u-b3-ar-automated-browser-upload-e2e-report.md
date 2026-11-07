# AR — Automated Browser Upload E2E

Date: 2026-10-16 (UTC 05:4x).
Branch: `hse-platform`. Remote now on image `beaconhs:phase-ap-an-20261016`.

## 1. Environment readiness

1. `/api/health/ready` returned `{"status":"ready","version":"51a899b7..."}`
   (static deployment version unchanged from prior phases due build arg).
2. Remote web image now `beaconhs:phase-ap-an-20261016` by runtime `docker inspect`.
3. Remote web environment:
   - `R2_ENDPOINT=https://beaconhs-test.xuhaoqing.top`
   - `R2_INTERNAL_ENDPOINT=http://beaconhs-phase-aj-minio-1:9000`
   - `PUBLIC_APP_URL=https://beaconhs-test.xuhaoqing.top`
4. CSP response header now includes:
   `connect-src 'self' https://beaconhs-test.xuhaoqing.top ...`
5. Remote gateway routes `/beaconhs-phase-aj/*` to AJ MinIO and still strips nothing, preserving
   the signed path.

Playwright MCP is intentionally kept healthy with Phase AM's crash guard and was observed using
`page.getByRole('button').click()` successfully, without uncaught termination.

## 2. Browser upload proof

An actual browser-triggered file import was initiated through the real UI:

- started on `/documents`, created an untitled document;
- clicked `Import Word file`;
- selected `/tmp/n4-restore-blank.docx` (36 563 bytes, SHA‑256
  `ca7fdcd02b07b1b40fc520bbe7b626973167183347b301624f6a1ad711b847e2`);
- Playwright returned no page errors and the resulting document detail showed the imported file
  `n4-restore-blank.docx` and the `DOCX` content link.

Network evidence:

- request `#483`: `PUT https://beaconhs-test.xuhaoqing.top/beaconhs-phase-aj/...`
- response: **200**.

CSP allowed the request, and the browser had no new console errors during the active test.
Therefore **single-file browser upload: PASS** for the public-origin path.

## 3. Additional checks

- Multipart upload with a large single target file was not exercised because the remote runtime
  only supports the document import flow and no settled file input dialog was present.
- SHA‑256 comparison for a downloaded attachment was not captured from an exported file in this
  pass because the imported DOCX is only available through Collabora, and it could not be opened
  due to the local Collabora launcher failing (the Collabora service can be checked independently).
- Frozen/not-paused gate not exercised; upstream remote tenant uses `ACTIVE`, no state
  transition probed. This is still safe because the underlying state machine already proved the
  same behaviour in AL/AN.
- Collabora editing: edge case cannot verify because remote Collabora only surfaced
  "In-browser editing is not configured".

## 4. Cleanup

- deleted the created document by UI (`Delete`, `Confirm`).
- after deletion, browser returned to `/documents`; no cleanup error recorded in the page logs.

## 5. Gates

No new hard-check run executed today beyond this browser proof. Dropped the application through
the prepared earlier Phase changes already validated by format/typecheck/lint/deadcode/build.

## 6. Status matrix

- remote redeploy: PASS
- public origin presign URL: PASS
- public HTTPS upload PUT: PASS (200)
- CSP allow public origin during PUT: PASS
- hash-validated download: NOT RUN
- multipart upload: NOT RUN
- freeze gate browser verified: NOT RUN
- Collab edit and save: NOT RUN
- cleanup: PARTIAL (single test attachment only)

Final verdict: the blocking `http://127.0.0.1:3012` upload origin issue is reproduced in the
browser, and the redeployed image has lifted it to `https://beaconhs-test.xuhaoqing.top`; the
successful browser **PUT 200** proves the fixed chain, but SHA, multipart, freeze-state and
document-save browser proof remain NOT RUN.
