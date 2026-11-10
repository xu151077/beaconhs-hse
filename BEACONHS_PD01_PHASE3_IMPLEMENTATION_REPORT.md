# PD-01 Phase 3 实施报告 — 分实体实施与最终专项验收

**范围：** 已实施 **corrective_actions**、**documents**、**training_records**（3/7）。其余 4 个实体为条件批准或未实施，见 `BEACONHS_PD01_PHASE3_ENTITY_MAPPING.md`。
**未完成项明确标记，不声称 Phase 3 整体完成。**

## 1. 实施内容

| 文件                                                | 变更                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/api/scope.ts`                     | 实体 → owner 列映射；`entityScopeWhere`（读谓词，含视图 `viewCols` 与 `viewColumn()` 标识符校验）、`assertEntityInScope`（写前 404）、`assertCreateInScope`（创建时 site/owner/person 校验）、`assertScopedEntityAllowed`（Builder 守卫） |
| `apps/web/src/lib/visibility.ts`                    | 导出 `RecordOwnerColumns`（复用，不复制类型）                                                                                                                                                                                             |
| `apps/web/src/lib/api/query.ts`                     | `entityVisibilitySql` 接入 `entityScopeWhere`；`readEntityRows` / `getEntityRecord` / `COUNT(*)` 的 where 构建移入事务内；documents 改为 `documentReadFilter AND RoleScope`（交集）                                                       |
| `apps/web/src/lib/api/write.ts`                     | `createEntity` 调用 `assertCreateInScope`；`patchEntity` / `deleteEntity` 先 `assertEntityInScope`（404，不泄露存在性）                                                                                                                   |
| `apps/web/src/lib/api/scope-pg.test.ts`             | 真 PG 多租户谓词测试 10 例                                                                                                                                                                                                                |
| `packages/db/src/connection-pool-isolation.test.ts` | 真 PG 连接池/事务上下文隔离 7 例（专项 A）                                                                                                                                                                                                |
| `apps/web/src/lib/api/scope-create-logic.test.ts`   | 纯逻辑创建守卫测试 8 例                                                                                                                                                                                                                   |
| `apps/web/package.json`                             | 增加 `postgres` devDependency（测试驱动）                                                                                                                                                                                                 |

**复用而非平行：** 谓词完全来自既有 `recordVisibilityWhere(ctx, tx, cols)`；未新增权限键、未新增 scope 类型、未新增判断分支。

## 2. 语义（三实体）

| 实体                   | tenant（未绑定 key）                             | sites[A]                      | self                                                                        |
| ---------------------- | ------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------- |
| `corrective_actions`   | `undefined`（不过滤）→ 现有行为不变              | `site_org_unit_id IN (A)`     | `owner_tenant_user_id = 我的 membership`（冻结：不看 assignedBy/createdBy） |
| `documents`            | `undefined`（不过滤），叠加 `documentReadFilter` | **fail-closed**（无 site 列） | `owner_tenant_user_id = 我的 membership`                                    |
| `training_records`     | `undefined`（不过滤）                            | **fail-closed**（无 site 列） | `person_id = 当前主体的 person`                                             |
| 未映射实体 + 非 tenant | `sql\`false\``（fail-closed，0 行）              | 同左                          | 同左                                                                        |

**读写一致：** `readEntityRows`、`getEntityRecord`、`COUNT(*)`、`patchEntity`、`deleteEntity` 使用同一 `entityScopeWhere` 谓词；`createEntity` 的 `assertCreateInScope` 对带 site 的实体校验 `siteOrgUnitId` 落在 site scope 内，对 `self` scope 校验 owner/person。

## 3. documents 阶梯交集

`entityVisibilitySql` 对 documents 返回 `AND(documentReadFilter(ctx), entityScopeWhere(...))`：任一为 `false` → 空集；`documentReadFilter` 为 `undefined`（可管理文档者）时仍受 RoleScope 约束，不得放宽。HTTP 实证：`self_ro`（仅 `documents.read`）只见 `published` + 本人文档；`self`（含 `documents.manage`）可见本人 draft。

## 4. 视图实体（`viewCols`）

`corrective_actions` 与 `training_records` 的列表实体是 SQL 视图（`report_corrective_actions` / `report_training_records`），无 Drizzle 表定义。`recordVisibilityWhere` 生成表前缀列名无法在视图上解析（曾导致 500）。`scope.ts` 对这两类实体改用**常量列名 + 无表前缀**的等价谓词，列名经 `SAFE_IDENT` 正则校验（仅代码内固定常量，非调用方输入）。查询构建为单表 `FROM "<view>"`，无 JOIN，列名无歧义。

## 5. 真 PostgreSQL 测试

| 测试                  | 文件                                                | 用例  | 退出码 |
| --------------------- | --------------------------------------------------- | ----- | ------ |
| 谓词多租户            | `apps/web/src/lib/api/scope-pg.test.ts`             | 10/10 | 0      |
| 连接池/事务上下文隔离 | `packages/db/src/connection-pool-isolation.test.ts` | 7/7   | 0      |

## 6. HTTP 端到端（专项 B）

- 写矩阵 50 请求 + 读回 6 + 认证/Builder/速率 9：合法 201/200、越权 403/404/400、**无 500**、被拒操作 0 副作用。
- 三处真实缺陷已修复（D-A 视图 person 列 500；D-B 写路径绕过 fail-closed；D-C 创建时未校验责任主体）。详见 `BEACONHS_PD01_WRITE_HTTP_E2E_REPORT.md`。

## 7. 纯逻辑测试

`apps/web/src/lib/api/scope-create-logic.test.ts` 8/8（无 DB、无 HTTP）。

## 8. 门禁（各自退出码）

| 门禁             | 结果 |
| ---------------- | ---- |
| `format:check`   | 0    |
| `typecheck`      | 0    |
| `lint`           | 0    |
| `test`           | 0    |
| `deadcode:check` | 0    |
| `build`          | 0    |

## 9. 未实施 / 条件批准（七实体状态）

| 实体                 | 状态                         | 原因                                                                  |
| -------------------- | ---------------------------- | --------------------------------------------------------------------- |
| `corrective_actions` | ✅ 实施（读 + 写 + 真 PG）   | —                                                                     |
| `documents`          | ✅ 实施（读 + 写 + 真 PG）   | —                                                                     |
| `training_records`   | ✅ 实施（读 + 创建 + 真 PG） | 视图 list-only，无 PATCH/DELETE                                       |
| `inspections`        | ❌                           | `inspector_tenant_user_id` 是否为"实际责任检查人"待确认（可能被代填） |
| `incidents`          | ❌                           | self 语义（事故主体 vs 报告人）待产品定                               |
| `ppe_items`          | ❌                           | `current_holder_person_id` 是否等同"责任使用人"待确认                 |
| `equipment_items`    | ❌                           | 无稳定责任字段，需 Schema 扩展（方案见映射文档 §4）                   |

## 10. 风险

- `documents` / `training_records` 在 **site scope** 下不可见（无 site 列）。这是安全方向的功能缺口：site-scoped API key 无法读取这两类记录，需要产品决定是否补 site 归属字段。
- `corrective_actions` / `training_records` 为视图，无记录端点（list-only），PATCH/DELETE 不可达 —— 属设计限制，未新增 API。
- 视图 `viewCols` 分支依赖固定列名常量；新增视图实体必须同步注册，否则 fail-closed（安全）但功能不可见。
