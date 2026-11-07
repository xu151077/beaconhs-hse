# Phase 6U-B3-CT — Scheduler verification

Date: 2026-10-19
Repository: `/home/test/projects/beaconhs-hse`
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Test transport: disposable Redis `127.0.0.1:6399` only

Status: **PASS for detection, recovery and health reporting.** The scheduler
registry inspector handles exact, missing, unexpected, duplicate, mismatched and
count-mismatch states. `scheduler.js --check` returns a machine-readable JSON
result with exit 0/1. Worker health returns non-zero on the same mismatch. The
same checks pass against the scheduler bundled into the real Phase CT image.
Nothing was deployed to `beaconhs-phase-aj`, and no live Redis was used for
destructive tests.

## 1. Unit suite

```text
$ pnpm --filter @beaconhs/jobs test
Test Files  4 passed (4)
     Tests  20 passed (20)
EXIT=0
```

Log: `/tmp/opencode/phase-ct/jobs-test.log`.

## 2. Disposable Redis integration

A local `redis:7-alpine` container was started on `127.0.0.1:6399` with no
persistent volume. The test script refused to run unless
`REDIS_URL=redis://127.0.0.1:6399`. It was removed after the run.

### 2.1 Registration and recovery

```text
first-registration
  {"ok":true,"expected":13,"actual":13,"missing":0,"unexpected":0,"duplicates":0,"mismatched":0}

repeat-registration (idempotency)
  {"ok":true,"expected":13,"actual":13,"missing":0,"unexpected":0,"duplicates":0,"mismatched":0}
  zcard bull:scheduled:repeat = 13

simulated registry loss
  {"ok":false,"expected":13,"actual":0,"missing":13,"unexpected":0,"duplicates":0,"mismatched":0}

re-registration
  {"ok":true,"expected":13,"actual":13,"missing":0,"unexpected":0,"duplicates":0,"mismatched":0}
```

`INTEGRATION_OK`; exit 0. Log:
`/tmp/opencode/phase-ct/scheduler-integration.log`.

### 2.2 State detection

| State                                | Observed result                                    |
| ------------------------------------ | -------------------------------------------------- |
| Exact 13 expected schedules          | `ok=true`, expected 13, actual 13                  |
| Idempotent second registration       | 13 members, 0 duplicates                           |
| Entire registry removed              | `ok=false`, actual 0, 13 missing                   |
| Unexpected schedule added            | `ok=false`, actual 14, 1 unexpected, then repaired |
| Duplicate expected entry             | `ok=false`, actual 14, 1 duplicate                 |
| Expected key with wrong cron pattern | `ok=false`, 1 mismatched, then repaired            |
| Count mismatch / missing / extra     | Reflected in `actualCount` and the matching list   |

The duplicate case is exercised through the pure inspector because a Redis
sorted set cannot contain the same member twice; that is the same representation
the inspector receives from BullMQ.

### 2.3 Scheduler CLI contract

```text
healthy:   {"event":"scheduler.repeat_schedules.check",...,"ok":true}   EXIT=0
lost:      {"event":"scheduler.repeat_schedules.check",...,"ok":false}  EXIT=1
recovery:  [scheduler] verified 13/13 repeat schedules.              EXIT=0
recheck:   {"event":"scheduler.repeat_schedules.check",...,"ok":true}   EXIT=0
```

The JSON includes `expectedCount`, `actualCount`, `missing`, `unexpected`,
`duplicates`, `mismatched`, and `ok`. Log:
`/tmp/opencode/phase-ct/scheduler-cli.log`.

### 2.4 Worker health

```text
healthy:   EXIT=0
delete repeat registry
unhealthy: [health] scheduled repeat registry mismatch {... "ok":false}
           [health] worker dependencies are not ready
           EXIT=1
restore:   [scheduler] verified 13/13 repeat schedules.              EXIT=0
```

Log: `/tmp/opencode/phase-ct/worker-health.log`.

## 3. Built-image verification

The scheduler bundled into
`beaconhs:phase-ct-validation-20261019-143743` was run against the same
disposable Redis:

```text
register      EXIT=0  verified 13/13
--check       EXIT=0  ok=true, 13/13
delete        (test setup)
--check       EXIT=1  ok=false, 0/13, 13 missing
recovery      EXIT=0  verified 13/13
--check       EXIT=0  ok=true, 13/13
```

This proves the built artifact, not only the source tree, contains the detection
and recovery code. Log: `/tmp/opencode/phase-ct/image-scheduler.log`.

## 4. Scope and limits

- Only the disposable Redis was written to. The live phase-aj Redis
  (`127.0.0.1:3014`) and drill Redis (`127.0.0.1:6379`) were never used for
  destructive scheduler tests.
- No scheduler/worker image was pushed or deployed.
- No phase-aj or drill container was restarted or recreated.
- The live phase-aj scheduler is still the previously deployed image and does
  not contain this Phase CT deployment; that remains a separate deploy decision.
- The built image contains the scheduler and health entrypoints; its web/worker
  processes were not started against the live database in this phase.

## 5. Verdict

Scheduler registration detection and recovery are verified on disposable Redis
and inside the real built image. The implementation is ready for a controlled
deployment decision, but Phase CT did not deploy it.
