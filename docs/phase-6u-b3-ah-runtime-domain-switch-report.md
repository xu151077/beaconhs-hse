# Phase AH — Runtime Custom-Domain Switch Verification

Repository: `/home/test/projects/beaconhs-hse`  
Branch: `hse-platform`  
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## Worktree and isolation

- Start state: 102 tracked modifications / 141 untracked entries.
- All runtime environment overrides were written to disposable `/tmp` env files.
- The user `.env` file was not modified.
- No production, C2 drill, DNS, or Cloudflare Tunnel access occurred.
- No full magic-link token, signed URL, credential, or secret was printed.

## 1. Runtime switches without rebuilding

The Next development server was started twice from the same source tree using
isolated environment overlays. No production build was run between switches.

### Run A: `PUBLIC_APP_URL=https://hse.example.test`

- Local service port: 3100.
- Auth runtime origin: `https://hse.example.test`.
- Magic-link email origin: `https://hse.example.test`.
- Magic-link callback path: `/api/auth/magic-link/verify`.
- Browser auth POSTs went to the live local origin, not the build-time fallback:
  - `POST http://localhost:3100/api/auth/sign-in/magic-link`
  - `GET http://localhost:3100/api/auth/magic-link/verify`
- Server-rendered QR page contained the configured origin: PASS.
- Stale build-time domain in rendered output: absent.
- Old deployment domain in rendered output: absent.

### Run B: `PUBLIC_APP_URL=https://beacon.example.test`

- Local service port: 3200.
- Auth runtime origin: `https://beacon.example.test`.
- Magic-link email origin: `https://beacon.example.test`.
- Magic-link callback path: `/api/auth/magic-link/verify`.
- Browser auth POSTs again targeted the live local origin.
- Server-rendered QR page contained the configured origin: PASS.
- Stale build-time domain in rendered output: absent.
- Old deployment domain in rendered output: absent.

The Next dev server has a single-project lock, so the two runs were performed
sequentially: the first isolated service was stopped, then the second was
started. This is a process restart, not an application rebuild.

## 2. Cross-service configuration consistency

A runtime probe executed with each overlay and imported the actual worker,
forms-PDF, and Better Auth URL helpers.

| Run | Web/worker/PDF origin         | Auth origin                   | Result |
| --- | ----------------------------- | ----------------------------- | ------ |
| A   | `https://hse.example.test`    | `https://hse.example.test`    | PASS   |
| B   | `https://beacon.example.test` | `https://beacon.example.test` | PASS   |

Events and integrations use the same `PUBLIC_APP_URL → APP_URL →
NEXT_PUBLIC_APP_URL` runtime order; their package tests and typechecks pass.
`NEXT_PUBLIC_APP_URL` was empty in the runtime overlays, so no stale build-time
value was present.

## 3. Presigned URL and internal endpoint runtime evidence

A local loopback proxy was used solely to make the two non-resolving
`example.test` hostnames reach local MinIO for signature verification. This is
**not** evidence of public DNS, Cloudflare Tunnel, or production R2 routing.

For both `hse.example.test` and `beacon.example.test`:

- public presigned PUT: HTTP 200
- public presigned GET: HTTP 200
- expired presigned PUT: HTTP 403
- signature parameter present: yes
- path root: `/beaconhs-dev/t/<tenant>/...` — no `/storage` prefix
- object size: 38 bytes
- SHA-256: `8e3219ac895f220c60da9b9111b2da6a2c786a5021ed59ec3c5cdc60dc50cbe9`
- downloaded object SHA-256 matched source
- disposable object deleted after each run

Internal server-side I/O used `R2_INTERNAL_ENDPOINT=http://127.0.0.1:9000`.
The existing routing tests continue to prove internal I/O and public presigning
use different clients/origins.

## 4. Build-time vs runtime boundaries

| Configuration                                  | Effective timing                          |
| ---------------------------------------------- | ----------------------------------------- |
| `PUBLIC_APP_URL`, `APP_URL`, `BETTER_AUTH_URL` | runtime; restart required                 |
| `R2_ENDPOINT`, `R2_INTERNAL_ENDPOINT`          | runtime; storage clients restart required |
| `COLLABORA_URL`, `COLLABORA_WOPI_URL`          | runtime; web/Collabora restart required   |
| `DEV_ALLOWED_ORIGINS`                          | build-time dev-HMR configuration only     |
| `NEXT_PUBLIC_APP_URL`                          | legacy build-time fallback only           |

The browser auth client now prefers the live page origin over
`NEXT_PUBLIC_APP_URL`, preventing a stale built value from redirecting auth
requests after a runtime domain switch.

## 5. Deployment configuration checks

Passed assertions:

- Dokploy web and worker both receive `PUBLIC_APP_URL: ${APP_URL}`.
- Local-production shared app environment receives
  `PUBLIC_APP_URL: ${APP_URL:?required}`.
- Deploy workflow persists `PUBLIC_APP_URL` alongside `APP_URL`.
- `R2_ENDPOINT` and `R2_INTERNAL_ENDPOINT` remain separate in deployment
  templates.
- No stale deployment hostname remains in active source or deployment templates
  (historical `.next` dev traces were excluded from source scanning).

No live tunnel or DNS was changed.

## 6. Public route limitations

`example.test` names do not resolve publicly. The web runs used loopback ports
and a local proxy for storage signatures only. The following remain **NOT RUN /
BLOCKED**:

- public DNS resolution for either example domain;
- Cloudflare Tunnel routing;
- Collabora `/browser`, `/cool`, `/hosting` through a real reverse proxy;
- production R2/IAM/lifecycle behavior;
- production backup/restore;
- production alert delivery.

## Validation commands

- `pnpm --filter @beaconhs/web test`: PASS — 234 files / 2015 tests
- `pnpm --filter @beaconhs/web typecheck`: PASS, exit 0
- `pnpm --filter @beaconhs/web build`: PASS, exit 0
- `pnpm --filter @beaconhs/auth test`: PASS — 78 tests
- `pnpm --filter @beaconhs/auth typecheck`: PASS
- `pnpm --filter @beaconhs/storage test`: PASS — 148 tests
- `pnpm --filter @beaconhs/storage typecheck`: PASS
- `pnpm --filter @beaconhs/events test`: PASS — 34 tests
- `pnpm --filter @beaconhs/integrations test`: PASS — 5 tests
- `pnpm --filter @beaconhs/worker test`: PASS — 103 tests
- `pnpm --filter @beaconhs/worker typecheck`: PASS
- targeted web ESLint: PASS, exit 0
- `pnpm deadcode:check`: PASS, exit 0
- deployment configuration assertions: PASS

## G2 status

Runtime domain switching is verified in the isolated application. Public DNS,
Tunnel, production storage, Collabora, and production alert evidence remain
unavailable.

**G2 remains BLOCKED.**

## Ending state

- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- No commit or push performed.
- Temporary runtime env files were removed after the runs.
