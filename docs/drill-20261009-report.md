# 隔离演练报告：beaconhs-drill-20261009（10.10.31.30）

> 一次性演练记录，非生产文档。真实生产上线以 `docs/PRODUCTION_RUNBOOK.md` 为准。
> 本文件不含任何密码、密钥、Token。

## 环境

- 主机：`ceshi@10.10.31.30`（Ubuntu 24.04, 8C/16G/124G），专用演练 VM（确认无 BeaconHS 残留、无用户服务）。
- 宿主机自带 cloudflared（boot 启动，演练全程未触碰）；127.0.0.1:20241 为其指标端口。
- Docker 29.9.0 + Compose v5.6.0（演练中现装）。宿主机 9000/9980 被本地 dev 服务占用，隧道改用 19000/19980。

## 资源清单（全部 `beaconhs-drill-20261009` 前缀隔离）

- Compose：`deploy/drill-20261009.compose.yaml`，镜像 `beaconhs:drill-20261009`（远程构建，`DEPLOYMENT_VERSION` 为当时 HEAD 全 SHA，构建密钥为现生成的演练密钥）。
- 容器：web/worker/postgres/redis/minio/mailpit/collabora/storage-init（一轮）/scheduler（一轮）。
- 卷：`beaconhs-drill-20261009_{postgres,redis,minio}-data`。网络：`beaconhs-drill-20261009_default`。
- 宿主机 loopback 端口：3001（web）/5432（pg）/6379（redis）/8025+1025（mailpit）/9000（minio）/9980（collabora）；本地经 SSH 隧道到达（注意本地 9000/9980 被 dev 占用，隧道用 19000/19980）。
- 密钥：全部现生成、600 权限、仅演练有效；`minio/minio` 上游仓库已消失，演练用本地缓存镜像 `save/load`（digest 与生产 pin 一致）。

## 初始化顺序（复现命令概要，敏感值只用变量名）

1. `provision.sql` 建角色（python 替换密码经 pipe 进 psql，不进 argv）。
2. `pnpm --filter @beaconhs/db migrate`（需 `MIGRATION_DATABASE_URL` + `DATABASE_OWNER_ROLE`）。
3. `bootstrap:email-provider --config <file>` dry-run → `--apply` → 复跑验证 `already_configured` → `--overwrite` 验证覆盖/失败保留。
4. `bootstrap:admin -- --email <addr> --password-stdin --apply`（密码走 stdin）。
5. `--resend-magic-link --apply` 发验证信 → Mailpit 取 token → verify 建 session。
6. `provision:first-tenant -- --name … --slug … --region … --apply`。
7. `run --rm scheduler` 注册 repeat 任务；storage-init 一轮建 bucket。
8. CLI 环境必须显式导出 `DATABASE_URL`/`SUPERADMIN_DATABASE_URL`/`REDIS_URL`/`BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`/`APP_URL`/`NODE_ENV=production`——**不可依赖仓库 `.env`**（本次演练曾因缺 `REDIS_URL` 把邮件送进 dev 队列，已清理并补测）。

## E2E 结果

- 管理员创建（superadmin、未验证）、Magic Link 发送/验证/session、重放与伪造拒绝、密码 reset 轮换+新密码登录、`/admin` 与 `/platform/tenants` 200、首租户及参考目录、worker 重启恢复、scheduler 注册、MinIO put/get/delete + presign、Collabora discovery、`global_only` 代码+单测确认——全部通过。
- WOPI 完整编辑流与恢复库上的认证复测未做（见剩余风险）。

## 故障演练结果

- Redis 停机：CLI ~12s 明确失败 exit 1（无挂起、无重连风暴）；恢复后 resend 成功投递。
- 坏 SMTP 配置更新：exit 1，线上配置原样保留。
- 带凭据明文 SMTP：worker 失败 `Error upgrading connection with STARTTLS: 502`，零投递、无 AUTH 上线路（与 stub 单测一致）。
- App 角色跑 migrate：在 assumeOwnerRole 门控明确拒绝，零写入。

## 备份恢复结果

- `pg_dump -Fc`（1.2MB）→ 新库 `drill_restore` 恢复成功；用户/租户/verification/附件计数与 provider 一致。
- MinIO 卷文件级拷贝（13 文件，含 bucket），minio 重启 healthy。
- 未做：以恢复库为后端的应用全功能复测。

## 质量门禁（演练后复跑，见对应会话记录）

`format:check`、`typecheck`、`lint`、`test`、`deadcode:check`、`build` 全绿；
live 套件（auth 86/86、jobs 19/19）在隔离 scratch 库上执行通过。

## MinIO 镜像固化（追加验证，2026-10-10）

- 源镜像：本地缓存 `minio/minio:latest` = digest `sha256:b187417eee0a…`，与演练/生产 compose pin、运行中容器镜像 ID 三方一致；上游 Hub 已删库（`object not found`），quay 路径 401。
- 无可用授权私有 Registry（本地/远程均无 GHCR 凭据），生产镜像推送记为 **BLOCKED（需人工提供写入 token）**。
- 演练内验证：远程 `registry:2`（loopback :5000）→ push（registry 回执 digest 与源完全一致）→ 删本地 tag 后重拉（digest 一致）→ 独立容器启动 + `/minio/health/live` 200 → 删测试容器；演练 minio 全程未动，事后 app 存储包 round-trip + 清理全过。
- 生产无需改文件：`local-production.compose.yaml` 已是 `${MINIO_IMAGE:-…}` 参数化，操作员只需镜像到私有库并设置 `MINIO_IMAGE`；回滚：`~/minio-image.tgz`（远程）可 `docker load` 恢复。
- 版本说明：该镜像自报 `DEVELOPMENT.GOGET`（源码构建 dev 版），无 RELEASE 号；tag 用短 digest 命名。

## 剩余风险 / 上线前人工项

1. 生产 MinIO 镜像拉取已失效（上游删库）：上线前必须镜像到私有 registry 并更新 pin。
2. 生产角色密码必须经 runbook `provision.sql` 参数化设置；compose 不得挂载弱密码 init 脚本。
3. `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` 构建与运行时必须同值（本仓库 compose 已补运行时变量）。
4. 固定临时密码政策靠规程（首登改密）；STARTTLS 强制仅覆盖有凭据连接。
5. 演练隧道与本地 600 密钥文件保留供复测；复测命令见会话记录。
