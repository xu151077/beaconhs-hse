# OpenCode V2 LSP Baseline — BeaconHS HSE

> **Finding: OpenCode V2 does not run language servers and does not expose LSP
> tools. No LSP was configured, and none was installed.**

---

## 中文摘要

**结论：任务书第六阶段（LSP）在 OpenCode V2 下无法实现，本次如实记录为「已验证的否定结论」，没有伪造配置，也没有安装无用的软件。**

**权威依据（OpenCode V2 官方 V1→V2 迁移文档原文）：**

> "V2 accepts and preserves `lsp` configuration, but it does **not run language
> servers**, **expose** LSP tools, or **produce** LSP diagnostics. Replace
> workflows that depend on those capabilities with the project's lint,
> typecheck, or compiler commands."
> —— https://opencode.ai/v2/docs/migrate-v1/

**权限文档同样明确：**

> "`doom_loop` and `lsp` are **not current V2 Core permission actions**."
> —— https://opencode.ai/v2/docs/permissions/

**任务书列出的九项能力全部是 V1 独有：**
`goToDefinition` · `findReferences` · `hover` · `documentSymbol` ·
`workspaceSymbol` · `goToImplementation` · `prepareCallHierarchy` ·
`incomingCalls` · `outgoingCalls`
—— 这些在 V2 的工具目录中**一个都不存在**。

**因此没有安装 `typescript-language-server`。** 装一个没有消费者的语言服务器，只会在机器上增加维护面而不产生任何能力。官方给出的替代方案已经落地为本项目的既定流程：`pnpm typecheck` + `pnpm lint` + `pnpm test`。

---

## 1. How this was verified

Not inferred from memory — checked against documentation and the running system.

### 1.1 The V2 tool catalog contains no LSP tool

`https://opencode.ai/v2/docs/tools/` was fetched and read in full. It enumerates
the complete built-in catalog: `read`, `glob`, `grep`, `edit`, `write`, `patch`,
`shell`, `webfetch`, `websearch`, `question`, `skill`, `subagent`, `execute`,
the `opencode` Code Mode session namespace, the `browser` namespace, and MCP
extensions.

**No LSP tool of any kind is listed.**

### 1.2 A scan of 16 V2 documentation pages

Every V2 docs page was fetched and searched for `lsp`, `goToDefinition`,
`findReferences`, `documentSymbol`, `workspaceSymbol`, `prepareCallHierarchy`,
`incomingCalls`, `outgoingCalls`, `typescript-language-server`.

Exactly **two** pages matched, and both are statements of absence:

| Page           | Statement                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `permissions/` | "`doom_loop` and `lsp` are not current V2 Core permission actions."                                                                 |
| `migrate-v1/`  | "V2 accepts and preserves `lsp` configuration, but it does not run language servers, expose LSP tools, or produce LSP diagnostics." |

`troubleshooting/` — the page that would describe configuring an LSP — returned
**zero** matches.

### 1.3 The `lsp` field in the published schema is V1

`https://opencode.ai/config.json` does contain an `lsp` key. This is a trap worth
recording explicitly:

- The schema's `$defs.Config.properties` resolve to the **V1** property names —
  `permission`, `plugin`, `subagent_depth`, `agent`, `provider`, `command`,
  `reference`, `server`, `logLevel`.
- Its agent-level `lsp` field is described as _"Enable or configure LSP servers.
  Omit or set to false to disable, true to enable built-ins…"_ — **V1 wording**.
- The V2 docs are explicit that the served schema may describe V1 and must
  **never** be used to infer V2 field names.

So the presence of `lsp` in `config.json` does **not** mean V2 supports LSP. It
is V1 schema that V2 tolerates without error — which is precisely why writing an
`lsp` block would have looked correct and silently done nothing.

### 1.4 The running system

Confirmed absent from the host — so "do not install a duplicate" is satisfied
automatically:

| Binary                         | Present      |
| ------------------------------ | ------------ |
| `typescript-language-server`   | No           |
| `tsserver`                     | No           |
| `deno`                         | No           |
| `biome`                        | No           |
| `vscode-langservers-extracted` | No (0 files) |

## 2. The nine requested capabilities

| Capability requested   | Status in V2      | V2 equivalent                                    |
| ---------------------- | ----------------- | ------------------------------------------------ |
| `goToDefinition`       | **Not available** | `grep` for the symbol, then `read` the file      |
| `findReferences`       | **Not available** | `grep` for the identifier across the workspace   |
| `hover`                | **Not available** | `read` the declaration site                      |
| `documentSymbol`       | **Not available** | `grep` for `export const` / `export function`    |
| `workspaceSymbol`      | **Not available** | `grep` across `packages/` and `apps/`            |
| `goToImplementation`   | **Not available** | `grep` for the interface and its implementations |
| `prepareCallHierarchy` | **Not available** | `grep` for the call site                         |
| `incomingCalls`        | **Not available** | `grep` for the function name                     |
| `outgoingCalls`        | **Not available** | `read` the function body                         |

The replacements are adequate in this repository specifically, because:

- the workspace is **26 TypeScript packages plus 2 apps** — small enough for
  `grep` to be fast;
- symbols are unusually well-named and cross-package references are explicit
  (`@beaconhs/tenant`, `@beaconhs/db`, `@beaconhs/events`), so `grep` on a
  package import name is an effective cross-package reference search;
- `strict` TypeScript plus `pnpm typecheck` already catches unresolved imports,
  so the main correctness benefit of an LSP is already delivered by the compiler.

The main real loss is **incremental feedback** — an LSP answers in
milliseconds, `turbo run typecheck` takes tens of seconds. That is a genuine
ergonomic cost, and it is the honest reason to revisit this if OpenCode V2 ever
restores LSP support.

## 3. Why nothing was installed

Installing `typescript-language-server` would have been actively harmful:

- It would have **no consumer** — V2 never spawns or speaks to it.
- It would add a global binary that must be kept in step with the project's
  **TypeScript 6.x**, a major version whose server compatibility would need
  independent verification.
- It would create the false impression that LSP verification had been performed,
  which is precisely the kind of unverified claim this project forbids.

The task's own instruction — _"don't install a duplicate; check what already
exists first"_ — resolves here to installing nothing.

## 4. What was done instead

The documented replacement — "the project's lint, typecheck, or compiler
commands" — is already this project's primary quality mechanism, and is wired
into agents and skills:

| Command               | Covers                                                 | Where enforced                                            |
| --------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `pnpm typecheck`      | unresolved imports, type errors across all 26 packages | all implementing agents; `release-readiness`              |
| `pnpm lint`           | `eslint` in `apps/web`                                 | `backend`, `frontend`, `test-engineer`, `release-manager` |
| `pnpm test`           | runtime behaviour, including the RLS coverage test     | `test-engineer`, `release-manager`                        |
| `pnpm deadcode:check` | knip — unused files, exports, types                    | `release-readiness`                                       |
| `pnpm build`          | full Next.js production build                          | `release-readiness`                                       |

Note the one honest gap in this substitution: **typecheck gives whole-program
feedback, not symbol-level navigation.** For cross-package reference questions the
workflow is `grep` + `read`, which is slower to iterate but produces the same
answers.

## 5. Project-specific implications

The repository has **no root `tsconfig.json`** — the base is
`tsconfig.base.json`, with each of 26 workspace packages carrying its own
`tsconfig.json`. A multi-root-aware language server would have needed explicit
configuration for all 28 files.

This is moot under V2, but it is recorded because it becomes a real
prerequisite the moment LSP support is restored: any future language server must
be pointed at `tsconfig.base.json` plus the per-package configs, not at a single
root project file.

## 6. Revisit criteria

Re-open this decision if **any** of the following becomes true:

1. The V2 tools documentation lists LSP tools.
2. The V2 migration guide's "does not run language servers" sentence is removed.
3. `lsp` becomes a documented V2 Core permission action.
4. A maintained, TypeScript-6-compatible language server exposes a V2 plugin
   surface (`ctx.tool.transform`) that could expose navigation as tools.

Until then the correct configuration is: **no LSP block, no language server.**

## 7. Completion criteria

- The absence of LSP support is established from authoritative V2 documentation,
  not assumption.
- All nine requested capabilities are listed with their V2 status and the actual
  replacement used.
- Nothing was installed that has no consumer.
- The substitution (lint / typecheck / test) is already enforced by agents and
  skills.
- The limitations are stated plainly, including the loss of incremental
  feedback.
