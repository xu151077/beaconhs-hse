# Permission Cutover v2 — Design (read-only, not executed)

> ## 中文摘要
>
> **设计结论：必须先做一次「单行、带 guard 的 targeted UPDATE」，再跑 `pnpm db:migrate`；单独靠 `db:migrate` 修不好 foreman。**
>
> - **A. 为什么 converge 修不了**：`convergeRolePermissions` 的并集是**只增不减**的。foreman live 行现在带 `ppe.read.all`，而这个 key **仍然在 93 键目录里**（safety_manager / tenant_admin 在用），所以 prune 不会删它；并集只会再加 `ppe.read.site`。结果 = **37 个 key，`ppe.read.all` 和 `ppe.read.site` 同时存在** → STOP 2 不消失，foreman 仍是租户级 PPE 读。已用只读模拟算出。
> - **B. 最小 SQL**：只改**一行**（`roles.id = 49e8c965-…`），`permissions - 'ppe.read.all' || '["ppe.read.site"]'`。已证明其结果**与代码 `BUILTIN_ROLES.foreman` 基线逐键完全相同**（36 键），其余 35 键原样保留。不碰 `role_assignments`，不碰 custom role。
> - **C. Guard**：tenant_id + key + is_built_in + 当前状态（`? ppe.read.all` 且 `NOT ? ppe.read.site`）+ 期望数量 `= 36`。只读前置查询已证明该 guard **恰好匹配 1 行**，所以「>1 行」在结构上不可能发生。
> - **D. Rollback**：`05-rollback.sql`，36 键，已**逐键与 snapshot 比对通过**。（生成过程中我一度手写多了一个 `ca.read.all`，被比对抓到并已修正——这正是要做这一步比对的原因。）
> - **F. 为什么 UPDATE 之后 db:migrate 不会破坏修正**：UPDATE 后 foreman 行**恰好等于**代码基线；converge 的并集条件是 `exists(基线 key 未出现在行里)`，全部已存在 → **不匹配任何行 → 完全 no-op**。其余角色本来就是 no-op（worker/safety_manager/tenant_admin 全部已收敛，custom role 被 `is_built_in` 跳过）。所以 `db:migrate` 对 `roles` 表变成彻底的空操作。
> - **本次为只读设计**：未执行 `db:migrate` / `db:rollback`，未执行任何 UPDATE/INSERT/DELETE/ALTER/DROP/CREATE，未修改 schema / migration / `migrate.ts` / 业务代码。数据库完全未变。
>
> 交付物：`docs/hse-permission-cutover-v2-plan.md` + `/tmp/opencode/phase15-cutover-v2/*.sql`（**仅生成，未执行**）。

---

## 0. Facts this design rests on

| Fact                                                                                   | Source                                                              | Label            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------- |
| 41 migration files, 41 journal entries, 41 ledger rows                                 | `ls drizzle/*.sql`, `_journal.json`, `drizzle.__drizzle_migrations` | RUNTIME VERIFIED |
| Phantom `0041_fine_vision.sql` absent                                                  | `ls drizzle/`                                                       | RUNTIME VERIFIED |
| `foreman` role id `49e8c965-e59e-4765-866b-38a61639dd90`                               | `select … from roles`                                               | RUNTIME VERIFIED |
| tenant id `85df8265-e62d-43ac-9455-e80a2a81efc9`                                       | same                                                                | RUNTIME VERIFIED |
| `foreman` live = 36 keys, has `ppe.read.all`, no `ppe.read.site`                       | same                                                                | RUNTIME VERIFIED |
| `ppe.read.all` **is still in the 93-key catalogue**                                    | `iam.ts:215`                                                        | STATIC VERIFIED  |
| Catalogue = 93; baselines worker 23 / foreman 36 / safety_manager 63 / tenant_admin 93 | `iam.ts`                                                            | STATIC VERIFIED  |
| `verif_no_ppe` (5 keys) is `is_built_in = false`                                       | `select`                                                            | RUNTIME VERIFIED |
| only `convergeRolePermissions` writes `roles.permissions`                              | `migrate.ts:161-222`, called at `:537`                              | STATIC VERIFIED  |

## A. Why `convergeRolePermissions` cannot fix foreman

`convergeRolePermissions` (`packages/db/src/migrate.ts:161-222`) does three things:

1. **Prune** (`:169-182`) — removes keys **not in the catalogue**, from all roles.
2. **`tenant_admin`** (`:184-191`) — set to the full catalogue.
3. **Built-in union** (`:193-218`) — `existing ∪ baseline`, gated on `is_built_in = true`.

Step 3's `WHERE` clause is:

```sql
where "key" = ${key}
  and "is_built_in" = true
  and exists (select 1 from jsonb_array_elements_text(baseline) b
              where not (roles.permissions ? b.permission))
```

So it **only ever adds**. It has no "remove keys that are no longer in this
role's baseline" branch, by design — a built-in baseline is a **floor**, so a
tenant admin who _added_ a key keeps it.

The prune cannot help either, because `ppe.read.all` is **still a valid catalogue
key** (`iam.ts:215`; `safety_manager` and `tenant_admin` both hold it). Prune
only removes keys outside the catalogue.

**Read-only simulation of converge on the current live row:**

| role           | live   | baseline | after union | converge action                                         |
| -------------- | ------ | -------- | ----------- | ------------------------------------------------------- |
| worker         | 23     | 23       | 23          | no-op                                                   |
| **foreman**    | **36** | **36**   | **37**      | **UPDATE → keeps `ppe.read.all`, adds `ppe.read.site`** |
| safety_manager | 63     | 63       | 63          | no-op                                                   |
| tenant_admin   | 93     | 93       | 93          | no-op                                                   |
| verif_no_ppe   | 5      | —        | —           | skipped (`is_built_in` gate)                            |

So `db:migrate` alone would leave foreman with **both** keys — strictly worse than
doing nothing, because it also adds a redundant `ppe.read.site`. This is the
union ratchet documented in `docs/hse-permission-cutover-analysis.md` §5.

## B. The minimal SQL

One statement, one row. Full text in
`/tmp/opencode/phase15-cutover-v2/03-apply.sql`; the essential part:

```sql
UPDATE roles
SET permissions = (
        SELECT jsonb_agg(value ORDER BY value)
        FROM jsonb_array_elements_text(
               (SELECT permissions - 'ppe.read.all' || '["ppe.read.site"]'::jsonb
                  FROM roles
                 WHERE id = '49e8c965-e59e-4765-866b-38a61639dd90'::uuid)
             ) AS t(value)
      ),
    updated_at = now()
WHERE id           = '49e8c965-e59e-4765-866b-38a61639dd90'::uuid
  AND tenant_id    = '85df8265-e62d-43ac-9455-e80a2a81efc9'::uuid
  AND key          = 'foreman'
  AND is_built_in  = true
  AND jsonb_array_length(permissions) = 36
  AND permissions  ? 'ppe.read.all'
  AND NOT (permissions ? 'ppe.read.site');
```

`- 'ppe.read.all'` removes one key; `|| '["ppe.read.site"]'` adds one. The
aggregate rebuilds the array, preserving the remaining 35 values.

**Scope discipline:**

| Must not change                | Why the statement cannot touch it              |
| ------------------------------ | ---------------------------------------------- |
| other roles                    | `WHERE id = <exact uuid>`                      |
| other tenants                  | `AND tenant_id = <exact uuid>`                 |
| `role_assignments`             | table never referenced                         |
| custom roles                   | `AND is_built_in = true`                       |
| RLS / grants / schema          | `roles.permissions` is the only column written |
| `ppe.read.site` on other roles | per-row `id` guard                             |

**Correctness proof** (computed read-only against the live row + the code baseline):

```
UPDATE target keys            : 36
== code BUILTIN_ROLES.foreman : True
removed ppe.read.all          : True
added   ppe.read.site         : True
other 35 keys preserved       : True (35 keys)
```

The transformation lands **exactly** on the code baseline — not near it.

## C. Guards

| Guard          | Value                                                                  | Pre-verified     |
| -------------- | ---------------------------------------------------------------------- | ---------------- |
| tenant         | `tenant_id = 85df8265-…efc9`                                           | RUNTIME VERIFIED |
| role key       | `key = 'foreman'`                                                      | RUNTIME VERIFIED |
| built-in only  | `is_built_in = true`                                                   | RUNTIME VERIFIED |
| expected count | `jsonb_array_length(permissions) = 36`                                 | RUNTIME VERIFIED |
| current state  | `permissions ? 'ppe.read.all' AND NOT (permissions ? 'ppe.read.site')` | RUNTIME VERIFIED |
| row count      | the precondition query returns **exactly 1** matching row              | RUNTIME VERIFIED |

Because `roles_tenant_key_ux` is unique on `(tenantId, key)`
(`iam.ts:35`), at most one `foreman` row can exist per tenant, so the
`> 1 row` failure mode is structurally impossible — the count check is a
belt-and-braces guard, not the primary defence.

## D. Rollback

`/tmp/opencode/phase15-cutover-v2/05-rollback.sql` — restores the exact
pre-cutover 36-key array for that one row, guarded so it only fires when the row
is in the post-cutover state (`has ppe.read.site`, `not ppe.read.all`).

**Verified by set comparison against the live snapshot:**

```
rollback keys = 36
EXACT MATCH to snapshot : True
contains ppe.read.all  : True
contains ppe.read.site : False
```

This check earned its keep: the first hand-written version contained 37 keys
(an extra `ca.read.all`). It was caught by the comparison and the array is now
generated from the snapshot rather than typed by hand.

If `db:migrate` has already run when you roll back, the row is restored but any
converge effect is not — re-check with the post-migrate verification.

## E. Execution order

```
1. SNAPSHOT           read-only, capture roles + role_assignments + ledger count
2. PRECONDITION       read-only SELECT, every assertion must hold
3. BEGIN              open the transaction
4. TARGETED UPDATE    one guarded statement
5. VERIFY SELECT      inside the transaction
6. COMMIT             only if UPDATE 1 and every check passed
7. pnpm db:migrate    becomes a no-op for roles (see F)
8. POST-VERIFY        confirm the state is still correct afterwards
```

The transaction boundary deliberately spans steps 3-6, so the UPDATE and its
verification are atomic: a failed check means `ROLLBACK`, and no partially
corrected state can be committed.

Artefacts, in order:

| Step | File                                                                                           | Executed?                              |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1    | `01-snapshot-roles.tsv`, `01-snapshot-role-assignments.tsv`, `01-snapshot-migration-count.txt` | SELECT only                            |
| 2    | `02-precondition.sql`                                                                          | SELECT only                            |
| 3-6  | `03-apply.sql`                                                                                 | **the only write**                     |
| 7    | `pnpm db:migrate`                                                                              | second write, expected no-op for roles |
| 8    | `04-post-migrate.sql`                                                                          | SELECT only                            |
| —    | `05-rollback.sql`                                                                              | only on failure                        |

## F. Why `db:migrate` cannot break the correction afterwards

After step 6, foreman's live row is **byte-equal in content to the code
baseline** (proven in §B). Now evaluate converge's `WHERE` clause for foreman:

- **Union branch (`:193-218`):** the guard is
  `exists (baseline key not already in the row)`. Every baseline key is present,
  so `exists` is **false** → **no row matches → no UPDATE**.
- **Prune branch (`:169-182`):** every one of the 36 keys is in the 93-key
  catalogue, so the `where exists (key not in catalogue)` predicate is **false**
  → **no UPDATE**.
- **`tenant_admin` branch (`:184-191`):** untouched by this cutover; it already
  equals the catalogue, and the guard `permissions <> catalogue` is false.

And `db:migrate` has no other writer of `roles`:

| `db:migrate` step                  | Touches `roles.permissions`?                    |
| ---------------------------------- | ----------------------------------------------- |
| `migrate()` (`:518`)               | no — and no migration is pending (41 = 41 = 41) |
| `verifyMigrationTracker` (`:519`)  | no                                              |
| `applyRlsPolicies` (`:522`)        | no — writes RLS policies                        |
| `applyRuntimeGrants` (`:525`)      | no — writes Postgres grants                     |
| `assertKioskPinHashes` (`:534`)    | no                                              |
| `convergeRolePermissions` (`:537`) | **yes — and is a no-op, per above**             |
| `applyPlannerStatistics` (`:540`)  | no                                              |
| `applyReportingViews` (`:543`)     | no                                              |

So the entire migration pipeline becomes a **verified no-op for the roles
table**. That is the property that makes this design safe: the correction is not
something `db:migrate` has to agree with — it is already in the state converge
converges _to_.

The residual risk is the reverse direction: if someone later removes
`ppe.read.site` from the catalogue, the prune would strip it from foreman on the
next `db:migrate`. Worth a line in the runbook; not a problem today.

## G. Failure handling

| Failure                                                             | Detection                      | Response                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UPDATE affects 0 rows**                                           | psql reports `UPDATE 0`        | **ABORT.** A guard did not match — the row is not in the expected state. Do **not** COMMIT, do **not** run `db:migrate`. Re-run `02-precondition.sql` and reconcile. Most likely causes: already applied (idempotent re-run), or someone changed the row.                              |
| **UPDATE affects > 1 row**                                          | psql reports `UPDATE n`, n > 1 | **ABORT + ROLLBACK.** Structurally impossible under `roles_tenant_key_ux`, so this means the uniqueness index is absent or the wrong database is targeted. Stop and investigate before anything else.                                                                                  |
| **`db:migrate` fails**                                              | non-zero exit                  | The `roles` table is untouched: `convergeRolePermissions` is one transaction (`migrate.ts:164`) and fails before writing. Run `05-rollback.sql` if the correction must be undone, or simply fix the migration problem and re-run — step 4 is idempotent-by-state, not by re-execution. |
| **post-check fails** (step 8)                                       | assertion mismatch             | Do **not** blindly re-run the UPDATE. First read the row: if `ppe.read.all` is back, converge reintroduced it, which would mean the pre-fix assumption was wrong — stop and re-derive. `05-rollback.sql` restores the snapshot state.                                                  |
| **Verification SELECT inside the transaction returns wrong values** | any assertion                  | `ROLLBACK;` — the transaction is still open, so nothing is written. This is the main reason the verify sits between `BEGIN` and `COMMIT`.                                                                                                                                              |

Additional safety: the UPDATE is **state-guarded, not blindly idempotent**. A
second run finds `NOT (permissions ? 'ppe.read.site')` false and matches 0 rows,
so it cannot double-apply or corrupt anything.

## H. Artefact

This document. SQL lives in `/tmp/opencode/phase15-cutover-v2/`:

```
01-snapshot-roles.tsv              5 rows   (authoritative)
01-snapshot-role-assignments.tsv   4 rows
01-snapshot-migration-count.txt    41
02-precondition.sql                SELECT only
03-apply.sql                       the single write (UPDATE + verify + COMMIT)
05-rollback.sql                    restore, verified against the snapshot
baselines.json                     code BUILTIN_ROLES for comparison
live-roles.jsonl                   live permissions for comparison
```

`04-post-migrate.sql` is specified in §E step 8 but is **not yet written** — it
should be authored from `03-apply.sql`'s verify block before the execution
phase, so that no SQL is improvised mid-execution.

---

## Final answers

**Is the database still unchanged?** **Yes.** This turn executed only `SELECT`
statements (roles, role_assignments, ledger, `information_schema`, `pg_*`). No
`UPDATE`/`INSERT`/`DELETE`/`ALTER`/`DROP`/`CREATE`, no `db:migrate`, no
`db:rollback`. Role permissions are byte-identical to the turn-start snapshot:
`foreman 36 (all=true) · safety_manager 63 · tenant_admin 93 · worker 23 (self=true) · verif_no_ppe 5`. Ledger still 41. `packages/db/drizzle` still 41 files, phantom absent. Nothing staged; HEAD `454658c4`.

**Can we enter the execution phase?** **Yes, once the preconditions are
re-verified against a live database** — the design is complete and the
correctness of the transformation is proven, not assumed. One piece of work
remains: author `04-post-migrate.sql` before executing.

**Human confirmations required before executing:**

1. Read the `UPDATE 1` line and the in-transaction verification output with your
   own eyes before `COMMIT`.
2. Confirm the target database/tenant is the intended one.
3. Confirm `01-snapshot-*.tsv` from _this_ run exists and is current (the
   rollback was generated against it).
4. Confirm `04-post-migrate.sql` exists.
5. Confirm no phantom migration is present (`ls packages/db/drizzle/*.sql | wc -l` = 41).
6. Authorise `db:migrate` as a separate, explicit step.

**Artefacts to retain:** `01-snapshot-roles.tsv`,
`01-snapshot-role-assignments.tsv`, `01-snapshot-migration-count.txt`,
`02-precondition.sql`, `03-apply.sql`, `04-post-migrate.sql`,
`05-rollback.sql`, plus the console output of every step. The snapshot is the
**only** thing that makes a post-hoc repair possible, so it must not be
overwritten by a later run.
