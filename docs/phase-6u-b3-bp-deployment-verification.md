# Phase 6U-B3 / BP — Deployment Verification

- **Date:** 2026-10-17
- **Environment:** `https://beaconhs-test.xuhaoqing.top` (isolated BeaconHS test
  service only)
- **Final deployed image:** `beaconhs:phase-bp-20261017-111136`
- **Final image ID:** `sha256:8d0e44b998bb3f126a1c717ae6e480510a2341a7299fbf803ba7678b1e40951b`
- **Previous image (retained for rollback):** `beaconhs:phase-bl-20261017-000000`
  (`58985bf9d603`)
- **No commit, no push, no destructive git** was performed. The shared C2 drill
  and production services were not touched.

This document verifies that the **uncommitted working-tree fix for D-BO-1** was
built and deployed to the isolated test service, that downloads are correct over
real HTTPS, and that the storage-freeze refusals observed in the browser are
correct. Two builds were required; both are recorded, because the second one
fixed a defect the first one shipped (D-BP-2).

---

## 1. Provenance of the deployed code

The deployed images are **not** HEAD builds. They were built from a sync of the
local working tree (all uncommitted work), because the D-BO-1 fix and the Storage
Freeze implementation exist only there.

| Item                         | Value                                                               |
| ---------------------------- | ------------------------------------------------------------------- |
| Git HEAD                     | `51a899b7aac0a942da327222a3eed355fca9798a`                          |
| Working-tree fingerprint     | `d17f0656ac68269f243985f1cd0103f70ceba7c7e51dbd0ba7819d3a44926326`  |
| Trees entries (modified/new) | 305                                                                 |
| Sync method                  | `rsync -a` (no `--delete`) local → `/home/ceshi/beaconhs-phase-aj/` |
| Build host                   | `ceshi@10.10.31.30`, build tree `/home/ceshi/beaconhs-phase-aj/`    |
| Build arg                    | `DEPLOYMENT_VERSION=51a899b7aac0a942da327222a3eed355fca9798a`       |

> The working-tree fingerprint is a sha256 over `git diff HEAD` plus the sha256 of
> every untracked, non-ignored file. It identifies the exact code inside the image
> even though no commit was made.

**The deployment carried the whole working tree, not only the fixes in scope.**
This is the established precedent from phases BK/BL, but it means the running
image also contains every other uncommitted change present locally.

### 1.1 The two BP builds

| #   | Tag                                 | Image ID       | Created (host time)        | What it carried                                     |
| --- | ----------------------------------- | -------------- | -------------------------- | --------------------------------------------------- |
| 1   | `beaconhs:phase-bp-20261017-101904` | `a39c78d0bc4b` | 2026-10-17 10:33:44 +08:00 | D-BO-1 fix (first BP build)                         |
| 2   | `beaconhs:phase-bp-20261017-111136` | `8d0e44b998bb` | 2026-10-17 11:11:36 +08:00 | Build 1 **plus** the D-BP-2 worker storage-gate fix |

Build 2 was not a planned build. While verifying the freeze (Task B) the worker
log was inspected and revealed that the deployed worker had **never registered
the storage freeze gate**, so every worker-side storage operation was failing
closed — see `docs/phase-6u-b3-bp-defect-register.md` D-BP-2. The fix (pass the
statically imported `@beaconhs/storage` module at both worker call sites, as the
web app already does) was applied, the six gates re-run, and the image rebuilt
and redeployed. Both tags remain on the host; build 1 was **not** deleted and no
tag was overwritten.

Files material to this phase:

| File                                                                           | Status    | Role                                                    |
| ------------------------------------------------------------------------------ | --------- | ------------------------------------------------------- |
| `apps/web/src/lib/content-disposition.ts`                                      | untracked | RFC 5987/6266 helper (D-BO-1 fix)                       |
| `apps/web/src/lib/content-disposition.test.ts`                                 | untracked | unit test for the helper                                |
| `apps/web/src/app/(app)/documents/[id]/master/route.ts`                        | modified  | now uses the shared helper                              |
| `apps/web/src/app/(app)/documents/[id]/versions/[versionId]/download/route.ts` | modified  | now uses the shared helper                              |
| `packages/db/src/storage-freeze-operations.ts`                                 | untracked | freeze state machine + gate bootstrap                   |
| `packages/db/src/storage-write-arms-operations.ts`                             | untracked | write arms + drain verification                         |
| `packages/storage/src/freeze-gate.ts`                                          | untracked | storage write gate                                      |
| `apps/web/src/lib/wopi-storage-refusal.ts` (+ `.test.ts`)                      | untracked | WOPI refusal → HTTP mapping                             |
| `apps/web/src/instrumentation.ts`                                              | modified  | registers the freeze reader at web boot                 |
| `apps/worker/src/index.ts`                                                     | modified  | registers the freeze reader at worker boot (D-BP-2 fix) |
| `apps/worker/src/storage-init.ts`                                              | modified  | same, for the storage-init job (D-BP-2 fix)             |
| `apps/worker/src/lib/storage-gate-bootstrap.test.ts`                           | untracked | regression guard for the above                          |

## 2. Server-Action key (`next_server_actions_key`) — source and use

Requested explicitly; recorded without exposing the value.

- **Source:** BuildKit `--secret id=next_server_actions_key,src=$HOME/.drill-secrets/action_key`
  on the build host (`ceshi@10.10.31.30`). The file is **never** copied into the
  build context, the image, the repo, or this report.
- **Use:** `Dockerfile` line 39–45 consumes it only for the build:

  ```
  RUN --mount=type=secret,id=next_server_actions_key,required=true \
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_server_actions_key)" \
      pnpm turbo run build --filter=@beaconhs/web --filter=@beaconhs/worker ...
  ```

  i.e. a **stable** Server-Action encryption key so an action rendered
  immediately before a rollout can be decrypted by the replacement instance.

- **Not an environment variable.** The Dockerfile comment states it explicitly:
  BuildKit mounts the key only for that `RUN`; it is **not** persisted as an
  image environment variable. No `NEXT_SERVER_ACTIONS_KEY` reference exists in
  `apps/web/next.config.ts` or `apps/web/src/instrumentation.ts`.

## 3. Deployment mechanics (isolated test service only)

1. Backup of the live compose: `phase-aj-compose-final.yaml.bp-backup`
   (created once with `cp -n`, so it still holds the pre-BP `phase-bl` state).
2. Repointed **only** the four BeaconHS application services:

   | Service        | Image before                 | Image (final)                       |
   | -------------- | ---------------------------- | ----------------------------------- |
   | `web`          | `beaconhs:phase-bl-…-000000` | `beaconhs:phase-bp-20261017-111136` |
   | `worker`       | `beaconhs:phase-bl-…-000000` | `beaconhs:phase-bp-20261017-111136` |
   | `scheduler`    | `beaconhs:phase-bl-…-000000` | `beaconhs:phase-bp-20261017-111136` |
   | `storage-init` | `beaconhs:phase-bl-…-000000` | `beaconhs:phase-bp-20261017-111136` |

   Postgres, Redis, MinIO, Mailpit and Collabora containers were **not**
   re-imaged; they only restarted as compose dependencies.

3. `docker compose --project-name beaconhs-phase-aj -f phase-aj-compose-final.yaml up -d`
   (`UP-EXIT=0`).
4. Verified container images with `docker inspect`:

   ```
   web       beaconhs:phase-bp-20261017-111136  sha256:8d0e44b998bb3f126a1c717ae6e480510a2341a7299fbf803ba7678b1e40951b
   worker    beaconhs:phase-bp-20261017-111136  sha256:8d0e44b998bb3f126a1c717ae6e480510a2341a7299fbf803ba7678b1e40951b
   scheduler beaconhs:phase-bp-20261017-111136  sha256:8d0e44b998bb3f126a1c717ae6e480510a2341a7299fbf803ba7678b1e40951b
   ```

## 4. Health after deploy

```
GET https://beaconhs-test.xuhaoqing.top/api/health/ready
{"status":"ready","version":"51a899b7aac0a942da327222a3eed355fca9798a"}
```

`version` is the `DEPLOYMENT_VERSION` build arg (= HEAD sha) and therefore does
**not** identify the working-tree changes; the **image ID** does. `/login`
returned `200`.

## 5. D-BO-1 verification — real HTTPS download

Regression suite: `apps/web/e2e/phase-bo-e2e.spec.ts` (Playwright, real HTTPS to
the test URL, Better-Auth session from `/tmp/beaconhs-e2e-auth.json`).

| State                               | `Content-Disposition`                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| **Before** (`phase-bl`, HEAD code)  | `attachment; filename="_.docx"` — no `filename*`, name destroyed                            |
| **After** (`phase-bp`, both builds) | `attachment; filename="_.docx"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3.docx` |

Raw header captured from the running service on the final image:

```
[Scenario B] raw Content-Disposition: attachment; filename="_.docx"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3.docx
```

Verified on the deployed image (assertions in Scenario B):

| Check                                                                 | Result  |
| --------------------------------------------------------------------- | ------- |
| `filename*` present and `decodeURIComponent(...) === '测试文档.docx'` | ✅ PASS |
| Whole header is printable ASCII (`/^[\x20-\x7E]+$/`)                  | ✅ PASS |
| Plain `filename=` param present, ends `.docx`, no `"`/`\`/CR/LF       | ✅ PASS |
| Downloaded bytes = uploaded bytes (20 622)                            | ✅ PASS |
| Downloaded SHA-256 = uploaded SHA-256 (`d86b84b4…`)                   | ✅ PASS |
| Browser-saved name = `测试文档.docx`                                  | ✅ PASS |

Plain source file names are unchanged in both parameters
(`report.pdf` → `filename="report.pdf"; filename*=UTF-8''report.pdf`).

**Suite result: 4 executed · 4 passed · 0 failed · 0 skipped** on the final image
(Scenario A Collabora edit/save, Scenario B integrity+filename, 24/24 module
render, anonymous-access guard). The same suite passed 4/4 on build 1.

Unit coverage for the helper: `apps/web/src/lib/content-disposition.test.ts`,
**7 passed** (ASCII name, Chinese name + ASCII fallback + full-ASCII header,
quote/backslash/CR-LF neutralisation, RFC 5987 `'()*!` encoding, all-non-ASCII
fallback, empty name, surrounding whitespace).

## 6. Storage Freeze deployment prerequisite

The freeze implementation was previously **blocked** because no web surface
drove a transition. These builds ship the gate (reader registered at web boot in
`apps/web/src/instrumentation.ts`, and — after D-BP-2 — at worker boot in
`apps/worker/src/index.ts`) so the refusal behaviour is observable in a real
browser and correct in the worker. The state machine itself is still driven by a
**test-only driver** against the isolated tenant; there is deliberately no
production operation entry point. See
`docs/phase-6u-b3-bp-storage-freeze-report.md`.

## 7. Quality gates (each exit code captured individually)

Run on the **final** (post-D-BP-2) working tree:

| Gate      | Command               | Exit  |
| --------- | --------------------- | ----- |
| Format    | `pnpm format:check`   | **0** |
| Typecheck | `pnpm typecheck`      | **0** |
| Lint      | `pnpm lint`           | **0** |
| Test      | `pnpm test`           | **0** |
| Dead code | `pnpm deadcode:check` | **0** |
| Build     | `pnpm build`          | **0** |

`@beaconhs/web` unit tests: **2022 passed, 8 skipped**. `@beaconhs/worker`:
**104 passed** (28 files, including the new bootstrap guard). `@beaconhs/db`:
**501 passed, 41 skipped**. The skips are database-gated scenarios the harness
itself reports as _skipped, not passed_ (`SEED_TEST_SCRATCH_DATABASE_URL` unset).
No gate was disabled, skipped, or suppressed. The same six gates passed on
build 1's tree.

## 8. Rollback

Previous images are still present in the build host's Docker daemon and the
prior compose is backed up:

1. `sed -i -E 's#image: beaconhs:[^ ]+#image: beaconhs:phase-bl-20261017-000000#g' phase-aj-compose-final.yaml`
   (or restore `phase-aj-compose-final.yaml.bp-backup`).
2. `docker compose --project-name beaconhs-phase-aj -f phase-aj-compose-final.yaml up -d`.
3. Re-check `/api/health/ready`.

Rollback to build 1 (`beaconhs:phase-bp-20261017-101904`, `a39c78d0bc4b`) is also
possible with the same procedure. No old image tag was ever overwritten; every
prior tag (`phase-bl`, `phase-bk`, `phase-ap-an`, `phase-o-6u-b3-o`,
`phase-bp-20261017-101904`, `drill-20261009`) remains intact.

## 9. Not verified / remaining risk

- The image contains the **entire** uncommitted working tree; changes unrelated
  to D-BO-1 and D-BP-2 were deployed as a side effect of that choice.
- `DEPLOYMENT_VERSION` equals the HEAD sha and does not distinguish the
  working-tree code; use the image ID / fingerprint above for identity.
- Only the isolated test service was deployed; no production deployment was
  performed.
- Build 2 fixed a defect that build 1 shipped (D-BP-2). The general lesson —
  a bundled-runtime bootstrap that fails silently can pass a green deploy — is
  recorded in the defect register rather than papered over.
