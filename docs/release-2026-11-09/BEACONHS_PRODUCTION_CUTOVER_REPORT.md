# BeaconHS 生产上线报告 — 2026-11-10

## 结论

**生产上线完成**：`origin/hse-platform@424761d0` 已部署到 `10.10.31.13`，Gate 5 **PASS**，全服务 healthy，公网登录 200。

## 执行链

| 步       | 内容                                                                                                                                           | 结果                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 备份     | 生产库 `pg_dump -Fc` → `beaconhs-backups/beaconhs-20261109T223650Z/beaconhs.dump`（1.3M，sha256 留存）                                         | ✅                             |
| 恢复演练 | 恢复到 `beaconhs_restore_drill`：0 错误、54 迁移、CASCADE FK 与备份一致；演练库已删                                                            | ✅                             |
| 构建     | 本机 test 由候选 worktree 构建 `beaconhs:local-prod`，`DEPLOYMENT_VERSION=424761d0`，Server Action key 与生产一致（fingerprint 一致）          | ✅                             |
| 传镜像   | `docker save                                                                                                                                   | gzip`→ scp → 生产`docker load` | ✅  |
| 迁移     | `APP_ROLE=migrate` 一次性容器：`54 applied, 3 pending → 57 applied`，RLS 191 表、grants、views 全过                                            | ✅                             |
| 部署     | `beaconhs-start.sh` 滚动 web/worker/scheduler；Gate 5 首轮因镜像缺 `com.beaconhs.deployment-id` label → NOT VERIFIED；补 label 重建后 **PASS** | ✅                             |

## 最终产物

- 镜像：`beaconhs@sha256:a3061df9dfae6289320cb842ff55b9ee1c170a4da3bdbbc742560a6dba17f9e3`
  - labels：`com.beaconhs.deployment-id=43b0c654…`、`com.beaconhs.git-head=424761d0…`
- 运行容器：web/worker = `a3061df9dfae`，其余 infra 镜像 digest 未变
- `APP_VERSION=424761d07d8b3e17953aa745e16e393ea50978cd`

## 验证证据

| 检查                | 结果                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| Gate 5              | **PASS**                                                                           |
| 服务                | postgres/redis/minio/web/worker/collabora healthy；scheduler/storage-init exited 0 |
| `/login`            | 本地 200、公网 `https://hse.xuhaoqing.top/login` 200                               |
| `/api/health/ready` | `{"status":"ready","version":"424761d0…"}`                                         |
| 迁移账本            | 57                                                                                 |
| `audit_log` FK      | `ON DELETE RESTRICT` (`confdeltype=r`)                                             |
| 审计触发器          | `audit_log_immutable_trigger` 存在（含 0057 owner 语义修复）                       |

## 回滚资产

- DB 备份 + sha256：`/home/xuhaoqing/beaconhs-backups/beaconhs-20261109T223650Z/`
- 旧配置：`/home/xuhaoqing/.beaconhs/runtime/local-prod.env.bak-20261110`（旧 digest `2aab7973…`）
- 旧镜像 `beaconhs:ea66d4-31` 仍在主机

## 遗留 / 风险

- **请尽快轮换 SSH 密码**（本轮对话曾明文出现），改用 SSH key
- PD-01（F2 site/self）、PD-02（审计回溯）、PD-03（A3 回填）仍待产品决策；A3 Apply 未执行
- `deploy-dev.yml` 仍要求 `refs/heads/main`，与 origin 默认 `hse-platform` 不一致；本次为本地 canonical 脚本部署，未走该 workflow
- 生产对象存储（MinIO）未单独备份（runbook 工具不在主机）
- 构建用 Server Action key 已从 test 机清除；镜像 tar 归档已删

## 未执行

Git commit/merge/push（本轮）、A3 Apply、生产数据回填、GitHub workflow 部署。
