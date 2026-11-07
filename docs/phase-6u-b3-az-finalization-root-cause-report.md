# AZ — Multipart Finalization Root-Cause Closure

Date: 2026-10-16 (UTC 06:44). Branch `hse-platform` (no commit, no push).

## 1. Root cause identified

The five `UploadPart` public HTTPS requests all succeeded (`200`), yet `Files (0)` remained on first glance.

The application's equipment Files tab does **not** create an `equipment_files` row until the user explicitly
commits it with **Save file** after `FileUploader` finishes (server-side finalize returns the
attachment, the UI keeps it in `uploaded` state locally). Closing/resetting the drawer drops the list row
in the client, even though the server-side attachment and S3 final object are valid. Thus:

- the empty list was a **workflow artifact**, not a failed finalization;
- the `attachment_upload_reservations.consumed_at` / `attachment_id` confirmed two consumed
  reservations; and
- `attachments` already contained the completed document with the expected 260 MiB size.

## 2. Executed evidence

- Presigned part PUT requests: 5 × `200` against
  `https://beaconhs-test.xuhaoqing.top/beaconhs-phase-aj/...` (public test domain, no CSP rejection).
- Attachment row created with:
  - `id` `25f698ea-99e1-4e3f-acf5-bb133382f816`
  - `filename` `ar-multipart.pdf`
  - `size_bytes` `272629760`
- Downloadable final object (via app signed GetObject + successful redirect) contained:
  - `SIZE=272629760`
  - `SHA256=b06e1c7663f17e9388643baddb72fb5c9af7b867e58d407cf5c44940333cbf1c`
- Source byte count and SHA-256:
  - `wc -c`: 272629760
  - `sha256sum`: `b06e1c7663f17e9388643baddb72fb5c9af7b867e58d407cf5c44940333cbf1c`
- Downloaded response (`content-length: 272629760`, `200 OK`) matched exactly.

Therefore:

- Multipart initialization: **PASS**
- five public HTTPS part PUTs: **PASS** (200 each)
- Beaker `completeness`, ETag matching, object finalization: **PASS**
- `attachment` finalize transaction + rows: **PASS**
- authenticated download: **PASS**
- size + SHA-256 exact match: **PASS**

The single-file UI upload from prior phases remains unchanged and still valid; this round closes the
largest remaining multipart gap.

## 3. Isolated tenant and freeze note

- A further browser freeze UI proof was not safely performed against the shared `Phase AJ Test Tenant`.
- Database/API-level freeze behavior remains PASS (prior 36 + 16 targeted scenarios).
- Do not mark freeze browser proof PASS without isolated-tenant host support.

## 4. Collabora status

NOT RUN. Editor is not fully configured on test host (`In-browser editing is not configured`).
Discovery endpoint returned valid WOPI XML, but no real save/open cycle was proved.

## 5. Cleanup

- Deleted the transient document used for proofing data and left its attachment's object bound
  under a known tenant row.
- No shared/customer data, Drill resources, resolver credentials or secret material were altered.
- No scope, IAM, bucket policy, production mapping or tunnel change. No commit/push.

## 6. Classification

| Area                                          | Status                                   |
| --------------------------------------------- | ---------------------------------------- |
| Multipart browser (all parts / final GET)     | **PASS**                                 |
| Download SHA-256 exact                        | **PASS**                                 |
| Single-file browser upload + download hash    | **PASS**                                 |
| Freeze DB state machine                       | **PASS**                                 |
| Freeze browser UI at `ACTIVE→FROZEN→ACTIVE`   | **NOT RUN / FAIL** (no isolated tenant)  |
| Collabora complete edit                       | **NOT RUN / FAIL**                       |
| Production IAM/lifecycle/backup/alert/network | **NOT RUN / UNKNOWN** - no authorization |
| Repo source changes made                      | none in this round                       |

## 7. G2 readiness

G2 stays **NOT PASS**. The remote browser/runtime evidence now includes a complete
multipart+download+hash proof, but freeze UI, full Collabora and production infra remain genuinely
blocked.<|end|>
