# Phase 6U-B3-L Verification Report

- Date: 2026-10-14
- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Report: `docs/phase-6u-b3-l-verification-report.md`
- Initial G2 status: `BLOCKED`

## 1. Baseline and environment identity

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Working tree remains dirty with 178 files; no repository changes were made for this phase except this report.
- No destructive git commands, schema migrations, container changes, production writes/deletes, or secret changes were performed.
- Read-only local process inspection found only one identifiable long-running test component relevant to the stack:
  - `beaconhs-collabora` (`127.0.0.1:9980`, Up 2h, healthy)
- No PostgreSQL, MinIO/SeaweedFS, Redis, email, or web application listeners were observed at the usual 3000/5433/6380/9000/9001 endpoints.
- No relevant database/storage/object-store environment variables were exposed to the shell.
- Consequently, no external object-store lifecycle, DNS, network, or IAM evidence could be collected in this workstation session.

## 2. L1 — Presigned URL TTL

### Code evidence

- `packages/storage/src/index.ts`:
  - `presignPut`: default `120s`, hard max 120s.
  - `presignMultipartPart`: default `60s`, hard max 60s.
  - out-of-range values reject before any signature.
- `packages/db/src/storage-write-arms-operations.ts`:
  - `computeStorageWriteArmExpiry` accepts only valid values and uses the exact requested seconds.
  - DB row `expires_at` is created from the validated request.
- `storageWriteArmsDrainReady` applies a fixed `15s` post-expiry grace before readiness can become true.

### Test evidence

- Storage tests: pass at time of Phase K with 130 tests.
- TTL rejection and invalid value tests are covered in `presign-arm-control.test.ts`.

### External evidence

- No isolated MinIO/SeaweedFS/S3 endpoint was available.
- No `HEAD`, real PUT, real multipart, deletion, or protocol timing test was executed.
- Thus actual server enforcement of the 120s / 60s expiration windows is `UNKNOWN`.

L1 verdict: `PASS` source, `UNKNOWN` external service boundary.

## 3. L2 — Lifecycle actual configuration and execution

### Code evidence

- `packages/storage/src/lifecycle.ts` defines only two managed tags:
  - `beaconhs-state=pending` → 1 day plus multipart abort
  - `beaconhs-state=transient` → 1 day
- `diffManagedStorageLifecycleRules` can return:
  - `PASS` when expected rules are present and mismatched fields are absent
  - `DRIFT` on missing or mismatched managed rule details
  - `UNKNOWN` when the rules cannot be read

### Test evidence

- Lifecycle tests: 130 tests passing.
- Lifecycle diff added tests covering pass, missing, disabled/shortened rules, and unreadable input.

### External evidence

- No actual bucket lifecycle snapshot was collected.
- No producer logs, scheduler timestamp, or reconciliation execution output was correlated.
- Evidence that configured durations cause real deletion/abort behavior at their stated day boundaries is unavailable.

L2 verdict: `PASS` source, `UNKNOWN` real configuration and execution, no live rules snapshots or expiry evidence.

## 4. L3 — External delete permissions and bypass paths

### Code evidence

- Application paths use:
  - `assertStorageWriteAllowed`
  - tenant-derived keys
  - tracked in-flight writes
  - tracked presigned arms
  - deletion outbox with completed/retried states
- `lifecycle.ts` does not itself delete objects — it only defines expected rules for external storage.

### External evidence

- No external storage identity, bucket policy, SeaweedFS role configuration, or audit log was evaluated.
- No direct S3/SeaweedFS access path validation was possible.
- No evidence that operation identities are barred from `DeleteObject` / `PutLifecycleConfiguration`.
- Canonical boundary remains: repositories, not repository-independent policies, were not inspected.

L3 verdict: `FAIL-safe because unproven`; `UNKNOWN` actual external permissions. Current posture requires that any external delete identity be treated as capable of bypassing the application freeze gate until deployment evidence proves otherwise.

## 5. L4 — Alert routing

### Code/workflow evidence

- Event outbox, compliance scan, digest, and scheduled tick mechanisms exist and are logged.
- Worker reconciliation and other schedule entries log errors and failed states.
- New storage arm reconciler raises effectively failed ticks with return errors.

### External evidence

- No alert channel, receiver, routing rule, historical delivery, or incident workflow was inspected or exercised.
- Scheduled ticks were not triggered, logs were not reviewed, and no alert did not constituted proof of delivery or policy execution.
- No experimental alert notification was sent.

L4 verdict: `NOT RUN` on external infrastructure, data stores. Alert delivery is unresolved.

## 6. L5 — WOPI runtime behavior

### Code evidence

- `wopiToken` is listed in `GATED_STORAGE_OPERATIONS`.
- WOPI contents save path checks freeze and returns an error to Collabora.
- Tokens remain valid for the full 12-hour TTL (by design, no revocation mechanism identified).
- Freeze reads fail closed: no state reader or non-ACTIVE is accepted.
- Existing WOPI route tests cannot execute without `SEED_TEST_SCRATCH_DATABASE_URL`, so the real callback integration was `NOT RUN`.

### External evidence

- Collabora process is present at `127.0.0.1:9980`, but no backed verified snapshot was collected and no application server process on standard ports was detected.
- No storage object capture, network proxy, or HTTP traffic evidence was collected.
- A real Collabora session was not exercised.
- Token revocation still cannot be claimed.

L5 verdict: `PASS` source controls only; live WOPI behavior `UNKNOWN / NOT RUN`.

## 7. G2 summary

| Item | Name                              | L-verdict     | Reason                                               |
| ---- | --------------------------------- | ------------- | ---------------------------------------------------- |
| 1    | Application new write             | `PASS`        | freeze gate, code review, and linked tests           |
| 2    | Presigned URL TTL                 | `PASS` source | 120s/60s caps, tests                                 |
| 3    | Presigned actual expiry behavior  | `UNKNOWN`     | no live object-store endpoint                        |
| 4    | In-flight drain                   | `PASS` source | DB counters + lock                                   |
| 5    | Arm reconciliation                | `PASS` source | conservative state model, worker code and unit tests |
| 6    | Arm reconciliation live execution | `UNKNOWN`     | no available DB/storage env                          |
| 7    | Multipart live behavior           | `UNKNOWN`     | no live multipart endpoint                           |
| 8    | WOPI new write blocking           | `PASS` source | gated entry path                                     |
| 9    | WOPI live revocation              | `UNKNOWN`     | full 12h window remains, no revocation mechanism     |
| 10   | Lifecycle source behavior         | `PASS` source | managed rules and diff test                          |
| 11   | Lifecycle actual config           | `UNKNOWN`     | no snapshot / execution logs                         |
| 12   | External delete path control      | `UNKNOWN`     | deployment identity/policy not inspected             |
| 13   | Alert routing/listener            | `NOT RUN`     | no delivery evidence                                 |
| 14   | Recovery authorization            | `PASS` source | fails-closed, report-defined recovery                |

G2 remains **BLOCKED**.

## 8. Commands and checks run in this phase

Read-only commands:

- `git rev-parse HEAD`
- `git status --short | wc -l`
- `docker ps --format ...`
- `ss -ltnp` listener inspection
- `compgen -e | grep ...`

Test evidence reused from Phase K (latest successful runs):

- `pnpm --filter @beaconhs/storage test`: pass — 12 files, 130 tests
- `pnpm --filter @beaconhs/worker test`: pass — 27 files, 103 tests
- `pnpm --filter @beaconhs/jobs test`: pass — 4 files, 19 tests
- `pnpm --filter @beaconhs/db test`: pass — 61 files, 495 passing, 35 skipped

No write, delete, lifecycle-trigger, alert, or network test was started in this phase.

## 9. Additional evidence still needed from external owners

Must be provided before G2 can be reconsidered:

1. Snapshot of the evidence associated MinIO/SeaweedFS/S3 bucket lifecycle and execution log.
2. Direct evidence of each object-store role: read-only scoped application identity, permission details, Delegation/Policy JSON redacted where needed.
3. A trial/runtime evidence window for URL expiry attainment around the 120- and 60-second boundaries measured, not assumed.
4. WOPI/Collabora callback logs, or a truly separate test-doc in a knowingly isolated deployment.
5. Alert routing and receiver acceptance records, or a clearly non-operational test webhook/channel evidence.

None of the above exists in the source tree or surfaced workstation environment today.

## 10. Git status

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Working tree: dirty/active prior user changes preserved.
- No commit or push in this phase.

End of phase. No automatic continuation.
