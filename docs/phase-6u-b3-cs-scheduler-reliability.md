# Phase 6U-B3-CS — Scheduler registration reliability

Date: 2026-10-19
Target under test: `beaconhs-phase-aj` on the isolated test host `10.10.31.30`
Implementation environment: local workspace + a disposable local Redis

Status: **Detection and recovery are implemented and tested in the repository:
the scheduler now reads back the exact registry before exiting 0, a read-only
`--check` probe prints JSON and exits non-zero on any mismatch, and the worker
health check reports the same mismatch. Re-registration is idempotent (13
definitions, 0 duplicates) and recovery from simulated Redis loss succeeded.
The new code is NOT deployed to `beaconhs-phase-aj` in this phase.**

## 1. Where the schedules live

BullMQ stores the repeat definitions in Redis, not in PostgreSQL. The phase-aj
stack currently has exactly 13 repeat members:

```text
$ docker exec beaconhs-phase-aj-redis-1 redis-cli zcard bull:scheduled:repeat
13
$ docker exec beaconhs-phase-aj-redis-1 redis-cli zrange bull:scheduled:repeat 0 -1 | sort | uniq -d | wc -l
0
```

The 13 keys are the stable `repeatKey` values in
`packages/jobs/src/queues/scheduled.ts`:

```text
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
```

The worker, not the scheduler, consumes the ticks. Fresh phase-aj logs show one
worker completing each tick timestamp once, including
`tick-storage-write-arms` and `tick-storage-object-deletion`.

## 2. One-shot registrar — the design fact

`apps/worker/src/scheduler.ts` is a one-shot job:

```ts
console.log('[scheduler] registering repeatable jobs…')
await registerSchedules()
console.log('[scheduler] done. Repeat schedules are persisted in Redis — exiting.')
process.exit(0)
```

The live container confirms that this is normal completion, not a crashed
daemon:

```text
status=exited exit=0 restarts=0 policy=on-failure:5
image=beaconhs:phase-cq-20261019-driver id=60dc4841…
logs:
  [scheduler] registering repeatable jobs…
  [scheduler] done. Repeat schedules are persisted in Redis — exiting.
```

A clean exit 0 must not be relaunched. The correct policy is
`on-failure:5` (Docker Compose) or Swarm `condition: on-failure` with a bounded
attempt count. An `always`/`unless-stopped` policy would re-register forever
after success. The Phase CR test-compose change to `on-failure:5` remains in
place and was not changed again in CS.

The meaningful failure is **registration failure or registry drift**, not “the
process exited.” Phase CS adds explicit detection for that failure.

## 3. Detection implementation

### 3.1 Exact registry comparison

`packages/jobs/src/queues/scheduled.ts` now exports:

```ts
export function inspectRepeatableSchedules(
  repeatables: readonly RepeatableSchedule[],
): ScheduledRegistrationHealth
```

It compares Redis’s repeatable jobs against the code registry and reports:

- `missing` — expected key absent;
- `unexpected` — key present that the code no longer defines;
- `duplicates` — the same key returned more than once;
- `mismatched` — same key but different `name` or cron `pattern`;
- `expectedCount` / `actualCount`;
- `ok` — true only when all four lists are empty and the counts match.

`inspectScheduledRegistration()` fetches `getRepeatableJobs()` and applies the
same comparison.

### 3.2 Scheduler read-back

Normal scheduler mode now registers and then verifies:

```ts
await registerSchedules()
const status = await inspectScheduledRegistration()
if (!status.ok) {
  throw new Error(`Repeat schedule verification failed: ${JSON.stringify(status)}`)
}
console.log(`[scheduler] verified ${status.actualCount}/${status.expectedCount} repeat schedules.`)
```

A partial registration can no longer exit 0. It exits 1, is captured by the
existing Sentry failure handler, and the five-retry policy applies.

### 3.3 Read-only probe

`node apps/worker/dist/scheduler.js --check` now performs no writes:

```json
{
  "event": "scheduler.repeat_schedules.check",
  "expectedCount": 13,
  "actualCount": 13,
  "missing": [],
  "unexpected": [],
  "duplicates": [],
  "mismatched": [],
  "ok": true
}
```

Exit code is 0 when exact, 1 when anything is missing, extra, duplicated or
mismatched. This is safe to run from an external monitor or manually.

### 3.4 Worker health check

`apps/worker/src/health.ts` (the command already used by the worker healthcheck
in `deploy/local-production.compose.yaml` and
`deploy/dokploy-dev.compose.yaml`) now checks the registry after DB/Redis
readiness:

```ts
const schedules = await inspectScheduledRegistration()
if (!schedules.ok) {
  console.error('[health] scheduled repeat registry mismatch', JSON.stringify(schedules))
  throw new Error('Scheduled repeat registry is not exact')
}
```

This is the post-registration-loss detector: the worker is unhealthy while it
would otherwise silently receive no scheduled ticks. The health check closes its
BullMQ producer connection before exiting.

Note: the ad-hoc phase-aj test Compose file has **no worker healthcheck** block,
so this detector is not active on that test stack until a healthcheck is added.
The tracked production/Dokploy Compose files already have the
`node apps/worker/dist/health.js` healthcheck.

## 4. Idempotent re-registration — tests and evidence

`registerSchedules()` already reconciles by stable `repeatKey`:

1. `removeUnconfiguredSchedules()` removes extra or mismatched repeat keys;
2. each of the 13 registry entries is re-added with its stable key and pattern.

A disposable local Redis (`redis:7-alpine`, `127.0.0.1:6399`) was used. No
phase-aj or drill Redis was modified.

Integration result (`/tmp/opencode/phase-cs/scheduler-integration.log`):

```text
first-registration   ok=true  expected=13 actual=13
repeat-registration  ok=true  expected=13 actual=13
simulated-redis-loss ok=false expected=13 actual=0  missing=13
recovered            ok=true  expected=13 actual=13
extra-schedule       ok=false expected=13 actual=14 unexpected=1
extra-removed        ok=true  expected=13 actual=13
mismatched-schedule  ok=false expected=13 actual=13 mismatched=1
mismatch-repaired    ok=true  expected=13 actual=13
INTEGRATION_OK
```

The “loss” was simulated by deleting `bull:scheduled:repeat`; the scheduler
re-registered all 13. Running `registerSchedules()` twice did not create
duplicates. Adding a stale `tick-stale` key was detected and removed by the next
reconciliation. Changing `tick-reports` to the wrong cron pattern was detected as
`mismatched` and repaired.

Scheduler CLI evidence (`/tmp/opencode/phase-cs/scheduler-cli.log`):

```text
scheduler --check (healthy)   EXIT=0
scheduler --check (lost)      EXIT=1  missing=13
scheduler one-shot recovery   EXIT=0  verified 13/13
scheduler --check (recovered) EXIT=0
```

Worker health evidence (`/tmp/opencode/phase-cs/worker-health.log`):

```text
worker health (healthy) EXIT=0
delete repeat zset      -> 1
worker health (lost)    EXIT=1
  [health] scheduled repeat registry mismatch {... "ok":false}
  [health] worker dependencies are not ready
restore scheduler       EXIT=0  verified 13/13
```

Unit tests:

```text
$ pnpm --filter @beaconhs/jobs test
Test Files  4 passed (4)
     Tests  20 passed (20)
EXIT=0
```

The new test covers exact health, missing, extra, mismatched and duplicate
detection. The existing reconciliation test still asserts 13 stable keys and 0
shadow definitions.

## 5. Observable state and alert conditions

| Signal              | Where                             | Healthy                 | Alert condition                                          |
| ------------------- | --------------------------------- | ----------------------- | -------------------------------------------------------- |
| Scheduler read-back | `[scheduler] verified 13/13…`     | exact count             | exit 1 / missing, extra, duplicate or mismatch in stderr |
| Read-only probe     | `scheduler.js --check` JSON       | `ok:true`, exit 0       | `ok:false`, exit 1                                       |
| Worker health       | `node apps/worker/dist/health.js` | exit 0                  | `[health] scheduled repeat registry mismatch`, exit 1    |
| Docker state        | scheduler container               | exited 0                | exit 1 / restart count increasing                        |
| Redis               | `bull:scheduled:repeat`           | 13 members, 0 duplicate | count ≠ 13 or any unexpected key                         |

Recommended external alert: run the read-only probe every minute (or use the
worker health status where the healthcheck is configured) and alert on non-zero
exit or `ok:false`. Recovery is the one-shot scheduler rerun:

```bash
docker compose -f <compose-file> --project-name <project> \
  --env-file <env-file> run --rm scheduler
```

or, on the existing test stack, recreate only the scheduler with `--no-deps`.
The scheduler registration is idempotent; no manual Redis cleanup is required.

## 6. Deployment decision

**Not deployed in Phase CS.** The live `beaconhs-phase-aj` scheduler still runs
the old image (`60dc4841…`) and its logs contain only the old two-line success
message; the live worker health script is the old one that checks only DB/Redis.
The new code exists in the working tree and passed unit and disposable-Redis
integration tests, but deploying it requires:

1. a new image build with the restored BuildKit secret;
2. a scheduler/worker recreate on the target stack;
3. a new `--check` probe against the live Redis;
4. verification that the worker healthcheck sees the exact 13-key registry.

Those steps were not executed because Phase CS forbids commits/pushes and did not
include an image-deploy approval. This is reported as **NOT DEPLOYED**, not as
a completed live change.

## 7. Residual risks

1. **No automatic self-heal.** Detection is explicit (scheduler read-back,
   `--check`, worker health) and recovery is a scheduler rerun. Nothing loops in
   the worker to re-register schedules; adding a second registrar has its own
   race/connection risks and was not done.
2. **Full Redis loss while the stack stays up.** If the repeat zset disappears,
   the worker no longer receives ticks. The worker healthcheck detects the
   mismatch only where that healthcheck is configured; the ad-hoc phase-aj test
   Compose has no worker healthcheck.
3. **Healthcheck start order.** A fresh worker can be unhealthy until the
   one-shot scheduler has run. The existing healthcheck has a 30 s start period;
   on a slow first boot, this can produce an initial unhealthy interval.
4. **`--check` uses the fail-fast producer connection.** It is correct for a
   one-shot probe; it is not a long-lived monitor connection.
5. **The test-compose scheduler still runs old code.** The `on-failure:5` policy
   is live, but the new read-back and worker health detection are not.

## 8. Status summary

| Check                                     | Result                 |
| ----------------------------------------- | ---------------------- |
| Repeat storage and count verified         | PASS                   |
| One-shot design confirmed                 | PASS                   |
| Missing/extra/duplicate/mismatch detector | PASS                   |
| Scheduler read-back and non-zero failure  | PASS                   |
| Read-only `--check` probe                 | PASS                   |
| Worker health detector                    | PASS                   |
| Idempotent re-registration                | PASS                   |
| Redis-loss recovery (disposable Redis)    | PASS                   |
| Deployed to `beaconhs-phase-aj`           | NOT RUN (not approved) |
| Automatic self-healing                    | NOT IMPLEMENTED        |
