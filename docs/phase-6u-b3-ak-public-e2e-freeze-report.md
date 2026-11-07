# Phase 6U-B3-AK — Public HTTPS E2E and Storage-Freeze Recovery (Test Deployment)

**Date:** 2026-10-16
**Environment:** isolated test deployment `https://beaconhs-test.xuhaoqing.top`
(AJ stack on the drill host) — **no production data, DNS, tunnel, or shared
storage credentials were touched.**
**Branch:** `hse-platform`, HEAD `51a899b7aac0a942da327222a3eed355fca9798a`
(no commits, push, or destructive git operations).

This phase verified, against the running deployment:

1. the public HTTPS browser journey (magic-link login, session persistence,
   refresh, logout) with host/callback discipline;
2. the full storage-freeze state machine and recovery in a throwaway tenant,
   including write refusals, drain verification, write-arm reconciliation,
   object integrity, and post-recovery writes;
3. web-process freeze enforcement over the WOPI HTTP path (the endpoint
   Collabora calls when it saves);
4. credential and network isolation between the test deployment and the
   existing Drill storage;
5. cleanup to zero residual test state, and the full local gate set.

No secret, token, or signed URL is printed in this report — only hash
prefixes, statuses, and state names.

---

## 1. Deployment under test

- Web/worker/scheduler/storage-init were upgraded (before this phase's runtime
  tests) from `beaconhs:drill-20261009` (no freeze code) to
  `beaconhs:phase-o-6u-b3-o`,
  sha256 `22e505495882825eef564dbbf7c2c92d2725a810de1a519dcff83cee81dac501`.
  All other services were left untouched. Compose backup:
  `phase-aj-compose-final.yaml.ak-backup` (enables revert).
- `/api/health/ready` (via the AJ gateway) reports app version
  `51a899b7aac0a942da327222a3eed355fca9798a`.
- The AJ database is 50 migrations and a superset of the image-era schema
  (extra columns only); runtime-compatible.
- Public topology: Cloudflare → `cloudflared` (PID 1105) → AJ gateway on
  `127.0.0.1:3012` + bridge `172.18.0.1:3012` → AJ web `3010`. The gateway
  routes `/beaconhs-phase-aj/*` to the AJ MinIO, Collabora paths to the AJ
  Collabora, everything else to the web app, and preserves `Host`
  byte-for-byte (so SigV4 signatures remain valid through it).
- The production tunnel, the gateway process, Drill containers, Drill MinIO,
  and all shared credentials were **not modified**.
- The phase-o web build contains the freeze gate (`hasStorageFreezeReader`
  in 1 server chunk, `STORAGE_FROZEN` in 4); the runtime evidence below is
  the authoritative proof — the earlier chunk-count observation was resolved
  as marker-dependent and is not a discrepancy that affects behavior.

## 2. Public browser E2E (auth journey) — PASS

Executed in a real browser against `https://beaconhs-test.xuhaoqing.top`:

| Step                                | Result                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Magic-link login (Mailpit over SSH) | PASS — from `/login` to `/dashboard`; link opened via the Mailpit UI on a forwarded loopback port                                                               |
| Link host + callback discipline     | PASS — link is `https://beaconhs-test.xuhaoqing.top/api/auth/magic-link/verify?…&callbackURL=%2Fauth%2Fcontinue` (relative callback; always the test domain)    |
| Session cookies                     | PASS — `__Secure-better-auth.session_token` and `…session_data`: domain `beaconhs-test.xuhaoqing.top`, `Secure`, `HttpOnly`, `SameSite=Lax`, non-session expiry |
| Refresh persists session            | PASS                                                                                                                                                            |
| Logout                              | PASS — Sign out lands on `/login`, auth cookies cleared; a later `/dashboard` visit redirects to `/login`                                                       |
| Network discipline                  | PASS — requests only to the test domain plus `static.cloudflareinsights.com`                                                                                    |

Browser-based upload during a freeze and the Collabora editor session could not
be exercised in the browser after the Playwright MCP server process crashed
mid-session (see §7). The freeze write-refusal half of both flows was instead
verified over HTTP on the deployment's own WOPI route (§4), which is the exact
server endpoint the editor and the uploader rely on for writes.

## 3. Storage freeze full cycle in a throwaway tenant — PASS

**Method.** The repo ships no UI/API trigger for freeze transitions, so the
state machine was driven through the deployment's own DB-layer primitives
(`ensureFreezeRow`, `applyTransition`) from inside the running worker
container, and **enforcement** was then verified through the real production
paths (the storage module's gated operations and real HTTP against MinIO via
the gateway bridge). Test tenant `f633f529-…` (slug `ak-freeze-…`) was created
by the harness; it was deleted at the end (§6).

### 3.1 Baseline writes and arms

| Probe                                                  | Result                                                                                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presignPut` URL shape                                 | `X-Amz-SignedHeaders=host`; hoisted query keys include `X-Amz-Algorithm`, `X-Amz-Date`, `X-Amz-Expires`, `x-amz-meta-upload-token`, `x-amz-tagging`, `x-amz-checksum-crc32`, `x-amz-sdk-checksum-algorithm` |
| PUT with browser-identical headers (Content-Type only) | **HTTP 200**; object present, `metaKeys=[upload-token]`, token hash **matches** the reserved token                                                                                                          |
| PUT with an explicit `x-amz-meta-upload-token` header  | HTTP 400 `AccessDenied` "headers present not signed" — harness artifact only; real clients do not send this header, the SDK hoists it into the URL                                                          |
| Direct `putObject` + presigned GET                     | 200; read-back SHA-256 matches (53/53 bytes)                                                                                                                                                                |

This resolves the earlier suspicion that browser uploads could not attach the
`upload-token` metadata: the AWS SDK presigner hoists `Metadata`/`Tagging`
into query parameters, MinIO applies them to the object, and finalization
validation passes. **No upload defect confirmed.**

### 3.2 Freeze transitions and refusals

| Transition / probe                           | Result                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Register a slow in-flight write while ACTIVE | Registered (`in_flight_writes`)                                                                                                            |
| `ACTIVE → FREEZE_REQUESTED`                  | v1, lease `ak-phase-ak-probe`; gated ops refused with `STORAGE_FROZEN`: `presignPut`, `putObject`, `deleteObject`, `createMultipartUpload` |
| Drain status                                 | `ready=false inFlight=1 unresolvedArms=0` (open write blocks the drain)                                                                    |
| `FREEZE_REQUESTED → DRAINING`                | v2                                                                                                                                         |
| Premature `DRAINING → FROZEN`                | Refused `FREEZE_DRAIN_UNVERIFIED` (requesting a freeze is not being frozen)                                                                |
| Close in-flight write                        | Drain `ready=true inFlight=0 unresolvedArms=0`                                                                                             |
| `DRAINING → FROZEN`                          | **Succeeded** v3, drain evidence persisted (`verifiedAt 2026-10-16T02:21:14.253Z`, `inFlightCount 0`, `unresolvedArmCount 0`)              |
| Writes while FROZEN                          | `presignPut`, `putObject` refused `STORAGE_FROZEN`                                                                                         |
| Reads while FROZEN                           | Presigned GET 200, SHA-256 match preserved                                                                                                 |
| `FROZEN → RECONCILING`                       | v4; writes still refused                                                                                                                   |
| Release with real manifest                   | Manifest snapshotted from actual objects; manifest SHA prefix `ebd67cd8877d`; `→ ACTIVE` v5, lease released, migration id cleared          |
| Post-recovery write                          | New `presignPut` + PUT 200; read-back integrity verified                                                                                   |

Write-arm reconciliation ran through the **scheduled tick inside the live
worker** (not a manual call): arms settled to `redeemed_confirmed` (object
present, token match) or `redeemed_nop` (object absent). The freeze audit
chain is complete and in order:
`active_to_freeze_requested → freeze_requested_to_draining → draining_to_frozen
→ frozen_to_reconciling → reconciling_to_active`.

## 4. Web-process gate via the WOPI HTTP path — PASS

The uploader's server action is not reachable without a browser, so the
web process's own gate was exercised through `/wopi/files/[fileId]/contents`
(the endpoint Collabora calls to save), via HTTP through the AJ gateway,
using a fixture document created in `phase-aj-test`. A token was minted inside
the web container with the deployment's own secret (never printed; file
removed afterwards).

| Step (HTTP, web process)                                    | Result                                                                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save while tenant ACTIVE                                    | **200** `{"LastModifiedTime":"2026-10-16T02:33:14.873Z"}`; attachment key rotated; document `updated_at` bumped; audit `Saved "ak-wopi.docx" in the editor` |
| Freeze requested (`FREEZE_REQUESTED` v1)                    | —                                                                                                                                                           |
| Save while frozen                                           | **423 "Workspace unavailable"** — the web process's own `putObject` refused via `STORAGE_FROZEN`; attachment key unchanged; no object created               |
| Read (`GET`) while frozen                                   | **200**, 31 bytes — reads stay available                                                                                                                    |
| Release (`→ ACTIVE` v2, manifest SHA prefix `49f54b24be7a`) | —                                                                                                                                                           |
| Save after recovery                                         | **200** `{"LastModifiedTime":"2026-10-16T02:35:22.340Z"}`                                                                                                   |

The 423 (rather than a 500 "gate not registered") is itself proof that the web
process registered the freeze gate and reads the freeze state from the
database. `phase-aj-test` was left in its intended steady state: **ACTIVE v2**
with the two freeze audit rows from this verification.

## 5. Credential and network isolation (AJ vs Drill storage) — PASS

Fingerprints only; no secret values were printed or changed.

| Pair                             | Fingerprint (SHA-256 prefix)                                   |
| -------------------------------- | -------------------------------------------------------------- |
| AJ app access key (web + worker) | `bbaa6b5854`                                                   |
| AJ app secret                    | `9efb3e837b`                                                   |
| Drill MinIO root user            | `bbaa6b5854` (same access-key **string**, different secret)    |
| Drill MinIO root password        | `b097eb1ff2`                                                   |
| AJ MinIO root user / password    | `36a9e7f1c9` / `36a9e7f1c9` (identical strings — see findings) |

Signature probe (SigV4, from the drill host):

| Case                                      | Result                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| AJ app creds → Drill MinIO `:9000`        | **403 `SignatureDoesNotMatch`** (ListBuckets; `beaconhs-drill` listing) — cannot access Drill storage |
| Drill root creds → Drill MinIO (control)  | 200 / 200                                                                                             |
| AJ app creds → AJ MinIO `:3011` (control) | 200 (ListBuckets; both AJ-instance buckets)                                                           |
| Drill root creds → AJ MinIO (control)     | **403 `SignatureDoesNotMatch`**                                                                       |

Network probes from inside the AJ worker container:

| Target                             | Result               |
| ---------------------------------- | -------------------- |
| `172.18.0.1:9000` (Drill MinIO)    | `ECONNREFUSED`       |
| `172.18.0.1:5432` (Drill Postgres) | `ECONNREFUSED`       |
| `172.18.0.1:3001` (Drill web)      | `ECONNREFUSED`       |
| `172.18.0.1:3012` (AJ gateway)     | connected (intended) |

Both MinIO instances bind loopback-only, live on separate Docker networks, and
hold disjoint secrets, so cross-deployment storage access is blocked at the
network **and** credential layer. One note: the AJ MinIO contains an **empty**
stray bucket named `beaconhs-drill` (likely a provisioning artifact; no
objects); it is not Drill data and was left as found.

## 6. Cleanup and residual verification — PASS

This round's data only; pre-existing phase-AJ artifacts were left untouched.

- Throwaway freeze tenant `f633f529-…`: all objects deleted; all rows
  (`storage_freeze`, `storage_write_arms`, `in_flight_writes`,
  `attachment_upload_reservations`, freeze audit, tenant) deleted;
  final counts all **0**.
- `phase-aj-test` test data: fixture document + attachment + the person
  created for the upload attempt + their 3 audit rows deleted; the WOPI
  object deleted (`deleted=true`; the tenant directory is gone); residual
  tracker rows cleared (`arms 0 / in-flight 4→0 / reservations 0`); final
  counts **0 / 0 / 0**; people/documents/attachments totals back to 0.
- MinIO bucket walk: under `t/` only the pre-existing phase-AJ object
  `t/519ad6d0-…/aj-test.pdf` remains (not this round's data). No
  `.minio.sys` tmp/multipart state exists → no pending multipart uploads.
- Temp artifacts removed: the harness script and state files from the worker
  container and the drill host `/tmp`, the WOPI token file and mint script
  from the web container.
- Kept intentionally: `phase-aj-test` ACTIVE freeze row + its two freeze
  audit rows; the compose backup file for revert.

## 7. Browser tooling incident (recorded, not a product defect)

The Playwright MCP server process exited with code 1 while running a scripted
upload-attempt with custom request listeners. The browser context was lost and
the MCP tools did not return for the remainder of the session. The crashed
attempt had **no server-side effect** (reservations/arms/in-flight were all
zero immediately afterwards; no requests reached the app). All remaining
verification that would have used the browser was either completed by other
means (§4) or is marked NOT RUN below. No production or shared resource was
involved.

## 8. Collabora independence and document tests

- **Independence: PASS.** AJ and Drill Collabora are separate containers on
  separate Docker networks, with no mounted volumes and no shared state
  (same local image only). AJ Collabora discovery answers **HTTP 200** through
  the AJ gateway with gateway-based URLs.
- **Full editor session (open/edit/save/reread) and freeze rejection inside a
  real editing session: NOT RUN.** With no browser tooling available after the
  MCP crash and no prepared editor fixture, a genuine Collabora session could
  not be driven. The write-side endpoint it uses was verified over HTTP in
  three freeze states (§4), but a real collaboration session remains
  unverified on this deployment.

## 9. Local gates (real exit codes)

| Gate                              | Result                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm format:check`               | **0** — final run, covering this report and the test change                                          |
| `pnpm typecheck`                  | **0** — final re-run after the test change, 27/27 tasks                                              |
| `pnpm lint`                       | **0** — final re-run after the test change                                                           |
| `pnpm test` (first run)           | **1** — `@beaconhs/db` `migrate-exit-code.test.ts` exceeded vitest's 5 s default under parallel load |
| `pnpm --filter @beaconhs/db test` | **0** (501 passed) after fixing the test's timeout budget (see findings)                             |
| `pnpm test` (re-run)              | **0** — 25/25 tasks                                                                                  |
| `pnpm deadcode:check`             | **0**                                                                                                |
| `pnpm build`                      | **0** — 4/4 tasks, 2 m 34 s                                                                          |

## 10. Defects and findings

1. **FIXED — test timeout budget too small for its own subprocess.**
   `packages/db/src/migrate-exit-code.test.ts` boots the real migrate CLI via
   `spawnSync` (30 s inner timeout) but ran under vitest's 5 s default, so it
   timed out under load and turned the test gate red. Added a suite-level
   `{ timeout: 20_000 }` budget with a comment. Verified: isolated package run
   and the full suite are green.
2. **REPORTED — tenants created by `provisionTenant` never get a freeze row
   and are permanently fail-closed for storage writes.**
   `packages/db/src/tenant-provisioning.ts:491` inserts the tenant but never
   calls `ensureActiveStorageFreeze`, while `packages/db/src/seed.ts`
   (lines 158/188) does. The gate refuses every gated write with
   `STORAGE_FREEZE_STATE_UNKNOWN` when no row exists, and nothing else can
   create the row (the arm issuer's `ensureFreezeRow` sits behind the gate),
   so an upload on such a tenant can never succeed. Observed live:
   `phase-aj-test` had no row and was fail-closed until this phase created it
   (now ACTIVE v2). Not fixed here: the fix belongs in provisioning, needs
   DB-backed coverage (`SEED_TEST_SCRATCH_DATABASE_URL` is unset in this
   environment, so provisioning DB scenarios already skip), and it changes
   the workspace-creation path used by bootstrap automation.
3. **Low-severity hygiene — AJ test-instance storage credentials.**
   The AJ MinIO root user and root password are the same string (hash
   prefixes both `36a9e7f1c9`), and the AJ app key can list every bucket in
   its own instance (including the stray empty `beaconhs-drill` bucket). Its
   access-key **name** equals the Drill MinIO root user name, but the secrets
   differ, so no cross-access exists (403 signatures both directions).
   No shared credential was changed.
4. **Availability risk — the AJ gateway has no restart or boot recovery.**
   No PID file, cron, or systemd unit; compose `restart: "no"`. If the
   gateway stops, the public test URL stops serving until manually restarted.
5. **Topology note — presigned URLs on AJ are loopback-only**
   (`http://127.0.0.1:3012/…`). A public browser cannot consume them; they
   are valid only from the host (or from a container over the bridge with a
   preserved `Host` header). This is consistent with the isolated test
   topology but means browser uploads cannot complete from outside the host.

## 11. Status matrix

| Item                                                     | Status  |
| -------------------------------------------------------- | ------- |
| Public magic-link login / session / refresh / logout E2E | PASS    |
| Auth callback and host discipline                        | PASS    |
| Freeze state machine, drain verification, reconciler     | PASS    |
| Freeze write refusals (storage layer, all 4 gated ops)   | PASS    |
| Reads during freeze / object integrity                   | PASS    |
| Post-recovery writes                                     | PASS    |
| Web-process gate enforcement (WOPI save 423 / 200)       | PASS    |
| AJ credentials vs Drill MinIO                            | PASS    |
| Network isolation AJ → Drill services                    | PASS    |
| Collabora container independence                         | PASS    |
| Collabora full editing session incl. freeze rejection    | NOT RUN |
| Browser UI upload during freeze                          | NOT RUN |
| Cleanup / zero residual test state                       | PASS    |
| Local gates (six)                                        | PASS    |

NOT RUN reasons: both items required browser tooling that was lost to the MCP
server crash; the write half of each was covered at the HTTP layer (§4/§8).

## 12. Remaining G2 blockers

Production evidence remains unavailable and no source change can substitute
for it:

- production R2/IAM policy and bucket lifecycle evidence;
- production network/tunnel and DNS behavior under load;
- production backup/restore evidence;
- live alert delivery evidence (production channels).

G2 remains **BLOCKED** on that evidence, unchanged by this phase. Everything
this phase could verify on the isolated deployment is green.

## 13. Changes made by this phase

- `packages/db/src/migrate-exit-code.test.ts` — suite timeout budget
  (defect 10.1).
- Deployment state: `phase-aj-test` freeze row created (ACTIVE) as part of the
  web-gate verification — it is the intended steady state; two freeze audit
  rows retained.
- This report. No other source, schema, deployment, or credential changes.
