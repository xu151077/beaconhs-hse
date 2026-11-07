# Phase 6U-B3-CR — Scheduler reliability

Date: 2026-10-19
Target: `beaconhs-phase-aj` on the isolated test host `10.10.31.30`

Status: **PASS — the scheduler is a one-shot registration job, not a daemon.
Its clean exit 0 is correct. The restart policy was changed from `no` to
`on-failure:5`, the container was recreated with the current image, and repeat
registration is idempotent (13 definitions, 0 duplicates).**

## 1. The premise correction

The Phase CR brief described the scheduler as a supervised long-running service
that had exited 18 hours earlier (22 hours by the time of inspection). The
source and the runtime evidence show a
different design:

`apps/worker/src/scheduler.ts`:

```ts
async function main() {
  console.log('[scheduler] registering repeatable jobs…')
  await registerSchedules()
  console.log('[scheduler] done. Repeat schedules are persisted in Redis — exiting.')
  process.exit(0)
}
```

`/entrypoint.sh` dispatches `APP_ROLE=scheduler` to
`node apps/worker/dist/scheduler.js`. The scheduler registers repeatable jobs and
exits 0 by design. `restart: "no"` was therefore **not** the cause of a missing
service; an `always` policy would have produced an endless re-registration loop
after every clean exit. The meaningful failure mode is **registration failure**
(e.g. Redis unavailable at start), which should be retried.

## 2. Pre-change evidence

```
$ docker inspect beaconhs-phase-aj-scheduler-1 --format \
    'State={{.State.Status}} ExitCode={{.State.ExitCode}} Restart={{.HostConfig.RestartPolicy.Name}}'
State=exited ExitCode=0 Restart=no

$ docker logs beaconhs-phase-aj-scheduler-1
[scheduler] registering repeatable jobs…
[scheduler] done. Repeat schedules are persisted in Redis — exiting.
```

The container had completed its job and exited 0. The repeat schedules were
already persisted in Redis and the worker was executing them.

## 3. Change (minimal, reversible)

Backup:

```
cp -a /home/ceshi/beaconhs-phase-cd/compose.yaml \
      /home/ceshi/beaconhs-phase-cd/compose.yaml.bak-cr
```

Diff:

```diff
   scheduler:
     image: beaconhs:phase-cq-20261019-driver
     environment:
       <<: *app-env
       APP_ROLE: scheduler
-    restart: "no"
+    restart: on-failure:5
     depends_on:
       postgres: { condition: service_healthy }
       redis: { condition: service_healthy }
```

Recreate only the scheduler, without touching dependencies:

```
cd /home/ceshi/beaconhs-phase-cd
docker compose -f compose.yaml --project-name beaconhs-phase-aj \
  --env-file /home/ceshi/beaconhs-phase-aj/.env \
  up -d --force-recreate --no-deps scheduler
```

Why `on-failure:5`:

- a clean exit 0 (normal registration) stays exited — no restart loop;
- a non-zero registration failure retries up to five times;
- the scheduler is still a one-shot deploy step, not a second runtime.

## 4. Post-change verification

```
$ docker inspect beaconhs-phase-aj-scheduler-1 --format \
    'Status={{.State.Status}} Exit={{.State.ExitCode}} RestartCount={{.RestartCount}} Policy={{.HostConfig.RestartPolicy.Name}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}} Image={{.Config.Image}} {{.Image}}'
Status=exited Exit=0 RestartCount=0 Policy=on-failure:5
Image=beaconhs:phase-cq-20261019-driver sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370

$ docker logs beaconhs-phase-aj-scheduler-1
[scheduler] registering repeatable jobs…
[scheduler] done. Repeat schedules are persisted in Redis — exiting.
```

The scheduler now runs the same image as web and worker and exits cleanly with
the new policy.

### Restart-policy semantics probe

To verify that a **failure** is retried without risking the real scheduler, a
disposable container from the same image was started with `on-failure:2` and a
command that exits 1:

```
$ docker run -d --name cr-restart-probe --restart on-failure:2 \
    --entrypoint sh beaconhs:phase-cq-20261019-driver -c 'echo probe-fail; exit 1'
$ sleep 15
$ docker inspect cr-restart-probe --format \
    'Status={{.State.Status}} ExitCode={{.State.ExitCode}} RestartCount={{.RestartCount}} Restart={{.HostConfig.RestartPolicy.Name}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}}'
Status=exited ExitCode=1 RestartCount=2 Restart=on-failure:2

$ docker logs cr-restart-probe
probe-fail
probe-fail
probe-fail
```

Three runs (initial + 2 retries), then stopped. The probe was removed; no
residue remains. This verifies Docker's retry semantics on the deployed image.
A failure was deliberately **not** injected into the real scheduler, because
that would re-register schedules and add noise for no additional evidence.

## 5. Repeat scheduling is idempotent

After recreating the scheduler:

```
$ docker exec beaconhs-phase-aj-redis-1 redis-cli zcard 'bull:scheduled:repeat'
13
$ docker exec beaconhs-phase-aj-redis-1 redis-cli zrange 'bull:scheduled:repeat' 0 -1 | sort
tick-compliance-scan
tick-db-maintenance
tick-digest
tick-domain-event-outbox
tick-escalation
tick-form-session-overdue
tick-journal-analysis
tick-office-render-reconcile
tick-reports
tick-scheduled-flow
tick-storage-object-deletion
tick-storage-write-arms
tick-sync-scan
$ ... | sort | uniq -d | wc -l
0
```

Re-running the one-shot scheduler did **not** create shadow definitions. This is
also covered by `packages/jobs/src/lazy-runtime.test.ts` (“reconciles the exact
scheduled registry without leaving shadow repeat definitions”), and the jobs
package passed **19/19 tests** in the Phase CR full run.

## 6. Periodic work is executed by the worker, once per tick

The scheduler does not consume jobs; the single worker does:

```
$ docker logs --since 20m beaconhs-phase-aj-worker-1 | grep -E 'scheduled#repeat'
✔ scheduled#repeat:tick-compliance-scan:1792387560000 tick:compliance_scan
✔ scheduled#repeat:tick-domain-event-outbox:1792387560000 tick:domain_event_outbox
✔ scheduled#repeat:tick-storage-object-deletion:1792387560000 tick:storage_object_deletion
✔ scheduled#repeat:tick-form-session-overdue:1792387560000 tick:form_session
✔ scheduled#repeat:tick-storage-write-arms:1792387560000 tick:storage_write_arms
✔ scheduled#repeat:tick-scheduled-flow:1792387560000 tick:scheduled_flow
...
[scheduled] storage_write_arms: 0 reconciled / 0 quarantined / 0 deferred / 0 errors
```

There is exactly **one** phase-aj worker container. Each repeat job carries a
deterministic timestamped job id; Redis contains no duplicate timestamp keys
(`uniq -d` over the timestamped repeat keys was empty). The scheduler never
becomes a second consumer.

## 7. Duplicate-delivery protection

- Repeat registration: 13 stable scheduler ids; re-registration left 13/0
  duplicates.
- Dispatch: one worker; deterministic repeat job ids; no duplicate tick
  timestamps observed.
- Notifications: `notifications` has a unique index on
  `(tenant_id, source_job_id, user_id)` and the worker inserts with
  `onConflictDoNothing` on that target (`apps/worker/src/workers/notify.ts`).
  A retried notification job therefore cannot create a second inbox row for the
  same source job and user.
- In the observed window there were 0 notification rows and 0 duplicate groups
  (`SELECT ... HAVING count(*) > 1` returned 0 rows); Mailpit had 0 messages and
  the email queue had 0 waiting / 0 failed. This is a structural guarantee plus a
  short observation window, **not** a long-running delivery audit.

## 8. Residual risks

1. **Redis loss removes schedules.** They are persisted in Redis, not in the
   database. If Redis is flushed or replaced, re-run the scheduler:
   `docker compose ... up -d --force-recreate --no-deps scheduler`.
   This is an operational runbook item, not a code change in Phase CR.
2. **`on-failure:5` is silent.** A scheduler that exhausts five retries stays
   exited; there is no alert on the exit code. Recommend an external check on
   `docker inspect` exit code / logs. Not implemented in Phase CR.
3. **No periodic reconciliation.** A one-shot design does not re-register if
   Redis loses data while the stack stays up. A small idempotent re-registration
   at worker startup, or a monitored cron, would close this gap; it is outside
   the minimal fix and was not added.
4. The storage-init container remains on the old image (see the deployment
   identity report); it does not affect scheduling.

## 9. Status summary

| Check                                                      | Result                           |
| ---------------------------------------------------------- | -------------------------------- |
| Scheduler role understood (one-shot registrar)             | PASS                             |
| Exit code and logs explained                               | PASS                             |
| Minimal compose fix applied and backed up                  | PASS                             |
| Restart policy is `on-failure:5` on the real service       | PASS                             |
| Clean exit does not loop                                   | PASS                             |
| Failure retry semantics verified on the deployed image     | PASS                             |
| Recreated scheduler runs the current image                 | PASS                             |
| 13 repeat definitions, no duplicates after re-registration | PASS                             |
| Worker executes each tick once per timestamp               | PASS                             |
| Duplicate notification/business-data protection            | PASS (structural + short window) |
| Alerting on exhausted scheduler retries                    | NOT RUN (recommendation only)    |
| Redis-loss automatic re-registration                       | NOT RUN (runbook only)           |
