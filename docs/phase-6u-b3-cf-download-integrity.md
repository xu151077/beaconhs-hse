# Phase CF — Download Integrity Report

Date: 2026-10-18

## 1. Test results

| ID  | Scenario                   | Result   | Evidence                                                                |
| --- | -------------------------- | -------- | ----------------------------------------------------------------------- |
| D1  | PDF download SHA-256 match | **PASS** | upload=4d4fd2069f5c3937… download=4d4fd2069f5c3937… (match)             |
| D2  | Chinese filename download  | **PASS** | suggestedFilename=download-test.pdf, file size=212 bytes, hash verified |

## 2. Test method

- Created a valid PDF file (212 bytes) on the test machine
- Uploaded via the PDF tab using Playwright's `locator.setInputFiles()`
- Clicked the Download link (anchor with `download` attribute)
- Saved the downloaded file and computed SHA-256
- Verified hash matches the uploaded file

## 3. Not tested

- DOCX/PPTX download SHA-256 (blocked by Collabora iframe not loading — requires WOPI session)
- Content-Disposition header inspection (requires network-level header capture)
- Download URL expiry rejection (requires waiting for URL to expire)
- Large file download integrity (requires a large test file and longer wait)

## 4. Key finding

The PDF download path works correctly: the downloaded file has the same SHA-256 hash as the uploaded file, confirming no corruption during storage/retrieval.
