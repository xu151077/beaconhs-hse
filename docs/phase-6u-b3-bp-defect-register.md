# Phase 6U-B3 / BP — Defect Register

- **Date:** 2026-10-17
- **Environment:** `https://beaconhs-test.xuhaoqing.top` on image
  `beaconhs:phase-bp-20261017-111136` (`8d0e44b998bb`). The first BP build
  `beaconhs:phase-bp-20261017-101904` (`a39c78d0bc4b`) is where D-BP-2 was found;
  both builds are recorded in
  `docs/phase-6u-b3-bp-deployment-verification.md` §1.1.
- Scope: defects **observed during Phase BP**. Defects already recorded in other
  registers are referenced, not re-listed:
  - `docs/phase-6u-b3-bo-defect-register.md` — D-BO-1…D-BO-5
  - `docs/hse-development-baseline.md` §21 — D1–D6

No gate was disabled, skipped, or suppressed to produce this register.

---

## D-BP-2 — The worker process never registers the storage freeze gate (High) — FIXED

**Status:** **Fixed** in the working tree and verified on the running test
service. This is the most consequential defect found in the phase: it made the
deployed worker unable to write to storage **at all**.

**Symptom (live, repeating every minute on the test host):**

```
[storage-freeze] failed to load storage gate module Error
  [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently
  unsupported for files under node_modules, for
  "file:///app/apps/worker/node_modules/@beaconhs/storage/src/index.ts"
...
[uploads] expired reservation reconciliation failed {
  error: 'storage deleteObject refused for key "t/de8a882e-…/_pending/…":
          STORAGE_FREEZE_STATE_UNKNOWN — no freeze-state reader is registered for this process'
}
✗ scheduled#repeat:tick-storage-object-deletion …: Expired upload reconciliation had 1 error(s)
[scheduled] expired_uploads: 0 recovered / 0 discarded / 1 errors
```

**Root cause:** `apps/worker/src/index.ts` and `apps/worker/src/storage-init.ts`
called `bootstrapStorageFreezeGate()` **without** a module argument. That falls
back to `await import('@beaconhs/storage')`, which in the production image
resolves to raw TypeScript under `node_modules`; Node 24 refuses to type-strip
there. The bootstrap catches the error, logs it, and returns **without
registering a reader** — and `packages/storage` then fails closed for every
controlled mutation in that process (`STORAGE_FREEZE_STATE_UNKNOWN`).

The web process was unaffected because it already passes its statically bundled
module (`apps/web/src/instrumentation.ts`). The callee's own doc comment claimed
"workers use the normal dynamic import", which the bundled worker cannot do.

**Impact:**

- Every worker-side gated storage operation was permanently refused:
  expired-upload cleanup, render/output writes, any `putObject`/`deleteObject`/
  presign from a job.
- `tick:storage_object_deletion` failed on every run, so an expired upload
  reservation in the **shared** tenant `de8a882e…` was never cleaned up.
- The failure was **silent at startup**: `bootstrapStorageFreezeGate` swallows
  load errors by design, and `storage-init` still exited `0`, so a green deploy
  hid a broken worker.

**Fix:** pass the statically imported module at both worker call sites, exactly
as the web app does:

```ts
import * as storage from '@beaconhs/storage'
await bootstrapStorageFreezeGate(storage)
```

Files: `apps/worker/src/index.ts`, `apps/worker/src/storage-init.ts`; callee doc
comment corrected in `packages/db/src/storage-freeze-operations.ts`.

**Regression guard:** `apps/worker/src/lib/storage-gate-bootstrap.test.ts` scans
the worker sources and fails if any `bootstrapStorageFreezeGate()` call site
omits the module argument or the static import. The callee contract itself
(empty module → registers nothing, never throws) stays covered by
`packages/db/src/storage-freeze-operations.test.ts`.

**Verified:** after the fix was rebuilt and redeployed as
`beaconhs:phase-bp-20261017-111136` (`8d0e44b998bb`), the worker log on the
running image shows:

```
failed to load storage gate module   → 0 occurrences
STORAGE_FREEZE_STATE_UNKNOWN         → 0 occurrences
[scheduled] expired_uploads: 0 recovered / 1 discarded / 0 errors   (was 1 error, every minute)
✔ scheduled#repeat:tick-storage-object-deletion   (was ✗ …1 error(s))
```

i.e. the gate is registered, the previously stuck expired-upload reservation was
discarded, and worker storage operations succeed again. The full freeze suite was
re-run on the fixed image: **31/31** driver checks, browser `allowed` **2/2** and
`refused` **2/2**, live WOPI **200** ACTIVE / **423** FROZEN, and all six gates
green. Full detail in `docs/phase-6u-b3-bp-storage-freeze-report.md` §7.

**Follow-up worth considering (not done here):** a bootstrap that fails to
register should arguably be _loud_ — `storage-init` exited `0` while the gate was
unregistered. Making that a hard startup failure is a behaviour change and was
left for an explicit decision.

---

## D-BP-1 — Freeze refusals are not explained to the user (Medium)

**Status:** Open. Deliberately **not** fixed: it changes a core document flow and
was not part of the approved scope.

The storage write is correctly refused, but the two user-facing surfaces say the
wrong thing:

| Surface                             | What the user sees                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start blank** (`putObject`)       | `Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.` |
| **Import Word file** (`presignPut`) | inline uploader error: `Upload could not be started` (accurate but does not say _why_ — a quota problem and a frozen workspace look identical)                                |

**Reproduction:** with the isolated tenant frozen, create a document and press
**Start blank**, or import a `.docx`.

**Server-side truth (web container log, same moments):**

```
6 × workspace_frozen        (the blank-master action threw Error('workspace_frozen'))
18 × STORAGE_FROZEN         (the gate refused the storage operation)
3 × upload request failed   (requestUpload refused the presign)
```

**Root cause:** `apps/web/src/app/(app)/documents/[id]/_master-actions.ts:178`
throws `new Error('workspace_frozen')` from a server action. In a production
Next.js build the RSC runtime masks a thrown action error, so the client's
`catch` never receives that message and the toast shows a React error reference.
Every other place in the app already uses the structured form —
`return { ok: false, error: 'workspace_frozen' }` (this same file, line 112, and
`training/pptx/_actions.ts:85`) — and `components/collabora-embed.tsx` already has
friendly copy for `workspace_frozen`.

**Proposed fix (not applied):** have `createBlankDocumentMaster` return a
structured refusal for the freeze case (matching the file's own pattern) and map
it to the existing friendly copy in the client; and give `requestUpload` a
freeze-specific message so the uploader can say "the workspace is frozen" instead
of "Upload could not be started".

**Note:** the WOPI path is fine — a frozen save returns a clean HTTP **423**
with no partial write (verified live), so this defect is confined to the two
document-pane actions.

---

## Carried forward, untouched

- **D-BO-1 (non-ASCII download filename)** — **CLOSED**: fixed, deployed and
  verified end-to-end in this phase. See
  `docs/phase-6u-b3-bp-deployment-verification.md` §5.
- **D-BO-2 (`Content-Disposition` duplicated across many routes)** — still open,
  still only partially unified (the two document routes now share the helper).
  Unchanged by this phase; the constraints in the BO register still apply.
- **D-BO-3** (Collabora test-env misconfiguration) — fixed in the test env in
  Phase BO, still fixed.
- **D-BO-4** (`405` on `GET /documents/{id}/master`) — still observation-only,
  not reproduced deterministically in this phase either.
- **D-BO-5** (Collabora console noise) — open, cosmetic.
- **D1–D6** (`docs/hse-development-baseline.md` §21) — deliberately untouched:
  `equipment.read.self` missing from the catalogue (D1), ungated `people` nav
  (D2), dead columns (D3), PPE failed-inspection CA omits `recordDomainEvent`
  (D4), equipment flow `statusValues` missing `repaired`/`verified` (D5), stale
  seed comment (D6).

## Harness findings (not product defects)

- **`APIRequestContext` does not carry the view-as tenant cookie.** The Phase BP
  browser spec initially probed `GET /documents/{id}/master` through Playwright's
  `request` fixture, which carries the authenticated session but _not_ the
  `bhs-active-tenant` cookie added with `context.addCookies()`. It therefore
  resolved a different tenant and reported every document as `404` — a false
  404 that would have made the refusal assertions pass for the wrong reason. The
  probe now runs from the page (`page.evaluate(fetch)`), and the fix is recorded
  so future phases do not repeat the trap.
- **The `Write ↔ PDF` control is not a master-existence oracle.** It is a
  segmented _tab_ that always renders; the first version of the BP spec asserted
  on it and produced a false "allowed" result. The oracle is the download route.
- **The migration lease binds to the operator**, and **`→ ACTIVE` always
  requires reconciliation evidence** — both are intentional machine behaviours
  that initially read as harness failures; see the freeze report §3.1.

## Regression test status summary

| Suite                                          | Tests                     | Passed | Failed | Skipped | Notes                                     |
| ---------------------------------------------- | ------------------------- | ------ | ------ | ------- | ----------------------------------------- |
| `apps/web/e2e/phase-bo-e2e.spec.ts`            | 4                         | 4      | 0      | 0       | D-BO-1 now green on the deployed image    |
| `apps/web/e2e/phase-bp-freeze-browser.spec.ts` | 2 (× 3 states × 2 images) | 12     | 0      | 0       | allowed / refused / allowed-after-release |
| Freeze driver (31 checks)                      | 31                        | 31     | 0      | 0       | test-only driver, live isolated DB        |
| Six repo gates                                 | 6                         | 6      | 0      | 0       | each exit code captured                   |
