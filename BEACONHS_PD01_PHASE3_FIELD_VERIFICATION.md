# PD-01 Phase 3 字段核验证据与映射状态

**性质：** 只读核验（Schema + 写入链路）。未注册新映射，未改代码（除 `createdByCol` 命名修正）。

## 1. inspections — 不注册 Self（证据不足）

| 证据                                                           | 内容                                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/db/src/schema/inspection-records.ts:59`              | `inspectorTenantUserId` 可空                                                                               |
| `apps/web/src/app/(app)/equipment/inspections/_actions.ts:271` | 写入值为 `ctx.membership?.id ?? null` —— **当前操作者**，不保证是实际检查人                                |
| `apps/web/src/app/(app)/equipment/inspections/_lib.ts:81`      | `ownerIds: [record.inspectorTenantUserId, record.submittedByTenantUserId]` —— 业务上区分"检查人"与"提交人" |
| `inspections/export.csv/route.ts:102`                          | 作为筛选条件使用，无责任语义                                                                               |

**结论：** `inspector_tenant_user_id` 在代检/代填场景下等于填表人，不等于责任检查人。**不注册 Self**。需要产品定义"责任检查人"字段（可能是 `inspector` + `supervisor` 的组合，或新增 `responsible_tenant_user_id`）。

## 2. incidents — Self 候选字段（待产品确认）

| 字段                                       | 语义           | 是否可用作 Self                      |
| ------------------------------------------ | -------------- | ------------------------------------ |
| `reported_by_tenant_user_id`               | 报告人         | ❌ 明确禁止                          |
| `created_by`（若有）                       | 创建人         | ❌ 明确禁止                          |
| 事故涉及人员（injuries / people）          | 受害/涉及      | ❌ 明确禁止                          |
| **`assigned_investigator_tenant_user_id`** | **指派调查人** | ⚠ **候选**（"事故责任处理人"最接近） |
| `closed_by_tenant_user_id`                 | 结案人         | ❌ 处理结果不是责任归属              |
| `supervisor_person_id`                     | 主管           | ⚠ 可能，但语义是"主管"不是"责任人"   |

**建议映射（待确认）：** `Self = assigned_investigator_tenant_user_id`；未指派时该记录对 self scope **不可见**（fail-closed），不做 `reportedBy` 兜底。

## 3. ppe_items — 条件批准

| 证据                                   | 内容                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| `packages/db/src/schema/ppe.ts:79`     | `currentHolderPersonId` 可空                                      |
| `apps/web/src/app/(app)/equipment/...` | 同名概念在 equipment 侧被用作 `personCol`（search/picker/export） |

**未决问题：**

- `current_holder_person_id` 是**流转状态**（借出/归还/转交会变），不是稳定责任归属；
- 离职人员：`people` 软删后该字段仍指向旧人 → self scope 需处理"人员已离职"的可见性；
- 归还后 `current_holder` 变空 → 记录对 self 不可见（是否符合业务预期？）。

**结论：** 未形成"当前实际责任使用人/保管人"的稳定证据，**不注册**。需产品确认：责任归属是否等于"当前持有人"，以及离职/归还后的可见性规则。

## 4. equipment_items — 无责任字段（Schema 设计方向）

已确认设备主表只有 `current_holder_person_id`（状态）、`current_site_org_unit_id`、`last_seen_*`；无稳定责任字段。

**设计方向（未迁移）：** 新增 `responsible_tenant_user_id`（责任保管人，tenant_user）与 `responsible_person_id`（责任人，people）。详见 Site 设计报告 §4。

## 5. 七实体映射状态表

| 实体                 | Self 字段                                   | Site 字段          | 状态                          |
| -------------------- | ------------------------------------------- | ------------------ | ----------------------------- |
| `corrective_actions` | `owner_tenant_user_id`                      | `site_org_unit_id` | ✅ 已实施                     |
| `documents`          | `owner_tenant_user_id`                      | 无（待设计）       | ✅ 已实施（site fail-closed） |
| `training_records`   | `person_id`                                 | 无（待设计）       | ✅ 已实施（site fail-closed） |
| `inspections`        | 待定（`inspector` 不可靠）                  | `site_org_unit_id` | ⏸ 条件批准                    |
| `incidents`          | 候选 `assigned_investigator_tenant_user_id` | `site_org_unit_id` | ⏸ 条件批准                    |
| `ppe_items`          | 待定（`current_holder` 不稳）               | `site_org_unit_id` | ⏸ 条件批准                    |
| `equipment_items`    | 无（需扩展）                                | 待确认             | ❌ 未实施                     |

## 6. `createdByCol` 命名审查（已修正）

原 `RecordOwnerColumns.createdByCol` 被用来承载 `owner_tenant_user_id`（corrective_actions / documents），名称误导为"创建人"。已重命名为 **`ownerTenantUserCol`**（`visibility.ts` 定义与使用、`scope.ts`、`assistant/_commit-actions.ts`），行为不变。

**附带发现（记录，未修改）：** `apps/web/src/app/(app)/assistant/_commit-actions.ts:47` 用 `incidents.reportedByTenantUserId` 作为 self 谓词。这是 AI 助手"我报告的事故"语义，不是 PD-01 的 API Self scope；但按"禁止 reportedBy 作为 Self 兜底"的原则，需在后续审查中确认该处是否符合产品语义。
