# PD-01 Phase 3 专项 B — 已映射实体写操作 HTTP 端到端报告

**测试性质：真实 Web 服务（`localhost:3000`）+ 真实 PostgreSQL + 项目真实 API Key 认证链路。**
**环境：本地隔离 `pnpm dev` + `beaconhs-postgres/redis/minio/mailpit`，未连接生产。**

## 1. 实体与端点能力核实（任务书 §4.1）

先核实实际存在的路由与写入能力，未新增任何业务 API：

| 实体                 | 列表 GET | 详情 GET | POST | PATCH | DELETE | 说明                                                                     |
| -------------------- | -------- | -------- | ---- | ----- | ------ | ------------------------------------------------------------------------ |
| `corrective_actions` | ✅       | ❌       | ✅   | ❌    | ❌     | 列表/详情查询视图 `report_corrective_actions`，**list-only**，无记录端点 |
| `documents`          | ✅       | ✅       | ✅   | ✅    | ✅     | 物理表，全 CRUD                                                          |
| `training_records`   | ✅       | ❌       | ✅   | ❌    | ❌     | 列表/详情查询视图 `report_training_records`，**list-only**，无记录端点   |

**业务限制（如实记录，未人为新增接口）：** `corrective_actions` 与 `training_records` 的 PATCH/DELETE 一律返回 `404 No record endpoint for "…"` —— 这是视图无稳定 `id` PK 的设计结果，任务书明确禁止为测试新增业务 API。因此 §4.4/§4.5 的完整 CRUD 越权验证只能在 `documents` 上执行。

## 2. 测试环境

| 项                   | 值                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 租户（主）           | `demo` = `8b62c4c2-8ac9-40f5-8918-224036c4fbfd`                                                                                                    |
| 租户（跨租户）       | `phase-bs-isolated` = `aca29e48-fa59-400b-823e-a51764c1f8ea`                                                                                       |
| Site A（授权）       | `550e8400-e29b-41d4-a716-446655440000`                                                                                                             |
| Site B（未授权）     | `660e8400-e29b-41d4-a716-446655440001`                                                                                                             |
| 主体 P1（sites key） | tenant_user `aaaaaaaa-0000-4000-8000-0000000000a1`                                                                                                 |
| 主体 P2（self key）  | tenant_user `bbbbbbbb-0000-4000-8000-0000000000b2`                                                                                                 |
| 其他主体             | tenant_user `d53a595f-0d10-4fb4-992a-8c0f009ed50f`                                                                                                 |
| 角色                 | `tenant_admin`（两主体均绑定，role_assignments 作用域 tenant）                                                                                     |
| Key                  | `tenant`（无 principal，`[{tenant}]`）、`sites`（P1，`[{sites,[A]}]`）、`self`（P2，`[{self}]`）、`self_ro`（P2，`[{self}]`，仅 `documents.read`） |

**测试数据构造方式：** 本地 DB 直写（`/tmp/opencode/pd01-testdata.sql`，显式固定 UUID，可重复执行）；`people` 行绑定 P1/P2 的 `user_id`，使 `ctx.personId` 可解析。

**写请求均带唯一 `Idempotency-Key`**（服务端强制，缺失返回 400）。

## 3. 认证与速率限制（回归）

| 场景                        | 结果                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| 无 Authorization            | `401 {"code":"unauthorized","message":"Missing or invalid API key"}`       |
| 无效 key                    | `401` 同上                                                                 |
| 速率限制头                  | `ratelimit-limit: 600` / `ratelimit-remaining: 597` / `ratelimit-reset: …` |
| Builder 5 入口 × sites/self | 全部 `403`，固定文案，无 SQL 泄漏                                          |
| Builder tenant key          | `404 Builder app not found`（未走到数据路径，行为兼容）                    |

## 4. CREATE 矩阵（16 例）

### 4.1 corrective_actions

| 用例                          | 结果    | 期望                                        | 判定    |
| ----------------------------- | ------- | ------------------------------------------- | ------- |
| Tenant Key 合法创建           | **201** | 201                                         | ✅      |
| Site Key 授权 Site（A）       | **201** | 201                                         | ✅      |
| Site Key 未授权 Site（B）     | **403** | 403                                         | ✅      |
| Self Key 责任主体合法（P2）   | **403** | 拒绝（self 不携带 site scope，fail-closed） | ⚠ 见 §8 |
| Self Key 为他人创建（OTHER）  | **403** | 403                                         | ✅      |
| 必填归属字段为空（tenant）    | **201** | 允许（owner 非必填）                        | ✅      |
| 归属字段指向他租户（假 site） | **400** | 400                                         | ✅      |

### 4.2 documents

| 用例                         | 结果    | 期望        | 判定         |
| ---------------------------- | ------- | ----------- | ------------ |
| Tenant Key 合法创建          | **201** | 201         | ✅           |
| Site Key 创建（无 site 列）  | **403** | fail-closed | ✅（修复后） |
| Self Key 责任主体合法（P2）  | **201** | 201         | ✅           |
| Self Key 为他人创建（OTHER） | **403** | 403         | ✅（修复后） |
| 必填归属字段为空（tenant）   | **201** | 允许        | ✅           |

### 4.3 training_records

| 用例                                | 结果    | 期望        | 判定         |
| ----------------------------------- | ------- | ----------- | ------------ |
| Tenant Key 合法创建                 | **201** | 201         | ✅           |
| Site Key 创建（无 site 列）         | **403** | fail-closed | ✅（修复后） |
| Self Key 受训人合法（P2 的 person） | **201** | 201         | ✅           |
| Self Key 为他人创建                 | **403** | 403         | ✅（修复后） |

## 5. PATCH 矩阵（documents，10 例）

| 用例                                         | 结果    | 期望           | 判定                    |
| -------------------------------------------- | ------- | -------------- | ----------------------- |
| Tenant Key 修改租户内合法记录                | **200** | 200            | ✅                      |
| Site Key 修改"自己拥有"的文档                | **404** | 404            | ✅（修复前 200 → 缺陷） |
| Site Key 修改他人文档                        | **404** | 404            | ✅                      |
| Site Key 传 `siteOrgUnitId` 参数尝试绕过     | **404** | 404            | ✅                      |
| Self Key 修改自己的文档                      | **200** | 200            | ✅                      |
| Self Key 修改他人文档                        | **404** | 404            | ✅                      |
| Self Key 传 `ownerTenantUserId` 参数尝试绕过 | **404** | 404            | ✅                      |
| 跨租户记录 ID                                | **404** | 404            | ✅                      |
| 无归属文档（owner NULL）                     | **404** | 404            | ✅                      |
| 修改归属字段转移给他人                       | **200** | 见 §8 设计考虑 | ⚠                       |

## 6. DELETE 矩阵（documents，5 例）

| 用例                          | 结果    | 期望 | 判定                    |
| ----------------------------- | ------- | ---- | ----------------------- |
| Tenant Key 合法删除           | **200** | 200  | ✅                      |
| Site Key 删除"自己拥有"的文档 | **404** | 404  | ✅（修复前 200 → 缺陷） |
| Self Key 删除自己的文档       | **200** | 200  | ✅                      |
| Self Key 删除他人文档         | **404** | 404  | ✅                      |
| 跨租户记录 ID                 | **404** | 404  | ✅                      |

## 7. 跨租户与读侧一致性

| 用例                                       | 结果                                        |
| ------------------------------------------ | ------------------------------------------- |
| 跨租户 `documents` ID（PATCH/DELETE）      | **404**                                     |
| 跨租户 `training_records` ID               | **404**（无记录端点）                       |
| 读侧：sites key `GET /documents`           | **200 空集**（fail-closed）                 |
| 读侧：sites key `GET /documents/{id}`      | **404**                                     |
| 读侧：self key `GET /training_records`     | **200 且可见本人记录**（修复前 500 → 缺陷） |
| 读侧：sites key `GET /training_records`    | **200 空集**（fail-closed）                 |
| 读侧：tenant key `GET /corrective_actions` | **200 有数据**                              |

## 8. 数据库副作用核验

| 实体                 | 起始 | 创建后 | 结束时 | 合法写入                               | 拒绝写入     |
| -------------------- | ---- | ------ | ------ | -------------------------------------- | ------------ |
| `corrective_actions` | 13   | 16     | 16     | +3（tenant/sites-allowed/empty-owner） | 4 例 403 → 0 |
| `documents`          | 10   | 13     | 11     | +3 创建、-2 合法删除                   | 2 例 403 → 0 |
| `training_records`   | 20   | 22     | 22     | +2（tenant/self-own）                  | 2 例 403 → 0 |

**所有被拒绝的操作均未产生数据库副作用。**

## 9. 发现的缺陷与修复

| ID  | 缺陷                                                                                                                                   | 根因                                                                                                                                                                                           | 修复                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| D-A | `self` key `GET /training_records` 返回 **500**                                                                                        | `training_records` 列表实体是视图 `report_training_records`，`scope.ts` 却用物理表 `trainingRecords` 的 Drizzle 列生成 `"training_records"."person_id"`，视图 FROM 无该别名 → PG 报错          | 为 `training_records` 注册 `viewCols.personColName='person_id'`，并在 `entityScopeWhere` 实现 person 列分支                 |
| D-B | `sites` key 可 PATCH/DELETE 其"自己拥有"的 `documents`（200），而 `GET` 对同一实体 fail-closed（404）                                  | `assertEntityInScope` 直接调用 `recordVisibilityWhere`，绕过了 `entityScopeWhere` 的 fail-closed 规则（`sites` + 无 site 列 → `sql\`false\``）；`recordVisibilityWhere` 总是追加"自己的记录"腿 | `assertEntityInScope` 改用 `entityScopeWhere`，与读路径使用同一谓词                                                         |
| D-C | scoped key 可在自身 scope 之外**创建**记录（self key 为他人创建 documents/training_records → 201；sites key 创建无 site 列实体 → 201） | `assertCreateInScope` 只校验 `bodySiteKey`，不校验 owner/person，也不对"无 site 列实体 + sites scope"fail-closed                                                                               | `assertCreateInScope` 增加：sites scope + 无 site 列 → 403；self scope → owner 必须等于主体、person 必须等于 `ctx.personId` |

三个修复均为 **fail-closed 收紧**，未新增 API、未改 Schema、未改 RLS、未改权限键、未新增 scope 类型。

**附加加固（§5.6）：** 新增 `viewColumn()` + `SAFE_IDENT` 正则校验视图列名，列名仅来自代码内固定常量。

## 10. 错误体安全

对 50 条请求输出做关键字扫描（`select / insert / update / delete from / report_* / tenant_id / owner_tenant_user_id / where`）：**0 命中**。所有错误体仅含 `{"error":{"code","message"}}` 固定文案；不存在性探测统一返回 404（"outside its site scope"/"for another owner" 仅用于 CREATE，均为 403）。

## 11. documents 三交集验证（§5.5）

| Key       | 权限                  | scope  | 可见 `pd01-self-*`                                             |
| --------- | --------------------- | ------ | -------------------------------------------------------------- |
| `self_ro` | 仅 `documents.read`   | self   | 仅 `pd01-self-published`（draft 被 `documentReadFilter` 隐藏） |
| `self`    | 含 `documents.manage` | self   | `pd01-self-doc`、`pd01-self-draft`、`pd01-self-published`      |
| `tenant`  | 含 `documents.manage` | tenant | 全部（含他人 owner）                                           |

**结论：** `documentReadFilter`（阶梯）× `entityScopeWhere`（RoleScope）× RLS（TenantIsolation）三者均生效，任一拒绝不被其他层放宽；`manage` 只放宽阶梯，不放宽 scope。

## 12. 测试分层统计（本专项）

| 层                  | 内容                                                    | 数量        | 退出码       |
| ------------------- | ------------------------------------------------------- | ----------- | ------------ |
| **HTTP 集成**       | 写矩阵 50 请求 + 读回 6 请求 + 认证/Builder/速率 9 请求 | **65 请求** | 全部符合期望 |
| **真实 PostgreSQL** | `scope-pg.test.ts` 谓词测试                             | **10/10**   | 0            |
| **纯逻辑**          | `scope-create-logic.test.ts`（无 DB/无 HTTP）           | **8/8**     | 0            |
| **连接池隔离**      | 见专项 A 报告                                           | 7/7         | 0            |
| **Mock**            | 本专项无 Mock                                           | —           | —            |

**命令：** `bash /tmp/opencode/pd01-write-e2e.sh`（写矩阵，50 请求）；其余见各节。

## 13. 未通过项目与剩余风险

| #   | 项                                                                                      | 说明                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `corrective_actions` / `training_records` 无 PATCH/DELETE 端点                          | 视图 list-only，设计如此；未新增 API（任务书禁止）                                                                                                            |
| 2   | self key 无法创建 `corrective_actions`                                                  | `assertCreateInScope` 对带 `bodySiteKey` 的实体要求 site scope，self 不携带 → fail-closed。安全但为功能缺口                                                   |
| 3   | 修改归属字段转移记录                                                                    | `doc_self_move_owner` 返回 200。守卫对**变更前**行授权，未获得任何越权访问（转移后该 key 反而失去访问权）。是否允许 scoped key 转移归属属业务规则，需产品决策 |
| 4   | site scope 无法读取 `documents` / `training_records`                                    | 无 site 列，fail-closed；需 Schema 设计决策                                                                                                                   |
| 5   | `incidents` / `inspections` / `ppe_items` 未注册 Self                                   | 字段语义待产品确认，本轮不启用                                                                                                                                |
| 6   | Builder 元数据路由（`/api/v1`、`/apps`、`/openapi.json`）无 `assertScopedEntityAllowed` | 返回模板元数据而非 `form_responses` 记录；不在 §5.4 的五入口范围内，记录为剩余项                                                                              |
| 7   | 幂等重放不重跑 scope 守卫                                                               | `idempotency.ts` 命中缓存直接返回；key 与 apiKeyId 绑定，风险低，记录为剩余项                                                                                 |
