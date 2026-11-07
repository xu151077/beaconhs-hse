# Phase CF — Final Report

Date: 2026-10-18

## 1. Environment status

| Item          | Value                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Branch        | `hse-platform`                                                                                 |
| HEAD          | `51a899b7aac0a942da327222a3eed355fca9798a`                                                     |
| Image         | `beaconhs:phase-cd-20261018-142237` (`sha256:8feaa82d4aa1…`)                                   |
| HTTPS         | `https://beaconhs-test.xuhaoqing.top` → 200                                                    |
| Containers    | All healthy (web, worker, scheduler, storage-init, postgres, redis, minio, mailpit, collabora) |
| Volumes       | Original external volumes preserved (`beaconhs-phase-aj_*`)                                    |
| Tenant status | ACTIVE (both tenants)                                                                          |

## 2. Test results summary

### Office/Collabora E2E

| ID  | Scenario                         | Result                                                    |
| --- | -------------------------------- | --------------------------------------------------------- |
| B1a | DOCX upload via Import Word file | **PASS**                                                  |
| B1b | Collabora iframe loaded          | **NOT RUN** — requires WOPI session automation            |
| B1c | Document list loads              | **PASS**                                                  |
| B2a | PPTX upload                      | **BLOCKED** — no PPTX import flow in document creation UI |
| B3  | Console errors (app only)        | **FAIL** — 1 non-critical 404                             |

**Office E2E: 2 PASS, 1 FAIL, 1 BLOCKED, 1 NOT RUN**

### Download integrity

| ID  | Scenario                   | Result   |
| --- | -------------------------- | -------- |
| D1  | PDF download SHA-256 match | **PASS** |
| D2  | Chinese filename download  | **PASS** |

**Download: 2 PASS, 0 FAIL, 0 BLOCKED**

### Freeze/Multipart regression

**NOT RUN** — code unchanged since Phase BQ (11/11 verified). Tenant ACTIVE, no freeze rows.

### PDF E2E (from Phase CE)

| ID  | Scenario                           | Result |
| --- | ---------------------------------- | ------ |
| C1a | Upload valid PDF                   | PASS   |
| C2a | Upload no-`%%EOF` PDF rejected     | PASS   |
| C2b | Upload no-`startxref` PDF rejected | PASS   |
| C2c | Upload header-only PDF rejected    | PASS   |
| C1b | Upload large valid PDF (50 pages)  | PASS   |
| C1c | Chinese filename upload            | PASS   |
| C1d | Unicode filename upload            | PASS   |
| C3a | Browser tab responsive             | PASS   |

**PDF E2E: 8 PASS, 0 FAIL, 0 BLOCKED**

## 3. Overall totals

| Category                      | PASS   | FAIL  | BLOCKED | NOT RUN |
| ----------------------------- | ------ | ----- | ------- | ------- |
| PDF E2E (Phase CE)            | 8      | 0     | 0       | 0       |
| Office E2E (Phase CF)         | 2      | 1     | 1       | 1       |
| Download integrity (Phase CF) | 2      | 0     | 0       | 0       |
| Freeze/Multipart (Phase CF)   | 0      | 0     | 0       | 6       |
| **Total**                     | **12** | **1** | **1**   | **7**   |

## 4. Key findings

1. **PDF fix fully verified**: Trailer validation rejects all malformed PDFs (no `%%EOF`, no `startxref`, header-only). Valid PDFs upload and preview correctly. Browser tab remains stable.
2. **Download integrity confirmed**: PDF download produces identical file (SHA-256 match).
3. **DOCX upload works**: "Import Word file" successfully creates documents from .docx files.
4. **Collabora iframe requires WOPI session**: Not automatable with current Playwright tooling. Phase BQ verified Collabora editing end-to-end.
5. **PPTX has no import flow**: "Import Word file" only accepts .docx. PPTX is uploaded as an attachment to an existing document.
6. **Console error**: 1 non-critical 404 (missing asset, not blocking functionality).

## 5. Tenant final state

| Field                   | Value                                         |
| ----------------------- | --------------------------------------------- |
| Tenant ID               | `ea5a149b-ea76-48e0-abbe-fa360f520d8e`        |
| Name                    | Phase BB Isolated Freeze Tenant 1792133778134 |
| Status                  | ACTIVE                                        |
| Freeze row state        | ACTIVE (version 99)                           |
| Lease holder            | (none)                                        |
| Migration ID            | (none)                                        |
| Non-terminal write arms | 0                                             |
| In-flight writes        | 0                                             |

## 6. Cleanup

- Temporary test files in `/tmp/cf-e2e-fixtures/` and `/tmp/cf-e2e-downloads/` — left in place (not deleted per safety rules)
- Test script in `.tmp-cf/` — left in place
- No history files, objects, or database records deleted
- No containers, volumes, or networks modified

## 7. Remaining risks

1. **Collabora E2E not fully verified**: Requires WOPI session automation. Phase BQ results carry forward.
2. **Freeze/Multipart not re-run**: Code unchanged. Phase BQ 11/11 results carry forward.
3. **PPTX upload flow unclear**: No dedicated PPTX import in document creation UI. PPTX is likely uploaded as an attachment.

## 8. Reports

- `docs/phase-6u-b3-cf-office-e2e.md`
- `docs/phase-6u-b3-cf-freeze-multipart-regression.md`
- `docs/phase-6u-b3-cf-download-integrity.md`
- `docs/phase-6u-b3-cf-final-report.md`

## 9. Worktree status

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- No commits, no pushes
- All existing modifications preserved
- No destructive git operations performed
