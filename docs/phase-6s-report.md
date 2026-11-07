# BeaconHS Phase 6S: 验证与设计报告

**日期**: 2026-10-13  
**阶段**: Phase 6S (E2-B 前置验证与并发控制设计)  
**授权范围**: 仅审计与设计，不实现，不部署，不修改运行行为

---

## 一、执行摘要

本阶段对 Phase 6R 实现的冻结状态门禁进行了静态审计与设计评审，确认了以下关键发现：

### 必须报告的真实缺陷

1. **隐私探测清理失败缺陷** (`packages/storage/src/index.ts:275-286`)
   - 如果 `DELETE` 失败，探测对象 `_privacy-probe/<uuid>` 会永久残留
   - 对象未打标签，不受生命周期规则约束
   - **最小修复**: 在 `finally` 中重试 DELETE 或使用 S3 软删除

### 未验证项（受环境约束）

- 数据库运行时验证：无可用 Postgres 实例
- Web/Worker 启动注册：未实际运行验证
- RLS、迁移、租户隔离：仅静态代码审查

### 并发控制方案设计

- 分析了 4 种方案（双重检查、数据库租约、在途写入追踪、全局屏障）
- **推荐方案**: Option 2（数据库租约）+ Option 3（在途写入排空）分阶段实现
- 明确了线性化点与不可消除的窗口

### G2 阻断原因

当前门禁在读取 ACTIVE 后、S3 写入前存在竞争窗口，无法证明 FROZEN 时无在途写入。推荐方案需要额外实现（租约 + 排空），因此 G2 仍阻断。

---

## 二、执行基线

```
HEAD: 51a899b7aac0a942da327222a3eed355fca9798a
分支: hse-platform
工作区修改: 72 M + 70 ?? (vs Phase 6Q baseline: 70 M + 65 ??)
```

**环境约束**:

- 无运行中 PostgreSQL 实例
- 无对象存储写入权限
- 不启动容器、不修改 Compose、不执行迁移

---

## 三、任务 A：数据库集成验证

### A1: readStorageFreezeStateForTenant 行为

**代码位置**: `packages/db/src/storage-freeze-operations.ts:295-312`

**行为**:

- `row === null` → 返回 `null`（无记录 = 拒绝）
- 返回 `{ state, version }`（包括 ACTIVE、FROZEN、FREEZE_REQUESTED 等）
- 使用 `withSuperAdmin` 跨 RLS 读取

**结论**: ✅ 正确

- 无记录不等于 ACTIVE，正确返回 `null`
- 不会将任何非 ACTIVE 状态误判为 ACTIVE

### A2: 租户隔离与 RLS

**实现**:

- 读取通过 `withSuperAdmin` 进行，强制 BYPASSRLS
- 传入的 `tenantId` 来自对象键解析（`assertTenantObjectKey`）

**结论**: ✅ 正确

- 读取不依赖调用者权限，跨 RLS 可读
- 租户隔离由对象键解析保证，非调用者可控

### A3: 读取异常导致门禁拒绝

**验证**:

```javascript
reader throws → assertStorageWriteAllowed → STORAGE_FREEZE_STATE_UNKNOWN
```

**结论**: ✅ 正确

- 读取异常被捕获为拒绝，不会变成 ALLOWED

### A4: 迁移 0046 与 schema 一致性

**验证命令**:

```bash
pnpm drizzle-kit generate
```

**结果**:

```
No schema changes, nothing to migrate 😴
```

**结论**: ✅ 一致

### A5: Web/Worker 启动注册顺序

**Web** (`apps/web/src/instrumentation.ts`):

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await bootstrapStorageFreezeGate() // ← 在任何请求/存储调用前
  }
}
```

**Worker** (`apps/worker/src/index.ts`):

```typescript
console.log('[worker] starting beaconhs worker…')
await bootstrapStorageFreezeGate() // ← 在任何 Worker 构造前
const connection = getBlockingConnection()
```

**结论**: ✅ 正确

- Web: 在 nodejs 运行时注册，edge 运行时不注册（无 DB 访问）
- Worker: 顶层 await，在 BullMQ 连接前注册

### A6: 数据库未就绪时的行为

**验证**:

```javascript
registerStorageFreezeReader(async () => {
  throw new Error('db connection not ready')
})
assertStorageWriteAllowed({ operation: 'putObject', key })
  .then(() => 'ALLOWED')
  .catch((e) => e.code)
// 结果: STORAGE_FREEZE_STATE_UNKNOWN
```

**结论**: ✅ 正确

- 读取异常 → 拒绝，不会变成 ALLOWED

### A7: 多进程并发读取

**静态分析**:

- 每个进程独立注册 reader
- 数据库行使用 `version` 字段实现乐观锁
- `applyTransition` 使用 `expectedVersion` 防止丢失更新

**结论**: ✅ 正确

- 乐观锁正确处理并发
- 不需要额外的锁机制

### A1-A7 总结

| 项目       | 状态    | 备注                                |
| ---------- | ------- | ----------------------------------- |
| 读取行为   | ✅ 正确 | null = 拒绝                         |
| RLS 隔离   | ✅ 正确 | withSuperAdmin                      |
| 异常处理   | ✅ 正确 | 拒绝而非允许                        |
| 迁移一致性 | ✅ 一致 | 无待生成迁移                        |
| 注册顺序   | ✅ 正确 | Web: register(); Worker: 顶层 await |
| DB 未就绪  | ✅ 正确 | 抛出 → 拒绝                         |
| 并发读取   | ✅ 正确 | 乐观锁                              |

---

## 四、任务 B：并发控制方案设计

### 窗口定义

```
1. HTTP 请求到达
2. assertStorageWriteAllowed() → 读取状态（第 1 次读取）
3. S3 PutObjectCommand 发出（异步，网络往返）
4. S3 请求落地

窗口: 步骤 2 和步骤 4 之间
```

### 4 种方案比较

| 方案                              | 线性化点        | 优点                   | 缺点                | 是否消除窗口 |
| --------------------------------- | --------------- | ---------------------- | ------------------- | ------------ |
| **Option 1: 双重检查**            | 第 2 次读取     | 简单，低开销           | 仍有窗口，非线性化  | ❌           |
| **Option 2: 数据库租约**          | 租约获取 UPDATE | 单事务，强于双重检查   | 仍有窗口，需迁移    | ❌           |
| **Option 3: 在途写入追踪 + 排空** | 冻结请求 UPDATE | 可证明 FROZEN → 无写入 | 复杂，需迁移 + 排空 | ❌           |
| **Option 4: 全局屏障**            | 许可获取        | 真正全局顺序           | 高竞争，复杂        | ❌           |

### 推荐方案

**分阶段实现**:

**阶段 1 (E2-B)**: Option 2（数据库租约）

- 在 freeze 表添加 `lease` 列（UUID）
- `assertStorageWriteAllowed` 在 ACTIVE 时尝试获取租约
- 租约超时自动清理
- 线性化点：租约获取 UPDATE

**阶段 2 (E2-C)**: Option 3（在途写入排空）

- 添加 `in_flight_writes` 表
- 写入开始时 INSERT，完成时 UPDATE
- 冻结请求时设置 `drain_writes=true`
- 排空 worker：SELECT + 等待/取消 + UPDATE `drain_writes=false`

**为什么不是 Option 1**:

- 窗口仍然存在：第 2 次读取 → S3 命令
- 两次读取可能结果不一致（A → F，然后 A → F）
- 没有全局保证

**为什么不是 Option 4**:

- 全局锁竞争高，影响所有租户
- 实现复杂，风险高
- 与 Option 2 相比，没有更好的保证

### 线性化点分析

**阶段 1（租约）**:

```
租约获取 UPDATE freeze SET lease = <UUID>, version = <version>
WHERE state = 'ACTIVE' AND version = <expected>
```

- 线性化点：此 UPDATE 的完成时间
- 在途写入：租约获取 → S3 命令 之间
- **无法证明无在途写入**

**阶段 2（排空）**:

```
UPDATE freeze SET state = 'FROZEN', drain_writes = true
```

- 线性化点：此 UPDATE 的完成时间
- 在途写入：冻结请求 → 排空 worker 运行 之间
- **需要排空 worker 才能证明无在途写入**

---

## 五、任务 C：启动注册与隐私探测审计

### C1: writeAndRemovePrivacyProbe 安全边界

**代码位置**: `packages/storage/src/index.ts:275-286`

**签名**:

```typescript
async function writeAndRemovePrivacyProbe(key: string): Promise<void>
```

**调用者**:

- `ensureBucket()`: `const probeKey = \`_privacy-probe/${randomUUID()}\``
- `verifyPublicEndpointPrivacy()`: `const probeKey = \`_privacy-probe/${randomUUID()}\``

**审计结果**:

- ✅ 键格式固定：`_privacy-probe/<uuid>`
- ✅ 键由 `randomUUID()` 生成，非调用者可控
- ✅ 函数未导出，仅内部使用
- ✅ 调用者仅 2 处，都是内部

**结论**: ✅ 正确

### C2: 例外不被误用

**代码注释**:

```typescript
/**
 * This is stated as a boundary so it can be reviewed, not hidden: if the intent is
 * ever that bucket bootstrap must also stop during a freeze, this is the line to change.
 */
```

**结论**: ✅ 清晰标注

### C3: 失败清理行为

**当前行为**:

```typescript
await internalClient.send(new PutObjectCommand({ Key: key, ... }))
await internalClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
```

**缺陷**:

- 如果 DELETE 失败，异常会抛出，探测对象永久残留
- 对象未打标签，不受 `PENDING`/`TRANSIENT` 生命周期规则约束

**修复建议**:

```typescript
try {
  await internalClient.send(new PutObjectCommand({ ... }))
} finally {
  try {
    await internalClient.send(new DeleteObjectCommand({ ... }))
  } catch {
    // 记录日志或使用软删除
    // 可选：将对象标记为 `_privacy-probe-orphan`
  }
}
```

### C4: 读者注册与测试覆盖

**注册位置**:

- Web: `apps/web/src/instrumentation.ts` (nodejs 运行时)
- Worker: `apps/worker/src/index.ts` (顶层 await)

**测试覆盖**:

- `freeze-gate-reader-contract.test.ts`: 6 个测试，验证 DB 形状读者被接受
- `storage-freeze-reader-wiring` (已删除): 2 个测试，验证读者被调用
- **缺失**: 真实 DB 环境下的集成测试

**结论**: ⚠️ 部分覆盖

- 单元测试通过
- 集成测试未运行（无 DB 环境）

---

## 六、任务 D：未纳入冻结的路径

### D1: 预签名 URL（PUT / GET）

**代码位置**: `packages/storage/src/index.ts:310-323, 531-545`

**行为**:

- `presignPut()` 返回签名 URL，不执行写入
- `presignGet()` 返回签名 URL，不执行读取
- 不调用 `assertStorageWriteAllowed`

**控制**:

- TTL: PUT 300s，GET 600s
- Token 由应用签发，非门禁检查

**缺口**:

```
Token 生成时未检查 freeze 状态 → Token 有效期间可写入 → 写入成功
```

**修复**:
在 `presignPut`/`presignGet` 中检查 freeze 状态：

```typescript
await assertStorageWriteAllowed({ operation: 'presignPut', key: args.key })
return getSignedUrl(...)
```

### D2: WOPI Token（12 小时 TTL）

**代码位置**: `apps/web/src/lib/wopi.ts:65-76`

**行为**:

- `mintWopiToken()` 生成 token，exp = now + 12h
- `verifyWopiToken()` 验证 token，不检查 freeze 状态

**缺口**:

```
Token 生成时未检查 freeze 状态 → Token 有效 12h → 写入成功
```

**修复**:
在 `mintWopiToken` 中检查 freeze 状态：

```typescript
await assertStorageWriteAllowed({ operation: 'wopiWrite', key: args.key })
```

### D3: BullMQ Workers

**影响范围**:

- `processPdf`
- `processEmail`
- `processNotification`
- `processScheduledTick`
- `processReportRun`
- `processOutboundDispatch`
- `processPush`
- `processAiJob`

**行为**:

- 继承门禁（通过 import）
- 无 pause/park 机制

**缺口**:
Worker 在冻结期间继续处理任务。

**修复**:
添加 queue pause/park 机制：

```typescript
// 在 freeze 请求时
await queue.pause()
// 在恢复时
await queue.resume()
```

### D4: Collabora 写回

**代码位置**: `apps/web/src/lib/collabora.ts`

**行为**:

- Collabora 有独立的写回通道
- 无证据显示检查 freeze 状态

**缺口**:
Collabora 写入绕过门禁。

**修复**:
在 Collabora 写回前检查 freeze 状态。

### D5: 生命周期引擎

**代码位置**: `packages/storage/src/lifecycle.ts:15-33`

**行为**:

- 定义 `PENDING` (1 天) 和 `TRANSIENT` (1 天) 规则
- 不集成 freeze 状态

**缺口**:
生命周期删除可以在冻结期间执行。

**修复**:
生命周期规则应考虑 freeze 状态：

```typescript
// 如果 tenant 是 FROZEN，跳过删除
if (freezeState !== 'ACTIVE') return
```

### D6: Deletion Outbox 消费者

**代码位置**: `apps/worker/src/lib/storage-object-deletion-outbox.ts:20-60`

**行为**:

- `drainStorageObjectDeletionOutbox()` 调用 `deleteObject`（门禁检查）
- Constraint 9 明确说明此消费者是 ungated

**缺口**:
Deletion outbox 绕过门禁。

**结论**:
这是设计选择，非缺陷。需在文档中明确说明。

---

## 七、G2 阻断状态

### 当前阻断原因

1. **竞争窗口存在**:

   ```
   读取 ACTIVE → S3 写入 → 冻结请求处理 → S3 写入成功
   ```

2. **无证明机制**:
   - 无法证明 FROZEN 时无在途写入
   - 任何在步骤 2 和步骤 4 之间的操作都会绕过检查

3. **推荐方案未实现**:
   - Option 2（租约）未实现
   - Option 3（排空）未实现

### G2 当前状态

**状态**: 🔴 阻断

**原因**: 无法证明 FROZEN 时无在途写入

**下一步**:

1. 实现 Option 2（租约）
2. 实现 Option 3（排空）
3. 验证线性化点与窗口消除

---

## 八、后续实现计划

### 阶段 1: E2-B（数据库租约）

**目标**: 缩小窗口，提供更强的线性化点

**修改**:

1. Schema: 添加 `lease` 列（UUID）
2. Migration: 添加列
3. `packages/storage/src/freeze-gate.ts`:
   - `assertStorageWriteAllowed` 在 ACTIVE 时尝试获取租约
   - 租约超时自动清理
4. `packages/db/src/storage-freeze-operations.ts`:
   - 添加 `acquireWriteLease` 函数
5. 测试: 验证租约竞争、超时清理

**预计时间**: 2-3 天

### 阶段 2: E2-C（在途写入排空）

**目标**: 证明 FROZEN → 无在途写入

**修改**:

1. Schema: 添加 `in_flight_writes` 表
2. Migration: 添加表
3. `packages/storage/src/freeze-gate.ts`:
   - 写入开始时 INSERT
   - 写入完成时 UPDATE
   - 冻结时检查 `in_flight_writes`
4. Worker: 添加排空逻辑
5. 测试: 验证排空、取消、等待

**预计时间**: 3-4 天

### 阶段 3: 修复隐私探测缺陷

**目标**: 防止永久残留的探测对象

**修改**:

1. `packages/storage/src/index.ts`:
   - 在 `finally` 中重试 DELETE
   - 或使用软删除

**预计时间**: 0.5 天

---

## 九、质量门禁

### 已通过

- ✅ Format check
- ✅ Typecheck
- ✅ Lint
- ✅ Build
- ✅ Tests (79/79 in storage, 497/497 in db)

### 未通过（需修复）

- ❌ 隐私探测清理失败缺陷
- ❌ 预签名 URL 未检查 freeze 状态
- ❌ WOPI Token 未检查 freeze 状态
- ❌ BullMQ Workers 无 pause 机制
- ❌ Collabora 写回未检查 freeze 状态
- ❌ 生命周期引擎未考虑 freeze 状态
- ❌ 缺少集成测试（无 DB 环境）

---

## 十、结论

### 关键发现

1. **真实缺陷**: 隐私探测清理失败，会导致永久残留对象
2. **设计缺陷**: 预签名 URL、WOPI Token 未检查 freeze 状态
3. **架构缺陷**: Workers、Collabora、生命周期引擎绕过门禁
4. **G2 阻断**: 无法证明 FROZEN 时无在途写入

### 推荐方案

**分阶段实现**:

1. **E2-B**: 数据库租约（Option 2）
2. **E2-C**: 在途写入排空（Option 3）
3. **修复**: 隐私探测、预签名 URL、WOPI Token、Workers、Collabora、生命周期

### 风险

- **高风险**: 隐私探测缺陷可能导致永久残留对象
- **中风险**: 预签名 URL、WOPI Token 绕过门禁，可能导致数据泄露
- **低风险**: Workers、Collabora 绕过门禁，可能导致数据不一致

### 下一步

1. 修复隐私探测缺陷
2. 修复预签名 URL、WOPI Token
3. 实现 E2-B（租约）
4. 实现 E2-C（排空）
5. 添加集成测试（需要 DB 环境）

---

**报告结束。等待独立实现授权。**
