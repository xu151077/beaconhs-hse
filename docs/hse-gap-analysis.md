# BeaconHS — HSE Gap Analysis

> **Status:** read-only audit snapshot. **Audited:** 2026-09-29 · **Commit:** `70da27c4`
> Companion to [beaconhs-capability-matrix.md](./beaconhs-capability-matrix.md), which holds
> the per-capability evidence. This document adds the cross-cutting data-model findings and a
> build-sequencing proposal.
>
> **This is an assessment, not a development plan.** Nothing here has been implemented, and no
> recommendations in it have been acted on.

## 摘要（中文执行摘要）

**最重要的结论：BeaconHS 已经是一个 HSE 产品。** 17 项目标能力中没有任何一项完全缺失。
盲目按"从零建设 HSE 系统"的思路立项会浪费大量工作量。

**工作量分布：**

| 工作量       | 占比   | 内容                                                                         |
| ------------ | ------ | ---------------------------------------------------------------------------- |
| **保留不动** | 约 50% | Incident、Investigation、HSE Action、HSE Inspection、Training、Personnel     |
| **增量扩展** | 约 35% | Verification、Notifications、Dashboard、Reports、Audit、Machinery Inspection |
| **结构改造** | 约 13% | Certificate 统一、Machinery 分型、Finding 统一、Risk 登记册                  |
| **全新建设** | 约 2%  | 仅 Machinery Certificate                                                     |

**四项最需要关注的结构性问题：**

1. **Certificate 分散在 3 张表、4 个有效期字段、3 条签发路径**，且没有证书类型目录。
   数据都在，缺的是"证书"这个一等公民。**必须在现有 training/skill 记录之上统一，
   不能另建一套**（否则会变成第 4 种形态）。
2. **没有独立的风险登记册**。风险只存在于 JSHA 快照内部 —— 评估一结束风险就消失，
   下次评估从头再来，没有历史、没有趋势、没有责任人、没有周期性复审。
   **这在多数司法辖区是法定要求。**
3. **Finding 概念有 4 种平行实现**（incident near_miss / CA source=observation /
   inspection criterion fail / JSHA hazard row），没有统一生命周期，安全主管无法
   获得一个"所有未关闭发现"的视图。
4. **Verification 只作为整改措施的子状态存在**，且**没有有效性验证**（"整改是否真的有效？"）
   —— 而这正是 HSE 整改闭环的定义性特征。

**最被低估的技术债**：`equipment_items` 一张表同时表示手持工具、机械、车辆，
车辆专属字段（VIN、车牌、注册/保险到期日）出现在**每一行**上；更严重的是 `metadata` jsonb
**同时被当作类型判别器和外键使用** —— 设备详情的"证书"标签页是靠
`metadata->>'equipmentId'` 匹配 `attachments` 表实现的。这是影子系统。

---

# 1. The headline finding

The single most consequential fact for planning is that **BeaconHS is already an HSE
platform**, not a generic system of record that needs an HSE layer built on top.

Evidence of domain depth that is unusual to find in a codebase:

- `incidents` carries a **complete OSHA-300 medical trail** — EMS dispatch timestamps, hospital,
  attending physician, Ministry of Labour notification number, first-aid notes, lost-time and
  modified-duty day counts (`schema/incidents.ts:103-135`).
- `incident_hours_periods` exists specifically to give the OSHA frequency-rate denominator
  (`schema/incident-classifications.ts:161`).
- `incident_classifications` is hierarchical with an `isRecordable` flag driving TRIR/DART
  (`:47`); `incident_injury_types` carries `oshaCode` (`:115`).
- A **5-whys root cause chain** with a 6-value contributing-factor taxonomy is modelled natively
  (`incidents.ts:454, 487`).
- Equipment inspection records use **full snapshot semantics** so template edits never rewrite
  history (`equipment-inspection-records.ts:85-92`), including a **rental/unregistered target
  mode** enforced by a check constraint (`:166-172`) — a real-world construction requirement
  most systems get wrong.
- Document control has **version pinning, periodic review against an exact version, and
  sign-off sessions** (`schema/documents.ts`).

**Planning implication.** A budget that assumes "build the HSE modules" will overrun. The
real budget is for unification (Certificate, Finding, Risk), one new entity (Machinery
Certificate), and horizontal coverage (Verification, Notifications, Report entities).

---

# 2. Capability classification summary

| #   | Capability            | Class        | Primary work                                                                        |
| --- | --------------------- | ------------ | ----------------------------------------------------------------------------------- |
| 1   | Personnel             | **PRESERVE** | Add a `people.*` permission namespace; consider health/licence attributes           |
| 2   | Certificate           | **ADAPT**    | Unify 3 tables / 4 expiry columns / 3 issuance paths behind one certificate concept |
| 3   | Training              | **PRESERVE** | Nothing                                                                             |
| 4   | Machinery             | **ADAPT**    | Split the under-typed `equipment_items`; stop using `metadata` as a foreign key     |
| 5   | Machinery Certificate | **NEW**      | One new entity; template exists (`ppe_annual_records`)                              |
| 6   | Machinery Inspection  | **EXTEND**   | Statutory fields: issuing authority, inspector, registration no., class             |
| 7   | HSE Inspection        | **PRESERVE** | Nothing                                                                             |
| 8   | Finding / Hazard      | **ADAPT**    | One `findings` entity as common ancestor of 4 parallel shapes                       |
| 9   | Risk                  | **ADAPT**    | A persistent risk register independent of any JSHA snapshot                         |
| 10  | Incident              | **PRESERVE** | Nothing                                                                             |
| 11  | Investigation         | **PRESERVE** | Nothing                                                                             |
| 12  | HSE Action            | **PRESERVE** | Nothing                                                                             |
| 13  | Verification          | **EXTEND**   | Effectiveness check; make verification reusable across record types                 |
| 14  | HSE Dashboard         | **EXTEND**   | Add missing `REPORT_ENTITIES` rows; no engine work                                  |
| 15  | HSE Reports           | **EXTEND**   | Add missing report entities; no engine work                                         |
| 16  | HSE Notifications     | **EXTEND**   | Add event kinds + categories; add due/overdue alerts                                |
| 17  | HSE Audit             | **EXTEND**   | A scheduled audit programme entity; audit-log tamper evidence                       |

**6 PRESERVE · 6 EXTEND · 4 ADAPT · 0 REPLACE · 1 NEW.**

Per-capability evidence, current state, and rationale:
[beaconhs-capability-matrix.md](./beaconhs-capability-matrix.md).

---

# 3. Cross-cutting data-model findings

These are the mismatches that would matter to an HSE programme, ordered by severity. None
were fixed.

## 3.1 HIGH — `metadata` jsonb is used as both a type discriminator and a foreign key

**Where.** `apps/web/src/app/(app)/equipment/[id]/page.tsx:1028-1032` builds the equipment
detail page's "Certificates" tab by querying `attachments` filtered on
`metadata->>'equipmentId'`:

```
attachments.metadata->>'equipmentId' = <equipmentId>
```

**Why it matters.** An attachment table is being joined through a JSONB key rather than a
declared column. Consequences:

- No foreign key, so referential integrity is unenforced (the tenant-integrity audit in
  [TENANT_RELATIONAL_INTEGRITY.md](./TENANT_RELATIONAL_INTEGRITY.md) documents the same class of
  hazard for conventional FKs across tenants).
- Not indexed, so this is a sequential scan on an `attachments` table that grows without bound.
- Invisible to RLS-aware tooling, the export hub, the reporting views, and the data-source
  dependency map.
- Cannot be expressed as a report column or an API field without bespoke code.

**This is exactly the "shadow system" that AGENTS.md rule 6 prohibits.** It should be a real
`attachment_id` column (the pattern already used correctly in ~20 other schema files).

## 3.2 HIGH — No standalone risk register

**Where.** Risk lives only inside a JSHA: `hazid_assessment_hazards`
(`schema/hazid-assessments.ts:183-205`) stores `preLikelihood`/`preSeverity` (inherent) and
`postLikelihood`/`postSeverity` (residual), plus `standardControls`, `specificControls`,
`applicable`.

**Why it matters.** A risk that has been assessed in one JSHA vanishes when that JSHA is
superseded. The next JSHA re-derives it from scratch. There is therefore:

- no risk **owner**
- no **review date**, so no periodic re-assessment obligation can be tracked
- no **history or trend** — you cannot show a risk rating improving or degrading over time
- no **link from a risk to the corrective actions that treat it**
- no way to answer "what is our top risk across all projects?" in a queryable way

Most jurisdictions require a documented, periodically reviewed risk register. **This is a
compliance exposure, not a feature request.** The 5×5 L×S matrix and the inherent/residual
model are correct and should be preserved; what is needed is persistence outside the
assessment snapshot.

## 3.3 HIGH — Four parallel shapes for "finding", with no common lifecycle

| Shape                       | Location                                                                         | Nature                                                |
| --------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Near-miss                   | `incidents.type = 'near_miss'` (`incidents.ts:35`)                               | A full incident record                                |
| Observation                 | `corrective_actions.source = 'observation'` (`corrective-actions.ts:44`)         | A CAPA with no incident                               |
| Failed inspection criterion | `inspection_record_criteria` `answer='fail'` + `correctiveActionId` (`:79, 108`) | A criterion row                                       |
| Hazard                      | `hazid_assessment_hazards` (`:183`) + `hazid_hazards` library                    | A row in a JSHA; **no owner, no status, no due date** |

There is **no `findings` table** and no unified status lifecycle. A safety manager cannot get
a single "all open findings across all sources" view, because the four shapes have different
statuses, different owners, and different closure semantics.

**Encouraging precedent:** `corrective_actions.source` already enumerates
`inspection | incident | near_miss | observation | audit | jsha | other`
(`corrective-actions.ts:44`). The enum was designed for the unified concept that was never
built.

## 3.4 MEDIUM — Certificate is not a first-class entity

| Fragment                                               | Location                        |
| ------------------------------------------------------ | ------------------------------- |
| `training_certificates` (keyed on a record)            | `schema/training.ts:331`        |
| `training_skill_certificates` (keyed on an assignment) | `schema/training-skills.ts:129` |
| `person_files` `kind='certification'`                  | `schema/person-files.ts:28`     |
| Expiry on `training_courses.validForMonths`            | `schema/training.ts:48`         |
| Expiry on `training_records.expiresOn`                 | `schema/training.ts:225`        |
| Validity on `training_skill_types.validForMonths`      | `schema/training-skills.ts:59`  |
| Expiry on `training_skill_assignments.expiresOn`       | `schema/training-skills.ts:88`  |

Alerting works only indirectly: expiry is derived at _report_ time
(`packages/db/src/views.ts:34-39`) and driven by the compliance engine's `cert_requirement`
module. There is a `skills_expired_upcoming` report but **no native expiry notification**, and
no per-person "credential expiry rollup" — you cannot ask "what does John need to renew?"

**Constraint:** this must be unified **on top of** the existing training and skill records. A
parallel `certificates` table would create a fourth shape and make the problem worse
(AGENTS.md rules 4–5).

## 3.5 MEDIUM — `equipment_items` is under-typed

`schema/equipment.ts:84` represents hand tools, plant, and vehicles in one table,
discriminated only by `equipment_categories` (`:28`) and a free-form `metadata` jsonb.
Vehicle-specific fields — `vin`, `licensePlate`, `registrationExpiresOn`,
`insuranceExpiresOn` (`:126-129`) — are present on **every row regardless of category**.

For a construction HSE programme this is a real problem: there is no `plant` concept (crane,
hoist, MEWP, powered access), no statutory registration or rating-plate model, and no
distinction between a hand tool and a regulated machine.

The **workflows** are strong and should be preserved: QR tagging, location history, custody
check-in/out, work orders, maintenance schedules with per-cycle alert stamping, a notes log, a
truck log, and custom fields.

## 3.6 MEDIUM — No `people.*` permission namespace

`PERMISSION_CATALOGUE` (`schema/iam.ts:155-296`, 92 keys) has **no `people.*` entry**, and the
`people` nav entry has **no `requiredPermission`** (`lib/nav/registry.ts:172`) — it is visible
to every user.

The workforce master data is the most sensitive module in an HSE product: emergency contact
names and phone numbers, date of birth, hire and termination dates, and (via
`person_files`) identity documents. Read access is governed by whatever generic path each page
uses, not by a declared capability.

This is a small change with a disproportionate security benefit.

## 3.7 MEDIUM — Verification has no effectiveness check

`corrective_actions` carries `verificationRequired` / `verificationNotes` /
`verifiedByTenantUserId` / `verifiedAt` (`schema/corrective-actions.ts:90-93`), gated by
`ca.verify` (`:243`) with the multi-step record in `ca_complete_steps` (`:160`).

What is missing:

- **No effectiveness check.** Nothing records "was the fix actually effective?" — this is the
  defining feature of a real HSE corrective-action loop, and it is absent.
- No re-inspection linkage. A verification cannot reference a follow-up inspection.
- No post-closure sampling.
- No verification due date distinct from the action due date.
- **No verification on incidents, HAZID assessments, documents, or hazards** — only on CAs.
- `inspection_record_criteria.correctedOn` (`:100`) is a **date-only flag** with no verifier
  identity and no evidence.

## 3.8 MEDIUM — `projects` and `sites` are undifferentiated `org_units`

There is **no `projects` table and no `sites` table**. `schema/sync.ts:24-27` states it:

> "org_unit covers both Locations and Projects (the same org_units table, different `level`)"

`orgUnitLevel` is `customer | project | site | area` (`schema/org.ts:24`).

Consequence: a Project has **no project-specific attributes** — no client, contract number,
start/end dates, budget, phase, or project manager. Anything of that kind must go into
`org_units.metadata` jsonb, which is neither queryable in reports nor indexed.

Related: `people_assignments` (`org.ts:241`) is person ↔ org_unit with validity dates but **no
position or assignment type**, so "who is the site supervisor for project X" is not answerable
from data. And `departments` (`org.ts:72`) is flat with **no `parent` column**, so departments
cannot nest.

## 3.9 LOW — Missing report entities block dashboards

Only **12** report entities exist in `packages/reports/src/entities.ts`. Absent: `people`,
`org_units`, `hazid_assessments` (only the signature projection at `:501`), `journals`,
`form_responses`, `work_orders`, `ppe_issues`, and any machinery-certificate concept.

Because `REPORT_ENTITIES` is the single source feeding reports, `/api/v1/{key}`, and Insights,
each missing entity is simultaneously missing from **all three**. The BHQL engine is not
limited; the entity catalogue is.

## 3.10 LOW — No certificate/machinery expiry notifications

Only **4** `DomainNotificationEvent` kinds (`schema/domain-events.ts:24-38`) and **4**
built-in categories (`packages/events/src/recipients.ts:22-27`) exist. Missing: training
expiry, inspection overdue, PPE inspection/expiry, document review due, outstanding
acknowledgement, HAZID expiry, machinery certificate expiry, and **corrective-action
approach-to-due or overdue** (only assignment and completion are covered).

Person-targeted recipient resolution is also not first-class — the compliance emitter has to
bridge `personId → people.userId` manually (`packages/events/src/index.ts:403-411, 514-518`).

## 3.11 LOW — `audit_log` is not tamper-evident

`schema/audit.ts:5` has before/after jsonb, actor, IP, UA, and a 2-year retention
(`packages/db/src/maintenance.ts:26`), but **no UPDATE/DELETE-blocking trigger, no hash chain,
and no WORM target**. The runtime DML role holds `DELETE ON ALL TABLES`
(`packages/db/src/migrate.ts:406`).

For a statutory record-keeping obligation this is the most serious single technical finding in
the whole audit. An HSE record that can be altered or deleted by a compromised application role
does not satisfy an auditor.

## 3.12 LOW — Stale comment referencing removed tables

`schema/training-skills.ts:7-8`:

> "This is intentionally separate from the on-the-job `trainingSkills` /
> `trainingSkillEvaluations` already in `training.ts` — those model evaluator sign-off of
> in-house competencies…"

Grepped: **`trainingSkills` and `trainingSkillEvaluations` exist nowhere in the repository.**
Those tables were removed and the comment was not updated. It will mislead the next
implementer about where evaluator sign-off lives — and, per AGENTS.md rule 6, is dead
documentation.

---

# 4. What is genuinely well-built

An honest gap analysis records what should not be touched.

| Area                                       | Why it is strong                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`incidents`**                            | Full OSHA-300 surface, 9 sub-tables, 5-whys, contributing-factor taxonomy, TRIR/DART classifications, 7 seeded reports including OSHA-300. The most mature module in the repo. |
| **Investigation**                          | Native 5-step flow with permission-gated status transitions held by `safety_manager` only (`iam.ts:387-388`).                                                                  |
| **Corrective actions**                     | Multi-step completion record (`ca_complete_steps`) rather than a status flag — the right foundation for verification.                                                          |
| **HSE inspections**                        | Reusable criterion banks, per-type workflow toggles, per-criterion severity/action/assignment, **auto-spawning CAPA**.                                                         |
| **Equipment inspections**                  | Snapshot semantics preserving history + a rental/unregistered target mode. Rare to get right.                                                                                  |
| **Compliance engine**                      | 11 source modules, 8 audience kinds, 5 recurrence modes, live-evaluate on read plus worker materialization. The cheapest real extension path in the codebase.                  |
| **Document control**                       | Version pinning, periodic review against an exact version, sign-off sessions, management reviews.                                                                              |
| **Tenant isolation**                       | 187 tables under `FORCE ROW LEVEL SECURITY`, with a test that fails CI if the RLS list ever drifts from the schema.                                                            |
| **Attachment safety**                      | Server-issued reservations, token-verified promotion, and a database trigger enforcing tenant ownership of every key.                                                          |
| **Tenant scoping of the existing modules** | Verified complete — no gaps found. Every module table is in `TENANT_SCOPED_TABLES`.                                                                                            |
| **List UI discipline**                     | Search + filter + pagination verified present on every major list, including prefixed sub-table params on multi-table detail pages.                                            |

---

# 5. Build sequencing (proposal)

Not a plan — a dependency-ordered reading of the findings above, offered so the HSE programme
can be scoped.

### Phase 0 — Unblocking (small, high leverage)

| Item                                       | Why first                                                                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fix the empty `R2_*` credentials in `.env` | **Blocks all file upload.** Nothing else that involves photos, signatures, or certificates can be validated until this is resolved. See [the storage audit](./beaconhs-storage-audit.md). |
| Add a `people.*` permission namespace      | Small change, disproportionate security benefit (§3.6).                                                                                                                                   |
| Decide on the 7-day report email link      | Affects the incident/report design directly.                                                                                                                                              |

### Phase 1 — Data foundations

These unblock everything in Phase 2 and are prerequisites for one another in places.

| Item                                                      | Rationale                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Machinery Certificate entity**                          | The only `NEW` item. Template already exists: `ppe_annual_records` (`schema/ppe-annual-records.ts:38`) has `inspectorName`, `inspectorCompany`, `inspectedByPersonId` — exactly the statutory shape needed. Parent is `equipment_items`; bytes are `attachments`; a real column, not `metadata`. |
| **Unify Certificate**                                     | Three tables and four expiry columns into one concept, **built on** the existing training/skill records. Prerequisite for any meaningful "who is qualified for what" question.                                                                                                                   |
| **Type `equipment_items`**                                | Split hand tool / plant / vehicle, or at minimum stop carrying vehicle columns on non-vehicle rows. Prerequisite for Machinery Certificate to be coherent.                                                                                                                                       |
| **Replace `metadata->>'equipmentId'` with a real column** | A shadow system per AGENTS.md rule 6, and it blocks reporting on attachments.                                                                                                                                                                                                                    |

### Phase 2 — Business foundations

| Item                                                 | Rationale                                                                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`findings` entity**                                | Common ancestor of inspection fails, observations, and near-misses. Unblocks the unified "open findings" view and the unified overdue alerting.                                  |
| **Persistent risk register**                         | Statutory requirement (§3.2). Independent of JSHA snapshots; carries owner, review date, and action links.                                                                       |
| **Statutory fields on equipment inspection records** | Issuing authority, third-party inspector, registration number, inspection class — mirroring what PPE already has.                                                                |
| **Project attributes on `org_units`**                | Decide whether a first-class `projects` table is warranted, or whether `metadata` is acceptable. This is a schema decision with broad downstream impact, not an incremental add. |

### Phase 3 — Horizontal coverage

Cheap, because the engines already exist.

| Item                                            | Rationale                                                                                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add missing `REPORT_ENTITIES` rows**          | `people`, `org_units`, `hazid_assessments`, `journals`, `work_orders`, `ppe_issues`, machinery certificates. One row each unlocks reports + `/api/v1` + Insights simultaneously. Highest leverage per line of the whole gap analysis. |
| **Add notification event kinds and categories** | Certificate expiry, inspection overdue, PPE, document review, CA due/overdue. Plus first-class person-targeted recipients.                                                                                                            |
| **Effectiveness check on verification**         | Extend `ca_complete_steps` into a reusable, dated, effectiveness-scoring step applicable to any closeable record.                                                                                                                     |

### Phase 4 — Assurance

| Item                                  | Rationale                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Audit-log tamper evidence**         | Append-only trigger or an external sink. Non-negotiable for statutory record-keeping.                                                                                          |
| **Scheduled compliance audit entity** | Programme → checklist → findings → CAPA. `document_management_reviews` is the closest structural template. `corrective_actions.source='audit'` already anticipates the source. |
| **Permission-model tests**            | `packages/tenant` has **zero tests** and runs on every request.                                                                                                                |

---

# 6. Things this analysis deliberately does not do

- It does not propose rewriting any PRESERVE capability.
- It does not assume any capability that the matrix classifies as ADAPT/EXTEND needs to be
  rebuilt; the foundation is sound in every case.
- It does not address UI/UX redesign, performance, or infrastructure cost.
- It does not decide the `projects`-table question — that is a product decision with schema
  consequences.
- It does not assess whether BeaconHS's _user experience_ is acceptable to HSE officers, only
  whether the _data model and infrastructure_ support the capability.

---

# Risks & Open Questions

## Defects (documented only — nothing was changed)

All 15 defects are consolidated in the Risks section of each companion document. The ones
specific to this analysis:

| #   | Severity    | Finding                                                                                   | Location                                            |
| --- | ----------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | **Blocker** | Empty `R2_*` credentials block all uploads                                                | `packages/storage/src/index.ts:39-40`, `.env:34-35` |
| 2   | **High**    | `packages/tenant` — the entire permission model — has **no tests and no `test` script**   | `packages/tenant`                                   |
| 3   | **High**    | `audit_log` has no tamper evidence; the runtime role holds `DELETE ON ALL TABLES`         | `schema/audit.ts:5`, `migrate.ts:406`               |
| 4   | Medium      | No `people.*` permission namespace                                                        | `schema/iam.ts:155-296`, `nav/registry.ts:172`      |
| 5   | Medium      | `metadata` jsonb used as a foreign key for attachments                                    | `app/(app)/equipment/[id]/page.tsx:1028-1032`       |
| 6   | Medium      | `training-skills.ts:7-8` comment references two tables that no longer exist               | `schema/training-skills.ts:7-8`                     |
| 7   | Low         | `custom_field_entity_kind` is a closed 4-value enum with no generic path for a new entity | `schema/custom-fields.ts:24-29`                     |

## Open questions requiring a product decision

1. **Is Builder-form modelling acceptable to HSE officers?** A form-driven approach is
   dramatically cheaper, but HSE records often need to be structured and queryable. If
   field-level structure matters, some EXTEND-classified targets may need native tables. This
   is the single biggest cost driver and cannot be answered from the code.
2. **Is a first-class `projects` entity required?** Project attributes currently have to live in
   `org_units.metadata` jsonb, which is neither reportable nor indexed.
3. **Is a persistent risk register a legal requirement in the target jurisdictions?** If yes,
   §3.2 moves from "high priority" to "compliance blocker".
4. **What is the required retention and legal-hold posture for attachments?** Deletion today is
   a hard DELETE plus a best-effort outbox, with no way to prevent deleting an attachment that
   is evidence in an open incident.
5. **Is SSO/SCIM required for enterprise buyers?** BeaconHS has neither OIDC nor passkey
   support. Adding OIDC is a first-class change to `packages/auth`, not a config toggle.
6. **Does the target deployment need Chinese (`zh`) or other locales?** Only `en`/`fr`/`es`
   exist, and adding a locale touches `SUPPORTED_LOCALES`, three message catalogues, DB CHECK
   constraints, and the `RequestContext` contract.
7. **Is realtime status required for multi-crew site work?** There is no WebSocket and no SSE
   substrate at all; any live-update requirement is net-new infrastructure.
8. **AGPL-3.0 licensing.** `LICENSE`, `package.json:4`. AGPL §13 obliges you to offer complete
   corresponding source to users interacting with the software over a network. Internal
   deployment is usually manageable; **hosting a modified BeaconHS as a service for third
   parties is a material constraint on the commercial model.** _Legal advice required._

## Related documents

- [Architecture audit](./beaconhs-architecture.md) — the entity inventory
- [Capability matrix](./beaconhs-capability-matrix.md) — per-capability evidence
- [Storage audit](./beaconhs-storage-audit.md) — object storage
- [Extension points](./beaconhs-extension-points.md) — what a new module costs
- [SeaweedFS impact](./beaconhs-seaweedfs-impact.md) — MinIO → SeaweedFS
