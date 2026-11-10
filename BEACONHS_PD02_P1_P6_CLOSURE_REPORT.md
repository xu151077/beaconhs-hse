# PD-02 P-1 至 P-6 关闭报告

**性质：** 设计层面逐项关闭 + 实施验证方案。**未创建角色/函数/迁移，未改 RLS。**
**产品已定：** P-4 独立 Audit Approver；P-5 审计访问表不入 `TENANT_SCOPED_TABLES`；P-6 查询限额（31 天 / 10 000 行 / 500 行每页 / 10 秒超时 / 超范围需额外审批）。

## P-1 迁移角色预检（部署阻断）

**要求：** 新增角色不得让 `migrate.ts:assertDatabaseRoles` 失败，且必须证明角色边界。

**关闭方式：**

1. 预检新增两条断言（迁移时执行）：
   - `audit_reader`：`NOT rolsuper AND rolbypassrls AND NOT rolcanlogin AND NOT pg_has_role('audit_reader','beaconhs_owner','MEMBER')`
   - `audit_service`：`rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT pg_has_role('audit_service','beaconhs_owner','MEMBER')`
2. 权限矩阵断言：
   - `has_table_privilege('audit_reader','audit_log','SELECT') = true`
   - 对 `TENANT_SCOPED_TABLES` 中每张业务表 `has_table_privilege('audit_reader', t, 'SELECT') = false`
   - `pg_has_role('beaconhs_app','audit_reader','MEMBER') = false`（super / backup 同理）
3. `distinctRoles` 集合由 5 扩到 7，仍要求两两不同。

**状态：设计已关闭，实施未开始。** 验证方式：迁移后执行上述断言，失败即中止部署。

## P-2 `AUDIT_DATABASE_URL` 凭据管理

**要求：** 独立 secret、可轮换、fail-closed、不混入业务池。

**关闭方式：**

- 新增独立环境变量 `AUDIT_DATABASE_URL`（`audit_service` 身份），**不复用** `DATABASE_URL`/`SUPERADMIN_DATABASE_URL`。
- 审计模块启动时若该变量缺失 → 审计读取功能返回 503（`audit_unavailable`），**不回退**。
- 独立连接池（`max: 2`），不复用业务 `db` 实例。
- 轮换：改 secret 后重启审计服务即可；旧连接自然过期。

**状态：设计已关闭，实施未开始。**

## P-3 `SET LOCAL ROLE` 与连接池隔离（最危险项）

**要求：** 不得用会话级 `SET ROLE`（会把 BYPASSRLS 泄漏给后续业务查询）。

**关闭方式：**

```ts
await auditClient.begin(async (tx) => {
  await tx`SET LOCAL ROLE audit_reader` // 事务级，提交/回滚自动恢复
  await tx`SET LOCAL statement_timeout = '10s'`
  const rows = await tx`SELECT ... FROM audit_log WHERE ...` // 参数化，无动态 SQL
  await tx`RESET ROLE` // 冗余保险
})
```

**验证（必须真 PG）：** 同一连接先执行审计查询，再执行 `SELECT count(*) FROM incidents`（不带 `app.tenant_id`）→ 必须为 0 或报错，证明 `SET LOCAL` 已回滚、未泄漏 BYPASSRLS。

**状态：设计已关闭，验证未执行（需实施后真 PG 测试）。**

## P-4 独立 Audit Approver

**产品决策：** 独立审批角色，申请人不得审批自己的申请。

**关闭方式：**

- 新增权限键 `admin.audit.approve`，**默认不授予**任何内置角色（仅平台管理员显式授予）。
- `audit_access_grants.approved_by_user_id <> grantee_user_id` 由 CHECK 约束强制。
- 审批记录写入 `platform_audit_access_log`（`action='grant_approved'`）。

**状态：设计已关闭，实施未开始。**

## P-5 审计访问表不纳入 `TENANT_SCOPED_TABLES`

**产品决策：** 独立平台级模型。

**关闭方式：**

- `audit_access_grants`、`platform_audit_access_log` **不加入** `TENANT_SCOPED_TABLES`（不套租户 RLS）。
- 替代保护：`REVOKE ALL FROM PUBLIC`；仅 `beaconhs_owner`（DDL）与 `audit_service`（`SELECT`/`INSERT`）有权限；`beaconhs_app`/`beaconhs_super` **无任何权限**。
- `tenant_id` 列可空（平台级访问为 NULL），**不建 tenant FK**（规避 RESTRICT 语义冲突）。
- 不可篡改：`BEFORE UPDATE OR DELETE` 触发器，非 owner 抛错；`TRUNCATE` 由权限撤销控制。

**状态：设计已关闭，实施未开始。**

## P-6 查询限额（服务端强制）

**产品决策：** 31 天 / 10 000 行 / 500 行每页 / 10 秒超时 / 超范围需额外审批。

**关闭方式（全部服务端强制，不信任客户端参数）：**

| 限制              | 实现                                                      |
| ----------------- | --------------------------------------------------------- |
| 时间窗 ≤ 31 天    | 服务端裁剪 `from`/`to`；超出返回 400                      |
| 单次 ≤ 10 000 行  | 查询 `LIMIT 10001` 后判断，超限返回 400（提示分批）       |
| 每页 ≤ 500 行     | 服务端强制 `min(pageSize, 500)`                           |
| 查询超时 10 秒    | `SET LOCAL statement_timeout = '10s'`                     |
| 超范围/大批量导出 | 需要 `audit_access_grants.extra_approval = true` 且未过期 |

每次查询（成功或失败）都写 `platform_audit_access_log`（含 `row_count`、`filter`、失败原因）。

**状态：设计已关闭，实施未开始。**

## 汇总

| 项  | 设计                | 实施 | 验证                  |
| --- | ------------------- | ---- | --------------------- |
| P-1 | ✅ 关闭             | ❌   | 迁移后断言            |
| P-2 | ✅ 关闭             | ❌   | 缺失变量返回 503      |
| P-3 | ✅ 关闭             | ❌   | 真 PG 池隔离测试      |
| P-4 | ✅ 关闭（产品已定） | ❌   | CHECK 约束 + 审批记录 |
| P-5 | ✅ 关闭（产品已定） | ❌   | 权限矩阵断言          |
| P-6 | ✅ 关闭（产品已定） | ❌   | 限额边界测试          |

**P-1…P-6 设计层面全部关闭；数据库实施尚未开始，需 V3 评审确认后另行授权。**
