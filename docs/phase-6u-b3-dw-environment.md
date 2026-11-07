# Phase DW — Environment request list

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Current local state (read-only check)

- Branch/HEAD verified: `hse-platform` / `51a899b7…` (matches expected).
- Tracked modified: 154; untracked: 436.
- Dev server at `http://localhost:3000`: **not running**.
- Shared dev services running (read-only, not touched): `beaconhs-postgres` (5433),
  `beaconhs-redis` (6380), `beaconhs-minio` (9000/9001), `beaconhs-mailpit` (8025).
- Playwright binary present at `apps/web/node_modules/.bin/playwright`.
- Phase CX storage states exist at `/tmp/opencode/phase-cx-site-a-auth.json` and
  `/tmp/opencode/phase-cx-cross-auth.json`.
- Release image available locally: `beaconhs:dr-mirror-51a899b7` (2.86 GB, built at HEAD).
- Free disk: ~88 GB.

## 2. Why no environment was created

The phase constraints forbid operating shared dev services, phase-aj, Drill, or production.
Starting `pnpm dev` would bind the shared ports and use the shared Postgres/Redis/MinIO,
which is not permitted. Creating an isolated stack requires declaring resources, isolation,
and cleanup first; the host has ~3.4 GB RAM and a 2.86 GB app image, so a full isolated
stack (app + Postgres + Redis + MinIO + Collabora) is at high OOM risk and was not
started. No container, database, tenant, or object was created in DW.

## 3. Minimum isolated environment request

### 3.1 Containers and ports (all on a dedicated Docker network, not the dev network)

| Service     | Image                                          | Host port (isolated) | Notes                                                               |
| ----------- | ---------------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| Postgres 16 | `postgres:16-alpine`                           | 55433                | Fresh volume; role provisioning via `scripts/cluster/provision.sql` |
| Redis 7     | `redis:7-alpine`                               | 65379                | AOF on; no shared data                                              |
| MinIO       | `minio/minio` (or the pinned MinIO build)      | 59000/59001          | Fresh bucket; anonymous access denied                               |
| App (web)   | `beaconhs:dr-mirror-51a899b7` or a fresh build | 53000                | `APP_ROLE=web`; needs the env below                                 |
| Collabora   | `collabora/code:26.04.2.1.1@sha256:df33af…`    | 59980                | Only if WOPI matrix is in scope                                     |

### 3.2 Database

- Fresh Postgres with the full role provisioning (`scripts/cluster/provision.sql`) and
  `pnpm db:migrate` + `pnpm db:seed`.
- A second tenant (not the demo tenant) with a site-scoped user and a cross-tenant user,
  created via the provisioner, for the authorization matrix.
- Scratch database names must contain `test`/`scratch`/`ci` per the identity guard.

### 3.3 Application environment

`DATABASE_URL`, `SUPERADMIN_DATABASE_URL`, `MIGRATION_DATABASE_URL`,
`DATABASE_OWNER_ROLE=beaconhs_owner`, `DATABASE_BACKUP_ROLE=beaconhs_backup`,
`REDIS_URL`, `BETTER_AUTH_SECRET` (≥32 chars), `ATTACHMENT_CAPABILITY_SECRET`,
`BETTER_AUTH_URL`, `APP_URL`, `R2_ENDPOINT`, `R2_INTERNAL_ENDPOINT`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `COLLABORA_URL` (if WOPI).

### 3.4 Test accounts

- Site-scoped user on site A (from the seed or provisioned).
- Cross-tenant user on site B.
- Admin user with `documents.manage` and `admin.data.export`.
- Storage states saved under `/tmp/opencode/dw-*` (git-ignored, 0600).

### 3.5 Isolation

- Dedicated Docker network `dw-isolated` (not `beaconhs`/dev networks).
- Dedicated volume names prefixed `dw-`.
- No reuse of the existing `beaconhs-postgres`/`beaconhs-redis`/`beaconhs-minio` containers or
  their data.
- No reuse of existing tenants or object prefixes.

### 3.6 Cleanup commands (to run after verification)

```
docker rm -f dw-app dw-collabora dw-minio dw-redis dw-postgres
docker network rm dw-isolated
docker volume rm $(docker volume ls -q --filter name=dw-)
```

Verification after cleanup: `docker ps` shows no `dw-` containers; `docker volume ls` shows no
`dw-` volumes; ports 53000/55433/65379/59000/59980 are free; the existing dev services on
5433/6380/9000/8025 are unchanged.

### 3.7 Minimum environment for DV-1 alone (browser file E2E)

Postgres + Redis + MinIO + app (no Collabora) on isolated ports, seeded with two tenants and
the site-scoped/cross-tenant/admin users, plus storage states. Collabora is only needed for the
WOPI row.

### 3.8 Minimum environment for DV-2 alone (multi-replica key gate)

Two app containers on isolated ports, both pointed at the same isolated Postgres/Redis, with
either the same or deliberately different `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, plus the
gate script and `docker` access. No production secret is used; test keys are generated locally
and discarded.<|end|><|start|>write to=assistant<|channel|>analysis<|message|>Created file successfully: docs/phase-6u-b3-dw-environment.md
