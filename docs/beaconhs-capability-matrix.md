# BeaconHS — HSE Capability Matrix

> **Status:** read-only audit snapshot. **Audited:** 2026-09-29 · **Commit:** `70da27c4`
> Companion to [beaconhs-architecture.md](./beaconhs-architecture.md) (Part 3 covers the entity
> inventory these classifications are derived from).
>
> This document makes **no** change recommendations beyond the classification and the
> "what is missing" column. It is not a development plan.

## 摘要（中文执行摘要）

**最重要的结论：17 项 HSE 目标能力中，没有一项是完全缺失的。** BeaconHS 本身已经是一个
成熟的 HSE 平台，而不是需要从零建设的通用系统。

分类统计：

| 分类                  | 数量 | 能力                                                                                         |
| --------------------- | ---- | -------------------------------------------------------------------------------------------- |
| **PRESERVE** 直接保留 | 6    | Personnel、Training、HSE Inspection、Incident、Investigation、HSE Action                     |
| **EXTEND** 增量扩展   | 6    | Machinery Inspection、Verification、HSE Dashboard、HSE Reports、HSE Notifications、HSE Audit |
| **ADAPT** 需要改造    | 4    | Certificate、Machinery、Finding / Hazard、Risk                                               |
| **REPLACE** 替换      | 0    | 无                                                                                           |
| **NEW** 新建          | 1    | **Machinery Certificate**                                                                    |

**三项最关键的判断：**

1. **Incident 模块是全仓库最成熟的模块**，包含 OSHA-300 所需的完整医疗记录、损失工时
   可修改工作日计算、TRIR/DART 分类法。不应触碰。
2. **Certificate 是最大的一处结构性问题**：证书散落在 3 张表、有效期散落在 4 个字段、
   3 条签发路径，且没有统一的证书类型目录。数据都在，但缺少"证书"这个一等公民。
3. **Risk 没有独立的风险登记册**，风险只存在于 JSHA（作业安全危害分析）的快照内部，
   无法跟踪、无法周期性复审、无法与整改措施关联。这通常是法定要求。

**建议的建设顺序**（不在本文档展开，见 gap analysis）：先做 Machinery Certificate 与
Certificate 统一（数据基础），再做 Risk 登记册与 Finding 统一（业务基础），最后补
Verification 与 Notification 覆盖面（横切能力）。

---

# Classification legend

| Class        | Meaning                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| **PRESERVE** | Use as-is. Production-grade. Do not modify.                                          |
| **EXTEND**   | Foundation is correct. Add new capability additively.                                |
| **ADAPT**    | Capability exists but the data model is the wrong shape. Requires structural change. |
| **REPLACE**  | Exists but is actively wrong for HSE. Rewrite.                                       |
| **NEW**      | Nothing usable exists. Build from scratch (reusing existing primitives).             |

---

# The matrix

## 1. Personnel — **PRESERVE**

**Current state.** A complete HR-shaped worker master data model:
`people` (`org.ts:140`) with `employeeNo`, DOB, hire/termination, `departmentId`/`tradeId`/
`crewId`, `managerPersonId`, `emergencyContact*`, `badgeToken`, `signatureAttachmentId`,
`photoAttachmentId`; time-bounded site assignment via `people_assignments` (`org.ts:241`,
`validFrom`/`validTo`); `person_groups` + memberships; `person_titles` +
`person_title_assignments` (with `isPrimary`); `person_files` (resume / certification /
id_copy / other); plus flat `departments`, `trades`, `crews` catalogues. Routes cover
`/people/{page,new,[id],manage,departments,trades,crews,groups,titles,org-chart,custom-fields,
badges/design}`. Org chart exists. Badge QR and kiosk identity work.

**Why PRESERVE.** This is more than a name list — it is a real workforce model with
organisation hierarchy, temporal site assignment, and job-title structure. Rebuilding it would
be pure loss.

**What is missing (additive only).**

- No `people.*` permission namespace; nav entry has no `requiredPermission`
  (`nav/registry.ts:172`). **This is a real gap, not just an omission** — see
  [architecture §3.1](./beaconhs-architecture.md#31-user--exists-two-distinct-concepts).
- No medical / fitness-for-duty, immunisation, or health records.
- No driver licence class or licence expiry on a person.
- `people_assignments` has no position/assignment-type, so "who is the site supervisor for
  project X" is not answerable from data.
- `departments` is flat — no `parent` column, so departments cannot nest.

---

## 2. Certificate — **ADAPT**

**Current state.** There is **no `certificates` table**. Certificates are split across three
parallel shapes:

| Shape                                 | Location                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `training_certificates`               | `training.ts:331` — issued PDF + `verifyToken`, keyed on `training_records.recordId` |
| `training_skill_certificates`         | `training-skills.ts:129` — keyed on `training_skill_assignments.skillAssignmentId`   |
| `person_files` `kind='certification'` | `person-files.ts:28` — a raw file with no expiry semantics                           |

And **expiry lives on four different columns**: `training_courses.validForMonths`
(`training.ts:48`), `training_records.expiresOn` (`training.ts:225`),
`training_skill_types.validForMonths` (`training-skills.ts:59`),
`training_skill_assignments.expiresOn` (`training-skills.ts:88`).

**Alerting works, but only indirectly.** Expiry is derived at _report_ time
(`packages/db/src/views.ts:34-39` computes `status` from `expires_on` in the
`report_skill_assignments` view) and driven by the compliance engine's `cert_requirement`
source module (`compliance.ts:44`, adapter `packages/compliance/src/evaluate.ts:143-145`).
There is a seeded `skills_expired_upcoming` report (`seed/report-definitions.ts:553`), but
**there is no native notification on certificate expiry** — the `training` category does not
exist in `packages/events/src/recipients.ts:22-27`.

**Why ADAPT.** A real HSE product must answer "does every worker on this project hold a valid
X, and what expires in the next 30 days?" That requires a **single certificate concept** with
a type catalogue, one expiry field, one renewal path, and one reminder registry. The data
already exists — so the work is to **unify**, not to build.

**Constraint.** Per AGENTS.md rules 4–6, this must be built _on_ the existing training and
skill records, not beside them. A parallel certificate table would create a fourth shape and
make the problem worse.

**What is missing.**

- No certificate _type_ catalogue (no first-class "Working at Height", "Confined Space",
  "Forklift Operator" entity that certificates point at).
- No single expiry/renewal/reminder registry across the three issuance paths.
- No `people`-level credential expiry rollup.
- No native expiry notification (see #16).

---

## 3. Training — **PRESERVE**

**Current state.** A full LMS **plus** a legacy record system:

| Area           | Tables                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Catalogue      | `training_courses` with 5 delivery types incl. `external_certificate`/`online` (`training.ts:27`)        |
| Instructor-led | `training_classes` (`:67`), `training_attendees`, `training_records` (`:127`) with reviewed completion   |
| LMS            | `training_lms_modules/lessons/enrollments/progress/content_items` (`training-lms.ts:58,104,193,291,424`) |
| Assessments    | types, questions, assessments, results (`training-assessments.ts:40,97,167,267`)                         |
| Skills         | authorities, types, assignments, certificates, files (`training-skills.ts:29,49,75,129,161`)             |
| Extras         | course files + `training_extra_fields` (`training-extras.ts`)                                            |

Compliance integrates via two source modules — `training` and `cert_requirement`. There are
**11 seeded training reports**. Wallet cards, credential design studio, `/my/training`, and
public QR verification at `/verify/person/[token]`.

**Why PRESERVE.** This is production-grade and unusually complete. The credential design studio
(`packages/design-studio`) and Collabora-based PPTX authoring are well beyond typical HSE
systems.

**What is missing.** Only narrow items: no `people.*` permission gate; no native training
expiry notification.

---

## 4. Machinery (plant/equipment/vehicle register) — **ADAPT**

**Current state.** `equipment_items` (`equipment.ts:84`) is a **broad asset register covering
hand tools, plant, and vehicles in one table**, discriminated only by `equipment_categories`
(`equipment.ts:28`) and a free-form `metadata` jsonb. Vehicle-specific fields
(`vin`, `licensePlate`, `registrationExpiresOn`, `insuranceExpiresOn`, `equipment.ts:126-129`)
sit on **every row regardless of category**.

Strong supporting machinery does exist: QR tagging, `equipment_location_history`, custody
check-in/out (`equipment_checkouts` + `equipment_station_settings`), `work_orders`,
`equipment_maintenance` schedules/reminders/dispatches, a notes log, a truck log, and
custom fields.

**The specific modelling problem.** `metadata` is used as a **type discriminator and as a
foreign key simultaneously**. The equipment detail page's "Certificates" tab is built by
querying `attachments` filtered on `metadata->>'equipmentId'`
(`app/(app)/equipment/[id]/page.tsx:1028-1032`). An attachment table is being joined through a
JSONB key instead of a real column. Per AGENTS.md rule 6, this is a shadow system.

**Why ADAPT.** The register and its workflows are good, but the entity is **under-typed** for
construction plant (cranes, hoists, MEWPs, powered access). There is no `plant` concept, no
statutory registration or rating-plate model, and no distinction between a hand tool, a
vehicle, and a regulated machine.

**What is missing.**

- No `machinery` / `plant` / `vehicle` entity distinction.
- No statutory registration number, inspection class, or rated-capacity record on the item.
- Attachments linked via `metadata` JSONB rather than a column.
- Vehicle columns present on non-vehicle rows.
- No report entity covering registration/insurance/certificate dates —
  `packages/reports/src/entities.ts:201-226` (`equipment_fleet`) omits them, so a tenant
  **cannot** build a registration-expiry report today.

---

## 5. Machinery Certificate — **NEW**

**Current state. There is no machinery certificate entity.** No table, no column, no route, no
report entity, no permission. The closest existing things are:

| Fragment                                                        | Location                              | Why insufficient                                                |
| --------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `equipment_inspection_records.certificate`                      | `equipment-inspection-records.ts:111` | A single **free-text** column on an inspection record           |
| `equipment_items.registrationExpiresOn` / `.insuranceExpiresOn` | `equipment.ts:128-129`                | Two bare dates, no issuing body, no certificate number, no type |
| "Certificates" tab on the equipment page                        | `equipment/[id]/page.tsx:1028-1032`   | Not modelled at all — `attachments` rows matched by a JSONB key |

Grepped `machinery|plant_item|workerCert|registration` across
`packages/db/src/schema` — only 3 incidental comment hits. Note the _annual third-party PPE
certification_ table (`ppe_annual_records.ts:38`, with `inspectorName`, `inspectorCompany`,
`inspectedByPersonId`) is the **exact pattern this capability needs** and already exists for
PPE.

**Why NEW.** This is the only one of the 17 targets with genuinely no usable substrate. The
information is scattered across free text and two date columns.

**What is missing (all of it).**

- A certificate entity with type, issuing body, certificate number, issue date, expiry date.
- A machine-certificate type catalogue.
- Renewal reminders and an expiry notification path.
- A list page, and inclusion in the report entity catalogue so it is reportable.
- Link to the machine, not just to a JSONB-keyed attachment.

**Reuse guidance.** `ppe_annual_records` (`ppe-annual-records.ts:38`) is a working template for
exactly this shape. `equipment_items` is the correct parent. Reusing both satisfies
AGENTS.md rules 4–5 without new architecture.

---

## 6. Machinery Inspection (statutory plant inspection) — **EXTEND**

**Current state. This is the strongest machinery-adjacent capability in the repo** and the part
most likely to be destroyed by careless change.

`equipment_inspection_types` (`equipment-inspection-types.ts:40`) carries `appliesToTypeId`,
an interval, `isPreUse`, and `failsSpawnWorkOrders`. Groups and criteria follow
(`:83, 125`). `equipment_inspection_records` (`:56`) implements **full snapshot semantics** —
`intervalLabel`/`intervalValue`/`intervalUnit`/`isPreUse`/`allowPassAll` are snapshotted onto
each record (`:85-92`) so **template edits never rewrite history**. Per-criterion answers carry
severity, comment, `actionTaken`, and `correctedOn` (`:250-292`).

**A rare capability worth calling out:** a **rental / unregistered target mode** where a
snapshot replaces the item foreign key, enforced by a check constraint
(`equipment-inspection-records.ts:166-172`). This lets you inspect hired plant that is not in
your asset register — a real-world construction requirement that most systems get wrong.

The calendar side is also correct: `equipment_inspection_schedules` per unit with `nextDueOn`
and `dueNotifiedFor` one-alert-per-cycle stamping (`equipment-maintenance.ts:37-59`), ad-hoc
`equipment_reminders` with repeat intervals (`:89`), and a dispatch ledger (`:154`).

**Why EXTEND.** Cadence, snapshot integrity, and rental handling are already right and should
be preserved verbatim. The gap is narrowly statutory.

**What is missing.**

- No issuing authority or third-party inspector field. **Contrast PPE**, which has exactly
  this: `ppe_annual_records.inspectorName` / `inspectorCompany` / `inspectedByPersonId`
  (`ppe-annual-records.ts:53-55`).
- No statutory registration number or inspection class on the record.
- `nextDueOn` lives on the _schedule_ row, not on the machine — so "when is machine X next
  due?" requires a join.
- No per-unit capacity / load-test / rating record.

---

## 7. HSE Inspection (safety inspection / audit checklists) — **PRESERVE**

**Current state.** `inspection_types` (`inspection-types.ts:33-52`) carries per-type workflow
toggles: `requiresForeman`, `requiresCustomerSignature`, `enableCorrectiveActions`,
`allowCompliantNotes`, `availableTo` (by role / person / org unit), `notifyPersonIds`. Reusable
criterion **banks** exist (`inspection-bank.ts:24, 55`). `inspection_records`
(`:36-89`) capture customer context, signature, foreman, and supervisor.

**The per-criterion record is where the value is** — `inspection_record_criteria`
(`:50-108`) snapshots the criterion at creation and carries `severity`,
`nonComplianceDescription`, `actionTaken`, `assignedToPersonId` /
`assignedToTenantUserId` / `assignedDueDate` / `correctedOn`, and **auto-spawns a
`correctiveActionId`**. This _is_ the finding mechanism, and it already generates CAPA
automatically.

**Why PRESERVE.** This is a production inspection system. Per the capability matrix in
[architecture §3.12](./beaconhs-architecture.md#312-module-inventory-22-modules--platform),
it is tenant-scoped, permission-wired, and ships search + filter + pagination on every list.

**What is missing.** Only a notification gap — no native "inspection overdue" event
(see #16).

---

## 8. Finding / Hazard — **ADAPT**

**Current state. There is no `findings` table.** The concept is expressed in **four parallel
shapes with no common lifecycle**:

| Shape                       | Location                                                                                                        | Nature                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Near-miss                   | `incidents.type = 'near_miss'` (`incidents.ts:35`)                                                              | A full incident record — heavy for a near-miss, but correct              |
| Observation                 | `corrective_actions.source = 'observation'` (`corrective-actions.ts:44`)                                        | A CAPA with no incident                                                  |
| Failed inspection criterion | `inspection_record_criteria` with `answer='fail'` + `correctiveActionId` (`:79, 108`)                           | A criterion row, not a trackable record                                  |
| Hazard                      | `hazid_assessment_hazards` (`hazid-assessments.ts:183`) + the `hazid_hazards` library (`hazid-libraries.ts:58`) | A row inside a JSHA. **Not a record** — no owner, no status, no due date |

Safe Distance (`safe-distance.ts:51`) is a calculation tool, not a finding.

**Why ADAPT.** A real HSE programme needs a first-class **observation / finding** with its own
lifecycle — open → assigned → actioned → verified → closed — that is the **common ancestor**
of "inspection criterion failed", "observation raised", and "near-miss reported". Today there
is no single "open findings" view a safety manager can work from.

**Encouraging precedent.** `corrective_actions.source` already anticipates this
(`corrective-actions.ts:44`): `inspection | incident | near_miss | observation | audit | jsha | other`.
The enum was designed for the unified concept that was never built.

**What is missing.**

- No `findings` entity or register.
- No unified status lifecycle across the four shapes.
- No cross-module "all open findings" view or report entity.
- A hazard inside a JSHA cannot be tracked after the assessment is closed.

---

## 9. Risk (risk register, risk assessment) — **ADAPT**

**Current state. Risk exists only inside a JSHA.** `hazid_assessment_hazards`
(`hazid-assessments.ts:183-205`) stores `preLikelihood`/`preSeverity` (inherent) and
`postLikelihood`/`postSeverity` (residual), plus `standardControls`, `specificControls`, and
`applicable`. The 5×5 L×S matrix is tenant-configurable on `tenants.riskMatrix`
(`core.ts:41`, type at `:61`) with a builder at `/hazard-assessments/risk-matrix`.
Compliance tracks the _frequency_ of hazard assessments via the `hazard_assessment` source
module (`compliance.ts:51`, adapter `evaluate.ts:154-155`).

**Why ADAPT.** The scoring model is correct and should be preserved. But **there is no
standalone risk register** — no persistent per-risk row with an owner, a current risk level, a
review date, or a status, living outside a single assessment snapshot.

**This is a legal exposure, not just a modelling preference.** Most jurisdictions require a
documented risk register reviewed on a cycle. Today a risk that has been assessed in one JSHA
vanishes when that JSHA is superseded; the next JSHA re-derives it from scratch with no history
and no trend.

**What is missing.**

- A persistent risk register (one row per risk, independent of any single assessment).
- Risk ownership and periodic review dates.
- A link from a risk to the corrective actions that treat it.
- Trend history across assessments.

---

## 10. Incident — **PRESERVE**

**Current state. This is the most mature module in the repository.** `incidents`
(`incidents.ts:58`) has 7 types, 5 severities, 5 statuses, and an unusually complete record
for statutory reporting:

- **Full medical trail** (`:103-135`): EMS dispatch timestamps, hospital, attending physician,
  MOL (Ministry of Labour) notification number, first-aid notes for the OSHA-300 log, lost-time
  and modified-duty with day counts.
- **Key metrics** (`:140-149`): `actualSeverity`, `potentialSeverity`, `severityRating`,
  `damageEstimate`.
- Police and insurance trail (`:152-155`).
- Draft-first with a 48-hour sweep (`:72-76`).
- **Nine sub-tables**: people, injuries, injury-type assignments, lost-time events,
  attachments, events, contributing factors, root-cause whys, preventative steps.

**Taxonomies are built for regulatory reporting**: hierarchical `incident_classifications` with
`isRecordable` for TRIR/DART (`incident-classifications.ts:47`), flat `incident_injury_types`
with `oshaCode` (`:115`), and `incident_hours_periods` for OSHA frequency-rate denominators
(`:161`). The OSHA-300 report is seeded (`seed/report-definitions.ts:316`).

**Why PRESERVE.** Rewriting this would be strictly destructive. It already covers the statutory
reporting surface that most HSE systems treat as an afterthought.

**What is missing.** Nothing structural.

---

## 11. Investigation — **PRESERVE**

**Current state. A 5-step investigation flow is natively modelled**, not bolted on:

- `incident_events` (`:235`) — chronological timeline.
- `incident_contributing_factors` (`:308`) with a 6-value category enum
  `equipment | procedure | training | environment | human | other` (`:454`).
- `incident_root_cause_whys` (`:487`) — a 1–5 ordinal 5-whys chain.
- `incidents.rootCause` + `contributingFactors` + `assignedInvestigatorTenantUserId`
  (`:160-163`).
- `incident_preventative_steps` (`:524`) — owner, target date, status.

Status machine: `reported → under_investigation → pending_review → closed | reopened`
(`:50`), gated by `incidents.investigate` and `incidents.close` (`iam.ts:175-176`), held by
`safety_manager` only (`iam.ts:387-388`).

The schema header comment (`incidents.ts:8`) also notes an investigation can alternatively be a
`form_response` with `sourceEntityType='incident'` — so the Builder can model investigation
without code when a programme wants a bespoke format.

**Why PRESERVE.** A native 5-whys plus contributing-factor categorisation with permission-gated
status transitions is exactly right.

**What is missing.** No effectiveness check after closure — that is captured under #13.

---

## 12. HSE Action (corrective action) — **PRESERVE**

**Current state.** `corrective_actions` (`corrective-actions.ts:56`): reference, 4 severity
levels, status `open | in_progress | pending_verification | closed | cancelled`, 7 source
types, polymorphic `sourceEntityType`/`sourceEntityId` plus a typed `sourceFormResponseId`
shortcut, `rootCause`, `actionTaken`, `siteOrgUnitId`, `assignedOn`/`dueOn`, `costImpact`, lock.

`ca_photos` (`:133`) and `ca_complete_steps` (`:160`) — a **multi-step ordered audit** of
`action_taken | verification | signature` with a signature attachment and a step-kind enum
(`:50`).

Draft-first with 48h sweep. Permissions `ca.create | ca.update | ca.verify` (`iam.ts:238-243`)
enforced by `assertCan` at 8+ sites in `corrective-actions/_actions.ts`. Four dedicated seeded
reports plus by-assignee / aging / overdue / by-source report pages.

**Why PRESERVE.** The `ca_complete_steps` design — a multi-step completion record rather than a
status flag — is the right foundation for verification (see #13).

**What is missing.** No native notification on approach-to-due or on overdue; only on assignment
and completion (see #16).

---

## 13. Verification (closure verification / effectiveness check) — **EXTEND**

**Current state. Verification exists as a sub-state of the corrective action, not as a
reusable concept.** `corrective_actions` carries `verificationRequired` / `verificationNotes` /
`verifiedByTenantUserId` / `verifiedAt` (`corrective-actions.ts:90-93`), gated by `ca.verify`
(`:243`) and enforced with `assertCan(ctx, 'ca.verify')`
(`corrective-actions/_actions.ts:371`). The multi-step record is in `ca_complete_steps` (`:160`).

Separately, `inspection_record_criteria.correctedOn` (`:100`) is a **date-only flag** — there is
no verification identity or evidence behind it.

**Why EXTEND.** The mechanism and the permission already exist and should be reused. What is
missing is treating verification as a first-class, dated, effectiveness-scoring step available
to **any** closeable record.

**What is missing.**

- **No effectiveness check** — nothing records "was the fix actually effective?" This is the
  defining feature of a real HSE corrective action loop, and it is absent.
- No re-inspection linkage — a verification cannot spawn or reference a follow-up inspection.
- No post-closure sampling.
- No verification due date distinct from the CA due date.
- **Verification does not exist on incidents, HAZID assessments, documents, or hazards** —
  only on corrective actions.
- `correctedOn` is date-only, with no verifier identity.

---

## 14. HSE Dashboard — **EXTEND**

**Current state. The BI engine is genuinely strong; only the content is missing.**

`insight_dashboards` (`insight-dashboards.ts:41`) provides named per-user dashboards with a
12-column widget grid, dashboard-level filter fan-out (`layout`/`params`/`paramMap`), and
publishing controls (`status`, `allowedRoles`). `insight_cards` (`insights.ts:274`) stores a
saved query + visualization with kind `question | model | metric | ai`, plus
`insight_dashboard_pins` (`:308`) and `user_dashboard_layouts` / `role_dashboard_layouts`
(`dashboard-layouts.ts:53,76`).

The query layer is a real visual BI compiler — **BHQL** in `packages/analytics`
(`ast-schema.ts`, `expr-parser.ts`, semantic overlay `semantic.ts:87`), with the SQL compiler
hidden behind the `/server` subpath so client bundles cannot pull in drizzle. Nine
visualization types. Routes `/insights`, `/insights/library`, `/insights/cards/*`.

**Why EXTEND.** The engine needs nothing. The gap is entirely HSE-specific board content.

**What is missing.** Only **12 report entities** exist in
`packages/reports/src/entities.ts`. Notably **absent**: `people`, `org_units`,
`hazid_assessments`, `journals`, `form_responses`, `ppe_issues`, `work_orders`. So an HSE
dashboard cannot currently chart workforce, organisational units, hazard assessments, or
work orders at all. A machinery-certificate entity (see #5) would also be needed.

---

## 15. HSE Reports — **EXTEND**

**Current state. `packages/reports` is the single source of truth** for reportable entities,
and this is where the public API and Insights both inherit from.

Entities are either real base tables (`incidents`, `inspection_records`, `documents`,
`equipment_items`) or **flat reporting views** in `packages/db/src/views.ts`:
`report_skill_assignments`, `report_corrective_actions`, `report_training_records`,
`report_training_matrix`, `report_incident_rates`, `report_compliance_status`,
`report_equipment_fleet`, `report_ppe_items`, `report_vehicle_log_*`. Views read FORCE-RLS
base tables, so tenant scoping is automatic.

**32 seeded report definitions** (`packages/db/src/seed/report-definitions.ts:81`) covering
incidents, CAs, inspections, documents, cross-module KPI, site scorecard, OSHA-300, compliance,
hazid signatures, training (11), skills matrix/expiry/missing, PPE (4), vehicle log, fleet,
equipment inspections, oil change.

Tenant-configurable **without code**: create/clone/edit a report, choose entity, columns,
filters, group-by, measures, sorts, layout, export mode, and schedule it
(`/reports/schedules`; cadences daily/weekly/monthly/cron; BullMQ repeatables + `report_runs` +
`report_run_deliveries`).

**Why EXTEND.** The engine and 32 seeds are a strong base.

**What is missing.**

- No report entity for `people`, `org_units`, `hazid_assessments` (only the signature
  projection, `entities.ts:501`), `journals`, `form_responses`, `work_orders`, `ppe_issues`.
- No machinery-certificate or registration-expiry report.
- The file explicitly disclaims equipment financials (`views.ts:8-16`: "moved to a separate
  financial system") — intentional, not a defect.

**Engineering constraint.** `CREATE OR REPLACE VIEW` cannot reorder columns, so new columns must
be **appended**; removals need a `DROP VIEW IF EXISTS` at the top of the array
(`views.ts:13-16, 40-41`).

---

## 16. HSE Notifications — **EXTEND**

**Current state. The infrastructure is production-grade; the coverage is narrow.**

What exists:

- Transactional outbox with per-effect lease/retry (`domain-events.ts:103`), written in the
  same transaction as the mutation.
- 4 channels: `in_app | email | push | sms` (`notifications.ts:18`).
- Per-user × category × channel preferences (`notifications.ts:62`).
- Tenant kill switch, digest mode, quiet hours, and an escalation ladder
  (`tenant-settings.ts:12, 50`).
- Email + SMS + web push transports, with `email_log` and `sms_log` delivery ledgers.
- Two purpose-built emitters with correct self-targeted + rollup semantics:
  `emitComplianceTransitions()` (`events/src/index.ts:327`) and
  `emitEquipmentMaintenanceDue()` (`:498`).

**Why EXTEND.** The plumbing is right. Only event kinds and categories need adding.

**What is missing.**

- Only **4** `DomainNotificationEvent` kinds exist (`domain-events.ts:24-38`).
- Only **4** built-in categories (`recipients.ts:22-27`): `incident`, `ca`, `compliance`,
  `equipment`.
- **No native notification for:** training expiry/renewal, inspection overdue, PPE
  inspection/expiry, document review due, outstanding document acknowledgement, HAZID expiry,
  machinery certificate expiry, journal cadence.
- No native notification for **corrective-action approach-to-due or overdue** — only on
  assignment and completion. This is a significant operational gap for a corrective-action
  programme.
- **Person-targeted recipient resolution is not first-class.** The compliance emitter has to
  bridge `personId → people.userId` manually (`events/src/index.ts:403-411, 514-518`).

---

## 17. HSE Audit — **EXTEND**

**Current state. Three distinct things exist under the name "audit".**

**(a) Change audit trail.** `audit_log` (`audit.ts:5`) with before/after jsonb, actor, IP, UA,
`dedupKey`. See [architecture §1.13](./beaconhs-architecture.md#113-audit) — comprehensive in
breadth, but **not tamper-evident**. A second durable trail exists as the domain-event outbox,
and there are many module-native trails: `ca_complete_steps`,
`job_title_task_acknowledgments`, `document_reviews`, `form_response_steps`, `flow_gates`,
`equipment_location_history`, `ppe_issues`, `incident_lost_time_events`.

**(b) Periodic document review.** `document_reviews` (`documents.ts:264-321`) per document +
exact version, outcome `approved_no_change | updated | retired`.

**(c) Management review.** `document_management_reviews`
(`document-management-reviews.ts:27`) with period, participants, decisions, `actionItemsCreated`,
`nextReviewOn`, and normalized document→exact-version links (`:74`).

**Why EXTEND.** The audit trail and management review are solid and are the right foundation.

**What is missing.**

- **No scheduled compliance audit entity** — the programme → checklist → findings → CAPA loop
  does not exist. `document_management_reviews` is the closest structural template.
- `corrective_actions.source='audit'` (`corrective-actions.ts:45`) anticipates audit findings as
  a CA source, **but no audit entity exists to be that source** — a dangling enum value.
- No tamper evidence on `audit_log` (see architecture Risks #3). For a statutory
  record-keeping obligation this is the most serious single finding in this document.

---

# Summary

| #   | Capability            | Class        | One-line rationale                                                                        |
| --- | --------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| 1   | Personnel             | **PRESERVE** | Full HR-shaped worker model with temporal site assignment                                 |
| 2   | Certificate           | **ADAPT**    | Data exists across 3 tables / 4 expiry columns / 3 issuance paths; no unified certificate |
| 3   | Training              | **PRESERVE** | Full LMS + record system + assessments; production-grade                                  |
| 4   | Machinery             | **ADAPT**    | One under-typed `equipment_items` table; `metadata` used as a foreign key                 |
| 5   | Machinery Certificate | **NEW**      | Nothing usable; only free text and two bare date columns                                  |
| 6   | Machinery Inspection  | **EXTEND**   | Snapshot + rental handling already correct; add statutory fields                          |
| 7   | HSE Inspection        | **PRESERVE** | Full inspection system that auto-generates CAPA                                           |
| 8   | Finding / Hazard      | **ADAPT**    | Four parallel shapes, no common lifecycle entity                                          |
| 9   | Risk                  | **ADAPT**    | No standalone register; risk exists only inside a JSHA snapshot                           |
| 10  | Incident              | **PRESERVE** | Most mature module; full OSHA-300 surface                                                 |
| 11  | Investigation         | **PRESERVE** | Native 5-whys + contributing factors + gated transitions                                  |
| 12  | HSE Action            | **PRESERVE** | Multi-step completion record; correctly permission-gated                                  |
| 13  | Verification          | **EXTEND**   | Sub-state of CA only; no effectiveness check anywhere                                     |
| 14  | HSE Dashboard         | **EXTEND**   | BHQL engine is strong; only 12 report entities exist                                      |
| 15  | HSE Reports           | **EXTEND**   | 32 seeds; missing entities for people, org units, JSHAs, work orders                      |
| 16  | HSE Notifications     | **EXTEND**   | Outbox + 4 channels; only 4 event kinds, no due/overdue alerts                            |
| 17  | HSE Audit             | **EXTEND**   | Trail + management review exist; no scheduled audit programme entity                      |

**Counts: 6 PRESERVE · 6 EXTEND · 4 ADAPT · 0 REPLACE · 1 NEW.**

No target is entirely absent. The single `NEW` (Machinery Certificate) has a direct template
already in the codebase (`ppe_annual_records`).

## Related documents

- [Architecture audit](./beaconhs-architecture.md) — the entity inventory behind this matrix
- [HSE gap analysis](./hse-gap-analysis.md) — data-model mismatches and build sequencing
- [Extension points](./beaconhs-extension-points.md) — what a new module costs
