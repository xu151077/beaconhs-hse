# PD-02 独立安全评审报告 — 审计历史回溯

**评审对象：** `docs/pd-01-02-03-implementation-design.md` 中 PD-02 设计（尚未实施）。
**评审性质：** 只读代码/迁移评审，未修改任何文件，未实施 SECURITY DEFINER 函数。
**结论：不通过（设计需修订）。** 租户级可安全实施；**平台级跨租户读取与 `FORCE RLS` 存在直接冲突**，按现设计无法达成。

---

## 1. 关键发现（阻断项）

### F-1 `audit_log` 是 `FORCE ROW LEVEL SECURITY`，SECURITY DEFINER 无法跨租户读取

证据：

- `packages/db/src/rls.ts:63-66`：`RLS_POLICY_SQL` 对每张租户表执行 `ENABLE` **且** `FORCE ROW LEVEL SECURITY`。
- 生产/隔离库 `\d audit_log` 输出 `Policies (forced row security enabled)`。
- 策略：`USING (tenant_id = current_setting('app.tenant_id'))`（单租户）。

后果：`SECURITY DEFINER` 函数以 owner（`beaconhs_owner`，NOBYPASSRLS）执行时，**仍受 FORCE RLS 约束**。函数内 `SELECT … FROM audit_log` 只能看到当前 `app.tenant_id` 的那一个租户，**无法实现 `audit.read.platform` 的跨租户追溯**。

设计文档中"函数内校验权限后跨租户返回"的假设不成立。

**可选修订方案（需产品/安全共同选定）：**

| 方案      | 做法                                                                                                                                                                             | 风险                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A（推荐） | 专用 **只读 BYPASSRLS 审计角色**（`audit_reader`，`NOLOGIN`，仅 `SELECT`）+ `SECURITY DEFINER` 函数 owner 为该角色；函数固定 `search_path`、参数化、`REVOKE EXECUTE FROM PUBLIC` | 新增一个可越过 RLS 的角色；必须禁止其登录、禁止任何写权限、纳入角色审计 |
| B         | 函数内 `SET LOCAL row_security = off`                                                                                                                                            | 需要 superuser/BYPASSRLS；对 FORCE RLS 表会报错，实质等同 A 但更隐蔽    |
| C         | 分租户循环（逐租户设置 `app.tenant_id` 后查询再合并）                                                                                                                            | 安全但 N 次往返，大租户性能差；仍是单租户策略的合规用法                 |
| D         | 不做在线跨租户，改为离线归档/导出                                                                                                                                                | 最安全，但可能不满足"受控跨租户只读追溯"的产品要求                      |

### F-2 租户级读取不需要 SECURITY DEFINER（设计可简化）

`audit.read.tenant` 只需**本租户**全量读取：RLS 已按 `tenant_id` 放行，运行时角色（`beaconhs_app`）本就具备 `SELECT`。因此：

- 不需要 SECURITY DEFINER；
- 只需在应用层增加权限键校验 + 审计访问留痕；
- 攻击面显著小于原设计。

建议把 PD-02 拆为"租户级（低风险，可先做）"与"平台级（高风险，需 F-1 方案定稿）"。

---

## 2. 逐项评审（设计中的 11 个检查点）

| #   | 检查点                    | 结论          | 说明                                                                                                                                                                                              |
| --- | ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SECURITY DEFINER 权限边界 | ⚠ 需修订      | F-1：FORCE RLS 使跨租户不可行；若采用方案 A，函数仅 `SELECT`、禁动态 SQL、固定 `search_path = pg_catalog, public`                                                                                 |
| 2   | RLS 保留情况              | ✅            | 设计明确不改 `audit_log` 策略；F-2 下租户级完全依赖现有 RLS                                                                                                                                       |
| 3   | 函数 Owner 权限           | ⚠ 需修订      | 现 owner 为 `beaconhs_owner`(NOLOGIN/NOBYPASSRLS)，不足以跨租户；方案 A 需专用只读 BYPASSRLS 角色                                                                                                 |
| 4   | `search_path` 固定        | ✅ 设计已要求 | 实施时必须以 `SET search_path = pg_catalog, public` 声明，且函数体只用限定名                                                                                                                      |
| 5   | PUBLIC EXECUTE 撤销       | ✅ 设计已要求 | 实施时 `REVOKE ALL ON FUNCTION … FROM PUBLIC` 并对 app/super/backup 显式授予                                                                                                                      |
| 6   | 审计人员身份验证          | ⚠ 待定        | 当前只有 `isSuperAdmin`；`audit.read.tenant` 的授予对象、是否需二次确认（MFA/理由）未定义                                                                                                         |
| 7   | 跨租户授权有效性          | ❌ 不成立     | F-1 阻断；需方案 A/C/D 之一                                                                                                                                                                       |
| 8   | 访问目的与审批机制        | ❌ 未定义     | 设计只有"访问留痕"，没有"访问目的/审批"字段与流程                                                                                                                                                 |
| 9   | `audit_access` 不可篡改   | ✅ 机制存在   | 写入走既有 append-only 触发器（`0057`）；但**读事件写入会触发 RESTRICT 外键**要求 `tenant_id` 必须存在（见 #11）                                                                                  |
| 10  | 连接池与事务上下文        | ✅            | `withTenant`/`withSuperAdmin` 隔离已有测试；SECURITY DEFINER 函数不参与连接池，只接收参数                                                                                                         |
| 11  | RESTRICT FK 交互          | ⚠ 需注意      | `audit_log_tenant_id_tenants_id_fk` 为 `ON DELETE RESTRICT`；`audit_access` 行必须带有效 `tenant_id`（平台级读取跨租户时，用哪个 tenant_id 记录？需定义"以操作者所属租户记录"或"逐租户各记一条"） |

---

## 3. 其它风险

- **导出路径**：若提供导出，必须脱敏（`metadata`/`before`/`after` 可能含个人信息），并复用既有导出审计。
- **通用 API**：不得把审计读取暴露给 `/api/v1/*`；API 凭据为租户级主体，与其权限模型正交。
- **超管边界**：`audit.read.platform` 若只授予 `isSuperAdmin`，则与"独立授权"矛盾；需明确是"超管 + 显式授权"还是"独立角色"。

---

## 4. 结论与前置条件

**结论：不通过。** 在 F-1 未定稿、F-2 未拆分、#6/#8/#11 未定义前，不得开始实施（尤其不得创建任何 SECURITY DEFINER 函数或新 RLS 例外）。

**恢复评审的最低条件：**

1. 明确平台级跨租户方案（A/C/D 之一），并书面记录角色/函数/授权的安全边界
2. 拆分租户级与平台级，租户级先做（无需 SECURITY DEFINER）
3. 定义 `audit.read.tenant` 的授予对象与访问审批/目的字段
4. 定义跨租户访问的 `audit_access` 记录归属（tenant_id 语义）
5. 明确"独立授权"与超管的关系
6. 提供实施后的真 PG 测试矩阵（无权限拒绝、租户级不出租户、平台级可跨租户、普通 SELECT 仍受 RLS、触发器仍拒写）

满足后可再次提交评审；**本报告不批准实施**。
