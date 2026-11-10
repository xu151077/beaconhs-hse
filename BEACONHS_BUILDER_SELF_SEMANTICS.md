# Builder Self 业务语义核验报告

**结论：不注册统一 Self 字段；site/self scope 对 Builder 响应 fail-closed（已在 B-1 修复中实施）。**

## 1. 候选字段核验

| 候选              | 类型                        | 核验结果                                                         | 能否作 Self         |
| ----------------- | --------------------------- | ---------------------------------------------------------------- | ------------------- |
| `submittedBy`     | `tenant_users.id`           | 记录"谁提交了响应"；在代填/代提交场景等于**代填人**              | ❌ 未证明为责任主体 |
| `subjectPersonId` | `people.id`                 | 表单的**业务主体**（如被检查的设备、被评估的人），常与操作者无关 | ❌ 不是操作者身份   |
| `createdBy`       | —                           | 同 `submittedBy` 类风险                                          | ❌ 任务书明令禁止   |
| 模板定义          | `form_templates`            | 模板不含"责任主体"声明                                           | ❌ 无字段           |
| 响应数据结构      | `form_responses.data` JSONB | 自由结构，无统一责任字段                                         | ❌ 无结构保证       |

## 2. 创建/提交链路（只读）

- `createBuilderAppResponse`（`builder-apps.ts:588`）：写入 `submittedBy = ctx.membership?.id`（当前 API 主体），`subjectPersonId` 来自 body。
- `updateBuilderAppResponse`（:622）：已有 `canEditResponsePayload(ctx, row.response)`（F1 修复），校验的是**响应归属**，不是 RoleScope。
- 代填：A 代 B 提交时 `submittedBy = A`，而业务责任可能属于 B。与 `inspections.inspector_tenant_user_id` 同类问题。

**证据不足**：没有任何写入链路证明 `submittedBy` 或 `subjectPersonId` 是"责任主体"。按任务书「不得未经证据确认，将 submittedBy 或 subjectPersonId 注册为统一 Self 字段」。

## 3. 模板级 Self 责任主体配置方案（设计，未实施，无迁移）

在 `form_templates` 增加配置（JSONB，非新表、非新权限体系）：

```ts
type TemplateSelfResponsibility =
  | { kind: 'submitted_by' } // 仅当该模板禁止代填
  | { kind: 'subject_person' } // 仅当主体即责任人
  | { kind: 'field'; fieldKey: string } // 指向响应 data 中的 person 字段
  | { kind: 'none' } // 默认：fail-closed
```

规则：

- 默认 `none` → 非 tenant scope 拒绝（**当前已实施行为**）；
- 模板管理员显式声明后，`entityScopeWhere` 按配置选列；
- 声明必须是**模板级**，不做全局兜底；
- 不引入 Schema 迁移（配置存于模板 JSONB），需产品批准后方可实施。

## 4. 结论

- 已实施：site/self scope 对 Builder 响应 fail-closed（B-1）。
- 未实施：模板级配置方案（需产品决策）。
- 未引入任何 Schema 迁移或平行权限系统。
