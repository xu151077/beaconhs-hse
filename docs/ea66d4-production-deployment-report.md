# EA-66D.4 — 生产部署（hse.xuhaoqing.top）

**状态：** DEPLOYED & INITIALIZED — 生产栈运行中并通过 Gate 5；管理员 `admin@example.com`、工作区「马来西亚项目群」、SMTP 已由用户完成并验证
**日期：** 2026-11-01
**主机：** `10.10.31.13`（`xuhaoqing-ThinkPad-E470`，Ubuntu 26.04.1 LTS，x86_64）
**镜像：** `beaconhs@sha256:d5d72545a5e743a01751ba202f53761760a1da40266dca658899004386a374b9`（EA-66D.3.1 构建物）
**前置：** `docs/ea66d3-1-internal-storage-lifecycle-report.md`

---

## 1. 部署结论

| 项                  | 结果                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| 公网入口            | `https://hse.xuhaoqing.top` → 200                                       |
| `/setup`            | 200，业务初始化完成 → 「Setup complete / The platform is initialized」  |
| `/api/health/ready` | `{"status":"ready","version":"51a899b7…"}`                              |
| Gate 5              | **PASS**，8 个容器全部匹配 manifest                                     |
| Deployment ID       | `b2e5f3852b893ff1cd89c7556174ae12b9edcdac-20261101-001`                 |
| 管理员              | `admin@example.com`（`isSuperAdmin=true`，显示名「系统管理员」）        |
| 工作区              | 「马来西亚项目群」`slug=cccc`（`917a11db-467a-48ae-abf0-81d90eb06b51`） |
| 数据库              | `users=1, tenants=1, migrations=51`                                     |
| SMTP                | 已配置（`mode=global_only`，密文存储）；用户实测发送成功                |
| 数据卷              | 3 个 external 卷全部存在                                                |
| 回滚快照            | `~/beaconhs-snapshots/20261101-preinit/`（3 个卷 + SHA256SUMS）         |

生产栈使用**与测试主机完全相同的镜像 digest**，未重新构建、未拉取任何镜像。

## 2. 主机准备

| 步骤        | 结果                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| 初始状态    | 无 Docker、无 curl/node/psql；`sudo` 需密码；外网 443 可达               |
| 安装 Docker | `docker.io 29.1.3` + `docker-compose-v2 2.40.3`（Ubuntu 26.04 universe） |
| Docker 服务 | enabled + active，`overlayfs`，cgroup=systemd                            |
| 运维账号    | `xuhaoqing` 加入 `docker` 组（免 sudo 运行 compose）                     |
| Node.js     | 安装 `nodejs 22.22.1`，供 `server-action-key-fingerprint.mjs` 使用       |
| 资源        | 4 核 / 15 GB RAM / 851 GB 可用                                           |

## 3. 镜像传输

5 个镜像从测试主机 `10.10.31.30` 经本机中转流式导出（`docker save | zstd`）→ `docker load`，未落盘中间 tar：

| 镜像           | Digest（与 manifest 一致）                                                |
| -------------- | ------------------------------------------------------------------------- |
| beaconhs       | `sha256:d5d72545a5e743a01751ba202f53761760a1da40266dca658899004386a374b9` |
| postgres       | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` |
| redis          | `sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499` |
| minio/minio    | `sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c` |
| collabora/code | `sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c` |

`docker load` 按 digest 导入会丢失 repository tag，因此补打同名 tag（`postgres:16-alpine` 等）后，`repo@sha256:…` 解析恢复；`docker compose config --images` 已逐项验证。

## 4. 端口映射（受保护文件，已获单独授权）

`deploy/local-production.compose.yaml` 的 web 端口由固定 3000 改为按宿主机参数化：

```yaml
ports:
  - '127.0.0.1:${BEACONHS_WEB_PORT:-3000}:3000'
```

- 生产 `local-prod.env`：`BEACONHS_WEB_PORT=8000`（隧道指向 `127.0.0.1:8000`）；
- 测试主机不设该变量 → 仍为 3000，行为零变化；
- 容器内 Next.js 仍监听 3000，healthcheck 不受影响；
- 只有一份 Canonical Compose，不产生按主机分叉的副本；
- 改后计算 SHA256：`89ab50f314f8505efdaa452bc763cfaa7ada519f6bc557994070002586cf9715`（两端一致）。

## 5. 运行时密钥

全部在目标机本地用 `openssl rand` 生成，**未回传、未写入日志**，文件权限 0600：

| 文件                                        | 内容                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `~/.beaconhs/runtime/local-prod.env`        | 27 项：4 个数据库 URL、BETTER_AUTH_SECRET、ATTACHMENT_CAPABILITY_SECRET、MinIO 凭据、APP_URL 等 |
| `~/.beaconhs/runtime/provision-vars.env`    | 4 个角色密码（app / super / migrator / backup，互不相同）                                       |
| `~/.beaconhs/runtime/server-action-key.env` | `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`                                                            |
| `~/.beaconhs/next_server_actions_key`       | 与镜像构建期相同的密钥                                                                          |

Server Action key 指纹：`f61da7728f3065df58f9e89aec6985d6`，与镜像内嵌密钥一致（不匹配会导致所有 Server Action 失效）。

## 6. 数据库初始化

1. `docker compose up -d --pull never --no-build postgres` → healthy；
2. `~/.beaconhs/scripts/provision-db.sh` → 创建 `beaconhs_owner`（NOLOGIN）、`beaconhs_migrator`、`beaconhs_app`、`beaconhs_super`（BYPASSRLS）、`beaconhs_backup`（BYPASSRLS），密码经 stdin 管道传入，未出现在 argv/文件/历史；
3. `APP_ROLE=migrate` 一次性容器：**51 条迁移全部应用**，RLS 覆盖 191 张表，最小权限授权、视图、统计目标、内建角色权限全部应用，exit 0。

## 7. 回滚快照

按用户授权采用「快照回滚」：

```text
~/beaconhs-snapshots/20261101-preinit/
  postgres-data.tgz  9aa703cc1ea06df40f80bdc736f836e4df947e24f3704333337fe4374ec047ea  (12 MB)
  redis-data.tgz     c39249e32f35397c30a6e5e29dbfd2f4b08dd5681a0b91ba688c162eba2186f9  (14 KB)
  minio-data.tgz     f34bd0b29aa44fa8f33878f00cca36916bdffb296bbda109dcf2d8c27e3c2bf6  (9.5 KB)
  SHA256SUMS
```

快照在**停止全部容器之后**从卷内直接打包，因此 Postgres 是冷一致状态。目录 0700。

> 注意：这是**数据回滚**材料，不是「已验证的回滚演练」。真实恢复未执行，回滚状态仍为 `FAIL — NO EXECUTABLE ROLLBACK PATH`（见 §12）。

## 8. 生命周期脚本实测（生产）

| 步骤                          | 结果                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `beaconhs-start.sh`（首次）   | exit 0；8 服务 healthy/READY；Gate 5 PASS                                                |
| `beaconhs-stop.sh`            | exit 0；8 容器 exited 并保留；3 卷存在；公网 502（预期）                                 |
| 快照                          | 3 个卷打包并记录 SHA256                                                                  |
| `beaconhs-start.sh`（停止后） | exit 0；8 服务恢复；Gate 5 PASS；`users=0, tenants=0, migrations=51` 与停止前一致        |
| `beaconhs-status.sh`          | exit 0；deployment ID、app digest、卷、端口（web 3000 → 127.0.0.1:8000）、公网入口均正确 |

## 9. 公网验证

```text
GET https://hse.xuhaoqing.top/                → 200
GET https://hse.xuhaoqing.top/setup           → 200（Step 1: create the platform administrator）
GET https://hse.xuhaoqing.top/api/health/ready → {"status":"ready","version":"51a899b7…"}
CSP connect-src / frame-src / form-action     → https://hse.xuhaoqing.top
```

Cloudflare Tunnel 由用户侧配置，目标机不运行 cloudflared 服务；链路已验证可达 `127.0.0.1:8000`。

## 10. 本阶段发现并修复的缺陷

| #   | 缺陷                                                                                                                                                         | 修复                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1   | `beaconhs-start.sh` 与 `beaconhs-status.sh` 把公网入口**硬编码**为 `https://beaconhs-test.xuhaoqing.top`，在任何其他主机上都会误报（生产实际打印了测试域名） | 改为输出 `$BEACONHS_PUBLIC_ORIGIN`；30 项生命周期测试仍全通过；两端脚本重新同步并比对 SHA256 |
| 2   | `docker load` 按 digest 导入丢失 repository tag，`repo@sha256:` 无法解析                                                                                     | 补打同名 tag 并逐项验证 `compose config --images`                                            |

## 11. 业务初始化（已由用户在浏览器完成，OpenCode 未创建任何账号）

| 步骤              | 结果                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Step 1 创建管理员 | `admin@example.com`，`isSuperAdmin=true`，显示名「系统管理员」，`emailVerified=false`（密码登录正常） |
| 登录              | 成功，可看到工作区                                                                                    |
| Step 2 SMTP       | 已保存，`mode=global_only`，凭据密文存储（`platform_settings.email` 349 字节 JSONB，非明文）          |
| 测试邮件          | 用户实测**发送成功**                                                                                  |
| Step 3 工作区     | 「马来西亚项目群」，`slug=cccc`，`917a11db-467a-48ae-abf0-81d90eb06b51`                               |
| `/setup` 关闭     | 由 200 + Step 1 变为「Setup complete / The platform is initialized」，公开入口不再允许创建管理员      |

复核时间：2026-11-01T10:30Z 之后；`migrations=51` 未变，Gate 5 仍为 PASS。

## 12. 未完成与风险

1. **真实租户下的文件上传/下载尚未验证**：工作区已建，但还没有在浏览器里上传过文件；内网存储网关（`/api/storage/upload`、`/api/storage/object`）目前只有自动化测试与测试主机上的端到端证据。
2. **回滚未演练**：有快照，但没有执行过恢复演练；`FAIL — NO EXECUTABLE ROLLBACK PATH` 不变。
3. **SMTP 已完成**：`mode=global_only`，用户实测发送成功；密码重置等流程可继续验证。
4. **主机是笔记本**（ThinkPad E470，15 GB RAM，单盘 915 GB）：无 UPS、无 RAID、无异地备份；生产可用性取决于该机器。
5. **RDP `:3389` 监听在 `0.0.0.0`**：建议上线后立即用防火墙限制或关闭；本次未改动（属主机安全策略，需单独授权）。
6. **WOPI / Collabora**：`PAUSED`；隧道未验证 `/browser`、`/cool`、`/hosting` 路由。
7. **A1–A8**：`PENDING AUTHORIZATION` 不变。
8. **未 commit / 未 push**：所有改动仅在工作树与目标机。

## 13. 证据清单

| 证据                           | 位置                                                            |
| ------------------------------ | --------------------------------------------------------------- |
| 目标机运行时 env（不读取内容） | `~/.beaconhs/runtime/`（0600）                                  |
| Gate 5 最近结果                | `~/.beaconhs/runtime/gate5-last-result.txt`                     |
| 启动状态                       | `~/.beaconhs/runtime/system-start-state.txt`                    |
| 回滚快照                       | `~/.beaconhs-snapshots/20261101-preinit/`                       |
| 生命周期脚本                   | `~/.beaconhs/bin/`（0600/0700）                                 |
| Canonical 部署文件             | `~/beaconhs-canonical/deploy/`（compose + manifest + branding） |
