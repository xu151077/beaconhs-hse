# BeaconHS 数据库迁移审查 — 0058（发布候选审查）

**审查基线：** HEAD `62237a25`（领先 `origin/hse-platform` 21 提交）。**生产当前：57 migrations。**
**性质：只读审查。未连接生产、未执行 0058、未修改 RLS。**

## 1. 0058 内容（`packages/db/drizzle/0058_api_key_principal_scope.sql`）

```sql
ALTER TABLE "api_keys" ADD COLUMN "principal_tenant_user_id" uuid;
ALTER TABLE "api_keys" ADD COLUMN "scopes" jsonb;
CREATE INDEX "api_keys_principal_idx" ON "api_keys" USING btree ("tenant_id","principal_tenant_user_id");
```

| 检查项             | 结论                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增字段及类型     | ✅ 两列均可空：`principal_tenant_user_id uuid`（PD-01 P1 凭证主体绑定）、`scopes jsonb`（RoleScope 收窄声明）。与 `packages/db/src/schema/api-keys.ts` 的 Drizzle 定义及 `meta/0058_snapshot.json` 一致                                            |
| NULL 兼容性        | ✅ 全部存量行两列为 NULL。`principal_tenant_user_id IS NULL` → legacy 路径（`principal.ts:95-106`：权限即授权 + `[{type:'tenant'}]`，行为不变）；已绑定 key 的 `scopes NULL` → 逐字继承 principal（`packages/tenant/src/index.ts:370`）            |
| 索引               | ✅ 复合 btree `(tenant_id, principal_tenant_user_id)` 支撑 principal 解析查询（`auth.ts` 按 `principalTenantUserId` 等值查找）；`tenant_id` 前缀符合租户隔离访问模式                                                                               |
| 外键缺失的设计理由 | ✅ Schema 注释明确：复合 `(tenant_id, principal_tenant_user_id)` 无法用 `ON DELETE SET NULL`（`tenant_id` NOT NULL）；CASCADE 会在成员移除时静默删除凭证。替代：绑定写入路径校验租户一致；认证路径对 missing/inactive principal fail-closed（403） |
| 现有 API Key 兼容  | ✅ 完全兼容：所有存量 key 走 legacy 路径，权限与可见范围零变化                                                                                                                                                                                     |
| 生产存量数据影响   | ✅ 纯加列 + 建索引，无数据回填、无类型变更、无约束收紧、无表重写；对几十行量级的 `api_keys` 建索引为瞬时操作                                                                                                                                       |

## 2. 应用代码 ↔ 迁移状态兼容性矩阵（发布顺序的决定性依据）

| 场景                                               | 兼容性              | 依据                                                                                                                                |
| -------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **旧应用 + 57 migrations**（生产现状）             | ✅ 当前生产正常运行 | 现状                                                                                                                                |
| **旧应用 + 58 migrations**（迁移后、未部署新代码） | ✅ **兼容**         | 0058 纯加列；旧代码不引用新列，多出的可空列/索引对旧代码不可见                                                                      |
| **新应用 + 57 migrations**                         | ❌ **不兼容**       | `authenticateApiKey` 在认证路径 SELECT `api_keys.principal_tenant_user_id` / `scopes`（`auth.ts` P1 查询）→ 列不存在 → 认证全量 500 |
| **新应用 + 58 migrations**                         | ✅ 目标状态         | 全部测试与本地验证均在此状态运行                                                                                                    |

**结论：必须先迁移（0058）、后部署新应用。** 反向（先部署代码）会造成认证全量故障。迁移完成后**允许直接回滚旧应用版本**（见 §4）。

## 3. 迁移执行顺序与失败处理

`pnpm db:migrate`（`packages/db/src/migrate.ts`）执行序列：

1. 角色预检（`beaconhs_migrator → beaconhs_owner`；runtime/maintenance/backup 角色）
2. **`pg_advisory_lock(hashtext('beaconhs:schema-migration'))`** —— 阻止并发迁移
3. Schema 所有权验证 + 迁移账本验证（57 applied / 1 pending；未知 tracker 行报错）
4. Drizzle `migrate()` 应用 0058，随后**再次验证账本**
5. RLS 策略原子应用（单事务，191 表）；运行时最小授权收敛；kiosk PIN 哈希不变量；角色权限收敛；planner 统计；报表视图

**失败处理：** 任何一步抛错 → 进程 `console.error` + `process.exit(1)`（`migrate.ts` 尾部注释明确：绝不允许部署自动化读到 exit 0）。失败点之后的步骤不执行；已成功的前缀步骤保留（drizzle 迁移按账本幂等，重跑只应用 pending）。

**部分应用风险：** 0058 共 3 条语句。最坏部分状态 = "列已加、索引未建"——功能上无害（索引只为性能），重跑 `db:migrate` 会因账本未记录而重放，`ADD COLUMN` 将报 `duplicate column` —— 此时按账本人工登记或先 `DROP COLUMN` 后重跑（见 §4 回滚限制）。

## 4. 回滚限制

| 层                         | 策略                                                                                                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **应用回滚**（迁移成功后） | ✅ **允许直接回滚旧应用版本**：旧代码不引用新列，58-migration 数据库对旧应用完全兼容（§2）。这是本迁移"仅加列"性质带来的关键回滚自由度                                                                                                                                                        |
| **Schema 回滚**            | 无 down-migration（Drizzle 账本为 forward-only）。如必须回退 Schema：`DROP INDEX api_keys_principal_idx; ALTER TABLE api_keys DROP COLUMN scopes; DROP COLUMN principal_tenant_user_id;`（两列在未绑定任何 principal 前无数据价值）。**推荐路径仍是运行手册的备份恢复（PITR）**，而非手工 DDL |
| **迁移前失败**             | 未产生任何变更，直接重跑                                                                                                                                                                                                                                                                      |
| **迁移后 RLS/grants 失败** | 前缀已提交；RLS 步骤单事务原子 —— 失败则 RLS 未变（仍是 57 状态的既有策略），修复后重跑                                                                                                                                                                                                       |

## 5. 与生产 runbook 的一致性

- 迁移凭据与运行时凭据分离（runbook "Launch gates"）；迁移容器/操作不在长运行容器内持有备份凭据。
- 备份：生产已安装每日加密备份（`/home/xuhaoqing/.beaconhs/scripts/backup-daily.sh`）；发布预案要求**迁移前手动触发一次即时备份并确认成功**。
- 无 seed：生产禁止 `db:seed`；0058 不引入任何数据。

## 6. 结论

**0058 具备生产迁移条件**：纯加列、NULL 兼容、无 RLS 变更、对存量 API Key 行为零影响、失败路径清晰、迁移后保留旧应用回滚自由度。唯一硬性顺序约束：**先迁移、后部署**。
