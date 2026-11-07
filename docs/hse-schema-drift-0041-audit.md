# Schema Drift 0041 Audit — `0041_fine_vision.sql`

> ## 中文摘要
>
> **分类：CASE C — 本地生成物，绝不可提交、绝不可执行。**
>
> 根因不是 schema drift，而是 **drizzle snapshot 元数据缺失**：
>
> - 仓库有 **41 条 migration**，`_journal.json` 有 **41 条 entry**，两者 1:1 完全一致（最后一条 `0041_document_book_cover_template`）。
> - 但 `meta/` 只有 **25 个 snapshot**，最新的是 **`0029_snapshot.json`**。缺失编号：`1, 2, 26, 27, 28, 30–40`。
> - `drizzle-kit generate` 是拿 **最新 snapshot** 做 diff 基线的，基线停在 0029，于是把 **0030–0041 已提交的 DDL 全部重新吐了一遍**，命名为 `0041_fine_vision.sql`。
>
> 关键证据：0041_fine_vision 里的每一条语句都能在已提交 migration 中找到出处——`0034`（`compliance_audience_kind` ADD VALUE）、`0035`（`journal_analysis_run_status` + `journal_analysis_runs`）、`0038`（`document_book_item_kind`）。
>
> **PPE enum round-trip 是伪 migration**：`ppe_issues.action` / `ppe_items.status` 的 `SET DATA TYPE text` → `DROP TYPE` → `CREATE TYPE` → `USING ...::enum`，是 drizzle 表达 **enum label 变更** 的机械手法（0029 snapshot 记的还是旧 label `mark_damaged` / `damaged`，而 0032 已改成 `mark_out_of_service` / `out_of_service` 并新增 3 个 label）。**没有任何一条已提交 migration 修改过这两列的类型**；`0000_init` 建的就是 enum，`0032` 只改了 label。
>
> **当前数据库状态**：ledger `drizzle.__drizzle_migrations` = **41 行**，41 条 migration **全部已应用**。0041_fine_vision 要创建的 type/table **全部已存在**，执行必然报错；若强行绕过，PPE enum round-trip 会对 6 行 `ppe_items` / 3 行 `ppe_issues` 的活列做真实类型重写。
>
> **与 Phase 1.5 无关**：Phase 1.5 只改了 `iam.ts`，**DDL 语句数 = 0**（仅 permission 字符串字面量）。
>
> 本次审计为只读。未执行 `db:migrate` / `db:rollback`，未执行任何写操作，`packages/db/drizzle` 仍为 41 个文件。

---

## 1. Executive Summary

`pnpm db:generate` produced `0041_fine_vision.sql`, which looks like a new schema
migration. It is not. It is a **re-emission of migrations 0030–0041 that are
already committed, already journaled, and already applied to the database.**

The cause is incomplete Drizzle **snapshot metadata**, not schema drift:

| Artefact                            | Count  | State                                                          |
| ----------------------------------- | ------ | -------------------------------------------------------------- |
| Committed migration `.sql` files    | **41** | `0000_init` … `0041_document_book_cover_template`              |
| `_journal.json` entries             | **41** | **1:1 with the files, no gap, no orphan**                      |
| `meta/*_snapshot.json`              | **25** | newest is **`0029_snapshot.json`**                             |
| Missing snapshot numbers            | 16     | `1, 2, 26, 27, 28, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40` |
| `drizzle.__drizzle_migrations` rows | **41** | all 41 migrations applied                                      |

`drizzle-kit generate` diffs the live schema against the **most recent snapshot**,
not against the migration SQL. With the baseline stuck at `0029`, every change
made by 0030–0041 looks new and is re-emitted.

## 2. Current DB State

Read-only `SELECT` against `pg_type`, `pg_enum`, `pg_class`, `pg_attribute`,
`information_schema.columns`, and `drizzle.__drizzle_migrations`.

| Object asked for by 0041                | Exists in DB?                                            |
| --------------------------------------- | -------------------------------------------------------- |
| type `document_book_item_kind`          | **YES**                                                  |
| type `journal_analysis_run_status`      | **YES**                                                  |
| type `compliance_audience_kind`         | **YES**                                                  |
| table `journal_analysis_runs`           | **YES**                                                  |
| type `ppe_issue_action`                 | **YES**                                                  |
| `ppe_issues.action` type                | `USER-DEFINED` → `ppe_issue_action` (**still the enum**) |
| `ppe_items.status` type                 | `USER-DEFINED` → `ppe_item_status` (**still the enum**)  |
| `ppe_items.status` default              | `'in_stock'::ppe_item_status`                            |
| table `document_book_items` (0038)      | YES                                                      |
| cover column on `document_books` (0041) | YES                                                      |

`compliance_audience_kind` current labels — already include the values 0041 tries
to add:

```
everyone, person, role, trade, department, org_unit, person_group, crew
```

Row counts that a type rewrite would touch: `ppe_items` = 6, `ppe_issues` = 3,
`document_book_items` = 0, `journal_analysis_runs` = 0.

**Conclusion: 0041 would fail on its first statement** (`CREATE TYPE
document_book_item_kind` → type already exists) **and would be unsafe even if it
did not**, because the enum round-trips would rewrite two live columns.

## 3. Migration History

Journal is **healthy and complete**:

```
entries in journal : 41
last tag           : 0041_document_book_cover_template  (idx 40, version 7)
first tag          : 0000_init
in journal, no .sql : []
.sql, not in journal: []
```

The committed chain that 0041 duplicates:

| Migration                                       | Added (git) | Date       |
| ----------------------------------------------- | ----------- | ---------- |
| `0030_unify_hazid_app_locations.sql`            | `fed25915`  | 2026-08-05 |
| `0031_hazid_optional_risk_ratings.sql`          | `1678c412`  | 2026-08-06 |
| `0032_ppe_status_lifecycle.sql`                 | `09ee7c81`  | 2026-08-06 |
| `0034_compliance_group_audience_ppe_report.sql` | `cd698d53`  | 2026-08-21 |
| `0035_journal_analysis_runs.sql`                | `81df35b0`  | 2026-08-31 |
| `0038_document_book_sections.sql`               | `42b65091`  | 2026-09-16 |
| `0039_document_book_chapters.sql`               | `b38761de`  | 2026-09-16 |
| `0040_platform_feedback.sql`                    | `8aadce2c`  | 2026-09-16 |
| `0041_document_book_cover_template.sql`         | `5ec98e6a`  | 2026-09-16 |

All 12 of these are in the ledger (41 rows). **0041 is not a historical
migration that was omitted — it was generated minutes ago by a `db:generate` run
and must be deleted.**

## 4. Schema History

The schema and the migrations are **in sync** — this is not "schema ahead of
migration":

- `git log -- packages/db/src/schema/ppe.ts` → newest change is **`09ee7c81`**,
  2026-08-06.
- `0032_ppe_status_lifecycle.sql` was added in **the same commit `09ee7c81`**.

So each schema change shipped with its migration. There is no missing migration;
what is missing is the **snapshot** that records the post-migration schema state.

## 5. Object-by-object Analysis

| 0041 statement                                                 | Drizzle schema source                            | Committed migration that already does it                              | First commit          | In DB? | Phase 1.5? |
| -------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- | --------------------- | ------ | ---------- |
| `CREATE TYPE document_book_item_kind`                          | `schema/documents.ts`                            | **`0038_document_book_sections.sql:9`**                               | `42b65091` 2026-09-16 | yes    | no         |
| `CREATE TYPE journal_analysis_run_status`                      | `schema/journals.ts`                             | **`0035_journal_analysis_runs.sql`**                                  | `81df35b0` 2026-08-31 | yes    | no         |
| `CREATE TABLE journal_analysis_runs`                           | `schema/journals.ts`                             | **`0035_journal_analysis_runs.sql:6`**                                | `81df35b0` 2026-08-31 | yes    | no         |
| `ALTER TYPE compliance_audience_kind ADD VALUE 'person_group'` | `schema/compliance.ts`                           | **`0034_…:5`**                                                        | `cd698d53` 2026-08-21 | yes    | no         |
| `ALTER TYPE compliance_audience_kind ADD VALUE 'crew'`         | `schema/compliance.ts`                           | **`0034_…:6`**                                                        | `cd698d53` 2026-08-21 | yes    | no         |
| `ppe_issues.action` type round-trip                            | `schema/ppe.ts:145` `pgEnum('ppe_issue_action')` | **no migration alters the type**; label change in **`0032:25,32-34`** | `09ee7c81` 2026-08-06 | enum   | no         |
| `ppe_items.status` type round-trip                             | `schema/ppe.ts:74` `pgEnum('ppe_item_status')`   | **no migration alters the type**; label change in **`0032:15`**       | `09ee7c81` 2026-08-06 | enum   | no         |

No object originates from upstream, a merge, or a cherry-pick. Every one is a
local, committed migration from this repository's own history.

## 6. PPE Enum Analysis

**The round-trip is a phantom.** Evidence, not inference:

1. **Original type:** `0000_init.sql:43,45` created both `ppe_issue_action` and
   `ppe_item_status` as enums. The columns have been enums since day one.
2. **Did any migration change the column type?** No. `grep` for
   `ppe_issue_action|ppe_item_status` across all 41 migrations matches only
   `0000_init` and `0032`. `0032` contains **only label operations**:
   `ALTER TYPE … RENAME VALUE` and `ALTER TYPE … ADD VALUE` — never
   `ALTER COLUMN … TYPE`.
3. **Does the schema still use an enum?** Yes. `schema/ppe.ts:74`
   `status: ppeItemStatus('status')` and `:145` `action: ppeIssueAction('action')`.
4. **Why does Drizzle emit `SET DATA TYPE text`?** Because its diff baseline,
   `0029_snapshot.json`, still records the **pre-0032 labels**:
   ```
   0029 snapshot  ppe_issue_action : ['issue','return','replace','mark_damaged','discard']
   current schema ppe_issue_action : ['issue','return','replace','mark_out_of_service',
                                      'return_to_service','return_to_stock','expire','discard']
   0029 snapshot  ppe_item_status  : [... 'damaged' ...]
   current schema ppe_item_status  : [... 'out_of_service' ...]
   ```
   Changing an enum's labels requires `DROP TYPE` + `CREATE TYPE`, and a dependent
   column must be detached first. Drizzle therefore emits the mechanical sequence
   `SET DATA TYPE text` → `DROP TYPE` → `CREATE TYPE` → `SET DATA TYPE … USING`.
   The snapshot also records the enum **type name** correctly
   (`type=ppe_issue_action`), so this is not a type/snapshot mismatch — it is a
   **label** mismatch.
5. **Is a cast present?** Yes: `USING "action"::"public"."ppe_issue_action"`.
6. **Could it corrupt data?** It would be a genuine column type rewrite on live
   data (6 and 3 rows). Under normal `ALTER` semantics Postgres would refuse a
   lossy enum→text→enum round-trip without the `USING` clause — which drizzle
   supplies — so it would likely _succeed_ and silently churn two typed columns
   and the default. It is unnecessary work at best, and a `DROP TYPE`/`CREATE
TYPE` on shared enum types is a real hazard at worst.
7. **Is it merely a snapshot artifact?** **Yes.** Every statement in the
   round-trip is a restatement of what `0032` already did, and the database
   already holds the post-0032 labels.

## 7. Root Cause

Drizzle's snapshot chain was not committed for 16 of the 41 migrations. Because
`drizzle-kit generate` uses the newest available snapshot as its diff baseline,
and that baseline is `0029_snapshot.json`, all post-0029 schema changes are
mis-detected as pending and re-emitted as one phantom migration.

This is a **repository hygiene defect in migration metadata**, entirely
independent of Phase 1.5. It is also a latent trap: any developer who runs
`pnpm db:generate` on a clean checkout will get a plausible-looking but
destructive migration that duplicates applied history.

## 8. Classification

# CASE C

**`0041_fine_vision.sql` is a local generation artefact produced by incomplete
snapshot metadata. It is not real schema drift, it duplicates already-applied
migrations, and it must never be committed or applied.**

Why not the others:

- **Not CASE A** — it is not a historical migration and it is not missing from
  the journal. The _snapshots_ are omitted, not the migration.
- **Not CASE B** — it is not "new relative to history". History already contains
  it, three times over (0034, 0035, 0038).
- **Not CASE D** — the mixture of sources is a _symptom_ of the single snapshot
  gap. Splitting it would be treating a symptom; fixing the snapshots resolves
  all of it at once.

Caveat on the CASE C wording: "unexpected schema drift" is close but slightly
imprecise. **The schema has not drifted from the migration history** — they are
in lockstep. What is incomplete is the snapshot _metadata_. I record this because
the distinction changes the fix.

## 9. Evidence

| Claim                                                           | Label            | Source                                                                                                                                                                   |
| --------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 41 migrations, 41 journal entries, 1:1                          | STATIC VERIFIED  | `_journal.json` vs `drizzle/*.sql`                                                                                                                                       |
| Only 25 snapshots; newest `0029`                                | STATIC VERIFIED  | `ls drizzle/meta/`                                                                                                                                                       |
| Missing snapshot numbers `1,2,26,27,28,30–40`                   | STATIC VERIFIED  | computed from snapshot filenames                                                                                                                                         |
| Ledger has 41 rows                                              | RUNTIME VERIFIED | `select count(*) from drizzle.__drizzle_migrations`                                                                                                                      |
| All 0041 objects already exist in the DB                        | RUNTIME VERIFIED | `pg_type`, `pg_class`                                                                                                                                                    |
| `compliance_audience_kind` already has `person_group`, `crew`   | RUNTIME VERIFIED | `pg_enum`                                                                                                                                                                |
| `ppe_issues.action` / `ppe_items.status` are still enums        | RUNTIME VERIFIED | `information_schema.columns.udt_name`                                                                                                                                    |
| `document_book_item_kind` created by `0038:9`                   | STATIC VERIFIED  | migration file                                                                                                                                                           |
| `journal_analysis_runs` created by `0035:6`                     | STATIC VERIFIED  | migration file                                                                                                                                                           |
| `compliance_audience_kind` ADD VALUE by `0034:5-6`              | STATIC VERIFIED  | migration file                                                                                                                                                           |
| No migration ever altered the two PPE column types              | STATIC VERIFIED  | grep across all 41 migrations                                                                                                                                            |
| 0029 snapshot holds pre-0032 enum labels                        | STATIC VERIFIED  | snapshot JSON vs `schema/ppe.ts`                                                                                                                                         |
| `schema/ppe.ts` and `0032` landed in the same commit `09ee7c81` | STATIC VERIFIED  | `git log`                                                                                                                                                                |
| Phase 1.5 added 0 DDL statements                                | STATIC VERIFIED  | `git diff HEAD -- packages/db/src/schema`                                                                                                                                |
| What a full isolated re-generation contains                     | **UNVERIFIED**   | drizzle-kit `out` resolves relative to cwd; the isolated run failed on path resolution. Statement-level mapping was done statically instead, which is stronger evidence. |

## 10. Risk Assessment

| Risk                                | Severity       | Note                                                                                                                            |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Applying 0041                       | **Critical**   | `CREATE TYPE` fails immediately; if bypassed, enum round-trips rewrite live typed columns and `DROP`/`CREATE` shared enum types |
| Silent divergence of snapshot chain | **High**       | every future `db:generate` produces a phantom migration; the trap is repeatable                                                 |
| Blocks Phase 1.5 permission cutover | **High**       | `db:migrate` runs drizzle migrations before `convergeRolePermissions`, so a phantom 0041 in the folder would be picked up first |
| Data loss on PPE round-trip         | **Low–Medium** | only 9 rows here, but the same path in production would touch real data                                                         |
| Phase 1.5 correctness               | **None**       | unrelated; 0 DDL statements, no new tables, no `project_id`                                                                     |

## 11. Recommended Next Step

**Do not apply, do not commit, delete `0041_fine_vision.sql` and its snapshot**
(already done in the prior step; the repo is at 41 files).

Then, as a **separate** change, out of Phase 1.5 scope:

1. Regenerate the missing snapshots so the chain is complete — either by
   rebuilding the snapshot chain from the existing migrations, or by squashing
   the 41 migrations into a single baseline and generating a fresh snapshot.
   This is a judgement call about migration policy and should be made
   deliberately, not inside a security change.
2. Add a CI guard: fail if `db:generate` produces a non-empty diff, or if
   `meta/` snapshot count diverges from the journal entry count. This is the
   durable fix — it makes the trap impossible to walk into again.
3. Only then resume the Phase 1.5 permission cutover.

## 12. Explicitly Prohibited Actions Before Resolution

- Do **not** run `pnpm db:migrate` while a phantom migration is present.
- Do **not** commit `0041_fine_vision.sql` or `meta/0041_snapshot.json`.
- Do **not** apply the enum round-trips to `ppe_items.status` or
  `ppe_issues.action`; the committed state is already correct.
- Do **not** hand-patch the database to satisfy a phantom migration.
- Do **not** regenerate or delete committed migrations 0030–0041.
- Do **not** bundle the snapshot repair into the Phase 1.5 security commit.
