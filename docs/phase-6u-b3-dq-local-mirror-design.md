# Phase 6U-B3-DQ — Local same-origin mirror design

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Scope: **design and risk only.** No container was created, no port opened, no configuration changed.

## 1. Image identity — verified

| Location         | Image reference                   | Digest                                                                    | State                  |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------- | ---------------------- |
| phase-aj         | `collabora/code@sha256:4e983196…` | `sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c` | running (7 containers) |
| this workstation | `collabora/code:latest`           | **same digest** `sha256:4e983196…`                                        | running (local stack)  |

The local image is **byte-identical** to the remote one — the mirror starts from the correct collabora build, not from `latest` semantics.

The deploy workflow pins a _different_ digest (`collabora/code:26.04.2.1.1@sha256:df33af88…`). That pin is not what phase-aj is running today; the mirror must use `4e983196…` to match the environment under investigation.

## 2. What phase-aj actually does (verified from the running stack)

| Requirement                          | Value on phase-aj                                                                  | Source                   |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------ |
| App origin                           | `https://beaconhs-test.xuhaoqing.top`                                              | web env                  |
| `COLLABORA_URL`                      | **the app origin itself** (same-origin)                                            | web env                  |
| `COLLABORA_WOPI_URL`                 | `http://web:3000` (in-network name)                                                | web env                  |
| `aliasgroup1` (Collabora allow-list) | `http://web:3000`                                                                  | collabora env            |
| `net.frame_ancestors`                | `https://beaconhs-test.xuhaoqing.top`                                              | collabora `extra_params` |
| `ssl.enable` / `ssl.termination`     | `false` / **`true`** (TLS terminated by Traefik)                                   | collabora `extra_params` |
| Collabora listener                   | `9980/tcp`, published `127.0.0.1:3015` on the host                                 | docker inspect           |
| Browser-facing paths                 | `/browser/…` (assets, `cool.html`), `/cool/ws` (WebSocket), `/hosting/discovery`   | discovery XML + DK trace |
| `/cool/ws` evidence                  | `wss://beaconhs-test.xuhaoqing.top/cool/ws` status 101, upgraded through the proxy | DK/DL traces             |

So phase-aj is **not** "app on one origin, Collabora on another": both are the same origin, and Traefik splits by path. That is the property the local stack lacks — locally `COLLABORA_URL=http://localhost:9980` is a **different origin** from the app at `http://localhost:3000`, and the discovery XML returns `urlsrc="http://127.0.0.1:9980/browser/…"`.

## 3. Proposed mirror topology (additive, isolated)

```
                     ┌──────────────────────────────┐
  browser ─────────► │ dn-mirror-proxy  :3200       │  (new, throwaway)
                     │  /             → app:3000    │
                     │  /browser/*    → collabora   │
                     │  /cool/*       → collabora   │  (WebSocket upgrade)
                     │  /hosting/*    → collabora   │
                     └───────┬──────────────┬───────┘
                             │              │
                   ┌─────────▼────┐  ┌──────▼─────────────┐
                   │ app (existing│  │ collabora (new    │
                   │ local web,   │  │ container, same    │
                   │ :3000)       │  │ digest, :9981)     │
                   └──────┬───────┘  └────────────────────┘
                          │   WOPI callback: /wopi/files/* on the proxy origin
```

| Resource        | Value                                                                                                                                                                                         | Why                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Compose project | `dn-mirror` (separate from `beaconhs`)                                                                                                                                                        | isolation; `down -v` cannot touch the dev stack                                                                    |
| New containers  | 1 proxy (e.g. `caddy:2` or `nginx:alpine`), 1 Collabora                                                                                                                                       | the smallest set that gives same-origin routing                                                                    |
| Ports           | `127.0.0.1:3200` (proxy) only; Collabora published only on `127.0.0.1:9981`                                                                                                                   | loopback only, no LAN exposure                                                                                     |
| Network         | dedicated bridge `dn-mirror_default`                                                                                                                                                          | no shared network with the dev stack                                                                               |
| Volumes         | none persistent; optional bind of `deploy/collabora-branding.js` read-only                                                                                                                    | mirror must not accumulate state                                                                                   |
| Storage         | reuse the existing local MinIO bucket **with a new prefix** `t/<mirror-tenant>/…`                                                                                                             | keeps object data separable                                                                                        |
| Tenant          | a **new** isolated tenant created for the mirror (not the demo tenant, not the phase-aj tenant)                                                                                               | no cross-contamination                                                                                             |
| Collabora env   | `aliasgroup1=http://dn-mirror-proxy:3200`, `ssl.enable=false`, `ssl.termination=true`, `server_name=localhost:3200`, `frame_ancestors=http://localhost:3200`, **`logging.level=information`** | reproduces the same-origin + proxy-terminated TLS shape _and_ enables the docbroker detail phase-aj cannot provide |

## 4. Why the proxy is mandatory

Without it, `COLLABORA_URL=http://localhost:9980` means the app's discovery returns a `urlsrc` on a **different origin**, the iframe is cross-origin, `frame_ancestors` has to name that other origin, cookies/localStorage are not shared, and `/cool/ws` is a cross-origin socket. Every one of those is a structural difference from phase-aj, and the DK failure is precisely an iframe/socket-lifecycle problem. A mirror without the proxy would be testing a different system.

## 5. Proxy requirements, taken from the phase-aj evidence

1. **Path routing**, not host routing: `/browser`, `/cool`, `/hosting` → Collabora; everything else → app.
2. **WebSocket upgrade** on `/cool/ws` (phase-aj shows HTTP 101 with a long-lived socket — 158 s in DK).
3. **`X-Forwarded-*` headers** and, for TLS termination, `ssl.termination=true` in Collabora so it builds `https://` WOPI URLs when behind the proxy.
4. **No buffering on `/cool/ws`** (proxy read timeout must exceed the 158 s socket lifetime; the failure window in DK included a socket open that long).
5. **Same-origin `frame_ancestors`**: `http://localhost:3200`.
6. `server_name` set, otherwise Collabora's admin/discovery complain about an unknown host (the local stack already returns 400 from `/admin`).

## 6. Resource and risk envelope

| Risk                                                                               | Mitigation                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAM/CPU contention on a ~3.4 GB host (AGENTS.md notes OOM-killed Next dev servers) | run the mirror alone; no parallel Playwright; `--memory` cap on Collabora (e.g. 1.5 GB) is **not** applied, because capping distorts the very resource behaviour under study — instead the mirror runs when nothing else is. |
| Accidentally targeting the dev stack                                               | different project name, different port (`3200` vs `3000`), different network, different tenant                                                                                                                               |
| WOPI token leakage into logs                                                       | `logging.level=information` logs document/session info; the mirror is throwaway and its logs are deleted with the project                                                                                                    |
| Proxy misconfiguration producing a _new_ failure mode                              | the control run must pass (frozen re-open, panel, 0 iframes) before any backpressure experiment is attempted                                                                                                                 |

## 7. Cleanup plan (exact)

```bash
docker compose -p dn-mirror down -v --remove-orphans   # containers, network, anonymous volumes
docker rmi <mirror-proxy-image> <mirror-app-image>      # if a mirror-specific app image was built
# objects: delete only keys under t/<mirror-tenant>/ in the local MinIO bucket
# tenant: delete the mirror tenant row (cascade removes its rows) — only after confirming the id
rm -rf /tmp/opencode/phase-dq/mirror-evidence
```

The dev stack (`beaconhs-*`) and the phase-aj stack are untouched by every command above.

## 8. What cannot be reproduced (and the cost to the conclusion)

| phase-aj property                                      | Local mirror                                   | Consequence for conclusions                                           |
| ------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------- |
| Cloudflare TLS + injected `cdn-cgi` scripts            | no (plain HTTP on loopback)                    | a CSP/Cloudflare-specific cause could be missed                       |
| Public DNS name                                        | no                                             | authenticated-cookie behaviour differs (`__Secure-` prefix, SameSite) |
| Host contention with 14 containers                     | no                                             | a resource-exhaustion trigger may need lowering limits deliberately   |
| `APP_URL` == `COLLABORA_URL` == public origin, exactly | approximated via the proxy at `localhost:3200` | origin-equivalence is close but not identical                         |
| Production app image `phase-cq`                        | not present locally                            | a build of the same commit is needed, not byte-identical              |

Any finding from the mirror therefore has to be re-confirmed on phase-aj before it is treated as the real cause.

## 9. Status

**PASS** for the design and the verified facts. **NOT RUN** — nothing was created. Approval list in the final report.
