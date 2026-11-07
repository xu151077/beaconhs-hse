# Phase 6U-B Schema Design: In-Flight Write Tracking

## 设计目的

此文档描述 Phase 6U-B 所需的数据库 schema 变更。根据约束条件，这些变更需要用户授权后实施。

## 新增表：in_flight_writes

### 表结构

```sql
CREATE TABLE in_flight_writes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  operation TEXT NOT NULL,  -- 'putObject', 'presignPut', 'wopiToken', etc.
  key TEXT NOT NULL,
  lease_id UUID REFERENCES storage_freeze(id),
  lease_version INTEGER NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMPTZ NULL,
  success BOOLEAN NOT NULL,
  error TEXT NULL,
  PRIMARY KEY (id, tenant_id)
);
```

### 索引

```sql
-- 用于查询未完成写入
CREATE INDEX in_flight_writes_tenant_completed_idx
ON in_flight_writes(tenant_id, completed_at WHERE completed_at IS NULL);

-- 用于查询特定 key 的写入
CREATE INDEX in_flight_writes_tenant_key_idx
ON in_flight_writes(tenant_id, key);

-- 用于租约关联
CREATE INDEX in_flight_writes_lease_idx
ON in_flight_writes(lease_id);
```

### 约束

```sql
-- 租户归属检查：key 必须属于 tenant
CHECK (key LIKE ('t/' || tenant_id::text || '/%'));

-- 版本检查：lease_version 必须 >= 0
CHECK (lease_version >= 0);

-- 状态检查：completed_at 为 NULL 时，success 必须为 false
CHECK (
  (completed_at IS NULL AND success = false) OR
  (completed_at IS NOT NULL)
);
```

### 字段说明

| 字段          | 类型        | 说明                                            |
| ------------- | ----------- | ----------------------------------------------- |
| id            | UUID        | 主键，写入记录的唯一标识                        |
| tenant_id     | UUID        | 租户ID，外键引用 tenants表                      |
| operation     | TEXT        | 操作类型：putObject、deleteObject、presignPut等 |
| key           | TEXT        | 对象key（如 t/<tenantId>/documents/file.docx）  |
| lease_id      | UUID        | 关联的租约ID（storage_freeze.id），可为NULL     |
| lease_version | INTEGER     | 租约版本号，用于乐观锁                          |
| started_at    | TIMESTAMPTZ | 写入开始时间，自动设置                          |
| completed_at  | TIMESTAMPTZ | 写入完成时间，NULL表示未完成                    |
| success       | BOOLEAN     | 是否成功，写入进行中时为false                   |
| error         | TEXT        | 错误信息，成功时为NULL                          |

### 使用场景

1. **写入准入**：操作被准入时 INSERT 一条记录（completed_at=NULL, success=false）
2. **写入完成**：操作成功时 UPDATE 记录（completed_at=NOW(), success=true）
3. **写入失败**：操作失败时 UPDATE 记录（completed_at=NOW(), success=false, error=错误信息）
4. **超时恢复**：定时清理 completed_at=NULL 且 started_at 超时的记录
5. **冻结请求时检查**：查询 completed_at IS NULL 的记录数量

### 竞态控制

1. **租约 vs 写入**：lease_version 字段记录了写入准入时的租约版本
2. **乐观锁**：freeze-to-DRAINING 操作检查 version，如果版本不匹配则拒绝
3. **唯一性**：(tenant_id, key) 可以唯一标识一个在途写入

### 风险

1. **表大小**：每个写入操作都会生成一行，表会快速膨胀
2. **清理策略**：需要定期清理已完成的记录
3. **崩溃恢复**：进程崩溃时记录可能保持未完成状态
4. **数据库可用性**：如果数据库不可用，无法登记在途写入

### 迁移策略

1. 创建表和索引
2. 在现有写入路径中添加 INSERT/UPDATE 逻辑
3. 添加定时清理任务（如每天清理已完成记录）
4. 添加监控：未完成写入数量、平均完成时间等

### 验证策略

1. **单元测试**：使用内存模拟器测试所有状态转换
2. **并发测试**：多进程同时写入，验证 lease_version 一致性
3. **故障注入**：模拟进程崩溃、数据库故障
4. **集成测试**：真实数据库验证所有约束和索引

---

**设计完成日期**：2026-10-14
**设计人**：AI Agent
**状态**：等待授权
