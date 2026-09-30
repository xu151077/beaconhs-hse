# Verification Hardening — Removing the Second Catalogue

> ## 中文摘要
>
> **结论：数据库和代码都是对的，错的是我手写的两份 permission key 列表。现已全部消除。**
>
> - `04-post-migrate.sql` 原来**手写 76 个 key**（目录共 93 个），漏了 19 个，导致 post-migrate 误报 **35 个 stray key**。
> - `05-rollback.sql` 的 36-key 数组曾**手写多了一个 `ca.read.all`**（应为 36，实为 37），被"snapshot ↔ rollback 精确集合比对"当场抓到并修正。
> - 两处错误的根因相同：**在 schema 之外维护了第二份 catalogue**。
>
> **修复设计（单一事实来源）：**
>
> ```
> packages/db/src/schema/iam.ts
>   └─ PERMISSION_CATALOGUE / BUILTIN_ROLES     ← 唯一事实来源
>        └─ packages/db/src/scripts/emit-cutover-verification.ts   ← 只读取，不复制
>             ├─ renderPostMigrateSql()  → 04-post-migrate.sql
>             └─ renderRollbackSql(snapshot) → 05-rollback.sql
> ```
>
> 生成器**不含任何手写 permission key**；生成的 SQL 里的每个 key 都来自 `iam.ts`。测试断言"生成的 SQL 必须包含目录的全部 93 个 key，且不得出现目录外的 key"，因此**手写列表一旦回归，测试立即失败**。
>
> - **rollback 的 36-key 数组仍然来自 snapshot**（不是 catalogue）——这是正确的：rollback 的职责是恢复历史快照，而不是按当前代码重新推导。已增加自动集合等价校验。
> - **本轮新发现并修复了第三个问题（F6）**：我第一版生成的 rollback 集合校验用了 `value = ALL (ARRAY[…])`，对 text 恒为 false，该分支**永远返回 0 行**——即 rollback 失败时也会显示"通过"。已改为 `NOT (… = ANY (…))`，并对真实数据库只读验证：当前未回滚的 foreman 行恰好报出 2 条真实差异（`extra_in_db = ppe.read.site`、`absent_but_in_snapshot = ppe.read.all`），证明该校验有鉴别力。
> - 新增 **38 个测试**：`permission-catalogue-contract.test.ts`（10）+ `emit-cutover-verification.test.ts`（28）。
> - **本轮复审又发现并修复两个 fail-open**：F7 —— 三个 PPE spot-check key 原本被从"目录外 key"检查中白名单豁免，等于**没有任何东西检查它们**；若 `ppe.read.all` 从目录退役，生成的 SQL 会继续检查一个没有角色能持有的 key，永久空转却始终"通过"。现改为渲染时对照真实目录校验，缺失即抛错。F8 —— CLI 注释里写的 `--` 分隔符会被 pnpm 原样转发成参数，导致工具以 `ENOENT` 堆栈崩溃而非打印 usage。详见 §7a。
> - 本阶段**未修改数据库、未运行 db:migrate/db:rollback、未修改 BUILTIN_ROLES / PERMISSION_CATALOGUE / migrate.ts / schema / migration / RLS**。
> - 顺带确认：重新生成的 `04-post-migrate.sql` 现在对真实数据库跑出 **0 stray key**、**0 baseline 差异**。

---

## 1. Current findings

| #   | Artefact                                                                         | Hand-written keys                   | Correct count | Effect                                                                         |
| --- | -------------------------------------------------------------------------------- | ----------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| F1  | `04-post-migrate.sql` (pre-fix)                                                  | 76 quoted keys                      | 93            | 19 keys missing → **35 false "stray key" findings**                            |
| F2  | `05-rollback.sql` (pre-fix)                                                      | 37-key array                        | 36            | stray `ca.read.all` → wrong rollback target                                    |
| F3  | `apps/web/src/lib/api/permissions.ts`                                            | 0                                   | —             | already derives `VALID_PERMISSIONS` from the catalogue ✅                      |
| F4  | repo tests (`scope.test.ts`, `*contract.test.ts`, `report-run-as-scope.test.ts`) | 0 full-catalogue literals           | —             | all reference 3–10 specific keys; no duplicated list ✅                        |
| F5  | `apps/web/src/lib/module-admin/registry.ts:251`                                  | `permission: 'equipment.read.self'` | —             | **key is not in the catalogue** — this is recorded defect **D1**               |
| F6  | generator's first draft, rollback set-equality check                             | —                                   | —             | **vacuous** — `value = ALL (ARRAY[…])` on text is always false (**fixed**, §5) |
| F7  | generator's spot checks were whitelisted out of the stray-key test               | 3 exempt keys                       | 0             | retiring one would leave dead SQL that still passes (**fixed**, §9)            |
| F8  | CLI documented a `--` separator pnpm forwards as an argument                     | —                                   | —             | documented form died with a raw ENOENT stack trace (**fixed**, §9)             |

F5 is pre-existing and on the known-defects register. I did **not** add a test that would fail on it, because fixing it is out of scope and would red the gate. It is reported below instead.

F6 is a defect I introduced in this pass and then found and fixed myself. It is recorded because it is the same failure class as F1/F2: **a check that cannot fail is worse than no check, because it reads as evidence.**

## 2. Root cause

Two verification artefacts re-declared the permission catalogue by hand, and each drifted:

- **F1** — an 80-key list was typed from memory; 19 keys were missing. When the post-migrate check ran, every role's legitimate keys looked "outside the catalogue", producing 35 false findings. The check was wrong; the database was right.
- **F2** — the rollback array was typed rather than derived; an extra `ca.read.all` was included.

Both are the same failure mode: **a hand-maintained copy of a value that already has a single source of truth.** The Phase 1.5 verification already learned this once, in the rollback script; the same mistake recurred in the post-migrate script. Root cause is not carelessness in one file — it is that nothing structurally _prevented_ a second copy.

## 3. Verification scripts changed

| File                                                        | Change                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/db/src/scripts/emit-cutover-verification.ts`      | **NEW** — generates both SQL artefacts; imports the catalogue, declares no keys |
| `packages/db/src/scripts/emit-cutover-verification.cli.ts`  | **NEW** — runnable wrapper: snapshot file + out dir → two `.sql` files          |
| `packages/db/src/scripts/emit-cutover-verification.test.ts` | **NEW** — 28 tests, including the anti-hand-list guards                         |
| `packages/db/src/permission-catalogue-contract.test.ts`     | **NEW** — 10 tests on catalogue/baseline invariants                             |
| `packages/db/package.json`                                  | added script `emit:cutover-verification` (additive; lockfile untouched)         |
| `/tmp/opencode/phase15-cutover-v2/04-post-migrate.sql`      | regenerated from source                                                         |
| `/tmp/opencode/phase15-cutover-v2/05-rollback.sql`          | regenerated from snapshot                                                       |

`knip.ts` needed **no** change — the generator is reachable through its test, so `deadcode:check` passes as-is.

## 4. Catalogue single-source-of-truth design

Before, a permission key had to be added in **two** places; after, in **one**:

```
iam.ts  ──►  emit-cutover-verification.ts  ──►  04-post-migrate.sql
   │                     │
   │                     └──►  emit-cutover-verification.test.ts
   │                             └─ asserts generated SQL ⊇ PERMISSION_CATALOGUE
   │                             └─ asserts generated SQL ∌ anything outside it
   │
   └──► permission-catalogue-contract.test.ts
         └─ every BUILTIN_ROLES baseline ⊆ PERMISSION_CATALOGUE
         └─ tenant_admin === PERMISSION_CATALOGUE
         └─ foreman: has ppe.read.site, has NOT ppe.read.all
```

Three properties make this durable rather than aspirational:

1. **The generator declares no keys.** Adding a permission to `iam.ts` immediately appears in the generated SQL with no edit anywhere else.
2. **A test fails if the derivation breaks.** `renderPostMigrateSql()` must contain every catalogue key and nothing outside it. If someone pastes a literal list back in, the emitted set stops matching and the test goes red.
3. **The rollback path is deliberately different** and is _not_ coupled to the catalogue — see §5.

### Eliminated hand-written lists

| Artefact                              | Before                          | After                                                                           |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `04-post-migrate.sql` stray-key check | 76 hand-typed keys (19 missing) | `PERMISSION_CATALOGUE` interpolated at generation time — **93 keys, 0 outside** |
| `05-rollback.sql` permission array    | 37 hand-typed keys (1 spurious) | read from the snapshot file — **36 keys, exact set match**                      |

Verified on the emitted output:

```
04-post-migrate.sql   distinct keys=93   outside catalogue=0
05-rollback.sql       distinct keys=37   outside catalogue=0   (36 + the 3 PPE spot checks)
```

The three PPE keys (`ppe.read.self` / `.site` / `.all`) remain as **deliberate spot checks** — they are assertions about the change under test, not a catalogue substitute.

They are also the **only** permission-shaped strings the generator writes that are not read from the catalogue, which makes them the one place the emitted SQL could drift from the schema. They used to be whitelisted out of the stray-key test, which meant retiring one of them would leave the generated verification checking a key no role can hold — permanently vacuous, still green. The whitelist is gone: the generator now validates them against `PERMISSION_CATALOGUE` on every render and **throws** if any is missing, and the test asserts both that they exist and that they are genuinely emitted. See §9 F7.

## 5. Rollback snapshot strategy

The rollback array is **intentionally not** derived from the catalogue.

A rollback restores _what the row was_, not _what the code now says_. If the catalogue moves between the snapshot and the rollback, a catalogue-derived array would silently restore the wrong permissions. So `renderRollbackSql(row)` takes the snapshot row and emits it verbatim.

That is safe only if the array provably equals the snapshot, so the generator now emits a self-check inside the transaction, before `COMMIT`:

```sql
SELECT 'extra_in_db' AS problem, value
  FROM jsonb_array_elements_text((SELECT permissions FROM roles WHERE id = …))
 WHERE NOT (value = ANY (ARRAY[<snapshot keys>]))
UNION ALL
SELECT 'absent_but_in_snapshot', v.value
  FROM jsonb_array_elements_text('<snapshot>'::jsonb) AS v(value)
 WHERE NOT EXISTS (… r.permissions ? v.value);
-- EXPECT: 0 rows
```

The generated SQL also keeps the state guards (`has ppe.read.site`, `NOT has ppe.read.all`, `= 36`, exact id/tenant/key/`is_built_in`) so a rollback can never double-apply or hit the wrong row.

Verification: `snapshot=36  rollback=36  EXACT SET MATCH=True`, `ppe.read.all=True`, `ppe.read.site=False`.

### A check that could not fail (F6, found and fixed here)

My first draft of that self-check used `WHERE value = ALL (ARRAY[…])` to find keys present in the database but absent from the snapshot. For a **text** column, `= ALL` means "equals _every_ element", which is false for every real value — so the branch returned **0 rows unconditionally**. It would have printed "0 rows" after a rollback that restored the wrong permissions.

That is a worse defect than F1, because it manufactures false assurance rather than false alarms. It is fixed to `NOT (value = ANY (ARRAY[…]))`, and a test now pins the operator so the vacuous form cannot come back.

**Proven non-vacuous against the live database** (read-only, `SELECT` only, no `UPDATE`): running the fixed check against the current, not-yet-rolled-back foreman row reports exactly the two real differences —

```
         problem         |     value
------------------------+---------------
   extra_in_db            | ppe.read.site
   absent_but_in_snapshot | ppe.read.all
(2 rows)
```

A correctly applied rollback yields 0 rows; the pre-rollback state yields exactly 2. The check therefore has discriminating power, which the previous version did not.

## 6. New tests — 38 total

`permission-catalogue-contract.test.ts` (10)

- catalogue has no duplicate keys
- no empty / whitespace-only key
- `tenant_admin` === full catalogue
- every key is a lowercase dotted path with a module prefix (hyphens legal in non-first segments, e.g. `admin.api-keys.manage`)
- every `*.read.<tier>` family uses a tier `readTierCovers` can resolve — `all` / `site` / `self` / `others` — so a typo like `incidents.read.All` cannot silently floor the module to `self`
- **every** `BUILTIN_ROLES` baseline ⊆ `PERMISSION_CATALOGUE` (reported per role)
- no duplicate key within a role
- worker: `ppe.read.self`, and **not** `.site` / `.all`
- foreman: `ppe.read.site`, **not** `ppe.read.all`, has `equipment.read.site`, keeps `ppe.issue` / `ppe.inspect`
- safety_manager: `ppe.read.all`

Deliberately **not** asserted: that a family granting `read.all` also lists `read.site`. `training` grants `all` + `self` and no `site`, and that is correct — `readTierCovers` derives weaker tiers at runtime, so the catalogue stores explicit grants and the ladder supplies the rest. An earlier draft of this file asserted the implication and failed; the assertion was wrong, not the schema.

`emit-cutover-verification.test.ts` (28)

- accessors read the catalogue and baselines from the schema; unknown role throws
- generated post-migrate SQL embeds **every** catalogue key (no missing)
- generated SQL embeds **no** key outside the catalogue — with the spot checks **no longer whitelisted**
- the three spot-check keys are present in the real catalogue, and are genuinely emitted
- rendering is refused when a spot-check key is absent from the catalogue, while the intact catalogue still renders
- generated SQL is byte-for-byte reproducible across calls
- checks the three PPE tiers and the target row/tenant
- diffs **every** built-in role against its declared baseline
- generated SQL contains **no write statement**
- snapshot parser: reads a well-formed row, ignores blank lines/whitespace, marks custom roles
- snapshot parser **rejects** a truncated row, a row missing a required column, and permissions that are not a string array
- rollback restores the snapshot set exactly, introduces no non-snapshot key
- rollback guards exact role/tenant/built-in/count
- rollback is state-guarded
- rollback uses a **non-vacuous** symmetric set-equality check (`NOT (… = ANY)`, never `= ALL`) — the F6 regression guard
- rollback wraps BEGIN → verify → COMMIT in order
- a snapshot containing an unknown key is preserved verbatim (the generator reports, it does not filter)
- CLI strips a task-runner `--` separator instead of reading it as a path
- CLI exits **2** with a usage line for no arguments, and for a bare `--`
- CLI exits **1** when the snapshot has no foreman row, and leaves no half-written artefacts
- CLI exits **0** and writes both artefacts, containing real catalogue keys, on a valid snapshot

## 7. Risk

| Risk                                                    | Severity      | Note                                                                                                                            |
| ------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Generator emits SQL that no one runs                    | Low           | CLI is wired via `pnpm --filter @beaconhs/db emit:cutover-verification`; output verified byte-identical to the in-use artefacts |
| `renderPostMigrateSql` embeds 93 literals → large SQL   | Cosmetic      | readability only; the whole point is that it is derived                                                                         |
| Baseline check `[4]` masks differing roles              | None          | keyed by `role_key`; 0 rows only when every role matches                                                                        |
| A future hand-list reintroduction                       | **Prevented** | the coverage test fails immediately                                                                                             |
| `module-admin/registry.ts:251` D1 still unasserted      | Medium        | pre-existing; adding a test would red the gate without a fix in scope                                                           |
| A retired catalogue key stays undetectable              | Medium        | `tenant_admin` holds the whole catalogue, so an orphan-key check is vacuous — see §8.5                                          |
| Bare `emit:cutover-verification <snap>` writes into CWD | Low           | `outDir` defaults to `.`; neither target filename exists in the repo — see §8.6                                                 |
| `row.key` is interpolated unescaped into rollback SQL   | Low           | operator-supplied, not a trust boundary; malformed SQL rather than injection — see §8.7                                         |

## 7a. Defects found while auditing this work (fixed here)

### F7 — the spot checks were a fail-open

The three PPE spot-check keys were whitelisted out of the "no key outside the catalogue" test, on the reasoning that they are deliberate assertions rather than a catalogue substitute. That reasoning was right and the implementation was still wrong: **whitelisting meant nothing checked them.**

The consequence is the same failure class as F1/F2, one level up. Retire `ppe.read.all` from `PERMISSION_CATALOGUE` and the generator would keep emitting

```sql
permissions ? 'ppe.read.all' AS ppe_all_must_be_false
```

against a key no role can ever hold. The check would return "as expected" forever, the suite would stay green, and the cutover's central assertion — that the target role is site-scoped for PPE rather than register-wide — would have been silently checking nothing. Reproduced against the real catalogue before the fix.

The fix inverts the burden. `CUTOVER_SPOT_CHECK_KEYS` is now exported, validated against `PERMISSION_CATALOGUE` on every render, and a missing key **throws** rather than emitting. The whitelist is gone from the stray-key test, so those three keys are now held to the same standard as every other key, and a separate test asserts they exist _and_ are genuinely emitted, so the assertion cannot itself pass vacuously.

### F8 — the CLI's documented invocation did not work

The header read:

```
pnpm --filter @beaconhs/db emit:cutover-verification -- <snapshotFile> [outDir]
```

pnpm forwards that `--` to the script as a literal argument. It is truthy, so the "no snapshot given" guard was skipped, `--` was opened as a file, and the tool died with a raw Node `ENOENT` stack trace instead of its usage line. The form without `--` worked, so the bug was invisible to anyone who had already run it before writing the comment.

Fixed by stripping argument separators before interpreting `argv`, correcting the documented form, and exporting `main` so the exit-code contract became testable at all. All three exit paths are now covered: `2` for misuse, `1` for a refused snapshot (asserting no half-written artefacts are left behind), and `0` for success with real catalogue keys in the output.

### Still not covered

`main` catches nothing, so an unreadable snapshot or a render-time throw surfaces as a Node stack trace and exit 1. That is the right default for a cutover tool — a trace beats a tidy message that hides the cause — but it is untested, because provoking a throw would mean constructing an input the parser already rejects.

## 8. Unresolved

1. **D1 — `module-admin/registry.ts:251` uses `'equipment.read.self'`, which is not in the 93-key catalogue.** Confirmed against `iam.ts` (equipment has only `read.all` and `read.site`). This module-admin entry therefore never matches a real permission. Already on the known-defects register; out of scope here. Recommend a follow-up that either adds the key or corrects the reference **and** adds the invariant test.
2. ~~A cheap future invariant for `READ_PERMISSION_BY_CATEGORY`~~ — **done.** `apps/web/src/lib/api/permissions.test.ts` (commit `6e112089`) now asserts every category names a key that exists in `PERMISSION_CATALOGUE`, and pins the known-ungated `compliance` / `apps` entries so the exclusion cannot go stale.
3. **Snapshot files live in `/tmp`** and are not version-controlled. The rollback's correctness depends on `01-snapshot-roles.tsv`; if `/tmp` is cleared, the pre-cutover foreman state is unrecoverable except by re-deriving it (which is exactly what a catalogue-derived rollback would do, and exactly what §5 argues against). Consider storing snapshots under a non-`/tmp` path for any future cutover.
4. **The phantom-migration trap is still live, but it is now guarded.** `meta/` is still missing 16 snapshots, so anyone running `pnpm db:generate` still gets a destructive phantom `0041_*.sql`. Commit `65dfabe8` added `packages/db/src/scripts/check-migration-drift.ts` as a CI step, which tolerates exactly that known phantom and fails on anything beyond it. See `docs/hse-migration-integrity-guard.md`. The underlying chain is still unrepaired.
5. **A stale catalogue key cannot be detected — the check would be vacuous.** `tenant_admin` holds the full catalogue by definition, so every catalogue key is granted to at least one role and an "orphan key" invariant would always pass. Retiring a key therefore leaves it in `PERMISSION_CATALOGUE` with no test failure. Detecting it needs a usage-minus-catalogue comparison against live tenant roles, which is a business decision about role grants, not a mechanical check. **Design limitation, not fixed here.**
6. **`outDir` defaults to `.`, so a bare `emit:cutover-verification <snapshot>` writes `04-post-migrate.sql` and `05-rollback.sql` into the current directory** — which is `packages/db` under the package script. Neither file exists in the repo today, so there is no overwrite risk, but the default is a foot-gun. **Design limitation, not fixed here** (changing the default would break the documented invocation contract).
7. **`renderRollbackSql` interpolates `row.key` into SQL without escaping.** The value comes from an operator-supplied snapshot, not from an untrusted request, and an operator who can write the snapshot can already write arbitrary SQL files — so this is a robustness gap rather than a privilege boundary. A role key containing an apostrophe would produce malformed SQL rather than an injection. **Reported, not fixed**, because escaping would alter the generated text that other artefacts are diffed against.
