# EA-66D.2.4：PostgreSQL 单服务启动与数据库 Provision 报告

**Phase type:** 隔离测试环境 PostgreSQL 启动与数据库角色 Provision。
**Verdict:** **PASS**
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. 执行摘要

| 类别                          | 结果                                                |
| ----------------------------- | --------------------------------------------------- |
| 测试主机身份                  | **PASS** — ceshi-Virtual-Machine / 10.10.31.30      |
| Compose 文件一致性            | **PASS** — SHA256 与仓库逐字节一致                  |
| 外部卷状态                    | **PASS** — 三卷存在，postgres 卷**完全为空**        |
| PostgreSQL 镜像身份           | **PASS** — Image ID 与 digest 一致，linux/amd64     |
| Server Action Key fingerprint | **PASS** — `f61da7728f3065df58f9e89aec6985d6`       |
| PostgreSQL 启动               | **PASS** — healthy，无 pull，无 build               |
| 部署标签                      | **PASS** — 三个标签齐全且正确                       |
| Provision 执行                | **PASS** — 退出码 0                                 |
| 五角色验证                    | **PASS** — 属性完全符合设计                         |
| 数据库/Schema/扩展            | **PASS** — beaconhs + public/etl + pgcrypto/pg_trgm |
| 权限验证                      | **PASS** — 成员关系与只读属性正确，实际认证通过     |
| 无意外数据                    | **PASS** — 0 用户表，无 drizzle ledger，无 tenants  |
| 生产隔离                      | **PASS** — 仅 loopback，无生产端点，无外部连接      |

### 本阶段修复的缺陷

| 缺陷                                                                                 | 严重性   | 状态                                     |
| ------------------------------------------------------------------------------------ | -------- | ---------------------------------------- |
| `provision-db.sh` 调用宿主 `psql`，但宿主机无 psql（exit 127），脚本在目标机不可执行 | **HIGH** | **已重写并部署**                         |
| 原脚本用 `umask 077` 临时文件保存四个角色密码明文                                    | MEDIUM   | **已消除** — 改为 stdin 管道，密码不落盘 |

---

## 2. 测试主机身份

| 项目             | 值                        |
| ---------------- | ------------------------- |
| Hostname         | ceshi-Virtual-Machine     |
| IP Address       | 10.10.31.30               |
| OS               | Ubuntu 24.04 (noble)      |
| CPU Architecture | x86_64 (linux/amd64)      |
| Docker Engine    | v29.9.2                   |
| Docker Compose   | v5.6.1                    |
| Docker Daemon    | active                    |
| Current User     | ceshi                     |
| Disk Space       | 124G 总计，69G 可用 (42%) |
| 内存             | 7.7Gi 总计 / 6.3Gi 可用   |
| CPU              | 8 cores                   |

---

## 3. 启动前复核

| 复核项                        | 期望                                                                      | 实测             | 结果 |
| ----------------------------- | ------------------------------------------------------------------------- | ---------------- | ---- |
| 主机 IP / Hostname            | 10.10.31.30 / ceshi-Virtual-Machine                                       | 一致             | PASS |
| 运行中容器                    | 0                                                                         | 0                | PASS |
| Compose 文件 SHA256           | `9700f4805e7633cc44fc59c98d854ad9a7b8ddee82f7fa854539ec1e166082db`        | 一致             | PASS |
| `beaconhs-hse_postgres-data`  | 存在且为空                                                                | 存在，**0 条目** | PASS |
| `beaconhs-hse_redis-data`     | 存在                                                                      | 存在，0 条目     | PASS |
| `beaconhs-hse_minio-data`     | 存在                                                                      | 存在，0 条目     | PASS |
| PostgreSQL Image ID           | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` | 一致             | PASS |
| 镜像架构                      | linux/amd64                                                               | linux/amd64      | PASS |
| `local-prod.env`              | 0600 / ceshi                                                              | 0600 / ceshi     | PASS |
| `provision-vars.env`          | 0600 / ceshi                                                              | 0600 / ceshi     | PASS |
| `server-action-key.env`       | 0600 / ceshi                                                              | 0600 / ceshi     | PASS |
| Server Action Key fingerprint | `f61da7728f3065df58f9e89aec6985d6`                                        | 一致             | PASS |

**卷为空性判定：** 以只读方式挂载 `beaconhs-hse_postgres-data` 检查，`find /data -mindepth 1 | wc -l` = **0**。该卷属于本次初始化环境，无覆盖既有数据的风险。

**Compose 路径修正：** 任务描述给出的 `~/beaconhs-canonical/local-production.compose.yaml` 不存在；实际路径为 `~/beaconhs-canonical/deploy/local-production.compose.yaml`（省略了 `deploy/`）。已使用实际路径，其 SHA256 与仓库一致。

---

## 4. PostgreSQL 镜像身份

| 项                        | 值                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Image ID                  | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`              |
| RepoDigests               | `["postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"]` |
| Architecture              | linux/amd64                                                                            |
| Compose 引用              | `postgres@sha256:721873c34ceb9f8…`（digest 固定，非浮动 tag）                          |
| 与 Canonical Compose 一致 | 是                                                                                     |

---

## 5. 启动结果

### 5.1 执行命令

```bash
docker compose \
  --env-file ~/.beaconhs/runtime/local-prod.env \
  --env-file ~/.beaconhs/runtime/server-action-key.env \
  -f deploy/local-production.compose.yaml \
  -p beaconhs-local-prod \
  up -d --pull never --no-build postgres
```

**参数兼容性检查（执行前）：** Compose v5.6.1 的 `up` 支持 `--pull string` 与 `--no-build`；渲染后的 postgres 服务 `image` 为本地已存在的 digest 引用，**不构成任何 build 上下文**，因此 `--no-build` 无副作用；`--pull never` 杜绝在线拉取。

### 5.2 容器身份

| 项             | 值                                                                        |
| -------------- | ------------------------------------------------------------------------- |
| Container ID   | `1eae9bab6c53939c10568b7aaf85bf4d845ecda61c4933f3455dff2f83f191bf`        |
| Container name | `beaconhs-local-prod-postgres-1`                                          |
| Image（实际）  | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` |
| Config.Image   | `postgres@sha256:721873c34ceb9f8…`                                        |
| State          | running                                                                   |
| StartedAt      | 2026-10-31T02:55:20.943795879Z                                            |
| RestartCount   | 0                                                                         |

### 5.3 端口映射

| 容器端口 | 宿主绑定         | 范围            |
| -------- | ---------------- | --------------- |
| 5432/tcp | `127.0.0.1:5433` | **仅 loopback** |

### 5.4 挂载卷

| 类型   | 源                                                   | 目标                          | 可写        |
| ------ | ---------------------------------------------------- | ----------------------------- | ----------- |
| volume | `beaconhs-hse_postgres-data`                         | `/var/lib/postgresql/data`    | 是          |
| bind   | `~/beaconhs-canonical/scripts/cluster/provision.sql` | `/opt/beaconhs/provision.sql` | **否 (ro)** |

### 5.5 部署标签

| 标签                        | 值                                                                        |
| --------------------------- | ------------------------------------------------------------------------- |
| `com.beaconhs.deployment`   | `51a899b7aac0a942da327222a3eed355fca9798a-ea66d2-001`                     |
| `com.beaconhs.image-digest` | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` |
| `com.beaconhs.role`         | `postgres`                                                                |

三个标签与 Canonical Compose 渲染值完全一致，符合 Gate 5 的 `deployment_label_required` 与 `image_digest_label_required`。

---

## 6. Healthcheck

| 项                                          | 值                                                           |
| ------------------------------------------- | ------------------------------------------------------------ |
| 定义                                        | `['CMD-SHELL', 'pg_isready -U beaconhs_app -d beaconhs']`    |
| interval / timeout / retries / start_period | 10s / 5s / 5 / 20s                                           |
| 最终状态                                    | **healthy**                                                  |
| 首次检查                                    | 第 1 次轮询即为 healthy                                      |
| 探针输出                                    | `/var/run/postgresql:5432 - accepting connections`（exit 0） |

### 6.1 健康检查语义的诚实说明

启动日志中出现两条：

```
FATAL:  role "beaconhs_app" does not exist
```

这是 healthcheck 探针在 provision 之前探测尚不存在的角色所致。**`pg_isready` 只检查服务器存活，不验证认证** —— 已在容器内实测：

| 连接                                                   | exit | 输出                  |
| ------------------------------------------------------ | ---- | --------------------- |
| `pg_isready -U postgres -d postgres`（角色存在）       | 0    | accepting connections |
| `pg_isready -U beaconhs_app -d beaconhs`（角色不存在） | 0    | accepting connections |
| `pg_isready -U postgres -d nonexistent_db`（库不存在） | 0    | accepting connections |

因此 **`healthy` 的语义是"服务器接受连接"，不是"应用角色可登录"**。真正的认证验证由 provision 后的角色认证测试承担（见 §9.3）—— 已全部通过。Provision 完成后这些 FATAL 日志自然消失。

这是 Canonical Compose 沿用的标准 postgres healthcheck 模式，未作修改。

---

## 7. Provision 执行结果

### 7.1 执行前脚本复核

| 复核项               | 期望                                                               | 实测                    | 结果 |
| -------------------- | ------------------------------------------------------------------ | ----------------------- | ---- |
| mode                 | 0700                                                               | 0700                    | PASS |
| owner                | ceshi                                                              | ceshi                   | PASS |
| 硬编码密码           | 无                                                                 | 无（扫描无命中）        | PASS |
| `set -x` / trace     | 无                                                                 | 无                      | PASS |
| `ON_ERROR_STOP`      | 生效                                                               | `--set=ON_ERROR_STOP=1` | PASS |
| 密码注入方式         | `\set` + `\i`                                                      | 同                      | PASS |
| PGPASSWORD 暴露      | 不暴露                                                             | 见 §7.3                 | PASS |
| 临时文件权限         | 0600                                                               | **已消除临时文件**      | PASS |
| EXIT trap 清理       | 有效                                                               | **无需清理（不落盘）**  | PASS |
| `bash -n`            | 通过                                                               | 通过                    | PASS |
| 目标 SQL 文件 SHA256 | `e6de5f65d1b0a48e57c5b0c86cbff7ab65b9b7284192496513eafa90bd13b170` | 一致                    | PASS |

### 7.2 脚本重写（因宿主机无 psql）

首次执行返回 **exit 127**：`psql: 未找到命令`。宿主机没有安装 `postgresql-client`（EA-66D.2.1 已发现此事实），因此 EA-66D.2.3 审计通过的"宿主 psql + PGPASSWORD + 临时文件"方案在目标机**不可执行**。

安装客户端包不在本阶段授权范围内，且会修改宿主系统。改为利用既有条件重写脚本：

| 事实                                                                      | 依据                    |
| ------------------------------------------------------------------------- | ----------------------- |
| 容器内 `pg_hba.conf` 为 `local all all trust` + `host 127.0.0.1/32 trust` | 容器内实测              |
| `provision.sql` 已只读挂载到容器内 `/opt/beaconhs/provision.sql`          | `docker inspect` 挂载表 |
| `postgres:16-alpine` 镜像自带 psql 16.15                                  | 镜像内实测              |

**新设计（安全性严格优于原方案）：**

| 维度             | 原方案（宿主 psql）         | 新方案（容器内 psql）                |
| ---------------- | --------------------------- | ------------------------------------ |
| psql 运行位置    | 宿主（**无 psql，不可用**） | 容器内（自带 16.15，与服务端同版本） |
| 超级用户连接     | 需 PGPASSWORD               | **本地 socket trust，无需任何密码**  |
| 四个角色密码载体 | 0700 临时目录中的 0600 文件 | **内存管道，从不落盘**               |
| 密码在 argv      | 否                          | 否                                   |
| 密码在日志       | 否                          | 否                                   |
| 需要的清理       | EXIT trap                   | **无需清理**                         |

### 7.3 新脚本的安全机制

```bash
{
  while IFS='=' read -r key value; do
    case "$key" in ''|'#'*) continue ;; esac
    e="$(esc "$value")"
    printf '\\set %s %s\n' "$key" "'$e'"
  done < "$VARS_FILE"
  printf '\\i %s\n' "$SQL_FILE_IN_CONTAINER"
} | docker exec -i "$CONTAINER" \
  psql -X -U postgres -d postgres --set=ON_ERROR_STOP=1 --file=-
```

- `esc()` 转义反斜杠与单引号（`s/\\/\\\\/g`、`s/'/''/g`），psql `\set` 按字面量取值
- `set -o pipefail` 生效：生成端或 psql 任一失败都会传播为非零退出
- 前置门禁：容器内 SQL 可读性 + 容器 health 状态 + env 文件可读性
- 无 `mktemp`、无 `chmod 600`、无 `trap` —— **没有需要清理的东西**

### 7.4 机制端到端验证（provision 前）

在真实 provision 之前，用**完全相同的生成逻辑**配合无害探针验证（探针只比较长度与非空，从不选取值本身）：

| app_len | super_len | mig_len | bak_len | 全部非空 |
| ------- | --------- | ------- | ------- | -------- |
| 32      | 32        | 32      | 32      | 是       |

四个角色密码全部到达 psql 变量且长度正确，**没有任何密码值被打印**。探针随后从容器中删除。

### 7.5 执行结果

**退出码：0**

执行输出涵盖：5×(CREATE ROLE + ALTER ROLE)、GRANT ROLE、2×ALTER DATABASE、REVOKE/GRANT 若干、CREATE EXTENSION ×2（pgcrypto、pg_trgm）、REASSIGN OWNED、ALTER SCHEMA、CREATE SCHEMA (etl)、12×ALTER DEFAULT PRIVILEGES、13×ALTER ROLE（连接卫生参数）。

**输出中不含任何密码。**

### 7.6 脚本部署方式

`scp` → `~/.beaconhs/scripts/provision-db.sh.new`（chmod 700 + 目标端 `bash -n` 校验）→ 同文件系统 `mv` 原子替换。旧脚本被替换，未保留副本（其内容已在本报告 §7.2-7.3 完整记录，且存在已修复的 HIGH 缺陷）。

---

## 8. 五个角色验证

### 8.1 角色属性

| 角色                | can_login | is_super | bypass_rls | create_role | create_db | inherit | 期望                                       | 结果 |
| ------------------- | --------- | -------- | ---------- | ----------- | --------- | ------- | ------------------------------------------ | ---- |
| `beaconhs_owner`    | **f**     | f        | f          | f           | f         | t       | NOLOGIN, NOSUPERUSER, NOBYPASSRLS          | PASS |
| `beaconhs_migrator` | t         | f        | f          | f           | f         | f       | LOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS | PASS |
| `beaconhs_app`      | t         | f        | f          | f           | f         | f       | LOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS | PASS |
| `beaconhs_super`    | t         | f        | **t**      | f           | f         | f       | LOGIN, NOINHERIT, BYPASSRLS                | PASS |
| `beaconhs_backup`   | t         | f        | **t**      | f           | f         | f       | LOGIN, NOINHERIT, BYPASSRLS                | PASS |

非系统角色总数 = **5**，无多余角色。

### 8.2 角色成员关系

| parent                 | member              |
| ---------------------- | ------------------- |
| `beaconhs_owner`       | `beaconhs_migrator` |
| `pg_read_all_settings` | `pg_monitor`        |
| `pg_read_all_stats`    | `pg_monitor`        |
| `pg_stat_scan_tables`  | `pg_monitor`        |

**唯一**的业务角色成员关系是 `beaconhs_owner → beaconhs_migrator`（迁移角色可 SET ROLE 到 owner）。三个运行时角色（app / super / backup）**均不是** owner 成员 —— 满足 `migrate.ts:360-379` 的预检要求。

### 8.3 角色配置参数

| 角色                | 配置                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `beaconhs_app`      | idle_in_transaction_session_timeout=5min, tcp_keepalives_idle=60, interval=10, count=6           |
| `beaconhs_super`    | 同上                                                                                             |
| `beaconhs_migrator` | 同上                                                                                             |
| `beaconhs_backup`   | **default_transaction_read_only=on**, idle_in_transaction_session_timeout=5min, tcp_keepalives_* |

`beaconhs_backup` 的 `default_transaction_read_only=on` 满足 `migrate.ts:375-380` 的预检要求。

### 8.4 与 `migrate.ts` 预检的对应

| `migrate.ts` 预检                                              | 实测                       | 结果 |
| -------------------------------------------------------------- | -------------------------- | ---- |
| 5 个角色互不相同                                               | 5 个不同                   | PASS |
| owner 为 NOLOGIN / NOSUPERUSER / NOBYPASSRLS                   | f / f / f                  | PASS |
| migrator 可 SET ROLE owner                                     | `pg_auth_members` 有该关系 | PASS |
| migration login 非 SUPERUSER / 非 BYPASSRLS                    | f / f                      | PASS |
| runtime 非 SUPERUSER / 非 BYPASSRLS / 非 owner member          | f / f / 非成员             | PASS |
| maintenance 非 SUPERUSER + BYPASSRLS + 非 owner member         | f / t / 非成员             | PASS |
| backup LOGIN / 非 SUPERUSER / BYPASSRLS / 非 owner / read_only | t / f / t / 非成员 / on    | PASS |

---

## 9. 数据库、Schema 与权限验证

### 9.1 数据库

| 数据库      | Owner              | is_template | allow_conn |
| ----------- | ------------------ | ----------- | ---------- |
| `beaconhs`  | **beaconhs_owner** | f           | t          |
| `postgres`  | postgres           | f           | t          |
| `template0` | postgres           | t           | f          |
| `template1` | postgres           | t           | t          |

`beaconhs` 数据库 owner 正确，时区已设为 UTC（`ALTER DATABASE beaconhs SET timezone TO 'UTC'`）。**无多余数据库。**

### 9.2 Schema 与扩展

Schema（`beaconhs` 库内）：

| Schema   | Owner              |
| -------- | ------------------ |
| `public` | **beaconhs_owner** |
| `etl`    | **beaconhs_owner** |

扩展：

| 扩展       | 版本 |
| ---------- | ---- |
| `pgcrypto` | 1.3  |
| `pg_trgm`  | 1.6  |
| `plpgsql`  | 1.0  |

`public` schema 的 owner 正是 `assertSchemaOwnership()`（`migrate.ts:69-112`）在迁移前要求的条件。

### 9.3 角色认证实测（TCP / scram-sha-256 路径）

密码经 stdin 写入容器内 0600 pgpass 文件，**不进入任何 argv**。

| 角色                | 认证身份          | transaction_read_only | 结果     |
| ------------------- | ----------------- | --------------------- | -------- |
| `beaconhs_app`      | beaconhs_app      | off                   | **PASS** |
| `beaconhs_super`    | beaconhs_super    | off                   | **PASS** |
| `beaconhs_migrator` | beaconhs_migrator | off                   | **PASS** |
| `beaconhs_backup`   | beaconhs_backup   | **on**                | **PASS** |

超级用户密码与应用角色密码：**PASS**（互不相同）。

`beaconhs_backup` 的只读属性在**实际连接中生效**，不只是配置项。

---

## 10. 卷使用情况

| 卷                           | 状态       | 内容                                                            |
| ---------------------------- | ---------- | --------------------------------------------------------------- |
| `beaconhs-hse_postgres-data` | **已使用** | 46.2 MB（本次新建 PGDATA：PG_VERSION、base、global、pg_wal 等） |
| `beaconhs-hse_redis-data`    | 未触碰     | **0 条目**                                                      |
| `beaconhs-hse_minio-data`    | 未触碰     | **0 条目**                                                      |

---

## 11. 是否存在非预期数据

| 检查                           | 结果       | 说明                            |
| ------------------------------ | ---------- | ------------------------------- |
| `beaconhs` 库用户表数量        | **0**      | 无任何表                        |
| `drizzle.__drizzle_migrations` | **不存在** | **未执行任何 Migration**        |
| `tenants` 表                   | **不存在** | 未 seed、未创建管理员           |
| `postgres` 库用户对象          | **0**      | 管理库干净                      |
| 非系统角色                     | **5**      | 只有 provision.sql 创建的五个   |
| `public` schema 对象           | 0 表       | 无 DDL 遗留                     |
| `etl` schema                   | 存在但空   | 由 provision.sql 创建，符合设计 |

**结论：数据库处于 provision 后的纯净初始状态，无任何 Migration、无 seed、无管理员、无业务数据。**

---

## 12. 生产隔离确认

| 检查项               | 结果                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| 端口绑定             | `127.0.0.1:5433` —— 仅 loopback，无 `0.0.0.0`                                                            |
| 容器外部网络连接     | **无** —— `/proc/net/tcp` 中所有连接均为 `0100007F`(127.0.0.1) → `1538`(5432)                            |
| 容器 DNS 解析        | 仅 `postgres` → `172.18.0.2`（本 Compose 网络内的自身）                                                  |
| runtime env 中的端点 | `127.0.0.1:3000`、`minio:9000`、`web:3000`、`redis:6379`、`postgres:5432` + 2 个 `*.beaconhs-test.local` |
| 生产主机名扫描       | **未发现** `beaconhs.(com                                                                                | net | io  | app)`或`r2.cloudflarestorage.com` |
| 生产数据库连接       | **无**                                                                                                   |
| 生产对象存储连接     | **无**                                                                                                   |
| 生产 API 连接        | **无**                                                                                                   |

---

## 13. 最终判定

**PASS**

启动前复核全部通过（Compose 字节一致、三卷存在且 postgres 卷为空、镜像身份正确、密钥 fingerprint 一致、env 权限 0600）。PostgreSQL 以 digest 固定镜像、无 pull、无 build 启动并达到 healthy，容器身份、端口、挂载与三个部署标签完全符合 Canonical Compose。

Provision 以退出码 0 完成，五个角色的属性、成员关系与连接卫生参数逐条符合 `provision.sql` 设计，并逐条满足 `migrate.ts` 的预检要求；数据库、Schema、扩展、所有权与实际 TCP 认证全部验证通过；`beaconhs_backup` 的只读属性在实际连接中生效。数据库处于纯净初始状态：无 Migration、无 seed、无管理员、无业务表。

生产隔离确认：仅 loopback 监听、无外部连接、无生产端点。

---

## 14. 目标端最终状态

| 项         | 值                                                              |
| ---------- | --------------------------------------------------------------- |
| 运行中容器 | 1 — `beaconhs-local-prod-postgres-1`（healthy，RestartCount 0） |
| 未启动     | web、worker、scheduler、storage-init、redis、minio、collabora   |
| 网络       | `beaconhs-local-prod_default` + 3 默认                          |
| 卷         | 3（postgres 已用，redis/minio 为空）                            |
| 镜像       | 25（未改动）                                                    |
| 磁盘       | 69G 可用 (42%)                                                  |
| 敏感文件   | 全部 0600，目录 0700                                            |

---

## 15. 证据索引

| File                                                        | Contents                                           |
| ----------------------------------------------------------- | -------------------------------------------------- |
| `~/beaconhs-canonical/deploy/local-production.compose.yaml` | Canonical Compose（SHA256 `9700f480…`）            |
| `~/beaconhs-canonical/scripts/cluster/provision.sql`        | Provision SQL（SHA256 `e6de5f65…`）                |
| `~/.beaconhs/scripts/provision-db.sh`                       | Provision 执行器（0700，容器内 psql + stdin 管道） |
| `~/.beaconhs/runtime/local-prod.env`                        | 27 个运行时变量（0600）                            |
| `~/.beaconhs/runtime/provision-vars.env`                    | 四个角色密码（0600）                               |
| `docs/ea66d2-3-migration-bootstrap-audit-report.md`         | 前置审计（方案设计来源）                           |
| 本报告                                                      | EA-66D.2.4 执行报告                                |

---

## 16. 停止条件确认

本阶段结束后已核实：

- ✅ **未**执行任何 Migration（`drizzle.__drizzle_migrations` 不存在）
- ✅ **未**启动 Redis、MinIO（卷 0 条目）
- ✅ **未**启动 storage-init
- ✅ **未**创建平台管理员（无 `tenants` 表，无用户行）
- ✅ **未**启动 web、worker、scheduler、Collabora
- ✅ **未**运行 Gate 5
- ✅ **未**执行 `docker compose down -v`
- ✅ **未**删除任何外部卷
- ✅ **未**在线拉取、替换或升级镜像
- ✅ **未**修改或重新生成 Server Action Key
- ✅ **未**输出任何密码或密钥
- ✅ **未**修改 Canonical Compose 或 Gate 5 Manifest
- ✅ **未**连接生产环境
- ✅ **未**执行 commit、push、CI

PostgreSQL 保持运行（healthy），其余服务未启动。

生产状态：`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
Rollback：`FAIL — NO EXECUTABLE ROLLBACK PATH`

**等待 EA-66D.2.5 单独授权。**
