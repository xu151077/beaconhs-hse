# Phase EA-1 — Remote branch check, authorised push, CI acceptance

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Step 1 — local and remote state — PASS

| Check                 | Expected                                   | Actual                                                                                                    | Result               |
| --------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------- |
| Branch                | `hse-platform`                             | `hse-platform`                                                                                            | PASS                 |
| HEAD                  | `51a899b7aac0a942da327222a3eed355fca9798a` | `51a899b7aac0a942da327222a3eed355fca9798a`                                                                | PASS                 |
| Remotes               | (any)                                      | `origin` → `github.com/xu151077/beaconhs-hse.git`; `upstream` → `github.com/braedonsaunders/beaconhs.git` | PASS (used `origin`) |
| Staged changes        | 0                                          | 0 (`git diff --cached --stat` empty)                                                                      | PASS                 |
| Tracked modified      | preserved                                  | 154                                                                                                       | PASS                 |
| Untracked             | preserved                                  | 455                                                                                                       | PASS                 |
| Recent log            | —                                          | `51a899b7` → `10b9528d` → `f94c30c4` → `8e70c757` → `7fc0f991`                                            | PASS                 |
| Remote `hse-platform` | —                                          | **does not exist** (`git ls-remote --heads origin hse-platform` empty)                                    | —                    |

`git branch -vv`: `* hse-platform 51a899b7` (no upstream tracking branch), `main 70da27c4
[upstream/main: behind 1]`.

## 2. Step 2 — CI configuration and push impact — PASS (no deploy would be triggered)

- `.github/workflows/ci.yml` triggers: `push` to `main`, `pull_request` to `main`,
  `workflow_dispatch`. Nothing else.
- `.github/workflows/ci.yml` job `deploy-dev` is gated by
  `if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'` **and** `needs: ci`,
  and the whole workflow only runs for `main`-branch push/PR events.
- `.github/workflows/deploy-dev.yml` is `workflow_call` only — it can only be invoked by
  `ci.yml` for a `main`-branch commit.
- `.github/workflows/security.yml` triggers on `main` only.
- No workflow file references `hse-platform` at all.

**Conclusion: pushing `hse-platform` triggers NO workflow — not CI, not the security scan, and
not any deployment.** This is a material finding for the plan: the authorised push alone does
not produce a CI run to accept.

### History divergence

- `origin/main` = `c96bb1ba` (not present on `hse-platform`).
- Merge base of `HEAD` and `origin/main` = `70da27c4`.
- `origin/main..HEAD` = 45 commits; `HEAD..origin/main` = 1 commit (`c96bb1ba fix(email): omit
empty attachments and scope auth logs`).
- The remote `hse-platform` branch does not exist, so the push is a branch creation with no
  possible non-fast-forward and no force-push requirement. No rebase, merge, or commit is needed
  or was performed.

## 3. Step 3 — preserve worktree and push existing branch — BLOCKED

All pre-push conditions were verified as satisfied:

1. No staged changes (`git diff --cached --name-only` → 0).
2. HEAD unchanged at `51a899b7aac0a942da327222a3eed355fca9798a`.
3. No new commit created.
4. No history divergence on the target (the branch does not exist remotely).
5. Push cannot trigger a deployment (see §2).

`git push origin hse-platform` was then attempted three times (plain command, no redirection)
and **each attempt was refused by the sandbox permission layer**:

```
{"error":{"type":"permission.rejected","message":"Permission denied: shell"}}
```

The command never reached the git process. Verified afterwards:

- `git ls-remote --heads origin hse-platform` → still empty (no remote branch created).
- `git rev-parse HEAD` → still `51a899b7aac0a942da327222a3eed355fca9798a`.
- `git status --short` → still 154 modified / 455 untracked / 0 staged.

No stash, reset, restore, clean, checkout, commit, or rebase was performed. The worktree is
untouched.

## 4. Step 4 — wait for and verify CI — NOT RUN

Blocked by §3. Additionally, `gh` is not installed on this workstation, so even after a
successful push the CI run would have to be observed through the GitHub web UI or an installed
CLI.

No CI run ID, job status, test count, or skip count can be reported for this commit. Nothing was
pushed, so there is nothing to observe.

## 5. Step 5 — final verification — PASS (nothing changed)

```
git branch --show-current  -> hse-platform
git rev-parse HEAD         -> 51a899b7aac0a942da327222a3eed355fca9798a
git status --short         -> 154 M, 455 ??, 0 staged
git diff --stat            -> 154 files changed, 5100 insertions(+), 1919 deletions(-)
git diff --cached --stat   -> (empty)
```

No new commit, no deploy job run, no access to production, `phase-aj`, or Drill.

## 6. Status

| Step                         | Status                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| 1. Local/remote state        | **PASS**                                                                                       |
| 2. CI config and push impact | **PASS** — push to `hse-platform` triggers nothing                                             |
| 3. Push                      | **BLOCKED** — sandbox permission layer refused `git push` (3 attempts, command never executed) |
| 4. CI verification           | **NOT RUN** — blocked by step 3                                                                |
| 5. Final verification        | **PASS**                                                                                       |

## 7. What is needed to proceed

1. **Permission for `git push`** to be granted in the shell allow-list, or the push to be
   performed by the operator directly:
   `git push origin hse-platform` from `/home/test/projects/beaconhs-hse`.
   Expected result: a new remote branch `hse-platform` at `51a899b7…`.

2. **After the push, a CI run will NOT start automatically**, because no workflow triggers on a
   `hse-platform` push. To run CI on this exact commit, one of the following is required:
   - open a pull request from `hse-platform` to `main` (triggers `ci.yml` + `security.yml`), **or**
   - run `workflow_dispatch` on `ci.yml` — which also needs the workflow file on `main` or on the
     target branch, **or**
   - temporarily push the branch as `main` (not recommended — that would arm the deploy path).

   A pull request is the only option that runs CI without arming the deploy job, because the
   `deploy-dev` job in `ci.yml` requires `github.event_name == 'push'` — a `pull_request` event
   runs the gate job only.

3. **Observation tooling**: `gh` is not installed. Either install it (with a token) or observe the
   run in the GitHub web UI. The four DB steps and the six gates listed in §4 of the task brief
   then need to be checked for 0 skips in the DB projects.

No code, workflow, configuration, or deployment was modified in this phase.
