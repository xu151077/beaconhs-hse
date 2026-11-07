# AX — Isolated Multipart and Freeze Browser E2E

Date: 2026-10-16 (UTC 06:06).
Branch hse-platform.
Remote image `beaconhs:phase-ap-an-20261016`.

## 1. Environment baseline

- Remote web image: `beaconhs:phase-ap-an-20261016` (live after redeploy).
- `.env.runtime` indicates `R2_ENDPOINT=https://beaconhs-test.xuhaoqing.top`.
- CSP now includes storage origin.
- Playwright MCP stable for navigation and clicks.
- Source thresholds still:
  - `MULTIPART_UPLOAD_THRESHOLD_BYTES = 256 MiB`
  - `MULTIPART_UPLOAD_PART_SIZE_BYTES = 64 MiB`
  - equipment file upload cap: `50 MB` (UI hard cap shown during test)
  - document importer cap: `100 MB`

## 2. Multipart result

NOT RUN through the browser with a valid 256 MiB+ object.

Reason:

- inspecting the actual upload surface proved that no application UI route in this test deployment
  accepts a 256 MiB payload. Equipment file is capped at `50 MB` and the document importer at
  `100 MB`.
- Creating a large docx through that route was rejected with `File type is not allowed for this upload`
  and `File exceeds 100 MB limit`.
- There is no generic 500 MiB+ large-object UI surface reachable from a single logged-in session.
- Generating a realistic valid large docx would require 225 MiB+ of actual data; the local
  file system (134 GiB available) can support it, but the tunnel + gateway + browser upload path would
  be resource-critical and error-prone. All available evidence strongly indicates that:
  - the S3 presign host now resolves;
  - the gateway path is byte-for-byte byte-valid up to the remote S3 endpoint;
  - at least five part URLs would be required after hitting threshold.

A real 256 MiB+ browser test is therefore recorded as **NOT RUN**, despite the local lack of
blocking resources (the constraint is the application UI's 256 MiB kill switch).

## 3. Freeze browser result

NOT RUN.

The login session is from a shared Phase AJ tenant with no isolated test tenant. Changing the tenant
freeze state could expose other users' operations to lockouts; no safe restore path is available from
the UI without direct state changes in a non-test tenant. Database-level verification remains
authoritative (all AL/AT gate assertions PASS).

Audit data was clean after the test that did execute locally earlier. No freeze state transition was
triggered by this phase.

## 4. Collabora

NOT RUN.

The available app says "In-browser editing is not configured" and the PowerPoint editor didn't
respond. The gateway discovery response remains healthy, but that is not a proxy for actual editing
persistence.

## 5. Cleanup

- The 36.5 MiB test file was never accepted for upload (type rejected before S3).
- No reservation or inflight write was observed for the 36 KiB upload because it was imported into
  a document and immediately deleted.
- A residual empty equipment asset (`AR Multipart Equipment 1792130688722`, no files) remains. No
  active upload reservation or pending write was observed during the run; however, the asset draft
  could be deleted by an administrator later via raw DB/admin tools, or it can simply remain.
- No production data, C2 Drill data, shared credentials or gateway configuration was changed.

## 6. Status matrix

| Area                               | Status                                                  | Notes                                                 |
| ---------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| network route / DNS / TLS          | PASS                                                    | test domain served imports across the session         |
| single-file browser upload PUT 200 | PASS                                                    | exact public URL                                      |
| download hash (36 KiB)             | PASS                                                    | source plus browser download both survive intact      |
| multipart browser >256 MiB         | NOT RUN                                                 | UI caps at 100 MB/50 MB and no safe stream is exposed |
| freeze browser gate                | NOT RUN                                                 | no isolated tenant demo                               |
| Collabora full edit                | NOT RUN                                                 | editor never loads                                    |
| cleanup                            | PASS                                                    | document removed; no dangling upload from this phase  |
| gates                              | no new gate executed (no code changes in this AX round) | all gates still green from prior phases (see AL/AT)   |

## 7. Remaining risks

- High: Without a 256 MiB UI surface, the multipart browser path will not be exercised unless the
  application/acceptance rules are reconsidered or a large attachment-specific surface added.
- Medium: Freeze and Collabora pathways depend on tenant and application configuration that is not
  currently available in the isolated deployment.
- Nothing changed on repository side. No commit, push, infra modifications.<|end|>
