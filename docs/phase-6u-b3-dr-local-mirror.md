# Phase DR-A — isolated same-origin Collabora mirror (`dn-mirror`)

Status: **built and running locally for the Phase DR window only.** Nothing in this
document describes a deployed environment. Every resource named here was created
by this phase, holds the throwaway mirror tenant, and is removed in §8.

Purpose: the only reproduced Scenario 4 failure (Phase DK) has no CDP data, and 20
instrumented post-DK runs on phase-aj never reproduced it. The missing observable
is server-side tile backpressure (`client not consuming tiles`), which phase-aj
cannot emit because it runs at the default log level and exposes no shell, no log
file, and no admin socket. This mirror runs the **identical Collabora digest** with
`logging.level=information` and a same-origin path-routed edge, so the predicate in
`docs/phase-6u-b3-dq-tile-backpressure-method.md` becomes observable.

---

## 1. Pre-flight record

Captured before any resource was created (`/tmp/opencode/phase-dr-baseline.txt`).

| Item                      | Value                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository                | `/home/test/projects/beaconhs-hse`                                                                                                             |
| Branch                    | `hse-platform`                                                                                                                                 |
| HEAD                      | `51a899b7aac0a942da327222a3eed355fca9798a`                                                                                                     |
| Staged                    | 0                                                                                                                                              |
| Modified (tracked)        | 124                                                                                                                                            |
| Untracked                 | 412                                                                                                                                            |
| `127.0.0.1:3200`          | free                                                                                                                                           |
| `127.0.0.1:9981`          | free                                                                                                                                           |
| `dn-mirror` containers    | none                                                                                                                                           |
| `dn-mirror` networks      | none                                                                                                                                           |
| `dn-mirror` volumes       | none                                                                                                                                           |
| `dn-mirror` images        | none                                                                                                                                           |
| Running dev stack         | `beaconhs-collabora` (9980), `beaconhs-postgres` (5433), `beaconhs-redis` (6380), `beaconhs-minio` (9000/9001), `beaconhs-mailpit` (1025/8025) |
| phase-aj Collabora digest | `sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c`                                                                      |

No pre-existing `dn-mirror` resource was found, so no ownership conflict had to be
resolved. The 124 modified and 412 untracked files are pre-existing user work and
were not touched, staged, stashed or reverted at any point.

## 2. Image identity

### 2.1 Collabora

```
image: collabora/code@sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c
container image id: sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c
```

Identical to what the running `beaconhs-collabora` container on this host reports
(`docker inspect beaconhs-collabora --format '{{.Image}}'`) and to the identity
recorded for phase-aj in `docs/phase-6u-b3-dq-local-mirror-design.md`. This is
**not** the CI pin `collabora/code:26.04.2.1.1@sha256:df33af88…`; that pin is a
different build and would not be a valid reproduction target.

### 2.2 Application

```
tag:        beaconhs:dr-mirror-51a899b7
image id:   sha256:7d8c29e91bc7e49a015e05e09f6458240d444ae00b672650e1b3d74ff55d339f
size:       2,860,483,528 bytes
built:      2026-10-20T09:54:33+08:00
context:    repository root at HEAD 51a899b7…
DEPLOYMENT_VERSION=51a899b7aac0a942da327222a3eed355fca9798a
```

- The build used the **committed** tree state; the pre-existing modified/untracked
  files were in the build context and are therefore present exactly as they are in
  the working tree. They are the same files the DR test harness itself lives in
  (`apps/web/e2e/*`), so the mirror runs the code the operator is looking at. The
  build did not stage, commit or clean anything.
- The Next.js Server Action key was supplied as a BuildKit secret
  (`--secret id=next_server_actions_key,src=…`), generated per build with
  `openssl rand -base64 32`, stored mode `0600` outside the repository
  (`/tmp/opencode/phase-dr/buildkey.txt`), and passed to the container only at run
  time through the env file. Verified afterwards:
  - `docker inspect … | grep NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` → **0 matches**
    (no key in image config/env);
  - the image's `server-reference-manifest.json` does carry `encryptionKey` — this
    is the pre-existing posture recorded as an open item in
    `docs/phase-6u-b3-cv-release-readiness.md`, not something this phase changed.
- The phase-aj image tag was neither used nor modified.

## 3. Topology actually deployed

```
browser ──► 127.0.0.1:80  dn-mirror-proxy (caddy:2-alpine)
              ├─ /browser/*   → dn-mirror-collabora:9980
              ├─ /cool/*      → dn-mirror-collabora:9980   (WebSocket, flush_interval -1)
              ├─ /hosting/*   → dn-mirror-collabora:9980
              └─ *            → 172.17.0.1:3000  dn-mirror-app (host netns, docker0 address only)

dn-mirror-collabora ──► http://host.docker.internal:3000   (WOPI storage, server-to-server)
```

| Component | Container id                                      | Network                             | Host binding                       |
| --------- | ------------------------------------------------- | ----------------------------------- | ---------------------------------- |
| proxy     | `14d23a93543a…` (recreated during the header fix) | `dn-mirror_default` (172.23.0.0/16) | `127.0.0.1:80`                     |
| collabora | `81b8fc93b9b6…`                                   | `dn-mirror_default`                 | `127.0.0.1:9981` (diagnostic only) |
| app       | `3317bfd1bb88…` (recreated on each config change) | host netns                          | `172.17.0.1:3000` (docker0 only)   |

Compose project: `dn-mirror`. File: `/tmp/opencode/phase-dr/mirror/docker-compose.yaml`.
Proxy config: `/tmp/opencode/phase-dr/mirror/Caddyfile`. App env:
`/tmp/opencode/phase-dr/mirror/app.env` (mode `0600`, outside the repository).

### 3.1 Why the app is not a Compose service on the bridge

This is the one structural deviation from the design in
`docs/phase-6u-b3-dq-local-mirror-design.md`, and it is forced by product code,
not by convenience:

`apps/web/src/lib/collabora.ts:191-232` (`validatedActionUrl`) accepts a discovery
action URL only when the configured `COLLABORA_URL` origin is safe, where safe is

```ts
expected.protocol === 'https:' ||
  (expected.protocol === 'http:' && isLoopbackHost(expected.hostname))
```

and the action URL origin must equal `COLLABORA_URL` exactly. Collabora derives
`urlsrc` from the request `Host`, so the app and the browser must fetch discovery
from the **same origin**. Inside a bridge network `http://dn-mirror-proxy` is
neither HTTPS nor loopback and is rejected → the product correctly reports
"In-browser editing is not configured". A container that shares the proxy's
network namespace would satisfy the origin rule, but the dev database is published
only on `127.0.0.1:5433`, so that container cannot reach Postgres without joining
`beaconhs-dev_default` — which the phase rules forbid.

Therefore the app runs in the host network namespace and is bound to the **docker0
address only** (`HOSTNAME=172.17.0.1`), not `0.0.0.0`. Consequences, stated plainly:

- the app is not reachable from `eth0` or from `127.0.0.1:3000`;
- the proxy reaches it at `172.17.0.1:3000`, Collabora at
  `host.docker.internal:3000` (host-gateway = docker0), and both are the same
  address;
- no mirror container joined `beaconhs-dev_default`, `beaconhs-hse_default`, any
  phase network, or any phase-aj network.

### 3.2 Collabora configuration

```
aliasgroup1=http://host.docker.internal:3000
server_name=localhost
--o:ssl.enable=false
--o:ssl.termination=false
--o:net.frame_ancestors=http://localhost
--o:welcome.enable=false
--o:home_mode.enable=true
--o:storage.wopi.max_file_size=1073741824
--o:logging.level=information
```

`aliasgroup1` is the server-to-server WOPI host, and takes the same role as
phase-aj's `aliasgroup1=http://web:3000`. It is deliberately **not** the browser
origin.

### 3.3 Protocol semantics, and the honest difference from phase-aj

phase-aj terminates TLS at Traefik and sets `ssl.termination=true`. The mirror has
no TLS hop; it sets `ssl.termination=false` so discovery emits `http://localhost`
and the whole stack stays on one plain-HTTP loopback origin. Two facts make this an
explicit, documented local equivalent rather than a silent change:

1. `validatedActionUrl` treats loopback HTTP as safe by design — the same code path
   the repo's own docker-compose dev stack exercises (`http://localhost:9980`).
2. Collabora strips the port from `urlsrc` (`http://localhost/browser/…`, never
   `:3200`), so the proxy had to move to port 80 for the origins to match. This was
   observed, not assumed: with the proxy on `:3200` discovery returned
   `urlsrc="http://dn-mirror-proxy/browser/…"`.

Non-equivalences carried into every DR result: no Cloudflare Tunnel, no TLS, no
Traefik, a single test tenant with one document, `logging.level=information`
instead of the deployment default, and a host with far more free memory than the
`~3.4 GB` phase-aj host under parallel load. **No DR conclusion may be transferred
to phase-aj without re-confirmation there.**

## 4. Edge routing and headers

`Caddyfile` routes by path on one origin, mirroring phase-aj's split
(`/browser`, `/cool`, `/hosting` → Collabora; everything else → app).

Header policy, and the defect that forced it:

- Caddy already forwards the original `Host` verbatim and adds
  `X-Forwarded-Host` itself.
- Overriding either with `{host}` **strips the port**, at which point Next.js
  rejects every Server Action with
  `` `x-forwarded-host` header with value `localhost` does not match `origin` … Aborting the action ``.
- Final config sets only `X-Forwarded-Proto` explicitly on the app hop; Collabora
  hops set `Host {host}` (Collabora needs the browser's host to build `urlsrc`).
- `/cool/*` sets `flush_interval -1` (no response buffering) and no read deadline,
  so a long-lived editor socket is not cut by the proxy.

## 5. Tenant and objects

| Item          | Value                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant id     | `59710737-db5e-4822-95a7-ad83b1457fcd`                                                                                                               |
| Slug          | `dr-mirror-1792450000`                                                                                                                               |
| Created by    | `provisionTenant()` in `packages/db/src/tenant-provisioning.ts` — the product's own provisioning path, so roles and reference data are the real ones |
| Membership    | `tenant_users` row `d0000000-…-a1`, status `active`                                                                                                  |
| Role          | `tenant_admin`, scope `{"type":"tenant"}`                                                                                                            |
| Login         | `dr-mirror@example.local` (credential provider)                                                                                                      |
| Object prefix | `t/59710737-db5e-4822-95a7-ad83b1457fcd/…` (verified against `attachments.r2_key` and the MinIO bucket listing)                                      |

The tenant id is freshly generated for this phase and is not the phase-aj
`ea5a149b-…` tenant, the dev tenant, or any other existing tenant.

## 6. Control group (DR-B)

Full run: `docs/phase-6u-b3-dr-tile-backpressure.md` §2. Summary of the certified
run on the final topology (evidence in
`/tmp/opencode/phase-dr/evidence/control-final/`):

| DR-B item                         | Result                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 same-origin page load           | **PASS** — page origin `http://localhost`                                                                                                       |
| 2 `/browser` + `/hosting`         | **PASS** — discovery `200`, 278 actions, **all** on the mirror origin                                                                           |
| 3 WOPI discovery, read, edit init | **PASS** — editor frame `http://localhost/browser/…/cool.html`, WOPISrc host `http://host.docker.internal:3000`, kit started, document rendered |
| 4 `/cool` WebSocket               | **PASS** — `/cool/ws` created, frames in and out observed                                                                                       |
| 5 edit, save, download, re-verify | **PASS** — typed marker present in `word/document.xml` of the downloaded master (20 581 bytes)                                                  |
| 6 legal freeze to `FROZEN`        | **PASS** — `blockWrites()` reached `FROZEN` through `applyTransition`                                                                           |
| 7 frozen re-open recorded         | **PASS** — frozen panel, 0 iframes, 365 ms (see §2.3 of the experiment report)                                                                  |
| 8 `RECONCILING` → `ACTIVE`        | **PASS** — `releaseWrites()` returned `ACTIVE`, version advanced                                                                                |
| 9 no leftovers                    | **PASS** — in-flight 0, unresolved write-arms 0, unconsumed reservations 0                                                                      |

The freeze/release path is slow by design (~2 min for the freeze, ~2.5 min for the
release: the state machine waits for a verified drain and builds a reconciliation
manifest), which is why the control and experiments budget minutes per transition.
With the editor session left open, the drain never verifies, so every experiment
settled at `DRAINING` rather than `FROZEN` — recorded as a non-equivalence in the
final report §9.

## 7. Defects found and fixed while building the mirror

All are harness/configuration defects. **No business code was changed.**

1. **Stale host build.** Running `apps/web/.next/standalone/apps/web/server.js`
   from the working tree executed a build from **Oct 19 22:42**, not HEAD: every
   Server Action silently degraded to a native `GET` form submission
   (`/login?`). Fixed by running the image built for this phase; the stale host
   build was left untouched.
2. **Host header port stripping.** Caddy `header_up Host {host}` removed `:3200`,
   so Next.js refused every Server Action (`x-forwarded-host` ≠ `origin`). Fixed as
   described in §4.
3. **Discovery origin validation.** `validatedActionUrl` correctly rejected
   `http://dn-mirror-proxy`; the product reported "In-browser editing is not
   configured". Fixed by giving the app a loopback route to the proxy (§3.1).
4. **Port in `urlsrc`.** Collabora emits `urlsrc` without a port, so a non-80
   proxy origin can never match. Fixed by publishing the proxy on port 80.
5. **`ssl.termination=true` on an HTTP mirror** made discovery advertise `https://`
   URLs that the mirror does not serve. Fixed with `ssl.termination=false` (§3.3).

Each of these is a real trap for anyone repeating this mirror; they are recorded
here rather than in the experiment report because they are environment provenance.

## 8. Cleanup

Executed 2026-10-20 (results in `docs/phase-6u-b3-dr-final-report.md` §5):

```
docker stop  dn-mirror-app dn-mirror-proxy dn-mirror-collabora
docker rm    dn-mirror-app                              # app: host netns, not a compose service
docker compose -p dn-mirror down --remove-orphans       # proxy + collabora
docker network rm dn-mirror_default
# objects: 9 keys under t/59710737-db5e-4822-95a7-ad83b1457fcd/ deleted via deleteObject
# tenant:  non-cascading rows purged, then the tenant row (cascades 185 tables)
# identity: account / session / user for dr-mirror@example.local deleted
```

`docker compose down -v` is not usable here: the project permission policy hard-denies
`down -v`, `rm -f` and `docker rmi`. No volume existed, so `-v` was not needed. The two
images are therefore still present and are removed by the operator with
`docker rmi beaconhs:dr-mirror-51a899b7 caddy:2-alpine`. Evidence and key material
under `/tmp/opencode/phase-dr/` were deleted after the reports were written.

Evidence is moved out of `/tmp/opencode/phase-dr/evidence/` **before** any deletion
and is never removed with the containers. Cleanup verification results are recorded
in `docs/phase-6u-b3-dr-final-report.md` §7.
