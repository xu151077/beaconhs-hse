# BeaconHS 合并前最终独立审查报告

## 1. 基本信息

- 日期：2026-11-09
- 分支：`hse-platform`；HEAD：`20d0c78f`
- 工作区：33 修改 + 14 未追踪（`git status --short` 50 行，含 34 diff 文件）
- 范围：全部变更、0056/Schema/Snapshot/Journal、F1/F2/A3、PPTX 四写入、原生权限架构、只读工程检查、历史报告交叉核验
- 本轮只读：除本报告外未写任何文件；未执行 Migration/A3/DB 操作；未改代码

## 2. 变更文件清单（摘要）

| 类          | 文件                                                                                                                                                 | 目的                                       | 必要性         | 风险               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------- | ------------------ |
| 0056        | `0056*.sql`、`0056_snapshot.json`、`_journal.json`(56/idx42 缺号保留)                                                                                | FK 全定义幂等 + 审计保护                   | 必须           | 中（已真机验证）   |
| 0056 Schema | `audit.ts`、`ppe.ts`                                                                                                                                 | RESTRICT + 复合 FK                         | 必须           | 低                 |
| PPTX 锁     | `training/pptx/_lib.ts`、`pptx/_actions.ts`、`library/_actions.ts`、`studio/_actions.ts`                                                             | 4 入口统一 `FOR UPDATE`                    | 必须           | 低（G/H/I 证）     |
| F1/F2       | `builder-apps.ts`、`write.ts`（19 处 tenant 谓词）、`documents/export`、`people/files                                                                | titles`、`insights/_actions`、`training/*` | 越权/隔离/孤儿 | 必须               | 低  |
| 测试        | `audit-immutability`、`fk-0056-snapshot`、`pptx-concurrency-pg`、`security.test`、`fk-snapshot-coverage`、`production-cutover-integrity`、`phase11f` | 真 PG/合同覆盖                             | 必须           | 低                 |
| 构建        | `next-env.d.ts`（build 生成）                                                                                                                        | —                                          | 可弃（非整改） | **不建议随此合并** |
| 报告 13 份  | `BEACONHS_*`（+`TEST_HOST_*`）                                                                                                                       | 证据                                       | 必须（历史）   | 无                 |

⚠ `next-env.d.ts` 是 dev/build 自动产物，非安全整改，不应与整改一同合并（误合并仅回退路径差异，无功能影响，但污染 diff）。

## 3. 安全核查表

| 模块           | 结果         | 证据                                                                                    | 遗留                                                             |
| -------------- | ------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| F1             | ✅           | `builder-apps.ts:664 canEditResponsePayload` 403                                        | 无                                                               |
| F2             | ✅（租户级） | `write.ts:368,428,461…` 全带 `tenantId=ctx`；伪造 tenantId 被上下文覆盖                 | site/self 二次可见性=产品决策；审计回溯=产品决策                 |
| A3             | ✅           | `people/_actions/files.ts:41,97,134` tenant 谓词；`_master-actions.ts` 孤儿清           | A3 Apply 仍未执行（目标在库？未运行）                            |
| PPTX           | ✅           | 4 写入口锁：`_lib:108`/`_actions:351`/`library:171`/`studio:91,842`                     | `loadDeckMaster` 仅 RLS（P2）                                    |
| Outbox         | ✅           | trigger 同 tx + 唯一约束 + 租约幂等                                                     | 无（真 PG A–I）                                                  |
| Audit Log      | ✅           | RESTRICT + INVOKER trigger + backup 拒                                                  | runner 全表授权会回授 app UPDATE/DELETE→trigger 兜底（设计如此） |
| RLS            | ✅           | forced `tenant_isolation`，防混（A 1/B 0）                                              | 无（真 PG）                                                      |
| Migration 0056 | ✅           | 0055 哈希 `b63fd97d…` 未改；journal 56/42 缺号；snapshot/ schema 一致；drizzle-check 过 | 直接 SQL 在硬化后重放 `schema public denied`（顺序属性，非缺陷） |

## 4. 架构一致性

Permission/Role Scope/Tenant Scope/RLS **保持原生**：`studio` 仍走 `assertCanManageModule`；API 仍用 `ctx.tenantId` + 原生 predicate + RLS 双层；**无新平行权限系统**、无 role 字符串硬编码、无超管绕过新增。F2 未把 UI `moduleScopeWhere` 套入 API（契约保持）。

## 5. 工程质量（本轮实测，只读）

| 检查                  | 本轮     | 说明                                                                          |
| --------------------- | -------- | ----------------------------------------------------------------------------- |
| format:check          | ✅ 0     | 只读                                                                          |
| lint                  | ✅ 0     | 只读                                                                          |
| typecheck(web+tenant) | ✅ 0     | 只读                                                                          |
| deadcode:check        | ✅ 0     | 只读                                                                          |
| drizzle-kit check     | ✅ fine  | 只读                                                                          |
| build                 | ⏭ 跳过   | 写 `.next` 缓存，违反本轮只读边界；上轮 `--force` 4/4 通过                    |
| DB/真 PG 测试         | ⏭ 未重跑 | 隔离容器已清理；引用 `BEACONHS_ISOLATED_PG_FULL_MIGRATION_REPORT`（历史证据） |

未发现调试代码、凭证、测试 bypass 新增；`any` 新增仅迁移 runner 既有。

## 6. 遗留事项

- **P0：无**
- **P1：无**（PPTX 已合上）
- **P2**：`loadDeckMaster` 读仅 RLS 无显式 tenant 谓词；`next-env.d.ts` 误随合并建议剔除
- **产品决策**：F2 通用 API site/self 二次可见性；审计历史是否需二次可见性；A3 回填目标在库未定位
- **已知限制**：直接 SQL 在 grants 硬化后重放被顺序拒绝（runner 顺序已规避）；备份仅逻辑 dump 序列（角色级对象另议）

## 7. 合并建议

**有条件建议合并**：全部阻断已清，隔离真 PG 全链通过，门禁静态全绿。合并前必须：① 剔除 `apps/web/next-env.d.ts`（非整改产物）；② 确认不将 MinIO/生产 Secret/隔离凭证、`.env` 片段带入；③ 三项产品决策书面留痕（F2 site/self、审计回溯、A3 目标）。

本轮仅出报告，未执行任何合并/提交/推送/部署/迁移。
