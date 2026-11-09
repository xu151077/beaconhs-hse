# BeaconHS PPTX 并发修复 — 真实 PostgreSQL 验证报告

**基线：** `hse-platform / 20d0c78f`，工作区保留（33 修改 + 14 未追踪，见 §7）。本轮未连生产（`10.10.31.13`）、未跑生产 Migration、未 A3 Apply、未动 0055、未改 Secret。新增隔离测试文件 `packages/db/src/pptx-concurrency-pg.test.ts`（Postgres 16 临时容器，测后 `docker rm -f`）。

## 1. 锁协议核验（源码对照）

`purgeDeckAssetsTx`（`training/pptx/_lib.ts:104-109`）持 `SELECT … ORDER BY id FOR UPDATE` 后同 tx 重计引用；新建/替换两处同锁（`pptx/_actions.ts:351`、`library/_actions.ts:171`，升序单行）。附件 FK 插入取 `KEY SHARE`，与 `FOR UPDATE` 互斥（真 PG 实测通过）。但另有 **未加锁写入**（见 §3），协议覆盖不完整。

> 本报告的真 PG 并发测试复刻的是**协议语句**（锁+重计+删），非生产函数直调；它证明 PG 语义成立，不等同于全部生产入口已覆盖。

## 2. 真实 PG 并发测试（6 场景 — 全部通过）

| 场景                     | 结果    | 证据（最终状态）                                                                          |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------- |
| A 双 tx 删不同引用       | ✅ 通过 | 两独立连接并发，各藏一引用后 purge；`FOR UPDATE` 串行后仅一次删 `attachments`，`outbox=1` |
| B 删最后引用 vs 新增引用 | ✅ 通过 | 新增先提交后删：重计见新引用，`attachments` 保留，`outbox=0`（活对象未进删除态）          |
| C 删 vs 替换到同一对象   | ✅ 通过 | item 替换到 att 后 att 仍 2 引用；删其一后重计仍 1 引用，`outbox=0`                       |
| D 三 tx 并发删除         | ✅ 通过 | 3 独立连接同收敛 `attachments` 已删，`outbox=1`（唯一约束防重）                           |
| E 回滚                   | ✅ 通过 | purge 后抛错回滚，`outbox=0` 且引用恢复；重试后 `outbox=1`                                |
| F worker 重复执行        | ✅ 通过 | `pending` 状态 CAS 删两次安全幂等，`outbox` 0 行，无附带破坏                              |

**验证命令（真 PG，非 Mock）：**

```
docker run -d postgres:16-alpine（随机端口，-e POSTGRES_PASSWORD=testpw）
pnpm --filter @beaconhs/db exec vitest run src/pptx-concurrency-pg.test.ts
# Test Files 1 passed / Tests 6 passed / Duration 1.69s
```

每用例以 `outsideConn`（独立 `postgres()` 连接）+ `c.begin(tx)` 屏障隔离，提交顺序明确；无死锁（限 `ORDER BY id ASC` 排序）；未出现「仍被引用但已安排删除」的活删。

## 3. 发现的协议遗漏（停下待授权 — 本轮未改）

`studio/_actions.ts:668-690` 的 `importLessonPptx` 直接写 `trainingLessons.sourceAttachmentId`，**无 `FOR UPDATE`**（仅 `requireOwnedPptxAttachment` 普通 `SELECT`）。这是 PPTX 第三条写入链：与并发 `purgeDeckAssetsTx` 删同一附件时无串行点，P1 根因仍在。

**修复建议（待授权）：** 在该函数 `requireActiveCourse` 后、`update … sourceAttachmentId` 前补：

```ts
await tx
  .select({ id: attachments.id })
  .from(attachments)
  .where(and(eq(attachments.id, attachmentId), eq(attachments.tenantId, ctx.tenantId)))
  .for('update')
```

与现有两处保持同一行锁。

## 4. Outbox 幂等

`attachment_id UNIQUE + object_key UNIQUE`（`storage-object-deletions.ts:55-56`）+ 同 tx trigger 写 intent；真 PG 实测重复删/CAS 删均收敛（场景 D/F）。对象删除在 worker 侧（未改）；回滚不留有效任务（场景 E）。

## 5. P1 结论与迁移就绪性

- **P1 不能关闭：** 协议在已覆盖路径成立，但 `importLessonPptx` 未覆盖，存在「未修复」残留。
- **迁移就绪：** 不具备进入隔离 PG 全链（0000→0056/0055→0056）的前提；需先补 §3 锁、补真 PG 并发复跑后再定。

## 6. 回归门禁（本轮实测）

| 门禁/测试                                  | 结果   | 备注                              |
| ------------------------------------------ | ------ | --------------------------------- |
| `format:check`                             | ✅ 0   | 新测试已 `prettier --write`       |
| `lint`                                     | ✅ 0   |                                   |
| `typecheck`（`web+tenant`）                | ✅ 0   | 无 `error TS`                     |
| `deadcode:check`                           | ✅ 0   |                                   |
| `build --force`                            | ✅ 0   | 4/4 成功 1m13s                    |
| `web src/lib/api/security.test`            | ✅ 4/4 | API 安全                          |
| `db audit-immutability + fk-0056-snapshot` | ✅ 7/7 | 真 PG                             |
| `db pptx-concurrency-pg`                   | ✅ 6/6 | **真 PG**（`postgres:16-alpine`） |

Mock/源码合同项已在 §1 声明，未冒充真库。测试与真 PG 已分开记录。

## 7. 工作区状态（节选）

```
HEAD: 20d0c78f / branch hse-platform
33 modified, 14 untracked（本轮新增仅 pptx-concurrency-pg.test.ts + 本报告）
```

完整 `git status --short`/`git diff --stat` 以对话记录为准；**本轮无业务代码修改**（缺陷按要求停下报告，未擅自补锁）。

## 8. 尚存风险

1. §3 未覆盖写入（见上）— 建议补锁后复跑 6 场景再关 P1。
2. `loadDeckMaster` 附件读仅 RLS 无显式 `tenantId`（P2，见只读审查）。
3. 通用 API 二次可见性仍待产品决策。

---

**最终结论：部分修复 — 协议语义成立（6/6 真 PG），但存在明确遗漏，不可关闭 P1，不具备全链迁移验证条件。等待授权补 §3 修复。**
