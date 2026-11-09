# PPTX 事务一致性 + F2 通用 API 契约 — 本轮闭合

**基线：** `hse-platform / 20d0c78f`，工作区已含前轮 32 修改 + 本轮新改。未执行 Migration/Apply/部署，未连生产。

## 1. PPTX 生命周期

```
上传预约 → stagingKey → promote → attachments 行
  → PPTX 记录(sourceAttachmentId) → download(staging/内部流)
  → 替换(sourceAttachmentId 改) → 删除业务(softDelete)
  → 引用关系变化 → 孤儿检查(同 tx)
  → attachments 行删 → trigger 写 storage_object_deletion_outbox
  → worker 异步删对象/更新状态 → 失败重试
```

## 2. 本轮修改（事务边界）

- 新增 `purgeDeckAssetsTx(tx, decks, tenantId)`（`pptx/_lib.ts`）：同 tx 内共享计数 → 删附件行（`tenantId` 谓词）→ trigger 写 outbox；保留零 I/O 在 tx 内。
- 调用方 3 处（`library deleteContentItem` ×1，`studio deleteModule/deleteLesson` ×2）改在实体删同一 `ctx.db` 内调用，`purged` 以对象回传；旧 `purgeDeckAssets(db,…)` 保留为 wrapper（已无调用方新增，兼容导出）。
- 并发：删前 `FOR UPDATE` 锁实体行，共享检查在同一 tx 快照；worker 重试由 outbox 幂等保证（未改 worker）。

## 3. 幂等与并发

- 重复删：软删已判 `already deleted → throw`；附件计数为 0 直接返回。
- 共享删：仍被 live deck 引用时跳过，不误删。
- 跨租户拒：两层 `tenantId` 谓词 + RLS。
- worker 崩溃后重试：outbox 行已提交 state `pending→done`，无重复 DB 删。
- 对象已不存在：worker 幂等收敛（既有逻辑，未改）。

## 4. F2 通用 API 全路径清单

| API                     | 路径                         | Credential | TenantCtx               | Permission             | Ownership                | SQL 谓词             | RLS | Audit |
| ----------------------- | ---------------------------- | ---------- | ----------------------- | ---------------------- | ------------------------ | -------------------- | --- | ----- |
| inc create/patch/delete | `/api/v1/incidents`          | Bearer v2  | `requireRequestContext` | `incidents.*`          | self/all（tenant级）     | `tenantId`（已补锁） | ✓   | 同 tx |
| CA patch/delete         | `/api/v1/corrective_actions` | Bearer     | 同上                    | `corrective_actions.*` | 同上                     | `tenantId`（本轮补） | ✓   | 同 tx |
| inspection patch        | `/api/v1/inspection_records` | Bearer     | 同上                    | `inspections.*`        | 同上                     | `tenantId`（已含）   | ✓   | 同 tx |
| document patch          | `/api/v1/documents`          | Bearer     | 同上                    | `documents.*`          | 同上                     | `tenantId`（已补）   | ✓   | 同 tx |
| equipment/ppe/train 写  | `/api/v1/{entity}`           | Bearer     | 同上                    | `*.read.all` 门        | 同上                     | `tenantId`（已补）   | ✓   | 同 tx |
| builder patch           | `/api/v1/apps/.../responses` | Bearer     | 同上                    | `update.own`           | `canEditResponsePayload` | templateId           | ✓   | 同 tx |

## 5. 契约决策（待产品决策）

通用 API Credential 为租户级主体，不继承 UI site/self。拟未来 site/self 级 Credential 复用 `RoleScope` + `moduleScopeWhere`，不另建平行权限系统。本轮仅保证租户隔离，不改语义。

## 6. 测试计划（隔离 PG，方案未执行）

ephemeral `postgres:16-alpine` 独立库，永天云绑。10 场景（新鲜/0055→0056/重放/中断/RLS/审计/PPTX 端到端/跨租户 HTTP+DB/并发/备份恢复）的前置、步骤、预期、判据、清理见任务书五章；本轮未执行活库全量迁移，仅 `audit-immutability 3/3` 真 PG。
