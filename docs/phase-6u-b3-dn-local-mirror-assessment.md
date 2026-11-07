# Phase 6U-B3-DN — Local mirror assessment

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

Scope: **assessment only.** No container was created, no image was deployed, no configuration changed. Every item that would require a new container is listed with its scope, risk and cleanup so it can be approved or rejected.

## 1. What is already identical

| Component               | phase-aj                                                                  | This workstation                                         | Identical?                      |
| ----------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------- |
| Collabora image digest  | `sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c` | **same digest** (`collabora/code:latest` resolves to it) | **yes**                         |
| Collabora version       | 26.04.4.2 (log paths)                                                     | same                                                     | yes                             |
| `extra_params`          | `ssl.enable=false`, `frame_ancestors`, `home_mode`, `max_file_size`       | same set                                                 | yes                             |
| App image               | `beaconhs:phase-cq-20261019-driver`                                       | not present locally                                      | **no**                          |
| WOPI callback base      | `http://web:3000` (in-network service name)                               | `http://host.docker.internal:3000`                       | **different form, same effect** |
| Public origin           | `https://beaconhs-test.xuhaoqing.top` (Cloudflare Tunnel)                 | `http://localhost:3000` over plain HTTP                  | **no TLS, no tunnel**           |
| Collabora `aliasgroup1` | `http://web:3000`                                                         | `http://host.docker.internal:3000`                       | equivalent allow-list entry     |

## 2. What cannot be reproduced locally without changing the stack

1. **Same-origin iframe.** On phase-aj, Collabora is served on the app origin via Traefik path routes (`/browser`, `/cool`, `/hosting`), so the iframe is same-origin and shares `localStorage` and cookies. Locally, `COLLABORA_URL=http://localhost:9980` is a **different origin** (`localhost:9980` vs `localhost:3000`). The iframe/cookie/localStorage interaction that the failure may depend on is therefore structurally different.
2. **HTTPS + Cloudflare Tunnel.** phase-aj traffic passes through Cloudflare, which injects `beaconhs-test…/cdn-cgi/*` scripts (the CSP-blocked `beacon.min.js` in every trace) and terminates TLS. Locally there is neither.
3. **Host resource profile.** phase-aj runs on `ceshi-Virtual-Machine` alongside the drill stack (14 containers total); the local workstation has different CPU/RAM contention. A renderer stall hypothesis cannot be tested equivalently.
4. **App image.** The exact `phase-cq` image is not on this host; building an equivalent image is possible (`Dockerfile` + the required `next_server_actions_key` secret) but would not be byte-identical.

## 3. What a local mirror would still buy

- **Unrestricted CDP and container access**: `docker exec` into Collabora, `docbroker` inspection, raising `logging.level`, and renderer metrics — none of which phase-aj allows.
- **Free instrumentation of the app image**: an instrumented build could log WOPI/`CheckFileInfo` timing without touching the remote stack.
- **Repeatability**: the same sequence could be run dozens of times unattended.

## 4. Proposal (requires approval — NOT executed)

| Item               | Detail                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope              | one throwaway local Compose project (`dn-mirror`) using the **existing** `collabora` and `minio`/`postgres`/`redis` services, plus a locally built app image                                                                                    |
| Change             | pin `collabora/code@sha256:4e983196…`; serve Collabora same-origin through a local reverse proxy (one extra small container, e.g. Caddy) so the iframe is same-origin like phase-aj; raise `logging.level` to `information` for the mirror only |
| Risk               | local-only; ~2–4 GB RAM, one extra proxy container, a new volume for mirror logs. No remote effect.                                                                                                                                             |
| Cleanup            | `docker compose -p dn-mirror down -v`; remove the locally built image; delete the mirror log volume                                                                                                                                             |
| What it cannot fix | TLS termination by Cloudflare, the exact public origin, and phase-aj's host contention                                                                                                                                                          |

## 5. Renderer health observation (no container needed)

`Performance.getMetrics` and `page.on('crash')` can be added to the **existing** phase-aj spec with no remote change. Metrics worth aligning with CDP frame/WebSocket events:

- `JSHeapUsedSize`, `JSHeapTotalSize` (renderer memory growth during the frozen navigation);
- `TaskDuration`, `ScriptDuration` (main-thread saturation);
- `LayoutCount`, `RecalcStyleCount` (layout storms while an iframe tears down);
- `page.on('crash')` and `page.on('close')` for a renderer kill.

If the DK failure is a renderer stall rather than a frame-lifecycle defect, `TaskDuration` would spike while `Page.frameStoppedLoading` is missing — a clean discriminator that needs no new infrastructure.

## 6. Status

**PARTIAL** — the assessment is complete and the image identity is verified, but no mirror was built and no renderer metrics were collected, because both need approval and the batch had not yet produced a failure to measure.
