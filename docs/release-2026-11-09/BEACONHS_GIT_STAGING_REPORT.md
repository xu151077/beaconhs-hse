# BeaconHS Git 选择性暂存报告

## 1. 执行前 HEAD 与分支

- HEAD `20d0c78fafcfe61eeb2fd02aa9439b4ca718523b` / `hse-platform`（与整理报告一致）

## 2. 执行前工作区

33 修改 + 19 未追踪，见 `git status --short`（本报告 4 个 `?? BEACONHS_*.md` 在列）。

## 3. 执行前暂存区

空（`git diff --cached --stat` 0 行）。

## 4. Manifest 核对

A 必须暂存 25 文件逐个核对存在/diff 一致/无 Secret → 全部核准；B `next-env.d.ts`、C `.env*`、D 报告归档 全部排除。

## 5. 实际暂存（25 文件）

见 `git diff --cached --name-only`：

- 0056 SQL/new、0056 snapshot/new、_journal.json
- audit.ts、ppe.ts
- PPTX `_lib/_actions/library/studio`
- write.ts、builder-apps.ts
- documents/_master-actions、people/files|titles、insights/_actions、reports/export、training/evaluations、backfill-attachment-*
- 7 测试（audit-immutability/fk-0056-snapshot/pptx-concurrency-pg/fk-snapshot-coverage/production-cutover-integrity/security/phase11f）

## 6. 未暂存及原因

- `next-env.d.ts`（构建产物，B）
- `.env*`（C，未修改）
- 全部 `BEACONHS_*.md`/`TEST_HOST_*.md`/历史 `A3_/API_*.md`（D 归档，未入整改提交）

## 7. Secret 终检

候选 diff + staged diff 两次扫描：均无真实 Secret/生产地址（`10.10.31.13` 无命中）。

## 8. next-env.d.ts 排除确认

不在暂存区（`git diff --cached --name-only` 无此文件）；工作区差异保留。

## 9. 暂存后状态

- `git diff --cached --stat`：25 文件
- `git status --short`：暂存 `M `/`A ` + 未暂存 ` M`（12 历史 MD + next-env） + 未追踪 `??`（报告类）

## 10. 暂存区 vs 工作区差异

|                       | 暂存（本轮新） | 执行前已有 | 仍未暂存 | 未追踪 |
| --------------------- | -------------- | ---------- | -------- | ------ |
| 25 整改文件           | ✔ 本轮         | 无         | —        | —      |
| 12 历史 MD + next-env | —              | 无         | ✔ 保留   | —      |
| 19 ?? 报告/其余       | —              | 无         | —        | ✔ 保留 |

## 11. 提交前复核条件

**具备**：暂存内容符合 Manifest、排除项未入、Secret 干净、用户修改完整保留。可进入提交前最终复核（仍需人工审暂存 diff 后再决定是否 commit；本轮未提交）。
