# Phase 6U-B3-CQ — Drill host SSH timeout diagnostics

Date: 2026-10-19
Target: isolated test host `10.10.31.30` (SSH alias `beaconhs-drill`, user `ceshi`)
App domain: `https://beaconhs-test.xuhaoqing.top`
Status: **RESOLVED — SSH reachable; the earlier timeout was not reproducible and
left no evidence of host exhaustion.**

## Scope

Read-only diagnosis of why SSH to the drill host timed out for >15 minutes, then
restoration of access if the host was healthy. No host restart, no Docker daemon
restart, no `docker system prune`, no image/container/volume deletion, no `.env`
or key modification.

## Commands and observed results

### Tool and alias resolution

```
$ date
2026年 10月 19日 星期一 05:36:37 +08

$ command -v ssh && command -v scp && command -v nc && command -v ping
/usr/bin/ssh
/usr/bin/scp
/usr/bin/nc
/usr/bin/ping

$ ssh -G beaconhs-drill | grep -E '^(hostname|user|port|identityfile|connecttimeout|proxycommand) '
user ceshi
hostname 10.10.31.30
port 22
identityfile ~/.ssh/beaconhs_drill
connecttimeout 10
```

Alias, user, port and identity file expected; no proxy command. Private key
contents were never read or printed.

### Network reachability (LAN)

```
$ ping -c 4 -W 2 10.10.31.30
4 packets transmitted, 4 received, 0% packet loss, time 3036ms
rtt min/avg/max/mdev = 0.608/2.101/5.325/1.879 ms
```

### TCP port 22

```
$ nc -vz -w 5 10.10.31.30 22
Connection to 10.10.31.30 22 port [tcp/ssh] succeeded!
```

### SSH handshake and remote command

```
$ timeout 15s ssh -vvv -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
    -o ServerAliveInterval=3 -o ServerAliveCountMax=1 beaconhs-drill 'hostname; uptime'
...
ceshi-Virtual-Machine
 05:36:59 up 4 days, 20:50,  5 users,  load average: 0.48, 0.51, 0.43
```

Exit status 0. The timeout symptoms reported for Phase CP
(`Connection timed out during banner exchange`) did **not** reproduce.

### Local host

```
$ ip route get 10.10.31.30
10.10.31.30 dev eth0 src 10.10.31.26 uid 1000

$ uptime; free -h; df -h
 05:37:09 up 4 days, 17:26,  1 user,  load average: 0.12, 0.08, 0.07
 内存：15Gi used 2.2Gi, cache 10Gi, available 13Gi
 /dev/sda2 250G 122G used 116G free 52% /
```

### Remote host (read-only)

```
$ ssh beaconhs-drill 'uptime; free -h; df -h; df -i'
 05:37:14 up 4 days, 20:51,  load average: 0.37, 0.48, 0.43
 内存：7.7Gi total, 2.4Gi used, 5.3Gi available
 交换：3.8Gi total, 2.5Gi used
 /dev/sda2 124G 98G used 20G free 84% /
 Inodes: /dev/sda2 8257536 total, 4176208 used 51% /

$ ssh beaconhs-drill 'systemctl is-active ssh && systemctl is-active docker && docker ps ...'
active
active

$ ssh beaconhs-drill 'ps -eo pid,ppid,stat,%cpu,%mem,etime,cmd --sort=-%cpu | head -n 20'
(no CPU-bound build process; highest CPU was the sshd session at 7.6%)
 no docker build process:
 $ ps aux | grep -i docker | grep -i build | grep -v grep   →  (no output)

$ ssh beaconhs-drill 'docker system df'
Images          20    10    22.85GB   11.71GB (51%)
Containers      20    15    790.9MB   20.48kB (0%)
Local Volumes    9     7     4.408GB  26.47kB (0%)
Build Cache    130     0    59.63GB   49.14GB
```

## Findings

- The earlier timeout could **not** be reproduced. LAN latency was sub-5 ms, port
  22 accepted, the SSH handshake completed, and remote commands returned quickly.
- No evidence that a Docker build exhausted the host: load average < 0.5, no build
  process running, memory 31% used, disk 84% used with 20 GB free, inodes 51%.
- Root cause of the intermittent timeout is **not determined**. It is recorded as a
  transient transport/network condition; no host-side fault was found. Do not treat
  this as proof that the host was fine at the exact moment of the timeout.
- `Build Cache` counts 59.63 GB with 49.14 GB reclaimable. It was **not** pruned, per
  the task constraints. Disk headroom (20 GB) was sufficient for the re-build.

## Status

| Item                                              | Result                                  |
| ------------------------------------------------- | --------------------------------------- |
| SSH access restored                               | PASS                                    |
| Host identity confirmed (`ceshi-Virtual-Machine`) | PASS                                    |
| Host resource exhaustion                          | NOT OBSERVED                            |
| Root cause of original timeout                    | BLOCKED (not reproducible; no evidence) |

## Recovery notes for an operator

If SSH times out again:

1. `ping -c 4 -W 2 10.10.31.30` and `nc -vz -w 5 10.10.31.30 22` from the dev host.
2. If TCP 22 is refused, check the hypervisor console for `systemctl status ssh`.
3. If TCP 22 times out, check the VPN/gateway and the out-of-band console before
   retrying.
4. Do not restart the host or the Docker daemon without console evidence.
