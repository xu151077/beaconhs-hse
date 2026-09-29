# OpenCode V2 Custom Tools — Evaluation Only

> **Decision: create no custom tools in this phase.** Five candidates were
> evaluated and deferred. Nothing was implemented.

---

## 中文摘要

**结论：本阶段不创建任何 custom tool。**

**评估前提：** 先确认「内置工具 + MCP + Skills」是否已经足够。结论是**足够**，
因此不创建。

**关键判断：** 五个候选 custom tool 中，有四个本质上是**把一次性分析脚本
固化成工具**——而这类需求用一次性的 `shell` + `grep` 就能完成。创建工具的
真实成本是：它会进入每一次会话的工具目录、增加上下文负担、并且需要长期维护。
只有当一个操作**反复出现、且每次都需要多步非平凡判断**时，工具才划算。

**唯一勉强够格的是 `hse-permission-audit`**，但它也暂缓到 Phase 10
（Permission / Project Scope）——因为在项目范围能力落地之前，
「审计 project scope」本身就没有稳定语义可审。

**下表五个候选全部保留在本文档中**，等 Phase 3/4/10 落地后再按需重新评估。

---

## 1. Sufficiency assessment

| Capability                   | Already available                           | Verdict    |
| ---------------------------- | ------------------------------------------- | ---------- |
| Find files                   | `glob`                                      | sufficient |
| Find text                    | `grep`                                      | sufficient |
| Read / understand code       | `read`, `explore` subagent                  | sufficient |
| Run a command once           | `shell`                                     | sufficient |
| Run the CI gates             | `shell` + the six `pnpm` scripts            | sufficient |
| Query the database read-only | `shell` + `docker compose … psql`           | sufficient |
| Current library docs         | context7 MCP                                | sufficient |
| Browser verification         | built-in `browser` + playwright MCP         | sufficient |
| Domain knowledge             | 12 skills                                   | sufficient |
| Role separation              | 9 agents                                    | sufficient |
| Inspect a change             | `git status/diff/log/show`, `code-reviewer` | sufficient |

**Nothing in the current workflow required a custom tool.**

## 2. The cost of a custom tool

Recorded so the bar stays honest:

1. **Context cost.** Registered tools appear in the catalog and their schemas are
   carried in the request. Twelve skills are cheap because they load on demand;
   a tool is not.
2. **Maintenance surface.** A tool is code that must keep compiling and passing
   `pnpm typecheck`, `pnpm lint`, `pnpm deadcode:check` and `pnpm test` — forever.
   A one-off script has none of that.
3. **Failure mode.** A tool that silently returns the wrong shape is worse than
   no tool, because the agent trusts it.
4. **Knip.** An unused custom tool export is dead code and **fails
   `pnpm deadcode:check`** — so it must be wired into something real to justify
   existing at all.

## 3. Candidates evaluated

### `hse-schema-inspect` — **deferred**

**Purpose:** summarise the HSE schema — tables, columns, enums, FKs, indexes —
for a module or a concept.

**Why deferred:** `grep 'pgTable('` plus `read` on the relevant schema files
answers this in one or two calls, and `explore` does it exhaustively. A tool
would only make the same information harder to audit.

**Revisit if:** a future phase introduces a canonical HSE model (`findings`,
`risks`) with enough tables that manual greps stop being reliable.

### `hse-permission-audit` — **deferred to Phase 10**

**Purpose:** check that a new permission key is in `PERMISSION_CATALOGUE`,
granted to the correct built-in roles, wired to a nav entry, a Manage hub and a
manual article — and that no scope or tier is left half-connected.

**Why deferred, not rejected:** this is the strongest candidate. It is
repetitive, rule-based, and easy to get subtly wrong by hand — and the
`permission-review` skill shows the failure modes are non-obvious (for example a
new `.read.project` tier would need `readTierCovers`' regex widened, or it would
silently never match).

**Why not now:** project-level scoping does not exist yet, so "is this
permission correctly scoped?" has no stable answer to check against. Building the
tool now would encode today's gap as the expected result.

**Revisit when:** Phase 10 (Permission / Project Scope) in
`docs/hse-development-baseline.md` §17 lands.

### `hse-project-scope-check` — **deferred to Phase 10**

**Purpose:** verify that a record query actually respects tenant and (once it
exists) project scope.

**Why deferred:** the current answer is structurally always "project scope is not
expressible", so the tool would report one permanent finding. That is a
documented defect (already in `docs/project-development-state.md`), not a tool's
job.

**Revisit when:** a `project`/`orgUnits` scope variant and a matching visibility
tier exist.

### `hse-migration-check` — **not justified**

**Purpose:** review a generated migration for destructive statements, missing RLS
registration, and non-idempotent SQL.

**Why not justified:** the `database-migration` skill already encodes the exact
seven-step order, the `psql` verification commands, and the prohibition on
destructive migration. This is a checklist, not an operation — it belongs in a
skill, and duplicating it as a tool would create two sources of truth.

### `hse-test-report` — **rejected**

**Purpose:** aggregate test results across the monorepo.

**Why rejected:** `turbo run test` already aggregates, and the six gates report
their own results. A second aggregator adds a translation layer between the
runner and the report, which is a new failure surface for no new information.

## 4. If a tool is ever built

Constraints to hold:

1. **Justify the gap first.** Write one sentence on what the tool does that
   `grep` + `read` + `shell` cannot. An empty sentence means do not build it.
2. **Local only.** `.opencode/plugins/<name>/index.ts` with the **V2** API:
   ```ts
   import { Plugin } from '@opencode/plugin'
   export default Plugin.define({
     id: 'beaconhs.hse-schema-inspect',
     async setup(ctx) {
       await ctx.tool.transform((editor) => {
         editor.add({ name: 'hse_schema_inspect' /* … */ })
       })
     },
   })
   ```
   V1 plugin implementations do **not** run in V2.
3. **Read-only by default.** Any tool that writes needs its own permission
   entry and a stated justification.
4. **No dangerous shell.** The plugin must never auto-run destructive commands.
5. **Typed and tested.** Strict TypeScript, plus a test per tool.
6. **Wired in.** A registered tool that nothing calls fails
   `pnpm deadcode:check`.
7. **Deterministic output.** Return data, not prose, so the model cannot
   misread a summary as a conclusion.
8. **Update the baselines.** A new tool changes
   `docs/opencode-plugin-baseline.md` and possibly
   `docs/opencode-permissions-baseline.md` in the same commit.

## 5. Decision record

| Date       | Decision                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-29 | No custom tools created. Four candidates deferred pending Phase 3/4/10; one rejected as skill duplication. All five retained here for re-evaluation. |
