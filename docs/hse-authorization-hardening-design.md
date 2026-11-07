# BeaconHS HSE — Authorization Boundary Hardening: Design

> **Design only. Nothing here has been implemented.**
> Evidence: `docs/hse-authorization-hardening-analysis.md`
> Sequence: `docs/hse-authorization-hardening-implementation-plan.md`

---

## 中文摘要

**核心设计原则：把「谁能看哪些行」的计算留在 `apps/web`，把结果作为**数据**传入
报表/洞察引擎——而不是让包去 import 前端的可见性层。**

原因是硬性的：`packages/reports` 的依赖里**没有** `@beaconhs/tenant`，
它在依赖图中位于 `apps/web` 之下，**无法** import `@/lib/visibility`。
而且 `moduleScopeWhere` 返回 Drizzle `SQL` 对象，
`compileCustomReport` / `compileBhql` 输出**原始 SQL 字符串**——两者天然不兼容。

**因此修复形态是：在 `apps/web` 计算一个 `ReportRuleGroup`，通过
`runBeaconReport` 新增的可选参数传入。**

**三个修复的规模：**

| 修复                  | 改动文件数       | 新增数据模型 | 改 RLS |
| --------------------- | ---------------- | ------------ | ------ |
| S1 reports/insights   | 5（+1 测试辅助） | **无**       | **否** |
| S2 vehicle-log detail | 1                | **无**       | **否** |
| S3 PPE                | 2                | **无**       | **否** |

**全部零 migration。**

---

## 1. Design constraints

Five constraints, ranked. When two conflict, the earlier wins.

1. **Do not touch RLS.** 190 policies, zero reference `org_unit|site|project`,
   and the single-equality predicate is deliberate and asserted by
   `rls.test.ts:21-28`. All three findings are **within-tenant authorization**
   gaps; RLS is working. Changing it would not fix any of them.
2. **Reuse, do not rebuild.** `moduleScopeWhere`, `recordVisibilityWhere`,
   `canSeeRecord`, `can`, `assertCan`, `PERMISSION_CATALOGUE` all exist and are
   proven across ~40 list pages, ~45 detail pages and 13 CSV exports.
3. **No new data model.** Every fix is a code path change. No table, column,
   index, enum or permission concept is added.
4. **Enforcement belongs at the boundary, not the leaf.** Fix the one function
   each path funnels through, so all four reports surfaces are covered by one
   change rather than four.
5. **Additive where possible; explicit where not.** New helpers are exported
   alongside existing ones; no existing signature is silently repurposed.

---

## 2. Root cause restated as a design constraint

```
SYSTEM A  module authorization      →  Drizzle `SQL` fragment
SYSTEM B  analytics authorization   →  raw SQL strings
```

They never met because `moduleScopeWhere` returns a Drizzle `SQL` object while
both compilers emit strings. Verified dependency constraint:

```
packages/reports dependencies:
  @braedonsaunders/appkit-reports, @braedonsaunders/appkit-ui,
  @beaconhs/db, drizzle-orm, lucide-react, react
  → NO @beaconhs/tenant
```

**Design consequence — this is the single most important decision in this
document:**

> **The scope must be computed in `apps/web` and passed into
> `packages/reports` as a `ReportRuleGroup`, not imported into it.**

This keeps enforcement in the layer that already owns authorization, keeps
`packages/reports` dependency-clean, and makes the injected predicate visible in
one place (`_run.ts`) rather than scattered across four call sites.

---

## 3. S1 — Reports and Insights

### 3.1 Design shape

Three fixes, each at a funnel point:

```
FIX 1  entity gating   — which entities may this caller see at all?
FIX 2  row scoping    — which ROWS of those entities may they see?
FIX 3  gate closure   — the two direct bypasses (nav/layout, archived defs)
```

**Fix 1 and Fix 2 are both required.** Fix 2 alone leaves `foreman` able to
_build_ a query over `people` or `org_units`; Fix 1 alone leaves them able to
read every row of `incidents`.

### 3.2 Fix 1 — entity gating by module permission

**New concept: an entity → module-prefix map.**

`packages/reports/src/entities.ts` already declares 16 entities with
`key`, `table`, `category`. The `category` field is the natural hook
(`incidents`, `corrective_actions`, `training_records`, `compliance_status`,
`monitored_sessions`, …).

Add one exported helper in `apps/web`:

```
readableReportEntityKeys(ctx) -> Set<string>
  for each REPORT_ENTITY:
     resolve the module read tier for its category
     include the key when tier !== 'none'
```

Implemented by **exporting the existing tier function**, not by re-deriving it:

```
apps/web/src/lib/visibility.ts
  - export resolveVisibilityTier        (currently private, :114-118)
  - export moduleReadPrefix             (NEW: entity category -> permission prefix)
  - new exported moduleReadGate(ctx, prefix): 'all' | 'site' | 'self' | 'none'
```

`resolveVisibilityTier` already encodes the exact rule we need — it returns
`'all' | 'site' | 'self'` from `can(ctx, '<prefix>.read.all')` /
`can(ctx, '<prefix>.read.site')`. Reusing it means the analytics gate and the
page gate can never disagree.

**Where it is applied — one place:**

```
apps/web/src/lib/report-catalog.ts:12-15
  loadAuthorizedReportCatalogInTransaction(ctx, tx)
    → filter access.entities by readableReportEntityKeys(ctx)
    → loadBeaconReportCatalog(tx, filtered)
```

That single function is the funnel for the list page, the detail page,
`_viewer/actions.ts` and `_studio/actions.ts` — verified, all four call it.

**Categories with no read tier** (`documents` → `documents.read`, `compliance`
→ `compliance.read`) need an explicit mapping. Decision below.

### 3.3 Fix 2 — row scoping

**New: a scope option on `runBeaconReport`, built in `apps/web`.**

`BeaconReportRunOptions` (`packages/reports/src/run.ts:11-15`) gains one
optional field:

```ts
export type BeaconReportRunOptions = {
  maxRows?: number
  fiscalStartMonth?: number
  runtimeFilters?: ReportRuleGroup | null
  /** NEW — mandatory row predicate, built by the caller from its own context. */
  scope?: ReportRuleGroup | null
}
```

`mergeFilters` (`run.ts:60-67`) composes it **last and non-overridably**:

```
effective = scope AND (definition.filters AND runtimeFilters)
```

The scope predicate must not be replaceable by a saved definition's filters —
a tenant author must not be able to widen past their own access. So it is
combined at the same `combinator: 'and'` level and is never sourced from
`definition.query`.

**`packages/reports` stays permission-free.** It receives a rule group and
applies it. It does not know what a permission is.

**Building the scope in `apps/web`:**

```
apps/web/src/lib/report-scope.ts   (NEW)
  buildReportScope(ctx, tx, entities): ReportRuleGroup | null
    for each entity that has a site column:
       scope = moduleScopeWhere(ctx, tx, { prefix, siteCol, ownerCols, personCol })
       null      → tenant-wide for that entity; contribute nothing
       sql`false`→ contribute a rule that matches nothing
       otherwise → compile the SQL to its literal text for the rule group
    return null if every entity is tenant-wide (no-op, zero overhead)
```

Two implementation notes:

- `moduleScopeWhere` returns Drizzle `SQL`; the AppKit compiler needs a rule.
  Convert via the SQL fragment's own text rather than string-building by hand,
  and **fail closed** if the conversion cannot be made — a rule that silently
  matches everything is worse than an error.
- `mySiteIds` (`visibility.ts:120-122`) and `resolveVisibilityTier` are
  module-private and must be exported.

### 3.4 Entities that cannot be row-scoped

Honest scoping of the fix. Two groups:

| Group                       | Entities                                                                                                                                        | Why                                | Treatment                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| **Has a site/owner column** | `incidents`, `corrective_actions`, `inspection_records`, `documents`, `equipment_items`, `ppe_items`, `training_records`, `vehicle_log_entries` | `moduleScopeWhere` works           | **Full scope injection.** This covers every finding.                                          |
| **No usable column**        | `people`, `org_units`, `compliance_status`, `monitored_sessions`, `incident_rates`, `training_matrix`, `hazid_signatures`                       | aggregate views or registry tables | **Permission-gate only** (`compliance.read`, `dashboards.read`, …). No row filter is claimed. |

`people` is the sensitive one. Decision:

> **`people` and `org_units` must be permission-gated to at least
> `admin.org.manage` / `admin.users.manage` before any scope work.** They are
> workforce and location master data, they have no site column, and a foreman
> currently reads them through insights. They are **not** part of this phase's
> scope injection — they are removed from the analytics catalogue for roles
> that lack the admin permission, and that removal is the fix.

### 3.5 Fix 2b — BHQL / insights, the same discipline

`runAuthorizedBhql` (`apps/web/src/lib/analytics-access.ts:63-75`) is the
insights execution path. It must apply the same two gates.

**Critical detail:** `apps/web/src/app/(app)/insights/_data.ts:32-58`
(`runCardCached`) is an **independent copy** of the same logic, reached from
`loadDashboardCardRenders` and the `/insights` page. **Fixing only
`runAuthorizedBhql` leaves `/dashboard` unscoped.** Both must change.

The result cache key (`_data.ts:41`) must additionally include a scope
fingerprint, or one user's scoped rows will be served to another from cache.
Today the key is `${tenantId}:${scopeKey}:${trustScope}:${key}` — tenant-scoped
but **not user-scoped**, which is already latent and becomes exploitable once
scoping exists.

### 3.6 The three paths that must not bypass scope

Explicit requirement. Each gets a named choke point and a test:

| Path                           | Choke point                                                                                 | Test           |
| ------------------------------ | ------------------------------------------------------------------------------------------- | -------------- |
| **Report query (interactive)** | `loadAuthorizedReportCatalogInTransaction` (entity gate) + `runReportForViewer` (row scope) | T-S1-1, T-S1-2 |
| **Report export**              | same as above — `export/route.ts:54` calls `runReportForViewer`                             | T-S1-3         |
| **Insights query**             | `runAuthorizedBhql` **and** `runCardCached`                                                 | T-S1-4, T-S1-5 |
| **Insights export**            | inherits insights query; route additionally `requireExportContext()`                        | T-S1-6         |
| **Scheduled reports**          | `workers/reports.ts:137` must pass `requestCtx`-derived scope                               | T-S1-7         |

### 3.7 Fix 3 — close the two direct bypasses

| Fix | Change                                                                                                                         | File                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| G1  | Nav: `/insights` gated on `insights.read`, not `reports.read`                                                                  | `nav/registry.ts:209`                      |
| G2  | `reports/layout.tsx` requires `reports.read` (not `builder` alone) to render the definition list                               | `reports/layout.tsx:16-21`                 |
| G3  | `loadDefinitionById` adds `ne(state, 'archived')` to match `loadVisibleDefinitions:28`                                         | `reports/_definitions.ts:41`               |
| G4  | `export/route.ts:28` uses `requireExportContext()` (adds `admin.data.export` + no-impersonation), mirroring the insights route | `reports/definitions/[id]/export/route.ts` |

G1 is a **tightening** that may hide `/insights` from a foreman who currently
sees it via `reports.read`. That is correct — `insights.read` is the intended
key — but it is a visible change.

### 3.8 The `EXCLUDE_TABLES` blocklist (H-5)

**Decision: do not invert the blocklist into an allowlist in this phase.**
An entity allowlist would require maintaining a list that must be updated for
every new table — and `discover.ts:1-7` deliberately chose zero-maintenance.

Instead, **Fix 1's entity gate is the allowlist.** A table becomes visible to a
given user only if it maps to a module whose read tier that user holds. Adding
a table to `TENANT_SCOPED_TABLES` no longer auto-grants it; it becomes visible
only once it is added to `REPORT_ENTITIES` with a category, and then only to
holders of that category's read permission.

That converts the blocklist into defence-in-depth rather than the primary
control, without a maintenance burden.

### 3.9 The `app_responses` system cards (H-6)

`addTrustedSystemAppResponsesEntity` (`discover.ts:437-452`) exposes
tenant-wide `form_responses`. Two independent corrections, both cheap:

1. `isTrustedSystemCard` already exists (`_system-cards.ts:24-35`). Pair it
   with a `forms.response.read.*` check at the point where
   `trustedSystemCard` is consumed (`insights/_data.ts:47`,
   `cards/[id]/export/route.ts:78, 121`, `insights/page.tsx:76`). A foreman
   with `forms.response.read.site` then gets scoped counts; one without gets
   the card hidden rather than a wrong number.
2. Leave the entity available — `kpi-inspections` and `kpi-ppe-issues` also
   use it and must keep working.

`_widgets.test.ts:11` builds `addTrustedSystemAppResponsesEntity(...)` at
module scope; hiding the entity rather than removing it keeps that test green.

---

## 4. S2 — Vehicle-log detail

### 4.1 The fix, and why it is one line plus one call

The list page already has the correct gate and the correct scope. The detail
page must apply the same two things. No new concept.

```
apps/web/src/app/(app)/equipment/vehicle-log/[id]/page.tsx

 1. Add the list's read-tier gate at the top of the page component,
    immediately after requireRequestContext():
        if (!can(ctx,'equipment.read.all') &&
            !can(ctx,'equipment.read.site') &&
            !can(ctx,'equipment.manage')) redirect('/dashboard')
    (mirrors vehicle-log/page.tsx:86-92 verbatim)

 2. After the fetch, apply canSeeRecord using the SAME columns the list scopes
    on — the parent vehicle, not the entry:
        canSeeRecord(ctx, tx, {
          prefix: 'equipment',
          siteId:    truck?.currentSiteOrgUnitId ?? null,
          personId:  truck?.currentHolderPersonId ?? null,
        })
    (mirrors equipment/[id]/page.tsx:869-874)
```

### 4.2 Why the parent vehicle, not `truck_log_entries.site_org_unit_id`

This is a real decision with a real trade-off.

| Option                                          | Behaviour                                                                                                                             | Verdict                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **(a) parent vehicle's `currentSiteOrgUnitId`** | Identical to the list page. An entry filed at site A for a truck now at site B is visible under B.                                    | **Chosen.** Consistency with the list is what the user sees; a detail page that disagrees with its own list is worse than either. |
| (b) the entry's own `site_org_unit_id`          | Semantically purer ("where the truck actually was"), but **diverges from the list**, so a row visible in the list could 404 on click. | Rejected — that inconsistency is a new defect.                                                                                    |

The purer option can be adopted later as a deliberate change to **both**
surfaces, with a migration of the semantics. It must not be half-done here.

### 4.3 What is reused

Nothing new. `can`, `requireRequestContext`, `canSeeRecord`, and the existing
parent-vehicle scope — all already imported or already proven at the two sibling
routes.

---

## 5. S3 — PPE

### 5.1 The honest constraint

`ppe_items` has **zero** org_unit columns (RUNTIME verified), as does
`ppe_issues`. `ppe_inspections` has `site_org_unit_id`, but the register row
does not.

**Therefore S3 cannot be fixed with scope. It must be fixed with a
permission tier.** Any design that claims otherwise would be inventing a
location model that does not exist — which `AGENTS.md` forbids.

### 5.2 The fix

**Two new permission keys, mirroring the pattern every other module uses:**

```
ppe.read.self   (new)
ppe.read.site   (new)
```

alongside the existing `ppe.read.all` (`iam.ts:215-223`). Three additions to
the catalogue: **91 → 93**.

`readTierCovers` (`packages/tenant/src/index.ts:243-253`) already implements
the widening `all ⊃ site ⊃ self` for any `<prefix>.read.<tier>` key. So adding
the two keys makes `resolveVisibilityTier` return `'site'` or `'self'` with
**no change to `visibility.ts`**.

**Then three edits:**

| #   | Change                                                                                                        | File                           | Behaviour                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| P1  | Gate the page: require any `ppe.read.*` tier, else `redirect('/dashboard')`                                   | `ppe/page.tsx` (before `:116`) | mirrors `equipment/page.tsx`                                                             |
| P2  | `moduleScopeWhere(ctx, tx, { prefix:'ppe', personCol: ppeItems.currentHolderPersonId })` ANDed into `filters` | `ppe/page.tsx:116-194`         | `self` tier → own issued items; `site` tier → falls through to own (no `siteCol` exists) |
| P3  | Same gate + `canSeeRecord` on the detail fetch                                                                | `ppe/[id]/page.tsx:867, 884`   | mirrors `equipment/[id]/page.tsx:869`                                                    |
| P4  | Nav gate: `requiredPermission: 'ppe.read.self'`                                                               | `nav/registry.ts:188`          | mirrors `equipment` at `:185`                                                            |

### 5.3 Graceful degradation — stated, not hidden

Because `ppe_items` has no `siteCol`:

- `'all'` tier → no filter (unchanged; `safety_manager` / `tenant_admin`).
- `'site'` tier → `moduleScopeWhere` falls through to own-only
  (`visibility.ts:169-173`), i.e. `site` behaves **as `self`**.
- `'self'` tier → own issued items (`current_holder_person_id = ctx.personId`).

**This is strictly better than today** (everything visible to everyone) and it
is honest. It must be stated in the manual, because "site-scoped PPE holder"
will not see their site's stock until a location column exists.

**Not in this phase:** adding `ppe_items.current_site_org_unit_id`. It is the
correct long-term model — a physical item _does_ live somewhere — but it is a
migration plus a write-path change across issue/return/check-out, and it
belongs to the scope phase.

### 5.4 Role grants

`ppe.read.self` must be granted so the product remains usable:

| Role             | Change                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `worker`         | **+ `ppe.read.self`** — crews need to see their own issued gear                                        |
| `foreman`        | **+ `ppe.read.all`** — a foreman manages PPE issue/return already (`ppe.issue`) and needs the register |
| `safety_manager` | unchanged (has `ppe.read.all`)                                                                         |
| `tenant_admin`   | automatic (full catalogue)                                                                             |

Granting `ppe.read.self` to `worker` is the minimum that makes P1 safe: a crew
still sees its own gear, and nothing else.

---

## 6. What is explicitly **not** changed

| Not changed                                        | Why                                                                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **RLS** — no policy, no GUC, no `rls.ts` edit      | 190 policies are correct; the findings are within-tenant. `rls.test.ts:21-28` asserts the predicate shape.                        |
| **`role_assignments.scope` shape**                 | No new scope type. Site scope is reused as-is.                                                                                    |
| **`people_assignments`**                           | Not needed by S1/S2/S3. Deferred to the scope phase with a regression test pinning current behaviour.                             |
| **`truck_log_entries.site_org_unit_id` semantics** | Chosen (a) over (b) precisely to avoid a half-migration.                                                                          |
| **`ppe_items` schema**                             | No new column in this phase.                                                                                                      |
| **`canSeeSite` / `selfOnlyFilter`**                | Dead code. Deleting them is a **separate cleanup**, deliberately excluded so this change stays reviewable. Record as a follow-up. |
| **`api_keys` scope**                               | Unchanged; still tenant-wide by design.                                                                                           |
| **`EXCLUDE_TABLES` → allowlist**                   | Fix 1's entity gate becomes the allowlist instead.                                                                                |

---

## 7. Backward compatibility

### 7.1 Behaviour that becomes **more restrictive** (intended)

| Surface                                         | Before                           | After                                                               |
| ----------------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| Reports — foreman                               | all 32 seeds, tenant-wide        | only entities matching a held read tier; rows scoped to their sites |
| Reports — `safety_manager` / `tenant_admin`     | tenant-wide                      | **unchanged** (`read.all` → `undefined`)                            |
| Insights — foreman                              | sees `app_responses` tenant-wide | hidden without `forms.response.read.*`; scoped with `.site`         |
| PPE list — `worker`                             | whole register                   | own issued items                                                    |
| PPE list — `foreman`                            | whole register                   | whole register (granted `ppe.read.all`)                             |
| PPE list — `safety_manager`                     | whole register                   | **unchanged**                                                       |
| Vehicle-log detail — anyone                     | any entry                        | requires a read tier **and** passes scope                           |
| `/insights` nav                                 | shown to `reports.read` holders  | shown to `insights.read` holders                                    |
| Archived report definition                      | reachable by id                  | 404                                                                 |
| Reports export by a `reports.builder`-only user | allowed                          | requires `reports.read`                                             |

### 7.2 Behaviour that is **unchanged**

- Every module list/detail/export page — **zero changes** to
  `moduleScopeWhere` call sites.
- Every API key and `/api/v1` behaviour.
- `rls.test.ts`, `seed-parity.test.ts`'s 32-seed count, `source-catalog.test.ts`.
- All tenant-admin and safety-manager workflows.

### 7.3 The `osha_300_log` question — needs a product answer, not a code answer

A site-scoped foreman running `osha_300_log` would produce a **partial**
OSHA 300 log. The 300 log is federally required to be complete and
retention-bound.

**Recommendation:** do **not** silently scope this report. Either
(a) restrict it to `read.all` holders and mark it tenant-complete, or
(b) keep it scoped and document that a partial 300 is a site extract.

Flagging it rather than deciding: this is a compliance/legal call, and
`compliance.read` is the permission that should own it.

---

## 8. Regression test per fix

Every fix gets a named test. All are **negative** tests: they assert that data
is _not_ returned, which is what actually fails today.

| ID          | Fix                | Test                                                         | Asserts                                                                   |
| ----------- | ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **T-S1-1**  | entity gate        | foreman + `reports.read` resolves a catalogue                | `incidents`/`corrective_actions` present; `people`/`org_units` **absent** |
| **T-S1-2**  | row scope          | `buildReportScope` for a site-scoped foreman                 | non-null; every rule is site-scoped                                       |
| **T-S1-3**  | report export      | foreman runs `incidents_weekly`                              | rows ⊆ his `siteIds`                                                      |
| **T-S1-4**  | BHQL               | `runAuthorizedBhql` for a foreman                            | same                                                                      |
| **T-S1-5**  | `runCardCached`    | dashboard render for a foreman                               | **cache key differs** from another user; rows ⊆ scope                     |
| **T-S1-6**  | insights export    | foreman hits the export route                                | 403 (already true — pins it)                                              |
| **T-S1-7**  | scheduled          | schedule run-as a site-scoped member                         | scope reaches `runBeaconReport` options                                   |
| **T-S1-8**  | archived def       | `loadDefinitionById` on an archived id                       | `null`                                                                    |
| **T-S2-1**  | vehicle-log gate   | `worker` (0 equipment perms) opens `[id]`                    | redirect/404                                                              |
| **T-S2-2**  | vehicle-log scope  | site-A foreman opens a site-B entry                          | not visible                                                               |
| **T-S2-3**  | consistency        | detail visibility matches list visibility for the same entry | equal                                                                     |
| **T-S3-1**  | PPE nav            | `worker` without `ppe.read.self`                             | nav entry absent                                                          |
| **T-S3-2**  | PPE list gate      | a role with no `ppe.read.*`                                  | redirect                                                                  |
| **T-S3-3**  | PPE self scope     | `worker`                                                     | only own `current_holder_person_id`                                       |
| **T-S3-4**  | PPE tier widening  | `ppe.read.all` holder                                        | sees everything (unchanged)                                               |
| **T-PRE-1** | people_assignments | `org_unit` audience, no assignments                          | resolves to `[]` — pins today's behaviour                                 |

**T-S1-5 is the one most likely to be forgotten.** `runCardCached` is a
separate code path with its own cache; fixing `runAuthorizedBhql` alone would
leave `/dashboard` leaking across users once scoping is in place.

---

## 9. Test-contract constraints on the implementation

Verified present; these will break on a naive change and must be handled
deliberately:

| Test                                                        | Constraint                                                                                                                                                           | Required action                                                                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker/src/lib/report-source-access-contract.test.ts` | **string-matches `workers/reports.ts` source**; asserts the literal `'loadBeaconReportCatalog(tx, sources)'` and `not.toMatch(/loadBeaconReportCatalog\(tx\)(?!,)/)` | Any signature change at `reports.ts:551` breaks it **even if behaviour is correct**. Update the assertion to match the new call, with a comment explaining why. |
| `packages/reports/src/seed-parity.test.ts:29-40`            | compiles all 32 seeds with a **4-arg** `compileCustomReport` call                                                                                                    | Adding a 5th options field is fine (optional), but a seed whose entity lacks the injected scope column will throw.                                              |
| `apps/web/src/lib/analytics-access-policy.test.ts:221-237`  | calls `runBeaconReport(tx, 'tenant-1', {...}, { entities: [INCIDENTS] })` — 4 args                                                                                   | Keep `scope` **optional** so this call site compiles unchanged.                                                                                                 |
| `packages/reports/src/source-catalog.test.ts:43-61`         | asserts the app scope compiles into `"template_id"` in the SQL                                                                                                       | Scope injection must not remove that.                                                                                                                           |
| `apps/web/src/app/(app)/insights/_widgets.test.ts:11`       | builds `addTrustedSystemAppResponsesEntity(...)` at module scope                                                                                                     | **Do not remove the entity** — gate it at consumption instead (§3.9).                                                                                           |

**Design rule that falls out of this:** make the new parameters **optional**
so existing 4-argument call sites and tests keep compiling. The scope is
mandatory in _production_ paths because `apps/web` always supplies it — but the
_type_ stays optional so the package remains a pure engine.

---

## 10. Effort and blast radius

| Fix            | Files                                                                                                                          | New exports                                                   | Schema            | Migration | Manual  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------- | --------- | ------- |
| S1 entity gate | `visibility.ts`, `report-catalog.ts`                                                                                           | `resolveVisibilityTier`, `moduleReadPrefix`, `moduleReadGate` | —                 | **No**    | **Yes** |
| S1 row scope   | `report-scope.ts` (new), `visibility.ts`, `_run.ts`, `analytics-access.ts`, `insights/_data.ts`, `packages/reports/src/run.ts` | `buildReportScope`                                            | —                 | **No**    | **Yes** |
| S1 gates       | `nav/registry.ts`, `reports/layout.tsx`, `_definitions.ts`, `export/route.ts`                                                  | —                                                             | —                 | **No**    | —       |
| S2             | `vehicle-log/[id]/page.tsx`                                                                                                    | —                                                             | —                 | **No**    | —       |
| S3             | `iam.ts`, `ppe/page.tsx`, `ppe/[id]/page.tsx`, `nav/registry.ts`                                                               | —                                                             | 2 permission keys | **No**    | **Yes** |

**Totals: ~13 files, 2 new permission keys, 0 migrations, 0 RLS changes.**

Three manual articles must change (`AGENTS.md` rule 7): reports access, insights
access, and PPE visibility — because in all three cases a user will notice fewer
rows than before.

---

## 11. Design decisions requiring a product answer

Flagged, not decided:

1. **`osha_300_log`** — tenant-complete for `read.all` only, or a site extract?
   (§7.3) This is a compliance/legal decision.
2. **`ppe.read.site` semantics** — accept that it degrades to `self` because no
   location column exists, or defer the key until the column lands?
3. **Dead code** — delete `canSeeSite` / `selfOnlyFilter` in this change, or as a
   separate cleanup? Recommendation: separate, to keep this reviewable.
