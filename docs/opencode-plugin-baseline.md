# OpenCode V2 Plugins Baseline — BeaconHS HSE

> **Decision: install no plugins.** Built-ins plus the 12 skills and 9 agents
> already cover every identified need. No local plugin was created either — the
> one guard that was tempting is better expressed as a permission rule.

---

## 中文摘要

**结论：不安装任何插件，也不创建本地插件。**

**理由（逐条对应任务书要求）：**

1. **不要为了「插件数量」安装插件** —— 没有为了数量装任何东西。
2. **不要安装未经验证 / 不明来源 / 会上传源码的插件** —— 一个都没装。
3. **如果现有插件已经足够，不要增加** —— 判定为足够，因此不增加。
4. **优先考虑项目本地 V2 plugin 而不是装大量 npm 插件** —— 没有「缺少功能」
   需要补，所以本地 plugin 也没有必要。

**最关键的一条判断：** 任务书提到「项目状态检查 / 开发流程 guard / 自动提醒」
可以用本地 plugin 实现。但本次评估发现，**真正需要的那个 guard（禁止
`git reset --hard` 等）用 permissions 的 `deny` 实现比 plugin hook 更强**——
`deny` 是强制阻断，hook 只是可以被打断的回调。所以本地 plugin 被判定为
不必要，而不是「顺手写一个」。

**如果将来确实需要本地 plugin**，本文档第 6 节给出了正确的 V2 API 写法
（`Plugin.define({ id, setup(ctx) })` + `@opencode/plugin`），并说明 V1 plugin
实现在 V2 **完全不能运行**，必须重写。

---

## 1. Inventory

### Project plugins

```
$ opencode plugin list
No plugins found
```

The project's `.opencode/plugins/` directory does not exist, and nothing is
listed in `plugins` in `.opencode/opencode.jsonc`. This is deliberate.

### Built-in plugins

`opencode plugin list --builtin` returns the official OpenCode plugins that ship
with v2.0.18. They fall into these families:

| Family             | Examples                                                                                                                                                                                                                                                    | Purpose                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Config**         | `opencode.config.agent`, `.command`, `.compaction`, `.formatter`, `.image`, `.instruction`, `.location-watcher`, `.mcp`, `.policy`, `.provider`, `.reference`, `.shell`, `.skill`, `.snapshot`, `.tool-output`, `.websearch`, `.worktree`, `.compatibility` | the config surfaces this project actually uses |
| **Agent**          | `opencode.agent`                                                                                                                                                                                                                                            | agent system                                   |
| **Command**        | `opencode.command`                                                                                                                                                                                                                                          | command system                                 |
| **Browser**        | `opencode.browser`                                                                                                                                                                                                                                          | the built-in `browser` Code Mode namespace     |
| **Plan**           | `opencode.plan`                                                                                                                                                                                                                                             | the `plan` agent                               |
| **MCP**            | `opencode.mcp.codemode.defaults`                                                                                                                                                                                                                            | MCP Code Mode defaults                         |
| **Compaction**     | `opencode.compaction.native`                                                                                                                                                                                                                                | native provider compaction                     |
| **Model / prompt** | `opencode.models.dev`, `opencode.prompt.*` (anthropic, arcee, identity, kimi, meta, openai, verbosity)                                                                                                                                                      | provider adapters                              |
| **Provider**       | `opencode.provider.*` (amazon.bedrock, azure, cerebras, cloudflare.ai, cohere, digitalocean, …)                                                                                                                                                             | model providers                                |

**Assessment: the official built-ins already cover every capability this project
needs.**

| Need                             | Covered by                                               |
| -------------------------------- | -------------------------------------------------------- |
| Configuration                    | the `opencode.config.*` family                           |
| Agents and skills                | `opencode.config.agent`, `opencode.config.skill`         |
| MCP                              | `opencode.config.mcp` + `opencode.mcp.codemode.defaults` |
| Permissions / policy             | `opencode.config.policy`                                 |
| Interactive browser verification | `opencode.browser`                                       |
| Documentation lookup             | the context7 MCP                                         |
| Scripted E2E                     | the playwright MCP                                       |
| Domain knowledge                 | the 12 project skills                                    |
| Role separation                  | the 9 project agents                                     |

Nothing is missing. Adding a plugin would duplicate one of these.

## 2. Candidate evaluation

Each candidate was assessed against: is it official or high-trust, is it
maintained, does it upload source, and does it fill a real gap.

| Candidate type                                         | Verdict                                     | Reason                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telemetry / analytics plugin                           | **Rejected**                                | Unknown data posture; the task explicitly excludes anything that uploads source. No legitimate need.                                                                                                                                                       |
| UI / theme plugins                                     | **Rejected**                                | Cosmetic; not relevant to a large backend project; unknown provenance.                                                                                                                                                                                     |
| Another documentation MCP or search plugin             | **Rejected**                                | Already covered by context7 + built-in `websearch`/`webfetch`. Duplicate.                                                                                                                                                                                  |
| Another browser automation plugin                      | **Rejected**                                | Already covered by the built-in `browser` namespace and the playwright MCP. Duplicate.                                                                                                                                                                     |
| A code-generation or "AI pair programmer" agent plugin | **Rejected**                                | Unknown provenance and prompt-injection surface; agents in this project are reviewed and local.                                                                                                                                                            |
| Database MCP                                           | **Rejected**                                | `read`/`grep` plus `psql` cover it; extra server means extra attack surface.                                                                                                                                                                               |
| Formatter plugin                                       | **Rejected**                                | Prettier is already a repo gate; a formatter plugin would duplicate it and could fight `pnpm format:check`.                                                                                                                                                |
| Git workflow plugin (auto-commit, auto-PR)             | **Rejected**                                | Directly contradicts the project's git-safety posture. An agent that can commit or push autonomously removes the human checkpoint.                                                                                                                         |
| A local **guard** plugin                               | **Rejected — better done with permissions** | See §3.                                                                                                                                                                                                                                                    |
| A local **project-state** plugin                       | **Deferred**                                | The state file `docs/project-development-state.md` is already the durable record and is enforced by the `documentation` skill and `AGENTS.md`. A plugin would add a second source of truth that could drift. Revisit only if a real repeated need appears. |

## 3. Why no guard plugin

The one plugin that seemed genuinely useful was a development guard — block
`git reset --hard`, warn before destructive operations, remind about gates.

**A permission rule is strictly stronger than a plugin hook here.**

|                       | permission `deny`                                | plugin hook                                                         |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| Enforcement           | hard block before the command runs               | an advisory callback that can be skipped, mis-ordered, or fail open |
| Visibility            | the user sees exactly which rule blocked and why | may be silent                                                       |
| Configuration surface | declarative, reviewable                          | code                                                                |
| Failure mode          | fails closed                                     | a throw in setup can disable the guard entirely                     |

So the guard is implemented as permission denials instead:

```jsonc
{ "action": "shell", "resource": "git push*",   "effect": "deny" },
{ "action": "shell", "resource": "git reset*",  "effect": "deny" },
{ "action": "shell", "resource": "git clean*",  "effect": "deny" },
{ "action": "shell", "resource": "git restore*","effect": "deny" },
{ "action": "shell", "resource": "git rebase*", "effect": "deny" },
```

The **behavioural** half of the guard — the recovery protocol, what to protect,
how to report a mistake — lives in the `git-safety` skill, because that part is
guidance for a judgement call, not a mechanical block. Splitting the two this way
puts each half in the mechanism that actually suits it: mechanical blocks in
permissions, judgement guidance in a skill.

This is also why the project's `.opencode/opencode.jsonc` references no plugin at
all — the guard requirement is fully satisfied without one.

## 4. V1 plugin incompatibility — do not copy old examples

If a plugin is ever added, it must use the **V2 plugin API**. The V1→V2 migration
guide is explicit and emphatic:

> "**V1 plugin implementations do not run in V2.** Moving a file or renaming its
> config entry is not enough."
> — https://opencode.ai/v2/docs/migrate-v1

V1 plugins were plain exported functions taking a plugin input object. In V2 they
**silently do nothing**. Any example found online for a V1 plugin will appear to
work while having no effect — which is worse than an outright error.

Config also changed: `plugin` → `plugins`, and the package-and-options tuple
became an object.

## 5. Verification of the current state

| Check                         | Method                           | Result                                               |
| ----------------------------- | -------------------------------- | ---------------------------------------------------- |
| No project plugins            | `opencode plugin list`           | `No plugins found`                                   |
| Built-ins intact              | `opencode plugin list --builtin` | official families present                            |
| No plugin shadowing built-ins | config review                    | `plugins` key absent from `.opencode/opencode.jsonc` |
| No unknown agent plugin       | review of `.opencode/agents/`    | 9 local, reviewed, V2 frontmatter                    |

## 6. If a local plugin becomes necessary

The correct V2 shape, for reference. **Not created in this change.**

Location — auto-loaded, no config entry required:

```
.opencode/plugins/<name>/index.ts
```

```ts
import { Plugin } from '@opencode/plugin'

export default Plugin.define({
  id: 'beaconhs.guard',
  async setup(ctx) {
    // ctx.app, ctx.location, ctx.options, ctx.storage
    // Domains: ctx.agent, ctx.tool, ctx.skill, ctx.mcp, ctx.command,
    //           ctx.permission, ctx.vcs, ctx.session, ctx.event, …
    return () => {
      // cleanup
    }
  },
})
```

Configuration with options uses the object form:

```jsonc
{
  "plugins": [{ "package": "./.opencode/plugins/beaconhs-guard", "options": { "strict": true } }],
}
```

Hard constraints on any future plugin:

1. **V2 API only.** `Plugin.define({ id, setup(ctx) })` from
   `@opencode/plugin`. Never the V1 default-function form.
2. **Never auto-run dangerous shell.** A plugin must not execute destructive
   commands on the user's behalf.
3. **Fail closed, and fail loudly.** If a guard throws, say so — do not degrade
   to permissive.
4. **No telemetry, no source upload, no network egress** unless explicitly
   requested.
5. **Keep it local.** Prefer `.opencode/plugins/` over an npm dependency, so the
   behaviour is reviewable in the repository.
6. **Justify the gap first.** Write down what it does that skills + agents +
   permissions cannot. If that sentence is empty, do not write the plugin.

### Useful V2 plugin surfaces for a future need

| Surface                           | Use                                                              |
| --------------------------------- | ---------------------------------------------------------------- |
| `ctx.tool.transform`              | register a custom tool (see `docs/opencode-tools-evaluation.md`) |
| `ctx.session.hook("prompt", …)`   | inspect or redact inbound prompts before admission               |
| `ctx.session.hook("context", …)`  | adjust the outgoing request, e.g. remove tools or set options    |
| `ctx.agent.transform`             | adjust agent descriptions or the default agent                   |
| `ctx.vcs.status()` / `.diff()`    | read working-copy state for a status indicator                   |
| `ctx.storage`                     | durable JSON scoped to the plugin                                |
| `ctx.event.subscribe({ signal })` | react to the server event stream; abort on cleanup               |

## 7. Change log

| Date       | Change                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-29 | Initial baseline. No plugins installed; no local plugin created. Guard requirement met via permission denials plus the `git-safety` skill. |
