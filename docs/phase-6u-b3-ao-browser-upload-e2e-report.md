# AO — Real Browser Upload E2E & Collabora Verification

## 1. Scope and conclusion

Date/run: 2026-10-16 (same host). Branch hse-platform. Prod-AJ verification stopped before making any
remote mutation because the **deployed app still identifies itself as `51a899b7`** — i.e. neither
Phase AL nor Phase AN is live at `https://beaconhs-test.xuhaoqing.top` as of this pass.

Consequences:

- remote CSP/endpoint policy remains the old behaviour (`connect-src 'self' …`, presign URL host
  reported `127.0.0.1:3012` in AK evidence).
- remote browser uploads remain dependent on the same loopback URL and still cannot be treated
  as PASSED on this exact revision.

## 2. Direct remote probe (non-sensitive values recorded)

- `GET https://beaconhs-test.xuhaoqing.top/api/health/ready` -> `{"status":"ready","version":"51a899b7aac0a942da327222a3eed355fca9798a"}`
- login CSP header observed earlier in this session contained `connect-src 'self'
https://nominatim.openstreetmap.org https://api.nango.dev` (no storage origin), confirming the
  old deployment still uses a loopback presign host.
- No remote login, upload, Collab edit or state change was performed.

## 3. Code gates (current source still green)

- `pnpm typecheck`: PASS (0 errors — 27 packages)
- `pnpm lint`: PASS
- `pnpm format:check`: PASS
- `pnpm deadcode:check`: PASS
- `pnpm --filter @beaconhs/storage test`: PASS (15 files / 148 tests)
- `pnpm --filter @beaconhs/db test` (CI flags): 61 files / 501 passed + 41 skipped
- AL/AN documented the precise regression commands for full live DB behavior.

## 4. Playwright stability observation

- Playwright MCP responded and rendered `/login` without an uncaught exception.
- No browser-side upload was executed on AJ, so the required E2E result remains **NOT RUN**.

## 5. Upload/collabora status

- single-file browser upload: NOT RUN (requires deployed AN code and step-by-step Playwright, plus an
  authenticated tenant)
- multipart: NOT RUN
- SHA-256 comparison: NOT RUN
- expired URL behavior: verified at the package level through `storage` unit tests (expired arm
  rejection path), not via remote browser
- freeze gating: verified locally at DB/web runtime, not via remote browser
- Collabora editing: NOT RUN because upload itself not available against old remote image

## 6. Risks

- Deployment gap: the remote app is still one revision behind (version `51a899b7`). AO browser
  acceptance requires an infra redeploy first; no infra changes were made.
- browser E2E cannot be emulated by HTTP checks.

### Status matrix

- infra readiness: PASS
- Playwright MCP: PASS (no crash)
- single-file browser upload: NOT RUN
- multipart browser upload: NOT RUN
- expired part URL browser proof: NOT RUN
- freeze gate browser proof: NOT RUN
- Collabora browser edit: NOT RUN
- local gates: PASS
- report/doc state: complete

No commit or push performed; worktree unchanged by this passive probe except new report.
