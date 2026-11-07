# Phase CD — Final Summary

Date: 2026-10-18

## A. Execution status

| Item                          | Status                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| Config recovery (env mapping) | **PASS** — recovered from drill compose + running container env |
| Compose validation            | **PASS** — parses, all vars resolve, external volumes used      |
| Image build                   | **PASS** — `beaconhs:phase-cd-20261018-142237` (2.87 GB)        |
| Deployment                    | **PASS** — all app containers running on new image              |
| Data integrity                | **PASS** — 2 tenants, all tables, MinIO healthy                 |
| HTTPS health                  | **PASS** — `/login` → 200                                       |
| PDF browser E2E (HTTPS)       | **NOT RUN** — Playwright MCP lacks file upload tool             |
| Freeze / Multipart regression | **NOT RUN** — unchanged by this fix                             |
| Permission regression         | **PASS** — covered by existing tests (2033 passed)              |
| Quality gates (6)             | **PASS** — all exit 0 (from Phase BU/CA, code unchanged)        |
| Environment cleanup           | **PASS** — no data loss, volumes preserved                      |

## B. Evidence

- **Dev HEAD**: `51a899b7` (`hse-platform`), working tree preserved, no commits/pushes
- **Image**: `beaconhs:phase-cd-20261018-142237` (`sha256:8feaa82d4aa1…`), 2.87 GB
- **Image content verified**: trailer check + watchdog present in image
- **Running containers**: web-1, worker-1 on `phase-cd-20261018-142237`; base services healthy
- **Data integrity**: 2 tenants, all DB tables, MinIO healthy
- **Compose**: `/home/ceshi/beaconhs-phase-cd/compose.yaml` — external volumes, `${DRILL_*}` secret references
- **Rollback**: `beaconhs:phase-bp-20261018-095008` still on host; compose edit + `up -d` to rollback
- **Gates**: format 0, typecheck 0, lint 0, test 0 (2033 passed, 8 skipped), deadcode 0, build 0
- **Browser harness (Phase BU)**: valid 255 MiB renders 0.4 s; 256 MiB malformed + watchdog → no crash

## C. Deployment details

### Environment recovery

The Phase CB blocker was resolved by:

1. Finding `deploy/drill-20261009.compose.yaml` on the test host (original drill deployment compose)
2. Comparing its structure with the current running container's non-secret env
3. Building a new compose with: drill formula + current values + `${DRILL_*}` secret references + external volumes

### Deployment steps

1. Built image on dev machine: `docker buildx build --secret id=next_server_actions_key … -t beaconhs:phase-cd-20261018-142237 --load .`
2. Transferred to test host: `docker save | ssh beaconhs-drill docker load`
3. Created compose: `/home/ceshi/beaconhs-phase-cd/compose.yaml` with external volume references
4. Deployed: `docker compose -f compose.yaml --project-name beaconhs-phase-aj --env-file .env up -d`
5. Verified: containers healthy, data intact, HTTPS 200

### Volume incident (resolved)

First deploy attempt created new empty volumes (missing `external: true`). Immediately corrected: stopped containers, fixed compose, removed empty volumes, redeployed. No data loss.

## D. Unresolved items

1. **HTTPS product-path PDF E2E** — NOT RUN. Playwright MCP tools in this environment lack file upload capability. Requires a Playwright MCP server with `browser_set_input_files` or a custom Playwright script on the dev machine/test host.
2. **Freeze/Multipart re-verification** — NOT RUN. Code unchanged by this fix; Phase BQ results carry forward.

## E. Final state

**PASS with limitations** — the environment is recovered, the PDF fix image is deployed, and the test environment is healthy with all data preserved. The HTTPS browser PDF E2E could not be executed due to Playwright MCP tooling limitations (no file upload tool). The PDF fix itself is verified by unit tests and the Phase BU browser harness.

## Deliverables

- `docs/phase-6u-b3-cd-development-baseline.md`
- `docs/phase-6u-b3-cd-rollback-plan.md`
- `docs/phase-6u-b3-cd-environment-recovery.md`
- `docs/phase-6u-b3-cd-deployment-report.md`
- `docs/phase-6u-b3-cd-pdf-e2e-report.md`
- `docs/phase-6u-b3-cd-freeze-regression-report.md`
- `docs/phase-6u-b3-cd-permission-regression-report.md`
- `docs/phase-6u-b3-cd-defect-register.md`
- `docs/phase-6u-b3-cd-final-summary.md`

## Recommended next step

Run the HTTPS browser PDF E2E using a Playwright script with file upload capability (either on the dev machine or test host). The script should:

1. Upload a valid PDF via the documents page
2. Upload a malformed PDF (no trailer) and verify rejection
3. Preview a large PDF and verify watchdog behavior
4. Test Chinese filename download and SHA-256 round-trip

No commits or pushes until verification is complete.
