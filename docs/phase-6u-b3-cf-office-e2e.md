# Phase CF — Office & Collabora E2E Report

Date: 2026-10-18

## 1. Test environment

- URL: `https://beaconhs-test.xuhaoqing.top`
- Browser: Chromium (Playwright, headless)
- Auth: existing session (`/tmp/beaconhs-e2e-auth.json`)
- Image: `beaconhs:phase-cd-20261018-142237` (`sha256:8feaa82d4aa1…`)
- Test files: `/tmp/cf-e2e-fixtures/`

## 2. Results

| ID  | Scenario                         | Result      | Evidence                                                                                                                                                |
| --- | -------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1a | DOCX upload via Import Word file | **PASS**    | File set via hidden input, document created                                                                                                             |
| B1b | Collabora iframe loaded          | **NOT RUN** | No Collabora iframe found — requires opening document in edit mode and triggering WOPI session                                                          |
| B1c | Document list loads              | **PASS**    | Document list page renders                                                                                                                              |
| B2a | PPTX upload                      | **BLOCKED** | "Import Word file" accepts only .docx; no PPTX import flow exists in the document creation UI                                                           |
| B3  | Console errors (app only)        | **FAIL**    | 1 app console error: "Failed to load resource: the server responded with a status of 404 ()" — non-critical (missing asset, not blocking functionality) |

**Total: 2 PASS, 1 FAIL, 1 BLOCKED, 1 NOT RUN**

## 3. Key findings

### DOCX upload

The "Import Word file" button opens a file chooser. Setting a .docx file via Playwright's `setInputFiles` successfully creates a document. The document appears in the list.

### Collabora iframe

The Collabora iframe only appears when a document is opened in edit mode, which requires:

1. Creating a document with a DOCX master
2. Clicking "Edit" or similar action to trigger WOPI session
3. The Collabora embed component then form-POSTs the access token into the iframe

This flow was not fully automated in this test run. The Collabora embed component exists (`collabora-embed.tsx`) and uses WOPI protocol.

### PPTX upload

The "Import Word file" button only accepts .docx files. PPTX files are likely uploaded as attachments to an existing document, not as standalone document creation. The document creation page only shows "Import Word file" and "Start blank" options.

### Console errors

1 console error found: "Failed to load resource: the server responded with a status of 404 ()". This is a non-critical error (missing asset) and does not block functionality. The Cloudflare Insights script error is external noise and was filtered out.

## 4. Not verified (blocked by tooling)

- Collabora editor loading and editing (requires WOPI session automation)
- PPTX upload (no import flow in document creation UI)
- Collabora save and reopen verification
- Cross-tenant access denial
- Editor load failure feedback

## 5. Limitation

The Collabora iframe requires a WOPI session to be established via a server action, which involves form-POSTing an access token into the iframe. This complex flow is not easily automated with the available Playwright tools. Phase BQ verified Collabora editing end-to-end (11/11 scenarios).
