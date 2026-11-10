# PD-01 Phase 2 实施报告 — API Credential 与授权主体

**范围：** 仅 Phase 2（鉴权上下文）。Phase 3（读写接口切换到范围过滤）、Phase 4（permissions 降级为收窄 + 绑定 UI）**未实施**。
**基线：** `hse-platform`，本地未 push、迁移 `0058` 未应用生产。

## 1. 实现

| 文件                                | 变更                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/tenant/src/index.ts`      | 新增 `roleScopeCovers(principal, requested)` 与 `narrowRoleScopes(principalScopes, requested)`；复用既有 `RoleScope`，不新增权限类型                                            |
| `apps/web/src/lib/api/principal.ts` | 新增纯决策函数 `authorizeApiCredential(...)`：唯一决定"该凭据能做什么"的地方                                                                                                    |
| `apps/web/src/lib/api/auth.ts`      | 在**同一个** bypass-RLS 事务内解析 principal（租户谓词钉死）、复用 `resolveMembershipAccess` 取角色权限/scope、解析 `people.userId → personId`；`RequestContext` 由决策结果构建 |

**复用而非重建：** 权限与 scope 全部来自既有 `role_assignments` → `roles` → `resolveMembershipAccess`，与 UI 完全同源；未新增权限目录键、未新增 scope 变体、未引入平行判断。

## 2. 语义（明确三态）

| 字段              | 未绑定（`principal_tenant_user_id IS NULL`） | 绑定                                                                 |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `permissions`     | 凭据自身列表 = 全部授权（**现状不变**）      | `凭据列表 ∩ 主体权限`；交集为空即无权限                              |
| `scopes` = `NULL` | 恒为 `[{type:'tenant'}]`                     | **继承**主体 scopes                                                  |
| `scopes` = `[]`   | 不适用                                       | **显式无范围**（看不到任何记录），与 NULL 不同                       |
| `scopes` = 具体值 | 不适用                                       | 必须被主体覆盖，否则 `scope_exceeds_principal` **fail-closed**       |
| `personId`        | `null`（无员工记录）                         | 主体的 `people.id`（使 self/people scope 生效）                      |
| `membership`      | `null`                                       | 主体的 `{id, displayName}`（self scope 的 createdBy 谓词与审计归属） |
| `userId`          | `createdBy ?? api_key:<id>`                  | 主体的 `user_id`（审计归属真实用户）                                 |

**fail-closed 条件**（任一即 `ApiError.forbidden`，不回退到租户级）：主体行不存在、主体 id 与绑定不一致、主体租户 ≠ 凭据租户、主体 `status != active`、凭据 scope 超出主体。

## 3. 测试（真实断言，非源码合同除外）

| #   | 场景                                                             | 结果                                                              |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | 有效主体绑定 → 继承 + 交集 + personId + membership               | ✅                                                                |
| 2   | 跨租户主体绑定拒绝                                               | ✅                                                                |
| 3   | 不存在主体拒绝（含 id 不匹配）                                   | ✅                                                                |
| 4   | 已停用主体拒绝                                                   | ✅                                                                |
| 5   | 主体角色全部撤销 → 权限为空（可认证、不可操作）                  | ✅                                                                |
| 6   | RoleScope 正确传递                                               | ✅                                                                |
| 7   | personId 正确传递（self scope）                                  | ✅                                                                |
| 8   | 凭据权限不能扩大主体                                             | ✅                                                                |
| 9   | 凭据 scope 不能扩大主体                                          | ✅                                                                |
| 10  | `NULL`（继承）与 `[]`（无范围）区分                              | ✅                                                                |
| 11  | 旧未绑定 API Key 向后兼容（`bound=false`、`[tenant]`、权限原样） | ✅                                                                |
| 12  | 租户上下文伪造（凭据/主体租户不一致）拒绝                        | ✅                                                                |
| 13  | 连接池上下文隔离                                                 | 沿用既有 `withTenant`/`withSuperAdmin` 隔离测试；本次未改动该路径 |

测试文件：`packages/tenant/src/role-scope-narrowing.test.ts`（8）、`apps/web/src/lib/api/principal.test.ts`（14，含 1 条 wiring 源码合同）。
**说明：** 第 13 项没有新增真库用例；鉴权查询的租户谓词由 wiring 合同断言，真实跨租户 HTTP 验证属 Phase 3 范围。

## 4. 门禁（各自退出码）

| 门禁             | 结果            |
| ---------------- | --------------- |
| `format:check`   | 0               |
| `typecheck`      | 0               |
| `lint`           | 0               |
| `test`           | 0（26/26 任务） |
| `deadcode:check` | 0               |
| `build`          | 0               |

## 5. 未做 / 不声称完成

- Phase 3：API 读写接口接入 `recordVisibilityWhere`（**当前 API 仍是租户级范围**，绑定后的 `scopes` 已进入 ctx，但尚未被读写路径消费）
- Phase 4：`permissions` 降级为"收窄"的 UI/文档、主体绑定向导
- 迁移 `0058` 未应用生产；未 push

**PD-01 整体未完成。** 本阶段只保证"鉴权上下文正确"，不保证"数据范围已生效"。
