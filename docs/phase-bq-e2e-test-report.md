# Phase BQ — storage write freeze, real HTTP E2E report

## Summary

**Date**: 2026-10-18
**Environment**: `https://beaconhs-test.xuhaoqing.top` (isolated "ceshi" test host)
**Compose project**: `beaconhs-phase-aj`
**Tenant**: `ea5a149b-ea76-48e0-abbe-fa360f520d8e` ("Phase BB Isolated Freeze Tenant")
**Image under test**: `beaconhs:phase-bp-20261018-095008` (image id `474ccda68ed4`), built
from this working tree.

| Suite                            | Scenarios | Passed | Failed |
| -------------------------------- | --------- | ------ | ------ |
| Frozen UX regression             | 4         | 4      | 0      |
| Multipart upload across a freeze | 7         | 7      | 0      |
| **Total**                        | **11**    | **11** | **0**  |

All 11 scenarios drove a real Chromium against the deployed HTTPS app. The freeze
precondition in every scenario was produced by the production state machine
(`applyTransition` / `ensureFreezeRow` / `readFreezeState`) running against that
environment's own database — never by editing a state column.

## How the run is wired

- **Browser**: Playwright (locally installed), `--workers=1`, targeting the real
  HTTPS deployment. No local server, no local certificate, no new tunnel.
- **Auth**: a real magic-link login against the test environment's own Mailpit,
  captured once into a storage state file. The session cookie is the production
  `__Secure-better-auth.session_token` over HTTPS, plus the
  `bhs-active-tenant=ea5a149b-…` cookie that selects the isolated tenant. The
  seeded super-admin has no `tenant_users` row, so without that cookie the app
  would silently fall back to the oldest tenant.
- **Freeze control**: `apps/web/e2e/helpers/freeze-control.ts` shells into the
  test host's worker container and runs `bt-freeze-driver.ts` (a test-only
  artifact, not part of the product). The driver calls the real
  `applyTransition` with the real `STORAGE_FREEZE_PERMISSIONS` for that one
  tenant and prints the resulting row, so every transition is auditable.
- **Storage**: the driver and the app share one database, so the gate the browser
  hits is the real production gate reading the real freeze row.

### Blocking states

`applyTransition` refuses `FROZEN` unless the database itself reports a completed
drain (zero in-flight writes **and** zero unresolved write arms **and** the arm
grace elapsed). That is correct product behaviour, and it means a scenario that
parks a write mid-flight cannot always be frozen all the way to `FROZEN`. The
gate refuses new writes in **every** blocking state, so scenarios run in whichever
blocking state the database allows and log which one it was:

| Scenario                                 | State used        | Rejection point             |
| ---------------------------------------- | ----------------- | --------------------------- |
| 1. Normal multipart upload (all parts)   | ACTIVE            | — (success)                 |
| 2. Freeze before multipart create        | FROZEN            | `createMultipartUpload`     |
| 3. Freeze after create, part 1 parked    | FROZEN            | next `presignMultipartPart` |
| 4. Freeze after part 1, part 2 parked    | FROZEN            | next `presignMultipartPart` |
| 5. Freeze with the last part parked      | DRAINING          | `completeMultipartUpload`   |
| 6. Release and resume                    | DRAINING → ACTIVE | then success                |
| 7. Three concurrent uploads while frozen | FROZEN            | `createMultipartUpload` × 3 |

## Scenario detail

### Frozen UX regression (4/4)

| #   | Scenario                                               | Result | State  |
| --- | ------------------------------------------------------ | ------ | ------ |
| 1   | Frozen **Start blank** is refused with the frozen copy | pass   | FROZEN |
| 2   | Frozen **Import Word** is refused with the frozen copy | pass   | FROZEN |
| 3   | ACTIVE workspace opens the editor normally             | pass   | ACTIVE |
| 4   | Server-side freeze gate refuses a WOPI session         | pass   | FROZEN |

Scenario 1 asserts the sonner toast text is exactly the frozen action copy and
that no editor iframe is created. Scenario 2 asserts the inline uploader error.
Scenario 4 drives a real WOPI session request and asserts the gate refuses it
server-side.

### Multipart upload across a freeze (7/7)

The 256 MiB fixture is exactly `MULTIPART_UPLOAD_THRESHOLD_BYTES`, so every
upload takes the multipart path: `requestUpload` → `createMultipartUpload`, then a
fresh `presignMultipartPart` mint immediately before each 64 MiB part, then
`finalizeUpload` → `completeMultipartUpload` → `promoteObject`. The uploader is
sequential, one part at a time.

- **Scenario 1** uploaded all four parts (135.8 s to upload plus verify), then
  downloaded the stored object back through the pane's own presigned capability
  URL and asserted `status=200`, `size=268435456`, and a SHA-256 equal to the
  fixture's (`83dcf131…f7153d`).
- **Scenarios 3–5** parked a chosen part's object-store `PUT` with a Playwright
  route so the lifecycle stopped at a known stage, then applied the freeze, then
  released the parked request. The freeze therefore landed **while the multipart
  upload was genuinely in flight**. Each asserted the inline error is the frozen
  copy (not a generic upload failure) and that no version was attached.
- **Scenario 6** asserted the upload is refused while blocked, then that it
  succeeds end to end after a real release — again with a full SHA-256 match of
  the stored object.
- **Scenario 7** started three concurrent multipart uploads (three documents,
  three pages) and asserted each was refused and no document gained a source.

Nothing in the mid-flight scenarios fakes timing: the part mint, the part upload,
the finalisation and the gate are all the real code paths.

## Defect found and fixed (production-blocking)

**`apps/web/src/components/collabora-embed.tsx` crashed every document page in a
production build.**

`collabora-embed.tsx` is a `'use client'` component. It imported
`@/lib/storage-freeze-refusal`, which imports the `@beaconhs/storage` root. That
root validates the server-only `R2_INTERNAL_ENDPOINT` at module scope and throws
when it is absent — which is always true in a browser bundle, because a
non-`NEXT_PUBLIC_` variable is `undefined` there. In a production build the
document page rendered "This page could not load" for every document.

The fix separates the copy from the predicate:

- `apps/web/src/lib/storage-freeze-copy.ts` (new) holds the client-safe
  title/detail/action constants and has no server imports.
- `apps/web/src/lib/storage-freeze-refusal.ts` keeps the server-side predicate and
  imports the action constant from the copy module.
- `collabora-embed.tsx`, `documents/[id]/_master-actions.ts` and the predicate test
  now import the constant from the copy module.

Verified: `typecheck` and the focused vitest suite pass, and the string
`R2_INTERNAL_ENDPOINT is required` no longer appears in any client chunk under
`/app/apps/web/.next/static`.

## Second defect found and fixed (unrelated error path)

`apps/web/src/components/collabora-embed.tsx` rendered the
`workspace_unavailable` detail as `<GeneratedText id="m_130320500eeb16" />`
without its `values`, while the message text requires `{value0}` — so that error
screen showed the literal placeholder "…before opening {value0}." instead of "the
editor" / "the presentation". The freeze work had dropped the prop on an
otherwise unrelated branch. Restored, and a repository-wide check of every
generated message that needs `{value…}` now finds no other case.

(Coverage gap, not fixed: `apps/web/scripts/i18n-source-audit.test.ts` only checks
for duplicate generated keys, so a dropped `values` prop fails no gate.)

## Defect found, recorded, not fixed

**The PDF pane's pdf.js viewer cannot render a 256 MiB PDF and the browser kills
the renderer.**

Measured on this environment: after a 256 MiB PDF is attached as a document
source, the pane mounts the viewer, and the renderer dies about 80 s later —
after pdf.js has finished fetching the object. Timeline from a dedicated probe:

```
Uploaded at 120.0s
download link at 120.5s
PAGE CRASH at 201.9s
```

The upload itself is unaffected and the stored bytes are correct (Scenario 1
verifies them). The defect is the preview path, not the freeze work. It is out of
scope for this task (it is a pdf.js/streaming and document-size-cap question, not
a freeze-gate question) and **is not fixed here**. A test-side consequence is
documented in the spec: the byte verification reads the download capability URL
from the pane and fetches the object from a page that never mounts the viewer, so
the unrelated crash cannot corrupt the result.

The product currently accepts a PDF up to `MAX_PPTX_FILE_BYTES` (1 GiB) as a
document source, so this is reachable in normal use.

## Other findings (reported, not fixed)

- `packages/storage/src/freeze-gate.ts` header comment says `presignPut` and
  `presignMultipartPart` are **not** gated, but `packages/storage/src/index.ts`
  gates both (`presignPut` and `presignMultipartPart`). The comment is stale.
  `packages/storage/**` was not edited.
- This `format:check` scope includes the untracked `apps/web/e2e/**` scaffolding.
  The new and rewritten specs were formatted to keep the gate green.

## Cleanup performed

- The tenant is left **`ACTIVE`** (`storage_freeze.version = 99`, no lease holder),
  and every write arm is terminal (`redeemed_nop` 44, `failed_to_activate` 6) — no
  unresolved arm and no in-flight write.
- The E2E test documents were removed **through the product's own bulk-delete UI**
  (documents list → select all visible rows → Delete → Confirm), not by a direct
  state write. Result: `0` live documents, `64` soft-deleted rows in
  `ea5a149b`. The product's canonical document deletion is a soft delete that
  keeps version history for audit, so the attachment objects for the seven
  uploaded test files (`bq-*`, six × 256 MiB plus one 4 KiB, ~1.5 GiB) remain in
  the isolated bucket. They were deliberately **not** hard-deleted: doing so would
  contradict the product's retention semantics and orphan the retained version
  rows.
- The test-only freeze driver was removed from both the test host and the worker
  container, the temporary Mailpit tunnel was closed, and the temporary
  auth/cleanup/probe specs were deleted from `apps/web/e2e`.
- The stray `create-e2e-session.sql` left by the superseded Phase BS
  "insert a session row" approach was deleted.
- **Image left deployed: `beaconhs:phase-bp-20261018-095008`** — the image all 11
  scenarios passed against. (Explicit decision: the declared rollback target
  `beaconhs:phase-bp-20261017-111136` predates the D-BQ-1 fix, so on it every
  document page crashes in the browser. That tag is still present on the test host
  if the exact pre-run state is wanted.) `beaconhs:phase-bp-20261018-091505` is
  also present as an intermediate build.
- Local `/tmp/opencode` artifacts (storage state, 256 MiB fixture, run logs) are
  outside the repo and were left in place.

## Caveats

- The build script prints `DEPLOYMENT_VERSION=51a899b7`, which is the git revision
  of the build context, not a distinct release identifier; the image tag
  (`phase-bp-20261018-095008`) is the identifying fact.
- The stale specs were rewritten to the current UI (the old ones target
  `/documents/{id}/editor` without `?version=`, a route that now redirects to
  `/documents/{id}`, and a "PDF" button that no longer exists in that shape).
  Each scenario's intent and the "workspace is frozen" assertions were preserved.
- Two of the seven multipart scenarios could only be driven to `DRAINING` rather
  than `FROZEN`, because the database legitimately could not verify a completed
  drain while a write was parked or an arm was unresolved. Both states refuse new
  writes, and both are recorded above rather than presented as `FROZEN`.

## Reproducing

```bash
# from the repo root, with the storage state captured from the test env
cd apps/web
E2E_STORAGE_STATE=/tmp/opencode/bt-auth.json \
E2E_BASE_URL=https://beaconhs-test.xuhaoqing.top \
pnpm exec playwright test e2e/phase-bq-frozen-ux.spec.ts --workers=1

E2E_STORAGE_STATE=/tmp/opencode/bt-auth.json \
E2E_BASE_URL=https://beaconhs-test.xuhaoqing.top \
pnpm exec playwright test e2e/phase-bq-multipart-freeze.spec.ts --workers=1
```

The multipart suite needs the 256 MiB fixture at
`/tmp/opencode/bq-multipart-fixture.pdf`; `e2e/helpers/multipart-fixtures.ts`
generates and hashes it. Freeze control defaults to
`ssh beaconhs-drill docker exec beaconhs-phase-aj-worker-1 …` and can be
overridden with `E2E_FREEZE_SSH`, `E2E_FREEZE_CONTAINER`, `E2E_FREEZE_DRIVER` and
`E2E_FREEZE_TSX`.
