# AV — Remaining E2E Gaps and Production Evidence Maturity

Date: 2026-10-16. Branch hse-platform (no commit, no push; repo gates remain green from prior phases).

This phase specifically did **not** try to repeat already-passing single-file browser upload (AS) or DB-backed freeze behavior (AL/AT). It records what remains unverified, why it is blocked, and what the minimal safe production-side plan is.

## 1. Prepared execution surface

- Isolated AJ image: `beaconhs:phase-ap-an-20261016`
- Runtime CSP now contains the public presign origin.
- App and worker redeployment was not required again in this turn.
- No tenant was moved from ACTIVE to FROZEN; the shared Phase AJ Test Tenant remained in its normal state.

## 2. Multipart browser test — NOT RUN (resource/surface constrained)

Thresholds from source:

- `MULTIPART_UPLOAD_THRESHOLD_BYTES = 256 MiB`
- `MULTIPART_UPLOAD_PART_SIZE_BYTES = 64 MiB`
- document importer maximum is `100 MB`.

That pairing means **no document upload surface in the current app accepts a 256 MiB upload**, so the real UI path used for the proof cannot legitimately trigger multipart alone. An equipment attachment route could in theory accept larger `other` kinds, but that would require creating more production testing data and managing rollback across tenant-related rows, plus generating and moving 256 MB over a constrained public tunnel.

Therefore marking this category **NOT RUN** is required for truthfulness; the package-level tests in
`packages/storage`/`endpoint-routing.test.ts`/`freeze-gate*` already preserve the same part-signing
contracts, and the browser single-file PUT already proved `sharePoint` host, signature and CSP work. No new live multipart artifacts were created.

## 3. Freeze browser test — NOT RUN

- The task requires writing and rollback against a real tenant.
- The current shared AJ tenant is ACTIVE and is used for ordinary work.
- Freezing it would block tenant writes and could halt other tests or users without a guaranteed
  immediate rollback plan in the browser/test flow.
- DB/API-level evidence remains the authoritative closure for freeze behavior; browser UI evidence
  requires an independently created/isolated test tenant plus a known-safe restore path through the
  admin surface.

## 4. Collabora — NOT RUN

- The available tenant launched a document with `In-browser editing is not configured` and
  the PowerPoint editor did not respond.
- Phase AK already established the WOPI freeze/save contract over HTTP (server 200 → 423 → 200)
  through the exact published callback URL.
- Live Collabora save remains **NOT RUN** and is not marked PASS.

## 5. Production readiness actions (design only; none executed)

### R2 / IAM least privilege

- Authorize production-side inspection of the R2 bucket policy and IAM operator scope (needed roles:
  `HeadBucket`, `CreateMultipartUpload`, `PutObject`, `GetObject`, `HeadObject`, `DeleteObject`,
  `AbortMultipartUpload`, no admin/list wildcard).
- Document the actual policy ARN and verify `R2_PRIVATE_BUCKET_CONFIRMED=true` matches the dev
  check path.

### Object lifecycle

- Authorized console/admin export of the lifecycle rule for `beaconhs-prod` (or current bucket) and
  confirm `PutBucketLifecycleConfiguration` matches `withManagedStorageLifecycleRules`.
- Run the scheduled lifecycle rule in a controlled stale-object window; verify it deletes within the
  expected ttl rather than immediately (no silent full bucket cleanup).

### Backup & restore

- Schedule a production backup runbook drill on a **new database** (not the live one), restoring
  the snapshot then checking table/RLS grant posture.
- Verify `manifest.json` and hashes post-restore.

### Alert delivery & retry ACK

- Authorized production monitoring account / sandbox event sent to web, worker and storage
  monitors with dead-letter depth observation.
- Verify SENT, retested, and ACKed state machine transitions (`recorded`, `replayed`, `dropped`).

### Production network / tunnel, external URL

- reconfirm via `curl -I https://…` on a private staging hostname; ensure no build-time domain
  drift remains; verify public router path correctly forwards WOPI callbacks.

### Metadata/version check

- Fix build `DEPLOYMENT_VERSION` to a complete 40-char Git SHA instead of a deployment-composed
  short SHA where possible; report `51a899b7...` carries app identity but production also needs the
  exact registry digest for future diffs.

## 6. Minimal recommended sequence

1. Build a separate test tenant/attachment fixture plus test-only asset capacity (without affecting
   the AJ shared tenant) to execute multipart 256 MiB + expired-part reissue + replay without
   host pressure.
2. Add a guarded temporary freeze state toggle under an isolated test tenant to script the tenanted
   browser refusal flow and restore automatically.
3. Configure Collabora correctly on a dedicated target before repeating the editor save round-trip.
4. Run production evidence dry runs (serialized, authorized) for R2/IAM, lifecycle, backup/restore
   and alerts on a separate host family without changing prod data.

## 7. Matrix after Phase AT/AV

- Freeze reliability: **PASS** (DB web gates + local; 16/36 run).
- Single-file public upload SHA-256: **PASS** (isolated browser proof).
- Multipart browser SHA-256: **NOT RUN** (threshold and documented surface too small).
- Browser gate during freeze: **NOT RUN** (no isolated tenant).
- Collabora full editing session: **NOT RUN** (service missing).
- Production infra (IAM/R2, lifecycle, restore, alert): **NOT RUN / UNKNOWN**.

## 8. Final statement

No additional source code changes were needed; the remaining gaps are environmental or
authorization-bound. Keep all claims in the reports aligned with actual execution evidence.

No commit or push performed. No destructive commands used. Worktree preserved as-is.
