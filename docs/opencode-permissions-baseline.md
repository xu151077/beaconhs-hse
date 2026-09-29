# OpenCode V2 Permissions Baseline — BeaconHS HSE

> Project permission model in `.opencode/opencode.jsonc`. V2 native shape: an
> **ordered array** of `{action, resource, effect}` rules. Last match wins.

---

## 中文摘要

**核心原则：shell 默认 `ask`，然后只放行一份**只读白名单**——而不是试图列举所有危险命令。**

这是 V2 官方权限文档明确建议的做法，理由是：shell 以宿主用户的全部
文件系统/进程/网络权限运行，而**从命令文本推断目录只是尽力而为**。用白名单
比用黑名单更稳。

**安全边界：**

| 类别                                                                | 效果                       |
| ------------------------------------------------------------------- | -------------------------- |
| `read` / `glob` / `grep`                                            | allow                      |
| 密钥文件读取                                                        | **deny**                   |
| 密钥文件编辑                                                        | **deny**                   |
| shell 通配                                                          | **ask**                    |
| 只读 git / pnpm / docker 只读子命令                                 | allow                      |
| `git push`                                                          | **deny**                   |
| `git reset` / `clean` / `restore` / `rebase` / `filter-branch`      | **deny**                   |
| `rm -rf` / `rm -f`                                                  | **deny**                   |
| `docker system prune` / `volume prune` / `compose down -v`          | **deny**                   |
| `drizzle-kit drop` / `push --force` / `psql DROP\|TRUNCATE\|DELETE` | **deny**                   |
| `--no-verify` / `eslint-disable` / `ts-ignore`                      | **deny**                   |
| `subagent` 通配                                                     | **deny**，仅放行 11 个角色 |
| `skill` 通配                                                        | **ask**，仅放行 13 个      |
| MCP 写操作                                                          | **ask**                    |

**顺序是本质。** OpenCode 按「基础策略 → 全局 permissions → agent permissions」
合并，**最后匹配的规则获胜**。因此每一条 deny 都必须放在它要击穿的宽泛 allow
**之后**。例如 `*.env.example` 的 allow 必须在 `*.env.*` 的 deny 之后，否则
模板文件会被误杀。

---

## 1. Model

V2 uses one ordered `permissions` array. Three fields per rule:

| Field      | Meaning                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `action`   | tool permission action (`read`, `edit`, `shell`, `subagent`, `skill`, …) |
| `resource` | path, command, agent ID, skill ID, URL, query                            |
| `effect`   | `allow`, `deny`, or `ask`                                                |

Matching uses simple whole-value wildcards: `*` (zero or more characters),
`?` (exactly one), everything else literal. **Last matching rule wins.** If no
rule matches, the default is `ask`.

Merge order: base policy → global `permissions` → agent `permissions`. Agent
rules are **appended**, not substituted.

### Actions in use

`read`, `edit`, `shell`, `glob`, `grep`, `subagent`, `skill`, `webfetch`,
`websearch`, `execute`, and MCP actions of the form `<server>_<tool>`.

Two notes that matter:

- `edit` covers **`edit`, `write` and `patch`**. One `edit` deny makes an agent
  genuinely read-only.
- `doom_loop` and `lsp` are **not** V2 Core permission actions. `lsp` appears
  only in the V1 schema — see `docs/opencode-lsp-baseline.md`.

## 2. The eight blocks

### Block 1 — read-only discovery: allow

```jsonc
{ "action": "read",  "resource": "*", "effect": "allow" },
{ "action": "glob",  "resource": "*", "effect": "allow" },
{ "action": "grep",  "resource": "*", "effect": "allow" }
```

These carry no host authority and are what every task needs first.

### Block 2 — secrets: deny (placed AFTER block 1)

```jsonc
{ "action": "read", "resource": "*.env",          "effect": "deny" },
{ "action": "read", "resource": "*.env.*",        "effect": "deny" },
{ "action": "read", "resource": "*.env.example",  "effect": "allow" },  // after the deny
{ "action": "read", "resource": "secrets/**",     "effect": "deny" },
{ "action": "read", "resource": "credentials/**", "effect": "deny" },
{ "action": "read", "resource": "*.pem",          "effect": "deny" },
{ "action": "read", "resource": "*.key",          "effect": "deny" },
{ "action": "read", "resource": "*.p12",          "effect": "deny" },
{ "action": "read", "resource": ".ssh/**",        "effect": "deny" },
{ "action": "read", "resource": "**/.aws/**",     "effect": "deny" },
{ "action": "read", "resource": "**/.npmrc",      "effect": "deny" },
{ "action": "read", "resource": "**/id_rsa*",     "effect": "deny" },
{ "action": "read", "resource": "**/id_ed25519*", "effect": "deny" },
```

**The ordering detail that makes this correct:** `.env.example` holds no live
value and must stay readable — it is the documented template. Because last match
wins, its `allow` must come _after_ the `*.env.*` deny, or the deny would kill
it. OpenCode's own base policy does exactly this ordering.

Editing secrets is denied separately and outright — an agent should never
rewrite a credential file:

```jsonc
{ "action": "edit", "resource": "*.env",          "effect": "deny" },
{ "action": "edit", "resource": "*.env.*",        "effect": "deny" },
{ "action": "edit", "resource": "secrets/**",     "effect": "deny" },
{ "action": "edit", "resource": "credentials/**", "effect": "deny" },
{ "action": "edit", "resource": "*.pem",          "effect": "deny" },
{ "action": "edit", "resource": "*.key",          "effect": "deny" },
{ "action": "edit", "resource": "**/.npmrc",      "effect": "deny" },
```

`docker-compose.yml` is `ask` rather than `deny`, because it is a legitimate file
to change when explicitly requested — but it is verified byte-identical to
`HEAD`, so an accidental edit should prompt:

```jsonc
{ "action": "edit", "resource": "docker-compose.yml", "effect": "ask" },
```

### Block 3 — shell: ask, then a narrow allowlist

```jsonc
{ "action": "shell", "resource": "*", "effect": "ask" },
```

Everything is `ask` first. Then only known-safe inspection is allowed:

| Allowed                                                                                                         | Why                                                        |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `git status*` `git diff*` `git log*` `git show*` `git ls-files*` `git ls-remote*` `git rev-parse*` `git blame*` | read-only inspection                                       |
| `git branch*`                                                                                                   | listing — with the destructive subcommands re-denied below |
| `pnpm --version*` `pnpm list*` `pnpm why*`                                                                      | package inspection, no install, no lifecycle scripts       |
| `pnpm exec tsc --version*` `node --version*`                                                                    | version readouts                                           |
| `docker compose* ps*` `docker compose* logs*`                                                                   | read-only service state                                    |

**Why an allowlist, not a denylist.** The V2 permissions guide warns that shell
runs with the host user's full filesystem, process and network authority, and that
directory inference from command text is best effort. Enumerating every dangerous
command is therefore unreliable — a narrow allowlist with `ask` as the default is
the robust shape. Anything not recognised prompts.

### Hard denials (after the allowlist, so they win)

```jsonc
// Publishing
{ "action": "shell", "resource": "git push*", "effect": "deny" },

// History and worktree destruction
{ "action": "shell", "resource": "git reset*",           "effect": "deny" },
{ "action": "shell", "resource": "git clean*",           "effect": "deny" },
{ "action": "shell", "resource": "git restore*",         "effect": "deny" },
{ "action": "shell", "resource": "git rebase*",          "effect": "deny" },
{ "action": "shell", "resource": "git filter-branch*",   "effect": "deny" },
{ "action": "shell", "resource": "git reflog expire*",   "effect": "deny" },
{ "action": "shell", "resource": "git gc --prune*",      "effect": "deny" },

// Branch destruction — these override the broad `git branch*` allow above
{ "action": "shell", "resource": "git branch -D*",          "effect": "deny" },
{ "action": "shell", "resource": "git branch -d*",          "effect": "deny" },
{ "action": "shell", "resource": "git branch --delete*",    "effect": "deny" },
{ "action": "shell", "resource": "git branch -m*",          "effect": "ask" },
{ "action": "shell", "resource": "git branch -M*",          "effect": "ask" },

// File destruction
{ "action": "shell", "resource": "rm -rf*",   "effect": "deny" },
{ "action": "shell", "resource": "rm -f*",    "effect": "deny" },
{ "action": "shell", "resource": ":(){*",     "effect": "deny" },
{ "action": "shell", "resource": "shred*",    "effect": "deny" },

// Infrastructure and database destruction
{ "action": "shell", "resource": "docker system prune*",       "effect": "deny" },
{ "action": "shell", "resource": "docker volume prune*",       "effect": "deny" },
{ "action": "shell", "resource": "docker compose* down -v*",   "effect": "deny" },
{ "action": "shell", "resource": "docker compose* down --volumes*", "effect": "deny" },
{ "action": "shell", "resource": "docker rmi*",                "effect": "deny" },
{ "action": "shell", "resource": "drizzle-kit drop*",          "effect": "deny" },
{ "action": "shell", "resource": "drizzle-kit push --force*",  "effect": "deny" },
{ "action": "shell", "resource": "prisma migrate reset*",      "effect": "deny" },
{ "action": "shell", "resource": "psql* DROP *",               "effect": "deny" },
{ "action": "shell", "resource": "psql* TRUNCATE *",           "effect": "deny" },
{ "action": "shell", "resource": "psql* DELETE FROM *",        "effect": "deny" },

// Gate circumvention — AGENTS.md rule 8
{ "action": "shell", "resource": "git commit --no-verify*", "effect": "deny" },
{ "action": "shell", "resource": "*--no-verify*",          "effect": "deny" },
{ "action": "shell", "resource": "*eslint-disable*",       "effect": "deny" },
{ "action": "shell", "resource": "*ts-ignore*",            "effect": "deny" },
{ "action": "shell", "resource": "*ts-expect-error*",      "effect": "ask" },
{ "action": "shell", "resource": "knip*--delete*",         "effect": "deny" },
{ "action": "shell", "resource": "prettier --write .*",    "effect": "ask" },
```

**`ts-expect-error` is `ask`, not `deny`,** because unlike `ts-ignore` it
documents an expected failure and is sometimes legitimate. It still requires a
human decision.

### Block 4 — Code Mode

```jsonc
{ "action": "execute", "resource": "*", "effect": "allow" }
```

`execute` gates whether the Code Mode runtime is available at all. Denying it
removes the **entire** catalog, including read-only helpers. Every nested tool
still enforces its own rule, so allowing `execute` does not bypass anything else.

### Block 5 — subagents: deny by default

```jsonc
{ "action": "subagent", "resource": "*",                "effect": "deny" },
{ "action": "subagent", "resource": "explore",          "effect": "allow" },
{ "action": "subagent", "resource": "general",          "effect": "allow" },
{ "action": "subagent", "resource": "architect",        "effect": "allow" },
… 9 project agents …
```

Only the roles this project actually needs. OpenCode additionally caps nesting
depth at 1, and every read-only agent denies `subagent` itself — so an unbounded
subagent chain is not reachable.

### Block 6 — skills: ask by default

The 12 project skills plus the built-in `report` skill are allowed. A skill added
later is not auto-loaded until someone adds an explicit allow.

### Block 7 — network

`websearch` open. `webfetch` allowed for OpenCode docs, OpenAI, localhost and
`127.0.0.1` — the last being needed for verifying the running app — and `ask`
for everything else.

### Block 8 — MCP tools

MCP actions are `<server>_<tool>` with resource always `*`. Each block starts
broad and narrows:

```jsonc
{ "action": "context7_*", "resource": "*", "effect": "allow" },

{ "action": "github_*",      "resource": "*", "effect": "ask" },
{ "action": "github_get_*",  "resource": "*", "effect": "allow" },
{ "action": "github_list_*", "resource": "*", "effect": "allow" },
{ "action": "github_search_*", "resource": "*", "effect": "allow" },
{ "action": "github_read_*", "resource": "*", "effect": "allow" },

{ "action": "playwright_*", "resource": "*", "effect": "ask" },
{ "action": "playwright_browser_snapshot*",         "resource": "*", "effect": "allow" },
… read-only browser verbs …
```

**Fail-safe by construction:** a GitHub write verb or an unfamiliar tool name
matches none of the allow prefixes and therefore stays `ask`. An unrecognised
tool is asked about rather than allowed.

**Known limitation, recorded not hidden:** OpenCode's **built-in** `browser`
namespace is all-or-nothing — a `browser` deny removes the whole catalog and
individual browser operations issue no permission prompts. It therefore cannot
be given the same read/write split as Playwright MCP. See
`docs/opencode-mcp-baseline.md` §4.

## 3. Rule-ordering rules to remember

1. **Last match wins.** A deny is only effective if it comes _after_ the broad
   allow it overrides.
2. Agent rules append; they do not replace the global array.
3. Multi-resource operations: any `deny` denies the whole operation; otherwise
   any `ask` asks; otherwise it proceeds.
4. A trailing ` *` also matches the bare command, so `git status *` covers
   `git status`.
5. Saved "allow always" approvals are durable project-scoped rules and **never
   override a configured `deny`**.

## 4. What is deliberately left as `ask`

Being explicit about what was _not_ automated:

- `pnpm test`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
  — globally `ask`. Individual agents (`test-engineer`, `release-manager`) allow
  the gates they need, so routine verification is smooth without making every
  agent able to run arbitrary builds everywhere.
- `docker compose … exec … psql` — `ask`. Read-only `SELECT` is safe but the same
  command shape carries `DROP`, so it needs a human.
- `pnpm db:migrate` and friends — `ask`. Schema changes are a deliberate act.
- `webfetch` to arbitrary hosts — `ask`.

This is the correct bias: the cost of an unnecessary prompt is seconds, and the
cost of a wrong `allow` is unrecoverable.

## 5. Hardening beyond permissions

Permissions are one layer. These are enforced elsewhere and are **not**
permission rules:

- `.opencode/agents/*.md` — the five read-only agents carry `edit` → `deny`, so
  read-only is a property of the agent, not just the session.
- `git-safety` skill — the prohibition and the recovery protocol.
- `release-manager` — denied `git push` both in its own rules and project-wide.
- `AGENTS.md` non-negotiable rules — the behavioural contract.

## 6. Maintenance

- Add a rule, then re-check ordering. A deny placed before its allow is inert.
- When a new agent or skill is added, add its explicit `subagent` / `skill`
  allow in the same commit, or it will be unreachable.
- Review saved approvals periodically; they persist project-wide.
- Keep the shell block an allowlist. If a rule needs a denylist to be safe, the
  allowlist is too broad.

## 7. Completion criteria

- Every shell category resolves to a definite effect.
- No secret file is readable or editable, and `.env.example` remains readable.
- `git push` and all four mandated destructive git commands are `deny`.
- Destructive infrastructure and database commands are `deny`.
- Gate-suppression flags are `deny`.
- Subagents and skills are deny-by-default with explicit allows.
- MCP write operations resolve to `ask`.
- Rule ordering is correct throughout — verified by reading top to bottom.
