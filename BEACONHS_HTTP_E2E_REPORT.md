# PD-01 Phase 3 — HTTP 端到端安全验收报告

**基线：** HEAD 核实为 `027f724d`（含 `faf1fefb` B-1 修复），分支 `hse-platform`。
**环境：** 本地隔离 `postgres:16` + Redis + MinIO + Mailpit + `pnpm dev`（`localhost:3000`），**未连接生产**。
**测试性质：** 真实 HTTP 请求（curl）+ 真实 PostgreSQL + 真实 API Key（DB 直写创建）。

## 1. 发现的缺陷（已修复）

**P-1：`sites`/`self` key 访问 `corrective_actions` 返回 500。**

根因：报表实体 `corrective_actions` 的查询表是**视图 `report_corrective_actions`**（无 Drizzle 定义），而 `scope.ts` 映射用的是物理表 `correctiveActions` 的 PgColumn，Drizzle 生成 `"corrective_actions"."owner_tenant_user_id"` 前缀，视图 FROM 中无该表别名 → PG 报错 → 500。

修复（`scope.ts`）：为视图类实体增加 `viewCols`（常量列名），生成**无表前缀**的等价 scope 谓词；其余实体仍复用 `recordVisibilityWhere`。修复后 `sites`/`self` 返回 200 空集（fail-closed），tenant 保持 200 有数据。

## 2. HTTP 验收结果（14 项）

| #   | 场景                                    | 期望                     | 实测                                          |
| --- | --------------------------------------- | ------------------------ | --------------------------------------------- |
| 1   | 无 Authorization                        | 401                      | ✅ 401 `{"code":"unauthorized"}`              |
| 2   | 无效 key                                | 401                      | ✅ 401                                        |
| 3   | tenant key `/corrective_actions`        | 200 有数据               | ✅ 200                                        |
| 4   | tenant key `/documents`                 | 200 有数据               | ✅ 200                                        |
| 5   | tenant key Builder GET                  | 非 403（模板不存在 404） | ✅ 404                                        |
| 6   | sites key `/corrective_actions`         | 200 空集                 | ✅ 200 `data:[]`                              |
| 7   | self key `/corrective_actions`          | 200 空集                 | ✅ 200 `data:[]`                              |
| 8   | sites/self key `/documents`             | 200 空集（fail-closed）  | ✅ 200 `total:0`                              |
| 9   | sites/self key `/training_records`      | 200 空集                 | ✅ 200 `total:0`                              |
| 10  | sites key Builder GET/POST/PATCH/DELETE | 403                      | ✅ 全部 403                                   |
| 11  | self key Builder GET/POST               | 403                      | ✅ 403                                        |
| 12  | 错误体不含 SQL/表结构                   | 无泄漏                   | ✅ 仅 `code`+`message`                        |
| 13  | 速率限制头                              | 存在                     | ✅ `ratelimit-limit: 600` / remaining / reset |
| 14  | 跨租户（tenant key 查他租户 id）        | 404                      | ✅ 404（无记录端点，不泄露存在性）            |

**Builder 专项：** 5 个入口（列表 GET、详情 GET、POST、PATCH、DELETE）对 sites/self 全部 403；tenant key 走到 `resolveBuilderApp` 后 404（模板不存在），证明 guard 只拦非 tenant scope，且**发生在任何数据查询之前**。错误体固定文案，无 SQL、无内部表名、无敏感数据。

## 3. 测试分层（如实区分）

| 层                  | 命令                                                                       | 数量      | 退出码       |
| ------------------- | -------------------------------------------------------------------------- | --------- | ------------ |
| **HTTP 集成**       | 上表 curl 矩阵                                                             | 14 项     | 全部符合期望 |
| **真实 PostgreSQL** | `pnpm --filter @beaconhs/web exec vitest run src/lib/api/scope-pg.test.ts` | **10/10** | 0            |
| **纯逻辑**          | `scope-pg.test.ts` 内 `assertCreateInScope` 断言 2 例                      | 2/2       | 0（含于上）  |
| **连接池隔离**      | 未新增专项测试；沿用 `withTenant` 既有隔离测试                             | —         | 未执行专项   |
| **Mock**            | 无                                                                         | —         | —            |

**明确声明：本轮 HTTP 集成是真实 Web+DB+API Key 的端到端请求；谓词层 10/10 不与之混淆。**

## 4. 端到端授权矩阵

| 实体                     | tenant key       | sites key            | self key           |
| ------------------------ | ---------------- | -------------------- | ------------------ |
| `corrective_actions`     | 全租户           | 仅本站（本次空）     | 仅 owner（本次空） |
| `documents`              | 全租户（含阶梯） | **空**（无 site 列） | 仅 owner           |
| `training_records`       | 全租户           | **空**（无 site 列） | 仅受训人           |
| Builder `form_responses` | 原行为           | **403**              | **403**            |
| 未映射实体               | 原行为           | 空/403               | 空/403             |

## 5. 未通过项目与剩余风险

| 项                                                            | 状态                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `corrective_actions` 的 500（已发现）                         | ✅ 已修复并回归                                                          |
| `corrective_actions` 详情接口                                 | ⚠ 视图为 list-only，返回 404「No record endpoint」——**设计如此**，非缺陷 |
| 连接池复用/事务上下文隔离专项测试                             | ❌ 未执行（沿用既有 `withTenant` 测试）                                  |
| 完整 HTTP 覆盖 CREATE/PATCH/DELETE 对**已映射实体**的越权 404 | ❌ 未执行（Builder 因 guard 全部 403；通用实体缺可写的测试数据）         |
| 导出（UI session）RoleScope                                   | ❌ 不适用（API Key 不可达，见 B-2 报告）                                 |
| 未确认字段实体                                                | `inspections`/`incidents`/`ppe_items` 条件批准，`equipment_items` 未实施 |
| site-scoped key 无法读取 documents/training_records           | ⚠ 已知功能缺口（无 site 列），待 Schema 设计落地                         |

## 6. 门禁（各自退出码）

`format 0 / typecheck 0 / lint 0 / test 0(26/26) / deadcode 0 / build 0`

## 7. 修改文件与本地状态

- 修改：`apps/web/src/lib/api/scope.ts`（视图列名谓词修复）
- 新增：本报告、`BEACONHS_BUILDER_HTTP_VERIFICATION.md`、`BEACONHS_ASSERT_CREATE_SCOPE_AUDIT.md`
- 本地 HEAD、`git status`、提交 hash 见最终交付消息
- 未 push、未生产迁移、未改 RLS、未动生产数据
