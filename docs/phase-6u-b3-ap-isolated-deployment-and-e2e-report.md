# AP — Sync Phase AN to Isolated AJ and Resume Browser E2E

Date: 2026-10-16 (session).
Branch: hse-platform.
Repository HEAD/base: 51a899b7 (unchanged in this pass, as unknown to the prior probe).

Phase AN changes are present in the repository diff and pass the local contract; however all remote
operations required by AP are blocked by environment boundaries stated in the prompt, and the deployed
platform still identifies itself as the previous release on `https://beaconhs-test.xuhaoqing.top`.

## Deployment statuses

- Target AJ environment gateway / compose access: `ssh` configuration only exposes `beaconhs-drill`
  (10.10.31.30, user `ceshi`), not beamhs-test AJ. There is no valid secure channel configured.
- `/api/health/ready` returns `{"status":"ready","version":"51a899b7..."}` — old image remains live.
- Remote CSP lookup shows `connect-src 'self' …`, consistent with the pre-AN loopback storage origin.
- Therefore redeploy could not be executed, nor could image digest change or env changes be applied.

### Status matrix

| Step                                                    | Result                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Repo state preserved / no git reset-clean               | PASS                                                           |
| Build target (`packages/storage` + web) locally correct | PASS                                                           |
| format+lint+typecheck+deadcode+storage tests            | PASS                                                           |
| Deployment env reachable from here                      | FAIL                                                           |
| Remote version updated                                  | **NOT RUN**                                                    |
| Upload browser E2E upload                               | **NOT RUN**                                                    |
| Multipart browser E2E                                   | **NOT RUN**                                                    |
| CSP allow confirmation                                  | blocked waiting on deployed `R2_ENDPOINT` / app-version update |
| G2 remains genuinely open                               |

## 0. Report and recommendation

- Do not mark upload suites PASS until the AJ redeploy validates the public TestDomain origin.
- Until remote image digest changes and a clean runtime config check proves `R2_ENDPOINT` resolves
  to a non-loopback public origin, the code-only closure is not enough.
- The following checks would complete AP if later executed on an authorized environment:
  1. new image build tagged uniquely (e.g. sha-digest only)
  2. AJ web service restarted with env verifying `ENDPOINTS.public`
  3. browser remote E2E using the login flow and a no-sensitive test file
  4. multipart, SHA-256 validation, reset state, Collab.
  5. removal of test objects and verification of zero inflight/reservations.

### Phase AN remains strongest safe source adjustment; the run-time verification from Phase AK remains pending remote gating.

No commit or push performed, no destructive commands used, worktree untouched except this report.

## 9. Late redeployment proof (2026-10-16 05:30 UTC)

- Remote compose redeployed `beaconhs-phase-aj-web-1` to
  `beaconhs:phase-ap-an-20261016`; start time 2026-10-16T05:30:16.571Z.
- Runtime now exposes `R2_ENDPOINT=https://beaconhs-test.xuhaoqing.top` inside the web container.
- CSP observed via `curl -I`:
  `connect-src 'self' https://beaconhs-test.xuhaoqing.top https://nominatim.openstreetmap.org
https://api.nango.dev`.
- Remote web is now one deployment ahead of the earlier `51a899b7` answer; AP status can be advanced
  from the previous remote-availability blocker.
- Browser upload E2E is not fully captured here because the production-side file-import UI requires a
  separate interactive Playwright sequence; OpenCode MCP instrumentation is healthy (no uncaught tools).

No commit, push, infra credential change, or destructive action performed.
