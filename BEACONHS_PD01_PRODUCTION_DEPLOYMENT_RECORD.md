# PD-01 生产发布记录（2026-11-10）

## 结论

**已发布并验证通过。** 生产已从 `6ce125a4`（57 迁移）升级到 `62b92b94`（58 迁移），
Gate 5 PASS，公网健康检查返回新版本。

## 发布身份

| 项                           | 值                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Git HEAD（origin/main 同步） | `62b92b948e62d7b3e332ae1987e9ac7acdee56b3`                                                                       |
| CI                           | run 42798453069 ✅（6 门禁 0 失败）；Security 42798453184 ✅                                                     |
| 镜像                         | `beaconhs@sha256:7ed40e7ef476ff7f19078be7b6036b71afd08b18d65ce665b1ae5de6d31fc52b`                               |
| deployment-id                | `82d985d8da31e025842cad84604d4322d18bf027-20261110-001`                                                          |
| source-deployment-id         | `82d985d8da31e025842cad84604d4322d18bf027`（源归档 sha 派生，构建脚本产出）                                      |
| 源归档                       | sha256 `b4f0332b86fc0a0dd86911da70e0af833918a785747956abff2594a95ddf3e90`，3625 entries，forbidden entries: none |
| Server Action key 指纹       | `f61da7728f3065df58f9e89aec6985d6`（= 生产值，key-gate PASS；运行日志复核一致）                                  |

## 执行序列（实际命令与证据）

1. **构建**（本机，无 buildx 插件故不走 --secret）：`scripts/build-local-image-with-key-gate.sh beaconhs:pd01-release`，
   `SOURCE_CONTEXT_ARCHIVE` + `NEXT_SERVER_ACTIONS_KEY_FILE` + `RELEASE_ID=pd01-release`，
   `BUILD_EXIT=0`，key-gate PASS，source-identity PASS。
   构建后本地密钥副本即删除；日志 `/tmp/opencode/docker-build.log`，证据 `/tmp/opencode/build-evidence`。
2. **传输**：`docker save beaconhs:pd01-release | zstd | ssh … docker load`（按 tag 保存保留标签）；
   生产侧核验 Id、`com.beaconhs.deployment-id` 标签、RepoDigests 三者一致。
3. **备份**：`backup-daily.sh` → `~/beaconhs-backups/daily-20261110T123101Z`（2.9M，加密）。
4. **停栈**：`beaconhs-stop.sh`（8 容器全部 exited）。
5. **env 更新**：先备份 `.bak-pd01-20261110`，再改 `local-prod.env` 四项
   （APP_VERSION / BEACONHS_IMAGE / BEACONHS_IMAGE_DIGEST / BEACONHS_DEPLOYMENT_ID）。
6. **迁移**：仅起 postgres（healthy）→
   `docker compose run --no-deps --rm --entrypoint node -e MIGRATION_DATABASE_URL web apps/ops-migrate/dist/migrate.js`
   → RLS 191 tables / grants / invariants / 15 views 全部 ✔ →
   `drizzle.__drizzle_migrations` count = **58**。
   （第一次尝试失败：镜像 ENTRYPOINT `/entrypoint.sh` 忽略 CMD 覆盖，跑起了 Next 服务；
   已 `docker rm -f` 清理残留容器并改用 `--entrypoint node` 重跑成功。）
7. **启动**：`beaconhs-start.sh` → 8 容器全绿，**Gate 5 PASS**
   （manifest `deploy/gate5.manifest.yaml`：web/worker 为 gated 类，身份来自运行参数，
   无需改 manifest；pinned 服务身份未动）。
8. **验证**：
   - `http://127.0.0.1:8000/api/health/ready` → `{"status":"ready","version":"62b92b94…"}`
   - `/login` → 200（本机与公网 `https://hse.xuhaoqing.top` 均 200）
   - web 日志 error/unhandled 计数 = 0；worker 调度正常
   - `gate5-last-result.txt`：VERDICT PASS，gated image `7ed40e…`，deployment `82d985…-20261110-001`

## 回滚路径

- 迁移 0058 为纯加列（2 可空列 + 1 索引），旧镜像（`4ca7ec…`）不引用新列，**迁移后可直接回滚旧应用**：
  改回 `local-prod.env` 四项为 `.bak-pd01-20261110` 值并重启即可。
- 数据回滚点：`daily-20261110T123101Z` 加密备份。

## 已知说明

- 宿主端口 3000 被另一项目（risk-redmine）占用属既有状态；BeaconHS 经 `BEACONHS_WEB_PORT=8000`
  发布在 `127.0.0.1:8000`，Cloudflare Tunnel 指向该端口，不受影响。
- 本地临时凭据（SSH 密码副本、askpass、密钥副本）已在发布完成后全部删除；
  生产端 `~/.beaconhs/` 内的正式凭据未做任何变更。
