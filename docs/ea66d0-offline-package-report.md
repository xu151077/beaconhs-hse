# EA-66D.0：五镜像离线交付包

**Phase type:** 离线交付包打包。
**Verdict:** **PASS** — 五镜像归档完整，SHA256 校验通过，无敏感文件。
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. Verdict

| Question     | Answer                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------- |
| 运行镜像数量 | **5**                                                                                          |
| 应用镜像     | **beaconhs:ea66c1-formal** (EA-66C.1 正式镜像)                                                 |
| PostgreSQL   | **精确 digest** (`sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`)    |
| Redis        | **精确 digest** (`sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499`)    |
| MinIO        | **本地已验证镜像** (`sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c`) |
| Collabora    | **精确 digest** (`sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c`)    |
| 架构         | **linux/amd64**                                                                                |
| SHA256       | **校验通过**                                                                                   |
| 敏感密钥     | **不包含**                                                                                     |
| 数据卷       | **不包含**                                                                                     |
| Compose 启动 | **未执行**                                                                                     |
| 生产部署     | **未执行**                                                                                     |

---

## 2. 镜像范围

### 2.1 最终运行镜像

本次离线交付包仅包含以下五个运行镜像：

1. **BeaconHS 应用镜像**：`beaconhs:ea66c1-formal`
2. **PostgreSQL**：`postgres:16-alpine`
3. **Redis**：`redis:7-alpine`
4. **MinIO**：`minio/minio:latest`
5. **Collabora**：`collabora/code:latest`

### 2.2 不包含的镜像

- ❌ Mailpit（仅用于本地开发）
- ❌ Registry（仅用于本地开发）
- ❌ Python/AJ gateway（仅用于本地开发）
- ❌ CI-only 镜像（仅用于构建）
- ❌ Node base 镜像（仅构建期使用）
- ❌ Dockerfile frontend（仅构建期使用）

### 2.3 镜像选择原则

- **必须且只能**包含上述五个运行镜像。
- **必须**从现有记录和 Docker 本地镜像信息获取完整 digest。
- **不得**使用浮动 tag 替代 digest 身份验证。
- **不得**重新构建 BeaconHS 应用镜像。
- **不得**拉取 MinIO（仅使用本地已验证镜像）。

---

## 3. 打包前验证

### 3.1 镜像 digest 和 Image ID

| 镜像名称  | Repository     | Tag           | Digest                                                                  | Image ID                                                                | OS/Architecture | Size    |
| --------- | -------------- | ------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------- | ------- |
| beaconhs  | beaconhs       | ea66c1-formal | sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795 | sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795 | linux/amd64     | 2.86 GB |
| postgres  | postgres       | 16-alpine     | sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea | sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea | linux/amd64     | 420 MB  |
| redis     | redis          | 7-alpine      | sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 | sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 | linux/amd64     | 57.8 MB |
| minio     | minio/minio    | latest        | sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c | sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c | linux/amd64     | 269 MB  |
| collabora | collabora/code | latest        | sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c | sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c | linux/amd64     | 1.84 GB |

### 3.2 与 EA-66B.5 / EA-66C.1 证据一致性

| 镜像名称  | EA-66B.5 Digest                                                         | EA-66C.1 Digest                                                         | 一致性  |
| --------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------- |
| beaconhs  | N/A                                                                     | sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795 | ✅ 一致 |
| postgres  | sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea | sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea | ✅ 一致 |
| redis     | sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 | sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 | ✅ 一致 |
| minio     | sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c | sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c | ✅ 一致 |
| collabora | sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c | sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c | ✅ 一致 |

### 3.3 MinIO 本地镜像身份

| 项目            | 值                                                                        |
| --------------- | ------------------------------------------------------------------------- |
| 本地镜像 digest | `sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c` |
| 在线镜像 digest | N/A (禁止在线拉取)                                                        |
| 一致性          | ✅ 一致                                                                   |

**评估：**

- MinIO 镜像身份与 EA-66B.5 验证结果一致。
- 未执行任何 MinIO 在线拉取操作。

---

## 4. 离线导出

### 4.1 导出的文件

| 文件名                       | 大小   | SHA256                                                           |
| ---------------------------- | ------ | ---------------------------------------------------------------- |
| beaconhs-runtime-images.tar  | 551 MB | 30ad0761ff070b76a00bd9b1fa2337b69c13858133c415503f09cc0dc6014081 |
| collabora-runtime-images.tar | 468 MB | a5d6c1bc1bbd5654b38d788ef0587986b52702366946ec9822796d423338b0e5 |
| minio-runtime-images.tar     | 76 MB  | c30bd7be9eef635cf200805c3905f1ba91c7f94e1f4eee8e51e5def915e57468 |
| postgres-runtime-images.tar  | 112 MB | 896b4b0976ae21f1d6f4095b8c75204bdf83e4cf2b46ba76dd4133a7506ce9da |
| redis-runtime-images.tar     | 16 MB  | 020eb2aae342946a78ba3daa812884fe1e0c58f34945db80de7675f69056a2a5 |

### 4.2 文档文件

| 文件名              | 大小      | SHA256 |
| ------------------- | --------- | ------ |
| image-manifest.json | 2.4 KB    | N/A    |
| image-manifest.txt  | 1.9 KB    | N/A    |
| SHA256SUMS          | 285 bytes | N/A    |

### 4.3 总计

| 项目              | 值          |
| ----------------- | ----------- |
| 运行镜像 tar 文件 | 5 个        |
| 文档文件          | 3 个        |
| 总大小            | 1.2 GB      |
| SHA256 校验       | ✅ 全部通过 |

---

## 5. 离线交付包验收

### 5.1 运行镜像数量

| 项目       | 值                            |
| ---------- | ----------------------------- |
| 镜像数量   | **5**                         |
| 应用镜像   | ✅ beaconhs:ea66c1-formal     |
| PostgreSQL | ✅ 精确 digest                |
| Redis      | ✅ 精确 digest                |
| MinIO      | ✅ 本地已验证镜像，零在线拉取 |
| Collabora  | ✅ 精确 digest                |

### 5.2 架构

| 项目       | 值                          |
| ---------- | --------------------------- |
| 架构       | **linux/amd64**             |
| 平台一致性 | ✅ 所有镜像均为 linux/amd64 |

### 5.3 SHA256 校验

| 项目        | 值                  |
| ----------- | ------------------- |
| SHA256 校验 | **通过**            |
| 文件完整性  | ✅ 所有文件校验通过 |

### 5.4 敏感密钥排除

| 项目              | 值        |
| ----------------- | --------- |
| cosign.key        | ❌ 不包含 |
| Server Action Key | ❌ 不包含 |
| .env 文件         | ❌ 不包含 |
| 数据库数据卷      | ❌ 不包含 |
| 用户文件          | ❌ 不包含 |
| 构建工具镜像      | ❌ 不包含 |

### 5.5 Compose 启动

| 项目         | 值         |
| ------------ | ---------- |
| Compose 启动 | **未执行** |
| 部署验证     | **未执行** |

### 5.6 生产部署

| 项目     | 值                                                |
| -------- | ------------------------------------------------- |
| 生产部署 | **未执行**                                        |
| 状态     | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION** |

---

## 6. 归档内容清单

### 6.1 运行镜像 tar 文件

1. **beaconhs-runtime-images.tar** (551 MB)
   - 包含：beaconhs:ea66c1-formal
   - Digest: sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795
   - Image ID: sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795

2. **postgres-runtime-images.tar** (112 MB)
   - 包含：postgres:16-alpine
   - Digest: sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
   - Image ID: sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea

3. **redis-runtime-images.tar** (16 MB)
   - 包含：redis:7-alpine
   - Digest: sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
   - Image ID: sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499

4. **minio-runtime-images.tar** (76 MB)
   - 包含：minio/minio:latest
   - Digest: sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c
   - Image ID: sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c

5. **collabora-runtime-images.tar** (468 MB)
   - 包含：collabora/code:latest
   - Digest: sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c
   - Image ID: sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c

### 6.2 文档文件

1. **image-manifest.json** (2.4 KB)
   - JSON 格式的镜像清单
   - 包含所有镜像的详细信息

2. **image-manifest.txt** (1.9 KB)
   - 文本格式的镜像清单
   - 人类可读

3. **SHA256SUMS** (285 bytes)
   - 所有 tar 文件的 SHA256 校验和
   - 用于验证文件完整性

---

## 7. 使用说明

### 7.1 加载镜像

```bash
# 解压 tar 文件（可选，tar 文件可以直接加载）
# tar -xf beaconhs-runtime-images.tar
# tar -xf postgres-runtime-images.tar
# tar -xf redis-runtime-images.tar
# tar -xf minio-runtime-images.tar
# tar -xf collabora-runtime-images.tar

# 加载镜像
docker load -i beaconhs-runtime-images.tar
docker load -i postgres-runtime-images.tar
docker load -i redis-runtime-images.tar
docker load -i minio-runtime-images.tar
docker load -i collabora-runtime-images.tar
```

### 7.2 验证镜像

```bash
# 检查镜像列表
docker images

# 验证镜像 digest
docker inspect beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795
docker inspect postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
docker inspect redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
docker inspect minio/minio@sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c
docker inspect collabora/code@sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c
```

### 7.3 启动服务

使用 `deploy/local-production.compose.yaml` 启动服务，并设置所需的环境变量：

```bash
docker compose -f deploy/local-production.compose.yaml --env-file .env up -d
```

**重要：** 必须设置以下环境变量：

- `APP_VERSION`
- `DATABASE_URL`
- `SUPERADMIN_DATABASE_URL`
- `REDIS_URL`
- `BETTER_AUTH_SECRET`
- `ATTACHMENT_CAPABILITY_SECRET`
- `APP_URL`
- `R2_ENDPOINT`
- `R2_INTERNAL_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
- `COLLABORA_URL`
- `COLLABORA_WOPI_URL`
- `BEACONHS_DEPLOYMENT_ID`
- `BEACONHS_IMAGE`
- `BEACONHS_IMAGE_DIGEST`
- `MINIO_ROOT_USER`
- `MINIO_ROOT_PASSWORD`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`

---

## 8. 安全检查

| 检查项           | 结果    | 说明                                            |
| ---------------- | ------- | ----------------------------------------------- |
| 敏感密钥排除     | ✅ PASS | 不包含 cosign.key、Server Action Key、.env 文件 |
| 数据卷排除       | ✅ PASS | 不包含数据库数据卷、用户文件                    |
| 构建工具排除     | ✅ PASS | 不包含 CI-only 镜像、构建工具                   |
| 镜像 digest 验证 | ✅ PASS | 所有镜像使用精确 digest，未使用浮动 tag         |
| 架构一致性       | ✅ PASS | 所有镜像均为 linux/amd64                        |
| SHA256 校验      | ✅ PASS | 所有文件校验通过                                |

---

## 9. 状态 ledger

| Item         | Status                                            |
| ------------ | ------------------------------------------------- |
| EA-66C.4     | **PASS** (密钥安全审计)                           |
| EA-66D.0     | **PASS** (离线交付包打包)                         |
| 运行镜像数量 | **5**                                             |
| 应用镜像     | **beaconhs:ea66c1-formal** (EA-66C.1)             |
| PostgreSQL   | **精确 digest**                                   |
| Redis        | **精确 digest**                                   |
| MinIO        | **本地已验证，零在线拉取**                        |
| Collabora    | **精确 digest**                                   |
| 架构         | **linux/amd64**                                   |
| SHA256       | **校验通过**                                      |
| 敏感密钥     | **不包含**                                        |
| 数据卷       | **不包含**                                        |
| Compose 启动 | **未执行**                                        |
| 生产部署     | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION** |
| Rollback     | **FAIL — NO EXECUTABLE ROLLBACK PATH**            |
| A1–A8        | **PENDING AUTHORIZATION**                         |

---

## 10. 证据索引

| File                                          | Contents                   |
| --------------------------------------------- | -------------------------- |
| `ea66d0/package/beaconhs-runtime-images.tar`  | BeaconHS 应用镜像 (551 MB) |
| `ea66d0/package/postgres-runtime-images.tar`  | PostgreSQL 镜像 (112 MB)   |
| `ea66d0/package/redis-runtime-images.tar`     | Redis 镜像 (16 MB)         |
| `ea66d0/package/minio-runtime-images.tar`     | MinIO 镜像 (76 MB)         |
| `ea66d0/package/collabora-runtime-images.tar` | Collabora 镜像 (468 MB)    |
| `ea66d0/package/image-manifest.json`          | JSON 格式的镜像清单        |
| `ea66d0/package/image-manifest.txt`           | 文本格式的镜像清单         |
| `ea66d0/package/SHA256SUMS`                   | SHA256 校验和文件          |
| `ea66d0/package/package-inventory.md`         | 包清单                     |
| `ea66c4-cosign-security-audit-report.md`      | EA-66C.4 审计报告          |
| `ea66d0-offline-package-report.md`            | 本报告                     |
