# PD-01 Phase 3 实体字段映射（证据）

**用途：** Phase 3 的 `recordVisibilityWhere` 需要三类列：`personCol`（`people.id`）、`siteCol`（`org_units.id`）、`createdByCol`（`tenant_users.id`）。本文件逐实体给出真实列与证据，并标注可实施状态。

**规则：** 未确认字段不得投入使用（授权书 §二）。`recordVisibilityWhere` 只接受 Drizzle 列对象，因此实现映射时必须引用 schema 列，不能传字符串列名。

## 1. 映射表

| 实体                 | `siteCol`          | `personCol`                | `createdByCol`                           | 状态                               |
| -------------------- | ------------------ | -------------------------- | ---------------------------------------- | ---------------------------------- |
| `corrective_actions` | `site_org_unit_id` | —                          | **`owner_tenant_user_id`**               | ✅ **已冻结、可实施**              |
| `inspections`        | `site_org_unit_id` | —                          | `inspector_tenant_user_id`（责任检查人） | ✅ 字段存在；需确认非创建人        |
| `documents`          | `site_org_unit_id` | `person_id`                | `owner_tenant_user_id`                   | ✅ 三重交集                        |
| `incidents`          | `site_org_unit_id` | `person_id`（事故主体）    | —                                        | ⚠ self 语义待定（主体 vs 报告人）  |
| `ppe_items`          | `site_org_unit_id` | `current_holder_person_id` | —                                        | ✅ 字段存在                        |
| `training_records`   | —                  | `person_id`                | `created_by_tenant_user_id`              | ✅ 字段存在                        |
| `equipment_items`    | 待核实             | 待核实                     | 待核实                                   | ❌ **需 Schema 扩展方案**（见 §4） |

## 2. corrective_actions（本轮实施）

证据 `packages/db/src/schema/corrective-actions.ts`：

- `siteOrgUnitId: uuid('site_org_unit_id').references(() => orgUnits.id)`
- `ownerTenantUserId: uuid('owner_tenant_user_id').references(() => tenantUsers.id)`
- `assignedByTenantUserId`、`createdByTenantUserId` 存在但**不参与** self 可见性（产品冻结）

映射：`{ siteCol: correctiveActions.siteOrgUnitId, createdByCol: correctiveActions.ownerTenantUserId }`。
语义：self scope = "我是负责人"，与 `assigned_by` / `created_by` 无关。

## 3. inspections

证据 `packages/db/src/schema/inspection-records.ts:55,59,60,65`：

- `siteOrgUnitId`（业务所属 site）
- `inspectorTenantUserId`（检查人）
- `supervisorTenantUserId`（主管）
- `foremanPersonIds`（jsonb 数组，非单值，不能直接作 `personCol`）

映射：`{ siteCol: inspectionRecords.siteOrgUnitId, createdByCol: inspectionRecords.inspectorTenantUserId }`。
**待确认：** 该字段是否在业务流转中被改写为"实际检查人"（若仅创建时写入一次且可被他人代填，则语义不等于责任检查人）。未确认前不启用。

## 4. equipment_items（阻断：无明确责任字段）

在 `packages/db/src/schema/equipment*.ts` 中可检索到的相关字段：

- `currentHolderPersonId`（当前持有人，**状态字段**，随借还变化）
- `currentSiteOrgUnitId` / `lastSeenSiteOrgUnitId`（当前位置/最后位置）
- `assignedToPersonId` / `assignedToTenantUserId`（出现在 work order / 日志类表，不是设备主表）

**结论：** 设备主表没有稳定的"责任保管人/责任使用人"字段；`current_holder` 是流转状态，不是责任归属。按授权书"不得自行替代"，**不启用**，并提出正式扩展方案：

```sql
-- 建议（未实施）：设备责任归属
ALTER TABLE equipment_items
  ADD COLUMN responsible_person_id uuid REFERENCES people(id),
  ADD COLUMN responsible_tenant_user_id uuid REFERENCES tenant_users(id);
-- 并由设备登记/移交流程维护；缺省回退到 current_holder（需产品确认）
```

该扩展需要产品确认与迁移评审，本轮不实施。

## 5. documents（三交集）

产品冻结：`documentReadFilter AND recordVisibilityWhere AND tenantIsolation`。

现状：

- `apps/web/src/lib/api/query.ts:141-145 entityVisibilitySql` 只对 documents 返回 `documentReadFilter(ctx)`；
- `tenantIsolation` 由 RLS 强制（第二层）；
- `recordVisibilityWhere` 目前**未**叠加。

实施要求：在 `entityVisibilitySql` 中对 documents 返回 `AND(documentReadFilter, recordVisibilityWhere(...))`，且 `undefined`（tenant scope）时不得**放宽**阶梯结果。即：

```
finalWhere = tenantIsolation(RLS) AND documentReadFilter AND (recordVisibilityWhere ?? TRUE)
```

任一为 `sql\`false\`` → 结果为空；不得用 OR 合并。

## 6. 其余实体

- `incidents`：self 语义需产品明确"事故主体（person_id）"还是"报告人"；未定前不启用 self，只用 site scope。
- `ppe_items`：`current_holder_person_id` 是当前持有人，与"责任使用人"接近；需产品确认是否等同。
- `training_records`：`person_id` = 受训人，语义明确。

## 7. 本轮实施结论

| 实体                 | 本轮                                                |
| -------------------- | --------------------------------------------------- |
| `corrective_actions` | ✅ 实施（读 + 写 + 真 PG 测试）                     |
| 其余 6 个            | ❌ 未实施（字段确认中 / 需 Schema 扩展 / 语义待定） |

未实施的实体在 `scope.ts` 映射中**不出现**；`entityScopeWhere` 对未映射实体在非 tenant scope 下 **fail-closed**（返回 `sql\`false\``），绝不静默放行。
