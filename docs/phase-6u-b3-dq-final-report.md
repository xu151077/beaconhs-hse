# Phase 6U-B3-DQ — Final report

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Scope: **design and risk assessment only** — no container created, no port opened, no remote change.

## 1. Summary

The mirror is feasible and the essential facts are verified: the local Collabora image is **byte-identical** (`sha256:4e983196…`) to phase-aj's, and phase-aj is a **same-origin, path-routed** deployment (`/browser`, `/cool`, `/hosting` on the app origin, TLS terminated by Traefik). A local mirror therefore needs one new proxy container plus one new Collabora container on a separate Compose project and port; nothing else.

Two findings change how this should be planned:

1. The deploy workflow pins a **different** Collabora digest (`df33af88…`) from what phase-aj actually runs (`4e983196…`). A mirror built from the CI pin would not match the environment under investigation.
2. The predicate DP could not satisfy — a **server-side** stall — is reachable only by changing Collabora's own configuration (logging level, possibly `per_document` limits), which is legitimate **in a throwaway mirror** and illegitimate on phase-aj.

## 2. Deliverables

| Report                                       | Content                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `phase-6u-b3-dq-local-mirror-design.md`      | topology, exact resources, proxy requirements from evidence, risks, cleanup      |
| `phase-6u-b3-dq-tile-backpressure-method.md` | what to measure, the three-leg predicate, levers and how they must be classified |

## 3. Exact resource scope if approved

| Kind            | Name                                                          | Notes                                                                            |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Compose project | `dn-mirror`                                                   | `docker compose -p dn-mirror down -v` removes everything                         |
| Container       | `dn-mirror-proxy-1`                                           | path router + WS upgrade, `127.0.0.1:3200`                                       |
| Container       | `dn-mirror-collabora-1`                                       | `collabora/code@sha256:4e983196…`, `127.0.0.1:9981`, `logging.level=information` |
| Network         | `dn-mirror_default`                                           | isolated bridge                                                                  |
| Volumes         | none persistent                                               | optional read-only branding bind                                                 |
| Ports           | `3200` (proxy), `9981` (Collabora) — both loopback            | no LAN exposure                                                                  |
| Storage         | existing local MinIO, **new key prefix** `t/<mirror-tenant>/` | separable from dev data                                                          |
| Tenant          | one **new** mirror tenant                                     | not demo, not phase-aj                                                           |
| Build           | app image from the same commit (`51a899b7…`)                  | byte-identity with `phase-cq` not achievable                                     |

## 4. Cleanup plan

1. `docker compose -p dn-mirror down -v --remove-orphans`
2. remove any mirror-specific images built for it
3. delete only `t/<mirror-tenant>/` keys from the local bucket
4. delete the mirror tenant row once its id is confirmed
5. delete `/tmp/opencode/phase-dq/mirror-evidence`

The dev stack (`beaconhs-*`) and phase-aj are outside every step.

## 5. Items requiring authorisation

| #   | Operation                                                                                      | Why it needs approval                                              |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | Create `dn-mirror` project with 2 containers on loopback ports 3200/9981                       | new local containers and listeners                                 |
| 2   | Set `logging.level=information` (and keep `WebSocket`/`Socket` logging) **in the mirror only** | a configuration change, albeit local                               |
| 3   | Build an app image from HEAD for the mirror                                                    | image build on this host                                           |
| 4   | Create a mirror tenant + object prefix in local Postgres/MinIO                                 | new local data                                                     |
| 5   | Optionally lower `per_document` limits in the mirror                                           | changes Collabora behaviour; results must be classified separately |
| 6   | Repeat the experiment on phase-aj to confirm any finding                                       | remote test run (already the established pattern)                  |

Nothing in items 1–5 touches production, phase-aj, or the drill stack.

## 6. Blocking limitations to accept up front

- No Cloudflare TLS or injected scripts → a Cloudflare-specific cause cannot be seen.
- No `__Secure-` cookie context → authentication behaves differently.
- No host contention equivalent to 14 containers → resource pressure must be induced deliberately, which changes the mechanism.
- The app image will be a build of the same commit, not the deployed `phase-cq` bytes.

Any mirror result is a **mechanism hypothesis** that must be re-confirmed on phase-aj.

## 7. Status

| Item                                  | Status                       |
| ------------------------------------- | ---------------------------- |
| Image identity verification           | PASS                         |
| phase-aj same-origin routing analysis | PASS                         |
| Mirror design and risk assessment     | PASS                         |
| Backpressure measurement method       | PASS                         |
| Mirror creation                       | **NOT RUN** (by instruction) |
| Tile backpressure established         | **NOT RUN**                  |
| WOPI root cause                       | **FAIL / BLOCKED**           |

## 8. Files changed

- `docs/phase-6u-b3-dq-local-mirror-design.md` (new)
- `docs/phase-6u-b3-dq-tile-backpressure-method.md` (new)
- `docs/phase-6u-b3-dq-final-report.md` (new)
- `docs/phase-6u-b3-cv-release-readiness.md` (updated)

## 9. Git / environment

Branch `hse-platform`, HEAD `51a899b7aac0a942da327222a3eed355fca9798a`, 0 staged, no commit/push/deploy. No container, image, port, network, volume, tenant, or remote configuration was created or modified. All pre-existing workspace changes preserved.

## 10. Release status

**Unchanged: blocked** by the intermittent phase-aj frozen-navigation failure. DQ adds a credible plan to reach the one condition that has never been reproduced — **server-side tile backpressure** — but nothing was executed, so it does not move the root-cause verdict.
