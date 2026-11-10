# PD-01 Phase 3 授权测试与统一入口审查

## 1. 测试分层（如实区分）

| 层                  | 内容                                                                                                                      | 结果                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **真实 PostgreSQL** | `apps/web/src/lib/api/scope-pg.test.ts` — 谓词层：tenant / site / self / 跨租户 / 未映射 / 空责任字段 / 列表与 count 一致 | ✅ **8/8 通过**                                             |
| **HTTP 集成**       | 完整 API 授权链路（API key → principal → scope → 路由 → DB）                                                              | ❌ **未执行**（需运行 web + DB + API key 环境，本轮未启动） |
| **Mock**            | —                                                                                                                         | 无                                                          |

**明确声明：** 上述 8/8 是**谓词层真库测试**，不等于完整 HTTP 授权链路测试。

## 2. 真 PG 用例覆盖对照（任务书 §C 十项）

| #   | 要求                         | 覆盖情况                                             |
| --- | ---------------------------- | ---------------------------------------------------- |
| 1   | API Key 主体绑定与身份解析   | ⚠ 纯逻辑已测（`principal.test.ts` 14 例）；真库未测  |
| 2   | Principal ∩ Credential 权限  | ⚠ 纯逻辑已测                                         |
| 3   | Credential scope 收窄        | ⚠ 纯逻辑已测（`role-scope-narrowing.test.ts` 8 例）  |
| 4   | Tenant / Site / Self         | ✅ 真 PG                                             |
| 5   | 列表 / 详情 / count 一致性   | ✅ 真 PG（count 与列表同谓词）                       |
| 6   | CREATE / PATCH / DELETE 越权 | ⚠ 谓词层 + `assertEntityInScope` 源码合同；HTTP 未测 |
| 7   | documents 阶梯 ∩ RoleScope   | ✅ 真 PG（documents self/site/tenant）               |
| 8   | 跨租户阻断                   | ✅ 真 PG                                             |
| 9   | 未映射 fail-closed           | ✅ 真 PG                                             |
| 10  | 连接池 / 事务隔离            | ⚠ 既有 `withTenant` 隔离测试；本轮未新增             |

## 3. 统一入口审查（只读）

### 3.1 已确认无绕过

| 入口                | 路径                                       | 结论                                                             |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| 通用 REST 列表/详情 | `api/v1/[entity]`, `api/v1/[entity]/[id]`  | 走 `readEntityRows` / `getEntityRecord`（已接 scope）            |
| 通用 REST 写入      | 同上 POST/PATCH/DELETE                     | 走 `createEntity`/`patchEntity`/`deleteEntity`（已接 scope）     |
| count               | `readEntityRows` 内                        | 与列表同一 `whereSql`                                            |
| OpenAPI 文档        | `api/v1/openapi.json`                      | 仅 schema，无业务数据                                            |
| 报表导出            | `reports/definitions/[id]/export/route.ts` | 已有 `requireExportContext`（EA 系列）；RoleScope 叠加**未确认** |
| 下载/预览           | `wopi/*`、`documents/[id]/pdf`             | UI 会话（非 API key），不属 PD-01 范围                           |

### 3.2 发现的绕过入口（阻断项）

**B-1 Builder Apps 未接 RoleScope**

证据：`apps/web/src/lib/api/builder-apps.ts` 全文件使用 `ctx.db`（RLS 第二层），但**没有任何** `recordVisibilityWhere` / `entityScopeWhere` 调用（grep 无结果）。

影响：绑定 `sites`/`self` scope 的 API key 仍可通过 `/api/v1/apps/{templateKey}/responses` 读取/写入**租户内全部**表单响应。

**最小修复方案（未实施）：**

1. 在 `listBuilderAppResponses` / `getBuilderAppResponse` 的查询中加 `recordVisibilityWhere(ctx, tx, { personCol: formResponses.subjectPersonId, ownerTenantUserCol: formResponses.submittedBy })`；
2. 在 `updateBuilderAppResponse` 已有 `canEditResponsePayload` 之上，叠加 scope 断言（404）；
3. `createBuilderAppResponse` 校验 `site_org_unit_id` 在 scope 内；
4. 真 PG 测试：`sites`/`self` scope 下读取他人响应返回空/404。

**为什么不本轮实施：** 需要确认 `form_responses` 的 `submittedBy`（tenant_user）与 `subjectPersonId`（person）在 Builder 语义中的责任归属，与 `inspections` 同类问题（代填风险）。

**B-2 报表导出 RoleScope 叠加未确认**

`requireExportContext` 已有导出授权，但未确认是否叠加 `recordVisibilityWhere`。若未叠加，`sites`/`self` key 导出会超出范围。**需在 Phase 3 收尾前确认并补测。**

### 3.3 批量操作

通用 API 无独立批量端点（`api/v1` 只有单条 POST/PATCH/DELETE），批量由客户端循环调用 → 每条都走 scope 检查。

## 4. 门禁

`format 0 / typecheck 0 / lint 0 / test 0(26/26) / deadcode 0 / build 0`（`createdByCol` 改名后重跑）。

## 5. 结论

- 谓词层：3 实体已实施并通过真 PG（8/8）。
- HTTP 集成：**未执行**，不得视为完成。
- **B-1（Builder）是真实越权缺口**，必须在 Phase 3 收尾前修复；B-2 需确认。
- 未 push、未迁移、未部署。
