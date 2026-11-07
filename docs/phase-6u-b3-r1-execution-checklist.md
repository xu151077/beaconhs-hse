# Phase 6U-B3-R1 — Evidence Collection Execution Checklist

**Status:** PREPARATION ONLY — no production access, no execution
**Date:** 2026-10-15
**Branch:** `hse-platform`
**Expected / Actual HEAD:** `51a899b7aac0a942da327222a3eed355fca9798a` ✅
**G2 Status:** `BLOCKED`
**Companion documents:** `docs/phase-6u-b3-q-evidence-readiness-report.md`,
`docs/phase-6u-b3-r0-authorization-and-readiness-report.md`,
`docs/phase-6u-b3-p0-verification-report.md`

---

## 0. How to use this checklist

This document turns the Phase Q evidence plan and the R0 authorization gate into **executable,
auditable commands** for a _future, separately authorized_ Phase R run. It is a **checklist, not a
script**: every command is a placeholder template that a human runs by hand after the named
authorization checkpoint is satisfied.

**Hard rules for whoever executes this checklist:**

1. **No command runs until its authorization checkpoint (§6) is satisfied in writing.**
2. Every `<PLACEHOLDER>` must be filled from an approved, redacted runbook — never from a live
   secret printed to a terminal, and never from `.env` pasted into a shell history.
3. Credentials are supplied **only via environment variables** the tool already reads
   (`OBJECT_STORE_*` or `R2_*`). Never pass `--access-key`/`--secret-key` as flags (they reach
   argv, the process table, and shell history).
4. Every artifact is piped through redaction (§5) **before** it is stored, and is stored **only**
   at `docs/phase-6u-b3-r/evidence/`.
5. If any step cannot be completed without touching production before its checkpoint is satisfied,
   **STOP** and record the blocker. Do not improvise authorization.

**This checklist contains no runnable script.** No file is created that could auto-target
production. Read-only and mutating operations are strictly separated (§3).

---

## 1. Ordered preflight checks

Run **all** preflight checks before any production scope. They are local-only and safe.

| #   | Preflight check                         | Command / action                                                                  | Pass criteria                    |
| --- | --------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| P1  | Correct branch & HEAD                   | `git branch --show-current` → `hse-platform`; `git rev-parse HEAD` → `51a899b7…`  | Both match expected              |
| P2  | Clean worktree baseline recorded        | `git status --short \| wc -l` and save the number                                 | Number recorded in evidence log  |
| P3  | Evidence directory exists (empty)       | `ls -la docs/phase-6u-b3-r/evidence/` (create if absent, mode 0700)               | Directory present, empty         |
| P4  | Read-only tool present                  | `pnpm --filter @beaconhs/object-store-backup exec -- --help` prints usage, exit 0 | Usage text shown                 |
| P5  | Redaction helpers present               | `command -v jq sha256sum`                                                         | Both found                       |
| P6  | Target endpoint is REDACTED-PLACEHOLDER | Eyeball the runbook: endpoint/bucket are aliases, not live values                 | No live secret/endpoint visible  |
| P7  | Read-only vs mutating confirmed         | Confirm the intended command is in the read-only set (§3A)                        | Command is read-only             |
| P8  | Authorization checkpoint for the scope  | See §6 — the specific scope's written authorization exists                        | Authorization reference recorded |
| P9  | Rollback plan present                   | See §7                                                                            | Rollback owner + steps recorded  |

**If any preflight fails, STOP.** Do not proceed to §4–§8.

---

## 2. Evidence categories mapped to commands

The 6 evidence categories from Phase Q, mapped to the verified tooling.

| Category (from Q)               | Scope(s) | Read-only command (verified)                                     | In-workspace tool              | Notes                                                                  |
| ------------------------------- | -------- | ---------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| 1. R2 bucket identity           | Scope 1  | `inventory` (bucket_exists, endpoint redacted)                   | ✅ `object-store-backup`       | Confirms bucket exists + host suffix; **not** authoritative account id |
| 2. IAM & bucket policy          | Scope 2  | **none in-workspace**                                            | ❌ no `GetBucketPolicy` reader | Cloudflare console / IaC / bespoke reader only                         |
| 3a. Lifecycle config            | Scope 3  | `inventory` (lifecycle sha256) + `readBucketLifecycle` (raw XML) | ✅ `object-store-backup`       | sha256 + Status/Filter/Expiration compare                              |
| 3b. Lifecycle actual expiration | Scope 6  | none (mutating)                                                  | ❌                             | Requires disposable object + wait; SEPARATELY authorized               |
| 4. Network access paths         | Scope 4  | none (connectivity test)                                         | ❌                             | Denial/connection test; SEPARATELY authorized                          |
| 5. Collabora/WOPI               | Scope 7  | none (production)                                                | ❌                             | Production Collabora; SEPARATELY authorized                            |
| 6. Alert delivery/ACK           | Scope 8  | none (production)                                                | ❌                             | Production integration test; SEPARATELY authorized                     |

**Gap to record (not fix here):** there is **no in-workspace reader for bucket policy / effective
IAM**. Category 2 has no `GetBucketPolicy`-based tool; it requires the Cloudflare console/IaC or a
new, reviewed reader. Do not assume the backup tool covers scope 2.

---

## 3. Operation classification (read-only vs mutating)

### 3A. READ-ONLY — permitted once its scope is authorized

These never write, never delete, never trigger expiry. (Confirmed against source.)

| Command                                           | Effect                                                                               | Source basis                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| `object-store-backup inventory`                   | Counts objects/bytes + reads lifecycle sha256; writes only the local `--output` JSON | `inventory.ts` — "read-only … always first" |
| `object-store-backup inventory --diff <baseline>` | Compares live keys/sizes vs baseline; **never writes, never deletes**                | `diff.ts` — "THIS COMMAND NEVER WRITES"     |
| `object-store-backup verify --backup-dir <dir>`   | Re-checks an existing local backup vs its manifest; no network write                 | `verify.ts`                                 |
| Cloudflare console / IaC **read** views           | Read-only identity/policy/lifecycle inspection                                       | Console/IaC (manual)                        |

### 3B. MUTATING — each needs explicit, separate authorization and a future dedicated plan

These change state. They are **out of R1-PREP** and require their own rollback plan (§7).

| Operation                                  | Scope   | Why mutating                                            |
| ------------------------------------------ | ------- | ------------------------------------------------------- |
| Production network connectivity probe      | Scope 4 | Generates outbound traffic; may create connection state |
| Create disposable object / test prefix     | Scope 5 | Writes an object                                        |
| Delete object                              | Scope 6 | Removes data                                            |
| Trigger lifecycle expiration / shorten TTL | Scope 6 | Causes deletion                                         |
| Collabora/WOPI write against production    | Scope 7 | Writes document content                                 |
| Send / acknowledge test alert              | Scope 8 | Sends external message                                  |

---

## 4. Command templates (placeholders only — NOT executed here)

> **Do not run any command in this section until its §6 checkpoint is satisfied.** All values are
> `<PLACEHOLDER>`. Credentials come from the environment, never flags.

### 4.1 Preflight (local, safe — already permitted)

```bash
# P1/P2 — record baseline
git branch --show-current               # hse-platform
git rev-parse HEAD                       # 51a899b7aac0a942da327222a3eed355fca9798a
git status --short | tee /tmp/r1-worktree-baseline.txt | wc -l

# P4 — confirm the read-only tool is present and shows usage
pnpm --filter @beaconhs/object-store-backup exec -- --help

# P5 → confirm redaction helpers present (see §5)
command -v jq && command -v sha256sum
```

### 4.2 Scope 1 — R2 bucket identity (READ-ONLY) — **[AUTHORIZATION CHECKPOINT §6.1]**

```bash
# Credentials via environment only. Endpoint/bucket are aliases.
# This writes ONLY the local --output JSON; it never writes to the store.
pnpm --filter @beaconhs/object-store-backup exec -- inventory \
  --endpoint "<R2_ENDPOINT_ALIAS>" \
  --bucket "<PROD_BUCKET_ALIAS>" \
  --output "docs/phase-6u-b3-r/evidence/01-identity-inventory-<YYYY-MM-DD>.json"

# Confirm the report's endpoint redaction and bucket-exists flag:
jq '{bucket_exists, source, lifecycle_status: .lifecycle.status}' \
  "docs/phase-6u-b3-r/evidence/01-identity-inventory-<YYYY-MM-DD>.json"
```

**Expected:** `bucket_exists: true`, `source.endpoint` already scheme://host:port (no userinfo/query),
`lifecycle.status` in {`captured`,`none`,`unsupported`}.
**Failure criteria:** `bucket_exists: false` (wrong alias or no identity), or the tool errors on
credential resolution (`ConfigError`) — STOP, do not retry with flag-pasted keys.

### 4.3 Scope 3 — Lifecycle configuration (READ-ONLY) — **[AUTHORIZATION CHECKPOINT §6.3]**

```bash
# inventory already captured lifecycle sha256 in §4.2. Capture the raw rule detail too
# via an authorized console/IaC readout, then compare against the managed rule spec.
# The sha256 in the §4.2 report is the integrity anchor for this configuration.

# Compare captured lifecycle sha256 to a known-good managed baseline (if recorded):
sha256sum "docs/phase-6u-b3-r/evidence/01-identity-inventory-<YYYY-MM-DD>.json"
# Then, using the redacted console/IaC XML, verify Status/Filter/Expiration only.
# NOTE: do NOT require AbortIncompleteMultipartUpload parity — MinIO never returns it
# (packages/storage/src/lifecycle.ts comparison already excludes it for compatibility).
jq 'walk(if type=="object" then del(.AccountId) else . end)' \
  "<redacted-lifecycle-xml-readout>.json" \
  > "docs/phase-6u-b3-r/evidence/03-lifecycle-config-<YYYY-MM-DD>.redacted.json"
```

**Expected:** Lifecycle rules match `withManagedStorageLifecycleRules` on `Status`, `Filter`,
`Expiration`; sha256 recorded. **Failure:** any Status/Filter/Expiration mismatch → DRIFT finding,
record, do not fix.

### 4.4 Scope 2 — IAM / bucket policy (READ-ONLY) — **[AUTHORIZATION CHECKPOINT §6.2]**

> **No in-workspace tool reads bucket policy.** Use the Cloudflare console or IaC, or a **new,
> separately reviewed** `GetBucketPolicy` reader. Do not write one now.

```bash
# Manual, redacted console/IaC readout. Never paste principal ARNs or keys raw.
jq 'walk(if type=="object" then del(.Secret,.AccessKey,.Token,.AccountId) else . end)' \
  "<redacted-policy-readout>.json" \
  | jq '{principals: (.principals // .Statement[].Principal), effect: (.effect // .Statement[].Effect), actions: (.actions // .Statement[].Action)}' \
  > "docs/phase-6u-b3-r/evidence/02-iam-bucket-policy-<YYYY-MM-DD>.redacted.json"
```

**Expected:** Principal→operation mapping matches the Q-report least-privilege matrix; no secret
material. **Failure:** any principal with undocumented admin operations → record as a
least-privilege finding; do not change policy.

### 4.5 Evidence-diff (READ-ONLY, evidence-only) — optional, **[AUTHORIZATION CHECKPOINT §6.1+§6.3]**

```bash
# Compare a baseline manifest to the live store. NEVER writes; deletes/upload nothing.
pnpm --filter @beaconhs/object-store-backup exec -- inventory --diff \
  --diff "<baseline-manifest-or-backup-dir>" \
  --output "docs/phase-6u-b3-r/evidence/05-inventory-diff-<YYYY-MM-DD>.json"
```

**Expected:** Classes `ADDED`/`DELETED` from keys/sizes; same-size objects reported `UNKNOWN`
(honest, not `UNCHANGED`).

### 4.6 Scopes 4–8 — MUTATING / production (NOT part of R1-PREP)

No command template is provided for production connectivity, disposable-object creation, delete/
expiry, Collabora, or alert tests. Each requires its own authorized, separately planned procedure
with its own §7 rollback. **Do not derive these commands ad hoc.**

---

## 5. Output redaction instructions

Redact at capture time so raw output never persists.

| Item                                              | Rule                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Endpoint                                          | Tool already reduces to `scheme://host:port` (`redactEndpoint`); never print full URL |
| Endpoint userinfo / query (signed-URL signatures) | Strip — `redactEndpoint` already drops them                                           |
| Access key id / secret / token                    | Never store; env-var input only, never in report                                      |
| Account id                                        | Replace with `<ACCOUNT_ALIAS>`                                                        |
| Bucket name                                       | Replace with `<PROD_BUCKET_ALIAS>` / `<TEST_BUCKET_ALIAS>`                            |
| IAM principal ARNs                                | Replace with `<PRINCIPAL_ALIAS_n>`                                                    |
| Emails / webhook URLs                             | Replace with `<RECEIVER_ALIAS_n>`                                                     |
| Container names                                   | Use generic `web-container` / `worker-container`                                      |

jq pattern used above: `walk(if type=="object" then del(.Secret,.AccessKey,.Token,.AccountId,…) else . end)`.

**After writing any evidence file, verify no secret leaked:**

```bash
grep -niE 'AKIA|secret|password|BEGIN [A-Z ]*PRIVATE KEY|X-Amz-Signature=' \
  "docs/phase-6u-b3-r/evidence/<file>" && { echo "SECRET LEAK — delete file"; } || echo "clean"
```

Any hit → delete the file, record the incident, redo with stricter redaction.

---

## 6. Authorization checkpoints before each production scope

Every scope is **`NOT AUTHORIZED`** unless a written authorization reference is recorded here.
Read-only authorization does **not** authorize mutating scopes. Execute in order; do not skip ahead
to a mutating scope from a read-only one.

| Checkpoint | Scope                                          | Required authorization reference (fill on grant) | Status at R1-PREP  |
| ---------- | ---------------------------------------------- | ------------------------------------------------ | ------------------ |
| §6.1       | 1 — R2 bucket identity read                    | `AUTH-REF: __________`                           | **NOT AUTHORIZED** |
| §6.2       | 2 — effective IAM / bucket policy read         | `AUTH-REF: __________`                           | **NOT AUTHORIZED** |
| §6.3       | 3 — lifecycle configuration read               | `AUTH-REF: __________`                           | **NOT AUTHORIZED** |
| §6.4       | 4 — production network connectivity tests      | `AUTH-REF: __________`                           | **NOT AUTHORIZED** |
| §6.5       | 5 — disposable object / test-prefix creation   | `AUTH-REF: __________`                           | **NOT AUTHORIZED** |
| §6.6       | 6 — object deletion / lifecycle-expiry trigger | `AUTH-REF: __________`                           | **NOT AUTHORIZED** |
| §6.7       | 7 — production Collabora / WOPI access         | `AUTH-REF: __________`                           | **NOT AUTHORIZED** |
| §6.8       | 8 — test alert delivery / acknowledgement      | `AUTH-REF: __________`                           | **NOT AUTHORIZED** |

**Currently: all eight checkpoints are UNSATISFIED.** No production command in §4.2–§4.5 may run.

---

## 7. Rollback & cleanup requirements (for future separately authorized tests)

Applies to any future **mutating** scope. Read-only scopes (§4.2–§4.5) create no rollback
obligation beyond local evidence files.

| Requirement            | Rule                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Disposable-only        | Any object/prefix created MUST be under an approved disposable prefix and tagged `beaconhs-state=transient` (or `pending` for in-flight probes) |
| Unique naming          | Prefix includes `<date>-p0`-style token so cleanup cannot match unrelated objects                                                               |
| Pre-count              | Record `inventory` counts before and after; a mismatch is a STOP                                                                                |
| Cleanup list           | Track every created key; after the test, delete **only** those keys; confirm return to pre-count                                                |
| Local artifact cleanup | `docs/phase-6u-b3-r/evidence/` is gitignored-intended; raw/unredacted files never committed                                                     |
| Restore path           | Lifecycle/identity/policy must be returned to their captured baseline (sha256 in §4.2/§4.3)                                                     |
| Owner & sign-off       | Named rollback owner + reviewer recorded in the evidence log before any mutating step                                                           |

---

## 8. Expected results and failure criteria

| Step / artifact         | Expected result                                                   | Failure criteria → action                                                         |
| ----------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| P1–P9 preflight         | All pass                                                          | Any fail → STOP, no production access                                             |
| §4.2 identity inventory | `bucket_exists:true`, redacted endpoint, lifecycle status present | `bucket_exists:false` or `ConfigError` → STOP, record, do not paste keys as flags |
| §4.3 lifecycle config   | Status/Filter/Expiration match managed rules; sha256 recorded     | Any mismatch → DRIFT finding (record, do not fix)                                 |
| §4.4 IAM/policy         | Principal→op matches least-privilege matrix; no secrets           | Undocumented admin principal → finding (record, do not change policy)             |
| §4.5 inventory diff     | ADDED/DELETED by key/size; same-size → UNKNOWN                    | N/A (evidence-only)                                                               |
| §5 secret scan          | `clean`                                                           | Any hit → delete file, incident record, redo stricter                             |
| Scope authorization     | All 8 recorded AUTHORIZED before their scope runs                 | Missing ref → STOP                                                                |

A step that "fails" in a way that would tempt loosening a check (e.g., forcing a lifecycle match by
editing the comparison, or skipping redaction to save time) is a **STOP**, not a workaround.

---

## 9. Stop conditions

STOP and escalate if any of the following:

- An authorization checkpoint (§6) is unsatisfied but the next step would touch production.
- The only way to proceed is to read `.env`, paste a live secret, or disable redaction.
- The target endpoint/bucket cannot be proven to be the intended (non-test) target **and** the
  step is mutating.
- A mutating test cannot be cleaned to pre-test counts.
- A read-only output reveals it is actually hitting an unexpected store (wrong bucket_exists).

**G2 remains `BLOCKED` until authorized collection produces the evidence and is reviewed.**

---

## 10. Status

- This checklist is **preparation only**. No production access, no execution, no credentials used.
- All eight scopes: **NOT AUTHORIZED** (checkpoints §6.1–§6.8 unsatisfied).
- Next action: obtain explicit per-scope authorization + a provisioned read-only principal, then run
  §4.2–§4.5 in order, one scope at a time, under the §5 redaction and §7 cleanup rules.
