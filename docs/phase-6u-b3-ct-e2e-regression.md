# Phase 6U-B3-CT — E2E regression

Date: 2026-10-19
Repository: `/home/test/projects/beaconhs-hse`
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Target: `https://beaconhs-test.xuhaoqing.top` (phase-aj test stack)
Worker: Chromium, one worker, `--reporter=list`

Status: **E2E was actually run against the live test environment.** Three suites
and one targeted PDF check ran. Authentication, upload/download, Collabora
edit/save, freeze refusal for create/import, and 256 MiB multipart upload and
resume passed. The frozen WOPI-session scenario failed by timeout and a
`domcontentloaded` diagnostic also timed out, so it is reported as a **FAIL**,
not as a pass. Role Scope has no existing E2E coverage and is **NOT RUN**.

## 1. Environment and credentials

- Public target: `https://beaconhs-test.xuhaoqing.top`.
- Authenticated suites used a pre-existing Playwright storage state issued for
  the phase-aj test tenant. The token values are not reproduced here.
- Freeze suites used the isolated tenant
  `ea5a149b-ea76-48e0-abbe-fa360f520d8e` and the production freeze state machine
  through `bt-freeze-driver.ts` in the phase-aj worker.
- No business code, test assertion, helper, or permission check was modified.
- Two temporary diagnostic specs were created under `apps/web/e2e` and removed
  after use.

## 2. Results

| Suite / check                               | Result   | Evidence                                                                     |
| ------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `simple-test.spec.ts` navigation smoke      | PASS     | Authenticated `/documents` loaded; `New document` control found.             |
| `phase-bo-e2e.spec.ts` Scenario A           | PASS     | Collabora edit, save, and persistence into master DOCX.                      |
| `phase-bo-e2e.spec.ts` Scenario B           | PASS     | Upload → download byte-identical; Unicode filename preserved.                |
| `phase-bo-e2e.spec.ts` Coverage             | PASS     | Every authenticated navigation module rendered.                              |
| `phase-bo-e2e.spec.ts` anonymous refusal    | PASS     | Protected modules redirected an anonymous caller to `/login`.                |
| `phase-bq-frozen-ux.spec.ts` Scenario 1     | PASS     | Frozen `Start blank` refused with determinate frozen copy.                   |
| `phase-bq-frozen-ux.spec.ts` Scenario 2     | PASS     | Frozen `Import Word` refused; no upload started.                             |
| `phase-bq-frozen-ux.spec.ts` Scenario 3     | PASS     | ACTIVE workspace opened the Collabora editor.                                |
| `phase-bq-frozen-ux.spec.ts` Scenario 4     | **FAIL** | Timeout navigating to a document after freezing; WOPI refusal not verified.  |
| `phase-bq-multipart-freeze.spec.ts` Scen. 2 | PASS     | Frozen multipart create refused with the frozen copy.                        |
| `phase-bq-multipart-freeze.spec.ts` Scen. 6 | PASS     | Freeze released; 256 MiB multipart upload resumed and completed (10.8 min).  |
| Targeted PDF preview                        | PASS     | Valid 510-byte PDF rendered a 635×822 pdf.js canvas.                         |
| Role Scope / cross-role authorization       | NOT RUN  | No existing Playwright spec covers roles, scopes, or cross-tenant IDOR.      |
| `phase-bn-full-system`, `diagnose-*` suites | NOT RUN  | Broad smoke/diagnostic scripts; not required for the selected risk surfaces. |

### 2.1 Phase BO

```text
4 passed (1.5m)
```

Log: `/tmp/opencode/phase-ct/e2e-bo.log`.

This suite proved authenticated access, a real Collabora edit/save round trip,
byte-identical upload/download with a Unicode filename, all navigation modules
rendering, and anonymous refusal. It does not prove role-scope authorization.

### 2.2 Frozen UX — one failure

```text
3 passed, 1 failed (14.7m)
Scenario 4: server-side freeze gate refuses a WOPI session
Test timeout of 300000ms exceeded
page.goto(".../documents/0b471c1d-...", { waitUntil: "load" })
```

The failure is in `openDocument()` at `waitUntil: 'load'` after the workspace was
frozen. The test did not reach its frozen-panel assertions. Freeze state was
restored to `ACTIVE` by `afterAll` (driver version 201).

A targeted diagnostic repeated the same product step with
`waitUntil: 'domcontentloaded'` and a 120 s navigation timeout. It also timed out;
the page snapshot showed only the BeaconHS logo. This rules out only the
`waitUntil: 'load'` choice as the cause. The exact cause (server response,
streaming, Collabora iframe teardown, or browser navigation) was not proven, and
no product code was changed to make the test pass. The scenario remains a
**FAIL** and a release risk.

### 2.3 Multipart freeze and resume

```text
2 passed (14.2m)
Scenario 2: freeze before multipart create
Scenario 6: release and resume multipart upload
```

Scenario 6 exercised the 256 MiB multipart path and recovery after release. The
fixture is generated by `helpers/multipart-fixtures.ts`; the test verified the
final stored object. Freeze state was `ACTIVE` version 206 afterwards.

### 2.4 PDF preview

A temporary targeted spec uploaded the valid 510-byte fixture
`/tmp/beaconhs-test-fixtures/测试文档.pdf`, opened the PDF pane, and asserted a
visible pdf.js canvas. Result:

```text
[PDF] canvas=635x822
1 passed (17.8s)
```

The first run of this temporary check used `/tmp/opencode/bq-small.pdf`, which
`pdfinfo` proved was structurally invalid (missing trailer/xref). That first
failure was a fixture error, not a product result. The valid-fixture rerun is the
reported PDF result. The temporary spec was removed.

## 3. Freeze-state cleanup

| Checkpoint                        | State                 |
| --------------------------------- | --------------------- |
| Before freeze suites              | `ACTIVE`              |
| After `phase-bq-frozen-ux`        | `ACTIVE`, version 201 |
| After `phase-bq-multipart-freeze` | `ACTIVE`, version 206 |
| After WOPI diagnostic cleanup     | `ACTIVE`, version 211 |

No tenant was left frozen. The tests created documents/uploads in the isolated
test tenant; no production tenant was used.

## 4. What is not verified

- Role / permission / project-scope authorization has no existing Playwright
  coverage. It is **NOT RUN**, not a pass.
- The frozen WOPI refusal path is **FAIL**; the expected frozen panel was not
  observed because navigation hung.
- The broad `phase-bn-full-system` and `diagnose-*` suites were not run.
- No test was changed to hide the WOPI failure.
- The drill stack was not used for E2E and was not modified.

## 5. Artifacts

- `/tmp/opencode/phase-ct/e2e-simple.log`
- `/tmp/opencode/phase-ct/e2e-bo.log`
- `/tmp/opencode/phase-ct/e2e-bq-frozen.log`
- `/tmp/opencode/phase-ct/e2e-bq-multipart.log`
- `/tmp/opencode/phase-ct/e2e-pdf-preview.log`
- `/tmp/opencode/phase-ct/e2e-wopi-freeze-diagnostic.log`
