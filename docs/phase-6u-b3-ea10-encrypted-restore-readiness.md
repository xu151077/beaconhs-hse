# Phase 6U-B3-EA-10 — Encrypted backup, restored-database readiness and replica coverage

Date: 2026-10-22
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform` (unchanged) — HEAD `51a899b7aac0a942da327222a3eed355fca9798a` (unchanged)
Previous phase: `docs/phase-6u-b3-ea9-backup-restore-readiness.md`
Companion runbook: `docs/backup-restore-runbook.md`

---

## 0. Verdict

| Item                                                             | Result                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| Official database restore (`scripts/cluster/restore-verify.sh`)  | **PASS**                                                   |
| Object ownership / RLS / ledger / manifest metrics after restore | **PASS** (identical to source)                             |
| Restored database is usable by the app without an extra step     | **FAIL — fixed** (§3, E10-1)                               |
| Readiness against the restored database (schema match)           | **PASS** — 200                                             |
| Readiness when the ledger is ahead of the build                  | **PASS** — 503, exact diagnosis                            |
| Readiness when the ledger is unreadable or absent                | **PASS** — 503, fail-closed in production                  |
| Readiness when the database is unreachable                       | **PASS** — 503                                             |
| Readiness when the database is behind (pending migrations)       | **PASS** — 200 and logged once                             |
| Format-2 (encrypted) object-store backup                         | **PASS**                                                   |
| Package format-2 suite                                           | **PASS** — 31/31 (previously 31 skipped)                   |
| Encrypted backup tamper / wrong-key / wrong-format matrix        | **PASS** — every hostile case refused                      |
| Encrypted restore and post-restore comparison                    | **PASS** — identical keys, hashes, metadata, tenant prefix |
| Replica fleet decision logic + negative fixtures                 | **PASS** — contract only                                   |
| Real multi-node Swarm coverage                                   | **NOT RUN**                                                |
| Real production restore / real deployment                        | **NOT RUN**                                                |
| WORM / object-lock restore                                       | **NOT RUN** (static assurance only, §4.6)                  |
| WOPI frozen re-open                                              | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED` |

**EA-10: PASS for every locally testable item.** The local release candidate
verdict from EA-9 stands. None of this is production restore approval.

---

## 1. Phase A — audit (what exists, and what it cannot do)

| Mechanism              | Path                                                                                     | Finding                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Readiness schema guard | `apps/web/src/lib/schema-compatibility.ts`, `apps/web/src/app/api/health/ready/route.ts` | Reuses the migrator's ledger; distinguishes `match` / `ahead` / `pending` / `unknown`                               |
| Migration validator    | `packages/db/src/migration-state.ts`                                                     | Reused, not reimplemented                                                                                           |
| Official restore       | `scripts/cluster/restore-verify.sh`                                                      | Restores with `--no-owner --no-privileges --role=<owner>`; verifies ownership, manifest metrics and unvalidated FKs |
| Backup                 | `scripts/cluster/backup.sh`                                                              | Refuses a login that is not `NOSUPERUSER` + `BYPASSRLS` + `default_transaction_read_only=on`                        |
| Object-store backup    | `packages/object-store-backup/src/{vault,crypto,restore,diff}.ts`                        | Format 1 = plaintext; format 2 = age ciphertext + HMAC over a canonical, length-prefixed manifest                   |
| Replica gate           | `scripts/ci/verify-server-action-key-gate.sh`                                            | Enumerates `docker ps` only; cannot see tasks on other nodes                                                        |

Two limits were confirmed before testing, not assumed:

1. `restore-verify.sh` strips privileges by design. Nothing in the repository
   reapplied them automatically.
2. `docker ps` on a Swarm node lists only that node's tasks. The gate's
   `verify_replicas` therefore could not prove a multi-node fleet, and did not
   say so.

---

## 2. Phase B — restore and readiness against the restored database

### 2.1 Tooling

The host has no `pg_dump`, `pg_restore` or `psql`. All database work ran in
disposable `postgres:16-alpine` containers against the local stack on 5433. The
source database was created for the drill (`ea10_src_test`) and migrated with the
project migrator: **50 migrations, 211 public tables, 191 forced-RLS tables, 194
tenant policies**.

Backup: `scripts/cluster/backup.sh` with a drill-only read-only login.

| Field   | Value                                                                                |
| ------- | ------------------------------------------------------------------------------------ |
| Dump    | `beaconhs-20261022T001353Z.dump`                                                     |
| Size    | 1,162,274 bytes                                                                      |
| SHA-256 | `bd6e9f36847cddb2e4a67fdd9501f175d905b31ff71272610bb2f2745e22ff52`                   |
| Format  | custom (`pg_dump -Fc`), plaintext for the drill only (`BACKUP_ALLOW_PLAINTEXT=true`) |

### 2.2 Official restore

```sh
# inside postgres:16-alpine, as the administrator the script requires
PGUSER=postgres PGPASSWORD=… PGDATABASE=postgres \
DATABASE_OWNER_ROLE=beaconhs_owner KEEP_RESTORE_DB=true \
  sh /s/restore-verify.sh /in/beaconhs-20261022T001353Z.dump
```

Result:

```
beaconhs-20261022T001353Z.dump: OK
Restore verified and retained: beaconhs_restore_20261022002507_1
```

- All **197** public tables and the `drizzle` schema are owned by
  `beaconhs_owner` (0 wrong owners).
- Fingerprint before/after is identical:
  `migrations=50 tables=211 rls=191 policies=194`.
- The script also compared the manifest's tenant, attachment and form-response
  counts and the unvalidated-FK count; it fails on any mismatch, and it passed.

`PGUSER` must be an administrator. An earlier attempt used `beaconhs_migrator`,
which cannot create databases and cannot read `drizzle.*` after ownership is
reassigned; that attempt is user error against the documented contract, not a
script defect.

### 2.3 E10-1 — the restored database is not usable until grants are rebuilt (High, fixed)

`pg_restore` runs with `--no-privileges`. Immediately after a successful restore:

| Check                                                   | Value       |
| ------------------------------------------------------- | ----------- |
| `beaconhs_app` USAGE on `public`                        | `true`      |
| `beaconhs_app` SELECT on `public.tenants`               | **`false`** |
| `beaconhs_app` SELECT on `drizzle.__drizzle_migrations` | **`false`** |

Running the project migrator against the restored database repairs it:

```sh
MIGRATION_DATABASE_URL=…/beaconhs_restore_… DATABASE_URL=… SUPERADMIN_DATABASE_URL=… pnpm db:migrate
```

```
Migration ledger valid: 50 applied, 0 pending, 0 historical
RLS applied atomically (191 tables)
Least-privilege grants applied (runtime beaconhs_app; maintenance beaconhs_super; backup beaconhs_backup)
Statistics applied (32 targets)
```

| Check (after)                                           | Value                          |
| ------------------------------------------------------- | ------------------------------ |
| `beaconhs_app` SELECT on `public.tenants`               | `true`                         |
| `beaconhs_app` SELECT on `drizzle.__drizzle_migrations` | `true`                         |
| `beaconhs_app` INSERT on the ledger                     | `false` (read-only, unchanged) |

Two fixes landed:

1. `docs/backup-restore-runbook.md` makes the migrator step mandatory and
   explains that skipping it yields a healthy-looking but unusable database.
2. `scripts/cluster/restore-verify.sh` now prints, after a retained restore:

   ```
   Next: run 'pnpm db:migrate' against <db> to reapply the runtime, maintenance and backup grants.
         The restored database is not usable by the application until that completes.
   ```

   Re-proven end to end after the change: checksum OK, restore verified, both
   guidance lines printed, exit 0.

### 2.4 Readiness matrix against real databases

All instances ran the gated image `beaconhs:ea10-drill` (Server Action key
fingerprint `dc2116c5d44b60055557470fc2267bd2`) with `NODE_ENV=production`,
`APP_VERSION=5555555555555555555555555555555555555555`.

| Scenario       | Database                                                    | HTTP    | Logged reason                                                                                                            |
| -------------- | ----------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Match          | official restore + grants                                   | **200** | `[schema] match: {"state":"match","applied":50}`                                                                         |
| Behind         | real 49-of-50 database                                      | **200** | `[schema] pending: {"state":"pending","pending":["0050_repair_0049_multipart_upload_id"]}`                               |
| Ahead          | real 51-migration database                                  | **503** | `[schema] ahead: Migration tracker is ahead of this checkout (1792628861527 > 1792049376543)`                            |
| Ledger missing | empty database                                              | **503** | `[readiness] not ready: Failed query: select hash, created_at from "drizzle"."__drizzle_migrations" order by created_at` |
| Journal absent | rebuilt image with `BEACONHS_MIGRATIONS_DIR=/nonexistent-…` | **503** | `[schema] unknown: this build carries no migration journal`                                                              |
| DB unreachable | closed port                                                 | **503** | `[readiness] not ready: Failed query: select 1`                                                                          |

The `ahead` and `behind` states were produced **without editing any migration
ledger**, as required:

- A copy of the real `drizzle/` folder was extended with a migration
  representing the next release; drizzle's own migrator applied it to an
  isolated database (`SET ROLE beaconhs_owner`, the same path `migrate.ts` uses).
  The ledger genuinely ended at `1792628861527`, ahead of the build's
  `1792049376543`.
- The `behind` database was built by applying a copy of the real journal with the
  newest migration removed — a genuine 49/50 database.

The `behind` fixture needed one fixture-only grant (`USAGE` on `drizzle` and
`SELECT` on `__drizzle_migrations`) because the product grant step only runs as
part of the migrator, which would have advanced the database to 50. No access
beyond what the migrator grants was used, and the behaviour under test
(`pending → 200`) is unaffected by how the read grant got there.

No response body or log line contained a connection string, password or key.
The `Failed query` messages are Drizzle's own text and carry no credentials.

---

## 3. Phase C — format-2 encrypted backup

### 3.1 Tooling

The host has no `age`; no cached image contained it, and the Go module cache is
empty. `age` 1.1.1 and `age-keygen` were installed **inside a disposable
container from the already-cached `golang:1.26.6-bookworm` image**, used from a
`/tmp` directory for the duration of the drill, and deleted afterwards. Nothing
was installed on the host, no image was pulled, and no system package database
was touched. The package's own tests accept the binary through `AGE_HOME`.

### 3.2 Package suite

`pnpm --filter @beaconhs/object-store-backup exec vitest run src/crypto.test.ts`
with `AGE_HOME` set:

```
Test Files  1 passed (1)
Tests       31 passed (31)     # previously 31 skipped, not passed
```

The suite covers, among others: algorithm stamping, refusing a legacy-signed
backup with a version diagnosis, unknown/rewritten `hmac_algorithm`, a
non-string algorithm, a wrong HMAC, a removed algorithm field, identity
re-resolution, format-1 compatibility, and encrypted manifest + blob handling.
Without `age`, the suite still **skips loudly** rather than passing.

### 3.3 Real drill

Drill tenant `52544214-a391-4a29-a351-64c5d4cc16f9` in an isolated database
`ea10_enc_test`. Two objects were written through the **product path** only:

```ts
await storage.ensureBucket()
await bootstrapStorageFreezeGate(storage) // same registration the worker uses
await storage.putObject({ key, body, contentType })
```

Objects: `t/<tenant>/ea10-drill/gamma.txt` (18 B, `text/plain`) and
`…/delta.json` (33 B, `application/json`).

Encrypted backup (`backup --encrypt`, age recipient + HMAC key file, both 0600):

| File                      | Size        | Mode   |
| ------------------------- | ----------- | ------ |
| `manifest.json.enc`       | 1,893 B     | `0600` |
| `objects/<sha256>.age` ×2 | 218 / 233 B | `0600` |
| `checkpoint.json.enc`     | 602 B       | `0600` |
| `backup.hmac`             | 65 B        | `0600` |

No plaintext manifest, no plaintext blob, and the plaintext marker
(`ea10 gamma payload`) did not appear anywhere in the backup directory.

### 3.4 Refusal matrix (real artifacts, not mocks)

| Case                                                         | Exit  | Evidence                                                                                            |
| ------------------------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------- |
| Correct identity + HMAC key                                  | **0** | `verified 2 object(s); backup is intact`                                                            |
| Backup directory has no manifest                             | 1     | `manifest could not be loaded: manifest not found or unreadable: /tmp/ea10-missing/manifest.json`   |
| Wrong age identity                                           | 1     | `manifest could not be loaded: age command failed with exit code 1`                                 |
| Wrong HMAC key                                               | 1     | `integrity check failed: this backup does not match the HMAC key provided`                          |
| Missing HMAC key                                             | 1     | `BACKUP_HMAC_KEY_FILE (preferred) or BACKUP_HMAC_KEY is required`                                   |
| Tampered ciphertext blob                                     | 1     | age decryption failure during verification                                                          |
| Tampered encrypted manifest                                  | 1     | age decryption failure                                                                              |
| Tampered `backup.hmac`                                       | 1     | integrity check failed                                                                              |
| `format_version: 3` **with a valid HMAC**                    | 1     | `unsupported manifest format_version 3; this tool writes and reads 1 (plaintext) and 2 (encrypted)` |
| Blob re-encrypted with different content, manifest untouched | 1     | `sha256 mismatch: manifest says 2ada…, object hashes to 2ecb…`                                      |

The last two are the important ones: a valid signature does **not** bypass the
format check, and anyone holding the public recipient can re-encrypt a blob, but
cannot make it match the signed digest.

### 3.5 Restore and comparison

`restore` into a new bucket:

```
created target bucket ea10-enc-target
restored:        2/2
verified:        2/2
access checks:   anonymous=pass wrong-creds=pass presigned=pass
RESTORE VERIFIED
```

A fresh plaintext backup of the target was compared with the decrypted source
manifest:

| Field                                   | Result                  |
| --------------------------------------- | ----------------------- |
| Missing / extra objects                 | 0 / 0                   |
| SHA-256 / size / contentType mismatches | 0                       |
| Tenant prefix preserved                 | yes (`t/<uuid>/…` both) |
| Verdict                                 | **IDENTICAL**           |

The lifecycle configuration was captured in the manifest but **not applied**,
because `--apply-lifecycle` was not passed. MinIO does not return the
`AbortIncompleteMultipartUpload` rule it accepts, which the tool warns about; it
is not a restore failure.

### 3.6 WORM / versioning

Static audit of `packages/object-store-backup/src`: there is **no** `DeleteObject`
/ `DeleteObjects`, no `PutBucketVersioning` and no `PutObjectLockConfiguration`.
The only bucket-policy write is `PutBucketLifecycleConfiguration`, reachable only
with the explicit `--apply-lifecycle` flag. A restore therefore cannot delete
objects, disable versioning or weaken object-lock retention.

No object-lock (WORM) bucket was available in the drill, so a real WORM restore
is **NOT RUN**; this section is code-level assurance, not exercised behaviour.

---

## 4. Phase D — replica fleet decision logic

`verify_replicas` previously sampled `docker ps` on the local node, waited for
the service to settle and asserted each visible task's image key and readiness
version. It never read a task's node placement and never stated its scope.

### 4.1 What changed

New dependency-free module `scripts/ci/replica-coverage.mjs`:

- `evaluateFleet({ replicas, expectedVersion, expectedFingerprint, expectedNodes, tasks })`
  returns `{ ok, failures, coverage }`, pure and deterministic;
- refuses: no tasks, a non-positive replica count, a malformed fingerprint, a
  missing/duplicate task id, a task count that does not match the desired
  replicas, a task that is not `running`, a task that is not ready, a version
  mismatch, a task with no key evidence, a runtime fingerprint mismatch, a task
  with no node id, and fewer observed nodes than `--expected-nodes`;
- reports honestly: `taskCount`, `distinctNodes`, node ids,
  `single-node-observed` / `multi-node-observed`, and the number of expected
  nodes that were **not** observed.

The shell gate now collects `com.docker.swarm.task.id`,
`com.docker.swarm.node.id` and `State.Status` per container and delegates the
fleet decision to the module. `verify_log` records whether the task used the
build-time key or a runtime fingerprint, so the module sees real evidence.

### 4.2 Tests

- `node --test scripts/ci/replica-coverage.test.mjs`: **17/17 pass**, including
  duplicate task, partial fleet, failed task, not ready, mixed commit, mixed
  runtime key, missing node id, node-coverage shortfall, empty list and NDJSON
  parsing. The CLI test also verifies exit 1 and exit 0.
- Existing gate fixtures: `scripts/ci/verify-server-action-key-gate.test.sh`
  **13/13 pass** (unchanged contract).
- Local harness with a fake `docker` (not a Swarm): healthy fleet → exit 0 with
  `2 task(s) on 1 node(s) … (single-node-observed)`; stale commit, duplicate task
  id, missing node id and mixed runtime key all → exit 1 with a specific reason.
- CI now runs `node --test scripts/ci/replica-coverage.test.mjs`, and the
  deployment contract test pins that.

### 4.3 What this does and does not prove

| Statement                                           | Status      |
| --------------------------------------------------- | ----------- |
| Single-node gate behaviour, unchanged and re-tested | **PASS**    |
| Fleet decision contract, negative cases             | **PASS**    |
| Real multi-node Swarm task placement                | **NOT RUN** |

The module cannot discover a node it cannot reach. It now fails when the
observed list is incomplete or when node ids are missing, instead of silently
certifying a subset — which is the strongest claim a local-node gate can make.

---

## 5. Phase E — runbook

`docs/backup-restore-runbook.md` records the procedure actually exercised:
pre-checks, role requirements, backup and verification, restore order,
**mandatory grant reapplication**, object-store restore, post-restore comparison,
readiness/version compatibility, stop conditions, RPO/RTO recording, and the
prohibition on rolling a database back to an older schema. It also records the
BusyBox `sha256sum --check` portability wrinkle and the external `age`
dependency.

`docs/PRODUCTION_RUNBOOK.md` now points at it from its backup section.

---

## 6. Gates (each exit code captured separately)

| Gate                                               | Result                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                | **exit 0**                                                                                                                                    |
| `pnpm typecheck`                                   | **exit 0** (27/27 tasks; `@beaconhs/web` cache miss, recompiled)                                                                              |
| `pnpm lint`                                        | **exit 0**                                                                                                                                    |
| `pnpm test`                                        | **exit 0** — web 2114 passed / 8 skipped; db 506 / 41; object-store-backup 139 / 38 (age tests skip loudly when `age` is absent); 25/25 tasks |
| `pnpm deadcode:check`                              | **exit 0**                                                                                                                                    |
| `pnpm build`                                       | **exit 0** (4/4; web compiled)                                                                                                                |
| `node --test scripts/ci/replica-coverage.test.mjs` | **17/17**                                                                                                                                     |
| `scripts/ci/verify-server-action-key-gate.test.sh` | **13/13**                                                                                                                                     |

The six gates were re-run after the final script change; all exit codes above are
from that final run.

---

## 7. Cleanup

| Resource                                                                                   | State                                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `ea10_src_test`, `ea10_empty_test`, `ea10_ahead_test`, `ea10_behind_test`, `ea10_enc_test` | dropped                                                                        |
| `beaconhs_restore_20261022002507_1` and re-check restores                                  | dropped                                                                        |
| `ea10_backup_role`                                                                         | dropped                                                                        |
| `ALTER ROLE beaconhs_migrator CREATEDB` (drill-only)                                       | reverted to `NOCREATEDB`                                                       |
| `ea10-enc-source`, `ea10-enc-target` buckets (4 objects)                                   | deleted, verified absent on disk                                               |
| `ea10-*` containers                                                                        | removed                                                                        |
| `/tmp/ea10-*` (age binary, keys, dumps, backups, shims, fixtures)                          | removed (0 entries)                                                            |
| `beaconhs:ea10-drill` image                                                                | removed (untagged and deleted)                                                 |
| Git state                                                                                  | HEAD unchanged, 0 staged, pre-existing modifications/untracked files preserved |

The dev database was not touched: it still has 50 ledger rows and no EA-10
grants or rows.

---

## 8. Residual risks

| ID  | Risk                                                                                                       | Severity                              |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| R-1 | No production restore has been performed; local drill timings are not a production RTO                     | High (authorisation)                  |
| R-2 | Multi-node Swarm placement is still unproven; the contract is tested, the topology is not                  | High (authorisation)                  |
| R-3 | Every restore depends on running the current migrator to rebuild grants; skipping it produces 503s         | Medium (documented + script guidance) |
| R-4 | Format-2 requires an external `age`; the drill used 1.1.1 while upstream is 1.2.x                          | Low (format-compatible)               |
| R-5 | WORM/object-lock restore is assured by code audit only, never exercised                                    | Medium                                |
| R-6 | Lifecycle configuration is captured, not applied by default (MinIO quirk documented)                       | Low                                   |
| R-7 | The replicas gate now fails when swarm node labels are absent; a non-swarm direct deploy would fail closed | Low (intentional)                     |

---

## 9. Explicitly not run

- Real deployment through `deploy-dev.yml` / Dokploy, and a real rollback.
- A production database restore and a production object-store restore.
- A genuinely multi-node Swarm run.
- GHCR / GitHub Actions cache build path.
- Restore into an object-lock (WORM) or versioned bucket.
- WOPI frozen-document re-open (paused by owner decision).
