# BeaconHS 全面项目审计报告（2026-11-11）

**性质：只读审计 + 下一步任务梳理。本轮未实施任何修复。**
**基线：** HEAD `f463f415`，分支 `hse-platform`，工作区 clean，`origin/hse-platform` 同步（ahead=0 / behind=0）；用户已确认 CI 绿；生产运行态为 PD-02 验收版（`e35af979` / `beaconhs@sha256:2a3df5f8…` / 59 migrations / Gate 5 PASS）。

---

## 1. 审计方法（合规声明）

- **五个只读专项子代理并行**：`explore`、`security-reviewer`、`code-reviewer`、`hse-domain`、`release-manager`。全部被明确约束：禁止写操作、禁止连库、禁止连生产、禁止读取/回显 Secret、禁止复述历史结论（必须回代码核实）。
- **主代理独立抽样复核**：对代理报告中的关键主张逐条 `grep`/`read` 回代码验证，不照单全收（见 §3）。
- **本轮边界**：未连接任何数据库、未 ssh 生产、未做实时生产探测、未读任何 Secret、未运行六门禁、未 push、未改任何代码/数据/配置。本报告是新增文档交付，未提交。
- **测试分层诚实声明**：本审计**未执行任何测试**。CI 绿由用户确认；此前 PD-03 收尾时六门禁全 0（format/typecheck/lint/test/deadcode/build）为旁证，但本次未独立重跑。因此下述"测试覆盖"结论均为**静态审查**，非实测。
- 环境注意：shell 内 `rg` 不可用（`/bin/bash: rg: 未找到命令`），早期一条 "FILES WITH MATCHES 0" 系命令失败的空输出，已改用专用 `grep` 工具重做，不可作证据。

---

## 2. 总体结论

| 维度           | 判定                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| **生产安全**   | **无 Critical / High**。无跨租户业务数据读取路径、无认证绕过、无提权路径。当前生产具备继续运行条件。               |
| **发布就绪**   | **READY WITH STATED CAVEATS** —— 下次代码变更或回滚前，必须先补 runbook 回滚收敛步骤与 `deadcode:check` 门禁文档。 |
| **代码正确性** | 存在若干确认缺陷与合规缺口（`code-reviewer` 判 block，语境为"批准合并"，非生产越权）。                             |
| **HSE 二期**   | Phase 1 退出条件未满足，当前应停在 **pre-start 未授权**状态；无越阶段实施。                                        |
| **治理**       | 存在 **AGENTS.md 与已撤销设计之间的规则冲突**（§4.6），需用户裁决权威来源。                                        |

**一句话**：系统当前稳定、安全无高危；真正的价值不在"救火"，而在**回滚安全文档、一批安全加固、测试覆盖补强、以及一处治理规则裁决**。这些是加固项，不是"系统坏了"。

---

## 3. 独立复核：去伪存真

对代理主张逐条回代码验证的结果（避免把代理结论直接当结论）：

| 主张                                                     | 复核结果                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-reviewer`："admin/audit 表无分页"                  | **部分纠偏**。主审计日志表 `admin/audit/page.tsx:20-23,51,114-122,191` **有** `parseListParams`/`SearchInput`/`FilterChips`/`Pagination`。缺合规的是 `cross-tenant-section.tsx` 的 grants 表（`:295` 纯 `.map`）与 query 结果表（有 `hasMore`/Previous/Next，无 search/filter）。                                                                             |
| `code-reviewer`：预算 TOCTOU                             | **证实**。`audit-access.ts:414-431` `select coalesce(sum(row_count),0)` 无锁、与查询/记账不同事务；`if (req.extraApproval) return` 跳过预算系设计授权。                                                                                                                                                                                                       |
| `code-reviewer`：连接故障 500 而非 503                   | **证实方向**。`cross-tenant.ts:70-81` `auditConnectionOr503()` 仅捕获 `getAuditConnection()` 构造期的 `AuditConnectionUnavailableError`；postgres.js 惰性连接，`activeGrantFor:104` 首次真查才触发原生连接错误，不被映射到 503。catch 内 `:180/:216` 的留痕依赖同一已断连接，会使 `mapAuditError` 不执行。                                                    |
| `security-reviewer`：审批人跨租户枚举/撤销放大           | **证实**。`cross-tenant.ts:454-465` `canApprove` 时 `granteeUserId=undefined`→全表；`:443-447` `revoke` 分支无任何租户边界（F4 残留 + 新发现的列表放大）。                                                                                                                                                                                                    |
| `code-reviewer`：`viewCols` 是第二套不完整实现           | **证实**。`scope.ts:121-140` 只处理 sites/self(owner)/self(person)，未复用 `recordVisibilityWhere` 的"总是可见本人记录"腿；people/crews/team scope 落到 `sql\`false\``零行。注释 "identical scope semantics" 不成立。但列名为固定常量`viewColumn(...)`、单 `FROM "<view>"` 无 JOIN，**标识符注入与列名歧义风险不成立**（这部分代理的措辞过度）。              |
| 文档失真（`project-development-state.md`、`RUNBOOK.md`） | **证实**。`state.md:345/351/527/629-630` 仍以现在时陈述 `HEAD 51a899b7` / `51 migrations` / "Nothing has been committed or pushed"，与 `f463f415` / 59 / 已部署矛盾；`PRODUCTION_RUNBOOK.md:537` 只列 5 门禁，漏 `deadcode:check`（AGENTS.md 规则 8 要求 6 项）；`:215-216` 的 provision 重收敛是**前向部署**说明，回滚段 `:532/:559/:571-598` 无此强制步骤。 |
| `equipment.read.self` 幽灵键                             | **证实**。`manual/content/knowledge-assets.ts:799`、`equipment/inspections/page.tsx:85`、`_inspection-panel.tsx:90`、`inspections/records/page.tsx:400` 存活；`iam.ts` 只有 `read.all`/`read.site`；`permission-catalogue-contract.test.ts:124-125` 只覆盖 nav + module-admin；`equipment-inspection-atomicity-contract.test.ts:161,164` 反而固化该键。       |

---

## 4. 发现清单（去重、分级）

### 4.1 安全（无 High，最高 Medium）

1. **【Medium】跨租户 grant 枚举 + 无边界撤销**：`cross-tenant.ts:454-465` / `:443-447` + `audit-access.ts:185-191`/`:353-389`。持 `admin.audit.approve` 的租户审批人可枚举他租户及 platform-scope grant（含 purpose 明文）、按任意 UUID 撤销。属 F4 残留 + 新放大路径。缓释：该键默认不授予任何内置角色，需平台显式授予才可达，故非 High。
2. **【Medium/Low】行预算非原子**：`audit-access.ts:414-431`，并发/重试可绕过 10,000 行配额；`requestedRows: pageSize` 与实查 `limit: pageSize+1` 每页少计 1 行；`row_count` 独立 autocommit 写入失败会丢计费。**仍受有效 grant + `SET LOCAL ROLE` 约束，不构成越权读**。
3. **【Low】上传链路无 `assertCan`**：`uploads.ts:148` 仅 `requireRequestContext`。疑为通用能力取舍，未见文档说明。
4. **【Low】`/verify/[token]` 缺租户状态/软删过滤**：对照 `verify/person/[token]/page.tsx:59,66` 齐全；160-bit token + 限流缓释，属吊销一致性缺口。
5. **【Low/UX】分页末页 `row_cap` 返回 400**（N2，PD-02 独立审查已登记）。

### 4.2 正确性 / 契约

6. 连接故障 500 而非承诺 503 + catch 内留痕依赖已断连接（`cross-tenant.ts:70-81`, `:180`, `:216`）。
7. grants 表缺 search/filter/pagination（`cross-tenant-section.tsx:295`），违反 AGENTS.md "每个记录表必须可搜索/可过滤/可分页"；`listAuditAccessGrants` 默认 50 静默截断、无 total。
8. 31 天窗口上限只在 web 编排层（`cross-tenant.ts`），DB 层 `queryAuditLogAcrossTenants` 不设防；任何 worker/脚本/未来路由可绕过。
9. `query/route.ts:60-70` 与 `export/route.ts:55-64` 丢弃 `actorUserAgent`/`metadata` 取证字段，CSV 取证不完整；`occurredAt.toISOString()` 序列化无测试覆盖。
10. `scope.ts:121-140` viewCols 第二套实现致绑定 API 凭据读到的记录少于 UI 可见（功能回归，不泄露）。

### 4.3 测试覆盖（静态审查，未实测）

- 真 PG 覆盖扎实：`audit-access` / `audit-query-isolation` / `audit-role-preflight` / `audit-client` / `scope-pg`。
- **最大缺口**：4 个 session 路由（`grants`/`grants/[id]`/`query`/`export`）+ `cross-tenant.ts`(466 行) **零 HTTP 层测试**；PD-02 验收报告 §145-147 亦留白"会话级 HTTP 待运维验证"。
- `assertAuditRowBudget` 无并发用例；trail 失败/连接中断无测试；`audit-client.test.ts` 第二 describe 未受 Docker-ready 门控（缺 Docker 时 FAIL 而非 skip）；`scope-create-logic.test.ts` 等静态契约测试不可称 E2E。

### 4.4 文档真实性 / 治理（已复核为真）

- `docs/project-development-state.md` 旧章节仍以现在时陈述过期 HEAD/迁移数/"未提交"（虽已加 §8c 附录与顶部指针，但未消除冲突）。
- `docs/PRODUCTION_RUNBOOK.md:537` 漏 `deadcode:check`；回滚段缺"旧镜像 migrator/provision 重跑会放宽业务池权限并剥掉自定义角色 audit 键 → 必须重跑新 provision.sql + 新 db:migrate 收敛"（RC `:196-197` 明令要求却未落地；`ROLLBACK_PLAN.md:30-37` 只覆盖到 0055）。
- `docs/hse-development-baseline.md` 大面积失配（D3/D4/D5 已修但文档仍写未修、`api_keys.scopes` 已加但 `:461` 写无 scope 列、权限键 89 vs 111）。
- `packages/db/src/schema/journals.ts:50-51` 指向不存在的 `docs/hse-extension-boundary-decision-record.md`。
- **【治理冲突】** Project Scope / Phase 10 已被 `9227a70a` 永久撤销（`state.md:668` + `project-scope-removal-contract.test.ts:461-485` 14 符号生产代码 0 命中），但 `AGENTS.md:342-361` 与 `hse-development-baseline.md:430-467`/`:639-643` 仍强制走 §12 并列为待实施 → 按 AGENTS.md 行事的 agent 会重建被回归测试禁止的第二授权维度。**需用户裁决权威来源**。
- 【已登记未修，PD-03 N/A 时记录】`apps/web/scripts/cutover-target.ts:10-11` capability secret 指纹常量 `943990bc…` vs 历史卡片 `1c79927d…`。

### 4.5 HSE 领域（Phase 1 pre-start，未越阶段）

- §17 Phase 1 退出条件未满足：4 套 expiry-status（`packages/db/src/views.ts:34-45`/`:116-130`、`packages/compliance/src/evaluate.ts:768`、`apps/web/src/app/(app)/compliance/_signals.ts:66`）+ 2 套派生（`_actions.ts:155`/`skills/_actions.ts:114`）。
- `findings`/`risks`/`hazards`/`projects`/`machinery_certificates` 表 0 命中 —— 未提前建表，符合守卫。
- `packages/object-store-backup/src/s3.ts:2,19-35` 为 infra 备份工具的裸 bucket 客户端（非 app 路径），缺显式豁免 ADR。

### 4.6 代码卫生（knip 已过，语义重复仍在）

- `escapeHtml` 9 份（3 跨包导出）、`slugify` 4 份、`appBaseUrl` 3 份、`contentDisposition` 2 份（D-BO-2）、`isUniqueViolation` 2 份签名不一 → 违反 AGENTS.md 规则 5。
- 孤立 walkthrough 锚点：`_assignments-drawers.tsx:245` `end-assignment`、`_assignments-tab.tsx:59` `add-assignment` 在 9 个 tour 中无引用。
- `rls.test.ts:8-19` 不变量只"看见"已声明 tenantId 列的表（漏列 / raw SQL 建表测不出）。
- 死代码：`audit-roles.ts:24-30` `FORBIDDEN_AUDIT_READER_MEMBERS` 全仓无引用；`0059_audit_access_platform.sql:83` `audit_export_approved` 在 CHECK 但代码不写；`iam.ts:578-581` 冗余双重 cast。

### 4.7 发布 / 运维（未访问生产，无法核实）

- 0058 加列、0059 CREATE TABLE 均无 `IF NOT EXISTS`（幂等靠 ledger）。
- `admin/audit/page.tsx:60-61` 要求 `admin.audit.read` 而跨租户面板 `:66-69` 判 3 个新键 → 仅持 3 键主体能否到达面板**未验证**。
- append-only 触发器（`0056:81-91`/`0057:15-28`）vs `packages/db/src/maintenance.ts:26` audit_log 730 天清理可能冲突（维护作业连接身份未核实；生产库 2026-11-11 全新，暂不触发）。
- 主机侧 `~/.beaconhs/scripts/backup-daily.sh`/`health-check.sh` 同步状态、0059 两表是否进 `scripts/cluster/backup.sh:76-88` manifest **无法核实（禁 ssh）**。

---

## 5. 未验证项（诚实声明）

RLS 运行时实际生效、append-only 触发器实际拦截、生产权限矩阵、生产版本差异、会话级 HTTP 授权端点、主机脚本状态、DB 维护作业身份、权限键精确总数（代理报告有 107 / 106–111 分歧）—— 均**未实证**。本次五个代理与主代理复核均为静态审查，未连库、未连生产、未跑门禁、未读 Secret。

---

## 6. 下一步任务（按优先级 × 授权边界分层）

> 本轮**未实施任何修复**。以下为待批准清单，供逐项授权。

### A 类 —— 纯文档 / 仓库内，不碰生产、不碰库（低风险，可作下一批）

- **A1【P0，下次任何变更或回滚前必修】** `docs/PRODUCTION_RUNBOOK.md`：① `:537` 补 `deadcode:check` 成 6 门禁；② 回滚段补"旧镜像 migrator/provision 重跑 → 必须重跑新 provision.sql + 新 db:migrate 重新收敛"。
- **A2【P0】** `docs/project-development-state.md`：把 §1/§4/§5/§8 的现在时过期陈述改为历史标注，与 §8c / 顶部指针一致。
- **A3** 死代码清理（`FORBIDDEN_AUDIT_READER_MEMBERS`、冗余 cast、`audit_export_approved` CHECK 与代码对齐）。
- **A4** 测试补强（本地隔离环境）：4 个 session 路由 + `cross-tenant.ts` 的 HTTP 集成测试；`assertAuditRowBudget` 并发用例；连接中断 / trail 失败用例；`audit-client.test.ts` Docker-ready 门控。

### B 类 —— 代码修复，改行为/安全语义，**需单独授权**

- **B1** 收紧跨租户 grant 列表与撤销的租户边界（关闭 F4 残留 + 列表枚举放大）。
- **B2** 行预算原子化 + `requestedRows` 计数修正 + `row_count` 同事务写入。
- **B3** 连接故障真 503（惰性连接错误映射）+ catch 内留痕不依赖已断连接。
- **B4** grants 表补 search/filter/pagination（AGENTS.md 硬性规则）。
- **B5** `scope.ts` viewCols 与 `recordVisibilityWhere` 统一，消除第二套实现。
- **B6** 31 天窗口下沉 DB 层；导出补回取证字段。

建议顺序（安全收益）：**B1 > B3 > B2 > B4 > B5 > B6**。

### C 类 —— 需用户裁决 / 新授权，不擅自进行

- **C1【治理】** 裁决 `AGENTS.md` 与 `hse-development-baseline.md` 的 Project Scope 冲突，确定权威来源后统一（改 AGENTS.md 属治理文件变更）。
- **C2** HSE §17 Phase 1 及后续阶段正式启动（当前未授权）。
- **C3** 连库 / 连生产只读实证（RLS 运行时、触发器、权限矩阵、健康探测、§5 未验证项）。
- **C4** PD-03 重开（当前 N/A；须先提供 §7 四项输入 + 定位目标库）。
- **C5** 任何生产部署 / 迁移 / 数据 / RLS 变更 / push。

### 明确不做（除非用户单独批准）

生产改动、PD-03 重开、连库实证、HSE 二期阶段启动、任何 push/merge、任何数据回填。

---

## 7. 复核清单

- `apps/web/src/lib/audit/cross-tenant.ts:70-81`（503）、`:99-125`（activeGrantFor）、`:435-466`（revoke + list）
- `packages/db/src/audit-access.ts:414-431`（预算）
- `apps/web/src/lib/api/scope.ts:115-140`（viewCols）
- `apps/web/src/app/(app)/admin/audit/cross-tenant-section.tsx:295` vs `admin/audit/page.tsx:20-23,114-122,191`（分页对比）
- `docs/PRODUCTION_RUNBOOK.md:215-216, 532-598, 537`
- `docs/project-development-state.md:345,351,527,629-630,668`
- `BEACONHS_PD02_RELEASE_CANDIDATE_REVIEW.md:196-197`（回滚收敛要求）
- `BEACONHS_PD02_FINAL_ACCEPTANCE_REPORT.md:145-147`（会话级 HTTP 留白）

---

**结论**：当前生产稳定、安全无高危，具备继续运行条件；审计产出的是一份"加固与治理"清单，而非缺陷救火。等待用户对 §6 的 A/B/C 类任务逐项授权。
