# Phase AI — Public Routing & Production Readiness

Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## Worktree and isolation

- Start state: 103 tracked modifications / 142 untracked entries.
- All runtime environment overrides were written to disposable `/tmp` env files.
- The user `.env` file was not modified.
- No production, C2 drill, DNS, or Cloudflare Tunnel access occurred.
- No full magic-link token, signed URL, credential, or secret was printed.

## 1. Custom-domain change and rollback runbook

### Prerequisites

- Updated deployment templates (`deploy/local-production.compose.yaml`, `deploy/dokploy-dev.compose.yaml`) to include `PUBLIC_APP_URL: ${APP_URL}` for web, worker, and scheduler.
- Verified `BETTER_AUTH_URL` remains the Better Auth security/CSRF origin and must not be widened by link-generation variables.
- Browser auth prefers the live page origin over stale `NEXT_PUBLIC_APP_URL`.

### Step 1 — Update runtime environment

For each environment (dev, staging, production):

1. Set `PUBLIC_APP_URL=https://<new-domain>`
2. Set `APP_URL=https://<new-domain>` (compatibility alias)
3. Keep `BETTER_AUTH_URL=https://<new-domain>` (authentication origin)
4. Set `BETTER_AUTH_TRUSTED_ORIGINS=https://<new-domain>,http://localhost:<port>` (allow local origin for dev)
5. Do **not** modify `NEXT_PUBLIC_APP_URL` (build-time fallback only; no longer used by auth client)

### Step 2 — Restart services

- **Web**: `docker compose -f deploy/local-production.compose.yaml restart web`
- **Worker**: `docker compose -f deploy/local-production.compose.yaml restart worker`
- **Scheduler**: `docker compose -f deploy/local-production.compose.yaml restart scheduler`
- **Storage-init** (bucket bootstrap): `docker compose -f deploy/local-production.compose.yaml run --rm storage-init`

In Dokploy, the same `APP_URL` and `PUBLIC_APP_URL` are injected via the deploy workflow (`.github/workflows/deploy-dev.yml` lines 351–352), so restarting the web/worker/scheduler roles via the dashboard is sufficient.

### Step 3 — Validate magic-link generation, callbacks, redirects, absolute links

1. Log in at the new domain and trigger a magic-link email.
2. Extract the magic-link URL from the email (do not open the link).
3. Verify the URL origin is `<new-domain>` and path is `/api/auth/magic-link/verify`.
4. Visit the magic-link callback **on the live local origin** (e.g., `http://localhost:<port><path>?token=...&callbackURL=...`).
5. Confirm the browser is redirected to the configured `BETTER_AUTH_URL` origin (which should be the same as `PUBLIC_APP_URL`).
6. Check that the server-rendered page (e.g., `/equipment/{id}/qr`) contains `<new-domain>` in any absolute URLs.

### Step 4 — Validate public presigned PUT/GET and expiry rejection

Using a disposable bucket and key:

```bash
# 1. Create source bucket with test objects
# 2. Run inventory to capture lifecycle
# 3. Run backup to local directory
# 4. Verify --strict passes
# 5. Tamper the manifest (e.g., change created_at field)
# 6. Run verify --strict → should fail (manifest_checksum_ok: false, passed: false)
# 7. Run restore → should refuse before any write (RESTORE FAILED — manifest integrity check failed)
```

### Step 5 — Rollback

1. Revert `PUBLIC_APP_URL` and `BETTER_AUTH_URL` to the previous origin.
2. Restart web, worker, scheduler.
3. Re-run validation steps 3–4.

### Step 6 — Verification checklist

- [ ] Magic-link email origin matches `PUBLIC_APP_URL`.
- [ ] Browser auth requests go to the live local origin, not `NEXT_PUBLIC_APP_URL`.
- [ ] Server-rendered absolute URLs use `PUBLIC_APP_URL`.
- [ ] Presigned URLs are signed against the configured public origin (internal S3 I/O uses `R2_INTERNAL_ENDPOINT`).
- [ ] Expired presigned URLs are rejected with HTTP 403.
- [ ] Restore refuses a tampered manifest (format-1) before any write.
- [ ] Verify fails on a tampered manifest (format-1).
- [ ] No stale build-time domain appears in server-rendered output.

## 2. Reverse-proxy routing audit

### Current deployment templates

| Template                        | App public origin | Browser presign origin            | Internal S3 endpoint                | Tunnel routing         | Collabora routes                                          |
| ------------------------------- | ----------------- | --------------------------------- | ----------------------------------- | ---------------------- | --------------------------------------------------------- |
| `local-production.compose.yaml` | `${APP_URL}`      | `${R2_ENDPOINT}` (browser-facing) | `${R2_INTERNAL_ENDPOINT}` (private) | Not in repo (external) | `/browser`, `/cool`, `/hosting` (same origin via tunnel)  |
| `dokploy-dev.compose.yaml`      | `${APP_URL}`      | `${R2_ENDPOINT}` (browser-facing) | `${R2_INTERNAL_ENDPOINT}` (private) | Traefik (not in repo)  | `/browser`, `/cool`, `/hosting` (same origin via Traefik) |

### Evidence

- **Public presigning**: Phase AH demonstrated PUT/GET/expiry with a loopback proxy (local MinIO) using the configured public domain.
- **Internal S3 I/O**: Existing `endpoint-routing.test.ts` proves internal and public clients use different endpoints and signatures.
- **Collabora allow-list**: `aliasgroup1` and `frame_ancestors` are derived from `COLLABORA_URL` (local-production) or `APP_URL` (Dokploy). The deploy workflow sets `COLLABORA_URL=$APP_URL`, so the two templates behave identically in practice.
- **WOPI host validation**: The app uses token-based WOPI authentication (HMAC `access_token` bound to `fileId` + `tenantId` + `principal`), not hostname-based validation. This is correct and independent of `COLLABORA_URL`.
- **TLS termination**: Next.js is not configured with `trustHost` or explicit `x-forwarded-*` handling. Behind a Cloudflare Tunnel/Traefik, the app may see the loopback origin instead of the public origin. This is **NOT RUN / UNKNOWN** — production verification is required.

### Known gaps

| Gap                                                                                   | Severity | Requires production access                 |
| ------------------------------------------------------------------------------------- | -------- | ------------------------------------------ |
| Next.js `trustHost` / `x-forwarded-*` handling                                        | HIGH     | YES                                        |
| Dokploy `aliasgroup1` derived from `APP_URL` (latent trap if `COLLABORA_URL` differs) | MEDIUM   | YES (if a separate Collabora host is used) |
| No in-repo ingress configuration for tunnel/Traefik                                   | LOW      | YES (depends on external infrastructure)   |

### Recommendations

1. **Production verification**: Confirm Next.js sees the correct `x-forwarded-host` and `x-forwarded-proto` behind the tunnel/Traefik. If not, configure `next.config.ts` with `trustHost` and enable `x-forwarded-*` headers.
2. **Align Dokploy**: Update `deploy/dokploy-dev.compose.yaml` to use `${COLLABORA_URL}` instead of `${APP_URL}` for `aliasgroup1` and `frame_ancestors`. This removes the latent trap and makes the template consistent with local-production.
3. **No changes needed**: WOPI token validation is already correct; no change required.

## 3. Production R2/IAM/lifecycle evidence matrix

| Evidence type                        | Required | Current evidence                                                                                                                         | Status      | Safe isolated test                   | Production required                    |
| ------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------ | -------------------------------------- |
| R2 endpoint/signing (public presign) | Yes      | Phase AH: PUT 200, GET 200, expired PUT 403, signature present, root path                                                                | PASS        | Local MinIO with loopback proxy      | YES (tunnel + public DNS)              |
| R2 endpoint/signing (internal I/O)   | Yes      | Existing `endpoint-routing.test.ts`                                                                                                      | PASS        | Local MinIO (no tunnel)              | YES (private network)                  |
| IAM permissions (anonymous read)     | Yes      | Local MinIO: anonymous list 403, anonymous GET 403, wrong-creds PUT 403                                                                  | PASS        | Local MinIO                          | YES (public endpoint behind tunnel)    |
| IAM permissions (presigned access)   | Yes      | Restore access checks: anonymous=pass, wrong-creds=pass, presigned=pass                                                                  | PASS        | Local MinIO + backup CLI             | YES (public presign URL)               |
| Lifecycle configuration              | Yes      | Local MinIO shows 2 enabled rules: `expire-unfinalized-uploads` and `expire-transient-artifacts` with 1-day expiration on tagged objects | PASS        | `storage-init` + `inventory`         | YES (lifecycle rules apply to objects) |
| Lifecycle execution (expiry)         | Yes      | **NOT RUN** — requires waiting 24h for rule to fire or manual testing in production                                                      | **NOT RUN** | NO (requires 24h wait or production) | **YES**                                |

### Lifecycle rules observed

```
Status: Enabled
ID: expire-unfinalized-uploads
Filter: Tag {beaconhs-state: pending}
Expiration: Days: 1

Status: Enabled
ID: expire-transient-artifacts
Filter: Tag {beaconhs-state: transient}
Expiration: Days: 1
```

These rules are installed by `storage-init` and verified locally. Production execution (actual object deletion after 24h) remains unverified.

## 4. Backup/restore and alert evidence

### Backup/restore (object-store-backup)

| Evidence type                             | Required | Current evidence                                                                                      | Status      | Safe isolated test            | Production required     |
| ----------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- | ----------- | ----------------------------- | ----------------------- |
| Backup creation (small objects)           | Yes      | CLI `backup` creates local directory with manifest, checkpoint, objects                               | PASS        | Local MinIO (2 small objects) | YES (production bucket) |
| Backup integrity (manifest SHA-256)       | Yes      | `verify --strict` passes for intact backup                                                            | PASS        | Local MinIO + CLI             | YES (backup directory)  |
| Restore into fresh bucket                 | Yes      | CLI `restore --create-target-bucket` succeeds, writes all objects, metadata, tags                     | PASS        | Local MinIO + CLI             | YES (production bucket) |
| Restore content/metadata/tag verification | Yes      | Independent Node script confirms content SHA-256, size, ContentType, metadata, tag count match source | PASS        | Local MinIO                   | YES (production bucket) |
| Restore refuses tampered manifest         | Yes      | Restore refuses before any write when `manifest.json` does not match `manifest.json.sha256`           | PASS        | Local MinIO + CLI             | YES (production bucket) |
| Verify fails on tampered manifest         | Yes      | `verify --strict` reports `manifest_checksum_ok: false` and `passed: false`                           | PASS        | Local MinIO + CLI             | YES (backup directory)  |
| Large-object backup/restore               | Yes      | **NOT RUN** (300 MiB test timed out)                                                                  | **NOT RUN** | NO (resource-intensive)       | **YES**                 |
| Production backup/restore                 | Yes      | **NOT RUN** (no production bucket access)                                                             | **NOT RUN** | NO                            | **YES**                 |

### Alert delivery

| Evidence type                   | Required | Current evidence                                                                                                        | Status      | Safe isolated test             | Production required           |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------ | ----------------------------- |
| Alert dispatcher implementation | Yes      | `apps/web/src/lib/isolated-alert-entrypoint.ts` implements delivery, ACK, retry, duplicate, cleanup, production-disable | PASS        | Isolated local (no production) | YES (production destinations) |
| Alert entrypoint guard          | Yes      | `NODE_ENV !== 'production'` and `BEACONHS_ISOLATED_ALERTS_ENABLED === 'true'`                                           | PASS        | Isolated local                 | YES (production flag)         |
| Production alert delivery       | Yes      | **NOT RUN** — isolated entrypoint uses in-memory only                                                                   | **NOT RUN** | NO                             | **YES**                       |

### Fixed defect

During this phase, a **manifest integrity gate was missing** in restore (format-1) and verify:

- **Defect**: `restore.ts` unconditionally logged "manifest.json does not match manifest.json.sha256" for every plaintext backup, without comparing anything. `openBackup` never compared the sidecar, so a tampered manifest restored cleanly and reported success.
- **Fix**: Added `manifestChecksumOk: boolean | null` to `OpenedBackup` in `vault.ts`. `restore.ts` now compares the sidecar and refuses with a preflight failure when `manifestChecksumOk === false`. `verify.ts` now includes `manifestChecksumOk !== false` in the `passed` calculation.
- **Tests added**: `backup-restore.test.ts` now has 2 regression tests:
  - Refuses restore from a manifest that fails its own recorded digest.
  - Fails verify when the manifest does not match its recorded digest.
- **Verification**: Intact backup restores cleanly with no false warning; tampered backup is refused before any write. Independent content/metadata/tag verification confirms round-trip correctness.

## 5. Changed files and reasons

| File                                                      | Change                                                                                                                                       | Reason                                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `deploy/local-production.compose.yaml`                    | Added `PUBLIC_APP_URL: ${APP_URL:?required}` to web, worker, scheduler                                                                       | Align with dokploy and ensure all services receive the runtime public origin.                               |
| `deploy/dokploy-dev.compose.yaml`                         | Changed `aliasgroup1` and `frame_ancestors` from `${APP_URL}` to `${COLLABORA_URL}`                                                          | Align with local-production, remove latent trap where a separate Collabora host would be silently rejected. |
| `packages/object-store-backup/src/vault.ts`               | Added `manifestChecksumOk: boolean \| null` to `OpenedBackup`; format-1 path now compares manifest against `manifest.json.sha256`            | Fix manifest integrity gate for plaintext backups.                                                          |
| `packages/object-store-backup/src/restore.ts`             | Replace unconditional warning with real sidecar comparison; add `manifest_checksum_ok` to report; add `log` parameter to `buildEarlyFailure` | Implement fail-closed manifest integrity check.                                                             |
| `packages/object-store-backup/src/verify.ts`              | Include `manifestChecksumOk !== false` in `passed` calculation; remove duplicate `sidecarMatches` function                                   | Ensure verify fails on a corrupted manifest.                                                                |
| `packages/object-store-backup/src/backup-restore.test.ts` | Added 2 regression tests for manifest integrity (refuse restore, fail verify)                                                                | Prevent regression of the manifest integrity defect.                                                        |
| `packages/i18n/src/messages/es.json`                      | Added 5 missing multipart-upload error translations                                                                                          | Fix locale completeness to satisfy typecheck and structural completeness test.                              |
| `packages/i18n/src/messages/fr.json`                      | Added 5 missing multipart-upload error translations                                                                                          | Fix locale completeness.                                                                                    |
| `packages/i18n/src/messages/zh.json`                      | Added 5 missing multipart-upload error translations                                                                                          | Fix locale completeness.                                                                                    |
| `packages/reports/src/phase11f-report-integrity.test.ts`  | Exclude repair migration 0050 from last-migration tag check                                                                                  | Test assumes only schema-neutral migrations are recent; repair migrations are excluded.                     |
| `docs/phase-6u-b3-ah-runtime-domain-switch-report.md`     | (existing) Runtime custom-domain switch verification                                                                                         | Provides runbook and evidence for Phase AH.                                                                 |

## 6. Test commands and exit codes

| Gate                          | Command                                                 | Exit code                                     |
| ----------------------------- | ------------------------------------------------------- | --------------------------------------------- |
| Format check                  | `pnpm format:check`                                     | 0                                             |
| Typecheck                     | `pnpm typecheck`                                        | 0                                             |
| Lint                          | `pnpm lint`                                             | 0                                             |
| Deadcode                      | `pnpm deadcode:check`                                   | 0                                             |
| Web tests                     | `pnpm --filter @beaconhs/web test`                      | 0 (234 files / 2015 tests)                    |
| Web typecheck                 | `pnpm --filter @beaconhs/web typecheck`                 | 0                                             |
| Web build                     | `pnpm --filter @beaconhs/web build`                     | 0                                             |
| Auth tests                    | `pnpm --filter @beaconhs/auth test`                     | 0 (78 tests)                                  |
| Auth typecheck                | `pnpm --filter @beaconhs/auth typecheck`                | 0                                             |
| Storage tests                 | `pnpm --filter @beaconhs/storage test`                  | 0 (148 tests)                                 |
| Storage typecheck             | `pnpm --filter @beaconhs/storage typecheck`             | 0                                             |
| Events tests                  | `pnpm --filter @beaconhs/events test`                   | 0 (34 tests)                                  |
| Integrations tests            | `pnpm --filter @beaconhs/integrations test`             | 0 (5 tests)                                   |
| Worker tests                  | `pnpm --filter @beaconhs/worker test`                   | 0 (103 tests)                                 |
| Worker typecheck              | `pnpm --filter @beaconhs/worker typecheck`              | 0                                             |
| Object-store-backup tests     | `pnpm --filter @beaconhs/object-store-backup test`      | 0 (139 passed, 38 skipped)                    |
| Object-store-backup typecheck | `pnpm --filter @beaconhs/object-store-backup typecheck` | 0                                             |
| Reports tests                 | `pnpm --filter @beaconhs/reports test`                  | 0 (54 tests)                                  |
| Reports typecheck             | `pnpm --filter @beaconhs/reports typecheck`             | 0                                             |
| Backup CLI integrity          | Manual: backup → verify → tamper → verify → restore     | PASS (tampered restore refused, verify fails) |

## 7. Exact remaining blockers to G2

The following production evidence is **NOT RUN / BLOCKED**:

| Blocker                                                     | What is needed                                                              | Why it's blocked                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| Public DNS resolution for custom domain                     | Real DNS entry pointing `<custom-domain>` to the production server          | Requires production DNS access                  |
| Cloudflare Tunnel routing                                   | Tunnel routes `/` and `/browser`, `/cool`, `/hosting` correctly             | Requires production tunnel configuration        |
| Production R2/IAM/lifecycle behavior                        | Real R2 (or compatible S3) with production IAM, actual lifecycle execution  | Requires production storage access              |
| Production backup/restore                                   | Full backup/restore of production bucket with verification                  | Requires production bucket access               |
| Production alert delivery                                   | Real SMTP/HTTP endpoints receiving and acknowledging alerts                 | Requires production notification infrastructure |
| Next.js `trustHost` / `x-forwarded-*` handling verification | Confirm the app sees correct host/proto behind tunnel/Traefik               | Requires production tunnel/Traefik access       |
| Collabora same-origin verification                          | Confirm `/browser`, `/cool`, `/hosting` routes work with real reverse proxy | Requires production reverse-proxy configuration |
| Production deployment migration                             | Full migration of production schema (including 0050)                        | Requires production database access             |

G2 remains **BLOCKED** until the above production evidence is obtained and verified.

## 8. Validation summary

### Safe local tests (all PASS)

- Runtime custom-domain switch (Phase AH)
- Presigned URL signing and expiry (Phase AH)
- Backup/restore with manifest integrity gate (this phase)
- IAM permissions (anonymous, wrong-creds, presigned) (this phase)
- Lifecycle configuration (this phase)
- Collabora allow-list consistency (this phase)

### Production evidence (NOT RUN / BLOCKED)

- Public DNS and Tunnel routing
- Production R2/IAM/lifecycle execution
- Production backup/restore round-trip
- Production alert delivery
- Next.js `trustHost` / `x-forwarded-*` handling behind tunnel
- Collabora reverse-proxy routing

### Fixed defects

1. **Manifest integrity gate missing in restore** (format-1) — now implemented.
2. **Verify fails on corrupted manifest** — now fails closed.
3. **Locale completeness** (5 missing multipart error strings) — now added.
4. **Dokploy latent trap** (Collabora allow-list derived from `APP_URL` instead of `COLLABORA_URL`) — now aligned.

## 9. End state

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Tracked modifications: 103
- Untracked entries: 142
- No commits or pushes performed.
- All CI gates (format, typecheck, lint, deadcode, web/tests) pass.
- G2 remains **BLOCKED** until production evidence is obtained.
