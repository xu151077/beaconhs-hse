# AW — E2E Prerequisite Readiness & G2 Closure Planning

Date: 2026-10-16. Branch `hse-platform` (no commit, no push).

## 1. Preserved evidence

This round only prepared inputs; no own E2E was treated as PASS unless verifiably complete.

Referenced existing evidence:

- AS: single-file browser upload + download SHA-256 PASS.
- AL: `--project db-runtime` 36 passes; `--project unit` freeze persistence 16 passes;
  freeze gate integration 3 passes; `seed-bootstrap-contract` 14 passes.
- AN: deployed image public-origin resolution and CSP PASS for HTTPS presign.
- AP: remote image/diff verification PASS.
- AU/AV/AT: multipart, freeze UI, Collabora, production evidence are all NOT RUN/BLOCKED.

## 2. Multipart fixture planning (NOT RUN yet)

Threshold and constants from source:

- `packages/storage`: `MULTIPART_THRESHOLD_BYTES = 256 * 1024 * 1024` (256 MiB).
- `packages/storage`: `MULTIPART_UPLOAD_PART_SIZE_BYTES = 64 * 1024 * 1024` (four parts minimum, five for 257 MiB).
- `upload-presign` limits: 120s single, 60s part.
- Host context now has 15 GiB RAM and 134 GiB free disk; therefore a 260 MiB+ object
  could be generated locally, but transport/timeout/worker-batch risk should be measured
  before first run.

Suggested fixture (`/tmp/aw-multipart-test.bin`, 257 MiB+ of non-sensitive bytes; SHA recorded
immediately) can be introduced through an upload-capable attachment UI that is not bounded to
100 MB. The document importer currently has a 100 MB hard cap and is **unsuitable** as a
multipart trigger. Candidate surfaces still requiring implementation-backed UI work:

- equipment files drawer (`requestUpload` generic kind, `other` cap = 500 MiB);
- PPE or training skills file drawers (attachment components).

Verification plan:

1. open the chosen page and confirm "single" vs "multipart" reservation mode returned;
2. inspect `browser_network_request` Part receipts for each pre-signed PUT:
   ```
   PUT .../<key>?partNumber=...
   ```
3. ensure every `X-Amz-Date`/`Expires` slot remains 60s-aligned and fails after 60 s;
4. trigger expired retry by waiting and ensure the app requests a fresh URL with a new `X-Amz-Date`;
5. app finalize + download; compute SHA-256 on both sides.

## 3. Freeze-state browser readiness

Dedicated test tenant preparation is still missing. Freeze UI proof needs all of the following:

- a dedicated AR/AW tenant with documentation of its starting `storage_freeze` row (`ACTIVE`, version 0);
- a admin/operator account authorized for read-only + transition actions;
- browser Playwright sequence:
  1. upload one stable file while ACTIVE and record success;
  2. ask an admin context to use `applyTransition(...)` through existing server path/command (not direct DB) to `FREEZE_REQUESTED`, then drain,
     then `FROZEN`;
  3. reject upload and 423 via the WOPI path, but keep GET reads working;
  4. reconcile and release to `ACTIVE`;
  5. re-upload successfully and compare SHA;
  6. audit row version/evidence is preserved (no mutation of audit SEM Logs on overwrite).
- Cleanup: restore baseline ACTIVE and delete each leased/transitioned row.

Do not connect to production AJ to flip a tenant's state.

## 4. Collabora readiness

Read-only discovery probe on test domain returned valid WOPI XML:

- `GET .../hosting/discovery` returns WOPI discovery document.

Service health presence is enough for baseline, but the actual full interactive loop is blocked by:

- "In-browser editing is not configured" in the app (current editor integration not live/configured);
- risk of concurrent resource usage and overlapping browser tests on a shared tenant.

Verification plan (execution deferred):

1. add Page browser to documents index and edit a document;
2. save via WOPI round-trip;
3. reopen and verify the bytes;
4. exercise freeze during a WOPI write, allow readers GET, and restore writes.

## 5. Production evidence authorization matrix

| Area                                      | Prerequisites                                                                          | Required non-destructive actions                                                             | Evidence                                     | Blocker type                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------- |
| R2 / IAM least privilege                  | production-visible inspection account, no keys written into repo/docs                  | `GetBucketLifecycleConfiguration`, policy/ARNs, minio equivalent                             | snapshot + scoped token                      | production authorization            |
| Object lifecycle actual execution         | a controlled staged test object, recurring DeleteMarker schedule, no customer data     | create well-makedan object with exact lifecycle tag; observe at run end plus scheduler queue | scheduled doc + expiry timestamp             | production authorization + runtime  |
| Backup + restore                          | approved backup runner and a separate empty database                                   | run to isolated temp DB, check checksum manifest and restore visibility                      | manifest, sha256 list, restored table counts | authorization                       |
| Alert delivery                            | authorized production channels reachable, test endpoint or approved integration target | send synthetic alert, time until ACK, retry test                                             | FCM/console timestamps and queue state       | authorization                       |
| Production network / tunnel, external URL | approved production account but no token output                                        | head and OPTIONS for targeted downstream services; inspect routing in use                    | response codes only, no secrets              | authorization                       |
| Meta data / build identity                | local CI identity without exposing secrets                                             | verify `/api/health/ready`, registry digest, builder outputs                                 | container identity + digest + Git SHA        | partial (already possible remotely) |

## 6. Suggested execution order

1. Build `aw-multipart-test.bin` local and test multipart in browser through a generic attachment page, capturing every 64 MiB part plus final SHA.
2. Run freeze state browser suite on a truly isolated tenant in a separate pass (with recovery documented in advance).
3. Re-enable or configure Collabora editing on the isolated test app, then perform edit-save-reopen.
4. After isolated passes, run **only** the production-readiness checklist in a controlled change window with authorized accounts.

The six repository gates from AL remain green and should not be re-run now unless their inputs change.

## 7. G2 readiness statement

At this moment G2 still cannot be declared PASS. The required evidence for **production authorization, lifecycle execution, backup restore, alert delivery, multipart browser E2E at 256 MiB, full Collabora editing and freeze-state browser coverage** is outstanding. The code and decision paths are in place; remaining work is external-dependent and authorization-bound.

No commit or push performed. No repository or infrastructure changes made. All work remains in `docs/` report form.
