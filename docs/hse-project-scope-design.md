# BeaconHS HSE — Project / Organization Scope Design

> **Design only. Nothing in this document has been implemented.**
> Companion to `docs/hse-project-scope-analysis.md` (evidence) and
> `docs/hse-project-scope-implementation-plan.md` (sequence).

---

## 中文摘要

**核心设计决策：不新增 project 表，不给 17 张记录表加 project 字段，不改 RLS。**

BeaconHS 已经拥有：

- `org_units` 自引用层级（可任意深度）
- 成熟的 site scope 机制（`inArray(siteCol, siteIds)` 谓词形状）
- `people_assignments`（person ↔ org_unit + 有效期窗口）

**缺的只有一件事：把「project scope」解析成它自己的后代 site id 列表，然后喂给现有谓词。**

因此最小侵入方案的改动量是：

| 改动                                           | 规模             | 是否需要 migration |
| ---------------------------------------------- | ---------------- | ------------------ |
| `RoleScope` 增加一个变体                       | 1 个 type union  | **否**（jsonb）    |
| 解析 project → 后代 site/area id               | 1 个新函数       | 否                 |
| `moduleScopeWhere` / `canSeeRecord` 支持新维度 | 2 处分支         | 否                 |
| 管理界面允许选 project                         | 1 个过滤条件放宽 | 否                 |
| `readTierCovers` 正则放宽                      | 1 行             | 否                 |
| **记录表加 project 列**                        | **0**            | **否**             |
| **新建 projects 表**                           | **0**            | **否**             |
| **RLS 策略**                                   | **0**            | **否**             |

**这个方案的关键洞察：`mySiteIds()` 返回的是一个扁平 id 列表，`moduleScopeWhere` 对它做 `inArray`。project scope 只要把自身展开成后代 id，就完全复用了既有谓词形状——`visibility.ts` 的核心逻辑一行都不用改。**

**为什么这样比「每张表加 project_org_unit_id」好：**

1. 零 migration 触碰记录表
2. 不会产生「site 已迁移但 project 字段没同步」的数据漂移
3. site 在 project 之间调整时，权限**自动**跟随
4. 新增模块无需记得填写 project 字段

---

## 1. Design principles

Five constraints govern every choice below. They are ranked; when two conflict,
the earlier one wins.

1. **Reuse before extend.** `org_units` already models the location hierarchy
   with a self-FK and arbitrary depth. A `projects` table would duplicate it.
2. **No denormalization that can drift.** A cached `project_org_unit_id` on 17
   tables is 17 chances to be wrong. Derive it instead.
3. **The tenant boundary stays exactly where it is.** Project scope is an
   application-layer concern, exactly like site scope is today. RLS is not
   extended — see §8 for why.
4. **Additive and fail-closed.** A user with no recognised scope sees nothing
   (`visibility.ts:93`, `:175` already return `sql\`false\``). New scope types
   must inherit that.
5. **Builder-first.** Where a capability can be delivered with existing form
   / flow / report primitives, do not add a native module.

---

## 2. Reuse / extend / no-change

Directly answering the task's categories A–E.

### A. Entities to reuse unchanged

| Entity                             | Why it is already correct                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org_units`                        | Self-FK hierarchy, 4 levels, `(tenant_id, level)` and `(tenant_id, parent_id)` indexed. Arbitrary depth structurally allowed.                                        |
| `orgUnitLevel` enum                | `customer / project / site / area` maps onto Cluster / Project / Work Area / Site. **`area` is declared but never used — it is the free slot for Division/Section.** |
| `role_assignments.scope`           | `jsonb NOT NULL`, `$type<RoleScope>()`. A new variant needs **no migration**.                                                                                        |
| `people_assignments`               | `orgUnitId` + `validFrom`/`validTo` + `(tenant_id, orgUnitId)` index. The validity-window pattern is already proven in `packages/compliance/src/audience.ts:89-104`. |
| `departments`, `trades`, `crews`   | Flat catalogues. Correct for the **organisation** axis.                                                                                                              |
| `person_titles`, `job_title_tasks` | Correct for the **competency** axis.                                                                                                                                 |
| All RLS policy machinery           | Tenant-only is the right boundary for this phase.                                                                                                                    |
| `flow_gates`                       | Already the single gate store. Relevant to Phase 6 verification.                                                                                                     |

### B. Entities to extend

| Entity                          | Extension                                                         | Migration?                     |
| ------------------------------- | ----------------------------------------------------------------- | ------------------------------ |
| `RoleScope` type                | Add `{ type: 'orgUnits'; orgUnitIds: string[] }`                  | **No** — `jsonb`               |
| `VisibilityTier` type           | Add `'orgUnit'`                                                   | **No** — TypeScript only       |
| Scope resolver                  | New function: org-unit id → descendant ids                        | **No**                         |
| `moduleScopeWhere`              | One branch for the new scope type                                 | **No**                         |
| `canSeeRecord`                  | One branch                                                        | **No**                         |
| `readTierCovers`                | Widen the regex to accept the new tier                            | **No**                         |
| `_scope-data.ts`                | Drop the `level='site'` hard-filter                               | **No**                         |
| `analytics-access` / report run | Inject the caller's scope                                         | **No**                         |
| `people_assignments`            | **Populate it** — add a UI path to assign a person to an org unit | **No** (schema already exists) |

### C. Entities that need no change at all

- **All 17 `site_org_unit_id` columns.** Project membership is _derived_ from
  the site id, not stored. See §3.
- `tenants`, `tenant_users`, `roles`, `permissions`.
- Every table's tenant FK and RLS registration.
- `hazid_assessments.project_org_unit_id` — becomes an optional authoring hint,
  not a filter input. See §3.4.
- `documents`, `ppe_items`, `people`, `training_records` and the other tables
  with no org column: they are gated by **person** or **permission** scope, not
  location. See §6.

### D. Compatibility that must be preserved

| Must keep working                                             | Why                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Every existing `RoleScope` variant and its semantics          | 4 built-in roles + tenant-defined roles exist in the wild                                                |
| `readTierCovers` widening only downward (`all ⊃ site ⊃ self`) | Roles granted `.read.all` must keep total visibility                                                     |
| The `sql\`false\`` fail-closed fallback                       | A new scope type that matches nothing must not widen access                                              |
| `ctx.scopes` being a plain array union                        | `resolveMembershipAccess` (`:202`) maps one entry per assignment; tools like `selfOnlyFilter` iterate it |
| `api_keys` behaviour                                          | Tenant-wide by design and documented (`api/auth.ts:131-137`)                                             |
| Existing 91 permission keys                                   | Adding `.read.org_unit` is additive; nothing existing changes                                            |
| `people_assignments` semantics                                | Dated person↔org edge; Phase 3 adds data, not columns                                                    |

### E. Minimal-invasive implementation

The whole authorisation change is **one new scope type plus one resolver**:

```
project scope  →  expand to descendant org-unit ids  →  feed the existing
                  inArray(siteCol, ids) predicate
```

`apps/web/src/lib/visibility.ts`'s existing tier machinery does not change
shape — only gains one branch.

---

## 3. The core design

### 3.1 Do not add a project column to record tables

**Rejected alternative:** mirror `hazid_assessments.project_org_unit_id` across
all 17 site-bearing tables.

Rejected because:

| Problem                     | Consequence                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 17 migrations               | Each is a lock, a rollback question, and an RLS-adjacent risk                                                                    |
| Write-time duplication      | Every create/update path must set it; one omission = silent scope hole                                                           |
| Drift                       | Moving a site between projects leaves stale project ids on every record under it                                                 |
| No help where it is missing | `ppe_items`, `people`, `documents`, `training_records` have no site column at all, so the column would not land uniformly anyway |
| New modules                 | Every future module must remember a rule the existing 17 modules did not have                                                    |

**Chosen alternative:** derive project membership from `site_org_unit_id`.

### 3.2 Project scope as a descendant expansion

The existing predicate shape is:

```ts
// apps/web/src/lib/visibility.ts:171
const sites = mySiteIds(ctx) // flat string[]
if (sites.length > 0) return or(inArray(cols.siteCol, sites), ...ownConds)
```

A project scope needs to answer: _"which org units belong to project X, at any
depth?"_

**New resolver** (conceptual):

```
orgUnitScopeIds(ctx, tx, orgUnitIds) -> string[]
  1. Collect every {type:'orgUnits'} scope on ctx.scopes → requested ids
  2. If any {type:'tenant'} scope exists → return null (no narrowing; caller
     keeps its existing behaviour)
  3. Walk org_units.parent_id from the requested ids, collecting descendants
     at every depth, using one recursive CTE
  4. Return the union: requested ids ∪ all descendants
```

Then `moduleScopeWhere` treats that set exactly like `mySiteIds()`.

**Why this is cheap:**

- The CTE precedent already exists — `apps/web/src/app/(app)/locations/page.tsx:129`
  already runs `WITH RECURSIVE descendants` over `org_units`.
- It carries a documented gotcha that must be reproduced: _"Drizzle's sql tag
  binds arrays as single params which Postgres can't parse, so we expand the ID
  list via `sql.join`"_ (`locations/page.tsx:126-127`). The resolver must use
  `sql.join`, not `inArray` with an array.
- **Resolution is per-request and cacheable.** `org_units` is small per tenant.
  Resolve once per request context and memoise, so the CTE runs once, not once
  per list query.
- The result is a **flat id list**, so `inArray(cols.siteCol, ids)` is unchanged.

### 3.3 Which records a project scope reaches

With descendant expansion, a project-scoped viewer sees records whose
`site_org_unit_id` is the project itself **or any descendant at any depth**:

```
project "Turnaround 2026"
  ├─ area   "Section A"          ← reached
  │    └─ site "Tank Farm"       ← reached
  └─ site  "Cracker Unit"        ← reached
```

This is the behaviour an HSE manager expects, and it is what
`packages/compliance/src/audience.ts:89-104` **cannot** do today — that
resolver matches `people_assignments.org_unit_id` exactly, with no subtree walk
(`inArray(peopleAssignments.orgUnitId, orgUnitIds)`), so a project-targeted
obligation misses everyone assigned to a child site.

### 3.4 `hazid_assessments.project_org_unit_id`

Currently inert: written (`_actions.ts:376, 405`), displayed
(`[id]/page.tsx:1062`), exported to flows (`flows/adapters/hazid.ts:88-93`),
and **never used in any WHERE clause**.

Under this design it becomes an **authoring convenience**, not a filter input:

- Keep the column and the picker (they cost nothing and are already built).
- Do **not** pass it to `moduleScopeWhere`. Project scope comes from the scope
  assignment, not from a field on the row.
- Document it as "the project this assessment belongs to", with the
  understanding that authorisation derives from `site_org_unit_id` + the scope.

This is a strict improvement: today the column suggests scoping that does not
happen; after the change it is honestly what it is.

### 3.5 `readTierCovers` must be widened

`packages/tenant/src/index.ts:244`:

```ts
const match = /^(.+)\.read\.(all|site|self)$/.exec(requested)
```

A new key `incidents.read.org_unit` **does not match**, so it would degrade to a
bare `Set.has()` — no tier widening at all. The regex must accept the new tier,
and the widening direction must be decided:

```
read.all  ⊃  read.site  ⊃  read.org_unit  ⊃  read.self
```

That ordering is deliberate: `read.org_unit` is **narrower** than `read.site`
(a project is a subset of a site's visibility), so holding `read.site` must not
be assumed to grant `read.org_unit`, and holding `read.all` must.

**Decision: do not reuse the name `site`.** Introduce `org_unit` to match the
scope type name, keeping `site` as a permanent back-compat alias.

### 3.6 Tier resolution must stop being permission-only

`resolveVisibilityTier` (`visibility.ts:114-118`) reads permissions and never
`ctx.scopes`. Under the new tier it must consult both:

```
'all'      ⇔ super-admin or <prefix>.read.all
'site'     ⇔ <prefix>.read.site
'org_unit' ⇔ <prefix>.read.org_unit
'self'     ⇔ otherwise
```

Then the branch order matters. Today `:165` returns `undefined` for `'all'`
(no filter). The new `'org_unit'` tier must sit **below** `'all'` and be
evaluated **before** the fall-through to own-only:

```
'all'      → undefined                       (unchanged)
'site'     → inArray(siteCol, mySiteIds())    (unchanged)
'org_unit' → inArray(siteCol, expandedIds())  (NEW — must come before self)
'self'     → ownerCols / personCol only       (unchanged)
```

### 3.7 Fail-closed guarantees

Two invariants must survive:

- A user with **no** recognised scope still resolves to `sql\`false\``
(`visibility.ts:93`, `:175`). The new branch must not turn "no ids" into
  "no filter".
- A `{type:'orgUnits'}` scope whose ids **resolve to nothing** (deleted or
  moved org units) must yield **no rows**, not all rows. Treat an empty
  expansion exactly like an empty `siteIds` list: fall through to own-only, and
  if that is also empty, `sql\`false\``.

---

## 4. The two axes BeaconHS already keeps separate

The HSE scenario lists Contractor/Subcontractor and Project Staff alongside the
location hierarchy. **They are not the same axis** and must not be modelled
together.

| Axis             | Question                         | Existing model                                 |
| ---------------- | -------------------------------- | ---------------------------------------------- |
| **Location**     | _Where did this happen?_         | `org_units` (customer/project/site/area)       |
| **Organisation** | _Who does this person work for?_ | `departments`, `crews`, `trades`, `people` FKs |
| **Competency**   | _What may this person do?_       | `person_titles`, `job_title_tasks`             |

**Contractors belong to the organisation axis.** A contractor is a company, and
a person is employed by (or subcontracted to) that company. BeaconHS has **no
company/employer model at all** — verified: no `contractor`/`subcontract`/
`vendor`/`employer` entity in the schema, and `people` has only `employee_no`
and `external_employee_id`.

**Recommendation: do not model contractors in Phase 1.** It is a genuine gap,
but it is an _organisation_ gap, not a _location-scope_ gap. Folding it into
`org_units` would:

- conflate "where" with "who works for whom",
- make the descendant walk meaningless (a contractor has no site subtree),
- and force every site-scope query to special-case it.

`people_assignments.org_unit_id` **can** express "this person works on project
X" today, because it is a dated person→org edge with no level constraint. That
is the right home for Project Staff placement. Modelling the contractor
_organisation_ itself is a separate design question and is explicitly a
non-goal of Phase 1 (§10).

---

## 5. Design for the surfaces that have no scope at all

Project scope cannot be layered onto surfaces that have **no** row scope. These
need the base tier first.

| Surface                | Current                                      | Design                                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reports / Insights** | No scope injected at all (`run.ts:46-58`)    | **Highest priority.** Inject the resolved scope as a mandatory, system-generated `AND` on every discovered entity, in the one place `resolveAnalyticsAccess` composes the catalogue. Closes S1 and is a precondition for project scope being meaningful. |
| **Vehicle-log detail** | Bare id query (`[id]/page.tsx:133`)          | Add the read-tier gate the list page already has, then `canSeeRecord` keyed on the parent vehicle's `currentSiteOrgUnitId` (the same column the list scopes on).                                                                                         |
| **PPE**                | No scope, no permission (`ppe/page.tsx:116`) | Add a `ppe.read` gate + a tier. `ppe_items` has **no** org column, so location scope is impossible without one; start with a permission tier (person/`current_holder` if added later).                                                                   |
| **People**             | No scope, no `people.*` key                  | Introduce a `people.read.*` family. Location scope requires `people_assignments` to be populated (§6) — so people scope is **person-scope first, org-scope later**.                                                                                      |
| **Documents**          | Binary `read`/`manage` only                  | Decide whether documents are per-location. `document_acknowledgment_sessions.site_org_unit_id` exists but is never used for visibility. Recommend: permission tier now, location scope only if the business requires it.                                 |
| **Compliance**         | Tenant-only queries                          | Add a scope to `_signals.ts` and to `by-person` (which must reject a person the caller may not view). Fix the `org_unit` audience's missing subtree walk while in there.                                                                                 |
| **Notifications**      | Role/group audience, no record check         | Filter the resolved audience through `canSeeRecord` before enqueue, or redact `data`/`linkPath` for recipients who fail it.                                                                                                                              |
| **Kiosk**              | Shared PIN, tenant-wide                      | Out of Phase 1 scope. Flagged for a security decision.                                                                                                                                                                                                   |

**Ordering consequence:** the base-tier work is a **prerequisite** for project
scope on those surfaces, not a parallel task.

---

## 6. `people_assignments` must be populated

Two distinct needs, one table.

### Need 1 — people-based authorisation (already the compliance precedent)

`packages/compliance/src/audience.ts:89-104` resolves an audience from
`people_assignments` + a validity window. It is the **only** existing
people→org mechanism, and it is empty (0 rows, no writer, no UI).

Filling it fixes a live functional defect: a `compliance_audience` row with
`kind='org_unit'` currently resolves to **zero people with no fallback**.

### Need 2 — person-based scope

`recordVisibilityWhere`'s `people` scope variant (`visibility.ts:69-70`) already
matches `personCol` against a person-id list. With `people_assignments`
populated, a project scope can be expressed **without any record-location
column** on people-only modules:

```
project X → people_assignments (validity window) → person ids → recordVisibilityWhere
```

This is genuinely zero-migration for `training_records`,
`training_skill_assignments`, `people`, `ppe_items` — none of which has an
org column.

### Requirement

Phase 1 must add a **UI + server-action path** to assign a person to an org
unit with a validity window. The schema, indexes and RLS registration all
already exist; only the write path is missing.

**Guard:** adding a person→org assignment is itself a privileged act. It must be
gated (`admin.org.manage` or a new scoped key) and audited.

---

## 7. Administration UI

`_scope-data.ts` currently hard-filters:

```ts
// apps/web/src/app/(app)/admin/users/_scope-data.ts:61-65
.where(and(eq(orgUnits.level, 'site'), isNull(orgUnits.deletedAt)))
```

`parseRoleScope` (`:32-57`) accepts only the six known `type` strings and
silently degrades anything else to `{type:'self'}` (`:56`).

Required changes:

| File                                | Change                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `_scope-data.ts` `parseRoleScope`   | Add the `orgUnits` case; keep the `{type:'self'}` default for unknown types                    |
| `_scope-data.ts` `loadScopeOptions` | Stop hard-filtering to `level='site'`; offer `project` (and optionally `area`) and keep `site` |
| `_scope-data.ts` `describeScope`    | Add a label for the new type                                                                   |
| `scope-picker.tsx` `TYPE_OPTIONS`   | Add the option                                                                                 |
| `_actions.ts`                       | No change — writes already route through `parseRoleScope`                                      |

**Validation gap to close:** `role_assignments.scope` is `jsonb NOT NULL` with
**no CHECK constraint** (verified: no `jsonb_typeof` guard for it anywhere in
`packages/db/drizzle/*.sql`). A hand-written or stale `{"type":"project",…}`
row would be copied verbatim into `ctx.scopes` by `resolveMembershipAccess`
(`:202`) and treated as _unrecognised_ by every branch — which fails closed for
`recordVisibilityWhere`/`moduleScopeWhere`, but makes `canSeeSite` return
`false` and breaks `selfOnlyFilter`'s `order` map.

Phase 1 should therefore add a **runtime** guard in the resolver: an
unrecognised scope type must be ignored and logged, never silently widen access.

**Not recommended:** a SQL CHECK on the jsonb shape in this phase. It would need
a migration on `role_assignments` and locks a forward-compatible shape. The
runtime guard plus `parseRoleScope` validation is the smaller, safer change.

---

## 8. Why RLS must not be extended

Extending RLS to a second dimension is the "more correct" option and is
**rejected for this phase**, on evidence:

| Consideration                                                          | Evidence                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The policy is deliberately one equality                                | `rls.ts:44-54` documents that the previous `OR bypass_rls` branch made the predicate **non-sargable**; `rls.test.ts:21-28` asserts the single-equality shape |
| A second predicate needs a second GUC on **every** connection          | Today only `withTenant` sets one GUC; a scope predicate would need it set for every request path                                                             |
| The scope lives in `ctx.scopes`, which is **per-user**, not per-tenant | An RLS policy cannot express per-user visibility without materialising the scope into the session                                                            |
| `rls.test.ts` asserts exact registry coverage                          | Changing policy shape breaks a test that exists to keep the predicate index-usable                                                                           |
| Site scope — the closest analogue — is **entirely** application-layer  | Consistency argues for the same treatment                                                                                                                    |

**Decision: keep RLS tenant-only.** Project scope is enforced in
`apps/web/src/lib/visibility.ts`, exactly like site scope is today.

**Revisit if** a future requirement is "a compromised application query must not
read cross-project data" — that is a database-level guarantee and would need a
different design (materialised scope GUCs, or `SECURITY DEFINER` views). It is
not this phase's problem, and `SECURITY DEFINER` must not be introduced without
explicit review.

---

## 9. Migration risk

**There is no migration in the recommended design.** That is the point, and it
removes the largest category of risk. Specifically avoided:

- Adding `project_org_unit_id` to 17 tables (17 migrations, lock, rollback).
- Creating a `projects` table (duplicates `org_units`).
- Adding a `scope` column to `api_keys` (deferred; API keys stay tenant-wide and
  the grant must instead be stated explicitly on the key-creation UI).
- Changing any RLS policy.
- Populating `people_assignments` with a backfill migration — this is **data**,
  and per `AGENTS.md` a seed/data change is not a migration.

**One optional migration is deferred, not scheduled:** if Phase 3 later decides
contractor organisations are needed, that is a new entity and a new migration,
and it must be a separate approved step. It is a non-goal of Phase 1.

**Residual migration risk therefore reduces to: none in Phase 1.** Every risk
that remains is a code-risk, listed in the plan.

---

## 10. Compatibility risk

| Risk                                                             | Assessment                                                                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An existing `{type:'sites'}` assignment silently changes meaning | **No.** New variant is additive; `sites` keeps its exact-id semantics.                                                                                                            |
| A user with `read.all` loses access                              | **No.** `'all'` still short-circuits to `undefined` at `visibility.ts:165`.                                                                                                       |
| A role holding only `read.site` is now narrower                  | **No.** `read.org_unit` is a new key; absent keys never grant.                                                                                                                    |
| A malformed `scope` row now behaves differently                  | **Managed** by the unrecognised-type guard (§7).                                                                                                                                  |
| `selfOnlyFilter` breaks                                          | It is **dead code** (0 consumers). Delete it rather than extend it.                                                                                                               |
| `canSeeSite` breaks                                              | Also **dead code** (0 consumers). Delete rather than extend.                                                                                                                      |
| Performance regression from descendant resolution                | **Managed** — resolve once per request, memoise; `org_units` is small per tenant.                                                                                                 |
| Reports/insights behaviour changes for existing users            | **Yes, deliberately.** Injecting scope _removes_ access that exists today. This is a security fix, but it is user-visible and must be called out in release notes and the manual. |
| PPE / people / documents start returning fewer rows              | **Yes, deliberately** — same reason.                                                                                                                                              |
| `people_assignments` starts having data                          | Behaviour change in compliance audience resolution (correctly). Verify with a test before enabling.                                                                               |

---

## 11. Explicit non-goals

Not in this phase:

1. **Contractor / subcontractor organisations.** No company entity exists;
   designing one is a separate decision (§4).
2. **API-key project scoping.** `api_keys` has no scope column; the tenant-wide
   grant must instead be documented on the key-creation UI.
3. **Extending RLS** to a second dimension (§8).
4. **Per-project _write_ restriction.** Scope narrows reads; mutation gating
   stays permission-based, matching today's site behaviour.
5. **Section/Division as a first-class level.** `org_units` has no `division`
   level and `departments` is flat. Tenant admins may place a division as
   `level='area'`; a dedicated level is a later enum migration.
6. **Fixing the recorded security findings.** S1–S17 are documented, not fixed
   here (`AGENTS.md`: record, do not fix as a side effect). Phase 2 of the plan
   fixes them deliberately and separately.
7. **Renaming `site` to `org_unit`.** `read.site` and `{type:'sites'}` are
   permanent back-compat names; the new tier is `org_unit`.

---

## 12. The design in one picture

```
                       ctx.scopes  (RoleScope[])
                                │
        ┌───────────────────────┼────────────────────────┐
        │                       │                        │
   {type:'tenant'}        {type:'sites'}           {type:'orgUnits'}   ← NEW
        │                       │                        │
        ▼                       ▼                        ▼
   no narrowing          flat id list           resolve descendants   ← NEW
        │                       │                   (1 recursive CTE,
        │                       │                    memoised/request)
        │                       │                        │
        │                       │                        ▼
        │                       │                 flat id list
        │                       │                        │
        └───────────┬───────────┴────────────────────────┘
                    ▼
       resolveVisibilityTier(ctx, prefix)
         all      → undefined          (no filter — UNCHANGED)
         site     → inArray(siteCol, mySiteIds())        (UNCHANGED)
         org_unit → inArray(siteCol, expandedIds())      ← NEW
         self     → ownerCols / personCol only            (UNCHANGED)
                    │
                    ▼
              SQL WHERE  ──►  ctx.db() = withTenant  ──►  RLS (tenant_id)
                                                                 UNCHANGED
```

**Nothing in the lower half of that diagram changes.** Project scope is
delivered entirely by feeding a different id list into a predicate that already
exists.
