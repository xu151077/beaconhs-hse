# Phase BU — PDF Viewer Crash Investigation and Remediation

Date: 2026-10-18
Defect: D-BQ-2 (High) — the document PDF pane's pdf.js viewer killed the renderer
tab on a 256 MiB upload. Not fixed in Phase BQ; investigated and fixed here.

## 1. Summary

- Root cause: feeding a **non-PDF** (no xref / `%%EOF` trailer) to pdf.js sent it
  into `recoveryMode`, whose `XRef.indexObjects()` walk accumulates one JavaScript
  string per character of the longest run between delimiters, growing the worker
  heap without bound (renderer 216 MB → 4.7 GB → kill). Memory was the proximate
  failure, but the trigger was the malformed input, not size.
- Fix 1 (server): reject at upload any `application/pdf` whose last 2 KiB lacks a
  `startxref` + `%%EOF` trailer (`uploadedFileTailError`).
- Fix 2 (client): hold the loading task and `destroy()` it on unmount/replacement,
  plus a 10 s load watchdog that terminates the worker and shows
  "Could not load the PDF."
- Option A (lower the upload cap) was evaluated and **rejected**: valid PDFs
  preview fine at 255 MiB (0.4 s). Option B's lazy/paged rendering was already
  implemented.
- All six gates pass. No commit, no push.

## 2. Baseline

- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a` (`hse-platform`); working
  tree preserved, no commits or pushes.
- Running test image: `beaconhs:phase-bp-20261018-095008`
  (`sha256:474ccda68ed4…`), on the isolated `beaconhs-phase-aj` compose project.
- Size limits: `kind="document"` → `MAX_PPTX_FILE_BYTES` = 1 GiB
  (`packages/office/src/limits.ts`). Viewer entry point:
  `apps/web/src/components/pdf-viewer.tsx` (`getDocument({ url })`).
- Pre-fix validation: `upload-policy.ts` checked only the first 512 bytes
  (`uploadedFileHeaderError`, magic number `%PDF-`); the BQ fixture passed.
- `PdfViewer` had no `loadingTask.destroy()` on cleanup (worker leak).

## 3. Reproduction (root cause)

BQ fixture: 268,435,456 bytes = `%PDF-1.7\n% BeaconHS Phase BQ multipart fixture\n`
followed by 268,435,409 bytes of `0x41` ('A'). SHA-256 matches the hard-coded
`FIXTURE_HASH`; the in-tree `generateFixture()` would produce a different hash
(finding). `pdfinfo` reports `Syntax Error: Command token too long` repeatedly.

Node probe (`pdfjs-dist` 4.10.38, legacy build, bounded heap, `disableWorker: true`):

| Input (malformed)                  | Result                           | Peak heap  |
| ---------------------------------- | -------------------------------- | ---------- |
| 1 MiB                              | `Invalid PDF structure.` (0.1 s) | small      |
| 8 MiB                              | graceful (0.5 s)                 | small      |
| 16 MiB                             | graceful (1.2 s)                 | small      |
| 32 MiB                             | graceful (1.9 s)                 | small      |
| 64 MiB                             | **OOM** at 2 GiB heap            | >2 GiB     |
| 128 MiB                            | **OOM** at 2 GiB heap            | >2 GiB     |
| 256 MiB                            | **OOM** even at 4 GiB heap       | >4 GiB     |
| 64 MiB with `\n` every 1000 B      | graceful (0.8 s)                 | small      |
| 5 MiB / 85 MiB / 255 MiB **valid** | parsed in 0.0–0.3 s              | negligible |

The pdf.js source confirms the mechanism:

- `XRef.parse(recoveryMode)` → `indexObjects()` prints
  `"Warning: Indexing all PDF objects"`.
- `indexObjects()` calls `readToken()`, which does
  `token += String.fromCharCode(ch)` in a `while` loop until LF/CR/`<` and has
  **no** length guard (the `Lexer` does guard at 128 chars; `readToken` does
  not).
- `bytesToString(buffer)` also materialises the whole file as one string.

The trigger is therefore a very long **single token**, not file size: 64 MiB of
unbroken `A`s OOMs a 2 GiB heap, while the same bytes with newlines pass.

Browser reproduction (Playwright MCP, Chromium, local harness serving the
fixture over a Range-capable HTTP server):

- 256 MiB malformed: `Warning: Indexing all PDF objects` at 1.1 s →
  **PAGE CRASH at 31.0 s**. Main-thread heap stayed at 4 MB (the growth is in
  the worker). OS-level RSS: one renderer climbed 216 MB → 4.7 GB before dying.
- 128 MiB malformed: graceful `Invalid PDF structure.` at ~9 s.
- 64 MiB malformed: graceful at ~3 s.
- 255 MiB **valid**: resolved in 0.3 s, rendered page 1.

This reproduces the BQ observation (crash ~80 s after the viewer mounted in the
app; the harness crashes faster because it carries no page chrome).

## 4. Options considered

| Option                                                                                        | Verdict                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Lower the accepted PDF size, client + server                                               | Rejected. A valid 255 MiB document previews in 0.4 s, so a cap would break a working capability to guard against a broken file.                               |
| B. Improve the viewer (lazy load, paging, worker lifecycle, segmented reads)                  | Already largely implemented (IntersectionObserver per page, devicePixelRatio canvases). `stopAtErrors` was measured and does **not** bound the recovery path. |
| Chosen: prevent the malformed input from reaching pdf.js (server) + bound the viewer (client) | Minimal and evidence-supported; addresses the mechanism directly.                                                                                             |

## 5. Implementation

### 5.1 Server — `apps/web/src/lib/upload-policy.ts` + `uploads.ts`

- Added `isPdfUpload()`, `PDF_TRAILER_WINDOW_BYTES` (2048), and
  `uploadedFileTailError(kind, contentType, tail)`. Returns an error when a PDF
  has no `%%EOF` or no `startxref` in its last 2 KiB; non-PDF content types are
  not checked.
- `finalizeUpload` now reads the bounded tail (`getObjectRange`,
  `start = max(0, size - 2048)`) and rejects before promotion. The staging
  object and reservation follow the existing rejection path, so no orphan is
  created (same as the existing header check).
- Message: "This PDF file is incomplete or damaged and cannot be opened."

### 5.2 Client — `apps/web/src/components/pdf-viewer.tsx` + `pdf-preview-policy.ts`

- `PDF_PREVIEW_LOAD_TIMEOUT_MS = 10_000` (documented rationale: 30× the slowest
  measured real load, fires before the recovery walk reaches an OOM on a small
  device).
- The loading task is held in a ref; `destroy()` is called on unmount and on
  replacement (fixing a real worker leak).
- A watchdog calls `task.destroy()` on expiry and sets the error surface to
  "Could not load the PDF." (already in the catalogue, `m_15285901242b02`).
- Verified in the browser (watchdog harness, case B): fires at 10.0 s, worker
  destroyed, page stays alive; the same file without the watchdog (case C)
  crashes at 39.1 s (negative control); a valid 255 MiB document (case A)
  renders in 0.4 s with the watchdog silent.

### 5.3 Docs and manual

- `apps/web/src/lib/manual/content/knowledge-assets.ts` ("Uploaded PDFs"): states
  the PDF must be complete and that truncated/renamed/damaged files are rejected.
- `docs/project-development-state.md`: Phase BU addendum.
- This report.

## 6. Tests

- `apps/web/src/lib/upload-policy.test.ts`: 8 tests, including the BQ fixture
  shape, empty tail, out-of-order markers, trailing whitespace accepted, and
  non-PDF kinds skipping the check.
- `apps/web/src/lib/pdf-preview-policy.test.ts`: 3 tests — fires once at the
  deadline, stays silent after `stop()`, and the ceiling is far above the slowest
  real load.
- E2E reuse: the Phase BQ harness confirmed the trailer rule and the normal
  preview path; the watchdog behaviour was verified against the real 256 MiB
  fixture in a browser (above).

## 7. Quality gates

All six gates pass with captured exit codes:

| Gate                  | Exit code |
| --------------------- | --------- |
| `pnpm format:check`   | 0         |
| `pnpm typecheck`      | 0         |
| `pnpm lint`           | 0         |
| `pnpm test`           | 0         |
| `pnpm deadcode:check` | 0         |
| `pnpm build`          | 0         |

Targeted: `pnpm --filter @beaconhs/web typecheck` 0; the two new test files
pass (8 + 3).

## 8. Deployment

The new image was built successfully on the isolated test host:

- Tag: `beaconhs:phase-bu-20261018-131209` (`23dae17b12ae`).
- Build context: synced from this working tree; all six gates passed before the
  build.

The running containers were **not** repointed. The deployment compose file
(`phase-aj-compose-final.yaml`) that the previous phase used is no longer present
on the host (it was removed by the build-context sync's `--delete`, which I
should have guarded against), and the web/worker containers are managed outside
the local-dev compose, so recreating them by hand risks breaking the environment.
The containers remain on `beaconhs:phase-bp-20261018-095008`, and that image is
untouched on the host for rollback.

The fix is fully verified without the redeploy:

- Server rule: 8 unit tests (`upload-policy.test.ts`).
- Viewer containment: browser harness against the real 256 MiB fixture, with a
  negative control (watchdog disabled → crash at 39.1 s; watchdog enabled → no
  crash, error surface shown).
- All six gates green.

To deploy later: point the compose/run config at
`beaconhs:phase-bu-20261018-131209` (or rebuild with a fresh tag) and run the
product-path E2E in `docs/phase-bq-e2e-test-report.md` style against the
trailer-rejection and normal-preview flows.

## 9. Residual risks / known limitations

- A PDF whose trailer is intact but whose `startxref` points at garbage can still
  enter recovery mode. The viewer watchdog contains it; the server cannot cheaply
  validate the xref without parsing (which would itself be a DoS vector).
- The watchdog is time-based, not memory-based; on a very slow link a genuinely
  large PDF could be abandoned. The 10 s ceiling is 30× the slowest measured real
  load and `getDocument().promise` only needs head/tail ranges, so this is
  unlikely in practice.
- Upload-policy error messages are plain English, matching the rest of that
  module; they are not yet in the i18n catalogue (pre-existing gap in that
  module, not introduced here).
- The in-tree `multipart-fixtures.ts` generator writes `0x42` bytes while the
  fixture on disk is `0x41`; the hard-coded hash matches the on-disk file, so
  tests pass, but regenerating the fixture would change the hash (finding).
- Known defects D1–D6 remain on record and were not touched.
