# PD-02 阶段 0 — 基线与历史资料核查报告

**性质：只读审计。未修改代码、未创建角色/迁移、未连接生产数据库。**
**日期：2026-11-10**

## 1. Git 基线与工作区

| 项                    | 值                                                                    |
| --------------------- | --------------------------------------------------------------------- |
| 本地 HEAD             | `dade26a7`（docs(pd): production deployment record for pd01 release） |
| 分支                  | `hse-platform`                                                        |
| 工作区                | 干净（无未提交修改）                                                  |
| 与 origin 差异        | **领先 1 提交**（PD-01 发布记录文档，尚未 push）                      |
| `origin/hse-platform` | `62b92b94` = PD-01 已发布版本                                         |

PD-01 相关提交链完整：`faf1fefb`（B-1）→ `ea7801be`（视图实体 scope）→ `d54a233e`（HTTP 验收报告）→ `ffd526ec`/`23b1d64e`（D-A/B/C 修复）→ `684053db`（独立审计）→ `1ba6cc7c`/`62237a25`（M1/L1 关闭）→ `62b92b94`（RC 四文档）→ `dade26a7`（生产发布记录）。

## 2. PD-01 生产状态证据

以已提交的 `BEACONHS_PD01_PRODUCTION_DEPLOYMENT_RECORD.md` 为准：

- 生产运行 `62b92b948e62d7b3e332ae1987e9ac7acdee56b3`，镜像 `beaconhs@sha256:7ed40e7ef476ff7f19078be7b6036b71afd08b18d65ce665b1ae5de6d31fc52b`。
- 迁移 **58 applied**（`drizzle.__drizzle_migrations` 实测计数，发布时留证）。
- Gate 5 PASS（gated image `7ed40e…`，deployment `82d985d8da31e025842cad84604d4322d18bf027-20261110-001`）。
- 公网 `https://hse.xuhaoqing.top/api/health/ready` 返回 `version=62b92b94…`。

**说明：** 发布完成后本地 SSH 临时凭据副本已按卫生要求删除，本阶段不再实时连生产核验；上表全部来自发布当天留证的部署记录。若需重新实时核验，需用户重新提供访问凭据（仅阶段 11/12 部署前核对时才必要）。

## 3. PD-02 设计文件位置与审批状态

| 文件                                          | 性质                        | 状态                                      |
| --------------------------------------------- | --------------------------- | ----------------------------------------- |
| `BEACONHS_PD02_REVISED_ARCHITECTURE.md`       | 方案 A 修订架构（产品已选） | 设计定稿                                  |
| `BEACONHS_PD02_SECURITY_REVIEW.md` / `_V2.md` | 历史评审                    | 被 V3 取代                                |
| `BEACONHS_PD02_SECURITY_REVIEW_V3.md`         | **V3 权威评审**             | **设计层面通过**，实施前 5 项留证（阻断） |
| `BEACONHS_PD02_P1_P6_CLOSURE_REPORT.md`       | P-1…P-6 逐项关闭            | 设计全部关闭，**实施未开始**              |

三份文件均声明"未创建角色/函数/迁移，未修改 RLS"，与代码核查一致。

## 4. 现有审计日志结构

- `audit_log`：`packages/db/src/schema/audit.ts:5-33`。`tenant_id` NOT NULL + FK RESTRICT；`actor_user_id`（SET NULL）、`entity_type`、`entity_id`、`action`、`dedup_key`（unique per tenant）、`before`/`after`/`metadata` JSONB、`occurred_at`。索引：`(tenant_id, occurred_at)`、`(tenant_id, entity_type, entity_id)`、`(tenant_id, actor_user_id, occurred_at)`。
- 不可篡改：`packages/db/drizzle/0056_audit_log_and_fk_replay_safety.sql` + `0057_audit_immutable_trigger_owner_fix.sql`（`audit_log_immutable_trigger`，UPDATE/DELETE 非 owner 抛错）。
- 现有读取路径：`apps/web/src/app/(app)/admin/audit/page.tsx:58-76` — `requireRequestContext()` + `ctx.db`，经 RLS 只见本租户；权限键 `admin.audit.read`。

## 5. 现有数据库角色与授权

| 角色                             | 属性                                | 用途                 |
| -------------------------------- | ----------------------------------- | -------------------- |
| `beaconhs_owner`                 | NOLOGIN / NOSUPERUSER / NOBYPASSRLS | 迁移 DDL             |
| `beaconhs_app`                   | LOGIN / NOBYPASSRLS                 | 运行时（RLS）        |
| `beaconhs_super`                 | LOGIN / BYPASSRLS                   | 跨租户维护（专用池） |
| `beaconhs_backup`                | LOGIN / READ-ONLY                   | 备份                 |
| `audit_reader` / `audit_service` | **不存在**                          | 待 PD-02 创建        |

- `audit_log` 表权限现状：`beaconhs_app`/`beaconhs_super` SELECT+INSERT+UPDATE+DELETE（触发器拦截 UPDATE/DELETE）、`beaconhs_backup` SELECT（`packages/db/src/audit-immutability.test.ts:83-85`）。V3 §5 要求此现状**原样保留**。
- 迁移预检：`packages/db/src/migrate.ts:278` `assertDatabaseRoles`；`:348-356` `distinctRoles.size !== 5` 即中止。**P-1 需扩展为 7。**

## 6. 现有 Permission 与 RLS 结构

- `PERMISSION_CATALOGUE`：`packages/db/src/schema/iam.ts:155`，**108 键**；audit 相关仅 `admin.audit.read`（`:343`）。`admin.audit.approve` 不存在（待新增，V3 P-4：默认不授予任何内置角色）。
- `TENANT_SCOPED_TABLES`：`packages/db/src/rls.ts:105`（191 表安装 RLS）。`audit_access_grants`/`platform_audit_access_log` **不得加入**（V3 P-5）。
- `audit_log` 在 TENANT_SCOPED_TABLES 内，FORCE RLS + `tenant_isolation` 策略 — V3 §5 保留项，迁移不得触碰。

## 7. 现有连接池与事务封装

- `packages/db/src/client.ts:144` `db`（`DATABASE_POOL_MAX` 默认 20）；`:152` `superDb`（默认 10）；`createDatabase(url, max)` 工厂（`:45`）可复用于独立审计池。
- 租户上下文：`packages/db/src/rls.ts:13` `withTenant` = 事务内 `set_config('app.tenant_id', …, true)`（事务级）。跨租户：`withSuperAdmin` 走 `superDb` 专用池（角色属性 BYPASSRLS，非 GUC）。
- PD-01 已建立连接池隔离测试基建：`packages/db/src/connection-pool-isolation.test.ts`（max:1 池 + `pg_backend_pid()` 物理复用证据 + 事务级上下文清理断言），P-3 测试可复用同一模式。

## 8. PD-02 历史代码 / 遗留迁移

**无。** 全仓 grep `audit_reader`、`audit_service`、`audit_access`、`AUDIT_DATABASE_URL`、`admin.audit.approve`、`SET LOCAL ROLE` 仅命中 5 份设计文档；`packages/db/drizzle/` 无相关迁移。PD-02 为纯设计状态，可从零实施。

## 9. 指令与 V3 原文的差异（按指令规则：以 V3 为准）

| #   | 指令表述                                             | V3 原文                                                                        | 处理                                                                                                                                                                    |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 「最大分页数 500 页」                                | **「每页 ≤ 500 行」，服务端 `min(pageSize, 500)`；边界测试 pageSize 501 被拒** | ✅ **已裁决（2026-11-10 用户确认）：按 V3 执行「每页 ≤ 500 行」**。理由：两者是不同控件；单次查询上限 10,000 行 ÷ 500 行每页 = 最多 20 页，「500 页」在 V3 语义下不可达 |
| 2   | `audit_reader` NOLOGIN+BYPASSRLS+仅 SELECT audit_log | 完全一致；V3 另定义连接身份 `audit_service`（LOGIN、NOBYPASSRLS、仅成员资格）  | ✅ 兼容，V3 更完整                                                                                                                                                      |
| 3   | 审批权限 `admin.audit.approve`                       | V3 P-4 同名键，默认不授予                                                      | ✅ 一致                                                                                                                                                                 |
| 4   | `audit_access` 平台级，不入 `TENANT_SCOPED_TABLES`   | V3 P-5 一致；表名 `audit_access_grants` + `platform_audit_access_log`          | ✅ 一致                                                                                                                                                                 |
| 5   | 超限查询/导出需额外审批                              | V3 P-6：grant 上 `extra_approval = true`                                       | ✅ 一致                                                                                                                                                                 |
| 6   | （未提及）                                           | grant 有效期最长 90 天；`SET LOCAL statement_timeout = '10s'`                  | ✅ 按 V3 补充                                                                                                                                                           |

## 10. 发现的问题与风险

| #   | 风险                                                                                                    | 缓解                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| R-1 | `audit_reader` 是系统内唯一跨租户读审计身份；成员资格误授予普通角色 = 绕过全部租户隔离                  | P-1 角色矩阵断言**进入迁移流程**（失败即中止），并作为部署门禁每次执行（V3 §4 明确） |
| R-2 | `platform_audit_access_log` 不套租户 RLS，访问控制完全依赖权限矩阵；GRANT 遗漏 = 越权读审计访问日志本身 | `REVOKE ALL FROM PUBLIC` + 仅 `audit_service` 最小授权 + 断言测试                    |
| R-3 | `statement_timeout` 若非事务级会泄漏到业务查询                                                          | 强制 `SET LOCAL`；P-3 真 PG 测试覆盖                                                 |
| R-4 | `distinctRoles` 5→7 改动触及迁移部署门禁逻辑                                                            | 保持"两两不同"语义不变，仅扩集合 + 新增两条角色属性断言                              |
| R-5 | 生产部署需新增 `AUDIT_DATABASE_URL` + `audit_service` 密码                                              | 属阶段 11/12，须用户明确批准后执行；密码不入 Git、不写日志                           |

## 11. 后续实施依赖

1. 差异 #1（500 页 vs 500 行每页）的用户裁决 → 决定 P-6 实现。
2. P-1 依赖：迁移器角色断言扩展（`migrate.ts`）、`audit-immutability.test.ts` 测试模式。
3. P-2/P-3 依赖：`client.ts` 的 `createDatabase` 工厂、PD-01 连接池隔离测试模式。
4. P-4 依赖：`PERMISSION_CATALOGUE` 扩展 + 权限校验链（`packages/tenant`）。
5. 生产阶段依赖：`local-production.compose.yaml` 增加 `AUDIT_DATABASE_URL` 注入 + Gate 5 manifest 评估（audit 不新增容器，仅 env）。

## 12. 阶段 0 结论

**PASS — 可以进入 P-1。** 生产基线（58 迁移）、V3 设计原文、现有审计数据结构全部确认；差异 #1 已由用户裁决按 V3 执行（每页 ≤ 500 行），无遗留待决项。
