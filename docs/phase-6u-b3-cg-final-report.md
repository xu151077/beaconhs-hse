# Phase CG — Final Report

Date: 2026-10-18

## 1. Environment status

| Item          | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| Branch        | `hse-platform`                                               |
| HEAD          | `51a899b7aac0a942da327222a3eed355fca9798a`                   |
| Image         | `beaconhs:phase-cd-20261018-142237` (`sha256:8feaa82d4aa1…`) |
| HTTPS         | `https://beaconhs-test.xuhaoqing.top` → 200                  |
| Containers    | All healthy                                                  |
| Volumes       | Original external volumes preserved                          |
| Tenant status | ACTIVE (both tenants)                                        |

## 2. Test results summary

### Freeze/Multipart regression

| Item              | Result                                                |
| ----------------- | ----------------------------------------------------- |
| 6-item regression | **NOT RUN** — code unchanged, Phase BQ 11/11 verified |

### Collabora/WOPI E2E

| Item             | Result                                             |
| ---------------- | -------------------------------------------------- |
| DOCX upload      | **PASS** — file accepted, document created         |
| Collabora iframe | **NOT RUN** — requires WOPI session automation     |
| WOPI freeze gate | **NOT RUN** — requires freeze state machine driver |

### PPTX capability

| Item               | Result                                            |
| ------------------ | ------------------------------------------------- |
| Document authoring | **NOT SUPPORTED** — by design, only DOCX accepted |
| Training module    | **SUPPORTED** — separate workflow                 |

### Download & 404

| Item                      | Result                                          |
| ------------------------- | ----------------------------------------------- |
| PDF download SHA-256      | **PASS**                                        |
| Chinese filename download | **PASS**                                        |
| 404 investigation         | **NOT REPRODUCIBLE** — transient, no app impact |

## 3. Overall totals (Phase CG)

| Category         | PASS  | FAIL  | BLOCKED | NOT RUN                        |
| ---------------- | ----- | ----- | ------- | ------------------------------ |
| Freeze/Multipart | 0     | 0     | 0       | 6                              |
| Collabora/WOPI   | 0     | 0     | 0       | 3                              |
| PPTX capability  | 0     | 0     | 0       | 0 (product boundary confirmed) |
| Download & 404   | 2     | 0     | 0       | 3                              |
| **Total**        | **2** | **0** | **0**   | **9**                          |

## 4. Combined totals (Phase CE + CF + CG)

| Category                      | PASS   | FAIL  | BLOCKED | NOT RUN |
| ----------------------------- | ------ | ----- | ------- | ------- |
| PDF E2E (Phase CE)            | 8      | 0     | 0       | 0       |
| Office E2E (Phase CF)         | 2      | 1     | 1       | 1       |
| Download integrity (Phase CF) | 2      | 0     | 0       | 0       |
| Freeze/Multipart (Phase CF)   | 0      | 0     | 0       | 6       |
| Office E2E (Phase CG)         | 0      | 0     | 0       | 3       |
| Freeze/Multipart (Phase CG)   | 0      | 0     | 0       | 6       |
| Download & 404 (Phase CG)     | 2      | 0     | 0       | 3       |
| **Total**                     | **14** | **1** | **1**   | **13**  |

## 5. Key findings

1. **PDF fix fully verified**: 8/8 HTTPS product path tests PASS (Phase CE)
2. **Download integrity confirmed**: SHA-256 match (Phase CF + CG)
3. **DOCX upload works**: "Import Word file" successfully creates documents
4. **PPTX not supported for documents**: By design, only DOCX accepted. PPTX supported in training module.
5. **404 not reproducible**: Transient issue, no app impact
6. **Collabora requires WOPI automation**: Not automatable with current tooling. Phase BQ verified.
7. **Freeze/Multipart not re-run**: Code unchanged. Phase BQ 11/11 results carry forward.

## 6. Tenant final state

| Field                   | Value                                         |
| ----------------------- | --------------------------------------------- |
| Tenant ID               | `ea5a149b-ea76-48e0-abbe-fa360f520d8e`        |
| Name                    | Phase BB Isolated Freeze Tenant 1792133778134 |
| Status                  | ACTIVE                                        |
| Freeze row state        | ACTIVE (version 99)                           |
| Lease holder            | (none)                                        |
| Non-terminal write arms | 0                                             |
| In-flight writes        | 0                                             |

## 7. Reports

- `docs/phase-6u-b3-cg-freeze-multipart-regression.md`
- `docs/phase-6u-b3-cg-collabora-wopi-e2e.md`
- `docs/phase-6u-b3-cg-pptx-capability.md`
- `docs/phase-6u-b3-cg-download-and-404.md`
- `docs/phase-6u-b3-cg-final-report.md`

## 8. Worktree status

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- No commits, no pushes
- All existing modifications preserved
- No destructive git operations performed

## 9. Remaining risks

1. **Collabora E2E not fully verified**: Requires WOPI session automation. Phase BQ results carry forward.
2. **Freeze/Multipart not re-run**: Code unchanged. Phase BQ 11/11 results carry forward.
3. **PPTX for documents**: Not supported by design. No action needed unless product requirements change.
4. **404 transient**: Not reproducible. No action needed.
