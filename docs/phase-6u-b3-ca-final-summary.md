# Phase CA — Final Summary

Date: 2026-10-18

## A. Execution status

| Item                          | Status                                             |
| ----------------------------- | -------------------------------------------------- |
| Config recovery (env mapping) | BLOCKED — mapping not recoverable without guessing |
| Deployment of PDF fix image   | BLOCKED — compose config missing/unverified        |
| PDF browser E2E (HTTPS)       | NOT RUN — requires deployment                      |
| Freeze / Multipart regression | NOT RUN this phase (unchanged by fix; BQ 11/11)    |
| Permission regression         | Covered by existing tests (2033 passed)            |
| Quality gates (6)             | PASS (all exit 0)                                  |
| Environment cleanup           | PASS — no changes made, services healthy           |

## B. Evidence

- HEAD: `51a899b7` (`hse-platform`), working tree preserved, no commits/pushes.
- Running image: `beaconhs:phase-bp-20261018-095008` (`474ccda68ed4`), untouched.
- Ready image: `beaconhs:phase-bu-20261018-131209` (`23dae17b12ae`), contains both fixes (verified by extracting files from the image).
- Test env: `https://beaconhs-test.xuhaoqing.top/login` → 200.
- Gates: format 0, typecheck 0, lint 0, test 0 (2033 passed, 8 skipped), deadcode 0, build 0.
- Browser harness (Phase BU): valid 255 MiB renders 0.4 s; 256 MiB malformed + watchdog → no crash; same file without watchdog → crash at 39.1 s (negative control).

## C. Unresolved items

1. **Deployment config recovery** — `phase-aj-compose-final.yaml` missing; env mapping (DRILL_* → DATABASE_URL/R2_*/secrets) unverified. Blocks deployment. Minimal next step: reconstruct the `environment:` block from the running container's full env (host-local, gitignored), verify, then deploy.
2. **HTTPS product-path E2E** — blocked on deployment.
3. **Freeze/Multipart re-verification** — not re-run; code unchanged by this fix.

## D. Final state

**BLOCKED** — the deployment configuration cannot be safely recovered, so the PDF
fix image was not deployed and the HTTPS browser acceptance was not performed.
The fix itself is complete and fully verified locally (unit tests, browser
harness with negative control, all six gates). The image is built and ready.

## Deliverables

- `docs/phase-6u-b3-ca-env-recovery.md`
- `docs/phase-6u-b3-ca-deployment-report.md`
- `docs/phase-6u-b3-ca-pdf-e2e-report.md`
- `docs/phase-6u-b3-ca-freeze-regression-report.md`
- `docs/phase-6u-b3-ca-defect-register.md`
- `docs/phase-6u-b3-ca-final-summary.md`

## Recommended next step

Recover the `environment:` block from the running container's full env (host-local,
gitignored), update `phase-aj-compose-candidate.yaml`, run `docker compose config`,
then deploy `beaconhs:phase-bu-20261018-131209` and run the HTTPS browser checks.
No commits or pushes until verification is complete.
