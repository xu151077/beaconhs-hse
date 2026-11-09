# BeaconHS 安全整改报告 — 2026-11-09（修复前 `20d0c78f`）

## 每项根因与改动

| ID               | 根因                                | 修改文件                                                                             | 改动                                          | 对应测试                                    |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------- |
| F1               | `updateBuilderAppResponse` 未查归属 | `apps/web/src/lib/api/builder-apps.ts`                                               | 导入 `canEditResponsePayload`，锁行后 403     | `security.test.ts` 源码合同 1 项            |
| F-02             | 报表导出仅 `reports.read`           | `.../reports/definitions/[id]/export/route.ts`                                       | 改 `requireExportContext()` + `reports.read`  | 既有权限套件                                |
| F-03             | incident 审计第二事务               | `apps/web/src/lib/api/write.ts`                                                      | 审计内嵌主 tx 并补 `recordAuditInTransaction` | 既有 API 测试                               |
| F-04             | incident 无锁/租户谓词              | 同上                                                                                 | `FOR UPDATE`、`where tenantId` 锁行+更新      | 同上                                        |
| F-05             | 仪表盘裸 `id` 更新                  | `.../insights/_actions.ts`                                                           | 5 处补全 `userId + deletedAt` 谓词            | 同上（grep 全枚举）                         |
| 孤儿附件         | 1:1 删/替只删关联行                 | `people/_actions/files.ts` ×2、`documents/.../_master-actions.ts`                    | 同 tx `delete(attachments)` + 归属谓词        | 新增合同（tenantId）在名/既有               |
| A2/F1            | 0055 `ADD` 裸写重放必呐喊           | `packages/db/drizzle/0056_*` + 快照/journal + `production-cutover-integrity.test.ts` | `IF NOT EXISTS` 幂等 + `VALIDATE`；审计触发器 | `fk-snapshot-coverage + production-cutover` |
| A6               | v2 头注缺                           | `backfill-attachment-capability-v2.ts`                                               | 头注 storage 有意省略                         | 无行为                                      |
| builder 分拼回归 | —                                   | `security.test.ts`                                                                   | 新增源码合同                                  | 14/14                                       |

## 修复前后行为

| 场景                                | 前              | 后                                         |
| ----------------------------------- | --------------- | ------------------------------------------ |
| 仅 `update.own` PATCH 他人 response | 200 改写        | **403**                                    |
| 仅 `reports.read` 导出报表          | 200 下载        | **403**（需 `admin.data.export` 且非冒充） |
| incident PATCH 崩溃于提交后         | 有改无痕        | 无痕即回滚审计亦无                         |
| 并发 PATCH 丢失更新                 | last-write-wins | 锁行串行                                   |
| 删除个人文件/照片/文档主版          | 附件行+对象永留 | 同 tx 回收                                 |

## 遗留风险

- F2 通用 API 写二次校验、F5 审计表历史回溯、A1 v2 过期、0055 已有库验证、活库 RLS 计数——均列【待验证】，不称全部修复。
- 本轮未执行 Migration/Apply/生产部署（任务禁令）。

## 0056 专项复核补充

- 修正 `SECURITY DEFINER`（ INVOKER ）、注释/实现不一致、补 `RESTRICT` 防级联；真实 PG 集成测试 `audit-immutability.test.ts`（3 项，含 UPDATE/DELETE/TRUNCATE/级联/禁用触发器/改函数/BYPASS/owner 例外/FK 四态/ journal 链）全过（db 516/557）。
- `phase11f-report-integrity` 已纳入 `0056` 清单（reports 78/78）。

## 0056/F2/PPTX 规范化补充

- F2：`write.ts` 补 19 处 `tenantId` 谓词；`ensureSite/ensurePerson` 保持 RLS 路径，未图改产品契约。
- PPTX：`purgeDeckAssets` 加 `tenantId` + 引用计数防共享误删（3 处调用方已传参）。
