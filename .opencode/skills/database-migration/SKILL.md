---
name: Database Migration
description: Safe schema change workflow for BeaconHS — design, generate, verify, and validate a Drizzle migration without data loss. Use for any schema change, new table, index, column, enum, or RLS policy.
---

# Database Migration

A migration is the highest-risk edit in this repository. It runs against real
tenant data and cannot be undone by `git revert`.

## When to use

- Any change under `packages/db/src/schema/`.
- Any new table, column, index, enum value, or constraint.
- Any change to `packages/db/src/rls.ts`.
- Before running `db:generate`, `db:push`, or `db:migrate`.

## Mandatory order

Never reorder these. Each step gates the next.

### 1. Inspect the schema first

```sh
grep -rn "pgTable('<table>'" packages/db/src/schema/
grep -n "<table>" packages/db/src/rls.ts
```

Confirm the table exists, its tenant FK style, and whether it is in
`TENANT_SCOPED_TABLES`.

### 2. Inspect migration history

```sh
ls -1 packages/db/drizzle/ | tail -20
docker compose --profile local-db exec postgres \
  psql -U beaconhs_super -d beaconhs -c "\dt" | head -40
```

Know what is already applied. 41 migrations are applied on the current
baseline. Never assume a migration is unapplied because you cannot see it.

### 3. Design before generating

Write down, in the response:

- **Forward-only or destructive?** Dropping/renaming a column that holds data
  requires explicit user approval before you generate anything.
- **Backfill needed?** A new `NOT NULL` column on a populated table needs a
  default or a staged backfill, not a bare `NOT NULL`.
- **RLS entry?** A new table with `tenant_id` **must** be added to
  `TENANT_SCOPED_TABLES`.
- **Index plan?** State the query this index serves.
- **Rollback?** If there is none, say so explicitly.

### 4. Generate

```sh
pnpm db:generate     # drizzle-kit generate -> writes SQL to packages/db/drizzle/
```

Then **read the generated SQL**. Drizzle's output is a starting point, not a
finished migration.

### 5. Harden the SQL

- Prefer idempotent SQL (`IF NOT EXISTS`, `IF EXISTS`) to match the existing
  migration style.
- Add a `COMMENT` or a short SQL comment for anything non-obvious.
- Never write `DROP TABLE` / `DROP COLUMN` without approval.
- Watch for lock-heavy statements on large tables.

### 6. Register RLS

Add the table name to `TENANT_SCOPED_TABLES` in `packages/db/src/rls.ts`.
`packages/db/src/rls.test.ts` asserts exact coverage — a missing entry **fails
the test suite**, which is intended.

### 7. Apply and verify

```sh
pnpm db:migrate
```

Then prove it worked:

```sh
docker compose --profile local-db exec postgres \
  psql -U beaconhs_super -d beaconhs -c "\d+ <table>"
docker compose --profile local-db exec postgres \
  psql -U beaconhs_super -d beaconhs \
  -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relforcerowsecurity;"
```

RLS count must equal `TENANT_SCOPED_TABLES` length.

## Schema conventions

- Use helpers from `packages/db/src/schema/_helpers.ts`: IDs, `timestamps`,
  `softDelete`, tenant FKs, typed JSON.
- Every tenant table needs `tenant_id`.
- Re-export new tables from `packages/db/src/schema/index.ts`.
- Declare a Drizzle `relations` block for new tables.

## Forbidden

- **Never** run `drizzle-kit drop`, `drizzle-kit push --force`, `prisma migrate
  reset`, or hand-written `DROP`/`TRUNCATE` without explicit user approval.
  Project permissions also deny these.
- Never edit an already-applied migration. Add a new one.
- Never bypass RLS to "make it work". Fix the context, schema, or policy.
- Never add `SECURITY DEFINER` without an explicit review — it is an RLS escape
  hatch.
- Never run `db:push` against anything but a scratch database. It is a
  development shortcut, not a migration.
- Never combine a schema change with an unrelated cleanup in one migration.

## Completion criteria

- The generated SQL was read and is understood.
- `TENANT_SCOPED_TABLES` updated if a tenant table was added.
- `pnpm db:migrate` applied cleanly and the resulting shape was verified.
- `pnpm --filter @beaconhs/db test` passes (includes the RLS coverage test).
- `pnpm --filter @beaconhs/db typecheck` passes.
- Destructive-ness, if any, was stated and approved before execution.
