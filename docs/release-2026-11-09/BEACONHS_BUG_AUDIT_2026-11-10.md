# BeaconHS Bug 审计与修复 — 2026-11-10

**基线：** `hse-platform @ 0fdb46b3`（与 `origin` 同步）
**范围：** 项目级运行时缺陷审计（非安全审计、非新功能）
**结论：** 修复 1 类系统性缺陷（16 个文件）；1 项已登记缺陷受保护约束未改，待授权。

## 1. 审计方法

- 定向模式扫描：空 catch / 吞错误、`process.env ??` 空串回退、`z.enum` 与 pgEnum 漂移、分页/边界、`toISOString` 时区、TODO/FIXME、测试 skip
- 交叉核对：`AGENTS.md` 缺陷登记、`docs/project-development-state.md` 开放项、生产库运行指标
- 生产只读验证：`domain_event_outbox` 全 published、`compliance_dispatches` 0 错误、outbox 0 堆积

## 2. 已修复：用户可见日期用 UTC「今天」（P2）

**根因**：`new Date().toISOString().slice(0, 10)` 永远返回 UTC 日期。服务器/浏览器时区非 UTC 时，"今天"会差一天，导致：

- 纠正措施 `assignedOn` / `dueOn` **写入错误日期**
- PPE 证书下次到期**预览与服务器存值不一致**（预览 7/12、实存 7/13）
- 培训钱包/我的任务/PPE/设备到期状态**提前或延后一天**
- 管理评审 `periodEnd` 默认值错误
- 车辆日志"本月已过天数"错误
- 培训日历"今天"高亮错位

**修复**：新增纯日期算术辅助（`apps/web/src/lib/datetime.ts`）：

| 函数                            | 用途                                      |
| ------------------------------- | ----------------------------------------- |
| `addDaysToIsoDate(iso, days)`   | 日期列加天数，UTC 算术，不受 DST/时区影响 |
| `addYearsToIsoDate(iso, years)` | 日期列加年（2/29 → 3/1，与既有行为一致）  |
| `todayIsoLocal(now?)`           | 客户端组件用浏览器本地"今天"              |

服务端统一 `dateIsoInTimeZone(new Date(), ctx.timezone)`，客户端统一 `todayIsoLocal()`。

**改动文件（16）**

| 文件                                           | 修复点                                                          |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `lib/datetime.ts`                              | 新增 3 个辅助 + 抽取 `shiftIsoDate`                             |
| `lib/datetime.test.ts`                         | +3 组测试（跨月/跨年/闰日/DST/本地日）                          |
| `ppe/_lib.ts`                                  | CA `today` + `dueOn`                                            |
| `inspections/_lib.ts`                          | CA `assignedOn` + `dueOn`（基于 occurredAt 的租户日）           |
| `documents/management-reviews/[id]/actions.ts` | `periodEnd` 默认值                                              |
| `my/wallet/page.tsx`                           | 到期判断 `today` / `expiringThrough`                            |
| `my/tasks/page.tsx`                            | 逾期判断 `todayStr`                                             |
| `equipment/vehicle-log/_service.ts`            | 本月已过天数                                                    |
| `equipment/vehicle-log/new/page.tsx`           | `presetDate` / `initialDate`（并把 `ctx` 提前到默认值计算之前） |
| `ppe/[id]/page.tsx`                            | `today`、`todayIso`、`nextDueOn`                                |
| `ppe/[id]/_certificate-drawer.tsx`             | 下次到期预览（客户端）                                          |
| `ppe/_drawers.tsx`                             | 客户端"今天"（原注释错误声称 `toISOString()` 是本地日期）       |
| `equipment/[id]/page.tsx`                      | `todayIso` + 3 处表单默认日期                                   |
| `equipment/_maintenance-drawers.tsx`           | 客户端 `todayIso()` helper                                      |
| `training/classes/calendar/page.tsx`           | "今天"高亮 + `buildGrid` 增 `timeZone` 参数                     |
| `training/courses/[id]/_workspace.tsx`         | 客户端"今天"                                                    |

## 3. 未修复（需授权）

| 项                                                                                                                                                           | 原因                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/storage/src/index.ts:47-50`：`R2_*` 用 `??`，`.env.example` 提供空字符串 → 本地 `pnpm dev` 得到空 accessKey/secretKey，S3 签名失败且报错不指向配置 | `AGENTS.md` 明确「**Never** edit `packages/storage/**` … without an explicit request」。修复为 4 行（`??` → `?.trim() \|\| 默认值`），需你一句确认 |

## 4. 门禁（全部通过，各自退出码）

| 门禁             | 结果                                         |
| ---------------- | -------------------------------------------- |
| `format:check`   | 0                                            |
| `typecheck`      | 0（27/27）                                   |
| `lint`           | 0                                            |
| `test`           | 0（26/26；web **2216 passed** / 13 skipped） |
| `deadcode:check` | 0                                            |
| `build`          | 0（4/4）                                     |

## 5. 未提交

改动仅在工作区，**未 commit / 未 push / 未部署**。工作区另含 `apps/web/next-env.d.ts`（build 产物，不提交）。
