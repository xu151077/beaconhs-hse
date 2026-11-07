# Phase 6U-B3-CT — Final report

Date: 2026-10-19
Repository: `/home/test/projects/beaconhs-hse`
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Public test target: `https://beaconhs-test.xuhaoqing.top` (phase-aj)
Drill project: `beaconhs-drill-20261009` (read-only assessment)

Status: **Phase CT is complete, with one E2E failure and one build-security
caveat.** A real BuildKit image was built successfully. Scheduler detection,
recovery and health checks were verified on a disposable Redis and on the built
image. E2E ran against the live test stack; most flows passed, but the frozen
WOPI-session scenario timed out and is reported as FAIL. The drill stack was
diagnosed read-only and remains running and erroring; nothing was stopped,
migrated or deleted. All six gates pass on a forced, non-cached run. No commit or
push was made.

## 1. Final result

| Workstream                        | Result                                                               |
| --------------------------------- | -------------------------------------------------------------------- |
| A1 — baseline                     | PASS — branch/HEAD/worktree recorded; no destructive Git command     |
| A2 — real BuildKit image          | PASS — built locally; secret not in log/env/history                  |
| A2 — image secret criterion       | **WARN/FAIL** — Next.js embeds the key in its runtime manifest       |
| A3 — scheduler detection/recovery | PASS — 20/20 unit, disposable Redis, built image, worker health      |
| A4 — Playwright regression        | **PARTIAL** — auth/upload/Collabora/freeze/multipart pass; WOPI FAIL |
| A4 — Role Scope                   | NOT RUN — no existing E2E coverage                                   |
| A5 — six quality gates            | PASS — forced non-cached run, all exit 0                             |
| B — drill assessment              | PASS (read-only) — identity, drift, failures, options documented     |
| Drift repair / deployment         | NOT EXECUTED — requires owner approval                               |

## 2. What was actually executed

### 2.1 Real image build

```text
BuildKit image: beaconhs:phase-ct-validation-20261019-143743
Image ID:       sha256:9aac5ca6720d01c3366ec06eeee443ab78d8f9776dbd12e7e0e8fd2317ee3445
Size:           2,860,615,704 bytes
Architecture:   linux/amd64
BUILD_EXIT:     0
```

The build used a disposable 64-hex test key through
`--mount=type=secret,id=next_server_actions_key`. No production secret was read.
The image contains the web, worker, scheduler, health, ops-migrate and entrypoint
artifacts; Node is `v24.18.0`.

Secret checks:

- No key in the build log.
- No key in `Config.Env`.
- No key in image history.
- The key **is** in `/app/apps/web/.next/server/server-reference-manifest.json`
  and `.js` as Next.js's `encryptionKey`. This is framework runtime data, not a
  log leak, but it means the image is secret-bearing. A literal "no key anywhere
  in the image" criterion is not met. Restrict registry pull access; do not
  publish this image to an untrusted registry.

The built image's scheduler was exercised against disposable Redis: 13/13
register, `--check` exit 0, registry loss exit 1 with 13 missing, recovery exit 0.

### 2.2 Scheduler

- `pnpm --filter @beaconhs/jobs test`: **20/20 passed**.
- Disposable Redis only; no live phase-aj or drill Redis was used for
  destructive tests.
- Exact/missing/unexpected/duplicate/mismatch/count states verified.
- `scheduler.js --check` emits JSON and exits 0 when healthy, 1 when the registry
  is lost.
- Worker health exits 1 on the same mismatch.
- Not deployed to phase-aj.

### 2.3 E2E

Executed against the live phase-aj test stack with Chromium:

| Check                                     | Result   |
| ----------------------------------------- | -------- |
| Navigation smoke                          | PASS     |
| Collabora edit → save → persistence       | PASS     |
| Upload → download byte identity / Unicode | PASS     |
| All authenticated nav modules             | PASS     |
| Anonymous protected-route refusal         | PASS     |
| Frozen `Start blank` refusal              | PASS     |
| Frozen `Import Word` refusal              | PASS     |
| ACTIVE editor opens                       | PASS     |
| Frozen WOPI-session refusal               | **FAIL** |
| Frozen multipart create refusal           | PASS     |
| Release + 256 MiB multipart upload resume | PASS     |
| PDF preview (valid 510-byte PDF)          | PASS     |
| Role Scope / cross-role authorization     | NOT RUN  |

The frozen WOPI scenario timed out navigating to the document after freezing.
A `domcontentloaded` diagnostic also timed out, so this is not merely a
`waitUntil: 'load'` artifact. Freeze state was restored to `ACTIVE` after every
suite (final driver version 211). No business code or assertion was changed to
hide the failure.

### 2.4 Quality gates

All gates were run from the repository root. The Turbo-backed gates were then
rerun with `TURBO_FORCE=true` so the reported results are not cache hits.

| Gate      | Command                                 | Exit | Result | Log                                              |
| --------- | --------------------------------------- | ---: | ------ | ------------------------------------------------ |
| Format    | `pnpm format:check`                     |    0 | PASS   | `/tmp/opencode/phase-ct/format-final.log`        |
| Lint      | `TURBO_FORCE=true pnpm lint`            |    0 | PASS   | `/tmp/opencode/phase-ct/lint-force.log`          |
| Typecheck | `TURBO_FORCE=true pnpm typecheck`       |    0 | PASS   | `/tmp/opencode/phase-ct/typecheck-force.log`     |
| Test      | `TURBO_FORCE=true pnpm test --continue` |    0 | PASS   | `/tmp/opencode/phase-ct/test-continue-force.log` |
| Dead code | `pnpm deadcode:check`                   |    0 | PASS   | `/tmp/opencode/phase-ct/deadcode.log`            |
| Build     | `TURBO_FORCE=true pnpm build`           |    0 | PASS   | `/tmp/opencode/phase-ct/build-force.log`         |

Forced-run evidence:

```text
Tasks:    25 successful, 25 total
Cached:    0 cached, 25 total
@beaconhs/web:  Test Files 238 passed | 2 skipped (240)
@beaconhs/web:       Tests 2035 passed | 8 skipped (2043)
@beaconhs/jobs:      20 passed (dedicated run)
Build:     4 successful, 4 total, 0 cached
```

The final report was added after the code gates; the format gate was rerun after
it and passed. Code gates are unaffected by a Markdown-only addition.

## 3. Drill assessment summary

- Drill project `beaconhs-drill-20261009` is separate from phase-aj: own network,
  PostgreSQL, Redis, MinIO volumes and loopback ports. Its web is
  `127.0.0.1:3001`; phase-aj is `127.0.0.1:3010`.
- The public domain serves phase-aj, proven by authenticated phase-aj E2E and by
  the phase-aj freeze state changing the public page. Drill is not public.
- Drill `APP_URL` and `BETTER_AUTH_URL` point at the public phase-aj origin;
  `COLLABORA_URL`/`R2_ENDPOINT` point at `127.0.0.1:3002`, where nothing listens.
  Drill Mailpit has 0 messages; the cross-stack link/callback risk is latent.
- Migration ledger: phase-aj 50 rows; drill 45 rows (stops at 0045).
- Physical drill schema is **partially drifted**: 0046/0047 tables, enums,
  indexes and RLS exist, but the 0048 unique index is absent and the
  0049/0050 `multipart_upload_id` column is absent. A direct `db:migrate` would
  try 0046 again and fail because those objects already exist.
- 0049 is defective: it has 21 literal `\n` sequences and no real newlines, so
  the whole file is a comment. 0050 is the additive repair.
- Current drill failures: 45 `multipart_upload_id` errors and 45 reconciliation
  failures in the last 15 minutes; the `scheduled` failed set was 1,813 jobs at
  the 15:48 snapshot and is still growing about once per minute.
- The recurring failure is causally linked to the missing column: the
  reconciliation query explicitly selects `"multipart_upload_id"` from
  `attachment_upload_reservations`. Phase-aj has the column and 0 matching
  errors in the last 15 minutes. Earlier drill failures were separate
  `beaconhs_super`/`beaconhs_app` authentication failures; they are not
  attributed to the missing column.
- Phase-aj still has 270 historical failed jobs, including 163 old reconciliation
  failures; its current 15-minute error count is 0. This is residual history, not
  a clean-slate claim.

No drill container, volume, network, image, database or queue was changed.

## 4. Completed

- Baseline and final Git state recorded; no reset/clean/restore/add/commit/push.
- Real BuildKit image built from the working tree with the required secret.
- Build log, env and history checked; Next.js manifest key exposure documented.
- Scheduler unit, disposable Redis, CLI and built-image checks completed.
- Playwright auth/upload/Collabora/freeze/multipart/PDF checks executed.
- Frozen WOPI failure reproduced and diagnosed far enough to rule out the
  `load` wait alone.
- Drill identity, routing, migration drift, failure causes and three disposition
  options documented.
- Six gates passed with forced non-cached runs.
- Five Phase CT reports produced.

## 5. Not completed / blocked

- **WOPI frozen-session refusal** is not verified; the page navigation hangs. Do
  not mark this scenario green.
- **Role Scope / cross-role authorization** has no existing E2E; NOT RUN.
- **Drill repair** is blocked on owner approval, a backup window and the original
  drill environment file. Do not run `db:migrate` against drill as-is.
- **Scheduler deployment** is blocked on an image push/deploy decision. The new
  code is in the working tree and the local image only.
- **Image security criterion**: if "no key material anywhere in the image" is
  mandatory, it is unmet until the Next.js runtime key design changes.
- No deployment or configuration change was made to phase-aj, production,
  Cloudflare Tunnel or drill in this phase. The E2E suite did create isolated
  test-tenant documents/uploads, and it transiently changed that tenant's freeze
  state; the freeze state was restored to `ACTIVE` and verified (final driver
  version 211). Drill was not used for E2E.

## 6. Risks

1. **Drill error loop:** one failed scheduled job per minute and 45 errors per
   15 minutes; failed set grows. It is isolated from public phase-aj, but it
   consumes worker cycles and obscures real drill signal.
2. **Drill ledger drift:** a naive migration will fail at 0046; a careless repair
   could lose the 2 existing `storage_freeze` rows or leave the unique index
   absent. Backup and ledger reconciliation are mandatory.
3. **Drill URL collision:** drill magic links, callbacks and QR/email targets can
   point at the public phase-aj origin. No delivery was observed, but the risk is
   latent.
4. **Frozen WOPI hang:** a real user path may hang after freeze; the failed test
   is not proof of the exact cause, but it is a release risk.
5. **Image contains the Server Action key:** anyone with image pull access can
   read it. Restrict registry access and treat the image as a secret.
6. **Phase-aj historical failed jobs:** 270 remain, including 163 old
   reconciliation failures. They are not growing in the current 15-minute
   window, but they will remain visible for the 7-day failure retention.

## 7. Recommended next steps

1. Approve and execute **Option 1** for drill (stop only the worker) as immediate
   containment; verify the error/failed count stops growing.
2. If drill must remain usable, approve **Option 3**: back up the drill database,
   stop the worker, reconcile the 0046/0047 ledger versus physical schema, apply
   0048/0050, verify, restart, then fix drill-only URLs and Collabora/R2
   endpoints. Do not run a plain `db:migrate` first.
3. Investigate the frozen WOPI navigation hang with server/browser traces before
   treating the freeze gate as release-ready.
4. Add Role Scope/cross-tenant E2E coverage; it is currently absent.
5. Decide whether the Server Action key-in-image posture is acceptable. If not,
   design runtime key injection and re-run the build/secret checks.
6. Deploy scheduler/health code only after an approved image build/push and a
   `scheduler --check`/worker-health verification on the target stack.

## 8. Final worktree state

```text
branch:             hse-platform
HEAD:               51a899b7aac0a942da327222a3eed355fca9798a
tracked modified:   122
untracked (-uall):  625 (620 baseline + 5 Phase CT reports)
staged:             0
commits/pushes:     0
```

No existing modification, untracked file, `.tmp-*` script or user configuration
was removed. The temporary scheduler scripts and E2E specs were removed; the
reports and logs were retained. The drill remains running and unchanged.

## 9. Reviewer checklist

- [ ] Confirm the real image ID/tag and that it was not pushed.
- [ ] Decide whether the Next.js manifest key exposure is acceptable.
- [ ] Re-run `TURBO_FORCE=true pnpm test --continue` and check 25/25 tasks.
- [ ] Confirm the frozen WOPI failure is not reported as a pass.
- [ ] Approve or reject drill worker stop / schema repair.
- [ ] Before any drill repair: take and verify a backup; reconcile the ledger;
      do not run a plain `db:migrate`.
- [ ] Confirm no drill container, volume, database or queue was changed.
- [ ] Confirm HEAD/branch/staged state before any future commit.
