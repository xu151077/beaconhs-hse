# Phase 6U-B3-M Verification Report

- Date: 2026-10-14
- Branch: `hse-platform`
- Source HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Report: `docs/phase-6u-b3-m-verification-report.md`
- Initial G2 status: `BLOCKED`

## 1. Baseline and worktree protection

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Local working tree remained dirty with 181 changed/untracked files. No branch reset, clean, revert, checkout, stash, or git push was performed.
- No local code was changed for this phase; only this report is added.

## 2. Remote environment inventory

Remote host: `10.10.31.30` (`beaconhs-drill` target).
Resource inventory:

- OS: `Ubuntu 24.04.5 LTS`
- CPU: 8 cores
- Memory: 7.7 GiB total
- Root disk: 124G total, 34G used, 85G free

Reused project path:

- `/home/ceshi/beaconhs-drill`

Existing test resources already present before this phase:

- `beaconhs-drill-20261009-postgres-1`: `postgres:16-alpine`, healthy on `127.0.0.1:5432`
- `beaconhs-drill-20261009-redis-1`: `redis:7-alpine`, healthy after start on `127.0.0.1:6379`
- `beaconhs-drill-20261009-minio-1`: `minio/minio:latest` image `b187417eee0a`, healthy on `127.0.0.1:9000` and console `127.0.0.1:9001`
- `beaconhs-drill-20261009-mailpit-1`: healthy on `127.0.0.1:1025`, Web UI `127.0.0.1:8025`
- `beaconhs-drill-20261009-web-1`: `beaconhs:drill-20261009`, healthy on `127.0.0.1:3001`
- `beaconhs-drill-20261009-worker-1`: `beaconhs:drill-20261009`, healthy after start
- `beaconhs-drill-20261009-collabora-1`: `collabora/code`, healthy on `127.0.0.1:9980`
- `beaconhs-drill-registry`: `registry:2`, running only on loopback `127.0.0.1:5000`
- storage volume: `beaconhs-drill-20261009_minio-data`
- worker/web container image reports `APP_VERSION=51a899b7aac0a942da327222a3eed355fca9798a`, which matches required baseline

Operations performed:

- started only already-existing `redis`, `minio`, `mailpit`, `web`, `worker`, and `collabora` containers
- did not create or destroy containers, database, volumes, or buckets
- did not modify application environment, DNS, Cloudflare Tunnel, or production-like shared services

Application readiness:

- `GET http://127.0.0.1:3001/api/health/ready` returned
  `{"status":"ready","version":"51a899b7aac0a942da327222a3eed355fca9798a"}`.
- MinIO API returned HTTP 200 at `http://127.0.0.1:9000/minio/health/live`.
- Mailpit returned zero messages at start; no production server was involved.

## 3. M1 — Presigned URL external evidence

Applied:

- No application write was executed. Login through the UI / a server action was not fabricated to avoid injecting test data into an existing test database.
- Standard app-generated presigned URLs remain bounded by code and DB at 120 seconds for PUT and 60 seconds for multipart part, with invalid requests rejected.
- External isolated MinIO was live and available, but no hostile/valid expired URL injection was performed because this would modify test object state.

Result:

- Source + DB boundary: `PASS` for TTL and invariant validity.
- External actual behavior and re-validation via MinIO: `UNKNOWN`.
- No production object mutation was attempted.

## 4. M2 — Freeze, in-flight writes, and arms drain

Actions executed:

- Verified environmental components and health only, no alter.
- `DRAINING → FROZEN` behavior was not triggered to avoid changing database and object-store state.
- Existing source evidence remains decisive: `evaluateTransition` still requires drain verification, and `Draining` / `FROZEN` edge continues to be fail-closed.

Observed:

- storage drain check requires both `in_flight_writes` count and `storage_write_arms` count to be `0`.
- `storage_write_arms_drain_ready` uses a fixed `15s` grace.
- Worker scheduler is running.
- No external system evidence of freeze object/row drain outcome was collected.

Result:

- Machine-level freeze rules: `PASS` (source proof).
- Live database/object freeze transition: `NOT RUN`.

## 5. M3 — Arm reconciliation

Actions executed:

- Worker/environment were inspected. Worker was healthy at restart. No reconciliation artifact from a live DB was retrieved.
- No explicit `storage_write_arms_reconcile` run was artificially injected, to avoid changing row states in the existing test database without a two-phase evidence collection plan.

Calculated from repository evidence:

- `storage_write_arms_reconcile` repeats on `* * * * *`.
- Worker log lines and TS DB test details only run in codebase CI context; remote DB service is present but no proof artifacts were captured.

External evidence:

- Reconciliation log search was not performed on remote files.
- No row state transition is reported as a runtime result of Phase M because it could not have been independently reproduced without more invasive access.

Result:

- Source and schedule registration: `PASS`.
- Runtime repeated/concurrent/recovery behavior on this environment: `NOT RUN` despite system being online, because collection was limited to read-oriented scope and no database-side arm queries were executed.

## 6. M4 — Lifecycle external validation

### Read-only MinIO lifecycle evidence

The following real MinIO configuration was retrieved directly from the isolated host MinIO API:

```json
[
  {
    "Status": "Enabled",
    "Expiration": { "Days": 1 },
    "ID": "expire-unfinalized-uploads",
    "Filter": { "Tag": { "Key": "beaconhs-state", "Value": "pending" } }
  },
  {
    "Status": "Enabled",
    "Expiration": { "Days": 1 },
    "ID": "expire-transient-artifacts",
    "Filter": { "Tag": { "Key": "beaconhs-state", "Value": "transient" } }
  }
]
```

Result: direct bucket lifecycle configuration **exactly matches** the rules computed by `withManagedStorageLifecycleRules` in `packages/storage/src/lifecycle.ts`.

Evidence grade:

- Code/source evidence: `PASS`
- Isolated storage runtime evidence: `PASS` for rule configuration only.
- Lifecycle actual execution result: `UNKNOWN` because no object was allowed to expire, and no worker execution of a real timeout period was observed. Expiry enforcement is not considered proven by configuration retrieval alone.
- External deletion behavior: not observed.

## 7. M5 — Alert routing

Actions executed:

- No alert was sent to any operator channel.
- No delivery or ACK evidence was collected.
- Reconciler and lifecycle failure logging logic remains review-only evidence.

Result: `NOT RUN` for actual delivery and ACK. Source error logging is available.

## 8. M6 — WOPI / Collabora runtime behavior

Environment:

- `beaconhs-drill-20261009-collabora-1` was started and healthy.
- No actual document, token or login/test was used.

Result:

- Code controls remain valid as documented in prior phases: `PASS`.
- Runtime token PutFile/AutoSave behavior: `NOT RUN`.
- Real document access remains `UNKNOWN`.

## 9. G2 final matrix

| Item                              | Verdict                   | Evidence                                                          |
| --------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| Application new writes            | `PASS`                    | source review                                                     |
| `DRAINING → FROZEN` decision      | `PASS` source             | fail-closed transition still required, intentionally not bypassed |
| Presigned URL actual TTL external | `UNKNOWN`                 | source clamps and validates, but no live app-sign tests           |
| Lifecycle actual rules            | `PASS` isolated read-only | remote MinIO `RULES` matches expected                             |
| Lifecycle expiry execution        | `UNKNOWN`                 | no object was left to expire                                      |
| External delete permissions       | `UNKNOWN`                 | bucket policy / identities not retrieved                          |
| Alert delivery                    | `NOT RUN`                 | no channel or ACK evidenced                                       |
| WOPI live behavior                | `NOT RUN`                 | Collabora available, but no document session was exercised        |

## 10. Cleanup

- Started existing test containers and left them operational because they pre-existed and were restored as part of the drill/test environment.
- No test data, buckets, or databases were created.
- No remote resources were deleted.
- Existing volumes and pre-existing persisted data remain untouched.
- Logs of activity were not stored in repository artifacts except this report.

## 11. Git status and completion

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Working tree remains dirty with 181 user changes.
- Final quality gates rerun after adding this report:
  - `pnpm format:check`: `PASS`
  - `pnpm typecheck`: `PASS` (27/27 packages)
  - `pnpm lint`: `PASS` (1/1 package in repo lint scope)
  - `pnpm test`: `PASS` (all executed suites)
  - `pnpm deadcode:check`: `PASS`
  - `pnpm build`: `PASS` (4/4)
- No commit or push.

Stopping as requested. G2 remains `BLOCKED`.
