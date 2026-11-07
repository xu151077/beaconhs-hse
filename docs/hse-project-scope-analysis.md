# BeaconHS HSE — Project / Organization Scope Analysis

> Read-only audit at Git HEAD `454658c4`. No source, schema, migration, or
> database change was made. No git command that mutates state was run.
>
> This document records **what exists today**. The proposed model is in
> `docs/hse-project-scope-design.md`; the plan is in
> `docs/hse-project-scope-implementation-plan.md`.

---

## 中文摘要

**一句话结论：BeaconHS 的 scope 只有一个维度——租户。所有更细的可见性（site / crew / department / person）都是应用层 SQL 谓词，数据库完全不知道 org_unit 的存在。项目范围（Project Scope）作为概念今天不存在。**

**三个已实测的硬事实：**

1. **RLS 只有租户一层。** 数据库里共 190 条策略，**没有一条**引用 `org_unit` / `site` / `project`。全库唯一的 `set_config` 是 `app.tenant_id`。运行时验证：一个绑定了租户、**未设置任何 scope** 的连接，可以看到该租户全部 4 条事故（跨所有 site）。

2. **全库只有一个项目级 org_unit 字段** —— `hazid_assessments.project_org_unit_id`，而该表 **0 行**。其余 21 条实际写入的 org_unit 引用**全部**指向 `level='site'`。

3. **`foreman` 角色持有 `reports.read` 与 `insights.read`，但对记录类模块只有 `*.read.site`、零个 `*.read.all`**。而报表与洞察**不注入任何行级 scope**。因此一名工头可以打开 `/reports` 导出**全租户**的事故/整改/日志，而他在 `/incidents` 页面只能看到自己的 site。**这是本次审计最严重的发现。**

**唯一可复用的既有资产是 `people_assignments`**（`orgUnitId` + `validFrom`/`validTo` + 有效期窗口），合规模块已经用它实现「某个 org_unit 下的人」。**但这张表从不被 seed、从不被写入、没有任何 UI、当前 0 行**——所以合规的 `org_unit` 受众目前解析出 **0 个人，且没有兜底**。

**本次审计另发现 9 个既有安全缺陷**（含 3 个严重级），全部按只读要求**仅记录不修复**。

---

## 1. Scope architecture as it exists today

### 1.1 The one diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│ SESSION / REQUEST                                                    │
│  getRequestContext()  apps/web/src/lib/auth.ts:139                    │
│    cookie bhs-active-tenant / bhs-active-role (UUID-validated :155)   │
│    → resolveMembershipPerms() → { permissions:Set, scopes:RoleScope[] }│
└──────────────────────────────────────────────────────────────────────┘
                                    │
      ┌─────────────────────────────┼─────────────────────────────┐
      ▼                             ▼                             ▼
┌───────────────┐        ┌────────────────────┐        ┌──────────────────┐
│ PERMISSION    │        │ SCOPE              │        │ STORAGE          │
│ (flat strings)│        │ RoleScope[] (jsonb)│        │ org_units        │
│ 91 keys       │        │ 6 variants, NO     │        │ 4 levels         │
│ readTierCovers│        │ project variant    │        │ self-FK parentId │
│ wildcard x.*  │        │                    │        │ no level CHECK   │
└───────┬───────┘        └─────────┬──────────┘        └────────┬─────────┘
        │                          │                            │
        ▼                          ▼                            │
┌────────────────────────────────────────────────┐              │
│ visibility.ts                                  │              │
│  resolveVisibilityTier()  :114-118            │              │
│    reads PERMISSIONS ONLY — never ctx.scopes   │              │
│    → 'all' | 'site' | 'self'   (3 tiers)       │              │
│                                                │              │
│  moduleScopeWhere()     :156                   │              │
│    'all' → undefined  (NO FILTER AT ALL) :165  │              │
│    'site'→ inArray(siteCol, mySiteIds()) :171  │              │
│    'self'→ ownerCols/person only        :176  │              │
│                                                │              │
│  canSeeRecord()         :193                   │              │
│  recordVisibilityWhere():46  (only 2 callers)  │              │
└────────────────┬───────────────────────────────┘              │
                 │                                              │
                 ▼                                              │
┌────────────────────────────────────────────────────────────────────┐
│ DRIZZE QUERY  —  ctx.db() = withTenant(baseDb, tenantId, fn)      │
│                 packages/tenant/src/index.ts:89                    │
└────────────────┬─────────────────────────────────────────────────┘
                 ▼
┌────────────────────────────────────────────────────────────────────┐
│ POSTGRES RLS — the ONLY gate                                       │
│   190 policies installed; 0 reference org_unit/site/project        │
│   incidents :: tenant_isolation :: * ::                            │
│     (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')  │
│       ::uuid)                                                       │
│   ENABLE + FORCE ROW LEVEL SECURITY                                │
│   ONLY GUC ever set: app.tenant_id                                 │
└────────────────────────────────────────────────────────────────────┘
```

**The single most important line in that diagram:** `resolveVisibilityTier()` at
`apps/web/src/lib/visibility.ts:114-118` reads **permissions only** and never
consults `ctx.scopes`. When a user holds `<prefix>.read.all`, tier is `'all'`,
`moduleScopeWhere` returns `undefined` at `:165`, and **no record filter is
applied at all** — regardless of any scope that user holds.

### 1.2 The three chains, stated explicitly

#### Data access chain

```
UI param / route param
  → server action or route handler
  → requireRequestContext()                    auth.ts:139
  → ctx.db(fn)  ==  withTenant(db, tenantId)   tenant/index.ts:89
      └─ BEGIN; set_config('app.tenant_id', …) rls.ts:19; COMMIT
  → [ OPTIONAL ] moduleScopeWhere / canSeeRecord   visibility.ts
  → Drizzle query
  → Postgres RLS applies tenant_id predicate
```

**The `[ OPTIONAL ]` step is the whole problem.** Nothing enforces that a
tenant-bound query also applies a scope predicate. 190 policies cannot help,
because none of them knows what a site is.

#### Permission chain

```
PERMISSION_CATALOGUE (91 strings)         iam.ts:155-296
  → roles.permissions  (jsonb, per role)  iam.ts:20-39
  → role_assignments   (member × role)    iam.ts:57-93
  → resolveMembershipAccess() unions them tenant/index.ts:174-224
       + user_permission_overrides grants/denies
  → ctx.permissions : Set<string>
  → can(ctx, perm)  :101-110
       ├─ isSuperAdmin → true
       ├─ permissions.has(perm)
       ├─ readTierCovers()      :243-253   (.read.all ⊃ .read.site ⊃ .read.self)
       └─ wildcard 'x.*' prefix match
  → assertCan(ctx, perm) :255-259  →  ForbiddenError
```

`can()` returns a **boolean**. It never takes an org_unit, a project, or a
record. It cannot express "this user may act on project X".

#### RLS chain

```
packages/db/src/rls.ts
  TENANT_SCOPED_TABLES (187)              :105-331
  RLS_POLICY_SQL(table)                   :63-100
     ALTER … ENABLE ROW LEVEL SECURITY
     ALTER … FORCE  ROW LEVEL SECURITY
     CREATE POLICY tenant_isolation … USING/WITH CHECK (tenant_id = …)
  applied by migrate.ts:433-445  atomically, all-or-nothing
```

RUNTIME VERIFIED: 190 policies installed. Live policy on `incidents`:
`tenant_isolation :: * :: (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)`.
A query counting policies whose expression matches `org_unit|site|project`
returns **0**.

RUNTIME VERIFIED isolation proof:

```
beaconhs_app, no app.tenant_id  -> people = 0
beaconhs_app, app.tenant_id set -> people = 10
```

Tenant isolation **holds**. It is the only isolation that holds.

### 1.3 What `app.tenant_id` is the only GUC for

Repo-wide, every `set_config` call is `app.tenant_id`:
`packages/db/src/rls.ts:19`, `apps/web/src/app/kiosk/actions.ts:57`,
`apps/web/src/app/equipment-kiosk/actions.ts:55`. There is no `app.role`,
`app.user_id`, `app.site`, `app.org`, `app.project`, and **no
`withRoleContext` helper exists** anywhere.

Bypass is a **role attribute** (`beaconhs_super` is `BYPASSRLS`), not a GUC —
deliberate, so the policy predicate stays index-usable (`rls.ts:44-54`).

---

## 2. The organizational model as it exists

### 2.1 `org_units` is the only hierarchy

`packages/db/src/schema/org.ts:26-69`. Columns: `id`, `tenantId`, `parentId`,
`level`, `name`, `code`, `lat`, `lng`, `geofenceMeters`, `isEquipmentBase`,
`address` (jsonb), `metadata` (jsonb), timestamps, `deletedAt`.

`orgUnitLevel` (`:24`) — **exactly 4 values**:

```ts
export const orgUnitLevel = pgEnum('org_unit_level', ['customer', 'project', 'site', 'area'])
```

Properties verified:

| Property                                 | Evidence                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Arbitrary depth is structurally possible | self-FK `org_units_tenant_parent_fk (tenant_id, parent_id) → org_units(tenant_id, id)` |
| **No** level-vs-parent-level constraint  | `pg_constraint` CHECKs on `org_units`: **none**                                        |
| **No** cycle protection                  | no constraint; `parentId` is a plain uuid FK                                           |
| `(tenant_id, code)` UNIQUE               | `org_units_tenant_code_ux`                                                             |
| `(tenant_id, level)` indexed             | `org_units_tenant_level_idx`                                                           |
| `area` is declared but never used        | not in seed, not in any record                                                         |

RUNTIME hierarchy as seeded:

```
customer | Acme Refinery      | (root)
project  | Turnaround 2026    | Acme Refinery
site     | Site A — Tank Farm | Turnaround 2026
site     | Site B — Cracker   | Turnaround 2026
```

**There is no `projects` table and no `sites` table.** Both are `org_units` rows.

### 2.2 Where org_unit is actually referenced

RUNTIME inventory from `pg_constraint` across all 202 tables:

**Project-level — exactly ONE column in the entire schema:**

| Table               | Column                | Populated?                  |
| ------------------- | --------------------- | --------------------------- |
| `hazid_assessments` | `project_org_unit_id` | **0 rows** — table is empty |

**Site-level — 17 tables:**

`corrective_actions`, `document_acknowledgment_sessions`,
`equipment_inspection_records`, `equipment_items` (×2: `current_` +
`last_seen_`), `equipment_location_history`, `equipment_log_entries`,
`form_responses`, `hazid_assessments`, `incident_hours_periods`, `incidents`,
`inspection_records`, `journal_entries`, `kiosk_scans`, `ppe_inspections`,
`safe_distance_records`, `training_classes`, `truck_log_entries`.

**Level-agnostic — `org_unit_id`:** `people_assignments`, `customer_contacts`,
`hazid_location_tasks`, `equipment_checkouts.destination_org_unit_id`,
`equipment_station_settings.default_check_in_org_unit_id`,
`inspection_records.customer_org_unit_id`, `org_units.parent_id`.

RUNTIME: every populated reference points at `level='site'` —
incidents 4, corrective_actions 4, inspection_records 5, equipment_items 8.
**Zero point at `project`.**

### 2.3 The second and third axes

BeaconHS already separates three axes that the HSE scenario merges:

| Axis                                | Model                                                            | Nesting                                    |
| ----------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| **Location**                        | `org_units` (`customer\|project\|site\|area`)                    | self-FK, arbitrary depth, unconstrained    |
| **Organisation** (who you work for) | `departments` (`:72-93`), `trades` (`:95`), `crews` (`:117`)     | **`departments` has NO `parentId`** — flat |
| **Competency** (what you can do)    | `person_titles` + `job_title_tasks` + `person_title_assignments` | per-person, not org-hierarchical           |

`people` (`org.ts:140-239`) carries `departmentId`, `tradeId`, `crewId`,
`managerPersonId`, `groupIds` (jsonb) — **flat, with no org_unit link.**

### 2.4 The one reusable asset, and its state

`people_assignments` (`org.ts:241-269`): `personId`, `orgUnitId`,
`validFrom` (NOT NULL), `validTo` (nullable), indexed
`(tenant_id, orgUnitId)` at `:257` and `(tenant_id, person_id)` at `:256`.

**The pattern already works in production code.** `packages/compliance/src/audience.ts:89-104`
resolves "the people on org_unit X" by joining this table with a validity window
covering today.

**But the table is inert:**

| Check                       | Result                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| RUNTIME row count           | **0** (against 10 `people` rows)                                             |
| Referenced by seed          | **no** — `grep peopleAssignments packages/db/src/seed.ts` → 0 hits           |
| Written by any runtime code | **no** — only _read_ in `compliance/src/audience.ts:96` and `identity.ts:99` |
| Any UI reference            | **no** — `grep -rl peopleAssignments apps/web/src` → 0 files                 |

**Consequence:** a `compliance_audience` row with `kind='org_unit'` resolves to
**zero people**, and `resolveAudience` has **no fallback**
(`audience.ts:139-144` returns whatever was accumulated). Project-targeted
compliance obligations currently reach nobody.

---

## 3. Where each surface stands today

Legend — **PROJECT-SCOPE**: does project-level scoping work?
**SITE**: does site-level scoping work? **NONE**: no row scope at all.

| Surface                                               | Site        | Project                  | Notes                                                                            |
| ----------------------------------------------------- | ----------- | ------------------------ | -------------------------------------------------------------------------------- |
| Incidents list / detail / CSV                         | ✅          | ❌                       | `incidents/page.tsx:77`, `[id]/page.tsx:1694`, `export.csv:50`                   |
| Corrective actions (all surfaces incl. 4 sub-reports) | ✅          | ❌                       | `page.tsx:84`, `[id]:337`, `export.csv:56`                                       |
| Inspections (list/detail/CSV)                         | ✅ **best** | ❌                       | `records/page.tsx:111`; `canSeeRecord` in-tx before child reads `:1648`          |
| Hazard assessments (HazID)                            | ✅          | **column exists, inert** | `_list.tsx:113`; `projectOrgUnitId` never in any WHERE                           |
| Equipment (list / WO / inspections / maintenance)     | ✅          | ❌                       | `equipment/page.tsx:97`; site via `equipmentItems.currentSiteOrgUnitId`          |
| Vehicle log list / CSV                                | ✅          | ❌                       | scoped via parent vehicle, not the entry                                         |
| **Vehicle log detail**                                | 🔴 **NONE** | ❌                       | `[id]/page.tsx:133` bare id query, no permission, no scope                       |
| Journals                                              | ✅          | ❌                       | `journals/_lib.ts:33-54`, module-local predecessor of `moduleScopeWhere`         |
| **PPE list**                                          | 🔴 **NONE** | ❌                       | `ppe/page.tsx:116` — only soft-delete; nav ungated                               |
| **PPE detail**                                        | 🔴 **NONE** | ❌                       | `[id]/page.tsx:885` — permission only, no scope column exists                    |
| **People list + detail**                              | 🔴 **NONE** | ❌                       | no `people.*` permission key exists at all                                       |
| **Documents (whole module)**                          | 🔴 **NONE** | ❌                       | zero `moduleScopeWhere`/`canSeeRecord`; binary permission only                   |
| **Compliance (whole module)**                         | 🔴 **NONE** | ❌                       | tenant-only queries; `org_unit` audience exists but resolves via the empty pivot |
| Builder form responses (UI)                           | ✅          | ❌                       | `apps/responses/page.tsx:95`; `site_org_unit_id` is client-set, optional         |
| **Reports / analytics**                               | 🔴 **NONE** | ❌                       | **most severe — see §4**                                                         |
| **Insights / dashboards**                             | 🔴 **NONE** | ❌                       | same                                                                             |
| Global search (4 of 5 groups)                         | ✅          | ❌                       | `api/search/route.ts:82-109` — correctly scoped                                  |
| **Global search — `people` group**                    | 🔴 **NONE** | ❌                       | `:204-243`, no gate; roster PII enumeration                                      |
| Module CSV exports (6)                                | ✅          | ❌                       | all mirror their list page                                                       |
| **Reports / insights CSV export**                     | 🔴 **NONE** | ❌                       | up to 10 000 / 50 000 rows                                                       |
| Public REST API `/api/v1`                             | ❌          | ❌                       | **by design** — `scopes: [{type:'tenant'}]`, `api/auth.ts:137`                   |
| **Kiosk**                                             | 🔴 **NONE** | ❌                       | one shared tenant PIN, no device/site binding                                    |
| **Notifications**                                     | 🔴 **NONE** | ❌                       | recipient audience is role/group config, never record scope                      |

**API keys have no scope column at all** (`api-keys.ts:19-45`): `permissions`
jsonb + `builderTemplateIds` jsonb and nothing else.

---

## 4. Security findings

All verified against HEAD. **Recorded, not fixed** — this phase is read-only
design, and `AGENTS.md` forbids fixing them as a side effect.

### CRITICAL

**S1 — Reports and Insights bypass the record read tier entirely.**

- `packages/reports/src/run.ts:46-58` — `runBeaconReport` merges only
  `query.filters` (tenant-authored) with `runtimeFilters`. **No scope is
  injected.**
- `apps/web/src/lib/analytics-access-policy.ts:12-20` — the only filter is
  `canAccessTemplate(…, 'operate')`, which gates **Builder templates**, not
  module records. Grep for `incidents.read|ca.read|journals.read|training.read|documents.read`
  in the analytics authorisation path: **0 hits**.
- `apps/web/src/lib/report-catalog.ts:12-15` composes the catalogue from that
  policy plus a hardcoded table blocklist (`packages/analytics/src/server/discover.ts:35-65`).
- **The escalation is real:** `foreman` (`iam.ts:333-373`) holds
  `incidents.read.site`, `ca.read.site`, `journals.read.site`,
  `inspections.read.site`, `hazid.read.site`, `equipment.read.site`,
  `forms.response.read.site`, and **zero** `*.read.all` — yet also
  `reports.read` (`:365`) and `insights.read` (`:367`).
  A foreman therefore cannot see beyond their sites on `/incidents`, but can
  open `/reports`, run a seeded incident report, and export **every incident,
  corrective action and journal entry in the tenant**
  (`reports/definitions/[id]/export/route.ts:54-58`, `maxRows: 10_000`).
- `apps/worker/src/workers/reports.ts:508-523` resolves the run-as principal's
  `scopes` and then discards them at `:137-140`. Scheduled reports are
  tenant-wide on rows for the same reason.
- Insight cards export up to `maxRows: 50_000`
  (`insights/cards/[id]/export/route.ts:76-79, 119-122`) behind `insights.read`
  alone. System cards `kpi-submissions` / `kpi-monitored-sessions-active`
  (`insights/_widgets.ts:667, 733`) query tenant-wide `form_responses` without
  any `forms.response.read.*`.

**S2 — Vehicle-log detail page has no permission check at all.**

`apps/web/src/app/(app)/equipment/vehicle-log/[id]/page.tsx:133`
`.where(eq(truckLogEntries.id, id))`. `canManage = can(ctx,'equipment.manage')`
at `:119` gates **only** the `?tab=edit` sub-tab (`:120`). The list page _is_
gated (`page.tsx:86-92` requires `equipment.read.all|site|manage`). Any
authenticated tenant member who obtains a `truck_log_entries` UUID sees driver,
vehicle, site, km, hours, manpower and notes.

**S3 — PPE list exposes the whole register to every authenticated member.**

`apps/web/src/app/(app)/ppe/page.tsx:116` filters only `isNull(ppeItems.deletedAt)`;
nav entry `nav/registry.ts:188` has **no** `requiredPermission`. `ppe_items` has
**no org_unit column**. Result: every serial, size, status and **current
holder's name** is readable by any member of the tenant.

### HIGH

**S4 — People list and detail are entirely unscoped, and there is no `people.*`
permission key.** `people/page.tsx:78`, `people/[id]/page.tsx:273`. Any
authenticated user reads any person's date of birth, emergency contacts, notes,
files, training transcript and skills by URL. (This extends known defect D2 from
"nav is ungated" to "there is no permission model for the workforce at all".)

**S5 — Compliance `by-person` accepts a client-supplied person id.**
`compliance/by-person/page.tsx:43` reads `?person=`; `_hub.ts:171-177` filters
only `tenantId` + `personId`. Any `compliance.read` holder can enumerate any
person's full compliance profile. `compliance/mine/page.tsx:73-81` shows the
correct pattern (`eq(people.userId, ctx.userId)`).

**S6 — HazID project picker leaks every tenant project.**
`hazard-assessments/[id]/page.tsx:359-372` returns all `level='project'` org
units in the tenant with no scope filter.

**S7 — Notifications reveal record id, title and severity to recipients who
cannot read the record.** `packages/events/src/index.ts:167-184` builds
`linkPath: /incidents/{id}` and `data: { incidentId }` for a role/group audience
resolved by `recipients.ts:56-111`, which performs **no** `canSeeRecord` check.

**S8 — Worker executes tenant business logic under an RLS bypass.**
`apps/worker/src/workers/scheduled.ts:154-244` runs inside `withSuperAdmin`,
then **updates** `formResponses.monitorStatus` (`:193-204`), **inserts**
`formResponseCheckin` (`:206-211`), reads `users.email` (`:214-221`) and
**executes** `runSessionOverdueFlows` (`:227-234`) — a per-tenant business
transaction — all with only the row's own `tenantId` used for one lock helper
(`:187`). Every other scanner in the same directory correctly loops
`withTenant`.

**S9 — Incident sub-record mutations do not bind child id to parent incident.**
11 call sites in `incidents/[id]/page.tsx` validate `incidentId` but then use a
bare `eq(<child>.id, …)`: `:807, 844, 1120, 1125, 1158, 1167, 1212, 1216, 1250,
1259, 1306, 1312, 1346, 1355, 1402, 1407, 1443, 1457, 1521, 1527`. The correct
pattern is already in the same file for injuries (`:964-970`) and in
`inspections/_lib.ts:151-155`.

### MEDIUM

- **S10** — `inspections/[id]` email action fetches by id with no
  `canSeeRecord` (`_send-email.ts:37-44`), leaking checklist answers and a live
  record link.
- **S11** — `documents` facet counts ignore the `published` filter
  (`documents/page.tsx:102-117`), disclosing unpublished-document volumes to
  read-only holders.
- **S12** — `documents/versions/[versionId]/download/route.ts:28-53` never
  checks the parent document's `deletedAt`/`status`, so a soft-deleted or
  archived document's published version stays downloadable.
- **S13** — Kiosk: one shared per-tenant PIN, no device/site binding, and
  `remoteSearchTerm` has no minimum length, so the entire active roster, all
  site names and all crews are enumerable without typing
  (`kiosk/actions.ts:99-122, 150-160`).
- **S14** — `training.record.create` short-circuits `canSeeRecord`
  (`training/records/[id]/page.tsx:213-222`), letting a recorder read any
  training record by URL. Documented in-comment as intentional.
- **S15** — `training/classes` list and detail are unscoped despite
  `training_classes.site_org_unit_id` existing and being indexed
  (`training.ts:76`, `:96`).
- **S16** — `/api/v1` Builder `siteOrgUnitId` is client-supplied and validated
  only for `level='site'` (`api/write.ts:143-152`), never against the caller's
  scope; and the Builder list path (`api/builder-apps.ts:492-536`) applies no
  scope.
- **S17** — `compliance/obligations/_actions.ts:446-489` (`setObligationEnabled`)
  is the only guarded mutation across all audited modules that writes **no**
  audit record.

### Dead code found

`packages/tenant/src/index.ts:290` `canSeeSite()` and `:302` `selfOnlyFilter()`
have **zero consumers** repo-wide. `canSeeSite` is the only function in the
package that answers "may this context see this site". `selfOnlyFilter`
collapses a scope union to one scope, so it could not express
"self plus project X" anyway. `packages/tenant` ships **no test file and no
`test` script**, so nothing guards them.

---

## 5. Corrections to prior audit documents

| #   | Prior claim                                                                                                                                              | Actual at HEAD                                                        | Cause                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `PERMISSION_CATALOGUE` has **89** keys (`AGENTS.md:275`, `docs/hse-development-baseline.md:434`, `:700`, `docs/project-development-state.md:49`, `:139`) | **91**                                                                | The earlier parse silently dropped the two hyphenated keys `tools.safe-distance.use` and `admin.api-keys.manage`. Re-verified by exact line parse: 142 body lines = 91 keys + 49 comments + 1 blank + 1 array-open. |
| 2   | "`canSeeSite` is the site-access gate"                                                                                                                   | **Dead code** — 0 consumers                                           | Superseded by `recordVisibilityWhere`; its own doc comment at `:299-301` says so.                                                                                                                                   |
| 3   | "`people_assignments` is the zero-migration people-scope precedent"                                                                                      | Structurally true but the table is **empty, unwritten and has no UI** | It was described from the code path, not from the data. RUNTIME: 0 rows.                                                                                                                                            |

`docs/hse-development-baseline.md` §12 is otherwise accurate: project scoping
is not expressible, and `RoleScope` has no project variant. Those conclusions
stand and are re-confirmed here.

---

## 6. The HSE organizational scenario, mapped

The scenario to be supported:

```
Project Cluster
  ├── Project / Contract
  │     ├── Section / Division
  │     │     ├── Work Area / Work Zone
  │     │     └── Site
  │     └── Contractor / Subcontractor
  └── Project Staff
```

Mapped against what BeaconHS actually has:

| Scenario node              | Existing model                 | Verdict                                                                                                                                       |
| -------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Project Cluster            | `org_units` `level='customer'` | ✅ **Reusable as-is**                                                                                                                         |
| Project / Contract         | `org_units` `level='project'`  | ✅ **Reusable**                                                                                                                               |
| Section / Division         | —                              | ⚠️ `departments` is **flat** (no `parentId`); `org_units` `level='area'` could be used but is semantically a _place_, and is currently unused |
| Work Area / Work Zone      | `org_units` `level='area'`     | ✅ **Reusable** (declared, never used)                                                                                                        |
| Site                       | `org_units` `level='site'`     | ✅ **Reusable** (heavily used)                                                                                                                |
| Contractor / Subcontractor | —                              | 🔴 **No model anywhere.** `org_units` has only `address`/`metadata` jsonb; `people` has `employee_no`/`external_employee_id` but no employer. |
| Project Staff              | `people_assignments`           | ⚠️ **Table exists, zero rows, no writer, no UI**                                                                                              |

**Structural squeeze:** the scenario has 5 location levels; `orgUnitLevel` has 4
values. The hierarchy is a self-FK with no depth constraint, so extra depth is
_possible_, but there is no level that means "division" specifically, and
`area` is the only free slot.

**Important separation BeaconHS already gets right:** location (where) and
organisation (who you work for) are **different axes**. HSE contractors are an
_organisation_ fact, not a _location_ fact. Folding "contractor" into
`org_units` would conflate the axes and is not recommended — see the design
document.

---

## 7. Summary of the gap

| Question                                   | Answer                                   | Evidence                                                                        |
| ------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------- |
| Does RLS know what a project is?           | **No**                                   | 190 policies, 0 referencing org_unit/site/project                               |
| Is there a project column?                 | **One**, on an **empty** table           | `hazid_assessments.project_org_unit_id`, 0 rows                                 |
| Is there a project scope type?             | **No**                                   | `RoleScope` 6 variants, `iam.ts:49-55`                                          |
| Is there a project read tier?              | **No**                                   | `VisibilityTier` = `all\|site\|self`, `visibility.ts:106`                       |
| Can the admin UI assign a project scope?   | **No**                                   | `_scope-data.ts:61-65` hard-filters `level='site'`                              |
| Is there a reusable people→org assignment? | **Table yes, data no**                   | `people_assignments` — 0 rows, no writer, no UI                                 |
| Does anything walk the hierarchy for auth? | **No**                                   | a `WITH RECURSIVE` CTE exists but only for counting in `locations/page.tsx:129` |
| Do reports respect scope?                  | **No**                                   | `run.ts:46-58`; most severe finding S1                                          |
| Do exports respect scope?                  | **Module CSVs yes; reports/insights no** | 6 correct, 2 not                                                                |
| Do workers respect scope?                  | **Mostly; one clear violation**          | `scheduled.ts:154-244`                                                          |
| Do notifications respect scope?            | **No**                                   | `events/src/index.ts:167-184`                                                   |

**The single sentence for the design phase:** _BeaconHS has a correct and
well-tested tenant boundary, and a serviceable but purely flat site boundary
built entirely in the application layer. Project scope requires adding one
scope dimension and one tier to that application layer — and closing five
surfaces (reports, insights, PPE, people, vehicle-log) that currently have no
row scope at all._
