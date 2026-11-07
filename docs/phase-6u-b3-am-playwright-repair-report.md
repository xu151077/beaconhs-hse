# Phase AM — OpenCode v2 Playwright MCP Repair Report

**Repository:** `/home/test/projects/beaconhs-hse`
**Branch:** `hse-platform`
**Scope:** Phase AM — fix the OpenCode v2 Playwright browser tooling crash and
restore browser E2E verification capability. No production code, DNS, tunnel,
storage credentials, or C2 Drill resources were changed.

---

## 1. Symptom and scope

The Playwright MCP server stopped serving `playwright_*` tools mid-session on
2026-10-16T02:29:38Z (recorded in
`/home/test/.local/share/opencode/log/opencode.log`, run `f7c3866f`). After
the crash, the tool catalog no longer contained any `playwright_*` entry point,
so Layers 2–6 of the verification plan could not be driven through OpenCode until
the underlying defect was fixed.

This report documents the actual failure, root cause (proven by reproduction),
the minimal fix, and the per-layer verification performed afterwards.

---

## 2. Collected evidence

### 2.1 Stack trace (OpenCode log, exactly as recorded)

```
WARN mcp transport error server=playwright  ...  Node.js v24.21.0
MCP server process exited with code 1:
    .../coreBundle.js:11544:33)
    at _Page.emit   (coreBundle.js:11539:18)
    at _BrowserContext._onRequestFailed (coreBundle.js:63703:16)
    at Proxy.<anonymous>            (coreBundle.js:63644:113)
    at Proxy._callHandler          (coreBundle.js:11544:33)
    at Proxy.emit                  (coreBundle.js:11534:16)
    at Connection.dispatch         (coreBundle.js:65303:25)
    at Immediate.<anonymous>      (coreBundle.js:65364:85)
    at process.processImmediate     (node:internal/timers:574:21)
```

The MCP supervisor field is `run=f7c3866f` — the **same** long-lived process
run that holds this agent session, which is why the server was not restarted: a
`grep` of the log shows **no `mcp connected server=playwright` after
2026-10-16T02:29:38.219Z** until I corrected the configuration (see §4).

### 2.2 MCP configuration under test (`.opencode/opencode.jsonc`)

```jsonc
"playwright": {
  "type": "local",
  "command": [
    "…/node", "…/npx-cli.js", "-y", "@playwright/mcp@0.0.83",
    "--browser=chromium", "--headless",
    "--executable-path=…/chromium-1248/chrome-linux64/chrome"
  ],
  "environment": {
    "PATH": "…",
    "DBUS_SESSION_BUS_ADDRESS": "unix:/run/user/1000/bus"
  },
  ...
}
```

All three path components exist and are executable (verified 2026-10-16):

- node `v24.21.0`
- `npx-cli.js`
- `chrome` 156.0.8078.4

### 2.3 Environment hygiene checks

| Check                             | Result                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/dev/shm`                        | 7.9G available (chromium `--disable-dev-shm-usage` default from Playwright is present in the launched command line, confirmed) |
| DBus session bus                  | socket present at `unix:/run/user/1000/bus`                                                                                    |
| `/run/user/1000/bus`              | present, mode `srw-rw-rw-`                                                                                                     |
| host RAM                          | 16 GB total, adequate — AGENTS.md note of ~3.4 GB is stale for this host                                                       |
| Chromium `--no-sandbox`           | added by Playwright (confirmed in `ps -eo args` output)                                                                        |
| DNS `beaconhs-test.xuhaoqing.top` | resolves; TLS works                                                                                                            |

### 2.4 Process topology detail

`npx` does **not** run its target in the same Node process. The actual MCP
server is a grandchild:

```
node npx-cli.js   (PID A)
  └─ npm exec @playwright/mcp@0.0.83 (sh)
       └─ node …/node_modules/.bin/playwright-mcp   (PID C, the real server)
```

This topology is why an argv `--import` flag placed on the outer `node` is
**dropped** when npx re-execs the package binary, and why the fix uses
`NODE_OPTIONS`, which is inherited down the whole chain.

### 2.5 Known-environment noise that was ruled out

- The reported AK defect ("Playwright MCP `code 1`") was assigned to
  `@playwright/mcp` + Playwright core, **not** to DBus, `/dev/shm`, sandboxing,
  or the npx path. All of those were probed (above) and found healthy; the
  crash re-exposes reliably via a guarded test once the listener guard is off.

---

## 3. Reproduction (the decisive evidence)

### 3.1 Deterministic crash

A repro harness (`/tmp/opencode/am/prod-repro.mjs`, reproduced serveral times)
runs the exact MCP server command recorded in `.opencode/opencode.jsonc`, then
issues a `browser_run_code_unsafe` whose snippet registers an unguarded
`page.on('requestfailed', …)` listener that throws synchronously, then triggers
a failed subresource request. Without the fix:

```
MODE=throw:
  CALL_RESULT: { TIMEOUT / server exited before reply }
  SERVER_EXIT: { code: 1, signal: null }
  STDERR_TAIL:
    Error: phase-ak style listener blew up: { url, failure }
        at _Page.<anonymous> (evalmachine:…)
        at _Page._callHandler (coreBundle.js:11544:33)
        at _Page.emit (coreBundle.js:11539:18)
        at _BrowserContext._onRequestFailed (coreBundle.js:63703:16)
        at Proxy.<anonymous> (coreBundle.js:63644:113)
        at Proxy._callHandler (coreBundle.js:11544:33)
        at Proxy.emit (coreBundle.js:11534:16)
        at Connection.dispatch (coreBundle.js:65303:25)
        at Immediate.<anonymous> (coreBundle.js:65364:85)
        at process.processImmediate (node:internal/timers:574:21)
    Node.js v24.21.0
```

This stack is byte-identical, in its visible tail, to the Phase AK crash
recorded in the OpenCode log — including the `_BrowserContext._onRequestFailed`
and `Connection.dispatch → Immediate` frames. The crash is reproduced at will and
eliminated at will.

### 3.2 Variants probed

| Variant                                                                                             | Behaviour                                                           | Server survives?                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| No listener registered (`none`)                                                                     | control, returns normally                                           | yes                                                                      |
| Unguarded synchronous `throw` in `page.on('requestfailed')` listener (`throw` / baseline `GUARD=0`) | exit code 1                                                         | **no**                                                                   |
| Same listener wrapped in `try/catch` (`guard`)                                                      | tool returns `isError:false` with "registered guarded listener"     | yes                                                                      |
| Async listener whose promise rejects (`async-reject`)                                               | MCP converts the rejection into a normal `isError:true` tool result | yes (Playwright context-level `onUnhandledRejection` already handles it) |

Only **synchronous** throws inside listeners kill the server; async rejections are
already contained by Playwright. The fix therefore needs to contain _uncaught
synchronous exceptions_ in the MCP server process.

---

## 4. Root cause

`.opencode/opencode.jsonc` correctly pinned `@playwright/mcp@0.0.83`. The
defect is **not** in the MCP configuration but in Playwright itself:

`playwright-core/lib/coreBundle.js`, `Connection.dispatch`, schedules a bare
`Immediate` that invokes `_BrowserContext._onRequestFailed` → `page.emit(
Events.Page.RequestFailed, request)` **without any try/catch around the listener
call**. Any listener registered through `browser_run_code_unsafe` (phase AK and
phase AE used custom `request`, `response` and `requestfailed` listeners for
network diagnostics) that throws synchronously escapes this dispatch, and Node 24
turns that into an uncaught exception, exiting the process with code 1.

Contributing factor: **OpenCode v2.0.30 does not restart a crashed local MCP
server.** The log contains no `mcp connected server=playwright` after the AK
crash in this run until I corrected the configuration and reloaded it.

---

## 5. Fix applied

### 5.1 New file: `.opencode/mcp/playwright-mcp-guard.mjs`

A minimal Node `--import`-able module that registers
`process.on("uncaughtException", …)` _before_ any tool code runs. It:

- loads ahead of the MCP server (via `NODE_OPTIONS`, inherited into the grandchild
  that actually serves MCP — see §2.4);
- writes the failure and **full stack trace** to stderr under the marker
  `[beaconhs:playwright-mcp-guard]`, so no condition is hidden;
- does **not** call `process.exit`: the in-flight `tools/call` never receives a
  reply (client sees a failed call against `timeout.execution`), but the server
  process, browser and all subsequent calls survive;
- deliberately does **not** handle `unhandledRejection`: Playwright already
  converts those into normal tool errors and a process-level handler would
  suppress diagnostics the MCP server itself needs.

Duck-typed Error handling is used because the throwing listener lives in a `vm`
context created by `browser_run_code_unsafe`, so its `Error` object fails
`instanceof Error` (a cross-realm class) while still carrying `.name/.message/.stack`.

Verified syntax: `node --check` → 0, and Prettier clean.

### 5.2 `.opencode/opencode.jsonc` (playwright entry)

- Removed the ineffective argv `--import …` entry that npx dropped.
- Added environment entry
  `"NODE_OPTIONS": "--import=/home/test/projects/beaconhs-hse/.opencode/mcp/playwright-mcp-guard.mjs"`
  (inherited down the npx → sh → node chain).
- Kept the unchanged `@playwright/mcp@0.0.83` pin, `--browser=chromium`,
  `--headless`, the Chromium 1248 executable path, `DBUS_SESSION_BUS_ADDRESS`,
  and all timeouts.
- Plus a backup copy:
  `.opencode/opencode.jsonc.before-am-playwright-repair`.
- The file parses as valid JSONC (all three servers present; 124 permission
  rules; verified against OpenCode's own reload, which reconnected the MCP
  server at 2026-10-16T03:30:51Z).

### 5.3 `.opencode/skills/ui-e2e/SKILL.md`

Added an "Environment limits and tooling stability" note telling future browser
runs to wrap `browser_run_code_unsafe` event listener bodies in `try/catch` and
prefer async rejections (no product change).

No files outside these were modified; no legacy `opencode.json` was touched.

---

## 6. Level-by-level verification

Each layer was independently executed and recorded.

### Layer 1 — Playwright MCP starts and stays running

- **Result: PASS.**
- Command:
  ```
  NODE_OPTIONS=--import=…/playwright-mcp-guard.mjs
  /home/test/.nvm/versions/node/v24.21.0/bin/node …/npx-cli.js -y @playwright/mcp@0.0.83 \
    --browser=chromium --headless --executable-path=…/chrome
  ```
- MCP stdio `initialize` completed; server remained connected after the Layer 3
  call (no `mcp transport error`).
- In the production config, OpenCode reloaded the MCP server successfully
  (`mcp connected server=playwright` logged at 2026-10-16T03:30:51Z).

### Layer 2 — OpenCode discovers and calls Playwright tools

- **Result: PASS.**
- `tools/list` returned 25 tools (`browser_navigate`, `browser_snapshot`,
  `browser_run_code_unsafe`, `browser_file_upload`, etc.) both in the harness
  probe and in subsequent OpenCode-driven calls in this session.
- Representative OpenCode-driven call to `browser_navigate`
  (`https://example.com`) returned `Page Title: Example Domain` with
  snapshot attached.

### Layer 3 — Chromium launches, opens a page, executes a simple interaction

- **Result: PASS.**
- Chromium 156.0.8078.4 launched with `--headless --no-sandbox
--disable-dev-shm-usage --remote-debugging-pipe` (confirmed via
  `ps -eo args`).
- `browser_resize(1280,800)` → applied; `browser_navigate(https://example.com)`
  → URL + title + snapshot returned.
- Console/network monitored via `browser_console_messages` (no errors on the
  Example Domain page beyond the standard one-time 404).

### Layer 4 — Access `https://beaconhs-test.xuhaoqing.top` and basic page check

- **Result: PASS.**
- `browser_navigate(https://beaconhs-test.xuhaoqing.top/login)` reached the
  login page and (after the fresh magic link) `/dashboard`: title
  `Dashboard · BeaconHS`, 29+ `nav a` links, `console errors: 0`, main section
  rendered, ASP (account selector shows `Phase AJ Test Tenant`).
- Snapshot captured to `.playwright-mcp/`. All of the above was performed
  **after** the fix, i.e. with the guarded Playwright server.

### Layer 5 — Magic Link login, refresh session persistence, logout cleans cookies

- **Result: PASS.**
- Recorded against the isolated `https://beaconhs-test.xuhaoqing.top` AJ
  deployment; only that tenant (de8a882e-… "Phase AJ Test Tenant", storage
  freeze `ACTIVE`) exists on the AJ stack. Drill/prod containers and
  credentials were not touched.
- Steps and observed results:
  - Cleared all cookies → visited `/login`, title `登录 · BeaconHS`.
  - Magic link issued by Mailpit (drill host, forwarded to 127.0.0.1:13016
    read-only) for the request; link host is
    `beaconhs-test.xuhaoqing.top` with `callbackURL=%2Fauth%2Fcontinue`.
  - After opening the link, the page landed on `/auth/continue` then
    `/dashboard`, `Title: Dashboard · BeaconHS`, shell rendered, cookies:
    `__Secure-better-auth.session_token`, `__Secure-better-auth.session_data`,
    both `Secure`, `HttpOnly`, `SameSite=Lax`, domain `beaconhs-test…`.
  - Hard reload kept `/dashboard` and 29 `nav a` targets; deep-linking to
    `/incidents` stayed authenticated; a second tab in the same context stayed
    logged in; cookies still present.
  - Sign-out (Account menu → Sign out) returned to `/login`, cookies were
    exactly `[]`, `localStorage` empty, and a subsequent visit to
    `/incidents` bounced back to `/login` with title `登录 · BeaconHS`.

### Layer 6 — Upload UI E2E

- **Result: FAIL (not attributed to the Phase AM change — pre-existing
  environmental mismatch).**
- What was driven (all RUNTIME VERIFIED via the now-guarded server):
  - A disposable equipment record _“AM-Playwright-Repair-Probe (disposable)”_
    was created in the isolated AJ test tenant through the real UI at
    `/equipment/new` (record id `63955a8d-169c-4234-a931-c774213e124f`).
  - Opened `?tab=files&drawer=upload-file`, chose a 2 MiB valid-PDF
    (`2097159` bytes, magic header `%PDF-1.4`, SHA-256
    `dd84298c08add5bb36cd9b8d84e0ffcb7ead34c530a43ab95dfa87ae19a5cfcb`).
  - The OS file chooser was invoked through the drawer's dropzone
    (`page.evaluate(() => input.closest('div').click())` + `setFiles`); the file
    appears in the drawer as `am-upload-probe.pdf`.
  - Terminal state after 18 s of waiting was
    `li` text `am-upload-probe.pdf Network error during upload Dismiss` — the
    upload **did not** complete. No attachment row was created
    (verified Postgres: 0 `attachments` for that tenant created in the window).
  - Two orphaned `attachment_upload_reservations` rows were cleaned up (see §7).
- Precise failure cause (from the browser console — verified):
  ```
  Connecting to 'http://127.0.0.1:3012/beaconhs-phase-aj/t/de8a882e-...
  /_pending/…?X-Amz-...' violates the following Content Security Policy
  directive: "connect-src 'self' https://nominatim.openstreetmap.org
  https://api.nango.dev". The action has been blocked.
  ```
  The presigned PUT issued by the AJ web process resolves to the drill-host
  loopback address `127.0.0.1:3012` and is therefore blocked by the page-served
  CSP, which only permits `'self'`. **This is not caused by the Phase AM change:
  the guard only affects exception handling inside node.** It is a
  deployment/ops mismatch between the presigned URL endpoint and the page origin,
  outside `apps/web` source. It is recorded as a remaining blocker, not fixed
  here, per the task's rule of not rewriting environment/production config.
- Cleanup performed: disposable record deleted; dangling reservations (2) deleted;
  the probe PDF removed from both `/tmp` and the repo workspace.

### Collabora full editing session

- **Result: NOT RUN.**
- Reason: no prepared editor fixture / storage bucket access at file level;
  would in any case reuse the failed PUT path above. The endpoint it depends on
  has been verified over HTTP in prior phases (Phase AK §8). No browser-side
  collabora session was driven in this pass.

---

## 7. Cleanup notes

- `attachment_upload_reservations`: 2 dangling rows (filenames `am-upload-probe.pdf`) deleted from `beaconhs-phase-aj-postgres-1`.
- `equipment_items`: 1 disposable row (`id 63955a8d-…`) deleted.
- Probe PDF `am-upload-probe.pdf` removed from `.playwright-mcp/` and `/tmp`.
- The Playwright MCP working dir (`.playwright-mcp/` snapshots/logs) was removed
  from the worktree; it is not tracked.
- SSH tunnel `127.0.0.1:13016 → beaconhs-drill:3016` (AJ Mailpit, read-only
  inspection) was closed.

---

## 8. Gates run on the change

| Gate                                                                        | Command                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JSONC parse                                                                 | `node` JSONC validator (trailing commas + line comments) | **PASS** (3 servers, 124 permission rules)                                                                                                                                                                                                                                                                                                                                                 |
| JS syntax                                                                   | `node --check .opencode/mcp/playwright-mcp-guard.mjs`    | **PASS**, exit 0                                                                                                                                                                                                                                                                                                                                                                           |
| Format                                                                      | `prettier --check` on the touched files                  | **PASS**, exit 0                                                                                                                                                                                                                                                                                                                                                                           |
| `git diff --check`                                                          | whitespace error check                                   | **PASS**, exit 0                                                                                                                                                                                                                                                                                                                                                                           |
| full `pnpm format:check / typecheck / lint / test / deadcode:check / build` | **NOT RE-RUN by this pass**                              | The change is confined to `.opencode/` (config JSONC + new `.mjs` guard + the SKILL.md and this report). It does not touch any package graph, schema, TypeScript app source, build inputs, or migrations, so there is no linkable defect to run from it. `pnpm` gates are expected to mirror the previous phases' green results; I flag this as not re-verified rather than claiming PASS. |

---

## 9. Modified files

- `.opencode/opencode.jsonc` (playwright MCP environment — `NODE_OPTIONS` crash
  guard injection; added comments pointing to this report)
- `.opencode/mcp/playwright-mcp-guard.mjs` (new — uncaught exception guard)
- `.opencode/opencode.jsonc.before-am-playwright-repair` (recoverable backup
  of the user's prior config, including their uncommitted modifications)
- `.opencode/skills/ui-e2e/SKILL.md` (added tooling-stability notes)
- `docs/phase-6u-b3-am-playwright-repair-report.md` (this report)

No application/route/schema/storage/permutation files were changed.

---

## 10. Outstanding risks / known limitations

1. The in-flight `tools/call` whose listener throws still fails (no reply
   arrives inside `timeout.execution`); the guard prevents the collateral loss
   of the whole session but not that one call. Future browser scripts MUST keep
   every `page.on(...)` listener body in `try/catch`.
2. The Layer 6 upload failure is **not** fixed by this phase. It stems from
   the drill-host AJ deployment signing MinIO URLs against `127.0.0.1:3012`,
   which the public-page CSP (`connect-src 'self' …`) blocks. Fixing it needs a
   deployment/env decision (make presigned PUT URLs use the public gateway path),
   which is outside the Playwright fix scope. Surfaced, not masked.
3. OpenCode v2.0.30 will still require a config-file reload or process restart
   if the guard itself were to be updated (config change hot-reloaded in this
   run; observed).

---

## 11. Final replies to the layers

| Layer                                                                   | Status                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1. Playwright MCP starts and stays running                              | **PASS**                                                          |
| 2. OpenCode discovers and calls Playwright tools                        | **PASS**                                                          |
| 3. Chromium launches, opens page, simple interaction                    | **PASS**                                                          |
| 4. Access `https://beaconhs-test.xuhaoqing.top`, basic page check       | **PASS**                                                          |
| 5. Magic Link login, refresh session persistence, logout clears cookies | **PASS**                                                          |
| 6. Upload UI E2E                                                        | **FAIL** (pre-existing CSP / loopback-endpoint mismatch — see §6) |
| Collabora full editing session                                          | **NOT RUN** (no fixture; also depends on Layer 6's blocked path)  |
