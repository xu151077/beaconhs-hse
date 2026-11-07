# Phase DY-1 — Host recovery

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Connection attempt

Command: `ssh -o ConnectTimeout=15 -o BatchMode=yes beaconhs-drill 'echo SSH_OK; date -u; uptime'`

Result: **Connection timed out during banner exchange. Connection to 10.10.31.30 port 22 timed out.**

- TCP 22 is not reachable within 15 s.
- No host identity, fingerprint, or banner was obtained.
- Last successful connection: during Phase DX (before the image build timed out).

## 2. Actions taken

None. Per the phase constraints, no restart of the host, Docker, or network was attempted, and
no configuration was changed. The host is left for the operator to recover.

## 3. Status

**BLOCKED.** Remote operations are stopped. DY-2 (leftover verification/cleanup) and DY-3
(existing-service health checks) could not be performed because they require SSH access. No
PASS/PARTIAL claim is made for them.

## 4. What remains unverified on the host

- Whether `/home/ceshi/beaconhs-dx` and `/home/ceshi/dx-sa-key` exist.
- Whether a partial image `beaconhs:dx-20261020` exists.
- Whether the existing Drill and phase-aj stacks are healthy.
- Whether any DX container/network/volume was created (none was intended, but unconfirmed).
