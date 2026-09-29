---
name: Project Architecture
description: Navigate the BeaconHS monorepo and find the right existing primitive before building anything. Use when a task touches an unfamiliar area, when deciding where new code belongs, or before proposing a new module, table, or package.
---

# Project Architecture

Answers one question: **where does this already exist, and which primitive am I
required to reuse?** Load this before proposing any new module, table, package,
or service.

## When to use

- A task names a BeaconHS area you have not read yet.
- You are about to add a table, a native module, a package, or a route.
- You are deciding between the form Builder and a native module.
- A review asks "does this duplicate something that already exists?"

## What to read first

Read the target area before writing anything. Never guess a layout.

| Question | Where to look |
|---|---|
| Repo layout, CI gates, conventions | `AGENTS.md` (authoritative) |
| Capability inventory | `docs/beaconhs-capability-matrix.md` |
| Reuse points and limits | `docs/beaconhs-extension-points.md` |
| HSE gap analysis | `docs/hse-gap-analysis.md` |
| HSE decisions and plan | `docs/hse-development-baseline.md` |
| Current project state | `docs/project-development-state.md` |

Then confirm against **current code**, because the docs can lag:

```sh
# Does a table already exist for this concept?
grep -rn "pgTable('" packages/db/src/schema/ | grep -i "<concept>"

# Does a permission already gate this?
grep -n "<prefix>\." packages/db/src/schema/iam.ts

# Is this route or nav entry already present?
grep -n "<concept>" apps/web/src/lib/nav/registry.ts
ls apps/web/src/app/\(app\)/<module>/
```

## The reuse decision

Before adding anything, classify it. See `hse-domain` for the HSE-specific
version of this test.

1. **Does a Builder form solve it?** The form engine has 46 field types, 6 flow
   triggers and 13 flow actions (`packages/forms-core`). If yes, no native code.
2. **Does an existing native module solve it?** Extend it. Check the module
   exists in `apps/web/src/lib/module-admin/registry.ts`.
3. **Does an existing package primitive solve it?** Reuse it. Check
   `packages/compliance`, `packages/reports`, `packages/events`, `packages/jobs`,
   `packages/storage`, `packages/forms-core`.
4. **Only if all three fail**, propose a native module — and state why Builder
   and existing modules are insufficient.

## Hard invariants

- **Never re-create** `User`, `Tenant`, `Organization`, `Project`, `Permission`
  or `Storage`. They all exist. Extending is always allowed; replacing is not.
- Projects are `org_units` with `level = 'project'`
  (`packages/db/src/schema/org.ts:24`). There is no `projects` table.
- Tenant-scoped data must be read through `ctx.db(...)` from
  `requireRequestContext()` / `getRequestContext()` so Postgres RLS applies.
- New tenant tables must be added to `TENANT_SCOPED_TABLES`
  (`packages/db/src/rls.ts`) or `packages/db/src/rls.test.ts` fails.
- Use schema helpers in `packages/db/src/schema/_helpers.ts` for IDs,
  timestamps, soft deletes and tenant FKs.

## Forbidden

- Do not add a second gate store. `flow_gates` is explicitly "the single gate
  store" (`packages/db/src/schema/forms.ts:617-678`).
- Do not add a second compliance engine, report engine, notification bus or
  object-storage client. Each is already unified in a package.
- Do not add an ad hoc SQL layer next to Drizzle outside migrations, RLS
  policies, and queries Drizzle cannot express cleanly.
- Do not edit `packages/db/src/rls.ts` to make a failing policy pass without a
  corresponding migration.

## Completion criteria

You have named, with `path:line` evidence:

- the existing primitive you reused, or
- a written justification for why no existing primitive fits, and

- the module/table/route your change lands in, and
- the manual article in `apps/web/src/lib/manual/content/*` that must stay in
  sync (`AGENTS.md` rule 7).
