# OpenCode V2 Agents Baseline — BeaconHS HSE

> 9 project agents under `.opencode/agents/`. Strictly separated remits. All
> frontmatter validated as V2.

---

## 中文摘要

**结论：建立 9 个 Agent，职责严格分离，两个 Reviewer 强制只读，`release-manager` 禁止 `git push`。**

**V2 Agent 文件格式（与 V1 的区别）：**

- 位置：`.opencode/agents/<name>.md`（V1 还支持 `agent/`、`mode/`、`modes/`）
- frontmatter：`description`、`mode`、`model`、`permissions`、`steps`、`hidden`、`color`
- **Markdown 正文 = system prompt**，不是 `prompt` 字段
- **禁止使用 V1 字段**：`prompt`、`permission`、`disable`、`maxSteps`、
  `temperature`、`top_p`、`tools`、`variant`、`subtask`

已用程序验证：9 个 agent 的 frontmatter 全部可解析，**没有任何一个使用 V1 遗留字段**。

**最关键的隔离：`edit` 权限。** V2 中 `edit` 这一个 action 同时覆盖
`edit`、`write`、`patch` 三个工具，所以「严格只读」只需要一条
`{action: edit, resource: "*", effect: deny}`。architect、hse-domain、
security-reviewer、code-reviewer、release-manager 五个 Agent 都有这一条。

---

## 1. The nine agents

| Agent               | Mode     | Mutability              | Remit                                                                         |
| ------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------- |
| `architect`         | subagent | **read-only**           | architecture, data models, dependencies, technical options, development plans |
| `hse-domain`        | subagent | **read-only**           | HSE concept mapping, lifecycle duplication, Builder vs native decision        |
| `backend`           | all      | implements              | server actions, route handlers, package logic, jobs, event wiring             |
| `frontend`          | all      | implements              | React components, pages, lists, forms, drawers, styling                       |
| `database`          | all      | implements              | schema, migrations, queries, RLS, indexes                                     |
| `security-reviewer` | subagent | **read-only**           | auth, authz, tenant isolation, RLS, IDOR, file access, secrets                |
| `code-reviewer`     | subagent | **read-only**           | correctness, regression, security, performance, types, tests, architecture    |
| `test-engineer`     | all      | implements + runs gates | test level selection, test authoring, gate failure triage                     |
| `release-manager`   | subagent | **read-only**           | gate verification, migration safety, docs, rollback, ship/no-ship verdict     |

## 2. Read-only enforcement

Five agents are strictly read-only. The mechanism is one rule, because in V2 a
single `edit` action covers `edit`, `write` and `patch`:

```yaml
permissions:
  - action: edit
    resource: '*'
    effect: deny
```

Applied by `architect`, `hse-domain`, `security-reviewer`, `code-reviewer` and
`release-manager`.

Their shells are additionally narrowed: they may run the git and package
inspection commands and, where relevant, the CI gates — but any mutation
requires approval, and destructive git is denied outright.

`release-manager` additionally carries:

```yaml
- action: shell
  resource: 'git push*'
  effect: deny
```

This matters because a release manager that can push can publish a red pipeline.
The denial is enforced at the project level too, so it cannot be bypassed by an
agent regardless of what the agent file says.

## 3. Mode choice

| Mode       | Meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| `subagent` | runs only in a child session, launched via the `subagent` tool |
| `primary`  | can be the session's main agent                                |
| `all`      | either                                                         |

**Reasoning agents are `subagent`.** `architect`, `hse-domain`,
`security-reviewer`, `code-reviewer` and `release-manager` exist to be consulted.
Making them `primary` would put a read-only reviewer in charge of a coding
session.

**Implementing agents are `all`.** `backend`, `frontend`, `database` and
`test-engineer` can be driven as a specialist child _or_ selected as the session
agent for focused implementation work.

`all` is an explicit choice, not an omission. Omitting `mode` on a new custom
agent defaults to `primary`, which would have been wrong for these four.

## 4. Responsibility separation

The point of splitting is that **no two agents can both edit the same concern**,
so a change has exactly one obvious owner.

### Schema is `database` alone

Only `database` edits `packages/db/**`. `backend` implements server logic and is
explicitly forbidden from touching schema or migrations. This prevents the
common failure where a server action change quietly adds a column.

### Server vs UI is a hard split

`frontend` states: _"Do not write server actions, route handlers, or schema."_
`backend` states: _"You do not touch React components, page layouts, or CSS."_
Neither can drift into the other's layer.

### Reviewers cannot fix

Both reviewers are read-only **and** instructed not to fix while reviewing,
because mixing review and implementation hides findings.

### Gates belong to `test-engineer`, the verdict to `release-manager`

`test-engineer` runs and triages gates. `release-manager` runs them again for
verification and renders the verdict. They cannot both: `release-manager` is
read-only, so it reports a failing gate rather than quietly repairing it.

### `architect` produces plans and stops

Its instructions say _"You produce designs and plans. You do not implement"_ and
_"Do not implement a plan. Hand it to the user."_

## 5. Skill loading per agent

Agents load skills on demand with the `skill` tool; the skills are not injected
into every prompt. Each agent names which skills it should load first:

| Agent               | Loads first                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `architect`         | `project-architecture`, `hse-domain`                                                       |
| `hse-domain`        | `hse-domain`                                                                               |
| `backend`           | `project-architecture`, then `api-design` / `permission-review` / `hse-domain` as relevant |
| `frontend`          | `project-architecture`, then `permission-review` / `ui-e2e`                                |
| `database`          | `database-migration`                                                                       |
| `security-reviewer` | `security-review`                                                                          |
| `code-reviewer`     | `code-review`                                                                              |
| `test-engineer`     | `test-engineering`                                                                         |
| `release-manager`   | `release-readiness`                                                                        |

## 6. Subagent chaining

Project permissions deny `subagent` by default and allow only the nine project
agents plus the two useful built-ins:

```jsonc
{ "action": "subagent", "resource": "*",                   "effect": "deny" },
{ "action": "subagent", "resource": "explore",             "effect": "allow" },
{ "action": "subagent", "resource": "general",             "effect": "allow" },
{ "action": "subagent", "resource": "architect",           "effect": "allow" },
…
```

Additionally, every read-only agent denies `subagent` entirely, and OpenCode
caps nesting depth at **1** by default. An agent therefore cannot build an
unbounded chain of child agents: a child can do work, but cannot fan out again.

## 7. Validation performed

Every agent file was parsed with a YAML parser and checked:

| Check                                                                                                                     | Result    |
| ------------------------------------------------------------------------------------------------------------------------- | --------- |
| Frontmatter parses                                                                                                        | 9 / 9     |
| `description` present                                                                                                     | 9 / 9     |
| `mode` is `primary`, `subagent` or `all`                                                                                  | 9 / 9     |
| `permissions` is an array                                                                                                 | 9 / 9     |
| Every rule has `action`, `resource`, `effect`                                                                             | all rules |
| Every `effect` ∈ {`allow`, `ask`, `deny`}                                                                                 | all rules |
| No V1 legacy field (`permission`, `prompt`, `disable`, `maxSteps`, `temperature`, `top_p`, `tools`, `variant`, `subtask`) | 9 / 9     |
| Body is substantive                                                                                                       | 9 / 9     |

One real defect was caught by this validation and fixed: `backend.md` had a
malformed YAML line (`- action: shell"` with a stray trailing quote) that would
have failed to parse. It was corrected before completion.

## 8. Built-ins retained

The four V2 built-ins remain available: `build` (primary, default),
`plan` (primary), `general` (subagent), `explore` (subagent). Hidden
maintenance agents are not selectable. V2 has no built-in `scout`.

No built-in was overridden or disabled — the project agents are additive.

## 9. Maintenance

- Adding an agent: create `.opencode/agents/<kebab-id>.md`; put the system prompt
  in the **body**, not in a `system` frontmatter field.
- A read-only agent needs exactly one line to be safe: `edit` → `deny`.
- Adding an agent also requires an explicit `subagent` allow rule in
  `.opencode/opencode.jsonc`, otherwise it cannot be launched.
- Keep remits non-overlapping. If two agents both edit the same layer, one of
  them does not need to exist.
