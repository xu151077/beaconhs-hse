# Phase CL — Deployment & Regression Report

Date: 2026-10-18

## 1. No code changes

Phase CL did not modify any business code. No new image was built or deployed.

## 2. Test execution

| Package         | Test files                  | Tests                         | Status |
| --------------- | --------------------------- | ----------------------------- | ------ |
| `@beaconhs/web` | 239 (237 passed, 2 skipped) | 2041 (2033 passed, 8 skipped) | PASS   |
| `@beaconhs/db`  | 62 (61 passed, 1 skipped)   | 542 (501 passed, 41 skipped)  | PASS   |

## 3. Environment status

| Item          | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| Image         | `beaconhs:phase-cd-20261018-142237` (`sha256:8feaa82d4aa1…`) |
| HTTPS         | `https://beaconhs-test.xuhaoqing.top` → 200                  |
| Containers    | All healthy                                                  |
| Volumes       | Original external volumes preserved                          |
| Tenant status | ACTIVE (both tenants)                                        |

## 4. No deployment performed

No code changes were made, so no new image was built or deployed. The existing healthy deployment remains in place.

## 5. Collabora E2E results (Phase CL)

| Step                   | Result       | Evidence                                                                        |
| ---------------------- | ------------ | ------------------------------------------------------------------------------- |
| DOCX upload            | PASS         | File accepted, document created, master set in DB                               |
| Collabora iframe loads | PASS         | Host_PostmessageReady received, 11 toolbar elements                             |
| Edit (type text)       | PASS         | Typed "PhaseCJEdit-1792310682774", text found in frame                          |
| Save (Ctrl+S)          | PASS         | "上次保存：6秒前" (Last saved: 6 seconds ago)                                   |
| Download & verify      | PASS         | Downloaded DOCX contains "PhaseCJEdit-" in document.xml                         |
| Reopen verification    | INCONCLUSIVE | Text not found via textContent (canvas-rendered), download confirms persistence |
| Freeze write blocking  | NOT RUN      | Requires freeze state machine driver                                            |

## 6. Freeze/Multipart

**NOT RUN** — technical blocker (no freeze driver in container). Phase BQ 11/11 results carry forward.
