# BeaconHS 安全复审报告 — 2026-11-09

**基线：** 分支 `hse-platform`，HEAD `20d0c78f`（`Restore TEST_HOST_A3_FORENSIC_AUDIT.md…`），审计日 2026-11-09（+0800）。
**范围：** 重新审计（不采信历史 PASS）：API 安全、Permission/RoleScope/RLS、附件、A3 Backfill、SQL/上传/SSRF/Worker/审计日志/错误处理。未连生产库、未跑 A3 `--apply`、未 Migration、未改指纹/guardrails、未部署。

## 审计范围与基线

- 工作区：`/home/test/projects/beaconhs-hse`，唯一未提交为 `TEST_HOST_A3_FORENSIC_AUDIT.md`（未追踪）+ `apps/web/next-env.d.ts`（构建产物）+ 下文四处修复。
- 与历史审计基 `7df32ab6` 差异：仅审计文档 12 件 + `next-env.d.ts` + 本次修复；权限目录/CSP/RLS 注册表未变。
- 测试体系：`vitest`（web/tenant/db），`turbo` 六门禁（format/lint/typecheck/test/deadcode/build），`rls.test.ts` 静态注册等价。

覆盖：`apps/web/src/lib/api/**`、`app/api/v1/**`、`app/api/attachments`、`packages/tenant`、`packages/db/src/rls.ts`、`packages/storage`、`packages/sync/src/egress.ts`、`packages/jobs`、`apps/worker/**`（静态）。

## 检查模块与覆盖

| 模块                                                                                    | 覆盖                             | 结果                   |
| --------------------------------------------------------------------------------------- | -------------------------------- | ---------------------- |
| 会话/Better-Auth、邀请/魔法链接、cookie                                                 | 静态                             | 通过                   |
| API Key、HMAC capability（verify/WOPI/内部事件/存储网关）                               | 静态                             | 通过（F1 修复后）      |
| 匿名/公共路由（kiosk/verify/setup）                                                     | 静态                             | 通过                   |
| 权限目录 108 键 vs 91 处 `assertCan/can/keyHasPermission`                               | 静态治理                         | 通过                   |
| RoleScope（tenant/sites/team/people/crews/self）                                        | 静态                             | 通过                   |
| RLS（191 表注册等价、FORCE、GUC/tx 边界、app/super 分池）                               | 静态等价（**无活库，未做活测**） | 通过                   |
| API 写面（`write.ts` + `builder-apps.ts`）                                              | 静态 + 新回归                    | **F1 修复**            |
| 附件（上传/下载/删除/v1/v2/租户归属/MinIO）                                             | 静态                             | 通过 + 2 删除点硬化    |
| A3 Backfill（`cutover-target.ts` / `backfill-attachment-capability-v2.ts` / 0054/0055） | 静态 + A3 测试                   | 通过 + 1 注释          |
| SQL 注入/SSRF/开放重定向/上传/Worker/审计/错误泄露                                      | 静态抽查                         | 通过（余 2 低项见 §4） |

## 发现的问题

### F1 — API PATCH 可绕过 `own` 归属检查【已修复】

- **等级：** High
- **位置：** `apps/web/src/lib/api/builder-apps.ts:622` `updateBuilderAppResponse`
- **复现：** API key 仅持 `forms.response.update.own` 时 PATCH 可改任意 `formResponses.data`（重算 compliance）、`siteOrgUnitId`、`subjectPersonId`；`lockApiResponseForMutation` 仅校验 `locked`；UI 填表/生命周期（`fill/actions.ts:299,562,746`、`form-response-lifecycle.ts:132`）均调 `canEditResponsePayload`，API PATCH 未调。
- **根因：** 路由仅查 `BUILDER_APP_UPDATE_PERMISSION=forms.response.update.own`，handler 未复用 UI 归属策略。

### F2 — 通用 API 写缺少对象可见性二次校验【待验证】

- **等级：** Medium
- **位置：** `apps/web/src/lib/api/write.ts:357,444`（incidents/CA/inspections 等）
- **复现：** 仅有 `X.update` 无 `X.read.all` 的 key 不可 GET，却可按 UUID PATCH/DELETE（跨租户不可，RLS 阻断）。UI 写面均经 `moduleScopeWhere/canSeeRecord`，API 无。
- **未改原因：** 硬塞 `moduleScopeWhere` 会使无 `read.all` 的 key 归入 `self→false` 而全拒，需产品裁决「key 是租户内主体」契约，非一行可修。

### F3 — 未鉴权发现接口泄露权限目录【非问题·设计如此】

- **位置：** `app/api/v1/route.ts:25`、`openapi.json/route.ts`
- 仅暴露端点/权限名，无数据；保留公开 spec 为产品选择，不改。

### F4 — 「POST /api/v1 compliance 500」【非问题】

- `compliance` 已映射 `compliance.read.all`，`POST` 对其为 405 而非 500；声明过期，未改。

### F5 — 审计表无 DB 不可变性【待验证】

- `audit_log` 无 REVOKE/触发器；app 级纪律。改需 DB trigger + 迁移，任务禁迁移，未改。

### A1 — `attachment:v2` 永久承载【非问题·设计如此】

- `lib/attachment-url.ts:28-51` 常驻承载是 v2 既有约定（注释 `:11-24` 已声明）；轮转会全量失效。后续若需过期，应做双哈希窗口，不属本次。

### A2 — 0055 `ADD CONSTRAINT` 重放不安全【未修复·历史迁移】

- 9 个 `DROP` 有 `IF EXISTS`，`ADD "att_tenant_ppe_inspection_attachments…"` 裸写，`VALIDATE` 分步。已上线历史迁移改文件会与台账哈希不一致，禁止改；需新补偿迁移，任务禁迁移，未改。

### A3 — 附件删除仅靠 RLS【已修复（2/3 点）】

- 点位：`training/.../evaluations/_actions.ts:160`、`people/_actions/titles.ts:817,892`（已加 `tenantId` 谓词）；`pptx/_lib.ts:103` 未改（见 REMEDIATION）。
- 风险：RLS 已阻断跨租户，属纵深一致性；未爆无利用。

### A4 — `resolveTenantLogoUrl` 无 `buildUrl` 时发预签名【非问题】

- 当前 `app/verify/person/[token]/page.tsx:119` 已传 `buildUrl: storageObjectUrl`，与 `person-badge.ts:109` 一致，已无内网主机泄露。

### A5 — Verify 为唯一未鉴权存储面【非问题】

- `object:v1` 3600s TTL，`/api/attachments` 仍需会话+能力，二者不对称正确。

### A6 — v2 无存储目标门禁【已修复·注释】

- 事实：v2 只重算 HMAC+JSON，不触对象存储；v1 断言存储私钥。已在头注说明「有意省略」。

---

## 结论

其余（已部署确认项 D9 fail-closed 已落地、D10 SSRF 独立 egress `secureFetch` 健全）静态层面无中高危未修复项；活库 RLS 计数与活体探针因无可安全测试库，未以运行态复验（报告 §未解决问题）。
