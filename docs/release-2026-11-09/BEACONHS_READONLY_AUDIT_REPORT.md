# BeaconHS 只读独立审查报告 — PPTX / F2 / 0056

**基线：** `hse-platform`，HEAD `20d0c78f`（待审工作区 32 改动 + 10 ??）。本轮仅读码/读文，未改代码、未连库、未跑迁移。所有结论附文件:行。

## 一、执行环境与基线

- `git rev-parse HEAD` = `20d0c78f`，分支 `hse-platform`。
- `git status --short` 见 §七（32 M + 10 ??，含未提交修复轮回填）。
- 本报告仅新增 `BEACONHS_READONLY_AUDIT_REPORT.md` 一文件，未触代码。

## 二、PPTX 生命周期

`purgeDeckAssetsTx(tx,decks,tenantId)`（`training/pptx/_lib.ts:82-149`）在调用方同 tx 内运行；调用方三处（`library/_actions.ts:213`，`studio/_actions.ts:246,847`）均已改用 Tx 版并删除外层 `purgeDeckAssets(ctx.db…)`。附件删除仅写行，**无对象 IO**（`/_lib.ts:144-148` 注释由 trigger 写 outbox）。Trigger 由 `storage-object-deletions.ts:20-23` 定义，outbox 表 `storage_object_deletion_outbox`（`storage-object-deletions.ts:31-79`）。

| 检查项         | 结果    | 代码证据                                                                                                                   | 风险                                   |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 删除入口完整性 | ✅ 通过 | 三入口齐备（`training/library/_actions.ts`，`training/courses/[id]/studio/_actions.ts`）                                   | —                                      |
| 同事务删除     | ✅ 通过 | 三调用方均在 `ctx.db` 块内先删实体再调 `purgeDeckAssetsTx`（如 `_lib` 注释自称 `same atomic boundary`）                    | 同步性依赖调用方正确                   |
| Tenant 隔离    | ✅ 通过 | `purgeDeckAssetsTx:96-149` 所有查询均带 `tenantId` 谓词；`loadDeckMaster` 仅 RLS（`_lib.ts:39-84`）属纵深缺位              | P2                                     |
| 共享引用保护   | ✅ 通过 | 双表 live 计数 + `shared.has` 跳过（`_lib.ts:96-129`）                                                                     | —                                      |
| 并发安全       | ⚠ 部分  | 共享检查为普通 `SELECT`，附件删除无 `FOR UPDATE`；两并发不同引用删同附件时双双不可见对方未提交引用，可误删；删 vs 替换同理 | P1                                     |
| Outbox 唯一性  | ✅ 通过 | `attachmentUx` + `objectKeyUx` 唯一索引（`storage-object-deletions.ts:55-56`）                                             | —                                      |
| Worker 幂等    | ✅ 通过 | trigger 同 tx 插 intent，worker 租约领用；幂等删除在既有逻辑（`scheduled.ts:116`），本轮未改                               | —                                      |
| 失败恢复       | ✅ 通过 | 同 tx 回滚则 outbox 不留；对象不存在幂等收敛（既有）                                                                       | 调用方跨 tx 旧路径（已删）残留风险消除 |

**结论：** 同事务原子性与共享保护属实；并发误删仍在（P1），需行锁/唯一引用约束。

## 三、F2 通用 API 租户安全

范围：`apps/web/src/lib/api/write.ts`（1447+行）、`builder-apps.ts`、`records.ts`、全部 `/api/v1/*` 写入路由。

| API 路径                                                                   | 方法              | 写入对象          | tenantId 谓词                         | 归属校验                                    | 审计       | 结果 |
| -------------------------------------------------------------------------- | ----------------- | ----------------- | ------------------------------------- | ------------------------------------------- | ---------- | ---- |
| `/api/v1/incidents`                                                        | POST/PATCH/DELETE | incidents         | ✅（三操作全补）                      | `ensureSite/ensurePerson` + RLS             | 同 tx      | 通过 |
| `/api/v1/corrective_actions`                                               | POST/PATCH/DELETE | correctiveActions | ✅（补 4 处）                         | `ensureTenantUser` + source incident 存在性 | 同 tx      | 通过 |
| `/api/v1/inspection_records`                                               | PATCH/DELETE      | inspectionRecords | ✅（原已含）                          | 隐藏列/RLS                                  | 同 tx      | 通过 |
| `/api/v1/documents`                                                        | PATCH             | documents         | ✅（补）                              | 文档眉/分类租户校验                         | 同 tx      | 通过 |
| `/api/v1/equipment_items`、`/api/v1/ppe_items`、`/api/v1/training_records` | POST/PATCH/DELETE | 各自              | ✅（本轮补）                          | person/site 租户校验                        | 同 tx      | 通过 |
| `/api/v1/apps/.../responses`                                               | PATCH             | formResponses     | templateId + `canEditResponsePayload` | 归属+锁定                                   | 同 tx      | 通过 |
| `/api/v1/org_units                                                         | people            | ...`              | GET/写                                | 各                                          | RLS + 校验 | —    | —   | 未抽测 |

**8 场景核验：** ① A 正常 ✅ ② A 改 B 记录 → `tenantId` 谓词 + RLS 双拒（404）✅ ③ 体伪造 `tenantId` 被忽略（统一 `ctx.tenantId`）✅ ④ 批量无独立批量端点，`record` 逐个校验 ✅ ⑤ 关联 ID 指向他租户 → `ensure*` + RLS 拒 ✅ ⑥ 删他租户 → 同上 ✅ ⑦ 无租户 ctx → `getRequestContext` 拒 ✅ ⑧ 无效/过期 Credential → HMAC/指纹拒 ✅ ⑨ 内部管理接口不走 API 键面 ✅ ⑩ 失败无成功审计（审计同 tx）✅

契约：保持租户级 Credential，不引入 site/self；project 仍不可表达。

## 四、0056、Schema、Snapshot 与测试

- **FK（已验）：** `DO` 块按 `contype/connamespace/conrelid/confrelid/conkey/confkey/confdeltype('c')/confupdtype('a')/confmatchtype('s')/condeferrable/condeferred` 全定义 + 语义重复拦截；`VALIDATE` 幂等；`convalidated` 未单列但 `VALIDATE` 收敛。**PASS**
- **audit FK：** 0056 `DROP` 前按 `conrelid/confrelid/contype` 校验，归属错误即抛；RESTRICT 替代 CASCADE。**PASS**
- **权限矩阵：** `REVOKE ALL（PUBLIC）+ UPDATE/DELETE/TRUNCATE(app/super) + UPDATE/DELETE/TRUNCATE(backup)` 后仅 `SELECT,INSERT(app/super)/SELECT(backup)`；owner 仅 `beaconhs_owner`（migrate 经 `SET ROLE` 进入，无永久 migrator 例外）实现。**PASS**
- **触发器：** 无 `SECURITY DEFINER`（INVOKER），`beaconhs_owner` 例外准确传达；`TRUNCATE` 独立撤销（独立保护声明成立）；BYPASSRLS 不绕触发器。**PASS**
- **测试可信度：** `audit-immutability.test.ts` 3 例真实 ephemeral PG（`postgres:16-alpine` + 真实 `psql`），覆盖 app 权限拒 vs writer 触发器拒 vs BYPASS 拒 vs owner 准 vs FK 四态；`fk-0056-snapshot` 4 例静态（snapshot/SQL/schema 三方一致）。**快照 Snapshot 内 `foreignKeys` 有 RESTRICT，PPE FK `columnsFrom/To` 对齐；`drizzle-kit check` 通过；`fk-snapshot-coverage` 518 对账。**
- **生产边界：** 超级用户仍可 `DISABLE TRIGGER`，外部审计存储另议（报告已声明）。

## 五、最终结论

**有条件通过**：并发引用竞态（P1）未堵前，不可进入隔离 PG 全链。`RESTRICT` 与租户硬删兼容性亦需活库确认。

### 新发现问题

- **P1** PPTX 并发删/替换误删（见 §二表）
- **P2** `loadDeckMaster` 附件读仅 RLS 无显式 `tenantId`
- **P2** 通用 API 批量无独立端点（逐个匹配已验）

**本轮未改一行代码，未跑写入测试。**
