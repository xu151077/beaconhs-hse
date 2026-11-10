# BeaconHS 生产发布预案（PD-01 发布候选随行文件）

**适用基线：** HEAD `62237a25`（21 commits ahead of `origin/hse-platform`）。生产现状：`https://hse.xuhaoqing.top`（10.10.31.13），镜像 `beaconhs@sha256:4ca7ec41…`，`APP_VERSION=6ce125a4…`，57 migrations。
**前提：** 本预案仅在发布授权（单独批准）后执行。本文件本身是只读审查产物，未执行任何生产操作。

## 0. 执行顺序总则（决定性约束）

```
备份 → 迁移(0058) → [健康检查] → 部署新镜像 → [验证] → 观察
```

**绝对禁止先部署代码、后迁移**：新代码认证路径 SELECT `api_keys.principal_tenant_user_id` / `scopes`，57-migration 数据库上会全量 500。反过来，**迁移完成后允许直接回滚旧应用版本**（0058 纯加列，旧代码不引用新列 —— 见 `BEACONHS_DATABASE_MIGRATION_REVIEW.md` §2/§4）。

## 1. 生产环境检查

- [ ] 确认生产仍在 57 migrations / `APP_VERSION=6ce125a4…`（readiness 已证明部署 SHA）
- [ ] CI 对 21 个领先提交全绿（push 后确认；当前未 push —— 前置条件）
- [ ] 磁盘、连接数、Redis/MinIO/Postgres 健康检查通过（既有每小时 `health-check.sh`）
- [ ] 无进行中的后台迁移/导入任务
- [ ] 确认发布窗口与值班人员；变更记录就绪

## 2. 数据库备份

- [ ] 手动触发一次即时加密备份（复用 `backup-daily.sh` 的机制）并**验证成功标志**
- [ ] 记录备份标识/时间戳，确认可恢复（近一次恢复演练仍在有效期内）
- [ ] 确认 WAL 归档连续（RPO 15 分钟基线）

## 3. 数据库迁移（0058）

- [ ] 以迁移凭据在维护窗口执行 `db:migrate`（禁止长运行容器持有迁移凭据 —— runbook 约束）
- [ ] 预期输出逐项核对：role preflight → advisory lock → ledger "57 applied, 1 pending" → drizzle migrate → ledger "58 applied, 0 pending" → RLS applied atomically (191 tables) → grants/invariants/roles/stats/views
- [ ] **任一步骤失败：停止，不部署**；按 `BEACONHS_DATABASE_MIGRATION_REVIEW.md` §3/§4 处理（重跑或恢复备份）
- [ ] 迁移后立即验证：`\d api_keys`（两列 + 索引存在）、`select count(*) from api_keys where principal_tenant_user_id is not null;` 预期 **0**

## 4. 应用部署

- [ ] 构建/推送新镜像（`APP_VERSION=62237a25…` 全 SHA），仅替换 web/worker/scheduler；迁移凭据不进入运行容器
- [ ] 先单实例/滚动部署 web，再 worker/scheduler
- [ ] readiness 必须证明新 Git SHA（runbook gate）

## 5. 健康检查

- [ ] `/api/health/ready` 200 且报告新 SHA
- [ ] 登录页 200；一次真实登录成功
- [ ] worker scheduled tick 正常输出；错误监控无新增告警（含一次合成错误验证既有告警链路）

## 6. API Key 兼容验证

- [ ] 用**现有生产 API Key**（均为未绑定形态）调用任一既有实体列表：200 且数据与迁移前一致（`ratelimit-*` 头存在）
- [ ] 无 Authorization / 无效 key → 401
- [ ] 确认 `select count(*) from api_keys where principal_tenant_user_id is not null = 0` → 证明全部 key 走 legacy 路径，PD-01 scope 层处于休眠状态

## 7. Tenant / Site / Self 授权验证（可选，仅当开始签发 scoped key 时）

- [ ] 在测试租户签发 bound key（principal + scopes），验证：tenant 全量、site 失败闭合（documents/training_records 空集）、self 仅本人记录
- [ ] 验证 M1 行为：self key PATCH 本人记录的 `ownerTenantUserId` → 403 且 DB 不变
- [ ] 验证 Builder：scoped key 访问 responses → 403 固定文案
- [ ] **生产验证不修改任何业务数据；必要时用专用测试租户并在验证后清理**

## 8. 日志及异常检查

- [ ] 迁移与部署窗口内：无 `[api/v1] unhandled error`、无 500 增长、无 RLS 相关错误
- [ ] 审计日志确认 API Key 调用被记录（actorKind=api_key）
- [ ] 观察期 ≥ 24h：错误率、p95 延迟与基线对比

## 9. 回滚触发条件

满足任一即回滚：

- readiness 不报告新 SHA 或健康检查失败持续 > 5 分钟
- 认证/列表出现 500（尤其 `column … does not exist` —— 表明迁移/部署顺序错乱）
- 错误率或延迟显著偏离基线且无法快速归因
- 任何数据完整性异常（审计缺失、租户数据可见性异常）

## 10. 应用与数据库回滚策略

| 场景                                                 | 动作                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **迁移成功后、应用异常**                             | ✅ **直接回滚旧镜像**（`6ce125a4`）—— 旧应用与 58-migration 数据库完全兼容；**无需回滚 Schema** |
| **迁移本身失败**                                     | 未部署新代码则生产不受影响；按失败点处理（重跑 / 恢复备份）                                     |
| **Schema 需回退**（仅在绑定 principal 之后才有意义） | 首选备份恢复（PITR）；手工 DDL（DROP INDEX/COLUMN）仅作为紧急路径并需评审                       |
| **部署后数据异常**                                   | PITR 恢复到迁移前时间点，随后重走 §3→§4                                                         |

## 11. 明确声明

- 迁移完成后**允许**直接回滚旧应用版本（本预案 §10 第一行），且**不需要**回滚数据库 —— 这是 0058 纯加列设计的直接结果。
- 本预案不含 Push / Merge / 部署动作；等待单独批准。
