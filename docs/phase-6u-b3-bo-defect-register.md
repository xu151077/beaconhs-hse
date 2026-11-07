# Phase 6U-B3 / BO — Defect Register

- **Date:** 2026-10-17
- **Environment:** `https://beaconhs-test.xuhaoqing.top` on image
  `beaconhs:phase-bl-20261017-000000`
- Scope: defects **observed during Phase BO**, with reproduction, evidence,
  impact and status. Pre-existing, already-recorded defects (D1–D6 in
  `docs/hse-development-baseline.md` §21) are referenced but not re-listed.

No gate was disabled, skipped, or suppressed to produce this register.

---

## D-BO-1 — Non-ASCII download filename is destroyed (High)

**Status:** Fix present in working tree; **NOT deployed**. Regression test added
and currently **red** against the running image.

**Symptom:** downloading a document whose stored filename contains non-ASCII
characters (e.g. `测试文档.docx`) saves as `_.docx`, losing the name entirely.

**Reproduction (running image):**

1. Sign in, open a document, import a `.docx` named `测试文档.docx`
   (SHA-256 `d86b84b4…`).
2. `GET /documents/{id}/master`.

**Evidence:** response header

```
Content-Disposition: attachment; filename="_.docx"
```

Note the absence of any `filename*=UTF-8''…` parameter. The ASCII case
(`untitled-<uuid>.docx`) is unaffected.

**Root cause:** the deployed image is built from HEAD. HEAD's
`apps/web/src/app/(app)/documents/[id]/master/route.ts` computes:

```ts
const filename = att.filename.replace(/[^\w.\- ]+/g, '_') || 'document.docx'
```

`\w` is `[A-Za-z0-9_]`, so the whole Chinese run `测试文档` collapses to a single
`_`, and only a plain `filename=` parameter is emitted.

**Fix (working tree):** the route now funnels through the shared helper
`apps/web/src/lib/content-disposition.ts`, matching every other download route:

```
Content-Disposition: attachment; filename="测试文档.docx"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3.docx
```

**Regression test:** `apps/web/e2e/phase-bo-e2e.spec.ts` → _Scenario B — upload →
download is byte-identical and keeps its Unicode name_. It asserts both the
SHA-256 round trip and `decodeURIComponent(filename*) === '测试文档.docx'`, and
the browser-saved name. The integrity half passes; the filename half fails on
the current image and will pass once the working tree is deployed.

**Deployment requirement:** build the working tree and deploy a new image, then
re-run Scenario B. (Not performed in this phase.)

---

## D-BO-2 — `Content-Disposition` is implemented in many places (Medium)

**Status:** Partially unified in the working tree; the rest is flagged, not
silently rewritten.

There are **two** competing helper implementations plus several hand-rolled
copies:

- `packages/storage/src/index.ts` exports `contentDisposition(mode, filename, fallback)`
  (used by `apps/web/src/app/api/attachments/[id]/route.ts` for presigned URLs).
- `apps/web/src/lib/content-disposition.ts` is a **near-duplicate** of it
  (used by `apps/web/src/lib/uploads.ts` — the attachment finalization path —
  and now by the two document routes unified in this phase).
- Hand-rolled copies of the RFC 5987 string remain in:
  - `apps/web/src/app/(app)/reports/definitions/[id]/export/route.ts`
  - `apps/web/src/app/(app)/training/pptx/[target]/[id]/download/route.ts`
  - `apps/web/src/app/(app)/training/records/wallet-cards/route.ts`
  - `apps/web/src/lib/csv.ts`
  - `apps/web/src/lib/pdf-route.ts`

**Impact:** divergent behaviour is exactly how D-BO-1 arose — one route kept the
RFC 5987 parameter while another dropped it.

**Recommendation:** converge on a single helper. Two constraints apply and are
the reason this was only partially actioned:

1. `AGENTS.md` forbids editing `packages/storage/**` and the attachment
   finalization path (`apps/web/src/lib/uploads.ts`) without an explicit
   request, so the web helper cannot simply be deleted here.
2. A safe convergence is to keep `apps/web/src/lib/content-disposition.ts` as a
   thin re-export of the storage package's `contentDisposition` (single logic,
   unchanged import sites) — pending an explicit go-ahead because it touches the
   finalization path's behaviour.

---

## D-BO-3 — Collabora test-env misconfiguration blocked in-browser editing (High, environment)

**Status:** Fixed in the test environment (this phase). Not a code defect.

**Symptom:** the Documents page showed "In-browser editing is not configured".

**Root cause:** the remote Collabora container ran without `ssl.termination`, so
`/hosting/discovery` advertised `http://…` action URLs while `COLLABORA_URL` was
`https://…`. `apps/web/src/lib/collabora.ts::validatedActionUrl` correctly
rejected the origin mismatch and `getCollaboraEditUrl` returned `null`.

**Fix:** set `--o:ssl.termination=true` and
`--o:net.frame_ancestors=https://beaconhs-test.xuhaoqing.top` on the test-env
compose file (aligning with `deploy/local-production.compose.yaml`) and recreate
the container. Discovery now returns `https://…` URLs and Writer loads.

**Note:** this modified the shared test-env compose file
(`/home/ceshi/beaconhs-phase-aj/phase-aj-compose-final.yaml` on the remote).
No repository file, production resource, or the shared C2 drill was touched.

---

## D-BO-4 — `405` on `GET /documents/{id}/master` (Low, unconfirmed)

**Status:** Observation only — not reproduced deterministically.

**Observed:** the browser console logged
`Failed to load resource: the server responded with a status of 405` for
`/documents/{id}/master` twice while interacting with the document detail page,
yet a direct authenticated `GET` of the same URL returns `200` with the file.

**Hypothesis:** a non-GET (prefetch/HEAD) reached the route, which only exports
`GET`. Not a user-visible failure in the tested flows.

**Action:** reproduce before treating as a defect; recorded so it is not lost.

---

## D-BO-5 — Collabora page console noise: blocked Cloudflare beacon + missing extension index (Low, cosmetic)

**Status:** Open, cosmetic.

- `static.cloudflareinsights.com` beacon is blocked by the app's CSP
  (`script-src 'self' 'unsafe-eval'`) on the Collabora page.
- `GET /browser/<id>/extensions/index.json` → `404`.

Neither affects document editing (Scenario A passes). Recorded for completeness.

---

## Regression test status summary

| Suite                               | Tests | Passed | Failed | Notes                                      |
| ----------------------------------- | ----- | ------ | ------ | ------------------------------------------ |
| `apps/web/e2e/phase-bo-e2e.spec.ts` | 4     | 3      | 1      | failure = D-BO-1 (expected until deployed) |
| Six repo gates                      | 6     | 6      | 0      | each exit code captured                    |

**Known defects deliberately not fixed in this phase** (recorded in
`docs/hse-development-baseline.md` §21, still open, untouched): D1
(`equipment.read.self` not in the permission catalogue), D2 (`people` nav has no
permission gate), D3 (dead columns), D4 (PPE failed-inspection CA omits
`recordDomainEvent`), D5 (equipment flow `statusValues` missing `'repaired'`/
`'verified'`), D6 (stale seed comment).
