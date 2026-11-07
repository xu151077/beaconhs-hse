# BeaconHS HSE Second-Stage Development Baseline

> Read-only analysis against Git HEAD `70da27c4`.
> Produced 2026-09-29. No source, schema, compose, or environment file was modified.

---

## 中文摘要

**结论一句话**：BeaconHS 已经是一个成熟的 HSE 生产平台底座——202 张表、187 张表强制 RLS、89 个权限键、46 种表单字段、16 个报表实体、32 个预置报表——但它的 HSE 能力集中在「**记录**」，而不是「**闭环管理**」。

**五个必须先知道的事实（均经代码与运行时双重验证）：**

1. **不存在 Finding 表，也不存在 Hazard 表。** 「发现 → 分类 → 风险 → 措施 → 责任人 → 整改 → 验证 → 关闭」这条链路今天由 **8 条互相独立的生命周期**拼凑而成。其中只有 `corrective_actions` 一条同时具备「责任人 + 截止日期 + 验证步骤 + 通知」四要素；其余 7 条都是残缺版本。

2. **不存在风险登记册（Risk Register）。** 全库唯一持久化的风险数据，是 `hazid_assessment_hazards` 表上 **4 个可空整数**（`pre_likelihood` / `pre_severity` / `post_likelihood` / `post_severity`）。没有风险主键、没有责任人、没有状态、没有复查日期、没有整改关联。全库 `views.ts`（499 行）中 "risk" 一词出现 **0 次**。

3. **不存在项目级权限。** `RoleScope` 有 6 个变体，**没有一个是 project/org_unit**；可见性只有 `all` / `site` / `self` 三档；权限配置界面硬编码只允许选 `level='site'` 的组织单元。因此「该用户只能看到项目 X 的事故」在今天**无法表达**。但修复是纯增量的——现有代码里已有可复用先例。

4. **不存在原生证书过期通知。** `DomainNotificationEvent` 全库只有 **4 种**事件（incident×2、corrective_action×2）。证书过期提醒必须由租户手工创建 `cert_requirement` 合规义务才会产生。

5. **人员主数据是暴露面最大的模块。** `people` 导航项**没有任何权限门**（`nav/registry.ts:172`），任何登录用户都能看到名册（含紧急联系人、出生日期、入离职日期）；只有写入操作被 `admin.org.manage` 拦住。

**开发顺序建议（与题目给出的参考顺序不同，依据是代码实测）**：
先做 **Phase 1 数据模型统一**（含清理 2 个死列、合并 4 套重复的过期状态计算器、修 1 个 flow 引擎 bug），再做 **证书 ADAPT**，再做 **Finding NEW（根模型）**，然后 **风险 NEW**，最后才轮到 Action/Verification 收敛、Incident 补齐、Dashboard/Report、通知、权限范围。

**所有结论标注为** `RUNTIME VERIFIED`（运行时验证）/ `STATIC VERIFIED`（仅静态代码证据）/ `UNVERIFIED`（无法确认）。**本次审计发现 4 处早期审计结论已过时（AUDIT OUTDATED），并新发现 6 个缺陷，全部只做记录、未做修复。**

---

## 1. Executive Summary

BeaconHS ships a **mature HSE records platform** on a **highly disciplined platform core**. The platform core is genuinely production-grade and this baseline confirms it holds at current HEAD:

| Property                                           | Value   | Verification     |
| -------------------------------------------------- | ------- | ---------------- |
| Public tables                                      | 202     | RUNTIME VERIFIED |
| Tables with `FORCE ROW LEVEL SECURITY`             | 187     | RUNTIME VERIFIED |
| Drizzle `pgTable` declarations                     | 193     | STATIC VERIFIED  |
| Tenant isolation registry (`TENANT_SCOPED_TABLES`) | 187     | STATIC VERIFIED  |
| `PERMISSION_CATALOGUE` unique keys                 | 89      | STATIC VERIFIED  |
| Built-in roles                                     | 4       | STATIC VERIFIED  |
| Form field types                                   | 46      | STATIC VERIFIED  |
| Flow triggers / actions                            | 6 / 13  | STATIC VERIFIED  |
| Report entities / seeded reports                   | 16 / 32 | STATIC VERIFIED  |
| Compliance source modules                          | 11      | STATIC VERIFIED  |
| Native notification event kinds                    | 4       | STATIC VERIFIED  |

Tenant isolation was **proven live**, not merely asserted:

```
beaconhs_app, no app.tenant_id  -> people = 0
beaconhs_app, app.tenant_id set -> people = 10
beaconhs_super (BYPASSRLS)      -> people = 10
```

Against that solid core, the **HSE management layer** is where the gap is concentrated. The distinction that organises this entire baseline:

> **BeaconHS records events extremely well. It does not yet manage their resolution.**

Every native module persists _what happened_. Almost none of them persist _who owns getting it fixed, by when, and whether the fix was verified_. The single exception is `corrective_actions`.

The consequence is structural, not cosmetic: because there is no `findings` table and no `risks` table, an HSE manager cannot answer the three questions that define the job:

1. "What is currently open across all my projects?" — **unanswerable**, because hazard rows have no status (`hazid-assessments.ts:183-205`) and there is no cross-project risk query surface.
2. "What is my residual risk profile?" — **unanswerable**, because the word `risk` appears 0 times in `packages/db/src/views.ts` and the only HazID report entity is `hazid_signatures` (`entities.ts:501`).
3. "Who on my project can see what?" — **unanswerable**, because `RoleScope` has no project variant (`iam.ts:49-55`).

These are **ADAPT** and **NEW** items, not rewrites. The platform core (RLS, permissions, builder, flows, reports, compliance, notifications) is the reusable asset; the HSE management layer above it is the new work.

---

## 2. Current BeaconHS Baseline

### 2.1 Identity

- **Repo HEAD**: `70da27c4`
- **Stack**: pnpm 10.30.3 / Turbo / Next.js 16 App Router / Drizzle ORM / PostgreSQL (RLS) / Better-Auth / BullMQ
- **Node**: 24 LTS (`.nvmrc`)
- **Object storage baseline**: MinIO, image built from pinned archived source commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a` (tag `RELEASE.2025-10-15T17-29-55Z`). See `docs/beaconhs-minio-build.md` and `docs/beaconhs-storage-minio-verification.md` (25/25 acceptance conditions). **No SeaweedFS. `packages/storage/**` unmodified.**

### 2.2 Schema footprint

- 71 schema files under `packages/db/src/schema/`
- 193 `pgTable` declarations; 202 tables physically present (extra tables are views + migrations-created relations)
- 187 entries in `TENANT_SCOPED_TABLES` (`packages/db/src/rls.ts`)
- 41 migrations applied

**Hard constraint on any new table** — `packages/db/src/rls.test.ts:9-20` asserts that `TENANT_SCOPED_TABLES` **exactly equals** every Drizzle table with a `tenant_id` column. A new tenant table that is not registered **fails the test suite**, not just review.

### 2.3 Platform primitives available for reuse

| Primitive                     | Location                                                                              | Notes                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Form builder (46 field types) | `packages/forms-core/src/field-types.ts`                                              | Includes `risk_matrix`, `person_picker`, `project_picker`, `signature`, `typed_attestation`, `sketch` |
| Flow engine                   | `packages/forms-core/src/flow-subjects.ts`                                            | 6 triggers, 13 actions                                                                                |
| Flow gate store               | `packages/db/src/schema/forms.ts:617-678`                                             | Explicitly "the single gate store — so we never build two gate systems"                               |
| Module flow profiles          | `apps/web/src/lib/flows/module-profiles.ts`                                           | 9 subjects                                                                                            |
| Compliance engine             | `packages/compliance/src/evaluate.ts`                                                 | 11 source modules                                                                                     |
| Report studio                 | `packages/reports/src/entities.ts` + `packages/db/src/views.ts`                       | 16 entities, 9 views                                                                                  |
| Insights / dashboards         | `packages/db/src/schema/insights.ts`, `insight-dashboards.ts`, `dashboard-layouts.ts` | Native BI                                                                                             |
| Audit log                     | `packages/db/src/schema/audit.ts:5`                                                   | 217 source files call `recordAudit`                                                                   |
| Attachment pipeline           | `packages/storage`, `apps/web/src/lib/uploads.ts`                                     | RUNTIME VERIFIED end-to-end                                                                           |
| Notifications                 | `packages/events/src/index.ts`                                                        | 4 event kinds, 4 recipient categories                                                                 |

### 2.4 Prior-art docs audited

`docs/beaconhs-architecture.md`, `docs/beaconhs-capability-matrix.md`, `docs/beaconhs-extension-points.md`, `docs/hse-gap-analysis.md`, plus `docs/beaconhs-storage-minio-verification.md` and `docs/beaconhs-storage-audit.md` as the storage baseline reference.

**Conclusion: these prior docs remain substantively accurate.** Four numeric or factual claims in them (or in my own earlier audit) did not survive re-verification — see §21 `AUDIT OUTDATED`. Where prior docs and current code disagree, **this document follows the current code**.

---

## 3. Existing HSE Capabilities

The platform covers these HSE domains natively today:

| Domain                              | Native module         | Route                      | Evidence                                                                        |
| ----------------------------------- | --------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| Hazard assessment (JSHA/JSA)        | HazID                 | `/hazard-assessments`      | `packages/db/src/schema/hazid-assessments.ts` (7 tables)                        |
| Incident reporting & investigation  | Incidents             | `/incidents`               | `packages/db/src/schema/incidents.ts` (1 + 9 sub-tables)                        |
| Corrective action (CAPA)            | Corrective Actions    | `/corrective-actions`      | `packages/db/src/schema/corrective-actions.ts` (+ 2 child tables)               |
| HSE inspection                      | Inspections           | `/inspections`             | `packages/db/src/schema/inspection-records.ts`, `inspection-record-criteria.ts` |
| Training & competency               | Training              | `/training`                | `packages/db/src/schema/training.ts`, `training-skills.ts`, `training-lms.ts`   |
| Plant / machinery                   | Equipment             | `/equipment`               | `packages/db/src/schema/equipment.ts` (60+ columns on `equipment_items`)        |
| Machinery inspection                | Equipment Inspections | `/equipment/inspections`   | `packages/db/src/schema/equipment-inspection-records.ts`                        |
| PPE lifecycle & inspection          | PPE                   | `/ppe`                     | `packages/db/src/schema/ppe.ts`, `ppe-annual-records.ts`                        |
| Document control & review           | Documents             | `/documents`               | `packages/db/src/schema/documents.ts`                                           |
| Management review                   | Documents             | `/documents`               | `packages/db/src/schema/document-management-reviews.ts`                         |
| Hazard journals / observation books | Journals              | `/journals`                | `packages/db/src/schema/journals.ts`                                            |
| Compliance obligations & dispatch   | Compliance            | `/compliance`              | `packages/db/src/schema/compliance.ts`                                          |
| Pneumatic test safe distance        | Tools                 | `/tools/safe-distance`     | `packages/db/src/schema/safe-distance.ts`                                       |
| Workforce master data               | People                | `/people`                  | `packages/db/src/schema/org.ts` (`people`, `people_assignments`)                |
| BI / dashboards                     | Insights, Dashboards  | `/insights`, `/dashboards` | `packages/db/src/schema/insights.ts`                                            |
| Custom apps (form builder)          | Apps                  | `/apps`                    | `packages/db/src/schema/forms.ts`                                               |

**Not present natively** (confirmed absent, see §6, §7):
`findings`, `hazards` (as findings), `risks`, risk register, JSA/RAMS/SWMS as a distinct model, project-level as a first-class entity.

---

## 4. HSE Capability Matrix

Classification vocabulary is restricted to `PRESERVE` / `EXTEND` / `ADAPT` / `NEW` as required. "Implementation approach" uses only Builder/Form, Extend existing native module, New native module.

| Capability                | Current implementation                                                                                                                                                                                                                                                                            | Classification             | Recommended implementation                                                                                                                                    | Reused objects                                                                                                           | New objects                                                                                      | Risk                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Personnel**             | `people` (200+ col incl. emergency contacts, DOB, termination), `departments`, `trades`, `crews`, `personGroups`, `personTitles`, `people_assignments` (`org.ts:140-269`) — **no `position`, no project assignment type**                                                                         | **EXTEND**                 | Extend `people_assignments` (add position/assignment-type); extend `people` nav gate                                                                          | `people`, `people_assignments`, module-admin `people`                                                                    | position + assignment-type columns; `people.*` permission keys                                   | `people` nav is now gated by `people.read.all` (EA-12), including direct access and export; project scoping is still not expressible and remains the open constraint                               |
| **Certificate (person)**  | `training_certificates` (`training.ts:331`), `training_skill_certificates` (`training-skills.ts:129`), both with verify tokens; expiry on parents (`training_records.expires_on:225`, `training_skill_assignments.expires_on:88`); public verify `/verify/[token]`, `/verify/person/[token]`      | **ADAPT**                  | Unify into one certificate read model + one expiry-status function; keep both issuance tables (different parents/paths)                                       | both cert tables, `verifyToken`, `/verify/*`, `report_skill_assignments`, `report_training_matrix`                       | unified expiry status helper; unify `expiryForValidity`/`skillExpiry`; certificate report entity | 4 duplicated expiry computors with **divergent thresholds** (90d vs 30d); no native expiry notification; EA-12 removed the 2 dead enrollment expiry columns                                        |
| **Training**              | `training_courses`, `training_records`, `training_classes`, `training_enrollments`, `training_assessments`, `training_courses.valid_for_months`, credential design, wallet cards, `/my/training`                                                                                                  | **PRESERVE**               | Preserve as-is                                                                                                                                                | all training tables, 6 training reports (`report-definitions.ts:401-629`), `cert_requirement` compliance                 | none                                                                                             | Low. EA-12 removed the dead `training_enrollments.expires_on`/`due_on` columns                                                                                                                     |
| **Machinery**             | `equipment_items` (60+ cols: QR, custody, location history, rental, pre-use inspection, oil change, VIN, `isEquipmentBase` checkout) — `equipment.ts:84-240`                                                                                                                                      | **PRESERVE**               | Preserve; the model is unusually complete                                                                                                                     | `equipment_items`, `equipment_categories/types`, `equipmentLocationHistory`, `equipmentReminders`, flow profile          | none                                                                                             | Low                                                                                                                                                                                                |
| **Machinery Certificate** | **No model.** EA-12 removed the unused free-text `equipment_inspection_records.certificate` column; `registration/insurance/warranty_expires_on` remain flat on `equipment_items`                                                                                                                 | **ADAPT**                  | Adopt the `ppe_annual_records` pattern (year, inspector, `inspector_company`, `certificate_attachment_id`, `next_due_on`) as a `machinery_certificates` table | `ppe_annual_records` shape, `attachments`, `equipment_inspection_records`                                                | `machinery_certificates` table + compliance adapter                                              | No authoritative certificate record yet; `registration/insurance/warranty` are flat (not per-cert), excluded from compliance (`evaluate.ts:798-804` reads schedules only)                          |
| **Machinery Inspection**  | `equipment_inspection_types` (cadence, `failsSpawnWorkOrders`), `equipment_inspection_records` (inspector user/person/text, supervisor, `nextDueOn`, criteria), `equipment_work_orders` spawn                                                                                                     | **EXTEND**                 | Add verifier identity + due date to work orders; add a notification kind; EA-12 fixed the `statusValues` gap                                                  | inspection types/records, criteria, work orders, `equipment.read.*`, reminders                                           | notification kind for work order; `verified_by/at` columns                                       | Work order `verified` is **decorative** (enum only, no `verified_by`); inspection→work-order path emits **no notification** (`equipment/inspections/_lib.ts` imports only `recordModuleFlowEvent`) |
| **HSE Inspection**        | `inspection_records` + `inspection_record_criteria` (severity, nonComplianceDescription, actionTaken, `assigned_to_person/user`, `assigned_due_date`, `corrected_on`, `corrective_action_id`); fail→CA spawn with due-offset logic (`inspections/_lib.ts:161-166, 243, 252-255`)                  | **EXTEND**                 | Preserve the criterion→CA spawn (exemplary); add a notification on inspection submit and on criterion fail                                                    | inspection records/criteria, CA spawn, `inspections.*`, flow profile                                                     | (none required)                                                                                  | Spawn is notification-complete (`recordDomainEvent` at `inspections/_lib.ts:370`); EA-12 made the PPE path notification-complete too                                                               |
| **Finding / Hazard**      | **No ancestor entity.** 8 parallel partial lifecycles (§6). Closest: `corrective_actions` (the only complete one)                                                                                                                                                                                 | **NEW**                    | New native module `findings` as the shared ancestor; make each existing lifecycle a child or a view                                                           | `corrective_actions` columns as template; `flow_gates` for verification; `recordDomainEvent` pattern; CA spawn helpers   | `findings` table + child links; `DomainNotificationEvent` finding kinds                          | Without it, every new HSE capability reinvents a partial lifecycle — the failure mode already observed 8×                                                                                          |
| **Risk**                  | **No model.** 4 nullable ints on `hazid_assessment_hazards` (`hazid-assessments.ts:198-204`); derived score never persisted; compliance blind to level (`evaluate.ts:671-755`)                                                                                                                    | **NEW**                    | New native module `risks` (register), seeded from hazid hazard rows                                                                                           | `tenants.risk_matrix` config (`core.ts:41`), `risk-matrix.tsx` scoring, `hazid_assessment_hazards`, `corrective_actions` | `risks` table; risk report entity/view; risk compliance adapter                                  | Library task ratings never reach assessments (`_actions.ts:503-512` copies no L/S) — must decide whether to fix or seed from hazards only                                                          |
| **Incident**              | `incidents` (type/severity/status enums, 9 sub-tables incl. injury taxonomy, lost-time events, root-cause whys, contributing factors, inline `incident_preventative_steps`) — `incidents.ts`                                                                                                      | **PRESERVE** → then EXTEND | Preserve the rich model; add due date + a link from `incident_preventative_steps` to `corrective_actions`                                                     | incidents + 9 sub-tables, `incident.*` notifications, `incident_rates` report                                            | `due_on` on incident; CA link on preventative steps                                              | `incident_preventative_steps` is a **dead-end mini-CAPA** (`incidents.ts:515-517` "linking to a full CAPA is a follow-up") — its work never reaches CAPA metrics                                   |
| **Investigation**         | Root-cause 5-why (`incident_root_cause_whys`) + contributing factors (`incident_contributing_factors`) inline; `incidents.status` has `under_investigation`/`pending_review`; no separate investigation entity                                                                                    | **ADAPT**                  | Adapt existing inline model + add CA link so investigation outputs feed resolution                                                                            | `incident_root_cause_whys`, `incident_contributing_factors`, `ca` from incidents                                         | (link columns)                                                                                   | Investigation has no due date or SLA; `pending_review` has no reviewer field                                                                                                                       |
| **HSE Action**            | `corrective_actions` — **the reference lifecycle**: severity, status(5), `source`(7), `owner`, `assigned_by`, `due_on`, `verification_required`, `verified_by/at/notes`, `locked`, `ca_complete_steps` (`corrective-actions.ts:56-182`)                                                           | **PRESERVE**               | Preserve and use as the template for `findings`                                                                                                               | entire `corrective_actions` model                                                                                        | none                                                                                             | It is the only lifecycle with all four of owner/due/verify/notify — protecting it is the anchor of the whole plan                                                                                  |
| **Verification**          | Exists **only** in `corrective_actions` (`verification_required`, `verified_by`, `verified_at`, `verification_notes`, `ca_complete_steps` kind=verification). Work orders have `verified` enum only; hazid has advisory `review_status` ("never locks", `hazid-assessments.ts:95-96`)             | **ADAPT**                  | Adapt the CA verification pattern into `flow_gates` as the shared verification layer for all lifecycles                                                       | `ca_complete_steps`, `flow_gates` (`forms.ts:617-678`), `ca.verify` permission                                           | verification binding in `flow_gates` for non-CA subjects                                         | Verification is not reusable today; `flow_gates` is the designed home but is not yet wired as a generic verifier                                                                                   |
| **HSE Dashboard**         | Insights + Dashboards (native BI, `insights.ts`, `insight-dashboards.ts`); home metrics (`_metrics.ts`); **no risk surface anywhere**                                                                                                                                                             | **EXTEND**                 | Extend existing insights/dashboards with a findings/risk dataset                                                                                              | insights, dashboards, report views                                                                                       | risk/findings dataset (requires the `risks`/`findings` models first)                             | Blocked on Finding/Risk; dashboard cannot show risk until those exist                                                                                                                              |
| **HSE Reports**           | 16 report entities + 9 report views + 32 seeded reports; **risk appears 0× in `views.ts`**; `hazid_signatures` is the only hazid entity (no assessment/hazard entity); no `ppe_annual_records` entity; `report_equipment_fleet` omits registration/insurance/warranty expiry                      | **EXTEND**                 | Extend report entities/views once findings/risks exist; add the missing expiry/machinery-cert columns to views                                                | all 16 entities, 9 views, report builder                                                                                 | risk/findings entities + views; missing expiry columns                                           | `report_equipment_fleet` doesn't project `registration/insurance/warranty_expires_on` → currently un-reportable                                                                                    |
| **HSE Notifications**     | **4** `DomainNotificationEvent` kinds (`domain-events.ts:24-38`); 4 recipient categories (`incident`, `ca`, `compliance`, `equipment`); cert expiry **only** via a hand-authored `cert_requirement` obligation (`scheduled.ts:251-254` "the compliance obligation engine is the single detector") | **ADAPT**                  | Adapt the existing outbox/event pattern; add finding/risk/machinery-cert/work-order kinds + an expiry notifier                                                | `recordDomainEvent`, outbox, `packages/events`, flow engine                                                              | new event kinds; expiry notifier                                                                 | 4 of 15 modules have any notification kind; PPE→CA spawn silently omits it (`ppe/_lib.ts` has no `recordDomainEvent`)                                                                              |
| **HSE Audit**             | `audit_log` table (`audit.ts:5`); 217 files call `recordAudit`; `admin.audit.read` permission                                                                                                                                                                                                     | **PRESERVE**               | Preserve; ensure new models record audit like existing ones                                                                                                   | `audit_log`, `recordAudit`, `admin.audit.read`                                                                           | (none)                                                                                           | Low. Just extend to any new model                                                                                                                                                                  |

---

## 5. Certificate Analysis

### 5.1 Structure inventory (STATIC VERIFIED)

Eight distinct certificate/expiry structures exist:

| #   | Structure                 | Table / column                                                           | Parent                                     | Expiry column                                                              |
| --- | ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | Issued course certificate | `training_certificates` (`training.ts:331-353`)                          | `training_records` (1:1, UNIQUE)           | — (on parent)                                                              |
| 2   | Course certificate fact   | `training_records` (`training.ts:208-284`)                               | person + course                            | `expires_on` (`:225`, indexed `:253`)                                      |
| 3   | Course validity rule      | `training_courses.valid_for_months` (`:48`)                              | —                                          | rule (null = never)                                                        |
| 4   | Issued skill certificate  | `training_skill_certificates` (`training-skills.ts:129-154`)             | `training_skill_assignments` (1:1, UNIQUE) | — (on parent)                                                              |
| 5   | Skill grant               | `training_skill_assignments` (`training-skills.ts:75-123`)               | person + skill type                        | `expires_on` (`:88`, indexed `:106`)                                       |
| 6   | Skill validity rule       | `training_skill_types.valid_for_months` (`:59`)                          | —                                          | rule (null = never)                                                        |
| 7   | PPE third-party cert      | `ppe_annual_records` (`ppe-annual-records.ts:38-80`)                     | `ppe_items`                                | `next_due_on` (`:50`)                                                      |
| 8   | Machinery cert            | **none** — free-text `equipment_inspection_records.certificate` (`:111`) | inspection record                          | via flat `registration/insurance/warranty_expires_on` on `equipment_items` |

### 5.2 Complete expiry-column register

All expiry-type columns across the schema (STATIC VERIFIED), grouped:

- **Credential:** `training_records.expires_on`, `training_skill_assignments.expires_on`, `training_courses.valid_for_months`, `training_skill_types.valid_for_months`, `training_enrollments.expires_on` (DEAD), `training_enrollments.due_on` (DEAD)
- **PPE:** `ppe_items.expires_on`/`next_inspection_due`/`next_annual_inspection_due`, `ppe_inspections.next_due_on`, `ppe_annual_records.next_due_on`
- **Equipment:** `equipment_items.warranty/registration/insurance_expires_on`, `rental_ends_on`, `next_oil_change_due`; `equipment_inspection_schedules.next_due_on` (NOT NULL); `equipment_reminders.due_on`; `equipment_inspection_records.next_due_on`
- **Documents:** `documents.review_frequency_months`/`next_review_on`, `document_versions.next_review_on`, `document_reviews.next_review_on`, `document_management_reviews.next_review_on`
- **Compliance/work:** `compliance_obligations.next_due_at`, `compliance_status.due_on`, `corrective_actions.due_on`, `inspection_record_criteria.assigned_due_date`, `form_responses.next_checkin_due_at`
- **Infra (non-HSE):** sessions, accounts, verification, attachment reservations, api keys

### 5.3 Dead columns (RUNTIME-verified as unread — STATIC VERIFIED grep)

Two expiry columns are defined but **never read or written** anywhere in `apps/` or `packages/`:

1. **`training_enrollments.expires_on`** (`training-lms.ts:217`) and **`training_enrollments.due_on`** (`training-lms.ts:216`) — grep `trainingEnrollments.expiresOn|dueOn` → 0 hits. Writes go to `training_records.expiresOn` instead.
2. **`equipment_inspection_records.certificate`** (`equipment-inspection-records.ts:111`) — grep `.certificate\b` in equipment/inspection context → 0 hits.

These are dead schema surface and should be removed (documented, not fixed, per read-only constraint).

### 5.4 Duplicated expiry-status computation (a real inconsistency)

Four independent implementations compute certificate expiry status with **different thresholds and different vocabularies**:

| Implementation               | Location                             | Threshold                           | Vocabulary                                                    |
| ---------------------------- | ------------------------------------ | ----------------------------------- | ------------------------------------------------------------- |
| Skill assignments view       | `views.ts:34-39`                     | 90 days                             | `no_expiry` / `expired` / `expiring` / `valid`                |
| Training matrix view         | `views.ts:121-127`                   | 90 days                             | `missing` / `valid` / `expired` / `expiring` (no `no_expiry`) |
| Compliance `expiryStatus`    | `compliance/src/evaluate.ts:762-768` | 30-day default (`remindBeforeDays`) | compliance statuses                                           |
| Signals (dashboard/expiring) | `compliance` signals `_signals.ts`   | 30 days                             | `HORIZON_DAYS`                                                |

Two duplicate expiry-derivation functions are byte-for-byte equivalent: `expiryForValidity` (`training/records/_actions.ts:155-165`) and `skillExpiry` (`training/skills/_actions.ts:114-124`), both capped at `MAX_TRAINING_VALIDITY_MONTHS`.

### 5.5 Query / permission / notification entry points

- **Query**: `/training/records` (expiry filters), `/training/skills/types/[id]` (valid/expiring/expired/no_expiry), `/my/wallet`, `/my/training` (expiring tab), `/people/[id]` (transcript), `/compliance/expiring`, `/dashboard`. Public: `/verify/[token]`, `/verify/person/[token]`.
- **Permission**: no `certificates.*`/`skills.*` key exists; folded into `training.read.all/self`, `training.record.create`, `ppe.read.all/manage`, `equipment.read.all/manage`, `compliance.read/manage/assign`, `reports.read/builder`, `admin.data.export`. Record-level via `canSeeRecord` (`training-credential-access.ts:35,72`).
- **Notification**: **none native for certificates.** Expiry alerts only arise if the tenant authors a `cert_requirement` obligation (`kind:'expiry'`, `remindBeforeDays:30`, forced at `compliance/obligations/_actions.ts:119-120`). The worker explicitly delegates this: `scheduled.ts:251-254` "Cert expiry … NOT scanned here — the compliance obligation engine is the single detector."
- **Reporting**: expiry surfaces in 5 seeded report families (`report-definitions.ts:401-736`) and 5 report views. **No `ppe_annual_records` report entity**; **`report_equipment_fleet` omits registration/insurance/warranty expiry.**

### 5.6 Verdict

Certificate is **ADAPT**, not NEW. The issuance/verification/public-QR pipeline is genuinely strong and should be preserved. The unification work is: (a) one expiry-status function replacing four divergent ones; (b) one expiry derivation replacing two duplicates; (c) delete the dead columns; (d) add a machinery-certificate model mirroring `ppe_annual_records`; (e) add a native expiry notifier. All of these are additive over an existing asset.

---

## 6. Finding/Hazard Analysis

### 6.1 The target lifecycle

The intended HSE chain is:

```
finding → classification → risk → measure → owner → corrective action → verification → close
```

### 6.2 The 8 parallel lifecycles that exist instead (STATIC VERIFIED)

There is **no `findings` table and no `hazards` table** — confirmed by grep across `packages/db/src/schema` and all `packages/db/drizzle` SQL (0 matches). Instead:

| #   | Lifecycle             | Table                          | State machine                                                       | Owner             | Due              | Verify         | Notify               |
| --- | --------------------- | ------------------------------ | ------------------------------------------------------------------- | ----------------- | ---------------- | -------------- | -------------------- |
| 1   | **Corrective Action** | `corrective_actions`           | `open→in_progress→pending_verification→closed`(+`cancelled`)        | ✅                | ✅               | ✅             | ✅                   |
| 2   | Incident              | `incidents`                    | `reported→under_investigation→pending_review→closed`(+`reopened`)   | investigator only | ❌               | ❌             | ✅                   |
| 2b  | Incident inline CAPA  | `incident_preventative_steps`  | `planned→in_progress→completed`                                     | person            | ✅ `target_date` | ❌             | ❌                   |
| 3   | Equipment Work Order  | `equipment_work_orders`        | `open→assigned→in_progress→awaiting_parts→repaired→verified→closed` | ✅                | ❌               | label-only     | web-flow only        |
| 4   | HSE Inspection        | `inspection_records`           | `draft→in_progress→submitted→closed`                                | performer         | ❌               | locked only    | ❌                   |
| 4b  | Failed criterion      | `inspection_record_criteria`   | **no status** (`answer` only)                                       | ✅                | ✅               | `corrected_on` | ❌ (spawns CA)       |
| 5   | Machinery Inspection  | `equipment_inspection_records` | `draft→in_progress→submitted→closed`                                | performer         | cadence          | ❌             | web-flow only        |
| 6   | PPE Issue Report      | `ppe_issue_reports`            | `open→resolved\|replaced`                                           | ❌                | ❌               | ❌             | ❌                   |
| 7   | Document Review       | `document_reviews`             | `in_progress→completed` × outcome                                   | ❌                | `next_review_on` | ❌             | ❌                   |
| 7b  | Mgmt Review           | `document_management_reviews`  | **no status column**                                                | chair             | `next_review_on` | ❌             | ❌ (delegates to CA) |
| 8   | HazID Assessment      | `hazid_assessments`            | in_progress+locked × advisory review_status                         | supervisor        | ❌               | advisory       | ❌                   |
| 8b  | HazID hazard row      | `hazid_assessment_hazards`     | **no status**                                                       | ❌                | ❌               | ❌             | ❌                   |
| —   | Safe Distance         | `safe_distance_records`        | **no status** (locked only)                                         | —                 | ❌               | ❌             | ❌                   |

**Only `corrective_actions` (#1) has all four of {owner, due date, verification, notification}.** Everything else is a strictly weaker shadow that reuses a subset of the same concepts in its own column vocabulary.

### 6.3 How they diverge (code-proven)

- **PPE failed inspection spawns a CA but emits no notification.** `ppe/_lib.ts` creates a `corrective_actions` row (`:74-104`) but never calls `recordDomainEvent`, unlike the identical inspections path (`inspections/_lib.ts:370`). So a PPE-derived CA is invisible to notifications.
- **Machinery inspection failure spawns a work order, never a CA**, and emits only a web flow event (`equipment/inspections/_lib.ts` imports `recordModuleFlowEvent` only). The failure is invisible to the entire CA/reporting/notification surface.
- **Work-order `verified` is decorative.** The enum has `verified` (`equipment.ts:290-299`) but there is **no `verified_by`/`verified_at` column** (confirmed by column list).
- **`incident_preventative_steps` is a dead end.** Owner + target date + status, but the schema comment (`incidents.ts:515-517`) says linking it to `corrective_actions` "is a follow-up" — its work never reaches CAPA metrics or compliance.
- **Flow engine `statusValues` bug.** `module-profiles.ts:577` (equipment) declares `['open','assigned','in_progress','awaiting_parts','closed','cancelled']` — **missing `'repaired'` and `'verified'`** which the DB enum and UI both support. The flow engine therefore cannot condition on two real states.

### 6.4 The common ancestor that does not exist

There is no single first-class `findings` record owning `{title, description, severity, source, source_entity_type/id, owner, site, assigned_on, due_on, status, verification_required, verification_*, closed_at, locked}` once. Each module duplicates a partial subset of these in its own vocabulary, with one-way untyped back-links (`inspection_record_criteria.corrective_action_id` is a typed FK; `equipment_inspection_record_criteria.work_order_id` is a plain uuid; `document_management_reviews.action_items_created` is untyped jsonb).

**Conclusion:** the finding chain exists today as a **reactive, per-module shuttle** (`corrective_actions` as an optional sink) rather than a **primary managed record**. Establishing `findings` as the ancestor is the highest-leverage NEW item.

---

## 7. Risk Register Analysis

### 7.1 What exists as a persistent model (STATIC VERIFIED)

The only persistent risk data is four nullable integers on a hazard row **inside an assessment snapshot**:

- `hazid_assessment_hazards.pre_likelihood`, `pre_severity` (`hazid-assessments.ts:198-199`)
- `hazid_assessment_hazards.post_likelihood`, `post_severity` (`:203-204`)
- plus `controls`/`standard_controls`/`specific_controls` (`:201`,`:193`,`:194`) and `applicable` (`:195`)

Supporting config: `tenants.risk_matrix` jsonb `RiskMatrixConfig` (`core.ts:41`, type `:61-64`); risk matrix editor `/hazard-assessments/risk-matrix`; `hazid_assessment_types.has_risk_ratings` (`hazid-libraries.ts:202`); library `hazid_tasks` pre/post L/S defaults (`hazid-libraries.ts:127-130`); a `risk_matrix` **form field type** (`forms-core/src/field-types.ts:358-365`).

**Confirmed absent as a persistent model:**

- No `risks` table. Risk lifetime is bound to an assessment (cascades on delete).
- No `risk_level`/`risk_score`/`inherent_risk`/`residual_risk` column — score is **derived at render, never persisted** (`components/risk-matrix.tsx:120-123`; comment `hazid-assessments.ts:179-181`).
- No risk **owner, assignee, due date, status, review date, or corrective-action link** on `hazid_assessment_hazards` (relations block `:494-504` has only tenant/assessment/hazard).
- No RAMS / SWMS / Bowtie anywhere (repo-wide grep → 0 matches). JSA/JHA/JSHA/FLHA exist only as display strings (`manual/content/frontline.ts:129-130,145`; `ai/src/prompts.ts:9`).

### 7.2 What exists only as form/field/config

- `risk_matrix` form field type — values live in form-response JSONB, never reach `hazid_assessment_hazards` or any report.
- Risk band label/colour/threshold and 3–6 × 3–6 axes on `tenants.risk_matrix`. Score formula is **fixed** to `(sev+1)×(lik+1)`; the validator rejects any other score (`risk-matrix/_policy.ts:52-55`) — no weights, no RPN, no nonlinear log.
- `hazid_assessment_type_apps` (`hazid-libraries.ts:303-344`) — a generic extension point where a RAMS/JSA could be modelled; currently hosts confined-space/arc-flash/fall-protection only.

### 7.3 Two critical findings

1. **Task-level risk ratings never reach the assessment.** Library `hazid_tasks` has pre/post L/S, but copy-on-add writes only `taskId, hazardIds, controls, entityOrder` (`hazard-assessments/_actions.ts:503-512`). In a `task_based` assessment the library rating is **write-only UI sugar**, never persisted, never queryable.
2. **Compliance is blind to risk level.** The `hazard_assessment` adapter (`compliance/src/evaluate.ts:671-755`) counts only signatures + assessments created (`frequencyProgress`). A crew can submit 100% Critical-rated assessments and report 100% compliant; a crew can submit 100% unrated assessments with no matrix at all and also report 100% compliant.

### 7.4 Risk in reporting (absent)

- The word `risk` appears **0 times** in `packages/db/src/views.ts` (499 lines, 9 views).
- The only HazID report entity is `hazid_signatures` (`entities.ts:501-534`) — signatures only; no `hazid_assessments` or `hazid_assessment_hazards` entity exists.
- No risk register report; no residual-risk-trend or inherent-vs-residual seeded report (`seed/report-definitions.ts`).
- No risk dashboard, no `/risks` nav entry.
- HazID list has **no project filter** (`hazard-assessments/_list.tsx:93-106,136-140`; `SORTS` at `:73` omits project).

### 7.5 Verdict

A genuine HSE **Risk Register** does not exist and is **NEW**. Its inputs (matrix config, L/S ratings, controls, applicability) all already exist natively — the register is a **promotion of existing data into a managed, queryable, reportable entity** with owner/status/dates that do not exist today. It cannot be built before the risk matrix and hazard ratings are stable, so it belongs after the Finding model and after the Certificate phase.

---

## 8. Machinery Analysis

### 8.1 Model completeness (STATIC VERIFIED)

`equipment_items` (`equipment.ts:84-240`) is unusually complete, with 60+ columns covering: identity (QR `qrToken`, `bulkQrToken`, `assetTag`, `serialNumber`, `vin`, `licensePlate`); classification (`typeId`, `categoryId`); ownership (`ownership`, `rentalProvider`, `rentalEndsOn`, `warrantyExpiresOn`); registration (`registrationExpiresOn`, `insuranceExpiresOn`); custody (`currentHolderPersonId`, `currentSiteOrgUnitId`, location history `equipmentLocationHistory`); utilization (`currentHours`, `currentOdometer`, `fuelType`, `powerRating`, `capacity`); maintenance (`requiresPreUseInspection`, `lastPreUseInspectionAt`, `requiresOilChange`, `oilChangeIntervalMonths`, `nextOilChangeDue`); checkout (`isAvailableForCheckout`, `isEquipmentBase` base semantics); missing/lost tracking (`isMissing`, `missingReportedAt/By`, `missingFoundAt`); draft (`isDraft`).

This is a **PRESERVE** — it is more complete than typical HSE equipment registers.

### 8.2 Inspection model

`equipment_inspection_types` — cadence `intervalValue`/`intervalUnit`, `isPreUse`, `allowPassAll`, `failsSpawnWorkOrders`, `hasSeverity`/`criticalSeverity` (STATIC VERIFIED).

`equipment_inspection_records` (`equipment-inspection-records.ts`) — snapshot/semi-structured: `reference`, `equipmentNameSnapshot`, inspector identity (**`inspectorTenantUserId`, `inspectorPersonId`, `inspectorText`** — `:101-103`), `supervisorTenantUserId`, `foremanPersonIds`, `hours`, `serial`, free-text `certificate` (`:111`, DEAD), `rentalProvider`/`isRental`, `nextDueOn` (`:94`), `result`, `locked`, plus per-criterion rows (`equipment_inspection_record_criteria` with `severity`, `comment`, `actionTaken`, `correctedOn`, `workOrderId`).

> **AUDIT OUTDATED (self-correction):** My earlier audit claimed equipment inspection records "lack inspector fields." That is **wrong** — they have three inspector identity columns. The genuine, narrower gap is: no **issuing organisation** (`inspector_company` equivalent — PPE has it), no **certificate document attachment** FK (`certificate_attachment_id` — PPE has it), and no **issue date**. See §21.

### 8.3 Machinery inspection → work order path

Fail→work-order spawn at `equipment/inspections/_lib.ts:280-324`: gated on type `failsSpawnWorkOrders` (or critical), priority from severity (`:299-300`), writes back `workOrderId` (`:306-317`), emits **web flow only** (`:318-323`, `recordModuleFlowEvent`) — **no notification payload** (confirmed: file imports only `recordModuleFlowEvent`).

Work order model (`equipment.ts:303-364`): status (8 values), priority, `assignedToTenantUserId` (owner), `reportedByPersonId`, `openedAt`/`closedAt`. **No due date, no `verified_by`/`verified_at`** (confirmed by column list).

### 8.4 Machinery certificate gap

There is **no machinery certificate entity**. Registration/insurance/warranty are flat columns on the asset (static document expiry), separate from inspection-schedule cadence (recurring). The compliance `evalEquipment` adapter (`evaluate.ts:798-804`) reads **schedules only** — the three flat expiry columns are excluded from every compliance obligation. Machinery cert is **ADAPT**: adopt the `ppe_annual_records` shape (which is the existing, correct third-party-cert pattern).

---

## 9. Personnel/Training Analysis

### 9.1 Personnel (STATIC VERIFIED)

Tables (`org.ts`): `people` (`:140`), `people_assignments` (`:241-269`), `departments` (`:72-93`), `trades` (`:95`), `crews` (`:117`), `personGroups` + `personGroupMemberships` (`:20,:44`), `personTitles` + `personTitleAssignments` (`:27,:53`); `people.status` enum `active|inactive|terminated`.

Gaps:

- **`people_assignments` is a bare dated edge** — `id, tenantId, personId, orgUnitId, validFrom, validTo` — with **no position and no assignment-type**. Cannot express "Site Manager on Project X" or full-time vs contract.
- **`departments` has no `parentId`** (confirmed) — departments are flat, so department hierarchy is not modellable.
- **`people` nav is ungated** (`nav/registry.ts:172`) — every authenticated user sees the workforce directory (emergency contacts, DOB, termination dates). Writes are gated by `admin.org.manage` (`module-admin/registry.ts`). This is the **largest current exposure surface** in the HSE product.
- **No `people.*` permission keys** (confirmed 0 of 89). Personnel administration rides on `admin.org.manage`.

Personnel is **EXTEND**: preserve the (good) master model; add position/assignment-type to `people_assignments`; add a `people.read.*` tier.

### 9.2 Training (STATIC VERIFIED)

The strongest HSE module. Tables: `training_courses`, `training_records`, `training_classes`, `training_enrollments`, `training_assessments`, `training_certificates`, `training_record_files`, `training_skills`, `training_skill_types`, `training_skill_assignments`, `training_skill_certificates`, `training_skill_authorities`, `training_extra_fields`, `training_lms` (enrollments/assignments).

Completeness markers: validity rules (`valid_for_months`), source enum (`class|self_paced|evaluator|external_upload|migrated`), score+grade, certificate issuance (auto/photo), revoke, wallet cards, credential design studio, public QR verify, LMS, `training_matrix` view (person × course coverage). Reporting: 9 report entities/views + ~9 seeded training reports (`report-definitions.ts:401-629`).

Gaps (all minor): the two dead `training_enrollments` expiry columns (§5.3); no native expiry notification (§5.5).

Training is **PRESERVE** — it is the reference-quality HSE module.

---

## 10. Incident/Investigation Analysis

### 10.1 Incident model (STATIC VERIFIED)

`incidents` (`incidents.ts`): `type` (`injury|illness|near_miss|property_damage|environmental|security|other`), `severity` (`first_aid_only|medical_aid|lost_time|fatality|no_injury`) + integer `actualSeverity`/`potentialSeverity`/`severityRating`, `status` (`reported|under_investigation|pending_review|closed|reopened`), `siteOrgUnitId`, `supervisorPersonId`, `assignedInvestigatorTenantUserId`, `closedByTenantUserId`, `locked`/`closedAt`, statutory fields (`molReportNumber`, `externallyReportable`, `policeReportNumber`).

**9 sub-tables** (all present): `incident_people`, `incident_injuries` (+`incident_injury_type_assignments` taxonomy), `incident_lost_time_events` (off_work→restricted_duty→full_duty), `incident_attachments`, `incident_events` (timeline), `incident_contributing_factors`, `incident_root_cause_whys` (1–5 why), `incident_preventative_steps` (inline mini-CAPA).

This is a **rich, well-factored incident model** — PRESERVE.

### 10.2 Investigation

There is **no separate investigation entity**. Investigation is expressed as: `incidents.status` moving through `under_investigation`/`pending_review`, plus inline `incident_root_cause_whys` (ordinal 1–5) and `incident_contributing_factors` (categorised). Notification fires on `incident_reported` and `incident_status_changed` (`domain-events.ts:25-31`).

Gaps: investigation has **no due date / SLA** and `pending_review` has **no reviewer field**. `incident_preventative_steps` (the inline CAPA) is a dead end — see §6.4.

Investigation is **ADAPT**: keep the inline model, add a CA link so investigation outputs feed resolution, add a reviewer/SLA on `pending_review`.

---

## 11. Action/Verification Analysis

### 11.1 Corrective Action — the reference lifecycle (STATIC VERIFIED)

`corrective_actions` (`corrective-actions.ts:56-128`) is the **only** lifecycle with the full quartet:

- **Owner**: `ownerTenantUserId` (`:74`), `assignedByTenantUserId` (`:73`)
- **Due**: `dueOn` (`:77`), `assignedOn` (`:76`)
- **Verification**: `verificationRequired` (`:90`), `verifiedByTenantUserId` (`:92`), `verifiedAt` (`:93`), `verificationNotes` (`:91`), `locked` on close (`:98`), `ca_complete_steps` (kind=`verification|action_taken|signature`, `:160-182`)
- **Notification**: `corrective_action_assigned` + `corrective_action_completed` (`domain-events.ts:32-38`)

Enforcement in app code (`corrective-actions/_actions.ts`): close blocked when locked or (verificationRequired && !verifiedAt) (`:468-489`); verify writes `verifiedAt/By` and transitions to `pending_verification` (`:370-438`); reopen clears lock (`:555-563`).

Severity: `low|medium|high|critical` (`:25-30`). Source: `inspection|incident|near_miss|observation|audit|jsha|other` (`:40-48`) — a broad source taxonomy already, which is _notably forward-compatible_ with a future `findings` ancestor.

**The CA model is PRESERVE and should serve as the template for every new lifecycle.**

### 11.2 Verification is not reusable

Verification exists **only** inside CA. The other lifecycles approximate it:

- Work order: `verified` enum value, **no verifier identity** (decorative).
- HazID: `review_status` `pending|approved|rejected` but explicitly **advisory** ("never locks the assessment or blocks field work", `hazid-assessments.ts:95-96`).
- Criterion rows: `corrected_on` (a date, not a verifier sign-off).
- Documents: review outcomes, no verification.

The designed generic home is **`flow_gates`** (`forms.ts:617-678`) — "the single gate store … so we never build two gate systems" — already able to gate 15 subjects (`flows/registry.ts:30-46`). It is **not yet wired as a generic verifier**.

Verification is **ADAPT**: adopt the CA verification pattern into `flow_gates` so any finding-bearing subject can require verification, with a verifier identity and timestamp.

---

## 12. Permission / Project Scope Analysis

### 12.1 The model (STATIC VERIFIED)

- `PERMISSION_CATALOGUE` (`iam.ts:155-296`): **89** unique keys. 4 built-in roles (`worker`, `foreman`, `safety_manager`, `tenant_admin` — `iam.ts:301-448`); `tenant_admin` holds the full catalogue.
- `RoleScope` (`iam.ts:49-55`): **6 variants** — `tenant`, `sites(siteIds)`, `team(departmentIds,groupIds)`, `people(personIds)`, `crews(crewIds)`, `self`. **No project/org_unit variant.**
- Scopes are per-assignment (`role_assignments.scope`, `iam.ts:66`), not per-role.
- `RequestContext` (`packages/tenant/src/index.ts:36-74`) carries `permissions: Set<string>` + `scopes: RoleScope[]`; `can()` (`:101-110`) is a pure boolean permission-string test; `readTierCovers()` (`:243-253`) maps `.read.all/.site/.self` tiers.
- Record visibility (`apps/web/src/lib/visibility.ts`): `recordVisibilityWhere()` (`:46-95`) and `moduleScopeWhere()` (`:156-177`), driven by `resolveVisibilityTier()` (`:114-118`) — **exactly 3 tiers: `all` / `site` / `self`**.

### 12.2 Project model

There is **no `projects` table** and **no `sites` table** (confirmed). Projects are `org_units` with `level='project'` (`orgUnitLevel` = `customer|project|site|area`, `org.ts:24`). `org_units` is self-referential via `parentId` (`org.ts:33,64-68`), so a project→site→area hierarchy exists. Seed creates one project + two sites (RUNTIME VERIFIED: `org_units: customer=1, project=1, site=2`).

### 12.3 Can "this user may only see incidents on project X" be expressed today?

**No.** Three independent structural blockers, any one fatal:

1. `RoleScope` has no project/org_unit variant (`iam.ts:49-55`).
2. `resolveVisibilityTier` has exactly 3 tiers — `all`/`site`/`self` — and is permission-driven, scope-blind (`visibility.ts:106,114-118`). Holding `incidents.read.all` returns **no record filter at all** (tenant-wide).
3. The scope picker hard-filters `orgUnits.level = 'site'` (`admin/users/_scope-data.ts:61-65`), so a project id can never enter `siteIds`.

The only existing workaround is semantically wrong: grant `*.read.site` plus a `sites` scope enumerating every site under project X — which is not a project, excludes project-level records, and breaks when a site is added.

### 12.4 Minimal extension — no new User/Organization/Permission concepts (STATIC VERIFIED precedent)

The fix is **purely additive** and needs **zero new tables** if the people-based route is taken:

- **Route A (person-based, zero migration):** `people_assignments` already has `orgUnitId` + `validFrom`/`validTo` (`org.ts:248-251`). `packages/compliance/src/audience.ts:89-104` **already resolves "the people on project X"** by joining `people_assignments` on `orgUnitId` with a validity window covering today. Reuse that exact pattern to derive a person-id set, which already feeds `recordVisibilityWhere`'s `people` scope (`visibility.ts:69-70`).
- **Route B (record-based, one scope variant):** add `{ type: 'orgUnits'; orgUnitIds: string[] }` to `RoleScope`; add a `project` tier to `resolveVisibilityTier`; emit a **descendant-expanding** predicate using the self-referential `orgUnits.parentId` (recursive CTE is trivial; `form-picker-entities.ts:246-251` already shows the level-typed pattern); drop the `level='site'` hard-filter in the scope picker. Optionally add `<prefix>.read.project` tier keys (note `readTierCovers` regex at `tenant/src/index.ts:244` must be widened to match a `.read.project` key).

**API keys**: `api_keys` has `permissions` + `builderTemplateIds` but **no scope column** (`api-keys.ts:19-45`) — API-key project scoping is impossible at the storage layer today (would need a column, i.e. a small schema change).

**Recommendation:** Route A first (zero migration, reuses a proven pattern), Route B only if record-level (rather than people-level) project filtering is required.

### 12.5 Related finding — nav gate inconsistency

`nav/registry.ts:185` and `module-admin/registry.ts` both reference `equipment.read.self`, which is **not in `PERMISSION_CATALOGUE`** (only `equipment.read.all` / `equipment.read.site` at `iam.ts:208-209`). It passes today only because `readTierCovers` tier-maps it (`tenant/src/index.ts:249-251`). Latent breakage risk. (Documented, not fixed.)

---

## 13. Notification Analysis

### 13.1 Current surface (STATIC VERIFIED)

`DomainNotificationEvent` — exactly **4** kinds (`domain-events.ts:24-38`):

- `incident_reported` (`:25`)
- `incident_status_changed` (`:26-31`)
- `corrective_action_assigned` (`:32-37`)
- `corrective_action_completed` (`:38`)

`DomainWebCommand` — 4 kinds (`domain-events.ts:47-89`): `module_flow`, `form_submitted`, `flow_gate_decided`, `form_status_changed`.

Recipient categories (`packages/events/src/recipients.ts:22-27`) — exactly **4**: `incident`, `ca`, `compliance`, `equipment`. Purpose-built emitters: `emitComplianceTransitions`, `emitEquipmentMaintenanceDue` (`events/src/index.ts:327-469, 529-577`).

Outbound integrations — 8 triggers / 5 destinations (`packages/integrations/src/triggers/registry.ts`; destinations email, http, sheets, slack, sql).

### 13.2 Coverage gaps

Native notification exists for **incidents and corrective actions only**. Modules with **no** notification kind: work orders, PPE issue reports, inspection records, inspection criterion fails, machinery inspections, document reviews, flow gates, hazid reviews. Certificate expiry is delegated entirely to the compliance obligation engine (`scheduled.ts:251-254`).

Concrete divergences (code-proven):

- PPE→CA spawn omits `recordDomainEvent` (`ppe/_lib.ts`) → PPE-derived CAs are unnotified, unlike the identical inspections path.
- Machinery-inspection→work-order emits web flow only → unnotified.

### 13.3 Verdict

Notifications are **ADAPT**: reuse the existing outbox/event architecture; add notification kinds for the new `findings`/`risks` models and an expiry notifier for certificates; backfill the PPE and machinery paths. No new notification architecture is needed.

---

## 14. Reporting / Dashboard Analysis

### 14.1 Current surface (STATIC VERIFIED)

- **16 report entities** (`packages/reports/src/entities.ts:20-539`): incidents, corrective_actions, training_records, skill_assignments, inspection_records, documents, equipment_items, equipment_fleet, vehicle_log_entries, vehicle_log_monthly, ppe_items, training_matrix, incident_rates, compliance_status, monitored_sessions, hazid_signatures.
- **9 report views** (`packages/db/src/views.ts`): report_skill_assignments, report_training_matrix, report_incident_rates, report_vehicle_log_entries, report_vehicle_log_monthly, report_equipment_fleet, report_ppe_items, report_corrective_actions, report_training_records.
- **32 seeded reports** (`seed/report-definitions.ts`).
- Native BI: `insights.ts`, `insight-dashboards.ts`, `dashboard-layouts.ts`; home metrics in `_metrics.ts`.

### 14.2 Gaps relevant to HSE

- **Risk absent from reporting entirely** — word `risk` appears 0× in `views.ts`; no hazid assessment/hazard report entity (only `hazid_signatures`).
- **No `ppe_annual_records` report entity** — the third-party PPE certificate is not queryable from Reports.
- **`report_equipment_fleet` omits** `registration_expires_on` / `insurance_expires_on` / `warranty_expires_on` → machinery registration/insurance compliance is currently un-reportable.
- **No cross-project HSE dashboard** and no project filter on the HazID list.
- Findings/risk dashboards are **blocked** on the Finding/Risk models (§7, §6).

Reporting/Dashboard is **EXTEND**: preserve the report studio and views; add entities/views once findings/risks exist; backfill the missing expiry columns.

---

## 15. Builder vs Native Module Decision

Per the Builder-first principle, the decision for each capability is: **can it be delivered via the existing Builder/Form/Workflow/Notification/Report primitives?**

### 15.1 Primitives available (STATIC VERIFIED)

- 46 field types including `risk_matrix`, `person_picker`, `project_picker`, `signature`, `typed_attestation`, `sketch`, `table`, `data_table`.
- 6 flow triggers (`on_submit`, `on_field_value`, `status_change`, `scheduled`, `session_overdue`, `manual`) and 13 actions (`send_email`, `create_capa`, `create_incident`, `notify_role`, `set_field`, `flag_non_compliant`, `webhook`, `create_response`, `analyze_photos`, `start_monitored_session`, `change_status`, `duplicate_record`, `export_pdf`).
- A generic human-gate store (`flow_gates`) that can gate any of 15 module subjects.
- Report studio, insights BI, compliance engine, 8 outbound integration triggers.

### 15.2 What Builder **can** deliver (do NOT build native modules for these)

- **RAMS / JSA / SWMS as documents** → Builder App + `project_picker` + `risk_matrix` field + `signature` + flow gates. `hazid_assessment_type_apps` (`hazid-libraries.ts:303-344`) is the existing attachment point.
- **Custom inspection checklists, toolbox talks, permit-to-work, checklists** → Builder Apps (existing seeded templates demonstrate this).
- **Notification/automation wiring for new models** → Flow engine (`notify_role`, `send_email`, `webhook`), not native emitters.
- **Ad-hoc dashboards for existing data** → Insights BI.
- **Project-scoped checklists** → Builder `project_picker` (no native change needed).

### 15.3 What genuinely requires native modules (Builder is insufficient)

A new native module is justified only for: complex state machine, dedicated API, dedicated permission, transactional cross-model logic, performance, or an authoritative queryable record. Applying that test:

1. **`findings` — NEW native module.** Justified: it must be the **authoritative cross-module record** with a real state machine, a dedicated permission (`findings.*`), transactional owner/due/verification columns, and a query surface spanning modules. Builder forms cannot own a cross-module canonical record, cannot be gated by a dedicated permission tier, and cannot support transactional owner/verify invariants. _This is the strongest NEW justification in the plan._
2. **`risks` — NEW native module.** Justified: it needs an authoritative, queryable, reportable entity with owner/status/review-date and a compliance adapter. The Builder `risk_matrix` field stores values inside form-response JSONB, invisible to reports, compliance, and dashboards. A register requires a first-class table.
3. **`machinery_certificates` — ADAPT (native table, no module).** Justified by data-model necessity (the `ppe_annual_records` pattern); it does **not** need a full native module (no complex state machine) — a table + read-only surface suffices, reusing the equipment module.
4. **Everything else — no new module.** Personnel, Training, Machinery, Machinery Inspection, HSE Inspection, Incident, HSE Action are all EXTEND/PRESERVE/ADAPT of existing native modules. Verification reuses `flow_gates`. Notifications reuse the event outbox. Reporting extends the studio.

**Net: 2 new native modules (`findings`, `risks`) + 1 new native table (`machinery_certificates`). No other module is justified.**

---

## 16. Data Model Unification Plan

Ordered, additive, and each item reuses an existing template. (Plan; EA-12 implemented the dead-column deletion in item 1, the rest remains unimplemented.)

### 16.1 Certificate unification

1. ~~Delete dead columns~~ **Done in EA-12:** `training_enrollments.expires_on`, `training_enrollments.due_on` and `equipment_inspection_records.certificate` were dropped by migration `0051`.
2. Replace the 4 divergent expiry-status computors (§5.4) with **one** shared function + constant horizon (standardize on one threshold).
3. Replace duplicate `expiryForValidity`/`skillExpiry` with **one** derivation helper.
4. Add `machinery_certificates` mirroring `ppe_annual_records` (year, inspector, `inspector_company`, `certificate_attachment_id`, `next_due_on`).
5. Project `registration/insurance/warranty_expires_on` into `report_equipment_fleet`; add a `ppe_annual_records` report entity.

### 16.2 Finding unification

1. Add `findings` table as the ancestor, modelled on `corrective_actions` (reuse its severity/status/owner/due/verification columns verbatim as the shape).
2. Add typed links from each lifecycle into `findings`: `inspection_record_criteria` (already typed FK), `equipment_inspection_record_criteria.work_order_id`, `ppe_issue_reports`, `incident_preventative_steps`, `hazid_assessment_hazards`.
3. Add a native expiry notifier and the missing notification kinds (PPE→CA, machinery→WO).
4. Fix the `equipment` flow-profile `statusValues` gap (`module-profiles.ts:577`): add `'repaired'`, `'verified'`.
5. Give `equipment_work_orders` a due date + `verified_by`/`verified_at` so `verified` stops being decorative.

### 16.3 Risk unification

1. Add `risks` table (owner, status, inherent/residual L×S, review date, corrective_action link, project_org_unit_id).
2. Seed from `hazid_assessment_hazards`; **decide** whether to also fix task-level L/S persistence (`_actions.ts:503-512`) or seed only from hazard rows.
3. Add risk report entity + view; add a `project` filter to the HazID list.
4. Add a risk-aware compliance adapter (today the adapter is frequency-only).

### 16.4 Permission/scope unification

1. Add a `project`/`orgUnits` visibility tier (Route B) or reuse the compliance people-by-org-unit pattern (Route A, zero migration).
2. Add `people.read.*` permissions and gate the `people` nav entry (currently ungated).
3. Consider a scope column on `api_keys` for API-key project scoping.

---

## 17. Recommended Development Sequence

The sequence below is derived from the code analysis, not the reference order. **Rationale for departures from the reference order is stated per phase.**

### Phase 1 — Data model unification (cleanup + shared helpers)

- Delete dead certificate/inspection columns; unify expiry-status + expiry-derivation helpers; fix the `equipment` flow-profile `statusValues` gap.
- **Why first:** these are low-risk, self-contained, remove dead surface, and establish shared helpers that later phases reuse. Doing them later means every new model is written against duplicated expiry logic.

### Phase 2 — Certificate ADAPT

- Add `machinery_certificates` (mirror `ppe_annual_records`); add native expiry notifier; backfill missing report columns/entities; add a `ppe_annual_records` report entity.
- **Why here:** the machinery-cert model is a self-contained ADAPT of a proven existing pattern and does not depend on findings/risks. It closes the highest-frequency real-world gap (third-party equipment certs) cheaply. Notification unification (§13) is also independent and lands here.

### Phase 3 — Finding NEW (root model)

- Add the `findings` ancestor table + typed links from all 8 lifecycles; add finding notification kinds.
- **Why here and not later:** every subsequent phase (risk seeding, dashboard, reporting, action convergence) benefits from a canonical finding record existing first. Building findings late would force rework of every downstream model.

### Phase 4 — Risk Register NEW

- Add `risks` table seeded from hazid hazard rows; decide task-level L/S persistence; add risk report entity/view + compliance adapter.
- **Why after Finding:** a risk's owner/status/due/verify should reference the finding/CA chain established in Phase 3, avoiding a second parallel resolution model.

### Phase 5 — Machinery Certificate (folded into Phase 2)

The reference order lists Machinery Certificate as a later phase, but the analysis shows it is the **same ADAPT** as Certificate Phase 2 with no dependency on findings/risks. **Recommend folding it into Phase 2** rather than deferring.

### Phase 6 — Action/Verification convergence

- Wire `flow_gates` as the generic verification layer; give work orders due/verifier columns; link `incident_preventative_steps` to CA.
- **Why after Finding/Risk:** verification should attach to the canonical finding record introduced in Phase 3, not to scattered per-module tables.

### Phase 7 — Incident/Investigation completion

- Add incident due date, `pending_review` reviewer, and investigation→CA link.
- **Why after Action:** investigation outputs should feed the now-canonical Action/Verification flow.

### Phase 8 — HSE Dashboard / Reports

- Add findings/risk datasets to insights/dashboards; add cross-project views.
- **Why last among features:** dashboards can only present risk/findings once those models (Phases 3–4) exist.

### Phase 9 — Notifications completion

- Backfill remaining notification gaps (already largely done in Phase 2); consolidate onto the event outbox.
- **Why here:** depends on the final set of models to notify.

### Phase 10 — Permission / Project Scope

- Add project/org-unit visibility tier (Route A then B); add `people.*` gates; API-key scope.
- **Why last:** project scoping is a cross-cutting authorization change; applying it before the new models stabilise would require touching each model twice. It is also **independently shippable** and could be pulled earlier if project separation is an urgent business need.

**Net ordering rationale:** cleanup → self-contained ADAPT → canonical model (findings) → register (risks) → convergence → completion → presentation → notifications → authorization. The two departures from the reference order are: **Machinery Certificate folded into Certificate (Phase 2)**, and **Finding/Risk moved earlier** (before Action/Incident/Dashboard) because they are the canonical records everything else converges on.

---

## 18. Dependencies

- **Phase 1** — no dependencies. Self-contained.
- **Phase 2** — depends on nothing (Certificate ADAPT is independent). Machinery-cert sub-item reuses `attachments` + `equipment_inspection_records`.
- **Phase 3** — Finding model depends on Phase 1 helpers and the CA column shape; RLS registration required (`TENANT_SCOPED_TABLES`, `rls.test.ts` enforces exact coverage).
- **Phase 4** — Risk depends on Phase 3 (owner/verify reference findings/CA) and on stable hazard ratings.
- **Phase 6** — Verification depends on Phase 3 (findings) and `flow_gates`.
- **Phase 7** — Incident depends on Phase 6 (Action/Verification).
- **Phase 8** — Dashboards/reports depend on Phases 3–4 (findings/risks).
- **Phase 9** — Notifications depend on the final model set.
- **Phase 10** — Permission/scope is cross-cutting; recommended last, but independently shippable.

**Cross-cutting constraint on every tenant-scoped phase:** new tables must be registered in `TENANT_SCOPED_TABLES` (`packages/db/src/rls.ts`) or the `rls.test.ts` exact-coverage test fails.

**Platform prerequisites (already satisfied, RUNTIME VERIFIED):** MinIO storage baseline green (25/25), migrations + seed applied, RLS enforced live. No new infrastructure is required for any phase.

---

## 19. Risks

- **R1 — Findings model scope creep.** A `findings` ancestor that tries to absorb all 8 lifecycles at once risks destabilising working modules. _Mitigation:_ land `findings` as an additive ancestor with typed links; do not migrate existing rows in the first phase.
- **R2 — Permission/scope change is cross-cutting.** Adding a project tier touches `RoleScope`, visibility, the scope picker, and (if Route B) `readTierCovers`. Doing it late reduces rework; doing it early could unblock urgent project-separation needs. _Mitigation:_ Route A (zero migration, reuse compliance pattern) first.
- **R3 — Compliance blind spot on risk persists until Phase 4.** The `hazard_assessment` adapter counts frequency only, so fully-rated-critical risk reads as compliant until then. _Mitigation:_ document the gap explicitly (Phase 1); close in Phase 4.
- **R4 — `people` exposure surface.** The ungated `people` nav (master data incl. emergency contacts, DOB) is the largest current privacy exposure. _Mitigation:_ can be fixed independently and early, ahead of the full scope work.
- **R5 — Dead/decorative verification on work orders.** `verified` status with no verifier identity persists until Phase 6; machinery findings remain unreported until then. _Mitigation:_ the `statusValues` fix (Phase 1) at least makes the states visible to the flow engine.
- **R6 — Report-view gaps under-report compliance.** `report_equipment_fleet` omits registration/insurance/warranty expiry, so machinery compliance is un-reportable until Phase 2. _Mitigation:_ included in Phase 2 scope.
- **R7 — Two native modules is a real commitment.** `findings` + `risks` each require schema, RLS, permissions, APIs, notifications, reports, UI, manual articles, and tests. _Mitigation:_ the Builder-first analysis (§15) confirms these two are the only genuinely justified native modules; everything else is reuse.

---

## 20. Explicit Non-goals

This baseline is **analysis only**. It does **not** implement anything. Specifically, the following are out of scope and were **not** done:

- No source code, schema, migration, seed, compose, `.env`, permission, or database changes.
- No new native modules built (`findings`, `risks`, `machinery_certificates` are **proposed**, not created).
- No defect fixes (the 6 defects in §21 and throughout are **documented only**, per the read-only constraint).
- No RAMS/JSA/SWMS product decision beyond "Builder is sufficient" (§15.2).
- No decision on which risk-matrix threshold/horizon to standardize to (§16.1) — flagged as a decision, not made.
- No re-do of the SeaweedFS analysis or storage work (storage is a completed, referenced baseline).
- No HSE feature development of any kind.

---

## 21. Audit Differences

### 21.1 AUDIT OUTDATED (self-corrections vs. prior audit)

Where the earlier audit / prior docs disagreed with current HEAD, **current code wins**. Four corrections:

| #   | Prior claim                                          | Actual at HEAD                                                                                                             | Cause                                                                                                                                  |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "92 permission keys"                                 | **107** unique (`iam.ts:155-372`)                                                                                          | Earlier counts were stale; the catalogue is the authoritative source                                                                   |
| 2   | "12 report entities"                                 | **18** (`entities.ts`)                                                                                                     | Prior count missed hazid_signatures, compliance_status, monitored_sessions, etc.                                                       |
| 3   | "39 form field types"                                | **46** (`field-types.ts`)                                                                                                  | Prior count missed table, ranking, matrix, sketch, typed_attestation, lookup, data_table, metric, …                                    |
| 4   | "equipment inspection records lack inspector fields" | **They have 3**: `inspectorTenantUserId`, `inspectorPersonId`, `inspectorText` (`equipment-inspection-records.ts:101-103`) | Prior gap statement was too broad; the true gap is narrower (no issuing _organisation_, no certificate _attachment_ FK, no issue date) |

**Prior docs that remain accurate:** `beaconhs-capability-matrix.md` (risk ADAPT verdict), `hse-gap-analysis.md` (§3.2 no standalone risk register), `beaconhs-extension-points.md`, `beaconhs-architecture.md`. No correction needed to their substantive conclusions.

### 21.2 Defects discovered during re-verification (status as of EA-12)

| #   | Defect / status                                                                                                                                                                                          | Location                                                               | Severity / resolution            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------- |
| D1  | **FIXED (EA-12).** Nav + module-admin now reference catalogue keys; the previous `equipment.read.self` references were stale.                                                                            | `nav/registry.ts`, `module-admin/registry.ts`                          | Regression coverage added        |
| D2  | **FIXED (EA-12).** `people` now requires `people.read.all`; direct access and export are gated.                                                                                                          | `nav/registry.ts`; `/people` route/export                              | Access tests added               |
| D3  | **FIXED (EA-12).** The three columns were dropped; the only code references were two write-only enrollment assignments, removed with them. Migration `0051` applied locally after a zero-non-null check. | `training-lms.ts`, `equipment-inspection-records.ts`, migration `0051` | Schema/migration regression test |
| D4  | **FIXED (EA-12).** PPE failed-inspection → CA now emits `corrective_action.created` with notification, integration and web-flow payloads, matching inspections.                                          | `ppe/_lib.ts`                                                          | Unit test added                  |
| D5  | **FIXED (EA-12).** `equipment` flow-profile `statusValues` now includes `'repaired'` and `'verified'`, matching the DB enum and UI.                                                                      | `module-profiles.ts`; enum `equipment.ts`                              | Enum-parity test added           |
| D6  | **FIXED (EA-12).** Comment now matches `CANONICAL_TEMPLATES` and the deliberate non-canonical built-ins.                                                                                                 | `seed.ts` vs `canonical-templates.ts`                                  | Docs/code consistency            |

### 21.3 Evidence-status legend

- **RUNTIME VERIFIED** — proven against the running stack (e.g. RLS isolation, table/row counts, org_unit levels).
- **STATIC VERIFIED** — proven by code/schema inspection only (default for most findings).
- **UNVERIFIED** — could not be confirmed; would need runtime exercise (e.g. actual notification delivery for cert expiry through a hand-authored obligation; end-to-end verification-tier behaviour for non-CA subjects).

**No STATIC VERIFIED claim in this document is presented as RUNTIME VERIFIED.** The only RUNTIME VERIFIED claims are the storage baseline (referenced from prior work), the RLS isolation proof, and the object/row counts in §2.

---

## Appendix A — Key file references

| Area                                      | Location                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| Corrective action (reference lifecycle)   | `packages/db/src/schema/corrective-actions.ts:56-182`                                  |
| Hazard assessment hazards (risk snapshot) | `packages/db/src/schema/hazid-assessments.ts:183-221`                                  |
| HazID library                             | `packages/db/src/schema/hazid-libraries.ts`                                            |
| Incident model + 9 sub-tables             | `packages/db/src/schema/incidents.ts`                                                  |
| PPE issue reports                         | `packages/db/src/schema/ppe.ts:351-394`                                                |
| PPE third-party cert pattern              | `packages/db/src/schema/ppe-annual-records.ts:38-80`                                   |
| Machinery + work orders                   | `packages/db/src/schema/equipment.ts:84-364`                                           |
| Machinery inspection records              | `packages/db/src/schema/equipment-inspection-records.ts`                               |
| Flow gate store                           | `packages/db/src/schema/forms.ts:617-678`                                              |
| Notification events                       | `packages/db/src/schema/domain-events.ts:24-89`                                        |
| Permission catalogue                      | `packages/db/src/schema/iam.ts:155-296`                                                |
| Role scopes                               | `packages/db/src/schema/iam.ts:49-55`                                                  |
| Visibility tiers                          | `apps/web/src/lib/visibility.ts:106-177`                                               |
| Compliance evaluators                     | `packages/compliance/src/evaluate.ts`                                                  |
| Report entities / views                   | `packages/reports/src/entities.ts`, `packages/db/src/views.ts`                         |
| Risk matrix (component + editor)          | `apps/web/src/components/risk-matrix.tsx`, `app/(app)/hazard-assessments/risk-matrix/` |
| org_units (projects)                      | `packages/db/src/schema/org.ts:24-68`                                                  |
| people_assignments                        | `packages/db/src/schema/org.ts:241-269`                                                |
