# PD-01 M1 修复报告 — PATCH 归属重转移（同事务 Scope 复查）

**基线：** `684053db`（独立审查 CONDITIONAL PASS）。**状态：已关闭，经未参与修复的独立代理复核确认。**

## 1. 缺陷回顾

`patchEntity` 仅对**变更前**的行做 Scope 校验，且校验与修改不在同一事务。self-scoped key 可通过 `PATCH /documents/{own}` 将 `ownerTenantUserId` 改为其他用户，把记录移出自身 scope（HTTP 实测 200），随后该 key 对该记录失去访问权 —— 与 CREATE 侧已闭合的同类缺口（D-C）构成不对称。

## 2. 修复设计（`scope.ts` + `write.ts`）

| 组件                                                         | 内容                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assertPatchInScope(ctx, entityKey, body)`（`scope.ts`，新） | **写前 body 校验**：scoped key 的 PATCH body 中出现的 scope 定义键必须落在 scope 内 —— `bodySiteKey` ∈ 授权 site 集合；`self` scope 下 `bodyOwnerKey` 必须等于 `ctx.membership.id`、`bodyPersonKey` 必须等于 `ctx.personId`（含显式 `null`）。键缺省 = 不修改，放行                                                                       |
| `assertResultInScope(ctx, entityKey, id)`（`scope.ts`，新）  | **写后复查**：handler 执行后，行必须仍满足 `entityScopeWhere` 谓词；不满足 → 403 → **整个事务回滚**                                                                                                                                                                                                                                       |
| `patchEntity`（`write.ts`）                                  | **scoped（非 tenant）凭证**：`assertEntityInScope` → `assertPatchInScope` → handler → `assertResultInScope` 全部绑定在**同一个事务**（`ctx.db(async tx => …)`，`txCtx.db = (fn) => fn(tx)` 使 handler 内所有 `ctx.db` 复用该事务，无嵌套）。**tenant 凭证**：路径与修复前逐字节一致（`assertEntityInScope` 早返回 + handler），行为零变化 |

**关键性质：** 校验与修改同事务 → 并发重分配（TOCTOU）在写后复查中被捕获并整体回滚；**不存在"返回 403/404 但归属转移已提交"**（复查失败即回滚，数据库保持原值）。

**范围控制：** 未新增权限键、未新增 scope 类型、未改 RLS、未改 Schema、未新增迁移；tenant key 行为不变；DELETE 路径不在本缺陷范围（删除不产生归属转移）。

## 3. 测试（真实 PostgreSQL，无 Mock 替代 DB）

`apps/web/src/lib/api/patch-scope-transaction.test.ts` — 临时 `postgres:16-alpine`、专用 `probe_app` 角色（NOSUPERUSER/NOBYPASSRLS）、真实 FORCE RLS、真实 `patchEntity` → `updateDocument` handler（含事务内审计写入）。唯一 Mock 是 `next/cache`（框架 API，非数据）。

| #   | 场景（任务书 §二.M1 测试要求）                     | 结果                                                                                                                                                                                                 |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Self Key 修改普通非归属字段，成功                  | ✅ 200；title 更新、owner 不变                                                                                                                                                                       |
| 2   | Self Key 修改 `ownerTenantUserId` 为其他用户，拒绝 | ✅ 403；DB owner/title 均不变                                                                                                                                                                        |
| 3   | 拒绝后数据库归属字段保持原值                       | ✅（用例 2/3/7 三重断言）                                                                                                                                                                            |
| 4   | Tenant Key 合法修改归属，按现有业务权限处理        | ✅ 200；DB owner 落库；还原 200                                                                                                                                                                      |
| 5   | 跨租户归属目标，拒绝                               | ✅ self → 403（scope 守卫）；tenant → 400（`ensureTenantUser` + RLS 隐藏外租户主体）                                                                                                                 |
| 6   | 并发修改不出现 TOCTOU 绕过                         | ✅ 真实竞态：攻击者事务持行锁重分配 → patch 预检基于已提交态通过 → UPDATE 阻塞（`pg_stat_activity` Lock 等待断言）→ 攻击者提交 → 写后复查见 `owner=OTHER` → 403 → **patch 自身写回滚**（title 未变） |
| 7   | 事务异常后数据正确回滚                             | ✅（用例 6 即"复查失败 → 整体回滚"路径；patch 的 title 写入被回滚）                                                                                                                                  |

命令与退出码：

```bash
NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter @beaconhs/web exec vitest run \
  src/lib/api/patch-scope-transaction.test.ts
# 7 passed (7)，退出码 0
```

## 4. HTTP 集成（真实 Web + 真实 PostgreSQL + 真实 API Key）

`/tmp/opencode/pd01-m1-http.sh`，10 请求，全部符合期望：

| 场景                              | 结果                                                | DB 副作用            |
| --------------------------------- | --------------------------------------------------- | -------------------- |
| Self Key PATCH title              | 200                                                 | owner 不变           |
| Self Key 转移给他人               | **403**                                             | **无**（owner 原值） |
| Self Key 置空 / 跨租户目标        | 403 / 403                                           | 无                   |
| Tenant Key 合法转移 + 还原        | 200 / 200                                           | 按预期落库           |
| Tenant Key 跨租户目标             | 400（`No document owner with id … in this tenant`） | 无                   |
| 回归：sites PATCH                 | 404（fail-closed 不变）                             | 无                   |
| 回归：self 读他人 / tenant 读他人 | 404 / 200                                           | —                    |

## 5. 同类缺口排查（独立代理复核确认）

| 实体                                              | PATCH 可重分配的 scope 列            | 声明情况                                  | 可达性                                                                        |
| ------------------------------------------------- | ------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------- |
| `corrective_actions`                              | `siteOrgUnitId`、`ownerTenantUserId` | ✅ 已声明（`bodySiteKey`/`bodyOwnerKey`） | list-only 视图，PATCH 不可达                                                  |
| `documents`                                       | `ownerTenantUserId`                  | ✅ 已声明                                 | **可达，已闭合**                                                              |
| `training_records`                                | `personId`                           | ✅ 已声明（`bodyPersonKey`）              | list-only 视图，PATCH 不可达                                                  |
| `incidents` / `inspections` / `equipment` / `ppe` | site/holder/inspector 等             | 未声明                                    | 未映射实体 → `assertEntityInScope` 对 scoped key 一律 404，fail-closed 不可达 |

## 6. 门禁

`format:check 0 / typecheck 0 / lint 0 / test 0（26/26 任务，web 2259 通过） / deadcode:check 0 / build 0`（各自独立退出码）。

## 7. 独立复核结论（未参与修复的代理）

五项全部 CLOSED：同事务性 ✅、同类缺口无遗漏 ✅、TOCTOU 测试真实且回滚可靠 ✅、L1 清除 ✅、无兼容性破坏 ✅。附带两项后续条件：(a) M1 事务测试依赖 Docker（无 Docker 环境会失败而非跳过，CI 具备 Docker，建议后续加 skip 守卫）；(b) 未映射实体对 scoped key 整体不可写属设计内 fail-closed，若未来开放需先冻结对应 ScopeEntry。
