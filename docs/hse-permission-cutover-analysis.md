# Permission Cutover — Analysis

> ## 中文摘要
>
> **结论：G.2 不是一个缺陷。BeaconHS 已经具备正确的权限下发机制，Phase 1.5 遗漏的只是「运行 `pnpm db:migrate`」这一步。**
>
> - `roles.permissions` 是 jsonb 物化副本（`packages/db/src/schema/iam.ts:31`）。这是**有意设计**：`/admin/roles` 允许租户在运行时调整角色，数据库才是运行时授权事实来源，代码里的 `BUILTIN_ROLES` 只是**基线下限**，不是实时权威。
> - 仓库**已经存在**内置角色权限收敛函数 `convergeRolePermissions`（`packages/db/src/migrate.ts:161-222`），并由 `pnpm db:migrate` 在 `migrate.ts:537` 调用。它做三件事：剔除目录外的失效 key、把 `tenant_admin` 重置为完整目录、对其余内置角色做**并集**下发。
> - 因此新增 `ppe.read.self` / `ppe.read.site` **不需要新 migration、不需要新命令、不需要改 seed**。正确动作就是执行一次 `pnpm db:migrate`。
> - 只读模拟已验证收敛结果：foreman 35→36（+`ppe.read.all`）、worker 22→23（+`ppe.read.self`）、safety_manager 63 不变、tenant_admin→93。（RUNTIME VERIFIED）
> - 自定义角色安全：所有写语句都带 `is_built_in = true` 条件（`:189`、`:211`），自定义角色只会按 clean-cutover 语义被剔除已下架 key，不会被基线覆盖。
> - **发现一个真实语义缺口**：`convergeRolePermissions` 对内置角色做**并集**，因此管理员手工**删除**的权限会在每次 migrate 时被静默恢复。这是「删除方向的单向棘轮」，必须在切换说明中写明。
> - **测试缺口**：`convergeRolePermissions` 没有任何测试覆盖（`packages/db/src/*.test.ts` 中 0 命中）。
>
> 本文档只做分析，不修改业务代码、migration、seed、数据库或 RLS。

---

## Scope

Phase 1.5 runtime verification raised two follow-ups. This document answers the
G.2 questions only. G.1 is analysed in
[`hse-ppe-picker-authorization-analysis.md`](./hse-ppe-picker-authorization-analysis.md).

Nothing in this phase modified business code, migrations, the database, the seed,
or RLS. The one database interaction was a **read-only** `SELECT` simulation
described in §7.

---

## 1. Why `roles.permissions` is a materialised copy

**STATIC VERIFIED** — `packages/db/src/schema/iam.ts:20-39`:

```
20: export const roles = pgTable(
21:   'roles',
       ...
27:     key: text('key').notNull(), // e.g. 'worker', 'foreman', custom slugs
30:     isBuiltIn: boolean('is_built_in').default(false).notNull(),
31:     permissions: jsonb('permissions').$type<PermissionKey[]>().default([]).notNull(),
       ...
35:     tenantKeyUx: uniqueIndex('roles_tenant_key_ux').on(t.tenantId, t.key),
```

The materialisation is **intentional, not an oversight**. Three independent facts
force it:

1. **Authorization is resolved per request from the row, never from code.**
   `RequestContext.permissions` is built from the tenant's `roles` rows, so the
   database is the runtime authority. A code-only design would make the role
   editor at `/admin/roles` non-functional.
2. **Tenants may retune their own roles at runtime.**
   `apps/web/src/app/(app)/admin/roles/_actions.ts:674` performs
   `update(roles).set({ permissions })` for **any** role, built-in or custom, and
   `:672` pins only `tenant_admin` to `ALL_PERMISSIONS`. A tenant admin can
   therefore legitimately hold a role whose live permission set differs from
   `BUILTIN_ROLES`.
3. **`BUILTIN_ROLES` is per-tenant data, not global config.**
   `roles` is tenant-scoped (`tenantId` FK, `iam.ts:24-26`) and the catalogue is
   copied per tenant at seed time
   (`packages/db/src/seed.ts:156-165`). Two tenants running the same build are
   _expected_ to diverge.

**Consequence:** `BUILTIN_ROLES` is a **baseline / floor**, not the live
authority. Any new permission must be _converged into_ the database; editing code
alone has no runtime effect.

## 2. Does builtin-role permission reconciliation already exist?

**Yes.** `STATIC VERIFIED` — `packages/db/src/migrate.ts:161-222`:

```ts
161: async function convergeRolePermissions(db: MigrationDatabase) {
162:   const fullCatalogueJson = JSON.stringify(PERMISSION_CATALOGUE)
164:   await db.transaction(async (transaction) => {
166:     // Clean cutover: remove retired/unknown keys from built-in and custom roles
169:     await tx.execute(sql`
170:       update "roles"
171:       set "permissions" = ( ... keys present in the catalogue ... )
177:       where exists ( ... any key NOT in the catalogue ... )
182:     `)
184:     await tx.execute(sql`
185:       update "roles"
186:       set "permissions" = ${fullCatalogueJson}::jsonb
188:       where "key" = 'tenant_admin'
189:         and "is_built_in" = true
190:         and "permissions" <> ${fullCatalogueJson}::jsonb
191:     `)
193:     for (const [key, def] of Object.entries(BUILTIN_ROLES)) {
194:       if (key === 'tenant_admin') continue
196:       await tx.execute(sql`
198:         set "permissions" = ( ... distinct(existing UNION baseline) ... )
210:         where "key" = ${key}
211:           and "is_built_in" = true
212:           and exists ( ... baseline key not already present ... )
217:       `)
218:     }
219:   })
221:   console.log('✔ Built-in role permissions backfilled')
222: }
```

Three distinct operations:

| #   | Lines   | Scope                                   | Operation                                                 |
| --- | ------- | --------------------------------------- | --------------------------------------------------------- |
| 1   | 169-182 | **ALL** roles (no `is_built_in` filter) | Prune any key not in the current catalogue                |
| 2   | 184-191 | `key='tenant_admin' AND is_built_in`    | **Replace** with the full catalogue                       |
| 3   | 193-218 | each other built-in, `is_built_in`      | **Additive union** of the code baseline into the live set |

And it is on the `db:migrate` path — `STATIC VERIFIED`
`packages/db/src/migrate.ts:518-543`, in this order:

```
518: await migrate(migrationDb, { migrationsFolder: MIGRATIONS_FOLDER })
521: console.log('▶ Applying RLS policies…')            applyRlsPolicies
525: console.log('▶ Applying least-privilege runtime grants…')  applyRuntimeGrants
534: await assertKioskPinHashes(maintenanceDb)
536: console.log('▶ Converging role permissions…')
537: await convergeRolePermissions(maintenanceDb)      <-- HERE
540: await applyPlannerStatistics(migrationDb)
543: await applyReportingViews(migrationDb)
```

> **Correction to the Phase 1.5 report.** That pass recorded G.2 as a "seed gap"
> because `pnpm db:seed` short-circuits at `packages/db/src/seed.ts:118-121` when
> the super-admin already exists. That observation is correct but the conclusion
> was wrong: the seed is a **fresh-install** path, and upgrades are handled by
> `convergeRolePermissions`. The real cause of the observed drift was simply that
> `db:migrate` had not been run after the `iam.ts` edit.

## 3. How an existing database receives `ppe.read.self` / `ppe.read.site`

**Run `pnpm db:migrate`.** No other step is required.

**RUNTIME VERIFIED** (read-only simulation; the exact set/union logic from
`migrate.ts:196-217`, applied to the pre-Phase-1.5 rows and the post-change
baselines — no `UPDATE` was executed):

```
foreman:        pre=35  converged=36  gained=ppe.read.all
worker:         pre=22  converged=23  gained=ppe.read.self
safety_manager: pre=63  converged=63  gained=(none)
tenant_admin:   replaced with the full catalogue = 93   (migrate.ts:184-191)
```

Exactly the two new keys propagate, and nothing else moves. `safety_manager`
already had `ppe.read.all`, so it is correctly untouched.

## 4. How custom roles are protected

**Protected.** Every mutating statement is gated on `is_built_in = true`:

- `migrate.ts:189` — `tenant_admin` replacement requires `is_built_in = true`
- `migrate.ts:211` — the baseline union requires `is_built_in = true`

Consequences:

- A custom role **never** receives a built-in baseline, even if it reuses a
  similar shape.
- Custom roles created at `admin/roles/_actions.ts:272` and `:724` set
  `isBuiltIn: false` explicitly, so they are structurally excluded.
- A key collision is impossible: `roles_tenant_key_ux` is unique on
  `(tenantId, key)` (`iam.ts:35`), so a tenant cannot have both a built-in
  `foreman` and a custom `foreman`.

**One deliberate exception.** The prune at `migrate.ts:169-182` has **no**
`is_built_in` filter, so custom roles _are_ touched — any permission key that has
been removed from `PERMISSION_CATALOGUE` is stripped from them too. This is the
documented clean-cutover intent (`:166-168`): a retired capability must not
survive as inert authorization data. Custom roles are protected from
**over-reach**, not from **retirement**.

## 5. Should this use a migration?

**No.** `PRESERVE` the existing mechanism.

Reasons:

1. A Drizzle SQL migration changes **schema**. A permission baseline is **data**,
   and the repo already has a data-convergence step in the same pipeline
   (`migrate.ts:533-537`).
2. A migration would be **duplicated logic**: two independent mechanisms writing
   `roles.permissions` would race, and the `verifyMigrationTracker` ledger
   (`migrate.ts:519`) records a migration as applied forever, so it could never
   be re-run for a later `BUILTIN_ROLES` change.
3. The repo's own precedent for permission changes is convergence, not migration —
   the function is already called on every `db:migrate`.

## 6. Should this use an idempotent reconciliation command?

**It already is one.** `convergeRolePermissions` _is_ the idempotent
reconciliation step, embedded in `db:migrate`. Do **not** add a second command.

Idempotence is structural, not incidental:

- `tenant_admin` is guarded by `and "permissions" <> ${fullCatalogueJson}::jsonb`
  (`:190`), so a no-op update does not even match a row.
- The union is guarded by `and exists ( ... baseline key not already present )`
  (`:212-216`).
- The operation is set-semantics (`select distinct` over `UNION`, `:200-207`), so
  re-running cannot duplicate keys.
- The prune only matches rows that actually contain an unknown key (`:177-181`).

**A gap worth closing (not part of this change):** nothing tests this function.
`STATIC VERIFIED` — no file in `packages/db/src/*.test.ts` references
`convergeRolePermissions` or asserts a built-in/converged parity invariant. A
regression here is silent: it would surface as "a role lost a permission" with no
failing gate.

## 7. Fresh install vs upgrade

|                                | Fresh install                                                                  | Upgrade                                   |
| ------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------- |
| Order                          | `db:migrate` then `db:seed` (`docs/QUICKSTART.md:35-36`)                       | `db:migrate`                              |
| `convergeRolePermissions` sees | **no tenants yet** → `roles` is empty → every statement matches 0 rows → no-op | populated `roles` → converges             |
| Where permissions come from    | `seed.ts:156-165` inserts `def.permissions` directly, already current          | `migrate.ts:169-218` converges to current |
| End state                      | identical                                                                      | identical                                 |

Both paths converge on the same state, which is the property that matters.

`seed.ts:157` performs a bare `insert(roles)` with **no** `onConflictDoNothing`.
That is safe only because the seed short-circuits at `:118-121` when the
super-admin already exists, so the roles insert is reachable exactly once per
database. `STATIC VERIFIED` — this is a real coupling: the seed's re-run
protection is the early return, not conflict handling on `roles`.

## 8. Rollback

**There is no down-migration for this data step, and none is needed.** The
ledger (`verifyMigrationTracker`, `migrate.ts:519`) tracks schema migrations;
`convergeRolePermissions` writes no ledger row, so there is nothing to roll back
in the usual sense.

Rollback is **"revert the code, then re-run the convergence"**:

1. Revert `packages/db/src/schema/iam.ts` (removes the two keys from
   `PERMISSION_CATALOGUE` and `BUILTIN_ROLES`).
2. Run `pnpm db:migrate`.
3. The prune at `migrate.ts:169-182` now finds `ppe.read.self` / `ppe.read.site`
   absent from the catalogue and strips them from **every** role, built-in and
   custom, in one transaction.
4. `tenant_admin` is re-pinned to the shortened catalogue (`:184-191`).
5. The union loop re-adds the reverted (shorter) baselines — which cannot remove
   anything, so the prune in step 3 is what actually performs the rollback.

**Residual risk — the one-way ratchet.** The union at `migrate.ts:196-207` only
ever _adds_. An administrator who deliberately **removed** a permission from a
built-in role (possible via `admin/roles/_actions.ts:674`, which permits editing
built-in roles other than `tenant_admin`) will see that permission **restored on
every subsequent `db:migrate`**. Additions to a built-in role survive; removals
do not. This is a deliberate clean-cutover stance — the code baseline is treated
as a floor — but it is undocumented and must be stated in the cutover runbook,
because it changes what a tenant admin can durably configure.

## 9. Evidence ledger

| Claim                                                                                 | Label            | Source                                                                |
| ------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `roles.permissions` is jsonb, tenant-scoped, unique on `(tenantId,key)`               | STATIC VERIFIED  | `packages/db/src/schema/iam.ts:20-39`                                 |
| Seed inserts built-in roles once with a permission snapshot                           | STATIC VERIFIED  | `packages/db/src/seed.ts:156-165`                                     |
| Seed short-circuits on existing super-admin                                           | STATIC VERIFIED  | `packages/db/src/seed.ts:118-121`                                     |
| An admin can edit a built-in role's permissions                                       | STATIC VERIFIED  | `admin/roles/_actions.ts:671-674`                                     |
| `convergeRolePermissions` prunes / replaces / unions                                  | STATIC VERIFIED  | `packages/db/src/migrate.ts:161-222`                                  |
| `db:migrate` invokes it                                                               | STATIC VERIFIED  | `packages/db/src/migrate.ts:536-537`                                  |
| `canAny` in the picker route is tier-aware                                            | STATIC VERIFIED  | `api/picker-options/route.ts:198-199`                                 |
| Convergence would yield 36 / 23 / 63 / 93                                             | RUNTIME VERIFIED | read-only `SELECT` simulation, §3                                     |
| Live DB currently holds 36 / 23 / 63 / 93 (manually aligned by the Phase 1.5 fixture) | RUNTIME VERIFIED | `select key, is_built_in, jsonb_array_length(permissions) from roles` |
| `convergeRolePermissions` has no test                                                 | STATIC VERIFIED  | no match in `packages/db/src/*.test.ts`                               |
| Running `db:migrate` actually converges this database                                 | **UNVERIFIED**   | forbidden in this phase ("不修改 database")                           |

## 10. Classification

| Capability                                                                       | Verdict                                                           |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `convergeRolePermissions` as the permission cutover mechanism                    | **PRESERVE**                                                      |
| Prune-then-add ordering in the same transaction                                  | **PRESERVE**                                                      |
| `tenant_admin` pinned to the full catalogue                                      | **PRESERVE**                                                      |
| Additive union as the built-in baseline floor                                    | **PRESERVE** (document the ratchet)                               |
| New Drizzle migration for permission keys                                        | **NEW — rejected**, duplicates an existing mechanism              |
| New `db:sync-roles` command                                                      | **NEW — rejected**, `db:migrate` already is this                  |
| Edit to `seed.ts`                                                                | **NEW — rejected**, seed is the fresh-install path and is correct |
| A parity test asserting every built-in baseline is a subset of its converged row | **NEW — recommended**, currently untested                         |
| Runbook note: run `pnpm db:migrate` after any `BUILTIN_ROLES` edit               | **ADAPT** (`docs/QUICKSTART.md`)                                  |
| Runbook note: built-in role removals are reverted by migrate                     | **ADAPT** (new)                                                   |

## 11. Open question for the owner

Should built-in role **removals** be durable? Today they are not — the union
restores them. Options: (a) accept and document the floor semantics; (b) record
an explicit deny-list per role so removals persist; (c) forbid editing built-in
roles in the admin UI. This is a product decision, not a bug, and it is out of
scope for Phase 1.5.
