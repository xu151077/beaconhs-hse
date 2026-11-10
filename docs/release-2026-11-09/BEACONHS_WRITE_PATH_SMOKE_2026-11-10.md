# BeaconHS 写路径端到端冒烟 — 2026-11-10

**环境：** 本地隔离 dev（`localhost:3000` + 本地 Postgres/Redis/MinIO/Mailpit），**未连接生产**。
**基线：** `hse-platform @ 6ce125a4`（与生产镜像同源码）。
**目的：** 验证唯一尚未在真实存储上跑过的路径——附件删除 → outbox → worker → 对象存储删除。

## 结果

| #   | 步骤                           | 证据                                                                                                                                                             | 结果 |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | 登录                           | 会话进入 `/dashboard`                                                                                                                                            | ✅   |
| 2   | 新建 Incident                  | `INC-2026-0005` / `/incidents/eb4b7f88-…`；`audit_log` 同事务写入 1 行 `incident/create`                                                                         | ✅   |
| 3   | 附件上传                       | `attachments a542417a…`（image, smoke.png, 70 B）；MinIO `t/<tenant>/image/<uuid>-smoke.png`；`incident_attachments` 1 行；UI `Photos 1`                         | ✅   |
| 4   | 报表导出                       | `GET /reports/definitions/…/export?format=csv` → **200**、`text/csv; charset=utf-8`、842 B、含表头与数据行                                                       | ✅   |
| 5   | **outbox → worker → 对象删除** | worker 日志 `[scheduled] storage_object_deletion: 6 deleted / 0 retrying`；MinIO 对象消失；`storage_object_deletion_outbox` 归零；重复 drain `claimed:0`（幂等） | ✅   |
| 6   | 审计不可变                     | `UPDATE` / `DELETE audit_log` → `audit_log is append-only`（触发器，非权限）                                                                                     | ✅   |
| 7   | RLS 跨租户                     | 本租户 `count=1` / 他租户 `count=0`（`beaconhs_app` + `app.tenant_id`）                                                                                          | ✅   |

## 审计中发现（记录，未擅自修改）

| 项                                                             | 性质                                                                                           | 建议                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 本地 `pnpm dev` 只启动 web + worker，**scheduler 未启动**      | 本地脚本与 `AGENTS.md` 描述不符；生产 compose 有独立 `scheduler` 服务，不受影响                | 手动 `tsx src/scheduler.ts` 注册 repeat schedules；或补 `dev:scheduler` 脚本 |
| `retryStorageObjectDeletion` 仅有退避，**无死信/最大尝试次数** | P3 设计局限：永久失败的任务长期留存（每附件一行，不膨胀）                                      | 若需要运维可见性，可加 `dead` 状态与告警                                     |
| 裸脚本调用 `deleteObject` 报 `STORAGE_FREEZE_STATE_UNKNOWN`    | **设计正确**（fail-closed）；worker 启动时 `bootstrapStorageFreezeGate(storage)` 已注册 reader | 无                                                                           |

## 生产侧同时完成的自动化

| 脚本                                  | 频率       | 内容                                                                                                                                                 |
| ------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.beaconhs/scripts/backup-daily.sh` | 每日 03:00 | DB `pg_dump` + MinIO 快照 → AES-256-CBC(PBKDF2 200k) + sha256 → 删明文；保留 7 天。已实测解密后 `pg_restore --list` 正常（2768 TOC）、MinIO tar 可读 |
| `~/.beaconhs/scripts/health-check.sh` | 每小时     | ready 版本、容器状态、重启次数、1h 错误数、outbox 计数、迁移账本 → `health.log`（保留 4000 行）                                                      |

## 未完成（需人或单独授权）

- PD-01（F2 site/self）、PD-02（审计回溯）、PD-03（A3 回填）签字
- A3 Apply（目标在库未定位 + 未授权）
- SSH 密码轮换（按用户要求不变）

## 结论

写路径（含附件 → outbox → worker → 对象存储）在真实 Postgres + MinIO 上**端到端可用且幂等**，审计与 RLS 在真实数据上生效。
