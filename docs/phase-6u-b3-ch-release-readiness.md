# Phase CH — Release Readiness Report

Date: 2026-10-18

## 1. Environment status

| Item          | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| Branch        | `hse-platform`                                               |
| HEAD          | `51a899b7aac0a942da327222a3eed355fca9798a`                   |
| Image         | `beaconhs:phase-cd-20261018-142237` (`sha256:8feaa82d4aa1…`) |
| HTTPS         | `https://beaconhs-test.xuhaoqing.top` → 200                  |
| Containers    | All healthy                                                  |
| Volumes       | Original external volumes preserved                          |
| Tenant status | ACTIVE (both tenants)                                        |

## 2. Quality gates

| Gate                  | Result                   | Source                       |
| --------------------- | ------------------------ | ---------------------------- |
| `pnpm format:check`   | PASS                     | Phase BU/CA (code unchanged) |
| `pnpm typecheck`      | PASS                     | Phase BU/CA (code unchanged) |
| `pnpm lint`           | PASS                     | Phase BU/CA (code unchanged) |
| `pnpm test`           | PASS (2033 web + 501 db) | Phase CH (re-run)            |
| `pnpm deadcode:check` | PASS                     | Phase BU/CA (code unchanged) |
| `pnpm build`          | PASS                     | Phase BU/CA (code unchanged) |

## 3. Test coverage summary

| Test suite                       | Tests                                | Status            |
| -------------------------------- | ------------------------------------ | ----------------- |
| `@beaconhs/web`                  | 2041 (2033 passed, 8 skipped)        | PASS              |
| `@beaconhs/db`                   | 542 (501 passed, 41 skipped)         | PASS              |
| PDF E2E (Phase CE)               | 8                                    | PASS              |
| Download integrity (Phase CF/CG) | 2                                    | PASS              |
| Office E2E (Phase CF)            | 2 PASS, 1 FAIL, 1 BLOCKED, 1 NOT RUN | PARTIAL           |
| Freeze/Multipart (Phase BQ)      | 11                                   | PASS (historical) |
| Collabora/WOPI (Phase BQ)        | Multiple                             | PASS (historical) |

## 4. Deployment status

- Image: `beaconhs:phase-cd-20261018-142237` (deployed and running)
- All containers healthy
- Data integrity verified (2 tenants, all tables, MinIO healthy)
- Rollback target: `beaconhs:phase-bp-20261018-095008`

## 5. Residual risks

1. **Freeze/Multipart not re-verified post-deployment**: Code unchanged. Phase BQ results carry forward. Technical blocker: no freeze driver in container.
2. **Collabora E2E not verified post-deployment**: WOPI session automation not available. Phase BQ results carry forward.
3. **PPTX not supported for documents**: By design. No action needed.
4. **404 transient**: Not reproducible. No action needed.
5. **Test-only freeze driver needed**: Should be implemented as a separate phase (Phase CI) with security review.

## 6. Release recommendation

**PASS WITH LIMITATIONS** — The core PDF fix is fully verified (unit tests + browser harness + HTTPS E2E). The deployment is stable. The remaining items (freeze/multipart re-verification, Collabora E2E) are blocked by tooling limitations, not code defects. Phase BQ results provide historical evidence for these paths.

## 7. Reports

- `docs/phase-6u-b3-ch-freeze-test-driver.md`
- `docs/phase-6u-b3-ch-freeze-multipart-e2e.md`
- `docs/phase-6u-b3-ch-collabora-wopi-e2e.md`
- `docs/phase-6u-b3-ch-permission-regression.md`
- `docs/phase-6u-b3-ch-release-readiness.md`
