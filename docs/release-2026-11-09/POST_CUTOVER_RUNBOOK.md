# BeaconHS 上线后运维手册（2026-11-10）

生产已上线：`origin/hse-platform@424761d0` / 镜像 `beaconhs@sha256:a3061df9…` / Gate 5 PASS / 57 迁移。
本手册给出观测基线、冒烟清单与回滚触点。**不包含任何 Secret 或连接串**；涉及生产凭据的命令请在主机上由运维导出环境变量后执行。

## 1. 观测基线（T+20min 快照）

| 指标                             | 基线值                                                |
| -------------------------------- | ----------------------------------------------------- |
| 负载                             | `0.30 / 0.27 / 0.28`                                  |
| 根分区                           | 802G 可用（8%）                                       |
| web / worker 重启次数            | 0 / 0                                                 |
| web / worker 最近 1000 行错误数  | 0 / 0                                                 |
| worker 调度输出                  | 15 行 `[scheduled]`，`0 errors`                       |
| 内存                             | web 355MiB、worker 188MiB、pg 91MiB、collabora 558MiB |
| 迁移账本                         | 57                                                    |
| `storage_object_deletion_outbox` | 0（无堆积）                                           |
| `audit_log`                      | 285 行；上线后 15 分钟新增 0                          |
| DB 活动连接                      | 3                                                     |
| RLS 表                           | 191                                                   |
| audit FK                         | `RESTRICT`                                            |
| 审计触发器                       | `audit_log_immutable_trigger` 在位                    |

> 上线后暂无用户活动（`audit_last15m=0`）属正常；有真实流量后该值应随写入增长，这是判断「写入链路是否活着」的最直接信号。

## 2. 24–48 小时观测清单

在生产主机执行（只读）：

```sh
# 服务与重启
docker ps --format '{{.Names}} {{.Status}}' | grep beaconhs-local-prod
docker inspect beaconhs-local-prod-web-1 beaconhs-local-prod-worker-1 --format '{{.Name}} restarts={{.RestartCount}}'

# 错误日志（期望 0）
docker logs --since 24h beaconhs-local-prod-web-1    2>&1 | grep -icE 'error|fatal|unhandled|ECONNREFUSED'
docker logs --since 24h beaconhs-local-prod-worker-1 2>&1 | grep -icE 'error:|fatal|unhandled|job failed'

# 数据库信号
docker exec beaconhs-local-prod-postgres-1 psql -U postgres -d beaconhs -c \
  "select count(*) as outbox from storage_object_deletion_outbox;
   select count(*) filter (where occurred_at > now() - interval '24 hours') as audit_24h from audit_log;
   select count(*) from drizzle.__drizzle_migrations;"

# 健康与可用性
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/health/ready
curl -s http://127.0.0.1:8000/api/health/ready
```

**告警阈值（建议）**：任一容器 `RestartCount > 0`；错误日志计数 > 0；`outbox` 持续增长 > 1h；`audit_24h = 0` 但确认有用户操作；`/api/health/ready` 非 200 或 version 不是 `424761d0…`。

## 3. 写路径端到端冒烟（需人工执行）

**为何未自动执行**：以下流程会在生产创建真实业务数据与对象存储对象，且需要已认证会话（Magic link / API key）。自动化会污染生产数据，也不应读取生产 Secret。请在浏览器用有权限的测试账号手工走一遍，或由运维在明确的测试租户内执行。

| #   | 步骤                                | 断言                                                                                                  |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | 登录 `/login`（Magic link）         | 进入 app shell，无 500                                                                                |
| 2   | 新建一条 Incident（或任意模块记录） | 保存成功、列表可见、`audit_log` 新增 1 行                                                             |
| 3   | 上传一个附件                        | 附件可读、MinIO `beaconhs-prod` 出现新对象                                                            |
| 4   | 导出报表（CSV/PDF）                 | 文件下载成功、`audit_log` 记录 export                                                                 |
| 5   | 新建 PPTX 课程/课件并删除           | 删除成功                                                                                              |
| 6   | 检查 outbox                         | 若该 PPTX 附件无其他引用，`storage_object_deletion_outbox` 出现 1 行；worker 处理后该行消失、对象被删 |
| 7   | 检查审计不可变                      | 尝试改/删任意 `audit_log` 行 → 被拒                                                                   |
| 8   | 跨租户反向验证                      | 用另一租户账号查第 2 步记录 → 404 / 不可见                                                            |

第 6 步是**唯一尚未在真实存储联调过**的路径（隔离 PG 验证过 DB 事务与 outbox 幂等，MinIO 端到端删除未跑）。

## 4. 回滚触点

| 资产                              | 位置                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| DB 备份（pre-migration，54 迁移） | `/home/xuhaoqing/beaconhs-backups/beaconhs-20261109T223650Z/beaconhs.dump` + `.sha256` |
| MinIO 目录快照                    | 同目录 `minio-data.tar.gz` + `.sha256`                                                 |
| 旧运行时配置                      | `/home/xuhaoqing/.beaconhs/runtime/local-prod.env.bak-20261110`                        |
| 旧镜像                            | `beaconhs:ea66d4-31`（`sha256:2aab7973…`），仍在主机                                   |
| 部署脚本                          | `beaconhs-canonical/scripts/deployment/beaconhs-{stop,start,status}.sh`                |
| Gate 5 结果                       | `/home/xuhaoqing/.beaconhs/runtime/gate5-last-result.txt`                              |

**已验证的恢复链**（生产主机本机临时库，未动生产库）：`pg_restore` 0 错误 → `APP_ROLE=migrate` `54→57` → 终态 FK `RESTRICT` + 审计触发器在位。详见 `BEACONHS_POST_CUTOVER_CONVERGENCE_REPORT.md`。

**回滚顺序**（仅在确需回滚时，且须先停写）：

1. `beaconhs-stop.sh` 停止写入
2. 恢复 DB（按 `docs/backup-restore-runbook.md`，`--role=beaconhs_owner`）
3. 恢复 MinIO 数据（解压快照，或按 runbook 工具）
4. 将 `local-prod.env` 的 `BEACONHS_IMAGE` / `BEACONHS_IMAGE_DIGEST` / `APP_VERSION` 改回旧值（备份文件可用）
5. `beaconhs-start.sh` 拉起，确认 Gate 5 与 `/api/health/ready`

⚠️ 0056/0057 把 audit FK 由 CASCADE 改为 RESTRICT，**结构不可逆**；若回滚到 54 迁移状态需按备份整库恢复，不能只回退镜像。

## 5. 定期化建议

- 把一次性 `pg_dump` 变成每日 cron + 保留策略；每月做一次恢复演练并记录 RTO
- 用 runbook 的 `packages/object-store-backup` 替换当前目录快照（提供 manifest / HMAC / age 加密），工具需先部署到主机
- 把第 2 节的观测命令接入现有告警（或简单 cron + 邮件）

## 6. 待产品负责人签字

见 `BEACONHS_PRODUCT_DECISIONS.md`：PD-01（F2 site/self）、PD-02（审计回溯）、PD-03（A3 回填）。A3 Apply **未执行**。
