# PD-02 P-1 — 数据库角色预检报告

**阶段门禁结论：PASS（可进入 P-2）。**
**基线：** 阶段 0 报告 `BEACONHS_PD02_BASELINE_AUDIT.md`（提交 611ef924），V3 设计链
`BEACONHS_PD02_REVISED_ARCHITECTURE.md` + `BEACONHS_PD02_SECURITY_REVIEW_V3.md` +
`BEACONHS_PD02_P1_P6_CLOSURE_REPORT.md` §P-1。

## 1. 目标

按 V3 方案 A 交付两个专用数据库角色，并证明：

- `audit_reader`：NOLOGIN + BYPASSRLS，只能 SELECT `audit_log`，不能写、不能删、不能读任何业务表。
- `audit_service`：LOGIN + NOINHERIT + NOBYPASSRLS，是 `audit_reader` 的**唯一**成员；普通应用角色永远不能经由任何路径获得 `audit_reader`。
- 迁移流程每次执行都做预检断言，角色缺失或属性漂移时 fail-closed 中止。

未在生产数据库创建或修改任何角色；本阶段全部操作在本地隔离环境（docker，5433）与测试专用临时容器内。

## 2. 现状核查（P-1.1–P-1.9 执行记录）

| 检查项                         | 结果                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 现有角色（阶段 0）             | 仅 5 个：owner(NOLOGIN) / migrator(NOINHERIT) / app / super / backup；无 CREATEROLE，角色只能由 superuser 经 provision.sql 创建 |
| app 角色是否 BYPASSRLS         | 否（NOBYPASSRLS），RLS 全程生效                                                                                                 |
| app/migrator 能否建角色/改角色 | 否（无 CREATEROLE/CREATEDB；provision.sql 是唯一入口）                                                                          |
| `audit_reader` 此前是否存在    | 不存在（PD-02 无历史代码/迁移）                                                                                                 |
| audit_log 表                   | `public.audit_log`（`packages/db/src/schema/audit.ts:5-33`），tenant_id NOT NULL FK RESTRICT；不可篡改由 0056/0057 触发器保证   |
| 普通角色改/删审计日志路径      | 无：app 仅 INSERT；UPDATE/DELETE 被触发器 RAISE；audit_reader 按新矩阵只读                                                      |

## 3. 实施内容（最小变更）

### 3.1 `scripts/cluster/provision.sql`（幂等，superuser 执行）

- `audit_reader`：`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS`（`CREATE ROLE ... WHERE NOT EXISTS` + `ALTER` 收敛属性）。
- `audit_service`：`LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`，密码走 `psql -v audit_service_password`（不进 Git）。
- 成员关系收敛（防注入/防漂移 REVOKE 循环）：owner 成员剔除清单加入 `audit_service`；`audit_reader` 的成员剔除后仅保留 `audit_service`；`audit_service` 的父角色剔除后仅保留 `audit_reader`；`GRANT audit_reader TO audit_service` 幂等。
- 连接授权：`GRANT CONNECT` 清单加入 `audit_service`。
- 读取路径：`GRANT USAGE ON SCHEMA public TO audit_reader`（SET ROLE 后读取必需）。
- 表授权（`to_regclass` 守卫，旧库无表时不出错）：`REVOKE ALL ON audit_log FROM audit_reader` → `GRANT SELECT ON audit_log TO audit_reader`。
- 连接卫生（会话级，仅 audit_service 登录）：`statement_timeout=10s`、`idle_in_transaction_session_timeout=5min`、tcp keepalive。
- `scripts/cluster/local-init.sh`：传递本地 `audit_service_password` 变量。

### 3.2 `packages/db/src/audit-roles.ts`（新模块，迁移流程内建断言）

- `assertAuditRoleAttributes(db, ownerRole)`：preflight。断言 reader = NOLOGIN/NOSUPERUSER/BYPASSRLS 且非 owner 成员；service = LOGIN/NOSUPERUSER/NOBYPASSRLS 且非 owner 成员；reader 的成员**恰好**为 service；service 不得 member of owner。失败消息含修复指引 `Re-run scripts/cluster/provision.sql`。
- `assertAuditTablePrivileges(db)`：迁移后断言。reader 对 audit_log SELECT=true、INSERT/UPDATE/DELETE=false；`has_schema_privilege(reader,'public','USAGE')`；**权限矩阵泛查**：`information_schema` 全部 BASE TABLE × 两角色 × SELECT/INSERT/UPDATE/DELETE，除 reader×audit_log SELECT 外任一命中即报 offenders（新增业务表默认对审计角色无权限）。
- `convergeAuditPrivileges(db)`：漂移自愈（GRANT USAGE、REVOKE ALL TABLES、GRANT SELECT audit_log）。

### 3.3 `packages/db/src/migrate.ts` 接入

- 角色计数 5→7（`assertDatabaseRoles` distinctRoles 缺 audit_reader/audit_service 即中止）。
- preflight 阶段：`▶ Verifying audit roles (PD-02 preflight)…` → `assertAuditRoleAttributes`。
- grants 阶段后：`convergeAuditPrivileges` + `assertAuditTablePrivileges`，输出 `✔ audit privilege matrix verified (audit_reader: SELECT audit_log only)`。

### 3.4 CI（`.github/workflows/ci.yml`）

- beaconhs_test 库与 scratch 库两处内联 SQL 补建两个角色及同等授权，保证 CI 与本地/生产同构。

## 4. 权限矩阵（实测证据，见 §5）

| 主体                         | 读 audit_log           | 改/删 audit_log       | 读业务表                          | 切换 audit_reader          |
| ---------------------------- | ---------------------- | --------------------- | --------------------------------- | -------------------------- |
| beaconhs_app（普通应用角色） | ❌                     | ❌（触发器+授权双重） | ✅（RLS 限租户）                  | ❌ `permission denied`     |
| beaconhs_super / backup      | ❌（backup 只读业务）  | ❌                    | 按 runtime grants                 | ❌                         |
| audit_service（登录态）      | ❌（直读被拒）         | ❌                    | ❌                                | ✅ 仅事务内 SET LOCAL ROLE |
| audit_reader（切换后）       | ✅ 全租户（BYPASSRLS） | ❌                    | ❌（information_schema 矩阵证明） | 不适用                     |

## 5. 真实 PostgreSQL 测试（非 Mock）

### 5.1 自动化：`packages/db/src/audit-role-preflight.test.ts`

临时 `postgres:16-alpine` 容器（skip-if-no-docker），17 用例全部通过：

- **权限矩阵**：service 事务内 `SET LOCAL ROLE audit_reader` 跨租户读 audit_log 2 行（BYPASSRLS 证明）；无角色切换直读被拒；INSERT/UPDATE/DELETE 被拒；读 `incidents`/`tenants` 被拒；app 角色执行 `SET ROLE audit_reader` 被拒；RLS 回归（app 读 0/1 行正确）。
- **属性断言正路径** + 5 个负路径（角色缺失→提示 provision；LOGIN 化→NOLOGIN；失 BYPASSRLS→BYPASSRLS；意外成员 beaconhs_app；reader 成员非唯一；service 得 owner 成员）。
- **表权限断言** 正路径 + 4 个负路径（业务表 SELECT；audit_log INSERT；缺 SELECT；service 被直接授权）。
- **converge 自愈**：故意 REVOKE 后收敛恢复。

命令：`pnpm --filter @beaconhs/db exec vitest run src/audit-role-preflight.test.ts` → **17/17，退出码 0**。

### 5.2 端到端（本地隔离库 5433）

- re-provision：`PROVISION_EXIT=0`；`pg_roles` 实测 `audit_reader | f | t`（NOLOGIN/BYPASSRLS）、`audit_service | t | f`、唯一成员关系、audit_log SELECT=t。
- `pnpm db:migrate` 全流程 ✔（preflight `audit roles verified` → RLS 191 tables → grants → `audit privilege matrix verified` → … → views）。
- **fail-closed 实证**：`DROP ROLE audit_reader` 后迁移 **退出码 1**，错误：
  `Audit role preflight failed: audit_reader/audit_service missing. Re-run scripts/cluster/provision...`
  重建角色后迁移恢复正常。

## 6. 门禁（每项独立退出码）

| 门禁      | 命令                  | 退出码 | 结果                                                 |
| --------- | --------------------- | ------ | ---------------------------------------------------- |
| format    | `pnpm format:check`   | 0      | All matched files OK                                 |
| typecheck | `pnpm typecheck`      | 0      | —                                                    |
| lint      | `pnpm lint`           | 0      | —                                                    |
| test      | `pnpm test`           | 0      | db 558 passed/41 skipped；web 2259 passed/13 skipped |
| deadcode  | `pnpm deadcode:check` | 0      | —                                                    |
| build     | `pnpm build`          | 0      | 4 tasks                                              |

## 7. 生产授权边界（本阶段未执行）

- 生产创建 `audit_reader`/`audit_service` 属生产数据库变更，**须用户单独批准**，SQL 即本仓 `provision.sql`（幂等、密码经 `psql -v` 注入）。
- 迁移流程已内建断言：生产执行 migration 时若角色未建/属性漂移/权限越界，**部署自动中止**——V3 §3"实施前留证阻断"第 1 项由此关闭。

## 8. 风险与移交

- R-1 缓解落地：`audit_reader` 成员资格被迁移流程每次执行断言（恰为 audit_service，永不含 app/owner）。
- `audit_service` 密码尚未在任何环境登记为正式凭据；P-2 的 `AUDIT_DATABASE_URL` 将以 `audit_service` 为登录主体，密码注入方式在 P-2/部署阶段定稿。
- 无遗留：无临时容器、无未使用导出（deadcode=0）。

**P-1 门禁：PASS → 进入 P-2（独立 AUDIT_DATABASE_URL 连接路径）。**
