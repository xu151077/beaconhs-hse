# PD-02 P-2 — 独立 AUDIT_DATABASE_URL 连接路径报告

**阶段门禁结论：PASS（可进入 P-3）。**
**V3 依据：** `BEACONHS_PD02_P1_P6_CLOSURE_REPORT.md` §P-2、`BEACONHS_PD02_REVISED_ARCHITECTURE.md` §2。
**前置：** P-1 已交付 `audit_service`（LOGIN/NOINHERIT/NOBYPASSRLS，无表权限）与 `audit_reader`（NOLOGIN/BYPASSRLS，仅 SELECT audit_log）。

## 1. 实施（最小变更）

### 1.1 `packages/db/src/audit-client.ts`（新模块）

- `readAuditDatabaseUrl()`：仅读 `AUDIT_DATABASE_URL`，**trim 后为空一律视为缺失**；**永不回退**到 `DATABASE_URL`/`SUPERADMIN_DATABASE_URL`。
- `AuditConnectionUnavailableError`：配置缺失时抛出；HTTP 层（P-6 端点）必须映射为 **503 `audit_unavailable`**，绝不降级为业务连接。
- `createAuditConnection()` / `getAuditConnection()`（进程级懒加载单例）/ `closeAuditConnection()`。
- **独立池**：`postgres(url, { max: AUDIT_DATABASE_POOL_MAX=2, idle_timeout: 30, connect_timeout: 10, prepare: false })`，与 `db`(max 20)/`superDb`(max 10) 无任何共享；`prepare:false` 兼容 PgBouncer 事务模式。
- 池大小固定为 2（V3 §P-2 设计值），**刻意不提供环境变量开关**——审计并发不是调优旋钮。
- 密钥卫生：本模块不打印、不嵌入、不记录 URL；错误消息只提配置键名。

### 1.2 `.env.example`

新增 `AUDIT_DATABASE_URL` 说明（默认注释状态：未开通审计功能时不设置），明确 503 fail-closed 语义。

### 1.3 导出

`packages/db/src/index.ts` 导出 `audit-client`（`audit-roles` 一并导出）。

## 2. 测试（真实 PostgreSQL + 纯逻辑，分层报告）

### 2.1 纯逻辑 / 配置契约（无 DB）

| #   | 场景                                                                                                         | 结果 |
| --- | ------------------------------------------------------------------------------------------------------------ | ---- |
| 1   | 环境变量缺失 → `readAuditDatabaseUrl()=null`；`createAuditConnection()` 抛 `AuditConnectionUnavailableError` | ✅   |
| 2   | 空串 / 纯空白 → 与缺失完全一致（fail-closed）                                                                | ✅   |
| 3   | **设置了 `DATABASE_URL`/`SUPERADMIN_DATABASE_URL` 但 AUDIT 缺失 → 仍然 null**（证明无回退）                  | ✅   |
| 4   | 池上限常量 = 2                                                                                               | ✅   |

### 2.2 真实 PostgreSQL（临时 postgres:16-alpine 容器，`audit_service` 真实身份）

| #   | 场景                                                                                                             | 结果 |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---- |
| 5   | 以 `audit_service` 连接成功，`current_user=session_user='audit_service'`                                         | ✅   |
| 6   | **登录成功但直接读 `incidents`/`audit_log` 被拒（permission denied）**——边界在角色授权而非网络可达性             | ✅   |
| 7   | 审计池 backend pid ≠ 业务池 backend pid（不同物理连接、不同身份）                                                | ✅   |
| 8   | `AUDIT_DATABASE_URL` 指向关闭端口 → 审计查询立刻失败；独立创建的业务池查询 `select 1` 正常（审计故障不影响业务） | ✅   |
| 9   | `closeAuditConnection()` 后单例重建并重新读取配置                                                                | ✅   |

命令：`pnpm --filter @beaconhs/db exec vitest run src/audit-client.test.ts` → **8/8，退出码 0**。

### 2.3 HTTP 503 证据的落地位置

跨租户审计查询的 HTTP 端点按 V3 §7 顺序属于 P-6（依赖 P-4 授权、P-5 表、P-6 限额）；届时端点在会话认证与权限校验后、任何查询前执行配置检查，缺失即 503 `audit_unavailable`。本阶段 503 契约已由 §2.1 的模块级异常类型固化并有测试钉住；HTTP 层证据在 P-6 验收矩阵中补齐（P-2 报告届时引用）。

## 3. 安全结论

- 审计连接身份 = `audit_service`：无表权限、无 BYPASSRLS；跨租户读取只能经 P-3 的 `SET LOCAL ROLE audit_reader` 在事务内发生。
- 配置缺失/空白/不可达全部 fail-closed，无降级路径；业务池与审计池在对象、socket、身份三个层面均隔离。
- `AUDIT_DATABASE_URL` 未进入任何日志或错误消息。

**P-2 门禁：PASS → 进入 P-3。**
