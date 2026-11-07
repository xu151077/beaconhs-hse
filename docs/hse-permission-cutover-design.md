# Permission Cutover — Design

> ## 中文摘要
>
> **设计结论：不新增任何机制。Phase 1.5 的权限切换 = 执行一次 `pnpm db:migrate`。**
>
> - `convergeRolePermissions`（`migrate.ts:161-222`）已经完整实现「剔除失效 key → 重置 tenant_admin → 并集下发内置基线」，且由 `db:migrate` 在 `:537` 调用。它是幂等的、数据层面的正确机制，**PRESERVE**。
> - 因此本次切换的**唯一动作**是运行 `pnpm db:migrate`；**不新建 migration、不新建命令、不改 seed**（均判定为 NEW — rejected）。
> - 本设计额外提出两项 **NEW** 的低风险补强（都不在 Phase 1.5 实施范围内，仅记录）：
>   1. `convergeRolePermissions` 的**参数化测试** —— 目前 0 覆盖，回归是静默的。
>   2. 内置角色**并集单向棘轮**的书面说明 —— 管理员手工删除的权限会被每次 migrate 恢复。
> - 自定义角色安全由 `is_built_in = true` 保证（`:189`、`:211`），并集不会覆盖它们；仅有意的「剔除下架 key」例外。
> - fresh install 与 upgrade 最终状态一致，这是本设计依赖的核心性质。
>
> 本文档只做设计，不修改任何代码、migration、seed、数据库或 RLS。

---

## 1. Design position

The analysis established that the required mechanism **already exists and is
already on the migration path**. The correct design is therefore a _zero-code_
design: specify the operation, its ordering, its verification, and its rollback,
and decline to add a second mechanism.

Anything added here would be a parallel system for the same job, which
`AGENTS.md` non-negotiable rule 5 and rule 6 forbid.

## 2. The cutover operation

```
pnpm db:migrate
```

Single command. No flags, no arguments, no environment branch.

It performs, in pipeline order (`packages/db/src/migrate.ts:518-543`):

| Step | Function                      | Effect on `roles.permissions`                           |
| ---- | ----------------------------- | ------------------------------------------------------- |
| 1    | `migrate()`                   | none (schema only)                                      |
| 2    | `verifyMigrationTracker`      | none                                                    |
| 3    | `applyRlsPolicies`            | none                                                    |
| 4    | `applyRuntimeGrants`          | none                                                    |
| 5    | `assertKioskPinHashes`        | none (fails fast on unhashed PINs)                      |
| 6    | **`convergeRolePermissions`** | **prune → pin tenant_admin → union built-in baselines** |
| 7    | `applyPlannerStatistics`      | none                                                    |
| 8    | `applyReportingViews`         | none                                                    |

Steps 1-5 and 7-8 are unchanged by this work. Only step 6 is relevant, and it is
a single transaction (`migrate.ts:164`).

### 2.1 Why a separate command is rejected

`convergeRolePermissions` already satisfies every property an ad-hoc
`db:sync-roles` would need:

- **Idempotent** — the `tenant_admin` update is guarded by
  `permissions <> catalogue` (`:190`); the union by
  `exists(baseline key not present)` (`:212-216`); both are set-semantics.
- **Atomic** — all three operations are in one `db.transaction` (`:164`).
- **Ordered** — prune runs before the union, so a key removed from the catalogue
  cannot be re-added by a stale baseline.
- **On the standard path** — deploys already run `db:migrate`; a second command
  would be a step people forget.

A second command would also create a **second writer** of the same column. Two
writers with different ordering guarantees is how permission drift becomes
unknowable.

## 3. Change classification

| #   | Item                                                           | Class                 | Rationale                                                                                                                  |
| --- | -------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `convergeRolePermissions`                                      | **PRESERVE**          | Already the correct mechanism; correct ordering; idempotent                                                                |
| 2   | Prune-before-union ordering                                    | **PRESERVE**          | Prevents a retired key being re-added by a stale baseline                                                                  |
| 3   | `is_built_in` gates (`:189`, `:211`)                           | **PRESERVE**          | The only thing protecting custom roles                                                                                     |
| 4   | `tenant_admin` pinned to the full catalogue                    | **PRESERVE**          | Already matches `_actions.ts:672`'s runtime pin; keeps the two in agreement                                                |
| 5   | Additive union as a baseline floor                             | **PRESERVE**          | Clean-cutover stance; see §5 for the documented cost                                                                       |
| 6   | Fresh-install / upgrade convergence property                   | **PRESERVE**          | Both paths end at the same state                                                                                           |
| 7   | New Drizzle migration for the two PPE keys                     | **NEW — rejected**    | Schema migration cannot express a per-tenant data baseline; would be recorded as applied forever and could never run again |
| 8   | New `db:sync-roles` script                                     | **NEW — rejected**    | Duplicates step 6; second writer of the same column                                                                        |
| 9   | Edit to `seed.ts` roles insert                                 | **NEW — rejected**    | Seed is the fresh-install path and is already correct; the early return at `:118-121` is its re-run guard                  |
| 10  | Parity test for `convergeRolePermissions`                      | **NEW — recommended** | Zero coverage today; regressions are silent                                                                                |
| 11  | `QUICKSTART.md`: run `db:migrate` after a `BUILTIN_ROLES` edit | **ADAPT**             | The one real process gap this work exposed                                                                                 |
| 12  | `AGENTS.md` known-defects: union ratchet                       | **ADAPT**             | Undocumented behaviour that changes what an admin can durably configure                                                    |
| 13  | `docs/project-development-state.md`                            | **ADAPT**             | Close the G.2 item with the corrected finding                                                                              |

## 4. Custom-role safety properties to preserve

Any future change to `convergeRolePermissions` must keep these four invariants.
They are the design's contract, not incidental behaviour.

1. **No baseline into a custom role.** Every write is gated `is_built_in = true`.
2. **No silent collapse of a custom role.** The union never runs against
   `is_built_in = false`.
3. **Retirement still applies to custom roles.** The prune deliberately has no
   `is_built_in` filter, so a key removed from the catalogue is stripped from
   custom roles too (`migrate.ts:166-168`). This is intended; changing it would
   leave retired capabilities alive as inert authorization data.
4. **Key uniqueness prevents impersonation of a built-in.** `roles_tenant_key_ux`
   on `(tenantId, key)` (`iam.ts:35`) means a tenant cannot have a custom role
   whose `key` collides with a built-in one, so the `where "key" = ${key}` in the
   union loop can never hit a custom row.

## 5. Accepted cost: the union ratchet

The union at `migrate.ts:196-207` only adds. Combined with
`admin/roles/_actions.ts:674` (an admin may edit a built-in role's permissions),
this produces an asymmetry:

| Admin action on a built-in role | Survives `db:migrate`?                                                            |
| ------------------------------- | --------------------------------------------------------------------------------- |
| **Add** a permission            | Yes — the union is additive and the prune only removes keys outside the catalogue |
| **Remove** a permission         | **No** — the code baseline re-adds it on the next `db:migrate`                    |

This is coherent with clean-cutover rules (the shipped baseline is a floor, and
the platform has not launched), but it is undocumented and materially changes
what a tenant admin can durably configure. It must be written down rather than
discovered later.

**This is a product decision, not a defect.** Options are listed in the analysis
(§11). Nothing in Phase 1.5 should decide it.

## 6. Verification design

Verification must be non-destructive and must not require a second database.

### 6.1 Pre-cutover (read-only)

Assert the current divergence, so the run is provably a no-op when it is not
needed:

```sql
select key, is_built_in, jsonb_array_length(permissions)
from roles where is_built_in order by key;
-- expect foreman 35, worker 22, safety_manager 63, tenant_admin 91
```

### 6.2 The cutover

```
pnpm db:migrate
```

Expected console line (`migrate.ts:221`): `✔ Built-in role permissions backfilled`.

### 6.3 Post-cutover (read-only)

```
foreman        36   gains ppe.read.all
worker         23   gains ppe.read.self
safety_manager 63   unchanged
tenant_admin   93   full catalogue
```

Plus the custom-role invariant: a custom role's permission set must be **exactly**
what it was before, modulo keys that are no longer in the catalogue.

### 6.4 Second run (idempotence proof)

Run `pnpm db:migrate` again and re-assert §6.3. Every count must be identical.
This is the check that proves the mechanism is safe to re-run on every deploy,
which is the entire reason to prefer it over a migration.

### 6.5 Behavioural confirmation

`ppe.read.self` on `worker` is the load-bearing change. It should be observable
as: a `worker` role holder sees the PPE nav entry and their own gear only. This
was already verified at runtime in the Phase 1.5 pass (nav present, own item
visible, other holders' items denied) — but against a database whose role rows
had been aligned by hand. §6.3 replaces that manual alignment with the real
mechanism, after which the same check should be repeated once.

## 7. Rollback design

| Scenario                           | Action                                                                                            | Mechanism                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Bad `BUILTIN_ROLES` edit           | Revert `iam.ts`, re-run `db:migrate`                                                              | Prune (`:169-182`) strips the now-unknown keys from every role; `tenant_admin` re-pinned (`:184-191`); the shorter union cannot re-add |
| Convergence itself corrupts a role | Restore `roles.permissions` from a pre-run `SELECT … to jsonb` snapshot, then re-run `db:migrate` | The snapshot is taken in §6.1                                                                                                          |
| Migration fails mid-pipeline       | Nothing to undo                                                                                   | Step 6 is a single transaction (`migrate.ts:164`); failure rolls back the whole convergence                                            |

**Precondition for any rollback: take a `roles` snapshot first.** The convergence
writes no ledger row, so there is no `db:rollback` for it — the only recovery
path is a restore plus a re-run. This is the practical reason §6.1 is mandatory
rather than optional.

Recommended snapshot:

```sql
select tenant_id, key, is_built_in, permissions
from roles
order by tenant_id, key;
```

## 8. What this design deliberately does not do

- No `projects` table, no `project_id`, no Project Scope.
- No RLS change. Role convergence is a data step, not a policy step.
- No change to `PERMISSION_CATALOGUE` semantics, `can()`, or `readTierCovers`.
- No change to `seed.ts`, and no change to the seed's early-return guard.
- No change to the admin role editor.
- No `osha_300_log` semantics.
