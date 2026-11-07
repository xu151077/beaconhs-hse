# Phase 6U-B3-DI — Final report

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Summary

- **Server Action multi-instance consistency**: a non-recoverable, keyed fingerprint plus a blocking deployment gate now lets an operator prove that every instance holds the same key. Verified with three real standalone instances, including rotation and rollback.
- **WOPI Scenario 4**: still not reproducible; this phase pinned down exactly which artifacts are missing and produced one decisive negative result (the WOPI route logged no error in the phase-aj failure window).
- **File authorization**: the historical 7/7 matrix is preserved; no new cases were added because no concrete gap was identified in this phase.
- **Drill**: read-only only; no remote resource was touched.

## 2. Results

| Area                                                                  | Status            | Notes                                                                                   |
| --------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| Key consistency — same key on two instances                           | PASS              | Identical fingerprint; gate exit 0.                                                     |
| Key consistency — different keys                                      | PASS              | Different fingerprints; gate exit 1.                                                    |
| Key consistency — rotation / rollback                                 | PASS              | Fingerprint follows the change; the gate blocks a rollback against the new expectation. |
| Key consistency — output hygiene                                      | PASS              | No key material in logs, responses, or script output.                                   |
| Key consistency — end-to-end bound action across mismatched instances | NOT RUN           | No authenticated bound action could be completed in the containerized instance.         |
| Key validity (Phase DH)                                               | PASS              | Invalid override → readiness 503; missing override → 200 by design.                     |
| WOPI Scenario 4 root cause                                            | FAIL / BLOCKED    | Fault boundary still the phase-aj Collabora document session; cause unproven.           |
| File authorization matrix                                             | PASS (historical) | Phase CX 7/7, not re-run this phase.                                                    |
| Drill                                                                 | BLOCKED           | Owner approval outstanding.                                                             |

## 3. Quality gates (this phase, after the code change)

| Gate                                    |                                Exit code |
| --------------------------------------- | ---------------------------------------: |
| `pnpm format:check`                     |                                        0 |
| `TURBO_FORCE=true pnpm lint`            |                                        0 |
| `TURBO_FORCE=true pnpm typecheck`       |                                        0 |
| `TURBO_FORCE=true pnpm test --continue` | 0 (25 tasks; web 240 passed / 2 skipped) |
| `pnpm deadcode:check`                   |                                        0 |
| `TURBO_FORCE=true pnpm build`           |                                        0 |
| targeted key/readiness/CLI vitest       |                            0 (20 passed) |

## 4. Files changed this phase

- `apps/web/src/lib/server-action-key.ts` (modified — added the keyed fingerprint)
- `apps/web/src/lib/server-action-key.test.ts` (modified — fingerprint tests)
- `apps/web/src/app/api/health/ready/route.ts` (modified — logs the fingerprint once per process)
- `apps/web/scripts/verify-server-action-key-consistency.ts` (new — the deployment gate)
- `apps/web/scripts/verify-server-action-key-consistency.test.ts` (new)
- `knip.ts` (modified — one entry for the new script)
- `docs/phase-6u-b3-di-*.md` (4 new reports)
- `docs/phase-6u-b3-cv-release-readiness.md` (updated)

## 5. Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`  
Branch: `hse-platform`  
No commit, push, deploy, reset, clean, restore, or checkout was performed. 0 files staged; all pre-existing modifications and untracked files were preserved; no remote or Drill side effects.

## 6. Release status

The key-consistency gap now has a checked, blocking mechanism. **Release remains blocked** by the unproven WOPI navigation failure, and the cross-instance key invariant still depends on the deployment running the gate.
