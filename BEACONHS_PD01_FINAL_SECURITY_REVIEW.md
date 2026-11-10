# PD-01 Phase 3 最终安全审查（专项 C）

**审查对象：** PD-01 Phase 3 公共 REST API 分实体记录范围层（`apps/web/src/lib/api/scope.ts` 及其调用方）。
**审查日期：** 2026-11-10。**HEAD：** `d54a233e`（分支 `hse-platform`，未 push）。

## 0. 审查方法与独立性声明（如实记录）

- 本轮启动的**独立自动化安全审查子代理未能返回结果**（后台会话 `ses_e3b9ba52…` 被取消；前台重试因平台用量配额失败）。因此本审查由实施方自行执行，证据来自：一个**独立只读 explore 子代理**的全量数据访问入口盘点（其结果独立返回）、真实 PostgreSQL 谓词/连接池测试、真实 HTTP 端到端矩阵、以及对每个断言的逐行源码核验。
- **这是本次审查的独立性与流程限制，不是技术缺陷。** 在此前提下，本审查刻意采取保守取态；凡无法独立确证的项均按"非阻断限制"列出，而非计入通过项。

## 1. §5.1 权限架构

| 检查项                             | 结论 | 证据                                                                                                                                                     |
| ---------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未新增平行权限系统                 | ✅   | `scope.ts` 复用 `recordVisibilityWhere`（`visibility.ts`），谓词来自既有实现；无新权限键、无新 scope 类型                                                |
| 复用 Permission / RoleScope / RLS  | ✅   | `keyHasPermission`（`permissions.ts`）、`narrowRoleScopes`（`@beaconhs/tenant`）、RLS 经 `withTenant`                                                    |
| Principal ∩ Credential permissions | ✅   | `principal.ts` `narrowPermissions()`：credential 权限必须同时被 principal 持有，wildcard 不展开                                                          |
| Credential Scope 只能收窄          | ✅   | `narrowRoleScopes(access.scopes, credential.scopes)` 不合法即 `scope_exceeds_principal` → 403                                                            |
| tenant / sites / self 语义不混淆   | ✅   | `entityScopeWhere` 三分支互斥；`sites` + 无 site 列 → `sql\`false\``                                                                                     |
| 未映射实体非 tenant 下 fail-closed | ✅   | `entityScopeWhere` `if (!entry) return sql\`false\``；`assertCreateInScope` `if (!entry) throw forbidden`；`assertEntityInScope` `if (!entry) throw 404` |
| tenant scope 行为零变化            | ✅   | 三个守卫均以 `isTenantScope(ctx)` 首判提前返回；HTTP 实证 tenant key 全部保持 200/201                                                                    |

## 2. §5.2 数据访问入口

全量盘点（独立子代理 + 抽样亲核）：`/api/v1` 下共 8 个 route handler；**不存在** count、export、download、preview、batch、statistics、async 路由；`pagination.total` 的 `COUNT(*)` 与列表共用同一 scope 谓词（`query.ts:231,237-243`）。

| 入口                                                                | 评估                                                                                                                                       | 分级           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `query.ts` / `write.ts` 三守卫覆盖的读写路径                        | 列表、详情、count、PATCH、DELETE 使用同一谓词                                                                                              | ✅             |
| `auth.ts:46,159` `withSuperAdmin`                                   | 认证引导期使用（尚无租户上下文），谓词内显式过滤 `tenantId`（`auth.ts:88-104`）                                                            | ✅ 非 bypass   |
| `/api/v1/openapi.json` 直接 `ctx.db` 读自定义列                     | `loadBeaconCustomReportColumns` 为租户内**列定义元数据**，RLS 约束，无记录数据                                                             | ⚠ 非阻断       |
| `/api/v1`、`/api/v1/apps`、`/api/v1/openapi.json` 的 Builder 元数据 | `listBuilderApps` 过滤 `tenantId + status='published' + id IN key.builderTemplateIds`；返回模板摘要/字段定义，**非** `form_responses` 记录 | ⚠ 非阻断       |
| `idempotency.ts:101-103` 重放返回缓存响应                           | 不重跑 `assertCreateInScope`/`assertEntityInScope`；但重放绑定同一 `apiKeyId`，且 `authenticateApiKey` 每次重跑                            | ⚠ 非阻断（低） |
| Builder responses 5 入口                                            | 全部在数据查询前执行 `assertScopedEntityAllowed`                                                                                           | ✅             |
| 导出/下载/预览                                                      | 均位于会话态 app shell（`requireExportContext` + `assertCan('admin.data.export')`），不经 API key，不在本层职责内                          | ✅ 不适用      |

## 3. §5.3 实体映射（七实体）

| 实体                 | 当前规则                                                                                                         | 核验                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `corrective_actions` | Self = `owner_tenant_user_id`；Site = `site_org_unit_id`                                                         | ✅（视图 `report_corrective_actions`，读谓词用无表前缀常量列） |
| `documents`          | Self = `owner_tenant_user_id`；Site 无字段 → fail-closed；`documentReadFilter AND RoleScope AND TenantIsolation` | ✅                                                             |
| `training_records`   | Self = `person_id`；Site 无字段 → fail-closed                                                                    | ✅（视图 `report_training_records`）                           |
| `inspections`        | **不注册 Self**                                                                                                  | ✅ 不在 `API_ENTITY_SCOPE`                                     |
| `incidents`          | **不注册 Self**（责任调查人字段待核实）                                                                          | ✅ 不在 `API_ENTITY_SCOPE`                                     |
| `ppe_items`          | **不注册 Self**                                                                                                  | ✅ 不在 `API_ENTITY_SCOPE`                                     |
| `equipment_items`    | 等待 Schema 扩展，未实施                                                                                         | ✅ 不在 `API_ENTITY_SCOPE`                                     |

**Self 兜底禁令：** `scope.ts` 不存在 `createdByCol` / `reportedBy` / 代填人回退；映射仅使用 `ownerTenantUserCol` 与 `personCol`。✅

## 4. §5.4 Builder Apps

- 5 个 responses handler（list GET、detail GET、POST、PATCH、DELETE）均在**任何数据查询之前**调用 `assertScopedEntityAllowed`（`responses/route.ts:30,54`；`responses/[id]/route.ts:36,66,102`）。✅
- 未映射 `form_responses` 对 Site/Self key 一律 403，固定文案；HTTP 实证无 SQL/表名泄漏。✅
- Tenant key 行为兼容（走到 `resolveBuilderApp` 后 404，未命中 403）。✅
- `TemplateSelfResponsibility` **仅存在于设计文档，无任何代码实现**（全仓 grep 为空）。✅

## 5. §5.5 documents 三交集

| 层                              | 证据                                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| `documentReadFilter`（阶梯）    | `self_ro`（仅 `documents.read`）只见 `published` + 本人文档；draft 被隐藏 |
| RoleScope（`entityScopeWhere`） | `self_ro`/`self` 均只见本人 owned 文档；`sites` key 空集                  |
| TenantIsolation（RLS）          | 跨租户 ID 404；专项 A 证明 RLS 在连接复用下仍生效                         |

`manage` 只放宽阶梯，不放宽 scope —— 无一层可被其他层放宽。✅

## 6. §5.6 视图映射（`viewCols` 分支）

| 检查项                                                        | 结论                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 列名来源固定且可信                                            | `viewCols` 均为代码内常量；`viewColumn()` 以 `SAFE_IDENT`（`^[a-z_][a-z0-9_]*$`）校验，非调用方输入 ✅ |
| SQL 标识符处理安全                                            | 经 `sql.raw` 前先过白名单正则；值经参数化（`sql\`… in ${ids}\``、`= ${ctx.personId}`），不拼接值 ✅    |
| JOIN 列名歧义                                                 | `readEntityRows` / `getEntityRecord` 均为单 `FROM "<table                                              | view>"` 无 JOIN；`assertEntityInScope`的 Drizzle 查询单表`from(entry.table)`，无歧义 ✅ |
| Site/Self/tenant 语义一致                                     | 与物理表映射同一分支逻辑；`sites` + 无 site 列仍 fail-closed ✅                                        |
| 不破坏底层租户隔离                                            | 谓词与 RLS 叠加（AND）；跨租户 ID 全部 404 ✅                                                          |
| 覆盖 `report_corrective_actions` 与 `report_training_records` | 前者 `siteColName/ownerColName`，后者 `personColName`（本轮补齐）✅                                    |

## 7. 本轮发现并修复的缺陷（均已复验）

| ID  | 缺陷                                                                                    | 根因                                                                      | 修复                                                     | 复验                    |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------- |
| D-A | `self` key `GET /training_records` 500                                                  | 视图实体用物理表列生成带表前缀谓词                                        | 注册 `viewCols.personColName` 并实现 person 分支         | HTTP 200 且可见本人记录 |
| D-B | `sites` key 可 PATCH/DELETE 自己的 documents（200），读侧却 fail-closed（404）          | `assertEntityInScope` 直调 `recordVisibilityWhere`，绕过 fail-closed 规则 | 改用 `entityScopeWhere`（与读路径同一谓词）              | HTTP 404                |
| D-C | scoped key 可在 scope 外创建记录（self 为他人创建 201；sites 在无 site 列实体创建 201） | `assertCreateInScope` 只校验 site                                         | sites+无 site 列 → 403；self → owner/person 必须等于主体 | HTTP 403；纯逻辑 8/8    |

三个修复均为 fail-closed 收紧；未新增 API、未改 Schema、未改 RLS、未新增权限键。

## 8. 剩余发现（按严重度）

| #   | 发现                                                                                                            | 分级                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| R1  | 4/7 实体未实施（inspections / incidents / ppe_items / equipment_items），非 tenant scope 下 fail-closed（0 行） | 非阻断（产品冻结的等待态，安全方向）                                  |
| R2  | `corrective_actions` / `training_records` 视图 list-only，无 PATCH/DELETE 端点                                  | 非阻断（设计；任务书禁止为此新增 API）                                |
| R3  | site scope 无法读取 `documents` / `training_records`（无 site 列）                                              | 非阻断（fail-closed，安全方向）                                       |
| R4  | self key 无法创建 `corrective_actions`（无 site scope 可携带）                                                  | 非阻断（fail-closed）                                                 |
| R5  | PATCH 修改归属字段可把记录移出自身 scope（200）；守卫对变更前行授权，转移后 key 反而失去访问权，无越权访问获得  | 非阻断（业务规则需产品决策）                                          |
| R6  | Builder 元数据路由无 `assertScopedEntityAllowed`                                                                | 非阻断（模板元数据，受 `builderTemplateIds` + 租户 + published 约束） |
| R7  | 幂等重放不重跑 scope 守卫                                                                                       | 非阻断（低；重放绑定 apiKeyId）                                       |
| R8  | 审查独立性的流程限制（见 §0）                                                                                   | 流程限制                                                              |

## 9. 结论：**CONDITIONAL PASS**

**理由：** 所有**阻断项已关闭**——本轮专项 A/B 发现的 3 个真实缺陷（含 2 个越权风险：写路径绕过 fail-closed、创建时未校验责任主体）已修复并以真实 HTTP + 真 PG 测试复验；读/写/count 使用同一谓词；未映射实体 fail-closed；Builder 五入口守卫前置；documents 三交集互不放宽；连接池复用下租户上下文无残留。任务书 §4.6 的验收标准全部满足。

**之所以不是 PASS：** 存在明确的非阻断限制（R1–R5），其中 R1（4/7 实体未实施）与 R3（site scope 覆盖缺口）是产品已冻结的等待态而非缺陷，但它们意味着"三 scope × 七实体"的矩阵尚未闭环；且本次审查的独立性受 §0 的流程限制。这些限制不构成越权风险（全部为收紧方向或元数据层面），但在进入发布候选审查前应作为已知限制如实随行。

## 10. 无法在本环境核验的项

- 生产环境 `10.10.31.13` 的行为（任务书禁止连接生产）；所有验证均在隔离本地环境完成。
- 速率限制在多实例部署下的分布式语义（本地为单实例内存实现）。
- `/api/v1/openapi.json`、`/api/v1`、`/api/v1/apps` 对 scoped key 的元数据暴露范围是否需要收紧，需产品决策（R6）。
