# Phase 6U-B3-DJ — Deployment key gate

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. The gate that exists

`apps/web/scripts/verify-server-action-key-consistency.ts`:

- `--print` → `fingerprint=<32 hex>` (exit 0)
- `--expect <fingerprint>` → exit **0** on match, **1** on mismatch
- `--key-file <path>` → verifies the build-time key from the same file the build uses as its BuildKit secret
- missing key → exit **2** with a message that names the variable, never the value

The fingerprint is `HMAC-SHA256(key, label)`, truncated to 128 bits — non-invertible, non-replayable, and revealing only key equality. Phase DI verified the match/mismatch/rotation/rollback paths against three real standalone instances.

## 2. Is it wired into the deployment?

**No.** Inspecting `.github/workflows/deploy-dev.yml`:

- The image is built with `secrets: next_server_actions_key=${{ secrets.DEV_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY }}` (line 78) — the **build-time** key.
- The deployed stack (`deploy/dokploy-dev.compose.yaml`) sets **no** `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` on the web service, so every replica runs on the embedded build-time key.
- The workflow's readiness step polls `/api/health/ready` for `status=ready` at the exact commit SHA, which now also enforces **key validity** (Phase DH) — but not cross-instance equality.
- Nothing in the workflow invokes `verify-server-action-key-consistency.ts`.

So today the invariant holds by construction — one image, one embedded key, one replica (`replicas: ${WRITER_REPLICAS}`, restored to 1) — but it is **not mechanically checked**.

## 3. Deployment contract, pinned by tests

`apps/web/src/lib/server-action-key-deployment-contract.test.ts` (new, 5 tests, exit 0) asserts:

1. the image build carries the required BuildKit secret;
2. the deployed compose does **not** set a per-service runtime override (the build-time key is the single effective key);
3. the local-production compose, which does set one, requires it to match the build-time key;
4. the consistency gate exposes `--expect` and `--key-file` and fails with `fingerprint mismatch`;
5. readiness validates the key.

A future edit that gives one replica a different runtime key fails test 2, and one that drops the gate fails test 4.

## 4. What is still missing

- A workflow step that runs the gate before declaring the deployment healthy. For the current single-replica build-time-key deployment the check is redundant; for a multi-replica or runtime-override deployment it becomes mandatory.
- For the runtime-override mode, the gate needs the expected fingerprint supplied by the deployer (from the first instance or the secret's own fingerprint).

## 5. Status

Status: **PASS** for the gate mechanism and for pinning the deployment shapes; **PARTIAL** for automation, because the workflow does not call the gate yet. That gap is recorded, not claimed as solved.
