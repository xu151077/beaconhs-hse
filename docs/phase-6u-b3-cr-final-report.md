# Phase 6U-B3-CR — Final report

Date: 2026-10-19
Repository: `/home/test/projects/beaconhs-hse`
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Test host: `10.10.31.30` (`ceshi-Virtual-Machine`)
Test stack: `beaconhs-phase-aj` (domain `https://beaconhs-test.xuhaoqing.top`)
Tenant: `ea5a149b-ea76-48e0-abbe-fa360f520d8e`

Status: **Phase CR complete. The tested stack identity is clear; the scheduler
is verified as a one-shot registrar with a resilient restart policy; the full
gate results are recorded; the unused drill stack was inventoried and not
deleted; the pre-existing worktree was preserved; no commit or push was made.
Two gates remain red for pre-existing working-tree reasons, and the SSH root
cause remains UNKNOWN.**

## 1. Result by phase

| Phase | Area                  | Result                              | Summary                                                                                                                                 |
| ----- | --------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Real stack identity   | **PASS** (with residual mismatches) | Domain, Compose project, containers, image digest, DB, Redis, MinIO and Mailpit all resolve to `beaconhs-phase-aj`.                     |
| B     | Scheduler reliability | **PASS**                            | Scheduler is a one-shot registrar; `restart: on-failure:5`; 13 repeat definitions, 0 duplicates; failure-retry semantics verified.      |
| C     | Full quality gates    | **4 PASS / 2 FAIL**                 | format, lint, typecheck, build pass; test and deadcode fail for pre-existing worktree reasons. No CR code changes.                      |
| D     | Drill stack risk      | **PASS** (inventory only)           | Isolated network/volumes/DB, but active worker, schema drift, same public `APP_URL`, shared image tag. Not stopped or deleted.          |
| E     | 256 MiB PDF preview   | **PASS for diagnosis**              | Upload and structure valid; 1/16/32 MiB render; 64/256 MiB abort at the 10 s watchdog with bounded memory and no crash. Proposals only. |
| F     | SSH timeout review    | **Recovery PASS / cause UNKNOWN**   | No host pressure, sshd restart or kernel OOM evidence; no direct network evidence. Root cause not determined.                           |
| G     | Reports               | **PASS**                            | Seven `docs/phase-6u-b3-cr-*.md` documents written and Prettier-clean.                                                                  |

## 2. Key findings

### 2.1 Stack identity

- The earlier “container name = target” assumption was wrong. The public domain
  serves `beaconhs-phase-aj`, not `beaconhs-drill-20261009`. The proof is
  behavioural: the domain renders the phase-aj tenant names and the phase-aj
  database contains exactly those tenants; the drill database contains different
  tenants; the drill web is on 3001 with no clients.
- Web and worker run `sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370`,
  matching the Phase CQ report. The scheduler now runs the same image.
- `storage-init` is still an exited container on the older `8feaa82d…` image;
  the Compose file already references the current image. No runtime impact.
- The tunnel ingress is token-managed and remote; it was verified behaviourally,
  not by reading a local ingress file.

### 2.2 Scheduler

- Source and logs show a **one-shot** job: register repeat schedules in Redis,
  print “done”, exit 0. The long “exit” (22 hours at inspection) was normal completion, not a crashed
  daemon.
- Changing it to `always` would create an endless re-registration loop. The
  minimal correct policy is `restart: on-failure:5`: clean exit stays exited; a
  registration failure retries.
- Re-running registration is idempotent: exactly **13** repeat definitions and
  **0** duplicates after the recreate. The jobs package passed 19/19 tests,
  including the “no shadow repeat definitions” contract.
- One worker executes each repeat job once per timestamp; there is no second
  consumer. Notification inserts are retry-safe via a unique
  `(tenant, source_job_id, user)` index and `onConflictDoNothing`.
- A disposable container from the same image verified `on-failure:2` produces
  three runs then stops. The probe was removed.

### 2.3 Quality gates

| Gate           | Result | Cause                                                                   |
| -------------- | ------ | ----------------------------------------------------------------------- |
| format:check   | PASS   | —                                                                       |
| lint           | PASS   | —                                                                       |
| typecheck      | PASS   | —                                                                       |
| test           | FAIL   | Pre-existing uncommitted `Dockerfile` secret-mount change               |
| deadcode:check | FAIL   | Pre-existing untracked `.tmp-*` scratch files + root `@playwright/test` |
| build          | PASS   | —                                                                       |

`pnpm test --continue` gives the authoritative result: **24/25 tasks pass**.
`@beaconhs/web` has 1 failing test / 2032 passing / 8 skipped; the failing test
is `deployment-version-skew-contract.test.ts`, which expects the HEAD Dockerfile
secret mount that the user's uncommitted working-tree change replaced with a
placeholder. `@beaconhs/object-store-backup` passes 139/38 skipped; its earlier
`ELIFECYCLE` was collateral from turbo aborting the first run after the web
failure. No repository code was changed in Phase CR, so no gate regression is
attributable to this phase.

The repository is **not CI-green** while those pre-existing worktree items
remain. They were not “fixed” by deleting untracked work or reverting user
changes.

### 2.4 Drill stack

- Separate Compose project, network, volumes and database; no port collision; no
  observed domain traffic.
- It is **not idle**: the drill worker runs the 13 scheduled ticks and fails
  upload reconciliation about once a minute (45 errors in 15 minutes) because
  its database lacks `attachment_upload_reservations.multipart_upload_id`.
- The `beaconhs:drill-20261018-202804` tag now points at the Phase CQ image
  (`60dc4841…`), so the tag no longer identifies the build.
- The drill web shares the phase-aj public `APP_URL`/`BETTER_AUTH_URL`; its
  `R2_ENDPOINT=http://127.0.0.1:3002` has no listener. Repointing the tunnel
  would silently serve a different DB under the same domain.
- A separate unmanaged `beaconhs-drill-registry` container runs on the default
  bridge with a drill-prefixed volume.
- Nothing was stopped, removed or pruned. The exact reversible `stop` command
  and impact are in `phase-6u-b3-cr-drill-stack-inventory.md`; it is **not
  executed**.

### 2.5 PDF preview

- Document upload limit is **1 GiB**; pending uploads **25/user**; no preview
  byte cap; a **10 s** load watchdog; lazy page rendering; `task.destroy()` on
  timeout and unmount.
- All valid fixtures are structurally valid (`pdfinfo`; local pdf.js parses
  256 MiB in **87 ms**). Server upload of the 256 MiB file succeeds.
- Real browser results: **1, 16 and 32 MiB render** (1.8 s, 3.8 s, 5.8 s);
  **64 MiB and 256 MiB fail at ~10.3 s** with “Could not load the PDF”; the
  damaged-xref 64 MiB also fails at 10.3 s. Process RSS stayed ~0.73–0.85 GB and
  no renderer was killed.
- CDP traces show the cause: pdf.js issues a **full-body GET** first (16 MiB:
  16,781,512 bytes in 3.07 s; 64 MiB aborted at 9.46 s; 256 MiB aborted at
  9.49 s), while direct full download of 64 MiB measured **113.87 s at
  ≈ 0.59 MB/s**. The fixed 10 s deadline is therefore a download-time cap, not a
  parse or memory limit.
- Recommended, not implemented: return `sizeBytes` with the capability URL and
  show an explicit oversize/download message above a measured threshold; do not
  simply raise the watchdog without structural validation; investigate why
  pdf.js is not range-only. No limit was changed.
- The BQ test comment claiming an ~80 s renderer kill is stale; the 10 s
  watchdog now aborts the load and the renderer survives. Flagged for a
  follow-up doc/comment fix.

### 2.6 SSH

- Access recovered; ping 4/4, TCP 22 open, publickey login succeeds.
- sshd has not restarted since 2026-10-16 (`NRestarts=0`); no auth entries
  before 05:36:54; no kernel OOM/hung-task lines; `sar` shows ~98% idle and
  5.58 GB available through 05:30.
- A Docker build at 05:39 drove memory to 73.5% and load to 3.42, but that is
  **after** recovery and is not the cause.
- Root cause: **UNKNOWN**. The symptom is consistent with a transient
  transport/sshd-accept stall, but there is no direct evidence. Do not record it
  as resolved.

## 3. Changes made

### Remote test host

- Backed up `/home/ceshi/beaconhs-phase-cd/compose.yaml` to
  `compose.yaml.bak-cr`.
- Changed only the scheduler block:
  `restart: "no"` → `restart: on-failure:5`.
- Recreated the scheduler with `--no-deps`; it registered 13 schedules and exited
  0 with the current image.
- Created and removed one disposable `cr-restart-probe` container to verify
  retry semantics.
- No `.env`, SSH key, auth config or unused-stack resource was modified, stopped
  or deleted.

### Repository

- Added seven reports:
  - `docs/phase-6u-b3-cr-deployment-identity.md`
  - `docs/phase-6u-b3-cr-scheduler-reliability.md`
  - `docs/phase-6u-b3-cr-quality-gates.md`
  - `docs/phase-6u-b3-cr-drill-stack-inventory.md`
  - `docs/phase-6u-b3-cr-pdf-preview.md`
  - `docs/phase-6u-b3-cr-ssh-review.md`
  - `docs/phase-6u-b3-cr-final-report.md`
- No repository application, schema, test or config code was edited.
- No `git add`, commit or push. `HEAD` is unchanged at `51a899b7`.
- Before/after tracked state: **119 modified, 0 staged, 608 untracked files**
  (`-uall`; 301 untracked directory entries in the default summary), plus the
  seven new untracked docs. No pre-existing change was reverted or overwritten.

## 4. Verification checklist for the reviewer

1. **Stack identity:** open the domain, confirm the workspace switcher shows the
   Phase BB/Phase AJ tenants; `docker inspect beaconhs-phase-aj-web-1` shows
   `com.docker.compose.project=beaconhs-phase-aj` and image `60dc4841…`.
2. **Scheduler:** `docker inspect beaconhs-phase-aj-scheduler-1` shows
   `Status=exited`, `ExitCode=0`, `Restart=on-failure:5`, image `60dc4841…`;
   `docker logs` ends with “Repeat schedules are persisted in Redis — exiting.”
3. **Repeat schedules:** `redis-cli zcard bull:scheduled:repeat` → `13`; the
   member list has no duplicates; `docker logs` shows one execution per tick
   timestamp.
4. **Gates:** `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`
   exit 0; `pnpm test --continue` exits 1 only on the pre-existing Dockerfile
   test; `pnpm deadcode:check` exits 1 only on the pre-existing `.tmp-*` files
   and root `@playwright/test`.
5. **Drill stack:** `docker ps -a | grep beaconhs-drill-20261009` still shows all
   containers; no volume/image/network was deleted. Confirm the worker’s
   `multipart_upload_id` error loop is documented, not “fixed”.
6. **PDF:** upload a 1/16/32 MiB valid PDF and confirm a canvas renders; upload
   a 64 MiB valid PDF and confirm the 10 s “Could not load the PDF” message
   without a tab crash; download the 64/256 MiB file to confirm bytes.
7. **SSH:** `ssh beaconhs-drill 'hostname; uptime'` works; `systemctl show ssh`
   still shows `NRestarts=0`; `sar` shows no pressure before 05:30.
8. **Worktree:** `git log -1` is `51a899b7`; `git status` still shows the 119
   modified and pre-existing untracked files; no new tracked modifications from
   CR.

## 5. Remaining risks and work

1. **Two pre-existing gate failures** keep CI red: the uncommitted `Dockerfile`
   secret-mount change and the uncommitted root `@playwright/test` plus `.tmp-*`
   scratch scripts. Resolve them at the source (restore the secret mount, remove
   or ignore the scratch files, decide the Playwright dependency); do not delete
   user work blindly.
2. **Drill stack** remains running and erroring, with the same public `APP_URL`
   and a misleading image tag. Stopping it requires explicit owner approval;
   the reversible command is in the drill report. Do not `down -v` or prune.
3. **Scheduler resilience** is bounded to five retries and is unmonitored. A
   Redis flush removes schedules until the scheduler is re-run. Add monitoring
   and a runbook (or an idempotent worker-start re-registration) before relying
   on it in production.
4. **PDF preview** is capped by download time, not bytes. The next change should
   be a measured preflight/oversize message and a range-only investigation, not a
   blind increase of the 10 s watchdog.
5. **SSH root cause** is unknown. Capture `ssh -vvv`, `journalctl`, `sar` and
   `ss` at the next occurrence; do not reboot or restart sshd first.
6. **Stale documentation:** the BQ test comment about an ~80 s renderer kill is
   inaccurate and should be updated when the preview work is done.
7. **Storage-init image** is stale (exited). A full `docker compose up -d` will
   align it; no runtime impact today.

## 6. Honest limitations

- The tunnel ingress configuration was not read directly (token-managed, no
  dashboard access); identity was proven behaviourally.
- The SSH timeout’s exact start time is not in a local log; the post-recovery
  `sar`/journal samples are the best available evidence, not a recording of the
  incident.
- The duplicate-notification check is structural (unique index +
  `onConflictDoNothing`) plus a short window; it is not a long-running delivery
  audit.
- The PDF probe used six documents in the isolated test tenant and left them in
  MinIO (~433 MiB); no production data was touched.
- The two pre-existing gate failures were reported, not repaired,
  because the brief forbids reverting or deleting the user’s uncommitted work.
