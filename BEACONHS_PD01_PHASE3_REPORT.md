# PD-01 Phase 3 报告 — API 数据范围接入

**结论：未实施，未通过验收。** 本报告交付范围评估、精确接入点、映射草案与测试矩阵；**没有修改任何读写代码**。

## 1. 为什么不实施（不是工作量借口，是风险判断）

Phase 3 要求"覆盖列表、详情、统计、关联查询、Builder、导出、创建、修改、删除和批量操作，不允许遗漏"。

盘点结果：接入点确实集中（8 个动态路由 → 4 个 lib），**但每个实体需要不同的 owner 语义映射**，而映射错误会直接产生两类事故：

- **过宽** → 真实越权（例如把 `corrective_actions.owner_tenant_user_id` 当成 `person_id`，self scope 会看到别人的记录）；
- **过窄** → 静默丢数据（合法记录查不到，用户以为数据丢失）。

现有 `recordVisibilityWhere(ctx, tx, { personCol, siteCol, createdByCol })` 的三列语义是 **person / site / tenant_user**，而 7 个可写实体的归属字段并不统一：

| 实体                 | site 列            | person 列   | tenant_user 列                                        | 语义备注                                                        |
| -------------------- | ------------------ | ----------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `incidents`          | `site_org_unit_id` | `person_id` | 待确认（是否有 created_by_tenant_user_id）            | 事故主体与报告人不同                                            |
| `corrective_actions` | `site_org_unit_id` | —           | `owner_tenant_user_id` / `assigned_by_tenant_user_id` | self scope 应看 owner 还是 assignedBy？**需产品定义**           |
| `inspections`        | 待逐列确认         | 待确认      | 待确认                                                | 记录表 + criteria 子表                                          |
| `documents`          | `site_org_unit_id` | `person_id` | `owner_tenant_user_id`                                | 已有 `documentReadFilter` 阶梯，需与 RoleScope **叠加而非替换** |
| `equipment_items`    | 待确认             | —           | `created_by_tenant_user_id`（部分子表）               |                                                                 |
| `ppe_items`          | `site_org_unit_id` | `person_id` | —                                                     | 持有者与检查对象不同                                            |
| `training_records`   | —                  | `person_id` | `created_by_tenant_user_id`                           | 记录主体 = 受训人                                               |

在这些语义确定之前写代码，等于用一个未经产品确认的映射决定"谁能看谁的数据"。这违反本次授权的统一约束第 4/6 条。

## 2. 精确接入点（已确认，供下一轮直接实施）

| 层      | 位置                                               | 现状                                                                                                   | 需要的改动                             |
| ------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| 读-列表 | `apps/web/src/lib/api/query.ts:174 readEntityRows` | 已调用 `entityVisibilitySql(ctx, entity)`，但该函数**只对 `documents` 返回过滤**（`query.ts:141-145`） | 用统一映射替换 documents-only 分支     |
| 读-详情 | `query.ts:281 getEntityRecord`                     | 同上（需确认是否也调用）                                                                               | 同上                                   |
| 写-创建 | `write.ts:2547 createEntity`                       | 仅权限检查                                                                                             | 校验 body 的 site/person 落在 scope 内 |
| 写-修改 | `write.ts:2557 patchEntity`                        | 仅权限检查                                                                                             | `assertEntityInScope` 后再调用 handler |
| 写-删除 | `write.ts:2568 deleteEntity`                       | 仅权限检查                                                                                             | 同上                                   |
| Builder | `builder-apps.ts`（886 行）                        | 有 `canEditResponsePayload`；列表/详情按 tenant                                                        | 按 `submitted_by` 映射 self/tenant     |
| 导出    | `reports/definitions/[id]/export/route.ts`         | 已有 `requireExportContext`（EA 系列修复）                                                             | 叠加 RoleScope，不替换现有阶梯         |
| 统计    | `readEntityRows` 的 count 查询                     | 与列表同 where                                                                                         | 随列表一起生效                         |

**关键事实：** `ctx.scopes` 在未绑定凭据时恒为 `[{type:'tenant'}]`，`recordVisibilityWhere` 返回 `undefined`（不过滤）。因此接入不会改变现有生产行为——这是本阶段可以安全实施的前提。

## 3. 实施设计（待语义确认后执行）

新增 `apps/web/src/lib/api/scope.ts`：

```ts
// entityKey → 三列映射（仅列名，不含逻辑）
export const API_ENTITY_SCOPE: Record<
  string,
  { siteCol?: string; personCol?: string; createdByCol?: string }
>
export async function entityScopeWhere(ctx, tx, entityKey): Promise<SQL | undefined>
export async function assertEntityInScope(ctx, entityKey, id): Promise<void> // 无行 → 404
```

规则：

1. `ctx.scopes` 含 `tenant` → 返回 `undefined`（现状，零开销）。
2. 映射缺失的实体 + 非 tenant scope → **fail-closed**（`sql\`false\``），绝不放行。
3. 写路径先 `assertEntityInScope` 再执行 handler，越界返回 **404**（不泄露存在性）。
4. 创建：body 的 site/person 必须落在 scope 内，否则 400/403 且**无部分写入**。
5. Builder：`submitted_by` = 主体 → self 可见；其余按 tenant scope。
6. 导出：在既有 `requireExportContext` 之上叠加，不替换。

## 4. 测试矩阵（下一轮必须全部通过）

| #   | 场景                       | 断言                             |
| --- | -------------------------- | -------------------------------- |
| 1   | 未绑定 key（tenant scope） | 读/写/删与今天完全一致           |
| 2   | 绑定 `sites[A]`            | 只能读 A 站记录；B 站记录 404    |
| 3   | 绑定 `self`                | 只能读 `person_id = 主体` 的记录 |
| 4   | 越权 PATCH 他人记录        | 404，DB 无变更                   |
| 5   | 越权 DELETE                | 404，行仍在                      |
| 6   | 越权 POST 到 scope 外 site | 拒绝且无部分写入                 |
| 7   | 列表 count 与 data 一致    | 均受同一 where                   |
| 8   | Builder 越权读/写          | 404                              |
| 9   | 导出越权                   | 拒绝                             |
| 10  | 跨租户                     | 始终 404（RLS 第二层）           |

要求：**真实 PostgreSQL 多租户**（临时容器 + 两租户 + 两 site + 绑定 key），不是源码合同。

## 5. 结论

- **Phase 3：未实施、未验收。** 需要先确定 §1 表格中 3 处语义（CA 的 self 归属、inspections/equipment 的列名、documents 阶梯与 RoleScope 的叠加顺序）。
- 已确认接入点集中，工作量可控（约 1 个新文件 + 3 处修改 + 1 个真 PG 测试文件）。
- 未改变任何生产行为，未应用迁移。
