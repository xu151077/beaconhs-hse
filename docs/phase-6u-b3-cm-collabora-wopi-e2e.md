# Phase CM — Collabora/WOPI E2E Report

Date: 2026-10-18

## 1. Status

**PARTIALLY VERIFIED** — Collabora iframe loads, editing works, save works, download verifies text. Reopen verification inconclusive (canvas-rendered text). Freeze write blocking NOT RUN.

## 2. Test results

| Step                   | Result           | Evidence                                                                        |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------- |
| DOCX upload            | **PASS**         | File accepted, document created, master set in DB                               |
| Collabora iframe loads | **PASS**         | Host_PostmessageReady received, 11 toolbar elements, iframe rendered            |
| Edit (type text)       | **PASS**         | Typed "PhaseCMEdit-1792310682774", text found in frame textContent              |
| Save (Ctrl+S)          | **PASS**         | "上次保存：6秒前" (Last saved: 6 seconds ago)                                   |
| Download & verify      | **PASS**         | Downloaded DOCX contains "PhaseCMEdit-" in document.xml                         |
| Reopen verification    | **INCONCLUSIVE** | Text not found via textContent (canvas-rendered), download confirms persistence |
| Freeze write blocking  | **NOT RUN**      | Requires freeze state machine driver                                            |

## 3. Key findings

### Collabora iframe loads

The Collabora iframe is rendered with empty `src` (because it's loaded via form-POST, not `src` attribute). The Collabora editor initializes and reports `Host_PostmessageReady`. The frame body shows the Collabora toolbar and document area.

### Editing works

Typing into the document via `page.keyboard.type()` successfully inserts text. The text is found in the frame's `textContent` immediately after typing.

### Save works

Pressing Ctrl+S triggers a save. The frame shows "上次保存：6秒前" (Last saved: 6 seconds ago), confirming the save completed.

### Download verifies text

Downloading the document via `/documents/{id}/master` produces a valid DOCX file. Extracting `word/document.xml` confirms the typed text "PhaseCMEdit-" is present.

### Reopen inconclusive

After reopening the document, the typed text is not found via `textContent` because Collabora renders the document on a canvas, not in DOM text nodes. The download verification confirms the text persisted.

### 404 investigation

The 404 is for `/browser/201368fc8d/extensions/index.json` — a Collabora extension loading request, not an application error. This is non-critical.

## 4. Technical details

- Collabora discovery XML: accessible at `https://beaconhs-test.xuhaoqing.top/hosting/discovery` (200)
- Collabora edit URL for docx: `https://beaconhs-test.xuhaoqing.top/browser/201368fc8d/cool.html`
- Collabora iframe: loaded via form-POST (not `src` attribute)
- Cross-origin: Collabora is same-origin (routed through reverse proxy)
- WOPI token: minted by `getDocumentWriterSession` server action
- Host_PostmessageReady: received (Collabora handshake complete)

## 5. What was NOT verified

- **Freeze write blocking**: Requires freeze state machine driver (not available)
- **Reopen via textContent**: Inconclusive due to canvas rendering (download confirms persistence)
- **Cross-tenant access denial**: Requires a second tenant session
- **WOPI token expiry**: Requires waiting for token to expire

## 6. Phase BQ results (historical evidence — NOT counted as Phase CM)

Phase BQ verified Collabora editing end-to-end:

- DOCX upload, edit, save, reopen
- WOPI GetFile/PutFile flow
- Collabora iframe loading
- All scenarios passed
