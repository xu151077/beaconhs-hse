# BA — Freeze & Collabora E2E Closure

Date: 2026-10-16 (UTC ~06:52). Branch `hse-platform`.
No commit or push performed.

## Runtime evidence (non-destructive)

1. Remote app image is `beaconhs:phase-ap-an-20261016`.
2. Env in the web container:
   - `R2_ENDPOINT=https://beaconhs-test.xuhaoqing.top`
   - `PUBLIC_APP_URL=https://beaconhs-test.xuhaoqing.top`
   - `COLLABORA_URL=http://127.0.0.1:3015` (pointing at the gateway)
   - `COLLABORA_DISCOVERY_URL=http://172.18.0.1:3002` (gateway hop)
3. Live CSP now includes `https://beaconhs-test.xuhaoqing.top`.
4. A normal `pages` navigation to `/login` showed the app usable; file drawer is accessible.
5. No isolated tenant for Freeze was confirmed; the available tenant is `Phase AJ Test Tenant`.

## Freeze status — NOT RUN

Reason:

- The only reachable tenant is the shared `Phase AJ Test Tenant`. Freezing it would risk writes and
  lock downstream browser checks or other users.
- There is no currently visible `freeze*`/`admin.*freeze*` UI to perform the state transitions as a
  normal tenant admin.
- The realistic state-machine path (`ACTIVE -> FREEZE_REQUESTED -> DRAINING -> FROZEN -> RECONCILING ->
ACTIVE`) was not exercised in a browser due to lacking a safe, isolated test tenant.

Evidence already available from prior phases:

- Code-level DB tests proved the state-machine/API behavior 16 pass + injected shell behavior
  (`applyTransition`, `requireFreezeState`, freeze gate).
- No browser HTTP refusal or UI error logs were captured for either 200 or 423 transitions in this
  round.

No freeze transition was executed; **remaining: BLOCKED / NOT RUN**, safe-constrained.

## Collabora status — NOT RUN

Intelligence gathered:

- WOPI discovery XML responds successfully.
- The available document editor shows `In-browser editing is not configured` and WOPI
  `PutFile` could not be observed in browser automation.
- No `Save` response was obtained, so edit persistence claims cannot be made.
- No production or shared service was changed in this round.

## Cleanup and safety

- No test tenant changes.
- No freeze transition.
- No large file beyond prior experiment remains staged.
- Image and runtime evidence stays on the healthy upgraded target.

## Status matrix

| Area                                     | Status      | Evidence                                                         |
| ---------------------------------------- | ----------- | ---------------------------------------------------------------- |
| Remote image/CSP and pre-signed host fix | PASS        | `docker inspect` = phase-ap-an-20261016 + curl CSP               |
| Single-file browser upload + SHA match   | PASS        | captured earlier (AS)                                            |
| Multipart browser upload + SHA match     | PASS        | captured via 5 parts and attachment size/SHA from local ax phase |
| Freeze DB state machine/E2E logic        | PASS (code) | prior DB tests                                                   |
| Freeze browser 200->423->restore         | NOT RUN     | shared tenant isolation blocker                                  |
| Collabora full edit/save                 | NOT RUN     | editor integration not ready                                     |
| G2                                       | BLOCKED     | freeze + Collabora + prod checklist remain open                  |

## Recommendation to operator

- Provision a separate test tenant with `[allowedToMutate]` capability or documented test-only account.
- Re-run only the freeze + Collabora scripts against that tenant with explicit recovery steps.
- Do not assert PASS for freeze UI or Collabora without the observed browser sequence.  
  — **Not a PASS for G2.**
