# PD-01 最终审查附录 — M1/L1 关闭复核与结论更新

**基线：** 独立安全审查 `BEACONHS_PD01_INDEPENDENT_SECURITY_AUDIT.md`（CONDITIONAL PASS，条件：M1 闭合或产品接受、L1 修正、其余限制随行）。
**本附录：** 记录 M1/L1 关闭实施、独立复核结果与结论更新。实施提交见最终 Git 状态；未 push。

## 1. 实施摘要

| 项     | 变更                                                                                                                                                                                                       | 报告                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **M1** | `patchEntity` 对 scoped 凭证将「行 Scope 预检 → `assertPatchInScope`（body 归属校验）→ handler 写入 → `assertResultInScope`（写后复查）」绑定在**同一事务**；复查失败即整体回滚。tenant 凭证路径逐字节不变 | `BEACONHS_PD01_M1_REMEDIATION_REPORT.md` |
| **L1** | 删除 `narrowPermissions` 不可达通配符分支；修正注释；无能力新增                                                                                                                                            | `BEACONHS_PD01_L1_REMEDIATION_REPORT.md` |

变更文件：`apps/web/src/lib/api/scope.ts`（+`assertPatchInScope`/`assertResultInScope`，导出 `isTenantScope`）、`apps/web/src/lib/api/write.ts`（patchEntity 事务化）、`apps/web/src/lib/api/principal.ts`（L1）、新增测试 `patch-scope-transaction.test.ts`、扩展 `principal.test.ts`。

## 2. 验证（分层，不合并计数）

| 层                  | 内容                                                                                                                                                  | 数量         | 退出码   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------- |
| **真实 PostgreSQL** | `patch-scope-transaction.test.ts`：7 场景含**真实 TOCTOU 竞态**（攻击者持行锁 → patch 预检通过 → UPDATE 阻塞 → 攻击者提交 → 写后复查拒绝 → 整体回滚） | **7/7**      | 0        |
| **真实 PostgreSQL** | `scope-pg.test.ts`（回归）                                                                                                                            | **10/10**    | 0        |
| **纯逻辑**          | `scope-create-logic.test.ts`（回归）+ `principal.test.ts` 14–17                                                                                       | 8/8 + 4 新增 | 0        |
| **HTTP 集成**       | M1 矩阵 10 请求：self 转移 403 / 置空 403 / 跨租户 403、tenant 合法转移 200、tenant 跨租户 400、sites 404 回归、DB 副作用逐项核对                     | 10 请求      | 全部符合 |
| 门禁                | format 0 / typecheck 0 / lint 0 / test 0（26/26，web 2259 通过）/ deadcode 0 / build 0                                                                | —            | 各自 0   |

## 3. 独立复核（未参与本轮修复的代理，实际运行）

代理自行查看源码与测试并在本机**实际运行**了两套测试（principal 18/18、patch-scope 7/7），五项结论：

1. **M1 已关闭** — 预检/写入/写后复查在同一事务（`withTenant` = `db.transaction`；`txCtx.db = (fn) => fn(tx)` 复用同一 tx，无嵌套）；复查抛 403 即回滚；幂等重放不构成绕过（只回放缓存的已完成响应，从不重执行）。
2. **无遗漏的同类缺口** — 三个已映射实体的全部可重分配列均已声明（`bodySiteKey`/`bodyOwnerKey`/`bodyPersonKey`）；四个未映射实体的归属列**fail-closed 不可达**（`assertEntityInScope` 一律 404）。
3. **回滚证明真实** — 测试 6 构造了真锁等待（`pg_stat_activity` Lock 断言）；title 断言只能在"patch 自身写入已回滚"时成立。条件性弱点：依赖 Docker（CI 具备）；测试 6 的 title 断言耦合用例 1 的状态（顺序依赖 fixture）。
4. **L1 已清除** — 死分支删除、注释不再声称通配符、无能力新增、测试 17 源码契约钉住。
5. **无兼容性破坏** — 未绑定/tenant/sites/self 四类凭证行为核对：新 403 恰为预期的归属/站点转移阻断；无任何既有合法流程被新增拒绝。

**独立代理结论：PASS**（M1/L1 视角），并要求随行两项条件：(a) M1 事务测试建议增加 Docker-less skip 守卫；(b) 未映射实体保持 fail-closed 不可写，未来开放前必须先冻结对应 ScopeEntry。

## 4. 结论更新：**PASS（具备进入发布候选审查的条件）**

原 CONDITIONAL PASS 的闭合条件现已满足：

| 原条件                                     | 状态                  |
| ------------------------------------------ | --------------------- |
| M1 闭合（post-patch scope 复查）或产品接受 | ✅ 已闭合并经独立复核 |
| L1 修正（死分支 + 注释矛盾）               | ✅ 已闭合并经独立复核 |
| R2/R3/R6/R7 作为已知限制随行               | ✅ 保持随行（见下）   |

**随行限制（非阻断，必须进入发布候选审查的已知限制清单）：**

| 项   | 内容                                                                         | 性质                             |
| ---- | ---------------------------------------------------------------------------- | -------------------------------- |
| R1   | 4/7 实体未实施，非 tenant scope 下 fail-closed                               | 产品冻结等待态                   |
| R2   | `corrective_actions`/`training_records` 视图 list-only                       | 设计限制                         |
| R3   | site scope 无法读 documents/training_records（无 site 列）                   | fail-closed 功能缺口，需产品决策 |
| R4   | self key 不能创建 corrective_actions                                         | fail-closed                      |
| R6   | Builder 元数据路由无 scoped 守卫（仅模板元数据）                             | 需产品决策是否收紧               |
| R7   | 幂等重放不重跑 `[entity]` 路由守卫                                           | 低风险实现取舍                   |
| 新增 | M1 事务测试建议加 Docker-less skip 守卫                                      | 测试质量                         |
| 新增 | 0058 无 FK on `principal_tenant_user_id`（悬空 → 403 fail-closed，有意设计） | 设计决定                         |

**未发现阻断发布的问题。** 本 PASS 不改变 R1/R3 等产品决策的待办性质 —— 它们随发布候选审查继续跟踪。
