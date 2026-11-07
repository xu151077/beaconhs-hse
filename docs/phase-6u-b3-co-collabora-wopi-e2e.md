# Phase CO — Collabora/WOPI E2E Report

Date: 2026-10-18

## 1. Status

**NOT RUN** — Collabora/WOPI freeze write blocking tests were not executed due to driver deployment failure.

## 2. Test approach

**File**: `apps/web/e2e/phase-bq-multipart-freeze.spec.ts` (Scenarios 6-7)

**Test steps**:

1. Open DOCX in ACTIVE state
2. Edit and save unique test marker
3. Freeze via driver
4. Try to save via WOPI
5. Verify write is blocked
6. Release and verify resume

## 3. Execution status

**Status**: NOT RUN

**Reason**: `bt-freeze-driver.ts` not deployed to test server

## 4. Historical evidence (Phase BQ)

Phase BQ verified Collabora/WOPI freeze write blocking:

| Step | Description                         | Status         |
| ---- | ----------------------------------- | -------------- |
| 1    | Open DOCX in ACTIVE state           | PASS           |
| 2    | Edit and save unique test marker    | PASS           |
| 3    | Freeze via driver                   | PASS           |
| 4    | Try to save via WOPI                | PASS (blocked) |
| 5    | Verify write is blocked             | PASS           |
| 6    | Release and verify resume           | PASS           |
| 7    | Reopen and verify content persisted | PASS           |

**Evidence**:

- Service-side write blocking verified
- Object storage content unchanged during freeze
- UI correctly shows save failure
- Release allows normal save

## 5. Test document details

**Test document ID**: `8ae24ed0-bf03-41d3-ad6c-c530d056c057` (verified editable/saved/persisted)

**Collabora configuration**:

- Discovery XML: https://beaconhs-test.xuhaoqing.top/hosting/discovery (200)
- Edit URL: https://beaconhs-test.xuhaoqing.top/browser/201368fc8d/cool.html
- WOPI session: minted by `getDocumentWriterSession` server action
- iframe: loaded via form-POST (not `src` attribute)
- Cross-origin: same-origin (routed through reverse proxy)

## 6. What was NOT verified

- ❌ Freeze write blocking via WOPI
- ❌ Service-side rejection verification
- ❌ Object storage unchanged verification
- ❌ UI save failure confirmation
- ❌ Release and resume verification
- ❌ DOCX content persistence after release
- ❌ Real browser Collabora editing
- ❌ Download and verify `word/document.xml`

## 7. Collabora E2E baseline (Phase CL/CM)

Previous phases verified the following Collabora/WOPI functionality:

| Step                   | Result           | Evidence                                                                        |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------- |
| DOCX upload            | **PASS**         | File accepted, document created, master set in DB                               |
| Collabora iframe loads | **PASS**         | Host_PostmessageReady received, 11 toolbar elements                             |
| Edit (type text)       | **PASS**         | Typed "PhaseCNEdit-1792310682774", text found in frame textContent              |
| Save (Ctrl+S)          | **PASS**         | "上次保存：6秒前" (Last saved: 6 seconds ago)                                   |
| Download & verify      | **PASS**         | Downloaded DOCX contains "PhaseCNEdit-" in document.xml                         |
| Reopen verification    | **INCONCLUSIVE** | Text not found via textContent (canvas-rendered), download confirms persistence |

**Status**: Collabora editing baseline is verified, but freeze blocking is NOT RUN.
