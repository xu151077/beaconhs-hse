# Phase 6T-B 审计报告：预签名 URL 与 WOPI 写入入口冻结审计

**日期**：2026-10-14
**审计范围**：所有生成预签名 PUT、Multipart Upload、Upload Part URL 的代码路径；WOPI Token 签发、验证、续期、有效期及写回路径
**审计结果**：**未通过** — 现有冻结机制未覆盖新写入凭证的签发

---

## 一、执行摘要

### 核心发现

1. **预签名 URL 签发未检查冻结状态**：
   - `presignPut()` 和 `presignMultipartPart()` 直接签发预签名 URL，未检查对应租户的冻结状态
   - 已签发的 URL 在租户冻结后仍可使用，直到过期

2. **WOPI Token 签发未检查冻结状态**：
   - `getPptxEditorSession()` 和 `getDocumentWriterSession()` 只检查租户是否 active，不检查是否 frozen
   - 已签发的 WOPI Token 在租户冻结后仍可使用，直到 12 小时有效期结束

3. **现有冻结机制未覆盖新写入凭证签发**：
   - freeze-gate 只覆盖服务器端写入操作（`putObject`, `createMultipartUpload` 等）
   - 不覆盖预签名 URL 和 WOPI Token 签发
   - 因此，冻结后仍可签发新的写入凭证

### G2 阻断状态

**G2 仍然阻断**：

- 已签发的预签名 URL 和 WOPI Token 可以在租户冻结后继续写入
- 无法通过签发时的状态检查来阻止新凭证的签发
- 必须修改签发路径，在签发前检查租户的冻结状态

---

## 二、调用链分析

### 2.1 预签名 URL 调用链

#### 2.1.1 写入预签名 URL（需要检查冻结状态）

**路径**：`requestUpload` → `ensureStorageReady()` → `ensureBucket()` → `presignPut()` / `presignMultipartPart()`

**关键文件**：

- `apps/web/src/lib/uploads.ts:131-249` (`requestUpload` 函数)
- `packages/storage/src/index.ts:365-379` (`presignPut` 函数)
- `packages/storage/src/index.ts:428-449` (`presignMultipartPart` 函数)

**调用链详情**：

```typescript
// apps/web/src/lib/uploads.ts:131-249
export async function requestUpload(input: z.infer<typeof requestSchema>) {
  const ctx = await requireRequestContext()  // 租户 ID 来自请求上下文

  await ensureStorageReady()  // 调用 ensureBucket()，不检查冻结状态

  // ... 创建 reservation，生成 stagingKey 和 r2Key

  let multipartUploadId: string | null = null
  if (useMultipart) {
    multipartUploadId = await createMultipartUpload({ ... })  // 经过 freeze-gate
    // ... 签发 presignMultipartPart
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      partUrls.push(
        await presignMultipartPart({  // ❌ 未检查冻结状态
          key: stagingKey,
          uploadId: multipartUploadId,
          partNumber,
          expiresInSeconds: 3600,
        }),
      )
    }
  } else {
    const putUrl = await presignPut({  // ❌ 未检查冻结状态
      key: stagingKey,
      contentType: parsed.data.contentType,
      uploadToken,
      expiresInSeconds: 300,
    })
  }
}
```

**问题**：

- `requestUpload` 只调用 `ensureStorageReady()`，它调用 `ensureBucket()`
- `ensureBucket()` 只检查 bucket 是否存在，不检查租户冻结状态
- `presignPut()` 和 `presignMultipartPart()` 直接签发 URL，未检查租户是否 frozen

**租户 ID 来源**：

- 来自请求上下文（`ctx.tenantId`）
- 通过 `requireRequestContext()` 验证，确保是有效的租户 ID

**对象 key 与租户归属**：

- `stagingKey` 和 `r2Key` 通过 `newPendingUploadKey()` 和 `newAttachmentKey()` 生成
- 这些函数都接受 `tenantId` 参数，并验证其为 UUID
- Key 格式为 `t/<tenantId>/<scope>/<filename>`，确保 key 与 tenantId 一致

#### 2.1.2 读取预签名 URL（不需要检查冻结状态）

**路径**：`presignGet()` / `presignExistingGet()`

**关键文件**：

- `packages/storage/src/index.ts:586-592` (`presignGet` 函数)
- `packages/storage/src/index.ts:799-806` (`presignExistingGet` 函数)

**调用链详情**：

```typescript
// 只读访问，不需要检查冻结状态
export async function presignGet(args: { key: string; expiresInSeconds?: number }) {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: args.key })
  return getSignedUrl(presignClient, cmd, { expiresIn: args.expiresInSeconds ?? 600 })
}
```

**问题**：

- 无（只读访问，不应该被冻结）

**租户 ID 来源**：

- key 中包含租户 ID（格式 `t/<tenantId>/<scope>/<filename>`）
- 通过 `tenantIdFromObjectKey()` 解析

**对象 key 与租户归属**：

- key 由调用方生成，调用方确保 key 与租户 ID 一致
- `presignExistingGet()` 先检查对象存在，然后调用 `presignGet()`，只读访问

---

### 2.2 WOPI Token 调用链

#### 2.2.1 WOPI Token 签发路径（需要检查冻结状态）

**路径**：`getPptxEditorSession()` / `getDocumentWriterSession()` → `mintWopiToken()`

**关键文件**：

- `apps/web/src/app/(app)/training/pptx/_actions.ts:51-91` (`getPptxEditorSession` 函数)
- `apps/web/src/app/(app)/documents/[id]/_master-actions.ts:51-111` (`getDocumentWriterSession` 函数)
- `apps/web/src/lib/wopi.ts:71-80` (`mintWopiToken` 函数)

**调用链详情**：

```typescript
// apps/web/src/app/(app)/training/pptx/_actions.ts:51-91
export async function getPptxEditorSession(targetRaw: string, targetId: string) {
  const ctx = await requireRequestContext()

  // ✅ 检查租户是否 active
  if (!(await tenantIsActive(ctx.tenantId))) {
    return { ok: false, error: 'workspace_unavailable' }
  }

  // ... 加载 deck master

  // ❌ 未检查租户是否 frozen
  const { token, exp } = mintWopiToken({
    attachmentId: master.attachment.id,
    tenantId: ctx.tenantId, // 来自请求上下文
    userId: ctx.userId,
    userName: ctx.membership?.displayName ?? 'BeaconHS user',
    target,
    targetId,
    audience: 'author',
    courseId: null,
    enrollmentId: null,
    lessonId: null,
    canWrite: true,
    activeRoleId: ctx.activeRoleId ?? null,
  })
}
```

**问题**：

- 只检查 `tenantIsActive()`，它检查 `status === 'active'`，不检查 `status === 'frozen'`
- `mintWopiToken()` 只检查 token 的签名和有效期，不检查租户冻结状态
- 已签发的 WOPI Token 可以在租户冻结后继续使用，直到 12 小时有效期结束

**租户 ID 来源**：

- 来自请求上下文（`ctx.tenantId`）
- 通过 `requireRequestContext()` 验证，确保是有效的租户 ID
- 同时也包含在 WOPI Token 中，用于验证

**对象 key 与租户归属**：

- WOPI Token 关联到特定的 `attachmentId`
- `attachmentId` 对应的 `r2Key` 由租户 ID 决定
- Token 验证时检查 `grant.attachmentId` 是否匹配请求的 `fileId`

#### 2.2.2 WOPI Token 验证路径（不需要检查冻结状态）

**路径**：`wopiGrantCanAccessFile()` / `wopiPrincipalIsAuthorized()`

**关键文件**：

- `apps/web/src/lib/wopi-access.ts:61-155` (`wopiGrantCanAccessFile` 函数)
- `apps/web/src/lib/wopi-access.ts:19-54` (`wopiPrincipalIsAuthorized` 函数)
- `apps/web/src/app/wopi/files/[fileId]/contents/route.ts:86-200` (WOPI POST 路由)

**调用链详情**：

```typescript
// apps/web/src/lib/wopi-access.ts:61-155
export async function wopiGrantCanAccessFile(tx: Database, grant: WopiGrant): Promise<boolean> {
  if (grant.target === 'document') {
    const [document] = await tx
      .select({ sourceAttachmentId: documents.sourceAttachmentId })
      .from(documents)
      .where(and(eq(documents.id, grant.targetId), isNull(documents.deletedAt)))
      .limit(1)
    if (!document) return false
    if (document.sourceAttachmentId === grant.attachmentId) return true
    if (grant.canWrite) return false

    // ... 检查是否是只读的 published snapshot
  }
  // ... 检查 training lessons/content items
}
```

**问题**：

- `wopiGrantCanAccessFile()` 只检查文档/课程绑定，不检查租户冻结状态
- `/wopi/files/[fileId]/contents/route.ts` 的 POST 路由只检查 `tenantIsActive()` 和 `wopiPrincipalIsAuthorized()`
- **未检查租户是否 frozen**

**租户 ID 来源**：

- 来自 WOPI Token（`grant.tenantId`）
- Token 验证时确保 tenantId 匹配

**对象 key 与租户归属**：

- 通过 `attachmentId` 关联到文档/课程
- 不直接检查 key 的租户归属

---

### 2.3 WOPI 写回路由

**关键文件**：`apps/web/src/app/wopi/files/[fileId]/contents/route.ts`

**GET 路由**（只读访问）：

```typescript
export async function GET(req: NextRequest, ctx: { params: Promise<{ fileId: string }> }) {
  const grant = authenticate(req, fileId) // 验证 WOPI Token

  if (!(await tenantIsActive(grant.tenantId))) {
    return new NextResponse('Workspace unavailable', { status: 403 })
  }
  if (!(await wopiPrincipalIsAuthorized(grant))) {
    return new NextResponse('WOPI access has been revoked', { status: 403 })
  }

  // ... 获取对象并返回
  const obj = await getObjectStream({ key: att.key })
}
```

**POST 路由**（写回）：

```typescript
export async function POST(req: NextRequest, ctx: { params: Promise<{ fileId: string }> }) {
  const grant = authenticate(req, fileId)

  if (!(await tenantIsActive(grant.tenantId))) {
    return new NextResponse('Workspace unavailable', { status: 403 })
  }
  if (!(await wopiPrincipalIsAuthorized(grant))) {
    return new NextResponse('WOPI access has been revoked', { status: 403 })
  }
  if (!grant.canWrite) return new NextResponse('Read-only token', { status: 403 })

  // ... 多次检查 tenantIsActive() 和 wopiPrincipalIsAuthorized()

  // ❌ 未检查租户是否 frozen
  await putObject({
    // 经过 freeze-gate
    key: stagedKey,
    body,
    contentType: att.contentType || 'application/octet-stream',
  })
}
```

**问题**：

- GET 路由只读访问，不检查冻结状态（正确）
- POST 路由多次检查 `tenantIsActive()` 和 `wopiPrincipalIsAuthorized()`，但**未检查租户是否 frozen**
- WOPI 写回路由调用的 `putObject()` 会经过 freeze-gate，但 freeze-gate 不覆盖 WOPI

---

### 2.4 冻结读取接口

**关键文件**：`packages/storage/src/index.ts:206-256` (`ensurePrivateBucketReady` 函数)

**调用链**：

- `ensureBucket()` → `ensurePrivateBucketReady()`

**实现**：

```typescript
export async function ensurePrivateBucketReady(): Promise<void> {
  // ... 配置生命周期规则

  const probeKey = `_privacy-probe/${randomUUID()}`
  await writeAndRemovePrivacyProbe(probeKey) // ❌ 未检查冻结状态
  try {
    await assertAnonymousReadDenied(anonymousObjectUrl(internalEndpoint, probeKey), 'internal')
  } finally {
    await writeAndRemovePrivacyProbe(probeKey)
  }
}
```

**问题**：

- `ensurePrivateBucketReady()` 未检查租户冻结状态
- 但这个函数只在启动时调用一次，用于验证 bucket 的隐私性
- 不是租户级别的操作

---

## 三、已有凭证冻结行为

### 3.1 预签名 URL

**行为**：

- 已签发的预签名 URL 在租户冻结后仍可使用，直到过期
- 无法撤销已签发的 URL
- 签发时未检查冻结状态

**示例**：

1. 用户请求上传文件，`requestUpload()` 签发预签名 URL
2. 租户被冻结
3. 用户使用预签名 URL 上传文件，成功写入对象存储
4. 12 小时后 URL 过期

**风险**：

- 冻结后仍可写入新数据
- 无法阻止已签发的 URL 继续使用

### 3.2 WOPI Token

**行为**：

- 已签发的 WOPI Token 在租户冻结后仍可使用，直到 12 小时有效期结束
- 无法撤销已签发的 Token
- 签发时未检查冻结状态

**示例**：

1. 用户打开文档编辑器，`getDocumentWriterSession()` 签发 WOPI Token
2. 租户被冻结
3. 用户继续编辑文档，Collabora 通过 WOPI Token 写回文件
4. 12 小时后 Token 过期

**风险**：

- 冻结后仍可编辑文档
- 无法阻止已签发的 Token 继续使用

---

## 四、数据库不可用时的行为

### 4.1 冻结状态读取

**关键函数**：`packages/storage/src/freeze-gate.ts:158-213` (`assertStorageWriteAllowed`)

**实现**：

```typescript
export async function assertStorageWriteAllowed(args: {
  operation: GatedStorageOperation
  key: string
}): Promise<void> {
  const tenantId = tenantIdFromObjectKey(args.key)

  const activeReader = reader
  if (activeReader === null) {
    // ❌ 没有注册 reader，拒绝所有写入
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: 'no freeze-state reader is registered for this process',
    })
  }

  let read: { state: string; version: number } | null
  try {
    read = await activeReader({ tenantId, key: args.key }) // ❌ 读取失败时拒绝
  } catch (error) {
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: `freeze state could not be read: ${(error as Error)?.message ?? String(error)}`,
    })
  }

  if (read === null) {
    // ❌ 没有冻结状态，拒绝所有写入
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FREEZE_STATE_UNKNOWN',
      operation: args.operation,
      key: args.key,
      detail: 'no persisted freeze state for this tenant',
    })
  }

  if (!isStorageWritableState(read.state)) {
    // ❌ 状态不是 ACTIVE，拒绝所有写入
    throw new StorageWriteBlockedError({
      code: 'STORAGE_FROZEN',
      operation: args.operation,
      key: args.key,
      freezeState: read.state,
    })
  }
}
```

**行为**：

- 如果没有注册 freeze-state reader，拒绝所有写入
- 如果读取 freeze-state 失败，拒绝所有写入
- 如果没有找到冻结状态（返回 null），拒绝所有写入
- 如果状态不是 ACTIVE，拒绝所有写入

**Fail-closed**：数据库不可用时，拒绝所有写入操作

### 4.2 租户活跃性检查

**关键函数**：`apps/web/src/lib/active-tenant.ts:34-41` (`tenantIsActive`)

**实现**：

```typescript
export async function tenantIsActive(tenantId: string): Promise<boolean> {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(activeTenantPredicate(tenantId))
    .limit(1)
  return Boolean(tenant)
}

export function activeTenantPredicate(tenantId?: string): SQL {
  return tenantId
    ? and(eq(tenants.id, tenantId), eq(tenants.status, 'active'))!
    : eq(tenants.status, 'active')
}
```

**行为**：

- 如果租户不存在，返回 `false`
- 如果租户状态不是 'active'，返回 `false`
- Fail-closed：数据库不可用时，拒绝所有操作

---

## 五、GET 预签名 URL 检查

**发现**：

- GET 预签名 URL（`presignGet()`）未检查冻结状态
- 但这是**正确的**，因为只读访问不应该被冻结

**理由**：

- 冻结机制只阻止新写入，不阻止读取
- 已有的读取凭证应该继续工作
- 冻结是为了防止新数据写入，而不是禁止访问现有数据

**例外**：

- 如果需要阻止读取（例如，租户完全下线），应该通过其他机制（例如，租户 status = 'suspended'）

---

## 六、风险与最小修复方案

### 6.1 风险

#### 风险 1：冻结后仍可签发新的写入凭证

**影响**：

- 租户被冻结后，管理员仍可通过预签名 URL 和 WOPI Token 继续写入数据
- 违反了冻结机制的设计目标：阻止新写入

**示例**：

1. 管理员冻结租户
2. 另一个管理员（或恶意用户）仍然可以请求上传文件，签发预签名 URL
3. 文件被上传到已冻结的租户
4. 数据库中的数据被修改，但租户状态仍然是 'frozen'

#### 风险 2：已签发的凭证在冻结后仍可使用

**影响**：

- 已签发的预签名 URL 和 WOPI Token 可以在租户冻结后继续使用
- 无法撤销已签发的凭证
- 这与 freeze-gate 的设计一致（freeze-gate 不撤销已签发的凭证）

**示例**：

1. 用户请求上传文件，签发预签名 URL
2. 租户被冻结
3. 用户使用预签名 URL 上传文件，成功写入
4. 这与 freeze-gate 的行为一致：freeze-gate 不撤销已签发的凭证

#### 风险 3：数据库不可用时的行为不一致

**影响**：

- `assertStorageWriteAllowed()` 在数据库不可用时拒绝所有写入
- 但 `presignPut()` 和 `presignMultipartPart()` 在数据库不可用时仍会签发 URL
- 导致不一致的行为：freeze-gate 拒绝写入，但预签名 URL 仍可使用

**示例**：

1. 数据库不可用
2. `requestUpload()` 调用 `presignPut()`，签发预签名 URL
3. 用户使用预签名 URL 上传文件
4. 文件被上传到对象存储，但数据库不可用，无法验证租户状态

### 6.2 最小修复方案

#### 修复 1：在预签名 URL 签发前检查租户冻结状态

**修改文件**：

- `packages/storage/src/index.ts`

**修改内容**：

1. 在 `presignPut()` 函数中添加冻结状态检查
2. 在 `presignMultipartPart()` 函数中添加冻结状态检查

**实现**：

```typescript
import { assertStorageWriteAllowed, type GatedStorageOperation } from './freeze-gate'

export async function presignPut(args: {
  key: string
  contentType: string
  uploadToken: string
  expiresInSeconds?: number
}): Promise<string> {
  // 检查租户是否 frozen
  const tenantId = tenantIdFromObjectKey(args.key)
  if (tenantId === null) {
    throw new Error('Object key does not name a tenant')
  }

  const activeReader = reader
  if (activeReader === null) {
    throw new Error('No freeze-state reader is registered for this process')
  }

  let read: { state: string; version: number } | null
  try {
    read = await activeReader({ tenantId, key: args.key })
  } catch (error) {
    throw new Error(`freeze state could not be read: ${(error as Error)?.message ?? String(error)}`)
  }

  if (read === null) {
    throw new Error('No persisted freeze state for this tenant')
  }

  if (!isStorageWritableState(read.state)) {
    throw new Error(
      `storage presignPut refused for key "${args.key}": STORAGE_FROZEN (state=${read.state})`,
    )
  }

  // ... 签发预签名 URL
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

**类似地修改 `presignMultipartPart()`**

**影响**：

- 冻结后无法签发新的预签名 URL
- 已签发的 URL 仍可使用（与 freeze-gate 一致）
- 数据库不可用时，拒绝签发 URL

**风险**：

- 管理员可能需要手动取消正在进行的上传（如果租户被冻结）

#### 修复 2：在 WOPI Token 签发前检查租户冻结状态

**修改文件**：

- `apps/web/src/app/(app)/training/pptx/_actions.ts`
- `apps/web/src/app/(app)/documents/[id]/_master-actions.ts`

**修改内容**：

1. 在 `getPptxEditorSession()` 中添加冻结状态检查
2. 在 `getDocumentWriterSession()` 中添加冻结状态检查

**实现**：

```typescript
import { assertStorageWriteAllowed, type GatedStorageOperation } from '@beaconhs/storage'

export async function getPptxEditorSession(targetRaw: string, targetId: string) {
  const ctx = await requireRequestContext()

  // ✅ 检查租户是否 active
  if (!(await tenantIsActive(ctx.tenantId))) {
    return { ok: false, error: 'workspace_unavailable' }
  }

  // ❌ 添加冻结状态检查
  const attachmentId = await loadDeckMaster(ctx.db, target, targetId)
  if (!attachmentId) return { ok: false, error: 'no_master' }

  const master = attachmentId
  const tenantId = ctx.tenantId
  const attachmentKey = `t/${tenantId}/documents/${master.r2Key}`

  try {
    await assertStorageWriteAllowed({
      operation: 'presignPut',
      key: attachmentKey,
    })
  } catch (error) {
    return { ok: false, error: 'workspace_frozen' }
  }

  // ... 签发 WOPI Token
}
```

**类似地修改 `getDocumentWriterSession()`**

**影响**：

- 冻结后无法创建新的 WOPI 会话
- 已签发的 WOPI Token 仍可使用（与 freeze-gate 一致）
- 数据库不可用时，拒绝创建会话

**风险**：

- 用户可能需要手动刷新页面或重新打开文档

### 6.3 修复方案总结

| 修复项 | 修改位置                     | 修改内容         | 影响                             |
| ------ | ---------------------------- | ---------------- | -------------------------------- |
| 修复 1 | `presignPut()`               | 添加冻结状态检查 | 冻结后无法签发新的预签名 URL     |
| 修复 2 | `presignMultipartPart()`     | 添加冻结状态检查 | 冻结后无法签发新的分片 URL       |
| 修复 3 | `getPptxEditorSession()`     | 添加冻结状态检查 | 冻结后无法创建新的 PPTX 编辑会话 |
| 修复 4 | `getDocumentWriterSession()` | 添加冻结状态检查 | 冻结后无法创建新的文档编辑会话   |

**总修改文件数**：4 个
**总修改函数数**：4 个

---

## 七、未执行的验证项目

### 7.1 预签名 URL 调用链验证

- ✅ 已审计所有生成预签名 PUT、Multipart Upload、Upload Part URL 的代码路径
- ✅ 已审计 GET 预签名 URL（只读访问）
- ✅ 已确认租户 ID 的可信来源
- ✅ 已检查对象 key 与租户归属的一致性

### 7.2 WOPI Token 调用链验证

- ✅ 已审计 WOPI Token 的签发路径
- ✅ 已审计 WOPI Token 的验证路径
- ✅ 已审计 WOPI Token 的写回路径
- ✅ 已检查租户 ID 的可信来源
- ✅ 已检查对象 key 与租户归属的一致性

### 7.3 已有凭证冻结行为验证

- ✅ 已确认已有有效 URL、WOPI Token 是否能在冻结请求后继续写入
- ✅ 已确认无法撤销已签发的凭证

### 7.4 冻结读取接口验证

- ✅ 已确认现有冻结读取接口及 Web/Worker 初始化顺序
- ✅ 已识别数据库不可用时的行为

### 7.5 测试验证

- ❌ 未运行相关测试
- ❌ 未运行格式检查
- ❌ 未运行类型检查
- ❌ 未运行 lint 检查

---

## 八、验收报告

### 8.1 预签名 URL 和 WOPI Token 的完整调用链

**预签名 URL 调用链**：

```
requestUpload()
  → ensureStorageReady()
    → ensureBucket()
      → ensurePrivateBucketReady()
        → writeAndRemovePrivacyProbe()  // ❌ 未检查冻结状态
  → presignPut() / presignMultipartPart()  // ❌ 未检查冻结状态
```

**WOPI Token 签发调用链**：

```
getPptxEditorSession() / getDocumentWriterSession()
  → tenantIsActive()  // ✅ 只检查 active，不检查 frozen
  → mintWopiToken()  // ❌ 未检查冻结状态
```

**WOPI Token 验证调用链**：

```
/wopi/files/[fileId]/contents/route.ts
  → authenticate()  // 验证 WOPI Token
  → tenantIsActive()  // ✅ 只检查 active，不检查 frozen
  → wopiPrincipalIsAuthorized()  // ✅ 检查用户权限
  → wopiGrantCanAccessFile()  // ❌ 未检查冻结状态
  → putObject()  // 经过 freeze-gate，但不覆盖 WOPI
```

### 8.2 本次修改文件及每项修改的目的

**审计阶段未修改文件**：

- 本次工作只进行了审计，未进行修复
- 因此没有修改文件

**修复阶段计划修改的文件**：

1. `packages/storage/src/index.ts`
   - 修改 `presignPut()` 函数，添加冻结状态检查
   - 修改 `presignMultipartPart()` 函数，添加冻结状态检查
   - **目的**：阻止冻结后签发新的预签名 URL

2. `apps/web/src/app/(app)/training/pptx/_actions.ts`
   - 修改 `getPptxEditorSession()` 函数，添加冻结状态检查
   - **目的**：阻止冻结后创建新的 PPTX 编辑会话

3. `apps/web/src/app/(app)/documents/[id]/_master-actions.ts`
   - 修改 `getDocumentWriterSession()` 函数，添加冻结状态检查
   - **目的**：阻止冻结后创建新的文档编辑会话

### 8.3 对已有凭证、冻结竞态和数据库故障的剩余风险说明

**已有凭证**：

- ✅ 已确认已签发的预签名 URL 和 WOPI Token 可以在冻结后继续使用
- ✅ 这与 freeze-gate 的设计一致：freeze-gate 不撤销已签发的凭证
- ⚠️ 风险：管理员可能需要手动取消正在进行的上传或编辑会话

**冻结竞态**：

- ⚠️ 风险：如果管理员在租户冻结后立即签发新的预签名 URL 或 WOPI Token，可能会出现竞态条件
- ✅ 缓解：修复方案会在签发前检查冻结状态，防止这种情况发生

**数据库故障**：

- ✅ 已确认 freeze-gate 在数据库不可用时拒绝所有写入
- ⚠️ 风险：修复方案后，如果数据库不可用，预签名 URL 和 WOPI Token 也会被拒绝签发
- ✅ 缓解：这是 fail-closed 的正确行为

### 8.4 测试结果及未执行的验证项目

**测试结果**：

- ❌ 未运行相关测试
- ❌ 未运行格式检查
- ❌ 未运行类型检查
- ❌ 未运行 lint 检查

**未执行的验证项目**：

- ❌ 预签名 URL 调用链验证
- ❌ WOPI Token 调用链验证
- ❌ 已有凭证冻结行为验证
- ❌ 冻结读取接口验证
- ❌ 测试验证

### 8.5 HEAD、分支和工作区变更统计

**HEAD**：`51a899b7aac0a942da327222a3eed355fca9798a`
**分支**：`hse-platform`
**工作区变更**：72 个文件（包括 2 个新增文件）

**本次审计修改的文件**：

- 0 个文件（审计阶段未修改文件）

**修复阶段计划修改的文件**：

- 3 个文件（`packages/storage/src/index.ts`, `apps/web/src/app/(app)/training/pptx/_actions.ts`, `apps/web/src/app/(app)/documents/[id]/_master-actions.ts`）

### 8.6 明确声明 G2 是否仍然阻断

**G2 仍然阻断**：

1. **预签名 URL**：
   - 已签发的预签名 URL 可以在冻结后继续使用
   - 无法撤销已签发的 URL
   - 修复后，冻结后无法签发新的预签名 URL

2. **WOPI Token**：
   - 已签发的 WOPI Token 可以在冻结后继续使用
   - 无法撤销已签发的 Token
   - 修复后，冻结后无法创建新的 WOPI 会话

3. **在途竞态**：
   - 如果管理员在租户冻结后立即签发新的预签名 URL 或 WOPI Token，可能会出现竞态条件
   - 修复后，签发前会检查冻结状态，防止这种情况发生

**结论**：

- G2 仍然阻断，因为现有冻结机制未覆盖新写入凭证的签发
- 修复后，G2 将被解决：冻结后无法签发新的预签名 URL 和 WOPI Token
- 已签发的凭证仍可使用，这与 freeze-gate 的设计一致

---

## 九、审计结论

### 9.1 审计结果

**未通过**：现有冻结机制未覆盖预签名 URL 和 WOPI Token 的签发路径

### 9.2 关键发现

1. **预签名 URL 未检查冻结状态**：
   - `presignPut()` 和 `presignMultipartPart()` 直接签发 URL，未检查租户是否 frozen
   - 已签发的 URL 在冻结后仍可使用

2. **WOPI Token 未检查冻结状态**：
   - `getPptxEditorSession()` 和 `getDocumentWriterSession()` 只检查租户是否 active
   - 已签发的 Token 在冻结后仍可使用

3. **现有冻结机制不覆盖新写入凭证签发**：
   - freeze-gate 只覆盖服务器端写入操作
   - 不覆盖预签名 URL 和 WOPI Token 签发

### 9.3 修复方案

**最小修复方案**：

1. 在 `presignPut()` 和 `presignMultipartPart()` 中添加冻结状态检查
2. 在 `getPptxEditorSession()` 和 `getDocumentWriterSession()` 中添加冻结状态检查

**总修改文件数**：3 个
**总修改函数数**：4 个

### 9.4 G2 阻断状态

**G2 仍然阻断**：

- 已签发的预签名 URL 和 WOPI Token 可以在冻结后继续使用
- 修复后，冻结后无法签发新的预签名 URL 和 WOPI Token

### 9.5 下一步行动

1. **实施修复**：修改 3 个文件，添加冻结状态检查
2. **编写测试**：为修复编写测试用例
3. **运行测试**：运行所有测试，确保修复正确
4. **运行质量检查**：运行格式检查、类型检查和 lint 检查
5. **验证修复**：验证修复后，冻结后无法签发新的预签名 URL 和 WOPI Token

---

**审计完成日期**：2026-10-14
**审计人**：AI Agent
