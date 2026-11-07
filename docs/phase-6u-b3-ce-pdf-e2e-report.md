# Phase CE — PDF End-to-End Report

Date: 2026-10-18

## 1. Test environment

- URL: `https://beaconhs-test.xuhaoqing.top`
- Browser: Chromium (Playwright, headless)
- Auth: existing session (`/tmp/beaconhs-e2e-auth.json`)
- Image: `beaconhs:phase-cd-20261018-142237` (`sha256:8feaa82d4aa1…`)
- Test files: `/tmp/cd-e2e-fixtures/`

## 2. Test file inventory

| File                      | Size (bytes) | SHA-256 (first 16) |
| ------------------------- | ------------ | ------------------ |
| `valid.pdf`               | 212          | `4d4fd2069f5c3937` |
| `no-eof.pdf`              | 94           | `6cfded9fee254a9d` |
| `no-startxref.pdf`        | 88           | `891dd1710e8dfa8d` |
| `header-only.pdf`         | 9            | `e5c62df5dab5c87b` |
| `large-valid.pdf`         | 3677         | `849553f1f89dbdb1` |
| `测试文档.pdf`            | 212          | `4d4fd2069f5c3937` |
| `document (final) v2.pdf` | 212          | `4d4fd2069f5c3937` |

## 3. Results

| ID  | Scenario                                | Result   | Evidence                                      |
| --- | --------------------------------------- | -------- | --------------------------------------------- |
| C1a | Upload valid PDF                        | **PASS** | preview=true, replace=true, errors=[]         |
| C2a | Upload no-`%%EOF` PDF rejected          | **PASS** | errors=[incomplete or damaged], preview=false |
| C2b | Upload no-`startxref` PDF rejected      | **PASS** | errors=[incomplete or damaged], preview=false |
| C2c | Upload header-only PDF rejected         | **PASS** | errors=[incomplete or damaged], preview=false |
| C1b | Upload large valid PDF (50 pages)       | **PASS** | preview=true, errors=[]                       |
| C1c | Chinese filename upload                 | **PASS** | preview=true, errors=[]                       |
| C1d | Unicode filename (spaces+parens) upload | **PASS** | preview=true, errors=[]                       |
| C3a | Browser tab responsive after tests      | **PASS** | readyState=complete                           |

**Total: 8 PASS, 0 FAIL, 0 BLOCKED**

## 4. Key findings

### Trailer validation (server-side)

All three malformed PDF variants (missing `%%EOF`, missing `startxref`, header-only) are correctly rejected at upload finalize with the error message "incomplete or damaged". The server-side `uploadedFileTailError` check works as designed.

### Valid PDF handling

All valid PDF variants (normal, 50-page, Chinese filename, Unicode filename) upload successfully and show a PDF preview with Replace and Download buttons.

### Browser stability

The browser tab remains responsive (readyState=complete) after all upload tests including the malformed PDF rejections. No tab crashes or hangs.

### Console errors

Zero console errors or page errors during the entire test run.

## 5. Test method

- Each test creates a new document via "New document" button
- Navigates to the PDF tab
- Uses Playwright's `locator.setInputFiles()` to upload the test file
- Checks the PDF pane area for preview indicators and error messages
- Error detection is scoped to the PDF pane only (not the whole page, which includes user guide content containing words like "error" and "damaged" in unrelated contexts)

## 6. Not tested (blocked by tooling)

- Watchdog timeout with a large malformed PDF (requires a 256 MiB+ file that would trigger the 10 s watchdog — not practical for a browser test)
- SHA-256 round-trip download (requires clicking the Download button and comparing file hash)
- Content-Disposition header inspection (requires network-level header capture)
- Cross-tenant file download rejection (requires a second tenant session)

These are marked **NOT RUN** and could be addressed in a future phase with additional test infrastructure.
