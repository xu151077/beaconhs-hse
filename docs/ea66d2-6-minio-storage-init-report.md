# EA-66D.2.6：MinIO 启动与对象存储初始化验证报告

**Phase type:** 隔离测试环境 MinIO 启动与对象存储初始化验证。
**Verdict:** **PASS**
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. 本阶段目标和范围

1. 启动 MinIO，验证本地镜像、数据卷、认证、健康状态及网络隔离。
2. 执行 `storage-init`，验证对象存储初始化。
3. 验证 Bucket、访问策略、应用对象存储配置及初始化幂等性。
4. 将本阶段所有正确的代码、脚本、配置及文档修改同步回开发环境。
5. 形成完整、可追溯的执行报告。

**原则遵守：** 开发环境是代码和脚本的唯一修改源头。本阶段**未在测试主机修改任何代码或脚本**，也未发现需要修改的代码缺陷，因此**没有制造无意义的同步修改**。测试主机上的同步方向只有"证据回写"（只读复制）。

---

## 2. 开发环境与测试环境差异检查

### 2.1 Canonical 部署文件

| 文件                                   | 开发仓库 SHA256     | 测试主机 SHA256     | 结果      |
| -------------------------------------- | ------------------- | ------------------- | --------- |
| `deploy/local-production.compose.yaml` | `9700f4805e7633cc…` | `9700f4805e7633cc…` | **MATCH** |
| `deploy/gate5.manifest.yaml`           | `6bc70fa0e42ad267…` | `6bc70fa0e42ad267…` | **MATCH** |
| `deploy/collabora-branding.js`         | `730d1827c652fcd4…` | `730d1827c652fcd4…` | **MATCH** |
| `scripts/cluster/provision.sql`        | `e6de5f65d1b0a48e…` | `e6de5f65d1b0a48e…` | **MATCH** |

### 2.2 镜像内运行时文件

| 文件                               | 开发仓库            | 镜像内              | 结果      |
| ---------------------------------- | ------------------- | ------------------- | --------- |
| `docker/entrypoint.sh`             | `1ee60ca610b4774e…` | `1ee60ca610b4774e…` | **MATCH** |
| `apps/worker/dist/storage-init.js` | `3d2052488156a5ff…` | `3d2052488156a5ff…` | **MATCH** |

**关键验证：** 开发仓库的本地构建产物 `apps/worker/dist/storage-init.js` 与镜像内文件**字节完全一致**。这证明镜像内的对象存储初始化代码对应**当前工作区源码**（含未提交的用户修改），无需回写代码。

### 2.3 脚本与目录

| 检查                                                                          | 结果                                                                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 开发仓库 `scripts/` + `docker/` 文件数                                        | 51                                                                                                                     |
| 测试主机 `~/beaconhs-canonical/` 文件数                                       | 4（Compose + Gate 5 Manifest + branding + provision.sql）                                                              |
| 差异原因                                                                      | **设计使然**：目标主机只需 Canonical Compose 及其 bind mount 依赖；CI 脚本、构建脚本、launchers 属于开发环境与 CI 职责 |
| 目标端其它 checkout（`beaconhs-phase-aj` / `beaconhs-drill` / `beaconhs-e3`） | 三者均含 `scripts/` 与 `docker/`，但均为 pre-EA-65.1 的旧 checkout，本阶段未使用、未修改                               |
| `docker/entrypoint.sh` 的运行来源                                             | 镜像内（`/entrypoint.sh`），与开发仓库一致 ✅                                                                          |

### 2.4 未提交的用户修改（受保护，未触碰）

| 文件                                | 未提交差异   |
| ----------------------------------- | ------------ |
| `packages/storage/src/index.ts`     | +1007 / −143 |
| `packages/storage/src/lifecycle.ts` | +236         |
| `apps/worker/src/storage-init.ts`   | +9 / −2      |
| `docker/entrypoint.sh`              | +21          |

这些是用户既有的工作区修改。本阶段**只读**它们用于审计，**未修改、未暂存、未提交、未还原**。

### 2.5 对象存储环境变量名称比对（禁止输出值）

| 变量                          | 开发仓库定义                        | 目标端运行时  | 结果                                     |
| ----------------------------- | ----------------------------------- | ------------- | ---------------------------------------- |
| `R2_ENDPOINT`                 | `.env.example:41`                   | 存在，长度 33 | 名称一致                                 |
| `R2_INTERNAL_ENDPOINT`        | `.env.example:42`                   | 存在，长度 17 | 名称一致                                 |
| `R2_ACCESS_KEY_ID`            | `.env.example:44`                   | 存在，长度 16 | 名称一致                                 |
| `R2_SECRET_ACCESS_KEY`        | `.env.example:45`                   | 存在，长度 32 | 名称一致                                 |
| `R2_BUCKET`                   | `.env.example:47`                   | 存在，长度 19 | 名称一致                                 |
| `R2_PRIVATE_BUCKET_CONFIRMED` | `.env.example:48`                   | 存在，长度 5  | 名称一致                                 |
| `R2_PUBLIC_URL`               | `packages/storage/src/index.ts:295` | **不存在**    | 符合要求（存在则 storage-init 拒绝执行） |

**两端配置一致，无漂移。**

---

## 3. 修改文件清单

**本阶段未修改任何代码、脚本或配置文件。**

原因：审计确认镜像内的对象存储代码、Canonical Compose、Gate 5 Manifest 与开发仓库**字节一致**，未发现需要修复的缺陷。按任务要求"如果本阶段没有代码或脚本修改，也必须记录两端差异检查结果，不能为了同步而制造无意义修改"——本阶段只新增文档与证据。

| 类别 | 文件                                         | 说明                                     |
| ---- | -------------------------------------------- | ---------------------------------------- |
| 新增 | `docs/ea66d2-6-minio-storage-init-report.md` | 本报告                                   |
| 新增 | `docs/evidence/ea66d2-6/logs/*.txt` ×4       | 从测试主机回写的执行日志（脱敏，已扫描） |
| 修改 | `docs/project-development-state.md`          | 追加 EA-66D.2.6 ledger                   |

---

## 4. 修改文件同步记录及 SHA256

**代码/脚本同步：本阶段无（无需同步）。**

证据回写（测试主机 → 开发仓库，只读复制）：

| 目标                                                            | 来源（测试主机）                  | SHA256              | 敏感扫描 |
| --------------------------------------------------------------- | --------------------------------- | ------------------- | -------- |
| `docs/evidence/ea66d2-6/logs/storage-init-run1.txt`             | `/tmp/ea66d2-6-storage-init.out`  | `8a76863094027b29…` | 0 命中   |
| `docs/evidence/ea66d2-6/logs/storage-init-run2-idempotency.txt` | `/tmp/ea66d2-6-storage-init2.out` | `897c4785be29b6ea…` | 0 命中   |
| `docs/evidence/ea66d2-6/logs/migration-run1.txt`                | `/tmp/ea66d2-5-migrate.out`       | `2d6176e54bb70f43…` | 0 命中   |
| `docs/evidence/ea66d2-6/logs/migration-run2-idempotency.txt`    | `/tmp/ea66d2-5-migrate2.out`      | `7b5b1a40385ed3fd…` | 0 命中   |

敏感扫描模式：`password|secret|postgresql://|redis://|r2_secret|access_key` — 全部 0 命中。

**未同步的敏感文件（按要求不得进仓库）：** `local-prod.env`、`migration.env`、`provision-vars.env`、`server-action-key.env`、`storage-verify.env`、Server Action Key 文件。

**未覆盖开发仓库任何目录** —— 仅新增上述文件。

---

## 5. MinIO 镜像身份

| 项                 | 值                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------- |
| Image ID           | `sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c`               |
| 与 EA-66D.1 期望值 | **完全一致**                                                                            |
| RepoDigests        | `minio/minio@sha256:b187417e…` + `127.0.0.1:5000/beaconhs-drill/minio@sha256:b187417e…` |
| 平台               | linux/amd64                                                                             |
| 服务端版本         | `DEVELOPMENT.GOGET (commit-id=DEVELOPMENT.GOGET)`，Runtime go1.24.13                    |
| Compose 引用       | `minio/minio@sha256:b187417eee0a…`（digest 固定）                                       |

**未拉取、未升级、未替换任何镜像。**

---

## 6. MinIO 启动验证

### 6.1 执行命令

```bash
docker compose \
  --env-file ~/.beaconhs/runtime/local-prod.env \
  --env-file ~/.beaconhs/runtime/server-action-key.env \
  -f deploy/local-production.compose.yaml \
  -p beaconhs-local-prod \
  up -d --pull never --no-build --no-deps minio
```

`--no-deps` 确保不启动任何依赖服务；只启动 `minio` 一个服务。

### 6.2 容器身份

| 项            | 值                                                                 |
| ------------- | ------------------------------------------------------------------ |
| Container ID  | `82ef421c3241853a2ee6d92e070036e223bdd4dfde286c172aadb8f7c874ad4e` |
| Image（实际） | `sha256:b187417eee0a…`                                             |
| Config.Image  | `minio/minio@sha256:b187417e…`                                     |
| State         | running                                                            |
| StartedAt     | 2026-10-31T03:19:22.374458326Z                                     |
| RestartCount  | **0**                                                              |
| Health        | **healthy**（第 1 次轮询）                                         |
| 运行用户      | uid=0(root) —— 上游 MinIO 镜像默认；Canonical Compose 未设 `user:` |
| 数据卷        | `beaconhs-hse_minio-data` → `/data`（rw）                          |
| 端口          | `127.0.0.1:9000 → 9000/tcp`（console 9001 **未发布**）             |
| 部署标签      | deployment / image-digest / role 三项齐全且与渲染值一致            |

---

## 7. 认证和网络隔离验证

### 7.1 管理认证

用**与应用完全相同**的 S3 客户端配置（`packages/storage/src/index.ts:173-180`：region `auto`、`forcePathStyle: true`、凭据取自环境变量）执行独立验证：

| 检查                               | 结果                           |
| ---------------------------------- | ------------------------------ |
| `ListBuckets`（storage-init 之前） | **成功**，BUCKET_COUNT=0       |
| `ListBuckets`（storage-init 之后） | **成功**，BUCKET_COUNT=1       |
| `HeadBucket "beaconhs-local-prod"` | **成功**                       |
| 匿名 `GET http://minio:9000/`      | **HTTP 403** —— 认证被强制执行 |

凭据经 `--env-file`（0600 文件）注入，**从未出现在 argv、日志、报告或临时明文文件中**。

### 7.2 网络隔离

| 检查               | 结果                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| 宿主监听端口       | 仅 `127.0.0.1:5433`、`127.0.0.1:9000`、`127.0.0.1:6380`                                  |
| MinIO console 9001 | **未发布到宿主**                                                                         |
| 容器内 IPv4 LISTEN | `127.0.0.11:46757`（Docker DNS）、`127.0.0.1:9000`                                       |
| 容器内 IPv6 LISTEN | `[::]:9000`（业务）、`[::]:9001`（console，容器内可达但未对外发布）                      |
| 内网络可达性       | `minio:9000/minio/health/live` → **HTTP 200**（同一 Compose 网络，`minio` → 172.18.0.4） |
| 外部连接           | 无                                                                                       |

---

## 8. 对象存储配置核验（依据代码，非推测）

| 项                                              | 代码依据                                | 值                                                           | 判定                                |
| ----------------------------------------------- | --------------------------------------- | ------------------------------------------------------------ | ----------------------------------- |
| S3 endpoint（内部 I/O）                         | `packages/storage/src/index.ts:171,183` | `R2_INTERNAL_ENDPOINT` → `http://minio:9000`                 | ✅ **内网服务名**，非宿主机公网地址 |
| S3 endpoint（预签名）                           | `index.ts:185`                          | `R2_ENDPOINT` → `https://minio.beaconhs-test.local`          | ✅ 浏览器可达语义（https）          |
| Bucket 名                                       | `index.ts:187`                          | `beaconhs-local-prod`                                        | ✅ 与初始化创建的一致               |
| Region                                          | `index.ts:175`                          | `'auto'`                                                     | ✅ MinIO 兼容                       |
| Path-style                                      | `index.ts:176`                          | `forcePathStyle: true`                                       | ✅ MinIO 必需                       |
| Access/Secret Key                               | `index.ts:178`                          | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`                  | ✅ 来自环境变量                     |
| TLS                                             | `index.ts:172-179`                      | 内部 `http://`（内网明文）、预签名 `https://`                | ✅ 内部明文符合内网设计             |
| R2 / MinIO 分支                                 | `index.ts:204-217`                      | 公网 endpoint 非 `r2.cloudflarestorage.com` → **MinIO 分支** | ✅ 执行 `DeleteBucketPolicy`        |
| `R2_PUBLIC_URL`                                 | `index.ts:295-300`                      | 未设置                                                       | ✅ 不会抛错                         |
| `R2_PRIVATE_BUCKET_CONFIRMED`                   | `index.ts:304-308`                      | 仅 R2 分支要求；MinIO 分支不检查                             | ✅ `false` 不阻塞                   |
| `MINIO_ROOT_USER` == `R2_ACCESS_KEY_ID`         | 运行时 env                              | 相等                                                         | ✅ 应用使用 root 凭据               |
| `MINIO_ROOT_PASSWORD` == `R2_SECRET_ACCESS_KEY` | 运行时 env                              | 相等                                                         | ✅                                  |
| 凭证写入日志风险                                | `index.ts` 中凭据仅用于 S3Client 构造   | 无日志输出                                                   | ✅                                  |

**初始化入口与实际执行逻辑：**

| 项                           | 内容                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 入口                         | `docker/entrypoint.sh` → `storage-init)` → `exec node apps/worker/dist/storage-init.js`                                            |
| 实现                         | `apps/worker/src/storage-init.ts` — `bootstrapStorageFreezeGate(storage)` + `storage.ensureBucket()`                               |
| `ensureBucket`               | `packages/storage/src/index.ts:283-291` — `HeadBucket`，缺失则 `CreateBucket`，随后 `ensurePrivateBucketReady()`                   |
| `ensurePrivateBucketReady`   | `index.ts:294-340` — 拒绝 `R2_PUBLIC_URL`；MinIO 分支 `DeleteBucketPolicy`；合并生命周期规则；写/删 1 字节隐私探针并断言匿名读被拒 |
| 生命周期合并                 | `packages/storage/src/lifecycle.ts:251-274` — 保留既有规则，仅替换两个托管 ID                                                      |
| 探针清理                     | `index.ts:363-...` — PUT 不重试，DELETE 重试 3 次（指数退避），确保删除                                                            |
| `bootstrapStorageFreezeGate` | `packages/db/src/storage-freeze-operations.ts:443-...` — **仅注册内存回调**，不查询数据库                                          |

---

## 9. storage-init 执行结果

### 9.1 执行前范围确认

| 检查项                               | 结论                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| entrypoint                           | `exec node apps/worker/dist/storage-init.js` ✅                                                                                  |
| 是否修改 MinIO 数据                  | 是 —— 创建 Bucket、删除 Policy、设置 Lifecycle、写入并删除 1 个探针对象（**均在对象存储初始化范围内**）                          |
| 是否创建 Bucket / 修改 Bucket Policy | 是 ✅                                                                                                                            |
| 是否访问 PostgreSQL                  | **否** —— 服务定义中无 `DATABASE_URL`；`runtimeDatabaseUrl()` 仅在惰性工厂被调用时抛错，`bootstrapStorageFreezeGate` 不触碰 `db` |
| 是否访问 Redis                       | **否** —— 服务定义中无 `REDIS_URL`                                                                                               |
| 是否触发其他初始化逻辑               | 否                                                                                                                               |
| 是否执行不可逆操作                   | 否 —— 全部幂等，探针必删                                                                                                         |
| 是否自动删除/覆盖已有对象            | **否** —— 仅操作随机 UUID 探针键                                                                                                 |
| 是否创建用户/租户                    | **否**                                                                                                                           |
| Server Action Key                    | **未注入**（服务定义不含该变量）                                                                                                 |

### 9.2 执行结果

```bash
docker compose … -p beaconhs-local-prod run --rm --no-deps --pull never storage-init
```

**STORAGE_INIT_EXIT = 0**

```
[storage-init] private bucket policy, lifecycle, and anonymous-read probe passed
```

一次性容器残留：**0**（`--rm` 已删除）。

---

## 10. Bucket 与 Policy 验证

| 检查项                         | 结果                                                     |
| ------------------------------ | -------------------------------------------------------- |
| Bucket 数量                    | **1**                                                    |
| Bucket 名称                    | `beaconhs-local-prod` —— 与 `R2_BUCKET` **一致**         |
| 多余 Bucket                    | **无**（未创建代码未定义的 Bucket）                      |
| Region / Location              | 空（us-east-1 默认）—— 与 `region: 'auto'` 一致 ✅       |
| Bucket Policy                  | **absent (NoSuchBucketPolicy)** —— **不存在匿名访问** ✅ |
| 匿名写权限                     | 无（无 policy 即无授权）✅                               |
| Lifecycle 规则数               | 2                                                        |
| ├ `expire-unfinalized-uploads` | Enabled，tag `beaconhs-state=pending`，1 天过期          |
| └ `expire-transient-artifacts` | Enabled，tag `beaconhs-state=transient`，1 天过期        |
| 对象总数                       | **0**                                                    |
| 隐私探针残留                   | **0**                                                    |
| 数据卷中的 probe 文件          | **0**                                                    |

Bucket 目录内容仅含 MinIO 自身元数据（`.metadata.bin`、`.usage-cache.bin`、`.usage-cache.bin.bkp`），**无对象目录**。

---

## 11. 幂等性验证

在确认初始化逻辑幂等且不覆盖已有数据后，**顺序**复跑一次（不并发）：

| 检查项             | 第一次                    | 第二次                    | 结果                                               |
| ------------------ | ------------------------- | ------------------------- | -------------------------------------------------- |
| 退出码             | 0                         | **0**                     | PASS                                               |
| Bucket 数量 / 名称 | 1 / `beaconhs-local-prod` | 1 / `beaconhs-local-prod` | **一致**                                           |
| Bucket Policy      | absent                    | absent                    | **一致**                                           |
| Lifecycle 规则     | 2 条（ID、tag、过期天数） | 2 条（同上）              | **一致**                                           |
| Location           | 空                        | 空                        | **一致**                                           |
| 对象数             | 0                         | 0                         | **一致**                                           |
| 探针残留           | 0                         | 0                         | **一致**                                           |
| 状态全文 diff      | —                         | —                         | **完全一致（diff 为空）**                          |
| 数据卷             | 192.0K / 20 文件          | 216.0K / 24 文件          | 增量为 MinIO `.minio.sys/tmp/.trash/` 内部删除暂存 |

**如实说明：** 卷文件数增加 4 个，全部位于 MinIO 的 `.minio.sys/tmp/.trash/` —— 这是 MinIO 对已删除对象（每次运行的探针）的内部暂存记账，S3 API 层不可见（`OBJECT_COUNT=0`、`PRIVACY_PROBE_RESIDUE=0` 均已证实），由 MinIO 自身的 GC 周期清理。**不是遗留对象，也不是垃圾数据**。

**幂等性判定：PASS。**

---

## 12. 应用连接验证

| 路径                                        | 用途                                           | 验证结果                                                                          |
| ------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `http://minio:9000`（内网）                 | 应用的 put/get/head/delete（`internalClient`） | **可用**：HTTP 200；认证成功；写入/删除路径已由 storage-init 的隐私探针端到端证实 |
| `https://minio.beaconhs-test.local`（公网） | 浏览器预签名（`presignClient`）                | **不可解析** —— 测试环境无真实公网域名                                            |

**未验证事项（限制）：** 预签名 URL 的浏览器端可达性**无法在本隔离环境验证**，因为没有真实公网域名与隧道。生产拓扑由隧道把 `^/beaconhs(/.*)?$` 路由到 `127.0.0.1:9000`。本阶段未启动 web/worker，因此未做完整业务功能测试（符合任务边界）。

---

## 13. 数据卷状态

| 卷                           | 状态       | 内容                                                                      |
| ---------------------------- | ---------- | ------------------------------------------------------------------------- |
| `beaconhs-hse_minio-data`    | **已使用** | 216.0K，24 个文件（MinIO 内部元数据 + `.trash` 暂存；无对象、无探针残留） |
| `beaconhs-hse_postgres-data` | 已使用     | PostgreSQL PGDATA（EA-66D.2.4/5）                                         |
| `beaconhs-hse_redis-data`    | 已使用     | Redis 数据（EA-66D.2.5）                                                  |

**未删除、未重建任何外部卷；未执行 `docker compose down -v`。**

---

## 14. 门禁执行结果

| 门禁                  | 退出码                           |
| --------------------- | -------------------------------- |
| `pnpm format:check`   | **0**                            |
| `pnpm typecheck`      | **0**（27/27）                   |
| `pnpm lint`           | **0**（1/1）                     |
| `pnpm test`           | **0**（2118 passed / 9 skipped） |
| `pnpm deadcode:check` | **0**                            |
| `pnpm build`          | **0**（4/4）                     |

---

## 15. 未验证事项及限制

| #   | 事项                                 | 原因                                                                                 |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | 浏览器端预签名 URL 的端到端可达性    | 测试环境无真实公网域名与隧道；`minio.beaconhs-test.local` 不可解析                   |
| 2   | 应用（web/worker）的对象存储业务功能 | 本阶段边界禁止启动 web/worker                                                        |
| 3   | 预签名 PUT / multipart 上传链路      | 依赖 web 服务，未启动                                                                |
| 4   | MinIO console（9001）功能            | 未发布到宿主，属生产拓扑设计（仅容器内可达）                                         |
| 5   | 失败路径的初始化回滚                 | 本阶段初始化未失败；幂等性由代码分析与实测复跑证明                                   |
| 6   | MinIO 以 root 运行                   | 上游 `minio/minio:latest` 镜像默认；Canonical Compose 未设 `user:`，未修改受保护文件 |

---

## 16. 最终容器状态

| 容器                             | 镜像           | 状态          | 端口                    |
| -------------------------------- | -------------- | ------------- | ----------------------- |
| `beaconhs-local-prod-postgres-1` | `721873c34ceb` | Up（healthy） | `127.0.0.1:5433 → 5432` |
| `beaconhs-local-prod-redis-1`    | `858f009f9709` | Up（healthy） | `127.0.0.1:6380 → 6379` |
| `beaconhs-local-prod-minio-1`    | `b187417eee0a` | Up（healthy） | `127.0.0.1:9000 → 9000` |

保持停止（容器数均为 0）：`web`、`worker`、`scheduler`、`storage-init`、`Collabora`。
一次性容器残留：0。网络 4。卷 3。镜像 25（未改动）。磁盘 69G 可用（42%）。

敏感文件权限：全部 `0600` / owner `ceshi`；目录 `~/.beaconhs` 及子目录 `0700`。

---

## 17. 生产部署状态

**`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`**

本阶段为隔离测试环境的对象存储验证，**不是**生产部署完成。

## 18. 回滚状态

**`FAIL — NO EXECUTABLE ROLLBACK PATH`**

MinIO 数据卷已写入初始化数据（Bucket + 生命周期规则），但仓库内**没有**可执行的回滚路径定义。回滚能力的缺失是已知且已记录的缺陷，不因本阶段通过而改变。

## 19. A1–A8

**`PENDING AUTHORIZATION`**

## 20. WOPI

**`PAUSED`**

---

## 21. 下一阶段建议

1. **EA-66D.2.7（建议）**：启动 `storage-init` 之后的下一批服务 —— `scheduler`、`web`、`worker`、`collabora`，然后运行 Gate 5 验证。
2. 启动前仍需处理 EA-66D.2.3 §10 遗留的条件：首个平台管理员的执行载体（`bootstrap-admin` 镜像内已有 bundle）、email provider 路径（`bootstrap-email-provider` 无镜像内可执行入口）。
3. Gate 5 前必须确认：一次性任务容器（`run --rm`）已全部清理（本阶段残留 0 ✅），且 Gate 5 的 `--filter label=com.docker.compose.project=beaconhs-local-prod` 不会把已删除的一次性容器计入。
4. 生产部署前需由运维替换测试端点（`APP_URL`、`R2_ENDPOINT`、`COLLABORA_URL`）为真实公网域名，并补齐 Rollback 路径。

---

## 22. 证据索引

| File                                                      | Contents                           |
| --------------------------------------------------------- | ---------------------------------- |
| `docs/ea66d2-1-startup-preparation-report.md`             | 启动前准备报告                     |
| `docs/ea66d2-2-runtime-configuration-readiness-report.md` | 运行时配置就绪报告                 |
| `docs/ea66d2-3-migration-bootstrap-audit-report.md`       | Migration / Bootstrap 方案审计     |
| `docs/ea66d2-4-postgres-provision-report.md`              | PostgreSQL 与 Provision 报告       |
| `docs/ea66d2-5-migration-execution-report.md`             | Redis 与 Migration 执行报告        |
| `docs/evidence/ea66d2-6/logs/`                            | 4 份脱敏执行日志                   |
| `packages/storage/src/index.ts`                           | 对象存储配置与 `ensureBucket` 实现 |
| `packages/storage/src/lifecycle.ts`                       | 生命周期规则合并                   |
| `apps/worker/src/storage-init.ts`                         | storage-init 实现                  |
| `docker/entrypoint.sh`                                    | APP_ROLE 路由                      |
| `deploy/local-production.compose.yaml`                    | Canonical Compose                  |
| `deploy/gate5.manifest.yaml`                              | Gate 5 Manifest                    |
| 本报告                                                    | EA-66D.2.6 执行报告                |
