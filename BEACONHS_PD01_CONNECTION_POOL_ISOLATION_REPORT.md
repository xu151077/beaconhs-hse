# PD-01 Phase 3 专项 A — PostgreSQL 连接池复用与事务上下文隔离报告

**测试性质：真实 PostgreSQL（临时 `postgres:16-alpine` 容器）+ 项目真实连接池实现 + 项目真实 `withTenant()`。无 Mock。**
**被测对象：** `packages/db/src/rls.ts` 的 `withTenant`（`db.transaction` + `set_config('app.tenant_id', ${tenantId}, true)`）。

## 1. 环境构造方式

| 项       | 做法                                                                                                                                                                 | 目的                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 数据库   | `docker run --name beaconhs-pool-<ts> postgres:16-alpine`（随机主机端口）                                                                                            | 独立、可丢弃，绝不接触生产                                               |
| 登录角色 | `probe_app`：`LOGIN`、`NOSUPERUSER`、`NOBYPASSRLS`                                                                                                                   | 让 `FORCE ROW LEVEL SECURITY` 真正生效，排除"超级用户绕过"的假通过       |
| 探针表   | `tenant_isolation_probe(id, tenant_id, payload)`，`ENABLE` + `FORCE ROW LEVEL SECURITY`，策略 `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` | 与生产策略同构                                                           |
| 连接池   | `postgres(url, { max: 1 })`                                                                                                                                          | **强制所有事务复用同一个物理连接**，物理复用可被 `pg_backend_pid()` 观测 |
| 被测调用 | 项目真实 `withTenant(appDb, tenantId, fn)`                                                                                                                           | 不是自写替身                                                             |

**物理复用证据：** 每个 `withTenant` 内先执行 `select pg_backend_pid()` 记录 PID，断言跨租户调用得到的 PID 集合大小为 1 —— 证明不是"同一个池对象"，而是**同一个后端进程**。

## 2. 场景 → 断言对照（任务书 §3.2 全覆盖）

| #   | 任务书场景                              | 测试 | 断言                                                                                         |
| --- | --------------------------------------- | ---- | -------------------------------------------------------------------------------------------- |
| 1   | 同一物理连接先后执行 Tenant A、Tenant B | 1+2  | A 提交 1 行；B 计数 0；两租户 `pg_backend_pid()` 相同                                        |
| 2   | A 正常提交后连接被 B 复用               | 1+2  | 同上（B 复用 A 的连接）                                                                      |
| 3   | A 异常回滚后连接被 B 复用               | 3    | 抛出 `force rollback`；A 计数仍为 1（仅已提交行）；B 复用同一 PID；事务后无 GUC 残留         |
| 4   | A 事务中途抛异常后连接被正确释放        | 4    | 抛出 `mid-flight`；下一租户事务拿到同一 PID；无 GUC 残留                                     |
| 5   | 多租户并发共享同一连接池                | 5    | `Promise.all` 并发；PID 集合为 1；A 计数 2、B 计数 1（各自正确，无交叉）                     |
| 6   | 查询执行过程中连接池复用不交叉          | 1–5  | 每个租户的 `count(*)` 只看到自己租户的行                                                     |
| 7   | 空租户上下文 / 缺失租户上下文           | 6    | 无上下文与空串上下文 `count(*)` 均为 0（RLS 第二层兜底）                                     |
| +   | 跨租户写入（附加）                      | 7    | `WITH CHECK` 拒绝 A 租户事务写入 B 租户行；B 计数不变                                        |
| +   | 上下文设置语义（附加）                  | 8    | 源码断言 `set_config(..., true)`（事务级），且不存在 `SET ROLE` / `SET SESSION` / `SET app.` |

## 3. 关键实现审查（任务书 §3.3 要求）

| 项                                   | 结论                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SET` vs `SET LOCAL` vs `set_config` | 仅使用 `set_config('app.tenant_id', ${tenantId}, true)`。第三参 `true` 即 `SET LOCAL` 语义，事务结束自动失效。**无会话级设置。**            |
| `RESET`                              | 不需要显式 `RESET`：`SET LOCAL` 在事务结束时由 PostgreSQL 自动清理，异常回滚路径同样清理（测试 3/4 已证）。                                 |
| 事务边界                             | `withTenant` 在 `db.transaction(async tx => { set_config(...); return fn(tx) })` 内设置，设置与业务查询处于**同一事务**，不存在跨事务边界。 |
| 身份残留                             | 未使用 `SET ROLE`，未修改会话级变量；`current_setting('app.tenant_id', true)` 在事务外读取为 `''`（未设置），证明无残留。                   |
| 错误路径                             | 回滚与中途异常均不残留上下文（测试 3、4）。                                                                                                 |
| 连接池复用                           | `max:1` 下多租户复用同一 `pg_backend_pid()`，且无上下文交叉（测试 1、5）。                                                                  |

## 4. 执行命令与结果

```bash
NODE_OPTIONS=--max-old-space-size=6144 \
  pnpm --filter @beaconhs/db exec vitest run src/connection-pool-isolation.test.ts \
  --reporter=verbose
```

| 指标     | 值                                                  |
| -------- | --------------------------------------------------- |
| 测试文件 | `packages/db/src/connection-pool-isolation.test.ts` |
| 用例数   | **7**                                               |
| 通过     | **7**                                               |
| 失败     | 0                                                   |
| 退出码   | **0**                                               |
| 输出     | `Test Files 1 passed (1) / Tests 7 passed (7)`      |

### 测试分层统计（本专项）

| 层                                | 数量                                | 退出码 |
| --------------------------------- | ----------------------------------- | ------ |
| **连接池隔离（真实 PostgreSQL）** | **7/7**                             | 0      |
| Mock                              | 0（明确声明：本专项不使用 Mock）    | —      |
| 纯逻辑                            | 0（连接池隔离必须真实 PG 才能证明） | —      |

## 5. 发现与修复

本专项**未发现缺陷**，无需修复。`withTenant` 的事务级上下文实现正确，异常与回滚路径均正确清理。

## 6. 局限与剩余风险

- 测试用 `max:1` 强制物理复用，比生产配置更强（生产默认池更大）。更大的池只会减少复用频率，不会引入新的上下文泄漏路径；事务级设置的清理语义与池大小无关。
- 未覆盖 `withSuperAdmin` / `withTenant` 跨连接池混用的场景（超管走独立 BYPASSRLS 池，见 `rls.ts`），该路径不属于"租户请求复用连接"的隔离问题。
- 未覆盖 PgBouncer 事务池模式下的 `SET LOCAL` 兼容性；本地与生产均使用应用内 `postgres` 驱动直连，无中间池。
