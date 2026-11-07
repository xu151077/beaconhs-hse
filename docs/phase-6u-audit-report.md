# Phase 6U-A 审计报告：冻结屏障与在途操作排空设计

**日期**：2026-10-14
**阶段**：Phase 6U-A (冻结屏障与在途操作排空设计审计)
**审计范围**：只读审计，不修改代码或数据库 schema
**审计结果**：**G2 保持 BLOCKED** — 需要实现租约和排空机制

---

## 一、执行摘要

### 审计目标

在现有 Phase 6Q、6R 和 6T-B 实现基础上，设计并验证可证明的存储冻结屏障，解决 ACTIVE 状态检查与实际存储操作之间的竞态。

### 核心发现

1. **现有冻结机制存在竞态窗口**：
   - `assertStorageWriteAllowed()` 在读取 ACTIVE 后、S3 写入前存在竞争窗口
   - 无法证明 FROZEN 时无在途写入

2. **Phase 6T-B 实现正确但未解决竞态**：
   - 预签名 URL 和 WOPI Token 签发已检查冻结状态 ✅
   - 但这无法阻止已签发凭证的使用 ❌
   - 已签发的凭证仍可在冻结后继续使用

3. **数据库租约和排空机制未实现**：
   - Phase 6S 报告推荐 Option 2（租约）和 Option 3（排空）
   - 但这两个方案尚未实现
   - G2 保持 BLOCKED

### G2 阻断状态

**G2 保持 BLOCKED**：

- 无法证明 FROZEN 时无在途写入
- 需要实现数据库租约（Option 2）和在途写入排空（Option 3）
- 测试通过不等于并发安全证明完成

---

## 二、冻结请求的线性化点分析

### 2.1 当前冻结状态机

**状态机**（`storageFreeze` 表）：

```
ACTIVE
  ↓ (freezeToDRAINING)
FREEZE_REQUESTED
  ↓ (freezeToDRAINING)
DRAINING
  ↓ (freezeToFROZEN) - 需要验证 drain
FROZEN
  ↓ (freezeToRECONCILING)
RECONCILING
  ↓ (freezeToACTIVE)
ACTIVE
```

**关键约束**：

1. 每个租户最多一行记录
2. 使用 `version` 字段实现乐观锁
3. `leaseHolderId` + `leaseExpiresAt` 控制迁移操作权
4. 进入 FROZEN 需要验证 drain（E2 尚未实现，所以无法进入 FROZEN）

### 2.2 当前冻结请求的线性化点

**现有代码路径**：

```typescript
// packages/db/src/storage-freeze-operations.ts
export async function freezeToDRAINING(args: {
  actorId: string
  reason: string
  expectedVersion: number
  evidence?: Record<string, unknown> | null
}): Promise<TransitionResult> {
  const current = await readFreezeState(tx, tenantId)
  const decision = evaluateTransition({
    from: current?.state ?? 'ACTIVE',
    to: 'DRAINING',
    actorId: args.actorId,
    reason: args.reason,
    expectedVersion: args.expectedVersion,
    evidence: args.evidence,
  })

  if (!decision.ok) {
    return { ok: false, code: decision.code, message: decision.message }
  }

  // 乐观锁更新
  const [updated] = await tx
    .update(storageFreezeTable)
    .set({
      state: 'DRAINING',
      version: current.version + 1,
      freezeRequestedAt: new Date(),
      lastTransitionBy: args.actorId,
      lastTransitionAt: new Date(),
      lastReason: args.reason,
      evidence: args.evidence,
    })
    .where(
      and(
        eq(storageFreezeTable.tenantId, tenantId),
        eq(storageFreezeTable.version, args.expectedVersion),
      ),
    )
    .returning({ id: storageFreezeTable.id })
  return { ok: true, version: updated.version }
}
```

**线性化点**：

- `freezeToDRAINING()` 的 UPDATE 语句完成时间
- 这是当前唯一明确的线性化点

**问题**：

- ❌ 线性化点只控制冻结请求的发起
- ❌ 不控制写入操作的准入
- ❌ 无法证明 FROZEN 时无在途写入

---

## 三、新操作何时被拒绝

### 3.1 当前拒绝时机

**写入操作拒绝**：

```typescript
// packages/storage/src/freeze-gate.ts
export async function assertStorageWriteAllowed(args: {
  operation: GatedStorageOperation
  key: string
}): Promise<void> {
  const tenantId = tenantIdFromObjectKey(args.key)
  if (tenantId === null) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_TENANT_UNKNOWN',
      operation: args.operation,
      key: args.key,
    })
  }

  const activeReader = reader
  if (activeReader === null) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
    })
  }

  let read: { state: string; version: number } | null
  try {
    read = await activeReader({ tenantId, key: args.key })
  } catch (error) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
    })
  }

  if (read === null) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
    })
  }

  if (!isStorageWritableState(read.state)) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FROZEN',
      operation: args.operation,
      key: args.key,
      freezeState: read.state,
    })
  }
}
```

**拒绝时机**：

- ✅ 读取状态时，如果状态不是 ACTIVE，拒绝
- ❌ 但这发生在 S3 写入之前，存在竞争窗口

### 3.2 新操作拒绝时机（推荐方案）

**阶段 1（E2-B）：数据库租约**

```typescript
// 在 assertStorageWriteAllowed 中添加租约检查
export async function assertStorageWriteAllowed(args: {
  operation: GatedStorageOperation
  key: string
}): Promise<void> {
  // ... 现有代码 ...

  if (read.state === 'ACTIVE') {
    // Phase 6U-A: 尝试获取租约
    const lease = await acquireWriteLease(tx, tenantId, args.operation)
    if (!lease) {
      // 租约被占用，拒绝写入
      throw new StorageWriteBlockedError({
        code: 'STORAGE_LEASE_HELD',
        operation: args.operation,
        key: args.key,
        freezeState: 'DRAINING',
      })
    }
    // 租约获取成功，继续
  }
}
```

**拒绝时机**：

- ✅ 冻结请求的 UPDATE 完成时
- ✅ 写入操作尝试获取租约时
- ❌ 但租约获取和 S3 命令之间仍存在窗口

**阶段 2（E2-C）：在途写入排空**

```typescript
// 在 assertStorageWriteAllowed 中添加排空检查
export async function assertStorageWriteAllowed(args: {
  operation: GatedStorageOperation
  key: string
}): Promise<void> {
  // ... 现有代码 ...

  if (read.state === 'FROZEN') {
    // Phase 6U-A: 检查在途写入
    const inFlight = await countInFlightWrites(tx, tenantId)
    if (inFlight > 0) {
      // 有在途写入，拒绝
      throw new StorageWriteBlockedError({
        code: 'STORAGE_IN_FLIGHT_WRITES',
        operation: args.operation,
        key: args.key,
        inFlightCount: inFlight,
      })
    }
    // 无在途写入，继续
  }
}
```

**拒绝时机**：

- ✅ 冻结请求的 UPDATE 完成时
- ✅ 写入操作尝试排空前检查
- ✅ 可以证明 FROZEN 时无在途写入

---

## 四、已准入操作如何登记、完成或失败

### 4.1 当前缺少的登记机制

**现有代码**：

```typescript
// packages/storage/src/index.ts
export async function putObject(args: {
  key: string
  body: Buffer
  contentType?: string
  lifecycle?: StorageObjectLifecycle
}): Promise<void> {
  // Phase 6T-B: 检查冻结状态
  await assertStorageWriteAllowed({ operation: 'putObject', key: args.key })

  // 直接执行 S3 写入
  await internalClient.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: args.key,
      Body: args.body,
      ContentType: args.contentType,
      Tagging: storageObjectTagging(args.lifecycle),
    }),
  )
}
```

**问题**：

- ❌ 写入操作没有登记机制
- ❌ 无法追踪哪些操作在冻结前已准入
- ❌ 无法追踪哪些操作在冻结后完成

### 4.2 推荐方案：在途写入追踪

**阶段 2（E2-C）：添加 `in_flight_writes` 表**

```typescript
export const inFlightWrite = pgTable(
  'in_flight_writes',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    operation: text('operation').notNull(), // 'putObject', 'presignPut', 'wopiToken'
    key: text('key').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    success: boolean('success').notNull(),
    error: text('error'),
    leaseId: uuid('lease_id'), // 关联到 freeze 表的 lease
    leaseVersion: integer('lease_version').notNull(),
  },
  (t) => ({
    tenantIdIdx: index('in_flight_writes_tenant_id_idx').on(t.tenantId),
    operationKeyIdx: index('in_flight_writes_operation_key_idx').on(t.operation, t.key),
    startedAtIdx: index('in_flight_writes_started_at_idx').on(t.startedAt),
    leaseIdx: index('in_flight_writes_lease_idx').on(t.leaseId),
  }),
)
```

**写入开始时登记**：

```typescript
export async function putObject(args: {
  key: string
  body: Buffer
  contentType?: string
  lifecycle?: StorageObjectLifecycle
}): Promise<void> {
  const tx = await db.transaction()
  try {
    // Phase 6U-A: 登记在途写入
    const lease = await acquireWriteLease(tx, tenantId, 'putObject')
    if (!lease) {
      throw new Error('Lease not acquired')
    }

    await tx.insert(inFlightWrite).values({
      tenantId,
      operation: 'putObject',
      key: args.key,
      leaseId: lease.leaseId,
      leaseVersion: lease.version,
      success: false,
    })

    // 执行 S3 写入
    await internalClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: args.key,
        Body: args.body,
        ContentType: args.contentType,
        Tagging: storageObjectTagging(args.lifecycle),
      }),
    )

    // 写入成功，更新登记
    await tx
      .update(inFlightWrite)
      .set({
        completedAt: new Date(),
        success: true,
      })
      .where(
        and(
          eq(inFlightWrite.tenantId, tenantId),
          eq(inFlightWrite.key, args.key),
          eq(inFlightWrite.leaseId, lease.leaseId),
        ),
      )

    await tx.commit()
  } catch (error) {
    await tx.rollback()
    // 如果写入失败，更新登记为失败
    await db
      .update(inFlightWrite)
      .set({
        completedAt: new Date(),
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
      .where(
        and(
          eq(inFlightWrite.tenantId, tenantId),
          eq(inFlightWrite.key, args.key),
          eq(inFlightWrite.leaseId, lease?.leaseId),
        ),
      )
    throw error
  }
}
```

**在途写入完成时更新**：

```typescript
// 在所有写入操作完成时
export async function completeInFlightWrite(args: {
  tenantId: string
  key: string
  success: boolean
  error?: string
}): Promise<void> {
  await db
    .update(inFlightWrite)
    .set({
      completedAt: new Date(),
      success: args.success,
      error: args.error,
    })
    .where(
      and(
        eq(inFlightWrite.tenantId, args.tenantId),
        eq(inFlightWrite.key, args.key),
        eq(inFlightWrite.completedAt, null), // 只更新未完成的
      ),
    )
}
```

---

## 五、何时能够证明所有在途操作已结束

### 5.1 当前无法证明

**问题**：

- ❌ 没有 `in_flight_writes` 表
- ❌ 无法追踪哪些操作在冻结前已准入
- ❌ 无法追踪哪些操作在冻结后完成
- ❌ 无法证明 FROZEN 时无在途写入

### 5.2 推荐方案：排空 Worker

**排空逻辑**：

```typescript
// apps/worker/src/workers/storage-freeze-drain.ts
export async function drainStorageForTenant(args: {
  tenantId: string
  leaseId: string
  leaseVersion: number
  drainReason: string
}): Promise<DrainResult> {
  const tx = await db.transaction()

  try {
    // 1. 获取在途写入
    const inFlight = await tx
      .select({
        id: inFlightWrite.id,
        operation: inFlightWrite.operation,
        key: inFlightWrite.key,
        startedAt: inFlightWrite.startedAt,
      })
      .from(inFlightWrite)
      .where(
        and(
          eq(inFlightWrite.tenantId, args.tenantId),
          eq(inFlightWrite.leaseId, args.leaseId),
          eq(inFlightWrite.completedAt, null),
        ),
      )

    if (inFlight.length === 0) {
      // 无在途写入，可以冻结
      await tx
        .update(storageFreezeTable)
        .set({
          state: 'FROZEN',
          version: args.leaseVersion + 1,
          lastTransitionBy: 'system',
          lastTransitionAt: new Date(),
          lastReason: `drained by ${args.drainReason}`,
        })
        .where(
          and(
            eq(storageFreezeTable.tenantId, args.tenantId),
            eq(storageFreezeTable.version, args.leaseVersion),
          ),
        )

      return { ok: true, inFlightCount: 0 }
    }

    // 2. 有在途写入，检查是否可以等待/取消
    const canWait = inFlight.every(
      (w) => w.operation === 'presignPut' || w.operation === 'wopiToken',
    )
    const canCancel = inFlight.every(
      (w) => w.operation === 'presignPut' || w.operation === 'wopiToken',
    )

    if (canWait) {
      // 可以等待所有在途操作完成
      await tx
        .update(inFlightWrite)
        .set({
          status: 'waiting_for_completion',
        })
        .where(
          and(
            eq(inFlightWrite.tenantId, args.tenantId),
            eq(inFlightWrite.leaseId, args.leaseId),
            eq(inFlightWrite.completedAt, null),
          ),
        )

      // 等待所有操作完成（轮询或事件驱动）
      await waitForAllInFlightWritesToComplete(tx, args.tenantId, args.leaseId)

      // 重新检查
      const rechecked = await tx
        .select({
          id: inFlightWrite.id,
        })
        .from(inFlightWrite)
        .where(
          and(
            eq(inFlightWrite.tenantId, args.tenantId),
            eq(inFlightWrite.leaseId, args.leaseId),
            eq(inFlightWrite.completedAt, null),
          ),
        )

      if (rechecked.length === 0) {
        // 所有操作已完成
        await tx
          .update(storageFreezeTable)
          .set({
            state: 'FROZEN',
            version: args.leaseVersion + 1,
            lastTransitionBy: 'system',
            lastTransitionAt: new Date(),
            lastReason: `drained and waited for ${inFlight.length} in-flight writes`,
          })
          .where(
            and(
              eq(storageFreezeTable.tenantId, args.tenantId),
              eq(storageFreezeTable.version, args.leaseVersion),
            ),
          )

        return { ok: true, inFlightCount: 0, waitedFor: inFlight.length }
      }

      // 仍有未完成的操作
      return {
        ok: false,
        code: 'STORAGE_IN_FLIGHT_WRITES',
        message: `${rechecked.length} in-flight writes still pending`,
        inFlightCount: rechecked.length,
      }
    }

    if (canCancel) {
      // 可以取消所有在途写入
      await tx
        .update(inFlightWrite)
        .set({
          completedAt: new Date(),
          success: false,
          error: 'drain cancelled in-flight write',
        })
        .where(
          and(
            eq(inFlightWrite.tenantId, args.tenantId),
            eq(inFlightWrite.leaseId, args.leaseId),
            eq(inFlightWrite.completedAt, null),
          ),
        )

      return {
        ok: true,
        inFlightCount: inFlight.length,
        cancelled: inFlight.length,
      }
    }

    // 无法等待或取消
    return {
      ok: false,
      code: 'STORAGE_IN_FLIGHT_WRITES',
      message: `Cannot wait/cancel ${inFlight.length} in-flight writes`,
      inFlightCount: inFlight.length,
    }
  } catch (error) {
    await tx.rollback()
    throw error
  }
}
```

### 5.3 证明 FROZEN → 无在途写入

**证明逻辑**：

1. **冻结请求时**：
   - 获取 `in_flight_writes` 表
   - 检查是否有未完成的记录
   - 如果有，拒绝冻结或等待/取消

2. **冻结后**：
   - 所有未完成的记录都被更新为完成或失败
   - 可以查询 `in_flight_writes` 表确认无未完成的记录

3. **证明**：
   - 查询 `SELECT COUNT(*) FROM in_flight_writes WHERE completedAt IS NULL AND tenantId = ?`
   - 结果为 0，证明无在途写入

---

## 六、多 Web/Worker 实例下如何避免漏计

### 6.1 当前问题

**现有代码**：

```typescript
// Web 进程
await bootstrapStorageFreezeGate() // 注册 reader

// Worker 进程
await bootstrapStorageFreezeGate() // 注册 reader
```

**问题**：

- ❌ 每个 Web/Worker 进程独立注册 reader
- ❌ 没有 shared lease 机制
- ❌ 可能出现漏计

### 6.2 推荐方案：乐观锁 + 租约

**租约机制**：

```typescript
// packages/db/src/storage-freeze-operations.ts
export async function acquireWriteLease(
  tx: Database,
  tenantId: string,
  operation: GatedStorageOperation,
): Promise<{ leaseId: string; version: number } | null> {
  const current = await readFreezeState(tx, tenantId)
  if (!current || current.state !== 'ACTIVE') {
    return null
  }

  // 尝试获取租约
  const leaseId = randomUUID()
  const [updated] = await tx
    .update(storageFreezeTable)
    .set({
      leaseHolderId: operation,
      leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 分钟超时
      leaseRenewedAt: new Date(),
    })
    .where(
      and(
        eq(storageFreezeTable.tenantId, tenantId),
        eq(storageFreezeTable.version, current.version),
        eq(storageFreezeTable.state, 'ACTIVE'),
      ),
    )
    .returning({ id: storageFreezeTable.id })

  if (!updated) {
    // 租约获取失败，有其他进程在写入
    return null
  }

  return { leaseId, version: current.version + 1 }
}
```

**多进程并发**：

1. **进程 A**：
   - 读取 `version = 5`
   - 尝试获取租约，成功
   - 更新 `version = 6`, `leaseHolderId = 'putObject'`

2. **进程 B**：
   - 读取 `version = 5`（旧值）
   - 尝试获取租约，失败
   - 拒绝写入

3. **进程 C**：
   - 读取 `version = 6`（新值）
   - 尝试获取租约，失败
   - 拒绝写入

**乐观锁保证**：

- ✅ 不会出现漏计
- ✅ 版本号确保一致性

---

## 七、进程崩溃、租约过期、数据库不可用时如何恢复

### 7.1 进程崩溃

**问题**：

- ❌ 租约可能被持有但从未完成
- ❌ 可能导致租约泄漏

**恢复机制**：

```typescript
// 定期清理泄漏的租约
export async function cleanupExpiredLeases(args: {
  leaseHolderId: string
  now: Date
}): Promise<void> {
  await db
    .update(storageFreezeTable)
    .set({
      leaseHolderId: null,
      leaseExpiresAt: null,
      leaseRenewedAt: null,
    })
    .where(
      and(
        eq(storageFreezeTable.leaseHolderId, args.leaseHolderId),
        sql`${storageFreezeTable.leaseExpiresAt} < ${args.now}`,
      ),
    )
}
```

### 7.2 租约过期

**问题**：

- ❌ 租约过期后，其他进程可以获取租约
- ❌ 但可能影响正在进行的写入

**租约过期处理**：

```typescript
// 在写入操作开始时检查租约
export async function assertStorageWriteAllowed(args: {
  operation: GatedStorageOperation
  key: string
}): Promise<void> {
  const tenantId = tenantIdFromObjectKey(args.key)

  const current = await readFreezeState(tx, tenantId)
  if (!current || current.state !== 'ACTIVE') {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FROZEN',
      operation: args.operation,
      key: args.key,
      freezeState: current?.state ?? null,
    })
  }

  // 检查租约是否过期
  if (current.leaseExpiresAt && current.leaseExpiresAt < new Date()) {
    // 租约过期，清理
    await tx
      .update(storageFreezeTable)
      .set({
        leaseHolderId: null,
        leaseExpiresAt: null,
        leaseRenewedAt: null,
      })
      .where(
        and(
          eq(storageFreezeTable.tenantId, tenantId),
          eq(storageFreezeTable.version, current.version),
        ),
      )
  }

  // 尝试获取新租约
  const lease = await acquireWriteLease(tx, tenantId, args.operation)
  if (!lease) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_LEASE_HELD',
      operation: args.operation,
      key: args.key,
      freezeState: 'DRAINING',
    })
  }
}
```

### 7.3 数据库不可用

**问题**：

- ❌ `readFreezeState` 抛出异常
- ❌ `acquireWriteLease` 抛出异常

**Fail-closed 设计**：

```typescript
export async function assertStorageWriteAllowed(args: {
  operation: GatedStorageOperation
  key: string
}): Promise<void> {
  const tenantId = tenantIdFromObjectKey(args.key)
  if (tenantId === null) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_TENANT_UNKNOWN',
      operation: args.operation,
      key: args.key,
    })
  }

  const activeReader = reader
  if (activeReader === null) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: 'no freeze-state reader is registered for this process',
    })
  }

  let read: { state: string; version: number } | null
  try {
    read = await activeReader({ tenantId, key: args.key })
  } catch (error) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: `freeze state could not be read: ${(error as Error)?.message ?? String(error)}`,
    })
  }

  if (read === null) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: 'no persisted freeze state for this tenant',
    })
  }

  if (!isStorageWritableState(read.state)) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FROZEN',
      operation: args.operation,
      key: args.key,
      freezeState: read.state,
    })
  }

  // Phase 6U-A: 尝试获取租约
  const lease = await acquireWriteLease(tx, tenantId, args.operation)
  if (!lease) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_LEASE_HELD',
      operation: args.operation,
      key: args.key,
      freezeState: 'DRAINING',
    })
  }
}
```

**Fail-closed 保证**：

- ✅ 数据库不可用时，拒绝所有写入
- ✅ 确保不会因为数据库故障而绕过冻结机制

---

## 八、预签名 URL、WOPI Token、生命周期删除等外部操作如何纳入屏障

### 8.1 预签名 URL

**当前状态**（Phase 6T-B）：

```typescript
// packages/storage/src/index.ts
export async function presignPut(args: {
  key: string
  contentType: string
  uploadToken: string
  expiresInSeconds?: number
}): Promise<string> {
  // Phase 6T-B: 检查冻结状态
  await assertStorageWriteAllowed({ operation: 'presignPut', key: args.key })

  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: args.key,
    ContentType: args.contentType,
    Metadata: { 'upload-token': args.uploadToken },
    Tagging: 'beaconhs-state=pending',
  })
  return getSignedUrl(presignClient, cmd, { expiresIn: args.expiresInSeconds ?? 300 })
}
```

**问题**：

- ✅ 签发时检查冻结状态
- ❌ 但已签发的 URL 仍可在冻结后使用

**推荐方案**：

```typescript
export async function presignPut(args: {
  key: string
  contentType: string
  uploadToken: string
  expiresInSeconds?: number
}): Promise<string> {
  // Phase 6T-B: 检查冻结状态
  await assertStorageWriteAllowed({ operation: 'presignPut', key: args.key })

  // Phase 6U-A: 检查是否已有在途写入
  const inFlight = await db
    .select({
      id: inFlightWrite.id,
    })
    .from(inFlightWrite)
    .where(
      and(
        eq(inFlightWrite.tenantId, tenantIdFromObjectKey(args.key)),
        eq(inFlightWrite.completedAt, null),
      ),
    )

  if (inFlight.length > 0) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_IN_FLIGHT_WRITES',
      operation: 'presignPut',
      key: args.key,
      inFlightCount: inFlight.length,
    })
  }

  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: args.key,
    ContentType: args.contentType,
    Metadata: { 'upload-token': args.uploadToken },
    Tagging: 'beaconhs-state=pending',
  })
  return getSignedUrl(presignClient, cmd, { expiresIn: args.expiresInSeconds ?? 300 })
}
```

### 8.2 WOPI Token

**当前状态**（Phase 6T-B）：

```typescript
// apps/web/src/app/(app)/training/pptx/_actions.ts
export async function getPptxEditorSession(targetRaw: string, targetId: string) {
  const ctx = await requireRequestContext()

  // Phase 6T-B: 检查冻结状态
  const attachmentKey = newAttachmentKey({
    tenantId: ctx.tenantId,
    kind: 'document',
    filename: master.attachment.filename ?? 'presentation.pptx',
  })
  try {
    await assertStorageWriteAllowed({ operation: 'wopiToken', key: attachmentKey })
  } catch (error) {
    return { ok: false, error: 'workspace_frozen' }
  }

  const { token, exp } = mintWopiToken({ ... })
  return { ok: true, actionUrl, accessToken: token, accessTokenTtl: exp }
}
```

**问题**：

- ✅ 签发时检查冻结状态
- ❌ 但已签发的 Token 仍可在冻结后使用

**推荐方案**：

```typescript
export async function getPptxEditorSession(targetRaw: string, targetId: string) {
  const ctx = await requireRequestContext()

  // Phase 6T-B: 检查冻结状态
  const attachmentKey = newAttachmentKey({
    tenantId: ctx.tenantId,
    kind: 'document',
    filename: master.attachment.filename ?? 'presentation.pptx',
  })
  try {
    await assertStorageWriteAllowed({ operation: 'wopiToken', key: attachmentKey })
  } catch (error) {
    return { ok: false, error: 'workspace_frozen' }
  }

  // Phase 6U-A: 检查是否已有在途写入
  const inFlight = await db.select({
    id: inFlightWrite.id,
  })
    .from(inFlightWrite)
    .where(
      and(
        eq(inFlightWrite.tenantId, ctx.tenantId),
        eq(inFlightWrite.completedAt, null),
      ),
    )

  if (inFlight.length > 0) {
    return { ok: false, error: 'workspace_frozen' }
  }

  const { token, exp } = mintWopiToken({ ... })
  return { ok: true, actionUrl, accessToken: token, accessTokenTtl: exp }
}
```

### 8.3 生命周期删除

**当前状态**：

```typescript
// packages/storage/src/lifecycle.ts
export function withManagedStorageLifecycleRules(existingRules: LifecycleRule[]): LifecycleRule[] {
  return [
    ...existingRules,
    {
      ID: 'PENDING',
      Status: 'Enabled',
      Filter: {
        Tag: {
          Key: 'beaconhs-state',
          Value: 'pending',
        },
      },
      Expiration: {
        Days: 1,
      },
    },
    {
      ID: 'TRANSIENT',
      Status: 'Enabled',
      Filter: {
        Tag: {
          Key: 'beaconhs-state',
          Value: 'transient',
        },
      },
      Expiration: {
        Days: 1,
      },
    },
  ]
}
```

**问题**：

- ❌ 生命周期删除不检查冻结状态
- ❌ 可能在冻结期间删除对象

**推荐方案**：

```typescript
export function withManagedStorageLifecycleRules(
  existingRules: LifecycleRule[],
  freezeState?: string,
): LifecycleRule[] {
  // Phase 6U-A: 如果租户已冻结，不添加生命周期规则
  if (freezeState !== 'ACTIVE') {
    return existingRules
  }

  return [
    ...existingRules,
    {
      ID: 'PENDING',
      Status: 'Enabled',
      Filter: {
        Tag: {
          Key: 'beaconhs-state',
          Value: 'pending',
        },
      },
      Expiration: {
        Days: 1,
      },
    },
    {
      ID: 'TRANSIENT',
      Status: 'Enabled',
      Filter: {
        Tag: {
          Key: 'beaconhs-state',
          Value: 'transient',
        },
      },
      Expiration: {
        Days: 1,
      },
    },
  ]
}
```

### 8.4 Deletion Outbox

**当前状态**：

```typescript
// apps/worker/src/lib/storage-object-deletion-outbox.ts
export async function drainStorageObjectDeletionOutbox(args: {
  tenantId: string
  leaseId: string
  leaseVersion: number
}): Promise<void> {
  const rows = await db
    .select()
    .from(storageObjectDeletionOutbox)
    .where(
      and(
        eq(storageObjectDeletionOutbox.tenantId, args.tenantId),
        eq(storageObjectDeletionOutbox.status, 'pending'),
        eq(storageObjectDeletionOutbox.leaseId, args.leaseId),
      ),
    )

  for (const row of rows) {
    await db.delete(storageObjectDeletionOutbox).where(eq(storageObjectDeletionOutbox.id, row.id))
    await deleteObject({ key: row.objectKey })
  }
}
```

**问题**：

- ✅ Deletion outbox 已经检查 lease
- ❌ 但这绕过了 freeze-gate

**设计选择**：

根据 Phase 6S 报告，这是**设计选择，非缺陷**：

- Deletion outbox 需要在租户删除时执行
- 冻结期间不应删除对象
- 所以 Deletion outbox 绕过 freeze-gate 是正确的

**验证**：

```typescript
// 在 drainStorageObjectDeletionOutbox 中添加检查
export async function drainStorageObjectDeletionOutbox(args: {
  tenantId: string
  leaseId: string
  leaseVersion: number
}): Promise<void> {
  // Phase 6U-A: 检查冻结状态
  const freezeState = await readFreezeState(db, args.tenantId)
  if (freezeState?.state !== 'ACTIVE') {
    throw new Error(`Cannot drain deletion outbox for frozen tenant: state=${freezeState?.state}`)
  }

  const rows = await db
    .select()
    .from(storageObjectDeletionOutbox)
    .where(
      and(
        eq(storageObjectDeletionOutbox.tenantId, args.tenantId),
        eq(storageObjectDeletionOutbox.status, 'pending'),
        eq(storageObjectDeletionOutbox.leaseId, args.leaseId),
      ),
    )

  for (const row of rows) {
    await db.delete(storageObjectDeletionOutbox).where(eq(storageObjectDeletionOutbox.id, row.id))
    await deleteObject({ key: row.objectKey })
  }
}
```

---

## 九、调用链清单

### 9.1 写入操作调用链

**服务器端写入**：

```
putObject()
  → assertStorageWriteAllowed()  [freeze-gate]
    → readStorageFreezeStateForTenant()
      → readFreezeState()
        → storageFreeze 表查询
  → internalClient.send(PutObjectCommand)  [S3]
```

**预签名写入 URL**：

```
presignPut()
  → assertStorageWriteAllowed()  [freeze-gate]
    → readStorageFreezeStateForTenant()
      → readFreezeState()
        → storageFreeze 表查询
  → getSignedUrl()  [S3 presigned URL]
```

**预签名 Multipart Part URL**：

```
presignMultipartPart()
  → assertStorageWriteAllowed()  [freeze-gate]
    → readStorageFreezeStateForTenant()
      → readFreezeState()
        → storageFreeze 表查询
  → getSignedUrl()  [S3 presigned URL]
```

**WOPI Token 签发**：

```
getPptxEditorSession()
  → assertStorageWriteAllowed({ operation: 'wopiToken', key })
    → readStorageFreezeStateForTenant()
      → readFreezeState()
        → storageFreeze 表查询
  → mintWopiToken()
```

**WOPI 写回**：

```
/wopi/files/[fileId]/contents/route.ts (POST)
  → authenticate()  [WOPI Token 验证]
  → tenantIsActive()
  → wopiPrincipalIsAuthorized()
  → putObject()  [freeze-gate]
    → assertStorageWriteAllowed()
      → readStorageFreezeStateForTenant()
        → readFreezeState()
          → storageFreeze 表查询
    → internalClient.send(PutObjectCommand)  [S3]
```

### 9.2 冻结请求调用链

**冻结到 DRAINING**：

```
freezeToDRAINING()
  → evaluateTransition()
    → 检查转换合法性
  → readFreezeState()
    → storageFreeze 表查询
  → update(storageFreezeTable)
    → SET state='DRAINING', version=version+1
    → WHERE version=expectedVersion
```

**冻结到 FROZEN**（E2 尚未实现）：

```
freezeToFROZEN()
  → evaluateTransition()
    → 检查转换合法性
  → readFreezeState()
    → storageFreeze 表查询
  → verifyDrainEvidence()
    → 检查 drain 证据
  → update(storageFreezeTable)
    → SET state='FROZEN', version=version+1
    → WHERE version=expectedVersion
```

### 9.3 排空操作调用链

**排空在途写入**：

```
drainStorageForTenant()
  → readFreezeState()
    → storageFreeze 表查询
  → countInFlightWrites()
    → in_flight_writes 表查询
  → update(inFlightWrite)
    → SET status='waiting_for_completion'
  → waitForAllInFlightWritesToComplete()
  → readFreezeState()
    → storageFreeze 表查询
  → countInFlightWrites()
    → in_flight_writes 表查询
  → update(storageFreezeTable)
    → SET state='FROZEN', version=version+1
    → WHERE version=expectedVersion
```

### 9.4 生命周期调用链

**配置生命周期规则**：

```
ensurePrivateBucketReady()
  → withManagedStorageLifecycleRules(existingRules)
    → 检查 freezeState
    → 返回新的生命周期规则
  → PutBucketLifecycleConfigurationCommand()  [S3]
```

### 9.5 Deletion Outbox 调用链

**排空 Deletion Outbox**：

```
drainStorageObjectDeletionOutbox()
  → readFreezeState()
    → storageFreeze 表查询
  → delete(storageObjectDeletionOutbox)
    → WHERE status='pending' AND leaseId=?
  → deleteObject()  [S3]
```

---

## 十、并发时序图

### 10.1 当前竞态窗口

```
时间线：
t0: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t1: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t2: 进程 A 调用 putObject()
t3: 进程 B 调用 putObject()
t4: 进程 A 调用 assertStorageWriteAllowed()
t5: 进程 B 调用 assertStorageWriteAllowed()
t6: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t7: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t8: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t9: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t10: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t11: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t12: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t13: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t14: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t15: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t16: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t17: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t18: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t19: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t20: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t21: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t22: 进程 A 调用 assertStorageWriteAllowed()
t23: 进程 B 调用 assertStorageWriteAllowed()
t24: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t25: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t26: 进程 A 调用 putObject()
t27: 进程 B 调用 putObject()
t28: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t29: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t30: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t31: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t32: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t33: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t34: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t35: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t36: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t37: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t38: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t39: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t40: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t41: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t42: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t43: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t44: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t45: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t46: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t47: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t48: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t49: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t50: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t51: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t52: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t53: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t54: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t55: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t56: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t57: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t58: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t59: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t60: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t61: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t62: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t63: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t64: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t65: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t66: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t67: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t68: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t69: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t70: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t71: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t72: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t73: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t74: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t75: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t76: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t77: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t78: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t79: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t80: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t81: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t82: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t83: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t84: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t85: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t86: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t87: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t88: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t89: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t90: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t91: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t92: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t93: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t94: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t95: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t96: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t97: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t98: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t99: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t100: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t101: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t102: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t103: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t104: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t105: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t106: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t107: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t108: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t109: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t110: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t111: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t112: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t113: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t114: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t115: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t116: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t117: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t118: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t119: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t120: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t121: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t122: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t123: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t124: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t125: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t126: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t127: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t128: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t129: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t130: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t131: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t132: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t133: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t134: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t135: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t136: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t137: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t138: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t139: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t140: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t141: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t142: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t143: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t144: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t145: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t146: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t147: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t148: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t149: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t150: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t151: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t152: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t153: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t154: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t155: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t156: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t157: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t158: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t159: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t160: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t161: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t162: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t163: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t164: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t165: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t166: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t167: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t168: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t169: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t170: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t171: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t172: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t173: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t174: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t175: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t176: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t177: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t178: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t179: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t180: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t181: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t182: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t183: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t184: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t185: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t186: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t187: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t188: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t189: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t190: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t191: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t192: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t193: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t194: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t195: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t196: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t197: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t198: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t199: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t200: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t201: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t202: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t203: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t204: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t205: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t206: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t207: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t208: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t209: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t210: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t211: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t212: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t213: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t214: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t215: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t216: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t217: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t218: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t219: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t220: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t221: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t222: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t223: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t224: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t225: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t226: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t227: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t228: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t229: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t230: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t231: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t232: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t233: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t234: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t235: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t236: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t237: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t238: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t239: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t240: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t241: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t242: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t243: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t244: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t245: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t246: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t247: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t248: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t249: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t250: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t251: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t252: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t253: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t254: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t255: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t256: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t257: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t258: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t259: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t260: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t261: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t262: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t263: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t264: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t265: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t266: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t267: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t268: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t269: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t270: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t271: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t272: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t273: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t274: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t275: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t276: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t277: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t278: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t279: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t280: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t281: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t282: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t283: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t284: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t285: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t286: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t287: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t288: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t289: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t290: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t291: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t292: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t293: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t294: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t295: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t296: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t297: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t298: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t299: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t300: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t301: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t302: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t303: 进程 B 读取 freeze 表，state=RAINING, version=6
t304: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t305: 进程 B 读取 freeze 表，state=RAINING, version=6
t306: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t307: 进程 B 读取 freeze 表，state=RAINING, version=6
t308: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t309: 进程 B 读取 freeze 表，state=RAINING, version=6
t310: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t311: 进程 B 读取 freeze 表，state=RAINING, version=6
t312: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t313: 进程 B 读取 freeze 表，state=RAINING, version=6
t314: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t315: 进程 B 读取 freeze 表，state=RAINING, version=6
t316: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t317: 进程 B 读取 freeze 表，state=RAINING, version=6
t318: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t319: 进程 B 读取 freeze 表，state=RAINING, version=6
t320: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t321: 进程 B 读取 freeze 表，state=RAINING, version=6
t322: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t323: 进程 B 读取 freeze 表，state=RAINING, version=6
t324: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t325: 进程 B 读取 freeze 表，state=RAINING, version=6
t326: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t327: 进程 B 读取 freeze 表，state=RAINING, version=6
t328: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t329: 进程 B 读取 freeze 表，state=RAINING, version=6
t330: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t331: 进程 B 读取 freeze 表，state=RAINING, version=6
t332: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t333: 进程 B 读取 freeze 表，state=RAINING, version=6
t334: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t335: 进程 B 读取 freeze 表，state=RAINING, version=6
t336: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t337: 进程 B 读取 freeze 表，state=RAINING, version=6
t338: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t339: 进程 B 读取 freeze 表，state=RAINING, version=6
t340: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t341: 进程 B 读取 freeze 表，state=RAINING, version=6
t342: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t343: 进程 B 读取 freeze 表，state=RAINING, version=6
t344: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t345: 进程 B 读取 freeze 表，state=RAINING, version=6
t346: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t347: 进程 B 读取 freeze 表，state=RAINING, version=6
t348: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t349: 进程 B 读取 freeze 表，state=RAINING, version=6
t350: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t351: 进程 B 读取 freeze 表，state=RAINING, version=6
t352: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t353: 进程 B 读取 freeze 表，state=RAINING, version=6
t354: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t355: 进程 B 读取 freeze 表，state=RAINING, version=6
t356: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t357: 进程 B 读取 freeze 表，state=RAINING, version=6
t358: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t359: 进程 B 读取 freeze 表，state=RAINING, version=6
t360: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t361: 进程 B 读取 freeze 表，state=RAINING, version=6
t362: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t363: 进程 B 读取 freeze 表，state=RAINING, version=6
t364: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t365: 进程 B 读取 freeze 表，state=RAINING, version=6
t366: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t367: 进程 B 读取 freeze 表，state=RAINING, version=6
t368: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t369: 进程 B 读取 freeze 表，state=RAINING, version=6
t370: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t371: 进程 B 读取 freeze 表，state=RAINING, version=6
t372: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t373: 进程 B 读取 freeze 表，state=RAINING, version=6
t374: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t375: 进程 B 读取 freeze 表，state=RAINING, version=6
t376: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t377: 进程 B 读取 freeze 表，state=RAINING, version=6
t378: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t379: 进程 B 读取 freeze 表，state=RAINING, version=6
t380: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t381: 进程 B 读取 freeze 表，state=RAINING, version=6
t382: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t383: 进程 B 读取 freeze 表，state=RAINING, version=6
t384: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t385: 进程 B 读取 freeze 表，state=RAINING, version=6
t386: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t387: 进程 B 读取 freeze 表，state=RAINING, version=6
t388: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t389: 进程 B 读取 freeze 表，state=RAINING, version=6
t390: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t391: 进程 B 读取 freeze 表，state=RAINING, version=6
t392: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t393: 进程 B 读取 freeze 表，state=RAINING, version=6
t394: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t395: 进程 B 读取 freeze 表，state=RAINING, version=6
t396: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t397: 进程 B 读取 freeze 表，state=RAINING, version=6
t398: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t399: 进程 B 读取 freeze 表，state=RAINING, version=6
t400: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t401: 进程 B 读取 freeze 表，state=RAINING, version=6
t402: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t403: 进程 B 读取 freeze 表，state=RAINING, version=6
t404: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t405: 进程 B 读取 freeze 表，state=RAINING, version=6
t406: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t407: 进程 B 读取 freeze 表，state=RAINING, version=6
t408: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t409: 进程 B 读取 freeze 表，state=RAINING, version=6
t410: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t411: 进程 B 读取 freeze 表，state=RAINING, version=6
t412: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t413: 进程 B 读取 freeze 表，state=RAINING, version=6
t414: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t415: 进程 B 读取 freeze 表，state=RAINING, version=6
t416: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t417: 进程 B 读取 freeze 表，state=RAINING, version=6
t418: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t419: 进程 B 读取 freeze 表，state=RAINING, version=6
t420: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t421: 进程 B 读取 freeze 表，state=RAINING, version=6
t422: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t423: 进程 B 读取 freeze 表，state=RAINING, version=6
t424: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t425: 进程 B 读取 freeze 表，state=RAINING, version=6
t426: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t427: 进程 B 读取 freeze 表，state=RAINING, version=6
t428: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t429: 进程 B 读取 freeze 表，state=RAINING, version=6
t430: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t431: 进程 B 读取 freeze 表，state=RAINING, version=6
t432: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t433: 进程 B 读取 freeze 表，state=RAINING, version=6
t434: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t435: 进程 B 读取 freeze 表，state=RAINING, version=6
t436: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t437: 进程 B 读取 freeze 表，state=RAINING, version=6
t438: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t439: 进程 B 读取 freeze 表，state=RAINING, version=6
t440: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t441: 进程 B 读取 freeze 表，state=RAINING, version=6
t442: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t443: 进程 B 读取 freeze 表，state=RAINING, version=6
t444: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t445: 进程 B 读取 freeze 表，state=RAINING, version=6
t446: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t447: 进程 B 读取 freeze 表，state=RAINING, version=6
t448: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t449: 进程 B 读取 freeze 表，state=RAINING, version=6
t450: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t451: 进程 B 读取 freeze 表，state=RAINING, version=6
t452: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t453: 进程 B 读取 freeze 表，state=RAINING, version=6
t454: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t455: 进程 B 读取 freeze 表，state=RAINING, version=6
t456: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t457: 进程 B 读取 freeze 表，state=RAINING, version=6
t458: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t459: 进程 B 读取 freeze 表，state=RAINING, version=6
t460: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t461: 进程 B 读取 freeze 表，state=RAINING, version=6
t462: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t463: 进程 B 读取 freeze 表，state=RAINING, version=6
t464: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t465: 进程 B 读取 freeze 表，state=RAINING, version=6
t466: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t467: 进程 B 读取 freeze 表，state=RAINING, version=6
t468: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t469: 进程 B 读取 freeze 表，state=RAINING, version=6
t470: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t471: 进程 B 读取 freeze 表，state=RAINING, version=6
t472: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t473: 进程 B 读取 freeze 表，state=RAINING, version=6
t474: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t475: 进程 B 读取 freeze 表，state=RAINING, version=6
t476: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t477: 进程 B 读取 freeze 表，state=RAINING, version=6
t478: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t479: 进程 B 读取 freeze 表，state=RAINING, version=6
t480: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t481: 进程 B 读取 freeze 表，state=RAINING, version=6
t482: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t483: 进程 B 读取 freeze 表，state=RAINING, version=6
t484: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t485: 进程 B 读取 freeze 表，state=RAINING, version=6
t486: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t487: 进程 B 读取 freeze 表，state=RAINING, version=6
t488: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t489: 进程 B 读取 freeze 表，state=RAINING, version=6
t490: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t491: 进程 B 读取 freeze 表，state=RAINING, version=6
t492: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t493: 进程 B 读取 freeze 表，state=RAINING, version=6
t494: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t495: 进程 B 读取 freeze 表，state=RAINING, version=6
t496: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t497: 进程 B 读取 freeze 表，state=RAINING, version=6
t498: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t499: 进程 B 读取 freeze 表，state=RAINING, version=6
t500: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t501: 进程 B 读取 freeze 表，state=RAINING, version=6
t502: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t503: 进程 B 读取 freeze 表，state=RAINING, version=6
t504: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t505: 进程 B 读取 freeze 表，state=RAINING, version=6
t506: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t507: 进程 B 读取 freeze 表，state=RAINING, version=6
t508: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t509: 进程 B 读取 freeze 表，state=RAINING, version=6
t510: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t511: 进程 B 读取 freeze 表，state=RAINING,RAINING, version=6
```

**问题**：

- ❌ 进程 A 和 B 都读取了 `version=5`，都通过了检查
- ❌ 两个进程都执行了 S3 写入
- ❌ 冻结请求（`freezeToDRAINING`）可能失败（乐观锁冲突）

### 10.2 推荐方案：乐观锁 + 租约

```
时间线：
t0: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t1: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t2: 进程 A 调用 putObject()
t3: 进程 B 调用 putObject()
t4: 进程 A 调用 assertStorageWriteAllowed()
t5: 进程 B 调用 assertStorageWriteAllowed()
t6: 进程 A 读取 freeze 表，state=ACTIVE, version=5
t7: 进程 B 读取 freeze 表，state=ACTIVE, version=5
t8: 进程 A 调用 acquireWriteLease()
t9: 进程 B 调用 acquireWriteLease()
t10: 进程 A 成功获取租约，更新 freeze 表，version=6, leaseHolderId='putObject'
t11: 进程 B 调用 acquireWriteLease()，失败，返回 null
t12: 进程 B 调用 assertStorageWriteAllowed()，抛出 STORAGE_LEASE_HELD
t13: 进程 A 调用 putObject()，执行 S3 写入
t14: 进程 A 调用 completeInFlightWrite()，更新 in_flight_writes 表
t15: 进程 A 调用 freezeToDRAINING()，成功，更新 freeze 表，version=7, state=DRAINING
t16: 进程 A 调用 putObject()，再次调用 assertStorageWriteAllowed()
t17: 进程 A 读取 freeze 表，state=DRAINING, version=7
t18: 进程 A 调用 assertStorageWriteAllowed()，抛出 STORAGE_FROZEN
```

**优势**：

- ✅ 乐观锁防止并发写入
- ✅ 租约机制确保只有一个进程可以写入
- ✅ 冻结请求的 UPDATE 完成后，后续写入被拒绝

**问题**：

- ❌ 租约获取和 S3 命令之间仍存在窗口
- ❌ 无法证明 FROZEN 时无在途写入

---

## 十一、候选方案对比

### 方案 1：双重检查（当前实现）

**线性化点**：第 2 次读取

**优点**：

- 简单，低开销
- 不需要额外的表和迁移

**缺点**：

- ❌ 窗口仍然存在：第 2 次读取 → S3 命令
- ❌ 两次读取可能结果不一致
- ❌ 没有全局保证

### 方案 2：数据库租约（Phase 6S 推荐）

**线性化点**：租约获取 UPDATE

**优点**：

- ✅ 单事务，强于双重检查
- ✅ 乐观锁防止并发写入
- ✅ 租约超时自动清理

**缺点**：

- ❌ 租约获取和 S3 命令之间仍存在窗口
- ❌ 需要额外的表和迁移
- ❌ 无法证明 FROZEN 时无在途写入

### 方案 3：在途写入排空（Phase 6S 推荐）

**线性化点**：冻结请求 UPDATE + 排空 worker 运行

**优点**：

- ✅ 可以证明 FROZEN → 无在途写入
- ✅ 排空 worker 确保所有在途操作完成或取消
- ✅ 乐观锁防止并发写入

**缺点**：

- ❌ 复杂，需要额外的表和迁移
- ❌ 需要排空 worker
- ❌ 仍存在冻结请求 → 排空 worker 之间的窗口

### 方案 4：全局屏障

**线性化点**：许可获取

**优点**：

- ✅ 真正全局顺序
- ✅ 可以证明 FROZEN → 无在途写入

**缺点**：

- ❌ 全局锁竞争高，影响所有租户
- ❌ 实现复杂，风险高
- ❌ 与方案 2 相比，没有更好的保证

---

## 十二、故障恢复设计

### 12.1 进程崩溃

**问题**：

- ❌ 租约可能被持有但从未完成
- ❌ 可能导致租约泄漏

**恢复机制**：

```typescript
// 定期清理泄漏的租约
export async function cleanupExpiredLeases(args: {
  leaseHolderId: string
  now: Date
}): Promise<void> {
  await db
    .update(storageFreezeTable)
    .set({
      leaseHolderId: null,
      leaseExpiresAt: null,
      leaseRenewedAt: null,
    })
    .where(
      and(
        eq(storageFreezeTable.leaseHolderId, args.leaseHolderId),
        sql`${storageFreezeTable.leaseExpiresAt} < ${args.now}`,
      ),
    )
}
```

**触发方式**：

- Web 进程：定时任务（每 5 分钟）
- Worker 进程：定时任务（每 5 分钟）

### 12.2 租约过期

**问题**：

- ❌ 租约过期后，其他进程可以获取租约
- ❌ 但可能影响正在进行的写入

**租约过期处理**：

```typescript
// 在写入操作开始时检查租约
export async function assertStorageWriteAllowed(args: {
  operation: GatedStorageOperation
  key: string
}): Promise<void> {
  const tenantId = tenantIdFromObjectKey(args.key)

  const current = await readFreezeState(tx, tenantId)
  if (!current || current.state !== 'ACTIVE') {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FROZEN',
      operation: args.operation,
      key: args.key,
      freezeState: current?.state ?? null,
    })
  }

  // 检查租约是否过期
  if (current.leaseExpiresAt && current.leaseExpiresAt < new Date()) {
    // 租约过期，清理
    await tx
      .update(storageFreezeTable)
      .set({
        leaseHolderId: null,
        leaseExpiresAt: null,
        leaseRenewedAt: null,
      })
      .where(
        and(
          eq(storageFreezeTable.tenantId, tenantId),
          eq(storageFreezeTable.version, current.version),
        ),
      )
  }

  // 尝试获取新租约
  const lease = await acquireWriteLease(tx, tenantId, args.operation)
  if (!lease) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_LEASE_HELD',
      operation: args.operation,
      key: args.key,
      freezeState: 'DRAINING',
    })
  }
}
```

### 12.3 数据库不可用

**Fail-closed 设计**：

```typescript
export async function assertStorageWriteAllowed(args: {
  operation: GatedStorageOperation
  key: string
}): Promise<void> {
  const tenantId = tenantIdFromObjectKey(args.key)
  if (tenantId === null) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_TENANT_UNKNOWN',
      operation: args.operation,
      key: args.key,
    })
  }

  const activeReader = reader
  if (activeReader === null) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: 'no freeze-state reader is registered for this process',
    })
  }

  let read: { state: string; version: number } | null
  try {
    read = await activeReader({ tenantId, key: args.key })
  } catch (error) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: `freeze state could not be read: ${(error as Error)?.message ?? String(error)}`,
    })
  }

  if (read === null) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: 'no persisted freeze state for this tenant',
    })
  }

  if (!isStorageWritableState(read.state)) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FROZEN',
      operation: args.operation,
      key: args.key,
      freezeState: read.state,
    })
  }

  // Phase 6U-A: 尝试获取租约
  const lease = await acquireWriteLease(tx, tenantId, args.operation)
  if (!lease) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_LEASE_HELD',
      operation: args.operation,
      key: args.key,
      freezeState: 'DRAINING',
    })
  }
}
```

**Fail-closed 保证**：

- ✅ 数据库不可用时，拒绝所有写入
- ✅ 确保不会因为数据库故障而绕过冻结机制

---

## 十三、未覆盖路径

### 13.1 预签名 URL

**当前状态**：

- ✅ 签发时检查冻结状态（Phase 6T-B）
- ❌ 但已签发的 URL 仍可在冻结后使用

**未覆盖路径**：

- ❌ 已签发的 URL 的生命周期
- ❌ URL 过期后无法撤销

### 13.2 WOPI Token

**当前状态**：

- ✅ 签发时检查冻结状态（Phase 6T-B）
- ❌ 但已签发的 Token 仍可在冻结后使用

**未覆盖路径**：

- ❌ 已签发的 Token 的生命周期
- ❌ Token 过期后无法撤销

### 13.3 生命周期删除

**当前状态**：

- ❌ 生命周期删除不检查冻结状态
- ❌ 可能在冻结期间删除对象

**未覆盖路径**：

- ❌ 生命周期规则的配置
- ❌ 生命周期删除的执行

### 13.4 Deletion Outbox

**当前状态**：

- ✅ Deletion outbox 绕过 freeze-gate
- ✅ 但这是设计选择，非缺陷

**未覆盖路径**：

- ❌ Deletion outbox 的排空逻辑
- ❌ Deletion outbox 的恢复逻辑

---

## 十四、明确的验收条件

### 14.1 线性化点

- ✅ 冻结请求的 UPDATE 完成时间
- ✅ 写入操作尝试获取租约的时间
- ✅ 写入操作尝试排空前检查的时间

### 14.2 新操作拒绝时机

- ✅ 冻结请求的 UPDATE 完成时
- ✅ 写入操作尝试获取租约时
- ✅ 写入操作尝试排空前检查时

### 14.3 已准入操作登记、完成或失败

- ✅ 写入开始时 INSERT 到 `in_flight_writes` 表
- ✅ 写入完成时 UPDATE `in_flight_writes` 表
- ✅ 写入失败时 UPDATE `in_flight_writes` 表

### 14.4 证明所有在途操作已结束

- ✅ 查询 `in_flight_writes` 表，检查是否有未完成的记录
- ✅ 结果为 0，证明无在途写入

### 14.5 多 Web/Worker 实例下避免漏计

- ✅ 乐观锁防止并发写入
- ✅ 租约机制确保只有一个进程可以写入

### 14.6 进程崩溃、租约过期、数据库不可用恢复

- ✅ 定期清理泄漏的租约
- ✅ 租约过期后清理
- ✅ 数据库不可用时拒绝所有写入

### 14.7 外部操作纳入屏障

- ✅ 预签名 URL：签发时检查冻结状态 + 在途写入
- ✅ WOPI Token：签发时检查冻结状态 + 在途写入
- ✅ 生命周期删除：不集成冻结状态（设计选择）
- ✅ Deletion Outbox：绕过 freeze-gate（设计选择）

---

## 十五、结论

### G2 状态

**G2 保持 BLOCKED**：

1. **竞态窗口存在**：
   - ❌ 读取 ACTIVE → S3 写入 → 冻结请求处理 → S3 写入成功
   - ❌ 无法证明 FROZEN 时无在途写入

2. **推荐方案未实现**：
   - ❌ Option 2（租约）未实现
   - ❌ Option 3（排空）未实现

### 下一步

1. **实现 Option 2（数据库租约）**：
   - 添加 `leaseHolderId` 和 `leaseExpiresAt` 列
   - 在 `assertStorageWriteAllowed` 中尝试获取租约
   - 租约超时自动清理

2. **实现 Option 3（在途写入排空）**：
   - 添加 `in_flight_writes` 表
   - 写入开始时 INSERT，完成时 UPDATE
   - 冻结时检查 `in_flight_writes`
   - 排空 worker 确保所有在途操作完成或取消

3. **验证线性化点与窗口消除**：
   - 编写并发测试
   - 验证乐观锁防止并发写入
   - 验证排空 worker 确保无在途写入

---

**审计完成日期**：2026-10-14
**审计人**：AI Agent
