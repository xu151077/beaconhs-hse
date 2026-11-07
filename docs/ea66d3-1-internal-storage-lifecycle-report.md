# EA-66D.3.1 — 内网对象存储架构修正与系统生命周期管理

**状态：** READY — 新镜像已部署到测试主机并通过 Gate 5；生产未部署
**日期：** 2026-10-31
**阶段：** EA-66D.3.1
**前置：** `docs/ea66d3-0-launch-readiness-report.md`

---

## 1. 最终网络架构

```text
Internet
   |
   | HTTPS  https://beaconhs-test.xuhaoqing.top
   v
Cloudflare
   |
   | Tunnel（唯一 Public Hostname → 127.0.0.1:3000）
   v
BeaconHS Web :3000
   |
   | Docker internal network（默认 bridge，项目内服务名可解析）
   |
   +---- PostgreSQL :5432
   +---- Redis      :6379
   +---- MinIO      :9000
   +---- Collabora  :9980
   +---- Worker
   +---- Scheduler
   +---- storage-init
```

| 服务          | 内部地址         | 公网访问                     |
| ------------- | ---------------- | ---------------------------- |
| BeaconHS Web  | `web:3000`       | **唯一入口**                 |
| PostgreSQL    | `postgres:5432`  | 禁止                         |
| Redis         | `redis:6379`     | 禁止                         |
| MinIO         | `minio:9000`     | 禁止                         |
| MinIO Console | 9001             | 禁止（Compose 未发布该端口） |
| Collabora     | `collabora:9980` | 不新增独立公网入口           |
| Worker        | 内部服务         | 禁止                         |
| Scheduler     | 内部服务         | 禁止                         |

**未创建：** `s3-test.xuhaoqing.top`、任何独立 MinIO 公网域名、第二个 Cloudflare Tunnel Public Hostname、MinIO 公网代理入口。**未新增任何 DNS 记录。**

## 2. 唯一公网入口

`https://beaconhs-test.xuhaoqing.top`。Cloudflare Tunnel 是宿主机级服务（`cloudflared.service`），指向 `127.0.0.1:3000`。本阶段未修改其配置。

## 3. MinIO 内网访问证明

1. **Compose 审计（只读，未修改保护文件）**：`deploy/local-production.compose.yaml` 无顶层 `networks:` 段，因此 8 个服务全部加入同一默认项目网络；`web`、`worker`、`minio` 因此互相可达，且 `minio` 只以服务名被访问。
2. **端口绑定**：所有 `ports:` 均为 `127.0.0.1:<port>:<port>`，无 `0.0.0.0` 发布；MinIO Console 9001 **未发布**。
3. **应用配置**：`R2_INTERNAL_ENDPOINT=http://minio:9000`（服务端 S3 I/O）；`R2_ENDPOINT=https://minio.beaconhs-test.local`（一个不存在公网解析的 `.local` 名称）。二者都不是浏览器可用的公网地址。
4. **浏览器实测**：在隔离 scratch 环境完成文档 PDF 上传与预览后，浏览器 Network 中**只有** `POST /api/storage/upload` 与 `GET /api/storage/object`，**没有任何** `:9000`、`minio` 或预签名 URL 请求（见 §5）。
5. **对象落点**：上传的 PDF 实际存储在 MinIO 的租户命名空间下：`beaconhs-dev/t/<tenantId>/document/<uuid>-ea66d31-e2e.pdf`。

> 说明：`127.0.0.1:9000` 的端口发布是 Compose 既有内容（回环绑定，非公网）。移除它需要修改受保护的 Canonical Compose，本阶段未获授权，**未修改**。

## 4. 文件上传 / 下载 / 预览的代理实现

### 4.1 浏览器侧 URL

浏览器只拿到 **BeaconHS 自身的路径**：

- 下载/预览：`/api/storage/object?k=<base64url key>&cap=<HMAC>`
- 上传：`POST /api/storage/upload?uploadId=<id>&token=<upload token>`

`k` 是对象键的 base64url 编码；`cap` 是服务端用 `ATTACHMENT_CAPABILITY_SECRET` 对 `object:v1:<key>` 计算的 HMAC-SHA256（43 字符 base64url），校验使用 `timingSafeEqual`。能力命名空间与附件能力（`attachment:v1:`）隔离，二者不可互换。

### 4.2 下载 / 预览

`apps/web/src/app/api/storage/object/route.ts`：

1. 校验能力（失败 → 404，与"对象不存在"不可区分，不能用于探测键）；
2. **有会话时**额外校验对象键属于调用者当前租户（`assertTenantObjectKey`，失败 → 403）；
3. `headObject` 确认存在（否则 404）；
4. `getObjectStream` 从**内网 endpoint** 取流并原样返回；
5. 响应头：`Content-Type`、`Content-Length`、`Content-Disposition`、`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。

**无会话时**（公开 verify 页面的一次性 token 场景）能力本身即授权：能力只由服务端在该 token 校验通过后签发，且只覆盖一个对象；对象存储仍然不可从浏览器到达。

附件下载 `/api/attachments/[id]` 由原来的 **307 重定向到 MinIO 预签名 URL** 改为**流式返回**，授权模型不变（能力 + 会话 + 租户 RLS）。

### 4.3 上传

`apps/web/src/app/api/storage/upload/route.ts`：

1. 会话必须存在；预留记录必须属于调用者、未消费、未过期、租户一致；
2. `uploadToken` 以常量时间与预留记录中的哈希比对；
3. 单文件：声明长度必须等于预留的字节数；Content-Type（若提供）必须与预留一致；
4. 分片：分片号必须在 `1..partCount`，期望长度由 `MULTIPART_UPLOAD_PART_SIZE_BYTES` 与总大小精确推导；
5. 请求体**流式**传给 `putStagedObject` / `uploadStagedPart`，`exactLengthStream` 边传边计数：多一个字节立即失败，少一个字节在结束时失败；同时把输入重新切分为 ≤1 MiB 的块（MinIO 拒绝 >16 MiB 的 aws-chunked 分块）；
6. 对象写入使用与预签名写入相同的 write-arm 语义（先 issue、成功后 activate、失败 withdraw），并把 `upload-token` 写入对象元数据，因此既有 `finalizeUpload` 校验完全不变。

**没有任何路径把整个文件读入内存。**

### 4.4 删除

删除仍走 `deleteObject`（服务端，内部 endpoint）+ 业务权限校验；前端不能传任意 bucket/key。

### 4.5 预签名 URL

- `presignPut`、`presignMultipartPart`、`presignExistingGet` **已删除**（无调用者，且它们的存在本身就是"让浏览器直连对象存储"的入口）。
- `presignGet` 改为对**内网 endpoint** 签名，并在文档中标注"仅服务端使用"；剩余调用者只有 worker 的 PDF 渲染与 forms-pdf 的图片嵌入。
- 所有面向浏览器的 16 处 `presignGet`、2 处 `presignExistingGet`、`resolveTenantLogoUrl` 的默认返回，全部改为 `storageObjectUrl()`。
- 定时报告邮件中的"下载 PDF"预签名链接改为指向应用内的运行记录页（PDF 本身仍随邮件附带）。

## 5. 对象存储安全测试

### 5.1 自动化测试（开发环境，全部通过）

| 套件                                 | 数量 | 覆盖                                                                                                                                                               |
| ------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api/storage/object/route.test.ts`   | 7    | 无对象存储 URL 泄露；`private, no-store`/`nosniff`；错误能力 404；对象不存在 404；跨租户 403；无会话公开分享；能力不能跨键复用                                     |
| `api/storage/upload/route.test.ts`   | 12   | 未登录 401；非本人/错误 token 404；跨租户 403；过期 410；缺 Content-Length 411；长度不符 400；类型不符 400；正确写入；分片类型不校验；分片号越界 400；未开分片 409 |
| `api/attachments/[id]/route.test.ts` | 5    | ID-only/错误能力 404；租户范围；未登录 401；**流式返回而非重定向**；对象缺失 404                                                                                   |
| `packages/storage`                   | 141  | 含真实 130 MiB 多分片上传（重试、并发、完成、SHA-256 校验、冻结拒绝）与端点路由（写操作全部走内网）                                                                |

### 5.2 浏览器端到端（隔离 scratch 数据库，未触碰验收库）

在独立 PostgreSQL（端口 55433、独立容器与匿名卷、真实 `provision.sql` + 真实 migration runner，51 条迁移）上：

1. `/setup` 创建首个管理员 → 成功；
2. 登录 → `/setup` 进入"配置邮件 + 创建首个工作区"阶段；
3. SMTP 页面正常渲染，密码字段为空且提示"密码会加密保存，页面不会回显"；
4. 创建首个工作区 → "Setup complete"；
5. 新建文档 → PDF 标签 → 上传 212 字节 PDF → 预览成功；
6. 下载链接为 `/api/storage/object?k=…&cap=…`，响应 `application/pdf`、`content-length: 212`、`private, no-store`；
7. **Network 中没有任何 MinIO/`:9000` 请求**；
8. 对象实际存在于 MinIO 租户命名空间。

验收数据库复核：`users=1, tenants=0, migrations=51` —— 与 EA-66D.2.7 完全一致。

### 5.3 未能执行的项

- 真实 SMTP 投递：无用户提供的凭据，**不宣称成功**。
- 生产浏览器中的跨租户/跨项目越权：验收库无租户，按约束未创建；由自动化测试覆盖。

## 6. 启动脚本

`scripts/deployment/beaconhs-start.sh`（目标机 `~/.beaconhs/bin/beaconhs-start.sh`）。

**前置检查（任一失败即停止，不改变现场）：** Docker Engine、Docker Compose、Compose 文件存在、运行时 env 与 Server Action key env 存在且权限为 600/400、三个外部卷存在、五个固定镜像存在、**应用镜像 ID 必须等于运行时 env 声明的 digest**、Compose 文件 SHA256（可选）、deployment ID 存在、运行时 env 不得出现第二个公网主机。

**启动：**

```bash
docker compose --env-file <runtime> --env-file <key> -f <compose> -p beaconhs-local-prod \
  up -d --pull never --no-build <long-running services>
```

- 永不 `pull`、永不 `build`；
- one-shot 服务（`scheduler`、`storage-init`）**仅当尚未用当前镜像成功完成时**才启动；
- 等待每个长驻服务 `running/healthy`（每服务独立 180s 预算）；
- 检查 RestartCount；
- 执行 Gate 5；
- 记录启动时间与 deployment ID 到 `runtime/system-start-state.txt`。

## 7. 停止脚本

`scripts/deployment/beaconhs-stop.sh`。

- 项目白名单守卫（默认仅 `beaconhs-local-prod`）；
- 列出将停止的容器与其他 Compose 项目（后者不动）；
- 依赖顺序：`web → worker → scheduler → storage-init → collabora → minio → redis → postgres`；
- 只用 `docker compose stop -t 30`；**永不** `down -v`、`volume rm`、`prune`、删除镜像；
- 停止后校验：三个外部卷存在、五个镜像存在、Postgres 已停止；
- 不停止 cloudflared（宿主机服务）。

## 8. 状态脚本

`scripts/deployment/beaconhs-status.sh`（只读）。

输出：Docker/Compose 版本、项目名、Compose 文件与 SHA256、deployment ID、启动时间、各服务状态、镜像集合与应用 digest、外部卷、磁盘、Gate 5 最近结果、公网入口、各服务端口发布、cloudflared 状态、密钥文件的存在与权限、Server Action key 指纹。

**不输出**任何 env 内容、数据库密码、MinIO 密钥、SMTP 密码、Server Action key 或完整连接串。

## 9. 幂等性与异常测试

`scripts/deployment/lifecycle.test.sh` —— **30/30 通过**，全部在隔离 fixture（独立项目名 `beaconhs-fixture`、独立卷、独立容器）中执行：

| #   | 场景                                           | 结果 |
| --- | ---------------------------------------------- | ---- |
| 1   | Compose 文件缺失拒绝启动                       | PASS |
| 2   | 运行时 env 缺失拒绝启动                        | PASS |
| 3   | env 权限 644 拒绝启动                          | PASS |
| 4   | 外部卷缺失拒绝启动                             | PASS |
| 5   | 固定镜像缺失拒绝启动                           | PASS |
| 6   | Compose 文件 SHA256 不符拒绝启动               | PASS |
| 6b  | 镜像引用与 digest 矛盾 / 主机无该镜像，均拒绝  | PASS |
| 7   | 生产端点拒绝启动                               | PASS |
| 7b  | 唯一公网入口被接受、第二个公网主机被拒绝       | PASS |
| 8   | 并发 start 被锁拒绝                            | PASS |
| 9   | 停止不动其他 Compose 项目；卷与卷内数据保留    | PASS |
| 10  | 重复停止安全                                   | PASS |
| 10b | 无健康检查时拒绝谎报成功；start→stop→数据仍在  | PASS |
| 11  | 状态脚本不泄露 env                             | PASS |
| 12  | 布局文件提供路径、被解析而非执行、环境变量优先 | PASS |

**真实环境幂等性实测（目标机）：** 连续三次 `beaconhs-start.sh`：

- 第二次、第三次未重建任何容器（容器 `Created` 时间不变）；
- `scheduler`、`storage-init` 输出 `already complete for this image`，未重跑；
- 未执行 migration、未重置数据库、未覆盖配置；
- 每次 Gate 5 均 PASS。

## 10. 新镜像构建信息

| 项                             | 值                                                                        |
| ------------------------------ | ------------------------------------------------------------------------- |
| 源归档                         | `docs/evidence/ea66d3-1/source-context.tar.zst`                           |
| 归档 SHA256                    | `f8137e47f411e8f03b7d93fe8fc1e1e4c94a976786ddcbabf1d9fb7326cfffc9`        |
| 归档条目                       | 3474，无禁止条目                                                          |
| Deployment ID（源）            | `b2e5f3852b893ff1cd89c7556174ae12b9edcdac`                                |
| 镜像 tag                       | `beaconhs:ea66d3-1`                                                       |
| 镜像 digest                    | `sha256:d5d72545a5e743a01751ba202f53761760a1da40266dca658899004386a374b9` |
| 旧镜像                         | `beaconhs@sha256:1834f867…` **保留未删**                                  |
| MinIO                          | `minio/minio@sha256:b187417e…` **Image ID 未变**                          |
| PostgreSQL / Redis / Collabora | 未变                                                                      |

镜像内已核验：`/setup` 路由、`/api/storage/object`、`/api/storage/upload`、`object:v1:` 能力实现、`STORAGE_UPLOAD_LENGTH_MISMATCH` 流式守卫、`api/storage/upload` 上传 URL 构造。

> **Provenance note.** The image was built from archive `f8137e47…` and matches it exactly. Two HOST-ONLY shell fixes and this report were written after that build and are therefore not inside the image: `scripts/ea66d3-0-scratch-db.sh` now resolves `tsx` through `packages/db` (it had been broken by the root-level `node --import tsx`), and `beaconhs-stop.sh` now inspects `docker compose ps -aq` so it can tell a stopped container from a removed one. Neither file is copied into the image, and the scripts actually installed on the host are the final versions whose SHA-256 is recorded in §15. The application code, the Dockerfile inputs and every runtime file match the archive exactly. **Later, during EA-66D.4, `beaconhs-start.sh` and `beaconhs-status.sh` were also corrected** — they printed a hard-coded public URL instead of `$BEACONHS_PUBLIC_ORIGIN` — so the SHA-256 values in §15 are the post-fix host files, not the archive copies.

## 11. Server Action Key 验证

- 构建输入：目标机既有密钥（`~/.beaconhs/next_server_actions_key`）恢复至 `/tmp/beaconhs-server-action-key`，权限 600；
- 指纹：`f61da7728f3065df58f9e89aec6985d6`（与既有部署一致）；
- 构建脚本 `[key-gate] PASS`：镜像内嵌密钥与预期一致；
- 构建日志、镜像 config、history 中均未出现密钥内容；
- 目标机 `BEACONHS_DEPLOYMENT_ID` 更新后，容器标签与 Gate 5 校验一致。

## 12. SBOM / provenance

- 构建证据目录：`docs/evidence/ea66d3-1/build/`（`source-identity.json`、`source-manifest.json`、`image-inspect.json`、`embedded-identity.json`、`build.log`）；
- 镜像标签：`com.beaconhs.deployment-id`、`com.beaconhs.source-archive-sha256`、`com.beaconhs.git-head`；
- 镜像内嵌 Next.js deploymentId 由 `verify-image-identity.mjs` 读回并比对通过；
- 目标机镜像 `RepoDigests` 与开发机一致（`docker save | docker load` 保真）。

## 13. 六项开发门禁

| 门禁           | 命令                  | 退出码 |
| -------------- | --------------------- | ------ |
| format:check   | `pnpm format:check`   | 0      |
| typecheck      | `pnpm typecheck`      | 0      |
| lint           | `pnpm lint`           | 0      |
| test           | `pnpm test --force`   | 0      |
| deadcode:check | `pnpm deadcode:check` | 0      |
| build          | `pnpm build --force`  | 0      |

`test --force` 全仓 25/25 任务通过（web 2146 passed / 13 skipped（2159）；storage 141；db 508 passed / 41 skipped（549））。

六项门禁在 `2026-10-31T14:32Z` 前后重新完整执行一次，**逐项捕获进程退出码**并写入 `docs/evidence/ea66d3-1/gates/exit-codes.txt`（六项均为 `exit=0`），同目录保留每项的完整日志。

## 14. Gate 5

```text
VERDICT: PASS
REASON: all 8 container(s) match the manifest (gated image beaconhs@sha256:d5d72545a5e743a01751ba202f53761760a1da40266dca658899004386a374b9;
        pinned identities from the manifest; deployment 'b2e5f3852b893ff1cd89c7556174ae12b9edcdac-20261031-001')
```

## 15. 开发环境与测试环境 SHA256

| 文件                                           | SHA256                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `scripts/deployment/lib.sh`                    | `7f58a7011cb69c19f531435cd567a2c3bb1059c939770db7f9041e99d6235fdd` |
| `scripts/deployment/beaconhs-start.sh`         | `661d0cd0eb964f056127423e8ef99a0a637b5af7b697f669af3424f39acbb831` |
| `scripts/deployment/beaconhs-stop.sh`          | `fa406850dee6bf52264616abf4c46fea2c98e2aa874e98ae306066be07e9e29f` |
| `scripts/deployment/beaconhs-status.sh`        | `4a59968904c9acc4f84318b2ec8d503ca255d34a84c1bc69e5d249099a50ee30` |
| `scripts/ci/server-action-key-fingerprint.mjs` | `782139003d3790aa6bf67d02b54333688ecd63af68170e5bbdd8cc7b92b253ba` |

目标机安装位置：`~/.beaconhs/bin/`；布局文件 `~/.beaconhs/lifecycle.env`（0600，只含路径）。两端逐文件比对一致。

## 16. 启动 / 停止 / 再次启动实测

| 步骤                                | 结果                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `beaconhs-start.sh`（首次，新镜像） | exit 0；8 服务全部 healthy/READY；Gate 5 PASS                                                      |
| `beaconhs-start.sh`（重复 1）       | exit 0；未重建容器；`scheduler`/`storage-init` 报告 `already complete for this image`；Gate 5 PASS |
| `beaconhs-start.sh`（重复 2）       | exit 0；容器 `Created` 时间不变；Gate 5 PASS                                                       |
| `beaconhs-status.sh`                | exit 0；deployment `b2e5f385…-20261031-001`；app digest `sha256:d5d72545…`                         |
| `beaconhs-stop.sh`                  | exit 0；8 容器全部 exited（保留）；3 外部卷存在；5 镜像存在；公网 502（预期）                      |
| `beaconhs-start.sh`（停止后）       | exit 0；8 服务恢复；Gate 5 PASS；公网恢复 200                                                      |
| 数据核对（停止后重启）              | `users=1, tenants=0, migrations=51` —— 与停止前一致；MinIO 桶 `beaconhs-local-prod` 保留           |

## 17. 数据卷保护结果

- 三个外部卷在每次 stop 后均存在；
- 目标机 stop 前后镜像集合不变（26 个）；
- 未执行 `down -v`、`volume rm`、`prune`；
- 停止后再次启动，Postgres 数据、MinIO 对象、Redis 数据均保留（start→stop→start 实测）。

## 18. 未完成事项

1. **生产部署**：仍为 `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`。本阶段只更新测试主机。
2. **回滚**：仍为 `FAIL — NO EXECUTABLE ROLLBACK PATH`。新镜像构建成功不等于具备回滚能力。
3. **A1–A8**：`PENDING AUTHORIZATION`。
4. **WOPI**：`PAUSED`。
5. **首次管理员 / 首个租户 / SMTP 凭据**：由用户本人通过网页完成；本阶段**未创建**、**未填写**。验收库保留了 EA-66D.2.7 的 CLI 管理员（1 个），因此 `/setup` 正确显示"请先登录"而不是再次创建管理员；首个工作区与 SMTP 仍待用户完成。
6. **Cloudflare Tunnel 稳定性**：边缘多次重置控制流（20:25 全部连接丢失，20:27 自动重连；期间公网 502/530，恢复后 200）。22:23 复核时公网 `/`、`/setup`、`/api/health/ready` 再次返回 **502**，而同刻目标机 `127.0.0.1:3000` 对应路径均为 **200**、8 个容器全部 healthy、Gate 5 仍为 PASS——故障在隧道链路，不在应用。这是既有环境缺陷，未修改 systemd，未重启服务（`ceshi` 无 root 权限）。
7. **真实 SMTP 投递**：未验证，不宣称成功。

## 19. 用户网页初始化操作说明

1. 打开 `https://beaconhs-test.xuhaoqing.top/setup`。
2. 若显示"请先登录 / 平台管理员已经创建"，说明该环境已有管理员：直接登录；否则按页面提示创建首个管理员（邮箱、显示名称、密码）。
3. 登录后回到 `/setup`，在"第 2 步：配置邮件服务"填写 SMTP 发件邮箱与密钥，点击**保存平台邮件**，可点击**发送测试**验证投递。密码加密保存，页面不会回显。
4. 在"第 3 步：创建首个工作区"填写工作区名称，点击**创建工作区**。
5. 看到"Setup complete"后点击 **Open the app** 进入系统。

系统启停：

```bash
~/.beaconhs/bin/beaconhs-start.sh     # 启动全部服务并跑 Gate 5
~/.beaconhs/bin/beaconhs-status.sh    # 只读状态
~/.beaconhs/bin/beaconhs-stop.sh      # 安全停止（保留卷与数据）
```

---

## 附：本阶段发现并修复的缺陷

| #   | 缺陷                                                                                     | 修复                                                    |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | 上传代理把整个请求体读入内存（500 MB 视频即 500 MB 内存）                                | 改为流式 + 精确长度守卫 + 1 MiB 重分块                  |
| 2   | 附件下载 307 重定向到 MinIO 预签名 URL                                                   | 改为服务端流式返回                                      |
| 3   | 助手文档阅读器、文档 PDF 仍返回 MinIO 预签名 URL                                         | 改为 `storageObjectUrl`                                 |
| 4   | 定时报告邮件含 7 天有效的 MinIO 预签名链接                                               | 改为应用内运行记录链接                                  |
| 5   | `packages/storage` 静态导入 `node:stream`，Edge Instrumentation 编译失败，setup 动作 500 | 改为动态导入 + Web Streams 输入                         |
| 6   | setup 页面把内联箭头函数传给 Client Component，管理员存在后页面直接崩溃                  | 改为直接传 server action 引用                           |
| 7   | Gate 5 校验缺少 Server Action key env，误报 NOT VERIFIED                                 | 子 shell 内同时加载两份 env                             |
| 8   | 生命周期脚本硬编码镜像 digest，发版即失效                                                | 镜像身份从运行时 env 读取（`BEACONHS_IMAGE`/`_DIGEST`） |
| 9   | `scripts/ea66d3-0-scratch-db.sh` 用根级 `node --import tsx`，tsx 不可解析                | 改为 `pnpm --filter @beaconhs/db exec tsx`              |
| 10  | 重复启动会重跑已完成的 one-shot（storage-init/scheduler）                                | 仅当未用当前镜像成功完成时才启动                        |
