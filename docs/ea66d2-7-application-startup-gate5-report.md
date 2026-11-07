# EA-66D.2.7：BeaconHS 应用启动与端到端验证报告

**Phase type:** 隔离测试环境应用启动、端到端验证与 Gate 5 部署门禁。
**Verdict:** **PASS**（Gate 5 退出码 0）；部分功能测试因「不创建租户」边界而 BLOCKED。
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. 执行摘要

| 项目                       | 判定                                    |
| -------------------------- | --------------------------------------- |
| 启动前审计                 | PASS                                    |
| Bootstrap Admin 执行       | PASS                                    |
| Email Provider             | **BLOCKED**                             |
| 应用服务启动               | PASS                                    |
| Cloudflare Tunnel 公网访问 | PASS                                    |
| 登录认证测试               | PASS                                    |
| 原生权限及 RLS（UI 层）    | **BLOCKED**（零租户边界）               |
| 文件上传下载（UI 层）      | **BLOCKED**（零租户边界）               |
| 预签名 URL 机制            | PASS                                    |
| 预签名 URL 公网可达性      | **FAIL**（缺公网对象存储域名/隧道路由） |
| Collabora                  | PASS（只读审计，WOPI 保持 PAUSED）      |
| **Gate 5**                 | **PASS — 退出码 0**                     |

### 本阶段发现并修复的两个问题

| 问题                                                                                                                      | 严重性   | 状态                                           |
| ------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| `APP_URL` / `PUBLIC_APP_URL` 为 `http://127.0.0.1:3000`，公网 origin 不在 Better Auth 信任列表 → 公网登录被 CSRF 检查拒绝 | **HIGH** | **已修复**（改为公网域名）                     |
| deployment ID `…-ea66d2-001` 违反 Gate 5 的 `<40hex>-<数字runid>-<数字attempt>` 契约 → Gate 5 返回 usage error            | **HIGH** | **已修复**（改为 `…-20261031-001` 并重建容器） |

---

## 2. 启动前审计

### 2.1 基础服务与镜像

| 检查项               | 实测                                                                                                    | 结果                       |
| -------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------- |
| PostgreSQL           | healthy，Image `721873c34ceb…`                                                                          | PASS                       |
| Redis                | healthy，Image `858f009f9709…`                                                                          | PASS                       |
| MinIO                | healthy，Image `b187417eee0a…`                                                                          | PASS                       |
| BeaconHS             | Image `1834f8679619…`                                                                                   | PASS                       |
| Collabora            | Image `4e983196eb98…`                                                                                   | PASS                       |
| 卷挂载               | postgres→`beaconhs-hse_postgres-data`、redis→`beaconhs-hse_redis-data`、minio→`beaconhs-hse_minio-data` | PASS                       |
| MinIO Bucket/Policy  | 1 个 `beaconhs-local-prod`，Policy absent，2 条生命周期规则，对象 0，探针残留 0                         | 与 EA-66D.2.6 基线**一致** |
| 非预期容器           | 0                                                                                                       | PASS                       |
| `run` 一次性容器残留 | 0                                                                                                       | PASS                       |

### 2.2 应用配置变量（仅名称 / 存在性 / 非空）

| 组                   | 变量                                                                                                                          | 状态                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 数据库               | `DATABASE_URL`、`SUPERADMIN_DATABASE_URL`、`MIGRATION_DATABASE_URL`                                                           | 全部 PRESENT 非空                                                    |
| Redis                | `REDIS_URL`                                                                                                                   | PRESENT 非空                                                         |
| 对象存储             | `R2_ENDPOINT`、`R2_INTERNAL_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_PRIVATE_BUCKET_CONFIRMED` | 全部 PRESENT 非空                                                    |
| 对象存储（可选）     | `R2_ACCOUNT_ID`、`R2_PUBLIC_URL`                                                                                              | ABSENT（`R2_PUBLIC_URL` **必须**不存在，否则 storage-init 拒绝执行） |
| 应用 URL             | `APP_URL`、`PUBLIC_APP_URL`                                                                                                   | PRESENT 非空                                                         |
| 应用 URL（可选回落） | `NEXT_PUBLIC_APP_URL`                                                                                                         | ABSENT（`PUBLIC_APP_URL` 优先，可选）                                |
| 认证                 | `BETTER_AUTH_SECRET`                                                                                                          | PRESENT 非空（44 字符，≥32 要求）                                    |
| 认证（可选）         | `BETTER_AUTH_TRUSTED_ORIGINS`                                                                                                 | ABSENT                                                               |
| 认证（**不适用**）   | `AUTH_URL`、`NEXTAUTH_URL`                                                                                                    | BeaconHS 使用 Better Auth，**不使用** NextAuth — 非缺项              |
| Collabora            | `COLLABORA_URL`、`COLLABORA_WOPI_URL`                                                                                         | 全部 PRESENT 非空                                                    |
| 邮件                 | `SMTP_HOST`、`SMTP_PORT`、`SMTP_FROM`、`SMTP_USER`、`SMTP_PASSWORD`、`EMAIL_PROVIDER`                                         | **全部 ABSENT**                                                      |
| Server Action        | `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`                                                                                          | PRESENT（独立 0600 密钥文件）                                        |

### 2.3 Web 端口与隧道

| 检查项               | 实测                                                                                                         | 结果                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| Compose web 端口     | `127.0.0.1:3000 → 3000`                                                                                      | PASS                             |
| 容器内监听           | `PORT='3000'`、`HOSTNAME='0.0.0.0'`                                                                          | PASS                             |
| 宿主机实际绑定       | `127.0.0.1:3000`（仅回环）                                                                                   | PASS                             |
| cloudflared 运行方式 | 宿主机进程（非容器），`--token-file /etc/cloudflared/token`                                                  | —                                |
| 隧道 ingress         | `{"hostname":"beaconhs-test.xuhaoqing.top","service":"http://127.0.0.1:3000"},{"service":"http_status:404"}` | PASS — 与 web 的回环绑定**一致** |
| 管理端口暴露         | 回退规则为 `http_status:404`，PostgreSQL/Redis/MinIO/Collabora **均未公开**                                  | PASS                             |

---

## 3. 开发环境与测试环境同步

### 3.1 同步前检查

| 项                                                     | 开发仓库                                                                     | 测试主机            | 结果         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------- | ------------ |
| HEAD                                                   | `51a899b7aac0a942da327222a3eed355fca9798a`                                   | —                   | 未变         |
| staged                                                 | 0                                                                            | —                   | 未变         |
| modified / untracked                                   | 165 / 565                                                                    | —                   | 用户修改完好 |
| `deploy/local-production.compose.yaml`                 | `9700f4805e7633cc…`                                                          | `9700f4805e7633cc…` | **MATCH**    |
| `deploy/gate5.manifest.yaml`                           | `6bc70fa0e42ad267…`                                                          | `6bc70fa0e42ad267…` | **MATCH**    |
| `docker/entrypoint.sh`（镜像内）                       | `1ee60ca610b4774e…`                                                          | `1ee60ca610b4774e…` | **MATCH**    |
| `apps/worker/dist/storage-init.js`                     | `3d2052488156a5ff…`                                                          | 镜像内同            | **MATCH**    |
| `apps/ops-bootstrap-admin/dist/bootstrap-admin.cli.js` | `61e676161e496e82…`                                                          | 镜像内同            | **MATCH**    |
| EA-66D.2.6 证据已回写                                  | `docs/ea66d2-6-minio-storage-init-report.md`、`docs/evidence/ea66d2-6/logs/` | —                   | PASS         |

### 3.2 本阶段的同步记录

**开发环境 → 测试主机（唯一一次代码/脚本同步）：**

| 目标                                                          | 来源                                     | SHA256              | 方式                                         |
| ------------------------------------------------------------- | ---------------------------------------- | ------------------- | -------------------------------------------- |
| `~/beaconhs-canonical/scripts/ci/reconcile-compose-digest.sh` | `scripts/ci/reconcile-compose-digest.sh` | `fb829baeee480f92…` | `scp` → 临时文件 → `bash -n` → `mv` 原子替换 |

**理由：** 目标端三个旧 checkout 均不含 Gate 5 验证脚本（它是开发仓库后加的文件）。这是把开发环境的验证工具送抵测试主机，未在测试主机发明或修改代码。

**测试主机 → 开发仓库（只读证据回写）：**

| 目标                                              | SHA256  | 敏感扫描 |
| ------------------------------------------------- | ------- | -------- |
| `docs/evidence/ea66d2-7/logs/gate5-evidence.json` | 9,363 B | 0 命中   |
| `docs/evidence/ea66d2-7/logs/storage-init.log`    | 81 B    | —        |
| `docs/evidence/ea66d2-7/logs/scheduler.log`       | 159 B   | —        |
| `docs/evidence/ea66d2-7/logs/web-startup.log`     | 274 B   | —        |
| `docs/evidence/ea66d2-7/logs/worker-startup.log`  | 614 B   | —        |

**未同步：** 任何 `.env`、`bootstrap-admin.env`、`migration.env`、`provision-vars.env`、`server-action-key.env`、`storage-verify.env`、管理员密码文件、Server Action Key。

**受保护文件：** `turbo.json`、`pnpm-lock.yaml`、`Dockerfile`、`.dockerignore`、Canonical Compose、Gate 5 Manifest —— **全部未修改**（SHA256 逐项比对一致）。

---

## 4. Bootstrap Admin 执行证据

### 4.1 执行载体核实

| 项                 | 结果                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| 镜像内 bundle      | `/app/apps/ops-bootstrap-admin/dist/bootstrap-admin.cli.js`（833,005 B）                     |
| 与开发仓库构建产物 | **字节一致**（`61e676161e496e82…`）                                                          |
| entrypoint 路由    | `bootstrap-admin)` → `exec node apps/ops-bootstrap-admin/dist/bootstrap-admin.cli.js "$@"`   |
| 所需环境           | `DATABASE_URL`（运行时角色）、`BETTER_AUTH_SECRET`、`APP_URL`/`BETTER_AUTH_URL`、`REDIS_URL` |
| 专用 env 文件      | `~/.beaconhs/runtime/bootstrap-admin.env`（0600，8 变量）                                    |
| 最小权限核对       | **不含** `MIGRATION_DATABASE_URL`、`SUPERADMIN_DATABASE_URL`、Server Action Key              |

### 4.2 执行过程

| 步骤     | 结果                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| 干跑     | `existing super-admins: 0` → `DRY RUN — pass --apply to create this administrator`                            |
| 正式执行 | **退出码 0**，`created super-admin platform-admin@beaconhs-test.local (a5dc2d2d-d3f5-4140-8390-f3ff6c3b9d26)` |
| 密码传递 | `--password-stdin`，来自 0600 文件（32 字节，无尾随换行）；**不进 argv、不进 history、不进日志**              |
| 幂等复跑 | `already bootstrapped — 1 super-admin(s) exist, nothing written`，退出码 0 —— **拒绝式幂等**                  |

### 4.3 数据库记录与权限属性

| 项                 | 实测                                                                                                     | 结果                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `user` 行数        | 1（`platform-admin@beaconhs-test.local` / `BeaconHS Test Platform Admin`）                               | PASS                                   |
| `isSuperAdmin`     | `t`                                                                                                      | PASS — 使用既有原生标志位              |
| `emailVerified`    | `f`                                                                                                      | 符合 `requireEmailVerification: false` |
| `account` 行       | 1，`providerId='credential'`，`accountId` 镜像 `userId`，密码哈希 161 字符十六进制（Better Auth scrypt） | PASS                                   |
| `tenants`          | **0**                                                                                                    | PASS — 未创建租户                      |
| `roles`            | **0**                                                                                                    | PASS — 未新增角色                      |
| `role_assignments` | **0**                                                                                                    | PASS — 未新增角色分配                  |
| `org_units`        | **0**                                                                                                    | PASS                                   |

**未通过 SQL 手工插入，未绕过 Bootstrap Admin 业务逻辑，未创建额外角色/权限/租户。**

### 4.4 会话与权限属性的运行时证据

| 项                                  | 实测                                                              |
| ----------------------------------- | ----------------------------------------------------------------- |
| 原生 Permission catalogue           | 未改动（107 键）                                                  |
| Role / Role Scope / visibility tier | 未改动                                                            |
| RLS                                 | 191 张表启用 RLS、192 张 FORCE RLS（EA-66D.2.5 建立，本阶段未变） |
| 超级管理员跨租户通道                | `withSuperAdmin` BYPASSRLS 池（代码路径 `auth.ts:163`）           |

---

## 5. Email Provider 状态

### 5.1 实际路径核实（依据代码）

| 环节          | 结论                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 生产发信路径  | `apps/worker/src/lib/resolve-email-transport.ts:50` —「Production sends must resolve through the database-managed provider system」 |
| Provider 来源 | `platform_settings.email`（`readPlatformEmail()`），**无 env 回退**                                                                 |
| 缺失时行为    | `resolveEffectiveTransport` 返回 `unconfigured` → `requireEmailTransport` 抛「Email delivery is not configured」                    |
| 配置入口      | `packages/auth/src/bootstrap-email-provider.cli.ts` —— **无 ops 部署目标，镜像内无 bundle**                                         |
| SMTP env 用途 | `packages/auth/src/server.ts:287-289` 的直发路径**仅在 `NODE_ENV=development` 生效**；production 走队列                             |

### 5.2 实测证据

| 检查                     | 结果                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `platform_settings` 行数 | **0** —— 无平台邮件 provider 配置                                                                      |
| Redis 邮件队列           | `bull:emails:wait` 有 **1** 个 job（magic-link），`attempts: 5` 指数退避                               |
| magic-link URL           | `https://beaconhs-test.xuhaoqing.top/api/auth/magic-link/verify?token=…`（公网 origin ✅）             |
| Worker 处理结果          | `✗ emails#1 send: Email delivery is not configured: configure an enabled platform or tenant provider.` |

### 5.3 判定

**EMAIL_DELIVERY = BLOCKED**

- 邮件**已入队**，但**无法投递**（无 provider、无 SMTP 服务）。
- 未新增 Mailpit 镜像、未拉取邮件服务镜像、未修改受保护 Compose、未改动用户 SMTP 凭据。
- **不影响**账户创建与密码认证测试（`requireEmailVerification: false`）。
- **未**测试邮件找回功能；**未**将邮件投递描述为 PASS。

---

## 6. 应用服务启动结果

### 6.1 执行命令

```bash
docker compose --env-file ~/.beaconhs/runtime/local-prod.env \
  --env-file ~/.beaconhs/runtime/server-action-key.env \
  -f deploy/local-production.compose.yaml -p beaconhs-local-prod \
  up -d --pull never --no-build
```

`--pull never --no-build`；未拉取任何镜像、未重建镜像、未执行 Migration、未重新执行 Provision、未删除或重建数据卷。

### 6.2 容器状态

| 服务         | 镜像           | 状态           | RestartCount | 端口             |
| ------------ | -------------- | -------------- | ------------ | ---------------- |
| postgres     | `721873c34ceb` | Up（healthy）  | 0            | `127.0.0.1:5433` |
| redis        | `858f009f9709` | Up（healthy）  | 0            | `127.0.0.1:6380` |
| minio        | `b187417eee0a` | Up（healthy）  | 0            | `127.0.0.1:9000` |
| web          | `1834f8679619` | Up（healthy）  | 0            | `127.0.0.1:3000` |
| worker       | `1834f8679619` | Up（healthy）  | 0            | 无（仅 expose）  |
| collabora    | `4e983196eb98` | Up（healthy）  | 0            | `127.0.0.1:9980` |
| scheduler    | `1834f8679619` | **Exited (0)** | 0            | —                |
| storage-init | `1834f8679619` | **Exited (0)** | 0            | —                |

`run` 一次性容器残留：**0**。

### 6.3 部署标签

8 个服务全部携带 `com.beaconhs.deployment` / `com.beaconhs.image-digest` / `com.beaconhs.role`，值与渲染结果一致。

### 6.4 日志证据

| 服务         | 关键输出                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web          | `Next.js 16.3.5` · `✓ Ready` · `[server-action-key] configuration fingerprint: f61da7728f3065df58f9e89aec6985d6` · `[schema] match: {"state":"match","applied":51}` |
| worker       | 6 类调度 tick 全部 ✔（storage_write_arms / compliance_scan / scheduled_flow / domain_event_outbox / form_session / storage_object_deletion）                        |
| scheduler    | `[scheduler] verified 13/13 repeat schedules.`                                                                                                                      |
| storage-init | `[storage-init] private bucket policy, lifecycle, and anonymous-read probe passed`                                                                                  |
| collabora    | `Ready to accept connections on port 9980.`                                                                                                                         |

**两条关键运行时证明：**

1. **`[server-action-key] configuration fingerprint: f61da7728f3065df58f9e89aec6985d6`** —— 运行中的 web 进程的 Server Action 密钥指纹与**构建时密钥完全一致**。这在运行中直接证实了 EA-66D.2.2 的密钥修复生效。
2. **`[schema] match: {"state":"match","applied":51}`** —— 镜像内 journal 与数据库 schema 版本**匹配**，无漂移、无需自动迁移。

### 6.5 意外行为检查

| 检查项               | 结果                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| 自动迁移             | **无** —— `drizzle.__drizzle_migrations` 仍 51 行，`max_created_at` 未变 |
| 意外租户/管理员      | **无** —— tenants=0，users=1（本次 bootstrap 管理员）                    |
| 密码/密钥/连接串泄漏 | **无** —— 7 个容器日志敏感扫描全部 0 命中                                |
| 容器异常重启         | **无** —— 全部 RestartCount=0                                            |

---

## 7. Cloudflare Tunnel 公网访问结果

| 检查项           | 结果                                                                                                                      | 判定 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ---- |
| DNS 解析         | `2606:4700:3032::ac43:d735`、`2606:4700:3037::6815:25ec`（Cloudflare）                                                    | PASS |
| HTTPS 证书       | `subject=CN = xuhaoqing.top`，`issuer=Google Trust Services / WE1`，有效期 2026-09-12 → 2026-12-11，`ssl_verify_result=0` | PASS |
| 隧道状态         | 4 条边缘连接（hkg01/hkg11/hkg12/hkg13），http2                                                                            | PASS |
| 首页             | `HTTP 200`，1,448,107 B                                                                                                   | PASS |
| 登录页           | `HTTP 200`，`text/html`，标题「登录 · BeaconHS」                                                                          | PASS |
| 静态资源         | 3 个 `/_next/static/chunks/*.js` 全部 `HTTP 200`                                                                          | PASS |
| Server Actions   | 登录 POST 成功并建立会话                                                                                                  | PASS |
| 浏览器控制台错误 | 1 个 —— 无效密码尝试的预期 `401`（`/api/auth/sign-in/email`），非缺陷                                                     | PASS |
| 服务端异常日志   | 无异常；仅邮件任务因 provider 缺失而失败（已记录）                                                                        | PASS |

**隧道瞬断事件（如实记录）：** 首次测试返回 `HTTP 530` / `error code: 1033`。诊断显示 cloudflared 在 11:40:38 丢失全部 4 条边缘连接（Cloudflare 边缘侧重置长连接），进程存活但未及时重连；11:43:47-48 自行重连后公网访问恢复。**未修改隧道配置、未重启服务**。宿主机无 OOM、内存充足（5.2Gi 可用）、`cloudflared` 单元从未被 systemd 重启。

### 7.1 CSP 策略（应用自行下发）

```
connect-src 'self' https://minio.beaconhs-test.local https://nominatim.openstreetmap.org https://api.nango.dev
frame-src   'self' https://collabora.beaconhs-test.local https://minio.beaconhs-test.local blob: https: …
form-action 'self' https://collabora.beaconhs-test.local
```

对象存储与 Collabora 的公网域名**已在 CSP 白名单中** —— 说明配置层已就位，缺的是 DNS/隧道路由。

---

## 8. 登录认证测试

全部经公网 `https://beaconhs-test.xuhaoqing.top` 完成。

| #   | 测试项                 | 结果                                                                                                  | 判定     |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| 1   | 管理员登录（密码认证） | 成功，重定向 `/auth/continue`                                                                         | **PASS** |
| 2   | 会话 cookie 建立       | `__Secure-better-auth.session_token`、`__Secure-better-auth.session_data`                             | **PASS** |
| 3   | 页面刷新后会话保持     | 刷新后仍为已认证态                                                                                    | **PASS** |
| 4   | 退出登录               | 跳转 `/login`；**服务端 `session` 表 0 行**                                                           | **PASS** |
| 5   | 未登录访问受保护页面   | `/dashboard`、`/incidents`、`/platform/tenants`、`/admin/users` 全部重定向 `/login`                   | **PASS** |
| 6   | 无效密码               | 提示「Invalid email or password」，停留 `/login`，**服务端 session 仍为 0**                           | **PASS** |
| 7   | 未授权 API 请求        | `/api/attachments` → 404（该路由不存在）；未认证访问受保护页面由服务端 `requireRequestContext()` 拦截 | **PASS** |

**浏览器 console 唯一错误**为无效密码尝试的 `401`（`/api/auth/sign-in/email`），属预期行为。

---

## 9. 原生权限及 RLS 测试

### 9.1 零租户边界（决定性发现）

`apps/web/src/lib/auth.ts:190-193` 明确记载：

> "We must NOT return null **while tenants exist**: the app shell requires a tenant-bound RequestContext even for platform administration."

`docs/PRODUCTION_RUNBOOK.md:98-107` 明确记载：

> "A platform with no tenant cannot be used through its own UI, so the first workspace is created with a command rather than a form. **This is not a workaround.** … `/platform/tenants/new`, the only page that could create a tenant, is itself gated behind `requireRequestContext()`."

实测：超级管理员登录成功后，`/dashboard`、`/incidents`、`/platform/tenants`、`/platform/users`、`/` **全部**重定向 `/auth/continue`，页面显示「Access is not active — This account is not attached to an active workspace.」。

首个租户必须由 `pnpm --filter @beaconhs/db provision:first-tenant` CLI 创建。**本阶段任务禁止创建租户**，因此依赖租户上下文的 UI 级权限测试为**边界受限**，不是缺陷。

### 9.2 可验证的权限与 RLS 项（不依赖租户）

| 检查项                  | 实测                                                                                 | 判定 |
| ----------------------- | ------------------------------------------------------------------------------------ | ---- |
| Permission catalogue    | 107 键，未改动                                                                       | PASS |
| Role / Role Scope       | 未改动                                                                               | PASS |
| Project Scope           | 未改动                                                                               | PASS |
| visibility tier         | 未改动                                                                               | PASS |
| RLS 策略覆盖            | 191 张租户表启用 RLS、192 张 FORCE RLS                                               | PASS |
| 应用角色最小权限        | `beaconhs_app`：`NOSUPERUSER`、`NOBYPASSRLS`、非 owner 成员                          | PASS |
| 维护角色                | `beaconhs_super`：非 superuser + BYPASSRLS + 非 owner 成员                           | PASS |
| 备份角色                | `beaconhs_backup`：LOGIN + BYPASSRLS + 非 owner + `default_transaction_read_only=on` | PASS |
| 运行时角色非 owner 成员 | 唯一业务成员关系是 `beaconhs_owner → beaconhs_migrator`                              | PASS |
| 数据库与应用权限一致    | `applyRuntimeGrants` 的 211 表 × 4 权限授权与 `migrate.ts` 声明一致                  | PASS |
| 超级管理员跨租户通道    | `withSuperAdmin` BYPASSRLS 池（原生实现，未改动）                                    | PASS |

**未通过放宽权限使功能通过** —— 本阶段未修改任何权限、角色、Scope 或 RLS 策略。

### 9.3 判定

- **数据库层权限与 RLS：PASS**
- **UI 层租户作用域权限：BLOCKED**（零租户边界，任务禁止创建租户）

---

## 10. 文件上传下载测试

### 10.1 判定

**BLOCKED** —— 文件 UI 与附件 API 均在 `(app)` 租户作用域内，零租户时不可达。任务禁止创建租户，故不执行。

### 10.2 已验证的等效底层能力

| 项                 | 结果                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| 应用存储客户端配置 | `region: 'auto'` + `forcePathStyle: true` + 环境变量凭据（`packages/storage/src/index.ts:173-180`） |
| 写入               | 经内部 endpoint PUT 成功（探针）                                                                    |
| 读取               | 经内部签名 URL GET **HTTP 200，1 字节**                                                             |
| 删除               | DELETE 成功，对象数回到 0                                                                           |
| Bucket             | `beaconhs-local-prod`（唯一）                                                                       |
| 匿名访问           | **HTTP 403**                                                                                        |
| Bucket Policy      | **absent**                                                                                          |
| 生命周期规则       | 2 条托管规则                                                                                        |
| 残留               | 探针对象已清理，对象数 0                                                                            |

**探针对象已全部删除，Bucket 恢复为阶段开始时的状态。**

---

## 11. 预签名 URL 测试

### 11.1 生成的 URL 形状（用应用自身的 SDK 与客户端配置复现）

```
https://minio.beaconhs-test.local/beaconhs-local-prod/ea66d2-7-probe/….txt
  ?X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Content-Sha256=UNSIGNED-PAYLOAD
  &X-Amz-Credential=<accessKeyId>/20261031/auto/s3/aws4_request
  &X-Amz-Date=20261031T035242Z
  &X-Amz-Expires=600
  &X-Amz-Signature=…
  &X-Amz-SignedHeaders=host
  &x-amz-checksum-mode=ENABLED
  &x-id=GetObject
```

| 属性             | 值                                               | 判定 |
| ---------------- | ------------------------------------------------ | ---- |
| scheme           | `https`                                          | PASS |
| hostname         | `minio.beaconhs-test.local`                      | —    |
| port             | 默认 443                                         | PASS |
| path             | `/<bucket>/<key>`（path-style，3 段）            | PASS |
| path 中的 bucket | `beaconhs-local-prod` —— **与 `R2_BUCKET` 一致** | PASS |
| 签名参数         | 9 个 SigV4 参数齐全，`X-Amz-SignedHeaders: host` | PASS |
| 签名覆盖的 Host  | `minio.beaconhs-test.local`（与 URL 主机名一致） | PASS |
| 有效期           | 600 秒                                           | PASS |

### 11.2 失败原因隔离（关键判定）

| 测试                                      | 结果                                                |
| ----------------------------------------- | --------------------------------------------------- |
| 公网 DNS 解析 `minio.beaconhs-test.local` | **失败** —— 无公网 DNS 记录                         |
| 公网 fetch 该预签名 URL                   | **失败** —— curl exit 6（`Could not resolve host`） |
| 内网 fetch 同一签名的等价 URL             | **HTTP 200，1 字节**                                |
| 内网 PUT 探针对象                         | 成功                                                |

**结论：签名机制、凭据、Bucket、Key 全部正常。公网可达性失败的唯一原因是 `R2_ENDPOINT` 的主机名既无公网 DNS 记录，也没有对应的隧道路由。**

### 11.3 最小架构修改建议（**未实施**，需单独授权）

Canonical Compose 的注释（`deploy/local-production.compose.yaml:282`）记载了既定设计：

> "Reached by the other services as minio:9000, and from outside only through the tunnel's existing `^/beaconhs(/.*)?$` route to 127.0.0.1:9000."

当前隧道的 ingress 只有 `beaconhs-test.xuhaoqing.top → http://127.0.0.1:3000` 与 `http_status:404` 回退，**缺少对象存储路径路由**。两种可选方案：

| 方案                            | 变更                                                                                                                                                   | 影响                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **A. 独立对象存储域名**         | 隧道新增一个 public hostname → `http://127.0.0.1:9000`；`R2_ENDPOINT` 改为该域名                                                                       | 需 Cloudflare 仪表板操作 + 一行 env 变更；不动 bucket 名；与 `R2_ENDPOINT` 的「浏览器/预签名地址」语义最贴合                             |
| **B. 同源路径路由**（既定设计） | 隧道新增路径规则 `^/beaconhs(/.*)?$` → `http://127.0.0.1:9000`；`R2_ENDPOINT` 改为 `https://beaconhs-test.xuhaoqing.top`；**bucket 名需为 `beaconhs`** | path-style URL 的首段是 bucket 名，`beaconhs-local-prod` 不匹配 `^/beaconhs(/.*)?$`；需重命名 bucket 并迁移 lifecycle/policy，属数据操作 |

**两者都需要 Cloudflare 仪表板变更 —— 本阶段未修改 Tunnel、未改 Canonical Compose、未改 MinIO 暴露端口、未重命名 bucket。**

**未把未验证的预签名 URL 描述为 PASS。**

---

## 12. Collabora 状态

| 项                   | 实测                                                                                  | 判定                |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------- |
| 容器                 | `4e983196eb98…`，healthy，RestartCount 0                                              | PASS                |
| 运行用户             | uid 1001（**非 root**）                                                               | PASS                |
| branding 挂载        | `collabora-branding.js` → `/usr/share/coolwsd/browser/dist/branding.js`，**rw=false** | PASS                |
| 端口                 | `127.0.0.1:9980`（仅回环）                                                            | PASS                |
| 内网 WOPI discovery  | `http://collabora:9980/hosting/discovery` → **HTTP 200**                              | PASS                |
| `COLLABORA_URL`      | `https://collabora.beaconhs-test.local` —— 公网不可解析                               | 与 MinIO 同构的限制 |
| `COLLABORA_WOPI_URL` | `http://web:3000`（内网，WOPI 回调正确）                                              | PASS                |

**WOPI 保持 `PAUSED`。** 本阶段仅做只读连通性与配置审计，**未**解除 PAUSED，**未**声称 WOPI 已通过完整业务测试。

---

## 13. Gate 5 结果及退出码

### 13.1 首次运行 —— 真实的 usage error

```
::error::--deployment-id must be <40-hex sha>-<run id>-<attempt>
VERDICT: USAGE ERROR
GATE5_EXIT=3
```

我在 EA-66D.2.2 选定的 deployment ID `51a899b7…-ea66d2-001` 中，run id 段含字母，违反 `reconcile-compose-digest.sh:327` 的 `^[0-9a-f]{40}-[0-9]{1,20}-[0-9]{1,10}$` 契约。**脚本自身的校验捕获了该缺陷，退出码 3 符合契约。**

### 13.2 修复

- 部署身份改为 `51a899b7aac0a942da327222a3eed355fca9798a-20261031-001`（run id 与 attempt 均为数字）
- 因部署身份标签变更，Compose 重建全部 8 个服务（外部卷保留）
- 重建后数据核对：migrations=51、users=1、tenants=0、Bucket 与 Policy 不变

### 13.3 正式运行

```
VERDICT: PASS
REASON: all 8 container(s) match the manifest (gated image beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795;
        pinned identities from the manifest; deployment '51a899b7aac0a942da327222a3eed355fca9798a-20261031-001')
GATE5_EXIT=0
```

### 13.4 Gate 5 覆盖项核对

| #   | 检查项                   | 实测                                                    | 结果 |
| --- | ------------------------ | ------------------------------------------------------- | ---- |
| 1   | Canonical Compose SHA256 | `9700f4805e7633cc…`                                     | PASS |
| 2   | Manifest SHA256          | `6bc70fa0e42ad267…`                                     | PASS |
| 3   | 8 个 service identity    | 8/8 匹配 manifest                                       | PASS |
| 4   | 五种镜像固定 digest      | 全部 `@sha256:` 固定                                    | PASS |
| 5   | 实际容器 Image ID        | 8/8 匹配                                                | PASS |
| 6   | RepoDigest               | `beaconhs@sha256:1834f867…`（离线导入后仍保留）         | PASS |
| 7   | deployment ID            | 8 个容器标签一致                                        | PASS |
| 8   | source archive SHA256    | 镜像标签 `com.beaconhs.source-archive-sha256=927062b6…` | PASS |
| 9   | Compose project identity | `beaconhs-local-prod`                                   | PASS |
| 10  | 容器 deployment labels   | deployment / image-digest / role 三项 8/8               | PASS |
| 11  | restart count            | 全部 0（Gate 5 要求非零即失败）                         | PASS |
| 12  | 服务状态                 | 6 running+healthy，2 one-shot exited 0                  | PASS |
| 13  | external volumes         | 3 个 `beaconhs-hse_*`                                   | PASS |
| 14  | port binding             | 全部 `127.0.0.1`                                        | PASS |
| 15  | network                  | `beaconhs-local-prod_default`                           | PASS |
| 16  | 未授权容器               | 0（容器总数 8 = manifest 8）                            | PASS |
| 17  | 镜像数量与身份           | 25 个镜像，5 个目标镜像 ID 全部匹配                     | PASS |

**Gate 5 未通过修改 Manifest、跳过检查或伪造标签获得 PASS。**

---

## 14. 最终容器状态

| 容器                                 | 镜像           | 状态          | 端口             |
| ------------------------------------ | -------------- | ------------- | ---------------- |
| `beaconhs-local-prod-postgres-1`     | `721873c34ceb` | Up（healthy） | `127.0.0.1:5433` |
| `beaconhs-local-prod-redis-1`        | `858f009f9709` | Up（healthy） | `127.0.0.1:6380` |
| `beaconhs-local-prod-minio-1`        | `b187417eee0a` | Up（healthy） | `127.0.0.1:9000` |
| `beaconhs-local-prod-web-1`          | `1834f8679619` | Up（healthy） | `127.0.0.1:3000` |
| `beaconhs-local-prod-worker-1`       | `1834f8679619` | Up（healthy） | —                |
| `beaconhs-local-prod-collabora-1`    | `4e983196eb98` | Up（healthy） | `127.0.0.1:9980` |
| `beaconhs-local-prod-scheduler-1`    | `1834f8679619` | Exited (0)    | —                |
| `beaconhs-local-prod-storage-init-1` | `1834f8679619` | Exited (0)    | —                |

`run` 一次性容器残留 **0**；卷 3（未删除）；镜像 25（未改动）；磁盘 69G 可用（42%）。
敏感文件全部 `0600` / owner `ceshi`；目录 `0700`。

> `scheduler` 与 `storage-init` 的容器按 Gate 5 manifest 期望各保留 1 个 **Exited (0)** 实例（`one_shot: true`、`expected_exit_code: 0`）；它们处于**停止**状态，非运行状态。

---

## 15. 未验证事项及限制

| #   | 事项                                                               | 原因                                                                                                | 影响                                 |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | UI 层租户作用域权限、Role Scope 跨项目隔离、RLS 的端到端表现       | 零租户边界；任务禁止创建租户                                                                        | 需在授权创建首个租户后补测           |
| 2   | 文件上传/下载 UI、无权限读取/下载、对象不存在、无效/过期预签名 URL | 同上                                                                                                | 同上                                 |
| 3   | 预签名 URL 的公网浏览器可达性                                      | 无公网对象存储 DNS 记录与隧道路由                                                                   | 已定位根因并给出两种最小方案，待授权 |
| 4   | Collabora 公网可达性                                               | `collabora.beaconhs-test.local` 无公网记录                                                          | 与 #3 同构                           |
| 5   | 邮件投递                                                           | `platform_settings` 无 provider，原生 `bootstrap-email-provider` 无镜像入口，且禁止擅自增加 Mailpit | `EMAIL_DELIVERY = BLOCKED`           |
| 6   | 密码找回流程                                                       | 依赖邮件投递                                                                                        | 未测试                               |
| 7   | WOPI 完整业务测试                                                  | WOPI 保持 `PAUSED`                                                                                  | 仅做只读连通性审计                   |
| 8   | 隧道瞬断的根因                                                     | Cloudflare 边缘侧重置长连接，宿主侧无异常                                                           | 已记录；未改隧道配置                 |

---

## 16. 生产部署状态

**`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`**

本阶段是隔离测试环境的应用启动与端到端验证，**不是**生产部署完成。生产环境未被接触。

## 17. 回滚状态

**`FAIL — NO EXECUTABLE ROLLBACK PATH`**

## 18. A1–A8

**`PENDING AUTHORIZATION`**

## 19. WOPI

**`PAUSED`**

---

## 20. 门禁执行结果

| 门禁                  | 退出码                           |
| --------------------- | -------------------------------- |
| `pnpm format:check`   | **0**                            |
| `pnpm typecheck`      | **0**（27/27）                   |
| `pnpm lint`           | **0**（1/1）                     |
| `pnpm test`           | **0**（2118 passed / 9 skipped） |
| `pnpm deadcode:check` | **0**                            |
| `pnpm build`          | **0**（4/4）                     |

---

## 21. 工作区保护确认

| 项                                                                | 状态                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| HEAD                                                              | `51a899b7aac0a942da327222a3eed355fca9798a`（未变）                                                                               |
| staged                                                            | 0                                                                                                                                |
| 用户原有修改                                                      | 全部保留（`packages/storage/src/index.ts` +1007/−143、`lifecycle.ts` +236、`storage-init.ts` +9/−2、`entrypoint.sh` +21 均未动） |
| `git reset --hard` / `git clean` / `git restore` / `git checkout` | **未执行**                                                                                                                       |
| `git add -A`                                                      | **未执行**                                                                                                                       |
| commit / push / CI                                                | **未执行**                                                                                                                       |
| 受保护文件                                                        | `turbo.json`、`pnpm-lock.yaml`、`Dockerfile`、`.dockerignore`、Canonical Compose、Gate 5 Manifest —— **全部未修改**              |
| `.env` 内容读取                                                   | **未读取**                                                                                                                       |

---

## 22. 下一阶段建议

1. **EA-66D.2.8（建议）**：在获得授权后创建首个测试租户（`provision:first-tenant` CLI，runbook 指定的机制），随后补测本阶段 BLOCKED 的项目：UI 层租户权限、Role Scope 跨项目隔离、RLS 端到端、文件上传下载、无权限文件访问、无效/过期预签名 URL。
2. **需用户决策**：预签名 URL 公网可达性 —— 在 §11.3 的方案 A（独立对象存储域名）与方案 B（同源路径路由 + bucket 更名）之间选择；两者都需要 Cloudflare 仪表板操作。
3. **需用户决策**：`bootstrap-email-provider` 的可执行入口（可考虑新增 ops 部署目标，但需开发环境先行修改与授权），以及是否在隔离环境引入 SMTP 测试服务以解除 `EMAIL_DELIVERY = BLOCKED`。
4. 生产部署前仍需：替换测试端点、补齐 Rollback 路径、解除 WOPI PAUSED 并完成 WOPI 验证。

---

## 23. 证据索引

| File                                              | Contents                                               |
| ------------------------------------------------- | ------------------------------------------------------ |
| `docs/evidence/ea66d2-7/logs/gate5-evidence.json` | Gate 5 JSON 证据记录（verdict PASS，8 容器，5 digest） |
| `docs/evidence/ea66d2-7/logs/storage-init.log`    | storage-init 执行输出                                  |
| `docs/evidence/ea66d2-7/logs/scheduler.log`       | scheduler 执行输出（13/13 调度）                       |
| `docs/evidence/ea66d2-7/logs/web-startup.log`     | web 启动日志（含密钥指纹与 schema 匹配）               |
| `docs/evidence/ea66d2-7/logs/worker-startup.log`  | worker 启动日志                                        |
| `docs/ea66d2-6-minio-storage-init-report.md`      | 前置阶段报告                                           |
| `docs/PRODUCTION_RUNBOOK.md:98-118`               | 首个租户的 CLI 机制（零租户边界依据）                  |
| `apps/web/src/lib/auth.ts:176-193`                | 超级管理员的租户上下文解析                             |
| `packages/storage/src/index.ts:173-186,283-340`   | S3 客户端配置与 `ensureBucket`                         |
| `packages/emails/src/transport.ts:318-341`        | 邮件 provider 解析与缺失时的失败语义                   |
| `scripts/ci/reconcile-compose-digest.sh`          | Gate 5 验证脚本（退出码契约）                          |
| `deploy/gate5.manifest.yaml`                      | Gate 5 期望                                            |
| 本报告                                            | EA-66D.2.7 报告                                        |
