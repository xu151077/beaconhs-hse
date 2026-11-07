# Phase 6U-B3-DK — Target identity verification

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Verification: read-only, before any test was run.

## 1. Connection identity

| Item          | Verified value                                                 | How                               |
| ------------- | -------------------------------------------------------------- | --------------------------------- |
| SSH alias     | `beaconhs-drill`                                               | `ssh -G`                          |
| Host          | `10.10.31.30`                                                  | `ssh -G`                          |
| User          | `ceshi`                                                        | `ssh -G` and `whoami` on the host |
| Port          | 22                                                             | `ssh -G`                          |
| Host key      | `SHA256:fkdz2n4BCf6BzcIV3DubIvJgXw4JRx9C9SG34u2fJXU` (ED25519) | `ssh-keyscan`                     |
| Identity file | configured (path redacted)                                     | `ssh -G`                          |

`whoami` on the target returns `ceshi`, `hostname` returns `ceshi-Virtual-Machine`, so the alias lands on the intended host.

## 2. Compose project and containers

| Field                               | Value                                        |
| ----------------------------------- | -------------------------------------------- |
| Compose project                     | `beaconhs-phase-aj`                          |
| Compose file (from container label) | `/home/ceshi/beaconhs-phase-cd/compose.yaml` |
| File on disk                        | `-rw-rw-r-- ceshi ceshi 5252 Oct 19 12:54`   |

Running containers (all `Up`, all healthy where a healthcheck exists):

| Container                          | Image                               | Digest             | Status            |
| ---------------------------------- | ----------------------------------- | ------------------ | ----------------- |
| `beaconhs-phase-aj-web-1`          | `beaconhs:phase-cq-20261019-driver` | `sha256:60dc4841…` | Up 14 h (healthy) |
| `beaconhs-phase-aj-worker-1`       | same                                | `sha256:60dc4841…` | Up 14 h           |
| `beaconhs-phase-aj-collabora-1`    | `collabora/code@sha256:4e983196…`   | `sha256:4e983196…` | Up 33 h (healthy) |
| postgres / redis / minio / mailpit | —                                   | —                  | Up 33 h           |

The separate `beaconhs-drill-20261009` project is **still running** (7 containers, up 15–27 h) and was **not** touched. It is a distinct project with its own network/volumes, exactly as the historical notes said.

## 3. Domain routing

- `beaconhs-test.xuhaoqing.top` resolves to Cloudflare addresses (`172.67.215.53`, `104.21.37.236`).
- On the host, a `cloudflared.service` (Cloudflare Tunnel client) is active; no Traefik/other reverse proxy container exists.
- The phase-aj web container is the only thing published on `127.0.0.1:3010`, and the tunnel is the only path from the public hostname to a local service.
- **Corroborating proof**: `GET /api/health/ready` over the public hostname returns `{"status":"ready","version":"51a899b7aac0a942da327222a3eed355fca9798a"}`, and `beaconhs-phase-aj-web-1` has `APP_VERSION=51a899b7aac0a942da327222a3eed355fca9798a`. The public hostname therefore serves the phase-aj web container at the expected commit.
- A one-off marker probe (`/__route-probe-<timestamp>`) returned 404 and did not appear in the phase-aj web log — expected, because the web container only logs request lines for some routes; the readiness version match above is the decisive identity evidence, and the probe result is recorded as inconclusive rather than contradictory.

## 4. Test tenant and document

| Item                                                               | Value                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Active tenant (from the stored session cookie `bhs-active-tenant`) | `ea5a149b-ea76-48e0-abbe-fa360f520d8e`                             |
| Document created by the test                                       | `692f70a8-e2cb-4af9-b7ff-af6ea3894915`                             |
| Document tenant (DB, read-only)                                    | `ea5a149b-ea76-48e0-abbe-fa360f520d8e` — matches the active tenant |
| Document master attachment                                         | `2bca98c8-8981-46ea-b2db-bca25246980c`                             |

The stored session is valid on phase-aj: the session row exists when the token is looked up by its pre-dot portion (Better-Auth's stored token format), and the cookie is `__Secure-…`, secure, httpOnly.

## 5. Pre-run state

| Check                       | Value                                                                          |
| --------------------------- | ------------------------------------------------------------------------------ |
| Freeze state before the run | `ACTIVE`, version 211                                                          |
| Freeze driver               | present at `/app/apps/worker/src/bt-freeze-driver.ts`                          |
| Repo baseline               | branch `hse-platform`, HEAD `51a899b7…`, 0 staged, 124 modified, 386 untracked |

## 6. Verdict

Identity is **confirmed**: SSH host/user, Compose project and file, container images and digests, public-hostname → phase-aj routing (via readiness version), and the test tenant/document all agree with the historical record. Proceeding was therefore allowed.
