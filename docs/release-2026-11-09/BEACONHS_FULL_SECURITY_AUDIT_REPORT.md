# BeaconHS 全量安全审计报告 — 2026-11-09（HEAD `20d0c78f`+）

基线：分支 `hse-platform`，复核对象为当前工作区代码（未信历史 PASS）。未连生产库、未跑 Audit、未 Migration。

## 范围与模块覆盖

| 模块                                              | 检查                                                  | 结论                                               |
| ------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| 全部 API Route（17）                              | 逐文件读路由/鉴权/参数/状态码                         | F1,F2 已修复；F3 设计如此                          |
| 全部 Server Actions（112 文件 grep + 高风险深读） | `requireRequestContext/assertCan/canSeeRecord`        | 通过                                               |
| 数据访问层/查询                                   | 白名单标识符、绑定参数、`sql.raw` 呼叫点              | 通过                                               |
| Permission/RoleScope/TenantScope                  | 目录 108 键 vs 91 调用、六变体、deny-wins             | 通过                                               |
| RLS Policy / DB 角色                              | 注册表 191 表等价、FORCE、GUC/tx 边界、app/super 分池 | 静态通过；活库待验证                               |
| 附件上传/下载/删除                                | 预约模型、tenant 命名空间、cookie+cap 双门、outbox    | 通过 + A3 删除谓词硬化                             |
| 审计日志 写入/读/改/删                            | 写入/读取门控、双归因                                 | 写原子性已修复；不可变需 trigger（见 remediation） |
| 级联/附件关联                                     | 软删 vs 硬删 FK/trigger                               | 3 处孤儿已修 2，`pptx/_lib` 待办                   |
| 迁移/快照/执行机制                                | 55→56 链、快照等值、`--apply` 锁/CAS                  | 通过；0055 重放补 0056                             |
| 后台/定时/Webhook/内部接口                        | domain-event HMAC、outbox 认领、egress SSRF           | 通过                                               |
| 并发/事务/异常恢复                                | `FOR UPDATE`、幂等、编排删除                          | F-04 已补 incident                                 |
| 导出/搜索/统计/报表                               | `requireExportContext`、搜索门控                      | 报表导出已堵                                       |

## 发现（风险等级 · 证据 · 判定）

- **F1 High (已修复)**：`apps/web/src/lib/api/builder-apps.ts` PATCH 未调 `canEditResponsePayload`，仅查 `forms.response.update.own`。根因即权限断层（路由查键，handler 未查归属）。现补调用，见 REMEDIATION。
- **F2 Medium (待验证)**：通用 API 写不在位二次可见性；硬塞 `moduleScopeWhere` 误杀无 `read.all` 的 key，须产品契约裁决。
- **F5 Medium (已修复)**：报表导出仅 `reports.read`，绕 `admin.data.export` + 冒充拦截；已改 `requireExportContext`。
- **F-03 Medium (已修复)**：`write.ts` incident 三操作审计在第二事务，崩溃留无痕；现审计随主事务。
- **F-04 Low-Med (已修复)**：incident 先查后写无 `FOR UPDATE`，缺 `tenantId` 谓词；已锁行并在 SQL 层断言租户。
- **F-05 Low (已修复)**：Insights 仪表盘更新仅按 `id`；已收敛 owner 谓词。
- **A2/F1 高 (已修复)**：0055 裸 `ADD` 重放必呐喊；新补偿迁移 `0056` 以 `IF NOT EXISTS + VALIDATE` 收敛。
- **孤儿附件 (已修复)**：`files.ts`（照片/个人文件）与 `master-actions.ts`（文档主版）删 1:1 附件同事务。
- **设计风险/非问题：** v2 永久承载（A1）、公开发现接口（F3）、Logo 已对齐（A4）、verify 非对称 TTL（A5）、0054 租户循环已幂等、0055 快照沉默为有意清单。

## 未验事项

活库 RLS 计数、`beaconhs_app` 无租户零行断言、业务 admin 冒充导出与真机 E2E、并发竞态实跑——均列待验证，不在本轮结论内。
