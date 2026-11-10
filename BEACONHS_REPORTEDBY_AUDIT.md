# reportedByTenantUserId 用途审查结论

**位置：** `apps/web/src/app/(app)/assistant/_commit-actions.ts:47`

```ts
recordVisibilityWhere(ctx, tx, {
  ownerTenantUserCol: incidents.reportedByTenantUserId,
  ...
})
```

## 1. 用途

这是 **AI 助手（assistant）提交事件**时的记录可见性谓词，语义是「我报告的事故」：助手在把一条事故写入对话上下文时，只挑出当前用户作为**报告人**的事故。它服务于 UI 的业务筛选，不是授权判定。

## 2. 三者严格区分

| 概念                       | 含义                                                               | 载体                                                                  |
| -------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 业务页面的「我报告的」筛选 | UI 便利性：只看自己报告的事故                                      | `reportedByTenantUserId`（此处）                                      |
| **API Key 的 Self 授权**   | PD-01：凭据可见范围，由 `RoleScope` + `recordVisibilityWhere` 决定 | `scope.ts` 的实体映射（`corrective_actions.owner_tenant_user_id` 等） |
| 记录的实际业务责任主体     | 谁对该事故负责处理                                                 | `assigned_investigator_tenant_user_id`（候选，**未注册**）            |

**结论：三者不得混为一谈。** `reportedByTenantUserId` 在此处是第 1 类，不是第 2 类，也不是第 3 类。

## 3. 命名问题（本轮发现）

上一轮把 `RecordOwnerColumns.createdByCol` 统一改名为 `ownerTenantUserCol`（准确表达 owner/self 语义）。该重命名使本处变成「用 `ownerTenantUserCol` 装 `reportedBy`」，名称与值语义不符，容易让读者误以为报告人是 Self 责任主体。

**处置：** 本轮**不改动代码**（避免扩大范围、避免改变 UI 可见性行为）。建议后续独立审查中：

1. 为该调用点加注释明确「这是『我报告的』筛选，不是 Self 授权」；
2. 或在 `RecordOwnerColumns` 增加独立属性 `reporterCol` 以区分，而不是复用 `ownerTenantUserCol`。

## 4. 对 PD-01 的影响

- 该调用点在 `(app)/assistant` UI 路径，**不在** `/api/v1/*` 通用 API 链路；
- 不影响 `scope.ts` 的任何实体映射；
- 不构成「以 reported_by 作为 API Self 兜底」——API 侧 `incidents` 的 Self 仍未注册（fail-closed）。

## 5. 结论

`reportedByTenantUserId` 在此处是合法的 UI 业务筛选，与 API Key Self 授权、事故责任主体三者语义分离；命名为遗留歧义，已记录待清理，不影响 PD-01 安全性。
