# EA-66D.2.1：隔离测试环境启动前准备报告

**Phase type:** 隔离测试环境启动前准备。
**Verdict:** **READY WITH CONDITIONS**
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. 执行摘要

### 1.1 审计范围

本阶段完成 Canonical Compose 首次启动所需的基础资源准备：

- 创建三个 Docker 外部卷
- 审计数据库 provision 脚本和执行顺序
- 审计必需环境变量清单
- 验证 Server Action Key fingerprint
- 检查 Compose 外部卷一致性
- 设计首次启动顺序
- 复核资源容量

### 1.2 执行结果

| 类别                          | 结果                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| 测试机身份                    | PASS (ceshi-Virtual-Machine, 10.10.31.30)                                  |
| Docker 环境正常               | PASS (v29.9.2, v5.6.1)                                                     |
| 三个外部卷创建                | PASS                                                                       |
| 卷名一致性                    | PASS (与 Compose 声明完全一致)                                             |
| 数据库 provision 审计         | PASS (脚本幂等，可重复执行)                                                |
| 环境变量清单                  | PASS (已提取，缺失项已列出)                                                |
| Server Action Key fingerprint | WARNING (构建时 f61da7728f3065df58f9e89aec6985d6，运行时 aac818abd1505f96) |
| Runtime Key 安全传递          | WARNING (运行时密钥与构建时密钥不一致)                                     |
| 启动顺序设计                  | PASS (已设计完整顺序)                                                      |
| 容量复核                      | PASS (69G 可用，充足)                                                      |
| 最终判定                      | **READY WITH CONDITIONS**                                                  |

---

## 2. 测试主机信息

| 项目             | 值                                         |
| ---------------- | ------------------------------------------ |
| Hostname         | ceshi-Virtual-Machine                      |
| IP Address       | 10.10.31.30                                |
| OS               | Ubuntu 24.04 (noble)                       |
| CPU Architecture | x86_64 (linux/amd64)                       |
| Docker Engine    | v29.9.2                                    |
| Docker Compose   | v5.6.1                                     |
| Docker Daemon    | active                                     |
| Current User     | ceshi                                      |
| Disk Space       | 124G 总计，49G 已用，69G 剩余 (42% 使用率) |
| Memory           | 7.7Gi 总计，6.3Gi 可用                     |
| CPU Cores        | 8                                          |

---

## 3. 三个外部卷创建结果

### 3.1 创建前检查

执行 `docker volume ls -f 'name=beaconhs-hse_'` 时无同名卷，因此可以安全创建。

### 3.2 卷创建状态

| 卷名                       | Driver | Scope | Mountpoint                                               | CreatedAt                 | 容器使用 | 状态 |
| -------------------------- | ------ | ----- | -------------------------------------------------------- | ------------------------- | -------- | ---- |
| beaconhs-hse_postgres-data | local  | local | /var/lib/docker/volumes/beaconhs-hse_postgres-data/_data | 2026-10-31T08:27:29+08:00 | 0        | PASS |
| beaconhs-hse_redis-data    | local  | local | /var/lib/docker/volumes/beaconhs-hse_redis-data/_data    | 2026-10-31T08:27:29+08:00 | 0        | PASS |
| beaconhs-hse_minio-data    | local  | local | /var/lib/docker/volumes/beaconhs-hse_minio-data/_data    | 2026-10-31T08:27:29+08:00 | 0        | PASS |

三个卷均为空卷（Local Volumes space usage 显示 0B），无 Labels，无容器使用，属于 ceshi 测试环境。未创建其他卷。

### 3.3 卷名与 Compose 一致性

| Compose 卷名  | 预期外部卷                 | 实际创建                   | 一致性 |
| ------------- | -------------------------- | -------------------------- | ------ |
| postgres-data | beaconhs-hse_postgres-data | beaconhs-hse_postgres-data | PASS   |
| redis-data    | beaconhs-hse_redis-data    | beaconhs-hse_redis-data    | PASS   |
| minio-data    | beaconhs-hse_minio-data    | beaconhs-hse_minio-data    | PASS   |

三个卷在 Compose 中均为 `external: true`，Compose 不会创建或删除它们。

### 3.4 挂载目标路径核对

| 服务     | 卷            | 容器挂载路径             | 核对 |
| -------- | ------------- | ------------------------ | ---- |
| postgres | postgres-data | /var/lib/postgresql/data | PASS |
| redis    | redis-data    | /data                    | PASS |
| minio    | minio-data    | /data                    | PASS |

额外只读挂载（非数据卷）：

| 服务      | 宿主机路径                       | 容器路径                                    | 模式 |
| --------- | -------------------------------- | ------------------------------------------- | ---- |
| postgres  | ../scripts/cluster/provision.sql | /opt/beaconhs/provision.sql                 | ro   |
| collabora | ./collabora-branding.js          | /usr/share/coolwsd/browser/dist/branding.js | ro   |

本阶段未挂载卷、未启动容器。

---

## 4. 数据库 provision 审计

### 4.1 逐项回答

1. **PostgreSQL 容器是否将宿主机 127.0.0.1:5433 映射到容器 5432？**
   是。Compose 第 243-244 行：`ports: - '127.0.0.1:5433:5432'`。

2. **provision.sql 是否要求 PostgreSQL 已经启动？**
   是。脚本通过 `psql` 连接 `postgres` 库执行，必须先启动 PostgreSQL 并通过 healthcheck。

3. **SQL 是否创建角色、授权、数据库或 schema？**
   是，全部创建：
   - 5 个角色：`beaconhs_owner`（NOLOGIN）、`beaconhs_migrator`、`beaconhs_app`、`beaconhs_super`（BYPASSRLS）、`beaconhs_backup`（BYPASSRLS）
   - 数据库 `beaconhs`，owner 为 `beaconhs_owner`，时区 UTC
   - Schema `public`（owner 改为 beaconhs_owner）与 `etl`
   - 扩展 `pgcrypto`、`pg_trgm`
   - 表/序列/Schema 的 GRANT、REVOKE、ALTER DEFAULT PRIVILEGES
   - 连接卫生参数（idle_in_transaction_session_timeout、tcp_keepalives_*）

4. **是否会修改已有数据库对象？**
   会，但仅用于权限收敛，且是幂等的：
   - `REASSIGN OWNED BY beaconhs_app TO beaconhs_owner`
   - `ALTER SCHEMA public OWNER TO beaconhs_owner`
   - `REVOKE ... FROM PUBLIC, beaconhs_app, beaconhs_super`
     这些语句只改变 owner/权限，不修改数据。全新空卷上它们是空操作。

5. **是否可以重复执行？**
   是。

6. **是否存在幂等性？**
   是。角色/数据库/扩展/Schema 均使用 `WHERE NOT EXISTS` 或 `IF NOT EXISTS`；GRANT/REVOKE 天然幂等；`\set ON_ERROR_STOP on` 保证失败立即停止而非半途继续。

7. **是否需要 postgres 超级用户权限？**
   是。脚本需创建角色、创建数据库、创建扩展、REASSIGN OWNED，必须由超级用户执行（脚本头注释明确要求 "run as a PostgreSQL superuser"）。

8. **是否依赖环境变量？**
   不依赖环境变量，依赖 psql 变量：`app_password`、`super_password`、`migrator_password`、`backup_password`，通过 `-v` 传入。脚本内没有任何 `:env` 读取。

9. **是否与应用启动自动迁移存在先后依赖？**
   是。顺序必须是：PostgreSQL 启动 → provision.sql → 应用首次启动（自动执行 Drizzle migration）。脚本第 116-125 行对 `drizzle` schema 的处理带有存在性判断，说明 provision 可在 migration 之前执行，且 migration 之后再次执行也安全。

### 4.2 报告中原命令的核实

EA-66D.2.0 报告中的命令：

```
psql postgresql://postgres:PASSWORD@127.0.0.1:5433 -f scripts/cluster/provision.sql
```

核实结果：**部分不正确**，存在三个缺陷：

1. **端口错误。** provision.sql 头注释示例使用 `localhost:5432`，而本 Compose 把宿主机 5433 映射到容器 5432。若在**宿主机**执行，必须用 `127.0.0.1:5433`；若在 postgres 容器内执行，应用 `localhost:5432`。报告混用了两者，易误导。
2. **缺少必需的 psql 变量。** 脚本要求 4 个密码变量，缺失时 `:'app_password'` 会展开为 NULL，导致 `CREATE ROLE ... PASSWORD NULL`，应用无法登录。正确形式必须带 `-v`。
3. **数据库名。** 连接串末段应为 `postgres`（管理库），脚本内部自行 `\connect beaconhs`。

**审计后的正确命令（在宿主机执行）：**

```bash
psql "postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:5433/postgres" \
  -v app_password="..." \
  -v super_password="..." \
  -v migrator_password="..." \
  -v backup_password="..." \
  -f scripts/cluster/provision.sql
```

**或在 postgres 容器内执行（避免宿主机暴露端口）：**

```bash
docker compose -f deploy/local-production.compose.yaml exec -T postgres \
  psql -U postgres -d postgres \
  -v app_password="..." -v super_password="..." \
  -v migrator_password="..." -v backup_password="..." \
  -f /opt/beaconhs/provision.sql
```

注意：provision.sql 在容器内以只读方式挂载于 `/opt/beaconhs/provision.sql`，可直接使用，无需复制。

**本阶段未执行任何 SQL。**

### 4.3 provision 正确执行顺序

```
1. 创建外部卷                          [已完成]
2. 准备 .env 与运行时密钥               [待完成]
3. 启动 postgres 容器                   [需授权]
4. 等待 postgres healthcheck = healthy  [需授权]
5. 执行 provision.sql（带 4 个密码变量）[需授权]
6. 启动 redis、minio                    [需授权]
7. 等待 minio healthcheck = healthy
8. 运行 storage-init（一次性，退出码 0）
9. 运行 scheduler（一次性，退出码 0）
10. 启动 web、worker
11. 启动 collabora
12. 全部 healthcheck 通过
13. Gate 5 验证
```

---

## 5. 环境变量清单

### 5.1 必需变量（`:?` 强制）

| 变量名                             | 服务                              | 敏感 | 提供方式                    | 当前状态 | 阻塞启动 |
| ---------------------------------- | --------------------------------- | ---- | --------------------------- | -------- | -------- |
| BEACONHS_IMAGE                     | web/worker/scheduler/storage-init | 否   | 部署脚本指定                | 未设置   | 是       |
| BEACONHS_DEPLOYMENT_ID             | 全部 8 个服务                     | 否   | `<40hex>-<runid>-<attempt>` | 未设置   | 是       |
| BEACONHS_IMAGE_DIGEST              | 4 个 gated 服务                   | 否   | `sha256:1834f867...6795`    | 未设置   | 是       |
| APP_VERSION                        | web/worker/scheduler/storage-init | 否   | 40-hex commit SHA           | 未设置   | 是       |
| DATABASE_URL                       | 4 个应用服务                      | 是   | 运维提供                    | 未设置   | 是       |
| SUPERADMIN_DATABASE_URL            | 4 个应用服务                      | 是   | 运维提供                    | 未设置   | 是       |
| REDIS_URL                          | 4 个应用服务                      | 是   | 运维提供                    | 未设置   | 是       |
| BETTER_AUTH_SECRET                 | 4 个应用服务                      | 是   | 运维提供                    | 未设置   | 是       |
| ATTACHMENT_CAPABILITY_SECRET       | 4 个应用服务                      | 是   | 运维提供                    | 未设置   | 是       |
| APP_URL                            | 4 个应用服务 + collabora          | 否   | 运维提供                    | 未设置   | 是       |
| R2_ENDPOINT                        | web/storage-init                  | 否   | 运维提供                    | 未设置   | 是       |
| R2_INTERNAL_ENDPOINT               | web/storage-init                  | 否   | 运维提供                    | 未设置   | 是       |
| R2_ACCESS_KEY_ID                   | web/storage-init                  | 是   | 运维提供                    | 未设置   | 是       |
| R2_SECRET_ACCESS_KEY               | web/storage-init                  | 是   | 运维提供                    | 未设置   | 是       |
| R2_BUCKET                          | web/storage-init                  | 否   | 运维提供                    | 未设置   | 是       |
| COLLABORA_URL                      | web + collabora                   | 否   | 运维提供                    | 未设置   | 是       |
| COLLABORA_WOPI_URL                 | web                               | 否   | 运维提供                    | 未设置   | 是       |
| NEXT_SERVER_ACTIONS_ENCRYPTION_KEY | 4 个应用服务                      | 是   | 必须等于构建时密钥          | 未设置   | 是       |
| POSTGRES_PASSWORD                  | postgres                          | 是   | 运维提供                    | 未设置   | 是       |
| MINIO_ROOT_USER                    | minio                             | 是   | 运维提供                    | 未设置   | 是       |
| MINIO_ROOT_PASSWORD                | minio                             | 是   | 运维提供                    | 未设置   | 是       |

### 5.2 可选变量（`:-default`）

| 变量名                       | 默认值    | 服务             |
| ---------------------------- | --------- | ---------------- |
| POSTGRES_USER                | postgres  | postgres         |
| POSTGRES_DB                  | beaconhs  | postgres         |
| R2_PRIVATE_BUCKET_CONFIRMED  | false     | web/storage-init |
| SYNC_DATABASE_HOST_ALLOWLIST | 10.0.0.44 | web/worker       |
| VAPID_PUBLIC_KEY             | 空        | web/worker       |
| VAPID_PRIVATE_KEY            | 空        | web/worker       |
| VAPID_SUBJECT                | 空        | web/worker       |

### 5.3 `.env` 文件状态

| 检查项   | 结果                        |
| -------- | --------------------------- |
| 文件存在 | 否（`ls: 无法访问 '.env'`） |
| 权限     | 不适用                      |
| owner    | 不适用                      |
| size     | 不适用                      |

未读取任何 `.env` 内容（文件不存在）。未执行 `docker compose config` 展开敏感变量。

### 5.4 缺失项汇总

全部 21 个必需变量均未设置。**谁提供：** 部署负责人 / 运维。本阶段未生成任何生产凭据，未把占位符当作有效配置。

---

## 6. Server Action Key 验证

### 6.1 四个维度

| 维度                     | 结果                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build-time key           | `/tmp/beaconhs-server-action-key`，ASCII text，45 bytes，`test:test`，mode 600，存在                                                                                         |
| Runtime key              | 测试机 `~/.beaconhs/next_server_actions_key`（45 bytes，`ceshi:ceshi`，600）与 `~/.drill-secrets/action_key`（45 bytes，`ceshi:ceshi`，600），均存在                         |
| Fingerprint verification | 构建时 = `f61da7728f3065df58f9e89aec6985d6`（与 EA-66C.0.1 预期一致，PASS）。运行时 `~/.beaconhs/next_server_actions_key` = `06b5f60d7906ee9414a27cae54173db4`（**不匹配**） |
| Secure transfer status   | **NOT MATCHED** —— 运行时密钥与构建时密钥不同源                                                                                                                              |

> **更正（EA-66D.2.2）：** 本表运行时 fingerprint 曾记录为 `aac818abd1505f96`。该值是用明文
> `SHA256(key 文本)` 计算的，**不是**项目的规范算法。规范算法是
> `HMAC-SHA256(keyBytes, "beaconhs:server-action-key:fingerprint:v1")` 截断 128 位
> （`apps/web/src/lib/server-action-key.ts:97,125-149`）。用项目工具
> `scripts/ci/server-action-key-fingerprint.mjs` 重算，旧密钥的正确规范值是
> `06b5f60d7906ee9414a27cae54173db4`。**不匹配的结论不变**，但比较值本身已修正。

### 6.2 判定

**BUILD-TIME KEY: PASS**

- 文件仍在原构建环境，权限 600，fingerprint 与 EA-66C.0.1 记录的 `f61da7728f3065df58f9e89aec6985d6` 完全一致。

**RUNTIME KEY: BLOCKED（不匹配）**

- 测试机现有 `~/.beaconhs/next_server_actions_key` 的规范 fingerprint 为 `06b5f60d7906ee9414a27cae54173db4`，与构建时密钥不同。
- Compose 注释明确要求运行时 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` 必须等于构建时 `--secret` 内容，否则预渲染的 Server Action 引用无法解密，且滚动重启会中断进行中的 action。
- `~/.drill-secrets/action_key` 属于早期 drill 环境（2026-10-10），不应作为本次正式镜像的运行时密钥。

**处理要求（本阶段未执行）：**

1. 通过安全通道把构建时密钥传输到测试机受保护路径（mode 600，非工作目录）。
2. 或重新构建镜像并改用测试机现有密钥（需重新走 EA-66C 签名链，成本更高）。
3. 传输后必须再次核对 fingerprint 等于 `f61da7728f3065df58f9e89aec6985d6`。
4. 本阶段不读取原文、不输出 Base64、不重新生成、不写入镜像/Git/普通报告、不通过命令行参数暴露。

---

## 7. 首次启动顺序（计划，未执行）

| 步骤 | 动作                               | 依赖      | 预期结果                            |
| ---- | ---------------------------------- | --------- | ----------------------------------- |
| 1    | 创建 3 个外部卷                    | 无        | 已完成                              |
| 2    | 准备 `.env` + 运行时密钥           | 运维      | 21 个变量就绪，key fingerprint 匹配 |
| 3    | `up -d postgres`                   | 步骤 2    | 容器 running                        |
| 4    | 等待 postgres healthy              | 步骤 3    | healthcheck 通过                    |
| 5    | 执行 provision.sql（4 个密码变量） | 步骤 4    | 5 角色 + beaconhs 库 + 扩展就绪     |
| 6    | `up -d redis minio`                | 步骤 5    | 两者 healthy                        |
| 7    | `run --rm storage-init`            | 步骤 6    | 退出码 0                            |
| 8    | `run --rm scheduler`               | 步骤 6    | 退出码 0                            |
| 9    | `up -d web worker`                 | 步骤 7、8 | 两者 healthy                        |
| 10   | `up -d collabora`                  | 步骤 9    | running                             |
| 11   | 全量 healthcheck 复核              | 步骤 10   | 全部 healthy                        |
| 12   | Gate 5 reconcile                   | 步骤 11   | VERDICT: PASS                       |

### 7.1 自动行为识别

| 项目                           | 是否存在 | 说明                                                                                                                                                                                  |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自动 Migration                 | 是       | 应用启动时执行 Drizzle migration（含 0051_ea12_drop_dead_columns.sql）。因此 provision 必须在应用启动前完成。                                                                         |
| 自动创建数据库角色             | 否       | provision.sql 不会自动执行；Compose 注释明确 "no initdb helper with baked-in passwords may run here"。                                                                                |
| 重复初始化风险                 | 低       | provision.sql 幂等；storage-init 幂等；scheduler 可重复运行。                                                                                                                         |
| 首次启动失败留下不完整数据风险 | 中       | 若 provision 未完成即启动 web，migration 会因缺少角色/权限失败，但空卷上不会产生脏数据；修正后重跑即可。若 provision 中途失败（ON_ERROR_STOP），已创建的角色/库会保留，重跑幂等收敛。 |

---

## 8. 容量复核

### 8.1 卷创建后实测

| 资源          | 值                                    |
| ------------- | ------------------------------------- |
| 磁盘          | 124G 总计 / 49G 已用 / 69G 可用 / 42% |
| 内存          | 7.7Gi 总计 / 6.3Gi 可用 / swap 3.8Gi  |
| Docker Images | 30.11GB（可回收 27.72GB）             |
| Containers    | 0B                                    |
| Local Volumes | 3 个卷，合计 0B                       |
| Build Cache   | 0B                                    |

### 8.2 评估

| 项目 | 可用  | 预估需求                                           | 结论 |
| ---- | ----- | -------------------------------------------------- | ---- |
| 磁盘 | 69GB  | 32-53GB（含 Docker 可写层、PG、MinIO、上传、预留） | PASS |
| 内存 | 6.3Gi | 2-4Gi                                              | PASS |
| CPU  | 8 核  | 4-6 核                                             | PASS |

三个新卷创建后磁盘可用空间无变化（空卷不占数据空间）。未删除任何系统文件或其他镜像。

---

## 9. 剩余风险

| 风险                         | 严重性 | 说明                                                                                      | 处置                                 |
| ---------------------------- | ------ | ----------------------------------------------------------------------------------------- | ------------------------------------ |
| 运行时密钥与构建时密钥不匹配 | HIGH   | fingerprint `aac818abd1505f96` ≠ `f61da7728f3065df58f9e89aec6985d6`，Server Action 会失败 | 安全传输构建时密钥后复核 fingerprint |
| `.env` 完全缺失              | HIGH   | 21 个必需变量全部未设置，Compose 无法渲染                                                 | 运维提供                             |
| provision 未执行             | HIGH   | 无 beaconhs 角色与数据库，应用启动即失败                                                  | 按第 7 节顺序执行                    |
| 报告原 psql 命令有误         | MEDIUM | 端口/变量/库名三处缺陷，照抄会失败                                                        | 使用第 4.2 节审计后命令              |
| 宿主机 5433 暴露 postgres    | LOW    | 仅 loopback，符合设计                                                                     | 无需处理                             |
| Gate 5 依赖 RepoDigest       | LOW    | 离线导入后 RepoDigest 可能为空，但脚本将其视为辅助证据，不据此判失败                      | 无需处理                             |

---

## 10. 是否 READY FOR STARTUP AUTHORIZATION

**判定：READY WITH CONDITIONS**

启动前必须满足：

1. 通过安全通道提供构建时密钥到测试机受保护路径，并复核 fingerprint = `f61da7728f3065df58f9e89aec6985d6`。
2. 提供全部 21 个必需环境变量（`.env`，mode 600，owner ceshi）。
3. 确认 4 个 provision 密码变量由运维提供。
4. 按第 7 节顺序执行，provision 在 web/worker 启动之前完成。

外部卷、配置一致性、启动顺序、容量四项已就绪。

---

## 11. 证据索引

| File                                              | Contents                        |
| ------------------------------------------------- | ------------------------------- |
| `deploy/local-production.compose.yaml`            | Canonical Compose 配置          |
| `deploy/gate5.manifest.yaml`                      | Gate 5 Manifest                 |
| `scripts/cluster/provision.sql`                   | 数据库 provision 脚本（174 行） |
| `scripts/ci/server-action-key-fingerprint.mjs`    | fingerprint 验证工具            |
| `docs/ea66d2-preflight-audit-report.md`           | EA-66D.2.0 审计报告             |
| `docs/ea66d1-offline-import-validation-report.md` | EA-66D.1 报告                   |
| 本报告                                            | EA-66D.2.1 准备报告             |

---

**报告生成时间：** 2026-10-31 (UTC)
**审计范围：** 隔离测试环境启动前准备
**最终判定：** READY WITH CONDITIONS

---

## 下一步

**已完成：** 三个外部卷、provision 审计、变量清单、启动顺序、容量复核。

**待完成（需用户授权/提供）：**

1. 运行时密钥安全传输（fingerprint 必须匹配构建时密钥）
2. `.env` 与 21 个必需变量
3. provision 密码变量
4. 启动授权

**禁止：** 不自动启动 PostgreSQL，不执行 provision.sql，不启动 Canonical Compose，不自动修复密钥不匹配。

生产状态：`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
Rollback：`FAIL — NO EXECUTABLE ROLLBACK PATH`

**本阶段完成，等待用户明确授权。**
