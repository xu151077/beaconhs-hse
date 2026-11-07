# Permission Cutover — Implementation Plan

> ## 中文摘要
>
> **实施计划：Phase 1.5 权限切换本身不需要写任何代码，只需执行一次 `pnpm db:migrate`。**
>
> - 本计划把切换拆成 **Step 0（快照）→ Step 1（只读前置断言）→ Step 2（执行 `pnpm db:migrate`）→ Step 3（只读后置断言）→ Step 4（幂等复跑）→ Step 5（行为确认）**。
> - Step 2 是**唯一的状态变更**，其余全部是只读验证。
> - 回滚 = 回退 `iam.ts` + 重跑 `db:migrate`（prune 会自动剔除已下架 key），**没有 down-migration**，因此 Step 0 的快照是强制前置。
> - 两项**不在 Phase 1.5 实施范围**的后续项：(a) 为 `convergeRolePermissions` 补参数化测试（当前 0 覆盖）；(b) 在 `QUICKSTART.md` / `AGENTS.md` 中写明「内置角色权限并集单向棘轮」。
> - 明确不做：不新建 migration、不新建命令、不改 seed、不改 RLS、不改业务代码。
>
> **当前状态：本文档为计划，尚未执行。Phase 1.5 明确禁止修改 database，因此 Step 0-5 均未运行。**

---

## 0. Preconditions

| Precondition                                         | Evidence                             |
| ---------------------------------------------------- | ------------------------------------ |
| Infra up (`docker compose --profile local-db up -d`) | `docs/AGENTS.md` quick start         |
| `pnpm db:migrate` is the documented upgrade path     | `docs/QUICKSTART.md:35`              |
| `convergeRolePermissions` is on that path            | `packages/db/src/migrate.ts:536-537` |
| Working tree is the reviewed Phase 1.5 change        | `git status` — 13 modified, 7 new    |
| No migration is pending that would conflict          | `pnpm db:generate` must be clean     |

**Gate:** if `pnpm db:generate` reports a pending schema change, stop. This
permission cutover must not be bundled with a schema migration.

## 1. Step 0 — Snapshot `roles` (MANDATORY)

There is no down-migration for the convergence step, so the only recovery path
is a restore. This step is not optional.

```bash
docker exec beaconhs-postgres psql -U postgres -d beaconhs -t -A -c \
  "select tenant_id, key, is_built_in, permissions from roles order by tenant_id, key;" \
  > /tmp/roles-snapshot-$(date +%Y%m%dT%H%M%S).json
```

**Exit criteria:** file exists, is non-empty, and contains one line per role.

**Note for the multi-tenant case:** a real cutover must run this per environment
(production, staging, each tenant database if tenants are not co-hosted). The
snapshot must be taken from the same database `db:migrate` will target.

## 2. Step 1 — Read-only pre-assertion

Establish, before changing anything, that the database is actually behind the
code. If it is already converged, the cutover is a no-op and can be skipped.

```sql
select key, is_built_in, jsonb_array_length(permissions) as n
from roles
where is_built_in
order by key;
```

**Expected (pre-Phase-1.5 database):**

| role           | keys | Phase 1.5 change                |
| -------------- | ---- | ------------------------------- |
| foreman        | 35   | will gain `ppe.read.all`        |
| safety_manager | 63   | unchanged                       |
| tenant_admin   | 91   | will become 93 (full catalogue) |
| worker         | 22   | will gain `ppe.read.self`       |

Also record the custom-role invariant, which must be unchanged by Step 2:

```sql
select key, is_built_in, permissions
from roles
where not is_built_in
order by key;
```

> On the local demo database the roles rows are **already** at 36 / 63 / 93 / 23
> because the Phase 1.5 verification fixture aligned them by hand. That is exactly
> what Step 2 would have produced, so on this host Steps 2-4 are a no-op
> re-affirmation. They remain non-trivial on any environment seeded before the
> change. **RUNTIME VERIFIED.**

## 3. Step 2 — Run the cutover

```
pnpm db:migrate
```

**Expected output** (`packages/db/src/migrate.ts:536-537`, `:221`):

```
▶ Converging role permissions…
✔ Built-in role permissions backfilled
```

**Exit criteria:** the command exits 0 and the success line is present. The whole
operation is one transaction (`migrate.ts:164`); any failure rolls back the
convergence entirely and leaves `roles` untouched.

**Do not** run `pnpm db:seed` afterwards. The seed short-circuits at
`packages/db/src/seed.ts:118-121` and would do nothing, but running it invites the
false belief that it performs the upgrade. It does not.

## 4. Step 3 — Read-only post-assertion

```sql
select key, is_built_in, jsonb_array_length(permissions) as n
from roles
where is_built_in
order by key;
```

**Expected:**

| role           | keys | delta               |
| -------------- | ---- | ------------------- |
| foreman        | 36   | +1 `ppe.read.all`   |
| safety_manager | 63   | 0                   |
| tenant_admin   | 93   | +2 (full catalogue) |
| worker         | 23   | +1 `ppe.read.self`  |

And the two new keys must be present exactly where the code puts them:

```sql
select key,
       permissions ? 'ppe.read.all'  as has_all,
       permissions ? 'ppe.read.site' as has_site,
       permissions ? 'ppe.read.self' as has_self
from roles
where key in ('foreman', 'worker');
```

**Expected:** `foreman` → `has_all = true`, `has_site = false`, `has_self = false`;
`worker` → `has_self = true`, others false.

**Custom-role invariant re-check:** re-run the Step 1 custom-role query and
confirm byte-identical output. Any difference means a custom role was touched
beyond retirement, which is a regression.

## 5. Step 4 — Idempotence proof

Run `pnpm db:migrate` a second time and re-assert Step 3.

**Exit criteria:** identical counts. This is the check that justifies preferring
this mechanism over a migration: it is safe on _every_ deploy, not just once.

**Expected:** foreman 36, safety_manager 63, tenant_admin 93, worker 23 — no
change from Step 3.

## 6. Step 5 — Behavioural confirmation

The point of the cutover is that `ppe.read.self` becomes real. Confirm it at
runtime, then re-confirm the Phase 1.5 matrix on a database where the roles came
from `db:migrate` rather than a hand-written fixture.

| Check                                              | Expected                                              |
| -------------------------------------------------- | ----------------------------------------------------- |
| `worker` role holder: PPE nav entry                | present (gated on `ppe.read.self`, `nav/registry.ts`) |
| `worker` role holder: `/ppe` list                  | own gear only                                         |
| `worker` role holder: another holder's `/ppe/[id]` | not found                                             |
| `foreman` role holder: `/ppe` list                 | full register                                         |
| Unauthenticated `/ppe`                             | redirect to `/login`                                  |

These are the same assertions as
[`apps/web/src/lib/ppe-read-tier-contract.test.ts`](../../apps/web/src/lib/ppe-read-tier-contract.test.ts),
which cover the code path. Step 5 covers the _database_ path.

> **Known adjacent defect:** a `ppe.read.self` / `ppe.read.site` holder receives
> **403** on the `ppe-register-filter-holders` picker, because
> `apps/web/src/app/api/picker-options/route.ts:298-299` only accepts
> `ppe.read.all` plus write permissions. Fail-closed, not a leak. Analysed
> separately in
> [`hse-ppe-picker-authorization-analysis.md`](./hse-ppe-picker-authorization-analysis.md).
> Expected to persist through this cutover.

## 7. Rollback

| Trigger                                     | Action                                                                         | Verification                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong `BUILTIN_ROLES` edit shipped          | Revert `packages/db/src/schema/iam.ts`, re-run `pnpm db:migrate`               | Prune (`:169-182`) strips the now-unknown keys from every role; `tenant_admin` re-pinned (`:184-191`); the shorter union cannot re-add |
| Convergence produced an unexpected role set | Restore `roles.permissions` from the Step 0 snapshot, re-run `pnpm db:migrate` | Re-assert Step 3                                                                                                                       |
| Migration failed at step 6                  | Nothing to undo                                                                | Single transaction (`migrate.ts:164`); verify Step 1 output is unchanged                                                               |

**There is no `db:rollback` for this step.** `convergeRolePermissions` writes no
ledger row, so recovery is always "restore + re-run".

## 8. Gates

`convergeRolePermissions` is data, not code, so the six code gates are unaffected
and are **not** re-run for this cutover. They were green at the Phase 1.5 exit and
nothing in Steps 0-5 modifies source:

| Gate                   | Status at plan time                                                  |
| ---------------------- | -------------------------------------------------------------------- |
| `pnpm format:check`    | FAIL — 20 pre-existing `.opencode/**/*.md` (unrelated, out of scope) |
| `pnpm typecheck`       | PASS (26/26)                                                         |
| `pnpm lint`            | PASS                                                                 |
| `pnpm test`            | PASS (24/24; web 192 files / 1170 tests)                             |
| `pnpm deadcode:check`  | PASS                                                                 |
| `pnpm build`           | PASS                                                                 |
| migrations             | 0                                                                    |
| RLS                    | unchanged                                                            |
| `PERMISSION_CATALOGUE` | 93                                                                   |

## 9. Out of scope for Phase 1.5

Not authorised, not started, listed so the boundary is explicit:

- **Project Scope** (`docs/hse-project-scope-*.md` Steps A-E).
- **`people_assignments`** crew/team scope expansion.
- Contractor/subcontractor organization model.
- **`osha_300_log`** scope semantics (still an open legal decision).
- The union-ratchet product decision (analysis §11).
- A parity test for `convergeRolePermissions` (design §3 item 10).
- The G.1 picker fix.

## 10. Definition of done

1. Step 0 snapshot exists and is non-empty.
2. `pnpm db:migrate` exits 0 with `✔ Built-in role permissions backfilled`.
3. Post-assertions match the expected table exactly (36 / 63 / 93 / 23).
4. `ppe.read.all` on `foreman`, `ppe.read.self` on `worker` — verified by query.
5. Custom roles byte-identical before and after.
6. Second `pnpm db:migrate` changes nothing.
7. Step 5 behavioural checks pass at runtime.
8. No source file, migration, RLS policy, or seed was modified.
9. `git status` unchanged apart from the Phase 1.5 work already staged for review.

**Nothing in this plan is committed by this document.**
