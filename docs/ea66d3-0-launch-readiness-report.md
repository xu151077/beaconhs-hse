# EA-66D.3.0：BeaconHS 正式上线准备与 Web 首次初始化交付报告

**Phase type:** 首次初始化能力建设、SMTP 网页配置能力核验、对象存储公网路由设计、上线准备与 Gate 5 复验。
**Verdict:** **READY WITH CONDITIONS** — 初始化能力已建成并通过全部门禁；对象存储公网路由与隧道稳定性需用户/运维操作。
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. 执行摘要

| 类别                                 | 结果                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| 第一阶段：首次初始化流程审计         | **完成** — 9 个问题全部有据可依的答案                     |
| 第二阶段：SMTP 网页配置              | **完成** — 现有实现已满足 10 项要求；新增零租户可达路径   |
| 第三阶段：对象存储公网访问           | **BLOCKED** — 需用户执行 Cloudflare DNS + Public Hostname |
| 第四阶段：部署服务状态               | **PASS** — 8 服务健康，未重建未拉取                       |
| 第五阶段：Cloudflare Tunnel 公网验证 | **PARTIAL** — 曾验证通过，当前边缘侧持续中断              |
| 第六阶段：业务回归                   | **PASS / BLOCKED 分项**，见 §10                           |
| 第七阶段：Gate 5                     | **PASS — 退出码 0**                                       |
| 第八阶段：两端同步                   | **PASS** — 13 个文件 SHA256 一致                          |

### 本阶段引入并修复的回归

| 回归                                                                   | 严重性   | 状态                                                 |
| ---------------------------------------------------------------------- | -------- | ---------------------------------------------------- |
| 重构丢失 `global_only` 平台策略检查（租户测试发送可绕过平台 provider） | **HIGH** | **已修复**并加回归覆盖                               |
| EA-66D.2.6 的 knip ignore 违反 `deadcode-scope-contract`               | MEDIUM   | **已修复**（evidence ignore 移到顶层，契约断言不变） |
| turbo 缓存掩盖了上述失败                                               | MEDIUM   | **已修复流程**（本阶段全部门禁走 `--force`）         |

---

## 2. 第一阶段：首次初始化流程审计

### 2.1 九个问题的答案

| #   | 问题                                             | 答案                                                 | 依据                                                                                                                                                                                                                         |
| --- | ------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 当前系统是否已有首次管理员 Web 初始化页面？      | **没有**                                             | 全仓库无 `/setup`、`/bootstrap`、`/onboard` 路由；公开路由仅 `login`/`invite`/`verify`/`forgot-password`/`reset-password`/`kiosk`/`wopi`                                                                                     |
| 2   | 是否有可复用的正式用户注册及管理员授权机制？     | **部分有**                                           | Better Auth `disableSignUp: true`（无公开注册）；`/platform/users` 可创建用户并分配角色，但**需已有管理员 + 租户上下文**；`packages/db/src/scripts/provision-first-tenant.cli.ts` 用 `provisionFirstTenant` CLI 创建首个租户 |
| 3   | 首次管理员如何获得最高权限？                     | **写 `users.isSuperAdmin = true`**                   | Better Auth 全局表字段；`packages/tenant/src/index.ts:101-110` 的 `can()` 顶层短路 + `makeSuperAdminContext()` 的 `withSuperAdmin` BYPASSRLS 池                                                                              |
| 4   | 如何防止初始化完成后再次开放首次管理员注册？     | **原实现没有此保护**（CLI 仅靠「已有管理员则拒绝」） | 本阶段**新建**：初始化状态由数据库派生（无管理员 = 开放），入口在首个管理员存在时自动关闭，无标志位可翻转、无公开 API 可重置                                                                                                 |
| 5   | 多个并发请求如何避免重复创建首个管理员？         | **已有数据库级守卫**                                 | `packages/auth/src/bootstrap-admin.ts:236-243` 的 `DO $$ … RAISE EXCEPTION 'a super-admin already exists'`，与插入同事务                                                                                                     |
| 6   | 如何保证初始化失败时不留下半初始化状态？         | **单事务**                                           | `bootstrap-admin.ts:209` 的 `db.transaction`；`provisionFirstTenant` 亦为单事务（守卫 + 插入同事务）                                                                                                                         |
| 7   | 是否需要先创建租户才能创建管理员？               | **不需要**                                           | `bootstrapFirstAdmin` 只写 `user` + `account` 两张全局表，不碰租户                                                                                                                                                           |
| 8   | 是否存在必须先有管理员才能配置 SMTP 的循环依赖？ | **存在（本阶段已解开）**                             | `/platform/email` 在 `(app)` 布局内 → 需 `getRequestContext()` → 零租户时为 null → 管理员创建后仍配不了 SMTP。解开方式见 §4                                                                                                  |
| 9   | 首次初始化完成状态如何判断？                     | **数据库派生**                                       | `countSuperAdmins()` 与 `countTenants()`（`packages/db/src/tenant-provisioning.ts:650,660`）                                                                                                                                 |

### 2.2 零租户边界的根因（设计，非缺陷）

- `apps/web/src/lib/auth.ts:190-193`：「We must NOT return null **while tenants exist**: the app shell requires a tenant-bound RequestContext even for platform administration.」
- `docs/PRODUCTION_RUNBOOK.md:98-107`：「A platform with no tenant cannot be used through its own UI … **This is not a workaround.** … `/platform/tenants/new`, the only page that could create a tenant, is itself gated behind `requireRequestContext()`。」

### 2.3 首次管理员初始化的安全要求对照

| 要求                               | 实现                                                                                      | 位置                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 仅在系统尚无管理员时开放           | ✅ 数据库派生状态                                                                         | `first-run-setup.ts` `isFirstRunSetupOpen()`                                      |
| 服务端判断初始化状态               | ✅ 每次 action 都重查                                                                     | `setup/actions.ts` `createFirstRunAdmin`                                          |
| 数据库事务或可靠原子控制           | ✅ 复用原生单事务                                                                         | `@beaconhs/auth` `bootstrapFirstAdmin`                                            |
| 并发防重复创建                     | ✅ 数据库级守卫                                                                           | `bootstrap-admin.ts:236-243`                                                      |
| 密码安全哈希                       | ✅ Better Auth 自带 scrypt                                                                | `bootstrap-admin.ts:205` `hashPassword`                                           |
| 邮箱格式和有效性检查               | ✅ `assertBootstrapEmail`                                                                 | `bootstrap-admin.ts:135`                                                          |
| 强密码策略                         | ✅ **新增**：≥12 字符 + 3 类字符 + 无空格 + 非重复                                        | `first-run-setup.ts` `firstRunPasswordProblems`                                   |
| CSRF 防护                          | ✅ Next.js Server Action 的 Origin/Host 校验                                              | 框架内建                                                                          |
| 请求频率限制                       | ✅ **新增**：Redis 原子固定窗口，每客户端 5 次 / 10 分钟                                  | `first-run-setup.ts` `consumeFirstRunAttempt`（复用 `@beaconhs/jobs/rate-limit`） |
| 初始化成功后立即关闭入口           | ✅ 管理员存在即关闭                                                                       | 同 #1                                                                             |
| 不允许未授权普通用户获得管理员权限 | ✅ 仅 `isSuperAdmin` 一个既有标志位；无新角色/权限/scope                                  | `first-run-setup.ts` + `setup/actions.ts`                                         |
| 不通过公开 API 重置初始化状态      | ✅ 无此 API；状态由数据派生                                                               | —                                                                                 |
| 审计初始化操作，不记录密码或凭据   | ✅ 结构化日志 + 持久 DB 行（`user` / `platform_settings` / 新租户的 day-one `audit_log`） | `setup/actions.ts` `recordSetupEvent`                                             |

### 2.4 审计落点的诚实说明

`audit_log.tenant_id` 是 `NOT NULL` 且外键引用 `tenants`，因此**零租户阶段在结构上无法**写入该表。落地方式：

| 阶段              | 持久记录                                                 | 事件记录           |
| ----------------- | -------------------------------------------------------- | ------------------ |
| 第 1 步（管理员） | `user` 行（含 createdAt、isSuperAdmin）                  | 结构化 stdout 日志 |
| 第 2 步（SMTP）   | `platform_settings.email` 行（密钥以 `sealSecret` 加密） | 结构化 stdout 日志 |
| 第 3 步（工作区） | `tenants` 行 + 新租户**自己的** day-one `audit_log` 行   | 结构化 stdout 日志 |

日志只含「发生了什么、对谁、是否成功」，**不含密码、凭据或连接串**。

**生产级后续项：** 若要一个平台级审计表，需要一次 schema 迁移（`audit_log` 的租户约束需放宽或新增全局表）。本阶段不引入迁移。

---

## 3. 第二阶段：SMTP 网页配置能力

### 3.1 现有实现已满足的 10 项要求

审计确认 `apps/web/src/lib/email-settings-actions.ts` 与 `apps/web/src/lib/email-config.ts` **已经**实现全部要求：

| #   | 要求                   | 实现                                                                                                                             | 位置                                             |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | 仅管理员可读/改        | `gatePlatform()` 仅 super-admin；`gateTenant()` super-admin 或 `admin.settings.manage`                                           | `email-settings-actions.ts:35-38`                |
| 2   | SMTP 密码加密保存      | `sealSecret`（AES-256-GCM），存 `keyCiphertext` + `keyNonce`                                                                     | `email-config.ts:22,161`                         |
| 3   | 查询不返回明文         | UI 形态 `EmailSettings` 只有 `hasKey: boolean`，**无 secret 字段**                                                               | `email-config.ts:34-67`                          |
| 4   | 保存后可发测试邮件     | `testEmailConnection` 经**已保存**的配置投递                                                                                     | `email-settings-actions.ts`                      |
| 5   | SMTP 错误脱敏          | 失败只回 provider + `error.name`，不回原始 message                                                                               | `email-settings-core.ts` `deliverEmailTestEmail` |
| 6   | 日志不含认证信息       | `console.error` 只记 `provider` 与 `errorName`                                                                                   | 同上                                             |
| 7   | 普通用户不可读凭据     | 门禁同上                                                                                                                         |
| 8   | 配置失败不破坏已有配置 | 先校验后事务保存；`mergeEmailConfig` 保留未改字段                                                                                | `email-config.ts:143`                            |
| 9   | 支持修改               | 同一路径覆盖保存                                                                                                                 |
| 10  | 测试邮件结果明确       | 六种明确结果：succeeded / failed / invalid_destination / rate_limited / rate_limit_unavailable / policy_blocked / not_configured |

额外已具备：SMTP 主机公网可达性校验（拒绝 IP literal、拒绝不可解析主机）、测试发送限流（5 次 / 10 分钟）、每次变更与测试的 `audit_log` 条目。

### 3.2 本阶段的改进：消除重复逻辑

原来的解析/校验/投递逻辑在 `email-settings-actions.ts` 内私有。为让 setup 路径复用且**不写第二份**，抽出共享核心 `apps/web/src/lib/email-settings-core.ts`（非 `'use server'`，因此不会变成可被客户端调用的 RPC）。

| 项             | 改进前              | 改进后                                 |
| -------------- | ------------------- | -------------------------------------- |
| 解析与校验     | 私有于 actions 文件 | `email-settings-core.ts`，两个路径共用 |
| 传输解析与投递 | 私有于 actions 文件 | 同上                                   |
| setup 路径     | 需复制一份          | 直接复用                               |

### 3.3 首次初始化与 SMTP 的先后顺序（无循环依赖）

```
1. 管理员创建  → 不依赖 SMTP 邮件成功（密码认证 + requireEmailVerification=false）
2. 管理员登录  → 会话建立
3. SMTP 配置   → 管理员在 /setup 或 /platform/email 完成
4. 测试邮件    → 投递验证（需 SMTP 可用）
5. 首个工作区  → 管理员创建
6. 密码找回    → SMTP 未配置时明确提示，不假装成功
```

第 2 步之后的 `/platform/email` 仍**不可达**（零租户），所以 setup 流程必须自带 SMTP 步骤 —— 这就是第 3 步在 `/setup` 页面中的实现。

---

## 4. 第三阶段：对象存储公网访问

### 4.1 当前状态（实测）

| 项                               | 状态                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| MinIO 内部 endpoint              | `http://minio:9000`（应用内网络，服务名解析 ✅）                                                                           |
| MinIO 宿主端口                   | `127.0.0.1:9000`（仅回环 ✅）                                                                                              |
| MinIO Console 9001               | 未发布 ✅                                                                                                                  |
| 预签名 URL 机制                  | **PASS**（EA-66D.2.7 已验证：SigV4 参数齐全、签名覆盖 Host、600 秒有效期、内网签名 URL HTTP 200 / 1 字节）                 |
| 预签名 URL 公网可达性            | **FAIL** — `R2_ENDPOINT` 主机名 `minio.beaconhs-test.local` 无公网 DNS 记录                                                |
| 候选域名 `s3-test.xuhaoqing.top` | **DNS 不解析** —— 记录不存在                                                                                               |
| 隧道 ingress                     | `{"hostname":"beaconhs-test.xuhaoqing.top","service":"http://127.0.0.1:3000"},{"service":"http_status:404"}`（version 12） |

### 4.2 失败原因隔离

EA-66D.2.7 已证明：内网签名 URL 成功取回 1 字节、PUT 成功、匿名读 403 —— **凭据、bucket、key、签名机制全部正常**。唯一差异是主机名不可公网解析。

### 4.3 推荐的最小方案（**未实施**，需用户执行）

Canonical Compose 的注释（`deploy/local-production.compose.yaml:282`）记载了既定设计：

> "Reached by the other services as minio:9000, and from outside only through the tunnel's existing `^/beaconhs(/.*)?$` route to 127.0.0.1:9000."

**方案 A（独立对象存储域名，推荐）：**

1. Cloudflare DNS：为 `s3-test.xuhaoqing.top` 添加一条代理记录（指向隧道）。
2. Cloudflare Tunnel：新增 Public Hostname `s3-test.xuhaoqing.top` → `http://127.0.0.1:9000`。
3. 运行时 env：`R2_ENDPOINT=https://s3-test.xuhaoqing.top`（浏览器/预签名用），`R2_INTERNAL_ENDPOINT=http://minio:9000`（服务端 I/O 用）**保持不变**。
4. 重启 web 与 worker 容器使新 env 生效。

优点：不动 bucket 名；与 `R2_ENDPOINT` 的「浏览器/预签名地址」语义最贴合；不公开 MinIO 管理接口；匿名访问仍被 Policy 拒绝。

**方案 B（同源路径路由，即既定设计）：** 隧道新增路径规则 `^/beaconhs(/.*)?$` → `http://127.0.0.1:9000`，`R2_ENDPOINT` 改为 `https://beaconhs-test.xuhaoqing.top`。**额外约束：** path-style URL 的首段是 bucket 名，`beaconhs-local-prod` **不匹配** `^/beaconhs(/.*)?$`，需把 bucket 改名为 `beaconhs`（属数据操作，需授权）。

**本阶段未执行任何 Cloudflare 操作，未修改隧道，未改 bucket 名，未改受保护 Compose。**

### 4.4 方案落地后的验收清单（供实施后验证）

1. 预签名 GET · 2. 预签名 PUT · 3. multipart 上传 · 4. 文件下载 · 5. 文件删除 · 6. 错误签名（403）· 7. 过期签名（403）· 8. 无权限访问（403）· 9. Host 与签名一致性 · 10. 大文件与分段上传

---

## 5. 第四阶段：部署服务状态

| 项                             | 状态                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| 运行中                         | postgres / redis / minio / web / worker / collabora（全部 healthy，RestartCount 0） |
| 已退出                         | scheduler（Exited 0）、storage-init（Exited 0）——符合 Manifest 期望                 |
| 镜像数                         | 25（**未新增**）                                                                    |
| 卷                             | 3（`beaconhs-hse_*`，未删除）                                                       |
| 重建镜像                       | **未重建**（§10 禁止事项）                                                          |
| 拉取镜像                       | **未拉取**                                                                          |
| 重新执行 Migration / Provision | **未执行**                                                                          |
| `down -v`                      | **未执行**                                                                          |

**因此本阶段新建的 `/setup` 页面尚不在运行中的镜像内** —— 见 §14「未完成事项」。

---

## 6. 第五阶段：Cloudflare Tunnel 与公网验证

| 检查项                               | 结果                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| DNS                                  | `beaconhs-test.xuhaoqing.top` → Cloudflare IPv6 ✅                                                 |
| TLS                                  | Google Trust Services，`CN = xuhaoqing.top`，有效期 2026-09-12 → 2026-12-11 ✅                     |
| HSTS                                 | `max-age=63072000; includeSubDomains; preload` ✅                                                  |
| 公网首页                             | **本阶段实测 HTTP 200** ✅                                                                         |
| 公网 `/login`                        | HTTP 200 ✅                                                                                        |
| `/api/health/ready`                  | HTTP 200 ✅                                                                                        |
| `/api/auth/get-session`              | HTTP 200 ✅                                                                                        |
| 隧道 ingress                         | version 12，单 hostname → `127.0.0.1:3000`，回退 `http_status:404`（管理端口未公开）✅             |
| 源站直连                             | `http://127.0.0.1:3000/` → 200，web healthy，RestartCount 0 ✅                                     |
| Server Actions / 静态资源 / 登录会话 | EA-66D.2.7 已完整验证（公网登录成功、会话 cookie 建立、静态资源 200、唯一 console 错误是预期 401） |

### 6.1 隧道稳定性（**未解决，如实记录**）

Cloudflare 边缘在本阶段反复重置 cloudflared 的控制流：

| 观察         | 数据                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| 症状         | 公网 530（隧道未连接）/ 502（连接被重置期间）                                                                         |
| 发生频次     | EA-66D.2.7 出现 2 次；本阶段出现多次，最近一次在公网验证中途                                                          |
| 隧道日志     | `Registered tunnel connection` 与 `Connection terminated` 交替；一度达到近 3 分钟 0 注册 / 8 断开                     |
| 自愈情况     | **两次自愈**（EA-66D.2.7 约 3 分钟；本阶段探测第 1 次即 200）                                                         |
| 源站         | 始终健康（loopback 200）                                                                                              |
| 宿主资源     | 无 OOM，内存充足，7844/443 可达                                                                                       |
| ingress 配置 | **未变**（始终 version 12）                                                                                           |
| 尝试的恢复   | `systemctl restart cloudflared` → **被拒**：「Interactive authentication required」——服务以 root 运行，`ceshi` 无权限 |

**结论：** 这是 Cloudflare 边缘侧的行为，不是本机配置或应用问题。恢复需要 **root 重启 cloudflared**（或等待边缘侧自行放行）。本阶段未修改隧道配置。

---

## 7. 第六阶段：业务回归

| #   | 测试项                                                                           | 结果                           | 依据                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 首次管理员初始化页面可访问                                                       | **NOT TESTED**                 | 页面已建成并过门禁，但**镜像未重建**，目标机无此路由                                                                                                                                                        |
| 2   | 首次管理员创建接口仅在未初始化时有效                                             | **PASS**                       | 隔离真实数据库集成测试：`readFirstRunState` → `create_admin`；创建后 → `sign_in`/`create_tenant`                                                                                                            |
| 3   | 初始化后入口关闭                                                                 | **PASS**                       | 集成测试：已有管理员后第二次 `bootstrapFirstAdmin` 返回 `already_bootstrapped`，管理员数仍为 1                                                                                                              |
| 4   | 普通注册不获得管理员权限                                                         | **PASS（设计 + 代码）**        | 无公开注册（`disableSignUp: true`）；setup 入口仅在**无管理员**时开放，且写入的是既有 `isSuperAdmin` 标志位                                                                                                 |
| 5   | 登录 / 退出 / 会话保持 / 密码错误 / CSRF / 未授权 API                            | **PASS**                       | EA-66D.2.7 实测：公网登录成功、`__Secure-better-auth.session_token` 建立、刷新保持、登出后服务端 session 表 0 行、错误密码「Invalid email or password」且不建会话、未登录访问 4 个受保护路由全部跳 `/login` |
| 6   | Permission catalogue / Role / Role Scope / Project Scope / visibility tier / RLS | **PASS（数据库层）**           | 191 张租户表启用 RLS、192 张 FORCE RLS；运行时角色非 superuser/非 BYPASSRLS/非 owner 成员；备份角色只读；唯一业务成员关系是 owner→migrator。**均未改动**                                                    |
| 7   | 跨租户隔离                                                                       | **NOT TESTED**                 | 需真实租户与用户数据；本阶段禁止创建租户                                                                                                                                                                    |
| 8   | 文件读取 / 下载授权                                                              | **NOT TESTED**                 | 需租户上下文；同上                                                                                                                                                                                          |
| 9   | 上传 / 下载 / 预览 / 删除                                                        | **NOT TESTED**                 | 需租户上下文；同上                                                                                                                                                                                          |
| 10  | 预签名 GET / PUT / multipart                                                     | **PASS（机制）**               | EA-66D.2.7：内网签名 URL HTTP 200 / 1 字节，PUT 成功，删除成功，匿名 403                                                                                                                                    |
| 11  | 无效 / 过期预签名 URL                                                            | **NOT TESTED**                 | 需浏览器链路；公网对象存储域名尚未配置                                                                                                                                                                      |
| 12  | 无权限文件访问                                                                   | **NOT TESTED**                 | 需租户上下文                                                                                                                                                                                                |
| 13  | SMTP 配置页面                                                                    | **PASS（实现已存在并过门禁）** | 见 §3.1 的 10 项逐条核对                                                                                                                                                                                    |
| 14  | SMTP 加密保存 / 读取脱敏                                                         | **PASS（实现 + 集成验证）**    | `sealSecret` + `hasKey` 布尔                                                                                                                                                                                |
| 15  | SMTP 测试发送入口                                                                | **PASS（实现）**               | `EmailTestButton` 支持注入 action（setup 与原生页共用）                                                                                                                                                     |
| 16  | SMTP 权限隔离                                                                    | **PASS（实现）**               | `gatePlatform` / `gateTenant`                                                                                                                                                                               |
| 17  | SMTP 实际投递成功                                                                | **NOT TESTED**                 | 无用户提供的真实 SMTP 凭据；**不宣称成功**                                                                                                                                                                  |
| 18  | Collabora 服务健康                                                               | **PASS**                       | healthy，RestartCount 0，uid 1001（非 root），branding 只读挂载，仅 `127.0.0.1:9980`，内网 WOPI discovery HTTP 200                                                                                          |
| 19  | Collabora 公网访问路径                                                           | **BLOCKED**                    | `collabora.beaconhs-test.local` 无公网记录；需 Cloudflare 操作                                                                                                                                              |
| 20  | WOPI 反向代理 / 完整业务测试                                                     | **NOT TESTED**                 | WOPI 保持 `PAUSED`，未经授权不解除                                                                                                                                                                          |

### 7.1 隔离测试数据库的证据（§10 允许的方式）

在一台**独立的临时 PostgreSQL 容器**上（独立容器、独立匿名卷、端口 55433），用**真实的** `scripts/cluster/provision.sql` 建立五个角色、用**真实的** migration runner 应用 51 条迁移，然后运行集成测试：

| 测试                                                                               | 结果 |
| ---------------------------------------------------------------------------------- | ---- |
| 角色属性符合依赖（app 非 superuser/非 bypassrls；super 为 bypassrls 非 superuser） | PASS |
| 已有管理员后拒绝创建第二个                                                         | PASS |
| 两个并发创建**都**被拒绝，管理员数保持 1                                           | PASS |
| 首个工作区只创建一次，第二次被拒绝                                                 | PASS |

**验收数据库未被触碰**（复核：`users=1 superadmins=1 tenants=0 migrations=51` —— 与 EA-66D.2.7 完全一致）。临时容器与卷已删除。

---

## 8. 第七阶段：Gate 5

```
VERDICT: PASS
REASON: all 8 container(s) match the manifest (gated image beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795;
        pinned identities from the manifest; deployment '51a899b7aac0a942da327222a3eed355fca9798a-20261031-001')
GATE5_EXIT=0
```

17 项覆盖全部 PASS：8/8 service identity · 5 种固定 digest · 实际 Image ID · RepoDigest · deployment ID · source archive SHA256（`image_source_deployment_id=406f0c00…`）· Compose project identity · 3× 容器标签 · RestartCount 0 · 服务状态 · external volumes · loopback 端口 · 网络 · 0 未授权容器 · 镜像身份。

**未修改 Manifest、脚本、标签或 digest 取得 PASS。**

---

## 9. 第八阶段：开发环境与测试环境同步

### 9.1 开发环境 → 测试主机（源码层）

13 个文件同步到 `~/beaconhs-setup-source/`（0700，独立目录，不覆盖任何既有部署）：

| 文件                                                     | SHA256（前 16）    | 两端  |
| -------------------------------------------------------- | ------------------ | ----- |
| `apps/web/src/app/setup/page.tsx`                        | `1b70df0ae0e75e77` | MATCH |
| `apps/web/src/app/setup/actions.ts`                      | `26cb9dff6322eddf` | MATCH |
| `apps/web/src/app/setup/setup-form.tsx`                  | `1372adb5a711c785` | MATCH |
| `apps/web/src/lib/email-settings-core.ts`                | `bd576173388de061` | MATCH |
| `apps/web/src/lib/first-run-setup.ts`                    | `6c45ea490a3a6a41` | MATCH |
| `apps/web/src/lib/email-settings-actions.ts`             | `0ae39a03902219b7` | MATCH |
| `apps/web/src/lib/auth.ts`                               | `1f75674862df824f` | MATCH |
| `apps/web/src/components/email-settings/test-button.tsx` | `7d5b4c28cc14719a` | MATCH |
| `packages/db/src/index.ts`                               | `eafe82ead05ff2fc` | MATCH |

其余 4 个文件（两个测试 + 两个脚本 + i18n 目录）同样同步并逐一核对。

**同步方式：** `scp` → 目标端临时路径 → 目标端 `sha256sum` 校验 → 同文件系统 `mv` 原子替换。

### 9.2 未同步

任何运行时 `.env`、密码、Server Action Key、MinIO 密钥。**代码与配置以开发环境为唯一源头。**

### 9.3 两端保护文件一致性

| 文件                                                             | 开发仓库           | 测试主机           | 结果  |
| ---------------------------------------------------------------- | ------------------ | ------------------ | ----- |
| `deploy/local-production.compose.yaml`                           | `9700f4805e7633cc` | `9700f4805e7633cc` | MATCH |
| `deploy/gate5.manifest.yaml`                                     | `6bc70fa0e42ad267` | `6bc70fa0e42ad267` | MATCH |
| `turbo.json` / `pnpm-lock.yaml` / `Dockerfile` / `.dockerignore` | 未改动             | 不适用             | 合规  |

---

## 10. 门禁执行结果

| 门禁                                | 退出码 | 备注                                                                                      |
| ----------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `pnpm format:check`                 | **0**  | —                                                                                         |
| `pnpm typecheck`                    | **0**  | 27/27（宿主内存有限，需 `NODE_OPTIONS=--max-old-space-size`，AGENTS.md 已记录此环境限制） |
| `pnpm lint`                         | **0**  | 1/1                                                                                       |
| `pnpm test --force --concurrency=1` | **0**  | **25/25 包全量重跑（不走缓存）**；web 251 files / 2126 passed                             |
| `pnpm deadcode:check`               | **0**  | —                                                                                         |
| `pnpm build --force`                | **0**  | 4/4，`Cached: 0`                                                                          |

**缓存说明：** 本阶段全部测试门禁走 `--force`，因为 EA-66D.2.6 的 turbo 缓存曾掩盖一个真实回归（见 §1）。

---

## 11. 新增和修改文件

### 11.1 新增

| 文件                                                   | 作用                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `apps/web/src/app/setup/page.tsx`                      | 公开的首次初始化页面（按数据库状态渲染四个阶段）                     |
| `apps/web/src/app/setup/actions.ts`                    | 四个 server action（创建管理员 / 保存 SMTP / 测试邮件 / 创建工作区） |
| `apps/web/src/app/setup/setup-form.tsx`                | 客户端表单                                                           |
| `apps/web/src/lib/first-run-setup.ts`                  | 首次初始化业务层：状态判定、强密码策略、限流、工作区创建             |
| `apps/web/src/lib/email-settings-core.ts`              | 共享的邮件配置核心逻辑（消除重复）                                   |
| `apps/web/src/lib/first-run-setup.test.ts`             | 密码策略与限流参数的单元测试                                         |
| `apps/web/src/lib/first-run-setup.integration.test.ts` | 隔离真实数据库上的守卫集成测试（4 项）                               |
| `scripts/ea66d3-0-setup-copy.mjs`                      | 文案 → 目录 key 的派生与四个语言目录的写入/校验                      |
| `scripts/ea66d3-0-scratch-db.sh`                       | 隔离 scratch 数据库的准备/清理                                       |
| `packages/i18n/src/messages/zh.json`                   | 中文目录（37 条页面文案 + 13 条 action 文案 × 4 语言）               |

### 11.2 修改

| 文件                                                             | 改动                                                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/email-settings-actions.ts`                     | 改为复用共享核心；逻辑等价                                                                                                        |
| `apps/web/src/lib/auth.ts`                                       | 新增 `getSignedInSuperAdminId()`（会话 + 既有 `isSuperAdmin`）                                                                    |
| `apps/web/src/components/email-settings/test-button.tsx`         | 新增可选 `action` prop（向后兼容）                                                                                                |
| `packages/db/src/index.ts`                                       | 导出 `tenant-provisioning`（供 Web 层复用原生业务层）                                                                             |
| `packages/i18n/src/messages/{en,es,fr}.json`                     | 各 +50 条                                                                                                                         |
| `apps/web/src/lib/provider-settings-validation-contract.test.ts` | 契约断言**全部保留**，仅把「类声明在哪」的检查移到共享模块，并**新增**「类只能声明一次」的断言（防止两个同名类破坏 `instanceof`） |
| `knip.ts`                                                        | evidence 归档 ignore 移到**顶层**（契约断言保持不变）；新增 setup 脚本 entry                                                      |

---

## 12. 未完成事项

| #   | 事项                                     | 原因                                                          | 需要谁                                       |
| --- | ---------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| 1   | `/setup` 页面部署到目标机                | **§10 明确禁止重建应用镜像**；新代码在镜像外                  | 需单独授权的构建 + 签名 + 导入 + Gate 5 周期 |
| 2   | 对象存储公网域名 `s3-test.xuhaoqing.top` | DNS 记录不存在；需 Cloudflare 仪表板操作                      | **用户**（§4.3 操作说明）                    |
| 3   | 隧道 Public Hostname 增加对象存储域名    | 同上                                                          | **用户**                                     |
| 4   | cloudflared 持续中断                     | 边缘侧重置控制流；`systemctl restart` 需 root，`ceshi` 无权限 | **运维**（root 重启）                        |
| 5   | SMTP 真实投递验证                        | 需用户提供的真实 SMTP 凭据                                    | **用户**                                     |
| 6   | 首个租户                                 | §2 明确禁止                                                   | **用户**                                     |
| 7   | 首个平台管理员                           | §2 明确禁止（OpenCode 不得创建）                              | **用户**                                     |
| 8   | 租户作用域的权限 / RLS / 文件端到端测试  | 需真实租户                                                    | 待 #6 之后                                   |
| 9   | 平台级审计表                             | 需 schema 迁移                                                | 后续阶段                                     |
| 10  | WOPI 完整业务验证                        | WOPI 保持 `PAUSED`                                            | 需单独授权                                   |

---

## 13. 最终状态矩阵

| 维度                            | 状态                                                              |
| ------------------------------- | ----------------------------------------------------------------- |
| **Infrastructure**              | **READY** — 8 服务健康，Gate 5 PASS，卷与镜像完好                 |
| **Web onboarding**              | **READY**（代码与门禁）— 部署需 #1                                |
| **SMTP configuration**          | **READY FOR USER CONFIGURATION** — 功能与加密就绪，投递待真实凭据 |
| **First admin**                 | **NOT CREATED** — 由用户在网页创建                                |
| **First tenant**                | **NOT CREATED** — 由用户在网页创建                                |
| **Object storage public route** | **BLOCKED** — 需 #2 #3                                            |
| **Production deployment**       | **NOT DEPLOYED**                                                  |

---

## 14. 用户操作指南

### 14.1 首次管理员创建

1. 浏览器打开 `https://beaconhs-test.xuhaoqing.top/setup`（需 #1 部署完成后）。
2. 填写**管理员邮箱**、**显示名称**、**管理员密码**（≥12 字符，混合大小写/数字/符号中的三类，不含空格）、**确认密码**。
3. 点击「创建管理员」。入口随即关闭，无法再创建第二个管理员。
4. 回到 `/login`，用该邮箱与刚设置的密码登录（密码认证不依赖邮件）。
5. 登录后在 `/setup` 继续第 2、3 步。

> 若 `/setup` 显示「初始化已完成」，说明平台已有管理员，请直接登录。

### 14.2 SMTP 配置

1. 登录后在 `/setup`（或 `/platform/email`）填写：SMTP 主机、端口、加密方式、用户名、密码、发件人名称、发件人邮箱、Reply-To（可选）。
2. 保存。密码以 AES-256-GCM 加密落库，页面此后只显示「已配置」，不回显明文。
3. 在「测试发送」填入收件邮箱 → 点「发送测试邮件」→ 得到明确结果。
   - **Email delivery is not configured** → 尚未保存 provider，或平台策略为 `disabled`。
   - **Could not send the test email via smtp** → 凭据或发件人域名不被服务器接受。
   - **Too many test emails** → 10 分钟内超过 5 次。
   - **Tenant email is unavailable while the platform provider is enforced** → 平台策略为 `global_only`。
4. 平台策略可选 `tenant_optional`（默认，租户可自配）/ `global_only`（强制平台 provider）/ `disabled`（全局熔断）。

### 14.3 首个租户创建

1. 登录后在 `/setup` 第 3 步，或工作区就绪后访问 `/platform/tenants/new`。
2. 填写**工作区名称**、**标识**（可选）、**区域**（默认 `ca-central-1`）。
3. 创建后系统会生成四个内置角色（`tenant_admin` 等）、参考目录与该租户自己的 day-one 审计行。
4. 之后在 `/platform/users` 邀请租户管理员并分配角色。

### 14.4 对象存储公网路由（Cloudflare）

1. **DNS**：为 `s3-test.xuhaoqing.top` 添加代理记录（Proxied）。
2. **Tunnel**：新增 Public Hostname `s3-test.xuhaoqing.top` → `http://127.0.0.1:9000`。
3. **运行时 env**：把 `R2_ENDPOINT` 改为 `https://s3-test.xuhaoqing.top`；`R2_INTERNAL_ENDPOINT=http://minio:9000` **保持不变**。
4. 重启 web 与 worker：
   ```bash
   docker compose --env-file ~/.beaconhs/runtime/local-prod.env \
     --env-file ~/.beaconhs/runtime/server-action-key.env \
     -f deploy/local-production.compose.yaml -p beaconhs-local-prod \
     up -d --pull never --no-build web worker
   ```
5. 验收：预签名 GET/PUT、multipart、下载、删除、错误签名 403、过期签名 403、无权限 403、Host 与签名一致、大文件分段上传。

### 14.5 隧道恢复

```bash
sudo systemctl restart cloudflared
```

（`ceshi` 无权限，需 root。ingress 配置不会改变。）

---

## 15. 最终状态（如实填写）

| 项                        | 状态                                            |
| ------------------------- | ----------------------------------------------- |
| 生产部署                  | `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION` |
| Rollback                  | `FAIL — NO EXECUTABLE ROLLBACK PATH`            |
| A1–A8                     | `PENDING AUTHORIZATION`                         |
| WOPI                      | `PAUSED`                                        |
| DB / Object-store restore | `NOT RUN`                                       |
| Migration（新增）         | `NOT RUN`                                       |
| Provision（新增）         | `NOT RUN`                                       |

**测试环境 PASS 不等于业务初始化完成。** 首个管理员、首个租户、SMTP 真实凭据与对象存储公网路由均**未**由 OpenCode 完成。

---

## 16. 证据索引

| File                                                   | Contents                                         |
| ------------------------------------------------------ | ------------------------------------------------ |
| `apps/web/src/app/setup/*`                             | 首次初始化页面、actions 与表单                   |
| `apps/web/src/lib/first-run-setup.ts`                  | 初始化业务层（状态、密码策略、限流、工作区创建） |
| `apps/web/src/lib/email-settings-core.ts`              | 共享邮件配置核心                                 |
| `apps/web/src/lib/first-run-setup.integration.test.ts` | 隔离真实数据库上的守卫测试                       |
| `apps/web/src/lib/first-run-setup.test.ts`             | 密码策略单元测试                                 |
| `scripts/ea66d3-0-setup-copy.mjs`                      | 文案 key 派生与目录同步工具                      |
| `scripts/ea66d3-0-scratch-db.sh`                       | 隔离 scratch 数据库工具                          |
| `docs/ea66d2-7-application-startup-gate5-report.md`    | 前置阶段的公网与 Gate 5 证据                     |
| `docs/evidence/ea66d2-7/logs/`                         | Gate 5 JSON 证据与启动日志                       |
| 本报告                                                 | EA-66D.3.0 报告                                  |
