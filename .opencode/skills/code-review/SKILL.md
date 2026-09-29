---
name: Code Review
description: Review a change or diff for correctness, regressions, security, performance, types, tests and architecture. Use before committing, before opening a PR, or when asked to review someone else's work.
---

# Code Review

Review a change against the repo's own rules. Findings only — a review does not
edit files unless you are asked to fix.

## When to use

- Before committing a change.
- Before opening or updating a pull request.
- When asked to review a diff, a file, or a subsystem.

## Method

```sh
git status --short          # what actually changed
git diff --stat             # scope
git diff                    # the change itself
```

Read the diff first, then open the surrounding code for context. A diff read in
isolation invents false findings.

## The seven passes

### 1. Correctness
- Does the code do what the change claims? Check the actual branch, not the
  happy path.
- Off-by-one, inverted conditions, wrong enum member, null vs undefined.
- Error paths: is the failure handled, or swallowed?
- Async: unawaited promises, missing error handling, race conditions.

### 2. Regression
- What existing behaviour does this change break?
- Any caller not updated? Search for every call site.
- Enum additions: is every exhaustive `switch` still exhaustive?
- Schema changes: does every query, view, or report column still line up?

### 3. Security
Defer to the `security-review` skill. At minimum check: permission enforced on
the **action** (not just the page), tenant id not trusted from input, no secret
or PII logged, no RLS bypass added.

### 4. Performance
- N+1 queries, especially inside a list render.
- Missing index on a new filter or join column.
- Unbounded list: `AGENTS.md` requires search, filters and pagination on every
  table of records.
- Large `jsonb` round-tripped whole.

### 5. Types
- `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` are on.
- Any `any`, non-null `!`, or cast that hides a real uncertainty?
- Prefer narrowing or a guard clause over `as`.

### 6. Tests
- Does the change have a test proportional to its risk?
- Would the test fail if the change were reverted?
- Schema/permission changes need a test that would catch a regression.

### 7. Architecture
Defer to `project-architecture` and `hse-domain`. At minimum:
- Does this duplicate an existing primitive?
- Does it create a second lifecycle, permission vocabulary, or store?
- Is module-specific logic in the right place, or does it belong in a package?

## Reporting

Order findings by severity. For each:

- **`path:line`**
- what is wrong
- why it matters (what breaks, or what an attacker gets)
- the minimal direction for a fix

Mark each finding:

- **blocker** — correctness, security, data loss, or a red CI gate
- **should fix** — real defect, not urgent
- **nit** — style or clarity

State explicitly when you found nothing in a pass. Silence is not evidence of a
clean review.

## Repo rules that are review blockers

- CI must be green: `pnpm format:check`, `typecheck`, `lint`, `test`,
  `deadcode:check`, `build`.
- Never make a gate pass by disabling it — no `eslint-disable`, no `ts-ignore`,
  no `--no-verify`.
- Every table of records ships search, filters and pagination.
- User-facing changes update the matching manual article in
  `apps/web/src/lib/manual/content/*` and, if a tour points at it,
  `apps/web/src/lib/walkthroughs/registry.ts`.
- New tenant tables are registered in `TENANT_SCOPED_TABLES`.
- No dead code, duplicate implementations, or unused exports.

## Forbidden

- Do not approve a change with an unaddressed blocker.
- Do not review only the happy path.
- Do not report a style preference as a defect.
- Do not fix while reviewing unless asked; mixing the two hides findings.
- Do not leave a known defect unmentioned just because it is pre-existing —
  label it pre-existing.

## Completion criteria

- The change's actual scope was read from git, not assumed.
- All seven passes were run.
- Every finding has `path:line`, impact and severity.
- Pre-existing defects are labelled as such.
- The review ends with an explicit verdict: block, fix-then-merge, or approve.
