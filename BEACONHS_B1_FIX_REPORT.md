# B-1 修复报告 — Builder Apps RoleScope 缺失（安全阻断项）

## 根因

`apps/web/src/lib/api/builder-apps.ts`（886 行）所有数据访问都经 `ctx.db`（RLS 第二层），但**没有任何** `recordVisibilityWhere` / `entityScopeWhere` 调用。`/api/v1/apps/{templateKey}/responses` 的 5 个 handler（GET 列表 / GET 详情 / POST / PATCH / DELETE）在 `authenticateApiKey` + 权限检查后直接读写，绑定 `sites`/`self` scope 的 API Key 仍可访问**租户内全部**表单响应。

## 修复（复用既有机制，未建平行体系）

按任务书「若暂时无法确认责任主体 → Site/Self Scope 对 Builder 响应 fail-closed」：

| 文件                            | 变更                                                                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/api/scope.ts` | 新增 `assertScopedEntityAllowed(ctx, entityKey)`：调用 `entityScopeWhere`，**返回 `undefined` 才放行**（仅 tenant scope）；任何 SQL（含未映射实体的 fail-closed `false`）→ 403。`assertCreateInScope` 对未映射实体由"跳过"改为**拒绝** |
| `.../responses/route.ts`        | GET 列表、POST 创建 —— auth + 权限后、**读数据前**调用 guard                                                                                                                                                                           |
| `.../responses/[id]/route.ts`   | GET 详情、PATCH、DELETE —— 同上                                                                                                                                                                                                        |

关键性质：

- guard 在 `resolveBuilderApp` / 任何查询**之前**执行，不存在"先读跨范围数据再隐藏"（任务书 §二.10）。
- `form_responses` **未注册映射** → 非 tenant scope 由 `entityScopeWhere` 返回 `sql\`false\``→ guard 拒绝；tenant scope 返回`undefined` → 原行为完全不变（§二.8）。
- PATCH/DELETE/CREATE 同样在写前拒绝；未放行任何跨范围写入。

## Builder Self 语义（另见 `BEACONHS_BUILDER_SELF_SEMANTICS.md`）

`submittedBy`（可能是代填人）、`subjectPersonId`（表单主体，可能是他人）均未证明为"责任主体"，**未注册 Self 映射**，也未引入 Schema 迁移。

## 测试（真 PostgreSQL，10/10）

`apps/web/src/lib/api/scope-pg.test.ts`（临时 `postgres:16-alpine`）：

| 用例                                                           | 结果      |
| -------------------------------------------------------------- | --------- |
| 原有 8 例（corrective_actions / documents / training_records） | ✅ 不回退 |
| B-1：`form_responses` tenant scope → `undefined`（兼容）       | ✅        |
| B-1：sites / self scope → 谓词为 `false`，查询 0 行            | ✅        |
| B-1：scoped key 不能 CREATE 未映射实体（抛错）                 | ✅        |

**测试分层：** 真 PostgreSQL 谓词层 10/10；**HTTP 集成未执行**（需运行 web + DB + API key）；无 Mock。

## 修改文件清单

```
apps/web/src/lib/api/scope.ts
apps/web/src/app/api/v1/apps/[templateKey]/responses/route.ts
apps/web/src/app/api/v1/apps/[templateKey]/responses/[id]/route.ts
apps/web/src/lib/api/scope-pg.test.ts
```

## 门禁（各自退出码）

`format 0 / typecheck 0 / lint 0 / test 0(26/26) / deadcode 0 / build 0`

## 剩余风险

1. site/self scoped API Key **完全不能访问 Builder 响应**（fail-closed 是有意的产品缺口），需模板级 Self 责任主体配置方案落地后启用。
2. 真 PG 只验证谓词与 guard 决策，未跑完整 HTTP 链路（403 响应码、错误体、速率限制）— 需 HTTP 集成测试。
3. `assertScopedEntityAllowed` 用 `entityScopeWhere` 的返回值判定；若将来 `form_responses` 被注册映射，guard 仍会拒绝非 tenant scope（正确，直到明确授权）。
