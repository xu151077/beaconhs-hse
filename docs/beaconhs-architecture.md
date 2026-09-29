# BeaconHS — Technical Architecture Audit

> **Status:** read-only audit snapshot. **Audited:** 2026-09-29 · **Commit:** `70da27c4` ·
> **Scope:** the entire repository at that commit, with a working-tree delta limited to the
> operator's SeaweedFS change in `docker-compose.yml` (see [SeaweedFS impact](./beaconhs-seaweedfs-impact.md)).
>
> This document describes **upstream state as observed**. It is not living documentation and
> will drift. It deliberately makes no change recommendations except where flagged in
> [Risks](#risks--open-questions).

## 摘要（中文执行摘要）

BeaconHS **本身已经是一个成熟的 HSE 平台**，不是需要从零建设的通用系统。核心结论：

- **技术栈**：Next.js 16.3.5 全栈单体。没有独立后端服务（无 Express/Fastify/Nest），
  "后端" = 15 个 `/api` 路由处理器 + 115 个 `'use server'` server action 文件。
- **数据层**：PostgreSQL 16，193 张 Drizzle 表，其中 187 张启用 `FORCE ROW LEVEL SECURITY`，
  租户隔离在数据库层强制，并有测试保证 RLS 清单与 schema 永不脱节。
- **权限**：92 个权限字符串，支持通配符、读取层级（`read.all ⊇ read.site ⊇ read.self`）、
  范围对象（site/team/crew/person/self），deny 优先。**无缓存**，每请求实时计算。
- **异步**：BullMQ 8 个队列 + 12 个 cron 计划。**无 WebSocket、无 SSE、无实时推送**，
  依靠 HTTP + `router.refresh()`。
- **插件系统已被官方删除**（`0002_drop_retired_plugin_tables.sql`）。`plugins/` 目录为空。
  唯一的扩展接缝是 `packages/integrations`（9 触发器 / 5 目标）与 `packages/sync`（5 连接器）。
- **测试**：约 346 个测试文件，但**无 e2e / 无 Playwright / 无 DOM 测试**，
  且权限模型包 `packages/tenant` **完全没有测试**。

**对 HSE 二次开发最重要的三点结论：**

1. **17 项 HSE 目标能力中，没有一项是完全缺失的**，只有 Machinery Certificate 属于真正新建。
   Personnel / Training / HSE Inspection / Incident / Investigation / HSE Action 足够成熟，
   应直接保留（PRESERVE）。
2. **新增原生模块成本约 37 个注册点**；而用 Builder 表单实现成本接近于 0 ——
   仓库自己就把原生 Lift Plans 和 Toolbox Talks 模块删掉、改成表单模板重新交付。
   这应作为整个 HSE 建设的策略主线。
3. **最大技术风险是权限模型无测试 + 审计日志无防篡改**。对需要满足法定留痕的 HSE 产品，
   这两项是优先补强对象。

---

# Part 1 — Technical Architecture

## 1.1 Backend runtime

**There is no separate backend service.** Grepped `express|fastify|koa|@nestjs|http.createServer`
across all sources — zero matches. The only HTTP listener in the process is Next.js's own.

| Component       | Detail                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Node            | `24.18.0` (`.nvmrc:1`, `package.json:7-9` pins `>=24.18.0 <25`)                                                                                 |
| `apps/web`      | Next.js `16.3.5` exact (`apps/web/package.json:71`), App Router, `output: 'standalone'` (`next.config.ts:7`)                                    |
| `apps/worker`   | Two entrypoints: `src/index.ts` (8 BullMQ workers, `index.ts:17-26`) and `src/scheduler.ts` (16 lines — registers crons then `process.exit(0)`) |
| Worker aux      | `src/health.ts`, `src/storage-init.ts`, `src/instrument.ts`                                                                                     |
| Container roles | `web` / `worker` / `scheduler` / `storage-init`, dispatched by `docker/entrypoint.sh:4-21`                                                      |

Next 16 conventions are in use: `params` is a `Promise` in route handlers
(`apps/web/src/app/api/v1/[entity]/route.ts:26`).

### Route handler inventory — exactly 15 under `app/api/`

| Path                                                | Methods                           |
| --------------------------------------------------- | --------------------------------- |
| `api/auth/[...all]/route.ts`                        | GET, POST (Better-Auth catch-all) |
| `api/v1/route.ts`                                   | GET (service discovery)           |
| `api/v1/docs/route.ts`                              | GET (HTML docs)                   |
| `api/v1/openapi.json/route.ts`                      | GET                               |
| `api/v1/[entity]/route.ts`                          | GET, POST                         |
| `api/v1/[entity]/[id]/route.ts`                     | GET, PATCH, DELETE                |
| `api/v1/apps/route.ts`                              | GET                               |
| `api/v1/apps/[templateKey]/responses/route.ts`      | GET, POST                         |
| `api/v1/apps/[templateKey]/responses/[id]/route.ts` | GET, PATCH, DELETE                |
| `api/attachments/[id]/route.ts`                     | GET                               |
| `api/apps/draft-save/route.ts`                      | POST                              |
| `api/search/route.ts`                               | GET                               |
| `api/picker-options/route.ts`                       | GET                               |
| `api/health/ready/route.ts`                         | GET                               |
| `api/internal/domain-events/[id]/route.ts`          | POST (worker → web)               |

**55 further route handlers** live outside `/api`, overwhelmingly PDF/CSV export generators
under `(app)` (e.g. `(app)/incidents/export.csv/route.ts`), plus 2 AI streaming routes and
2 WOPI routes for the Collabora Online bridge.

## 1.2 Frontend

- **Next.js `16.3.5`**, **React `19.2.7`** (both exact pins).
- **Tailwind `^4.3.2`**, CSS-first config: `apps/web/src/app/globals.css:1-7` imports
  `tailwindcss`, `@beaconhs/ui/styles.css`, and a JS config for content globs
  (`apps/web/tailwind.config.ts:6`).
- **Dark mode is class-based** via `.dark` (`@custom-variant dark (&:where(.dark, .dark *))`).
- **i18n**: `next-intl 4.13.2`, wired at `next.config.ts:3,67`. **3 locales: `en`, `fr`, `es`**
  (`packages/i18n/src/index.ts:1`). Message keys are hashed (`m_1f0a25de4c8df0`) and coverage
  is enforced by `apps/web/src/i18n/i18n-coverage.test.ts`.
- **No global state library.** Grepped `zustand|redux|@reduxjs|jotai|recoil` — zero matches.
  State is React local state + `React.cache()` for per-request dedup + a few context providers
  (`ThemeProvider`, `NavigationProvider`, `RiskMatrixProvider`, `WalkthroughProvider`).
- **`packages/ui`** exports 31 primitives (`packages/ui/src/index.ts:1-26`): button, input,
  textarea, select, search-select, card, label, badge, alert, table, skeleton, separator,
  page-header, drawer, popover, empty-state, animated-number, sparkline, tab-content,
  rich-text-editor (TipTap), file-uploader, signature-pad, link-context, text-context.
- Notable web-only libs: `@xyflow/react` (flow canvas), `grapesjs` (design studio),
  `@excalidraw/excalidraw` (sketch), `echarts` (charts), `pdfjs-dist`, `pagedjs`, `exceljs`.

### Navigation — 23 registered modules in 6 groups

`apps/web/src/lib/nav/registry.ts:63-71` defines `NAV_GROUP_ORDER`:

| Group               | Modules                                                            |
| ------------------- | ------------------------------------------------------------------ |
| **Overview**        | dashboard, assistant, feed, my, notifications                      |
| **Frontline**       | inspections, hazid, journals, incidents, corrective-actions, tools |
| **Knowledge**       | training, documents, help                                          |
| **Assets & people** | people, locations, equipment, ppe                                  |
| **Assurance**       | compliance, insights, reports                                      |
| **Administration**  | admin, forms                                                       |

Module keys present (23): `admin assistant compliance corrective-actions dashboard documents
equipment feed forms hazid help incidents insights inspections journals locations my
notifications people ppe reports tools training`.

Each entry carries `requiredPermission` or `requiredAnyPermission`; tenant saved overrides
merge via `resolveNavGroups()` in `apps/web/src/app/(app)/layout.tsx:68`. The layout forces
`export const dynamic = 'force-dynamic'` (`(app)/layout.tsx:35`) and renders `AppShell`.

## 1.3 Database

**PostgreSQL 16** (`docker-compose.yml:6` `postgres:16-alpine`, host port 5433; CI uses a
SHA-pinned `postgres:16-alpine`).

| Property         | Value                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Table count      | **193** `pgTable(` declarations across 76 schema files                                          |
| Tenant-scoped    | **187** — all present in `TENANT_SCOPED_TABLES`                                                 |
| Global (6)       | `tenants`, `user`, `session`, `account`, `verification`, `platform_settings`                    |
| Extensions       | `pgcrypto`, `pg_trgm` — created in `scripts/cluster/provision.sql:91-92`, **not** in migrations |
| Full-text search | built-in `tsvector` + GIN index (`drizzle/0000_init.sql:2691, 4226`)                            |

### Row-level security — the tenant isolation boundary

`packages/db/src/rls.ts` (331 lines) is the mechanism:

- `TENANT_SCOPED_TABLES` (`rls.ts:105-331`) — **187 entries**, `as const`.
- Enforcement is `ENABLE` **plus** `FORCE ROW LEVEL SECURITY` (`rls.ts:66`) — so even the
  table owner is subject to the policy.
- Policy body is a single index-usable equality (`rls.ts:61, 95-99`):
  ```sql
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  ```
  The file comment at `rls.ts:46-51` explains that an earlier `OR current_setting('app.bypass_rls')='on'`
  branch was removed because it forced sequential scans; bypass is now a **role attribute**
  (`beaconhs_super` holds `BYPASSRLS`).
- `report_definitions` is the single special case (`rls.ts:77-92`): a `FOR SELECT` policy also
  allows `tenant_id IS NULL` (global built-in reports), while INSERT/UPDATE/DELETE policies
  forbid touching global rows.
- Applied atomically in one transaction by `applyRlsPolicies()` (`packages/db/src/migrate.ts:433-445`),
  printing `✔ RLS applied atomically (187 tables)`.
- Idempotent via `DROP POLICY IF EXISTS` (`rls.ts:67-70`).

**The list is test-enforced.** `packages/db/src/rls.test.ts:8-19` asserts that
`TENANT_SCOPED_TABLES` _exactly equals_ every Drizzle table having a `tenant_id` column, and
`rls.test.ts:21-28` asserts the policy stays a single sargable equality. **A new tenant table
that is not added to this list fails CI.** This is the single most important invariant for
anyone adding tables.

Scope helpers: `withTenant()` (`rls.ts:13-22`, `SET LOCAL app.tenant_id`) and
`withSuperAdmin()` (`rls.ts:28-35`, always the BYPASSRLS pool).

## 1.4 ORM

- **Drizzle ORM `^0.45.2`**, **drizzle-kit `^0.31.10`**, driver **postgres.js `^3.4.9`**.
- Config: `packages/db/drizzle.config.ts` — `schema: './src/schema/index.ts'`, `out: './drizzle'`,
  `dialect: 'postgresql'`, `strict: true`.
- **42 migration files**, `0000_init.sql` … `0041_document_book_cover_template.sql`, plus
  `drizzle/meta/_journal.json` and snapshots. (Note: `0033` is absent from the directory —
  a deliberately dropped gap; the journal jumps accordingly.)
- **Custom migration runner** — `packages/db/src/migrate.ts` (561 lines) wraps drizzle's
  migrator and layers on: schema ownership assertion (`:53`), migration ledger validation
  (`:98-130`), `SET ROLE` to the owner (`:224`), a 5-role preflight (`:262`), an advisory lock
  `pg_advisory_lock('beaconhs:schema-migration')` (`:508`), RLS install, least-privilege grants,
  kiosk-PIN hash invariants, role-permission convergence, planner statistics, reporting views.
- **Idempotency is proven in CI** — `migrate.ts` is executed twice in a row
  (`.github/workflows/ci.yml:90-92`).
- `db:push` / `db:push:ci` exist in the root `package.json:19-20` but are **used by no
  workflow or script**. CI and deploy both use `src/migrate.ts`. (Dead scripts — see Risks.)

## 1.5 API

**Two distinct API surfaces, with different conventions.**

### (a) The public REST API — generated from the reports entity catalogue

`apps/web/src/app/api/v1/` is a thin generic surface. `apps/web/src/lib/api/openapi.ts:1-4`:

> "OpenAPI 3.1 document, generated from the reports entity registry so the spec can never
> drift from what /api/v1/[entity] actually serves. Hand-built plain objects (no extra dependency)"

The single source of truth is `REPORT_ENTITIES` in `packages/reports/src/entities.ts`;
`lib/api/{permissions,write,records,query}.ts` map an entity to its permission and
read/write capability. **Adding a row to `entities.ts` automatically publishes
`/api/v1/{key}`, an Insights binding, and export-hub presence.**

Representative handler — `apps/web/src/app/api/v1/[entity]/route.ts` (84 lines), showing the
canonical order: authenticate API key → resolve entity → check permission → read → respond.

Auth is a bearer `bhs_live_…` key, SHA-256 hashed and looked up across tenants
(`lib/api/auth.ts:1-7,39-60`); rate limiting via `@beaconhs/jobs/rate-limit`; write requests
require an `Idempotency-Key` (`lib/api/idempotency.ts`).

### (b) Server actions — no shared envelope

**115 files** begin with a top-level `'use server'`, plus inline `'use server'` inside ~10
`.tsx` pages. Two naming conventions coexist: `_actions.ts` (60 files, the dominant
convention) and `actions.ts` (15 files, mostly public auth routes). A few modules use an
`_actions/` directory (`people/_actions/`, `training/_actions/`, `locations/_actions/`).

**There is no shared result envelope.** Every module re-declares its own ad-hoc union, e.g.
`(app)/incidents/_actions.ts:24-27`:

```ts
type BulkActionResult =
  { ok: true; updated: number; skipped: number } | { ok: false; error: string }
```

This is duplicated across ~60 modules. The REST layer _does_ have a shared convention
(`lib/api/errors.ts:8-18`: `ApiError` with a fixed code union and `errorResponse()`), but it
is not reused by server actions.

**Validation** is `zod ^4.4.3` throughout. Per-entity write schemas live in
`lib/api/write.ts:202-227` (`incidentCreate`, `correctiveActionCreate`, `inspectionCreate`, …).

**Client → server mechanisms** (no tRPC, no GraphQL — grepped, zero matches):
server actions (115), route handlers (70 total), and 12 direct `fetch()` sites for streaming
and remote pickers.

## 1.6 Authentication

**Better-Auth `^1.6.23`**, configured at `packages/auth/src/server.ts:34-133`.

| Aspect                  | Reality                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database                | A **raw `pg ^8.22.0` Pool** (`server.ts:35`), not the Drizzle instance                                                                                        |
| Email/password          | Enabled, `disableSignUp: true` (invite-only), `minPasswordLength: 8`                                                                                          |
| Password hashing        | Custom `verifyLegacyOrCurrentPassword` (`server.ts:51`) accepting legacy bcrypt **and** current scrypt; new hashes use the SDK default                        |
| Plugins                 | **Exactly two**: `magicLink` (`server.ts:69-96`) and `nextCookies` (`:97`)                                                                                    |
| Email OTP               | **Does not exist**                                                                                                                                            |
| Passkeys / WebAuthn     | **Do not exist**                                                                                                                                              |
| Two-factor              | **Does not exist**                                                                                                                                            |
| **SSO / OIDC / social** | **Does not exist** — no `socialProviders`, no `genericOAuth`, no `sso()`                                                                                      |
| Session                 | 30-day expiry, 1-day update age, 5-minute cookie cache (`server.ts:63-67`); stored in the Postgres `session` table (`schema/core.ts:87-121`)                  |
| Secret hardening        | Throws in production if `BETTER_AUTH_SECRET` missing or < 32 chars (`server.ts:23-32`); the same secret derives AES-256-GCM keys via HKDF (`packages/crypto`) |

> **HSE relevance:** an enterprise HSE rollout very often requires SSO or SCIM provisioning.
> BeaconHS has **neither**. Adding OIDC is a first-class change to `packages/auth`, not a config
> toggle. This is listed as an open question below.

### Session resolution

`apps/web/src/lib/auth.ts` is the single request entry point:

- `getRequestContext = cache(async () => …)` (`:139`) — React `cache()` so layout, page, and
  chrome resolve once per render.
- Reads the session via `getAuth().api.getSession({ headers: await headers() })` (`:141`).
- Reads two cookies, `bhs-active-tenant` and `bhs-active-role` (`:28-31`), both UUID-validated
  to defeat tampered cookies (`:155-156`).
- The entire identity/membership/role resolution runs inside `withSuperAdmin(db, …)` (`:163`)
  because tenant tables are FORCE-RLS.
- Returns `makeTenantContext(db, {...})` whose `db()` is `withTenant(baseDb, tenantId, …)`
  (`packages/tenant/src/index.ts:82-91`).
- `requireRequestContext()` (`:387-391`) redirects to `/auth/continue` or `/login`.
- `requireExportContext()` (`:401-406`) additionally asserts `admin.data.export` and blocks
  impersonation.
- **Impersonation** (`resolveImpersonation`, `:307-385`) stores its pointer on the **admin's own
  `session` row** (`sessions.impersonatingUserId` / `impersonationTenantId` /
  `impersonationExpiresAt`, `schema/core.ts:106-112`) — server-authoritative, dies on sign-out,
  and is re-authorized against the actor on **every** request. Super-admins are never
  impersonatable (`:345`).

Public pages: `/login`, `/forgot-password`, `/reset-password`, `/auth/continue`,
`/kiosk` (shared-tablet PIN), `/equipment-kiosk`, `/invite/accept`, and `/verify/**`
(public QR credential verification, no session).

## 1.7 Authorization

### The permission model

`packages/tenant/src/index.ts` (2 files: `index.ts` + `regulatory.ts`).

- **92 permission strings** in the canonical `PERMISSION_CATALOGUE`
  (`packages/db/src/schema/iam.ts:155-296`). The type is deliberately loose
  (`iam.ts:16-18`): `export type PermissionKey = string`, convention `module.action[.qualifier]`.
- **Wildcards** — `can()` (`tenant/index.ts:101-110`):
  ```ts
  export function can(ctx: RequestContext, perm: string): boolean {
    if (ctx.isSuperAdmin) return true
    if (ctx.permissions.has(perm)) return true
    if (readTierCovers(ctx.permissions, perm)) return true
    for (const p of ctx.permissions) {
      if (p.endsWith('.*') && perm.startsWith(p.slice(0, -1))) return true
    }
    return false
  }
  ```
- **Read tiers** — a second implicit rule, `readTierCovers()` (`:243-253`):
  `X.read.all ⊇ X.read.site ⊇ X.read.self`.
- `assertCan()` (`:255-266`) throws `ForbiddenError`.
- **Scope objects** — `RoleScope` (`iam.ts:49-55`):
  `{type:'tenant'} | {type:'sites',siteIds} | {type:'team',departmentIds,groupIds} |
{type:'people',personIds} | {type:'crews',crewIds} | {type:'self'}`
- **Resolution** — `resolveMembershipAccess()` (`:174-224`): union across a user's role
  assignments → apply `grant` overrides → apply denies. **Deny always wins**; a deny of a
  specific key expands a wildcard grant into its exact catalogue members (`:226-241`).
- Record-level predicates: `moduleScopeWhere()` / `recordVisibilityWhere()` in
  `apps/web/src/lib/visibility.ts:46-140`. Notably `visibility.ts:93` returns SQL `false`
  when no scope grants anything — _"never fall through to all"_.

### Roles are rows carrying a JSON array

- `roles` (`iam.ts:20-39`): `tenantId`, `key`, `name`, `isBuiltIn`, and
  **`permissions: jsonb().$type<PermissionKey[]>().default([]).notNull()`** — a per-tenant JSON
  array of strings, **not** a join table.
- `role_assignments` (`iam.ts:57-93`): `(tenantId, tenantUserId, roleId)` +
  `scope: jsonb().$type<RoleScope>()`, unique per (tenant, user, role) so two rows cannot
  union their scopes (`:73-76`).
- `user_permission_overrides` (`iam.ts:119-144`): one row per (user, permission),
  effect enum `grant | deny`.
- `BUILTIN_ROLES` (`iam.ts:301-448`): `worker`, `foreman`, `safety_manager`, `tenant_admin`
  (the last = the full catalogue, `:446`). Converged on every migration by
  `convergeRolePermissions()` (`packages/db/src/migrate.ts:161-222`), which also prunes
  retired keys from custom roles.

### Super-admin

1. `users.isSuperAdmin` boolean (`schema/core.ts:77`) on the global Better-Auth user row.
2. `getRequestContext` grants `permissions = new Set(['*'])`, `scopes: [{type:'tenant'}]`
   (`apps/web/src/lib/auth.ts:227-238`).
3. `can()` short-circuits to `true` (`tenant/index.ts:102`).
4. **Data stays tenant-bounded** — the context is still `makeTenantContext` with a real
   `tenantId` chosen via the `bhs-active-tenant` cookie, else the oldest membership
   (`auth.ts:176-240`).
5. Cross-tenant reads use the BYPASSRLS `superDb` pool via `withSuperAdmin`.

### Caching: none

Permissions are resolved **fresh on every request** inside the `withSuperAdmin` transaction
(`auth.ts:163, 274-278`). There is no Redis or in-process permission cache; the only
memoization is React `cache()` (per-request). This is a deliberate correctness-over-latency
choice, but it also means the untested `packages/tenant` code is on every single request's
critical path.

## 1.8 Cache

**There is no application cache.** All `ioredis` usage is confined to `packages/jobs`:

| File                              | Purpose                                                   |
| --------------------------------- | --------------------------------------------------------- |
| `packages/jobs/src/connection.ts` | BullMQ producer + blocking connections                    |
| `packages/jobs/src/rate-limit.ts` | Fixed-window rate limiter (Lua `INCR`+`EXPIRE`, `:37-43`) |
| `packages/jobs/src/health.ts`     | Short-lived readiness probe                               |

Nothing outside `packages/jobs` imports `ioredis`. `.env.example:21` says *"Redis (for BullMQ

- sessions/cache)"*, but **no session or application cache is stored in Redis** — Better-Auth
  sessions live in Postgres.

**Next.js caching**: the authenticated shell is `force-dynamic`. Invalidation is
`revalidatePath` only. Grepped `revalidateTag` — **zero matches**. `unstable_cache`,
`'use cache'`, `cacheTag`, `cacheLife` — **zero matches**. Public API responses are forced
uncacheable by `noStore()` (`lib/api/errors.ts:83-90`).

## 1.9 Queue

**BullMQ `^5.80.2`** on Redis via `ioredis 5.11.1` (pinned in `pnpm-workspace.yaml:22`).
**8 queues**, defined in `packages/jobs/src/queues/`:

| Queue           | Producer                                                                             | Worker                 | Concurrency    | Attempts / backoff | retain complete / fail |
| --------------- | ------------------------------------------------------------------------------------ | ---------------------- | -------------- | ------------------ | ---------------------- |
| `emails`        | `enqueueEmail`                                                                       | `workers/email.ts`     | 10             | 5 / exp 30 s       | 7 d / 30 d             |
| `pdfs`          | `enqueuePdf`, `enqueuePdfEmail`, `enqueueDocumentVersionRender`, `renderPdfOnDemand` | `workers/pdf.ts`       | 3              | 3 / exp 15 s       | 3 d / 30 d             |
| `notifications` | `enqueueNotification`, `@beaconhs/events`                                            | `workers/notify.ts`    | 10             | 3 / **fixed** 5 s  | 1 d / 7 d              |
| `scheduled`     | `enqueueScheduled`                                                                   | `workers/scheduled.ts` | 5              | 3 / exp 10 s       | 1 d / 7 d              |
| `reports`       | `enqueueReportRun`                                                                   | `workers/reports.ts`   | 2              | 3 / exp 30 s       | 7 d / 30 d             |
| `outbound`      | `enqueueOutboundDispatch`, `@beaconhs/integrations`                                  | `workers/outbound.ts`  | 5              | 5 / exp 15 s       | 7 d / 30 d             |
| `push`          | `enqueuePush` (notify fan-out)                                                       | `workers/push.ts`      | 10             | 5 / exp 10 s       | 1 d / 30 d             |
| `ai`            | `enqueueAiJob`                                                                       | `workers/ai.ts`        | 2 (5 min lock) | 2 / exp 30 s       | 1 d / 7 d              |

**Deterministic jobIds are a real convention** and give at-most-once semantics for free:
`email-fanout|<sha256(jobId\0recipient)>` (`email.ts:65-70`),
`pdf|<tenantId>|<kind>|<entityId>` (`pdf.ts:293-308`),
`report-run|<runId>`, `sync-run|<tenantId>|<connectionId>`, `notification-batch|<sha256>`,
`journal-analysis|<tenantId>|<days>`.

**Payload validation is hand-written** — `packages/jobs/src/validation.ts` (61 lines) plus
per-queue bounds, e.g. `assertPdfJobData` (`pdf.ts:174-276`) caps at 16 MiB job / 2 MiB HTML /
500 fields / 5000 rows / 100 photos.

- **BullMQ Flows (parent/child): do not exist.** No `FlowProducer`, no `{parent: …}`.
  (The word "flow" in this codebase means the _automation_ feature, not BullMQ Flows.)
- **DLQ / dead-letter: does not exist.** Grepped `dead.?letter|\bDLQ\b` — zero matches.
  Failed jobs are **retained** in Redis for 7–30 days (`removeOnFail`) and reported to Sentry
  via `captureWorkerFailure` (`apps/worker/src/index.ts:30-41`).

## 1.10 Scheduler

`apps/worker/src/scheduler.ts` is a **cron registrar, not a long-running process** — it calls
`registerSchedules()` then exits (`scheduler.ts:5-10`). **12 recurring schedules** in
`packages/jobs/src/queues/scheduled.ts:103-194`:

| Name                           | Cron           | Handler                                              |
| ------------------------------ | -------------- | ---------------------------------------------------- |
| `tick:form_session`            | `* * * * *`    | `lib/session-overdue-flows.ts`                       |
| `tick:reports`                 | `*/5 * * * *`  | `lib/report-scheduler.ts`                            |
| `tick:compliance_scan`         | `* * * * *`    | `lib/compliance-scanner.ts`                          |
| `tick:escalation`              | `30 6 * * *`   | `lib/escalation-scanner.ts`                          |
| `tick:digest`                  | `5 * * * *`    | `lib/digest-scanner.ts`                              |
| `tick:scheduled_flow`          | `* * * * *`    | `lib/scheduled-flow-runner.ts`                       |
| `tick:sync_scan`               | `*/15 * * * *` | `lib/sync-scanner.ts`                                |
| `tick:db_maintenance`          | `30 3 * * *`   | `lib/db-maintenance.ts`                              |
| `tick:domain_event_outbox`     | `* * * * *`    | `lib/domain-event-outbox.ts`                         |
| `tick:storage_object_deletion` | `* * * * *`    | `lib/storage-object-deletion-outbox.ts` + reconciler |
| `tick:office_render_reconcile` | `*/5 * * * *`  | `lib/office-render-reconcile.ts`                     |
| `tick:journal_analysis`        | `20 * * * *`   | `lib/journal-analysis.ts`                            |

**Reconciliation is deliberate**: `registerSchedules()` first calls
`removeUnconfiguredSchedules()` to delete any repeat whose (key, name, pattern) no longer
matches, then re-adds each with an **explicit `repeat.key`** so a renamed jobId cannot survive
as a shadow timer (`scheduled.ts:196-228`).

**Tenant-level crons are evaluated inside the minute-tick scanners**, not registered as
BullMQ repeats — `packages/compliance/src/schedule.ts` (using `cron-parser`), plus
`lib/report-cadence.ts` and `lib/scheduled-flow-runner.ts`. The tick's _intended_ minute is
derived from `job.timestamp + (job.opts.delay ?? 0)` so retries cannot silently skip a tenant
(`workers/scheduled.ts:32-34`).

**Plugin cron work does not exist** (see Part 5 of the extension-points doc).

## 1.11 WebSocket / realtime

**None.** This is a definitive negative, established by grepping all of:
`text/event-stream`, `EventSource`, `new WebSocket`, `socket.io`, `ws` (not even a dependency),
and `revalidateTag` — **all zero matches**.

What does exist:

1. **AI streaming** — the Vercel AI SDK's own UI-message stream returned as a streaming
   `Response` (`(app)/assistant/chat/route.ts`, produced by
   `result.toUIMessageStreamResponse()` at `packages/ai/src/agent.ts:64`, consumed by
   `readUIMessageStream()`). A source-level contract test pins the transport
   (`lib/assistant-stream-cutover-contract.test.ts:8-26`). A second streaming endpoint exists
   at `(app)/journals/ai/route.ts`. These are _not_ SSE — they are chunked SDK protocol streams.
2. **BullMQ → web over HTTP** — durable Flow commands POST to
   `/api/internal/domain-events/[id]` over the private network.
3. **`router.refresh()`** after mutations — ~30+ call sites. The `(app)` layout deliberately
   remounts on tenant/role change because `router.refresh()` preserves client state
   (`(app)/layout.tsx:127-138`).
4. **One polling `setInterval`** — the impersonation countdown banner
   (`components/impersonation-banner.tsx:28`).

Notifications are **not** pushed to the browser; the unread count is fetched server-side per
request (`(app)/layout.tsx:59-65`). Web Push is outbound device notification only.

> **HSE relevance:** multi-crew, multi-site HSE platforms usually want live status boards.
> BeaconHS has **no realtime substrate at all**. Any live-update requirement is net-new
> infrastructure (SSE routes plus client reconnection, or a dedicated websocket service).

## 1.12 Logging

**There is no structured logger.** Grepped `pino|winston|createLogger` — **zero matches**.
Everything is `console.*`. There is no `LOG_LEVEL` env var and no logger abstraction.

Sentry is the only real telemetry, in three configs:
`apps/worker/src/instrument.ts:5-12` (`@sentry/node` 10.65.0),
`apps/web/src/sentry.server.config.ts`, `apps/web/src/sentry.edge.config.ts` — all with
`sendDefaultPii: false` (PII redaction), `tracesSampleRate: 0.05`.

Deliberate redaction points: `packages/auth/src/server.ts:164` ("Secret-bearing auth URLs are
never written to application logs"); `packages/sync/src/egress.ts`;
`packages/appkit-feedback/src/redact.ts`; ioredis error logging silenced
(`packages/jobs/src/health.ts:28`); and `packages/db/src/migrate.ts:485-490` sets
`onnotice: () => undefined` so deploy logs keep explicit phase summaries instead of thousands
of "does not exist, skipping" notices.

Worker log style is emoji-prefixed single lines: ``console.log(`✔ ${w.name}#${job.id} …`)``
(`apps/worker/src/index.ts:29`).

**There is no application log table.** `email_log` and `sms_log` are delivery ledgers, not logs.

## 1.13 Audit

**Table** — `packages/db/src/schema/audit.ts:5-31`, `audit_log`:
`tenantId` (cascade), `actorUserId` (set null), `actorIp`, `actorUserAgent`, `entityType`,
`entityId`, `action`, `dedupKey`, `summary`, **`before: jsonb`, `after: jsonb`**, `metadata`,
`occurredAt`. Indexes on `(tenantId, occurredAt)`, `(tenantId, entityType, entityId)`,
`(tenantId, actorUserId, occurredAt)`, unique on `(tenantId, dedupKey)`.

**Actions** — `packages/audit/src/index.ts:4-19`, 15 values:
`create, update, delete, sign, publish, archive, invite, login, logout, export, copy, send,
view_sensitive, impersonate, impersonate_stop`.

**Writing** — two layers:

- `packages/audit/src/index.ts:35-49` `audit(db, evt)` plus a shallow `diff()` (`:55-77`).
- `apps/web/src/lib/audit.ts` is the path actually used:
  `recordAuditInTransaction(tx, ctx, evt)` (`:24-69`) writes **on the caller's existing
  transaction**, so the mutation and its evidence commit or roll back together (`:19-22`);
  `recordAudit(ctx, evt)` (`:71-73`) wraps it.
- **Dual attribution under impersonation** (`:29-52`): `actorUserId` stays the _target_ (so it
  reads as their own activity) while the real admin is stamped into
  `metadata.impersonatorUserId` and the summary is prefixed `[impersonated]`.
  API-key actors are nulled and tagged `actorKind: 'api_key'`.

**Read paths** — `recentActivityForEntity()` and `activityPageForEntity()`
(`apps/web/src/lib/audit.ts:75-191`); the latter returns exact `total`/`filteredTotal` and an
action histogram, and explicitly _"never silently truncates a record's history."_

**Enforcement is contract-tested.** Several tests read the source and assert an audit call
exists in specific mutations — e.g. `corrective-action-compliance-evidence-lifecycle-contract.test.ts:43,69,86`,
`equipment-inspection-atomicity-contract.test.ts:64-157`,
`download-audit-prefetch-contract.test.ts:18,32`. 60+ call sites, concentrated in
`lib/api/write.ts` (23 of them).

**Retention** — `packages/db/src/maintenance.ts:26` declares `audit_log` with
`defaultRetentionDays: 730` (**2 years**), super-admin configurable in
`platform_settings.database`, `null` = keep forever. Executed by
`apps/worker/src/lib/db-maintenance.ts:39-69` in 5000-row CTID batches as the BYPASSRLS role.

**Immutability: no.** There is no UPDATE/DELETE-blocking trigger, no hash chain, no
signature, no WORM target on `audit_log`. The runtime DML role is granted
`SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` (`packages/db/src/migrate.ts:406`), so any
compromise of that role can alter or erase history. **This is the most significant gap for an
HSE product with a statutory record-keeping obligation.** See Risks.

## 1.14 Testing

**Three runners, no shared config.**

| Runner          | Packages                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest 4.1.11` | web, worker, db, auth, jobs, ui, forms-core, forms-pdf, compliance, reports, crypto, storage, analytics, emails, email-render, i18n, design-studio, sms, office |
| `node:test`     | ai, appkit-feedback, integrations, sync                                                                                                                         |
| **none**        | `tenant`, **`audit` (no `test` script at all)**                                                                                                                 |

**There is no `vitest.config.ts` or `vite.config.ts` anywhere in the repo** and no
`@vitest-environment` pragma. Vitest runs on defaults (node environment) even though `jsdom`
is a web devDependency — so **there are no component-rendering tests at all**.

**~346 test files**: `apps/web` 189, `apps/worker` 27, `packages/*` ~130 (db 51, forms-core 14,
compliance 10, …).

**A distinctive and valuable pattern: source-level contract tests.** Many tests `readFileSync`
a source file and assert specific code patterns are present — e.g. `lib/audit.test.ts`,
`lib/assistant-stream-cutover-contract.test.ts`, `report-built-in-editor-contract.test.ts`.
These pin architectural invariants (an audit call exists here, a permission gate exists there)
without needing a running database.

**What is not covered:**

- **No e2e.** No Playwright, no Cypress, no config, no directory.
- **No DOM/component tests** (no React Testing Library, no jsdom environment in use).
- **`packages/tenant` has no tests and no `test` script** — `can()`, `assertCan`,
  `readTierCovers`, `applyPermissionDenies`, `resolveMembershipAccess`, `recordVisibilityWhere`
  are entirely untested despite being the highest-blast-radius code in the repo.
- **`packages/audit` has no tests.**
- Only 4 of 15 `/api` route handlers have any test.
- No integration tests that hit a live Postgres/Redis from the app (the DB integrity tests are
  AST-based, not live-DB).

## 1.15 Package inventory

All 25 workspace packages are `private: true`, `type: module`, and publish **raw TypeScript
source** (`main`/`types` → `./src/index.ts`); the web app `transpilePackages` them
(`next.config.ts:19-36`) and the worker bundles them with esbuild (`build.mjs:26`).

| Package           | Purpose                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ai`              | Vercel AI SDK wrappers: multi-provider registry, prompts, doc-chat (RAG), extract, vision, digest, journal analysis, agent loop. Uses `node:test`.                                                                                         |
| `analytics`       | Native BI. BHQL query language (zod AST, expression parser, semantic registry) + a SQL compiler/executor hidden behind the `@beaconhs/analytics/server` subpath so a client bundle can never pull in drizzle.                              |
| `appkit-feedback` | In-app PII-safe GitHub issue reporter engine. **Note: publishes as `@braedonsaunders/appkit-feedback`, a vendored third-party package living inside `packages/`.**                                                                         |
| `audit`           | The 15-action union, `audit()` insert, and `diff()`. 77 lines. **No test script.**                                                                                                                                                         |
| `auth`            | Better-Auth config, invite acceptance, legacy-bcrypt verification, client singleton.                                                                                                                                                       |
| `compliance`      | The unified compliance engine: audience resolver, 11 per-module completion adapters, `evaluate` (web) + `materialize` (worker), cron/schedule math, evidence, target lock & retirement. Takes `tx` + `tenantId`, never a `RequestContext`. |
| `crypto`          | Server-only AES-256-GCM secret sealing for stored tenant credentials; keys HKDF-derived from `BETTER_AUTH_SECRET`.                                                                                                                         |
| `db`              | 193-table Drizzle schema, postgres.js client + `superDb`, RLS registry/installer, custom migrate runner, reporting views, retention catalogue, seed data, integrity guards.                                                                |
| `design-studio`   | Print/design canvas for **credentials** (badges, labels, wallet cards): schema, defaults, html, print, plus a `./fabric` canvas subpath. Distinct from the form designer.                                                                  |
| `email-render`    | The single keystone turning a flow `send_email` action into `{subject, html, text}`. Sanitizes authored HTML once at save time, HTML-escapes merge values at interpolation.                                                                |
| `emails`          | Transport abstraction: Resend / SendGrid / Mailgun / Postmark / SMTP, emitting `email_log` rows.                                                                                                                                           |
| `events`          | Domain-event dispatcher **+ transactional outbox**. Resolves audiences and enqueues in-app/push. Module email is deliberately left to Flows so it cannot double-send.                                                                      |
| `forms-core`      | The form engine: schema, 39 field types, validator, scoring, evaluator, automation graph, flow subjects, participants, custom fields, sanitizer. **No DB dependency.**                                                                     |
| `forms-pdf`       | Server-side PDF rendering via `puppeteer-core` against a pinned headless Chrome, plus credential/wallet/report templates.                                                                                                                  |
| `i18n`            | Locale registry and negotiation for `en`/`fr`/`es`. No runtime dependencies.                                                                                                                                                               |
| `integrations`    | Outbound automation: trigger → mapping → destination, published one job per (automation, event). 9 triggers, 5 destinations.                                                                                                               |
| `jobs`            | The 8 queues, 12 cron schedules, payload validators, Redis connection policy, rate limiter.                                                                                                                                                |
| `office`          | LibreOffice + poppler CLI wrappers (PPTX/slides import, document version renders, book concatenation, draft text extraction).                                                                                                              |
| `reports`         | The HSE entity catalogue + DB adapter. Re-exports `@braedonsaunders/appkit-reports` wholesale and adds `REPORT_ENTITIES` and the column-SQL mapping.                                                                                       |
| `sms`             | SMS provider registry and transport, reusing the SSRF-hardened egress from `sync`.                                                                                                                                                         |
| `storage`         | S3-compatible object storage client. **Audited in detail in [the storage audit](./beaconhs-storage-audit.md).**                                                                                                                            |
| `sync`            | **Inbound** data-sync engine (5 connectors) — not offline/mobile. Also hosts the SSRF/egress guard reused by `@beaconhs/ai`.                                                                                                               |
| `tenant`          | Request context + the entire authorization model. 2 files. **No test script.**                                                                                                                                                             |
| `ui`              | 31 shared primitives + the CSS-variable theme.                                                                                                                                                                                             |

`packages/etl` is **excluded** from the workspace (`pnpm-workspace.yaml:4 '!packages/etl'`) and
git-ignored — an optional, customer-specific package.

---

# Part 2 — Project Structure

## 2.1 Directory map

```
apps/web/src/     ~1,446 files, ~317k LOC
├── app/          ~730   routes + co-located module code
│   ├── (app)/    ~640   the entire authenticated app (27 module directories)
│   ├── api/       15   route handlers
│   └── login, kiosk, equipment-kiosk, forgot-password, reset-password,
│       invite, auth, verify, wopi, manifest.webmanifest, favicon.ico
├── components/   ~175  app-level composites
├── lib/          ~290  (flat) + 9 sub-dirs
├── i18n/           6
└── types/          2   (only next-intl.d.ts, vendor.d.ts)

apps/worker/src/   71 files, ~8.7k LOC
├── index.ts, scheduler.ts, health.ts, instrument.ts, storage-init.ts
├── lib/           48   scanners and policies
├── workers/       12   BullMQ handlers
└── scripts/        2
```

**There is no `hooks/` directory** — the three `use-*` modules live in `lib/`.
**All domain types live next to their code** (in `packages/db/src/schema/*.ts`); `types/`
holds only ambient declarations.

## 2.2 Frontend/backend boundary

Four mechanisms, no middleware tier:

| Mechanism               | Count                          | Notes                                    |
| ----------------------- | ------------------------------ | ---------------------------------------- |
| Server actions          | **115** files + ~10 inline     | Primary mutation path                    |
| Route handlers          | **70** total (15 under `/api`) | The other 55 are in-page resource routes |
| Direct client `fetch()` | 12                             | Streaming and remote pickers only        |
| tRPC / GraphQL          | **0**                          | Do not exist                             |

## 2.3 Data access layer

**There is no repository or DAO layer.** Server actions and RSCs call Drizzle directly inside
`ctx.db(async (tx) => …)`. The only abstractions are:

1. `RequestContext.db` — the RLS executor (`packages/tenant` → `packages/db/src/rls.ts`).
2. `moduleScopeWhere()` — the visibility predicate builder (`apps/web/src/lib/visibility.ts`).
3. A handful of shared query helpers in `lib/`.
4. Flat SQL reporting views in `packages/db/src/views.ts`.

### Vertical slice — Incidents list

| Hop              | File                                                                              |
| ---------------- | --------------------------------------------------------------------------------- |
| Page             | `app/(app)/incidents/page.tsx:47-120`                                             |
| Layout shell     | `app/(app)/layout.tsx:37` → `components/app-shell.tsx`                            |
| List layout      | `components/page-layout.tsx:37` `ListPageLayout`                                  |
| Primitives       | `components/{search-input,pagination,filter-bar,sortable-th,table-toolbar}.tsx`   |
| Request context  | `lib/auth.ts` `getRequestContext` / `requireRequestContext`                       |
| RLS executor     | `packages/tenant/src/index.ts:89` → `packages/db/src/rls.ts:13` `withTenant`      |
| Visibility       | `lib/visibility.ts` `moduleScopeWhere(ctx, tx, {prefix:'incidents', …})`          |
| Query            | `incidents/page.tsx:114-120` — `tx.select().from(incidents).leftJoin(orgUnits,…)` |
| Schema           | `packages/db/src/schema/incidents.ts` (+ 9 sub-tables)                            |
| RLS registration | `packages/db/src/rls.ts:133, 259-268`                                             |
| Audit            | `lib/audit.ts` `recordAudit`                                                      |
| Revalidation     | `revalidatePath` in the action                                                    |

## 2.4 Service layer

**Does not exist as a directory.** Glob `**/services/**` — zero matches. Business logic lives in
three places:

1. **Inline in server actions / RSCs** — the dominant pattern: permission check → `ctx.db` →
   audit → `revalidatePath`.
2. **In `packages/*`** when shared: `compliance`, `reports`, `events`, `jobs`, `forms-core`,
   `analytics`, `storage`, `sync`.
3. **In `apps/web/src/lib/<domain>-policy.ts`** — the de-facto service layer, e.g.
   `lib/flows/` (29 files incl. 15 module adapters), `lib/custom-fields/`, `lib/forms/`,
   `lib/assistant/`, `lib/visibility.ts`, `lib/list-params.ts`, `lib/equipment-custody.ts`,
   `lib/document-*-policy.ts`, `lib/training-*-policy.ts`, `lib/incident-investigation.ts`.

One app-local exception: `app/(app)/equipment/vehicle-log/_service.ts`.

## 2.5 API layer

Covered in §1.5. The key insight: **`REPORT_ENTITIES` is the single source of truth for the
public API**, the export hub, and Insights.

## 2.6 UI layer

`apps/web/src/components/page-layout.tsx` provides four shells:

| Export             | Line   | Purpose                                                                                       |
| ------------------ | ------ | --------------------------------------------------------------------------------------------- |
| `PageContainer`    | `:11`  | Content-driven; whole body scrolls                                                            |
| `ListPageLayout`   | `:37`  | Sticky header (title/actions/search/filters) + scrolling table. **The mandatory list shell.** |
| `DetailPageLayout` | `:78`  | Fixed header + alerts + `TabNav`; `fullBleed` for builders                                    |
| `WizardLayout`     | `:145` | 3-row form shell; `wide` = read-only record view                                              |

**List primitives** (AGENTS.md mandates search + filter + pagination on every table):
`lib/list-params.ts` (`parseListParams`, `pickString`, `buildExportHref`),
`components/search-input.tsx`, `components/filter-bar.tsx` (`FilterChips`),
`components/sortable-th.tsx`, `components/pagination.tsx`, `components/table-toolbar.tsx`,
`lib/row-selection.ts`, `lib/bulk-actions.ts`. Multi-table detail pages use a prefixed
sub-table param pattern (`?wo_q=&wo_p=2`).

**Manual** — 38 articles across
`lib/manual/content/{getting-started,frontline,knowledge-assets,oversight-admin}.ts`
(7 + 13 + 10 + 9), assembled in `lib/manual/registry.ts:13-18`, typed by `lib/manual/types.ts`.
Visibility gates mirror the nav registry (`registry.ts:33-38`). Surfaced at `/help`, and read
by the AI assistant via the `search_user_guide` / `read_user_guide` tools.

**Walkthroughs** — 9 tours in `lib/walkthroughs/registry.ts`: `welcome`, `daily-journal`,
`hazard-assessment`, `site-inspection`, `report-incident`, `vehicle-log`, `ppe-inspection`,
`my-training`, `manage-user-access`. Per-tenant config in `walkthrough_settings`, per-user
progress in `walkthrough_progress`, admin UI at `/admin/walkthroughs`. Steps target
`data-walkthrough="…"` attributes and stable `a[href="…"]` selectors (`registry.ts:15-21`).

## 2.7 Configuration system

**There is no central env module and no zod env schema.** Glob `**/env.ts` — zero files.
Each package reads `process.env` directly with explicit throws, e.g.
`packages/db/src/client.ts:8-39` (`assertDatabaseConfiguration()` throws
`'[db] DATABASE_URL is required.'` in production), `packages/jobs/src/config.ts:5-7`,
`packages/storage/src/index.ts:38-45`.

| Layer                        | Mechanism                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Tenant generic KV            | `tenants.settings` jsonb via `lib/tenant-settings.ts`                                                       |
| Tenant columns               | `defaultLanguage`, `enabledLanguages`, `riskMatrix`, `hierarchy` (`schema/core.ts:32-57`)                   |
| Tenant notification policy   | `tenant_notification_policy` (1 row/tenant): digest, quiet hours, `scanEnabled`, `scanCron`, `scanTimezone` |
| Tenant notification settings | `tenant_notification_settings` (per category): roles, users, groups, channels, escalation ladder            |
| Tenant nav overrides         | `tenant_nav_configs.config` jsonb — items of kind `module` / `form` / `link`                                |
| Platform                     | `platform_settings` — single row, sentinel id `000…001`, **not** RLS-scoped                                 |
| Walkthroughs                 | `walkthrough_settings` + `walkthrough_progress`                                                             |

**Feature flags: there is no generic feature-flag system.** Grepped
`featureFlag|feature_flag|FEATURE_FLAG` — **zero matches**. Toggling is ad hoc and domain-local.
The closest thing is `tenant_notification_policy.scanEnabled`
(`drizzle/0007_compliance_scan_toggle.sql:1-5`), a master switch for the compliance scan.

## 2.8 Repository scale

~400k lines of TypeScript/TSX across 1,446 web files, 71 worker files, and 25 packages.
952 commits between 2026-05-18 and 2026-09-18. CI gates: `format:check`, `typecheck`, `lint`,
`deadcode:check` (knip), shell gate tests, migrations applied twice, `test`, `build`
(`.github/workflows/ci.yml:80-94`).

---

# Part 3 — Core Business Objects

Verified against the schema and routes. **Absences are stated explicitly.**

## 3.1 User — **EXISTS** (two distinct concepts)

| Concept        | Table                                 | Location                            |
| -------------- | ------------------------------------- | ----------------------------------- |
| Login identity | `user` (Better-Auth, global, text PK) | `packages/db/src/schema/core.ts:69` |
| Membership     | `tenant_users`                        | `core.ts:167`                       |
| Worker         | `people`                              | `packages/db/src/schema/org.ts:140` |

`people` carries `employeeNo`, `externalEmployeeId`, name, DOB, hire/termination,
`departmentId`/`tradeId`/`crewId`, `managerPersonId`, `emergencyContact*`, `badgeToken`,
`signatureAttachmentId`, `photoAttachmentId`, and denormalised `groupIds`/`titleIds`.
`people.userId` has a partial unique index (`org.ts:209-211`) enforcing **at most one active
person per user per tenant** — many workers legitimately have `userId = null` (no app login).

**Responsibilities:** workforce master data, org chart (`/people/org-chart`), badge QR
(`/verify/person/[token]`), kiosk identity (`kiosk_scans`), and site assignment through
`people_assignments` (person ↔ org_unit with `validFrom`/`validTo`, `org.ts:241`).

> **Gap:** there are **no `people.*` permission keys** in `PERMISSION_CATALOGUE`, and the
> `people` nav entry has **no `requiredPermission`** (`nav/registry.ts:172`) — it is visible to
> everyone. The most sensitive module in an HSE product (emergency contacts, DOB, termination
> dates) has no declared read/write capability. Also absent: medical/fitness-for-duty,
> immunisation, health records, driver licence class.

## 3.2 Organization — **EXISTS**, but **tenant ≠ org unit**

This is the single most commonly misunderstood part of the model.

- **`tenants`** (`core.ts:22`) — the **customer/company account**. Carries `slug`, `status`,
  `region`, languages, `hierarchy` JSON `{customer, project, site, area}` (`:32-35`), branding,
  `riskMatrix` (`:41`), `kioskPin`. This is the RLS root.
- **`org_units`** (`org.ts:26`) — the **internal hierarchy**, one self-referential table with
  `orgUnitLevel` enum `customer | project | site | area` (`:24`). Tenant-configurable depth via
  `tenants.hierarchy`. Has `parentId` (composite tenant FK, `:64`), `code`,
  `lat/lng/geofenceMeters` for site geofencing, `isEquipmentBase` (`:44`).
- **There is NO `organizations` table.** The `org_units` header comment (`org.ts:1-2`) states
  this explicitly.

So: _a tenant is the customer account; the "organization" a worker belongs to is an `org_unit`
tree inside that tenant._ `user → tenant` is via `tenant_users`; `user → people` is via
`people.userId`.

Routes: `/locations` (nav label "Locations") for units, plus `/people` for people.

**Responsibilities:** site/project/area hierarchy, geofencing, equipment bases, and the
container for `customer_contacts` (`locations.ts:14`, deliberately _not_ in `people`).

## 3.3 Department — **EXISTS** (flat, non-nesting)

`packages/db/src/schema/org.ts:72` `departments` (id, tenantId, name, code, description;
normalized-name unique, non-blank check). Referenced by `people.departmentId` (composite FK
`org.ts:218`), `incidents.departmentId` (`incidents.ts:89,206`), and the compliance audience
kind `department` (`compliance.ts:73`). Routes `/people/departments`.

**There is no `parent` column** — a department cannot nest. Sibling catalogues `trades`
(`org.ts:95`) and `crews` (`org.ts:117`) are likewise flat.

## 3.4 Project — **NO `projects` TABLE. NO `sites` TABLE.**

Verified: `pgTable('projects'` → no matches anywhere in `packages/db`.

Projects and sites are **`org_units` rows distinguished only by `level`**. This is stated in
the schema itself — `packages/db/src/schema/sync.ts:24-27`:

> "org_unit covers both Locations and Projects (the same org_units table, different `level`)"

`hazid-assessments.ts:72` `projectOrgUnitId` is simply a second FK to `orgUnits`.

**Consequence:** a Project has **no project-specific attributes** — no client, contract number,
start/end dates, budget, phase, or project manager. Anything of that kind must go into
`org_units.metadata` jsonb.

## 3.5 Role — **EXISTS**

`iam.ts:20` `roles` (tenant-scoped, `key`, `name`, `isBuiltIn`, `permissions` jsonb array).
Unique on `(tenant_id, key)`. Four built-ins (`iam.ts:301-448`): `worker`, `foreman`,
`safety_manager`, `tenant_admin`. Routes `/admin/roles` (`admin.roles.manage`).

## 3.6 Permission — **EXISTS**

`iam.ts:155-296` `PERMISSION_CATALOGUE` — **92 strings**, wildcard-aware. Stored as JSON on
roles, with `role_assignments.scope` and `user_permission_overrides` (grant/deny) for
per-assignment narrowing. `packages/tenant/src/index.ts` implements `can` / `assertCan` /
scope resolution. **Untested** — see §1.14.

## 3.7 File / Attachment — **EXISTS** (binary layer)

`packages/db/src/schema/attachments.ts`:

- `attachments` (`:26`) — `r2Key` (unique), `contentType`, `sizeBytes`, `filename`, image
  `width`/`height`, `durationMs`, `capturedAt`, `geoLat`/`geoLng`, `exif` jsonb,
  `annotations` jsonb, `caption`. **No `deleted_at`** — deletion is a hard DELETE.
- `attachment_upload_reservations` (`:64`) — the server-issued staging → finalize handshake.
- `attachmentKind` enum (`:17-24`): `image, document, video, audio, signature, other`.

**Full path, data model, and permission model: see [the storage audit](./beaconhs-storage-audit.md).**

## 3.8 Document — **EXISTS** (document-control layer)

`packages/db/src/schema/documents.ts` is a real document-control system, not a file bucket:

| Table                                    | Line                                       | Purpose                                                                                                                                |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `documents`                              | `:32`                                      | `key`, title, type/category, status, `reviewFrequencyMonths`/`nextReviewOn`, DOCX `sourceAttachmentId`, soft delete                    |
| `document_versions`                      | `:86`                                      | Numeric version (1.1, 1.2), content/docx/pdf attachments, `textContent`, `renderStatus`/`renderError`                                  |
| `document_acknowledgment_sessions`       | `:139`                                     | Toolbox-style group sign-off sheets                                                                                                    |
| `document_acknowledgments`               | `:202`                                     | Per-person + signature, session-linked                                                                                                 |
| `document_reviews`                       | `:264`                                     | Periodic review against an **exact version**, outcome `approved_no_change \| updated \| retired`                                       |
| `document_types` / `document_categories` | `document-types.ts:13,34`                  | Taxonomy (categories are a tree)                                                                                                       |
| `document_books` / `document_book_items` | `documents.ts:362`, `document-books.ts:33` | Ordered document/section/chapter collections with print settings                                                                       |
| `document_management_reviews`            | `document-management-reviews.ts:27,74`     | Board review of the whole S&H system: period, participants, decisions, action items, `nextReviewOn`, normalized document→version links |

Routes: `/documents` (+ `books`, `types`, `categories`, `sign-off-sessions`, `management-reviews`,
`manage`, `flows`). Nav label "Documents"; permissions `documents.read|manage|acknowledge|review`.

> This is already a substantial document-control system with periodic review, version
> pinning, and sign-off — directly relevant to the HSE audit workstream in
> [the gap analysis](./hse-gap-analysis.md).

## 3.9 Workflow — **EXISTS** (unified, but form- and module-anchored)

| Mechanism                                              | Location                                                   | Scope                                                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `form_automations`                                     | `forms.ts:585`                                             | One automation **graph** per subject; `subjectType = form_template \| module` (`:576`)                                                                                                        |
| `flow_gates`                                           | `forms.ts:623`                                             | Human approval gates for **any** subject. Explicitly the single gate store, replacing forms-only rows (`:617-620`). Carries `signatureRequired`, `signatureAttachmentId`, assignee, decision. |
| `form_responses.workflowState` + `form_response_steps` | `forms.ts:295,441`                                         | Per-step sign/reject audit                                                                                                                                                                    |
| Module hooks                                           | `packages/events/src/outbox.ts:42` `recordModuleFlowEvent` | Emits `flow.<moduleKey>.<event>` for `on_submit \| status_change \| on_create \| on_sign \| on_lock \| on_unlock \| on_delete` (`domain-events.ts:47-62`)                                     |

**There is no generic user-definable workflow definition entity** for arbitrary record types.
Flows attach to a form template or a hard-coded module key. The Flow engine
(`packages/forms-core/src/flow-subjects.ts`) supports 6 triggers (`on_submit`, `on_field_value`,
`status_change`, `scheduled`, `session_overdue`, `manual`) and 13 actions (`send_email`,
`create_capa`, `create_incident`, `notify_role`, `set_field`, `flag_non_compliant`, `webhook`,
`create_response`, `analyze_photos`, `start_monitored_session`, `change_status`,
`duplicate_record`, `export_pdf`).

## 3.10 Task — **PARTIAL**. Three unrelated things are named "task".

1. `job_title_tasks` (`job-title-tasks.ts:29`) — a task _text_ list per job title, with
   `job_title_task_acknowledgments` (`:56`) for per-person signature acknowledgement. This is a
   job-description task list, **not a work tracker**.
2. `hazid_assessment_tasks` (`hazid-assessments.ts:140`) — rows inside a JSHA, each tied to
   hazards and controls. Library counterpart `hazid_tasks` (`hazid-libraries.ts:108`).
3. **Actual work tracking is `corrective_actions`** (`corrective-actions.ts:56`).

**There is no generic task/assignment entity.** `/my/tasks` is a cross-module _workspace_
aggregating CAs, form steps, gates, and job-title acknowledgements — not a task table. There is
no task with a plain owner + due date outside the CA table.

## 3.11 Notification — **EXISTS** (event-driven, production-grade plumbing)

`packages/db/src/schema/notifications.ts`:

- `notifications` (`:25`) — `userId`, `category`, `type`, `linkPath`, `data`, `isCritical`,
  `sourceJobId` (unique per tenant+user, for retry safety), `readAt`, `snoozedUntil`.
- `notification_preferences` (`:62`) — per user × category × channel.
- `webpush_subscriptions` (`:87`). Channel enum `in_app | email | push | sms` (`:18`).

**Transactional outbox** — `domain_event_outbox` (`domain-events.ts:103`) with a `dedupKey`
unique constraint, per-effect published timestamps, leases/claims, and retries; plus
`domain_event_effects` (`:141`). Events are written **in the same transaction as the mutation**
(`packages/events/src/outbox.ts:94`) and published only from retryable worker paths with
deterministic job ids.

**Coverage is narrow:** only **4** `DomainNotificationEvent` kinds exist
(`domain-events.ts:24-38`) — `incident_reported`, `incident_status_changed`,
`corrective_action_assigned`, `corrective_action_completed` — and only **4** built-in
categories (`packages/events/src/recipients.ts:22-27`) — `incident`, `ca`, `compliance`,
`equipment`. Two purpose-built emitters also exist: `emitComplianceTransitions()`
(`events/src/index.ts:327`) and `emitEquipmentMaintenanceDue()` (`:498`).

Routes `/notifications` (nav "Inbox"), `/notifications/preferences`, `/admin/notifications`.

## 3.12 Module inventory (22 modules + platform)

| Module                                                                         | Nav label          | Key tables                                                                                                                                             | Primary permission                    |
| ------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| Compliance                                                                     | Compliance         | `compliance_obligations/audience/dispatches/status`                                                                                                    | `compliance.read\|manage\|assign`     |
| Forms (Builder)                                                                | Builder            | `form_templates/versions/responses/*`, `form_automations`, `flow_gates`                                                                                | `forms.template.read`                 |
| Training                                                                       | Training           | courses, classes, attendees, records, certificates; skills/authorities/assignments/certificates; assessments; LMS modules/lessons/enrollments/progress | `training.*`                          |
| PPE                                                                            | PPE                | types, items, issues, inspections, criteria banks, **annual third-party certs**                                                                        | `ppe.*` incl. `ppe.return_to_service` |
| Equipment                                                                      | Equipment          | categories, types, items, location history, work orders, inspections, maintenance schedules, checkouts, truck log                                      | `equipment.read.self`                 |
| Incidents                                                                      | Incidents          | `incidents` + 9 sub-tables; classifications, injury types, hours periods                                                                               | `incidents.*`                         |
| HAZID                                                                          | Hazard Assessments | hazard libraries + assessments/tasks/hazards/signatures/ppe/questions                                                                                  | `hazid.*`                             |
| Inspections                                                                    | Site Inspections   | banks, criteria, types, type content, records, record criteria                                                                                         | `inspections.*`                       |
| Journals                                                                       | Journals           | entries, photos, tags, analysis runs (FTS `searchVector`)                                                                                              | `journals.*`                          |
| Documents                                                                      | Documents          | see §3.8                                                                                                                                               | `documents.*`                         |
| Corrective actions                                                             | — (reachable)      | `corrective_actions`, `ca_photos`, `ca_complete_steps`                                                                                                 | `ca.create\|update\|verify`           |
| Insights                                                                       | Insights           | `insight_dashboards`, `insight_cards`, pins, layout tables                                                                                             | `reports.read` + `insights.*`         |
| Reports                                                                        | Reports            | `report_definitions/schedules/runs/run_deliveries`                                                                                                     | `reports.read`                        |
| People                                                                         | People             | `people`, assignments, groups, titles, files, departments/trades/crews                                                                                 | **none**                              |
| Locations                                                                      | Locations          | `org_units`, `customer_contacts`                                                                                                                       | —                                     |
| Tools                                                                          | Tools              | `safe_distance_records/segments`                                                                                                                       | `tools.safe-distance.use`             |
| Assistant                                                                      | Assistant          | `ai_conversations/messages/shares`                                                                                                                     | `assistant.use\|write`                |
| Feed / Dashboard / Inbox / My / Help / Notifications / Account / Kiosk history | —                  | —                                                                                                                                                      | —                                     |
| Admin / Platform                                                               | Admin              | roles, overrides, tenants, `platform_settings`, api_keys, data_sources, templates                                                                      | `admin.*`                             |

---

# Risks & Open Questions

## Defects found (documented only — nothing was changed)

| #   | Severity    | Finding                                                                                                                                                                       | Location                                         |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | **Blocker** | Empty `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` in `.env` + `??` instead of `\|\|` at `index.ts:39-40` ⇒ empty SigV4 credentials                                              | see [storage audit](./beaconhs-storage-audit.md) |
| 2   | **High**    | **The permission model has zero tests and no `test` script**, yet `can()` runs on every request                                                                               | `packages/tenant`                                |
| 3   | **High**    | **`audit_log` has no tamper evidence.** No UPDATE/DELETE trigger, no hash chain; the runtime role holds `DELETE ON ALL TABLES`                                                | `schema/audit.ts:5`, `migrate.ts:406`            |
| 4   | Medium      | `README.md:139` advertises a "plugin registry" in the Admin hub. The plugin system was retired                                                                                | `README.md:139`                                  |
| 5   | Medium      | `pnpm-workspace.yaml:5` keeps `- 'plugins/*'` though `plugins/` holds only `.gitkeep` — dead config                                                                           | `pnpm-workspace.yaml:5`                          |
| 6   | Medium      | `training-skills.ts:7-8` comment references `trainingSkills` / `trainingSkillEvaluations`; **neither table exists anywhere in the repo**                                      | `schema/training-skills.ts:7-8`                  |
| 7   | Medium      | No `people.*` permission namespace; `people` nav entry has no `requiredPermission`                                                                                            | `iam.ts:155-296`, `nav/registry.ts:172`          |
| 8   | Medium      | `s3Client` is exported with **zero consumers** — dead export, relevant to the `deadcode:check` gate                                                                           | `packages/storage/src/index.ts:662`              |
| 9   | Low         | `db:push` / `db:push:ci` defined but referenced by no workflow or script                                                                                                      | `package.json:19-20`                             |
| 10  | Low         | `packages/audit` has no `test` script                                                                                                                                         | `packages/audit/package.json`                    |
| 11  | Low         | No `vitest.config.*` anywhere; `jsdom` installed but no test uses a DOM environment                                                                                           | repo-wide                                        |
| 12  | Low         | 5 `actions.ts` + 60 `_actions.ts` files with no shared result envelope; the `{ok:false,error}` union is redefined per module                                                  | `app/(app)/**/_actions.ts`                       |
| 13  | Low         | `R2_ENDPOINT` is absent from `turbo.json` `globalEnv`, so changing the storage endpoint does not invalidate the Turbo task cache                                              | `turbo.json:4-26`                                |
| 14  | Low         | Stale MinIO references in `AGENTS.md:26,76`, `README.md:176,239,256`, `docs/QUICKSTART.md:32,46`, `scripts/launchers/dev-launcher.{sh,ps1}`, `scripts/launchers/README.md:17` | see [storage audit](./beaconhs-storage-audit.md) |
| 15  | Low         | `appkit-feedback` publishes as `@braedonsaunders/appkit-feedback` from inside `packages/` — a vendored upstream package in the workspace. Intent unclear.                     | `packages/appkit-feedback/package.json`          |

## Open questions for the HSE programme

1. **Licensing.** BeaconHS is **AGPL-3.0-or-later** (`LICENSE`, `package.json:4`). AGPL §13
   obliges you to offer complete corresponding source to users interacting with the software
   over a network. Internal deployment is usually manageable; **hosting a modified BeaconHS
   as a service for third parties is a material constraint on the commercial model.** This
   was outside the requested audit scope but belongs on the register. _Legal advice required._
2. **SSO / SCIM.** No OIDC, no passkey, no 2FA, no email OTP. Enterprise HSE buyers commonly
   require at least OIDC. Adding it is a first-class change to `packages/auth`.
3. **Realtime.** No WebSocket, no SSE. If live multi-crew status boards are required, that is
   net-new infrastructure.
4. **Language coverage.** Only `en`/`fr`/`es`. A Chinese-language HSE deployment would need
   `zh` added to `SUPPORTED_LOCALES`, the message catalogues, and the DB CHECK constraints on
   `tenants.default_language` / `enabled_languages` (`schema/core.ts:48-57`).
5. **Offline/mobile.** `packages/sync` is _inbound data sync_, not offline. There is a service
   worker (`apps/web/public/sw.js`) whose scope was not verified from source. Field use on
   intermittent connections is a stated design goal — confirm what actually exists.
6. **Project as a first-class entity.** No `projects` table (§3.4). If the HSE programme needs
   project-level reporting, contracting, or ownership, that is a schema decision with broad
   downstream impact, not an incremental add.
7. **PDF rendering dependency.** `packages/forms-pdf` requires a pinned `chrome-headless-shell`
   and LibreOffice. Confirm these are acceptable in the target deployment (memory footprint,
   licensing, air-gapped installs).

## Related documents

- [Capability matrix](./beaconhs-capability-matrix.md) — the 17 HSE capabilities
- [Storage audit](./beaconhs-storage-audit.md) — object storage end to end
- [Extension points](./beaconhs-extension-points.md) — how to add a module
- [HSE gap analysis](./hse-gap-analysis.md) — what to build
- [SeaweedFS impact](./beaconhs-seaweedfs-impact.md) — MinIO → SeaweedFS migration
