# EA-66D.2.2：Runtime Key 修复与运行环境变量准备报告

**Phase type:** 隔离测试环境运行时密钥修复与运行环境变量准备。
**Verdict:** **READY FOR POSTGRESQL START AUTHORIZATION**（附条件）
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. 执行摘要

本阶段解决 EA-66D.2.1 发现的两个 HIGH 阻塞项，并额外发现并修复了两个此前未记录的问题。

| 类别                                          | 结果                                     |
| --------------------------------------------- | ---------------------------------------- |
| Runtime Server Action Key 修复                | **PASS** — fingerprint 现与构建时一致    |
| 旧密钥备份                                    | **PASS** — `.previous` 受保护保留        |
| 21 个必需环境变量                             | **PASS** — 全部就位，0 缺失              |
| 四个数据库角色密码                            | **PASS** — 独立、互不相同、映射一致      |
| 安全传输与权限                                | **PASS** — 0600 文件 / 0700 目录         |
| Git 泄漏检查                                  | **PASS** — 无敏感文件被跟踪              |
| 生产端点检查                                  | **PASS** — 无外部生产端点                |
| Compose 静态渲染                              | **PASS** — 8 服务全部 digest 固定        |
| Gate 5 静态一致性                             | **PASS** — 8/8 服务标签与 digest 匹配    |
| **额外发现：目标端无 Canonical Compose**      | **已修复** — 部署到独立目录，SHA256 一致 |
| **额外发现：EA-66D.2.1 fingerprint 算法错误** | **已更正** — 见 §3.4                     |

---

## 2. Runtime Key 修复结果

### 2.1 源端核实

| 检查项           | 值                                    |
| ---------------- | ------------------------------------- |
| 路径             | `/tmp/beaconhs-server-action-key`     |
| 文件类型         | regular file（`test -f` 通过）        |
| Owner / Group    | `test` / `test`                       |
| Mode             | `0600`                                |
| Size             | 45 bytes（44 字符 base64 + 尾随换行） |
| 规范 fingerprint | `f61da7728f3065df58f9e89aec6985d6` ✅ |

指纹工具：`scripts/ci/server-action-key-fingerprint.mjs`（项目现有工具，SHA256 `782139003d3790aa…`，目标端副本与仓库端**字节一致**）。

### 2.2 目标端核实（修复前）

| 检查项                   | 值                                           |
| ------------------------ | -------------------------------------------- |
| 目标目录                 | `~/.beaconhs`，owner `ceshi`，mode `0700` ✅ |
| 当前密钥文件类型         | regular file ✅                              |
| 当前密钥权限             | `0600`，owner `ceshi` ✅                     |
| 当前密钥 size            | 45 bytes                                     |
| 当前密钥规范 fingerprint | `06b5f60d7906ee9414a27cae54173db4`           |
| `.previous` 是否存在     | 否（可安全创建备份）                         |
| `.new` 是否存在          | 否（可安全创建临时文件）                     |

### 2.3 安全传输

| 要求                           | 落实方式                                       |
| ------------------------------ | ---------------------------------------------- |
| 不通过命令行参数传递密钥       | `scp` 直接传输文件，argv 只有路径              |
| 不复制到普通仓库目录           | 目标为 `~/.beaconhs/`（0700）                  |
| 不使用公共临时目录保存明文密钥 | 直接落目标端专用路径，未在 `/tmp` 留副本       |
| 不使用终端回显密钥             | 无 `cat`/`echo` 密钥内容的操作                 |
| 不写入 shell history           | 非交互式 SSH 会话，无 history 记录             |
| 先传到专用临时文件             | `~/.beaconhs/next_server_actions_key.new`      |
| 临时文件权限 0600              | 传输后显式 `chmod 600` 复核                    |
| 传输后验证 fingerprint         | `f61da7728f3065df58f9e89aec6985d6` ✅          |
| 仅验证通过才替换               | 验证通过后才执行 rename                        |
| 旧密钥保留为受保护备份         | `~/.beaconhs/next_server_actions_key.previous` |
| 同文件系统原子 rename          | 两次 `mv`（同目录同 fs）                       |

传输一致性额外用 SHA256 交叉验证：源端与目标端 `.new` 均为 `c7513c8e6eff8acff1672d76f9c4b913ed03a575da57e78bdc8a898092e36cdd`（字节级一致）。

### 2.4 替换后最终状态

| 文件                                           | Owner   | Mode   | Size | 存在        |
| ---------------------------------------------- | ------- | ------ | ---- | ----------- |
| `~/.beaconhs/next_server_actions_key`          | `ceshi` | `0600` | 45   | ✅          |
| `~/.beaconhs/next_server_actions_key.previous` | `ceshi` | `0600` | 45   | ✅          |
| `~/.beaconhs/next_server_actions_key.new`      | —       | —      | —    | ✅ 已不存在 |
| `~/.beaconhs/`（目录）                         | `ceshi` | `0700` | —    | ✅          |

---

## 3. Build-time / Runtime Fingerprint 比对

### 3.1 最终比对

| 角色                                    | Fingerprint                        | 状态               |
| --------------------------------------- | ---------------------------------- | ------------------ |
| Build-time key                          | `f61da7728f3065df58f9e89aec6985d6` | 基准               |
| Runtime key（修复后，正式文件）         | `f61da7728f3065df58f9e89aec6985d6` | ✅ **一致**        |
| Runtime key（旧密钥，`.previous` 备份） | `06b5f60d7906ee9414a27cae54173db4` | 已归档，保留供审计 |

### 3.2 Runtime Key 注入

`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` 不写入 `local-prod.env`，而是放在独立文件
`~/.beaconhs/runtime/server-action-key.env`（0600）。其 value 与密钥文件内容**逐字节相同**
（44 字符，已单独用项目工具验证规范 fingerprint = `f61da7728f3065df58f9e89aec6985d6`）。

启动时通过两个 `--env-file` 叠加注入：

```bash
docker compose \
  --env-file ~/.beaconhs/runtime/local-prod.env \
  --env-file ~/.beaconhs/runtime/server-action-key.env \
  -f deploy/local-production.compose.yaml <command>
```

### 3.3 旧密钥备份状态

| 项           | 值                                             |
| ------------ | ---------------------------------------------- |
| 路径         | `~/.beaconhs/next_server_actions_key.previous` |
| Owner / Mode | `ceshi` / `0600`                               |
| Size         | 45 bytes                                       |
| 是否被删除   | 否                                             |
| 用途         | 审计追溯；**不得**作为运行时密钥使用           |

### 3.4 EA-66D.2.1 报告 fingerprint 更正

EA-66D.2.1 §6 记录运行时旧密钥 fingerprint 为 `aac818abd1505f96`。该值是用**明文
`SHA256(key 文本)`** 计算的，与项目规范算法不符。

规范算法（`apps/web/src/lib/server-action-key.ts:97,125-149`）是
`HMAC-SHA256(keyBytes, "beaconhs:server-action-key:fingerprint:v1")` 截断 128 位。

用项目工具重算，旧密钥的正确规范值是 `06b5f60d7906ee9414a27cae54173db4`。
**不匹配的结论不变**，比较值本身已在 `docs/ea66d2-1-startup-preparation-report.md` 更正。

---

## 4. 21 个环境变量逐项状态

变量清单来源：`docs/ea66d2-1-startup-preparation-report.md` §5.1（未自行猜测名称）。

| #   | Variable                             | Service                           | Required | Sensitive | Default | Source           | Test value | Status    |
| --- | ------------------------------------ | --------------------------------- | -------- | --------- | ------- | ---------------- | ---------- | --------- |
| 1   | `BEACONHS_IMAGE`                     | web/worker/scheduler/storage-init | 是       | 否        | 无      | C — 构建产物     | 是         | **READY** |
| 2   | `BEACONHS_DEPLOYMENT_ID`             | 全部 8 服务                       | 是       | 否        | 无      | C — 部署身份     | 是         | **READY** |
| 3   | `BEACONHS_IMAGE_DIGEST`              | 4 个 gated 服务                   | 是       | 否        | 无      | C — 镜像 digest  | 是         | **READY** |
| 4   | `APP_VERSION`                        | 4 个应用服务                      | 是       | 否        | 无      | C — 构建 commit  | 是         | **READY** |
| 5   | `DATABASE_URL`                       | 4 个应用服务                      | 是       | 是        | 无      | A — 随机测试凭据 | 是         | **READY** |
| 6   | `SUPERADMIN_DATABASE_URL`            | 4 个应用服务                      | 是       | 是        | 无      | A — 随机测试凭据 | 是         | **READY** |
| 7   | `REDIS_URL`                          | 4 个应用服务                      | 是       | 是        | 无      | B — 网络拓扑     | 是         | **READY** |
| 8   | `BETTER_AUTH_SECRET`                 | 4 个应用服务                      | 是       | 是        | 无      | A — 随机测试凭据 | 是         | **READY** |
| 9   | `ATTACHMENT_CAPABILITY_SECRET`       | 4 个应用服务                      | 是       | 是        | 无      | A — 随机测试凭据 | 是         | **READY** |
| 10  | `APP_URL`                            | 4 个应用服务 + collabora          | 是       | 否        | 无      | B — 本机回环     | 是         | **READY** |
| 11  | `R2_ENDPOINT`                        | web/storage-init                  | 是       | 否        | 无      | B — 测试域名     | 是         | **READY** |
| 12  | `R2_INTERNAL_ENDPOINT`               | web/storage-init                  | 是       | 否        | 无      | B — 内网络       | 是         | **READY** |
| 13  | `R2_ACCESS_KEY_ID`                   | web/storage-init                  | 是       | 是        | 无      | A — 随机测试凭据 | 是         | **READY** |
| 14  | `R2_SECRET_ACCESS_KEY`               | web/storage-init                  | 是       | 是        | 无      | A — 随机测试凭据 | 是         | **READY** |
| 15  | `R2_BUCKET`                          | web/storage-init                  | 是       | 否        | 无      | B — 桶名         | 是         | **READY** |
| 16  | `COLLABORA_URL`                      | web + collabora                   | 是       | 否        | 无      | B — 测试域名     | 是         | **READY** |
| 17  | `COLLABORA_WOPI_URL`                 | web                               | 是       | 否        | 无      | B — 内网络       | 是         | **READY** |
| 18  | `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | 4 个应用服务                      | 是       | 是        | 无      | C — 构建时密钥   | 是         | **READY** |
| 19  | `POSTGRES_PASSWORD`                  | postgres                          | 是       | 是        | 无      | A — 随机测试凭据 | 是         | **READY** |
| 20  | `MINIO_ROOT_USER`                    | minio                             | 是       | 是        | 无      | A — 随机测试凭据 | 是         | **READY** |
| 21  | `MINIO_ROOT_PASSWORD`                | minio                             | 是       | 是        | 无      | A — 随机测试凭据 | 是         | **READY** |

**缺失数：0。** 所有变量来源明确、值已验证。

### 4.1 额外提供的变量（非 Compose 必需，但运行所需）

| Variable                      | 用途                                | 状态          |
| ----------------------------- | ----------------------------------- | ------------- |
| `MIGRATION_DATABASE_URL`      | 迁移专用连接（`beaconhs_migrator`） | READY         |
| `POSTGRES_USER`               | Compose 有默认值 `postgres`         | READY（显式） |
| `POSTGRES_DB`                 | Compose 有默认值 `beaconhs`         | READY（显式） |
| `PUBLIC_APP_URL`              | 浏览器可见源                        | READY         |
| `R2_PRIVATE_BUCKET_CONFIRMED` | Compose 有默认值 `false`            | READY（显式） |

### 4.2 可选变量（保持 Compose 默认，未设置）

`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`、`SYNC_DATABASE_HOST_ALLOWLIST` — 保持默认，不写入。

### 4.3 变量文件结构

| 文件                                        | 变量数 | Owner   | Mode   | Size   |
| ------------------------------------------- | ------ | ------- | ------ | ------ |
| `~/.beaconhs/runtime/local-prod.env`        | 25     | `ceshi` | `0600` | 1984 B |
| `~/.beaconhs/runtime/server-action-key.env` | 1      | `ceshi` | `0600` | 80 B   |
| `~/.beaconhs/runtime/provision-vars.env`    | 4      | `ceshi` | `0600` | 405 B  |

---

## 5. 测试凭据与外部提供凭据分类

### 5.1 A 类：隔离测试环境可生成的随机凭据

在目标端**本地**生成（`openssl rand`，不经网络传输、不回显）：

| 凭据                           | 长度 | 字符集    | 用途                                           |
| ------------------------------ | ---- | --------- | ---------------------------------------------- |
| `beaconhs_app` 密码            | 32   | base64url | `DATABASE_URL` + `app_password`                |
| `beaconhs_super` 密码          | 32   | base64url | `SUPERADMIN_DATABASE_URL` + `super_password`   |
| `beaconhs_migrator` 密码       | 32   | base64url | `MIGRATION_DATABASE_URL` + `migrator_password` |
| `beaconhs_backup` 密码         | 32   | base64url | `backup_password`                              |
| `postgres` 超级用户密码        | 32   | base64url | `POSTGRES_PASSWORD`                            |
| `BETTER_AUTH_SECRET`           | 44   | base64url | 认证密钥（≥32 要求）                           |
| `ATTACHMENT_CAPABILITY_SECRET` | 44   | base64url | 附件签名密钥（≥32 要求）                       |
| `MINIO_ROOT_USER`              | 16   | hex       | MinIO 用户名                                   |
| `MINIO_ROOT_PASSWORD`          | 32   | base64url | `MINIO_ROOT_PASSWORD` + `R2_SECRET_ACCESS_KEY` |

**隔离性核对：**

| 检查项                | 结果                                                  |
| --------------------- | ----------------------------------------------------- |
| 不与生产凭据共享      | ✅ 全部为本次新生成，未读取任何生产值                 |
| 不与其他测试环境共享  | ✅ 未复用 `~/.drill-secrets/` 中的旧 drill 凭据       |
| 不写入 Git 或日志     | ✅ 仅存在于目标端 0600 文件                           |
| 服务间引用一致        | ✅ 三个数据库 URL 的密码段与 provision 变量逐项 MATCH |
| 与 provision 变量一致 | ✅ app/super/migrator 三项 MATCH                      |

**注意：** `postgres` 超级用户密码与 `beaconhs_app` 密码是**两个独立值**。初版曾误用同一个值，已修正。

### 5.2 B 类：需要运维/项目配置提供的参数

| 变量                         | 现状                                           | 责任方                       |
| ---------------------------- | ---------------------------------------------- | ---------------------------- |
| `APP_URL` / `PUBLIC_APP_URL` | 已用 `http://127.0.0.1:3000`（本机回环，隔离） | 部署负责人（生产需公网域名） |
| `R2_ENDPOINT`                | 已用 `https://minio.beaconhs-test.local`       | 部署负责人（生产需真实域名） |
| `R2_INTERNAL_ENDPOINT`       | 已用 `http://minio:9000`（内网络）             | 部署负责人                   |
| `R2_BUCKET`                  | 已用 `beaconhs-local-prod`                     | 部署负责人                   |
| `COLLABORA_URL`              | 已用 `https://collabora.beaconhs-test.local`   | 部署负责人                   |
| `COLLABORA_WOPI_URL`         | 已用 `http://web:3000`（内网络）               | 部署负责人                   |
| `REDIS_URL`                  | 已用 `redis://redis:6379`（内网络）            | 部署负责人                   |

隔离测试环境无需外部提供即可运行；生产部署时必须由运维替换为真实值。

### 5.3 C 类：必须与正式构建/部署身份一致

| 变量                                 | 值                                                                                 | 依据                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `BEACONHS_IMAGE`                     | `beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795` | EA-66D.0/1 导入镜像的 Image ID                                           |
| `BEACONHS_IMAGE_DIGEST`              | 同上                                                                               | 与镜像 `RepoDigests` 一致                                                |
| `BEACONHS_DEPLOYMENT_ID`             | `51a899b7aac0a942da327222a3eed355fca9798a-ea66d2-001`                              | 格式 `<40hex>-<runid>-<attempt>`，符合 `reconcile-compose-digest.sh:327` |
| `APP_VERSION`                        | `51a899b7aac0a942da327222a3eed355fca9798a`                                         | 仓库 HEAD = 镜像 label `com.beaconhs.git-head`                           |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | 构建时密钥内容                                                                     | 见 §2、§3                                                                |

镜像身份标签（目标端实测）：

```
com.beaconhs.deployment-id         = 406f0c00d0e42bc1e578acf0e5af86b14bd7e175
com.beaconhs.git-head               = 51a899b7aac0a942da327222a3eed355fca9798a
com.beaconhs.source-archive-sha256  = 927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9
```

**补充纠正：** EA-66D.2.0 曾担心"离线导入后 RepoDigest 可能不保留"。实测**保留**：

```
postgres:16-alpine  -> ["postgres@sha256:721873c34ceb9f8…"]
redis:7-alpine      -> ["redis@sha256:858f009f9709ce57…"]
minio/minio:latest  -> ["minio/minio@sha256:b187417eee0a…", …]
collabora/code      -> ["collabora/code@sha256:4e983196eb98…"]
beaconhs:ea66c1-formal -> ["beaconhs@sha256:1834f8679619…"]
```

---

## 6. 四个数据库密码变量准备状态

### 6.1 变量与角色映射

核对自 `scripts/cluster/provision.sql`：

| psql 变量           | PostgreSQL 角色     | 属性                                      | 映射来源                         |
| ------------------- | ------------------- | ----------------------------------------- | -------------------------------- |
| `app_password`      | `beaconhs_app`      | LOGIN, NOINHERIT, NOBYPASSRLS             | `DATABASE_URL` 密码段            |
| `super_password`    | `beaconhs_super`    | LOGIN, NOINHERIT, **BYPASSRLS**           | `SUPERADMIN_DATABASE_URL` 密码段 |
| `migrator_password` | `beaconhs_migrator` | LOGIN, NOINHERIT, 可 SET ROLE owner       | `MIGRATION_DATABASE_URL` 密码段  |
| `backup_password`   | `beaconhs_backup`   | LOGIN, NOINHERIT, **BYPASSRLS**, 默认只读 | 独立生成                         |

`beaconhs_owner` 是 NOLOGIN，无密码。

### 6.2 与 `.env` 变量是否重复

| 变量                | 与 env 变量关系                                          |
| ------------------- | -------------------------------------------------------- |
| `app_password`      | **值**与 `DATABASE_URL` 密码段相同（同一角色，一处真相） |
| `super_password`    | **值**与 `SUPERADMIN_DATABASE_URL` 密码段相同            |
| `migrator_password` | **值**与 `MIGRATION_DATABASE_URL` 密码段相同             |
| `backup_password`   | 无对应 env URL（仅备份角色使用）                         |

**未重复存放同一凭据的独立副本**：`provision-vars.env` 是 env 中 URL 密码段的镜像，不是第二次生成。

### 6.3 是否必须使用不同密码

| 检查                                         | 结果          |
| -------------------------------------------- | ------------- |
| 四个角色密码互不相同                         | ✅ 4 个不同值 |
| `backup_password` 独立于其余三者             | ✅            |
| `postgres` 超级用户密码独立于 `beaconhs_app` | ✅            |
| 与生产密码不同                               | ✅ 本次新生成 |

### 6.4 特殊字符与转义

| 检查项                                | 结果                            |
| ------------------------------------- | ------------------------------- |
| 密码字符集                            | base64url（`A-Za-z0-9_-`）+ hex |
| 引号 `'`                              | 无                              |
| 反斜杠 `\`                            | 无                              |
| 空格                                  | 无                              |
| `$`（Compose 插值触发符）             | 无                              |
| URI 中需转义的字符（`@ : / ? # % &`） | 无                              |
| SQL 字面量需转义的字符                | 无                              |

**结论：** 无转义风险。`psql` 的 `format('%L', …)` 会对密码做字面量转义，即使有特殊字符也安全 — 但本环境已消除该需要。

### 6.5 provision 是否会设置或更新角色密码

会。脚本对 `beaconhs_migrator`、`beaconhs_app`、`beaconhs_super`、`beaconhs_backup` 每个角色执行两次：

```sql
-- 首次创建时（若不存在）
CREATE ROLE ... PASSWORD %L
-- 每次执行都执行（幂等重置）
ALTER ROLE ... PASSWORD %L
```

因此 `ALTER ROLE ... PASSWORD` 使 provision **可重复执行**且保证密码与预期一致 — 这正是"密码只在 provision-vars.env 中保存一份"能成立的前提。

### 6.6 安全参数注入方案（已确定，本阶段未执行）

**问题：** `psql -v app_password=... -v super_password=...` 把全部密码放进 argv → `/proc/<pid>/cmdline` 对同机任何用户可见，且进入 shell history。

**采用方案：**

| 秘密                  | 注入方式                                                        | 出现在 argv？ | 出现在 history？ |
| --------------------- | --------------------------------------------------------------- | ------------- | ---------------- |
| postgres 超级用户密码 | 从 0600 文件读入 `PGPASSWORD` 环境变量                          | 否            | 否               |
| 四个角色密码          | 写入 0600 psql 包装脚本，用 `\set` 定义后 `\i` include 真实 SQL | 否            | 否               |
| 两者                  | `mktemp -d` 私有目录 + `trap ... EXIT` 清理                     | —             | —                |

包装脚本已创建：`~/.beaconhs/scripts/provision-db.sh`（0700，2705 B），`bash -n` 语法检查通过。

**执行方式（需授权）：**

```bash
~/.beaconhs/scripts/provision-db.sh
```

脚本内：`psql -X --set=ON_ERROR_STOP=1 --host=127.0.0.1 --port=5433 --username=postgres --dbname=postgres --file=<wrapper>`

**待验证项：** 需在 PostgreSQL 实际启动后确认 `PGPASSWORD` 认证路径与 `\set` + `\i` 组合可用（当前宿主机无 psql，容器内有 16.15）。

---

## 7. 安全传输和权限检查

### 7.1 目标端敏感文件

| 文件                                           | Owner   | Mode   | Size |
| ---------------------------------------------- | ------- | ------ | ---- |
| `~/.beaconhs/next_server_actions_key`          | `ceshi` | `0600` | 45   |
| `~/.beaconhs/next_server_actions_key.previous` | `ceshi` | `0600` | 45   |
| `~/.beaconhs/runtime/local-prod.env`           | `ceshi` | `0600` | 1984 |
| `~/.beaconhs/runtime/server-action-key.env`    | `ceshi` | `0600` | 80   |
| `~/.beaconhs/runtime/provision-vars.env`       | `ceshi` | `0600` | 405  |
| `~/.beaconhs/scripts/provision-db.sh`          | `ceshi` | `0700` | 2705 |

### 7.2 目录权限

| 目录                   | Owner   | Mode   |
| ---------------------- | ------- | ------ |
| `~/.beaconhs`          | `ceshi` | `0700` |
| `~/.beaconhs/runtime`  | `ceshi` | `0700` |
| `~/.beaconhs/scripts`  | `ceshi` | `0700` |
| `~/beaconhs-canonical` | `ceshi` | `0700` |

### 7.3 Canonical 部署目录内容（无敏感文件）

| 文件                                   | Mode | 说明                                                                                            |
| -------------------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| `deploy/local-production.compose.yaml` | 0644 | Canonical Compose，SHA256 `9700f4805e7633cc44fc59c98d854ad9a7b8ddee82f7fa854539ec1e166082db`    |
| `deploy/gate5.manifest.yaml`           | 0644 | Gate 5 Manifest，SHA256 `6bc70fa0e42ad267926592359db45f7c7cfc34721df8feb96d149f67b85dd1ab`      |
| `deploy/collabora-branding.js`         | 0664 | 只读 bind mount 依赖，SHA256 `730d1827c652fcd4b7ed94e81a07397401607e50659fd5bfbe17235834aa29cc` |
| `scripts/cluster/provision.sql`        | 0664 | 只读 bind mount 依赖，SHA256 `e6de5f65d1b0a48e57c5b0c86cbff7ab65b9b7284192496513eafa90bd13b170` |

四个文件 SHA256 与仓库端**逐字节一致**。敏感 env **不在**该目录内。

### 7.4 关键发现：目标端原本没有 Canonical Compose

目标端三个 checkout（`beaconhs-phase-aj`、`beaconhs-drill`、`beaconhs-e3`）中的
`local-production.compose.yaml` **全部是 EA-65.1 之前的版本**，SHA256 分别为
`0337d38e…` / `02d93723…`，**没有任何 `com.beaconhs.deployment` 标签**。

用旧文件渲染会得到 `postgres:16-alpine`（浮动 tag，丢失 digest），Gate 5 必然失败。

处置：把 Canonical Compose 部署到**新建的独立目录** `~/beaconhs-canonical/`（0700），
不修改任何既有 checkout。四个文件 SHA256 与仓库一致。

**修正 `docs/project-development-state.md:1135`** 的过时记录 —— 它称目标端
`local-production.compose.yaml` 与仓库 "byte-identical"，实际并非如此。

### 7.5 `.env` 路径的实证结论

Docker Compose 默认从**第一个 `-f` 文件所在目录**读取 `.env`。在目标端用最小化探针实测：

| 场景                           | 结果                                         |
| ------------------------------ | -------------------------------------------- |
| `deploy/.env` 存在，PWD=项目根 | 读取到 `deploy/.env`                         |
| 仅项目根 `.env` 存在           | **读取不到**（报 required variable missing） |

因此 Canonical Compose 的 env 路径为 `~/beaconhs-canonical/deploy/.env`。本阶段**未**在该路径创建
env 文件，改用 `--env-file` 显式指定 `~/.beaconhs/runtime/` 下的受保护文件 — 避免在
`deploy/`（mode 775）中放置 0600 敏感文件。

**注意：** 目标端既有 `~/beaconhs-phase-aj/.env`（owner `ceshi:docker`，mode 664）**不会被**
Canonical Compose 读取（不在其 `deploy/` 目录内），但其 mode 664 是既有弱点，本阶段未修改
（不在授权范围内，且属于用户原有工作区内容）。

---

## 8. Git 泄漏检查

| 检查项                                             | 结果                                   |
| -------------------------------------------------- | -------------------------------------- |
| 仓库端敏感文件被 Git 跟踪                          | ✅ 无                                  |
| `.gitignore` 覆盖 `.env`                           | ✅ `.gitignore:13`                     |
| 目标端 `~/beaconhs-canonical` 是 Git 仓库          | ❌ 否（无 `.git`），故不存在误提交路径 |
| 敏感文件是否位于任何 Git 工作区内                  | ✅ 否，全部在 `~/.beaconhs/`（0700）   |
| 本阶段是否修改 Canonical Compose / Gate 5 Manifest | ✅ 否，只做字节级复制                  |
| 本阶段是否执行 commit / push / CI                  | ✅ 否                                  |

**已核对的未跟踪敏感文件路径**（仓库内均不存在或未被跟踪）：`.beaconhs/runtime/local-prod.env`、
`.beaconhs/runtime/server-action-key.env`、`.beaconhs/runtime/provision-vars.env`、
`.beaconhs/scripts/provision-db.sh`、`local-prod.env`、`provision-vars.env`、`server-action-key.env`。

---

## 9. 剩余阻塞项

| #   | 项目                                      | 严重性 | 状态     | 说明                                                                                                                                         |
| --- | ----------------------------------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `PGPASSWORD` + `\set`/`\i` 注入路径       | MEDIUM | 待验证   | 需 PostgreSQL 启动后确认认证与变量展开（宿主机无 psql，容器内 16.15）                                                                        |
| 2   | 迁移执行者未在 Compose 中                 | MEDIUM | 需决策   | Canonical Compose 8 服务**无** `migrate` 角色；`docker/entrypoint.sh:24` 支持 `APP_ROLE=migrate`，但须由 `apps/ops-migrate` 独立部署目标执行 |
| 3   | 首个平台管理员                            | MEDIUM | 需决策   | `bootstrap-admin` 同样不在 Compose 中；`PRODUCTION_RUNBOOK.md:11,38` 要求迁移后创建首个管理员                                                |
| 4   | `~/beaconhs-phase-aj/.env` mode 664       | LOW    | 未处理   | 既有弱点，不在授权范围，未修改                                                                                                               |
| 5   | 目标端 `~/beaconhs-canonical` 非 Git 仓库 | LOW    | 已缓解   | 无误提交路径；敏感文件不在该目录                                                                                                             |
| 6   | `APP_URL` / `R2_ENDPOINT` 为测试值        | LOW    | 设计如此 | 隔离环境；生产需运维替换为真实公网域名                                                                                                       |
| 7   | 生产部署                                  | —      | PENDING  | `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`                                                                                              |
| 8   | Rollback                                  | —      | FAIL     | `FAIL — NO EXECUTABLE ROLLBACK PATH`                                                                                                         |

---

## 10. 最终判定

### 10.1 判定

**READY FOR POSTGRESQL START AUTHORIZATION**（附条件）

### 10.2 判定依据

| #   | 条件                                  | 状态                                              |
| --- | ------------------------------------- | ------------------------------------------------- |
| 1   | Build-time / Runtime fingerprint 一致 | ✅ `f61da7728f3065df58f9e89aec6985d6`             |
| 2   | 旧密钥受保护保留                      | ✅ `.previous`，0600                              |
| 3   | 21 个必需变量就位                     | ✅ 0 缺失                                         |
| 4   | 四个 provision 密码来源明确           | ✅ 独立、互不相同、映射 MATCH                     |
| 5   | 应用数据库连接参数一致                | ✅ app/super/migrator 三项 MATCH                  |
| 6   | Redis / MinIO / Collabora 参数一致    | ✅ `redis://redis:6379`、`minio:9000`、`web:3000` |
| 7   | 测试配置无生产端点                    | ✅ 端点清单全部本地/内网络/测试域名               |
| 8   | 敏感文件不在 Git 跟踪范围             | ✅                                                |
| 9   | 敏感文件权限正确                      | ✅ 0600 文件 / 0700 目录                          |
| 10  | Canonical Compose 已就位于目标端      | ✅ 独立目录，SHA256 一致                          |
| 11  | Compose 静态渲染通过                  | ✅ 8 服务 / 0 错误                                |
| 12  | 8 服务全部 digest 固定                | ✅                                                |
| 13  | Gate 5 静态一致性                     | ✅ 8/8 PASS                                       |
| 14  | 三个外部卷就位                        | ✅                                                |

### 10.3 启动 PostgreSQL 前仍需满足

1. **必须**：确认 `provision-db.sh` 的 `PGPASSWORD` 认证与 `\set`/`\i` 路径可用（阻塞项 #1）。
2. **必须**：决定迁移执行方式 — Compose 无 `migrate` 服务（阻塞项 #2）。
3. **必须**：决定首个平台管理员的创建方式（阻塞项 #3）。
4. 建议：生产前由运维替换 `APP_URL`、`R2_ENDPOINT`、`COLLABORA_URL` 为真实域名。

### 10.4 本阶段已遵守的停止条件

未启动 PostgreSQL、未执行 `provision.sql`、未启动 Redis/MinIO/Collabora、未运行
storage-init、未启动 web/worker/scheduler、未运行 Gate 5、未执行 Migration 51、未重新生成
Server Action Key、未删除任何旧密钥或旧配置、未修改 Canonical Compose 或 Gate 5 Manifest、
未修改用户原有工作区内容、未执行 commit/push/CI、未输出任何密钥原文或密码。

---

## 11. 证据索引

| File                                                    | Contents                        |
| ------------------------------------------------------- | ------------------------------- |
| `docs/ea66d2-1-startup-preparation-report.md`           | 前置审计（含 fingerprint 更正） |
| `docs/ea66d2-preflight-audit-report.md`                 | EA-66D.2.0 启动前审计           |
| `docs/ea66c4-cosign-security-audit-report.md`           | Cosign 审计                     |
| `deploy/local-production.compose.yaml`                  | Canonical Compose（源）         |
| `deploy/gate5.manifest.yaml`                            | Gate 5 Manifest（源）           |
| `scripts/cluster/provision.sql`                         | 数据库 provision 脚本           |
| `scripts/ci/server-action-key-fingerprint.mjs`          | 规范 fingerprint 工具           |
| `apps/web/src/lib/server-action-key.ts`                 | 规范算法实现                    |
| `~/beaconhs-canonical/` (目标端)                        | Canonical 部署目录，SHA256 一致 |
| `~/.beaconhs/runtime/local-prod.env` (目标端)           | 25 个运行时变量，0600           |
| `~/.beaconhs/runtime/server-action-key.env` (目标端)    | Server Action 密钥注入，0600    |
| `~/.beaconhs/runtime/provision-vars.env` (目标端)       | 四个角色密码，0600              |
| `~/.beaconhs/scripts/provision-db.sh` (目标端)          | 安全 provision 执行器，0700     |
| `~/.beaconhs/next_server_actions_key.previous` (目标端) | 旧密钥受保护备份，0600          |
| 本报告                                                  | EA-66D.2.2 报告                 |

---

**报告生成时间：** 2026-10-31 (UTC)
**最终判定：** READY FOR POSTGRESQL START AUTHORIZATION（附条件）
