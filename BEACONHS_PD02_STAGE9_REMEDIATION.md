# PD-02 阶段 9 — 独立审查发现整改（F1–F8）

**触发：** 独立安全审查（`BEACONHS_PD02_INDEPENDENT_SECURITY_AUDIT.md`）判定 **FAIL**，
F1 Critical / F2 High 为阻断项。本报告记录每项发现的处置与验证证据。
**原则：** 不得为了复审通过降低验收标准——每项发现均实测验证，不以文档声明代替。

## 逐项处置

| ID  | 严重度   | 处置                                         | 状态         |
| --- | -------- | -------------------------------------------- | ------------ |
| F1  | Critical | **修复**（三处防线 + 失败关闭门禁）          | ✅ CLOSED    |
| F2  | High     | **修复**（revoke super 的 audit_log SELECT） | ✅ CLOSED    |
| F3  | Medium   | **消除**（本地 0059 重放最终版）             | ✅ CLOSED    |
| F4  | Medium   | **修复**（审批租户边界 + 留痕）              | ✅ CLOSED    |
| F5  | Medium   | **修复**（4 个入口加 impersonation 防护）    | ✅ CLOSED    |
| F6  | Low      | **接受风险**（有界、全程留痕）               | ⚠ DOCUMENTED |
| F7  | Low      | **核实为误报**                               | ✅ NO-BUG    |
| F8  | Low      | **核实已 fail-closed**                       | ✅ NO-BUG    |

## F1 — 业务池角色持有平台审计表全 CRUD（Critical）

**根因：** `scripts/cluster/provision.sql` 的 blanket `GRANT … ON ALL TABLES` +
owner default privileges 覆盖两张平台审计表；0059 只 `REVOKE PUBLIC`；
converge/preflight 只检查 audit 角色。实测确认 `beaconhs_app`/`beaconhs_super`
对 `audit_access_grants`/`platform_audit_access_log` 均有 SELECT/INSERT/UPDATE/DELETE。

**修复（三处独立防线，任一遗漏都会被迁移门禁拦截）：**

1. `scripts/cluster/provision.sql` — blanket GRANT 后显式
   `REVOKE ALL ON audit_access_grants / platform_audit_access_log FROM beaconhs_app, beaconhs_super`
   （`to_regclass` 守卫，幂等）。
2. `packages/db/drizzle/0059_audit_access_platform.sql` — 迁移尾部追加
   `DO $$ … to_regrole … $$` 守卫的 REVOKE（CI scratch 无业务角色也能干净应用）。
3. `convergeAuditPrivileges()` — 每次迁移自愈 REVOKE（`to_regrole`/`to_regclass` 守卫）。

**失败关闭门禁：** `assertAuditTablePrivileges()` 新增 businessOffenders 检查——
`beaconhs_app`/`beaconhs_super` 对两张平台表持有任何权限即迁移失败
（错误含 `business-pool roles hold platform-audit privileges` + remediation 提示）。

**验证：**

- 新测试 `audit-access.test.ts` §"F1 remediation"：模拟 blanket 授权 → converge 清零 →
  重新授予 → `assertAuditTablePrivileges` 抛错 → converge 自愈后通过。
- 本地 5433 实测：修复前 app/super 各 8 项权限 → 迁移后 offender 查询 0 行。

## F2 — beaconhs_super 直读全跨租户 audit_log（High）

**核实：** 全仓 grep 证实无任何代码经 super 池读取 audit_log（仅 INSERT：
platform 动作在 withSuperAdmin 事务内 `tx.insert(auditLog)`）。

**修复：** `REVOKE SELECT ON audit_log FROM beaconhs_super`（provision.sql +
0059 + converge 三处；**保留 INSERT**）。offender 门禁仅对
`grantee='beaconhs_super' AND privilege_type='SELECT'` 报警——
`beaconhs_app` 的 audit_log SELECT 合法保留（admin/audit 页经 RLS 读本租户）。

**验证：** 本地实测 `beaconhs_super` audit_log SELECT=false / INSERT=true；
测试钉住（audit-access.test.ts 第三例）。

## F3 — 0059 原地修订 drift（Medium）

**处置：** 0059 从未到达生产（生产 58 迁移）。为消除本地 drift：
drop 两表 + trigger/function + 删除 `drizzle.__drizzle_migrations` 末行 →
以最终版 0059（含 REVOKE DO 块）重放 → `Migration ledger valid: 59 applied,
0 pending`，全部门禁重绿。此后所有环境应用同一份最终版 0059。

## F4 — 审批无租户边界（Medium）

**修复：** `decideCrossTenantAuditGrant()`（`apps/web/src/lib/audit/cross-tenant.ts`）
approve/reject 前预读 grant 并执行边界：

- `scope='platform'` → 需要 `audit.read.platform`（严格 `permissions.has`）；
- `scope='tenant'` → 审批人属同租户 **或** 持 `audit.read.platform`。
- 拒绝时写 `audit_access_denied` 留痕（`reason: approver outside grant boundary`）。
- **revoke 不设边界**（fail-safe 方向：撤销只减少权限，紧急收回不应被阻断）。

**验证（真实 HTTP）：**

- platform-scope grant + 无 `audit.read.platform` 的审批人 → approve 403 / reject 403，
  留痕表两条 `audit_access_denied`（decision approve/reject）。
- 同租户 tenant-scope 全生命周期回归：create → approve 200 → query 200 →
  export 403（审批未确认 extra）→ revoke 200 → query 403。

## F5 — 审计入口无 impersonation 防护（Medium）

**修复：** `assertNotImpersonating(ctx, 'cross-tenant audit')` 加入全部 4 个编排入口
（query / export / request / decide）——冒名会话不得触碰跨租户审计面，
否则留痕会把动作归因到被冒名身份。

## F6 — 预算检查非原子（Low，接受风险）

**处置：** 接受并记录。理由：上限是失控防护栏而非安全边界
（大数据量需 `extra_approval`，超耗行为全部留痕）；竞争超耗上界 =
并发在飞请求数 × 单页 ≤500 行，有界且可审计。原子化需把检查与
append-only 留痕放进同一事务（当前查询发生在两者之间），复杂度
不成比例。

## F7 — 预算 off-by-one（Low，核实为误报）

`used + requestedRows > AUDIT_QUERY_MAX_ROWS` 拒绝、`=` 放行：
used=9999 + requested=1 → 10000 放行（恰好达帽）；used=10000 + 1 → 拒。
语义正确，无差一。测试 `exceeding the 10000-row budget` 已覆盖边界。

## F8 — 留痕写入失败时已读未记（Low，核实已 fail-closed）

`runCrossTenantAuditQuery` 的成功留痕 `recordAuditAccessEvent` 在返回行**之前**
执行且不在 try/catch 内：留痕写失败 → 异常传播 → withRouteErrors → 500，
**数据永不交付**。客户端不可能收到未留痕的行；服务端已读但未交付的行
随响应失败而丢弃。（导出路径同构。）

## 门禁（各自退出码）

| 门禁           | 退出码 | 备注                                                                                                                   |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| format:check   | 0      | 含对审计报告 md 的 prettier 格式化                                                                                     |
| typecheck      | 0      | db + web                                                                                                               |
| lint           | 0      |                                                                                                                        |
| test           | 0      | 全仓复跑（首跑 2 个 web 用例 5.6s/1.7s 超时为宿主负载 flake，单独重跑 15/15 及全仓复跑均 0）；db 615 passed/41 skipped |
| deadcode:check | 0      |                                                                                                                        |
| build          | 0      |                                                                                                                        |

## 测试分层（如实区分）

| 层              | 内容                                                             | 数量      | 退出码 |
| --------------- | ---------------------------------------------------------------- | --------- | ------ |
| 真实 PostgreSQL | audit-access（含 F1 三例）/ preflight / client / query-isolation | 68 passed | 0      |
| HTTP 集成       | F4 边界矩阵（403×2 + 留痕 2 行）+ 租户内全生命周期回归（6 请求） | 全部符合  | —      |
| 连接池隔离      | audit-query-isolation 既有 18 例回归                             | 18 passed | 0      |
| 纯逻辑 / Mock   | 无新增；既有套件回归通过                                         | —         | —      |

## 修改文件

- `scripts/cluster/provision.sql` — 平台表 REVOKE + super audit_log SELECT REVOKE
- `packages/db/drizzle/0059_audit_access_platform.sql` — 追加守卫 REVOKE DO 块
- `packages/db/src/audit-roles.ts` — converge REVOKE 自愈 + assert businessOffenders
- `packages/db/src/audit-access.ts` — `getAuditAccessGrant()` 导出
- `apps/web/src/lib/audit/cross-tenant.ts` — F4 边界 + F5 impersonation 防护
- `packages/db/src/audit-access.test.ts` — F1 describe（3 例）
- `BEACONHS_PD02_INDEPENDENT_SECURITY_AUDIT.md` — prettier 格式化（内容未改）
- 本报告
