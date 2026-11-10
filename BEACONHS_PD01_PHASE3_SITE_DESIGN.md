# PD-01 Phase 3 Site 归属字段设计（不迁移）

**范围：** `documents`、`training_records` 的 site 字段设计；`equipment_items` 责任字段设计。
**本轮只提交设计、兼容与迁移评估，不执行迁移、不回填。**

## 1. documents.site_org_unit_id

**语义：** 文档的**业务归属 Site**（该文档服务于哪个现场），不是"谁创建"或"谁上传"。

**设计：**

```sql
ALTER TABLE documents
  ADD COLUMN site_org_unit_id uuid;
-- 复合租户 FK（与项目既有模式一致）
ALTER TABLE documents
  ADD CONSTRAINT documents_tenant_site_fk
  FOREIGN KEY (tenant_id, site_org_unit_id) REFERENCES org_units (tenant_id, id)
  ON DELETE RESTRICT;
CREATE INDEX documents_tenant_site_idx ON documents (tenant_id, site_org_unit_id);
```

**可空性：** `NULL` = 项目级/全局文档（跨 Site 通用），此时 site scope **不可见**（fail-closed），tenant scope 正常。

**场景分析：**

| 场景                                 | 处理                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| 跨 Site 文档（一个文档服务多个现场） | 不引入多对多；建议拆分为多个文档，或标记为全局（NULL）                 |
| 项目级文档                           | NULL（项目级不是 Site）                                                |
| 文档转移（Site A → Site B）          | 更新 `site_org_unit_id` + `recordAudit`；旧 Site 立即不可见            |
| 历史文档                             | 迁移期全部 NULL → site-scoped key 暂不可见（安全方向），后续按业务回填 |

**为什么不复用 `document_ack_sessions.site_org_unit_id`：** 那是"签收会话"的现场，与文档归属无关。

## 2. training_records.site_org_unit_id

**必须先区分三个概念：**

| 概念            | 含义                     | 建议字段                                         |
| --------------- | ------------------------ | ------------------------------------------------ |
| 培训发生时 Site | 培训实际举行的现场       | `site_org_unit_id`（推荐）                       |
| 培训组织 Site   | 组织方所属现场           | 可选 `organizing_site_org_unit_id`（若业务需要） |
| 受训人当前 Site | 员工当前派驻现场（会变） | ❌ 不作为培训记录归属（会随时间漂移）            |

**设计：**

```sql
ALTER TABLE training_records
  ADD COLUMN site_org_unit_id uuid;   -- 培训发生（或组织）Site，产品二选一
ALTER TABLE training_records
  ADD CONSTRAINT training_records_tenant_site_fk
  FOREIGN KEY (tenant_id, site_org_unit_id) REFERENCES org_units (tenant_id, id)
  ON DELETE RESTRICT;
CREATE INDEX training_records_tenant_site_idx ON training_records (tenant_id, site_org_unit_id);
```

**历史记录归属规则（三选一，需产品定）：**

1. **严格**：历史记录 `NULL` → site scope 不可见；新记录必填。
2. **可推导**：从 `training_classes.site_org_unit_id`（若 class 有 site）推导；无 class 的保持 NULL。
3. **回填到受训人当前 Site**：❌ 不推荐 —— 会随人员调动改变历史归属。

**建议：** 方案 1（严格）+ 方案 2 作为可选辅助；禁止用受训人当前 Site 回填。

## 3. equipment_items 责任字段（Schema 设计）

**问题：** 主表无稳定责任字段；`current_holder_person_id` 是流转状态。

**设计（未迁移）：**

```sql
ALTER TABLE equipment_items
  ADD COLUMN responsible_tenant_user_id uuid,
  ADD COLUMN responsible_person_id uuid;

ALTER TABLE equipment_items
  ADD CONSTRAINT equipment_items_tenant_responsible_tu_fk
  FOREIGN KEY (tenant_id, responsible_tenant_user_id) REFERENCES tenant_users (tenant_id, id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT equipment_items_tenant_responsible_person_fk
  FOREIGN KEY (tenant_id, responsible_person_id) REFERENCES people (tenant_id, id)
  ON DELETE RESTRICT;

CREATE INDEX equipment_items_responsible_idx
  ON equipment_items (tenant_id, responsible_tenant_user_id, responsible_person_id);
```

**维护规则：**

- 登记设备时必填 `responsible_tenant_user_id`（或 person）；
- 移交/调拨：更新责任字段 + `recordAudit`，保留历史（不覆盖）；
- 离职：责任字段保留（历史归属），但 UI 标记"责任人已离职"，需重新指派；
- `current_holder_person_id` **不**作为责任归属的替代。

**影响分析：**

| 项        | 影响                                                  |
| --------- | ----------------------------------------------------- |
| 现有查询  | 新增列可空，无破坏                                    |
| 报表/导出 | 可新增"责任人"列；现有列不变                          |
| 权限/RLS  | 新增列不改变 RLS；scope 映射在列就绪后注册            |
| 历史数据  | 全部 NULL → self scope 不可见；需回填计划（不在本轮） |

## 4. 迁移评估（统一）

| 项       | 结论                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| 可空性   | 三张表的新列均可空，纯 additive，无表重写                                                                      |
| 锁       | `ADD COLUMN` 在 PG 11+ 为 metadata-only；索引 `CREATE INDEX` 建议 `CONCURRENTLY`（迁移外单独执行）             |
| 回滚     | `DROP COLUMN` 可逆（数据丢失需备份）                                                                           |
| 历史数据 | 不回填；NULL = fail-closed，安全                                                                               |
| 依赖     | 需要 `org_units(tenant_id, id)` / `tenant_users(tenant_id, id)` / `people(tenant_id, id)` 的唯一约束（已存在） |

## 5. 结论

- 三份 Schema 设计完成，**未执行迁移**。
- `documents` / `training_records` 的 site 字段需要产品确认语义（尤其 training 的"发生 vs 组织"）。
- 在字段落地前，两实体的 site scope 保持 **fail-closed**（已实施行为）。
