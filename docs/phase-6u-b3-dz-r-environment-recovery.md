# Phase DZ-R — Environment recovery, DX cleanup, isolated acceptance stack

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Local baseline (read-only)

```
git branch --show-current   -> hse-platform
git rev-parse HEAD          -> 51a899b7aac0a942da327222a3eed355fca9798a
git status --short          -> 154 modified, 450 untracked, 0 staged
git diff --stat             -> 154 files changed, 5100 insertions(+), 1919 deletions(-)
git diff --cached --stat    -> (empty)
```

All pre-existing modifications and untracked files were preserved. No branch switch, no
`reset`/`clean`/`restore`/`checkout`, no commit, no push.

## 2. Host identity verification

- Connection: `ssh -o ConnectTimeout=8 -o ConnectionAttempts=1 beaconhs-drill`
  (existing `~/.ssh/config` alias → `10.10.31.30`, user `ceshi`, key `~/.ssh/beaconhs_drill`).
- Live host key: `ssh-keyscan -t ed25519 10.10.31.30` →
  `SHA256:fkdz2n4BCf6BzcIV3DubIvJgXw4JRx9C9SG34u2fJXU`.
- The same fingerprint is in `~/.ssh/known_hosts` for that host
  (`ssh-keygen -lf ~/.ssh/known_hosts`), and it matches the historical prefix
  `SHA256:fkdz2n4B` recorded for this host. **Identity confirmed by full fingerprint.**
- Host: `ceshi-Virtual-Machine`, Ubuntu 24.04.5 LTS, Docker 29.9.0, Compose v5.6.0, 8 CPU,
  7.7 GiB RAM, 23 GiB free disk.

## 3. Existing stacks — read-only inspection, not modified

| Stack                     | Containers (image)                                                       | State at first contact                                                |
| ------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `beaconhs-phase-aj`       | web/worker/scheduler/storage-init/postgres/redis/minio/mailpit/collabora | Exited — the host had rebooted (`up 5 min`) before this phase started |
| `beaconhs-drill-20261009` | same shape                                                               | Exited — same reboot                                                  |
| `beaconhs-drill-registry` | `registry:2`                                                             | Up                                                                    |

The two stacks were already down when this phase began, because the host restarted after the
DX image build. **No container, image, volume, network, database, or file of either stack was
started, stopped, restarted, modified, or removed.** The same container names, image tags, and
volumes are present at the end of the phase.

## 4. DX leftover verification and cleanup

Ownership evidence collected before deletion:

| Item                      | Evidence                                                                                                                                                                                                                                 | Decision           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `/home/ceshi/beaconhs-dx` | rsync copy of this repository (2 805 files, 570 dirs, 81 MB, no `.git`); created by DX; `docker inspect` over all containers shows no mount; no compose file in `beaconhs-phase-aj`, `beaconhs-phase-cd`, `beaconhs-drill` references it | DX-owned → removed |
| `/home/ceshi/dx-sa-key`   | 44-byte file, mode 0600, created by DX, referenced by no compose file or container                                                                                                                                                       | DX-owned → removed |
| `beaconhs:dx-20261020`    | absent (`docker images` showed no match)                                                                                                                                                                                                 | nothing to remove  |

Commands: `rm -rf /home/ceshi/beaconhs-dx; rm -f /home/ceshi/dx-sa-key` (scoped to those two
paths only).

Post-cleanup verification: both paths absent, no `dx` images, and the `phase-aj` / Drill
container list, images, and volumes unchanged.

## 5. Isolated acceptance stack (created by this phase)

Declared resource manifest — all new, all `dxr`-prefixed, none shared:

| Resource        | Name                     | Port (loopback) | Notes                                                                          |
| --------------- | ------------------------ | --------------- | ------------------------------------------------------------------------------ |
| Network         | `dxr_default`            | —               | bridge; not joined to any existing stack                                       |
| Postgres 16     | `dxr-postgres-1`         | 15432           | volume `dxr_dxr-postgres-data`; database `beaconhs` + `beaconhs_dxr_scratch`   |
| Redis 7         | `dxr-redis-1`            | 16379           | volume `dxr_dxr-redis-data`                                                    |
| MinIO           | `dxr-minio-1`            | 19000/19001     | volume `dxr_dxr-minio-data`; bucket `beaconhs-dxr`, private, lifecycle applied |
| Mailpit         | `dxr-mailpit-1`          | 18025/11025     | catch-all mailbox                                                              |
| Collabora       | `dxr-collabora-1`        | 19980           | pinned digest `collabora/code@sha256:4e983196eb98…`                            |
| App (replica 1) | `dxr-web-1`              | 13010           | image `beaconhs:dxr-20261020` (`79db4885b1fb`)                                 |
| App (replica 2) | `dxr-web-2`              | 13011           | same image; used for the multi-replica key gate                                |
| Worker          | `dxr-worker-1`           | —               | APP_ROLE=worker                                                                |
| Storage init    | `dxr-storage-init-1`     | —               | one-shot; "private bucket policy, lifecycle, and anonymous-read probe passed"  |
| Test key        | `/home/ceshi/dxr-sa-key` | —               | 44-byte base64 AES key, 0600, generated on the host, never printed             |

The image was built on the host from the synced working tree with
`--build-arg DEPLOYMENT_VERSION=51a899b7aac0a942da327222a3eed355fca9798a` and the BuildKit
secret `next_server_actions_key`. The previous DX build had timed out and coincided with the
host reboot; this build completed in one pass with the host otherwise idle.

Database preparation (run from this workstation through an SSH tunnel, using the repository's
own scripts): `pnpm --filter @beaconhs/db exec tsx src/migrate.ts` (exit 0) and
`... src/seed.ts` (exit 0) against the isolated database, then a second database
`beaconhs_dxr_scratch` for the freeze suite.

## 6. Test fixtures (isolated database only)

- Second tenant `DXR Other Tenant` (slug `dxr-other`) with one site org unit.
- Cross-tenant rows the Phase CX spec addresses by id: incident `50b3f232…`, document
  `6362fee2…` + version, attachment `cae6c747…` (object key `t/<tenant>/…` as the schema
  requires).
- Three identities with password credentials (scrypt via Better Auth's own hasher) and
  Foreman/Tenant-Admin role assignments:
  `dxr-site-a@dxr.local` (scope: Site A), `dxr-cross@dxr.local` (tenant scope),
  `dxr-admin@dxr.local` (Tenant Admin).
- A real DOCX (20 622 bytes) stored in the isolated bucket and attached to a seeded document,
  so the legal download / PDF / version paths could be exercised.

## 7. Cleanup performed

- `docker compose --env-file dxr.env down -v --remove-orphans` (project `dxr` only): all DXR
  containers, the `dxr_default` network, and the three `dxr_dxr-*` volumes removed.
- `docker rmi beaconhs:dxr-20261020` → untagged and deleted.
- `rm -rf /home/ceshi/dxr /home/ceshi/beaconhs-dxr /home/ceshi/dxr-sa-key /home/ceshi/dxr-build.log`.
- Local: the three `beaconhs_dxr_scratch_*` databases dropped and verified absent; the SSH
  forward closed (0 listening ports).
- Verified afterwards: no `dxr` container, network, volume, image, or host path remains; the
  `phase-aj` and Drill containers retain their original names, images, and volumes.
- Playwright artifacts (`apps/web/test-results`, `apps/web/e2e/phase-bn-results.json`) are
  git-ignored; the tracked/untracked counts are unchanged (154 modified / 450 untracked).
