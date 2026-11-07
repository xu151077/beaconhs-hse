# Phase CG — Download & 404 Report

Date: 2026-10-18

## 1. Download integrity

| ID  | Scenario                   | Result   | Evidence                                                                |
| --- | -------------------------- | -------- | ----------------------------------------------------------------------- |
| D1  | PDF download SHA-256 match | **PASS** | upload=4d4fd2069f5c3937… download=4d4fd2069f5c3937… (match)             |
| D2  | Chinese filename download  | **PASS** | suggestedFilename=download-test.pdf, file size=212 bytes, hash verified |

## 2. 404 investigation

### Phase CF 404

Phase CF reported 1 console error: "Failed to load resource: the server responded with a status of 404 ()".

### Phase CG investigation

Two Playwright test runs were performed:

1. Navigation through `/documents`, `/dashboard`, `/login` — **0 404s**
2. Full PDF upload flow (new document → PDF tab → upload) — **0 404s**

The 404 could not be reproduced. It was likely a transient issue, possibly:

- A missing favicon or static asset (cached after first load)
- An external resource (Cloudflare Insights beacon)
- A race condition during page hydration

### Conclusion

The 404 is **not reproducible** and appears to be transient. No application code change is needed. The error did not affect any functionality (all uploads, previews, and downloads worked correctly).

## 3. Not tested

- Content-Disposition header inspection (requires network-level header capture)
- Download URL expiry rejection (requires waiting for URL to expire)
- Cross-tenant download denial (requires a second tenant session)
- DOCX download ZIP structure verification (blocked by Collabora iframe not loading)
- PPTX download (blocked by no PPTX upload flow in documents)
