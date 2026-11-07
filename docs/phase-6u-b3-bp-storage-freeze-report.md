# Phase 6U-B3 / BP — Storage Write Freeze Report

- **Date:** 2026-10-17
- **Environment:** `https://beaconhs-test.xuhaoqing.top`, final image
  `beaconhs:phase-bp-20261017-111136` (ID `8d0e44b998bb`); the same freeze
  behaviour was first observed on build
  `beaconhs:phase-bp-20261017-101904` (`a39c78d0bc4b`) and then re-verified on
  the final image. Database on the isolated test host (`ceshi@10.10.31.30`).
- **Isolated tenant under test:** `ea5a149b-ea76-48e0-abbe-fa360f520d8e`
  ("Phase BB Isolated Freeze Tenant 1792133778134")
- **No commit, no push, no destructive git.** No production service, tenant or
  secret was touched.

## 1. What was asked and what was done

Verify that the storage write freeze actually works: the full state machine, the
write gate, the drain, and the user-visible rejections — without using a
production operation entry point as a test precondition and without adding new
business UI.

Three distinct verification layers were used. They are reported separately
because they prove different things:

| Layer                                 | What it is                                                                                          | Count / result                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **A. DB state machine + gate module** | test-only driver calling the real exported production functions against the live isolated DB        | **31 checks, 31 passed, 0 failed**                    |
| **B. Live HTTPS API**                 | real HTTP requests to the deployed app (WOPI SaveFile; the app's own upload action path)            | **1 positive control + 2 refusal paths**              |
| **C. Browser E2E**                    | Playwright on the deployed image: two write paths × `allowed` / `refused` / `allowed-after-release` | **6 assertions per image, all passed on both images** |

None of A/B/C is presented as another: the driver is not an E2E test, and the
browser run is not evidence about the state machine internals.

Verifying the freeze is also what surfaced **D-BP-2**: inspecting the worker log
for freeze refusals revealed that the deployed worker had never registered the
storage freeze gate at all, so every worker-side storage operation was failing
closed (`STORAGE_FREEZE_STATE_UNKNOWN`). That defect was fixed in the same phase
and the whole freeze picture was re-verified on the rebuilt image — see
`docs/phase-6u-b3-bp-defect-register.md` D-BP-2 and
`docs/phase-6u-b3-bp-deployment-verification.md` §1.1.

## 2. Why a test-only driver (and what it is not)

There is deliberately **no user-facing surface** that drives a freeze
transition — the freeze is an operator/migration procedure and the product has
no freeze button. So the state machine was driven by a **test-only driver**
(`/tmp/opencode/bp-freeze-driver.mts`, outside the repository, never shipped):

- It imports the **real** production functions and calls them —
  `applyTransition` / `readStorageFreezeStateForTenant` / `bootstrapStorageFreezeGate`
  (`packages/db/src/storage-freeze-operations.ts`),
  `assertStorageWriteAllowed` / `registerInFlightWrite` /
  `assertWritesMayProceed` (`packages/storage/src/freeze-gate.ts`),
  and the write-arm helpers (`packages/db/src/storage-write-arms-operations.ts`).
- It is **not** a re-implementation of the state machine, and it does **not**
  add a product entry point.
- It connects over an **SSH tunnel** (local `15433` → remote Postgres publish)
  to the isolated test database, using the application and super-admin
  credentials read from the remote `.env`. No credential is printed anywhere.

The browser layer selects the isolated tenant with the application's **own**
`bhs-active-tenant` view-as cookie (the super-admin view-as feature), not a new
back door.

## 3. Layer A — state machine and write gate (31/31)

Tenant started `ACTIVE`. Each check's precondition and result:

| #   | Check                                                                             | Result |
| --- | --------------------------------------------------------------------------------- | ------ |
| 0   | baseline state is `ACTIVE`                                                        | PASS   |
| 1   | `ACTIVE → FROZEN` is refused as illegal (`FREEZE_ILLEGAL_TRANSITION`)             | PASS   |
| 2   | stale `expectedVersion` is a conflict (`FREEZE_VERSION_CONFLICT`)                 | PASS   |
| 3a  | in-flight write registered while `ACTIVE`                                         | PASS   |
| 3b  | gate **ALLOWS** `putObject` while `ACTIVE`                                        | PASS   |
| 3c  | gate **ALLOWS** `createMultipartUpload` while `ACTIVE`                            | PASS   |
| 3d  | gate **ALLOWS** `wopiToken` while `ACTIVE`                                        | PASS   |
| 4   | `FREEZE_REQUESTED` applied (version+1, `migrationId`, lease, `freezeRequestedAt`) | PASS   |
| 5   | gate **REFUSES** `putObject` while `FREEZE_REQUESTED`                             | PASS   |
| 5   | gate **REFUSES** `presignPut` while `FREEZE_REQUESTED`                            | PASS   |
| 5   | gate **REFUSES** `createMultipartUpload` while `FREEZE_REQUESTED`                 | PASS   |
| 5   | gate **REFUSES** `presignMultipartPart` while `FREEZE_REQUESTED`                  | PASS   |
| 5   | gate **REFUSES** `wopiToken` while `FREEZE_REQUESTED`                             | PASS   |
| 5   | gate **REFUSES** `deleteObject` while `FREEZE_REQUESTED`                          | PASS   |
| 5b  | `assertWritesMayProceed` throws `FREEZE_ACTIVE` while frozen                      | PASS   |
| 5c  | in-flight registration is REFUSED while not `ACTIVE`                              | PASS   |
| 5d  | restart does **NOT** resume writes while frozen (`safeToResumeWrites:false`)      | PASS   |
| 6   | `DRAINING` applied                                                                | PASS   |
| 7a  | `FROZEN` refused while an in-flight write is open (`FREEZE_DRAIN_UNVERIFIED`)     | PASS   |
| 7b  | drain shows zero in-flight after completion                                       | PASS   |
| 7c  | arm issued in `issuing` state                                                     | PASS   |
| 7c2 | `FROZEN` refused while a write arm is unresolved                                  | PASS   |
| 7d  | arm moved to terminal `failed_to_activate`                                        | PASS   |
| 7e  | `DRAINING → FROZEN` succeeds with a clean drain                                   | PASS   |
| 7f  | restart does **NOT** resume writes while `FROZEN`                                 | PASS   |
| 8   | `FROZEN → RECONCILING` applied                                                    | PASS   |
| 9a  | release without a manifest hash is refused (`FREEZE_RECONCILIATION_MISSING`)      | PASS   |
| 9b  | release with a malformed hash is refused (`FREEZE_RECONCILIATION_INVALID`)        | PASS   |
| 10  | `RECONCILING → ACTIVE` releases the lease, clears `migrationId`, keeps the hash   | PASS   |
| 11a | gate **ALLOWS** `putObject` again after release                                   | PASS   |
| 11b | in-flight registration works again after release                                  | PASS   |

`# total checks=31 failures=0`, `# restore: final state=ACTIVE`.

The requested traversal
`ACTIVE → FREEZE_REQUESTED → DRAINING → FROZEN → RECONCILING → ACTIVE` is
therefore exercised, **and** the refusal edges (illegal transition, stale
version, drain not verified, unresolved arm, missing/invalid reconciliation) are
exercised. No failing transition was converted into a skip.

### 3.1 Two behaviours of the machine worth recording (not defects)

Discovered while unwinding the test tenant; both are intentional and were
verified by their error codes:

1. **The migration lease is bound to the operator.** `applyTransition` binds the
   lease to `actorId`; a _different_ operator attempting to unwind it gets
   `another operator holds the active migration lease for this tenant`. The
   driver was therefore changed to adopt the recorded `leaseHolderId` when
   restoring, which is exactly how a resuming operator behaves.
2. **`→ ACTIVE` always requires reconciliation evidence**, even from
   `FREEZE_REQUESTED`: without it the machine returns
   `cannot release the freeze without a reconciliation manifest hash`. So an
   aborted freeze still has to be reconciled — it cannot be silently cancelled.

### 3.2 The drain window is real, and the worker closes it

`DRAINING → FROZEN` is refused until the workspace can be _proved_ quiet. That
proof includes every write arm (`issuing` / `armed` / `expired` / `reconciling`)
left over from earlier traffic: an arm is a presigned credential that may still
be redeemed, so the machine waits out its lifetime before declaring the tenant
frozen. This is the correct, conservative behaviour and it was observed directly:

- A browser upload run (Layer C) legitimately left one `armed` arm behind. A
  subsequent driver run was refused at the `FROZEN` step
  (`cannot enter FROZEN: drain verification is missing or incomplete; requesting
a freeze is not the same as being frozen`). That was **not** a product failure;
  it was the guard doing its job.
- The driver was therefore changed to **wait for drain readiness**
  (`readStorageFreezeDrainStatus(...).ready`) instead of assuming it. After the
  arm expired (issuer TTL 2 min), the worker's scheduled reconciler
  (`tick:storage_write_arms`, every minute) resolved it, the drain reported ready,
  and `DRAINING → FROZEN` then succeeded.
- Live worker evidence that the reconciler resolves arms on the running image:

  ```
  [scheduled] storage_write_arms: 1 reconciled / 0 quarantined / 0 deferred / 0 errors
  ```

No arm was manufactured or force-failed to make the test pass beyond the arms the
checks deliberately create for themselves.

## 4. Layer B — live HTTPS refusals

### 4.1 WOPI SaveFile (real HTTP, real token)

A WOPI access token was minted with the application's **own** production minter
(`apps/web/src/lib/wopi.ts::mintWopiToken`, HKDF over `BETTER_AUTH_SECRET`, 12 h
TTL) for a real DOCX attachment of the isolated tenant and a real super-admin
principal. The session is genuinely valid — it is not a forged or synthetic
credential.

| State    | Request                                                                                        | Response                                       |
| -------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `ACTIVE` | `POST /wopi/files/b74f5d51…/contents?access_token=…`, `X-WOPI-Override: PUT`, 20 622-byte DOCX | **200** `{"LastModifiedTime":"…"}` (real save) |
| `FROZEN` | same request, byte-identical body                                                              | **423** `Workspace unavailable`                |

This is a discriminating positive/negative pair: the identical request succeeds
while `ACTIVE` and is refused with HTTP **423** while frozen, so the 423 is
caused by the freeze and not by a malformed request. The 423 is produced by
`wopiStorageRefusalStatus()` mapping the storage `StorageWriteBlockedError`
(`packages/storage/src/freeze-gate.ts`) — the WOPI route never partially writes.
Both legs were re-run on the final image with the same results
(**200** ACTIVE · **423** FROZEN).

### 4.2 Presigned upload path (through the app's own action)

Exercised live through the browser (Layer C, "Import Word file"): while frozen
the app's `requestUpload` refuses the presign and the uploader reports it inline
— no object, no attachment, no master. Server log confirms
`[uploads] upload request failed`.

### 4.3 Honest scope of Layer B

- **Live HTTP while frozen:** WOPI SaveFile (423) and the app's presigned
  upload action. Both refused, neither left partial state.
- **Proven at the gate module only (not over a live HTTP multipart request):**
  `createMultipartUpload` and `presignMultipartPart`. Their refusal is asserted
  in Layer A as gate checks (`STORAGE_FROZEN`). A live multipart upload against
  this tenant was **not** executed in this phase. This is a coverage gap, stated
  plainly rather than implied as covered.

## 5. Layer C — browser E2E (2 write paths × 2 states)

Suite: `apps/web/e2e/phase-bp-freeze-browser.spec.ts` (Playwright, real browser,
deployed image, isolated tenant selected by the `bhs-active-tenant` cookie).

The oracle is the **real download route**, not a UI affordance: the
`Write ↔ PDF` control is a _tab_ that always renders, so it cannot judge whether
a master exists. `GET /documents/{id}/master` returns `200` with the DOCX once a
master exists and `404 Not found` while it does not. The probe is issued from
the **page** (`page.evaluate(fetch)`) so it carries the same cookies/tenant as
the browser session; a standalone `APIRequestContext` does not, and reports
every document as "not found".

| State                    | "Start blank" (`putObject`)        | "Import Word file" (`presignPut`)                                 |
| ------------------------ | ---------------------------------- | ----------------------------------------------------------------- |
| `ACTIVE` (allowed)       | master `200`                       | master `200` **and SHA-256 = fixture** (`d86b84b4…`)              |
| `FREEZE_REQUESTED`       | master `404`, refusal notice shown | master `404`, inline uploader error `Upload could not be started` |
| `ACTIVE` (after release) | master `200`                       | master `200` + SHA-256 = fixture                                  |

Run results: **allowed 2/2 passed**, **refused 2/2 passed**,
**allowed-after-release 2/2 passed**. No test was skipped. The whole sequence was
run twice — once on each BP image — with identical results, so the table above
holds for the final image.

## 6. User-visible refusal quality (feeds D-BP-1)

- **Word import (presign):** clear enough — the uploader shows an inline error
  row (`Upload could not be started`) with a Dismiss button.
- **Start blank (`putObject`):** _not_ clear. The client receives a masked
  production RSC error and shows
  `Minified React error #441; visit https://react.dev/errors/441 …`
  instead of a meaningful "workspace is frozen" message.

Server-side, both paths are correct — the web-container log shows the real
causes (accumulated across the phase; the final image's own window shows the same
shapes):

```
6 × workspace_frozen        (blank-master action)
3 × upload request failed   (presign/upload action)
18 × STORAGE_FROZEN         (storage gate refusals)
```

The message defect is registered as **D-BP-1** in
`docs/phase-6u-b3-bp-defect-register.md`; it was **not** silently fixed, because
fixing it changes a core user flow and requires explicit approval.

## 7. Final database state (left clean and ACTIVE)

| Item                                            | Value                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `storage_freeze.state`                          | `ACTIVE` (version 45)                                                                                               |
| lease / migrationId                             | cleared (`null`)                                                                                                    |
| reconciliation hash                             | present                                                                                                             |
| `storage_write_arms` (tenant)                   | terminal only — `redeemed_nop` 3, `failed_to_activate` 6 — plus one fresh `armed` awaiting the next reconciler pass |
| open in-flight writes                           | **0**                                                                                                               |
| `audit_log` rows (entity_type `storage_freeze`) | 47 transition records across the 6 transition actions                                                               |

Write arms are reconciled asynchronously by
`apps/worker/src/lib/storage-write-arm-reconciler.ts` via the
`tick:storage_write_arms` schedule (every minute): it expires stale arms and
resolves them to `redeemed_nop` / `redeemed_confirmed` by checking the object
store. This was observed working on the running image — arms left behind by the
browser runs were reconciled to `redeemed_nop`, and the previously stuck
expired-upload cleanup completed. A fresh arm issued by the most recent allowed
upload was still inside its grace window when the snapshot was taken, which is
expected, not a leak.

## 8. Test data created (isolation and cleanup scope)

All created under the isolated tenant `ea5a149b…` only:

- **25 documents** (baseline 4 + 21 created by BP runs), each an empty
  "Untitled document" or a fixture import; the refused runs left **no** master by
  design.
- Attachments backing the successful runs, in the isolated tenant's MinIO prefix.
- Write arms, all reconciled or within their grace window (see §7).

The shared tenant `de8a882e…` gained two documents (23 → 25), both created by
re-running the **Phase BO** suite (`apps/web/e2e/phase-bo-e2e.spec.ts`, Scenarios
A and B), which runs against the default tenant and imports/edits a document each
time. That is pre-existing Phase BO suite behaviour on a test tenant, not a Phase
BP change; no other shared-tenant data was touched. No existing image tag was
overwritten, and the previous `phase-bl` image is retained for rollback. No test
data was deleted: it is all confined to the isolated tenant, and none of it
pre-dated the phase as authoritative data.

## 9. What this report does NOT claim

- It does not claim the freeze is reachable from the product UI — there is still
  no operator surface for it.
- It does not claim a live HTTP multipart upload was refused (§4.3).
- It does not claim the refusal messaging is good (§6, D-BP-1).
- The state-machine checks ran against the **live isolated database**, not a
  scratch database; they are integration-level, not pure unit tests.
