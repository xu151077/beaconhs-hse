# Phase 6U-B3-N Verification Report

- Date: 2026-10-14
- Branch: `hse-platform`
- Expected and observed HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Prior reports: `docs/phase-6u-b3-m-verification-report.md`, `docs/phase-6u-b3-l-verification-report.md`, `docs/phase-6u-b3-j2-verification-report.md`
- This report: `docs/phase-6u-b3-n-verification-report.md`
- Initial G2 status: `BLOCKED`
- Final G2 status: `BLOCKED`

## 1. Baseline and worktree protection

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Working tree before this phase: 181 changed or untracked files.
- No branch switch, reset, restore, clean, stash, commit, staging, or push was performed.
- No application source, schema, migration, bucket policy, container image, or production configuration was changed.
- The only repository change in this phase is this report.

The static quality gates were intentionally not rerun, as instructed. Prettier was applied to this report only.

## 2. Environment identity and isolation

Remote host: `ceshi@10.10.31.30`, reached through the existing `beaconhs-drill` SSH alias.

Observed services at test time:

| Service    | Container / endpoint                                    | Observed state                                                                               |
| ---------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Web        | `beaconhs-drill-20261009-web-1`, `127.0.0.1:3001`       | healthy; `GET /api/health/ready` returned version `51a899b7aac0a942da327222a3eed355fca9798a` |
| PostgreSQL | `beaconhs-drill-20261009-postgres-1`, `127.0.0.1:5432`  | healthy                                                                                      |
| Redis      | `beaconhs-drill-20261009-redis-1`, `127.0.0.1:6379`     | healthy                                                                                      |
| MinIO      | `beaconhs-drill-20261009-minio-1`, `127.0.0.1:9000`     | healthy                                                                                      |
| Worker     | `beaconhs-drill-20261009-worker-1`                      | running                                                                                      |
| Mailpit    | `beaconhs-drill-20261009-mailpit-1`, `127.0.0.1:8025`   | healthy; used only for an isolated sign-in mail probe                                        |
| Collabora  | `beaconhs-drill-20261009-collabora-1`, `127.0.0.1:9980` | healthy                                                                                      |

Isolation findings:

- The only application database in the container is the drill database `beaconhs`, owned by the BeaconHS drill roles.
- The only object bucket used was the drill bucket `beaconhs-drill`, reached over loopback.
- No production DNS, tunnel, credential, bucket, database, C2 drill resource, or shared object store was accessed.
- All temporary objects, test tenants, arm rows, and mail messages created by this phase were removed or restored as recorded below.

### 2.1 Deployment identity is not sufficient

`APP_VERSION` and the readiness endpoint both report the required HEAD, but the packaged application is materially older than the working-tree storage and worker code:

- `/app/apps/worker/node_modules/@beaconhs/storage/src` in the running worker image contains only:
  - `endpoint-routing.test.ts`
  - `index.ts`
  - `lifecycle.test.ts`
  - `lifecycle.ts`
  - `multipart.test.ts`
  - `multipart.ts`
  - `object-keys.test.ts`
  - `storage-url.test.ts`
- That packaged snapshot has no `freeze-gate.ts` and no `write-arms.ts`.
- The deployed WOPI route bundle contains no `STORAGE_WRITE_BLOCKED` refusal string.
- The deployed worker `dist/scheduler.js` and `dist/index.js` contain no `storage_write_arms` symbol.

This is direct runtime evidence of deployment skew. A version label alone is therefore not proof that the running binaries contain the intended Phase 6T/6U code.

## 3. N1 — Freeze transitions, in-flight writes, and arms

### N1.1 Isolated tenant and database state

A dedicated tenant `b5a4f8b3-1f21-4f01-9f38-000000000094` was created for this phase, with its own freeze row, one unresolved `in_flight_writes` row, and one unresolved `storage_write_arms` row. No existing tenant was used for these drain scenarios.

The test then:

1. Set the isolated freeze row from `ACTIVE` to `FREEZE_REQUESTED` with version compare-and-set.
2. Set it from `FREEZE_REQUESTED` to `DRAINING` with a second compare-and-set.
3. Observed:

```text
n1_state   | DRAINING | version 2 | unresolved_in_flight 1 | unresolved_arms 1
drain_ready_with_open_items | false
```

4. Marked the in-flight row completed and the arm `redeemed_nop`.
5. Observed:

```text
drain_ready_after_terminal | true
post_drain_state          | DRAINING | version 2
```

Result: **PASS** for the database drain-counting primitive. Neither an unresolved in-flight row nor an unresolved arm can produce a ready result while present.

### N1.2 DRAINING to FROZEN

The actual rule function was invoked with `from=DRAINING`, `to=FROZEN`, version 2, a non-empty actor, and a reason:

```json
{
  "ok": false,
  "code": "FREEZE_DRAIN_UNVERIFIED",
  "message": "cannot enter FROZEN: drain verification is not implemented (stage E2); requesting a freeze is not the same as being frozen"
}
```

Source location: `packages/db/src/storage-freeze.ts:194`.

Result: the gate is fail-closed as designed. The requested `DRAINING -> FROZEN` completion was not bypassed.

Verdict: **FAIL for reaching `FROZEN`** in the sense required by the N1 acceptance condition: `DRAINING -> FROZEN` is still impossible and returns `FREEZE_DRAIN_UNVERIFIED`. This remains a G2 blocker.

### N1.3 Frozen-state write admission in the running deployment

The running deployment does not contain the freeze gate or write-arm issuer. A direct WOPI PutFile probe made during a non-ACTIVE freeze state is described under N4 and was not refused. There is therefore no runtime basis for proving that new PUT URLs, multipart-part URLs, or new controlled writes are refused in this environment.

Verdict: **FAIL for the running deployment**. The source rule is present, but the deployed runtime does not carry it.

### N1.4 Concurrency and failure injection

- Concurrent issuance versus a freeze request: **NOT RUN**; the running deployment lacks the gate and arm issuer.
- Database disconnect during freeze transition: **NOT RUN**; no safe isolated injection path was available without changing application behavior.
- Worker restart while DRAINING: **NOT RUN**; no deployed reconciler exists to restart and observe.
- Activation failure and network-unknown arm state: **NOT RUN** in the running deployment.

## 4. N2 — Actual presigned URL validity

### N2.1 Direct MinIO PUT URL behavior

Test command family:

```text
R2_ENDPOINT=http://127.0.0.1:9000
R2_BUCKET=beaconhs-drill
AWS SDK getSignedUrl(PutObjectCommand, expiresIn=120 or 1)
fetch(url, { method: 'PUT', body: ... })
```

Observed:

| Case                                   | Signed `X-Amz-Expires` | Result                                          |
| -------------------------------------- | ---------------------: | ----------------------------------------------- |
| Immediate 120-second PUT URL           |                    120 | HTTP 200                                        |
| 1-second PUT URL after 2.1-second wait |                      1 | HTTP 403, `AccessDenied`, `Request has expired` |

Both test objects were deleted immediately after the probe.

Result: **PASS** for the isolated MinIO S3 presigned PUT protocol behavior. An expired URL is rejected by the object store with a real server-side response.

### N2.2 Multipart part URL behavior

A disposable multipart upload was created, a part URL was signed with `expiresIn=1`, the request was delayed 2.1 seconds, and the part PUT was attempted.

Observed:

```text
uploadId_created true
multipart_expired_status 403
multipart_aborted yes
```

Result: **PASS** for the isolated MinIO multipart-part expiry protocol.

### N2.3 Application-to-arm-to-signature linkage

The running deployment has no `write-arms.ts` and no arm issuer, so the application path cannot be observed end to end.

The working-tree source also contains a separate, reproducible defect:

- `apps/web/src/lib/uploads.ts:212` requests `presignMultipartPart(..., expiresInSeconds: 3600)`.
- `apps/web/src/lib/uploads.ts:229` requests `presignPut(..., expiresInSeconds: 300)`.
- `packages/storage/src/index.ts:387` rejects PUT requests over 120 seconds.
- `packages/storage/src/index.ts:569` rejects multipart-part requests over 60 seconds.

With the intended working-tree caps, those two web call sites are rejected before a URL is issued. This is a source defect, not an SDK clock ambiguity. It was not modified in this phase.

Verdict:

- Isolated MinIO PUT expiry behavior: **PASS**.
- Isolated MinIO multipart expiry behavior: **PASS**.
- Application-issued URL and arm linkage: **FAIL** for the running deployment and **FAIL by source defect** for the working-tree call sites.
- Exact comparison of arm expiry and application signature: **NOT RUN**, because the deployed runtime has no arm issuer and the working-tree call sites fail the cap check.

## 5. N3 — Arm reconciliation live scheduling and recovery

A disposable `storage_write_arms` row was created for the drill tenant with:

- `state = 'armed'`
- `expires_at = now() - 5 minutes`
- a key under the drill tenant prefix
- `issued_by = 'phase-n runtime test'`

The scheduler registration entrypoint was then run inside the worker container:

```text
docker exec beaconhs-drill-20261009-worker-1 \
  node /app/apps/worker/dist/scheduler.js
```

It returned success:

```text
[scheduler] registering repeatable jobs…
[scheduler] done. Repeat schedules are persisted in Redis — exiting.
```

After waiting beyond a minute boundary:

- The arm row remained `armed` with no `last_checked_at` and no `reconciled_at`.
- No `tick:storage_write_arms` BullMQ key existed in Redis:

```text
docker exec ... redis-cli --scan --pattern 'bull:scheduled:repeat:tick-storage-write-arms*'
# no output
```

- The worker logs contained no `[scheduled] storage_write_arms:` line.
- The deployed worker `dist/scheduler.js` and `dist/index.js` contain no `storage_write_arms` symbol.

The disposable arm was deleted after evidence collection.

Verdict: **FAIL**. The live worker does not register or execute the arm reconciliation schedule in this deployment. Concurrency, retry, and worker-restart recovery are **NOT RUN**, because the scheduled job does not exist in the deployed runtime.

## 6. N4 — WOPI/Collabora freeze behavior

### N4.1 Environment and token

- Collabora container was healthy on loopback `9980`.
- A valid WOPI grant for the isolated drill document was minted with the deployed 12-hour TTL and bound to the existing test document attachment.
- The token was used only against the isolated drill document and was deleted from the container after the probe.

### N4.2 PutFile while the freeze row was non-ACTIVE

The drill tenant freeze row was temporarily changed from `ACTIVE` to `FREEZE_REQUESTED` in a committed database transaction.

The WOPI PutFile HTTP request was then issued against the real test route:

```text
POST /wopi/files/<isolated-test-document-attachment>/contents?access_token=<token>
Content-Type: application/octet-stream
body: 18 bytes of disposable test data
```

Observed result:

```text
HTTP=200
{"LastModifiedTime":"2026-10-14T06:45:19.100Z"}
```

Expected under the working-tree freeze gate was HTTP 423 `Workspace unavailable`.

The attachment row was updated by the route and an audit row was written:

```text
update | Saved "wopi-drill-test.docx" in the editor | 2026-10-14 06:45:19.100397+00
```

This is a direct runtime failure for WOPI freeze behavior. The deployed storage package lacks the freeze gate, so the write was admitted.

### N4.3 Cleanup and restoration

Because the PutFile route replaced the object referenced by the seeded disposable WOPI test document:

- the newly written object was deleted;
- the original object key was restored with a valid blank DOCX payload;
- the attachment row was restored to the original key and timestamp;
- the isolated test token file and Mailpit message were deleted.

The earlier test document payload was not recoverable from the object store. It was explicitly a `wopi-drill-test.docx` fixture, not a real user document. The audit row was retained as evidence rather than erased.

### N4.4 Other WOPI behavior

| Behavior                                | Verdict                                        |
| --------------------------------------- | ---------------------------------------------- |
| Freeze-before-token issuance            | NOT RUN; the deployed mint path lacks the gate |
| PutFile during non-ACTIVE freeze        | FAIL; observed HTTP 200 instead of 423         |
| AutoSave/Collabora callback integration | NOT RUN                                        |
| Read-only token semantics               | NOT RUN                                        |
| Fail-closed database read failure       | NOT RUN                                        |

## 7. N5 — External delete permission and alert delivery

### N5.1 Isolated bucket permission evidence

Read-only checks:

- `GetBucketPolicy` on `beaconhs-drill` returned `NoSuchBucketPolicy`.
- The isolated drill identity could create, delete, and then fail to head a unique disposable object:

```json
{
  "identity": "drillminio",
  "bucket": "beaconhs-drill",
  "deleteHttp": 204,
  "postDelete": "NotFound"
}
```

The delete was performed only against the isolated drill bucket and the disposable object was removed.

Verdict:

- Isolated drill identity delete capability: **PASS**.
- Production/external operator delete restriction: **UNKNOWN**. This test says nothing about production Cloudflare R2 policies, IAM identities, bucket policies, or break-glass roles.

### N5.2 Alert delivery

Both web and worker environments were checked for alert-related configuration keys. No keys matching alert, webhook, Slack, PagerDuty, incident, or ops receivers were present.

Result: **NOT RUN** for alert generation, queueing, delivery, and receiver acknowledgement. Mailpit exists in the isolated environment but is not configured as an alert receiver.

## 8. N6 — Lifecycle actual expiry

### N6.1 Actual rules snapshot

Read-only `GetBucketLifecycleConfiguration` returned:

```json
[
  {
    "Status": "Enabled",
    "Expiration": { "Days": 1 },
    "ID": "expire-unfinalized-uploads",
    "Filter": { "Tag": { "Key": "beaconhs-state", "Value": "pending" } }
  },
  {
    "Status": "Enabled",
    "Expiration": { "Days": 1 },
    "ID": "expire-transient-artifacts",
    "Filter": { "Tag": { "Key": "beaconhs-state", "Value": "transient" } }
  }
]
```

This corrects the Phase M wording that the rules “exactly match” the managed rules. The MinIO response does not include `AbortIncompleteMultipartUpload`, although the managed pending rule declares it.

### N6.2 Disposable tagged object probe

A disposable object was created with tag `beaconhs-state=pending`. The tag was read back and the object was present with HTTP 200. It was deleted manually after the probe because the configured expiry is one day and this phase could not wait for the rule to execute.

Verdict: **NOT RUN** for actual lifecycle expiry execution. Configuration presence was proven; execution was not.

### N6.3 Lifecycle diff defect

Invoking the working-tree `diffManagedStorageLifecycleRules` with the actual MinIO response returned:

```json
{
  "status": "DRIFT",
  "missing": [],
  "mismatchIds": [
    { "id": "expire-unfinalized-uploads", "differences": ["AbortIncompleteMultipartUpload"] },
    { "id": "expire-transient-artifacts", "differences": ["Other fields"] }
  ]
}
```

The first difference is explainable by MinIO not returning the abort-incomplete-multipart rule. The second is a code defect: `packages/storage/src/lifecycle.ts:22` normalizes rules with `JSON.stringify`, and `packages/storage/src/lifecycle.ts:75` compares serialized property order. A field-order-only difference is reported as `Other fields` and therefore as `DRIFT`.

This defect was not changed in this phase.

## 9. Cleanup and isolation result

Removed or restored:

- isolated N1 tenant, freeze row, in-flight row, and arm rows: deleted;
- N2 PUT and multipart disposable objects: deleted;
- N3 disposable arm row: deleted;
- N5 disposable delete-permission object: deleted;
- N6 disposable tagged object: deleted;
- Mailpit sign-in message: deleted;
- temporary scripts and WOPI token file: deleted;
- drill tenant freeze row: restored to `ACTIVE`, version 0, no migration, no freeze request timestamp;
- seeded WOPI drill document attachment: restored to a valid blank DOCX at its original key; its earlier disposable payload was not recoverable;
- N1–N6 prefix listings returned zero leftover probe objects.

No production object, credential, policy, DNS, tunnel, C2 resource, or external alert channel was touched.

## 10. G2 final matrix

| Required item                                   | Verdict                                                  | Direct evidence                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Freeze conversion and in-flight writes          | FAIL                                                     | Real DB drain counts behaved correctly, but `DRAINING -> FROZEN` returns `FREEZE_DRAIN_UNVERIFIED`; deployed gate is absent           |
| PUT URL actual expiry                           | PASS for MinIO protocol / FAIL for application linkage   | 120-second immediate URL returned 200; expired 1-second URL returned 403; app call site requests 300 seconds against a 120-second cap |
| Multipart part URL actual expiry                | PASS for MinIO protocol / FAIL for application linkage   | Expired part URL returned 403; app call site requests 3600 seconds against a 60-second cap                                            |
| Arm reconciliation live scheduling and recovery | FAIL                                                     | No Redis repeatable key, no worker log, no deployed `storage_write_arms` symbol, disposable arm stayed `armed`                        |
| Lifecycle actual expiry                         | NOT RUN                                                  | Rules snapshot and tagged-object presence only; one-day wait not performed                                                            |
| External delete permission                      | UNKNOWN for production; PASS for isolated drill identity | Drill identity DeleteObject returned 204 and object was gone; no production IAM/R2 policy evidence                                    |
| Alert delivery and acknowledgement              | NOT RUN                                                  | No configured isolated alert receiver                                                                                                 |
| WOPI/Collabora freeze-period write behavior     | FAIL                                                     | Real WOPI PutFile during non-ACTIVE freeze returned 200 instead of 423                                                                |

### G2 decision

**G2 remains `BLOCKED`.**

The isolated tests produced useful direct evidence, but the required end-to-end runtime behavior is not satisfied:

1. `DRAINING -> FROZEN` is still blocked by `FREEZE_DRAIN_UNVERIFIED`.
2. The running deployment lacks the freeze gate, write-arm issuer, and reconciliation schedule.
3. The working-tree upload call sites request TTLs rejected by the new presign caps.
4. Lifecycle expiry execution and alert delivery were not run.
5. Production delete permissions and production runtime configuration remain unproven.
6. WOPI PutFile during a non-ACTIVE freeze was not refused.

Isolated MinIO behavior cannot prove production Cloudflare R2, production IAM, production network paths, production DNS/Tunnel behavior, or production Collabora configuration. Separate production evidence is still required.

## 11. Additional code or authorization required

No code change was made in this phase. The following need separate authorization and fixes before G2 can be re-evaluated:

1. Deploy a web/worker image whose packaged storage and worker code includes `freeze-gate.ts`, `write-arms.ts`, the arm issuer registration, and the `storage_write_arms_reconcile` schedule.
2. Change `apps/web/src/lib/uploads.ts` TTL requests to the accepted storage caps, or define an explicit, reviewed compatibility decision.
3. Implement and test drain evidence before allowing `DRAINING -> FROZEN`.
4. Fix lifecycle rule comparison to be field-order independent and decide how MinIO’s missing `AbortIncompleteMultipartUpload` response should be classified.
5. Provide an isolated alert receiver and authorized delivery evidence.
6. Provide a non-production integration fixture for WOPI PutFile/AutoSave that is safely disposable and restorable.
7. Provide production-equivalent storage identity, bucket policy, lifecycle execution, and network evidence separately from this drill environment.

## 12. Git status

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- Working tree: 182 changed or untracked files after adding this report (181 pre-existing entries plus this report).
- No commit.
- No push.
- No destructive Git command.

Stopping here. G2 remains `BLOCKED`.
