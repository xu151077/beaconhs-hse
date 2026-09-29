# OpenCode V2 Skills Baseline — BeaconHS HSE

> 12 project skills under `.opencode/skills/`. Each has one non-overlapping
> remit. All validated: kebab-case ID, `name`, `description`, substantive body.

---

## 中文摘要

**结论：建立 12 个 Skill，每个只负责一件事，彼此不重复，也不复制 `AGENTS.md` 的内容。**

**Skill ID 来自路径，不是 `name`**（官方文档明确说明）。因此目录名必须是小写
kebab-case 且与 ID 一致：`project-architecture/SKILL.md` → ID `project-architecture`。

**每个 Skill 都回答五个问题：**

1. 什么时候使用（`description` 就是模型发现它的依据）
2. 应该读取什么
3. 执行什么检查
4. 禁止什么
5. 完成标准是什么

**去重策略（关键设计）：** 12 个 Skill 按「关注点」切分，而不是按任务切分。
例如 `security-review` 关注认证/租户隔离/文件/密钥，`permission-review` 专注
Role/Permission/Scope/项目范围的**授权模型本身**——两者会交叉但不会重复。
`code-review` 只在第 3 项引用 security-review，不复述其检查清单。

---

## 1. Location and discovery

```
.opencode/skills/
├── project-architecture/SKILL.md
├── hse-domain/SKILL.md
├── database-migration/SKILL.md
├── security-review/SKILL.md
├── permission-review/SKILL.md
├── api-design/SKILL.md
├── ui-e2e/SKILL.md
├── code-review/SKILL.md
├── test-engineering/SKILL.md
├── git-safety/SKILL.md
├── documentation/SKILL.md
└── release-readiness/SKILL.md
```

Project `.opencode/skills/` is discovered automatically by OpenCode — no
`skills` config entry is required. Confirmed at runtime: all 12 appear in the
agent's available-skill list.

The `name` field is a **display label only**. The ID is the directory path.
Every directory here matches its ID and the recommended
`^[a-z0-9]+(-[a-z0-9]+)*$` pattern, so an agent loading the skill must use the
kebab-case ID, not the display name.

## 2. The twelve skills

| ID                     | Display name         | Single responsibility                                                                    | Explicitly defers to                      |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| `project-architecture` | Project Architecture | Where does this already exist? Which primitive must I reuse?                             | `hse-domain` for HSE classification       |
| `hse-domain`           | HSE Domain           | HSE record semantics; Finding/Risk/Action/Verification; Builder vs native                | `project-architecture` for layout         |
| `database-migration`   | Database Migration   | Safe schema change: inspect → design → generate → harden → register RLS → apply → verify | `database` agent for execution            |
| `security-review`      | Security Review      | Auth, RLS, IDOR, file access, capability URLs, secrets, logging                          | `permission-review` for the authz model   |
| `permission-review`    | Permission Review    | Role, Permission, Scope, Tenant, Project, object-level authorization                     | —                                         |
| `api-design`           | API Design           | Server actions, route handlers, `/api/v1` conventions                                    | —                                         |
| `ui-e2e`               | UI E2E               | Drive real browser flows with Playwright MCP                                             | —                                         |
| `code-review`          | Code Review          | Seven-pass review of a diff                                                              | `security-review`, `project-architecture` |
| `test-engineering`     | Test Engineering     | Choose the test level; write it; fix gates at the cause                                  | —                                         |
| `git-safety`           | Git Safety           | Protect working tree, untracked docs, `.env`, history                                    | —                                         |
| `documentation`        | Documentation        | Manual articles, walkthroughs, `docs/` truthfulness                                      | —                                         |
| `release-readiness`    | Release Readiness    | The six gates and the Definition of Done                                                 | all others for detail                     |

## 3. Anti-duplication design

The requirement was that no skill duplicates `AGENTS.md` or another skill. How
that was achieved:

### Against AGENTS.md

`AGENTS.md` states the **rule**. A skill states the **method**. For example:

- `AGENTS.md`: "every tenant table needs RLS coverage in `TENANT_SCOPED_TABLES`."
- `database-migration`: gives the seven-step order, the verification `psql`
  commands, and the completion criteria.

No skill restates the repo map, the validation commands, or the web conventions.

### Within the skill set

Skills were split by _concern_, not by _task_, so an agent loading two of them
gets two different lenses rather than two copies of one:

- `security-review` and `permission-review` are the clearest case. Security asks
  _"is this exploitable?"_; Permission asks _"what is the effective decision for
  this user, and is it correctly gated?"_ They meet at object-level
  authorization and each states where the other owns it.
- `code-review` invokes `security-review` and `project-architecture` rather than
  repeating their checklists.
- `release-readiness` aggregates gate outcomes; it does not re-explain how to
  write a test (`test-engineering`) or design a migration (`database-migration`).

### The five-question shape

Every skill answers, in its own words:

1. **When to use** — frontmatter `description` (this is what the model reads to
   decide relevance).
2. **What to read** — concrete `path:line` references.
3. **What to check** — commands and greps.
4. **What is forbidden** — hard stops.
5. **Completion criteria** — what "done" means for that skill.

## 4. Skills with specific mandated content

The task required certain skills to carry specific content. Verified present:

### `git-safety` — hard prohibitions

Names all four destructive commands explicitly:
`git reset --hard`, `git clean`, `git restore`, `git checkout --`, plus
`git rebase`, `git filter-branch`, `git reflog expire`, `git branch -D`,
`git push`.

Protects: user modifications, `docs/` (14 untracked docs with **no Git copy**),
the database, `.env`, and `docker-compose.yml`.

Also states the recovery protocol: stop, report immediately, establish what
changed, and **do not** attempt an automated recovery that itself runs a
destructive command.

### `database-migration` — mandatory ordering

Seven ordered steps: inspect schema → inspect migration history → **design** →
generate → harden SQL → register RLS → apply and verify.

Explicitly forbids running a destructive migration without approval, and forbids
`db:push` outside a scratch database.

### `security-review` — focus areas

Authentication, authorization, tenant isolation / RLS, project scope, IDOR,
file access, capability URLs, sensitive information, logging, secrets — all nine
are named sections.

### `permission-review` — focus areas

Role, Permission, Scope, Tenant, Project, object-level authorization — all six
are named sections, plus a six-step "effective permission" trace.

### `ui-e2e`

Requires Playwright MCP to verify real browser flows: login, forms, upload,
permissions, HSE workflow verification, UI regression.

### `code-review`

Seven passes named: correctness, regression, security, performance, types,
tests, architecture.

### `test-engineering`

Defines all six levels: unit, integration, E2E, database, permission,
regression.

### `release-readiness`

Checks all eight: tests, migration, security, permissions, docs, build,
deployment, rollback.

## 5. Validation performed

Every file was parsed and checked programmatically:

| Check                                           | Result  |
| ----------------------------------------------- | ------- |
| File exists at `.opencode/skills/<id>/SKILL.md` | 12 / 12 |
| Frontmatter parses as YAML                      | 12 / 12 |
| `name` present                                  | 12 / 12 |
| `description` present                           | 12 / 12 |
| ID matches `^[a-z0-9]+(-[a-z0-9]+)*$`           | 12 / 12 |
| Body is substantive (not a stub)                | 12 / 12 |

All 12 are advertised to the model at runtime — confirmed by their appearance in
the available-skills list during this session.

## 6. Permission wiring

`AGENTS.md` is not duplicated into the skills; instead the skills are gated in
`.opencode/opencode.jsonc`:

```jsonc
{ "action": "skill", "resource": "*",                       "effect": "ask" },
{ "action": "skill", "resource": "project-architecture",    "effect": "allow" },
…
{ "action": "skill", "resource": "release-readiness",      "effect": "allow" },
{ "action": "skill", "resource": "report",                 "effect": "allow" }
```

Deny-by-default with explicit allows means a skill added later is not silently
auto-loaded until someone intends it to be.

## 7. Maintenance

- Adding a skill: create `.opencode/skills/<kebab-id>/SKILL.md`, give it a real
  `description`, and add an explicit `skill` allow rule.
- Renaming: change the **directory**, not just `name` — the ID is the path.
- Before adding a skill, check that no existing skill owns that concern. Twelve
  is enough; a thirteenth is more likely to be duplication than coverage.
- Supporting files may sit beside `SKILL.md` (`scripts/`, `references/`); paths
  inside a skill are relative to its own directory.
