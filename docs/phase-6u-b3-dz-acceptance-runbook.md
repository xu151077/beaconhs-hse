# Phase DZ — Unified acceptance runbook

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

This runbook is the ordered procedure for the remaining release verification. It does not
repeat static reviews; it points at the existing scripts, workflows, and tests.

## A. Remote recovery and identity verification

Precondition: SSH access to `10.10.31.30` as `ceshi` with key `~/.ssh/beaconhs_drill`.

1. `ssh -o ConnectTimeout=15 -o BatchMode=yes beaconhs-drill 'echo OK; hostname; date -u'`
   - Expected: `OK`, hostname `ceshi-Virtual-Machine`, current UTC time.
   - Failure: connection timeout / refused → stop, mark host BLOCKED, do not retry in a loop.
2. `ssh beaconhs-drill 'docker version --format "{{.Server.Version}}"; docker compose version'`
   - Expected: Docker 29.x, Compose v5.x.
3. `ssh beaconhs-drill 'uptime; free -h | head -2; df -h /home/ceshi | tail -1'`
   - Expected: load < CPU count, ≥ 4 GB available RAM, ≥ 10 GB free disk.
4. `ssh beaconhs-drill 'docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "phase-aj|drill"'`
   - Expected: both stacks' containers Up (healthy where applicable).
   - Stop if any existing service is unhealthy; do not proceed to cleanup.

Stop condition: host unreachable or existing services unhealthy → abort and report.

## B. DX temporary resource verification and safe cleanup

Precondition: section A passed.

1. `ssh beaconhs-drill 'ls -ld /home/ceshi/beaconhs-dx /home/ceshi/dx-sa-key 2>&1; docker images --format "{{.Repository}}:{{.Tag}}" | grep dx-20261020 || echo "no dx image"'`
2. Confirm ownership of each item before deletion:
   - `/home/ceshi/beaconhs-dx` is the DX source sync (not `beaconhs-phase-aj` or `beaconhs-drill`).
   - `/home/ceshi/dx-sa-key` is the DX test key (44 bytes, 0600, not referenced by any stack).
   - `beaconhs:dx-20261020` (if present) is not used by any running container.
3. Cleanup (only after confirmation):
   - `ssh beaconhs-drill 'rm -rf /home/ceshi/beaconhs-dx; rm -f /home/ceshi/dx-sa-key'`
   - `ssh beaconhs-drill 'docker rmi beaconhs:dx-20261020'` only if the image exists and is unused.
4. Verify:
   - `ssh beaconhs-drill 'ls /home/ceshi/beaconhs-dx /home/ceshi/dx-sa-key 2>&1; docker images --format "{{.Repository}}:{{.Tag}}" | grep dx-20261020 || echo "clean"'`
   - `ssh beaconhs-drill 'docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "phase-aj|drill"'` (still healthy).

Stop condition: any item's ownership cannot be confirmed → leave it and report.

## C. Create the isolated test environment

Precondition: sections A and B passed; host healthy.

Declare the resource manifest first (see `docs/phase-6u-b3-dw-environment.md` §3). Minimum for the
file-authorization matrix (no Collabora needed):

- Dedicated Docker network `dx-isolated` (bridge, not joined to existing stacks).
- Postgres 16 on host port 55433, Redis 7 on 65379, MinIO on 59000/59001, app on 53000.
- Dedicated volumes `dx-postgres-data`, `dx-redis-data`, `dx-minio-data`.
- Test image: a build from the current working tree with `DEPLOYMENT_VERSION=51a899b7…` and a
  locally generated 44-byte Server Action key (BuildKit secret). Build on the host with a
  30-minute timeout; abort and report if it exceeds.
- Fresh DB: role provisioning (`scripts/cluster/provision.sql`) + `pnpm db:migrate` +
  `pnpm db:seed`, then a second tenant with a site-scoped user and a cross-tenant user.

Cleanup plan (to run in section G): remove containers, network, volumes, test DB, test tenant,
and test objects; verify existing stacks untouched.

## D. Run the W3 file-authorization browser matrix

Precondition: section C complete; app healthy at `http://localhost:53000` on the host (tunnelled
or accessed via the host).

1. Create storage states for the site-scoped and cross-tenant users (Playwright `storageState`).
2. `E2E_BASE_URL=http://localhost:53000 CX_SITE_A_STORAGE=/tmp/opencode/dx-site-a.json CX_CROSS_STORAGE=/tmp/opencode/dx-cross.json pnpm test:e2e --grep "file authorization"`
   - Config: `apps/web/playwright.config.ts`, `testDir: ./e2e`.
   - Spec: `apps/web/e2e/phase-cx-file-authorization-e2e.spec.ts`.
3. Expected: the existing 10 cases pass; HTTP 500 is never an expected refusal.
4. For each denial, verify the resource state is unchanged (DB read-only check or object
   existence check).

Stop condition: a 500 appears where 403/404 is expected → abort and investigate the route.

## E. Run the W2 multi-replica key gate

Precondition: section C complete (app image built).

1. Start two app containers on the isolated network with the **same** test key:
   - `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<test key>` in both.
2. `scripts/ci/verify-server-action-key-gate.sh replicas dx-stack <fingerprint>` → expect exit 0.
3. Change one container's key to a different value; restart it.
4. Re-run `replicas` → expect exit 1 (mismatch).
5. Restore the original key; re-run → expect exit 0.
6. Test missing key: unset the variable in one container → expect readiness 503 / gate failure.
7. Test invalid key: set a non-base64 value → expect readiness 503 / gate failure.
8. Verify no key material in `docker logs` of any container.

Stop condition: a mismatched configuration reports success → abort and report FAIL.

## F. Trigger and check real CI (W1)

Precondition: owner authorisation to push or open a PR.

1. Push the branch (only with explicit authorisation) or open a PR against `main`.
2. Run `workflow_dispatch` if preferred.
3. Watch the `ci` job for the new steps (see `docs/phase-6u-b3-dv-ci-trigger.md` §4).
4. Confirm 0 skips in the four live DB steps and the expected counts (14, 40, 36, 16).
5. Confirm the host-safeguards step includes `verify-server-action-key-gate.test.sh` (13/13).

Stop condition: any live DB step reports a skip or a failure → abort and triage per
`docs/phase-6u-b3-dv-ci-trigger.md` §5.

## G. Summarise and clean up

1. Collect evidence: test output, status codes, image digest, container IDs, tenant IDs.
2. Update the release-readiness report with the new evidence.
3. Clean up per section C's cleanup plan.
4. Verify existing stacks are untouched (read-only).
5. Report git state (no commit/push performed).

## Commands that must not be guessed

- The compose file for the isolated stack does not exist yet; it must be written from
  `deploy/local-production.compose.yaml` or `docker-compose.yml` with isolated ports. Do not
  invent a compose file from memory.
- The test image does not exist yet; it must be built from the synced source.
- The test key must be generated on the host and stored at 0600; it must never be printed.
