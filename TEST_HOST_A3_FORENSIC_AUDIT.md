# Test Host A3 Forensic Audit — OpenCode Test 主机取证报告

**报告日期（主机时区）**: 2026-11-09
**审计范围**: 只读取证，未连接数据库、未恢复备份、未执行 A3 Audit/`--apply`/Migration、未启停/删除/重建容器、未修改代码/配置/指纹/guardrails，未读 `.env` 明文，未接触 `10.10.31.30` 与 `10.10.31.13`。
**证据要求**: 结论均标注文件路径 / Git commit / 行号 / 可复核命令。

---

## 1. 当前 OpenCode Test 主机身份

**【已证实事实】**

- `hostnamectl` Static hostname: `test-Virtual-Machine` (Hyper-V VM, Ubuntu 24.04.5 LTS, Kernel 7.0.0-42-generic)
- 当前用户 `test`，`HOME=/home/test`，发行版 `PRETTY_NAME="Ubuntu 24.04.5 LTS"`
- OpenCode 进程：`test 1591493 ... opencode serve --hostname 0.0.0.0 --port 4096` (`ps aux`)
- 当前工作目录：`/home/test/projects/beaconhs-hse`（`git rev-parse --show-toplevel`），与 `pwd` 一致

**证据命令**:
```bash
hostnamectl
whoami; echo $HOME; pwd
ps aux | grep -i opencode
git rev-parse --show-toplevel
```

## 2. 原 BeaconHS 项目真实路径

**【已证实事实】**

- Git 根：`/home/test/projects/beaconhs-hse`（非符号链接，`ls -ld` 确认目录）
- 当前 HEAD：`b9d1ab4134449cd52bc6f8c740a82a38f5d009fb`，分支 `hse-platform`（`[origin/hse-platform: ahead 29]`）
- 未提交修改：仅 `M apps/web/next-env.d.ts`（与 A3 无关）
- `git worktree list` 仅一条：`/home/test/projects/beaconhs-hse b9d1ab41 [hse-platform]`；无额外 worktree
- 同级目录（经 `git -C` 探测均为「非 Git 仓库」）：
  - `~/projects/beaconhs-ea19-snapshot`（含 `apps/web/scripts/backfill-*` 但**缺** `backfill-attachment-capability-v2.ts`）
  - `~/projects/beaconhs-ea21-exp`（同上，缺 v2 脚本）
  - `~/projects/beaconhs-hse-release-snapshot`（仅 `MANIFEST.txt` + `changed-files`）
  - `~/beaconhs-ea13-cleanup-backups`（见 §6）

**结论**: 原先审计目录即当前此检出，不在 Docker 镜像内，也不在 `.30/.13`。

## 3. 原审计 commit、分支和版本

**【已证实事实】** 5 个目标提交均存在且为 HEAD 祖先（`git merge-base --is-ancestor` 均为 `yes`）：

| Commit | 时间 (+0800) | 主题 |
|---|---|---|
| `7df32ab6` | 2026-11-09 13:13:20 | Close the deferred-term ILIKE escapes and pin them with a contract |
| `05f73be7` | 2026-11-09 13:18:38 | API permission audit phase 1: complete route inventory and mechanism map |
| `eecc87cf` | 2026-11-09 13:26:08 | API permission audit phases 2-4: evidence, matrix, report, remediation |
| `d06924d0` | 2026-11-09 13:35:21 | Deep round 2: API write-surface live probes and connection-pool isolation |
| `bfc3f889` | 2026-11-09 13:58:54 | A3 pre-launch review: backfill conditions, release ordering, rollback plan |
| `b9d1ab41`（HEAD） | 2026-11-09 14:08:21 | A3 backfill execution card: read-only audit, verified gates, data checks |

线性后继链：`b9d1ab41 → bfc3f889 → d06924d0 → eecc87cf → 05f73be7 → 7df32ab6 …`（`git log --oneline` 确认）。分支仅 `hse-platform` 包含 HEAD；`main 70da27c4` 落后 upstream 1。

审计报告（仓库根，均为跟踪文件，未篡改）：
- `API_SECURITY_EVIDENCE.md` (6253 B, eecc87cf)、`PERMISSION_TEST_MATRIX.md` (6492 B)、`API_SECURITY_AUDIT_REPORT.md` (3501 B)、`API_SECURITY_REMEDIATION.md` (2664 B)、`API_ROUTE_INVENTORY.md` (15996 B, 05f73be7)、`API_WRITE_SECURITY_AUDIT.md`、`CONNECTION_POOL_ISOLATION_AUDIT.md`、`DEEP_SECURITY_EVIDENCE.md`
- `A3_BACKFILL_PREFLIGHT.md` (3888 B, bfc3f889)、`A3_EXECUTION_CARD.md` (1568 B, b9d1ab41)、`ROLLBACK_PLAN.md` (2926 B, bfc3f889)、`RELEASE_READINESS_CHECKLIST.md` (2721 B)

**【重要限制】** `A3_EXECUTION_CARD.md`（1568 B）在 `b9d1ab41` 中**正文截断**于 `... matching fingerpr ...[truncated]`（`git cat-file` 与工作树一致），所谓「第 2 节命令」在仓库内**不存在**；仅脚本头（`backfill-attachment-capability-v2.ts:1-22`）声明默认 AUDIT-ONLY。

## 4. API 安全审计与 A3 问题发现时间线

**【已证实事实，文件+提交】**

1. **09-07 13:13** `7df32ab6` 先关闭 `deferred-term ILIKE` 转义问题（审计前置）。
2. **09-07 13:18** `05f73be7` 建清单 `API_ROUTE_INVENTORY.md`（15996 B）。
3. **09-07 13:26** `eecc87cf` 落 EVIDENCE/MATRIX/REPORT/REMEDIATION 四件套；E7 覆盖附件 capability 的跨租户与 v1→v2 降级（`API_SECURITY_EVIDENCE.md` E7）；Remediation 指出已修复 `attachment:v1→v2`（`b3e65ef6`）、PIN 6–12、D8 FK、ILIKE（`API_SECURITY_REMEDIATION.md §Already fixed`）。
4. **09-07 13:35** `d06924d0` Deep round 2（API 写面探针 + 连接池隔离），`API_WRITE_SECURITY_AUDIT.md / CONNECTION_POOL_ISOLATION_AUDIT.md / DEEP_SECURITY_EVIDENCE.md` 随之。
5. **09-07 13:58** `bfc3f889` 完成 A3 预审：复核脚本/锁/CAS/失败闭合（Preflight #1–#10），dev 侧 SQL-only 扫描称 `form_responses / training_lessons / training_content_items` 在两租户均 **0 附件引用**（`A3_BACKFILL_PREFLIGHT.md`），部署序见 `RELEASE_READINESS_CHECKLIST.md`，三表 dump 回滚见 `ROLLBACK_PLAN.md`。
6. **09-07 14:08** `b9d1ab41` 卡片记录**本机 guardrails 不通过**（`ae0ab37a…`≠`a19382e0…`、secret unset），声明「已在 dev 容器外的审计环境」执行，卡片截断导致无完整命令。

**A3 机制**（代码，非推断）：`b3e65ef6` 撤销 `attachment:v1:`→`v2`（`lib/attachment-url.ts`），历史 v1 cap 部署即 404；`backfill-attachment-capability-v2.ts` 默认 AUDIT-ONLY（`APPLY = process.argv.includes('--apply')`），`applyPlans` 单事务+CAS+advisory lock `beaconhs:attachment-capability-v2:v1`，幂等第二遍 `changedRows=0`；切面覆盖 `training_lessons/training_content_items.content_html` 与 `form_responses.(data/draft_data/workflow_state)`。

## 5. A3 目标指纹历史及来源分析

**【已证实事实】** 代码常量（`apps/web/scripts/cutover-target.ts:4-13`）：

| 指纹 | 值（前缀） | 算法 | 首次引入 |
|---|---|---|---|
| Pool | `a19382e01cec8…` | `SHA256('beaconhs-cutover-db-v1\|hostname\|port\|pathname')`，`port|5432` 缺省 | `a1e55581` 2026-07-12 |
| Direct | `0ae09059b957e…` | 同上（端口不同） | 同上 |
| Storage | `2609e30684ee…` | `SHA256('beaconhs-cutover-storage-v1\|origin\|path\|bucket')` | 同上 |
| Secret | `1c79927db4fd…` | `SHA256(secret)`（`ATTACHMENT_CAPABILITY_SECRET`，≥32 字符） | 同上 |

`git log -S` 对三指纹均**仅** `a1e55581 cutover: harden dev data migrations`（上层 Braedon Saunders，07-12 23:52）。`b3e65ef6` 仅引入 v2 脚本与校验器，未改常量。

**目标来源证据（分事实/推断）**：

- 【事实】`beaconhs-dev` 首次作为部署名出现于 `c8411b7d 2026-06-10 feat(training): … deploy dev to Dokploy` 与 `b01dbdcd`，`dokploy-mgr` placement 见 `deploy/dokploy-dev.compose.yaml` 全文及 `e79a805e / d0b71d3b / 156f14a8` 等 9 提交（`git log -S dokploy-mgr`）；EA62 另记「target host has no Dokploy control plane / wrong for the target」。
- 【事实】本机存在 `beaconhs-dev_default` 网络（Compose `project=beaconhs-dev`）、`beaconhs-dev_*` 卷三件套、`beaconhs-postgres` 容器 Labels `project=beaconhs-dev, config_files=/home/test/projects/beaconhs-hse/docker-compose.yml`（`docker network inspect` 含 `beaconhs-collabora/minio/postgres` 三端点）。
- 【推断（非事实）】该网络/卷/容器为**历史本地 `docker-compose` 跑出的 `beaconhs-dev`**，而非 Dokploy/Swarm。理由：Compose 标签 + 本机已知的 `ae0ab37a…` 与审计目标不同。
- 【无法确认】原指纹是否来自本机历史容器/数据库：`.env` 内容未读（禁止），不可反推 host/port；亦无审计日志归档。

**为什么现在无法验证**：`BEACONHS_CUTOVER_TARGET` 未设、`NODE_ENV` 未设、`SUPERADMIN_DATABASE_URL` 未设、`ATTACHMENT_CAPABILITY_SECRET` 未设（shell `env` 检查）。Guardrails 会在 `requireCutoverDatabaseTarget / requireCutoverCapabilitySecret`（`cutover-target.ts:45-53,136-141`）正常报错。本机指纹 `ae0ab37a…` 与 `a19382e0…` 不等，`assertCutoverDatabaseSession` 要求的 `beaconhs_super / beaconhs` ByaPASSRLS 角色亦未在当前会话下断言。

## 6. 数据库与附件备份清单及可恢复性

**【已证实事实，元数据，未读内容，未恢复】**

| 备份 | 路径 | 大小 / 时间 | SHA-256（文件） | 格式 | 附件覆盖 |
|---|---|---|---|---|---|
| `beaconhs_al_scratch-20261022.sqlc` | `~/beaconhs-ea13-cleanup-backups/` | 1336616 B / 2026-10-22 15:15 CEST `0600` | `c1b1a274…` | PostgreSQL custom dump v1.15-0 | **无附件对象数据**：仅 DB，附件在 MinIO/对象存储，目录未见 MinIO 归档 |
| `beaconhs_ea12_scratch-20261022.sqlc` | 同上 | 1253026 B / 同 `0600` | `d6e3cf96…` | 同上 | 同上 |
| `opencode.db*` 四件套 | `~/opencode-migration-backup/` | 102M / 2026-10-07 `0600` | 未计算（非 A3） | SQLite | 非 BeaconHS |

- **可恢复性判断**：两 `sqlc` 为 custom dump（`file` 判定），格式正确但**无 MinIO 附件数据**，无法单独证明含 A3 所需附件引用；`file` 无法替代 `pg_restore -l` 验证，且本轮禁止连接/恢复。
- **MinIO**：`docker volume ls` 含 `beaconhs-dev_minio-data`（及 `beaconhs-hse_*`、`beaconhs-prod-verify_*`），但 `/var/lib/docker/volumes` 因权限不可展开，未能验证对象覆盖；`find` 未见独立 MinIO 数据归档。
- **A3 输出**：全树未发现 `*AUDIT*.log / rowsScanned*.out / backup_pre_a3*.sql` 类产物；`A3_EXECUTION_CARD.md` 截断，无审计计数留存。
- **环境文件**：`.env (600 B, 664, 2026-11-09)`、`.env.orig (3958 B, 600, 2026-10-08)`、`.env.prod-verify (1145 B, 600, 2026-10-08)` 均存在且未读；`~/.beaconhs/runtime` 本机无对应目录。

## 7. 原始审计环境是否仍可追溯

**部分可追溯，整体不可运行恢复：**

- 可追溯：三指纹的引入提交、本地 `beaconhs-dev` 历史 Compose 残留（网络/卷/容器 Labels）、两份 `sqlc` 元数据。
- 不可追溯：已审计 DB 的 host/port/地址、审计 secret 明文（Vault 不可得）、审计输出与 `A3` 执行记录、 Dokploy `dokploy-mgr` 的身份。

## 8. 已证实事实 / 合理推断 / 无法确认

- **已证实**：主机身份、路径、HEAD 等五提交、A3 报告七件、指纹常量与算法、`0054/0055` 与 `production-cutover-integrity.test.ts` 锁表（迁移 0054–0055 均已提交且台账列全）、本地无 A3 输出、env 均 unset。
- **合理推断**：本机历史 `beaconhs-dev` 为本地 Compose 非审计目标；两 `sqlc` 为 EA13 清理底盘，非 A3 目标库备份。
- **无法确认**：原审计 DB 地址、secret 明文、MinIO 附件覆盖度、Dokploy 主机身份、A3 实际计数。

## 9. 后续恢复原审计链所需最小条件

1. **目标清单**：明确已审计 `SUPERADMIN_DATABASE_URL`（pool/direct 各一）经 Vault/秘密文件注入（不经聊天/日志），并在目标机导出 `BEACONHS_CUTOVER_TARGET=beaconhs-dev`、`NODE_ENV=production`。
2. **证据归档**：`A3_EXECUTION_CARD.md` 第 2 节补全并重签发；`backup_pre_a3_*.sql` 按 ROLLBACK_PLAN §1 归档（当前缺）。
3. **备份/附件对应**：若恢复 `sqlc`，须另备同租户 MinIO 附件数据快照并做非恢复的元数据比对；恢复本身需另行授权（含 `pg_restore` 链与 RLS 验收）。
4. **指纹声明**：重现目标后重算两 DB 指纹并与 `a19382e0… / 0ae09059…` 比对；Secret 指纹须与 `1c79927d…` 已验明相等，且明文不得落盘入仓。

**停止于此**，待审阅后决定下一步（是否补发执行卡/是否重建目标）。本轮未触碰 `.30/.13`，未改代码/指纹/guardrails，未运 Audit/DB。
