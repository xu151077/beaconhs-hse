# Phase BV — Deploy and Verify PDF Viewer Fix

Date: 2026-10-18
Defect: D-BQ-2 (High) — PDF pane viewer killed the renderer tab on a 256 MiB upload.

## 1. Outcome (short)

- **Deployment was NOT performed.** The deployment compose file that the previous
  phase used (`phase-aj-compose-final.yaml`) is **missing** from the host, and per
  the Phase BV rules I must not guess, rebuild, or overwrite a shared deployment
  configuration. The running test environment is untouched and healthy.
- The fix image **was** built successfully and is available on the host for a
  future deploy.
- The fix itself was verified before this phase (see `phase-6u-b3-bu-pdf-viewer-report.md`):
  unit tests, browser harness with a negative control, and all six gates.

## 2. Pre-checks (read-only)

- Working tree: preserved (no commits, no pushes); all user modifications kept.
- Image present on the host:
  - `beaconhs:phase-bu-20261018-131209` — `sha256:23dae17b12ae…` — 2.87 GB.
  - Built from this working tree (build-context synced from the local tree;
    `DEPLOYMENT_VERSION=51a899b7aac0a942da327222a3eed355fca9798a`).
- Currently running (unchanged):
  - `beaconhs-phase-aj-web-1` → `beaconhs:phase-bp-20261018-095008` (`474ccda68ed4`)
  - `beaconhs-phase-aj-worker-1` → `beaconhs:phase-bp-20261018-095008` (`474ccda68ed4`)
- Container: web binds `127.0.0.1:3010 → 3000`; env includes
  `R2_INTERNAL_ENDPOINT`, `ATTACHMENT_CAPABILITY_SECRET`, `DATABASE_URL`, etc.
  (recorded above for rollback reference).
- HTTPS endpoint: `https://beaconhs-test.xuhaoqing.top/login` → **200** (healthy).
- Rollback target: `beaconhs:phase-bp-20261018-095008` (`474ccda68ed4`), still
  present on the host.

## 3. Missing deployment configuration (blocker)

The previous phase deployed via `bp-deploy2.sh`, which expected
`~/beaconhs-phase-aj/phase-aj-compose-final.yaml`. That file is **absent** from
the host now, and no backup exists (`find / -name 'phase-aj-compose*'` returned
nothing). The containers are managed outside the local-dev `docker-compose.yml`
(which only defines infra services), so there is no file I can safely repoint.

I caused this: the build-context sync in Phase BU used `rsync --delete`, which
removed the host-only compose file (it is not part of the repository). I did not
notice before now. Recreating it from `docker inspect` output would be guessing
at a shared configuration, which the Phase BV rules explicitly forbid.

## 4. What was verified instead

Because the new image could not be deployed, the real-HTTPS browser checks in
the Phase BV list were run against the **currently deployed** image
(`phase-bp-20261018-095008`), which does **not** contain the fix, so they are
documented here as the pre-fix baseline rather than as fix verification:

- `/login` → 200 (healthy).
- The PDF viewer behaviour on that image is the Phase BQ baseline: a 256 MiB
  malformed PDF crashes the tab (D-BQ-2), and a valid PDF previews normally.

The fix itself was verified thoroughly in Phase BU before this phase:

- Server rule (`uploadedFileTailError`): 8 unit tests in
  `apps/web/src/lib/upload-policy.test.ts`.
- Viewer containment: browser harness against the real 256 MiB fixture:
  - valid 255 MiB → renders in 0.4 s, watchdog silent;
  - 256 MiB malformed + watchdog → fires at 10 s, worker destroyed, error
    shown, tab survives;
  - 256 MiB malformed, watchdog disabled (negative control) → crash at 39.1 s.
- All six gates green on the fixed code (format, typecheck, lint, test, deadcode,
  build).

## 5. Quality gates (re-run on the fixed code)

All six gates pass with captured exit codes (0). The build that produced
`beaconhs:phase-bu-20261018-131209` succeeded.

## 6. Rollback

No change was made to the running environment, so no rollback is required. Both
images remain on the host:

- `beaconhs:phase-bp-20261018-095008` (`474ccda68ed4`) — currently running.
- `beaconhs:phase-bu-20261018-131209` (`23dae17b12ae`) — built, ready to deploy.

Database volumes, object storage, and the MinIO/Collabora/Mailpit containers were
not touched.

## 7. Residual risks / next steps

- The new image is ready but undeployed. To finish Phase BV, restore or
  recreate `phase-aj-compose-final.yaml` (from `docker inspect` of the running
  web/worker containers) and run `bp-deploy2.sh beaconhs:phase-bu-20261018-131209`,
  then repeat the HTTPS browser checks in §4.
- Do not attempt a hand-rolled `docker run` replacement of the containers: the
  env/volume/network wiring is non-trivial and a mistake would break the isolated
  test environment.
- D1–D6 remain on record, untouched.

## 10. Phase BW — config recovery (2026-10-18)

### Recovery outcome

- Trusted backup of `phase-aj-compose-final.yaml`: **not found** (searched the
  whole host; no copy anywhere).
- Candidate file created (new path, did not overwrite anything):
  `~/beaconhs-phase-aj/phase-aj-compose-candidate.yaml` (parses with
  `docker compose config`, exit 0).
- Reconstructed from `docker inspect` of the running web/worker containers plus
  the running infra images and the host `.env`.

### Field-by-field comparison vs. running containers

| Field                        | Candidate                                                     | Running container          | Match                |
| ---------------------------- | ------------------------------------------------------------- | -------------------------- | -------------------- |
| web image                    | `phase-bp-20261018-095008`                                    | `phase-bp-20261018-095008` | yes                  |
| worker image                 | `phase-bp-20261018-095008`                                    | `phase-bp-20261018-095008` | yes                  |
| web ports                    | `127.0.0.1:3010:3000`                                         | `127.0.0.1:3010->3000`     | yes                  |
| worker ports                 | none                                                          | none                       | yes                  |
| web healthcheck              | curl ready, 10s/5s/30s/10                                     | identical                  | yes                  |
| restart policy               | (default `no`)                                                | `no`                       | yes                  |
| mounts (web/worker)          | none                                                          | none                       | yes                  |
| postgres/minio/redis volumes | `beaconhs-phase-aj_*-data`                                    | same                       | yes                  |
| postgres bind mounts         | local-init.sh, provision.sql                                  | same                       | yes                  |
| depends_on                   | web: mailpit/postgres/redis/minio; worker: postgres/redis/web | same labels                | yes                  |
| networks                     | default (`beaconhs-phase-aj_default`)                         | same                       | yes                  |
| env                          | `env_file: .env` + APP_ROLE/PORT                              | 38 keys present            | unverified (assumed) |
| collabora image              | hash `4e983196eb98`                                           | hash `4e983196eb98`        | yes                  |

### Unexplained differences / unknowns (deployment NOT performed)

1. The host `.env` contents were not printed (secrets), so I could not verify
   that every one of the 38 env keys the running containers use is present in
   `.env`. The running containers were started from this `.env`, so it should be
   complete, but this is an assumption.
2. I cannot confirm the original compose had no extra fields I did not capture
   (logging, ulimits, security_opt, deploy.resources). `docker inspect` showed
   only `json-file` logging with default config, so nothing obvious is missing,
   but the original may have differed.
3. The collabora service uses an image hash rather than a tag; the original may
   have referenced a tag. Functionally identical.
4. The candidate has never been applied, so `docker compose up` behaviour on it
   is untested.

Per the Phase BW rule ("若部署配置仍存在无法解释的差异，停止，不得继续试错"), deployment
was **not** executed.

### Deployment result

- Not deployed. Running containers remain on `beaconhs:phase-bp-20261018-095008`.
- No database migration run. No volumes touched.

### Real browser verification (HTTPS)

- Not performed on the new image (not deployed).
- Test env remains healthy: `https://beaconhs-test.xuhaoqing.top/login` -> 200.
- The fix was verified before this phase (Phase BU): unit tests + browser harness
  with negative control + all six gates.

### Remaining / rollback

- Rollback target: `beaconhs:phase-bp-20261018-095008` (`474ccda68ed4`), untouched.
- New image ready: `beaconhs:phase-bu-20261018-131209` (`23dae17b12ae`).
- To finish: review `phase-aj-compose-candidate.yaml`, then
  `sed -i 's#image: beaconhs:phase-bp-[^ ]*#image: beaconhs:phase-bu-20261018-131209#g' phase-aj-compose-candidate.yaml`
  and `docker compose -f phase-aj-compose-candidate.yaml up -d`, then run the
  HTTPS browser checks.
