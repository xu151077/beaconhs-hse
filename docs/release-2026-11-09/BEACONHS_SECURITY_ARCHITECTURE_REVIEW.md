# BeaconHS 安全架构评审 — 2026-11-09

## 1. 权限架构

目录 `packages/db/src/schema/iam.ts` 108 键；`can(ctx,key)` 宽泛 `read.all→read.site/self`，`keyHasPermission` 是子集谓词；deny-wins 覆盖串联。统一事实源：`packages/tenant`。本轮不新增平行体系， builder 与生命周期均复用 `canEditResponsePayload`。

## 2. Tenant Scope 与 RLS

- `RoleScope` 仅 `tenant/sites/team/people/crews/self`，**无 project**（基线 §12 设计约束，未手写 project 过滤）。
- `tenant_users`、其余 190 表在 `TENANT_SCOPED_TABLES`，`FORCE RLS` + `tenant_id = current_setting('app.tenant_id')`，`GUC` 经 `set_config(..,true)` 包库存取；`withSuperAdmin` 恒走 `superDb`，`createClient super` 仅运维脚本。
- 应用与库两层均断言：写面 SQL 层带 `tenant_id` 谓词（本轮补 incident/仪表盘/附件），读面补 `canSeeRecord/moduleScopeWhere`。

## 3. API 写入契约

| 资源族                  | 契约                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Builder responses       | 白名单（`patchBody.strict()`）→归属（`canEditResponsePayload`）→锁定/校验→原子更新→审计同 tx |
| Incidents（`write.ts`） | 白名单 `incidentPatch`→`FOR UPDATE + tenantId` 锁→状态机→同 tx 审计                          |
| 通用读面（GET）         | 仅 `*.read.all` 的 key，租户内全量；site/self 课户不适用 API key                             |

通用 API 的 tenant-credential 契约维持（F2）：key 即租户级主体，不享 UI tier；跨租户由 RLS 兜底。

## 4. 附件生命周期

预约（tenant 命名空间 `t/<tenantId>/`）→ `stagingKey`→`promote`→`attachments` 行；下载只走内部流式 + 会话/RLS + cap 双门；删除经 trigger 入 `storage_object_deletion_outbox` 由 worker 幂等清理；1:1 关系同事务连带删附件防孤儿。

## 5. 审计不可篡改

当前 `audit_log` 普通角色可 `DELETE` 是应用层纪律缺口。迁移 `0056` 以触发器 `BEFORE UPDATE OR DELETE` 在 `current_user <> beaconhs_owner` 时抛 `audit_log is append-only`，`INSERT` 仅准；`TRUNCATE`/cascade/owner 路径另行评审。写入与业务同 tx，失败则业务回滚。

## 6. 迁移规范

- 只追加【0056】：`DO $IF NOT EXISTS` + `VALIDATE` 幂等收敛 0055 的 `att_tenant_ppe…` FK；快照 `0056_snapshot.json` 与 journal `idx 56` 线性链入；测试锚定禁改历史文件、禁改 allowlist。
- 0054 保留单 `DO` 循环（`set_config(...,true)` 仅在单语句内有效）。

## 0056 专项复核补充（2026-11-09）

- 角色例外已收敛为仅 `beaconhs_owner`（migrate 经 `SET ROLE` 进入）；注释已同步，`migrator` 无永久例外。
- 触发器为 SECURITY INVOKER（非 DEFINER），BYPASSRLS 不绕过；`REVOKE TRUNCATE` + 仅 `SELECT,INSERT` 授权 app/super。
- FK 按全定义（表/引用/列/动作/验证态）幂等；同名异定义抛错；`audit_log` FK 改 `ON DELETE RESTRICT` 防级联清痕。
- `fk-snapshot-coverage` 未覆盖 0056，为已知缺口，靠 `audit-immutability.test.ts` 真实 PG 覆盖。

## 0056 最终核验补充（独立验收复核后）

- FK 幂等已升级为全定义：表/引用列/动作/validation + 语义重复约束拦截。
- audit FK 改 `RESTRICT`（租户级联删禁删痕）；触发器 SECURITY INVOKER，错误文案/注释与实现一致（仅 owner）。
- backup 补 `REVOKE UPDATE,DELETE`；TRUNCATE 显式撤销；BYPASSRLS 不绕触发器。
