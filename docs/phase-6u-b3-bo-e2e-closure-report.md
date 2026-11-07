# Phase 6U-B3 / BO — End-to-End Closure Report

- **Date:** 2026-10-17
- **Environment:** `https://beaconhs-test.xuhaoqing.top`
- **Deployed image (verified):** `beaconhs:phase-bl-20261017-000000` (HEAD-built)
- **Suite:** `apps/web/e2e/phase-bo-e2e.spec.ts` (Playwright `@playwright/test`)
- **Login:** captured Better-Auth session (`/tmp/beaconhs-e2e-auth.json`) for
  `admin@beaconhs.local`; anonymous checks run in a cookie-less context.
- **No commit, no push, no destructive git** was performed.

## 1. Headline result

| Scenario                                               | Outcome                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| **A — Collabora open → edit → save → re-download**     | ✅ **PASS**                                                |
| **B — Upload → download integrity + Unicode filename** | ⚠️ **PARTIAL** — SHA-256 integrity ✅, Chinese filename ❌ |
| **C — Storage Freeze state machine**                   | ⛔ **BLOCKED** (no web surface; see §3)                    |

## 2. Executed / passed / failed / skipped / blocked

**Phase BO E2E suite (Playwright, this phase):**

| Metric                 | Count                                 |
| ---------------------- | ------------------------------------- |
| Executed               | **4**                                 |
| Passed                 | **3**                                 |
| Failed                 | **1** (Scenario B — Unicode filename) |
| Skipped                | **0**                                 |
| Blocked (not runnable) | **1 scenario** (Storage Freeze)       |

**Evidence backends also exercised, counted separately:**

| Kind                                     | Count                   | Notes                                            |
| ---------------------------------------- | ----------------------- | ------------------------------------------------ |
| E2E module renders                       | 24 / 24                 | every navigation module loaded in a real browser |
| Interface-probe (HTTP only, **not** E2E) | 4 admin/platform routes | reported as probe, not E2E                       |
| Security E2E (anonymous guard)           | 4 routes                | all redirected to `/login`                       |
| Performance samples (Navigation Timing)  | 6 (3 pages × 2)         | measured, see §4                                 |

Nothing that was only interface-probed or only compile-level is presented as a
passing E2E test.

## 3. Scenario detail

### Scenario A — Collabora edit + save persists ✅ PASS

Steps executed against the live app:

1. Created a document via the UI and started the server-side blank master
   (`blankDocxBuffer()`).
2. Opened Writer (`Write` → `cool.html?WOPISrc=…` WOPI frame) — a real Writer UI
   loaded (`文件/开始/插入/…`, page 1/1, word & character counters).
3. Typed a unique marker `BHS-E2E-COLLABORA-EDIT-20261017`; the status bar
   updated to **1 个单词，31 个字符** (31 chars = the marker length).
4. Pressed **Ctrl+S** in the editor.
5. Downloaded the master via the authenticated route and inspected
   `word/document.xml`.

**Result:** the downloaded master is a valid Word 2007+ file (20 622 B) whose
`word/document.xml` **contains the exact marker**, and its SHA-256 differs from
the blank master — the edit was genuinely persisted through the WOPI host, not a
UI illusion. A reload of the document still reported 1 word / 31 characters.

> Environment fix applied during this phase (not a code change): the remote
> Collabora container was mis-configured — `ssl.termination` was off, so
> discovery advertised `http://` action URLs while `COLLABORA_URL` was `https://`,
> and `apps/web/src/lib/collabora.ts::validatedActionUrl` correctly rejected the
> origin mismatch. Set `--o:ssl.termination=true` and
> `--o:net.frame_ancestors=https://beaconhs-test.xuhaoqing.top` on the test-env
> compose file (matching `deploy/local-production.compose.yaml`) and recreated the
> container. Editor then loaded.

### Scenario B — Integrity ✅ / Unicode filename ❌

Fixture: a real 20 622-byte DOCX stored under the Chinese name `测试文档.docx`
(SHA-256 `d86b84b4…`; deliberately distinct from the server blank master
`ca7fdcd0…` so the integrity check is discriminating).

1. Imported the fixture through the Documents "Replace" uploader.
2. Polled `GET /documents/{id}/master` until the stored bytes were the fixture.
3. Asserted length + SHA-256, then the `Content-Disposition` header.

| Check                                               | Result      |
| --------------------------------------------------- | ----------- |
| Downloaded length = uploaded length (20 622)        | ✅ PASS     |
| Downloaded SHA-256 = uploaded SHA-256 (`d86b84b4…`) | ✅ PASS     |
| `Content-Disposition` preserves the Chinese name    | ❌ **FAIL** |

Observed header on the running image:

```
attachment; filename="_.docx"
```

Expected (working-tree fix):

```
attachment; filename="测试文档.docx"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3.docx
```

Root cause: the deployed image is HEAD-built; HEAD's
`apps/web/src/app/(app)/documents/[id]/master/route.ts` collapses any run of
non-word characters to a single `_`, so `测试文档.docx → _.docx`, and it emits no
RFC 5987 `filename*` parameter. The ASCII path is unaffected
(`untitled-…-docx` downloads correctly).

**The byte pipeline is sound; only the filename header is wrong, and only
because the fix is undeployed.**

### Scenario C — Storage Freeze ⛔ BLOCKED

The requested traversal
(`ACTIVE → FREEZE_REQUESTED → DRAINING → FROZEN → RECONCILING → ACTIVE`) could
**not** be executed through the product.

Reason: the freeze transitions are implemented only in
`packages/db/src/storage-freeze-operations.ts` and gated in
`packages/storage/src/freeze-gate.ts`. **No page or server action in
`apps/web` drives a transition**, so there is no user-facing flow to test. Both
tenants are currently `ACTIVE`:

| tenant_id                                     | state  | version | last_transition_by       |
| --------------------------------------------- | ------ | ------- | ------------------------ |
| `de8a882e…` (Phase AJ Test Tenant)            | ACTIVE | 2       | `ak-phase-ak-probe`      |
| `ea5a149b…` (Phase BB Isolated Freeze Tenant) | ACTIVE | 5       | `phase-bb-freeze-script` |

The isolated tenant exists and has a prior **script-driven** traversal on record
(`storage_freeze.evidence` contains drain/arm verification), so the state machine
itself is exercised by the package test suite. Driving it again from this phase
would require direct DB access on the shared test host or a deploy, and would be
script-driven rather than E2E — so it is reported **BLOCKED**, not passed.

## 4. Performance (measured, not estimated)

Measured with the Navigation Timing API in the live browser, two samples per
page (first number = cold, second = warm):

| Route        | TTFB (ms) | DOMContentLoaded (ms) | Load (ms)  | FCP (ms)  | Transfer (KB) | Decoded (KB)  |
| ------------ | --------- | --------------------- | ---------- | --------- | ------------- | ------------- |
| `/documents` | 373 / 89  | 717 / 735             | 718 / 736  | 428 / 416 | 285 / 287     | 1 509 / 1 509 |
| `/dashboard` | 450 / 62  | 844 / 781             | 849 / 786  | 488 / 448 | 283 / 281     | 1 421 / 1 421 |
| `/reports`   | 406 / 65  | 733 / 700             | 1017 / 701 | 440 / 376 | 280 / 283     | 1 419 / 1 416 |

**Measured:** TTFB, DOMContentLoaded, Load, FCP, transferred and decoded bytes.
**Not collected:** server-side render time attribution, worker/queue latency,
and any load/soak profile.

Observation: decoded payload is ≈1.4–1.5 MB per page while transfer is
≈280–290 KB — the pages are highly compressible but relatively heavy on decode.
No budget or assertion is applied to this; it is recorded as measured baseline.

## 5. Security regression (anonymous access)

For `/dashboard`, `/documents`, `/admin`, `/platform/tenants` in a cookie-less
browser context, a real page load **redirected the user to `/login`** every time
(login form rendered, `finalUrl=/login`).

Important nuance recorded deliberately: an `APIRequestContext` probe that does
not run JS sees `200` on those routes, because the app authenticates
**client-side** — the SSR shell is served and the shell then navigates to
`/login`. The BO suite therefore asserts the **final browser URL**, not the raw
HTTP status.

## 6. Quality gates (each exit code captured individually)

| Gate      | Command               | Exit  |
| --------- | --------------------- | ----- |
| Format    | `pnpm format:check`   | **0** |
| Typecheck | `pnpm typecheck`      | **0** |
| Lint      | `pnpm lint`           | **0** |
| Test      | `pnpm test`           | **0** |
| Dead code | `pnpm deadcode:check` | **0** |
| Build     | `pnpm build`          | **0** |

Unit-test detail (from the `test` gate output):

- `@beaconhs/web`: **2015 passed**, 8 skipped
- `@beaconhs/storage`: **148 passed**
- `@beaconhs/auth`: **78 passed**, 13 skipped
- `@beaconhs/forms-pdf`: **19 passed**

The harness itself prints that `SEED_TEST_SCRATCH_DATABASE_URL`-gated scenarios
are **skipped, not passed**; they are reported here as skipped.

## 7. What was changed that is not yet verified in the running image

Working-tree edits made in this phase (all pass the six gates locally):

- **Download-route unification** (fixes D-BO-1 and reduces D-BO-2):
  - `apps/web/src/app/(app)/documents/[id]/master/route.ts`
  - `apps/web/src/app/(app)/documents/[id]/versions/[versionId]/download/route.ts`
    both now funnel through `apps/web/src/lib/content-disposition.ts`.
- **E2E suite:** `apps/web/e2e/phase-bo-e2e.spec.ts` (new).
- **Repo hygiene for Playwright artifacts:** `.gitignore` and `.prettierignore`
  now exclude `test-results/` and `playwright-report/` (Playwright writes
  machine-generated `.md`/`.json` there, which otherwise broke `format:check`).
- **Docs:** the three BO reports, plus a dated addendum in
  `docs/project-development-state.md`.

Because the running image predates these edits, the closure results above still
reflect the running image's `_.docx` behaviour for Scenario B.

## 8. Remaining risk / not verified

- Scenario B's Unicode-filename requirement stays **FAIL** until the working
  tree is built and deployed (see defect register D-BO-1).
- Storage Freeze stays **BLOCKED** until a UI/script surface is run on the
  isolated tenant.
- No record-level CRUD lifecycle for each module was exercised; module coverage
  is render-level.
