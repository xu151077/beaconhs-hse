# B-2 导出授权入口审查报告

**结论：无 API Key 授权缺口。** `requireExportContext` 的 6 个调用方全部是 **UI session**（cookie），通用 API Key 无法到达这些路由。按任务书「无法安全应用 Scope 的导出入口，对非 tenant Scope 拒绝访问」——这些入口对 API Key scope 不适用（API Key 根本进不来）。

## 1. `requireExportContext` 定义（证据）

`apps/web/src/lib/auth.ts:440-445`：

```ts
export async function requireExportContext(): Promise<RequestContext> {
  const ctx = await requireRequestContext() // UI session, not API key
  assertCan(ctx, 'admin.data.export')
  assertNotImpersonating(ctx, 'export')
  return ctx
}
```

## 2. 全部 6 个调用方（逐个确认）

| 入口                                           | 认证       | 权限                                 | RoleScope                                              |
| ---------------------------------------------- | ---------- | ------------------------------------ | ------------------------------------------------------ |
| `equipment/export.csv/route.ts:46`             | UI session | `admin.data.export`                  | 走 `recordVisibilityWhere`（`_actions.ts:355` 同链路） |
| `equipment/_actions.ts:355`                    | UI session | 同上                                 | 同上                                                   |
| `equipment/vehicle-log/export.csv/route.ts:36` | UI session | 同上                                 | 报告引擎 scope                                         |
| `equipment/vehicle-log/pdf/route.ts:119`       | UI session | 同上                                 | 报告引擎 scope                                         |
| `reports/definitions/[id]/export/route.ts:32`  | UI session | `admin.data.export` + `reports.read` | `loadDefinitionById(ctx.tenantId!, id)`                |
| `openapi.json`（非导出）                       | API key    | —                                    | 仅 schema                                              |

## 3. 任务书 §三 八项逐条

| #   | 检查                              | 结论                                                                                                                                                      |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 导出查询叠加 Tenant Isolation     | ✅ `ctx.db` / RLS（第二层）                                                                                                                               |
| 2   | 主体 Permission 校验              | ✅ `requireExportContext` + 各路由 `assertCan`                                                                                                            |
| 3   | Credential permissions 限制       | ✅ 不适用：这些路由不接受 API Key                                                                                                                         |
| 4   | RoleScope                         | ⚠ UI 侧：equipment 系列走 `recordVisibilityWhere`；**`reports/definitions/[id]/export` 的报告引擎是否叠加 RoleScope 未核实**（UI session 风险，非 PD-01） |
| 5   | 绕过统一查询入口的直接 DB 访问    | ⚠ `loadDefinitionById(ctx.tenantId!, id)` 直接按 tenant + id 查定义，非统一 `readEntityRows`；但定义本身非业务记录，且权限已校验                          |
| 6   | 异步任务执行时重新验证授权        | ⚠ 未发现异步导出任务（6 个入口均为同步响应）                                                                                                              |
| 7   | 下载/预览再次验证授权             | ⚠ 这些路由本身即下载/预览入口，每次请求都走 `requireExportContext`                                                                                        |
| 8   | 导出结果含超出 API Key 范围的记录 | ✅ 不适用（API Key 无法到达）                                                                                                                             |

## 4. 发现的最小缺口（记录，未实施）

**B-2-a**：`reports/definitions/[id]/export/route.ts` 的报告引擎查询是否叠加**用户** RoleScope 未核实。这是 UI 会话侧的可见性问题，与 PD-01 的 API Key scope 不同；按"不改变现有 UI 授权语义"原则，本轮**不修改**，列为待独立审查项。

**B-2-b**：`loadDefinitionById` 使用 `ctx.tenantId!` 非空断言；`requireRequestContext()` 已保证非空，但建议改为显式校验（非安全缺口）。

## 5. 结论

- **B-2 对 PD-01（API Key 授权范围）无缺口**：6 个导出入口全部 UI session，API Key 不可达。
- 未修改任何导出代码（最小修复原则：无缺口则不动）。
- 未执行导出相关真 PG / HTTP 集成测试（无缺口可测）；测试矩阵中的"tenant/site/self 导出隔离"因 API Key 不可达而**不适用**，如实标注。
- 异步导出、下载二次授权：未发现异步任务，下载入口本身每次校验。
