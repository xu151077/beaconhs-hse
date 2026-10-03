# Migration Integrity Guard

> ## 中文摘要
>
> **结论：MIGRATION INTEGRITY GUARD = PASS · READ_PERMISSION INVARIANT = PASS · DATABASE = UNCHANGED · REPO MIGRATIONS = UNCHANGED**
>
> **本任务没有修复历史 snapshot chain。** 25 snapshots / 41 migrations 是既有的合法历史状态，本任务只加防护，不做修复。
>
> **为什么需要防护（已实测复现）：** `meta/` 缺 16 个 snapshot（idx 1, 2, 26-28, 30-40）。drizzle-kit 只能拿最新的 `0029_snapshot.json` 做 diff 基线，所以每次跑 `db:generate` 都会**重新提出**迁移 0030-0041 已经落地的 schema 变更。实测在本仓库直接生成了一个 **38 条语句的 phantom migration**（12 个 CREATE、9 个 ADD COLUMN、3 个 DROP），并且它的索引 `0041` **与已提交的 `0041_document_book_cover_template.sql` 冲突**——两个文件同名同索引，journal 出现 `idx=40 tag=0041_...` 与 `idx=41 tag=0041_...` 的重复。若提交，ledger 里该 idx 已 apply 过，文件无法与历史区分，会重跑已提交的 DDL。
>
> **Guard 设计：** `packages/db/src/scripts/check-migration-drift.ts`
>
> - 在**临时隔离目录**里跑真实 `drizzle-kit generate`（cwd = 临时目录、`--out` 为相对路径），**不加载 repo 的 drizzle.config**、**不需要 `DATABASE_URL`**、**不碰数据库**。
> - 检测方式为**执行前后 diff 目录内容**，而非依赖 exit code——drizzle-kit 失败时仍返回 0（它把 stack trace 写进 stdout），只信 exit code 会把坏掉的 guard 变成静默 PASS。
> - 判决三态：`in-sync`（generate 无产出，PASS）/ `drift`（任何新增提案、迁移丢失或索引冲突，FAIL）/ `tool-error`（工具失败，FAIL）。`known-stale` 已于 §13 移除。
> - **guard 自证不改仓库**：执行前后对 `packages/db/drizzle` 做整树 hash 比对，不一致即 FAIL。
>
> **为什么不用 `snapshots == migrations`**：那是把既有的历史结构当成错误，会要求先做一次 migration 策略判断（重建 chain 还是 squash），属于决策而非缺陷。正确目标是**"generation 是否会产生新东西"**，本 guard 只判这一件事。
>
> **测试：** 新增 23 个（`check-migration-drift.test.ts` 16 + `api/permissions.test.ts` 7）。含**两个端到端真实 generate 测试**：复现 phantom（证明指纹诚实）+ 注入一个迁移里没有的新表并断言 `drift`（证明 guard 真的有鉴别力，不是恒 PASS）。
>
> **顺带发现（未修）：** `REPORT_ENTITIES` 的 `compliance` 和 `apps` 两个 category 在 `READ_PERMISSION_BY_CATEGORY` 里**没有条目**，这正是已记录的 `POST /api/v1 returns 500` 缺陷。已记入 §7，未修（补 permission 授权是业务决策）。

---

## 1. Problem

`packages/db/drizzle/meta/` holds 25 snapshot files while the journal lists 41 entries. Sixteen journal entries have no snapshot:

```
idx 1, 2, 26, 27, 28, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
```

Consequence, **reproduced live** in this repo (see §6): `db:generate` proposes a new migration that re-applies schema already committed as 0030-0041, under an index that collides with a committed migration.

## 2. Root cause

drizzle-kit diffs the current schema against **the newest snapshot it can find**, which is `0029_snapshot.json`. Everything committed after 0029 is invisible to that diff, so the generator believes 0030-0041 never happened.

Measured on the real schema (drizzle-kit 0.31.10):

```
[✓] Your SQL migration file ➜ out/0041_loving_hardball.sql 🚀
  38 statements · 12 CREATE · 9 ADD COLUMN · 3 DROP
  e.g. CREATE TYPE "public"."document_book_item_kind" AS ENUM(...)
       ALTER TYPE "public"."compliance_audience_kind" ADD VALUE 'person_group'
       ALTER TABLE "ppe_issues" ALTER COLUMN "action" SET DATA TYPE text;
```

Every one of those changes is **already applied**. Worse, the generated tag reuses index `0041`:

```
temp out:  0041_burly_starbolt.sql
           0041_document_book_cover_template.sql     ← committed, real, already applied
journal:   idx=40  tag=0041_document_book_cover_template
           idx=41  tag=0041_burly_starbolt             ← two entries claiming index 0041
```

A migration file is identified by its index in the ledger. Two files at index `0041` cannot be told apart from history, so committing the phantom would re-run committed DDL — or fail mid-migration.

The root cause is the incomplete snapshot chain. **This task does not repair it.** It makes the trap loud instead of silent.

## 3. Why snapshot-count equality is the wrong check

`snapshots === migrations` is `25 === 41`, which is false. Enforcing it would mean requiring a deliberate migration-policy decision first — rebuild the chain from the migrations, or squash to a baseline and generate a fresh snapshot. That is judgement about migration policy (documented in `docs/hse-schema-drift-0041-audit.md` §11), not a defect, and doing it inside a hardening change would be the wrong order.

The count is also a proxy that is both too strict and too weak:

- **Too strict** — a legitimate squash-to-baseline history permanently has fewer snapshots than migrations, and would be permanently red.
- **Too weak** — equal counts do not prove the chain is _usable_. A snapshot can be present but stale, and generate would still mis-diff.

The property that actually matters is behavioural: **would generation produce a new file right now?** That is what the guard measures.

## 4. Guard design

`packages/db/src/scripts/check-migration-drift.ts` — `pnpm --filter @beaconhs/db check:migration-drift`

```
packages/db/src/schema/index.ts ──┐
packages/db/drizzle/ (journal + 25 snapshots) ──┤
                                          ▼
        temp dir: copy drizzle/ → out/  ──►  drizzle-kit generate  (cwd=temp, --out out)
                                          ▼
                        diff out/ before vs after
                                          ▼
                            classifyDrift()  ──►  exit 0 / 1
```

### Isolation

| Concern                  | How it is handled                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| repo config not used     | the repo `drizzle.config.ts` is **never loaded**; `--dialect`/`--schema`/`--out` are passed explicitly, so `out` cannot resolve to `packages/db/drizzle`  |
| `--out` must be relative | drizzle-kit prefixes `--out` with `.` and produces `.//abs/path` for an absolute path, which errors. The guard runs with `cwd` = temp dir and `--out out` |
| no database              | `generate` is offline; `DATABASE_URL` is cleared for the child process                                                                                    |
| cleanup                  | `mkdtempSync` + `rmSync` in a `finally`                                                                                                                   |
| self-proof               | the whole `packages/db/drizzle` tree is hashed before and after; a mismatch fails the guard with "this is a bug in the guard"                             |

`pnpm db:generate` is **not** used and is **not** invoked by the guard.

### Verdicts

Detection is by **directory diff**, but a diff is only trusted when the generator is known to have run to completion.

> **Finding 1 — the generator's exit code is not a verdict.** `drizzle-kit generate` **exits 0 even when it throws**, printing the stack trace to stdout. Verified against 0.31.10: an esbuild `TransformError` and a `TypeError` thrown from the schema module both exit 0.

> **Finding 2 — matching error strings is fail-open, and it was.** The first implementation detected a broken run with `/^\s*(Error|.*\bENOENT\b|.*\bCannot find\b)/m` and read anything else as "generated nothing" → `in-sync` → exit 0. That pattern misses any crash whose first line is not `Error`-prefixed, so a real `TypeError`, `EACCES`, `RangeError` or `error: …` from the generator was reported as a **clean pass**. This was reproduced with the real binary, not hypothesised.

The fix inverts the test. `classifyDrift` is **fail-closed**: a verdict of anything other than `tool-error` requires _positive evidence that the generator succeeded_, checked in this order.

| Step | Condition                                        | Result              |
| ---- | ------------------------------------------------ | ------------------- |
| 1    | the process reported failure (`toolFailed`)      | `tool-error`        |
| 2    | output was not captured                          | `tool-error`        |
| 3    | output contains no recognised **success** marker | `tool-error`        |
| 4    | only then is the directory diff trusted          | `in-sync` / `drift` |

The success markers are the two phrases drizzle-kit prints when, and only when, a run completes: `Your SQL migration file` and `No schema changes`. Both were captured from the real 0.31.10 binary.

`RECOGNISED_ERROR` is still present, but it only chooses the wording of the `detail` field. **No passing verdict depends on it**, so an unlisted failure shape is still caught by step 3 rather than being silently tolerated.

| Verdict      | Meaning                                                                                                                                  | Exit |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `in-sync`    | generation produced nothing                                                                                                              | 0    |
| _(removed)_  | **REMOVED in §13.** Existed only while the snapshot chain was incomplete and re-proposed a phantom.                                      |
| `drift`      | it proposed something that is **not** the recorded fingerprint — genuine new schema drift, or a removed migration, or an index collision | 1    |
| `tool-error` | generation failed; drift is **undetermined**                                                                                             | 1    |

`known-stale` was what made the guard usable while the snapshot chain was incomplete. It has since been **removed** — see §13. The guard now passes only on a genuine `in-sync`.

The fingerprint is a content hash, not a filename: drizzle-kit appends a random adjective (`0041_loving_hardball`, `0041_burly_starbolt`, `0041_purple_spiral`, `0041_unusual_hellion`) — verified identical body hash across runs.

## 5. CI integration

Added one step to `.github/workflows/ci.yml`, after `deadcode:check` and before the migration-apply steps:

```yaml
- name: Guard migration metadata integrity
  run: pnpm --filter @beaconhs/db check:migration-drift
```

It is placed before `Apply the production migration path` so drift is reported before migrations run. No new CI platform, no new dependency, no new secret. The step needs no `DATABASE_URL` and no Postgres service, but sits in the job that already has both.

Two end-to-end tests inside `packages/db` cover the generator, so `pnpm test` also fails on drift.

## 6. Phantom reproduction strategy

Both live tests run the **real** `drizzle-kit` binary against a **temp copy**, never the repo.

**Reproduce the phantom (proves the baseline is honest).** Seed a temp dir with a copy of `packages/db/drizzle`, generate, assert exactly one file appears at index `0041`. This test is deliberately shaped so that **when the snapshot chain is eventually repaired, this test fails** — a reminder to delete the baseline, not extend it.

**Catch a real phantom (proves the guard discriminates).** Build a temp schema that re-exports the real schema plus one extra table, then assert the verdict is `drift` and that the generated SQL contains `drift_guard_probe` — i.e. a change the migrations genuinely do not have is detected and not absorbed into the known-stale baseline.

Both clean up their temp dirs in a `finally`.

Evidence from the live runs in this task:

```
probe2/out/0041_loving_hardball.sql   38 statements, sha e9845cef…
temp out: 0041_burly_starbolt.sql + 0041_document_book_cover_template.sql   ← index collision
guard:    FAIL … would REUSE a committed migration index: 0041
```

**Test boundary, stated plainly:** the two end-to-end tests shell out to the `drizzle-kit` binary, so they require `node_modules/.bin/drizzle-kit` (a devDependency, always present after `pnpm install`). The remaining 21 tests are pure and run anywhere. If drizzle-kit is missing the E2E tests error rather than silently pass.

## 7. READ_PERMISSION_BY_CATEGORY invariant

`apps/web/src/lib/permissions.ts` gates public REST API reads with a hand-written category → permission map. TypeScript types the values as `CataloguePermission`, but **cannot** verify a hand-written string names a real key — a typo type-checks and then denies every read for that category at runtime.

`apps/web/src/lib/api/permissions.test.ts` (7 tests) reads the catalogue from `@beaconhs/db/schema` (no 93-key list restated) and asserts:

- all 9 exposed categories resolve
- every mapped key exists in `PERMISSION_CATALOGUE` — the typo guard
- no two categories share a permission
- the map is not a constant
- `readPermissionForEntity` throws for an unmapped category rather than failing open
- every `REPORT_ENTITIES` category has a catalogue-backed gate
- the known-ungated exclusion list is not stale

The map is module-private, so the test reaches it through its only consumer, `readPermissionForEntity`.

**Duplicate values are structurally impossible to assert directly** — the map is a `Record`, so a duplicate key would silently overwrite. The "no duplicate" test therefore covers duplicate _values_ (two categories, one permission), which is the real authorization risk: one read grant silently covering two modules.

### Finding — `compliance` and `apps` have no read gate (not fixed)

The entity sweep failed on first run and surfaced a real gap:

```
report entity categories without a catalogue-backed read gate: [ 'compliance', 'apps' ]
```

`REPORT_ENTITIES` ships these categories, but `READ_PERMISSION_BY_CATEGORY` has no entry for either, so `readPermissionForEntity` throws — this is the recorded `POST /api/v1 returns 500` defect (AGENTS.md §Environment and tooling issues). **Not fixed here:** adding a permission grant is a business-authorization decision and outside this task's scope. Both categories are listed in a `KNOWN_UNGATED` set with a second test asserting they are _still_ ungated, so fixing the defect forces the exclusion to be removed rather than left dead.

## 8. Files changed

Commit 9 — `ci(db): guard migration metadata against phantom generation`:

| File                                                    | Change                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/db/src/scripts/check-migration-drift.ts`      | **NEW** — guard; pure `classifyDrift` + isolated runner + repo-integrity self-check |
| `packages/db/src/scripts/check-migration-drift.test.ts` | **NEW** — 31 tests, incl. 2 end-to-end against the real generator                   |
| `packages/db/package.json`                              | added `check:migration-drift` only (additive; lockfile untouched)                   |
| `.github/workflows/ci.yml`                              | added one guard step                                                                |
| `docs/hse-migration-integrity-guard.md`                 | this document                                                                       |

The `package.json` hunk is staged selectively: the working tree also carries an unrelated `emit:cutover-verification` script belonging to a different work package, and it is **not** part of this commit.

Not touched: any migration SQL, `meta/_journal.json`, any snapshot, any schema file, `migrate.ts`, `drizzle.config.ts`, RLS, `BUILTIN_ROLES`, `PERMISSION_CATALOGUE`, or any authorization logic.

§7 above documents a **separate** change (the public API permission-map invariant, commit `6e112089`); it is recorded here for completeness and is not part of this commit.

## 9. Test results

| Gate                            | Result                                     |
| ------------------------------- | ------------------------------------------ |
| `check:migration-drift.test.ts` | **31 passed** (2 end-to-end, ~6.6s)        |
| `@beaconhs/db` full suite       | **292 passed** / 292, 52 files             |
| `@beaconhs/db` typecheck        | exit 0                                     |
| prettier (both guard files)     | clean                                      |
| guard run                       | `in-sync`, exit 0 (see §13 for the repair) |
| `packages/db/drizzle` hash      | identical before and after the run         |

## 10. Limitations

1. **RESOLVED in §13.** The guard now returns a genuine `in-sync`: the chain is understood, not tolerated.
2. **RESOLVED in §13.** There is no baseline any more. `KNOWN_STALE_DRIFT_SHA256` was deleted.
3. **Behaviour is pinned to drizzle-kit 0.31.10.** A version bump can change the generated SQL for the same schema, which reads as `drift`. That is a false positive to be reviewed, not silenced.
4. **E2E tests need the `drizzle-kit` binary** and take ~5s; they are not hermetic in the sense of being pure.
5. **No protection against manual journal editing.** A hand-edited journal that stays internally consistent would still be caught only if generation disagrees with the schema.
6. **RESOLVED in §13.** With no golden value there is no recorded value for a schema edit to coincidentally match.
7. **Fail-closed couples the guard to drizzle-kit's success wording.** Step 3 of the verdict requires `Your SQL migration file` or `No schema changes` to appear in the output. If a drizzle-kit upgrade rewords either phrase, the guard reports `tool-error` and CI goes red on a healthy tree. That is the intended direction of failure — a loud false positive rather than a silent false pass — but it is a coupling an upgrade must account for, and the same applies to a schema module that prints its own `No schema changes` text.
8. **`toolFailed` is the strongest signal but not a complete one.** It catches every non-zero exit and every spawn failure. The exit-0-while-crashing case is covered only by step 3, which infers failure from the absence of a success marker rather than from a positive error signature.

## 11. Future snapshot-chain repair recommendation

Not started. Suggested order:

1. Decide policy: **rebuild the chain from existing migrations** (keeps history, mechanical) vs **squash to a baseline** (cleanest, loses per-migration history). Recommend squash only if the migrations are already treated as a unit; otherwise rebuild.
2. Do it in its own change, with a database backup, on a scratch database first.
3. Re-run `check:migration-drift`; expect `in-sync`.
4. Delete `KNOWN_STALE_DRIFT_SHA256` and the "reproduces the phantom" test — they exist only to describe the broken state.
5. Optionally add a stricter `journal entries === snapshots` check, which only becomes meaningful once the chain is complete.

**This task did not repair the historical snapshot chain and did not run `db:generate` against the repository.**

## 12. Run log

See the task transcript. Guard result:

```
PASS (known stale snapshot chain, no new drift) db:generate would still re-propose the known
     phantom migration; the snapshot chain is incomplete … No NEW drift.
     would reuse committed migration index: 0041
GUARD_EXIT=0
```

## 13. Snapshot-chain repair (2026-10-02)

The recommendation in §11 was carried out, in the least invasive form available.

### Root cause

`meta/` held 25 snapshots against 43 journal entries, the last snapshot being
`0029_snapshot.json` (added 2026-08-05, the last commit that actually ran
`db:generate`). drizzle-kit walks **back from the newest journal entry** and diffs
the schema against the snapshot it finds, so it compared the current schema against
0029 and re-proposed every change committed as 0030-0043 — a phantom that re-creates
live objects, written under an index that collides with a committed migration. That
is why the guard needed a recorded fingerprint to pass at all.

### Fix

Added **`0043_snapshot.json`**, emitted by drizzle-kit itself from
`src/schema/index.ts`. drizzle-kit does **not** need one snapshot per historical
entry — it only needs the newest — so a single snapshot for the current migration
closes the gap without touching history.

`KNOWN_STALE_DRIFT_SHA256`, the `known-stale` verdict, the `baselineSha256` input and
the `newSqlBodies` plumbing were all **deleted**. There is no longer any state in
which proposing a migration is expected: a proposal now always fails.

### Evidence it is not fabricated history

1. **No committed migration was modified.** `git status` shows the 41 tracked
   `drizzle/*.sql` files unchanged; the only new SQL is `0043_companies.sql`. The
   journal diff is two appended entries.
2. **It chains correctly.** `0043_snapshot.prevId` equals `0029_snapshot.id`. The
   `0000`-`0029` snapshots are untouched and still chain by `prevId`.
3. **It matches the real migrated database.** The local `beaconhs` database was built
   by executing all 43 migrations in order via `pnpm db:migrate`. Comparing the
   snapshot against `information_schema` / `pg_enum` on that database gives an exact
   match: **194 tables, every column, and 108 enums with identical values.**
4. **`generate` now reports `No schema changes`** for the real schema, so
   `pnpm db:generate` is usable again instead of emitting a re-creating phantom.
5. **The guard still bites.** Removing `0043_snapshot.json` → `FAIL` exit 1. Mutating
   it so it no longer matches the schema → `FAIL` exit 1. Adding a probe table → a
   correct proposal containing `drift_guard_probe`, verdict `drift`.

### Known, deliberately NOT fixed: the index off-by-one

drizzle-kit names a proposal `NNN` where `NNN = journal.entries.length`. This
repo's file numbering ran **ahead** of its entry index, because the journal skips
`0033`: from idx 33 onward, `filename prefix = idx + 1`. So with 43 entries the
generator proposes `0043_…`, which **collides** with the committed
`0043_companies.sql`.

This is pre-existing and out of scope here: closing it means renumbering committed
migrations or inventing a journal entry, and §11.1 reserves that as a separate
decision. What this change guarantees is that the collision is **surfaced** by the
guard rather than passed off, and that a pinned test asserts it so the day it is
fixed the test says so.
