# PD-01 Phase 3 实施报告 — 分实体实施（corrective_actions）

**范围：** 按授权"分实体实施"，本轮完成 **corrective_actions** 的读 + 写 + 真 PG 多租户测试。其余 6 个实体未实施（字段未确认/需 Schema 扩展），见 `BEACONHS_PD01_PHASE3_ENTITY_MAPPING.md`。
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

## 3. 真 PostgreSQL 测试（5/5 通过）

`apps/web/src/lib/api/scope-pg.test.ts`，临时 `postgres:16-alpine`，两租户 + 两 site + 两 owner：

| 用例         | 断言                                       | 结果 |
| ------------ | ------------------------------------------ | ---- |
| site scope   | 只返回本站 2 行，不含他站                  | ✅   |
| self scope   | 只返回 `owner_tenant_user_id = 我` 的 2 行 | ✅   |
| tenant scope | 返回本租户全部 4 行（不过滤）              | ✅   |
| 跨租户       | 即使 site 相同也不返回他租户行             | ✅   |
| 未映射实体   | 非 tenant scope 返回 0 行                  | ✅   |

## 4. 门禁（各自退出码）

| 门禁             | 结果            |
| ---------------- | --------------- |
| `format:check`   | 0               |
| `typecheck`      | 0               |
| `lint`           | 0               |
| `test`           | 0（26/26 任务） |
| `deadcode:check` | 0               |
| `build`          | 0               |

## 5. 未实施（明确）

| 实体               | 状态   | 原因                                                                                                                            |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `inspections`      | ❌     | `inspector_tenant_user_id` 是否为"实际责任检查人"待确认（可能被代填）                                                           |
| `documents`        | ⚠ 部分 | 已实现"阶梯 AND RoleScope"组合，但映射未注册 → 非 tenant scope 下 fail-closed（文档对 scoped key 暂不可见），需在映射确认后启用 |
| `incidents`        | ❌     | self 语义（事故主体 vs 报告人）待产品定                                                                                         |
| `ppe_items`        | ❌     | `current_holder_person_id` 是否等同"责任使用人"待确认                                                                           |
| `training_records` | ❌     | 字段明确但本轮未做（分实体推进）                                                                                                |
| `equipment_items`  | ❌     | 无稳定责任字段，需 Schema 扩展（方案见映射文档 §4）                                                                             |

## 6. 风险

- `documents` 在非 tenant scope 下当前不可见（fail-closed）。这是安全方向，但属于**功能缺口**，必须在下一实体批次补齐映射。
- 真 PG 测试直接验证谓词，不覆盖完整 HTTP 栈（auth/rate-limit）；完整 API 越权测试在 Phase 3 收尾时补。
