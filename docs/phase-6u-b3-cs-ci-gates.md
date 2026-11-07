# Phase 6U-B3-CS — CI gates

Date: 2026-10-19
Repository: `/home/test/projects/beaconhs-hse`
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Host: local workspace (16 vCPU, 15 GiB RAM, Linux)

Status: **All six gates PASS on a fresh Phase CS run.** The two failures
recorded in Phase CR were fixed at their source: the Dockerfile Server Action
secret mount was restored without removing the uncommitted ops CLI targets, and
the dead-code scan now has a deliberately narrow scratch-directory ignore plus a
real root consumer for `@playwright/test`. No assertion was deleted, no security
check was weakened, and no scratch file or user dependency was removed.

## 1. Baseline

Before the Phase CS changes the worktree was already dirty:

| Item                      | Baseline                                                                  |
| ------------------------- | ------------------------------------------------------------------------- |
| Branch                    | `hse-platform`                                                            |
| HEAD                      | `51a899b7aac0a942da327222a3eed355fca9798a`                                |
| Tracked modified files    | 119                                                                       |
| Untracked files (`-uall`) | 615 (608 pre-existing + 7 Phase CR reports)                               |
| Staged files              | 0                                                                         |
| Remote test stack         | `beaconhs-phase-aj` on `10.10.31.30`                                      |
| Image                     | `sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370` |

The original failure evidence is preserved in
`/tmp/opencode/phase-cs/deadcode-before.log` and the Phase CR quality-gates
report. The Dockerfile failure was the direct consequence of this working-tree
replacement:

```diff
-RUN --mount=type=secret,id=next_server_actions_key,required=true \
-    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_server_actions_key)" \
+RUN NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="placeholder-key" \
```

## 2. B1 — deployment-version-skew-contract

### 2.1 Actual cause

The test is a real deployment contract, not a stale fixture. The uncommitted
working-tree `Dockerfile` had replaced BuildKit's required secret mount with a
hard-coded placeholder key. That would make Server Actions rendered by one image
undecryptable by the next image during a rollout. The same Dockerfile change also
added the `@beaconhs/ops-bootstrap-admin` and `@beaconhs/ops-migrate` build
targets; those are user work and were preserved.

The web, worker and scheduler all use one image and the same build. The deploy
workflow already supplies the key:

```yaml
secrets: |
  next_server_actions_key=${{ secrets.DEV_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY }}
```

The committed Dockerfile contract and the workflow are consistent; only the
working-tree placeholder was inconsistent.

### 2.2 Minimal fix

`Dockerfile` now keeps the ops filters but restores the protected build command:

```dockerfile
RUN --mount=type=secret,id=next_server_actions_key,required=true \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_server_actions_key)" \
    pnpm turbo run build --filter=@beaconhs/web --filter=@beaconhs/worker \
        --filter=@beaconhs/ops-bootstrap-admin --filter=@beaconhs/ops-migrate
```

A negative regression assertion was added to the existing contract test:

```ts
expect(dockerfile).not.toContain('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="placeholder-key"')
```

This prevents a future “make the local build work” placeholder from landing
without a failing test. The positive secret-mount assertions were not changed.

### 2.3 Verification

```text
$ pnpm --filter @beaconhs/web exec vitest run src/lib/deployment-version-skew-contract.test.ts
Test Files  1 passed (1)
     Tests  2 passed (2)
EXIT=0
```

The full web suite also passes (see §3). A real Docker image build with the
BuildKit secret was **not run** in this phase; it requires the image build/deploy
step and is listed as NOT RUN in the final report.

## 3. B2 — deadcode:check

### 3.1 Actual cause

The scan reported 35 unused files under `.tmp-cf`, `.tmp-cj`, `.tmp-ck` and
`.tmp-e2e`, plus the root `devDependencies` entry for `@playwright/test`.

- The `.tmp-*` directories are untracked operator scratch scripts from earlier
  live investigations. They are not shipped code and were not deleted.
- `@playwright/test` is declared in both the root and `apps/web`. The
  `apps/web` copy is used by `apps/web/e2e` and `apps/web/playwright.config.ts`.
  The root copy had no root consumer. Removing it was forbidden by the brief, so
  it was given a real root consumer instead.

### 3.2 Scoped fix

`knip.ts` now ignores only the repo-root scratch directories:

```ts
'.': {
  entry: ['deploy/collabora-branding.js', '.opencode/mcp/playwright-mcp-guard.mjs'],
  ignore: ['.tmp-*/**'],
}
```

The ignore is scoped to the root workspace and to `.tmp-*` directories only. It
does not cover `apps`, `packages`, `src`, or arbitrary `**/*` files.

The root `package.json` now has a real E2E entry point:

```json
"test:e2e": "playwright test --config apps/web/playwright.config.ts"
```

This makes the root `@playwright/test` dependency a genuine binary consumer.
`apps/web` still declares the same dependency and uses it in its Playwright
config. The E2E suite itself was not executed in this phase; it targets the
remote test environment and is not one of the six CI gates.

### 3.3 Automated verification

New test:
`apps/web/src/lib/deadcode-scope-contract.test.ts`

It asserts:

1. the root workspace ignore is exactly `['.tmp-*/**']`;
2. every ignore pattern starts with `.tmp-*/` (so a later edit cannot broaden
   it to production code);
3. `@playwright/test` is not hidden with `ignoreDependencies`;
4. the root `test:e2e` script, the `apps/web` dependency and the Playwright
   config import still exist, so the dependency remains genuinely used.

The test runs inside the normal web suite and passed in the full gate run.

### 3.4 Verification

```text
$ pnpm deadcode:check
EXIT=0
```

No `.tmp-*` file was deleted, no root dependency was removed, and no broad ignore
was introduced.

## 4. Fresh gate results

All commands were run from `/home/test/projects/beaconhs-hse` after the B1/B2
fixes.

| Gate             | Command                | Exit | Result | Log                                        |
| ---------------- | ---------------------- | ---: | ------ | ------------------------------------------ |
| Format           | `pnpm format:check`    |    0 | PASS   | `/tmp/opencode/phase-cs/format.log`        |
| Lint             | `pnpm lint`            |    0 | PASS   | `/tmp/opencode/phase-cs/lint.log`          |
| Typecheck        | `pnpm typecheck`       |    0 | PASS   | `/tmp/opencode/phase-cs/typecheck.log`     |
| Test             | `pnpm test --continue` |    0 | PASS   | `/tmp/opencode/phase-cs/test-continue.log` |
| Dead code        | `pnpm deadcode:check`  |    0 | PASS   | `/tmp/opencode/phase-cs/deadcode.log`      |
| Production build | `pnpm build`           |    0 | PASS   | `/tmp/opencode/phase-cs/build.log`         |

Test totals from the authoritative `--continue` run:

```text
Tasks:    25 successful, 25 total
@beaconhs/web: Test Files  238 passed | 2 skipped (240)
@beaconhs/web:      Tests  2035 passed | 8 skipped (2043)
```

The web total is two tests higher than Phase CR because the new dead-code scope
contract file adds two tests. The deployment contract file still has two tests;
the new negative assertion runs inside the existing second test.

## 5. New defects, fixed items and residuals

### New defects introduced by CS

None known. The gate run is green.

### Fixed items

- `deployment-version-skew-contract.test.ts` now passes against the working-tree
  Dockerfile, and the exact placeholder regression is covered.
- `pnpm deadcode:check` now passes with a documented, tested, root-only scratch
  ignore and a real root Playwright consumer.

### Pre-existing workspace issues preserved

- 119 tracked files were modified before CS; the worktree remains uncommitted.
- 35 `.tmp-*` scratch scripts remain on disk and are deliberately ignored only
  under `.tmp-*`.
- The root `@playwright/test` duplicate remains; it is now used by
  `test:e2e` rather than removed.
- The Dockerfile ops CLI targets remain; only the secret mount was restored.
- `deploy/local-production.compose.yaml` is untracked in this checkout and was
  restored unchanged after inspection; it still uses `restart: 'no'` for the
  scheduler. It is not part of the tracked change.

### Residual risks

1. **Docker image build not executed.** The contract test proves the secret
   mount is present, but a real BuildKit build with
   `--secret id=next_server_actions_key,src=...` was not run in Phase CS.
2. **Untracked drill build helpers do not pass the secret.**
   `scripts/build-drill-image.sh` and `scripts/deploy-drill-freeze-driver.sh`
   invoke `docker build` without `--secret`. They are untracked scratch helpers,
   not CI, but they will fail against the restored `required=true` mount if used.
3. **Root Playwright duplication.** The dependency is now used, but it is still
   declared in two manifests. A future cleanup can decide whether the root copy
   should remain.
4. **Ignore scope.** The `.tmp-*/**` ignore is intentionally narrow and tested;
   any new scratch directory must follow the same `.tmp-*` naming or be added
   explicitly with a justification.
5. **CI is green only for this dirty working tree.** No commit or push was made;
   the final report records the exact final worktree state.

## 6. Status summary

| Check                                       | Result  |
| ------------------------------------------- | ------- |
| B1 root cause identified                    | PASS    |
| B1 minimal Dockerfile fix                   | PASS    |
| B1 regression assertion added               | PASS    |
| B2 root cause identified                    | PASS    |
| B2 scoped ignore / real dependency consumer | PASS    |
| B2 automated scope verification             | PASS    |
| All six gates on a fresh run                | PASS    |
| Docker image build with BuildKit secret     | NOT RUN |
| E2E suite execution                         | NOT RUN |
