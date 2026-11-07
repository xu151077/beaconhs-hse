# BeaconHS HSE — Authorization Boundary Hardening: Analysis

> **Read-only analysis.** No business code, migration, seed, or database change
> was made. No `git reset` / `restore` / `clean` / `rebase` / `merge` was run.
> Baseline: HEAD `454658c4`.
>
> Companion documents: `docs/hse-authorization-hardening-design.md` (fixes) ·
> `docs/hse-authorization-hardening-implementation-plan.md` (sequence).

---

## 中文摘要

**三个问题的结论（全部经代码与运行时双重验证）：**

|        | 问题                                                             | 结论                                                                                                                     |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **S1** | reports / insights 是否绕过 module read permission 与 site scope | **是，完全绕过。** 整条授权链只检查 **5 个** 权限字符串，全部是 `reports.*`；`ctx.scopes` 在**任何**执行路径上都不被读取 |
| **S2** | vehicle-log/[id] 是否 bare-id bypass                             | **是。** 唯一的 `can()` 只在 `:870` 门控 `?tab=edit`，视图页零权限检查                                                   |
| **S3** | PPE 导航/页面是否绕过 permission 与 scope                        | **是。** 导航无 gate，列表与详情都是 bare-id 查询，而 `worker` 角色持有 **0 个** ppe 权限                                |

**S1 最严重的具体后果：** `foreman` 角色持有 `incidents.read.site` / `ca.read.site` /
`journals.read.site`（**零个** `*.read.all`），却同时持有 `reports.read` 与
`insights.read`。因此他可以在模块页只看自己的 site，却能运行种子报表
**`osha_300_log`（OSHA 300 可记录伤害台账，法定记录）** 并导出**全租户**数据。
定时报表更严重——`workers/reports.ts:521` 解析出 `scopes` 后，在 `:137` 把它丢掉。

**必须澄清的两点（避免误判）：**

1. **RLS 是唯一有效边界，且它工作正常。** 190 条策略、跨租户读取为 0。三个问题全部是**同租户内**的授权绕过，不是数据隔离失效。
2. **`canSeeSite` 与 `selfOnlyFilter` 是死代码**（各 **0** 个调用点），**不得**被当作有效 gate 引用。

**`people_assignments` 不属于本阶段。** 0 行、零写入方、零 UI、零 seed，仅 2 个读取点。S1/S2/S3 均不需要它。

---

## 1. Baseline confirmations

### 1.1 `PERMISSION_CATALOGUE` = **91** (confirmed)

Exact line parse of `packages/db/src/schema/iam.ts:155-296`:

```
array body lines : 142
  comments       :  49
  blanks         :   1
  array open     :   1
  ────────────────────
  PERMISSION KEYS:  91   (unique: 91, duplicates: 0)
  hyphenated     :  tools.safe-distance.use, admin.api-keys.manage
```

The two hyphenated keys are exactly what an earlier naive regex parse dropped,
producing the erroneous "89" recorded in `AGENTS.md:275`,
`docs/hse-development-baseline.md:434`/`:700`, and
`docs/project-development-state.md:49`/`:139`.

### 1.2 `canSeeSite` / `selfOnlyFilter` are **DEAD CODE** (confirmed)

```
canSeeSite      : 0 call sites outside packages/tenant/src/index.ts:290
selfOnlyFilter  : 0 call sites outside packages/tenant/src/index.ts:302
```

`packages/tenant/src/index.ts:299-301` — `selfOnlyFilter`'s own doc comment
states it is superseded: _"Newer record lists should prefer
recordVisibilityWhere(), which unions ALL of the user's scopes"_.

`packages/tenant` ships **no test file** (`src/` contains only `index.ts` and
`regulatory.ts`) and **no `test` script**. Nothing guards this package's
authorization logic at all.

**Consequence for this phase:** neither function may be cited as an effective
gate, and neither should be extended. Any fix must use the **live** primitives:
`moduleScopeWhere` (`visibility.ts:156`), `recordVisibilityWhere`
(`visibility.ts:46`), `canSeeRecord` (`visibility.ts:193`).

### 1.3 The tenant boundary is sound — and that is the correct frame

RUNTIME VERIFIED:

```
190 policies installed
policies referencing org_unit|site|project : 0
incidents :: tenant_isolation :: * :: (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)
RLS enabled : t     RLS forced : t

beaconhs_app, no app.tenant_id  -> people = 0
beaconhs_app, app.tenant_id set -> people = 10
```

**All three findings below are within-tenant authorization bypasses.** RLS is
doing its job. Do not "fix" these by touching RLS.

---

## 2. S1 — Reports and Insights bypass the module read tier

### 2.1 The complete permission list in the authorization chain

Traced end to end. **These five strings are the entirety of what is checked:**

| Permission / predicate                                                     | Location                                                                 | Gates                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------- |
| `reports.read` \| `reports.builder` \| `reports.schedule` (or super-admin) | `reports/layout.tsx:18-20`                                               | area access           |
| `reports.read`                                                             | `reports/definitions/[id]/export/route.ts:29`                            | report export         |
| `reports.read`                                                             | `reports/_viewer/actions.ts:22`                                          | re-run with controls  |
| `reports.builder`                                                          | `reports/page.tsx:51`, `_studio/actions.ts:26,42`                        | authoring             |
| `isTemplateBuilder(ctx)` + `form_templates.allowed_roles`                  | `analytics-access-policy.ts:18` → `packages/tenant/src/index.ts:143-153` | **Builder apps only** |

**Zero `<module>.read.*` is consulted.**

`canAccessTemplate` (`packages/tenant/src/index.ts:136-154`) is the only
content-level check, and its body reads no module permission:

```ts
if (template.deletedAt) return false
const builder = isTemplateBuilder(ctx)
if (template.status !== 'published') return false
const allowed = template.allowedRoles
return (
  builder || !allowed || allowed.length === 0 || allowed.some((role) => effectiveRoleKeys.has(role))
)
```

It governs only `form_responses:<templateId>` entities
(`removeRawBuilderEntities`, `analytics-access-policy.ts:25-36`).

### 2.2 `ctx.scopes` is never read

Grep, both packages:

```
$ grep -rn "moduleScopeWhere|canSeeRecord|recordVisibilityWhere|scopes" packages/reports/src/     → 0 hits
$ grep -rn "moduleScopeWhere|canSeeRecord|recordVisibilityWhere"        packages/analytics/src/  → 0 hits
```

`runBeaconReport` (`packages/reports/src/run.ts:46-58`) — the whole body:

```ts
const filters = mergeFilters(query.filters ?? null, options.runtimeFilters ?? null)
const compiled = compileCustomReport({ ...query, filters }, tenantId, catalog, options)
const rows = await executeParameterizedRows(tx, compiled.sql, compiled.params)
```

`BeaconReportRunOptions` (`run.ts:11-15`) is `{ maxRows?, fiscalStartMonth?,
runtimeFilters? }` — **there is no scope field**. The function signature takes no
`ctx` and no `scopes`.

`apps/web/src/app/(app)/reports/_run.ts:23-35` passes `ctx.tenantId!` (line 27)
and `ctx` (for the catalogue) — `ctx.scopes` is never referenced.

### 2.3 The foreman escalation, proven

`foreman` (`packages/db/src/schema/iam.ts:333-373`) holds:

| Module reads                                    | Reports               | Insights               | Admin    |
| ----------------------------------------------- | --------------------- | ---------------------- | -------- |
| `incidents.read.site` `:340`                    | `reports.read` `:365` | `insights.read` `:367` | **none** |
| `ca.read.site` `:356`                           |                       |                        |          |
| `journals.read.site` `:359`                     |                       |                        |          |
| `inspections.read.site` `:343`                  |                       |                        |          |
| `hazid.read.site` `:346`                        |                       |                        |          |
| `equipment.read.site` `:350`                    |                       |                        |          |
| `forms.response.read.site` `:338`               |                       |                        |          |
| `training.read.all` `:349`                      |                       |                        |          |
| **`*.read.all` count: 0** (other than training) |                       |                        |          |

So a foreman sees only their sites in the module UIs — and can read the whole
tenant through reports/insights.

**The seeded report that proves it:** `osha_300_log` — _OSHA 300 Recordable
Log_ (`packages/db/src/seed/report-definitions.ts:315-347`). This is the
legally-required log of recordable injuries. Its columns are `severity`,
`status`, `actual_severity`, `potential_severity`; its only filter is
`severity ∈ {medical_aid, lost_time, fatality}`. **No site predicate.**

Also unfiltered: `corrective_actions_list` (`report-definitions.ts:630-654`) —
no `filters` at all, so it returns every CA in the tenant.

`loadVisibleDefinitions` (`reports/_definitions.ts:28`) filters on
`tenantId + state != 'archived'` only, so a foreman sees **all 32** seeds.

### 2.4 Scheduled reports: scopes resolved, then discarded

`apps/worker/src/workers/reports.ts:512-523` builds the run-as context **with**
scopes:

```ts
const requestCtx = makeTenantContext(db, {
  ...
  permissions: resolved.permissions,
  scopes: resolved.scopes,          // line 521
  activeRoleId: resolved.appliedRoleId,
})
```

`requestCtx` is returned at `:553` and destructured at `:131`. The actual query
at `:137-140` never receives it:

```ts
const result = await runBeaconReport(tx, tenantId, snapshot.definition.query, catalog, {
  maxRows: 10_000,
  runtimeFilters: normalizeReportRuntimeFilters(snapshot.filters),
})
```

`requestCtx` is used only at `:151` for PDF wallet-card branding. So a schedule
created by a site-scoped foreman **emails tenant-wide unscoped incident and CA
data to every recipient, indefinitely**. `runAsRoleId` is snapshotted (`:509`),
so a later role change that grants only `reports.read` still runs tenant-wide.

### 2.5 Insights: view unprotected, export incidentally protected

- Nav: `/insights` is gated on **`reports.read`**, not `insights.read`
  (`nav/registry.ts:209`). Confirmed.
- Page: `insights/page.tsx:28-29` → `canViewInsights` → `insights.read`.
  A foreman has it.
- Card: `cards/[id]/page.tsx:30-31`; `loadCard` (`cards/_data.ts:47-62`) is a
  publish/role gate, not a data gate.
- Execute: `cards/[id]/page.tsx:44-47` — `runAuthorizedBhql(ctx, card.query,
{ maxRows: 50_000, trustedSystemCard })`.
- **Export**: `cards/[id]/export/route.ts:57-58` uses
  `requireExportContext()` which asserts **`admin.data.export`**. A foreman does
  **not** hold it → **403**. So insights _export_ is incidentally protected by an
  unrelated admin permission. The insights _view_ is not.

**The `app_responses` system cards.** `insights/_widgets.ts:659-673`
(`kpi-submissions`) and `:725-742` (`kpi-monitored-sessions-active`) query the
`app_responses` alias, which `addTrustedSystemAppResponsesEntity`
(`packages/analytics/src/server/discover.ts:437-452`) builds from the raw base
entity with **no template filter and no permission**. Its own comment at `:449`
says _"Tenant-wide app responses for managed system cards."_ and
`:434-436` says it _"intentionally exposes a tenant-wide aggregate source."_

Trust cannot be forged (`_system-cards.ts:29` requires `createdBy === null` plus
an exact name+query match), so this is not an injection hole — it is two
hardcoded cards that bypass `forms.response.read.site` by design.

### 2.6 The authorisation boundary is a blocklist

`packages/analytics/src/server/discover.ts`:

```ts
// :31
const RLS_SAFE = new Set<string>(TENANT_SCOPED_TABLES)     // ALLOW-list = tenancy
// :35-65
const EXCLUDE_TABLES = new Set<string>([ ... ~24 tables ... ])   // BLOCK-list = authorisation
// :274
if (!RLS_SAFE.has(table) || EXCLUDE_TABLES.has(table)) continue
```

`discover.ts:1-7` states the intent: _"any table is automatically queryable in
Insights with ZERO hand-maintenance … The curated overlay only adds nice
labels/categories on top of what's discovered — it never gates what's
available."_

Tenants cannot register tables at runtime (`TENANT_SCOPED_TABLES` is a
compile-time constant). The real risk is developer-facing: **any new table added
to `TENANT_SCOPED_TABLES` becomes instantly queryable tenant-wide by every
analytics user, with no module permission declared.**

### 2.7 Secondary: archived definitions are reachable by id

`reports/_definitions.ts:41` — `loadDefinitionById` filters
`tenantId + id` but **not** `state`, while `loadVisibleDefinitions:28` does
(`ne(state,'archived')`). Callers: `export/route.ts:30`,
`definitions/[id]/page.tsx:18`, `definitions/[id]/edit/page.tsx:20`,
`_viewer/actions.ts:24`. So **archiving is cosmetic**.

Also: `reports/layout.tsx:16-21` accepts `reports.builder` alone, and
`page.tsx:40` then renders the full definition list with no read permission —
a user with only `reports.builder` sees definitions they cannot `reports.read`.

---

## 3. S2 — Vehicle-log detail page: bare-id authorization bypass

### 3.1 The page, line by line

`apps/web/src/app/(app)/equipment/vehicle-log/[id]/page.tsx`:

| Line       | Code                                                 | Effect                         |
| ---------- | ---------------------------------------------------- | ------------------------------ |
| `:864`     | `if (!isUuid(id)) notFound()`                        | **format** check only          |
| `:867`     | `const ctx = await requireRequestContext()`          | a session **is** required      |
| `:868`     | `const canManage = can(ctx, 'equipment.manage')`     | computed                       |
| `:870`     | `if (active === 'edit' && !canManage) redirect(...)` | gates **only the edit tab**    |
| `:879-886` | `.where(eq(truckLogEntries.id, id))`                 | 🔴 **no permission, no scope** |
| `:892`     | `if (!data) notFound()`                              | existence only                 |

**The overview/view tab — the default (`pickActiveTab(sp, TABS, 'overview')`) —
has no permission check at all.**

### 3.2 Scope is impossible to apply as written

`truck_log_entries.site_org_unit_id` **exists** (`equipment-truck-log.ts:43`,
indexed `:67`) but is **never** used as a visibility predicate. The list scopes
via the **parent vehicle**:

```ts
// _equipment-policy.ts:18-22
const scope = await moduleScopeWhere(ctx, tx, {
  prefix: 'equipment',
  siteCol: equipmentItems.currentSiteOrgUnitId, // the VEHICLE's current site
  personCol: equipmentItems.currentHolderPersonId,
})
```

So a log entry filed at site A for a truck that has since moved to site B is
scoped by B. Any fix must decide which column governs — and the existing list
behaviour (parent vehicle) is the compatible choice.

### 3.3 Sibling routes are correct — this is an inconsistency, not a design choice

| Route                                           | Gate                                                       | Scope                             |
| ----------------------------------------------- | ---------------------------------------------------------- | --------------------------------- |
| **List** `vehicle-log/page.tsx:86-92`           | `equipment.read.all \|\| read.site \|\| manage` → redirect | ✅ `resolveVehicleEquipmentWhere` |
| **PDF** `vehicle-log/pdf/route.ts:120-122`      | ✅ same triple check                                       | ✅                                |
| **CSV** `vehicle-log/export.csv/route.ts:37,43` | ✅ `assertCan('equipment.read.all')`                       | ✅ `resolveVehicleEquipmentWhere` |
| **Detail** `[id]/page.tsx:133`                  | 🔴 none                                                    | 🔴 none                           |

Three of four surfaces are correct. Only the detail page is wrong.

### 3.4 Exposure and blast radius

`truck_log_entries` columns (RUNTIME, `information_schema`):
`driver_person_id`, `entry_date`, `start_odometer`, `end_odometer`, `km_driven`,
**`business_km`, `personal_km`**, `site_org_unit_id`, `other_destination`,
`hours_on_site`, `manpower_count`, `notes`, `source_connection_id`,
`import_status`, `import_meta`.

That is **driver PII plus business-vs-personal mileage** — behavioural
tracking of a named individual. Combined with `leftJoin(people)` on
`driverPersonId` and `leftJoin(orgUnits)` on `siteOrgUnitId`, one UUID yields a
named driver's movements.

- **Reachable by**: any authenticated tenant member, including the `worker`
  role, which holds **no** equipment permission.
- **UUID entropy**: unguessable by brute force, but a UUID leaks through logs,
  exports, referrers, or another user's support request.
- **Tenant isolation holds** — `ctx.db()` is used, so this is **not**
  cross-tenant.

---

## 4. S3 — PPE: navigation and page bypass

### 4.1 The nav inconsistency, adjacent lines

```ts
// apps/web/src/lib/nav/registry.ts:180-188
{
  key: 'equipment',
  href: '/equipment',
  requiredPermission: 'equipment.read.self',     // :185
  group: 'Assets & people',
},
{ key: 'ppe', href: '/ppe', label: 'PPE', iconKey: 'hard-hat', group: 'Assets & people' },  // :188 — no gate
```

`nav/resolve.ts:161-163` only filters on `requiredPermission` /
`requiredAnyPermission`, so `/ppe` is shown to everyone.

Definitive nav census: **23 entries, 15 ungated.** Ungated includes `people`,
`ppe`, `incidents`, `corrective-actions`, `journals`, `hazid`, `training`,
`documents`, `locations`, `compliance`, `dashboard`, `my`, `feed`, `help`,
`notifications`. Some are intentionally so (`dashboard`, `my`, `help`,
`notifications`, and `compliance` which has an explanatory comment at
`nav/registry.ts:190-194`). `ppe` and `people` are the two with **no comment and
no gate**.

### 4.2 Role permissions — corrected

| Role             | `ppe.*` permissions                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `worker`         | **none**                                                                                                            |
| `foreman`        | `ppe.issue` (`:352`), `ppe.inspect` (`:353`)                                                                        |
| `safety_manager` | all 6 (`:408-413`): `ppe.read.all`, `ppe.manage`, `ppe.issue`, `ppe.return`, `ppe.inspect`, `ppe.return_to_service` |
| `tenant_admin`   | full catalogue (91)                                                                                                 |

**There is no `ppe.read.self` or `ppe.read.site` key** — `ppe.read.all` is the
only read tier.

### 4.3 The surfaces

| Surface                                           | Gate                                               | Scope          |
| ------------------------------------------------- | -------------------------------------------------- | -------------- |
| **Nav** `nav/registry.ts:188`                     | 🔴 none                                            | —              |
| **List** `ppe/page.tsx:116`                       | 🔴 none — `filters = [isNull(ppeItems.deletedAt)]` | 🔴 none        |
| **Detail** `ppe/[id]/page.tsx:884`                | 🔴 none — bare `eq(ppeItems.id, id)`               | 🔴 none        |
| `export.csv/route.ts:54`                          | ✅ `assertCan('ppe.read.all')`                     | ✅ none needed |
| `[id]/issues/[issueId]/pdf/route.ts:33`           | ✅ `assertCan('ppe.read.all')`                     | ✅             |
| `[id]/inspections/[inspectionId]/pdf/route.ts:34` | ✅ `assertCan('ppe.read.all')`                     | ✅             |
| **All server actions**                            | ✅ `assertCan` throughout                          | n/a            |

On the list page `:107-108`, `canExport` and `canIssue` are computed for
**capability display**, not gating — the module has no read gate to apply.

On the detail page `:868-876`, `canManage`, `canIssue`, `canChangeStatus`,
`canReturnToService` and `canDelete` are likewise affordance flags; the fetch at
`:884` uses none of them.

**All three route handlers are stricter than the pages they serve** — the CSV
export requires `ppe.read.all`, which the page itself does not.

### 4.4 Exposure and the structural blocker

The list joins `people` at `:253, :272, :295` and searches on
`people.firstName` / `lastName` (`:122-124`). So it exposes every item's serial
number, size, status and **current holder's full name**.

RUNTIME schema check:

| Table             | org_unit columns       |
| ----------------- | ---------------------- |
| `ppe_items`       | **0**                  |
| `ppe_issues`      | **0**                  |
| `ppe_inspections` | 1 (`site_org_unit_id`) |

**Location scope for PPE is impossible without a schema change.** `ppe_items`
is the asset register; it has no location column at all. So S3 is a
**permission** problem, not a scope problem — and the fix must not pretend
otherwise.

- **Reachable by**: any authenticated tenant member, including `worker`, which
  holds zero PPE permissions.
- **Tenant isolation holds** — `ctx.db()` is used.

---

## 5. `people_assignments` — current state, and why it is out of scope here

### 5.1 Current behavior (verified)

| Property                                  | Value                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Rows                                      | **0** (against 10 `people`)                                                                              |
| Writers anywhere in `apps/` + `packages/` | **zero** — no `insert/update/delete(peopleAssignments)`                                                  |
| UI references                             | **zero** — no file under `apps/web/src` mentions it                                                      |
| Seed references                           | **zero**                                                                                                 |
| Readers                                   | 2: `packages/compliance/src/audience.ts:96`, `packages/compliance/src/identity.ts:99`                    |
| Schema                                    | complete: `id`, `tenant_id`, `person_id`, `org_unit_id`, `valid_from` (NOT NULL), `valid_to`, timestamps |
| RLS                                       | registered (`rls.ts:113`)                                                                                |
| Indexes                                   | `(tenant_id, org_unit_id)` `org.ts:257`, `(tenant_id, person_id)` `org.ts:256`                           |

### 5.2 Intended role

It is the **only** person→organization assignment edge in BeaconHS: a dated
(person, org_unit) pair with a validity window. Its pattern is proven in
`packages/compliance/src/audience.ts:89-104`, which resolves "the people on
org_unit X" by joining it with `validFrom <= today AND (validTo IS NULL OR
validTo >= today)`.

Because `org_unit_id` has no level constraint, it can express both "person works
on project X" and "person is assigned to site Y".

### 5.3 Current failure mode

`resolveAudience` (`audience.ts:36-55`, returning at `:139`) has **no fallback**:
an `org_unit` audience with no matching assignment rows resolves to `[]`. So a
project-targeted compliance obligation currently reaches **nobody**.

Related: `audience-targets.ts:181-193` validates an `org_unit` target for
**existence only, with no level check**, while the picker UI restricts to
`level in ('site','project')` (`_form-options.ts:198`,
`api/picker-options/route.ts:535`). A crafted request can therefore target a
`customer` or `area` node.

### 5.4 Risks of activating it now

1. **It is a privileged write path added during a hardening phase.** Creating
   person→org assignments is itself an authorization act; it needs its own
   permission and audit. Adding one while the boundary is being hardened widens
   the surface under repair.
2. **It changes compliance behaviour immediately.** Every `org_unit` audience
   starts resolving from 0 people to N people — dispatches, notifications and
   obligation status all shift. That deserves its own release, not a ride-along.
3. **It does not help any of S1/S2/S3.** None of the three needs a person→org
   mapping:
   - S1 needs a **module read permission + row scope** on the analytics engine.
   - S2 needs the **read tier** the list page already has.
   - S3 needs a **permission tier**, and PPE has no org column at all.
4. **It is a scope feature, not a boundary fix.** Population belongs to the
   organization/project scope phase.

### 5.5 Recommendation

**Defer to the Project / Organization Scope phase** (`docs/hse-project-scope-*`).
Track it there as Step C with the prerequisite that the analytics/permission
boundary is hardened first.

In **this** phase, the only correct action is a **regression test that pins the
current behaviour** — that an `org_unit` audience with no assignments resolves to
an empty set — so the eventual population change is a deliberate, visible diff
rather than a surprise.

---

## 6. Findings

| ID       | Severity     | Finding                                                                                                                                                  | Location                                                                                         |
| -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **H-1**  | **Critical** | Reports/insights bypass every module read permission and all row scope. A foreman can run `osha_300_log` and export tenant-wide incidents/CAs.           | `reports/_run.ts:23-35`, `packages/reports/src/run.ts:46-58`, `analytics-access-policy.ts:12-20` |
| **H-2**  | **Critical** | Scheduled reports resolve the run-as user's `scopes` (`workers/reports.ts:521`) then discard them (`:137-140`), emailing tenant-wide data indefinitely.  | `apps/worker/src/workers/reports.ts`                                                             |
| **H-3**  | **Critical** | Vehicle-log detail page has no permission check; only the edit tab is gated.                                                                             | `equipment/vehicle-log/[id]/page.tsx:870, 884`                                                   |
| **H-4**  | **Critical** | PPE list and detail have no permission gate and no scope; nav entry ungated. A `worker` (0 ppe permissions) reads the whole register incl. holder names. | `ppe/page.tsx:116`, `ppe/[id]/page.tsx:884`, `nav/registry.ts:188`                               |
| **H-5**  | High         | Analytics entity authorisation is a **blocklist** (`EXCLUDE_TABLES`); any table added to `TENANT_SCOPED_TABLES` is auto-granted tenant-wide.             | `packages/analytics/src/server/discover.ts:35-65, 274`                                           |
| **H-6**  | High         | Two hardcoded system cards reach tenant-wide `form_responses` with no `forms.response.read.*`.                                                           | `insights/_widgets.ts:659-673, 725-742`                                                          |
| **H-7**  | Medium       | `loadDefinitionById` omits the `state` filter, so archived definitions are viewable, re-runnable and exportable by id.                                   | `reports/_definitions.ts:41` vs `:28`                                                            |
| **H-8**  | Medium       | `reports/layout.tsx:16-21` admits `reports.builder` alone; `page.tsx:40` then renders the definition list without `reports.read`.                        | `reports/layout.tsx:16-21`, `reports/page.tsx:51`                                                |
| **H-9**  | Medium       | `/insights` nav is gated on `reports.read`, not `insights.read`.                                                                                         | `nav/registry.ts:209`                                                                            |
| **H-10** | Info         | `canSeeSite` and `selfOnlyFilter` are dead code (0 call sites); `packages/tenant` has no tests.                                                          | `packages/tenant/src/index.ts:290, 302`                                                          |

All ten are **recorded, not fixed** — this phase is read-only.

---

## 7. Root cause

**One root cause explains H-1, H-2, H-5 and H-6: BeaconHS has two independent
authorization systems, and only one of them is connected to the data layer.**

```
SYSTEM A — module authorization  (well built, widely used)
  PERMISSION_CATALOGUE → roles → role_assignments → ctx.permissions
  visibility.ts: moduleScopeWhere / canSeeRecord / recordVisibilityWhere
  used by ~40 list pages, ~45 detail pages, 13 module CSV exports, global search
  ↓ operates on Drizzle PgColumn, returns a Drizzle `SQL` fragment

SYSTEM B — analytics authorization (thin, data-independent)
  nav.requiredPermission → reports.layout → runBeaconReport → compileCustomReport
  ↓ checks area access only; never reads permissions-per-module or ctx.scopes
  ↓ emits raw parameterised SQL strings, not Drizzle
```

`moduleScopeWhere` returns a **Drizzle `SQL` object** over `PgColumn`s.
`compileCustomReport` and `compileBhql` emit **raw SQL strings**. Neither can
consume the other. The two systems therefore never met — and the analytics side
was built without noticing, because its only check (`canAccessTemplate`) was
solving a different problem (Builder-app audience).

This is compounded by a **dependency-graph constraint**, verified:
`packages/reports/package.json` depends on `@beaconhs/db`, `drizzle-orm`,
`lucide-react`, `react` — and **not** on `@beaconhs/tenant`. It sits below
`apps/web` and **cannot** import `@/lib/visibility`. So the fix cannot be "call
`moduleScopeWhere` from the report runner"; the scope must be **computed in
`apps/web` and passed in as data**.

**H-3 and H-4 have a different, simpler cause: affordance flags were read as
gates.** In both pages a `can(...)` result is computed and then used to _show or
hide buttons_ (`active === 'edit' && !canManage`, `canManage ? … : …`) while the
surrounding `if (!isUuid(id)) notFound()` was mistaken for an access check. The
three sibling routes in each module are correctly gated, which shows the
pattern was known and simply not applied to the page.

**H-7/H-8/H-9 are consistency defects** in the reports area, not boundary
failures.

---

## 8. Verified baseline to preserve

| Suite                   | Result at `454658c4`   |
| ----------------------- | ---------------------- |
| Turbo tasks             | 24/24 successful       |
| `apps/web`              | 189 files / 1141 tests |
| `packages/db`           | 49 files / 232 tests   |
| `packages/auth`         | 16/16                  |
| `packages/email-render` | 49/49                  |

Contract tests that constrain any change here (all verified present):

| File                                                                   | What it pins                                                                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/reports/src/seed-parity.test.ts` (113 lines)                 | every seed compiles through `compileCustomReport` (`:29-40`); `BEACON_REPORT_SEEDS` has exactly 32 (`:45`)                                                                 |
| `apps/worker/src/lib/report-source-access-contract.test.ts` (19 lines) | **string-matches `workers/reports.ts` source text** — asserts the literal `'loadBeaconReportCatalog(tx, sources)'` and `not.toMatch(/loadBeaconReportCatalog\(tx\)(?!,)/)` |
| `apps/web/src/lib/analytics-access-policy.test.ts` (258 lines)         | no fallback to raw `form_` entities (`:221-237`); calls `runBeaconReport` with 4 args                                                                                      |
| `packages/reports/src/source-catalog.test.ts` (133 lines)              | app scope becomes an unavoidable predicate (`:43-61`)                                                                                                                      |
| `apps/web/src/app/(app)/insights/_widgets.test.ts` (31 lines)          | every built-in widget compiles against `addTrustedSystemAppResponsesEntity(...)`                                                                                           |

The worker contract test is the sharpest constraint: **it asserts on source
text, so a behaviour-preserving refactor still breaks it.**

---

## 9. Read-only verification

```
$ git status --short
?? docker-compose.yml.bak
?? docker-compose.yml.pre-cleanup-backup
?? docs/hse-project-scope-analysis.md
?? docs/hse-project-scope-design.md
?? docs/hse-project-scope-implementation-plan.md
```

`git diff HEAD` is **empty**. No tracked file modified. The two `.bak` files
predate this phase. Database access was read-only `SELECT` plus catalog queries;
no `INSERT`/`UPDATE`/`DELETE`/`DDL`, no migration, no seed.

---

## 10. Cross-references

| Document                                | Relationship                                                      |
| --------------------------------------- | ----------------------------------------------------------------- |
| `docs/hse-project-scope-analysis.md` §4 | where S1/S2/S3 were first recorded, alongside S4–S17              |
| `docs/hse-project-scope-design.md` §5   | why these must be fixed before project scope                      |
| `docs/hse-development-baseline.md` §21  | the original defect register D1–D6                                |
| `docs/opencode-agents-baseline.md`      | `security-reviewer` is the agent that would run this review in CI |
