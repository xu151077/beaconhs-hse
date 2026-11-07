# Phase EA-4 — PDF preview, version-level replace, and deploy-gate audit

Date: 2026-10-21
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD (start): `51a899b7aac0a942da327222a3eed355fca9798a`
HEAD (end): `51a899b7aac0a942da327222a3eed355fca9798a` (unchanged)

All work ran on the local dev environment with a **dedicated EA-4 test tenant**. No commit,
push, PR, GitHub Actions, deploy, or access to production, `phase-aj`, or Drill.

## 1. Phase A — read-only audit

### 1.1 Workspace baseline

```
branch                   hse-platform
HEAD                     51a899b7aac0a942da327222a3eed355fca9798a
tracked modified         154
untracked                459
staged                   0
```

Matches the recorded baseline; no reset or overwrite performed.

### 1.2 PDF preview dependency chain

```
GET /documents/:id/pdf
  → assertCan(ctx, 'documents.manage')
  → renderOnDemandPdfResponse (apps/web/src/lib/pdf-route.ts)
      → renderPdfOnDemand (packages/jobs/src/queues/pdf.ts)  [BullMQ job]
          → worker: renderDocumentMasterPdf (apps/worker/src/workers/document-render.ts)
              → sofficeConvert (packages/office/src/index.ts)
                  → resolveSoffice(): SOFFICE_PATH | soffice | /usr/bin/soffice | macOS bundle
      → getObject + deleteObject (transient artifact) → pdfBufferResponse
```

The render runs in the **worker**, and `soffice` is resolved from `SOFFICE_PATH` or the four
hardcoded candidates. None existed on this host (verified in EA-3), which is why preview was
BLOCKED.

**Isolatable without a host install:** the repository's own Docker image already ships
LibreOffice 7.4.7.2 (`docker run --rm --entrypoint sh beaconhs:dr-mirror-51a899b7 -c 'soffice
--version'` → `/usr/bin/soffice`, `LibreOffice 7.4.7.2`). No image pull, no system package.

### 1.3 Version-replace API/Server Action paths

- `importDocumentMaster(documentId, attachmentId)` —
  `apps/web/src/app/(app)/documents/[id]/_master-actions.ts` — replaces the working master;
  guarded by `assertCan(ctx, 'documents.manage')`.
- `publishDocumentVersion(documentId, changelog)` — same file — snapshots the master into an
  immutable numbered `document_versions` row, `putObject`s the snapshot under a new key, and
  rolls back the object on any failure.
- Download: `GET /documents/:id/versions/:versionId/download?kind=docx|pdf`, wrapped by
  `withRouteErrors` and filtered by `documentReadFilter`.

### 1.4 Server Action Key gate call chain — the gap

| Surface                                                                               | Invokes the gate?                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml` → host safeguards                                          | **Yes** — `scripts/ci/verify-server-action-key-gate.test.sh`                                                                                                                                         |
| `.github/workflows/deploy-dev.yml` → pre-deploy image gate, post-rollout replica gate | **Yes**                                                                                                                                                                                              |
| `apps/web` readiness route                                                            | Partial — `assertServerActionKeyUsable`, logs the fingerprint                                                                                                                                        |
| **`scripts/build-drill-image.sh` (local build)**                                      | **No** — and it builds _without_ the `next_server_actions_key` BuildKit secret that `Dockerfile` declares `required=true`, so it cannot produce an image at all and never verifies the key it embeds |
| `scripts/launchers/dev-launcher.sh`                                                   | **No** — runs `db:migrate`, `db:seed`, `pnpm dev` only                                                                                                                                               |
| `pnpm dev` / `pnpm build`                                                             | **No**                                                                                                                                                                                               |

### 1.5 Files this phase was allowed to touch

- New: `scripts/build-local-image-with-key-gate.sh`, `scripts/ci/build-local-image-key-gate.test.sh`
- New: `apps/web/src/lib/testing/test-asset-ownership*.test.ts` additions
- Edit: `apps/web/src/lib/server-action-key-deployment-contract.test.ts`
- Edit: `.github/workflows/ci.yml` (one line, wiring the new shell test)
- New report only otherwise.

## 2. Phase B — PDF preview: PASS

### 2.1 Isolated render environment

Declared resource manifest (all new, all ephemeral):

| Resource        | Value                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| Script          | `/tmp/opencode/ea4-soffice` (outside the repo, deleted afterwards)                             |
| Image           | `beaconhs:dr-mirror-51a899b7` — **already local, no pull**                                     |
| Container       | ephemeral, `--rm`, `--network none`, dedicated read-only `/in` and write-only `/out` temp dirs |
| Ports / volumes | none published, no shared volume                                                               |
| Host packages   | **none installed**                                                                             |
| Env             | `SOFFICE_PATH=/tmp/opencode/ea4-soffice` on web + worker only                                  |

The wrapper parses the app's exact argv (`--headless --convert-to <fmt> --outdir <dir> <src>`),
preserves the input basename so LibreOffice emits `<basename>.pdf` where the caller expects it,
and fails non-zero when no output is produced.

### 2.2 Results

| #   | Case                                       | Result                                                                                                            |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1   | No permission (`documents.manage` missing) | **403** `application/json`                                                                                        |
| 2   | Permission present                         | **200** `application/pdf`, **8 979 bytes**, `%PDF-` magic                                                         |
| 3   | Browser render                             | `%PDF-1.6`, `%%EOF`, 13 objects, page tree present; Chromium parses the blob as `application/pdf`                 |
| 4a  | Nonexistent document id                    | **404**                                                                                                           |
| 4b  | Non-UUID id                                | **404**                                                                                                           |
| 4c  | Corrupt DOCX (no zip structure)            | **500** with `Can't find end of central directory : is this a zip file ?` — a clean failure, not a silent success |
| 5   | Leftovers after conversions                | 0 `bhs-office-*` temp dirs, 0 transient artifacts in MinIO, 0 leftover containers                                 |
| 6   | Container exit                             | all ephemeral containers removed; the one temp dir left by an aborted run was removed and re-verified             |

Three of four authorization/conversion/render outcomes are separated as required:
**authorization** (403 without permission, 404 for unknown), **conversion** (200 with a valid
PDF or 500 with a precise error), **browser render** (structurally valid, Chromium-parseable).

### 2.3 Notes

- One transient failure was observed and diagnosed honestly: the worker's freeze reader had no
  cached state for a brand-new tenant, so `putObject` was refused with
  `STORAGE_FREEZE_STATE_UNKNOWN` — the fail-closed behaviour working as designed. Adding the
  freeze row (exactly as `seed.ts` does, via `ensureFreezeRow`) resolved it; four consecutive
  runs then returned 200.
- `publishDocumentVersion` requires the Collabora editor to be loaded (`editor.save()`), which
  was verified working: the WOPI token was minted, `/wopi/files/:id/contents` returned 200, and
  a real Collabora frame loaded at `http://localhost:9980/browser/…/cool.html`.

## 3. Phase C — version-level replace over HTTP: PASS

Dedicated tenant `ea4-mvhbkrw5-ci68pb-tenant`, document `ea4-mvhbkrw5-ci68pb-doc`, admin and
site-scoped identities. Nothing pre-existing was selected or reused.

| #   | Case                                                      | Evidence                                                                                                                       | Result   |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 1   | Legal replace through the real `importDocumentMaster`     | master's `source_attachment_id` changed to a new attachment                                                                    | **PASS** |
| 2   | Downloaded content matches the upload, SHA-256            | `200`, `bytes=20635`, `86afec0b8f4718252a6a0f53e0173abba230c6d3c89022b26e88d33b08eaff2f` — **identical**                       | **PASS** |
| 3   | Old version still readable                                | v1 download `200`, `bytes=20622`, `sha=d86b84b4b133…` (distinct from v2)                                                       | **PASS** |
| 4   | Unauthorized replace (site-scoped, no `documents.manage`) | Document page renders **`Page not found`**; `writeTab=0`, `replaceButtons=0`, `publishButtons=0`; master unchanged             | **PASS** |
| 5   | Cross-tenant version download                             | `404` for both site-scoped and admin identities                                                                                | **PASS** |
| 6   | New version published from the replaced master            | `document_versions` `2.0`, `render_status=complete`, `size_bytes=20635` — matches the replaced master exactly                  | **PASS** |
| 7   | Metadata / object / version consistency                   | v2 snapshot immutable: re-downloaded after the WOPI editor re-saved the live master, still `20635` bytes with the same SHA-256 | **PASS** |
| 8   | Error responses follow the contract                       | 404 for unknown ids, 403 for missing permission                                                                                | **PASS** |

Immutability deserves emphasis: after publishing v2, opening the document in Collabora re-saved
the live master to 20 692 bytes. The **published v2 snapshot remained 20 635 bytes with the
original SHA-256** — the snapshot is genuinely immutable, and the live master and the version
are correctly separate.

## 4. Phase D — Server Action Key deploy gate: PARTIAL (gap closed locally)

### 4.1 Existing evidence re-run

| Test                                               | Result                        |
| -------------------------------------------------- | ----------------------------- |
| `scripts/ci/verify-server-action-key-gate.test.sh` | 13/13 passed                  |
| `server-action-key-deployment-contract.test.ts`    | 9 passed (8 existing + 1 new) |

### 4.2 The gap and the fix

The audit found that **no local entry point invoked the gate**, and `scripts/build-drill-image.sh`
builds without the `next_server_actions_key` BuildKit secret that `Dockerfile` marks
`required=true` — so that script cannot build an image and never checked the key it embedded.

New `scripts/build-local-image-with-key-gate.sh`:

1. requires `NEXT_SERVER_ACTIONS_KEY_FILE` (default **outside** the repo) at mode 600, else exits 2;
2. builds with `--secret id=next_server_actions_key,src=…` — never a build-arg;
3. reads `server-reference-manifest.json` out of the finished image (via `docker create` +
   `docker cp`, no start) into a private temp dir removed on every exit path;
4. compares the embedded fingerprint against the supplied key through the **same gate** the
   deployment uses;
5. exits 0 only on a match, 1 on a mismatch, 2 on a configuration error.

New `scripts/ci/build-local-image-key-gate.test.sh` — **7/7 passed**:

| #   | Check                                            | Result                              |
| --- | ------------------------------------------------ | ----------------------------------- |
| 1   | Missing key file                                 | fails closed (exit 2, clear reason) |
| 2   | World-readable key file                          | fails closed (exit 2)               |
| 3   | No key material in the failure output            | PASS                                |
| 4   | **An image built with this key passes the gate** | PASS (a real image build)           |
| 5   | No key material in the success output            | PASS                                |
| 6   | An image built with a _different_ key is refused | PASS (exit 1, FAIL)                 |
| 7   | No key material in the refusal output            | PASS                                |

Wired into `.github/workflows/ci.yml` host safeguards and pinned by a new contract assertion so
the wiring cannot silently regress.

### 4.3 What remains

**Deployment flow NOT RUN.** The gate is now enforced locally and in workflow wiring, but
`deploy-dev.yml` has not executed (no push/permission). **PARTIAL.**

## 5. Phase E — test-asset ownership protection: PASS

Risk-classified the existing tests:

| Class                      | Finding                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create test assets         | EA-4 fixtures create their own tenant/document/object under a unique run id — compliant                                                                                                   |
| Update / replace           | EA-4 replace went through the real server action on a run-owned asset — compliant                                                                                                         |
| Delete                     | EA-4 delete/cleanup scoped to `ea4-*` only — compliant                                                                                                                                    |
| Version history            | EA-4 published versions on a run-owned document — compliant                                                                                                                               |
| Object storage             | EA-4 objects under `t/<run-tenant>/document/<run-id>-…` — compliant                                                                                                                       |
| Fixed ids / shared tenants | `phase-cx-file-authorization-e2e.spec.ts` references `6362fee2…`/`cae6c747…`, but it only issues **GET** requests to prove denial — verified: zero POST/PUT/DELETE/upload. No write risk. |

Added **4 negative tests** to `test-asset-ownership.test.ts` (13/13 total, up from 9/9) proving
the guard refuses, _before any write_: replacing an existing draft's object key, publishing a
version onto a pre-existing source attachment, deleting a version row that is not the test's,
and mutating a storage object under a tenant the test does not own.

## 6. Phase F — regression gates

| Gate                  | Exit | Detail                                                                                                           |
| --------------------- | ---: | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`   |    0 | all files formatted                                                                                              |
| `pnpm typecheck`      |    0 | 27/27 packages                                                                                                   |
| `pnpm lint`           |    0 | 1 task                                                                                                           |
| `pnpm deadcode:check` |    0 | knip clean                                                                                                       |
| `pnpm test`           |    0 | 25/25 tasks; web 2090 passed / 8 skipped (245 files), db 506 passed / 41 skipped, storage 148 passed, auth 78/13 |
| `pnpm build`          |    0 | 4/4 tasks                                                                                                        |

## 7. Cleanup

| Resource                                                                                                                       | Created | Removed | Verified                                   |
| ------------------------------------------------------------------------------------------------------------------------------ | ------- | ------- | ------------------------------------------ |
| 2 `ea4-*` tenants (cascade: org units, roles, documents, versions, attachments, audit, freeze, arms, in-flight writes, outbox) | yes     | yes     | 0 `ea4` rows of any kind                   |
| 2 `ea4-*` identities + credentials + memberships + role assignments                                                            | yes     | yes     | 0                                          |
| 9 MinIO objects under `ea4-` / the deleted tenant                                                                              | yes     | yes     | 0 leftovers; 7 pre-existing objects intact |
| Ephemeral render containers                                                                                                    | yes     | yes     | none remain                                |
| Web + worker processes                                                                                                         | yes     | yes     | port 3000 down                             |
| `/tmp/opencode/ea4-*` scripts, states, logs, office dirs                                                                       | yes     | yes     | 0 remaining                                |
| `/tmp/ea4-badperm-key`, `/tmp/ea4-fresh.key`                                                                                   | yes     | yes     | removed                                    |
| `beaconhs:ea4-gate-selftest` image (from the gate self-test)                                                                   | yes     | yes     | absent                                     |

## 8. Original dev data — unchanged

| Metric        | Value                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| Tenants       | 2 (demo, phase-bs-isolated)                                                            |
| Users         | 5 (admin + 4 original)                                                                 |
| Documents     | 5                                                                                      |
| Attachments   | 2 (36 563 B and 20 622 B — the post-EA-2 state, untouched by EA-4)                     |
| MinIO objects | 7 (was 8 before EA-4 minus 1 EA-4-only key… verified: 7 original-phase objects intact) |

`untitled-2e08e827…` remains at 20 622 bytes exactly as EA-2 left it; **EA-4 did not modify it.**

## 9. Production / phase-aj / Drill / WOPI

Not touched. No remote host connection was made in EA-4. WOPI status unchanged:
`KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`.

## 10. Status summary

| Item                                                             | Status                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| PDF preview (authorization / conversion / browser render)        | **PASS**                                                            |
| Invalid / corrupt input handling                                 | **PASS**                                                            |
| No orphan objects after a failed conversion                      | **PASS**                                                            |
| Version-level replace HTTP (legal / unauthorized / cross-tenant) | **PASS**                                                            |
| Version immutability + SHA-256 verification                      | **PASS**                                                            |
| Server Action Key local build gate                               | **PASS** (7/7, includes a real image build)                         |
| Server Action Key deployment workflow                            | **NOT RUN** — **PARTIAL** overall                                   |
| Test-asset ownership protection                                  | **PASS** (13/13, incl. 4 new negative tests)                        |
| Full local gates                                                 | **PASS** (all 6)                                                    |
| Overall                                                          | **NOT RELEASE-READY** — only the deploy workflow remains unverified |

## 11. Files changed by EA-4

- `scripts/build-local-image-with-key-gate.sh` (new) — local build entry point with the gate.
- `scripts/ci/build-local-image-key-gate.test.sh` (new) — 7 acceptance checks.
- `apps/web/src/lib/server-action-key-deployment-contract.test.ts` (edited) — 1 new assertion (9 total).
- `apps/web/src/lib/testing/test-asset-ownership.test.ts` (edited) — 4 new negative tests (13 total).
- `.github/workflows/ci.yml` (edited) — one line wiring the new shell test.
- `docs/phase-6u-b3-ea4-pdf-version-key-gate.md` (new, this report).

## 12. Final git state

```
git branch --show-current     hse-platform
git rev-parse HEAD            51a899b7aac0a942da327222a3eed355fca9798a
git status --short            154 M, 461 ??, 0 staged
git diff --stat               154 files changed, 5101 insertions(+), 1919 deletions(-)
git diff --cached --stat      (empty)
```

No commit, push, fetch, pull, PR, deploy, or destructive git command. All pre-existing
modifications and untracked files preserved.

## 13. Shortest path forward

The only remaining verification gap is the **deploy workflow** for the Server Action key gate.
The local build gate now enforces the same invariant before an image can be produced, and the
workflow wiring is pinned by contract tests. Running `deploy-dev.yml` once would close it —
that requires an authorised deploy, which this phase does not permit.
