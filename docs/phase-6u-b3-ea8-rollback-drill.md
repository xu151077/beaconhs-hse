# Phase 6U-B3-EA-8 — Rollback plan and local failure-recovery drill

Date: 2026-10-22
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform` (unchanged) — HEAD `51a899b7aac0a942da327222a3eed355fca9798a` (unchanged)
Previous phase: `docs/phase-6u-b3-ea7-release-security-audit.md`

---

## 0. Verdict

| Area                                        | Result                                                     |
| ------------------------------------------- | ---------------------------------------------------------- |
| Local rollback drill                        | **PASS** (with one defect found and fixed)                 |
| Rollback plan and decision table            | **Complete**                                               |
| Real deployment rollback                    | **NOT RUN**                                                |
| Swarm / multi-node / GHCR / Drill transport | **NOT RUN**                                                |
| WOPI frozen re-open                         | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED` |

The drill found **one high-severity release defect**: a rolling update could
finish with half the fleet on the previous commit, every task reporting `ready`,
and the deployment still declaring success. Fixed in the same phase with a
negative fixture.

**A local rollback drill passing does not mean real deployment rollback is
verified.**

---

## 1. Phase A — rollback boundaries (read from the code, not assumed)

| Component                     | Reversible?           | Mechanism / evidence                                                                                                                                                           |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Application image             | **Yes**               | Immutable per digest; CI deploys `IMAGE_NAME@sha256`. Re-pin the previous digest.                                                                                              |
| Web / Worker / Scheduler      | **Yes, together**     | One shared `${IMAGE}` for all roles; all three must move as a unit or they skew (see §3).                                                                                      |
| Database schema (migrations)  | **No, not by "down"** | 50 migrations, **12 with `DROP TABLE`/`DROP COLUMN`**; `migrate.ts` uses the forward-only drizzle journal and has **no down path**.                                            |
| File objects + metadata       | **Partially**         | Objects are content-addressed by key; deletion is not versioned. Consistency must be _verified_, not rolled back.                                                              |
| Server Action key             | **Yes, but globally** | Embedded at build time; two local builds embed **different** keys (`9602b7…` vs `c7840d…`), so a cross-build rollback breaks actions unless the runtime override is identical. |
| Background queues / in-flight | **No**                | Jobs enqueued under the new build stay queued. Verified they are not silently dropped (§4 D-9).                                                                                |
| Compose config / image digest | **Yes**               | The rewrite pins one tag; restoring the previous tag re-points the stack.                                                                                                      |

`migrate.ts` additionally **refuses a database that is ahead of the code**:

```
Error: Migration tracker is ahead of this checkout (9999999999999 > 1792049376543)   (exit 1)
```

This is the load-bearing protection for rollback: an old build cannot be pointed
at a forward-migrated schema _through the migrator_. It is **not** enforced by
the web process itself (see D-6b below).

---

## 2. Phase B — rollback decision table

For every scenario: **stop** = do not continue the release; **diagnose** = read-only;
**rollback** = the action; **verify** = data-consistency proof; **stop-fail** = when
recovery itself has failed; **approval** = who must sign off.

| #   | Scenario                              | Trigger                                              | Stop continuing           | Read-only diagnosis                                                      | Rollback / remedy                                                                | Data-consistency verification                                      | Stop-fail                                                      | Approval |
| --- | ------------------------------------- | ---------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- | -------- |
| 1   | Build OK, **image gate fails**        | `verify-server-action-key-gate.sh image` ≠ 0         | Yes — never ships         | gate output (fingerprint only), `docker image inspect` env               | rebuild with the correct 0600 key; fix the fingerprint build-arg                 | gate `PASS` prints the expected fingerprint                        | 2 rebuilds with the same key still fail → stop                 | No       |
| 2   | Gate passes, **readiness fails**      | `/api/health/ready` ≠ 200 for 10 min                 | Yes                       | `curl ready`, container logs, `[readiness]` lines, dependency TCP probes | restore the missing/invalid env; if the image is bad, re-pin the previous digest | readiness 200 **and** `version` == target commit                   | readiness still 503 after restore → stop                       | **Yes**  |
| 3   | **Web/Worker version skew**           | per-task `.version` ≠ `$GITHUB_SHA`                  | Yes                       | `docker service ps`, per-task ready body                                 | roll all roles to one digest; never mix                                          | every task reports one commit; worker key matches                  | skew persists after a full re-pin → stop                       | **Yes**  |
| 4   | **Partial replicas / not converged**  | replicated gate `did not settle`                     | Yes                       | `docker service inspect … UpdateStatus`, `docker ps` by label            | re-run the service update; roll back the digest if it rolls back repeatedly      | desired == running and `UpdateStatus.State` empty/`completed`      | repeated `rollback_*` states → stop                            | **Yes**  |
| 5   | **Migration fails**                   | `migrate` ≠ 0                                        | Yes — before rollout      | `select * from drizzle.__drizzle_migrations order by created_at desc`    | **forward fix**: add a corrective migration. No down-migration exists            | ledger matches the expected count; `validateMigrationState` passes | ledger "ahead of checkout" or drift → **stop, restore backup** | **Yes**  |
| 6   | Fault **after** new data was written  | new rows/objects exist and the rollback is requested | Yes — freeze writes first | new rows since deploy time; object key listing                           | forward fix preferred; if rollback unavoidable, restore the **verified backup**  | row counts + object SHA-256 set before/after                       | any unexplained row/object delta → stop                        | **Yes**  |
| 7   | **Server Action key mismatch**        | replica fingerprints differ                          | Yes                       | gate `fingerprint` per instance (never the key)                          | one digest + one key everywhere; or a **single** identical runtime override      | all fingerprints equal; readiness 200                              | mismatch persists → stop                                       | **Yes**  |
| 8   | **Rollback → key mismatch**           | old image embedded a different key                   | Yes                       | gate `image <old> <new fingerprint>` (verified: exit 1)                  | set one runtime override identical across old and new, export-import the key     | `compare` passes for every instance of both builds                 | actions fail cross-instance → stop                             | **Yes**  |
| 9   | **Jobs queued, worker not consuming** | queue depth rising, worker logs ECONNREFUSED         | Yes                       | `redis-cli -n <db> llen`, worker log errors                              | restore Redis/worker; **never** purge the queue blindly                          | depth drains to 0 after recovery; payload preserved                | jobs lost or depth stuck → stop                                | **Yes**  |
| 10  | **Storage/database inconsistency**    | `headObject` null for a referenced key               | Yes                       | `headObject` per referenced key; bucket listing                          | re-upload from the authoritative source; never fabricate metadata                | object SHA-256 matches the stored metadata                         | objects missing with no source → **stop**                      | **Yes**  |

**Explicitly rejected:** "roll the database back". There is no down path, 12
migrations drop objects, and `migrate` refuses to run against a newer ledger. The
only sanctioned database remedies are **forward fix** or **verified backup
restore**.

---

## 3. Defect found and fixed (EA-8)

### E-8a — a half-rolled-out fleet passed the deploy gate (HIGH)

**Reproduced live.** Two isolated instances were started on the drill database:

```
:4100 -> {"status":"ready","version":"deadbeef…#"}   (new build)
:4102 -> {"status":"ready","version":"1111…#"}       (old build)
```

Both healthy, both 200, **different commits**. The deployment's only version
check is a single `curl` of `$APP_URL/api/health/ready`; the load balancer can
route it to any task. The replicated step checked the Server Action **key** but
never the version.

**Fix.** `verify_replicas` now accepts an optional expected commit and each
`verify_replica` asserts `.version` from the same readiness body it already
fetches; the workflow passes `"$GITHUB_SHA"`. A mismatch fails with
`reports version '<observed>', expected '<commit>'`.

**Negative evidence.** Against the two live instances, expecting `deadbeef…`
refused `1111…` exactly:

```
REFUSED: reports version '1111111111111111111111111111111111111111',
         expected 'deadbeefea8deadbeefea8deadbeefea8deadbe'
```

Fixtures 12 and 13 of `verify-server-action-key-gate.test.sh` pin both the
rejection and the acceptance.

---

## 4. Phase D — executed fault injections

All resources were isolated: database `ea8_drill_test` (dropped at the end),
Redis DB index **9** (dev uses 0), containers named `ea8-*` on ports 4100–4104,
and keys generated in `/tmp` with mode 600.

| Scenario                        | Injection                                                       | Gate/state behaved as expected                                      | Recovery                                   | Result                  |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ | ----------------------- |
| D-1 wrong key fingerprint       | gate `image` with a foreign fingerprint on a real image         | exit **1**, `fingerprint mismatch`                                  | n/a — nothing shipped                      | **PASS**                |
| D-2a Redis unreachable          | instance with `REDIS_URL` pointing at a dead port               | readiness **503 `unavailable`**                                     | restore URL → 200                          | **PASS**                |
| D-2b invalid runtime key        | `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=not-a-valid-key`            | readiness **503** (does not silently override the build key)        | remove the override → 200                  | **PASS**                |
| D-3 version skew                | two instances, different digests **and** versions               | both `ready`; **deploy gate defect → fixed (E-8a)**                 | per-task version assertion now refuses     | **PASS after fix**      |
| D-4 not converged               | `replicas` against a non-existent stack                         | waits 300 s then exit **1**, `did not settle … refusing to certify` | n/a                                        | **PASS**                |
| D-5 app fails to start          | required env missing (`R2_INTERNAL_ENDPOINT`)                   | readiness **500**, `/login` **500** (module-eval failure)           | add the env → 200                          | **PASS**                |
| D-6a migration idempotence      | run `migrate` twice                                             | second run exit 0, ledger valid                                     | n/a                                        | **PASS**                |
| D-6b **database ahead of code** | injected a future ledger row                                    | `migrate` exit **1**, `Migration tracker is ahead of this checkout` | delete the row → exit 0                    | **PASS**                |
| D-8 queue unavailable           | worker with a dead `REDIS_URL`                                  | every queue logs `ECONNREFUSED`; no silent idle                     | restore Redis                              | **PASS**                |
| D-9 jobs queued, no consumer    | pushed a job into Redis DB 9                                    | depth stays **1** after 3 s (no loss); payload byte-identical       | consumer drains to 0                       | **PASS**                |
| D-10 storage gate fail-closed   | write with a non-tenant key, then a tenant without a freeze row | `STORAGE_TENANT_UNKNOWN`, then `STORAGE_FREEZE_STATE_UNKNOWN`       | would need the real instrumentation reader | **BLOCKED** (see below) |

### D-10 note — why BLOCKED, not PASS

The storage package refuses writes unless the process registers a freeze-state
reader (`packages/storage/src/gate-registry.ts`), which production installs via
the app/worker instrumentation. Driving a write from a standalone script cannot
register it **without bypassing a product control**, which the phase rules
forbid. The positive evidence kept is that both refusals are correct fail-closed
behaviour; the full object/metadata round-trip was **not** executed here and is
recorded as BLOCKED, not as a pass.

### D-6b note — an application-level gap worth recording

An **old** image started against a database containing a future migration
reported `{"status":"ready", ...}` **200**. The migrator catches it (proven
above), and migrations run as a separate step **before** the rollout, so the
deploy chain is protected. But a _manually_ re-pinned old image would come up
green against a newer schema. Recorded as a residual risk (§7 R-3); not fixed
here because adding a schema-version check to readiness is a product decision.

---

## 5. Phase E — consistency before/after

Database fingerprint, taken before any injection and again after all of them:

| Metric      | Before | After | Verdict                                            |
| ----------- | ------ | ----- | -------------------------------------------------- |
| migrations  | 50     | 50    | SAME                                               |
| tables      | 211    | 211   | SAME                                               |
| RLS enabled | 191    | 191   | SAME                                               |
| policies    | 194    | 194   | SAME                                               |
| documents   | 0      | 0     | SAME                                               |
| attachments | 0      | 0     | SAME                                               |
| tenants     | 0      | 1     | CHANGED — the drill tenant I inserted deliberately |

Redis: dev DB 0 held **67** keys throughout; the drill used DB 9 only and it was
flushed to 0.

**Rollback (#8) specifically:** the old image stayed `200` with its own version
after the new instance was removed, and the gate **refused** to certify the old
image against the new build's key (`exit 1`, `fingerprint mismatch`) — the
cross-build key divergence (`9602b7…` vs `c7840d…`) is real and must be handled
with one identical runtime override before any cross-build rollback.

Distinguishing the three outcomes, as required:

- **Code rollback:** PASS — re-pinning a digest is deterministic and the gate verifies the artifact.
- **Service recovery:** PASS — readiness, `/login` and per-task version return to the expected state (D-2, D-5).
- **Data recovery:** PARTIAL — schema undamaged and the ledger guard proven; a full object/metadata round-trip is **BLOCKED** (D-10) and real backup-restore was **NOT RUN**.

---

## 6. Phase D (gates) — regression

| Command                                                       | Exit | Pass                                                    | Time |
| ------------------------------------------------------------- | ---- | ------------------------------------------------------- | ---- |
| `bash scripts/ci/verify-server-action-key-gate.test.sh`       | 0    | 13                                                      | <1 s |
| contract + fingerprint CLI (vitest)                           | 0    | 26                                                      | <1 s |
| `pnpm format:check` / `typecheck` / `lint` / `deadcode:check` | 0    | —                                                       | —    |
| `pnpm test`                                                   | 0    | web 2107 passed / 8 skipped; db 506 passed / 41 skipped | —    |
| `pnpm build`                                                  | 0    | 4/4 tasks                                               | —    |

The build-entry acceptance suite (real image build) was **not** re-run: this
phase changed only the replica gate, the workflow and tests — not the build
entry points it covers.

---

## 7. Residual risks

| ID  | Risk                                                                   | Level    | Status                                                                    |
| --- | ---------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| R-1 | Real deployment rollback (digest re-pin on Dokploy/Swarm)              | **High** | **NOT RUN** — needs an authorized two-step deploy                         |
| R-2 | Verified backup restore (database + object store)                      | **High** | **NOT RUN** — no restore was exercised against real data                  |
| R-3 | Old image starts `ready` against a newer schema when re-pinned by hand | Medium   | Recorded; migrator guard protects the chain, readiness does not           |
| R-4 | Cross-build key divergence on rollback                                 | Medium   | Characterised (`9602b7…` vs `c7840d…`); needs one shared runtime override |
| R-5 | Multi-node Swarm replica coverage                                      | **High** | **NOT RUN**                                                               |
| R-6 | GHCR / GHA cache path                                                  | Medium   | **NOT RUN**                                                               |
| R-7 | Drill transport / recreate / probe                                     | Medium   | **NOT RUN**                                                               |
| R-8 | Object/metadata round-trip under a real gate reader                    | Medium   | **BLOCKED** this phase                                                    |
| R-9 | WOPI frozen re-open                                                    | Low      | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`                |

---

## 8. Resources created and cleaned

| Resource                                                                                    | Cleanup                           |
| ------------------------------------------------------------------------------------------- | --------------------------------- |
| Database `ea8_drill_test` (+ drill tenant, freeze row)                                      | `DROP DATABASE` — verified absent |
| Redis DB 9 (drill namespace)                                                                | `FLUSHDB` → dbsize 0              |
| Containers `ea8-web`, `ea8-web-noredis`, `ea8-web-old`, `ea8-web-newerschema`, `ea8-badkey` | All `docker rm -f` — 0 remain     |
| `/tmp/ea8*` (keys, logs, scripts, fingerprints, tenant id)                                  | 24 entries removed — 0 remain     |
| Temporary `packages/storage/src/ea8-drill-object-consistency.test.ts`                       | Deleted                           |
| Dev DB `beaconhs`, Redis DB 0 (67 keys), MinIO, existing images                             | Untouched                         |
| Drill / `phase-aj` / production                                                             | Never contacted                   |

---

## 9. Final state

```
branch                -> hse-platform (unchanged)
HEAD                  -> 51a899b7aac0a942da327222a3eed355fca9798a (unchanged)
staged                -> 0
modified / untracked  -> 154 / 467
git diff --stat       -> 154 files changed, 5134 insertions(+), 1919 deletions(-)
```

Files changed **by this phase**:

- `scripts/ci/verify-server-action-key-gate.sh` (untracked) — per-replica commit assertion.
- `scripts/ci/verify-server-action-key-gate.test.sh` (untracked) — fixtures 12–13.
- `.github/workflows/deploy-dev.yml` — passes `"$GITHUB_SHA"` to the replica gate; step renamed and documented.
- `apps/web/src/lib/server-action-key-deployment-contract.test.ts` (untracked) — one new contract test (16 → 17).
- `docs/phase-6u-b3-ea8-rollback-drill.md` (this report).

---

## 10. Conclusion

**LOCAL RELEASE CANDIDATE: PASS** — upheld. One high-severity defect (half-rolled
fleet passing the gate) was found by the drill and fixed with a negative fixture;
all six gates pass.

**Real deployment rollback: NOT RUN.** A rollback plan and decision table now
exist, but re-pinning a digest on the real platform, restoring a verified backup,
and multi-node behaviour remain unverified and require separate authorization.
