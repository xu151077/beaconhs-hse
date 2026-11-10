# PD-02 P-3 — SET LOCAL ROLE 与连接池身份隔离报告

**阶段门禁结论：PASS（可进入跨租户查询/授权实施）。**
**V3 依据：** `BEACONHS_PD02_P1_P6_CLOSURE_REPORT.md` §P-3（"最危险项"）。
**测试性质：** 真实 PostgreSQL（临时 postgres:16-alpine），**max:1 池强制物理连接复用**，`pg_backend_pid()` 证据；无 Mock。

## 1. 实施：`packages/db/src/audit-query.ts`（新模块，唯一执行器）

`queryAuditLogAcrossTenants(conn, filter)` — 每次跨租户审计读取都在**单个事务**内完成：

```sql
BEGIN
  SET LOCAL ROLE audit_reader          -- 事务级；提交/回滚自动恢复 audit_service
  SET LOCAL statement_timeout = '10s'  -- 事务级；不污染会话
  SELECT ... FROM audit_log [WHERE ...] ORDER BY occurred_at DESC LIMIT ... OFFSET ...
COMMIT / ROLLBACK
```

- 角色/超时常量取自 `audit-roles.ts` 的 `AUDIT_READER_ROLE` 与本模块 `AUDIT_QUERY_STATEMENT_TIMEOUT='10s'`。
- **全参数化**：postgres.js tagged template 绑定所有值；条件片段嵌套组合（postgres.js 无 `sql.join`），**无字符串拼接、无动态 SQL、无 SECURITY DEFINER**。
- 过滤器：`from`/`to`（occurred_at）、`tenantIds`（undefined=全租户；**显式空数组=fail-closed 空集**）、`entityTypes`、`actions`。
- **服务端页参数防御**：`limit` 必须 ∈ [1, `AUDIT_MAX_PAGE_SIZE=500`]（V3 每页≤500 行），`offset ≥ 0`，越界在触库前拒绝——客户端无法通过改参数放大页面。
- 会话级 `SET ROLE` 在该路径被禁止；此文件若出现即为缺陷。

## 2. 真实 PostgreSQL 隔离验证（11/11，退出码 0）

命令：`pnpm --filter @beaconhs/db exec vitest run src/audit-query-isolation.test.ts`
环境：临时容器 + 与生产同构的角色模型（audit_reader NOLOGIN/BYPASSRLS、audit_service LOGIN/NOBYPASSRLS）+ FORCE RLS 语义的 `audit_log`/`incidents` + **max:1 审计池**。

| #   | 场景                                                                                                                                    | 证据                             | 结果 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---- |
| 1   | 事务内切换 audit_reader，跨租户读到 Tenant A+B 两行                                                                                     | BYPASSRLS 生效证明               | ✅   |
| 2   | tenantIds / 空数组 / 不存在 action 的服务端过滤                                                                                         | 显式空 scope → 0 行              | ✅   |
| 3   | 越界页参数（501/0/负 offset）触库前拒绝                                                                                                 | 异常消息 /page size/i、/offset/i | ✅   |
| 4   | 事务内 `show statement_timeout`='10s'，事务外恢复 '0'                                                                                   | SET LOCAL 不残留                 | ✅   |
| 5   | **提交后**：`current_user=session_user='audit_service'`；`incidents`/`audit_log` 直读仍 permission denied                               | 复用连接身份恢复                 | ✅   |
| 6   | **回滚后**（事务内查询失败）：身份恢复，重新授权后执行器在同一连接恢复正常                                                              | 异常路径清理                     | ✅   |
| 7   | **调用方中途抛异常**：postgres.js 回滚，会话身份 `audit_service`，audit_log 直读仍被拒                                                  | 异常路径清理                     | ✅   |
| 8   | **物理连接复用证据**：连续 3 个审计事务 `pg_backend_pid()` 相同；事务内 `current_user='audit_reader'` 且 `session_user='audit_service'` | max:1 池 + PID                   | ✅   |
| 9   | 并发两个审计事务各自在事务内看到 audit_reader / 完整数据，结束后会话身份恢复                                                            | 无跨事务身份共享                 | ✅   |
| 10  | 事务外 `select * from audit_log` 永远被拒（RLS+无授权双保险）                                                                           | fail-closed                      | ✅   |
| 11  | 常量钉住：`AUDIT_MAX_PAGE_SIZE=500`、`AUDIT_QUERY_STATEMENT_TIMEOUT='10s'`                                                              | V3 契约                          | ✅   |

## 3. 与 P-1/P-2 的组合安全论证

- 连接身份（`audit_service`）与执行身份（事务内 `audit_reader`）分离；前者永远无表权限，后者仅存在于事务内且仅可 SELECT `audit_log`。
- 任何提交/回滚/异常路径后，池中连接回到 `audit_service`——**BYPASSRLS 不可能经连接复用泄漏给后续请求**（V3 §P-3 核心验收）。
- BYPASSRLS 可达面 = 仅 `audit_log` SELECT（P-1 information_schema 矩阵断言每次迁移复核）。
- 记录要求的身份证据：`pg_backend_pid()`、`current_user`、`session_user`、事务内/外 `statement_timeout` 均已在测试中断言。

## 4. 已知边界（移交后续阶段）

- 超范围/导出审批、行数上限（10,000）与 31 天窗口在 P-6 的 HTTP 层强制（执行器已具备页大小与超时防御）。
- `platform_audit_access_log` 留痕写入在 P-5 落表后接入端点（阶段 7 验证）。
- `auditQueryOversizeGuard`（limit+1 超限判定）随 P-6 端点一并落地，避免出现未使用导出。

**P-3 门禁：PASS → 进入 P-4（授权与独立审批）。**
