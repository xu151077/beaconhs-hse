# assertCreateInScope 全局调用方审查报告

## 1. 调用方清单（全仓 grep）

| 位置                                            | 类型                                          |
| ----------------------------------------------- | --------------------------------------------- |
| `apps/web/src/lib/api/write.ts:2556`            | **唯一生产调用点**（`createEntity` 分发入口） |
| `apps/web/src/lib/api/scope-pg.test.ts:334,339` | 测试断言                                      |

**结论：只有 1 个生产调用点**，且位于集中分发入口，无遗漏路径。

## 2. 本次改动

`assertCreateInScope` 原本对**未映射**实体直接 `return`（跳过 site 校验）。B-1 修复改为：

```ts
if (isTenantScope(ctx)) return          // 第一道：tenant scope 完全放行
const entry = API_ENTITY_SCOPE[entityKey]
if (!entry) throw ApiError.forbidden(...)  // 未映射 + 非 tenant → 拒绝
if (!entry.bodySiteKey) return            // 已映射但无 site 字段 → 不校验
// 否则校验 body site 落在 scope 内
```

## 3. tenant Scope 兼容性（逐条确认）

| 场景                                                 | 改动前         | 改动后                                |
| ---------------------------------------------------- | -------------- | ------------------------------------- |
| tenant scope，任意实体                               | return（放行） | return（放行，**第一道判断，未变**）  |
| sites scope，`corrective_actions`（已映射，有 site） | 校验 site      | 校验 site（未变）                     |
| sites scope，`documents`（已映射，无 site）          | return         | return（未变；读侧 fail-closed 生效） |
| sites scope，`training_records`（已映射，无 site）   | return         | return（未变）                        |
| sites scope，`incidents` 等**未映射**                | return（放行） | **403**（安全增强，符合任务书 §二.7） |

**结论：** tenant Scope 下的既有行为**零变化**；已明确映射的合法创建请求不被误拒绝（HTTP 验收中 tenant key 的 POST 未被 403 拦截；仅 Builder 因独立 guard 拒绝）。

## 4. HTTP 侧交叉验证

| 请求                                         | 结果              | 说明                                                               |
| -------------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| tenant key `POST /api/v1/apps/any/responses` | 404（模板不存在） | 未被 `assertCreateInScope` 拒绝（tenant scope 放行）               |
| sites key `POST /api/v1/apps/any/responses`  | 403               | 由 Builder 的 `assertScopedEntityAllowed` guard 拒绝（在读数据前） |
| 通用实体 `POST`（未构造合法 body）           | 未专项测试        | `assertCreateInScope` 的未映射拒绝由真 PG 单测覆盖                 |

## 5. 剩余风险

- 通用实体（`/api/v1/{entity}` POST）未构造合法 body 做端到端越权 404 验证；当前仅有真 PG 纯逻辑断言（scoped CREATE 拒绝）。
- `corrective_actions` 的 create site 校验未做 HTTP 端到端（需合法 body 与真实 site）。

## 6. 结论

`assertCreateInScope` 的唯一生产调用点已确认；tenant Scope 兼容行为未回退；未映射实体的 fail-closed 调整符合任务书要求，且经真 PG 测试覆盖。
