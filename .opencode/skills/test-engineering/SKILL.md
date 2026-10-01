---
name: Test Engineering
description: Decide what kind of test a change needs and write it. Use when adding tests, deciding test level, covering a new module or migration, or when a gate fails.
---

# Test Engineering

Picks the **cheapest test that would actually fail if the change broke**, then
writes it.

## When to use

- A change needs test coverage.
- You are unsure whether a change needs unit, integration, E2E, or database
  coverage.
- A gate fails and you need to decide whether to fix code or fix the test.
- Reviewing a change for missing coverage.

## What already exists

The repo uses **two** runners. Use the one already in the package.

| Runner                                   | Used by                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `vitest run`                             | most packages (db, compliance, reports, forms-core, events, storage, ui, …)         |
| `node --import tsx --test src/*.test.ts` | `packages/ai`, `packages/appkit-feedback`, `packages/integrations`, `packages/sync` |

```sh
pnpm test                                   # all packages
pnpm --filter @beaconhs/db test
pnpm --filter @beaconhs/forms-core test
```

There is **no Playwright in the repository** and no E2E test suite. Browser
verification is done through the `ui-e2e` skill, not a checked-in test.

## Choosing the level

Ask: _what is the smallest thing that could break without the test failing?_

| Level             | Use for                             | Example                                                             |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------- |
| **Unit**          | pure logic, a function's contract   | risk score derivation, expiry calculation                           |
| **Integration**   | a module against real collaborators | compliance evaluator against seeded rows; storage SDK against MinIO |
| **Database**      | schema, migrations, RLS, queries    | the RLS coverage test in `packages/db/src/rls.test.ts`              |
| **Permission**    | authorization decisions             | tier resolution, scope filtering, action guards                     |
| **E2E (browser)** | a user-visible workflow             | login → report incident → it appears → close                        |

Rules of thumb:

- A new tenant table → **database** test (RLS coverage) is mandatory; it exists
  and will fail if you forget `TENANT_SCOPED_TABLES`.
- A new permission key → **permission** test proving who can and cannot act.
- A new state machine → **unit** tests over every transition, including
  illegal ones.
- A migration → **database** test proving the shape after apply.
- A server action → **integration** test proving the mutation and the audit
  row.

## Writing a good test

- **Name the behaviour**, not the function: `it('blocks closing a corrective
action that requires verification')`, not `it('close')`.
- **Assert on the outcome** (row state, returned value, thrown error) — never on
  log output.
- **One reason to fail per test.** A test that asserts eight things reports one
  defect.
- **Cover the illegal transition.** State machines are where bugs hide.
- **Make it fail if the change is reverted.** Temporarily revert, confirm red,
  restore. A test that has never been red proves nothing.

## When a gate fails

Work in this order:

1. Is the **code** wrong? Fix the code.
2. Is the **test** wrong (asserting the old behaviour)? Fix the test, and say so.
3. Is the **environment** wrong (missing service, stale build)? Fix the
   environment, and say so.

**Never** delete, skip, or weaken a test to make a gate pass. That is a gate
defect, not a green pipeline.

## Forbidden

- No `skip`, `only`, or `.todo` in committed code to get past a failure.
- No snapshot-test sprawl — assert the specific field that matters.
- No test that requires a live external service when a fake is sufficient. Use
  the real service when the integration **is** the thing under test (storage,
  RLS).
- No sleeping to wait for async state. Await the condition.
- No test that mutates shared seed data without restoring it.

## Completion criteria

- The chosen level is justified by what could break.
- The test is named after a behaviour and asserts an outcome.
- The test was confirmed to fail when the change is reverted.
- The full suite passes: `pnpm test`.
- New coverage is proportionate to the risk of the change.
