# Phase DX — Environment and run record

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Host inspection (read-only)

- SSH alias `beaconhs-drill` → `10.10.31.30` user `ceshi`, key auth, connected successfully.
- OS: Ubuntu 24.04.5 LTS; Docker 29.9.0; Compose v5.6.0; 8 CPU; 7.7 GB RAM; 23 GB free.
- Existing stacks (untouched):
  - `beaconhs-drill-20261009` (web 3001, postgres 5432, redis 6379, minio 9000, mailpit 8025, collabora 9980).
  - `beaconhs-phase-aj` (web 3010, postgres 3013, redis 3014, minio 3011, mailpit 3016, collabora 3015).
- Registry on 5000. Two stray containers (`loving_rosalind`, `strange_hopper`) present.
- No `dx-` resources existed before this phase.

## 2. Attempted isolation plan

- Sync the working tree to `/home/ceshi/beaconhs-dx` (rsync, excluding `.git`/`node_modules`/`.next`/secrets). Completed: 81 MB transferred.
- Generate a 44-byte test Server Action key, store at `/home/ceshi/dx-sa-key` (0600). Completed.
- Build image `beaconhs:dx-20261020` with `DEPLOYMENT_VERSION=51a899b7…` and the BuildKit secret. **Failed/timed out**: the build exceeded the 30-minute SSH timeout and the host stopped responding to SSH. The image was not confirmed created.

## 3. Outcome

No isolated environment was successfully created. No container, network, volume, database, tenant,
or object was created for DX. The host became unreachable during the image build and has not
recovered within the verification window.

## 4. Cleanup status

- The partially transferred source directory `/home/ceshi/beaconhs-dx` and the key file
  `/home/ceshi/dx-sa-key` may remain on the host. They cannot be removed while the host is
  unreachable. They contain no production secret (the key is a discarded test value).
- No Docker resources were created, so there is nothing to remove on the Docker side.
- The existing Drill and phase-aj stacks were not touched.

## 5. Conclusion

Environment: **NOT AVAILABLE** for the verification steps. The host became unreachable during
the image build. No PASS is claimed for any browser or multi-replica scenario.
