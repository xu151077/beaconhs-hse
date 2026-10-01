---
name: Git Safety
description: Protect the working tree, untracked work and history from destructive git operations. Load before any command that could discard work, before branching, and whenever you are unsure whether a git command is reversible.
---

# Git Safety

This repository contains work that exists **only** in the working tree. Some
audit documents are untracked and have no Git copy. Losing them is losing them
permanently.

## The hard prohibitions

Never run these without the user explicitly authorising that exact command in
this conversation:

```
git reset --hard
git clean -fd  /  git clean -fdx
git restore
git checkout --
git rebase
git filter-branch
git reflog expire
git gc --prune=now
git branch -D
git push
```

Project permissions **deny** `git reset*`, `git clean*`, `git restore*`,
`git rebase*`, `git push*` and `git branch -D*`. Do not try to route around a
denial with an equivalent spelling. If a command is denied, report the denial —
do not look for a workaround.

## Before every git operation

```sh
git status --short        # what is modified, what is untracked
git stash list            # is someone's work parked?
```

Read the output. If it shows changes you did not make, **they belong to the
user**. Leave them alone.

## What must be protected

| Path                      | Why                                                                       |
| ------------------------- | ------------------------------------------------------------------------- |
| `.env`                    | live credentials; gitignored; never read or commit                        |
| `docker-compose.yml`      | verified byte-identical to `HEAD`; it is the official deployment baseline |
| `docs/**`                 | 14 audit documents, currently **untracked** — no Git copy exists          |
| `packages/db/drizzle/**`  | applied migrations; already applied to the live database                  |
| Any file you did not edit | it may be deliberate user work                                            |

If a broad edit risks touching any of these, do not perform the broad edit.

## Recovering from a mistake

Stop and say so immediately. Then:

1. `git status --short` and `git diff` to establish what actually changed.
2. Report precisely what was lost and what was not.
3. Do **not** attempt an automated recovery that itself runs a destructive
   command.

An honest early report is worth more than a silent partial fix.

## Branching and committing

- Work on `main` with small, atomic commits unless told otherwise.
- Stage **only** the files you intentionally edited. Never `git add -A` or
  `git add .` in a tree that contains user changes or untracked docs.
- Inspect `git status --short` immediately before committing, and confirm the
  staged list with `git diff --cached --stat`.
- Never commit `.env`, secrets, or credentials.
- Never push unless the user says so in this conversation.

## Checking history without changing it

These are safe and pre-allowed:

```sh
git status
git diff
git log --oneline -20
git show <ref>
git ls-files
git branch
git rev-parse HEAD
git blame <file>
```

`git log -p`, `git show <ref>:<path>` and `git cat-file` are read-only and safe.

To compare a file against `HEAD` without touching the working tree:

```sh
git diff HEAD -- docker-compose.yml
git show HEAD:docker-compose.yml | md5sum
```

## Forbidden

- Never use `git checkout -- .` or `git restore .` to "clean up" a messy tree.
- Never delete untracked files to make `git status` look tidy.
- Never reformat or stage files you did not edit, even if it would be "cleaner".
- Never amend or rebase a commit that is already on `main`.
- Never use `git stash` as a way to discard changes without telling the user.
- Never assume a file is recoverable because it is "probably in HEAD" — verify
  it is tracked: `git ls-files --error-unmatch <path>`.

## Completion criteria

- `git status --short` was inspected before and after any git operation.
- Every command run is one of the safe inspection commands, or was explicitly
  authorised.
- The staged set matches exactly the files you intended to change.
- No user change, untracked doc, `.env`, or compose file was touched.
