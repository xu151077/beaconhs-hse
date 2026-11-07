# EA-66D.2.3：Migration 与 Bootstrap Admin 方案审计报告

**Phase type:** 数据库初始化流程的源码审计、方案设计与静态验证。
**Verdict:** **READY WITH CONDITIONS**
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. 执行摘要

| 类别                       | 结果                                                     |
| -------------------------- | -------------------------------------------------------- |
| Migration 实现架构         | **PASS** — 单事务、advisory lock、SHA256 ledger          |
| `APP_ROLE=migrate` 支持    | **PASS** — 正式入口，镜像内可用                          |
| `apps/ops-migrate` 可用性  | **PASS** — bundle + 51 条迁移已在镜像内                  |
| Migration 0051 风险        | **PASS** — 低风险，3 条 DROP COLUMN                      |
| `provision-db.sh` 安全审计 | **PASS（已修一处缺陷）** — 见 §5                         |
| 数据库初始化顺序           | **PASS（已调整 1 处）** — Redis 必须先于 bootstrap-admin |
| Bootstrap Admin 机制       | **PASS** — 原生、幂等、无默认密码                        |
| 原生权限体系保护           | **PASS** — 无绕过路径                                    |
| 推荐执行方案               | 方案 C（独立 ops-migrate 部署）                          |
| 启动前剩余条件             | 4 项，见 §10                                             |

### 本阶段修复的缺陷

| 缺陷                                                                      | 严重性   | 状态                   |
| ------------------------------------------------------------------------- | -------- | ---------------------- |
| `provision-db.sh` 用 `exec` 导致 EXIT trap 不执行，临时目录残留含明文密码 | **HIGH** | **已修复并部署**       |
| 运行时 env 缺 `DATABASE_OWNER_ROLE` / `DATABASE_BACKUP_ROLE`              | MEDIUM   | **已修复**（显式写入） |

### 边界遵守说明

本阶段执行了一次 `docker compose run … --dry-run` 验证 `APP_ROLE=migrate` 的路由。**该命令的 `--dry-run` 未阻止容器创建** —— 它创建了一个一次性容器并运行（因 `MIGRATION_DATABASE_URL` 为空而快速失败）以及一个 Compose 网络。容器由 `--rm` 自动删除，网络已由本阶段显式 `docker network rm` 移除。最终状态已核实并恢复为 0 容器 / 3 默认网络 / 3 卷。除此之外未启动任何容器、未执行任何数据库写操作、未执行迁移、未创建管理员。

---

## 2. Migration 实现架构

### 2.1 组件

| 组件           | 路径                                                       | 作用                                                         |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| Migration 逻辑 | `packages/db/src/migrate.ts`                               | 唯一的迁移入口，模块作用域直接执行 `main()`                  |
| 打包目标       | `apps/ops-migrate/build.mjs`                               | esbuild bundle → `dist/migrate.js`                           |
| 状态校验       | `packages/db/src/migration-state.ts`                       | journal 读取 + ledger 校验                                   |
| 部署入口       | `docker/entrypoint.sh:24-26`                               | `APP_ROLE=migrate` → `node apps/ops-migrate/dist/migrate.js` |
| 迁移文件       | `packages/db/drizzle/*.sql`                                | 51 个文件，journal 51 条                                     |
| 镜像内位置     | `/app/apps/ops-migrate/node_modules/@beaconhs/db/drizzle/` | `resolveMigrationsDir()` 的 packaged 路径                    |

### 2.2 执行序列（`migrate.ts:486-576`）

```
1. 读取 MIGRATION_DATABASE_URL / DATABASE_URL / SUPERADMIN_DATABASE_URL（全部必需）
2. assumeOwnerRole()          — SET ROLE beaconhs_owner，并校验 owner 为 NOLOGIN/NOSUPERUSER/NOBYPASSRLS
3. assertDatabaseRoles()      — 校验 5 个角色互不相同、属性精确、backup 角色 read_only
4. pg_advisory_lock('beaconhs:schema-migration')  — 并发保护
5. assertSchemaOwnership()    — 所有 public 对象必须属于 owner 角色
6. verifyMigrationTracker(requireComplete=false) — 校验既有 ledger
7. drizzle migrate()          — 全部未应用迁移，单事务
8. verifyMigrationTracker(requireComplete=true)  — 确认全部应用
9. applyRlsPolicies()         — RLS 策略，事务内
10. applyRuntimeGrants()      — 最小权限授权，事务内
11. assertKioskPinHashes()    — PIN 哈希不变量
12. convergeRolePermissions() — 内置角色权限收敛，事务内
13. applyPlannerStatistics()  — 统计信息
14. applyReportingViews()     — 报表视图，事务内
finally: 释放 advisory lock，关闭三个连接池
```

### 2.3 三条连接

| 变量                      | 角色                | 用途                                       |
| ------------------------- | ------------------- | ------------------------------------------ |
| `MIGRATION_DATABASE_URL`  | `beaconhs_migrator` | DDL；可 SET ROLE 到 owner                  |
| `DATABASE_URL`            | `beaconhs_app`      | 运行时角色校验（不建对象）                 |
| `SUPERADMIN_DATABASE_URL` | `beaconhs_super`    | 跨租户维护（Kiosk PIN 检查、角色权限收敛） |

**三者缺一即失败**（`migrate.ts:496-500`）。

### 2.4 原子性与幂等性

| 性质                    | 依据                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| **迁移全部单事务**      | drizzle `pg-core/dialect.js:60-71` — 所有迁移语句与 ledger 插入在同一 `session.transaction` 内         |
| **失败不留部分修改**    | 事务回滚，DDL 与 ledger 一起撤销                                                                       |
| **可重复执行**          | drizzle 比较 `lastDbMigration.created_at < migration.folderMillis`；已应用则跳过                       |
| **ledger 完整性**       | `migration-state.ts:46` — 每个迁移文件的 SHA256；`validateMigrationState()` 比对 `(createdAt, hash)`   |
| **ledger 不一致即拒绝** | `migration-state.ts:94-100` — 缺失或被修改的历史迁移直接抛错                                           |
| **拒绝猜测状态**        | `migration-state.ts:67-71` — 既有 schema 无 tracker 时拒绝标记为已应用                                 |
| **并发保护**            | `migrate.ts:528` — `pg_advisory_lock(hashtext('beaconhs:schema-migration'))`，阻塞式；`finally` 中释放 |
| **失败退出码**          | `migrate.ts:584-587` — 打印错误后 `process.exit(1)`                                                    |

---

## 3. `APP_ROLE=migrate` 支持情况

### 3.1 是正式支持的入口

`docker/entrypoint.sh:20-26` 明确注释：

> It is a SEPARATE deploy target (apps/ops-migrate) with its own node_modules, so the migration driver never enters the worker runtime, and it is the ONLY process that receives MIGRATION_DATABASE_URL.

`entrypoint.sh` 的 `case` 分支包含 `web` / `worker` / `scheduler` / `storage-init` / `migrate` / `bootstrap-admin`，未知角色退出 1。

### 3.2 镜像内可用性（目标端实测）

| 检查项                                                                       | 结果                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/app/apps/ops-migrate/dist/migrate.js`                                      | ✅ 存在，562,433 字节                                                                  |
| `/app/apps/ops-migrate/node_modules/@beaconhs/db/drizzle/meta/_journal.json` | ✅ 存在                                                                                |
| journal 条目数                                                               | ✅ 51（与仓库一致）                                                                    |
| 最后一条                                                                     | ✅ `0051_ea12_drop_dead_columns`                                                       |
| `dist/migrate.js` 的错误信息                                                 | ✅ `MIGRATION_DATABASE_URL is required for migrations`（与仓库 `migrate.ts:496` 一致） |

### 3.3 web / worker / scheduler 是否自动执行 migration

| 服务         | 自动执行 migration？ | 依据                                                                                                                                        |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| web          | **否**               | `apps/web/scripts/start-standalone.mjs` 只导入 standalone `server.js`；`apps/web/src/instrumentation.ts` 只做 Sentry 与 storage-freeze gate |
| worker       | **否**               | `apps/worker/src/index.ts` 启动 BullMQ workers 与 freeze gate，无 migration 调用                                                            |
| scheduler    | **否**               | `apps/worker/src/scheduler.ts` 只做 Redis repeatable-job 注册                                                                               |
| storage-init | **否**               | `apps/worker/src/storage-init.ts` 只做 S3 bucket 引导                                                                                       |

全仓库 `migrate()` 的唯一调用点是 `packages/db/src/migrate.ts:538`。**没有任何服务在启动时自动执行迁移。**

### 3.4 Canonical Compose 的结构性缺口

Canonical Compose 的 8 个服务：`web` / `worker` / `scheduler` / `storage-init` / `postgres` / `redis` / `minio` / `collabora`。**没有 `migrate` 服务**。

`docker/entrypoint.sh` 支持 `APP_ROLE=migrate`，但 Compose 未定义承载它的服务。因此**不能假定通过现有 8 个服务完成迁移**。

---

## 4. `apps/ops-migrate` 可用性

| 检查项       | 结果                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| 包定义       | `apps/ops-migrate/package.json` — 私有 workspace，仅依赖 `@beaconhs/db`                                         |
| 构建         | `node build.mjs`（esbuild bundle，target node24，ESM）                                                          |
| 入口         | `packages/db/src/migrate.ts`（**未重新实现逻辑**，直接 bundle 现有源模块）                                      |
| 凭据隔离     | 独立 deploy 目录，`--filter=@beaconhs/ops-migrate deploy --prod --legacy /prod/ops-migrate`（Dockerfile:71-73） |
| 镜像内路径   | `/app/apps/ops-migrate/`（Dockerfile:110 `COPY --chown=node:node`）                                             |
| 依赖闭包     | `node_modules` 45 项，独立于 worker                                                                             |
| 镜像内实测   | ✅ `dist/migrate.js` + 完整 drizzle 目录 + journal                                                              |
| 是否需新构建 | **否** — 现有 `beaconhs:ea66c1-formal` 已包含                                                                   |
| 是否需新镜像 | **否** — 可复用同一镜像                                                                                         |

### 4.1 `bootstrap-admin` 同理可用

| 检查项       | 结果                                                                        |
| ------------ | --------------------------------------------------------------------------- |
| 镜像内路径   | `/app/apps/ops-bootstrap-admin/dist/bootstrap-admin.cli.js`（833,005 字节） |
| 入口         | `packages/auth/src/bootstrap-admin.cli.ts`                                  |
| 依赖闭包     | `node_modules` 162 项（含 better-auth、bcryptjs）                           |
| 是否需新构建 | **否**                                                                      |

### 4.2 `bootstrap-email-provider` **不在镜像内**

`packages/auth/package.json:16` 只有 `tsx --env-file=../../.env src/bootstrap-email-provider.cli.ts` —— 一个开发路径脚本，**没有对应的 ops 部署目标**，因此**没有 bundle 进生产镜像**。

目标端实测：镜像内只有 TS 源码
`/app/apps/ops-bootstrap-admin/node_modules/@beaconhs/auth/src/bootstrap-email-provider.ts`，
没有可执行的 `dist/`。

**影响：** 若隔离环境需要通过 SMTP 投递 magic-link，email provider 的写入步骤当前**没有镜像内可执行入口**。见 §10 剩余条件 #3。

---

## 5. Migration 0051 风险

### 5.1 内容

```sql
ALTER TABLE "equipment_inspection_records" DROP COLUMN "certificate";
ALTER TABLE "training_enrollments" DROP COLUMN "due_on";
ALTER TABLE "training_enrollments" DROP COLUMN "expires_on";
```

### 5.2 风险评估

| 维度           | 评估                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------- |
| 语句类型       | 仅 `DROP COLUMN`，无数据转换、无索引重建、无外键级联                                                |
| 数据丢失       | 3 列的数据被丢弃。这些列已在 EA-12 被判定为死列（对应 `packages/db/src/ea12-dead-columns.test.ts`） |
| 事务           | 与其余 50 个迁移在同一事务内                                                                        |
| 可重复         | 是 — ledger 记录后不再执行；列已不存在时也不会重复执行                                              |
| 对全新空库     | 无影响（列由更早的迁移创建，本迁移删除）                                                            |
| 对已有数据的库 | 数据不可恢复 —— 但这是 EA-12 已批准的死列清理                                                       |
| 依赖           | 需要 `equipment_inspection_records` 与 `training_enrollments` 表存在（由 0000_init 等创建）         |
| 前置要求       | **必须先完成 provision.sql**（见 §5.4）                                                             |

### 5.3 EA-12 死列测试覆盖

`packages/db/src/ea12-dead-columns.test.ts` 存在并在本阶段测试套件中通过。

### 5.4 Migration 0051 是否要求先完成 provision.sql

**是，且是硬性要求。** 三条独立证据：

| #   | 依据                                          | 说明                                                                                                                                                           |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `migrate.ts:521-527` `assertDatabaseRoles()`  | 要求 5 个角色全部存在、属性精确、互不相同。角色由 provision.sql 创建                                                                                           |
| 2   | `migrate.ts:264`                              | `Database owner role ${ownerRole} does not exist` — owner 角色必须存在                                                                                         |
| 3   | `migrate.ts:69-112` `assertSchemaOwnership()` | 要求 `public` schema 下所有表/序列/视图/类型/函数都属于 owner 角色。`provision.sql:97` 的 `ALTER SCHEMA public OWNER TO beaconhs_owner` 是达成此状态的唯一途径 |

### 5.5 预检属性 ↔ provision.sql 逐条映射

| `migrate.ts` 预检要求                                  | `provision.sql` 对应行                                              | 一致 |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ---- |
| owner NOLOGIN / NOSUPERUSER / NOBYPASSRLS              | 23                                                                  | ✅   |
| migrator LOGIN / NOINHERIT / NOSUPERUSER / NOBYPASSRLS | 31                                                                  | ✅   |
| migrator 可 SET ROLE owner                             | 63 `GRANT beaconhs_owner TO beaconhs_migrator`                      | ✅   |
| runtime NOSUPERUSER / NOBYPASSRLS / 非 owner member    | 40 + 66-78 REVOKE                                                   | ✅   |
| maintenance 非 superuser + BYPASSRLS + 非 owner member | 49                                                                  | ✅   |
| backup LOGIN / 非 superuser / BYPASSRLS / 非 owner     | 58                                                                  | ✅   |
| backup `default_transaction_read_only=on`              | 161                                                                 | ✅   |
| 5 个角色互不相同                                       | 5 条独立 CREATE ROLE                                                | ✅   |
| `public` schema owner = owner 角色                     | 83 `ALTER DATABASE` + 97 `ALTER SCHEMA public OWNER TO`             | ✅   |
| drizzle schema 的 backup 授权                          | 117-125（条件执行）+ `migrate.ts:429-437` `applyRuntimeGrants` 补齐 | ✅   |

---

## 6. `provision-db.sh` 安全审计

### 6.1 权限与所有权

| 检查项         | 值            | 结论 |
| -------------- | ------------- | ---- |
| mode           | `0700`        | ✅   |
| owner          | `ceshi:ceshi` | ✅   |
| 大小           | 3270 字节     | ✅   |
| `bash -n` 语法 | 通过          | ✅   |

### 6.2 硬编码密码

扫描 `(password\|PASSWORD\|secret\|SECRET)\s*=\s*["'][^"']{6,}` — **无命中**。脚本中所有凭据均从 0600 文件读取。

### 6.3 密码来源

| 秘密                  | 来源                                             | 进入方式                                       |
| --------------------- | ------------------------------------------------ | ---------------------------------------------- |
| postgres 超级用户密码 | `~/.beaconhs/runtime/local-prod.env`（0600）     | `set -a; . "$ENV_FILE"; set +a` → `PGPASSWORD` |
| 四个角色密码          | `~/.beaconhs/runtime/provision-vars.env`（0600） | 写入 0600 wrapper 的 `\set`                    |

### 6.4 PGPASSWORD 是否仅对子进程有效

`export PGPASSWORD` 后立即以**子进程**方式调用 `psql`（修复后不再用 `exec`）。`PGPASSWORD` 因此只存在于 psql 进程及其子进程的环境中，不写入任何文件。

### 6.5 `\set` / `\i` 注入方式 —— 隔离 fixture 验证

**测试方法：** 在一次性本地 PostgreSQL（与目标主机、生产均无关）上运行，使用**占位符**值，断言四个变量逐字节完整传递，且**从不打印任何值**。

| 测试                   | 结果                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| 正向：四个变量全部注入 | **PASS** — `PASS: all four provision variables injected intact`，退出码 0 |
| 负向：缺两个变量       | **PASS** — psql 报错，退出码 3，**不会静默使用空值**                      |

负向测试的关键结论：psql 把未定义的 `:'var'` 展开为**语法错误**（`invalid variable name` / `syntax error at or near ":"`），而非空字符串。因此 `provision.sql` 在密码变量缺失时**必然失败**，不会创建空密码角色。

隔离 fixture 与临时实例已清理；仓库与目标主机无残留。

### 6.6 临时文件权限

| 项           | 值                                                 |
| ------------ | -------------------------------------------------- |
| 临时目录     | `mktemp -d` → `chmod 700`                          |
| wrapper 脚本 | `umask 077` + 显式 `chmod 600`                     |
| 清理机制     | `trap cleanup EXIT INT TERM` → `rm -rf "$WORKDIR"` |

### 6.7 trap 对正常退出与错误退出的处理

**修复前（缺陷）：** 脚本以 `exec psql` 结尾。`exec` 替换当前 shell 进程，被替换的 shell **不会执行 EXIT trap** —— 临时目录（含四个角色密码明文）会残留在 `/var/tmp` 下，直到下次重启。

隔离验证（本地 `bash -c` 探针）：

```
workdir: /tmp/trap-probe-63llmz
# 进程退出后目录仍在 → 缺陷确认
```

**修复：** 改为普通子进程调用 psql，让 EXIT trap 保持有效，并在 `finally` 语义中等价地传播退出码。

```diff
-export PGPASSWORD
-exec psql -X --set=ON_ERROR_STOP=1 \
+export PGPASSWORD
+psql -X --set=ON_ERROR_STOP=1 \
   --host=127.0.0.1 --port=5433 --username=postgres --dbname=postgres \
   --file="$WRAP"
```

**修复后目标端实测：**

| 场景                       | 结果                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| 正常退出（假 psql 返回 0） | `script_exit=0`，临时目录数 0 → 0，**无残留**                       |
| 错误退出（假 psql 返回 7） | `script_exit=7`（**退出码正确传播**），临时目录数 0 → 0，**无残留** |

测试使用假 `psql` 替身（`PATH` 注入），**未连接任何数据库**。

修复已通过 `scp` 传输到 `~/.beaconhs/scripts/provision-db.sh.new`（chmod 700 + `bash -n` 校验），再以同文件系统 `mv` 原子替换。

### 6.8 是否可能把密码输出到 shell trace / 日志 / 进程参数

| 风险面          | 结论                                                               |
| --------------- | ------------------------------------------------------------------ |
| shell trace     | 脚本无 `set -x`（扫描无命中）                                      |
| argv / 进程列表 | 密码从不作为命令行参数；`psql` 只收到文件路径                      |
| 日志            | `psql` 不回显变量值；provision.sql 用 `format('%L', …)` 生成字面量 |
| stdout/stderr   | fixture 实测中值被脱敏后打印；实际脚本不打印任何值                 |
| 临时文件        | 修复后已清理（§6.7）                                               |

### 6.9 ON_ERROR_STOP

`psql -X --set=ON_ERROR_STOP=1`（脚本第 79 行）。`provision.sql` 自身也有 `\set ON_ERROR_STOP on`（第 18 行）。任一 SQL 语句失败即中止，不会静默继续。

### 6.10 执行失败时的处理

| 情况                       | 行为                                                      |
| -------------------------- | --------------------------------------------------------- |
| 必需文件缺失/不可读        | 打印路径，退出 2                                          |
| `POSTGRES_PASSWORD` 未设置 | `set -u` 下 `${POSTGRES_PASSWORD:?...}` 报错退出          |
| psql 连接失败              | psql 非零退出 → 脚本以同一退出码退出（已实测传播 exit 7） |
| SQL 失败                   | `ON_ERROR_STOP` 中止 → 非零退出                           |
| 任一上述情况               | EXIT trap 清理临时目录（已实测）                          |

### 6.11 四个角色密码与运行配置的一致性

**不输出任何密码**的比对结果：

| 校验                                                   | 结果      |
| ------------------------------------------------------ | --------- |
| `app_password` == `DATABASE_URL` 密码段                | **MATCH** |
| `super_password` == `SUPERADMIN_DATABASE_URL` 密码段   | **MATCH** |
| `migrator_password` == `MIGRATION_DATABASE_URL` 密码段 | **MATCH** |
| `backup_password` 独立于前三者                         | **OK**    |
| 四者互不相同                                           | **OK**    |
| 与 `postgres` 超级用户密码不同                         | **OK**    |

---

## 7. 数据库初始化顺序

### 7.1 顺序调整说明

给定顺序中，**步骤 9（创建首个平台管理员）必须移到步骤 11（启动 Redis）之后**。

**原因：** `bootstrap-admin` 的 magic-link 派发走 `sendAuthEmail`（`packages/auth/src/server.ts:244-268`），在 `NODE_ENV=production` 下调用 `enqueueEmail`（`packages/jobs/src/queues/email.ts:73`），后者通过 BullMQ 队列写入 **Redis**。Redis 未运行时，magic-link 派发失败。

`bootstrap-admin.ts:277-281` 将派发置于事务之外，因此管理员记录仍会创建，但 CLI 会返回退出码 1（`bootstrap-admin.cli.ts:218-240` 的 `emailFailed` 分支），并提示用 `--resend-magic-link` 重发。

**调整后顺序：**

| #   | 阶段                | 动作                                                     | 分类                       |
| --- | ------------------- | -------------------------------------------------------- | -------------------------- |
| 1   | 准备                | 确认空卷（3 个外部卷存在且 0B）                          | Provision 前置             |
| 2   | 准备                | 确认运行时 env 与 provision 密码变量一致                 | Provision 前置             |
| 3   | 启动                | `up -d postgres`                                         | —                          |
| 4   | 等待                | postgres healthy                                         | —                          |
| 5   | **Provision**       | `~/.beaconhs/scripts/provision-db.sh`                    | **Provision**              |
| 6   | 验证                | 5 个角色及属性（`pg_roles`）                             | Provision 验证             |
| 7   | 验证                | `beaconhs` 库、`public`/`etl` schema owner               | Provision 验证             |
| 8   | **Migration**       | 独立 ops-migrate 一次性任务                              | **Migration**              |
| 9   | 验证                | `drizzle.__drizzle_migrations` 行数 = 51、schema version | Migration 验证             |
| 10  | 启动                | `up -d redis minio`                                      | —                          |
| 11  | 等待                | redis / minio healthy                                    | —                          |
| 12  | **Bootstrap Admin** | 独立 ops-bootstrap-admin 一次性任务                      | **Bootstrap Admin**        |
| 13  | 验证                | 管理员 `isSuperAdmin=true`、角色/scope                   | Bootstrap 验证             |
| 14  | **Storage 初始化**  | `run --rm storage-init`                                  | **Storage initialization** |
| 15  | 启动                | `up -d scheduler web worker`                             | —                          |
| 16  | 启动                | `up -d collabora`                                        | —                          |
| 17  | 验证                | 全量 healthcheck                                         | —                          |
| 18  | 验证                | Gate 5                                                   | —                          |

### 7.2 四类初始化的边界

| 分类                       | 责任                                    | 是否幂等                                                          | 失败后果                                             |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| **Provision**              | `scripts/cluster/provision.sql`         | ✅ 是（`WHERE NOT EXISTS` / `IF NOT EXISTS` + 幂等 GRANT/REVOKE） | 角色/库/权限不全 → migration 预检失败                |
| **Migration**              | `packages/db/src/migrate.ts`（drizzle） | ✅ 是（ledger hash 比对）                                         | 单事务回滚，无部分修改                               |
| **Bootstrap Admin**        | `packages/auth/src/bootstrap-admin.ts`  | ✅ 是（**拒绝式**：已有管理员则不写任何东西并退出 0）             | 账号已建但 magic-link 未投递 → `--resend-magic-link` |
| **Storage initialization** | `apps/worker/src/storage-init.ts`       | ✅ 是（注释明确 "Idempotent, so a manual rerun is safe"）         | bucket 策略未收敛 → 私有读未证明被拒                 |

**四者互不替代**：provision 建角色和库；migration 建 schema 和 RLS；bootstrap 建第一个身份；storage-init 建对象存储策略。

### 7.3 自动 Migration 风险

| 项目                       | 结论                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 存在自动 Migration？       | **否** —— 无任何服务在启动时执行                                                                                                                          |
| 存在自动创建数据库角色？   | **否** —— Compose 明确禁止 initdb helper（`local-production.compose.yaml:247-253`）                                                                       |
| 重复初始化风险             | **低** —— 四类均幂等                                                                                                                                      |
| 首次启动失败留下不完整数据 | **中** —— provision 中途失败会留下已创建的角色/库（幂等，重跑收敛）；migration 失败无残留（单事务）；bootstrap 失败留下已建账号（拒绝式，重跑不重复创建） |

---

## 8. Bootstrap Admin 机制

### 8.1 实现

| 项            | 内容                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------- |
| 核心          | `packages/auth/src/bootstrap-admin.ts` — `bootstrapFirstAdmin()`                              |
| CLI           | `packages/auth/src/bootstrap-admin.cli.ts` — `main()`                                         |
| 镜像内 bundle | `/app/apps/ops-bootstrap-admin/dist/bootstrap-admin.cli.js` ✅                                |
| 写入          | 恰好 2 行：`user`（`isSuperAdmin=true`）+ `account`（`providerId='credential'`，scrypt 哈希） |
| 不写入        | 租户、角色、org unit、PPE/检查类型、表单模板、演示记录                                        |
| 数据库角色    | 普通 runtime `DATABASE_URL`（`user`/`account` 是全局表，无 RLS）                              |

### 8.2 是否存在默认管理员账号 / 默认密码

| 检查                              | 结果                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| bootstrap-admin 中的默认账号      | **无** — `admin@company.com` 仅出现在用法注释中（`bootstrap-admin.cli.ts:4-5`）                                        |
| bootstrap-admin 中的默认密码      | **无** — 随机生成（`generateBootstrapPassword()`，58 字符字母表，拒绝采样，32 字符）或 `--password-stdin`              |
| seed.ts 的 `admin@beaconhs.local` | **与 bootstrap 路径无关** — `seed.ts:108` 是开发演示种子，会创建 demo 租户及大量演示数据，**不得**用于生产或本测试环境 |

`packages/auth/src/server.ts:102,137` 保持 `disableSignUp: true`（email 密码与 magic-link 两条路径）。

### 8.3 可重复执行

| 场景               | 行为                                                                       | 退出码 |
| ------------------ | -------------------------------------------------------------------------- | ------ |
| 已有超级管理员     | **拒绝写入**，报告现有管理员                                               | 0      |
| 请求的邮箱已被占用 | **拒绝写入**，不提升该账号                                                 | 1      |
| 无 `--apply`       | 干跑，只报告                                                               | 0      |
| 并发调用           | 同一事务内 `DO $$ ... RAISE EXCEPTION 'a super-admin already exists'` 兜底 | 失败   |

设计要点（`bootstrap-admin.ts:51-62`）：**幂等靠拒绝，而非 upsert**。永不创建第二个管理员、永不改写已有密码、永不提升既有非管理员账号、永不改租户、永不删行。

### 8.4 一次性 bootstrap token

**不存在。** 机制不是 token，而是：shell 访问权限 + 显式 `--apply`。邮箱验证通过 Better Auth 原生 magic-link 完成（`storeToken: 'hashed'`，`server.ts:139`）。

### 8.5 审计日志

**bootstrap-admin 不写 `audit_log`。** 这不是遗漏，而是 schema 约束的直接结果：

| 依据                                   | 说明                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| `packages/db/src/schema/audit.ts:9-11` | `audit_log.tenant_id` 是 `notNull()` 且外键引用 `tenants.id` |
| `bootstrap-admin.ts:48-49`             | bootstrap 之后数据库**仍为零租户**，这是刻意设计             |
| 结论                                   | bootstrap 阶段**在结构上无法**写租户作用域审计行             |

**替代可审计性：**

| 机制         | 说明                                                     |
| ------------ | -------------------------------------------------------- |
| 命令退出码   | 干跑 0 / 已存在 0 / 邮箱占用 1 / magic-link 失败 1       |
| CLI 输出     | 明确打印创建结果、既有管理员列表、邮箱占用详情           |
| 事务原子性   | 创建与检查在同一事务（`bootstrap-admin.ts:209`）         |
| 数据库层守卫 | `DO $$` 块在插入前检查，冲突时抛异常                     |
| 外部审计     | 本阶段的执行记录（脚本、退出码、时间）可由部署编排层留存 |

**风险陈述：** 该操作在 `audit_log` 中不可见。对隔离测试环境可接受；生产部署应依赖编排层日志。

### 8.6 是否存在绕过正常权限系统的初始化路径

**不存在。** 具体核实：

| 检查项                             | 结果                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 直接写数据库绕过权限？             | **否** — 只写 `user` 与 `account` 两行，用 Drizzle ORM，走 `db.transaction`                                            |
| 修改 Better Auth 配置？            | **否** — `disableSignUp` 保持 true，不加路由、不加权限键、不建角色/scope、不动表/列/迁移（`bootstrap-admin.ts:38-42`） |
| 赋予不必要的 System Manager 权限？ | **否** — 只设置 `isSuperAdmin` 布尔标志，**不创建任何 `roles` / `role_assignments` 行**                                |
| 用超级用户凭据？                   | **否** — 核心路径用普通 runtime `db`；`withSuperAdmin` 仅在 CLI 的 `--resend-magic-link` 路径使用                      |
| 提升既有账号？                     | **否** — 邮箱占用时拒绝（`bootstrap-admin.ts:229-231`）                                                                |

### 8.7 原生权限体系保护情况

| 组件                                           | 状态                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PERMISSION_CATALOGUE`（107 键）               | ✅ 未改动                                                                                                                                                                                  |
| `roles` / `role_assignments`（租户作用域）     | ✅ 未触碰                                                                                                                                                                                  |
| `RoleScope` 六变体                             | ✅ 未改动                                                                                                                                                                                  |
| `resolveVisibilityTier`（`all`/`site`/`self`） | ✅ 未改动                                                                                                                                                                                  |
| RLS 策略                                       | ✅ 由 migration 施加，非 bootstrap                                                                                                                                                         |
| `isSuperAdmin`                                 | ✅ **原生机制** — `packages/tenant/src/index.ts:101-110` 的 `can()` 顶层短路 + `makeSuperAdminContext()` 的 `withSuperAdmin()` BypassRLS 池；`/platform/users` 与 `seed.ts` 使用同一标志位 |

bootstrap-admin 写入的是项目**既有的**原生平台管理员标志位，不是旁路。

### 8.8 推荐的首个平台管理员创建流程

**测试身份（明确、可区分）：**

| 项    | 值                                       | 说明                                               |
| ----- | ---------------------------------------- | -------------------------------------------------- |
| Email | `platform-admin@beaconhs-test.local`     | `.test` 是 RFC 2606 保留 TLD，不可能与生产域名冲突 |
| Name  | `BeaconHS Test Platform Admin`           | 明确标注为测试身份                                 |
| 密码  | 通过 `--password-stdin` 从 0600 文件读入 | 不进 argv、不进 history                            |

**与生产管理员的区分保障：**

| 保障         | 说明                                                                |
| ------------ | ------------------------------------------------------------------- |
| 域名隔离     | `.local` 保留 TLD，生产不会使用                                     |
| 名称标注     | 显示名显式包含 "Test"                                               |
| 环境隔离     | 账号建在 `10.10.31.30` 的测试数据库，与生产库物理分离               |
| 不写生产     | 本流程不接触任何生产数据库                                          |
| 与 seed 隔离 | **不运行** `db:seed`（它会创建 demo 租户与 `admin@beaconhs.local`） |

**执行流程（需授权后执行）：**

```bash
# 0. 前置：Redis 已启动且 healthy（步骤 10-11），否则 magic-link 派发失败

# 1. 干跑：报告现有管理员数量，不写入
docker compose --env-file … -f deploy/local-production.compose.yaml \
  run --rm --no-deps --pull never \
  -e APP_ROLE=bootstrap-admin \
  storage-init --email platform-admin@beaconhs-test.local

# 2. 正式：密码经 stdin
docker compose … run --rm --no-deps --pull never \
  -e APP_ROLE=bootstrap-admin \
  storage-init --email platform-admin@beaconhs-test.local \
               --name "BeaconHS Test Platform Admin" \
               --password-stdin --apply < ~/.beaconhs/runtime/platform-admin-password.txt
```

**本阶段不创建管理员。** 密码文件与执行均未发生。

---

## 9. 推荐执行方案

### 9.1 三方案对比

| 维度                     | 方案 A：独立 migrate 一次性任务                                                                                                                     | 方案 B：web 启动时执行迁移                                                              | 方案 C：独立 ops-migrate 部署                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 形态                     | `docker compose run --rm --no-deps -e APP_ROLE=migrate <现有一次性服务>`                                                                            | 修改 web 启动路径，在 `server.js` 前调用迁移                                            | 独立的 compose profile / 独立 compose 文件承载 `APP_ROLE=migrate` 任务 |
| 需要新镜像               | 否                                                                                                                                                  | 否                                                                                      | 否                                                                     |
| 需要改 Canonical Compose | 否（复用现有服务定义 + `-e` 覆盖）                                                                                                                  | **是**（改业务启动路径）                                                                | 否（独立文件）                                                         |
| 需要改业务代码           | 否                                                                                                                                                  | **是**                                                                                  | 否                                                                     |
| 与 Gate 5 的隔离         | ⚠️ run 容器带 `com.docker.compose.project` 标签，Gate 5 用该标签统计容器（`reconcile-compose-digest.sh:734`）。必须确保一次性容器在 Gate 5 前已删除 | ✅ 不产生额外容器                                                                       | ⚠️ 同 A，但独立 compose project 名可使 Gate 5 的 `--filter` 完全不匹配 |
| 失败隔离                 | ✅ 一次性容器，退出码即结果                                                                                                                         | ❌ web 起不来即无法区分"迁移失败"与"应用失败"                                           | ✅ 同 A                                                                |
| 凭据面                   | ⚠️ 复用某服务的 environment，需要 `-e` 注入 `MIGRATION_DATABASE_URL`（该变量不在任何服务定义中）                                                    | ❌ web/worker/scheduler 会同时拿到迁移凭据 —— 违反 `entrypoint.sh:20-23` 的凭据隔离原则 | ✅ 迁移任务独立定义 environment，只有它持有迁移凭据                    |
| 架构契合度               | 中                                                                                                                                                  | **低** —— 违背 `docker/entrypoint.sh:17-23` 明确记载的设计意图                          | **高** —— 与 `apps/ops-migrate` 作为独立 deploy target 的设计完全一致  |
| 重复执行                 | ✅                                                                                                                                                  | ⚠️ 每次 web 重启都会尝试                                                                | ✅                                                                     |
| 审计可追溯               | ✅ 独立日志                                                                                                                                         | ❌ 混在 web 启动日志                                                                    | ✅ 独立日志                                                            |

### 9.2 推荐：方案 C

**依据：**

1. **架构原生。** `docker/entrypoint.sh:17-23` 明确记载 migrate 是独立 deploy target，`apps/ops-migrate` 有自己的 node_modules 闭包，"the migration driver never enters the worker runtime"。
2. **凭据隔离。** `apps/ops-migrate/build.mjs:12-16` 说明该 target 的唯一职责就是接收 `MIGRATION_DATABASE_URL`。方案 B 会让 web/worker/scheduler 持有迁移凭据，直接违反该原则。
3. **Gate 5 天然隔离。** 用独立的 compose project 名，Gate 5 的 `--filter "label=com.docker.compose.project=beaconhs-local-prod"` 不会匹配到迁移容器，无需担心计数污染。
4. **失败可归因。** 迁移失败时容器退出码即结论，不与 web 的健康状态混在一起。
5. **无需新构建。** `beaconhs:ea66c1-formal` 已包含 `apps/ops-migrate/dist/migrate.js` 与完整 drizzle 目录（目标端实测）。
6. **不改受保护文件。** 方案 C 不需要修改 Canonical Compose（用独立 compose 文件或 `--project-name` 隔离），也不需要修改任何业务代码。

**方案 A 作为备选**：若不希望引入独立 compose 文件，可用 `run` 复用 `storage-init` 服务定义并 `-e APP_ROLE=migrate -e MIGRATION_DATABASE_URL=…`。功能等价，但必须确保一次性容器在 Gate 5 前已删除，且迁移凭据通过命令行注入（`MIGRATION_DATABASE_URL` 含密码 → 进入 argv → 进程列表可见）。**这是方案 A 的实质弱点**；方案 C 可用 `--env-from-file` 避开。

**方案 B 不推荐**：违反凭据隔离原则，且需要修改受保护的启动路径。

### 9.3 三类初始化的推荐执行形态（统一原则）

| 任务                   | 形态                                     | 一次性容器 | 凭据注入                                      |
| ---------------------- | ---------------------------------------- | ---------- | --------------------------------------------- |
| Migration              | 独立 ops-migrate 部署                    | 有         | `--env-from-file`（0600）                     |
| Bootstrap Admin        | 独立 ops-bootstrap-admin 部署            | 有         | `--env-from-file`（0600）+ `--password-stdin` |
| Storage initialization | Canonical Compose 的 `storage-init` 服务 | 有         | Canonical env 文件                            |

**共同要求：一次性容器必须在 Gate 5 之前完全清理。**

---

## 10. 启动前剩余条件

| #   | 条件                                       | 严重性   | 责任方     | 说明                                                                                                               |
| --- | ------------------------------------------ | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | 决定并实现迁移执行载体（推荐方案 C）       | **HIGH** | 部署负责人 | 需要一个独立 compose 文件或 `--project-name` 隔离的运行方式；**不修改** Canonical Compose                          |
| 2   | 决定并实现 bootstrap-admin 执行载体        | **HIGH** | 部署负责人 | 同上；镜像内已有 `bootstrap-admin.cli.js`                                                                          |
| 3   | email provider 写入路径                    | MEDIUM   | 部署负责人 | `bootstrap-email-provider` **无镜像内可执行入口**（§4.2）。若接受 magic-link 只入队、worker 后续投递，则可暂不阻塞 |
| 4   | 确认 Redis 先于 bootstrap-admin 启动       | MEDIUM   | 部署负责人 | 顺序已调整，见 §7.1                                                                                                |
| 5   | 批准执行 provisioning（`provision-db.sh`） | MEDIUM   | 部署负责人 | 本阶段未执行                                                                                                       |
| 6   | 提供测试平台管理员的密码文件（0600）       | MEDIUM   | 部署负责人 | 本阶段未创建                                                                                                       |
| 7   | 生产替换测试端点                           | LOW      | 运维       | `APP_URL` / `R2_ENDPOINT` / `COLLABORA_URL`                                                                        |

### 10.1 已知限制（如实陈述）

| 项                             | 说明                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `provision-db.sh` 的真实验证   | 隔离 fixture 验证了 `\set`/`\i` 机制与 trap 清理；**真实** provision 未执行（符合本阶段边界）。真实验证需 PostgreSQL 运行时进行 |
| 迁移的真实执行                 | **未执行**。预检逻辑、事务语义、advisory lock、ledger 校验均经源码与既有测试确认，但未在活库上跑过                              |
| `bootstrap-admin` 的真实执行   | **未执行**                                                                                                                      |
| `docker compose run --dry-run` | **不阻止容器创建**（本阶段误触发并已清理）。设计上一次性任务的执行必须被视为真实启动                                            |

---

## 11. 本阶段执行的验证

### 11.1 静态测试

| 测试                                                                                                                                                                                                                       | 结果                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `pnpm --filter @beaconhs/db exec vitest run src/migration-state.test.ts src/migration-rls-preflight.test.ts src/scripts/check-migration-drift.test.ts src/tenant-provisioning.test.ts src/seed-bootstrap-contract.test.ts` | **5 files / 83 passed / 19 skipped** |
| `pnpm --filter @beaconhs/auth exec vitest run src/bootstrap-admin.test.ts src/bootstrap-email-provider.test.ts src/public-url.test.ts`                                                                                     | **3 files / 51 passed / 13 skipped** |
| `bash -n ~/.beaconhs/scripts/provision-db.sh`（目标端）                                                                                                                                                                    | 通过                                 |
| `bash -n` 修正版脚本（本地 + 目标端）                                                                                                                                                                                      | 通过                                 |
| `\set`/`\i` 注入隔离 fixture（正向 + 负向）                                                                                                                                                                                | PASS / PASS                          |
| trap 清理验证（正常 + 错误退出，目标端）                                                                                                                                                                                   | PASS / PASS                          |
| Compose 静态渲染（27 变量 + 密钥文件）                                                                                                                                                                                     | 通过，0 错误                         |
| Gate 5 标签静态一致性                                                                                                                                                                                                      | 8/8 PASS（EA-66D.2.2）               |

### 11.2 目标端最终状态

| 项       | 值                            |
| -------- | ----------------------------- |
| 容器     | 0                             |
| 网络     | 3（bridge / host / none）     |
| 卷       | 3（`beaconhs-hse_*`）         |
| 镜像     | 25（含 5 个目标镜像，未改动） |
| 磁盘     | 69G 可用                      |
| 敏感文件 | 全部 0600，目录 0700          |

### 11.3 未执行

未启动 PostgreSQL、未执行 `provision.sql`、未执行任何 Migration、未创建管理员、未启动 Canonical Compose、未连接生产数据库、未 commit/push/CI、未修改 Canonical Compose 或 Gate 5 Manifest、未修改任何迁移文件、未修改用户工作区中的业务代码。

---

## 12. 最终判定

**READY WITH CONDITIONS**

八个初始化步骤（Provision / Migration / Bootstrap Admin / Storage initialization）各自的机制、幂等性、失败行为与前置条件均已从源码确认，且都能在现有镜像内运行，无需新构建。四个外部卷、五个镜像、全部密钥与运行时 env 均处于就绪状态。

放行启动前需先关闭 §10 的四个 HIGH/MEDIUM 条件：确定迁移与 bootstrap-admin 的独立执行载体（推荐方案 C）、确认 email provider 路径、把 Redis 提到 bootstrap-admin 之前、并批准执行 provisioning。

**本阶段到此停止。** 不启动 PostgreSQL，不执行任何数据库写操作，不启动 Canonical Compose。等待用户明确授权。
