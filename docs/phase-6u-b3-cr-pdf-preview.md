# Phase 6U-B3-CR — PDF preview limits and behaviour

Date: 2026-10-19
Target: `https://beaconhs-test.xuhaoqing.top` (phase-aj stack)
Tenant: `ea5a149b-ea76-48e0-abbe-fa360f520d8e` (isolated test tenant)

Status: **The upload path accepts and stores a structurally valid 256 MiB PDF.
The preview failure is a fixed 10-second load deadline meeting pdf.js's
full-body download, not a parsing or memory defect. 1, 16 and 32 MiB render;
64 and 256 MiB are aborted by the watchdog without crashing the tab. No code or
limit was changed in this phase.**

## 1. Current limits (read from the code)

| Control                    | Value                              | Source                                   |
| -------------------------- | ---------------------------------- | ---------------------------------------- |
| Document upload size       | 1 GiB (`MAX_PPTX_FILE_BYTES`)      | `apps/web/src/lib/uploads.ts`            |
| Pending uploads per user   | 25                                 | `apps/web/src/lib/uploads.ts`            |
| PDF preview byte cap       | none                               | `apps/web/src/components/pdf-viewer.tsx` |
| PDF preview load deadline  | 10,000 ms                          | `apps/web/src/lib/pdf-preview-policy.ts` |
| Page rendering             | lazy via `IntersectionObserver`    | `apps/web/src/components/pdf-viewer.tsx` |
| Cleanup on timeout/unmount | `task.destroy()`; watchdog stopped | `apps/web/src/components/pdf-viewer.tsx` |

The watchdog is a safety backstop for pdf.js “recovery” scans of a PDF with a
damaged xref. The policy comment records a measured 256 MiB damaged file driving
a Chromium renderer to ~4.7 GB before the tab was killed. The deadline is not a
byte limit.

## 2. Test method

A temporary Playwright probe (not added to the repository) used the existing
authenticated storage state and the real document UI:

1. open `/documents`, create a document, switch to the **PDF** pane;
2. upload a generated PDF through the pane's file input;
3. wait for the stable `a[download]` capability link (upload complete);
4. wait for a pdf.js canvas or the deterministic **“Could not load the PDF”**
   text, recording upload time, preview time and outcome;
5. sample Chromium process RSS and `performance.memory` before/after;
6. leave the page and sample RSS again.

Fixtures: structurally valid 1, 16, 32, 64 and 256 MiB PDFs, plus a 64 MiB PDF
with a valid trailer and a deliberately wrong `startxref` (damaged xref).

## 3. Structural validity (independent of the app)

```
$ pdfinfo /tmp/.../valid-256MiB.pdf
Pages:           1
Page size:       612 x 792 pts (letter)
File size:       268435456 bytes
```

All five valid fixtures report `Pages: 1` and the expected size. The damaged
fixture also reports a page because poppler reconstructs the xref, but pdf.js
announces `Warning: Indexing all PDF objects`.

Local pdf.js parse cost (no network, `pdfjs-dist` 4.10.38, Node):

| Fixture             | Parse time        | Pages |
| ------------------- | ----------------- | ----- |
| valid 1 MiB         | 40 ms             | 1     |
| valid 16 MiB        | 8 ms              | 1     |
| valid 64 MiB        | 26 ms             | 1     |
| valid 256 MiB       | 87 ms             | 1     |
| damaged xref 64 MiB | 514 ms (recovery) | 1     |

A structurally valid 256 MiB file is **not** a parsing or memory problem for
pdf.js. The browser result below is therefore about fetching, not parsing.

## 4. Observed results (real UI, headless Chromium)

| Fixture             |  Upload | Preview | Outcome                               | RSS before → after preview | Main JS heap |
| ------------------- | ------: | ------: | ------------------------------------- | -------------------------: | -----------: |
| valid 1 MiB         |   6.3 s |   1.8 s | **rendered**                          |               492 → 783 MB |        26 MB |
| valid 16 MiB        |  22.4 s |   3.8 s | **rendered**                          |               603 → 852 MB |        28 MB |
| valid 32 MiB        |   7.3 s |   5.8 s | **rendered**                          |               487 → 836 MB |        30 MB |
| valid 64 MiB        |  41.0 s |  10.3 s | **failed** (“Could not load the PDF”) |               604 → 731 MB |        21 MB |
| valid 256 MiB       | 148.0 s |  10.3 s | **failed** (“Could not load the PDF”) |               603 → 742 MB |        24 MB |
| damaged xref 64 MiB |  46.5 s |  10.3 s | **failed** (“Could not load the PDF”) |               606 → 793 MB |        36 MB |

RSS is the sum of the Chromium browser/renderer/utility processes on the
workstation; it includes a ~500–600 MB baseline from prior cases. The growth per
case is bounded (roughly 100–250 MB). No case triggered a renderer kill, a tab
crash, or an OOM. The main-thread JS heap stayed at 21–36 MB; the pdf.js worker
memory is not visible to `performance.memory`, which is why process RSS is also
recorded.

Upload throughput varied between cases (Cloudflare edge cache state and tunnel
throughput). The 32 MiB upload was faster than the 16 MiB upload, while its
preview was slower. The **outcome** threshold is therefore throughput-dependent,
not a fixed byte cutoff.

## 5. Network evidence: the full-body GET is the bottleneck

Chrome DevTools Protocol traces of the viewer's requests to the capability URL:

**16 MiB (rendered):**

```
GET  (no Range)   200  content-length 16777216  encodedDataLength 16781512  duration 3068 ms
GET  Range bytes=0-65535             206  65536 bytes
GET  Range bytes=16711680-16777215   206  65536 bytes
```

The viewer downloads the entire 16 MiB body (16,781,512 bytes) in ~3.07 s and
renders. Range requests for the xref are also made, but the full body is already
the dominant cost.

**64 MiB (failed), retried after the object had been fetched repeatedly:**

```
GET  (no Range)   200  content-length 67108864  failed net::ERR_ABORTED  duration 9459 ms
GET  Range bytes=0-65535             206  65536 bytes
GET  Range bytes=67043328-67108863   206  65536 bytes  failed net::ERR_ABORTED  duration 9337 ms
```

The full-body GET is still aborted at ~9.5 s; the object is not served from a
fast edge cache for this presigned path. A direct full download with `curl`
measured **67,108,864 bytes in 113.87 s (≈ 0.59 MB/s)**, while a 64 KiB range
request took **0.15 s**. The viewer's 10 s deadline therefore fires while the
full body is still downloading.

**256 MiB (failed):**

```
GET  (no Range)   200  content-length 268435456  failed net::ERR_ABORTED  duration 9491 ms
GET  Range bytes=0-65535             206  65536 bytes
GET  Range bytes=268369920-268435455 206  65536 bytes  failed net::ERR_ABORTED  duration 9062 ms
```

The `ERR_ABORTED` entries are the watchdog calling `task.destroy()`; they are the
cleanup working, not a crash.

## 6. Cleanup and memory behaviour

- At 10 s the watchdog destroys the loading task; the in-flight full GET and the
  range requests are aborted (`net::ERR_ABORTED`).
- The viewer unmount path also calls `task.destroy()` and stops the watchdog.
- Across the 256 MiB and damaged-64 MiB cases, process RSS stayed under ~800 MB
  and the page stayed responsive; there was no renderer kill and no OOM.
- This is consistent with the watchdog achieving its purpose: bound a
  pathological load without taking the tab down.

## 7. Diagnosis

Three independent facts must not be conflated:

| Question                          | Answer                                                   | Evidence                                                                          |
| --------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Did the server accept the upload? | **Yes**                                                  | multipart upload completed; `a[download]` link present; bytes stored              |
| Is the file structurally valid?   | **Yes**                                                  | `pdfinfo` reports 1 page and the exact size; local pdf.js parses it in 87 ms      |
| Did the browser parse it?         | **In Node: yes. In the app: not reached for 64/256 MiB** | the app aborts during the full-body download, before parse becomes the bottleneck |

The practical limit in this environment is between **32 and 64 MiB**. The 10 s
deadline is a **download-time cap** for large files, not a parse or memory cap.
The policy comment's “a 255 MiB document resolves and renders in well under a
second” was not measured over this public tunnel. Here the initial full-body GET
dominates and takes tens of seconds for the larger files.

The stale test comment in `apps/web/e2e/phase-bq-multipart-freeze.spec.ts`
(“the renderer is killed by the browser about 80s after the viewer mounts”) no
longer describes the code: the 10 s watchdog aborts the load and the renderer
survives. This is a documentation defect to correct in a follow-up; it was not
edited in Phase CR.

## 8. Options (not implemented; no limit was raised)

1. **Smallest safe UX fix — preflight size + explicit message.** The server
   action already resolves the attachment row; return its `sizeBytes` with the
   capability URL. Above a measured threshold (e.g. 32 MiB), show a determinate
   message (“This PDF is 64 MiB. Preview is limited on this connection — download
   to view.”) and keep the download link. This removes the 10 s spinner and the
   generic error, and preserves the watchdog for damaged files.
2. **Do not simply raise the 10 s deadline.** A damaged 256 MiB file can enter
   pdf.js recovery; the policy's measured 4.7 GB renderer case is the reason the
   cap exists. If the deadline is extended, scale it by content length only after
   a server-side structural check, cap the extension, and add a memory guard.
3. **Root fix to investigate — range-only loading.** The trace shows pdf.js
   issuing a full-body GET before the xref range requests. Determine why
   `getDocument({ url })` is not range-only here (fetch/network stream selection,
   `disableRange`, `disableStream`, `rangeChunkSize`, or the server's
   `Accept-Ranges` handling on the initial request). If the viewer fetched only
   the trailer, xref and page objects, a 64 MiB preview would be small and fast
   and the watchdog would no longer fire.
4. **Edge/origin throughput.** The presigned URL path is a Cloudflare MISS for
   the full-body GET; direct download measured ≈ 0.59 MB/s. A short-lived,
   access-controlled preview route with appropriate cache headers could help,
   but capability URLs are bearer secrets and must not be cached publicly.
5. **Pagination is already present.** Lazy page rendering does not help while
   the whole file is downloaded first; do not treat pagination as the fix.

## 9. Test side effect

The probe created six documents in the isolated test tenant (1, 16, 32, 64,
256 MiB and the damaged 64 MiB). They remain in that tenant's MinIO volume
(≈ 433 MiB); no production data was touched. They were not deleted because
deletion was not requested and the objects are part of the evidence path.

## 10. Status summary

| Check                                             | Result                         |
| ------------------------------------------------- | ------------------------------ |
| Document upload limit / pending limit documented  | PASS                           |
| Preview deadline / lazy rendering / cleanup code  | PASS                           |
| Server upload of 256 MiB valid PDF                | PASS                           |
| Structural validity of 256 MiB valid PDF          | PASS                           |
| Local pdf.js parse of 256 MiB                     | PASS (87 ms)                   |
| Preview 1 / 16 / 32 MiB                           | PASS                           |
| Preview 64 MiB                                    | FAIL (10 s watchdog; no crash) |
| Preview 256 MiB                                   | FAIL (10 s watchdog; no crash) |
| Damaged-xref 64 MiB                               | FAIL (10 s watchdog; no crash) |
| Watchdog abort / worker destroy / unmount cleanup | PASS                           |
| Memory bounded, no OOM / renderer kill            | PASS                           |
| Size-aware message or limit change                | NOT RUN (proposal only)        |
| Range-only loading investigation                  | NOT RUN (proposal only)        |
