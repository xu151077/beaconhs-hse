# Phase 6U-B3-CR — Quality gates

Date: 2026-10-19
Repository: `/home/test/projects/beaconhs-hse`
Host: 16 vCPU, 15 GiB RAM, Linux
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

Status: **4 of 6 gates PASS. `test` and `deadcode:check` FAIL for pre-existing
working-tree reasons, not for Phase CR changes. No Phase CR code was changed in
the repository, so no new gate failure was introduced.**

## 1. Commands and exit codes

| Gate             | Command                | Exit | Result | Notes                                                     |
| ---------------- | ---------------------- | ---- | ------ | --------------------------------------------------------- |
| Format           | `pnpm format:check`    | 0    | PASS   | Prettier: all matched files use the code style            |
| Lint             | `pnpm lint`            | 0    | PASS   | `turbo run lint`; only `@beaconhs/web` has a lint script  |
| Typecheck        | `pnpm typecheck`       | 0    | PASS   | 27 turbo tasks                                            |
| Test             | `pnpm test --continue` | 1    | FAIL   | 24/25 tasks pass; `@beaconhs/web#test` has 1 failing test |
| Dead code        | `pnpm deadcode:check`  | 1    | FAIL   | 35 unused files + one unused root devDependency           |
| Production build | `pnpm build`           | 0    | PASS   | 4 tasks; Next.js production build completed               |

Logs:

- `/tmp/opencode/phase-cr/format.log`
- `/tmp/opencode/phase-cr/lint.log`
- `/tmp/opencode/phase-cr/typecheck.log`
- `/tmp/opencode/phase-cr/test.log` (first run)
- `/tmp/opencode/phase-cr/test-continue.log` (authoritative full run)
- `/tmp/opencode/phase-cr/test-object-store-backup.log` (isolated rerun)
- `/tmp/opencode/phase-cr/deadcode.log`
- `/tmp/opencode/phase-cr/build.log`

## 2. Passing gates

### Format

```
$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!
EXIT=0
```

The Phase CR reports were formatted with the repository's Prettier and the check
was re-run after they were added (see §6).

### Lint

```
$ pnpm lint
@beaconhs/web:lint: eslint .
 Tasks:    1 successful, 1 total
EXIT=0
```

### Typecheck

```
$ pnpm typecheck
 Tasks:    27 successful, 27 total
EXIT=0
```

### Production build

```
$ pnpm build
 Tasks:    4 successful, 4 total
 Time:     34.5s
EXIT=0
```

The Next.js production build completed; there was no build-time OOM on this
host. The Phase CQ note about a 3.4 GiB host does not apply to the current
15 GiB workspace host.

## 3. Test failure (pre-existing)

Authoritative run:

```
$ pnpm test --continue
 Tasks:    24 successful, 25 total
 Time:     4m22.999s
Failed:    @beaconhs/web#test
EXIT=1
```

`@beaconhs/web` summary:

```
Test Files  1 failed | 236 passed | 2 skipped (239)
     Tests  1 failed | 2032 passed | 8 skipped (2041)
```

Failing test:

```
FAIL src/lib/deployment-version-skew-contract.test.ts
  > self-hosted Next.js version-skew protection
  > uses one protected Server Action encryption key across dev builds
```

The test reads the repository `Dockerfile` and expects:

```
--mount=type=secret,id=next_server_actions_key,required=true
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_server_actions_key)"
```

The **uncommitted working-tree** `Dockerfile` replaces that with a placeholder:

```diff
-RUN --mount=type=secret,id=next_server_actions_key,required=true \
-    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_server_actions_key)" \
+RUN NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="placeholder-key" \
```

`Dockerfile` is one of the 119 pre-existing modified files. Phase CR did not
edit it. The test is therefore failing against the user's uncommitted working-tree
change; it is **pre-existing, not a CR regression**.

### Object-store-backup was not a real failure

The first `pnpm test` run reported an `ELIFECYCLE` for
`@beaconhs/object-store-backup` after `@beaconhs/web` failed. Running it alone and
in the `--continue` run proves it passes:

```
Test Files  10 passed | 3 skipped (13)
     Tests  139 passed | 38 skipped (177)
```

The first-run `ELIFECYCLE` was collateral from turbo shutting the run down after
the web failure. The **authoritative** result is `--continue`: 24/25 tasks pass,
only web fails.

## 4. Dead-code failure (pre-existing)

```
$ pnpm deadcode:check
Unused files (35)
.tmp-cf/404-investigate.mjs
.tmp-cf/collabora-e2e.mjs
...
.tmp-cj/collabora-debug.mjs
...
.tmp-ck/collabora-debug.mjs
.tmp-e2e/debug-upload.mjs
.tmp-e2e/run-pdf-e2e.mjs
Unused devDependencies (1)
@playwright/test
EXIT=1
```

- The 35 files are untracked `/.tmp-cf`, `/.tmp-cj`, `/.tmp-ck` and `/.tmp-e2e`
  scratch scripts already present in the working tree.
- `@playwright/test` is an uncommitted addition to the root `package.json`
  (`git diff package.json` shows `+ "@playwright/test": "^1.64.1"`); knip sees no
  root consumer.

Neither item was added by Phase CR. Deleting untracked user scratch work or
reverting the uncommitted dependency is explicitly forbidden by the brief, so
the failure is reported, not “fixed” by deletion.

## 5. Side effects and working-tree preservation

- The test and build commands do not run migrations, deploy, seed, prune or
  modify tracked source. Package tests use mocks, local temporary directories
  and ephemeral S3 test servers.
- `git status` before and after the gates: **119 modified tracked files, 0
  staged, 608 untracked files** (`-uall`; 301 untracked directory entries in the
  default summary). `HEAD` remained `51a899b7`.
- The only new files are the seven `docs/phase-6u-b3-cr-*.md` reports, which are
  untracked. No pre-existing modification was reverted or overwritten.
- No commit, push or `git add` was performed.

## 6. Post-report re-verification

After the seven reports were written:

```
$ pnpm format:check
All matched files use Prettier code style!
EXIT=0
$ git log --oneline -1
51a899b7 fix(db): synchronize seeded reference counters
$ git status --porcelain=v1 -uall | awk '$1!="??"{print $2}' | wc -l
119
```

The seven reports increase the untracked file count by 7 and change no tracked
file.

## 7. Attribution summary

| Failure                                    | Introduced by CR? | Cause                                                           |
| ------------------------------------------ | ----------------- | --------------------------------------------------------------- |
| `deployment-version-skew-contract`         | No                | Pre-existing uncommitted `Dockerfile` placeholder change        |
| `knip` unused files                        | No                | Pre-existing untracked `.tmp-*` scratch scripts                 |
| `knip` unused devDependency                | No                | Pre-existing uncommitted root `package.json` `@playwright/test` |
| `object-store-backup` first-run ELIFECYCLE | No                | Collateral turbo shutdown; passes in isolation and `--continue` |
| Format/lint/typecheck/build                | No                | All pass                                                        |

## 8. Status summary

| Gate             | Result | Attribution                                                |
| ---------------- | ------ | ---------------------------------------------------------- |
| format:check     | PASS   | —                                                          |
| lint             | PASS   | —                                                          |
| typecheck        | PASS   | —                                                          |
| test             | FAIL   | Pre-existing Dockerfile                                    |
| deadcode:check   | FAIL   | Pre-existing scratch/dep                                   |
| build            | PASS   | —                                                          |
| Overall CI-ready | **NO** | Red until the pre-existing working-tree items are resolved |

Phase CR itself adds no code and no gate regression. The repository cannot be
declared CI-green while the user's uncommitted `Dockerfile` and root
`package.json`/scratch files remain in their current state.
