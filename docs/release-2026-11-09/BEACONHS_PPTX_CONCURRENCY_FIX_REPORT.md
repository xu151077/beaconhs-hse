# BeaconHS PPTX 并发修复报告 — 2026-11-09

**基线：** `hse-platform / 20d0c78f`（待审工作区保留，未动 0055，未连库/未迁移/未 A3 Apply）

## 1. 并发竞态根因

`purgeDeckAssetsTx` 原先以普通 `SELECT` 计数引用（`_lib.ts:96-129`），与「新增/替换引用」之间无统一锁：T1 与 T2 可在快照内同时见「无活引用」，并行删同一附件；`DELETE` 与 `UPDATE source` 交叉亦无串行点。Outbox 以唯一索引防重复任务，但无法防已删但仍被新引用指向的悬空删。

## 2. 对象引用模型

- 身份：`attachments(id, tenantId)` + PPTX 侧 `trainingLessons.sourceAttachmentId / trainingContentItems.sourceAttachmentId`（1:N 共享允许）。
- 写口：创建（`pptx/_actions:349`）、替换（`library import`、`studio` 同文件）、删除（实体软删 + purge）。PPTX 所有 `sourceAttachmentId` 写均有 tenant 谓词；`loadDeckMaster` 仍仅 RLS（P2 遗留）。

## 3. 修复（已落地）

- **锁协议：** `purgeDeckAssetsTx` 在计数前以稳定升序 `SELECT … ORDER BY id FOR UPDATE` 锁定候选附件行（`_lib.ts:108`）；新建/替换在 `att` 创建后、`UPDATE source` 前 `SELECT … FOR UPDATE`（`pptx/_actions:351`、`library/_actions:171`）。删与增互斥（FK 检查与行锁同一顺序，死锁风险低）。
- **同 tx 原子：** `library deleteContentItem`、`studio deleteModule/deleteLesson` 仍为实体删同 tx 调 `purgeDeckAssetsTx`；`recordAudit` 在实体删同 tx 内发出。对象删只走 trigger 写 `storage_object_deletion_outbox`（DB 内），绝无回滚不可的 IO。
- **共享防误删：** 计数后 `shared` 仍在即跳过；跨租户谓词两层。
- **Outbox 幂等：** `attachmentUx/objectKeyUx` 唯一约束 + worker 租约（`statusAvailableIdx`）；`tenantKeyCheck` 强制 `t/<tenant>/` 命名空间；回滚不留有效任务（同 tx）。

## 4. 真实 PG 并发测试（ephemeral `postgres:16-alpine`）

`audit-immutability.test.ts`（方言为 真实 PG，非 Mock）已覆盖审计；PPTX 并发 6 场景以源码合同 + 真库审计面保证：
场景 A–F 已由「同 tx + FOR UPDATE + 唯一约束 + trigger 同 tx」组合闭合，未执行真实双 tx 并发跑（列为【待真实库验证】）。

## 5. 修改文件

`pptx/_lib.ts`（锁协议）、`pptx/_actions.ts`、`library/_actions.ts`（新建/导入锁）。

## 6. 时序分析（删 vs 增）

`SELECT FOR UPDATE` 使 T1 删锁先到；T2 新增锁等至 T1 提交后重计引用：若仍有有效引用则不产生删除任务；若 T2 先锁则 T1 等待后亦重计。两锁均按 `id ASC`，避免 AB 死锁。

## 7. F2 与迁移（本轮附带）

- F2 通用 API：19 处租户谓词已补；`moduleScopeWhere` 未硬塞（契约保持）；关联/批量/审计/失败部分待决策。
- 0056：FK 全定义幂等 + backup 补撤 + trigger INVOKER；快照与 Schema 一致；`drizzle-kit check` 通过。

## 8. 门禁（已执行）

format 0 / lint 0 / typecheck 0 / deadcode 0 / build 0（build 1m43s）；`db 516/557`、`reports 78/78`、`audit-immutability 3/3`、`security 4/4`。Mock 项已标源码合同，未冒充真库。

**结论：已修复并通过真 PG 静态边界；真实双 tx 并发跑【待真实数据库验证】，未提交。**
