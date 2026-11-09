# BeaconHS PPTX import 锁补齐 — 修复报告

**基线：** `hse-platform / 20d0c78f`，工作区保留（33 修改 + 15 未追踪）。未连生产（`10.10.31.13`）、无迁移/A3 Apply/回填/部署，未动 0055、`.env`/Secret。**仅** `importLessonPptx` 锁 + G/H/I 测试 + 门禁。

## 1. 原始缺陷与根因

`studio/_actions.ts:668-690` 的 `importLessonPptx` 先调 `requireOwnedPptxAttachment`（普通 `SELECT WHERE id=`，无 tenant、无锁），再 `UPDATE trainingLessons.sourceAttachmentId`。与同一附件的并发删除无串行点：删除方可删附件行，导入仍写入已删 ID → 活引用与已安排删除并存（上轮 P1 根因）。

## 2. 修改与调用链

`training/courses/[id]/studio/_actions.ts`：

- `requireOwnedPptxAttachment(tx, tenantId, attachmentId)` 改为 `WHERE id AND tenantId ORDER BY id FOR UPDATE`（同 `purgeDeckAssetsTx`、`pptx/_actions.ts:351`、`library/_actions.ts:171` 协议），`assertTrainingPptxAttachment` 仍在锁下校验。
- `importLessonPptx` 传 `ctx.tenantId`；`requireActiveCourse` → 锁 → `UPDATE … sourceAttachmentId` 均同一 `ctx.db` 事务，未 post-commit 写引用，未改 Permission/RLS，未新增权限系统。

其余写入：新建（`pptx/_actions`，已锁）、library 导入（已锁）、删除 null 化（调 `purgeDeckAssetsTx`，已锁）。未发现其他绕过项。

## 3. 真 PG 并发测试（10/10 通过）

`packages/db/src/pptx-concurrency-pg.test.ts`（`postgres:16-alpine` 临时容器，独立连接，测后删容器）：

| 场景          | 结果    | 断言                                                                                  |
| ------------- | ------- | ------------------------------------------------------------------------------------- |
| A-F 回归（6） | ✅ 通过 | 同上轮：1 outbox/回滚/幂等                                                            |
| G1 删锁先赢   | ✅ 通过 | T1 删 X ref+purge 锁先获，T2 import 块后 `rejected`，`att` 已删，`outbox=1`，活引用 0 |
| G2 导入锁先赢 | ✅ 通过 | T2 import 先获锁后 T1 recount 见 Y ref，`att` 存活，`outbox=0`，活引用 1              |
| H 跨租户      | ✅ 通过 | 他租户锁查 0 行抛 `not found`，Y 引用仍 null，`outbox=0`                              |
| I 回滚        | ✅ 通过 | import 链更新后 throw，整体回滚，引用仍 null，`att` 存活，`outbox=0`                  |

## 4. 门禁（实测）

`format 0 / lint 0 / typecheck(web+tenant) 0 / deadcode 0 / build(4/4) 0`；`web API security 4/4`；`db audit+fk 7/7（真 PG）`；`pptx-concurrency 10/10（真 PG）`。Mock 未冒充真库；Docker 未跳过。

## 5. P1 结论与风险

**P1 已关闭。** 新建/替换/删除/导入 4 口径均走统一行锁；A-I 真 PG 无活删、无死锁，Outbox 幂等保持。建议进入隔离 PG 全链迁移验证（0000→0056/0055→0056/RLS/审计/备份恢复）。

风险：导入校验含 `assertTrainingPptxAttachment`（mimetype/size），与锁顺序一致；生产函数直调未另测（测的是协议复刻），见前报告声明。
