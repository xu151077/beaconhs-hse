# BeaconHS 生产上线准备 — 只读合并前发布评估

## 1. 评估范围与授权边界

只读评估，未修改源码/暂存区，未执行 Migration/A3/部署，未连生产。首次执行（本轮）。

## 2. Git 当前状态

- HEAD `78e48df8…`（`hse-platform`，目标 Commit 即 HEAD，`--is-ancestor` = 0）
- 暂存区 0；未暂存 13 `M`（12 历史 MD + next-env）+ 未追踪 17；与历史记录一致。

## 3. Commit 完整性

`78e48df8 fix(security): harden tenant isolation and data integrity`，25 文件、`--check` 过、hooks 未绕过。本地领先 `origin/hse-platform(ccec…)` 32 提交 —— **未推送**。

## 4. 候选发布目标分支（待负责人确认）

- 本地 `main 70da27c4`（HEAD 祖先，fast-forward 合并）
- `origin/main c96bb1ba`（含 1 未合 commit `fix(email)…`）
- `origin/hse-platform cecb92f5`（远端旧基线）

无法仅凭名称推断生产关系。需负责人确认正式发布目标。

## 5. 分支差异与合并风险

`merge-tree --write-tree` 只读模拟（未改工作区）：对 `main` 与 `origin/main` 均 exit 0（无冲突标注）。注意：仅模拟，不等于未来实际合并结果；`origin/main` 分叉仅 1 commit，`main→HEAD` 差 100 提交、覆盖 A3/00xx 文档链。Migration 顺序：0056 已登记 journal 末尾，main 无后续 migration（`git diff main HEAD --name-only` 0056 为新增）→ **无顺序冲突**。未暂存 13 修改与发布文件重叠：历史 MD（A3/API 等）+ `next-env.d.ts`，非运行时发布面。

## 6. 生产部署架构（仓库文档）

`docs/beaconhs-official-deployment-baseline.md` + `docker-compose.yml`：postgres:16-alpine、redis:7-alpine、minio（官方 HEAD）、mailpit、collabora。入口 `pnpm db:migrate`（`packages/db/src/migrate.ts`）、备份见 `docs/backup-restore-runbook.md`。生产停机窗口、真实回滚规程细节仓库未写明 → **生产环境信息待提供**。

## 7. Migration 风险

0056：SQL/Snapshot/Journal 一致；0055 哈希未改；audit trigger/RESTRICT/RLS 在发布路径内；幂等防重放（含语义重复拦截）；隔离真 PG 全链（0000→0056/0055→0056/重放/恢复）历史通过。不可逆：FK 由 CASCADE 改 RESTRICT（tenant 硬删有审计行即拒），需备份在先。

## 8. 安全整改发布覆盖

F1 403 / F2 tenant 谓词 / A3 锁 / PPTX 四锁 / Outbox 同事务 / Audit trigger 均在 HEAD 内（未回退）。

## 9. 上线前置条件

- [ ] 确认发布目标分支
- [ ] 生成工件（镜像/包）并记录 digest
- [ ] 线上备份（含角色/权限平面）+ 恢复演练记录
- [ ] 停机窗口/负责人/回滚负责人
- [ ] MinIO/Redis/队列的端到端健康检查（本轮未做真实联调，引用历史验证）
- [ ] 0056 部署顺序：备份 → 部署新代码 → `db:migrate`（0056 幂等）→ 验证 RLS/审计

## 10. 阻断项与待确认

- **阻断（流程）：** 未推送（32 提交仅本地）→ 需 push 授权；发布目标未确认
- PD-01/PD-02/PD-03 维持待决策，不阻塞安全修复上线，但须知悉：A3 回填未执行、F2 无 site/self 二次面、审计回溯未授权
- 未验证：实时 `git merge` 冲突（仅 merge-tree 模拟）；生产存储/在线升级行为

## 11. 建议下一阶段

有条件进入下一阶段：可做 push/合并准备，前置为（a）负责人确认发布目标（b）推送授权（c）生产备份与回滚确认。

## 12. 未执行事项

Merge/Push/rebase/Migration/A3 Apply/回填/部署/生产访问、fetch、`.env` 读取。报告文件为无踪迹只读新增（未入 HEAD）。
