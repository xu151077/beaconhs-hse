# BeaconHS PD-01 Phase 1–3 独立安全审查

**审查基线：** 分支 `hse-platform`，HEAD `23b1d64e`，工作区干净（0 项未提交），相对 `origin/hse-platform` 领先 18 提交，未 push。
**生产发布基线：** `origin/hse-platform`。
**审查性质：** 只读审查 + 本报告。未修改任何业务代码、迁移、RLS、生产数据库；未执行 Apply、Push、Merge、部署。

---

## 1. 审查范围与基线

| 项       | 值                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 审查对象 | PD-01 Phase 1（凭证主体绑定 Schema）、Phase 2（Principal 授权决策）、Phase 3（分实体记录范围层）及公共 REST API `/api/v1` 全入口 |
| 代码基线 | `23b1d64e`（18 commits ahead of origin）                                                                                         |
| 迁移基线 | 本地 0058 已应用；生产 57 迁移（0058 未应用）——本轮只读审查 0058，不执行                                                         |
| 排除项   | PD-02、PD-03（只确认未被本轮改动触碰）                                                                                           |

## 2. 审查方法与独立性说明

**独立审查代理已实际运行。** 本轮通过独立 `security-reviewer` 代理（独立会话、未参与本轮代码实施、未读取实施方结论作为输入）完成了对权限架构、绕行路径、三处修复、连接池测试与 0058 的独立审计，其原始结论为 **CONDITIONAL PASS** 并提出 2 项新发现（通配符死分支、PATCH 归属重转移上调为 Medium）。

审查人（实施方）对独立代理的每一项新发现做了**逐条独立复核**（源码定位 + 复现证据），复核结果全部成立，并补充了一项独立代理未区分的事实：PATCH 归属重转移在当前公共 API 的**可达面仅为 `documents`**（`corrective_actions` / `training_records` 为 list-only 视图，PATCH 一律 404），其余为潜在面。本报告的结论采纳独立代理的 CONDITIONAL PASS，并附复核证据。

独立性限制如实声明：最终报告由实施方汇编；独立代理的输出全文已保留在会话记录中，其判定未被修改。

## 3. Git 变更审查（18 commits）

### 3.1 按目的分组

| 组        | 提交                                                                                                                   | 目的                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Schema    | `51db8ea9`                                                                                                             | PD-01 P1：`api_keys` 增加 `principal_tenant_user_id`、`scopes` 列 + 迁移 0058 |
| 认证/授权 | `30a3f7f4`                                                                                                             | PD-01 P2：凭证绑定授权主体（`principal.ts` 纯决策 + `auth.ts` 解析）          |
| 记录范围  | `ed6b2c23` → `738c7b7e`                                                                                                | PD-01 P3 分实体实施：corrective_actions → documents/training_records          |
| 缺陷修复  | `faf1fefb`（B-1 Builder fail-closed）、`ea7801be`（视图实体列名 500）、`ffd526ec`（本轮 D-A/D-B/D-C）                  | 三个真实缺陷的最小修复，各含测试                                              |
| 重构      | `8fbb5752`                                                                                                             | `createdByCol` → `ownerTenantUserCol`（消除 Self 语义误读）                   |
| 文档/报告 | `ca68101d`、`4ee61c12`、`9b8f8b08`、`03cef82c`、`8fd90152`、`bf3b0f8d`、`5e7141d9`、`027f724d`、`d54a233e`、`23b1d64e` | 设计/验收/审查报告                                                            |

### 3.2 重点提交复核

- **`ffd526ec`（4 文件，+397/−22）**：`scope.ts` 三处守卫修复 + `viewColumn()` 标识符白名单；新增 2 个测试文件；`next-env.d.ts`。无权限键、无 scope 类型、无 RLS、无迁移变更。
- **`23b1d64e`（5 文件，+450/−86）**：纯文档（3 新报告 + 2 报告更正）。无代码。
- **未披露变更扫描（origin…HEAD）**：`packages/db/src/rls.ts` **零变更**；schema 仅 `api-keys.ts`（+25，两列 + 注释）；迁移仅 0058（3 条语句）+ snapshot/journal；`PERMISSION_CATALOGUE`、`TENANT_SCOPED_TABLES`、`permissions.ts` **零变更**。**结论：不存在未披露的权限、RLS、Schema 或数据库行为变更。**

### 3.3 `next-env.d.ts`

AGENTS.md 明确注明该文件由 `next dev` 自动再生成，"committing it with your work keeps the tree clean"。提交内容为 build 变体（`./.next/types/...`）。已知副作用：下次 `next dev` 会将其翻回 `.next/dev/types`，属工具链固有抖动，符合仓库约定。**合规。**

## 4. 权限架构审查（PD-01 设计一致性）

| 检查项                             | 结论                 | 证据                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Credential 主体绑定            | ✅                   | `auth.ts:75-104`：principal 行在**同一** bypass-RLS 事务内读取，谓词含 `tenant_id` 双重过滤（外租户 principal 行根本不会被加载）；`principal.ts:108-120` 逐项 fail-closed（missing / tenant_mismatch / inactive / exceeds_principal）→ 403（`auth.ts:184-188`）                    |
| Principal ∩ Credential permissions | ✅                   | `principal.ts:68-78` `narrowPermissions`：credential 权限必须被 principal 持有                                                                                                                                                                                                     |
| RoleScope 收窄关系                 | ✅                   | `packages/tenant/src/index.ts:366-376` `narrowRoleScopes`：非空请求集逐项 `roleScopeCovers`，未覆盖即 `exceeds_principal` fail-closed；**不静默丢弃**                                                                                                                              |
| tenant / sites / self 语义         | ✅                   | `scope.ts` 三分支互斥；tenant=不过滤、sites=`site_org_unit_id IN (…)`、self=owner/person 等于主体                                                                                                                                                                                  |
| 未绑定 Credential 兼容             | ✅                   | `principal.ts:95-106`：`principal_tenant_user_id IS NULL` → 权限即授权、scope=[{tenant}]，与 PD-01 前行为一致（HTTP 实证 tenant key 全部 200/201 未变）                                                                                                                            |
| scopes = NULL vs [] vs 具体值      | ✅                   | `narrowRoleScopes` 三值语义：`NULL`→继承 principal；`[]`→显式"无范围"（下游 `conds` 为空 → `sql\`false\`` → 0 行，fail-closed）；非空→必须被 principal 覆盖。三者不会混淆                                                                                                          |
| 未映射实体 fail-closed             | ✅                   | 读：`scope.ts:106-109` `sql\`false\``；写前：`:165` 404；创建：`:202-204` 403                                                                                                                                                                                                      |
| 创建/读取/修改/删除授权一致性      | ✅（含已知 R5 例外） | 读列表/详情/`COUNT(*)` 共用 `entityScopeWhere`（`query.ts:148,231,237-243,309`）；`patchEntity`/`deleteEntity` 先 `assertEntityInScope`（`write.ts:2569,2580`）；`createEntity` 先 `assertCreateInScope`（`:2556`）；documents 额外交集 `documentReadFilter`（`query.ts:149-155`） |

**绕行路径排查结论：** 未发现通过参数、字段修改、批量操作或其他 API 入口绕过 Scope 的路径。过滤值仅允许白名单列（`query.ts:73-95`）且与 scope 谓词独立 AND 合并；`/api/v1` 下**不存在**批量、导出、下载、统计、报表、异步路由（见 §5）。

## 5. API 全入口审查

`authenticateApiKey` 全仓调用点共 8 个文件（7 个 route + 定义），即 API Key 门控面的完整清单；无 kiosk/webhook 等其他 Key 门控面。

| 入口                                                  | 授权路径                                                                                                                                                 | 结论                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET/POST /api/v1/{entity}`                           | `readEntityRows` / `createEntity` → `entityScopeWhere` / `assertCreateInScope`                                                                           | ✅                                                                               |
| `GET/PATCH/DELETE /api/v1/{entity}/{id}`              | `getEntityRecord` / `patchEntity` / `deleteEntity` → 同一谓词 + 404 防探测                                                                               | ✅                                                                               |
| `GET /api/v1/apps`、`/api/v1`、`/api/v1/openapi.json` | `listBuilderApps`：`tenantId + published + id IN key.builderTemplateIds`；openapi 额外读自定义列定义（RLS 约束元数据）                                   | ⚠ R6：无 `assertScopedEntityAllowed`，暴露模板元数据（非 `form_responses` 记录） |
| Builder 5 responses handler                           | `assertScopedEntityAllowed` 在**任何数据查询之前**（`responses/route.ts:30,54`；`[id]/route.ts:36,66,102`）                                              | ✅                                                                               |
| 批量 / 导出 / 下载 / 统计 / 报表 / 异步               | `/api/v1` 下**不存在**；会话态导出走 `requireExportContext` + `assertCan('admin.data.export')`，不经 API Key                                             | ✅ 不适用                                                                        |
| 直接 DB 访问                                          | `auth.ts:46,159` `withSuperAdmin`（Key 查找与 last-used 遥测，认证引导期，谓词过滤租户）；`idempotency.ts`（基础设施表，RLS 约束，按 apiKeyId+tenantId） | ✅ 非 bypass                                                                     |
| 幂等重放                                              | `idempotency.ts:101-103`：命中缓存直接返回，不重跑 `[entity]` 路由的守卫（守卫在 `execute()` 内）；Builder 路由守卫在幂等包装**之外**，每次重跑          | ⚠ R7（低）                                                                       |
| SQL 注入                                              | 视图谓词列名经 `SAFE_IDENT` 白名单（`scope.ts` `viewColumn()`），值全部参数化；过滤器列白名单                                                            | ✅                                                                               |
| 密钥处理                                              | `auth.ts` 不记录 token；错误体仅 `code`+固定 `message`                                                                                                   | ✅                                                                               |

## 6. 连接池安全审查

`packages/db/src/connection-pool-isolation.test.ts` 独立核验为**真实测试**：

- 临时 `postgres:16-alpine` + 专用角色 `probe_app`（`LOGIN NOSUPERUSER NOBYPASSRLS`）→ `FORCE ROW LEVEL SECURITY` 真正生效，排除"超管绕过"假通过；
- 使用**项目真实** `withTenant`（`import { withTenant } from './rls'`）与真实 `postgres` 池（`max:1`）；
- `pg_backend_pid()` 断言集合大小 = 1，证明**物理连接复用**而非"同池对象"；
- 覆盖：提交隔离、强制回滚 + GUC 残留（`current_setting(..., true)` 事务外为 `''`）、中途异常释放、跨租户 `WITH CHECK` 拒绝、无/空上下文拒绝。

**独立代理提出的测试质量限制（复核成立，采纳）：**

- **I1** 测试 5 的 `Promise.all` 在 `max:1` 池下被 postgres-js **串行化**——它证明的是"顺序复用同一物理连接且上下文不交叉"，而非真正的事务交错；pid 断言因此平凡通过。这不削弱隔离结论（隔离由事务级 `set_config` + FORCE RLS 保证），但报告不应宣称覆盖了"并发交错"。
- 测试 8 为源码文本断言（非行为测试），仅作辅助。
- 无 Docker 时测试**失败**而非跳过（与其他真 PG 测试一致）。

## 7. D-A / D-B / D-C 修复复核

| 修复                         | 独立复核结论  | 证据                                                                                                                                                                                | 是否存在未覆盖的相似路径                                                                                                                  |
| ---------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **D-A** 视图实体 person 谓词 | ✅ 正确且完整 | `scope.ts` `viewCols.personColName:'person_id'` 与 `report_training_records` 及物理表一致；`entityScopeWhere` 实现 person 分支；HTTP：self key `GET /training_records` 由 500 → 200 | 无。`API_ENTITY_SCOPE` 仅 3 项；`documents` 的列表实体是物理表 `documents`（无别名问题）；其余视图实体未映射 → `sql\`false\``，不生成 SQL |
| **D-B** 写/读谓词一致        | ✅ 正确       | `assertEntityInScope`（`scope.ts:159`）改调 `entityScopeWhere`；HTTP：sites key PATCH/DELETE 自己的 documents 200 → 404                                                             | 无。全仓仅 `write.ts:2569,2580` 两个调用点，均走该函数                                                                                    |
| **D-C** CREATE 归属校验      | ✅ 正确       | `assertCreateInScope`：sites+无 site 列 → 403；self → owner == `membership.id`、person == `personId`；HTTP + 纯逻辑 8/8                                                             | **存在一处同类缺口：PATCH 归属重转移（见 §10 M1）**。CREATE 侧已闭合，PATCH 侧授权针对变更前行，归属列可被改写为 scope 外值               |

**修复是否只覆盖已测试路径：** 三处修复本身覆盖全部可达路径；同类缺口仅剩 PATCH 归属重转移（M1），且其当前可达面为 `documents` 的 `ownerTenantUserId`（`updateDocument`，`write.ts:1366`）。独立代理引用的 `updateCorrectiveAction`（`:728,:731`）与 `updateTrainingRecord`（`:2279`）属**潜在面**——这两个实体为 list-only 视图，`[id]` 路由 `isRecordable` 判定后一律 404，当前不可达；若未来为其开放记录端点，该缺口即变为可达。

## 8. R1–R8 风险复核

| 项                                                  | 真实存在                                   | 影响现有授权安全                                                           | 属产品能力限制                                                               | 阻断当前发布                                           | 需后续 Schema/产品决策                     | 非阻断证据                                                                               |
| --------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **R1** 4/7 实体未实施（fail-closed 0 行）           | 是（`scope.ts` 仅映射 3）                  | 否（拒绝方向）                                                             | 是（inspections/incidents/ppe 字段语义待确认、equipment 需扩展，均产品冻结） | 否                                                     | 是（Schema 扩展 / 字段确认）               | fail-closed 拒绝方向；HTTP 实证 scoped key 对未映射实体 404/403                          |
| **R2** 两视图 list-only                             | 是                                         | 否                                                                         | 是（任务书禁止为测试新增 API）                                               | 否                                                     | 否（如需 PATCH/DELETE 需产品定义记录端点） | `isRecordable` 判定；404 不泄露存在性                                                    |
| **R3** site scope 无法读 documents/training_records | 是（无 site 列）                           | 否（fail-closed）                                                          | 是                                                                           | 否                                                     | 是（是否补 site 归属列）                   | HTTP 空集 + 404；实现报告 §2 语义表                                                      |
| **R4** self key 不能创建 corrective_actions         | 是（无 site scope 可携带）                 | 否（fail-closed）                                                          | 是                                                                           | 否                                                     | 是（是否允许 self + 显式 site 组合）       | HTTP 403；纯逻辑用例 8                                                                   |
| **R5** PATCH 归属重转移移出 scope                   | **是**（独立代理上调为 **Medium**，见 M1） | **是（scope 完整性）**，但非跨租户、有审计、转移后 key 反而失去访问权      | 部分（是否允许 scoped key 转移归属属业务规则）                               | 否，但**必须作为已知限制随行**或以 post-patch 复查闭合 | 是                                         | HTTP `doc_self_move_owner` 200 + 之后 self 读取 404（无越权获得）；租户谓词 + RLS 仍生效 |
| **R6** Builder 元数据路由无 scoped 守卫             | 是                                         | 否（仅模板元数据，受 `builderTemplateIds`+租户+published 约束）            | 是                                                                           | 否                                                     | 是（是否收紧）                             | `listBuilderApps` 谓词（`builder-apps.ts:388-404`）                                      |
| **R7** 幂等重放不重跑守卫                           | 是                                         | 极低（重放的是调用方自己此前的响应，绑定同一 apiKeyId；digest 不符即 409） | 否（实现取舍）                                                               | 否                                                     | 否（可后续把守卫移出 `execute()`）         | `idempotency.ts:88-90,101-103`                                                           |
| **R8** 上一轮审查独立性流程限制                     | 是（已被本轮独立代理运行替代）             | n/a                                                                        | n/a                                                                          | 否                                                     | 否                                         | 本轮 §2                                                                                  |

## 9. 0058 迁移兼容性审查（只读）

`packages/db/drizzle/0058_api_key_principal_scope.sql`，共 3 条语句：

1. `ALTER TABLE "api_keys" ADD COLUMN "principal_tenant_user_id" uuid;` — 可空
2. `ALTER TABLE "api_keys" ADD COLUMN "scopes" jsonb;` — 可空
3. `CREATE INDEX "api_keys_principal_idx" ON "api_keys" USING btree ("tenant_id","principal_tenant_user_id");`

| 检查项               | 结论                                                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 字段与当前代码一致   | ✅ `api-keys.ts` `principalTenantUserId: uuid(...)`、`scopes: jsonb().$type<RoleScope[]>()`；snapshot/journal（`_journal.json:408` tag `0058_api_key_principal_scope`）与 SQL 一致                                                                                                                      |
| NULL 兼容            | ✅ 两列均可空。存量 Key：`principal_tenant_user_id IS NULL` → legacy 路径（`principal.ts:95-106`，权限即授权 + [{tenant}]，行为不变）；已绑定 Key 的 `scopes NULL` → 逐字继承 principal（`index.ts:370`）                                                                                               |
| 外键/索引合理性      | ✅ 复合 btree `(tenant_id, principal_tenant_user_id)` 支撑 principal 解析查询。**无 FK 为有意设计**（schema 注释说明：复合键无法 `ON DELETE SET NULL`——`tenant_id` NOT NULL；CASCADE 会在成员移除时静默删凭证）。悬空 principal → `principal_missing` → 403 fail-closed（`principal.ts:108-109`），安全 |
| 数据迁移/约束风险    | ✅ 纯加列 + 建索引，无数据回填、无约束收紧、无表重写；对存量行 `NOT VALID` 类风险不适用                                                                                                                                                                                                                 |
| 是否影响现有 API Key | ✅ 不影响：全部存量 Key 走 legacy 路径，行为字节级不变（HTTP 实证 tenant key 兼容）                                                                                                                                                                                                                     |
| 是否可能改变生产行为 | ✅ 否。无 RLS 变更（`rls.ts` 零差异）；`api_keys` 已在 `TENANT_SCOPED_TABLES`。唯一前提：应用代码与迁移需同版本发布——若新代码先于迁移上线，`select` 未存在列会报错，属标准发布顺序约束                                                                                                                  |

## 10. 问题清单及严重程度

| ID     | 严重度     | 问题                                                                                                                                                                                                                                                                                                               | 位置                                                        | 状态                                                       |
| ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------- |
| **M1** | **Medium** | PATCH 归属重转移可将记录移出调用方 scope（create 侧已闭合，patch 侧无 post-mutation 复查）。**当前可达面 = `documents.ownerTenantUserId`**；`corrective_actions`/`training_records` 的同类写点不可达（list-only）。复现：self key `PATCH /documents/{own}` 设 `ownerTenantUserId` 为他人 → 200，随后 self 读取 404 | `write.ts:2569`、`:1366`（可达）；`:728,:731,:2279`（潜在） | 已知（R5），严重度上调；须闭合或作为产品接受的已知限制随行 |
| **L1** | Low        | `narrowPermissions` 通配符分支为死代码（else 臂内 `principal.has(permission)` 必为 false）；且 `PERMISSION_CATALOGUE` 无通配符键，`sanitizeApiPermissions`（**本轮未改动**的既有行为）会剥离存量 `x.*`，与 `principal.ts:8-10` "byte-for-byte legacy" 注释矛盾                                                     | `principal.ts:73-77`、`permissions.ts:20-26`                | 新发现；非越权（fail-closed），属死代码 + 注释准确性问题   |
| **L2** | Low        | Builder 元数据路由（`/api/v1`、`/apps`、`/openapi.json`）无 `assertScopedEntityAllowed`，scoped key 可读租户内模板元数据                                                                                                                                                                                           | `apps/route.ts`、`route.ts`、`openapi.json/route.ts`        | 已知（R6）                                                 |
| **L3** | Low        | 幂等重放不重跑 `[entity]` 路由的 scope/权限守卫                                                                                                                                                                                                                                                                    | `idempotency.ts:101-103`                                    | 已知（R7）                                                 |
| **I1** | Info       | 连接池测试 5 的"并发"被 `max:1` 池串行化；测试 8 为源码文本断言                                                                                                                                                                                                                                                    | `connection-pool-isolation.test.ts`                         | 新发现（测试质量）；不削弱隔离结论                         |
| **I2** | Info       | 0058 无 FK on `principal_tenant_user_id`（有意设计，悬空 fail-closed）                                                                                                                                                                                                                                             | `0058_...sql:1`                                             | 设计决定，可接受                                           |

## 11. 最终审查结论：**CONDITIONAL PASS**

**依据：**

- 权限架构与产品冻结语义一致：单一权限目录、单一 scope 词表、RLS 支撑的租户上下文、无平行系统；Principal ∩ Credential、RoleScope 只收窄、三值 scopes 语义、未绑定凭证兼容、未映射 fail-closed 全部成立（§4）。
- 读/写/count 使用同一谓词；`/api/v1` 全入口经 `authenticateApiKey`，无批量/导出/下载/统计/异步入口，无直接 DB 绕行（§5）。
- D-A/D-B/D-C 三处修复实现正确、覆盖其路径（§7）；连接池测试为真实 PG + 真实 `withTenant` + FORCE RLS，隔离结论成立（§6）。
- 0058 为纯加列迁移，NULL 兼容，对存量 Key 行为不变，无 RLS 变更（§9）。
- 未发现跨租户访问、越权读取或权限提升路径。

**条件（进入发布候选审查前须满足其一）：**

1. **M1**：为 `patchEntity` 增加 post-mutation scope 复查（将记录改写为 scope 外值视为 404/403），**或**由产品明确接受"scoped key 可转移归属"并写入发布说明与手册；
2. **L1**：修正 `principal.ts` 的死通配符分支与"byte-for-byte legacy"注释（或在目录中显式支持通配符），消除行为与文档的偏差；
3. R2/R3/R6/R7 作为已知限制随行发布说明；R1/R3/R4 所需的字段确认与 Schema 决策排入后续迭代。

**未发现阻断发布的问题；PASS 未被授予的原因是 M1（Medium，scope 完整性缺口）与 L1 尚未闭合，且 R1/R3 属产品能力缺口需决策。**

---

_审查证据：独立代理原始审计（含全部 file:line 引用）保留于会话记录；本报告所有关键论断均经实施方逐条独立复核，复核命令与 HTTP 复现见 `BEACONHS_PD01_WRITE_HTTP_E2E_REPORT.md` 与 `BEACONHS_PD01_CONNECTION_POOL_ISOLATION_REPORT.md`。审查过程零写入（除本报告）。_
