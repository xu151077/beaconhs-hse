# Phase 6U-B3-CQ — Collabora / WOPI freeze and DOCX persistence E2E

Date: 2026-10-19
Specs:

- `apps/web/e2e/phase-bq-frozen-ux.spec.ts` (freeze UX, WOPI session refusal)
- `apps/web/e2e/phase-bo-e2e.spec.ts` Scenarios A and B (DOCX edit/save/download)

Status: **PASS — freeze blocks the WOPI session, and after thaw a real Collabora
edit persists into the master DOCX and the download is byte-identical.**

## 1. Freeze blocks the Collabora/WOPI write path

```
$ cd apps/web && pnpm exec playwright test e2e/phase-bq-frozen-ux.spec.ts \
    --workers=1 --reporter=list
Running 4 tests using 1 worker

[BQ] freeze state: FROZEN
  ✓ 1 Scenario 1: frozen Start blank is refused with the frozen copy          (2.9m)
[BQ] freeze state: FROZEN
  ✓ 2 Scenario 2: frozen Import Word is refused with the frozen copy          (41.8s)
[BQ] released -> ACTIVE
  ✓ 3 Scenario 3: ACTIVE workspace opens the editor normally                  (2.3m)
[BQ] released -> ACTIVE
[BQ] freeze state: FROZEN
  ✓ 4 Scenario 4: server-side freeze gate refuses a WOPI session              (4.6m)

4 passed (13.3m)
```

Log: `/tmp/opencode/cq-frozen-ux.log`.

Coverage relevant to Phase CQ step 8:

- Scenario 4 builds a document that **has** a Word master while the workspace is
  writable, freezes through the real state machine, then reopens the document. The
  server refuses to mint a WOPI session, the frozen panel (`STORAGE_FROZEN_TITLE` +
  `STORAGE_FROZEN_DETAIL`) is shown, and **no iframe** is created. This is the real
  Collabora/WOPI entry point, refused at the server.
- Scenario 1 (frozen `Start blank`) and Scenario 2 (frozen `Import Word`) show the
  same refusal on the two other write paths a user reaches from the document pane.
- Scenario 3 confirms the editor opens normally once the tenant is `ACTIVE`.

## 2. DOCX edit → save → download after thaw

```
$ cd apps/web && E2E_STORAGE_STATE=/tmp/opencode/bt-auth.json \
    pnpm exec playwright test e2e/phase-bo-e2e.spec.ts -g "Scenario (A|B)" \
    --workers=1 --reporter=list
Running 2 tests using 1 worker

  ✓ 1 Scenario A — Collabora edit + save persists into the master DOCX        (21.2s)
[Scenario B] raw Content-Disposition:
  attachment; filename="_.docx"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3.docx
  ✓ 2 Scenario B — upload → download is byte-identical and keeps its Unicode name (13.1s)

2 passed (34.7s)
```

Log: `/tmp/opencode/cq-bo-docx.log`.

- Scenario A (step 9): starts a blank document, opens the real Collabora Writer
  frame (`cool.html`), types a unique marker, presses **Ctrl+S**, then downloads the
  master via `GET /documents/{id}/master` and unzips `word/document.xml` — the
  marker is present. The persisted artifact, not the UI, is the oracle.
- Scenario B: uploads a DOCX and downloads it; the bytes are SHA-256 identical and
  the RFC 5987 `filename*=UTF-8''…` preserves the Chinese filename.

## Notes

- `E2E_STORAGE_STATE` was pointed at the verified session file
  (`/tmp/opencode/bt-auth.json`); the suite default `/tmp/beaconhs-e2e-auth.json`
  is an older capture. No credential values were printed.
- The frozen-UX suite uses the same `freeze-control` helper as the multipart suite,
  so it drives `beaconhs-phase-aj-worker-1` against the app's own database.
- Collabora is the pinned image `collabora/code@sha256:4e983196…` already running in
  the `phase-aj` stack; it was not re-configured.

## Status

| Item                                                               | Result |
| ------------------------------------------------------------------ | ------ |
| WOPI session refused while frozen (step 8)                         | PASS   |
| Frozen copy shown; no iframe minted                                | PASS   |
| Editor opens after thaw                                            | PASS   |
| Collabora edit + Ctrl+S persists into `word/document.xml` (step 9) | PASS   |
| DOCX download byte-identical; Unicode filename preserved           | PASS   |
