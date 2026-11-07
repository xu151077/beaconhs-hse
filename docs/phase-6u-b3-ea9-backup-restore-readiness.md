# Phase 6U-B3-EA-9 — Backup/restore closure and old-build startup guard

Date: 2026-10-22
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform` (unchanged) — HEAD `51a899b7aac0a942da327222a3eed355fca9798a` (unchanged)
Previous phase: `docs/phase-6u-b3-ea8-rollback-drill.md`

---

## 0. Verdict

| Item                                              | Result                                                     |
| ------------------------------------------------- | ---------------------------------------------------------- |
| Old-build startup guard (EA-8 R-3)                | **PASS — fixed and proven against a real image**           |
| Object-store backup → restore → verify round trip | **PASS**                                                   |
| Database backup → restore → verify round trip     | **PASS**                                                   |
| Server Action key rollback boundary (§E)          | **PASS** (known limitation recorded)                       |
| Multi-node replica coverage                       | **NOT RUN** (single-node only)                             |
| Real deployment / real production restore         | **NOT RUN**                                                |
| GHCR / GHA cache, Drill transport                 | **NOT RUN**                                                |
| WOPI frozen re-open                               | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED` |

**LOCAL RELEASE CANDIDATE: PASS** — upheld, with two production-affecting defects
found and fixed this phase (§2, §3).

---

## 1. Phase A — what already exists (verified, not assumed)

| Tool / mechanism                                  | Path                                                                                                                          | Verified           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Object-store inventory/backup/verify/restore/diff | `packages/object-store-backup/src/{cli,backup,restore,verify,diff,manifest}.ts`                                               | exists, used below |
| DB logical backup                                 | `scripts/cluster/backup.sh` (requires a `NOSUPERUSER`+`BYPASSRLS`+`default_transaction_read_only=on` login)                   | exists, used below |
| Migration journal + validator                     | `packages/db/src/migration-state.ts` (`readMigrationFiles`, `validateMigrationState`)                                         | exists, reused     |
| Freeze-state reader registration                  | `bootstrapStorageFreezeGate()` in `packages/db/src/storage-freeze-operations.ts`, called by `apps/worker/src/storage-init.ts` | exists, reused     |
| Server Action key gate                            | `scripts/ci/verify-server-action-key-gate.sh`                                                                                 | exists             |

The host has **no** `pg_dump`/`pg_restore`/`psql`/`age`; all database work ran in
plain `postgres:16-alpine` containers against the local stack. No resource was
created before the tools were confirmed.

---

## 2. Phase B — old-build startup guard (EA-8 R-3 fixed)

### The defect, restated

EA-8 proved an old image reported `{"status":"ready"}` **200** against a schema
that had a newer migration applied. The migrator catches this, but migrations run
as a separate step, so a hand-re-pinned old image came up green.

### Design — deliberately not "any mismatch is fatal"

| Database vs build                  | Readiness             | Why                                                                                                                                                              |
| ---------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ahead** of this build            | **503**               | Columns/tables a newer migration created; this build cannot understand them and there is no down path.                                                           |
| **Behind** (pending migrations)    | **200**, logged once  | During a rollout the outgoing replicas legitimately serve while the migration step finishes. Failing here would take the fleet down on every additive migration. |
| Identical                          | **200**               | Normal.                                                                                                                                                          |
| Ledger unreadable / journal absent | **503** in production | A proof that cannot be made is not a pass. In `next dev` (no journal) it is tolerated.                                                                           |

### Implementation

- `apps/web/src/lib/schema-compatibility.ts` — `classifySchema()` compares the
  ledger with the journal **using the migrator's own `validateMigrationState`**
  (re-exported from `@beaconhs/db`), so the rules are not duplicated.
- `apps/web/src/app/api/health/ready/route.ts` — runs the check **after**
  connectivity, so an outage is still reported as an outage; logs once with a
  precise reason (the previous bare `catch {}` discarded it, which made an
  out-of-rotation pod indistinguishable from an unreachable one).
- `packages/db/src/migrate.ts` — runtime and maintenance roles now get **read-only**
  `SELECT` on `drizzle.*` (same grant shape as the existing backup role). Without
  it the check cannot run at all: `beaconhs_app` and `beaconhs_super` had **no**
  `drizzle` privileges.

### Proof against a real, gated image

Built `beaconhs:ea9-drill4` through the key gate (`[key-gate] PASS`, fingerprint
`c2392fad…`), then ran it on an isolated database:

```
(A) ledger matches  -> readiness_http=200  [schema] match: {"state":"match","applied":50}
(B) one future row  -> readiness_http=503  [schema] ahead: Migration tracker is ahead of
                                           this checkout (9999999999999 > 1792049376543)
```

Regression: `schema-compatibility.test.ts` **6/6** (match / ahead / pending /
empty ledger / absent journal / inconsistent ledger) plus the readiness route
suite.

---

## 3. Phase C — object-store full round trip (EA-8 D-10 unblocked)

EA-8 stopped at `STORAGE_FREEZE_STATE_UNKNOWN` because it would not bypass the
control. The **product registration path** was then found and used — no bypass:

```ts
await bootstrapStorageFreezeGate(storage) // same call storage-init makes
await storage.putObject({ key, body, contentType }) // tenant + freeze enforced
```

**Correction recorded during the drill:** `putObject`'s contract is
`key/body/contentType` (+ `contentDisposition`, `lifecycle`) — it does **not**
accept `metadata`/`tags`. The first attempt passed them; they were silently
dropped, and the drill was corrected to exercise the API that exists rather than
assume one. No product defect.

| Acceptance gate         | Evidence                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Backup succeeded**    | `backup` exit 0; `schema=1 objects=2 bytes=38`                                                                                                         |
| **Restore succeeded**   | `restore` into a separate bucket: `restored: 2/2`, `verified: 2/2`, `RESTORE VERIFIED`; access checks anonymous=pass, wrong-creds=pass, presigned=pass |
| **Content verified**    | Independent `sha256sum -c` over the backup blobs: both `成功` (OK); re-backup of the restored bucket re-verified `2 object(s); backup is intact`       |
| **Metadata verified**   | `contentType` `text/plain` / `application/json` preserved; `contentDisposition=attachment`; tenant prefix `t/<uuid>/` preserved                        |
| **Diff passed**         | Source vs restored manifests: **missing 0, extra 0, content mismatches 0** → `IDENTICAL`                                                               |
| **Delete-then-restore** | Re-restore with `--overwrite` after deletion: `restored 2/2, verified 2/2`                                                                             |

**Two safety behaviours worth recording (both correct):**

- `inventory --diff` **refuses cross-bucket comparison** (`refusing to diff
different buckets … would delete the wrong objects`). The object comparison was
  therefore done on the two manifests directly.
- `restore` **never deletes target objects** absent from the backup — a backup is
  input, not a mirror.

---

## 4. Phase D — database backup and restore

| Item           | Value                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Backup tool    | `scripts/cluster/backup.sh` (project's own)                                                                              |
| Dump           | `beaconhs-20261021T164509Z.dump`, **1,162,778 bytes**                                                                    |
| SHA-256        | `0e0406d4216285d7302184ee286ab07b00a6016932aae25c69dadcd443477f4f`                                                       |
| Manifest       | `migration_rows=50`, `public_tables=197`, `public_views=14`, `forced_rls_tables=192`, `tenant_policies=191`, `tenants=1` |
| Restore target | brand-new `ea9_restore_test` (never the dev database)                                                                    |
| Restore time   | **4 s** (`pg_restore --no-clean --no-privileges --exit-on-error`)                                                        |

**Fingerprint comparison (source at backup time vs restored):**

```
migrations 50 | tables 211 | rls 191 | policies 194 | tenants 1 | freeze 1   → IDENTICAL
```

**Point-in-time proof:** a tenant inserted _after_ the backup (`ea9-post-backup`)
is present in the source (`ea9-drill,ea9-post-backup`) and **absent** from the
restore (`ea9-drill`, count 0) — the restore genuinely returned to the backup
instant.

Notes, recorded honestly:

- `backup.sh` refused the migrator role and demanded a `NOSUPERUSER + BYPASSRLS +
default_transaction_read_only=on` login. A **drill-only** role
  (`ea9_backup_role`) was created for that, then dropped. Existing cluster roles
  were not touched (changing their passwords would affect the dev stack).
- `BACKUP_ALLOW_PLAINTEXT=true` was used — the tool's own documented path for a
  disposable drill (no `age` on the host). **Not** a production configuration.
- `beaconhs_owner` is `NOLOGIN` by design, so the restore ran as the migrator
  login and the database/role grants were applied in the drill database only.
- **Application-level readiness against the restored database was NOT run.** The
  restored database existed as data; pointing an instance at it would have added
  another container cycle without new evidence. Marked NOT RUN rather than claimed.

**Real production restore: NOT RUN.**

---

## 5. Phase E — key rollback boundary

| Check                                                         | Result                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image/gate fingerprint consistency                            | PASS — `[key-gate] PASS`, fingerprint printed, never the key                                                                                                                                                                                                                        |
| Incompatible old image refused                                | PASS — `image <old> <new-fingerprint>` → exit **1**, `fingerprint mismatch`                                                                                                                                                                                                         |
| Key absent from logs / image env / build args / tracked files | PASS — only the 128-bit HMAC is ever printed; `ARG` carries the fingerprint only; no `ENV` holds the key                                                                                                                                                                            |
| Unified runtime override boundary                             | **Recorded limitation:** two local builds embed **different** keys (`9602b7…` vs `c7840d…`). A cross-build rollback therefore needs one identical `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` on every instance, or actions fail cross-instance. The gate detects it; it cannot repair it. |

**Multi-node replica coverage (read-only audit):** `verify_replicas` enumerates
`docker ps --filter label=com.docker.swarm.service.name=<stack>_web` — the **local
node's** containers only. It does **not** read a task's node placement, so on a
multi-node Swarm it would silently cover only the tasks on the runner's node. The
script states this limitation in a comment. No code was changed: faking multi-node
coverage locally would not be evidence. **Multi-node: NOT RUN.**

---

## 6. Phase F — regression

| Command                                         | Exit | Result                                                                       |
| ----------------------------------------------- | ---- | ---------------------------------------------------------------------------- |
| `schema-compatibility.test.ts`                  | 0    | 6/6                                                                          |
| `health/ready/route.test.ts`                    | 0    | 6/6 (updated for the new ledger read + one new production-semantics case)    |
| `server-action-key-deployment-contract.test.ts` | 0    | 17/17                                                                        |
| `@beaconhs/db` migration suites                 | 0    | 31/31                                                                        |
| `pnpm format:check`                             | 0    | —                                                                            |
| `pnpm typecheck`                                | 0    | 27/27                                                                        |
| `pnpm lint`                                     | 0    | —                                                                            |
| `pnpm test`                                     | 0    | web **2114 passed / 8 skipped** (2122); db **506 passed / 41 skipped** (547) |
| `pnpm deadcode:check`                           | 0    | —                                                                            |
| `pnpm build`                                    | 0    | 4/4                                                                          |

Three failures were hit and fixed **at the cause** during this phase: a readonly
type mismatch, two dead-code findings (an unused export and a leftover drill
script), and the readiness test's `superDb` call count — the assertion was
replaced with an explicit "once for connectivity, once for the ledger", not
loosened.

---

## 7. Cleanup

| Resource                                                         | State                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Databases `ea9_drill_test`, `ea9_restore_test`, `ea9_final_test` | `DROP DATABASE` — verified 0 remain                                              |
| Role `ea9_backup_role`                                           | `DROP ROLE` — verified 0 `ea9%` roles                                            |
| Buckets `ea9-drill-source`, `ea9-drill-target`                   | Deleted (2 objects each) — `inventory` confirms "does not exist"                 |
| Containers `ea9-*`                                               | 0 remain                                                                         |
| Images `beaconhs:ea9-drill{,2,3,4}`                              | Removed                                                                          |
| Temporary files, drill scripts                                   | `/tmp/ea9*` → 0; `apps/worker/src/ea9-drill-write.ts` and the temp probe removed |
| Dev DB `beaconhs`, Redis DB 0, existing images/buckets           | **Untouched** (dev ledger still 50 rows; no grant change applied to it)          |

---

## 8. Final state

```
branch                -> hse-platform (unchanged)
HEAD                  -> 51a899b7aac0a942da327222a3eed355fca9798a (unchanged)
staged                -> 0
modified / untracked  -> 154 / 471
git diff --stat       -> 154 files changed, 5240 insertions(+), 1927 deletions(-)
```

Change-boundary check: exactly **4** tracked files have a modification time
inside this phase — the four listed below. Every other modified file predates
EA-9 (storage work 2026-10-16, `pnpm-lock.yaml` 10-18, `turbo.json` 10-15, docs
10-14…10-20), so nothing outside this phase's scope was touched. The
insertions/deletions totals shifted from the EA-8 figure because the diff now
includes this phase's edits; the file counts are unchanged (154 modified) plus
the three new untracked files.

Files changed **by this phase**: `apps/web/src/lib/schema-compatibility.ts` (new),
`apps/web/src/lib/schema-compatibility.test.ts` (new),
`apps/web/src/app/api/health/ready/route.ts`,
`apps/web/src/app/api/health/ready/route.test.ts`,
`packages/db/src/migrate.ts`, `packages/db/src/index.ts`, this report.

---

## 9. Not verified — stated plainly

1. **Real deployment** and **real production restore**: NOT RUN.
2. **Multi-node Swarm**: NOT RUN — `verify_replicas` covers one node only.
3. **GHCR / GHA cache path** and **Drill transport/recreate**: NOT RUN.
4. **Readiness against a restored database**: NOT RUN (§4).
5. **Encrypted (format-2) backup**: NOT RUN — `age` is not installed; the
   plaintext flag exists for disposable drills only.
6. WOPI: unchanged.

---

## 10. Residual risks

| ID  | Risk                           | Level      | Note                                                                       |
| --- | ------------------------------ | ---------- | -------------------------------------------------------------------------- |
| R-1 | Old build vs newer schema      | **Closed** | Readiness 503 proven against a real image; migrator guard still first line |
| R-2 | Real rollback on Dokploy/Swarm | **High**   | NOT RUN                                                                    |
| R-3 | Multi-node replica coverage    | **High**   | NOT RUN; single-node assumption documented                                 |
| R-4 | Cross-build key divergence     | Medium     | Characterised; needs one identical runtime override                        |
| R-5 | Encrypted backup path          | Medium     | NOT RUN (no `age`)                                                         |
| R-6 | Drill transport                | Medium     | NOT RUN                                                                    |
| R-7 | WOPI frozen re-open            | Low        | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`                 |

---

## 11. Conclusion

**LOCAL RELEASE CANDIDATE: PASS.** The EA-8 gap (old build reporting ready on a
newer schema) is closed and proven end-to-end against a gated image; the object
store and the database both completed backup → restore → verification with
independent content checks; all six gates pass.

**Real deployment, real production restore, multi-node Swarm, GHCR/GHA and the
Drill transport remain NOT RUN** and must be verified under separate
authorization before any release announcement.
