# PD-01 Phase 4 报告 — 收窄语义、绑定入口与旧 Key 退役

**结论：部分完成，未通过验收。** 收窄逻辑已在 Phase 2 实现并有测试；绑定 UI、真实 DB 生命周期测试、旧 Key 迁移方案**未实施**。

## 1. 已完成（Phase 2 交付，可验证）

| 要求                       | 状态      | 证据                                                                                              |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| Credential Permission 收窄 | ✅        | `principal.ts: narrowPermissions` —— 交集，永不扩大                                               |
| Credential Scope 收窄      | ✅        | `tenant/src/index.ts: narrowRoleScopes` —— 子集校验，超出即 `scope_exceeds_principal` fail-closed |
| 主体不存在/停用拒绝        | ✅ 纯逻辑 | `principal.test.ts` 场景 3/4；DB 查询在 `auth.ts`（租户谓词 + status 判定）                       |
| 角色撤销后拒绝             | ✅ 纯逻辑 | 场景 5：主体权限为空 → 有效权限为空                                                               |
| 未绑定 Key 行为不变        | ✅        | 场景 11：`bound=false`、`[tenant]`、权限原样                                                      |

## 2. 未实施（本阶段缺口）

### 2.1 API Key 与主体绑定入口

现状：`api_keys.principal_tenant_user_id` 只能通过 SQL 设置，**没有 UI、没有 server action、没有校验**。

需要的实现（设计已定，未写）：

- `apps/web/src/app/(app)/admin/api-keys/_actions.ts` 增加 `bindApiKeyPrincipal(keyId, tenantUserId)` / `unbindApiKeyPrincipal(keyId)`
- 校验：`assertCan(ctx, 'admin.api_keys.manage')`；主体必须属于同一 tenant 且 `status='active'`；写入 `principal_tenant_user_id`；`recordAudit`
- UI：API Key 列表增加"授权主体"列（未绑定显示"租户级（未绑定）"），绑定抽屉列出本租户成员
- 绑定后需**立即**提示：该 Key 的权限将收窄为"主体权限 ∩ 当前 permissions"

### 2.2 真实 DB 生命周期测试

纯函数已覆盖决策逻辑，但以下需要真 PG（临时容器）验证：

| 场景                            | 断言                                 |
| ------------------------------- | ------------------------------------ |
| 绑定有效主体 → API 请求         | ctx.scopes/personId 来自主体         |
| 主体 `status` 改为 `suspended`  | 下一请求 403，不缓存旧权限           |
| 删除主体全部 `role_assignments` | 下一请求权限为空（可认证、不可操作） |
| 删除 `tenant_users` 行          | 下一请求 `principal_missing`         |
| Key 撤销（`revoked_at`）        | 401                                  |
| 跨租户绑定（SQL 直写）          | `principal_tenant_mismatch`          |

**"变更后不会继续使用过期权限"** 由每次请求实时解析保证（`auth.ts` 无缓存），但需要上述测试固化。

### 2.3 旧 Key 迁移与退役方案（草案）

| 阶段    | 动作                                                                                       |
| ------- | ------------------------------------------------------------------------------------------ |
| M1 观察 | 保持全部现有 Key 未绑定（`principal_tenant_user_id IS NULL`），行为零变化；UI 标注"租户级" |
| M2 引导 | 为每个 Key 推荐一个主体（按 `created_by` 的用户在本租户的成员记录）；管理员确认后绑定      |
| M3 收窄 | 绑定后 `permissions` 自动降级为"上限"，实际权限 = 主体 ∩ 上限；管理页显示差异，需显式确认  |
| M4 退役 | 设定截止日；未绑定 Key 在 UI 显示警告；到期后（需产品批准）拒绝未绑定 Key 或强制绑定       |

**不改变生产旧 Key 行为**：M1–M3 全部为选择性操作，未绑定的 Key 永远走现有路径。

## 3. 门禁

本阶段未新增代码，Phase 2 提交的门禁结果为：`format 0 / typecheck 0 / lint 0 / test 0(26/26) / deadcode 0 / build 0`。

## 4. 结论

- **Phase 4 未完成**：收窄语义已具备，但"绑定能力"与"生命周期测试"缺失，不能标记完成。
- 下一步最小可交付：绑定 action + UI 列 + 真 PG 生命周期测试（6 场景）。
