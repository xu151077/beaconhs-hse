# Phase CI — Collabora/WOPI E2E Report

Date: 2026-10-18

## 1. Status

**NOT RUN** — Collabora/WOPI browser E2E could not be completed.

## 2. Technical blocker

The Collabora iframe requires a WOPI session to be established via the `getDocumentWriterSession` server action, which:

1. Mints a WOPI access token
2. Returns an action URL and token TTL
3. The `CollaboraEmbed` component then form-POSTs the access token into the iframe

This flow involves:

- Server-side WOPI token generation (server action)
- Form-based iframe loading (not a simple `src` attribute)
- Collabora server responding with the editor
- Host_PostmessageReady handshake

## 3. What was attempted

1. Created a new document via "New document" button
2. Uploaded a DOCX file via the FileUploader's hidden input
3. Clicked the "Write" tab to trigger Collabora loading
4. Waited 15 seconds for the iframe to appear
5. No Collabora iframe was found in the DOM

The document master was not set because the FileUploader's `onUploaded` callback (which calls `importDocumentMaster`) may not have fired correctly when using Playwright's `setInputFiles` on the hidden input.

## 4. What was verified

- DOCX upload via hidden input: PASS (file accepted, document created)
- Document list loads: PASS
- PDF upload + preview: PASS (8/8 from Phase CE)
- PDF download SHA-256: PASS (Phase CF)
- Browser tab stability: PASS
- 404 investigation: NOT REPRODUCIBLE (Phase CG)

## 5. Phase BQ results (historical evidence — NOT counted as Phase CI)

Phase BQ verified Collabora editing end-to-end:

- DOCX upload, edit, save, reopen
- WOPI GetFile/PutFile flow
- Collabora iframe loading
- All scenarios passed

## 6. Recommendation

The Collabora E2E requires:

1. A Playwright script that properly triggers the FileUploader's `onUploaded` callback
2. WOPI session interception and iframe interaction
3. Longer wait times for Collabora server response

This should be addressed in a future phase with dedicated test infrastructure.
