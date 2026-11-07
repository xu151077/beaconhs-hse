# Phase 6U-B 实施完成报告：数据库租约与在途操作排空机制实施

**日期**：2026-10-14
**实施范围**：阶段 B1（数据库准入与租约机制设计）+ 最小实现
**实施结果**：✅ B1 已完成（设计 + 最小实现，未进行 B2 和 B3）

---

## 一、阶段 B1 实施内容

### 1.1 设计

**租约机制设计**：

- **线性化点**：租约获取 UPDATE 完成时间
- **租约类型**：optimistic concurrency (version check)
- **租约超时**：默认 2 小时，可配置
- **租约获取失败时**：拒绝写入，不重试
- **租约释放时**：即使写入失败也释放租约

**函数实现**：

1. `acquireWriteLease(db, tenantId, operation, leaseMs)`：
   - 读取当前 state 和 version
   - 检查 state 是否为 ACTIVE
   - 检查 lease 是否有效
   - 使用 version 进行乐观锁更新
   - 成功：返回 { leaseId, version }
   - 失败：返回 null

2. `releaseWriteLease(db, tenantId, leaseId, version)`：
   - 使用 version 进行乐观锁更新
   - 清除 leaseHolderId、leaseExpiresAt、leaseRenewedAt
   - 版本号不匹配时无操作（idempotent）

### 1.2 最小代码变更

**修改的文件**：

1. **`packages/db/src/storage-freeze-operations.ts`**（新增函数）：
   - `acquireWriteLease()` - 获取写入租约
   - `releaseWriteLease()` - 释放写入租约

**新增的文件**：

2. **`packages/storage/src/testing/write-lease.ts`**（测试辅助函数）：
   - `WriteLeaseManager` 接口
   - `createMockWriteLeaseManager()` - 创建 mock lease manager

3. **`packages/storage/src/freeze-gate-phase6u-b.test.ts`**（测试文件）：
   - 13 个测试用例，覆盖所有场景

**未修改的文件**：

- `packages/storage/src/freeze-gate.ts`（仅修改注释，保持 reader 单调用）

### 1.3 设计文档

**新增的文件**：

4. **`docs/phase-6u-b-schema-design.md`**（schema 设计文档）：
   - `in_flight_writes` 表设计
   - 索引和约束设计
   - 使用场景和竞态控制
   - 风险和迁移策略

---

## 二、新增测试和全部质量门结果

### 新增测试

**文件**：`packages/storage/src/freeze-gate-phase6u-b.test.ts`

**测试数量**：13 个测试用例

**覆盖场景**：

1. ✅ ACTIVE 状态允许 lease acquisition
2. ✅ FROZEN 状态拒绝 lease acquisition
3. ✅ FREEZE_REQUESTED 状态拒绝 lease acquisition
4. ✅ DRAINING 状态拒绝 lease acquisition
5. ✅ lease already held 时拒绝 acquisition
6. ✅ expired lease 后允许 takeover
7. ✅ unknown tenant 时返回 null
8. ✅ release 后 acquisition 成功
9. ✅ release is idempotent（重复 release 不报错）
10. ✅ release with wrong version 不释放 lease
11. ✅ 两个并发 acquisitions：一个成功，一个失败
12. ✅ release then acquire 允许 new lease
13. ✅ gate allows write in ACTIVE state with lease awareness

### 质量门结果

**测试结果**：

- ✅ `packages/storage/src/freeze-gate-phase6u-b.test.ts`：13/13 通过
- ✅ `packages/storage/src/freeze-gate.test.ts`：26/26 通过
- ✅ `packages/storage/src/freeze-gate-storage.test.ts`：4/4 通过
- ✅ 所有 storage 包测试：117/117 通过

**类型检查**：

- ✅ 所有包类型检查通过

**Lint 检查**：

- ✅ 所有包 lint 检查通过（只有 1 个无关的 warning）

**格式检查**：

- ✅ 所有文件格式检查通过

---

## 三、未覆盖的写入路径及未执行的验证

### 未覆盖的写入路径

1. **直接 S3 写入**：
   - ❌ `putObject()` 已通过 freeze-gate，但未集成租约
   - ❌ `deleteObject()` 已通过 freeze-gate，但未集成租约
   - ❌ `completeMultipartUpload()` 已通过 freeze-gate，但未集成租约
   - ❌ `abortMultipartUpload()` 已通过 freeze-gate，但未集成租约
   - ❌ `promoteObject()` 已通过 freeze-gate，但未集成租约

2. **预签名写入 URL**：
   - ❌ `presignPut()` 已通过 freeze-gate (Phase 6T-B)，但未集成租约
   - ❌ `presignMultipartPart()` 已通过 freeze-gate (Phase 6T-B)，但未集成租约

3. **WOPI Token 签发**：
   - ❌ `getPptxEditorSession()` 已通过 freeze-gate (Phase 6T-B)，但未集成租约
   - ❌ `getDocumentWriterSession()` 已通过 freeze-gate (Phase 6T-B)，但未集成租约

4. **BullMQ Workers**：
   - ❌ Workers 继承 freeze-gate，但未集成租约
   - ❌ 无 pause/park 机制

5. **Collabora 写回**：
   - ❌ `/wopi/files/[fileId]/contents/route.ts` 的 POST 路由调用 `putObject()`（已通过 freeze-gate），但未集成租约

6. **Deletion Outbox**：
   - ❌ `drainStorageObjectDeletionOutbox()` 绕过 freeze-gate（设计选择）

7. **生命周期引擎**：
   - ❌ 生命周期删除不集成 freeze 状态（设计选择）

### 未执行的验证

1. **真实数据库集成验证**：
   - ❌ 未执行
   - 原因：约束条件不允许连接真实数据库
   - 风险：中等，因为租约机制需要真实数据库的乐观锁

2. **真实并发压力测试**：
   - ❌ 未执行
   - 原因：需要真实数据库和多进程环境
   - 风险：中等，因为并发竞态需要真实环境验证

3. **租约超时恢复测试**：
   - ❌ 未执行
   - 原因：需要真实数据库
   - 风险：低，因为超时逻辑简单
   - ⏸️ B1 最小实现使用 reader 单调用（避免死锁）

4. **B2 阶段（在途写入登记）**：
   - ❌ 未执行
   - 原因：需要用户授权 + schema 变更
   - 风险：高，因为 in_flight_writes 表未定义
   - ⏸️ 设计文档已提交：`docs/phase-6u-b-schema-design.md`

5. **B3 阶段（接入写入路径）**：
   - ❌ 未执行
   - 原因：需要 B2 通过验证
   - 风险：高，因为需要逐个接入各写入路径

---

## 四、已签发凭证在冻结后仍然有效的风险

### 风险 1：已签发的预签名 URL 仍可使用

**影响**：

- 已签发的预签名 URL 在租户冻结后仍可使用，直到过期
- 无法撤销已签发的 URL

**风险等级**：🟡 中等

**缓解措施**：

- ✅ 这与 freeze-gate 的设计一致：freeze-gate 不撤销已签发的凭证
- ✅ 预签名 URL 通常有效期较短（300 秒或 3600 秒）
- ✅ 管理员可以通过撤销租户来阻止新的 URL 签发

### 风险 2：已签发的 WOPI Token 仍可使用

**影响**：

- 已签发的 WOPI Token 在租户冻结后仍可使用，直到 12 小时有效期结束
- 无法撤销已签发的 Token

**风险等级**：🟡 中等

**缓解措施**：

- ✅ 这与 freeze-gate 的设计一致：freeze-gate 不撤销已签发的凭证
- ✅ WOPI Token 有效期较短（12 小时）
- ✅ 管理员可以通过撤销租户来阻止新的 Token 签发

### 风险 3：在途写入竞态

**影响**：

- 即使有租约机制，租约获取和 S3 命令之间仍存在窗口
- 可能导致在途写入绕过冻结屏障

**风险等级**：🟠 高

**缓解措施**：

- ⏸️ B1 最小实现使用 reader 单调用，避免死锁
- ⏸️ B2 阶段需要实现 in_flight_writes 表
- ⏸️ B2 阶段需要实现排空逻辑
- ⏸️ B3 阶段需要逐个接入写入路径

### 风险 4：租约超时

**影响**：

- 租约超时后，其他进程可以获取租约
- 但正在进行的写入可能继续执行

**风险等级**：🟡 中等

**缓解措施**：

- ✅ 检查 leaseExpiresAt 是否过期
- ✅ 超时后清理 leaseHolderId
- ⏸️ B2 阶段需要更精确的超时处理

### 风险 5：数据库不可用

**影响**：

- 如果数据库不可用，无法 acquired/release 租约
- 写入操作失败

**风险等级**：🟢 低

**缓解措施**：

- ✅ fail-closed：数据库不可用时拒绝所有写入
- ✅ 确保不会因为数据库故障而绕过冻结机制

---

## 五、并发时序图

### 5.1 B1 最小实现时序图

```
进程 A (写入):
1. read freeze state → ACTIVE, version=5
2. assertStorageWriteAllowed()
   → ACTIVE check passes
   → (no lease acquisition in minimal impl, just double-check)
3. putObject() → S3 PUT

进程 B (冻结请求):
1. read freeze state → ACTIVE, version=5
2. freezeToDRAINING()
   → evaluateTransition() → ok
   → update storageFreeze (version=6, state=DRAINING)
   → succeed (= DRAINING)

进程 C (写入，晚于冻结):
1. read freeze state → DRAINING, version=6
2. assertStorageWriteAllowed()
   → state is not ACTIVE → throw STORAGE_FROZEN
```

### 5.2 B1 时序图（租约获取）

```
进程 A (写入):
1. read freeze state → ACTIVE, version=5
2. acquireWriteLease()
   → lease acquired, version=6 (optimistic lock)
   → if failed, return null → write refused
3. if lease acquired:
   → putObject() → S3 PUT
   → releaseWriteLease()

进程 B (冻结请求):
1. read freeze state → ACTIVE, version=5 (or latest)
2. evaluateTransition() → ok
3. freezeToDRAINING()
   → acquire lease for freeze?
   → update storageFreeze (state=DRAINING)
   → if version mismatch, version conflict
```

**注意**：当前最小实现中，冻结请求不获取写入 lease。这可能需要在 B2 中改进。

---

## 六、HEAD、分支、工作区变更统计

### Git 信息

- **HEAD**：`51a899b7aac0a942da327222a3eed355fca9798a`
- **分支**：`hse-platform`
- **工作区变更文件**：72+ 个（包括新增文件）

### 本次实施修改的文件

1. **修改文件**（1 个）：
   - `packages/db/src/storage-freeze-operations.ts` - 新增 `acquireWriteLease` 和 `releaseWriteLease`

2. **新增文件**（4 个）：
   - `packages/storage/src/testing/write-lease.ts` - 测试辅助函数
   - `packages/storage/src/freeze-gate-phase6u-b.test.ts` - 测试文件
   - `docs/phase-6u-b-schema-design.md` - schema 设计文档
   - `docs/phase-6u-b-implementation-report.md` - 完成报告

### 本次实施未修改的文件

- `packages/storage/src/freeze-gate.ts`（仅注释修改，保持 reader 单调用）
- `packages/storage/src/freeze-gate-presign-wopi.test.ts`（未修改）
- `packages/storage/src/index.ts`（未修改）

### 仍未实施的功能

1. ❌ 在途写入登记（`in_flight_writes` 表）- 需要 schema 变更，等待授权
2. ❌ 排空逻辑 - 需要 in_flight_writes 表
3. ❌ B3 阶段写入路径接入 - 需要 B2 通过验证

---

## 七、G2 状态

### G2 状态：**保持 BLOCKED** ❌

**原因**：

1. **竞态窗口仍然存在**：
   - ❌ 租约获取和 S3 命令之间仍存在窗口
   - ❌ 无法证明 FROZEN 时无在途写入

2. **在途写入登记未实现**：
   - ❌ `in_flight_writes` 表未定义
   - ❌ 排空逻辑未实现

3. **B3 阶段写入路径未接入**：
   - ❌ 各写入路径未集成租约和 in_flight_writes

### 下一步

1. ⏸️ 等待 B2 授权（in_flight_writes 表和排空逻辑）
2. ⏸️ 等待 B3 授权（写入路径接入）
3. ⏸️ 等待 schema 变更授权（`in_flight_writes` 表）

---

**实施完成日期**：2026-10-14
**实施人**：AI Agent
**阶段**：Phase 6U-B (B1 Phase - completed, B2 pending, B3 pending)
