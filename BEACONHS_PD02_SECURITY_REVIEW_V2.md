# PD-02 安全评审 V2 — 修订架构（方案 A）

**评审对象：** `BEACONHS_PD02_REVISED_ARCHITECTURE.md`
**性质：** 只读设计评审；未创建角色/函数/迁移。
**结论：设计层面有条件通过。** 原 F-1（FORCE RLS 阻断跨租户）已被 `audit_reader`（BYPASSRLS、仅 `audit_log.SELECT`、NOLOGIN）解决；实施前须闭合下列 6 项前置。

## 1. 逐项评审

| #   | 检查点                    | 结论        | 证据 / 说明                                                                                                   |
| --- | ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | SECURITY DEFINER 权限边界 | ✅ 已规避   | 本版改为**独立连接 + `SET ROLE audit_reader`**，不创建 SECURITY DEFINER 函数；函数注入面为零                  |
| 2   | RLS 保留                  | ✅          | 设计第 5 节明确 `audit_log` 的 FORCE RLS、策略、触发器、RESTRICT FK 原样                                      |
| 3   | 函数 Owner 权限           | ✅ 不适用   | 无函数；执行身份是 `audit_reader`（NOLOGIN，不可登录）                                                        |
| 4   | `search_path` 固定        | ✅ 不适用   | 无函数；查询为参数化 SQL，无动态拼接                                                                          |
| 5   | PUBLIC EXECUTE 撤销       | ✅ 不适用   | 无函数可授；角色层面 `REVOKE audit_reader FROM PUBLIC`                                                        |
| 6   | 审计人员身份验证          | ⚠ 待定      | 设计引入 `audit_access_grants`（审批人、有效期、purpose），但**未定义审批人角色**与 MFA/二次确认要求          |
| 7   | 跨租户授权有效性          | ✅ 设计成立 | `audit_reader` BYPASSRLS + 仅 `audit_log.SELECT`，跨租户读取可行                                              |
| 8   | 访问目的与审批机制        | ✅ 设计成立 | `purpose` 必填、`approved_by` 不得等于 grantee、有效期 ≤ 90 天                                                |
| 9   | `audit_access` 不可篡改   | ✅ 设计成立 | `platform_audit_access_log` 复用 append-only 触发器模式；`TRUNCATE` 由权限撤销                                |
| 10  | 连接池与事务上下文        | ⚠ 待定      | 见 P-3：`SET ROLE` 在池化连接上的残留风险必须用 `SET LOCAL` 或独立短连接解决                                  |
| 11  | RESTRICT FK 交互          | ✅ 已解决   | `platform_audit_access_log.tenant_id` 为 nullable 且**不建 tenant FK**，规避 `audit_log` 的 RESTRICT 语义冲突 |

## 2. 实施前必须闭合的 6 项

### P-1 迁移角色预检会因新角色失败（阻断）

`packages/db/src/migrate.ts:assertDatabaseRoles` 断言 migration/owner/runtime/maintenance/backup 五个角色 **distinct**，并校验各自属性。新增 `audit_reader`/`audit_service` 必须：

- 扩展预检：`audit_reader` 必须 `NOLOGIN + BYPASSRLS + 非 owner 成员`；`audit_service` 必须 `LOGIN + 非 SUPERUSER + 非 BYPASSRLS + 非 owner 成员`；
- 断言 `audit_reader` 仅持有 `audit_log` 的 `SELECT`（`has_table_privilege` 遍历业务表全部为 false）；
- 断言 `beaconhs_app`/`beaconhs_super`/`beaconhs_backup` 不是 `audit_reader` 成员（`pg_has_role(..., 'MEMBER') = false`）。

**未扩展预检就部署 = 迁移直接失败或角色边界未被证明。**

### P-2 `AUDIT_DATABASE_URL` 的凭据管理

- 需新增独立 secret（不得复用 `DATABASE_URL`），支持轮换；
- 审计服务连接失败必须 **fail-closed**（返回 503），不得回退到 `DATABASE_URL`；
- 该连接不得进入普通请求池（避免与业务事务混用）。

### P-3 连接池 `SET ROLE` 残留

`SET ROLE` 是会话级的；若复用池化连接，未 `RESET ROLE` 会把 BYPASSRLS 身份泄漏给后续业务查询——这是**最危险的实现错误**。

要求：使用 `SET LOCAL ROLE audit_reader`（事务级，提交/回滚自动恢复）或每次新建短连接并在 `finally` 中断开。评审要求提供一条**真 PG 测试**证明：执行审计查询后，同一连接上的业务查询**看不到**跨租户行。

### P-4 审批人模型

`audit_access_grants.approved_by` 需要明确的审批角色（建议 `admin.audit.approve`，仅平台管理员），且审批人不得审批自己的申请（设计已要求）。需产品确认该角色是否授予现有 `tenant_admin`。

### P-5 新表的 RLS 与备份可见性

`audit_access_grants` 与 `platform_audit_access_log` 是**平台级**表（tenant 可空）：

- 是否纳入 `TENANT_SCOPED_TABLES`（强制 RLS）需要决定；若不纳入，必须限定仅 `audit_service`/owner 可读，普通 app 角色无权限；
- `beaconhs_backup` 是否需要 `SELECT`（备份完整性）—— 建议授予只读，但**不得**授予 `audit_reader`。

### P-6 审计查询本身的滥用面

- 必须限制单次返回行数与时间窗（如 ≤ 10k 行、≤ 90 天/次）；
- 导出必须脱敏（`metadata`/`before`/`after` 可能含个人信息）；
- 查询失败也必须写一条访问事件（含失败原因），否则"失败不留痕"。

## 3. 真 PG 测试矩阵（实施后必须全过）

| #   | 场景                                           | 断言                                        |
| --- | ---------------------------------------------- | ------------------------------------------- |
| 1   | `audit_reader` 角色属性                        | NOLOGIN、BYPASSRLS、仅 `audit_log.SELECT`   |
| 2   | `audit_reader` 访问业务表                      | 全部 `permission denied`                    |
| 3   | `beaconhs_app` `SET ROLE audit_reader`         | 拒绝（无成员资格）                          |
| 4   | `audit_service` 登录后 `SET ROLE audit_reader` | 成功                                        |
| 5   | 租户级读取                                     | 只能读本租户，`platform` 范围被拒           |
| 6   | 平台级读取                                     | 可跨租户                                    |
| 7   | 无有效 grant                                   | 拒绝                                        |
| 8   | grant 过期 / 已撤销                            | 拒绝                                        |
| 9   | 超管无 grant                                   | 拒绝（不自动获得）                          |
| 10  | 访问事件写入                                   | 每次成功/失败各一条，且不可 UPDATE/DELETE   |
| 11  | 连接复用隔离                                   | `SET LOCAL` 后业务查询仍受 RLS              |
| 12  | `audit_log` 策略未变                           | FORCE RLS + 触发器仍在，普通角色仍不能改/删 |

## 4. 结论

**设计层面有条件通过**。P-1 是部署阻断项（不扩展 `migrate.ts` 预检，迁移会失败或角色边界未被证明）；P-3 是最危险实现错误（`SET ROLE` 残留会泄漏 BYPASSRLS）。

闭合 P-1…P-6 后可进入实施；**本评审不批准创建角色/迁移**。
