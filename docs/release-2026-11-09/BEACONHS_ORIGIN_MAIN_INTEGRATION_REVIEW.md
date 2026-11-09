# BeaconHS origin/main 整合审查报告

## 1. 当前 Git 状态

HEAD `78e48df8` / `hse-platform`；工作区 13 M + 17 ??；未 fetch（远程引用可能陈旧，结论基于现有引用）。

## 2. origin/main 引用状态与陈旧限制

`origin/main=c96bb1ba` 领先本地 `main(70da27c4)` 1 提交。未执行 fetch → **"更新后须复验"** 标注。

## 3. main vs origin/main

merge-base = `70da27c4`；本地独有 0，远程独有 1：`c96bb1ba fix(email)…`（attachments/auth 日志）。但本地已有等价 `454658c4`（邮件文件逐行同，差 `.opencode` 增量）→ 无实质新功能。

## 4. hse-platform vs origin/main（100 本地独有）

分类：安全整改 1（78e48df8）；其余 99 为 HSE 功能开发（schema/migration 推进到 0056、platform/reports/归档链），不能单拎 78e48df8 到现基线之上单建。

## 5. 远程独有提交分析

`c96bb1ba`（7 文件 email/auth）：本地 `454658c4` 同 message+同内容 email 侧，已包含。

## 6. 25 整改文件完整性

25/25 在 HEAD Diff 中；`78e48df8 NOT IN origin/main`（`--is-ancestor`=1）→ 需通过整合带入。

## 7. Migration/schema 依赖

0056 依赖 0055 及journal 同序；`origin/main` 仍停在更早（journal 尾在 0041 系），直接 cherry-pick 0056 会**缺中间 migration** → migration 顺序断裂。

## 8. 三方案比较

| 方案                                                                   | 完整性        | Migration   | 历史 | 冲突                     | 回滚   | 生产无关带入   |
| ---------------------------------------------------------------------- | ------------- | ----------- | ---- | ------------------------ | ------ | -------------- |
| A 整体并 hse-platform→origin/main                                      | ✅ 含 0056 链 | ✅ 100 连贯 | 大   | 低（merge-tree exit0）   | 大回滚 | 会带入 99 功能 |
| B 仅 cherry-pick 78e48df8                                              | ❌ 缺中间链   | ❌ 断裂     | 小   | **5 文件真冲突**（见下） | 小     | 不带           |
| C 独立发布分支（基 origin/main + 整体 cherry-pick 100 连贯提交或合并） | ✅            | ✅          | 可控 | 需验证                   | 可控   | 可控           |

**B 冲突（实测）**：`backfill-attachment-*.ts` modify/delete；`people/files.ts` 内容；`_journal.json` 内容（0042… 链）；`fk-snapshot-coverage.test.ts` modify/delete；`production-cutover-integrity.test.ts` 内容；`phase11f-test.ts` modify/delete。

## 9. 推荐

**C**（独立发布分支，自最新 origin/main 建，整体引入 100 本地提交链，跑门禁+迁移+回归后按策略合入）。**仅发布安全整改不可行（B 在 migration 上断裂 + 5 真冲突）**——若确需最小面，须把 0056 前置迁移链一并带上，并人工解 5 文件。

## 10. 后续授权

需 separately 授权：fetch 更新远程引用、建发布分支、整合、CI/门禁、测试、（如决）push/MR。未执行任何写操作。
