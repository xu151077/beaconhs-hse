# Phase 6U-B3-CQ — Freeze / multipart E2E

Date: 2026-10-19
Spec: `apps/web/e2e/phase-bq-multipart-freeze.spec.ts`
Helpers: `apps/web/e2e/helpers/freeze-control.ts`,
`apps/web/e2e/helpers/multipart-fixtures.ts`
Command:

```
cd apps/web && pnpm exec playwright test e2e/phase-bq-multipart-freeze.spec.ts \
  --workers=1 --reporter=list
```

Result: **PASS — 7 passed (33.0m)**. Log:
`/tmp/opencode/cq-multipart-all-pass.log`.

```
Running 7 tests using 1 worker

[BQ] released -> ACTIVE
[BQ] Scenario 1 verified the stored object after 99.5s
  ✓ 1 Scenario 1: normal multipart upload (all parts succeed)                  (3.4m)
[BQ] freeze state: FROZEN
  ✓ 2 Scenario 2: freeze before multipart create                               (2.8m)
[BQ] released -> ACTIVE
[BQ] parked the first part upload; the multipart upload exists and part 1 was minted
ERROR: cannot enter FROZEN: drain verification is missing or incomplete; requesting a freeze is not the same as being frozen
[BQ] freeze state: DRAINING
  ✓ 3 Scenario 3: freeze after multipart create but before finalize            (5.4m)
[BQ] released -> ACTIVE
[BQ] parked part 2; part 1 already uploaded
[BQ] freeze state: FROZEN
  ✓ 4 Scenario 4: freeze after part minting but before finalize                (5.1m)
[BQ] released -> ACTIVE
[BQ] parked the last of 4 parts; only finalisation is left
[BQ] freeze state: FROZEN
  ✓ 5 Scenario 5: freeze after part upload but before finalize                 (6.0m)
[BQ] freeze state: FROZEN
[BQ] released -> ACTIVE
  ✓ 6 Scenario 6: release and resume multipart upload                          (4.6m)
[BQ] freeze state: FROZEN
  ✓ 7 Scenario 7: concurrency and failure recovery                             (2.9m)

7 passed (33.0m)
```

Every result is from this run. Scenario 3's `DRAINING` is the correct, named
outcome: a part upload was genuinely in flight, so the database drain snapshot
could not verify `FROZEN`; `DRAINING` still refuses new writes (the gate blocks in
every non-`ACTIVE` state). The freeze reached `FROZEN` in the other blocking
scenarios.

## Requirements coverage (mirroring Phase CQ §7)

| Phase CQ step                                                       | Scenario          | Result                                            |
| ------------------------------------------------------------------- | ----------------- | ------------------------------------------------- |
| 1 ACTIVE multipart upload + SHA-256 verify                          | 1                 | PASS (verified at 99.5 s)                         |
| 2 freeze refuses new upload                                         | 2                 | PASS                                              |
| 3 freeze after create, before first part                            | 3                 | PASS                                              |
| 4 freeze after first part                                           | 4                 | PASS                                              |
| 5 freeze with last part pending: DRAINING / in-flight / arm / drain | 5                 | PASS                                              |
| 6 reconcile, drain, thaw; ACTIVE upload succeeds                    | 6                 | PASS                                              |
| 7 concurrent uploads blocked while frozen                           | 7                 | PASS                                              |
| 8 real Collabora/WOPI write blocked                                 | (frozen-UX suite) | PASS — see `phase-6u-b3-cq-collabora-wopi-e2e.md` |
| 9 thaw: DOCX edit/save/download + `word/document.xml`               | (BO suite)        | PASS — see `phase-6u-b3-cq-collabora-wopi-e2e.md` |

Scenario 1 and 6 assert the stored object, not the UI: the download capability URL
is read from the pane, fetched from a fresh page (the 256 MiB pdf.js render is a
known browser defect), and its length and SHA-256 are compared with the fixture.

## Defects found and fixed while running

### 1. The 256 MiB fixture was not a valid PDF (test defect)

The generated fixture was `%PDF-1.7\n` + 256 MiB of `B` with no xref trailer.
`finalizeUpload` reads the last 2048 bytes and requires `%%EOF` and `startxref`
(`uploadedFileTailError`), so the server correctly refused it:

```
[uploads] upload finalization failed ... → "This PDF file is incomplete or damaged and cannot be opened"
```

All four 64 MiB parts uploaded (257 MiB present under `_pending/` in MinIO);
only finalisation was refused. This was a **fixture defect, not an app defect** —
the validation is intentional (it stops a truncated/mislabelled PDF reaching
pdf.js).

Fix: `multipart-fixtures.ts` now builds a structurally valid 256 MiB PDF
(valid catalog/pages/page/content objects, an unreferenced `/EmbeddedFile` stream
carrying the payload, a real xref table, `startxref`, `%%EOF`) and the exported
`FIXTURE_HASH` was updated to the new deterministic digest. The file is exactly
268 435 456 bytes.

```
$ pnpm exec tsx -e "import { computeFixtureHash } from './e2e/helpers/multipart-fixtures'; console.log(computeFixtureHash())"
2874c2f8b60ac92b715d4a27a1d429f64302e56dd30a0eb74cce29ff5e4dd646
```

### 2. The stored-object assertion raced the uploader → viewer swap (test defect)

`expectStoredPdfMatchesFixture` waited for the uploader's transient `Uploaded`
row. Once the attachment is linked, `attachFileVersion` requests the PDF and the
pane replaces the uploader with the viewer, so the row can disappear before
Playwright polls it. This produced two false negatives (Scenarios 1 and 6) that
took 600 s each to time out, despite the object being stored (the error context
already showed the download link).

Fix: wait for the stable signal — the pane header's `a[download]` capability link,
which only exists once the attachment is stored — then read its href and verify the
bytes. No product code changed.

## Notes

- Run is serial (`--workers=1`) because the freeze state is per-tenant global; the
  spec's file-level config is not serial, and `fullyParallel: true` would
  otherwise interleave scenarios.
- A previous full run before these two fixes produced 5 passed / 2 failed; those
  results are superseded and not counted.
- Historical Phase BQ results are reference only and were not counted.
- Pending multipart uploads/reservations left by aborted scenarios are swept by
  the worker's reconciliation ticks after expiry; see the final report.
