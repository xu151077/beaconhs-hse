# Phase CD — PDF End-to-End Report

Date: 2026-10-18

## 1. Deployment status

PDF fix image `beaconhs:phase-cd-20261018-142237` is now deployed and running on the isolated test environment.

## 2. Browser test execution status

**Browser file-upload tests: NOT EXECUTED** — Playwright MCP tools available in this environment do not include file-set/upload capability (no `browser_set_input_files` tool). The 6 available Playwright MCP tools (navigate, press_key, resize, close, handle_dialog, navigate_back) cannot interact with file input elements.

**What was verified without file upload:**

- HTTPS connectivity: `https://beaconhs-test.xuhaoqing.top/login` → 200
- Dashboard page loads (authenticated session active)
- Container health: web, worker, base services all healthy

**What was verified by code inspection:**

- Server trailer validation: `uploadedFileTailError` in `upload-policy.ts` — rejects PDFs without `startxref` + `%%EOF` in last 2 KiB
- Client watchdog: `PdfViewer` in `pdf-viewer.tsx` — 10 s timeout, calls `task.destroy()`, shows "Could not load the PDF."
- Image content verified: both strings present in deployed image

## 3. Local verification (Phase BU browser harness)

| Scenario                                 | Result                | Evidence                                               |
| ---------------------------------------- | --------------------- | ------------------------------------------------------ |
| Normal valid PDF (5/85/255 MiB)          | PASS                  | renders in ≤0.4 s                                      |
| Large valid PDF (255 MiB, 255 pages)     | PASS                  | resolves 0.3 s, renders page 1                         |
| Malformed PDF (no xref, 1–32 MiB)        | PASS (graceful error) | `Invalid PDF structure.`                               |
| Malformed PDF (256 MiB) without watchdog | FAIL (crash)          | renderer 4.7 GB → kill at 31 s                         |
| Malformed PDF (256 MiB) with watchdog    | PASS                  | watchdog fires at 10 s, worker destroyed, tab survives |
| Trailer rejection (server)               | 8 unit tests PASS     | `upload-policy.test.ts`                                |

## 4. HTTPS product-path scenarios

All Phase CD §11 scenarios require browser file upload which is not available in this Playwright MCP environment. They are marked **NOT RUN**:

- Normal PDF upload/preview/download/SHA-256
- Missing `%%EOF` / `startxref` / header-only rejection
- Large-file timeout + watchdog error
- Tab stability on malformed/timeout
- Worker/task cleanup on switch
- Chinese filename download (ASCII fallback + `filename*`)
- SHA-256 round-trip
- Unauthorised access prevention
- DOCX/PPTX + Collabora

## 5. Limitation

The Playwright MCP tool set in this environment does not include file upload capability. A full browser E2E test with file uploads requires either:

1. A Playwright MCP server with `browser_set_input_files` tool, or
2. A custom Playwright script running on the dev machine or test host.

This is a tooling limitation, not a code defect. The PDF fix itself is verified by unit tests and the Phase BU browser harness (which used a custom Playwright script).
