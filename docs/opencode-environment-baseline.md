# OpenCode V2 Environment Baseline — BeaconHS HSE

> Read-only audit of the development environment, performed against the running
> host and Git HEAD `70da27c4`. No source, schema, compose, or environment file
> was modified.

---

## 中文摘要

**审计结论：当前 OpenCode 是 V2（v2.0.18），项目此前完全没有 `.opencode/` 目录、没有 MCP、没有项目 Agent、没有项目 Skill。`AGENTS.md` 已经存在且质量很高，本次是扩展而非覆盖。**

**环境事实（全部实测）：** OpenCode `v2.0.18` · Node `v24.21.0` · pnpm `10.30.3` · Git `2.53.0` · TypeScript `^6.0.3` · 测试框架混用 vitest 与 `node --test` · 项目**完全没有 Playwright**（无依赖、无配置、无 e2e）· 只有 `apps/web` 有 eslint。

**三个必须知道的发现：**

1. **OpenCode V2 没有 LSP 工具。** 官方 V1→V2 迁移文档明确写着：「V2 accepts and preserves `lsp` configuration, but it does not **run** language servers, **expose** LSP tools, or **produce** LSP diagnostics.」任务书中列出的 `goToDefinition` / `findReferences` / `hover` / `documentSymbol` / `workspaceSymbol` / `goToImplementation` / `prepareCallHierarchy` / `incomingCalls` / `outgoingCalls` 九项能力全部是 **V1 独有**，在 V2 中不存在。因此本阶段**没有安装** `typescript-language-server`（装了也没有任何消费者）。详见 `docs/opencode-lsp-baseline.md`。

2. **系统里已没有任何 LSP 二进制。** `typescript-language-server`、`tsserver`、`deno`、`biome`、`vscode-langservers-extracted` 全部不存在。因此「不要重复安装」这条要求自动满足。

3. **OpenCode 自带 `browser` 工具（Code Mode 命名空间，45 个工具），与 Playwright MCP 功能重叠。** 本次仍按任务书安装 Playwright MCP（用于脚本化 E2E 与 CI 集成），但重叠关系已如实记录。

**配置格式陷阱：** `https://opencode.ai/config.json` 返回的是 **V1 schema**（含 `permission`、`plugin`、`subagent_depth` 等单数旧字段）。本项目所有配置一律使用 V2 原生格式：`permissions`（有序数组）、`shell`、`subagent`、`agents`、`plugins`、`skills`、`mcp.servers`。绝不回退到 V1。

---

## 1. OpenCode

| Property      | Value                               | Evidence                                          |
| ------------- | ----------------------------------- | ------------------------------------------------- |
| Version       | **v2.0.18**                         | `opencode --version`                              |
| Binary        | `/home/test/.opencode/bin/opencode` | `command -v opencode`                             |
| Architecture  | client + background service         | `opencode service status` → `http://0.0.0.0:4096` |
| Line of truth | V2 docs only                        | `https://opencode.ai/v2/docs/`                    |

### Global configuration

`~/.config/opencode/`:

| File            | Content                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `opencode.json` | `{ "$schema": "https://opencode.ai/config.json" }` — schema reference only, no settings |
| `service.json`  | mode `0600`; keys `hostname`, `port`, `password` — **not read**, values never inspected |

`service.json` holds the background service password. It was checked by **key
name only**; no value was read, printed, or copied. Project permissions deny
reading `*.json` secrets patterns and `.ssh/**`.

### Environment variables

```
OPENCODE_TERMINAL=<set>
```

No `XDG_*` overrides, so global config resolves to `~/.config/opencode/`.

## 2. Project OpenCode state (before this change)

| Item                               | State                                                                |
| ---------------------------------- | -------------------------------------------------------------------- |
| `.opencode/`                       | **did not exist**                                                    |
| `opencode.json` / `opencode.jsonc` | **did not exist**                                                    |
| `AGENTS.md`                        | **existed**, 15 KB, 253 lines — already loaded as agent instructions |
| MCP servers                        | `No MCP servers configured`                                          |
| Project plugins                    | `No plugins found`                                                   |
| Project agents                     | none                                                                 |
| Project skills                     | none                                                                 |

`plugins/` exists in the repo and is a **pnpm workspace member**
(`pnpm-workspace.yaml` lists `plugins/*`), containing only `.gitkeep`. It is not
an OpenCode plugin directory; OpenCode's directory is `.opencode/plugins/`.

### AGENTS.md: extend, never overwrite

The existing `AGENTS.md` already defines the mission, non-negotiable engineering
rules, repo map, architecture rules, web conventions, data/auth/permissions,
database policy, workers, forms/compliance/reports, the manual and walkthrough
mandate, quality bar, git safety, and handoff notes.

Replacing it would destroy that. This change **appends** a new
"HSE Second-Stage Development" section covering what was genuinely missing:
the HSE canonical model, the closed loop, project scope, the storage
abstraction, the agent workflow, the Definition of Done, the known-defect
register, and the OpenCode infrastructure index.

## 3. Toolchain

| Tool | Version    | Note                                       |
| ---- | ---------- | ------------------------------------------ |
| Node | `v24.21.0` | matches `.nvmrc` (24 LTS)                  |
| pnpm | `10.30.3`  | matches `packageManager` in `package.json` |
| Git  | `2.53.0`   |                                            |

**Node is installed under nvm and is not on the default PATH.** Every shell
invocation needs:

```sh
export PATH="/home/test/.nvm/versions/node/v24.21.0/bin:$PATH"
```

This is an environment fact, not a configuration choice — do not "fix" it by
editing the project's shell config.

## 4. Repository configuration

### `pnpm-workspace.yaml`

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - '!packages/etl'
  - 'plugins/*'
```

Also carries `overrides`, `peerDependencyRules` and
`patchedDependencies: { pagedjs@0.4.3 }`. `packages/etl` is git-ignored and
excluded from the public workspace.

### TypeScript

- Root devDependency: **`typescript: ^6.0.3`** (TypeScript 6.x).
- **There is no root `tsconfig.json`.** The base is `tsconfig.base.json`, and
  each of 26 workspace packages has its own `tsconfig.json`.
- Any language server must therefore be pointed at `tsconfig.base.json` plus
  per-package configs — it cannot assume a single root project file. (Moot under
  V2; see the LSP baseline.)

### Root scripts and gates

```
build           turbo run build
dev             turbo run dev --parallel
lint            turbo run lint
deadcode:check  knip --treat-config-hints-as-errors
typecheck       turbo run typecheck
test            turbo run test
format          prettier --write "**/*.{ts,tsx,md,json}"
format:check    prettier --check "**/*.{ts,tsx,md,json}"
db:generate     pnpm --filter @beaconhs/db generate
db:migrate      pnpm --filter @beaconhs/db migrate
db:seed         pnpm --filter @beaconhs/db seed
```

Note the format glob is `{ts,tsx,md,json}` — a `.jsonc` file is **not**
format-checked, which is why the OpenCode config uses `opencode.jsonc` without
CI friction.

### Tooling inventory

| Concern    | Finding                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Prettier   | `^3.9.5` at root. Gate: `pnpm format:check`.                                                                                       |
| ESLint     | **Only `apps/web` has a lint script** (`eslint .`). `turbo run lint` therefore lints one package. No root `eslint.config.*` found. |
| Dead code  | `knip` `^6.27.0`, `--treat-config-hints-as-errors`                                                                                 |
| Turbo      | `^2.10.5`                                                                                                                          |
| Drizzle    | `drizzle-kit` `^0.31.10` in `@beaconhs/db`                                                                                         |
| Node types | `@types/node` `^24.13.2`                                                                                                           |

## 5. Test frameworks

Two runners coexist. Use the one already in the package.

| Runner                                   | Packages                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest run`                             | analytics, auth, compliance, crypto, **db**, design-studio, email-render, emails, events, forms-core, forms-pdf, i18n, jobs, office, reports, sms, storage, ui, **web** (`--passWithNoTests`), **worker** |
| `node --import tsx --test src/*.test.ts` | ai, appkit-feedback, integrations, sync                                                                                                                                                                   |

24 of 27 packages have a `test` script.

## 6. Playwright

**Completely absent.** Verified:

- No `@playwright/test` or `playwright` dependency in any `package.json`.
- No `playwright.config.*` file.
- No `*.e2e.ts` file.

There is therefore **no checked-in E2E suite**, and adding one is a separate
decision, not part of this infrastructure work. Browser verification today is
done ad hoc — previously with Playwright MCP, and natively with OpenCode's
built-in `browser` tool.

## 7. Database tooling

`packages/db` scripts:

```
generate    drizzle-kit generate
migrate     tsx --env-file=../../.env src/migrate.ts
push        drizzle-kit push
push:ci     drizzle-kit push --force
studio      drizzle-kit studio
seed        tsx --env-file=../../.env src/seed.ts
test        vitest run
typecheck   tsc --noEmit
```

Running containers (all healthy): `beaconhs-postgres`, `beaconhs-redis`,
`beaconhs-mailpit`, `beaconhs-minio`, `beaconhs-collabora`.

## 8. Language servers

| Binary                         | Present      |
| ------------------------------ | ------------ |
| `typescript-language-server`   | No           |
| `tsserver`                     | No           |
| `deno`                         | No           |
| `biome`                        | No           |
| `vscode-langservers-extracted` | No (0 files) |

Nothing was installed, because V2 exposes no LSP tools for a server to serve.
See `docs/opencode-lsp-baseline.md`.

## 9. The `config.json` schema trap

`https://opencode.ai/config.json` — the URL that the `$schema` field points at —
currently serves a schema whose `Config` properties include:

```
permission      (singular)
plugin          (singular)
subagent_depth  (top-level)
agent           (singular)
provider        (singular)
command         (singular)
reference       (singular)
```

These are **V1** names. Verified programmatically by resolving
`$defs.Config.properties` from the live schema.

The V2 docs are the only source of truth for V2 field names. This project uses:

| Concern     | V2 form used here                                            |
| ----------- | ------------------------------------------------------------ |
| Permissions | `permissions`: ordered array of `{action, resource, effect}` |
| Shell       | `shell`                                                      |
| Subagents   | `subagent`, `agents`                                         |
| Plugins     | `plugins`                                                    |
| Skills      | `skills`                                                     |
| MCP         | `mcp.servers`                                                |
| Agents      | `agents.<id>` or `.opencode/agents/<id>.md`                  |

## 10. Service architecture note

OpenCode is a client plus a background service. After changing plugins, MCP
servers, or configuration that registers resources:

```sh
opencode service restart
opencode service status
```

Logging lives at `~/.local/share/opencode/log/opencode.log`; filter `role=cli`
for client startup and `role=server` for sessions, providers, plugins,
permissions and tools. Do not delete or hand-edit the service database while
diagnosing.

## 11. Summary of what this change added

| Area           | Before            | After                                                                       |
| -------------- | ----------------- | --------------------------------------------------------------------------- |
| Project config | none              | `.opencode/opencode.jsonc` (V2 native)                                      |
| Permissions    | OpenCode defaults | 8 ordered blocks, secret denies, destructive-command denies, MCP tool tiers |
| MCP            | none              | context7, github, playwright (all verified before install)                  |
| Skills         | none              | 12 project skills                                                           |
| Agents         | 4 built-ins       | 9 project agents + 4 built-ins                                              |
| `AGENTS.md`    | 253 lines         | appended HSE second-stage section                                           |
| Docs           | 14 audit docs     | +9 baseline/state docs                                                      |
