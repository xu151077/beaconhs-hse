# EA-66D.2.5：Redis 启动与独立 Migration 51 执行报告

**Phase type:** 隔离测试环境 Redis 启动与数据库 Migration 执行。
**Verdict:** **PASS**
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. 执行摘要

| 类别                 | 结果                                                             |
| -------------------- | ---------------------------------------------------------------- |
| 启动前复核           | **PASS** — 镜像 ID、卷、配置、密钥、生产端点全部核对通过         |
| Redis 单服务启动     | **PASS** — healthy，无 pull，无 build                            |
| Redis 认证验证       | **PASS** — PING→PONG，内网络 `redis:6379` 解析并响应             |
| Migration 执行前审计 | **PASS** — 路由、bundle、journal、预检、锁全部确认               |
| Migration 执行       | **PASS** — 退出码 0，51 条全部应用                               |
| Ledger 验证          | **PASS** — 51 行，51 个不同 hash，与文件 SHA256 **逐条匹配**     |
| Migration 51         | **PASS** — 三条 DROP COLUMN 完成，目标表完好                     |
| Schema 验证          | **PASS** — 197 表 / 191 RLS / 192 FORCE RLS / 14 视图            |
| 角色权限复核         | **PASS** — 五角色属性与 provision 后完全一致                     |
| 幂等性               | **PASS** — 复跑退出码 0，ledger 51/51 不变                       |
| 事务与锁释放         | **PASS** — advisory lock 0 持有者，0 idle-in-transaction，0 死锁 |
| 无管理员/租户        | **PASS** — `admins=0, total_users=0, tenants=0`                  |
| 生产隔离             | **PASS** — 仅 loopback，无生产端点                               |

---

## 2. 启动前复核

| 复核项                        | 期望                                                                      | 实测                    | 结果 |
| ----------------------------- | ------------------------------------------------------------------------- | ----------------------- | ---- |
| 主机                          | ceshi-Virtual-Machine / 10.10.31.30                                       | 一致                    | PASS |
| PostgreSQL 容器               | healthy                                                                   | healthy                 | PASS |
| PostgreSQL Image ID           | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` | 一致                    | PASS |
| Redis Image ID                | `sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499` | 一致                    | PASS |
| BeaconHS 镜像 Image ID        | `sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795` | 一致                    | PASS |
| `beaconhs-hse_redis-data`     | 存在且为空                                                                | 存在，**0 条目**        | PASS |
| Compose 文件 SHA256           | `9700f4805e7633cc44fc59c98d854ad9a7b8ddee82f7fa854539ec1e166082db`        | 一致                    | PASS |
| runtime env 权限              | 0600 / ceshi                                                              | 三个文件均 0600 / ceshi | PASS |
| Server Action Key fingerprint | `f61da7728f3065df58f9e89aec6985d6`                                        | 一致                    | PASS |
| 生产端点                      | 不存在                                                                    | 未发现                  | PASS |

### 2.1 数据库迁移前状态

| 检查             | 实测          | 判定                   |
| ---------------- | ------------- | ---------------------- |
| 用户表数量       | 0             | 纯净                   |
| schema 列表      | `etl, public` | 无 `drizzle`           |
| 非系统角色       | 5             | 与 provision 后一致    |
| `drizzle` schema | **不存在**    | 未执行过任何 Migration |
| `user` 表        | **不存在**    | 无 seed、无管理员      |

**无非预期业务数据，执行继续。**

---

## 3. Redis 启动及认证验证

### 3.1 渲染后的服务定义

| 项          | 值                                                        |
| ----------- | --------------------------------------------------------- |
| image       | `redis@sha256:858f009f9709ce57…`（digest 固定，本地存在） |
| ports       | `127.0.0.1:6380 → 6379`（仅 loopback）                    |
| volumes     | `redis-data` → `/data`（外部卷）                          |
| environment | **无**（无 `requirepass`）                                |
| healthcheck | `['CMD', 'redis-cli', 'ping']`                            |
| restart     | `unless-stopped`                                          |

### 3.2 执行命令

```bash
docker compose \
  --env-file ~/.beaconhs/runtime/local-prod.env \
  --env-file ~/.beaconhs/runtime/server-action-key.env \
  -f deploy/local-production.compose.yaml \
  -p beaconhs-local-prod \
  up -d --pull never --no-build redis
```

只启动 `redis` 一个服务，未拉取任何镜像，未构建。

### 3.3 容器身份

| 项            | 值                                                                        |
| ------------- | ------------------------------------------------------------------------- |
| Container ID  | `e347ed572c2ada46123fa8a04f82ace49df7a0b8f2da452b0891631dd954612d`        |
| Image（实际） | `sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499` |
| Config.Image  | `redis@sha256:858f009f9709ce57…`                                          |
| State         | running                                                                   |
| RestartCount  | 0                                                                         |
| Health        | **healthy**（第 1 次轮询即为 healthy）                                    |
| 端口          | `127.0.0.1:6380 → 6379/tcp`                                               |
| 挂载          | `beaconhs-hse_redis-data → /data`                                         |
| 网络          | `beaconhs-local-prod_default`（IP `172.18.0.3`）                          |

### 3.4 部署标签

| 标签                        | 值                                                                        |
| --------------------------- | ------------------------------------------------------------------------- |
| `com.beaconhs.deployment`   | `51a899b7aac0a942da327222a3eed355fca9798a-ea66d2-001`                     |
| `com.beaconhs.image-digest` | `sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499` |
| `com.beaconhs.role`         | `redis`                                                                   |

### 3.5 认证验证

| 检查                                 | 结果                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `redis-cli ping`（healthcheck 命令） | **PONG**                                                                             |
| `config get requirepass`             | **空** —— 未配置密码，与 Compose 无 environment、`REDIS_URL=redis://redis:6379` 一致 |
| 持久化目录 `/data`                   | 空（全新）                                                                           |
| 内网络 `redis-cli -h redis ping`     | **PONG**                                                                             |

**应用实际使用的连接配置已验证：** `REDIS_URL` 的主机名 `redis` 在 Compose 网络内可解析并响应 PONG，无密码、无 TLS，与配置一致。**未输出任何密码**（Redis 本就不设密码）。

---

## 4. Migration 任务镜像身份

| 项               | 值                                                                        |
| ---------------- | ------------------------------------------------------------------------- |
| 镜像             | `beaconhs:ea66c1-formal`                                                  |
| Image ID         | `sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795` |
| 与 EA-66D.1 一致 | 是                                                                        |
| 是否重新构建     | **否**                                                                    |
| 是否在线拉取     | **否**（`--pull never`）                                                  |

镜像内 migration 组件（实测）：

| 组件     | 位置                                                                              | 结果                                                                    |
| -------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 路由入口 | `/entrypoint.sh` → `migrate)` → `exec node apps/ops-migrate/dist/migrate.js "$@"` | 正确                                                                    |
| bundle   | `/app/apps/ops-migrate/dist/migrate.js`                                           | 562,433 B                                                               |
| 迁移目录 | `/app/apps/ops-migrate/node_modules/@beaconhs/db/drizzle/`                        | 存在                                                                    |
| journal  | `meta/_journal.json`                                                              | **51 条**，dialect `postgresql`，最后一条 `0051_ea12_drop_dead_columns` |

### 4.1 APP_ROLE=migrate 执行证据

在正式执行前，先以 `--entrypoint sh` 探测一次性容器的有效环境（**只打印变量名，不打印任何值**）：

```
APP_ROLE=migrate          ← 已覆盖载体服务的 storage-init
NODE_ENV=production
DATABASE_OWNER_ROLE=beaconhs_owner
DATABASE_BACKUP_ROLE=beaconhs_backup
server_action_key_present=NO   ← 迁移不需要，未注入
```

有效环境变量集合：`APP_ROLE`、`DATABASE_BACKUP_ROLE`、`DATABASE_OWNER_ROLE`、`DATABASE_URL`、
`MIGRATION_DATABASE_URL`、`NODE_ENV`、`SUPERADMIN_DATABASE_URL` + 载体服务的 `R2_*`（无害测试值）

- 镜像级变量（`HOME`、`PATH`、`NODE_VERSION` 等）。

**`APP_ROLE=migrate` 覆盖生效**，Server Action 密钥未进入迁移容器。

---

## 5. 三个数据库连接验证

### 5.1 变量来源

三个 URL 从 `local-prod.env` **逐字复制**到专用的 `~/.beaconhs/runtime/migration.env`（0600，7 个变量），
未手工输入任何值。以 SHA256 前 12 位比对确认一致：

| 变量                      | 一致性                 |
| ------------------------- | ---------------------- |
| `MIGRATION_DATABASE_URL`  | MATCH (`3a29f8df0492`) |
| `DATABASE_URL`            | MATCH (`b733a8750f5b`) |
| `SUPERADMIN_DATABASE_URL` | MATCH (`4cb7d3a89191`) |

### 5.2 目标数据库确认

三个 URL 全部指向 `postgres:5432/**beaconhs**`：

```
MIGRATION_DATABASE_URL=postgresql://<user>:<pw>@postgres:5432/beaconhs
DATABASE_URL=postgresql://<user>:<pw>@postgres:5432/beaconhs
SUPERADMIN_DATABASE_URL=postgresql://<user>:<pw>@postgres:5432/beaconhs
```

**迁移目标是 `beaconhs` 测试库，不是 `postgres` 系统库。**

### 5.3 角色预检实测（以 migrator 身份、TCP 连接）

| 预检项                                       | 实测                              | 结果                     |
| -------------------------------------------- | --------------------------------- | ------------------------ |
| login_role                                   | `beaconhs_migrator`               | PASS                     |
| can_assume_owner                             | t                                 | PASS                     |
| login_super / login_bypass                   | f / f                             | PASS                     |
| owner_can_login / owner_super / owner_bypass | f / f / f                         | PASS                     |
| `SET ROLE beaconhs_owner`                    | `after_set_role = beaconhs_owner` | PASS                     |
| runtime_ok / maintenance_ok / backup_ok      | 1 / 1 / 1                         | PASS                     |
| stray objects（`assertSchemaOwnership`）     | 0                                 | PASS                     |
| advisory lock 持有者                         | 0                                 | PASS（无并发 migration） |

密码经 stdin 写入容器内 0600 pgpass 文件，**未进入任何 argv**，验证后立即删除。

---

## 6. Migration 执行

### 6.1 执行命令

```bash
docker compose \
  --env-file ~/.beaconhs/runtime/local-prod.env \
  --env-file ~/.beaconhs/runtime/server-action-key.env \
  -f deploy/local-production.compose.yaml \
  -p beaconhs-local-prod \
  run --rm --no-deps --pull never \
  --env-from-file ~/.beaconhs/runtime/migration.env \
  storage-init
```

| 要求                           | 落实                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ |
| 使用 APP_ROLE=migrate          | ✅ `--env-from-file` 覆盖载体服务的 APP_ROLE                                   |
| 使用同一网络与运行配置         | ✅ 同一 project `beaconhs-local-prod`，同一 `beaconhs-local-prod_default` 网络 |
| 只传入迁移所需变量             | ✅ 专用 7 变量文件                                                             |
| 密码不进 argv / 日志 / history | ✅ `--env-from-file` 读 0600 文件；无 `-e VAR=value`                           |
| 受保护的临时环境注入           | ✅ `migration.env` mode 0600 / owner ceshi                                     |
| 不修改 Canonical Compose       | ✅ 未改动（SHA256 不变）                                                       |
| 一次性任务自动退出             | ✅ `--rm`，容器已删除（残留计数 0）                                            |
| 保留退出码                     | ✅ **MIGRATE_EXIT=0**                                                          |
| 不并发启动第二个任务           | ✅ 执行前 advisory lock 持有者 0；全程单任务                                   |

### 6.2 执行输出（脱敏）

```
✔ Database role preflight passed (beaconhs_migrator → beaconhs_owner; runtime beaconhs_app; maintenance beaconhs_super; backup beaconhs_backup)
▶ Verifying schema ownership…
▶ Validating migration ledger…
  Fresh database detected; the full migration journal will run
▶ Running drizzle migrations…
  Migration ledger valid: 51 applied, 0 pending, 0 historical
▶ Applying RLS policies…
✔ RLS applied atomically (191 tables)
▶ Applying least-privilege runtime grants…
✔ Least-privilege grants applied (runtime beaconhs_app; maintenance beaconhs_super; backup beaconhs_backup)
▶ Verifying security data invariants…
✔ Kiosk PIN hash invariant verified
▶ Converging role permissions…
✔ Built-in role permissions backfilled
▶ Applying planner statistics targets…
✔ Statistics applied (32 targets)
▶ Applying reporting views…
✔ Views applied atomically (15 statements)
```

输出中**不含任何密码、密钥或完整连接串**。

---

## 7. Migration 51 结果

| 检查                           | 结果                                                 |
| ------------------------------ | ---------------------------------------------------- |
| 任务退出码                     | **0**                                                |
| `drizzle` schema               | 已建立                                               |
| `drizzle.__drizzle_migrations` | 存在，**51 行**                                      |
| distinct hash                  | 51                                                   |
| distinct created_at            | 51                                                   |
| max created_at                 | 1792640490486（= journal 最后一条 `0051` 的 `when`） |

### 7.1 Migration 0051 的三条 DROP COLUMN

| 列                                         | 结果       |
| ------------------------------------------ | ---------- |
| `equipment_inspection_records.certificate` | **已删除** |
| `training_enrollments.due_on`              | **已删除** |
| `training_enrollments.expires_on`          | **已删除** |
| `equipment_inspection_records`（表本身）   | 存在       |
| `training_enrollments`（表本身）           | 存在       |

### 7.2 51 条 ledger 记录的 SHA256 核对

在镜像内用与 `packages/db/src/migration-state.ts:46` **完全相同的算法**
（`sha256(文件文本)`）重算全部 51 个迁移文件，与数据库 ledger 逐条比对：

```
diff <(镜像内重算的 created_at|hash) <(数据库 ledger 的 created_at|hash)
→ 无差异
✓ 51/51 完全一致：每个迁移文件的 SHA256 与 ledger 记录匹配
```

复跑后再做一次同样比对：**仍 51/51 一致**，ledger 未被重复写入。

---

## 8. Schema 验证

| Schema    | 表                          | 视图 |
| --------- | --------------------------- | ---- |
| `public`  | 197                         | 14   |
| `drizzle` | 1（`__drizzle_migrations`） | 0    |
| `etl`     | 0                           | 0    |

| RLS 指标      | 值                                |
| ------------- | --------------------------------- |
| public 表总数 | 197                               |
| 启用 RLS      | **191**                           |
| FORCE RLS     | **192**（191 租户表 + `tenants`） |

未启用 RLS 的 6 张表全部是预期的全局表：

| 表                  | RLS | FORCE | 说明                 |
| ------------------- | --- | ----- | -------------------- |
| `user`              | f   | f     | Better Auth 全局表   |
| `account`           | f   | f     | Better Auth 全局表   |
| `session`           | f   | f     | Better Auth 全局表   |
| `verification`      | f   | f     | Better Auth 全局表   |
| `platform_settings` | f   | f     | 平台级单例           |
| `tenants`           | f   | **t** | 租户注册表，强制 RLS |

---

## 9. 角色权限复核

### 9.1 五角色属性（迁移后 vs provision 后）

| 角色                | login | super | bypass | readonly | 与 provision 后一致 |
| ------------------- | ----- | ----- | ------ | -------- | ------------------- |
| `beaconhs_owner`    | f     | f     | f      | f        | 是                  |
| `beaconhs_migrator` | t     | f     | f      | f        | 是                  |
| `beaconhs_app`      | t     | f     | f      | f        | 是                  |
| `beaconhs_super`    | t     | f     | t      | f        | 是                  |
| `beaconhs_backup`   | t     | f     | t      | t        | 是                  |

**迁移未意外修改任何角色属性。**

### 9.2 Schema 权限

| Schema   | app USAGE | super USAGE | backup USAGE | app CREATE |
| -------- | --------- | ----------- | ------------ | ---------- |
| `public` | t         | t           | t            | f          |
| `etl`    | **f**     | t           | t            | f          |

`etl` 对运行时角色 `beaconhs_app` **完全隔离**，与 provision.sql 的设计意图一致
（"Private ETL bookkeeping is intentionally isolated from runtime traffic"）。

### 9.3 表级授权

| 角色              | public 表授权数 | 推算               |
| ----------------- | --------------- | ------------------ |
| `beaconhs_app`    | 844             | 4 权限 × 211 表    |
| `beaconhs_super`  | 844             | 4 权限 × 211 表    |
| `beaconhs_backup` | **211**         | 仅 SELECT × 211 表 |

`drizzle.__drizzle_migrations`：三个运行时角色均仅 **SELECT**（readiness 校验需要比较 ledger 与镜像内 journal），
owner 保留全部权限。

---

## 10. 事务与 advisory lock 状态

| 检查                                                            | 结果                      |
| --------------------------------------------------------------- | ------------------------- |
| advisory lock 持有者（`hashtext('beaconhs:schema-migration')`） | **0**                     |
| `pg_stat_activity` 中 `beaconhs` 库的连接                       | 仅 1 条（即当前查询自身） |
| `idle in transaction` 会话                                      | **0**                     |
| 死锁计数                                                        | **0**                     |

迁移的所有语句与 ledger 插入在同一事务内执行（drizzle `pg-core/dialect.js:60-71`），
失败即整体回滚；advisory lock 在 `finally` 中释放。

---

## 11. 幂等性与失败回滚验证

### 11.1 幂等性（成功路径复跑）

在首次成功之后**顺序**再执行一次（非常并发）：

| 项                    | 结果                                                          |
| --------------------- | ------------------------------------------------------------- |
| 复跑退出码            | **0**                                                         |
| ledger 校验           | `Migration ledger valid: 51 applied, 0 pending, 0 historical` |
| drizzle 行为          | 正确跳过全部 51 条（未重复执行 DDL）                          |
| ledger 行数（复跑后） | 51，distinct hash 51                                          |
| SHA256 全量复核       | **51/51 仍一致**                                              |
| advisory lock         | 复跑后仍为 0 持有者                                           |

**证明：** ledger 哈希校验对已填充的 ledger 有效；迁移可安全重复执行。

### 11.2 失败回滚

本次迁移**未失败**，因此没有可观测的失败回滚实例。回滚保证来自代码层已验证的机制：
drizzle 把所有迁移语句与 ledger 插入放在同一个 `session.transaction` 内，事务失败即整体撤销，
不会留下"DDL 已执行但 ledger 未记录"的中间态。EA-66D.2.3 已从
`node_modules/.pnpm/drizzle-orm@0.45.2…/pg-core/dialect.js:60-71` 核实该实现。

**如实陈述：** 失败路径未在真实库上触发过 —— 该结论来自源码与依赖实现，不是实测。

---

## 12. 当前运行容器清单

| 容器                             | 状态                          | 端口                        |
| -------------------------------- | ----------------------------- | --------------------------- |
| `beaconhs-local-prod-postgres-1` | Up（healthy，RestartCount 0） | `127.0.0.1:5433 → 5432/tcp` |
| `beaconhs-local-prod-redis-1`    | Up（healthy，RestartCount 0） | `127.0.0.1:6380 → 6379/tcp` |

一次性迁移容器残留：**0**（`--rm` 已删除）。

## 13. 未启动的服务清单

| 服务         | 容器数 |
| ------------ | ------ |
| web          | 0      |
| worker       | 0      |
| scheduler    | 0      |
| storage-init | 0      |
| minio        | 0      |
| collabora    | 0      |

其它状态：网络 4（`beaconhs-local-prod_default` + 3 默认）；卷 3（postgres 已用、redis 已用、minio 空）；镜像 25（未改动）；磁盘 69G 可用（42%）。

---

## 14. 生产隔离确认

| 检查                        | 结果                                        |
| --------------------------- | ------------------------------------------- |
| 端口绑定                    | 均仅 `127.0.0.1`                            |
| 外部网络连接                | 无                                          |
| 容器 DNS                    | 仅 Compose 网络内地址                       |
| runtime env 端点            | 全部本地 / 内网络 / `*.beaconhs-test.local` |
| 生产主机名扫描              | 未发现                                      |
| 生产数据库 / 对象存储 / API | 均未连接                                    |

---

## 15. 最终判定

**PASS**

启动前复核逐项通过；PostgreSQL 与 Redis 的镜像 Image ID、卷状态、配置哈希、密钥 fingerprint 与
生产端点扫描全部符合预期，数据库在迁移前处于无业务数据、无 drizzle schema、无管理员的纯净状态。

Redis 以 digest 固定镜像、无 pull、无 build 启动并 healthy；PING 返回 PONG，`requirepass` 为空，
应用实际使用的内网络 `redis:6379` 连接已验证可用。

独立 Migration 任务以正式 BeaconHS 镜像、`APP_ROLE=migrate`、专用 0600 环境文件注入，
退出码 0；执行前的路由、bundle、journal、角色预检与 advisory lock 状态全部确认；
三个连接变量均指向 `beaconhs` 测试库。51 条 ledger 记录与镜像内迁移文件的 SHA256 **逐条匹配**，
Migration 0051 的三条 DROP COLUMN 已完成且目标表完好；schema、RLS、FORCE RLS、角色属性与授权
全部符合设计且未发现意外修改；advisory lock 已释放，无 idle-in-transaction、无死锁。
顺序复跑退出码 0 且 ledger 不变，证明迁移幂等且哈希校验有效。

数据库中 `admins=0`、`total_users=0`、`tenants=0` —— 未创建任何管理员或租户。

---

## 16. 停止条件确认

- ✅ PostgreSQL 保持运行（healthy）
- ✅ Redis 保持运行（healthy）
- ✅ Migration 一次性任务已退出，容器残留 0
- ✅ **未**创建管理员（`admins=0`）
- ✅ **未**启动 MinIO（容器 0，卷 0 条目）
- ✅ **未**执行 storage-init
- ✅ **未**启动 web、worker、scheduler、Collabora
- ✅ **未**运行 Gate 5
- ✅ **未**修改 Canonical Compose（SHA256 不变）或 Gate 5 Manifest
- ✅ **未**修改业务代码、**未**重建镜像、**未**在线拉取
- ✅ **未**执行数据库恢复、**未**删除数据库卷、**未**执行 `down -v`
- ✅ **未**连接生产环境、**未**输出密码或密钥、**未** commit/push/CI

生产状态：`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
Rollback：`FAIL — NO EXECUTABLE ROLLBACK PATH`

**等待 EA-66D.2.6 单独授权。**

---

## 17. 证据索引

| File                                                        | Contents                                |
| ----------------------------------------------------------- | --------------------------------------- |
| `~/beaconhs-canonical/deploy/local-production.compose.yaml` | Canonical Compose（SHA256 `9700f480…`） |
| `~/.beaconhs/runtime/local-prod.env`                        | 27 个运行时变量（0600）                 |
| `~/.beaconhs/runtime/migration.env`                         | 迁移专用 7 变量（0600）                 |
| `docs/ea66d2-3-migration-bootstrap-audit-report.md`         | Migration 方案审计                      |
| `docs/ea66d2-4-postgres-provision-report.md`                | Provision 执行报告                      |
| 本报告                                                      | EA-66D.2.5 执行报告                     |
