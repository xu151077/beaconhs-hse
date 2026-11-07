# Phase 6U-B3-CR — SSH timeout review

Date: 2026-10-19
Host: `10.10.31.30` (`beaconhs-drill` alias, user `ceshi`)
Symptom under review: SSH connections timing out during banner exchange during
Phase CP, before Phase CQ.

Status: **Access recovery PASS. Root cause UNKNOWN.** The host was healthy when
re-tested and the SSH service never restarted. There is no evidence to attribute
the outage to host resource exhaustion, an SSH service failure, or a network
fault. Recovery is not the same as a resolved root cause.

## 1. Timeline (host local time, UTC+08)

| Time                     | Event                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-19, before 05:36 | Phase CP SSH attempts time out at banner exchange. Exact start time was not written to a local log.                                                                                  |
| 00:40–01:17              | `sar` records 67–90% iowait on the host (an earlier I/O-heavy period, hours before the incident).                                                                                    |
| 04:00–05:30              | `sar` records a quiet host: ~98% CPU idle, 0.03% iowait, 5.58–5.61 GB available, 23.5–23.9% memory used, load 0.17–0.48, 0–1 blocked tasks.                                          |
| 05:36:37–05:39           | CQ diagnostics: ping 4/4, TCP 22 open, SSH publickey login succeeds.                                                                                                                 |
| 05:36:54                 | sshd logs `Connection closed by 10.10.31.26 port 40272` (a pre-auth connection closing; likely the tail of the stuck attempt).                                                       |
| 05:36:58 onward          | sshd logs repeated `Accepted publickey for ceshi`.                                                                                                                                   |
| 05:39–05:49              | A Docker/BuildKit build starts: memory reaches 73.53% at 05:40 (1.54 GB available), load 3.42, swap 76.81%; BuildKit logs a canceled solve at 05:49. This is **after** SSH recovery. |

The 05:39 build is not the cause of the earlier timeout. It is recorded because
it shows how quickly this 8 GB host can be driven into memory pressure by a
build, and because its `context canceled` error is consistent with a build client
session being torn down.

## 2. What was checked

The recovery-time `ping`, `nc`, `free` and `df` block below was recorded during
Phase CQ at 05:36–05:37 and is labelled as historical evidence. This phase
re-ran the current SSH access check, `sshd` state, kernel logs, `sar` history and
Docker logs; those are the fresh Phase CR results.

### Network and SSH at recovery (Phase CQ, historical)

```
$ ping -c 4 -W 2 10.10.31.30
4 packets transmitted, 4 received, 0% packet loss, time 3036ms
rtt min/avg/max/mdev = 0.608/2.101/5.325/1.879 ms

$ nc -vz -w 5 10.10.31.30 22
Connection to 10.10.31.30 22 port [tcp/ssh] succeeded!

$ ssh -o BatchMode=yes -o ConnectTimeout=10 beaconhs-drill 'hostname; uptime'
ceshi-Virtual-Machine
 05:36:59 up 4 days, 20:50, 5 users, load average: 0.48, 0.51, 0.43
```

### Host state after recovery (Phase CQ, historical)

```
$ free -h
内存: 7.7Gi total, 2.4Gi used, 5.3Gi available
交换: 3.8Gi total, 2.5Gi used
$ df -h /
/dev/sda2 124G 98G used 20G free 84%
$ systemctl is-active ssh && systemctl is-active docker
active
active
```

No CPU-bound build process was running; the highest CPU consumer was the sshd
session itself (7.6%). Disk had 20 GB free and inodes were 51% used.

### SSH service state

```
$ systemctl show ssh -p ActiveEnterTimestamp -p NRestarts -p ExecMainStartTimestamp
NRestarts=0
ExecMainStartTimestamp=Fri 2026-10-16 08:12:29 +08
ActiveEnterTimestamp=Fri 2026-10-16 08:12:29 +08
$ who -b
系统引导 2026-10-14 08:42
```

The sshd service has been running continuously since 2026-10-16 and has **not
restarted**. The host has been up since 2026-10-14. This rules out an sshd crash
or restart as the cause.

### SSH authentication logs

```
$ journalctl -u ssh --since '2026-10-19 03:00:00' --until '2026-10-19 05:36:00'
-- No entries --
```

The failed connections never reached authentication, which is consistent with a
stall before the banner/auth exchange. The first post-recovery log is the
`Connection closed` line at 05:36:54; successful publickey logins follow.

### Kernel pressure

```
$ journalctl -k --since '2026-10-19 03:00:00' --until '2026-10-19 06:30:00' \
    | grep -iE 'oom|killed process|hung task|blocked for more|out of memory|swap'
(no output)
```

No OOM kill, hung task, or blocked-task kernel message in the window.

### sar history

`sar` is collecting on this host. Relevant samples:

| Time  | CPU idle | iowait | Memory used |   Available |  Swap used |     Load | Blocked |
| ----- | -------: | -----: | ----------: | ----------: | ---------: | -------: | ------: |
| 04:00 |   98.07% |  0.03% |      23.47% |     5.61 GB |     66.26% |     0.24 |       0 |
| 04:30 |   98.11% |  0.03% |      23.62% |     5.60 GB |     66.22% |     0.44 |       0 |
| 05:00 |   98.06% |  0.03% |      23.68% |     5.59 GB |     66.10% |     0.13 |       0 |
| 05:20 |   98.04% |  0.04% |      23.83% |     5.58 GB |     65.90% |     0.17 |       0 |
| 05:30 |   98.07% |  0.03% |      23.86% |     5.58 GB |     65.88% |     0.48 |       0 |
| 05:40 |   92.66% |  0.70% |  **73.53%** | **1.54 GB** | **76.81%** | **3.42** |       1 |
| 05:50 |   76.38% |  4.84% |      34.29% |     4.73 GB |     67.07% |     1.91 |       0 |

At 05:30 — the last sample before SSH recovery — the host had 5.58 GB available,
23.86% memory used, 0.48 load and no blocked tasks. The memory spike at 05:40
coincides with the build that started at 05:39, **after** recovery.

The 2.6 GB of swap in use at 04:00–05:30 is residual from earlier activity
(consistent with the 00:40–01:17 iowait period); it is not, by itself, evidence
of exhaustion at 05:20.

### Docker / BuildKit logs

```
05:39:16 dockerd: … "detected 127.0.0.53 nameserver …"
05:39:19 dockerd: warning "healthcheck failed" error="… only one connection allowed"
05:39:24 dockerd: error "healthcheck failed fatally" … "only one connection allowed"
05:49:14 dockerd: "apply failure, attempting cleanup" error="failed to extract layer … context canceled"
05:49:14 dockerd: error /moby.buildkit.v1.Control/Solve error="rpc error: code = Canceled … context canceled"
```

These entries are from a build after recovery. The canceled solve is consistent
with a build client session ending; it does not establish why the earlier SSH
connection timed out. `docker events` retained no image/build events for the
03:00–06:30 window.

## 3. Attribution

| Candidate cause                     | Verdict       | Basis                                                                                       |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| Host CPU/memory exhaustion at 05:2x | NOT OBSERVED  | `sar` 04:00–05:30: ~98% idle, 5.58 GB available, load < 0.5, no blocked tasks               |
| sshd crash/restart                  | NOT OBSERVED  | `NRestarts=0`, running continuously since 2026-10-16                                        |
| Authentication failure              | NOT OBSERVED  | No sshd auth entries before 05:36:54; failed connections never reached auth                 |
| Kernel OOM / hung task              | NOT OBSERVED  | No matching kernel log lines 03:00–06:30                                                    |
| Network path fault                  | NOT PROVEN    | Ping/TCP/handshake were healthy at recovery; no packet-loss data at the incident            |
| Docker build resource pressure      | NOT THE CAUSE | The measured build pressure starts at 05:39, after recovery; earlier iowait was 00:40–01:17 |
| Disk exhaustion                     | NOT OBSERVED  | 20 GB free, 51% inodes at recovery; 22 GB free at CR                                        |

The symptom (TCP connection established, banner exchange timed out, no auth log)
is most consistent with a transient transport/sshd-accept stall, but there is no
direct evidence. **Root cause: UNKNOWN.** Do not record this as “resolved”; only
access was restored.

## 4. Recommendations

1. **Capture on recurrence.** Record the exact timestamp and keep
   `ssh -vvv` output; on the host, capture
   `journalctl -u ssh --since <time>`, `journalctl -k --since <time>`,
   `sar -q/-r/-u -f /var/log/sysstat/sa<dd>`, and `ss -ltnp`. Do not reboot or
   restart sshd before capturing evidence.
2. **Serialize builds.** The host has 8 vCPU / 7.7 GB RAM. The 05:40 sample shows
   a build can take available memory from 5.58 GB to 1.54 GB and load from 0.5 to
   3.4. Avoid concurrent Docker builds and consider `nice`/`ionice` or BuildKit
   concurrency limits.
3. **Keep the client liveness settings.** `ConnectTimeout=10`,
   `ServerAliveInterval=3`, `ServerAliveCountMax=1` make a dead path fail fast;
   they do not cause the stall.
4. **Capacity/disk.** The host is 82% full (22 GB free) and the Docker build cache
   is 53.5 GB (47.58 GB reclaimable). Do not prune without approval; plan
   capacity before the next large build.
5. **Out-of-band access.** For future timeouts, use the hypervisor console to
   distinguish a host fault from a network path fault before changing anything.
6. **Do not treat this report as proof the host was healthy at the exact moment
   of the timeout.** The post-recovery samples are the best available evidence,
   and they show no pressure in the preceding 90 minutes.

## 5. Status summary

| Check                                   | Result                       |
| --------------------------------------- | ---------------------------- |
| SSH access restored                     | PASS                         |
| Host identity (`ceshi-Virtual-Machine`) | PASS                         |
| sshd running, no restart                | PASS                         |
| Kernel OOM / hung-task evidence         | NOT OBSERVED                 |
| Host resource pressure in 04:00–05:30   | NOT OBSERVED                 |
| Auth failures before recovery           | NOT OBSERVED                 |
| Network fault attribution               | BLOCKED (no direct evidence) |
| Original timeout root cause             | **UNKNOWN**                  |
| Build pressure at 05:39+ documented     | PASS (not the cause)         |
