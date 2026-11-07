# Phase DZ — Remote recovery checklist

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Precondition

Do not run any command against `10.10.31.30` until SSH is restored. Do not restart the host,
Docker, or any service without explicit authorisation.

## 2. Step 1 — SSH reachability

```
ssh -o ConnectTimeout=15 -o BatchMode=yes beaconhs-drill 'echo OK; hostname; date -u'
```

- Success: `OK`, hostname `ceshi-Virtual-Machine`, current UTC time.
- Failure: timeout or refused → stop, record the error, mark BLOCKED. Do not retry in a loop.

## 3. Step 2 — Host health (read-only)

```
ssh beaconhs-drill 'uptime; free -h | head -2; df -h /home/ceshi | tail -1'
ssh beaconhs-drill 'docker version --format "{{.Server.Version}}"; docker compose version'
```

- Expected: load < 8, ≥ 4 GB available RAM, ≥ 10 GB free disk, Docker 29.x, Compose v5.x.

## 4. Step 3 — Existing service health (read-only)

```
ssh beaconhs-drill 'docker ps --format "{{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "phase-aj|drill"'
```

- Expected: both stacks' containers Up (healthy where applicable).
- If any container is unhealthy or exited unexpectedly, stop and report. Do not restart.

## 5. Step 4 — DX leftover inspection (read-only)

```
ssh beaconhs-drill 'ls -ld /home/ceshi/beaconhs-dx /home/ceshi/dx-sa-key 2>&1'
ssh beaconhs-drill 'docker images --format "{{.Repository}}:{{.Tag}}" | grep dx-20261020 || echo "no dx image"'
ssh beaconhs-drill 'docker ps -a --filter name=dx- --format "{{.Names}}\t{{.Status}}"'
ssh beaconhs-drill 'docker network ls --filter name=dx- --format "{{.Name}}"'
ssh beaconhs-drill 'docker volume ls --filter name=dx- --format "{{.Name}}"'
```

Record what exists. Do not delete anything whose ownership is uncertain.

## 6. Step 5 — Safe cleanup (only after ownership confirmed)

```
ssh beaconhs-drill 'rm -rf /home/ceshi/beaconhs-dx; rm -f /home/ceshi/dx-sa-key'
ssh beaconhs-drill 'docker rmi beaconhs:dx-20261020'   # only if image exists and is unused
```

Verify:

```
ssh beaconhs-drill 'ls /home/ceshi/beaconhs-dx /home/ceshi/dx-sa-key 2>&1; docker images --format "{{.Repository}}:{{.Tag}}" | grep dx-20261020 || echo "clean"'
```

## 7. Step 6 — Re-check existing services

Repeat step 3. Confirm nothing changed.

## 8. Stop conditions

- SSH unreachable → stop, mark BLOCKED.
- Existing service unhealthy → stop, do not clean up, report.
- Any resource ownership uncertain → leave it, report.
- Disk free < 10 GB → stop, do not build.
