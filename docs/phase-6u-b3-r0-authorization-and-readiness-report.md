# Phase 6U-B3-R0 — Authorization Gate & Read-Only Evidence Collection

**Status:** COMPLETE (readiness + authorization gate; no production access)
**Date:** 2026-10-15
**Branch:** `hse-platform`
**Expected HEAD:** `51a899b7aac0a942da327222a3eed355fca9798a`
**Actual HEAD:** `51a899b7aac0a942da327222a3eed355fca9798a` ✅
**G2 Status:** `BLOCKED`

---

## 1. Executive summary

This phase (R0) establishes the **authorization gate** that must pass before any Phase R
production-evidence collection can run, and performs a **credential-free readiness inspection**
so the future authorized collection steps are precisely known in advance.

**Every production scope is `NOT AUTHORIZED` for execution in this phase.** The R0 task itself
explicitly forbids executing production cloud commands, connectivity tests, object operations,
Collabora tests, or alert tests, and no explicit authorization artifact exists to elevate any
scope. Therefore **no production resource was accessed, and none will be until a separate,
explicit authorization is granted and executed in a future phase.**

**No production access happened in R0.** All report contents are derived from: (a) local
repository metadata, (b) non-secret source code (environment-variable _names_ only), and
(c) existing documentation. No `.env` file, token, key, signed URL, or secret-bearing value
was read, printed, or copied.

**G2 remains `BLOCKED`.**

---

## 2. Baseline and worktree protection (R0-A)

### 2.1 Baseline verification

| Item   | Expected                                   | Observed                                   | Status   |
| ------ | ------------------------------------------ | ------------------------------------------ | -------- |
| Branch | `hse-platform`                             | `hse-platform`                             | ✅ MATCH |
| HEAD   | `51a899b7aac0a942da327222a3eed355fca9798a` | `51a899b7aac0a942da327222a3eed355fca9798a` | ✅ MATCH |

### 2.2 Worktree snapshot

| Metric                          | Before R0 | After R0             |
| ------------------------------- | --------- | -------------------- |
| Total changed/untracked entries | 210       | 211                  |
| Tracked files modified          | 93        | 93 (unchanged)       |
| Untracked entries               | 117       | 118                  |
| Q report present                | YES       | YES (unmodified)     |
| P0 report present               | YES       | YES (unmodified)     |
| R0 report present               | NO        | YES (new, untracked) |

**The single repository change made in R0 is the new untracked report
`docs/phase-6u-b3-r0-authorization-and-readiness-report.md`.** No tracked file was modified,
staged, staged-over, reverted, reformatted, or normalized.

### 2.3 Safeguards exercised

- ✅ No destructive Git commands (`git reset --hard`, `git clean`, `git restore`, etc.)
- ✅ No `git add -A`, commit, or push
- ✅ Existing worktree preserved; no changes normalized
- ✅ No `.env` contents, tokens, keys, signed URLs, or secret-bearing configuration read or printed
- ✅ No C2 drill resources, unrelated containers/volumes, or Cloudflare Tunnel accessed
- ✅ No source, tests, schemas, migrations, dependencies, lockfiles, or deployment config modified
- ✅ No formatter run
- ✅ No production cloud command, connectivity test, object operation, Collabora test, or alert test executed

---

## 3. Authorization matrix (R0 gate)

Authorization is judged **only against explicit instructions/documents**. The R0 brief does not
grant authorization for any production scope, and its R0-D phase explicitly prohibits executing
them this phase. No authorization artifact exists in the repository that grants production access.

**Result: all eight production scopes are `NOT AUTHORIZED` for execution in R0.** "Read-only
inspection" did not raise any scope to `AUTHORIZED`; nothing was executed.

| #   | Scope                                            | R0 authorization   | Basis                                                                |
| --- | ------------------------------------------------ | ------------------ | -------------------------------------------------------------------- |
| 1   | Read production R2 bucket identity/configuration | **NOT AUTHORIZED** | No explicit grant; R0-D forbids production cloud commands this phase |
| 2   | Read effective IAM and bucket policy             | **NOT AUTHORIZED** | No explicit grant; no documented production read-only identity       |
| 3   | Read lifecycle configuration                     | **NOT AUTHORIZED** | No explicit grant; R0-D forbids production cloud commands this phase |
| 4   | Production network connectivity tests            | **NOT AUTHORIZED** | No explicit grant; R0-D explicitly forbids connectivity tests        |
| 5   | Create disposable objects / test prefixes        | **NOT AUTHORIZED** | No explicit grant; R0-D explicitly forbids object operations         |
| 6   | Delete objects / trigger lifecycle expiration    | **NOT AUTHORIZED** | No explicit grant; highest-risk scope, never implicitly granted      |
| 7   | Access production Collabora/WOPI                 | **NOT AUTHORIZED** | No explicit grant; R0-D explicitly forbids Collabora tests           |
| 8   | Send test alerts / acknowledge alerts            | **NOT AUTHORIZED** | No explicit grant; R0-D explicitly forbids alert tests               |

**Scope-separation rule reaffirmed:** authorization for a _read-only_ scope would NOT imply
authorization for writes, deletes, expiry triggers, alerts, or unrelated production systems.
Each scope above was evaluated independently and none was elevated.

### 3.1 What R0 _is_ authorized to do (and did)

| Activity                                                    | Authorized | Executed |
| ----------------------------------------------------------- | ---------- | -------- |
| Read local Git metadata (branch/HEAD/status)                | YES        | ✅       |
| Read non-secret source code (env var names, endpoint logic) | YES        | ✅       |
| Read existing documentation/reports                         | YES        | ✅       |
| Inspect installed tool availability (names)                 | YES        | ✅       |
| Create this report                                          | YES        | ✅       |
| Any production access                                       | NO         | ❌ none  |

---

## 4. Credential-free readiness findings (R0-B)

Inspection was limited to non-secret source and documentation. **No environment variables,
credential files, tokens, access keys, signed URLs, or secret-bearing configuration were read or
printed.** Environment-variable _names_ and non-secret logic were inspected only.

### 4.1 Approved credential mechanism for R2 access

The application's intended R2 credential mechanism is **environment variables** consumed in
`packages/storage/src/index.ts`. Variable **names only** (values never read):

| Variable (name)               | Purpose                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `R2_ACCOUNT_ID`               | Account identifier used for default endpoint construction  |
| `R2_ACCESS_KEY_ID`            | S3 access key ID (secret-bearing; not read)                |
| `R2_SECRET_ACCESS_KEY`        | S3 secret access key (secret-bearing; not read)            |
| `R2_BUCKET`                   | Bucket name                                                |
| `R2_ENDPOINT`                 | Public / browser-facing endpoint used for presigning       |
| `R2_INTERNAL_ENDPOINT`        | In-network / server-side endpoint (required in production) |
| `R2_PUBLIC_URL`               | Optional public base URL for read URLs                     |
| `R2_PRIVATE_BUCKET_CONFIRMED` | Bucket-privacy confirmation flag                           |

**Conclusion:** Credentials are supplied at runtime via environment variables. There is no
static, checked-in credential. This means any authorized evidence collection must either reuse the
already-configured runtime environment (no new secret handling) or use an explicitly provisioned
read-only identity — neither of which is authorized today.

### 4.2 Is a read-only identity documented?

**No production read-only identity is documented.** Findings:

- The only documented object-store identity is the isolated drill identity **`drillminio`**
  (Phase N report), operating against the isolated `beaconhs-drill` MinIO bucket — **not** production.
- `GetBucketPolicy` on the drill bucket returned **`NoSuchBucketPolicy`**; access is IAM-based there.
- Production Cloudflare R2 policies, IAM identities, bucket policies, and **break-glass roles are
  `UNKNOWN`** (Phase N §N5.1 / Phase O §8).

**Conclusion:** There is no documented, pre-provisioned production read-only principal. Obtaining
one is a prerequisite for scopes 1–3, not part of R0.

### 4.3 Where bucket identity and policy evidence should originate

Per the Phase Q evidence plan (the authoritative source reviewed here), production evidence should
originate from, in order of preference:

1. **Cloudflare R2 console** — bucket settings, bucket policy, lifecycle rules (read-only views).
2. **Cloudflare Zero Trust / IAM console** — account roles, effective policies, principal mappings.
3. **Infrastructure-as-code** — Terraform / K8s / Compose definitions declaring the R2 resources.
4. **Deployed runtime configuration** — environment-variable _names_ and non-secret endpoint values
   already present in containers (confirming intent, not secret values).
5. **Worker/web logs** — `AccessDenied` / connection messages that reveal principal or path _failure_.

Note: (4) proves **configuration intent**, not actual production bucket identity. Only (1)–(3)
provide authoritative identity/policy evidence, and all require authorization.

### 4.4 Tools already available for redacted evidence capture

| Tool                                                                                  | Availability     | Intended use in evidence capture                                  |
| ------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| `jq`                                                                                  | ✅ installed     | Redact/normalize JSON policy & lifecycle readouts                 |
| `@beaconhs/object-store-backup` Node package (`s3.ts`, `inventory`, `hash`, `verify`) | ✅ in-workspace  | S3 listing / object hashing / verification without extra binaries |
| Containerized MinIO client (`docker run`)                                             | conditional      | Only if an authorized, image-approved runner exists               |
| `aws` CLI                                                                             | ❌ not installed | Would need provisioning for an authorized phase                   |
| `s3cmd`                                                                               | ❌ not installed | Would need provisioning                                           |
| `rclone`                                                                              | ❌ not installed | Would need provisioning                                           |
| `mc` / `minio` CLI                                                                    | ❌ not installed | Would need provisioning                                           |

Redaction helpers exist in source (e.g., `packages/appkit-feedback/src/redact.ts`), but these are
component-specific and not a general evidence-redaction tool; **ad-hoc `jq`-based redaction scripts
would need to be authored and reviewed** as part of an authorized phase.

### 4.5 Can production vs test endpoints be distinguished without secret values?

**Yes — by non-secret configuration and code logic, without reading any secret.**

`packages/storage/src/index.ts` distinguishes production from test by:

1. **Endpoint hostname** (non-secret): the public endpoint is treated as Cloudflare R2 only when its
   hostname is `r2.cloudflarestorage.com` or ends with `.r2.cloudflarestorage.com`. A `localhost`,
   `127.0.0.1`, or internal hostname is treated as test/MinIO.
2. **`NODE_ENV=production`** combined with a mandatory **`R2_INTERNAL_ENDPOINT`**: production runtime
   _refuses to start_ server-side I/O without the private internal endpoint.
3. **Account convention**: a non-`local` account produces the R2 hostname; `local` maps to
   `http://localhost:9000`.

**Caveat:** This distinguishes **configuration intent** (what the deployment is configured to be).
It is **not** proof of the _actual_ authoritative production bucket identity — that requires
console/IaC readout (scopes 1–3), which are `NOT AUTHORIZED`.

### 4.6 Readiness blockers encountered

- **No production read-only identity** → blocks scopes 1–3 until provisioned.
- **No authorization artifact** → blocks all 8 scopes.
- **No cloud CLI installed** → an authorized phase must provision `aws`/`mc`/MinIO client or reuse
  the in-workspace Node tooling and a reviewed jq redaction script.
- **No `.env` was read** → no blocker; readiness derived entirely from non-secret source/docs.

---

## 5. Precise command plan for each authorized read-only scope

**No read-only scope is `AUTHORIZED`. The commands below are the PLANNED templates that a future,
explicitly authorized Phase R run would execute. They were NOT run in R0.** Values in `< >` are
placeholders; no secret is referenced, and every command pipes through `jq` redaction before any
artifact is stored.

### 5.1 Scope 3 — Read lifecycle configuration (planned, NOT EXECUTED)

```bash
# AUTHORIZATION REQUIRED — not run in R0.
# Read-only bucket lifecycle rule readout, redacted, via the in-workspace S3 client or approved CLI.
# Example shape using jq redaction of a lifecycle JSON readout:
<approved-s3-reader GetBucketLifecycleConfiguration --bucket <PROD_BUCKET_ALIAS>> \
  | jq 'del(.Owner, .IdentityARNs)' > docs/evidence/lifecycle-<date>.redacted.json
```

**Acceptance:** Rules match `withManagedStorageLifecycleRules` for `Status`, `Filter`, `Expiration`;
the MinIO-only `AbortIncompleteMultipartUpload` difference is documented, not silently matched.

### 5.2 Scope 1 — Read bucket identity/configuration (planned, NOT EXECUTED)

```bash
# AUTHORIZATION REQUIRED — not run in R0.
# Read-only bucket settings + confirm endpoint host pattern WITHOUT printing account id.
<R2-console or IaC readout of bucket> \
  | jq '{bucket: (.name // "<alias>"), hostPatternSuffix: (.endpoint|split(".")[-3:]|join("."))}'
```

**Acceptance:** Bucket alias and jurisdiction confirmed; account id and any credential are redacted;
hostname suffix confirms R2 vs test.

### 5.3 Scope 2 — Read effective IAM / bucket policy (planned, NOT EXECUTED)

```bash
# AUTHORIZATION REQUIRED — not run in R0.
<IAM-console or IaC effective-policy readout> \
  | jq 'walk(if type=="object" then del(.Secret, .AccessKey, .Token) else . end)' \
  > docs/evidence/effective-policy-<date>.redacted.json
```

**Acceptance:** Principal → operation mapping matches the least-privilege matrix in the Q report;
no secret material present in the stored artifact.

**Write/delete/expiry/Collabora/alert scopes (4–8) have no command plan here because they are
`NOT AUTHORIZED` and are out of R0's read-only remit. They would require their own future plans.**

---

## 6. Redaction rules and evidence retention (R0-C)

### 6.1 Redaction rules (to apply when an authorized phase collects evidence)

Any stored evidence artifact MUST have the following removed/normalized before it is written:

| Item                                        | Rule                                                             |
| ------------------------------------------- | ---------------------------------------------------------------- |
| Access key IDs / secret keys / tokens       | Delete entirely                                                  |
| Signed URLs (query-string signature params) | Delete entirely                                                  |
| Cloudflare account IDs                      | Replace with `ACCOUNT_ALIAS`                                     |
| Bucket names                                | Replace with `PROD_BUCKET_ALIAS` / `TEST_BUCKET_ALIAS`           |
| Internal endpoint hostnames/IPs             | Replace with `INTERNAL_ENDPOINT_ALIAS`                           |
| IAM principal ARNs / user identities        | Replace with `PRINCIPAL_ALIAS_<n>`                               |
| Email addresses / webhook URLs              | Replace with `RECEIVER_ALIAS_<n>`                                |
| Container names                             | Replace with generic `web-container` / `worker-container` / etc. |

Redaction is performed with `jq` at capture time so the raw output is never persisted.

### 6.2 Evidence retention location (proposed — not created in R0)

- Proposed location: `docs/phase-6u-b3-r/evidence/` (to be created only by an authorized phase).
- Naming: `<scope>-<yyyy-mm-dd>.redacted.json` plus a one-line provenance header (collector, date,
  source, redaction applied).
- Raw (unredacted) output: **never committed**; if required for audit, store only in an approved
  secret store with retention policy, referenced — not copied — into the report.

R0 created **no** evidence directory or artifact.

---

## 7. Explicit separation of read-only inspection from mutations

| Category                                                    | R0 status      | Executed in R0  |
| ----------------------------------------------------------- | -------------- | --------------- |
| Read-only **source/doc** inspection (this phase)            | AUTHORIZED     | ✅ done         |
| Read-only **production** inspection (scopes 1–3)            | NOT AUTHORIZED | ❌ not executed |
| Production **network connectivity** tests (scope 4)         | NOT AUTHORIZED | ❌ not executed |
| Production **write / disposable-object** creation (scope 5) | NOT AUTHORIZED | ❌ not executed |
| Production **delete / lifecycle-expiry trigger** (scope 6)  | NOT AUTHORIZED | ❌ not executed |
| Production **Collabora/WOPI** access (scope 7)              | NOT AUTHORIZED | ❌ not executed |
| Production **alert send / ACK** (scope 8)                   | NOT AUTHORIZED | ❌ not executed |

Reading source and documentation is categorically different from touching production. R0 performed
**only** the former. "Read-only inspection" was never interpreted as authorization to write, delete,
trigger expiry, send alerts, or access unrelated systems.

---

## 8. Stop/Go decision for each Phase R task

| Phase R task                           | Depends on scope(s) | Decision | Reason                                                |
| -------------------------------------- | ------------------- | -------- | ----------------------------------------------------- |
| R1 — R2 bucket identity collection     | 1                   | **STOP** | NOT AUTHORIZED; no read-only identity provisioned     |
| R2 — IAM / bucket policy collection    | 2                   | **STOP** | NOT AUTHORIZED; no read-only identity provisioned     |
| R3 — Lifecycle config readout          | 3                   | **STOP** | NOT AUTHORIZED; command plan drafted but not executed |
| R4 — Network connectivity tests        | 4                   | **STOP** | NOT AUTHORIZED; explicitly out of R0                  |
| R5 — Lifecycle expiry execution test   | 5, 6                | **STOP** | NOT AUTHORIZED; write+delete scopes                   |
| R6 — Collabora production verification | 7                   | **STOP** | NOT AUTHORIZED; explicitly out of R0                  |
| R7 — Alert delivery integration test   | 8                   | **STOP** | NOT AUTHORIZED; explicitly out of R0                  |

**No Phase R task is cleared to run.** Every task is held at `STOP` pending explicit, per-scope
authorization and (where needed) a provisioned read-only principal.

---

## 9. Remaining unknowns and recommended next action

### 9.1 Remaining unknowns

| Unknown                                         | Blocks      | Resolution                                           |
| ----------------------------------------------- | ----------- | ---------------------------------------------------- |
| Explicit production access authorization        | all scopes  | Obtain written/instructional authorization per scope |
| Production read-only identity (principal)       | scopes 1–3  | Provision a least-privilege read-only principal      |
| Actual authoritative production bucket identity | scope 1     | Console/IaC readout once authorized                  |
| Effective IAM / bucket policy contents          | scope 2     | Console/IaC readout once authorized                  |
| Production lifecycle rules + execution          | scopes 3, 6 | Readout + disposable expiry test once authorized     |
| Production network paths/latency                | scope 4     | Connectivity test once authorized                    |
| Production Collabora behavior                   | scope 7     | Isolated Collabora test once authorized              |
| Production alert delivery/ACK                   | scope 8     | Authorized integration test once authorized          |

### 9.2 Recommended next action

**STOP for authorization.** The correct next step is **not** to run any of the planned commands, but
to obtain **explicit, per-scope written authorization** plus a **provisioned read-only principal**
(the smallest possible grant — scope 3 lifecycle read, then scope 1, then scope 2). Only after that
authorization is recorded should a future phase execute the §5 command templates with the §6
redaction rules and write evidence to the proposed `docs/phase-6u-b3-r/evidence/` location.

Writing/deleting/expiry/Collabora/alert scopes must remain frozen until separately authorized.

---

## 10. No-production-access statement

**No production resource was accessed, queried, modified, or tested in this phase.** No `.env`
contents, environment-variable values, tokens, access keys, secrets, signed URLs, or
credential-bearing configuration were read or printed. No C2 drill resource, unrelated
container/volume, or Cloudflare Tunnel configuration was accessed. No production cloud command,
connectivity test, object operation, Collabora test, or alert test was executed.

All findings derive from local repository metadata, non-secret source code (environment-variable
_names_ and non-secret endpoint/hostname logic), and pre-existing documentation.

**G2 remains `BLOCKED`.**

---

## 11. Final verification & stop

- Report created: `docs/phase-6u-b3-r0-authorization-and-readiness-report.md` (this file, new/untracked)
- Only repository change this phase: that one untracked file (no tracked file modified, no formatter run)
- HEAD unchanged: `51a899b7aac0a942da327222a3eed355fca9798a`
- Branch unchanged: `hse-platform`
- G2: `BLOCKED`

**Stopping here for review, as instructed.** Production checks were not executed; no credentials
were collected; no follow-up implementation was started; nothing was committed or pushed.
