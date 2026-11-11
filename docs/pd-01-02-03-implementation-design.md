# PD-01 / PD-02 / PD-03 实施设计与分期

**决策来源：** 产品负责人 2026-11-10 选定 PD-01=B、PD-02=B、PD-03=B。
**统一约束：** 保留原生 Permission / RoleScope / RLS；优先扩展现有机制；不得以临时补丁代替正式能力；未经批准不改生产库/权限/数据；所有变更须有自动化测试、回归证据与可审计记录；未完成实施与验收的议题不得标记为完成。

**状态：** 设计已定稿。**PD-01 阶段一已实施（本地，未应用生产）；PD-01 阶段二/三、PD-02、PD-03 未实施。**

---

## PD-01 — 通用 API 的 site/self 二次可见性（完整统一权限模型）

### 现状

- `RequestContext` 已携带 `scopes: RoleScope[]`，UI 通过 `recordVisibilityWhere(ctx, tx, cols)` 把 scope 解析成谓词。
- `api_keys` 内嵌 `permissions: PermissionKey[]` 与 `builderTemplateIds`，**没有 scope**；API 请求因此是"租户内全量"。
- 结论：缺口不是"没有 scope 机制"，而是**凭据没有绑定到授权主体**，无法复用既有 scope。

### 目标模型

```
api_keys ──(principal_tenant_user_id)──> tenant_users ──> role_assignments ──> roles
                                                     └──> people (personId, 供 self/people scope)
```

- 凭据只保存**主体引用**（`principalTenantUserId`）与**显式收窄的 scope**（`scopes`，可空表示完全继承主体）。
- 有效权限 = 主体角色权限 ∩ 凭据 `permissions`（保留现有字段作为**收窄**，而非授权来源）。
- 有效 scope = 凭据 `scopes`（若设置，只能比主体更窄）否则主体 scope。
- `personId` 从主体派生，`self` scope 对 API 才真正可用。

### 分期

| 阶段               | 内容                                                                                                                    | 风险              | 验收                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------- |
| **P1-1（已实施）** | `api_keys` 增 `principal_tenant_user_id`(nullable FK) 与 `scopes`(jsonb, nullable)；迁移 `0058`；默认 NULL 保持现有行为 | 低（纯 additive） | 迁移幂等、快照/日志一致、现有 API 测试全绿                 |
| **P1-2**           | `authenticateApiKey` 解析主体 → 填充 `ctx.scopes` / `ctx.personId`；未绑定主体的 key 维持租户级（显式告警）             | 中                | 授权链路单测：绑定/未绑定、收窄/继承、失效主体 fail-closed |
| **P1-3**           | API 读写路径接入 `recordVisibilityWhere`；越界返回 404（不泄露存在性）                                                  | 中高              | 每类实体的跨 site/self 负例；写路径越界拒绝且无部分写入    |
| **P1-4**           | 将 `permissions` jsonb 降级为"收窄"语义并在 UI 明示；提供主体绑定向导                                                   | 中                | 权限矩阵回归；无平行权限判断                               |
| **P1-5**           | 废弃路径清理（若有）                                                                                                    | 低                | deadcode 门禁                                              |

### 迁移策略（现有 key）

1. 全部现有 key 的 `principal_tenant_user_id` 为 NULL → 行为不变（租户级）。
2. 提供 `api_keys` 管理页的"绑定主体"操作；绑定后 scope 生效。
3. 不强制迁移：未绑定的 key 继续可用，但在 UI 标注"租户级（未绑定主体）"，作为**已知边界**而非完成态。

### 验收标准（P1 整体）

- 租户 A 的 key 无法读到/写到租户 B（已有）。
- 绑定 site scope 的 key 只能读写该 site 的记录；越界返回 404 且无部分写入。
- 绑定 self scope 的 key 只能访问主体本人的记录。
- UI 与 API 对同一主体、同一记录给出一致可见性（同一 `recordVisibilityWhere`）。
- 未新增平行权限系统；`PERMISSION_CATALOGUE` 不新增 API 专属键。

### 回滚

- P1-1：列可空，回滚只需不读取；`0058` 可逆（drop column）。
- P1-2/3：行为由 `principal_tenant_user_id IS NOT NULL` 开关，置空即回到租户级。

---

## PD-02 — 审计历史回溯（独立审计授权体系）

### 现状

- `audit_log`：FORCE RLS `tenant_isolation` + `audit_log_immutable_trigger`（app/super UPDATE/DELETE 拒绝）；`audit_log_tenant_id_tenants_id_fk` 为 RESTRICT。
- 无任何审计读取权限键；读取受 RLS 限制在单一租户。

### 目标模型

新增**独立授权**（不进普通角色继承，需显式授予）：

| 权限键                | 范围   | 能力                                                    |
| --------------------- | ------ | ------------------------------------------------------- |
| `audit.read.tenant`   | 租户级 | 读取本租户全部审计（跨 site/self 可见范围，但不出租户） |
| `audit.read.platform` | 平台级 | 跨租户只读追溯（仅 `isSuperAdmin` 可授予）              |

**RLS 例外实现（推荐，最小暴露面）**

- 不修改 `audit_log` 的 RLS 策略本身。
- 新增 `SECURITY DEFINER` 只读函数 `audit_log_read(tenant_filter uuid, from ts, to ts, …)`：
  - 函数内校验 `has_permission('audit.read.tenant'|'audit.read.platform')`；
  - `tenant_filter` 为空时要求 `audit.read.platform`；
  - 只返回只读行，不提供任何写路径。
- 应用层通过该函数读取，普通查询路径保持 RLS 不变（fail-closed）。

**审计访问自身留痕**

- 每次调用写一条 `audit_log`（`entity_type='audit_access'`, `action='read'`, `metadata={filter, rowCount}`）。
- 该写入走既有 append-only 机制，不可篡改。

### 分期

| 阶段     | 内容                                                                                                    | 风险 | 验收                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------- |
| **P2-1** | 新增两个权限键 + 角色授予入口（仅 tenant_admin 可授 `audit.read.tenant`；`audit.read.platform` 仅超管） | 中   | 权限矩阵回归；默认角色不获得                                            |
| **P2-2** | `audit_log_read` SECURITY DEFINER 函数 + 迁移；函数级权限校验                                           | 高   | 真 PG：无权限拒绝、租户级不出租户、平台级可跨租户、普通 SELECT 仍受 RLS |
| **P2-3** | 审计访问 UI（筛选/导出）+ 自身留痕                                                                      | 中   | 每次访问产生一条 `audit_access` 记录                                    |
| **P2-4** | 安全评审（RLS 例外、函数注入、导出脱敏）                                                                | —    | 独立评审通过才可上线                                                    |

### 风险

- SECURITY DEFINER 函数是**唯一**越过 RLS 的路径，必须固定 `search_path`、参数化查询、禁止动态 SQL。
- 不得把该函数暴露给通用 API 写面或匿名路径。

### 回滚

- 删除权限键授予 + `REVOKE EXECUTE` 函数即可回到现状；不改 `audit_log` 策略。

---

## PD-03 — A3 目标在库回填（历史数据治理）

> **状态裁决（2026-11-11）：PD-03 = N/A，不实施。**
> P3-1 判定 FAIL-CLOSED：目标在库在全部已记载主机名 × 全端口 × 常见库名的
> 19,660,500 组合中零指纹命中；A3 从未执行；dev 库五个 rewrite surface 持久化
> 附件引用为 0；生产为 clean-cutover 全新镜像、无 legacy 数据；且 capability
> secret 指纹在历史卡片与代码常量间存在冲突。用户已采纳 N/A。证据与结论见
> `BEACONHS_PD03_P3_1_AUDIT_JUDGMENT.md` 与
> `BEACONHS_PD03_AUTHORIZATION_BOUNDARY.md`（均 2026-11-11）。
> **以下分期、硬性前置、回滚与"本轮实际交付"表为 2026-11-09 设计基线快照，
> 不再作为待执行计划**；全程未连接任何数据库、未改任何数据。

### 现状（设计基线快照）

- 代码侧已具备附件删除一致性（同事务 + 锁 + outbox + worker 幂等，已真 PG 端到端验证）。
- `BEACONHS_CUTOVER_TARGET=beaconhs-dev` 目标在库**未定位**（`TEST_HOST_A3_FORENSIC_AUDIT.md`）。
- A3 Apply **从未执行**。

### 分期

| 阶段          | 内容                                                                             | 前置            | 验收                           |
| ------------- | -------------------------------------------------------------------------------- | --------------- | ------------------------------ |
| **P3-1 定位** | 用指纹（pool/direct/secret/storage SHA）在候选主机定位目标库；产出《目标确认单》 | 无              | 指纹匹配、连接串来源可审计     |
| **P3-2 备份** | 目标库 `pg_dump -Fc` + 对象存储快照，均带 sha256 与恢复演练                      | P3-1            | 恢复演练 0 错误                |
| **P3-3 清单** | 只读 SQL 产出异常清单（孤儿附件、引用缺失、删除标记不一致），逐类计数与样本      | P3-2            | 清单可复核、可导出             |
| **P3-4 回填** | 事务化 + 幂等 + 可回滚；逐批提交；每批校验                                       | P3-3 + 明确批准 | 回填后清单归零或仅剩已批准例外 |
| **P3-5 验证** | 一致性校验（引用计数、outbox、对象存在性）+ 抽样人工核对                         | P3-4            | 校验通过、可审计记录完整       |

### 硬性前置（缺一不可）

1. 目标在库已确认（当前未满足）
2. DB + 对象存储备份完成且恢复演练通过
3. 异常清单已复核
4. 事务/回滚方案已批准
5. 停机窗口与负责人已定

### 回滚

- 每批回填写入 `backfill_run_id`，失败按 run 逆向删除；备份为最终兜底。

---

## 依赖与顺序

```
PD-01 P1-1 → P1-2 → P1-3 → P1-4        （独立，可先做）
PD-02 P2-1 → P2-2 → P2-3 → P2-4 安全评审（与 PD-01 无依赖）
PD-03 P3-1 → P3-2 → P3-3 → P3-4 → P3-5  （依赖目标库定位与批准）
```

建议顺序：**PD-01 全量 → PD-02（含安全评审）→ PD-03**。PD-03 在 P3-1 完成前不得开始 P3-2 之后步骤。

---

## 本轮实际交付

| 项                                                                                            | 状态                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 本设计文档                                                                                    | ✅                                         |
| PD-01 P1-1：`api_keys` 增 `principal_tenant_user_id` + `scopes`，迁移 `0058`，快照/日志，测试 | ✅ 本地实施，**未应用生产**                |
| PD-01 P1-2..P1-4                                                                              | ❌ 未实施                                  |
| PD-02 P2-1..P2-4                                                                              | ❌ 未实施（含高风险 RLS 例外，需安全评审） |
| PD-03 P3-1..P3-5                                                                              | ❌ 未实施（目标库未定位，生产数据未动）    |

**不声称任何一项已完成**：P1-1 只是可回滚的数据结构前置，PD-01 整体仍需 P1-2..P1-4 与验收。
