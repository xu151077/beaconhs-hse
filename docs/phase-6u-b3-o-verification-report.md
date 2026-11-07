# Phase 6U-B3-O — P0 Minimal Fixes and Isolated Regression

**Status:** complete for the three P0 items. **G2 remains `BLOCKED`** (see §8).
**Date:** 2026-10-14
**Branch / HEAD:** `hse-platform` @ `51a899b7aac0a942da327222a3eed355fca9798a` (matches the expected baseline; no reset, no rebase)

---

## 1. Baseline and working-tree protection

- HEAD verified before any edit: `51a899b7aac0a942da327222a3eed355fca9798a`. Unchanged.
- Pre-existing WIP at phase start: **182** changed/untracked entries. Preserved throughout.
- Working tree at phase end: **186** entries (report + the source/test files listed in §5).
- No commit, push, stage, reset, restore, clean, or branch switch was performed.
- No schema change and no new migration. `packages/db/drizzle/` is untouched.

### 1.1 One build-infrastructure defect found and fixed (was blocking O-2)

The first isolated image build failed on `pnpm install --frozen-lockfile`:

```
specifiers in the lockfile don't match specifiers in package.json:
* 1 dependencies were removed: vite-tsconfig-paths@^6.1.1
```

The lockfile carried a `vite-tsconfig-paths` entry that `apps/web/package.json` no longer
declares — a pre-existing WIP drift, not a Phase O change. Fixed at source with
`pnpm install --lockfile-only`, which removed the orphan importer entry. Without this,
**no image could be built at all**, so it was a hard prerequisite for O-2.

`pnpm-lock.yaml` is the only file touched that was not part of a P0 fix.

---

## 2. Root causes of the three P0 defects

### P0-1 — WOPI PutFile returned HTTP 200 while storage was frozen

Two independent causes, both required fixing:

1. **Wrong exception contract.** The route's catch tested
   `error.message.includes('STORAGE_WRITE_BLOCKED')`. The gate never throws that string;
   it throws `StorageWriteBlockedError` whose `code` is `STORAGE_FROZEN`. The predicate
   therefore never matched, the error escaped, and Next rendered **500** (in the deployed
   image) or the stale 200 path. Matching on message text was the defect.
2. **Gate wiring never registered in the web process.** `bootstrapStorageFreezeGate()`
   loaded `@beaconhs/storage` via a _dynamic_ import. That bare specifier is not resolvable
   from the Next.js standalone output (no `node_modules/@beaconhs/*` on disk), so the
   bootstrap silently caught the failure and left the gate unregistered. With no reader
   installed the gate fails closed — which is why the observed symptom was a _hard_ refusal
   (`STORAGE_FREEZE_STATE_UNKNOWN`), not a silent allow.

### P0-2 — Deployed image lacked the expected implementations

The image was built from a source tree that predated `freeze-gate.ts`, `write-arms.ts` and
the `storage_write_arms_reconcile` schedule, while `APP_VERSION` still matched HEAD. The
version string was therefore **not** evidence of content, exactly as the phase brief warned.

A second, independent wiring bug also surfaced: `packages/storage/src/index.ts` imported
the write-arm registry but never re-exported `./write-arms`. `bootstrapStorageFreezeGate()`
looks up `registerStorageWriteArmIssuer` on the loaded module; the export was absent, so the
issuer was never installed and `presignPut` failed with
`STORAGE_WRITE_BLOCKED: presigned write arm issuer not registered` even in a warm process.

### P0-3 — `DRAINING → FROZEN` permanently blocked by `FREEZE_DRAIN_UNVERIFIED`

`evaluateTransition` refused `FROZEN` unconditionally: `DrainVerification` was typed
`undefined` and the guard was unconditional by design ("no value is acceptable" until the
evidence existed). No code produced drain evidence, so the closed loop could never complete.
No weakening was required — the evidence was implemented instead.

---

## 3. Minimal fixes

### 3.1 WOPI freeze gate (P0-1)

- **`packages/storage/src/freeze-gate.ts`** — added `isStorageWriteBlockedError()`. Uses
  `instanceof` first, with a deliberately narrow structural fallback (name + `STORAGE_*` code
  - a known gated operation must all agree) for duplicated module instances across a bundler
    boundary. An arbitrary exception merely _mentioning_ storage is never converted to 423.
- **`apps/web/src/lib/wopi-storage-refusal.ts`** (new) — single mapping point. Maps **only**
  `STORAGE_FROZEN` → 423. `STORAGE_FREEZE_STATE_UNKNOWN` deliberately returns `null` so an
  outage or broken deploy surfaces as a server error rather than masquerading as a policy lock.
- **`apps/web/src/app/wopi/files/[fileId]/contents/route.ts`** — catch now uses the typed
  helper. On a refusal it returns 423 **without** calling the gated delete path (the staged
  object was never created, and a gated delete would itself be refused and turn a clean 423
  into a 500). Identity, tenant, permission and audit behaviour are unchanged.
- **`apps/web/src/instrumentation.ts`** — passes the statically bundled storage module into
  `bootstrapStorageFreezeGate(storage)`.
- **`packages/db/src/storage-freeze-operations.ts`** — `bootstrapStorageFreezeGate` now accepts
  an optional module argument, keeps the dynamic import as the default (worker path), and
  **logs** a load failure instead of swallowing it silently.

### 3.2 Process-wide gate registry (the fix that actually made P0-1 work at runtime)

Evidence of the problem: three separate Next server chunks each embedded the storage gate
(`chunks/_1dn1t2e._.js`, `chunks/ssr/packages_storage_src_1nij0cd._.js`,
`chunks/packages_storage_src_index_ts_1rfgnhs._.js`). Instrumentation and the WOPI route were
registering and reading **different module instances**, so even a working static import left
the route's gate unregistered.

- **`packages/storage/src/gate-registry.ts`** (new) — `Symbol.for('beaconhs.storage.gate.registry')`
  holds reader, in-flight tracker and write-arm issuer. Shared across duplicate copies in one
  Node process; isolated between processes. `freeze-gate.ts` and `write-arms.ts` now read/write
  through it instead of module-local variables.

### 3.3 Runtime/source consistency (P0-2)

- **`packages/storage/src/index.ts`** — added `export * from './write-arms'`, so
  `registerStorageWriteArmIssuer` is actually reachable by the bootstrap.
- Rebuilt and deployed from the working tree on the isolated host; verified by in-container
  file inspection, Redis schedule keys and worker logs — never by the `APP_VERSION` string.

### 3.4 Drain verification (P0-3)

- **`packages/db/src/storage-freeze.ts`** — `DrainVerification` is now a real snapshot type
  (`inFlightCount`, `unresolvedArmCount`, `waitUntil`, `verifiedAt`). `evaluateTransition`
  accepts `FROZEN` only when both counters are exactly `0` and any arm-expiry grace has
  elapsed. Missing, negative, fractional or malformed evidence still yields
  `FREEZE_DRAIN_UNVERIFIED` with the same stable code.
- **`packages/db/src/storage-freeze-operations.ts`** — `applyTransition` takes
  `SELECT … FOR UPDATE` on the freeze row and computes the snapshot **inside that
  transaction**. A caller cannot assert evidence; it does not accept a drain argument at all.
  Reuses `readStorageFreezeDrainStatus` via a dynamic import, so the drain predicate has one
  implementation instead of two.
- **`registerInFlightWrite`** now takes the same freeze-row lock before inserting, so a
  freeze transition either sees the write in its count or wins first and refuses registration.

### 3.5 Correctness defects found by review and fixed alongside the P0s

These were live defects that the P0 fixes would otherwise have inherited:

| Defect                                                                                                                                                                                         | Fix                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `presignPut` stamped the **arm** token into object metadata and discarded the caller's token, so `finalizeUpload` verification could never match and **every** non-multipart upload would fail | Threaded `uploadToken` through `StorageWriteArmIssuer.issue` → arm row → signed metadata                                                        |
| DB adapter read `args.expiresInSeconds` while storage sends `requestedExpiresInSeconds`, so a 1-second request silently became the 120-second default                                          | Corrected the field name; arm now honours the caller's TTL                                                                                      |
| In-flight completion matched on `(tenantId, key)`, so two concurrent same-key writes could close each other and let `DRAINING → FROZEN` commit over a live write                               | Completion identity is now the record id returned by `register`                                                                                 |
| `countInFlightWrites` swallowed errors inside a transaction, surfacing a raw driver error instead of a stable freeze code                                                                      | Errors propagate; the rule layer still fails closed on a non-zero count                                                                         |
| `storage_freeze.tenant_id` had no unique constraint (B3), so `ensureFreezeRow`'s `ON CONFLICT DO NOTHING` could never fire                                                                     | **Not fixed — schema change is out of scope.** Compensated fail-closed: reads and transitions now detect >1 row and refuse rather than guessing |

### 3.6 TTL drift

- **`packages/storage/src/index.ts`** exports `MAX_PRESIGN_PUT_EXPIRES_SECONDS` (120) and
  `MAX_PRESIGN_MULTIPART_PART_EXPIRES_SECONDS` (60).
- **`apps/web/src/lib/uploads.ts`** now imports those constants instead of hard-coding
  `300` and `3600`, which the server-side caps rejected. Drift can no longer recur.

---

## 4. Tests

### 4.1 New / changed regression coverage

| Test                                                  | Covers                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/wopi-storage-refusal.test.ts` (new) | `ACTIVE` passes through; every non-ACTIVE state → 423; indeterminate read → **not** 423                                                                                                                                                             |
| `packages/storage/src/freeze-gate.test.ts`            | Refusal classification accepts the real error and an identical bundled copy; rejects message-only and wrong-operation decoys                                                                                                                        |
| `packages/storage/src/presign-arm-control.test.ts`    | Shared TTL caps; caller upload token preserved for finalisation verification                                                                                                                                                                        |
| `packages/db/src/storage-freeze.test.ts`              | Accepts `DRAINING → FROZEN` only on a complete snapshot; refuses non-zero counts, negative/fractional counts, future grace and malformed untyped evidence                                                                                           |
| `packages/db/src/storage-freeze-operations.test.ts`   | Real DB: refuses `FROZEN` while an arm is unresolved and grace has not elapsed, succeeds after terminalising; same-key sibling writes are not closed by each other; injected bundled module registers all three adapters; empty module fails closed |
| `apps/web/.../contents/route.test.ts`                 | Frozen PutFile → 423 **with attachment key/timestamp and object store byte-identical before and after**                                                                                                                                             |

### 4.2 Commands and results

Targeted:

| Command                                             | Result                                 |
| --------------------------------------------------- | -------------------------------------- |
| `pnpm --filter @beaconhs/storage test`              | 12 files, **134 passed**               |
| `pnpm --filter @beaconhs/db test` (with scratch DB) | 62 files, **498 passed / 36 skipped**  |
| `storage-freeze-operations.test.ts` on scratch DB   | **16 passed**                          |
| `pnpm --filter @beaconhs/web test`                  | 233 files, **2007 passed / 5 skipped** |
| WOPI route + refusal tests on scratch DB            | **13 passed**                          |
| `pnpm --filter @beaconhs/worker test`               | 27 files, **103 passed**               |
| `pnpm --filter @beaconhs/jobs test`                 | 4 files, **19 passed**                 |

Full gate set, each with its **own captured exit code**:

| Gate                  | Exit code                 |
| --------------------- | ------------------------- |
| `pnpm format:check`   | **0**                     |
| `pnpm typecheck`      | **0**                     |
| `pnpm lint`           | **0**                     |
| `pnpm test`           | **0** (25/25 turbo tasks) |
| `pnpm deadcode:check` | **0**                     |
| `pnpm build`          | **0**                     |

DB-backed suites were additionally executed against a throwaway `beaconhs_phase_o_scratch`
database over an SSH tunnel (created, migrated with the existing 47-migration journal, and
dropped afterwards). They are skipped in normal local runs by repo convention — that skip is
reported, not counted as a pass.

---

## 5. Files changed

Modified:

- `packages/storage/src/index.ts`
- `packages/storage/src/freeze-gate.ts`
- `packages/storage/src/write-arms.ts`
- `packages/db/src/storage-freeze.ts`
- `packages/db/src/storage-freeze-operations.ts`
- `apps/web/src/lib/uploads.ts`
- `apps/web/src/lib/wopi-storage-refusal.ts` (new)
- `apps/web/src/app/wopi/files/[fileId]/contents/route.ts`
- `apps/web/src/instrumentation.ts`
- `pnpm-lock.yaml` (lockfile-consistency fix only — see §1.1)

Tests:

- `packages/storage/src/freeze-gate.test.ts`
- `packages/storage/src/presign-arm-control.test.ts`
- `packages/db/src/storage-freeze.test.ts`
- `packages/db/src/storage-freeze-operations.test.ts`
- `apps/web/src/lib/wopi-storage-refusal.test.ts` (new)
- `apps/web/src/app/wopi/files/[fileId]/contents/route.test.ts`

Report:

- `docs/phase-6u-b3-o-verification-report.md` (this file, new)

**No manual article or walkthrough step changed** — no user-facing feature, route, button or
labelled flow was added or renamed. The existing knowledge-assets article already documents
the "workspace unavailable, administrator must restore" behaviour that 423 now actually
enforces, so it is now accurate rather than aspirational.

---

## 6. Isolated runtime evidence

Host: `10.10.31.30` (SSH alias `beaconhs-drill`, user `ceshi`). Dedicated fixture tenant
`7f0c9d21-4c8e-4a1b-9d2e-6b3a5f7c9e01`, with its own document and attachment. The pre-existing
`drill` tenant was not modified.

### 6.1 Image and wiring

| Evidence                                                    | Value                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Deployed image (web **and** worker)                         | `sha256:22e505495882825eef564dbbf7c2c92d2725a810de1a519dcff83cee81dac501` |
| `/api/health/ready`                                         | `{"status":"ready","version":"51a899b7aac0a942da327222a3eed355fca9798a"}` |
| `freeze-gate.ts` / `write-arms.ts` present in worker deploy | yes                                                                       |
| `storage_write_arms` occurrences in `dist/index.js`         | 22                                                                        |
| Redis repeatable key                                        | `bull:scheduled:repeat:tick-storage-write-arms`                           |
| Gate registry found in                                      | 3 distinct Next server chunks (the duplication the fix addresses)         |
| Containers touched                                          | `web`, `worker` only — postgres/redis/minio/collabora/mailpit untouched   |

### 6.2 WOPI PutFile by freeze state (real HTTP against the running app)

| Freeze state              | HTTP    | Attachment key             | Attachment `updated_at` |
| ------------------------- | ------- | -------------------------- | ----------------------- |
| `ACTIVE` (baseline)       | **200** | advanced to new staged key | advanced                |
| `FREEZE_REQUESTED`        | **423** | unchanged                  | unchanged               |
| `DRAINING`                | **423** | unchanged                  | unchanged               |
| `FROZEN`                  | **423** | unchanged                  | unchanged               |
| `RECONCILING`             | **423** | —                          | —                       |
| `FAILED`                  | **423** | —                          | —                       |
| `RECOVERY_REQUIRED`       | **423** | —                          | —                       |
| `ACTIVE` (after recovery) | **200** | advanced to new staged key | advanced                |

Body on every refusal: `Workspace unavailable`. Attachment key and timestamp were captured
from Postgres before and after each attempt and were byte-identical, proving a refused write
changes no content, version or metadata.

### 6.3 Presigned URL expiry, issued by the application

| Case                                                          | Result                                               |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| Presigned PUT, `X-Amz-Expires=1`, used immediately            | **HTTP 200**, object metadata `upload-token` present |
| Presigned PUT, `X-Amz-Expires=1`, used after 2.1 s            | **HTTP 403**, `AccessDenied`, `Request has expired`  |
| Presigned multipart part, `X-Amz-Expires=1`, used after 2.1 s | **HTTP 403**, `Request has expired`                  |

The 1-second `X-Amz-Expires` in the URL matching the requested TTL is itself the proof that
the corrected `requestedExpiresInSeconds` field reaches the arm row.

### 6.4 Freeze drain and write-arm reconciliation

| Step                                         | Observed                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTIVE` with 1 open in-flight write, 4 arms | `drain.ready = false` (`inFlightCount 1`, `unresolvedArmCount 0`)                                                                                       |
| `→ FREEZE_REQUESTED`                         | `v1`; `presignPut` and `presignMultipartPart` both refused `STORAGE_FROZEN`                                                                             |
| `→ DRAINING`                                 | `v2`; new URLs still refused                                                                                                                            |
| `DRAINING → FROZEN` attempt                  | **refused**, `FREEZE_DRAIN_UNVERIFIED` — _"requesting a freeze is not the same as being frozen"_                                                        |
| In-flight write terminalised                 | `drain.ready = true` (`inFlightCount 0`, `unresolvedArmCount 0`)                                                                                        |
| `DRAINING → FROZEN` retry                    | **succeeded**, `v3`; persisted evidence `{"drain":{"inFlightCount":0,"unresolvedArmCount":0,"waitUntil":null,"verifiedAt":"2026-10-14T09:40:15.184Z"}}` |
| Arm reconciliation tick                      | `presignPut\|redeemed_confirmed 1`, `presignPut\|redeemed_nop 1`, `presignPut\|quarantined 1`, `presignMultipartPart\|redeemed_nop 1`                   |
| Full cycle                                   | `ACTIVE → FREEZE_REQUESTED → DRAINING → FROZEN → RECONCILING → ACTIVE`, `v11`, manifest hash recorded, lease released (`lease_holder_id = null`)        |

All four arm outcomes were driven by real object state (written, missing, metadata-mismatched,
multipart-only), not by direct state edits.

### 6.5 Cleanup

Tenant, document, attachment, freeze row, arms, in-flight rows and deletion-outbox rows all
returned to `0`. The 3 staged WOPI objects were purged (`deleted=3 remaining=0`). The
`storage_write_arms` table is empty for every tenant. The pre-existing `drill` tenant is
unmodified.

---

## 7. Defects discovered and fixed during this phase

Beyond the three P0s: the arm-token/caller-token metadata mismatch (would have broken every
upload), the `expiresInSeconds` field-name bug, same-key in-flight completion aliasing, the
swallowed in-flight count error, the missing `write-arms` export, and the cross-chunk gate
registry split. The lockfile drift in §1.1 was also fixed.

## 8. G2 decision — still `BLOCKED`

G2 is **not** unblocked by this phase. Improved, but incomplete:

| Item                                       | Before                          | After Phase O                                   |
| ------------------------------------------ | ------------------------------- | ----------------------------------------------- |
| WOPI PutFile under freeze                  | `FAIL`                          | **PASS** (isolated, 7 states)                   |
| Freeze / in-flight drain                   | `FAIL`                          | **PASS** (isolated full cycle)                  |
| `DRAINING → FROZEN`                        | `FAIL`                          | **PASS** (isolated, DB-computed evidence)       |
| PUT expiry — MinIO protocol                | `PASS`                          | `PASS`                                          |
| PUT expiry — application linkage           | `FAIL`                          | **PASS** (isolated)                             |
| Multipart expiry — application linkage     | `FAIL`                          | **PASS** (isolated)                             |
| Arm reconciliation                         | `FAIL`                          | **PASS** (isolated, 4 outcomes)                 |
| Lifecycle expiry execution                 | `NOT RUN`                       | **`NOT RUN`** — unchanged                       |
| External delete permission                 | isolated `PASS`, prod `UNKNOWN` | unchanged                                       |
| Alerts                                     | `NOT RUN`                       | **`NOT RUN`** — no isolated receiver configured |
| Production R2/IAM/bucket/network/Collabora | `UNKNOWN`                       | **`UNKNOWN`** — unchanged                       |

G2 requires production-equivalent evidence that this phase was explicitly forbidden from
gathering. **No independent evidence of lifecycle execution, alert delivery/ACK, or
production storage identity and policy behaviour was obtained.**

## 9. Residual risk and required next steps

1. **`storage_freeze.tenant_id` still lacks a unique constraint.** Duplicate rows are now
   detected and refused (fail-closed), but the underlying invariant is unbacked by the
   schema. A migration adding `uniqueIndex('storage_freeze_tenant_ux')` is required and was
   **not** performed — schema changes were out of scope for this phase.
2. **Multipart part TTL vs. upload duration (review blocker B2, not fixed).** Part URLs are
   capped at 60 s, but `packages/ui` mints every part URL up front and uploads **sequentially**
   in 64 MiB chunks. A 256 MiB file therefore needs ≈34 Mbps sustained inside 60 s; slower
   uplinks will see parts 3..N fail with `403 Request has expired`, with no re-sign path.
   Fixing it properly means lazily minting part URLs just-in-time or adding a per-part refresh
   endpoint — both are API changes beyond this phase's P0 scope. **This is a real product
   defect that is now live.**
3. **Orphaned in-flight writes.** `cleanupOrphanedWrites` exists but has no caller. A crash
   mid-write wedges the tenant in `DRAINING` until manual intervention. The reconciler covers
   arms only.
4. **The scrub DB suites remain CI-skipped.** CI does not set `SEED_TEST_SCRATCH_DATABASE_URL`,
   so the new DB-backed freeze scenarios and the WOPI 423 scenario do not run in CI.
5. **Deployment composition gap.** `bootstrapStorageFreezeGate` still defaults to a dynamic
   import that is unresolvable in the Next standalone output. Any future runtime that does not
   statically pass the storage module will silently fail closed again. The new failure log is
   the only signal.
6. **Not exercised at all:** lifecycle expiry execution, alert delivery, production IAM and
   bucket policy, and production Collabora behaviour.

## 10. Working-tree protection

All 182 pre-existing WIP entries were preserved; no unrelated file was modified, staged,
staged-over, reverted or reformatted. Changes are confined to the files in §5 plus this
report. Nothing was committed or pushed. The Phase N report was not modified.
