# Phase 6U-B3-DH — Final report

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Summary

- **Server Action key**: a project-level fail-closed boundary now rejects a present-but-invalid runtime key at readiness (503) instead of letting it silently override the valid build-time key. Missing runtime key stays legal because the deployed stacks run on the build-time key. Cross-instance mismatch detection remains a documented framework limit.
- **WOPI**: new read-only evidence narrows the fault boundary to the phase-aj Collabora document session (stalled tiles plus a killed kit in the failure window), which never occurs locally. A proven root cause is still missing, so the failure stays FAIL/BLOCKED and no business code was touched.
- **File authorization**: the existing browser matrix (7/7) is unchanged and preserved; no new file-surface cases were added in this phase.
- **Drill**: not touched; read-only status unchanged and still awaiting approval.

## 2. Results

| Area                                                       | Status            | Notes                                                                           |
| ---------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| Server Action key — invalid override                       | PASS              | Readiness 503 on the real standalone build; log carries no key material.        |
| Server Action key — missing override                       | PASS              | Readiness 200; build-time key is the effective key by design.                   |
| Server Action key — valid override                         | PASS              | Readiness 200.                                                                  |
| Server Action key — recovery after fixing config           | PASS              | Restart with a valid key returns the instance to rotation.                      |
| Server Action key — cross-instance mismatch                | NOT RUN           | Both instances report ready; the framework exposes no detection.                |
| Server Action key — bound-argument action across instances | NOT RUN           | No authenticated bound action could be completed in the containerized instance. |
| WOPI root cause                                            | FAIL / BLOCKED    | Boundary narrowed to the phase-aj Collabora session; cause not proven.          |
| File authorization matrix                                  | PASS (historical) | 7/7 from Phase CX; not re-run this phase.                                       |
| Drill                                                      | BLOCKED           | Owner approval outstanding.                                                     |

## 3. Quality gates (executed this phase, after the code change)

| Gate                                                                                            |                                Exit code |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------: |
| `pnpm format:check`                                                                             |                                        0 |
| `TURBO_FORCE=true pnpm lint`                                                                    |                                        0 |
| `TURBO_FORCE=true pnpm typecheck`                                                               |                                        0 |
| `TURBO_FORCE=true pnpm test --continue`                                                         | 0 (25 tasks; web 239 passed / 2 skipped) |
| `pnpm deadcode:check`                                                                           |                                        0 |
| `TURBO_FORCE=true pnpm build`                                                                   |                                        0 |
| targeted: `vitest run src/lib/server-action-key.test.ts src/app/api/health/ready/route.test.ts` |                            0 (13 passed) |

## 4. Files changed this phase

- `apps/web/src/lib/server-action-key.ts` (new)
- `apps/web/src/lib/server-action-key.test.ts` (new)
- `apps/web/src/app/api/health/ready/route.ts` (modified)
- `apps/web/src/app/api/health/ready/route.test.ts` (modified)
- `docs/phase-6u-b3-dh-key-fail-closed.md` (new)
- `docs/phase-6u-b3-dh-key-negative-tests.md` (new)
- `docs/phase-6u-b3-dh-wopi-evidence.md` (new)
- `docs/phase-6u-b3-dh-final-report.md` (new)
- `docs/phase-6u-b3-cv-release-readiness.md` (updated)

## 5. Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`  
Branch: `hse-platform`  
No commit, push, deploy, reset, clean, restore, or checkout was performed. All pre-existing modifications and untracked files were preserved; no file was staged.

## 6. Release status

The Server Action key gap is now closed for the invalid-configuration case. **Release remains blocked** by the unproven WOPI navigation failure, and the cross-instance key-consistency check is still an operational requirement rather than an application-enforced one.
