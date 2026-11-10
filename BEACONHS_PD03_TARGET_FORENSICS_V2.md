# PD-03 目标数据库取证 V2（P3-1，只读）

**授权：** 仅只读取证。未连接目标库、未执行 A3 Apply、未修改/删除任何数据、未做对象存储清理。
**本轮无 Secret 读取。**

## 1. 重要纠正：`beaconhs-dev` 是目标标记，不是数据库名

证据 `apps/web/scripts/cutover-target.ts:44-58`：

```ts
if (process.env.BEACONHS_CUTOVER_TARGET !== CUTOVER_TARGET) throw …
const url = required('SUPERADMIN_DATABASE_URL')
const fingerprint = databaseFingerprint(url)
if (fingerprint !== DEV_DATABASE_POOL_FINGERPRINT &&
    fingerprint !== DEV_DATABASE_DIRECT_FINGERPRINT) {
  throw new Error('SUPERADMIN_DATABASE_URL is not the audited BeaconHS dev database')
}
```

- `BEACONHS_CUTOVER_TARGET` 必须等于常量 `CUTOVER_TARGET`（值 `beaconhs-dev`），它是一个**环境标记**；
- 真正的定位依据是 `SUPERADMIN_DATABASE_URL` 的**指纹**必须命中 `DEV_DATABASE_POOL_FINGERPRINT`（`a19382e0…`）或 `DEV_DATABASE_DIRECT_FINGERPRINT`（`0ae09059…`）。

因此上一版报告"找不到名为 `beaconhs-dev` 的库"的表述不准确：**不存在该库名是正常的**，定位应基于指纹。

## 2. 指纹算法（可复核）

`cutover-target.ts:13-40`：

- DB：`sha256('beaconhs-cutover-db-v1' | hostname.toLowerCase() | port(默认 5432) | decodeURIComponent(pathname))`
- 期望：pool `a19382e0…`、direct `0ae09059…`；capability secret `1c79927d…`；storage `2609e306…`

**本机**（`10.10.31.26`）由当前配置计算得 `ae0ab37a…`，与两个期望值均不等 → **本机 dev DB 不是审计目标**（与 `TEST_HOST_A3_FORENSIC_AUDIT.md` 一致）。

## 3. 已排查实例

| 主机                  | 实例                                      | 库                            | 结论                    |
| --------------------- | ----------------------------------------- | ----------------------------- | ----------------------- |
| `10.10.31.13`（生产） | `beaconhs-local-prod-postgres-1`          | `beaconhs`(32MB) / `postgres` | 生产库，非审计目标      |
| `10.10.31.13`         | `risk-postgres`（postgres:13）            | —                             | 非 BeaconHS             |
| `10.10.31.26`（本机） | `beaconhs-postgres`（已停）               | `beaconhs`                    | 指纹 `ae0ab37a…` ≠ 期望 |
| `10.10.31.26`         | `beaconhs-prod-verify-postgres-1`（已停） | `beaconhs`                    | 同上，非目标            |
| `10.10.31.26`         | `beaconhs-fixture-postgres-1`（Exited 1） | 未声明                        | 非目标，未启动          |

**未找到指纹匹配的实例。**

## 4. A3 历史执行记录（只读）

| 文档                                                     | 关键结论                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `A3_BACKFILL_PREFLIGHT.md`                               | 回填前置条件与顺序                                                                                                           |
| `A3_EXECUTION_CARD.md`                                   | guardrails：target marker、指纹 `a19382e0…`/`0ae09059…`、capability `1c79927d…`、session 形状（`beaconhs_super`/`beaconhs`） |
| `docs/release-2026-11-09/TEST_HOST_A3_FORENSIC_AUDIT.md` | 三指纹引入提交 `a1e55581`；本机 `ae0ab37a…` 不匹配；env 全部 unset；**未执行过 A3 Audit/Apply**                              |
| `docs/project-development-state.md:1743`                 | cutover 环境说明                                                                                                             |

**结论：A3 从未执行（无 apply 记录、无输出产物）。**

## 5. 租户范围与对象存储归属

- 生产库：1 个租户（`tenants=1`）；附件 8、outbox 0、audit 285、迁移 57（只读基线）。
- 目标库租户范围：**未知**（需指纹匹配后确认）。
- 对象存储：生产为 MinIO `beaconhs-local-prod-minio-1`，bucket `beaconhs-prod`（约 2.1MB）。
- 注意：`R2_BUCKET=beaconhs-dev` 是 `.env.example` / 部署基线中的**默认 bucket 名**，与 target marker 同字不同义，不可据此推断目标实例。

## 6. 六类异常盘点 SQL（就绪，待目标库执行）

> 全部为 `SELECT`；执行前需在目标库确认表名/列名（部分实体表名与报表视图不同）。

```sql
-- 1) 孤儿附件：attachments 无任何业务引用
SELECT a.id, a.tenant_id, a.r2_key, a.created_at
FROM attachments a
WHERE NOT EXISTS (SELECT 1 FROM incident_attachments x WHERE x.attachment_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM training_lessons l WHERE l.source_attachment_id = a.id AND l.deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM training_content_items i WHERE i.source_attachment_id = a.id AND i.deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.source_attachment_id = a.id AND d.deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM person_files f WHERE f.attachment_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM ppe_inspection_attachments p WHERE p.attachment_id = a.id)
ORDER BY a.created_at
LIMIT 200;

-- 2) 悬空引用：业务表指向不存在的附件
SELECT 'training_lessons' AS src, l.id, l.tenant_id, l.source_attachment_id
FROM training_lessons l
LEFT JOIN attachments a ON a.id = l.source_attachment_id
WHERE l.source_attachment_id IS NOT NULL AND a.id IS NULL
UNION ALL
SELECT 'documents', d.id, d.tenant_id, d.source_attachment_id
FROM documents d
LEFT JOIN attachments a ON a.id = d.source_attachment_id
WHERE d.source_attachment_id IS NOT NULL AND a.id IS NULL;

-- 3) 删除标记不一致：业务行已软删但仍指向附件
SELECT 'training_lessons' AS src, id, tenant_id, source_attachment_id
FROM training_lessons
WHERE deleted_at IS NOT NULL AND source_attachment_id IS NOT NULL
LIMIT 200;

-- 4) outbox 残留（重试过或长期 pending）
SELECT id, tenant_id, attachment_id, status, attempts, available_at, created_at, left(last_error, 200) AS err
FROM storage_object_deletion_outbox
WHERE attempts > 0 OR available_at < now() - interval '1 hour'
ORDER BY created_at
LIMIT 200;
```

**5) 对象缺失 / 6) 对象多余**：需对象存储只读列举（`mc ls` 或 S3 ListObjects），与 `attachments.r2_key` 做差集。SQL 无法单独完成，实施时需：

- 导出 `attachments.r2_key` 列表（只读）；
- 对象存储列出全部 key（只读）；
- 两侧差集 → 缺失/多余清单。

## 7. 结论

- **P3-1 仍未完成**：未找到指纹匹配的实例；A3 从未执行（有据）。
- **P3-2 及之后不得开始。**
- 所需输入（缺一不可）：
  1. 指纹为 `a19382e0…`（pool）或 `0ae09059…`（direct）的实例地址与库名
  2. 该实例的 `SUPERADMIN_DATABASE_URL` 注入方式（Vault/秘密文件，**不经聊天**）
  3. 目标租户范围（单租户/全部）
  4. 对象存储实例与 bucket 名
