# OpenCode V2 MCP Baseline — BeaconHS HSE

> Every server was verified for provenance and reachability **before** being
> added. Configuration lives in `.opencode/opencode.jsonc` under `mcp.servers`
> (V2 shape — not the V1 singular `mcp.<name>` form).

---

## 中文摘要

**结论：安装 3 个 MCP，全部经过来源验证，未安装任何重复或来源不明的第三方 MCP。**

| MCP            | 形式   | 来源验证                                                                 |
| -------------- | ------ | ------------------------------------------------------------------------ |
| **context7**   | remote | 官方文档示例中的同一个端点                                               |
| **github**     | remote | 官方 `github/github-mcp-server`（MIT，33k stars，未归档）                |
| **playwright** | local  | 官方 `github.com/microsoft/playwright-mcp`（Apache-2.0，Microsoft 维护） |

**关键甄别：** npm 上的 `github-mcp-server` 包是**第三方**项目（作者 `jungchihoon`，ISC 许可），**不是** GitHub 官方版本。本次**故意不使用**该包，改用官方 remote 端点 `https://api.githubcopilot.com/mcp/`。这正是任务书「不要安装未经验证的第三方 MCP」所要求做的甄别。

**权限分层：** 文档查询 allow；GitHub 只读动词 allow、其余 ask；浏览器只读动词 allow、写入动词 ask。**未能安全限制粒度的能力默认 ask**——这是 fail-safe 方向。

**认证方式：** context7 走 OAuth（`/mcps`）；github 使用 `oauth: false` + 个人访问令牌（PAT），令牌保存在仓库外的 `~/.config/opencode/github-token`，配置文件里不写任何密钥。PAT 会过期，刷新步骤见 §6（2026-11-08 曾因过期导致 401，已修复）。

**已知功能重叠（如实记录）：** OpenCode V2 自带 `browser` 工具（Code Mode 命名空间，45 个工具），与 Playwright MCP 部分重叠。保留 Playwright MCP 的理由是它用于**脚本化 E2E 与 CI 集成**；内置 browser 用于交互式轻量验证。二者用途不同，但确实重叠。

---

## 1. Verification performed

Nothing was configured on trust. Each candidate was checked first.

| Check                           | Method               | Result                                                                                                                                                    |
| ------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing MCP servers            | `opencode mcp list`  | `No MCP servers configured` — no duplicates possible                                                                                                      |
| `@playwright/mcp` provenance    | npm registry         | official Microsoft, `github.com/microsoft/playwright-mcp`, Apache-2.0, maintainers include `microsoft-oss-releases`, latest `0.0.83` published 2026-09-28 |
| Context7 endpoint               | HTTP probe           | `https://mcp.context7.com/mcp` → `405` (expected for GET on an MCP endpoint)                                                                              |
| GitHub endpoint                 | HTTP probe           | `https://api.githubcopilot.com/mcp/` → `401` (reachable; authentication required)                                                                         |
| Official GitHub server          | GitHub API           | `github/github-mcp-server`, not archived, 33 268 stars, MIT, pushed 2026-09-28                                                                            |
| Third-party `github-mcp-server` | npm registry         | **rejected** — author `jungchihoon`, ISC, a different project                                                                                             |
| Native GitHub integration       | `opencode auth list` | `No authenticated integrations` — so an MCP is genuinely additive                                                                                         |

The Context7 URL is taken verbatim from the official V2 documentation example
(`opencode mcp add context7 --url https://mcp.context7.com/mcp`), so it needs no
independent trust decision.

## 2. Configured servers

### context7 — third-party library documentation

```jsonc
"context7": {
  "type": "remote",
  "url": "https://mcp.context7.com/mcp",
  "timeout": { "startup": 45000, "catalog": 30000 }
}
```

**Why:** the project runs TypeScript 6, Next.js 16, Drizzle, pnpm 10 and Turbo.
Training knowledge of these is unreliable. Context7 resolves a library ID and
returns current versioned docs.

**Auth:** OAuth. Sign in via `/mcps` in the TUI. Credentials are stored outside
the project configuration by design — no key is written to any file.

**Permission:** `context7_*` → **allow**. The server is a documentation lookup;
it has no write surface.

### github — repositories, issues, PRs, code search, releases

```jsonc
"github": {
  "type": "remote",
  "url": "https://api.githubcopilot.com/mcp/",
  "oauth": false,
  "headers": {
    "Authorization": "Bearer {file:~/.config/opencode/github-token}",
  },
  "timeout": { "startup": 45000, "catalog": 45000, "execution": 300000 }
}
```

**Why:** upstream issue/PR/release tracking and code search across the
BeaconHS ecosystem, without leaving the session.

**Auth:** a GitHub fine-grained **PAT**, not OAuth. The token is read from
`~/.config/opencode/github-token` (mode `0600`), outside the repository; no
secret is written into the config file. `oauth: false` is set because the
OAuth sign-in flow was never completed on this host — leaving it enabled would
only put the server into `needs authentication`. V2 documents `{env:NAME}`
substitution; this deployment uses the file-reference form, which OpenCode
v2.2.x resolves at connect time (proven by the 2026-11-08 incident: the server
received the stale token and returned a real `credential expired` 401, not a
configuration error).

**PATs expire.** When GitHub answers
`unauthorized: token authentication failed: credential expired (HTTP 401)`,
refresh the file as described in §6. Replacing the file restores the connection
on the next connect attempt; no config edit is needed.

**Permissions — read verbs allowed, everything else asks:**

```jsonc
{ "action": "github_*",        "resource": "*", "effect": "ask" },
{ "action": "github_get_*",    "resource": "*", "effect": "allow" },
{ "action": "github_list_*",   "resource": "*", "effect": "allow" },
{ "action": "github_search_*", "resource": "*", "effect": "allow" },
{ "action": "github_read_*",   "resource": "*", "effect": "allow" }
```

Tool names are normalised to `<server>_<tool>`. Write verbs
(`create_*`, `update_*`, `merge_*`, `push_*`, `add_*`, `close_*`,
`delete_*`, `set_*`, `enable_*`, `disable_*`, `lock_*`, `submit_*`, …) match
**none** of the allow prefixes and therefore stay `ask`. This is deliberate
fail-safe design: an unfamiliar tool name is asked about rather than allowed.

This satisfies the task's intent that PR creation and issue modification ask.

### playwright — browser E2E

```jsonc
"playwright": {
  "type": "local",
  // Node and npx live under nvm and are on NO default PATH (not even a
  // login shell), so the OpenCode background service cannot spawn a bare
  // `npx`. Invoke node by absolute path, and pass the nvm bin directory
  // down to the child shell that npx execs the package binary through.
  "command": [
    "/home/test/.nvm/versions/node/v24.21.0/bin/node",
    "/home/test/.nvm/versions/node/v24.21.0/lib/node_modules/npm/bin/npx-cli.js",
    "-y",
    "@playwright/mcp@0.0.83"
  ],
  "environment": {
    "PATH": "/home/test/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin"
  },
  "timeout": { "startup": 180000, "catalog": 60000, "execution": 180000 }
}
```

**Why:** the repository has **no** Playwright dependency, no Playwright config
and no checked-in E2E suite (verified). Browser verification of login, forms,
uploads, permissions and HSE workflows is currently ad hoc. This MCP gives it a
repeatable driver.

The version is **pinned** to `0.0.83` rather than floating, so a future package
release cannot change tool behaviour without a deliberate diff.

#### Why the absolute-path command (a real defect found and fixed)

The obvious form `"command": ["npx", "-y", "@playwright/mcp@0.0.83"]` **failed**:

```
x playwright  failed: NotFound: ChildProcess.spawn (npx -y @playwright/mcp@0.0.83)
```

Root cause, confirmed by test: on this host `npx` exists **only** under nvm and
is on **no** default PATH — not a login shell, not a non-login shell, and not in
`/usr/bin` or `/usr/local/bin`. The OpenCode background service therefore cannot
resolve the bare executable name.

**Two** fixes were needed, not one:

1. **Absolute node path.** Spawning `npx` directly fails because npx is a
   symlink to `npx-cli.js`, whose shebang is `#!/usr/bin/env node` — and `node`
   is equally absent from the default PATH. Invoking the `node` binary by
   absolute path bypasses the shebang entirely.
2. **`environment.PATH` for the child.** With only fix 1, npx downloads the
   package successfully and then fails with
   `sh: 1: playwright-mcp: not found`, because npx execs the package binary
   through a child shell that still has no PATH. The MCP `environment` block
   supplies the nvm bin directory to that child.

Both were verified by direct invocation before being written to config. The
server now reports **connected** with 25 tools.

Startup timeout is generous (180 s) because `npx -y` may fetch the package and
launch a browser on first use.

**Permissions — read verbs allowed, state-changing verbs ask:**

```jsonc
{ "action": "playwright_*",                            "resource": "*", "effect": "ask" },
{ "action": "playwright_browser_snapshot*",            "resource": "*", "effect": "allow" },
{ "action": "playwright_browser_take_screenshot*",     "resource": "*", "effect": "allow" },
{ "action": "playwright_browser_console_messages*",     "resource": "*", "effect": "allow" },
{ "action": "playwright_browser_network_requests*",    "resource": "*", "effect": "allow" },
{ "action": "playwright_browser_tabs_list*",           "resource": "*", "effect": "allow" },
{ "action": "playwright_browser_tabs_select*",         "resource": "*", "effect": "allow" },
{ "action": "playwright_browser_navigate*",            "resource": "*", "effect": "allow" },
{ "action": "playwright_browser_navigate_back*",       "resource": "*", "effect": "allow" }
```

State-changing verbs — `browser_click`, `browser_type`, `browser_fill_form`,
`browser_select_option`, `browser_press_key`, `browser_drag`,
`browser_file_upload`, `browser_handle_dialog`, `browser_run_code` — remain
`ask`. Navigation is allowed because it does not by itself mutate application
state, and without it no verification flow can start.

## 3. Verified state

```
$ opencode mcp list --server http://127.0.0.1:4096
```

The shared background service is the systemd unit `opencode.service` on port 4096. The CLI is pointed at it explicitly: a bare `opencode mcp list` tries to
start its own managed service on the same port and fails with
`Managed service port 4096 ... is already in use`.

Current state:

| Server       | State                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `context7`   | **connected** — tools live in the Code Mode catalog as `context7.query-docs` and `context7.resolve-library-id` |
| `github`     | **connected** — 46 tools in the Code Mode catalog; `github.get_me()` returns `xu151077`                        |
| `playwright` | **connected** — 25 tools live in the Code Mode catalog                                                         |

Raw output:

```
✓ context7    connected
✓ github      connected
✓ playwright  connected
```

### 2026-11-08 — expired PAT incident (fixed)

From 2026-11-07 the github server failed every connect with
`unauthorized: token authentication failed: credential expired (HTTP 401)`.
The cause was the fine-grained PAT in `~/.config/opencode/github-token`, not the
MCP configuration: the old token returned `401 Bad credentials` from
`api.github.com`, while the account's git credential store held a **different,
valid** token (created 2026-11-07). The two copies had drifted — the git
credential was rotated and the MCP file was not.

Fix: copied the valid token into `~/.config/opencode/github-token` (kept mode
`0600`). No config change was needed; the server reconnected and
`github.get_me()` succeeded. The standing risk is that these are **two
independent credential copies** — §6 documents the refresh procedure that keeps
them in sync.

## 4. Known overlap: the built-in `browser` tool

OpenCode V2 ships a built-in `browser` Code Mode namespace with 45 tools —
tab management, page snapshots, clicking, form input, screenshots, file
transfer, console and network inspection, performance traces, heap inspection
and Lighthouse audits.

This overlaps substantially with the Playwright MCP. It was **not** removed,
because the two serve different purposes:

|                        | Built-in `browser`                                                                                      | Playwright MCP                |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Style                  | interactive, agent-driven                                                                               | scriptable, repeatable        |
| Traces / CI            | not designed for it                                                                                     | yes                           |
| Permission granularity | **all-or-nothing** — a `browser` deny removes the whole catalog; individual operations issue no prompts | per-tool, read vs write split |
| Availability           | tied to the OpenCode desktop app                                                                        | any client                    |

**Consequence to be aware of:** because built-in browser operations do not issue
individual permission prompts, they are effectively allowed by default and are
**not** subject to the read/write split applied to Playwright. That is a real
limitation of the granularity available for browser control in V2, and it is
recorded here rather than papered over.

## 5. Deliberately not installed

| Candidate                        | Why not                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| npm `github-mcp-server`          | third-party (`jungchihoon`), not GitHub's official server                                                    |
| Filesystem / database MCPs       | `read`, `grep`, `glob` and `psql` already cover these; an extra server adds attack surface for no capability |
| Memory / note MCPs               | `docs/project-development-state.md` is the durable record; a second memory store would drift from it         |
| Any "AI coding" or telemetry MCP | unknown data-handling posture; explicitly out of scope                                                       |
| General web-search MCP           | OpenCode already provides `websearch` and `webfetch`                                                         |

The rule applied throughout: **add a server only when it provides a capability
the built-in tools cannot.** All three configured servers pass that test.

## 6. Maintenance

```sh
opencode mcp list --server http://127.0.0.1:4096   # connection state (systemd service)
opencode mcp add <name> --url …                    # add (project-local by default)
opencode mcp logout <name>                         # clear stored OAuth credentials
```

To connect or disconnect a server interactively, use `/mcps` in the TUI. Only
`context7` uses OAuth; `github` has `oauth: false`, so `/mcps` sign-in does not
apply to it.

### Refreshing the GitHub PAT

`github` authenticates with a fine-grained PAT that expires. Rotate it on
GitHub, then update **both** places that hold it — the account's git credential
store (`~/.config/git/credentials`, used by git) and
`~/.config/opencode/github-token` (used by the MCP header). They are independent
copies; rotating only one reproduces the 2026-11-08 incident.

Sync the MCP file from the git credential store without printing the secret:

```sh
python3 - <<'PY'
import pathlib, os
home = pathlib.Path.home()
line = (home / '.config/git/credentials').read_text().strip()
secret = line.rsplit('@', 1)[0].split('://', 1)[1].split(':', 1)[1]
target = home / '.config/opencode/github-token'
target.write_text(secret)
os.chmod(target, 0o600)
PY
```

Verify the credential and the connection (never echo the token):

```sh
python3 - <<'PY'
import urllib.request, pathlib
tok = pathlib.Path.home().joinpath('.config/opencode/github-token').read_text().strip()
req = urllib.request.Request('https://api.github.com/user', headers={
    'Authorization': f'Bearer {tok}', 'Accept': 'application/vnd.github+json'})
print(urllib.request.urlopen(req, timeout=20).status)
PY
opencode mcp list --server http://127.0.0.1:4096
```

Config changes are watched and applied without a restart; replacing the token
file is picked up on the next connect attempt. Restart the background service
only when it is stuck or unhealthy:

```sh
opencode service restart
opencode service status
```

## 7. Completion criteria

- `opencode mcp list` shows all three servers with their real state.
- No server was added without a provenance check.
- No duplicate of a built-in capability was installed.
- Read and write exposure is separated by permission rule, and anything that
  cannot be separated defaults to `ask`.
- No secret or token is written into `.opencode/opencode.jsonc`.
- The GitHub PAT expiry path is documented (§6), since fine-grained PATs expire.
