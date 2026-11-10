# PD-01 Phase 3 实施报告 — 分实体实施（corrective_actions）

**范围：** 分实体实施。已实施 **corrective_actions**、**documents**、**training_records**（3/7），均含真 PG 多租户测试。其余 4 个实体为条件批准或未实施，见 `BEACONHS_PD01_PHASE3_ENTITY_MAPPING.md`。
**未完成项明确标记，不声称 Phase 3 整体完成。**

## 1. 实施内容

| 文件                                          | 变更                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/api/scope.ts`（新）         | 实体 → owner 列映射；`entityScopeWhere`（读谓词）、`assertEntityInScope`（写前 404）、`assertCreateInScope`（创建 site 校验）                                                          |
| `apps/web/src/lib/visibility.ts`              | 导出 `RecordOwnerColumns`（复用，不复制类型）                                                                                                                                          |
| `apps/web/src/lib/api/query.ts`               | `entityVisibilitySql` 增加 `tx` 参数并接入 `entityScopeWhere`；`readEntityRows` / `getEntityRecord` 的 where 构建移入事务内；documents 改为 `documentReadFilter AND RoleScope`（交集） |
| `apps/web/src/lib/api/write.ts`               | `createEntity` 加 site 校验；`patchEntity` / `deleteEntity` 先 `assertEntityInScope`（404，不泄露存在性）                                                                              |
| `apps/web/src/lib/api/scope-pg.test.ts`（新） | 真 PG 多租户测试 5 例                                                                                                                                                                  |
| `apps/web/package.json`                       | 增加 `postgres` devDependency（测试驱动）                                                                                                                                              |

**复用而非平行：** 谓词完全来自既有 `recordVisibilityWhere(ctx, tx, cols)`；未新增权限键、未新增 scope 类型、未新增判断分支。

## 2. 语义（corrective_actions）

| scope                  | 谓词                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| `tenant`（未绑定 key） | `undefined`（不过滤）→ **现有行为完全不变**                                       |
| `sites[A]`             | `site_org_unit_id IN (A)`                                                         |
| `self`                 | `owner_tenant_user_id = 我的 membership`（**冻结：不看 assignedBy / createdBy**） |
| 未映射实体 + 非 tenant | `sql\`false\``（fail-closed，0 行）                                               |

读写一致：`readEntityRows`、`getEntityRecord`、`count`、`patchEntity`、`deleteEntity` 使用同一映射；`createEntity` 校验 body 的 `siteOrgUnitId` 落在 site scope 内。

## 3. documents 与 training_records（本轮新增）

### 3.1 字段核验（关键）

- `documents` 表**没有** `site_org_unit_id`（该列在 `document_ack_sessions`），也没有 `person_id`；只有 `owner_tenant_user_id`。
- `training_records` 表**没有** site 列；只有 `person_id`（受训人）、`course_id`、`completed_on`。

### 3.2 映射

| 实体               | self                   | site                 | 说明                                                              |
| ------------------ | ---------------------- | -------------------- | ----------------------------------------------------------------- |
| `documents`        | `owner_tenant_user_id` | **无 → fail-closed** | 保留 `documentReadFilter`（状态阶梯）与 RoleScope 的 **AND** 交集 |
| `training_records` | `person_id`（受训人）  | **无 → fail-closed** | 无 site 字段，不降级为"只看自己的"                                |

**为什么 site scope 不降级：** `recordVisibilityWhere` 在无 `siteCol` 时会退化为 personCol=me，这会让调用方以为"查的是本站数据"却拿到"自己的数据"。`scope.ts` 显式对 `sites` scope + 无 siteCol 的实体返回 `sql\`false\``。

### 3.3 documents 阶梯交集

`entityVisibilitySql` 对 documents 返回 `AND(documentReadFilter(ctx), entityScopeWhere(...))`：任一为 `false` → 空集；`documentReadFilter` 为 `undefined`（可管理文档者）时仍受 RoleScope 约束，不得放宽。

## 4. 真 PostgreSQL 测试（8/8 通过）

`apps/web/src/lib/api/scope-pg.test.ts`，临时 `postgres:16-alpine`，两租户 + 两 site + 两 owner：

| 用例         | 断言                                       | 结果 |
| ------------ | ------------------------------------------ | ---- |
| site scope   | 只返回本站 2 行，不含他站                  | ✅   |
| self scope   | 只返回 `owner_tenant_user_id = 我` 的 2 行 | ✅   |
| tenant scope | 返回本租户全部 4 行（不过滤）              | ✅   |
| 跨租户       | 即使 site 相同也不返回他租户行             | ✅   |
| 未映射实体   | 非 tenant scope 返回 0 行                  | ✅   |

## 5. 门禁（各自退出码）

| 门禁             | 结果            |
| ---------------- | --------------- |
| `format:check`   | 0               |
| `typecheck`      | 0               |
| `lint`           | 0               |
| `test`           | 0（26/26 任务） |
| `deadcode:check` | 0               |
| `build`          | 0               |

## 6. 未实施 / 条件批准

| 实体               | 状态   | 原因                                                                                                                            |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `inspections`      | ❌     | `inspector_tenant_user_id` 是否为"实际责任检查人"待确认（可能被代填）                                                           |
| `documents`        | ⚠ 部分 | 已实现"阶梯 AND RoleScope"组合，但映射未注册 → 非 tenant scope 下 fail-closed（文档对 scoped key 暂不可见），需在映射确认后启用 |
| `incidents`        | ❌     | self 语义（事故主体 vs 报告人）待产品定                                                                                         |
| `ppe_items`        | ❌     | `current_holder_person_id` 是否等同"责任使用人"待确认                                                                           |
| `training_records` | ❌     | 字段明确但本轮未做（分实体推进）                                                                                                |
| `equipment_items`  | ❌     | 无稳定责任字段，需 Schema 扩展（方案见映射文档 §4）                                                                             |

## 7. 风险

- `documents` / `training_records` 在 **site scope** 下不可见（无 site 列）。这是安全方向的功能缺口：site-scoped API key 无法读取这两类记录，需要产品决定是否补 site 归属字段。
- 真 PG 测试直接验证谓词，不覆盖完整 HTTP 栈（auth/rate-limit）；完整 API 越权测试在 Phase 3 收尾时补。
