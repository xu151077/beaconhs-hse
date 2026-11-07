# BeaconHS — Commit 15B-1: Authorization Pipeline Core Impact Audit

**Status:** read-only. No code changed, nothing staged, nothing committed.
**HEAD at audit:** `87b5f2f4 feat(auth): add canonical project scope resolver`
**Inputs:** `apps/web/src/lib/project-scope.ts`, `docs/hse-project-scope-authorization-design.md`,
`docs/hse-project-scope-resolver.md`, and the live code and schema at HEAD.
**Target semantics (settled for 15B, not implemented):**

- **D1** `read.all` = all rows _within_ the caller's Project Scope
- **D2** `tenant_admin` = an explicit `{type:'tenant'}` scope → `unrestricted`

No architectural conflict with D1/D2 was found. Both are implementable against the real
code without touching RLS, the permission catalogue, or any consumer.

---

## 1. Current authorization pipeline, from real imports

The pipeline is **not** a single chain. It is three independent implementations that share
a vocabulary but not a code path, plus a fourth path (the public API) that shares neither.

```
 permission key ──can()──▶ read tier ──▶ row predicate ──▶ SQL
 (catalogue)      packages/tenant:101      visibility.ts   ctx.db()
                                        analytics/scope.ts
                          ▲
                     ctx.scopes (RoleScope[])
                          ▲
                    role_assignments.scopes (JSONB)
```

### The three in-app implementations

| #   | implementation              | file                     | tier source                     | scope source                               | short-circuit                         |
| --- | --------------------------- | ------------------------ | ------------------------------- | ------------------------------------------ | ------------------------------------- |
| 1   | `recordVisibilityWhere`     | `visibility.ts:46`       | **none — permissions not read** | `ctx.scopes`, unioned                      | `visibility.ts:51,53`                 |
| 2   | `moduleScopeWhere`          | `visibility.ts:157`      | `resolveVisibilityTier`         | `mySiteIds` (only `{type:'sites'}`)        | `visibility.ts:165`                   |
| 3   | `canSeeRecord`              | `visibility.ts:194`      | `resolveVisibilityTier`         | `mySiteIds`                                | `visibility.ts:201`                   |
| 4   | `resolveEntity` (analytics) | `analytics/scope.ts:368` | `tierFor`                       | `subject.siteIds` from `siteIdsFromScopes` | `analytics/scope.ts:374` (and `:327`) |

`mySiteIds` (`visibility.ts:120-122`) and `siteIdsFromScopes` (`scope.ts:308`) both read
**only** `{type:'sites'}` scopes. Neither knows `orgUnits` or `people_assignments` exists.

### The fifth path

| path                      | authorization                                                                  | row scope                                                                             |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| public REST API `/api/v1` | `keyHasPermission` + `readPermissionForEntity` (`api/v1/[entity]/route.ts:28`) | **none** — `readEntityRows` filters `deletedAt` + RLS. `api_keys` has no scope column |

### The canonical resolver is not wired

`grep -rl "project-scope"` over `apps/web/src`, `apps/worker/src` and `packages` returns
**only** `project-scope.ts` and its own contract test. No business code imports it, so
`read.all` still means tenant-wide everywhere and no existing behaviour has changed.

---

## 2. Every short-circuit, at HEAD line numbers

Line numbers re-read from HEAD; the previous design doc's approximations were off by a few
lines in places and are corrected here.

### S1 — `recordVisibilityWhere` → `undefined` (2 call sites)

```
visibility.ts:51   if (ctx.isSuperAdmin) return undefined
visibility.ts:53   if (scopes.some((s) => s.type === 'tenant')) return undefined
```

- **function:** `recordVisibilityWhere(ctx, tx, cols)`
- **callers:** exactly **2**, both in the AI assistant
  - `lib/assistant/tools.ts:652` — `search_people` tool
  - `app/(app)/assistant/_commit-actions.ts:45` — TOCTOU re-check on a linked incident
- **input:** `ctx`, `tx`, `{ personCol?, siteCol?, createdByCol? }`
- **current behaviour:** returns `undefined` for super-admin and for a `{type:'tenant'}`
  scope; otherwise a union of the caller's own records plus one condition per scope type
  (`sites` → `inArray(siteCol, …)`, `people` → `inArray(personCol, …)`, `crews` → subquery,
  `team` → department/group subquery); `sql\`false\`` when nothing applies (line 88).
- **why it bypasses scope:** it is the only entry point that **ignores permissions entirely**
  and grants visibility _from scope_. That is the dependency inversion — scope widens here,
  while in S2/S3/S4 permission discards scope. Two opposite failure modes in one pipeline.
- **desired 15B behaviour:** keep the permission-independence decision explicit, AND the
  Project Scope predicate in, so a `{type:'tenant'}` scope is the only non-permission route
  to `undefined`.
- **exact change:** after computing the union, AND the resolver's `personIds`/`orgUnitIds`.
  `undefined` may then only be returned for super-admin or `{type:'tenant'}` **and** when no
  narrowing was requested.
- **affected consumers:** 2.
- **tests required:** `search_people` must not return an out-of-project person; a
  `{type:'tenant'}` holder must still see the whole roster; a user with no assignment must
  get an empty result, not everything.

### S2 — `moduleScopeWhere` → `undefined` (68 call sites)

```
visibility.ts:165  if (tier === 'all' || (cols.prefix === 'hazid' && can(ctx, 'hazid.read.others'))) return undefined
```

- **function:** `moduleScopeWhere(ctx, _tx, cols)`
- **caller pattern:** `const w = await moduleScopeWhere(...); if (w) conds.push(w)`
- **input:** `ctx`, `cols: { prefix, ownerCols?, siteCol?, personCol? }`
- **current behaviour:** `tier === 'all'` → no filter. Otherwise `site` + `siteCol` →
  `inArray`; `self` → owner/person columns; empty → `sql\`false\`` (line 175).
- **why it bypasses scope:** returns at 165 **before** `mySiteIds` is ever called, so
  `ctx.scopes` is discarded entirely for a `read.all` holder.
- **desired 15B behaviour:** `tier === 'all'` removes the _visibility_ predicate only. The
  Project Scope predicate is ANDed regardless of tier.
- **exact change:** delete the `undefined` return; build `ownConds`; branch on tier for the
  visibility part; AND the resolver predicate. Net effect for a tenant-wide caller: the
  result must be identical to today.
- **affected consumers:** 68 across equipment (22), apps (14), corrective actions (10),
  training (8), inspections/incidents/hazid (5 each), PPE (2), and 7 singletons.
- **tests required:** per-module, `read.all` + scoped caller must be strictly narrower than
  `read.all` + unrestricted; `read.all` + unrestricted must be unchanged.

### S3 — `canSeeRecord` → `true` (45 call sites)

```
visibility.ts:201  if (tier === 'all' || (rec.prefix === 'hazid' && can(ctx, 'hazid.read.others'))) return true
```

- **caller pattern:** `if (!(await canSeeRecord(ctx, tx, rec))) notFound()`
- **current behaviour:** `all` → always true. `site` → record at one of my sites, or mine.
  `self` → mine only. Mirrors S2 for a single loaded record.
- **why it bypasses scope:** identical to S2 — returns before the scope check.
- **desired 15B behaviour:** `all` short-circuits only the _site_ check; a record outside the
  caller's Project Scope must still be refused.
- **exact change:** replace the `return true` with a scope-membership test against the
  resolver output, then fall through to the existing site/owner/self logic.
- **affected consumers:** 45.
- **tests required:** for each site-bearing module, a record id that the list hides must
  404 on the detail page. This is the IDOR test.

### S4 — `resolveEntity` → `filter: undefined` (analytics)

```
scope.ts:374  if (tier === 'all') return { visible: true, filter: undefined }
scope.ts:376  const siteCol = pickColumn(entity, spec.siteCols)     ← never reached for tier 'all'
```

- **function:** `resolveEntity(subject, entity)`; reached via `scopeAnalyticsEntities` (`:410`)
- **callers:** `lib/analytics-access.ts:61` (web) and `apps/worker/src/lib/report-run-as-scope.ts:46` (worker)
- **current behaviour:** `none` → `{visible:false}`. `all` → visible, no filter. `site` +
  a site column → `in` rule; no site ids → `visible:false` (line 383). Otherwise falls back
  to the owner column, then `visible:false`.
- **why it bypasses scope:** line 374 returns before `pickColumn` at 376, so a `siteCols` /
  `personCols` / `userCols` declared on a `tier: 'all'` spec is **dead configuration**. This
  is exactly what Commit 12 had to fix for `report_compliance_status` by moving it from
  `{key}` to `{prefix}`.
- **desired 15B behaviour:** Project Scope ids enter the _subject_, so the `site` branch
  filters by them. The `all` branch still means "no visibility filter", but the subject's
  scope is no longer empty, so downstream compilers can still bound it.
- **exact change:** extend `AnalyticsScopeSubject` with the resolved `orgUnitIds` /
  `personIds`; make `siteIdsFromScopes` a _consumer_ of the resolver rather than the only
  source; make `pickColumn` fall back to person columns when no site column exists (already
  does, at line 390, for the ownership path).
- **affected consumers:** the whole analytics/reports/dashboard surface, plus every
  CSV/PDF/XLSX export that compiles a report.

### S5 — `tierFor` flat key → `'all'` (analytics)

```
scope.ts:327  if ('key' in read) return subject.permissions(read.key) ? 'all' : 'none'
```

- **why it matters:** a flat `{key}` is all-or-nothing, so every entity declared that way has
  permanently-unreachable scope columns. Real instances at HEAD: `ppe_`, `document_`,
  `compliance_` (prefix, superseded by Commit 12's `TABLE_SCOPE` entry for
  `report_compliance_status`), `person_`, `people_`, `customer_`, `job_title`, `role`,
  `insight_`, `safe_distance`, and in `TABLE_SCOPE`: `documents`, `people`,
  `vehicle_log_settings`, `org_units`, `departments`, `crews`, `trades`.
- **desired 15B behaviour:** each of these needs an explicit decision, not a blanket rule —
  see §7D, where "no scope relation" is answered per entity rather than uniformly.

### The `hazid.read.others` branch (S2, S3)

Both `visibility.ts:165` and `:201` also return unrestricted for a `hazid.read.others`
holder. It is deliberately scoped to hazid. Under 15B this must become "no _visibility_
filter", subject to the same Project Scope AND — otherwise a self-tier hazid reader with
`hazid.read.others` becomes tenant-wide under project scope too.

---

## 3. `recordVisibilityWhere`: what `undefined` actually means to its callers

Both call sites use the same shape:

```ts
const vis = await recordVisibilityWhere(ctx, tx, { … })
if (vis) conds.push(vis)
```

- `vis === undefined` → the predicate is **not pushed** → the query has **no visibility
  condition at all**.
- `vis === sql\`false\``→`conds.push(false)` → the query matches nothing.

So **yes: `undefined` is read as "unrestricted / unconditional" by both callers.** Confirmed
from real code, not inferred.

Consequences, both live today:

1. A caller with a `{type:'tenant'}` scope gets an **unfiltered `people` search** through the
   AI assistant's `search_people` tool — an agent-facing tool that enumerates people by
   name, employee number and email.
2. A caller with **no recognised scope** gets `sql\`false\`` and sees nothing, which is the
   fail-closed branch and is correct.

For 15B:

- **Project Scope must be ANDed** after the scope union, not before it, so the union's
  fail-closed property is preserved.
- **If Project Scope resolves to `empty`, the final SQL must become `sql\`false\``** — not
`undefined`, and not a silently dropped condition. A dropped condition is a leak; this is
the single most dangerous edit in 15B because the *existing* code path for `undefined` is
  exactly the leak shape.
- **`unrestricted` must remain reachable only** from `ctx.isSuperAdmin` or a
  `{type:'tenant'}` scope, matching the resolver's own rule. The two implementations must
  agree, and today they only accidentally do.

**Does `recordVisibilityWhere` really need to change?** Yes — but it is the _smallest_ of the
four (2 consumers) and the highest risk per line, because its `undefined` is consumed as
"no filter" rather than as a boolean. It should be changed **first**, with a dedicated
contract test, not last.

---

## 4. `readTierCovers` and the read tiers

```
tenant/index.ts:243  function readTierCovers(permissions, requested)
tenant/index.ts:244    const match = /^(.+)\.read\.(all|site|self)$/.exec(requested)
tenant/index.ts:248    if (tier === 'site') return permissions.has(`${prefix}.read.all`)
tenant/index.ts:249-250 if (tier === 'self') return permissions.has(`.read.all`) || permissions.has(`.read.site`)
```

Its **only** caller is `can()` at `tenant/index.ts:104`. So:

1. **Is a tier only permission widening?** **Yes.** `readTierCovers` exists so `can(ctx,
'x.read.self')` succeeds for someone holding `x.read.all`. It never produces a filter and
   never sees `ctx.scopes`.
2. **Does the tier directly decide the scope filter?** **No.** The filter is decided
   separately by `resolveVisibilityTier` (`visibility.ts:114-118`), which asks `can()` for
   the _exact_ tier and therefore does not use `readTierCovers` at all.
3. **Are all/site/self already mixed with visibility?** **Yes, at the consumer, not in the
   resolver.** `resolveVisibilityTier` returns a `VisibilityTier` from a permission, and
   `moduleScopeWhere` then turns that tier into a SQL predicate — so one value drives both
   "may I" and "which rows". That coupling is the root of the problem: a single bit has to
   mean two things.
4. **Which modules have which tiers?** From `packages/db/src/schema/iam.ts` at HEAD:

| tier family                   | modules                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `all` + `site` + `self`       | `ca`, `hazid`, `incidents`, `inspections`, `journals`, `ppe`, `forms.response` |
| `all` + `site` (no `self`)    | `compliance`, `equipment`                                                      |
| `all` + `self` (no `site`)    | `training`                                                                     |
| **`all` only**                | **`people`**                                                                   |
| **flat key, no tiers at all** | `documents.read`, `reports.read`, `insights.read`, `admin.*`                   |

5. **Entity-specific fallbacks that exist today:**
   - `moduleScopeWhere:167-170` — a `site` holder with **no** `siteCol` falls through to
     own-only, then `sql\`false\`` if that is empty. This is the PPE precedent and it is the
     behaviour 15B should generalise rather than replace.
   - `resolveEntity:389-395` — owner/person column fallback, then `visible:false`.
   - `resolveEntity:383` — a `site` holder with an empty `siteIds` is withheld outright
     rather than falling through. **Note the inconsistency**: `visibility.ts` falls through,
     `scope.ts` withholds. 15B should pick one and say which.

**The regex is closed.** `^(.+)\.read\.(all|site|self)$` will not match a fourth tier, so
adding e.g. `read.org_unit` would silently degrade to a bare `Set.has()` — no widening at
all. **Under D1 this is not needed**: D1 re-purposes `read.all` rather than adding a tier,
which is the lower-risk reading of the same requirement.

---

## 5. Visibility and Project Scope can be ANDed — with three per-entity caveats

**A. How does visibility become a predicate today?** `moduleScopeWhere` returns a drizzle
`SQL | undefined` built from `inArray(siteCol, mySiteIds(ctx))` and/or
`eq(ownerCol, myTenantUserId)` / `eq(personCol, ctx.personId)`, OR-ed, or `sql\`false\``.
`resolveEntity`returns a`ReportRuleGroup` (`{combinator, rules:[{field, op:'in', value}]}`)
instead, because the report compilers take rules, not SQL.

**B. How would Project Scope become a predicate?** The resolver returns
`{kind, orgUnitIds, personIds}`. The mapping is not uniform:

| resolver kind       | visibility.ts (SQL)                                      | analytics (rules)                                                              |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `unrestricted`      | no predicate                                             | no predicate                                                                   |
| `orgUnits`          | `inArray(cols.siteCol, orgUnitIds)`                      | `{field: siteCol, op:'in', value: orgUnitIds}`                                 |
| `persons`           | `inArray(cols.personCol, personIds)`                     | `{field: personCol, op:'in', value: personIds}`                                |
| `peopleAndOrgUnits` | `(site IN … OR person IN …)` — **requires both columns** | one rule per available column, AND-ed                                          |
| `empty`             | `sql\`false\``                                           | `{combinator:'and', rules:[]}` → an always-false group, **or** `visible:false` |

**C. Can they be safely ANDed?** Yes, with one hard requirement per entity: **the AND is
only constructible if the entity has a column the scope can bind to.** Where it does not,
the result must be a deliberate fail-closed, never a dropped term. Concretely, `and(A, undefined)`
is a leak and `and(A, null)` is not expressible — so the caller must never pass
`undefined` for the Project Scope leg.

**D. Entities with no scope relation — answered individually, not uniformly:**

| entity                                                                | scope relation                                         | 15B answer                                                        | rationale                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `people`                                                              | none direct; `people → people_assignments → org_units` | **person-scope via the resolver**                                 | no column needed: `personCol = people.id` against `personIds`                                                |
| `ppe_items`                                                           | none direct; `current_holder_person_id`                | **person-scope**                                                  | `personCol = current_holder_person_id`                                                                       |
| `ppe_issue_reports`                                                   | **none** — only `item_id`                              | **join `item_id → ppe_items`**; never add a `person_id`           | a column here would be a second source of truth that drifts on every transfer                                |
| `training_records` / `_enrollments` / `_skill_assignments`            | `person_id`                                            | **person-scope**                                                  | already has the column                                                                                       |
| `compliance_obligations`                                              | **none**, by design — a cross-module rollup            | **fail closed for a scoped holder**                               | it is not a place-scoped record; a project filter has no meaning. Report the choice explicitly               |
| `compliance_status`                                                   | none direct; `subject_person_id` exists in the view    | **person-scope if the entity exposes it, else fail closed**       | Commit 12 proved the current entity exposes neither a site nor a `person_id` column, so today it is withheld |
| `org_units`, `departments`, `crews`, `trades`, `vehicle_log_settings` | structural master data                                 | **tenant-wide, permission-only**                                  | these _are_ the scope structure; filtering them by scope is circular                                         |
| `role_`, `tenant_`, `notification`, `audit`, `api_`, `ai_`, `kiosk`   | —                                                      | **withheld (`read: null`)** — leave alone                         | already fail-closed                                                                                          |
| `insight_`                                                            | n/a — card _definitions_                               | **permission-only**                                               | definitions are not tenant data rows                                                                         |
| public API entities                                                   | n/a                                                    | **tenant-wide, permission-only** — and say so in the OpenAPI spec | `api_keys` has no scope column; making it scoped needs a migration                                           |

---

## 6. Entity integration matrix

`read.all bypass` = does a `read.all` holder currently see every row?
`15B predicate` = the leg the Project Scope AND must add.

| Entity                       | permission                                  | visibility entry                          | scope relation                              | `read.all` bypass                 | `read.site`           | `read.self` | 15B predicate                                   | no-assignment result                   | difficulty                         | tests                             |
| ---------------------------- | ------------------------------------------- | ----------------------------------------- | ------------------------------------------- | --------------------------------- | --------------------- | ----------- | ----------------------------------------------- | -------------------------------------- | ---------------------------------- | --------------------------------- |
| `people`                     | `people.read.all` (only tier)               | page gate (Commit 12), **not** the ladder | `people_assignments → org_units`            | **yes** (page is permission-only) | n/a                   | n/a         | `inArray(people.id, personIds)`                 | `empty` → 0 rows                       | **S** — highest value, highest PII | R1 contract + browser             |
| `people_assignments`         | —                                           | —                                         | **is** the scope source                     | n/a                               | n/a                   | n/a         | never a filterable entity                       | n/a                                    | —                                  | F1 (not filterable)               |
| `ppe_items`                  | `ppe.read.{all,site,self}`                  | `moduleScopeWhere` ×2                     | `current_holder_person_id`                  | yes                               | falls back to holder  | holder      | `inArray(current_holder_person_id, personIds)`  | `empty` → empty register (fail-closed) | **M**                              | PPE contract (31 tests) + browser |
| `ppe_issue_reports`          | `ppe.issue`                                 | none                                      | **none** (join)                             | n/a                               | n/a                   | n/a         | join via `item_id`                              | refuse the action                      | **M**                              | R5 action test                    |
| `ppe_inspections`            | `ppe.read.*`                                | `moduleScopeWhere`                        | `site_org_unit_id` + `supervisor_person_id` | yes                               | `inArray(site)`       | supervisor  | `inArray(site_org_unit_id, orgUnitIds)`         | `empty`                                | **L** — direct                     | PPE suite                         |
| `equipment_items`            | `equipment.read.{all,site}`                 | `moduleScopeWhere` ×22                    | `current_site_org_unit_id`                  | yes                               | `inArray(site)`       | owner       | `inArray(current_site_org_unit_id, orgUnitIds)` | `empty`                                | **L**                              | equipment suites                  |
| vehicle log                  | `equipment.read.site` (Commit 4)            | `moduleScopeWhere`                        | parent vehicle's site                       | yes                               | parent site           | —           | same, on `equipment_items`                      | `empty`                                | **L**                              | Commit 4 suite                    |
| `training_records`           | `training.read.{all,self}` (**no `.site`**) | `moduleScopeWhere` ×8                     | `person_id`                                 | yes                               | **no `.site` exists** | `person_id` | `inArray(person_id, personIds)`                 | `empty`                                | **M**                              | training suites                   |
| `training_enrollments`       | `training.read.*`                           | `moduleScopeWhere`                        | `person_id`                                 | yes                               | —                     | `person_id` | `inArray(person_id, personIds)`                 | `empty`                                | **M**                              | training suites                   |
| `training_skill_assignments` | `training.read.*`                           | —                                         | `person_id`                                 | yes                               | —                     | `person_id` | `inArray(person_id, personIds)`                 | `empty`                                | **M**                              | training suites                   |
| `compliance_obligations`     | `compliance.read` (flat)                    | `resolveEntity`                           | **none**                                    | yes                               | n/a                   | n/a         | **fail closed** for a scoped holder             | withheld                               | **M** + a product decision         | compliance suites                 |
| `compliance_status`          | `compliance.read.{all,site}`                | `resolveEntity`                           | view exposes no scope column                | yes                               | **withheld**          | n/a         | withheld (already)                              | withheld                               | **L** — already correct            | Commit 12 suite                   |
| `report_*` views             | inherits the source module's tier           | `resolveEntity`                           | source-dependent                            | yes                               | per source            | per source  | pass resolved ids in the subject                | `visible:false`                        | **L**                              | Commit 6/12 suites                |
| `analytics` (BHQL)           | per entity                                  | `resolveEntity`                           | per entity                                  | yes                               | per entity            | per entity  | extend `AnalyticsScopeSubject`                  | `visible:false`                        | **M**                              | analytics suites + **cache test** |
| `dashboard`                  | `dashboards.read`                           | `moduleScopeWhere` ×1                     | per card                                    | yes                               | per card              | per card    | per card                                        | card empty                             | **M**                              | dashboard + insights suites       |
| assistant `search_people`    | `people.read.*`                             | `recordVisibilityWhere`                   | `personCol: people.id`                      | **yes** for `{type:'tenant'}`     | n/a                   | n/a         | `inArray(people.id, personIds)`                 | `sql\`false\``                         | **S**                              | new — no test exists today        |
| public API                   | key permission                              | **none**                                  | n/a                                         | yes                               | n/a                   | n/a         | none in 15B                                     | n/a                                    | **out of scope**                   | needs a migration                 |

Difficulty: **L** direct column, **M** person-scope or indirect, **S** semantic change.

---

## 7. 15B minimal change surface

The brief asked not to say "change 86 consumers". The real answer splits three ways.

### A. Fixable inside `visibility.ts` alone (no consumer edits)

- **S2** `moduleScopeWhere`: replace the `undefined` return with a visibility-only branch,
  then AND the Project Scope leg. Consumers keep `if (w) conds.push(w)` — the predicate is
  now always defined for a non-unrestricted caller.
- **S3** `canSeeRecord`: same, for the single-record guard.
- **S1** `recordVisibilityWhere`: AND after the union; `undefined` only for super-admin /
  `{type:'tenant'}` with no narrowing.

All 115 call sites (`moduleScopeWhere` 68 + `canSeeRecord` 45 + `recordVisibilityWhere` 2)
then inherit the change **without edits**, because they already treat a returned predicate as
"add this" and `undefined` as "add nothing".

**One consumer class breaks:** any caller that branches on `undefined` to decide something
other than "no filter". That must be found by search before the change, not after.

### B. Requires the analytics resolver

- **S4/S5** `analytics/scope.ts`: extend `AnalyticsScopeSubject` with the resolved
  `orgUnitIds` / `personIds`; move the scope source from `siteIdsFromScopes` to the
  resolver; keep `visible:false` as the fail-closed answer.
- `analytics-access.ts` (`analyticsScopeFingerprint`) **must** gain the resolved scope, or
  the insights cache becomes scope-blind — see §8.
- `report-run-as-scope.ts` (worker) needs the same subject extension, or worker-generated
  reports keep the old semantics.

### C. Requires entity config

- Each flat-key spec in `PREFIX_SCOPE` / `TABLE_SCOPE` needs an individual decision
  (§5D). No blanket rule.
- `ppe_`, `person_`, `people_`, `customer_`, `job_title` declare `siteCols`/`personCols`
  that are unreachable today; either they become reachable (needs a `prefix`) or the dead
  declarations are deleted. Leaving them is misleading.

### D. Requires consumer edits

Only where the entity has **no** column to bind:

- `ppe_issue_reports` (R5) — a join in the action, not a filter in the ladder.
- The AI assistant's two `recordVisibilityWhere` callers — only if the AND needs a column
  they do not declare (`_commit-actions.ts` declares `siteCol`, so it is fine).
- Any export route that must converge (10 of 14 today).

### E. Cannot be done in 15B

- **Public API scoping** — `api_keys` has no scope column; needs a migration.
- **`read.org_unit` as a new tier** — `readTierCovers`' regex is closed. Not needed under D1.
- **Write-scope for actions** (R5/R6/R8) — the ladder is read-only; actions need their own
  assertions.
- **The 10 permission-only export routes** — converge first, or every module needs an
  exemption.

---

## 8. Cache analysis — one concrete, named risk

**No Redis, no `unstable_cache`, no KV** in the analytics/dashboard/reports path. `insight_cards`
is a **definition** table (AST), not a result cache; results are computed per request.

There is exactly **one** process-level result cache in the authorization path:

```ts
// apps/web/src/app/(app)/insights/_data.ts:35
const CARD_RESULT_CACHE = new Map<string, { at: number; result: BhqlResult }>()
const CARD_RESULT_TTL_MS = 60_000
// key at :53
const cacheKey = `${ctx.tenantId}:${access.scopeKey}:${trustScope}:${key}`
```

`scopeKey` = `analyticsAccessScopeKey({ activeRoleId, effectiveRoleKeys, templateIds,
rowScope })` where

```ts
// analytics/scope.ts:435
analyticsScopeFingerprint = JSON.stringify({ super, sites: [...siteIds].sort(), person, user })
// and `sites` comes from siteIdsFromScopes(ctx.scopes) — i.e. ONLY {type:'sites'}
```

The source comment already states the scope in the key is "load-bearing, not an optimisation".

**Verdict, precisely:**

- **Cross-user collision: not possible today.** `user` is `ctx.membership.id`, unique per
  membership, so two users never share a fingerprint. The design is correct as written.
- **Cross-user collision after Project Scope: still not possible**, for the same reason —
  **provided** the fingerprint keeps `user`.
- **Staleness after a scope change: REAL, and 15B makes it worse.** The fingerprint has no
  project-scope component. Once scope derives from `people_assignments`, a user who is
  **removed from a project** keeps the same `{super, sites, person, user}` fingerprint and
  therefore keeps being served the previous project's card rows for up to **60 seconds**.
  Today the same class of staleness exists when an admin edits a `sites` scope, so this is
  an amplification, not a new bug class — but 60 s of a revoked project is a security
  regression, not a UX annoyance.
- **Required change:** `analyticsScopeFingerprint` must include the resolver's resolved
  `orgUnitIds` and `personIds`. Cheap, and it makes the key correct by construction.
- **Two smaller caches**, neither a result cache but both worth a look in 15B:
  `lib/assistant/document-content.ts:48` caches **PDF text extraction** keyed by a storage
  key; the caller must authorize before returning, and that gate is not in the cache key.
  `vehicle-log/_workspace.client.tsx:154` `vehicleLogScopeKey` is a **client-side** reseed
  key for form state, not data.

---

## 9. Security regression matrix (analysis only)

| #   | risk                               | present today?                                      | after 15B if done carelessly                                                                          | required guard                                                                                             |
| --- | ---------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | `empty` → `unrestricted`           | no (no resolver yet)                                | **yes** — if a consumer maps an empty scope to "no filter"                                            | the `[]` ≠ `undefined` contract; a dedicated consumer test                                                 |
| 2   | missing scope → tenant-wide        | **yes** for S1 with `{type:'tenant'}`               | same                                                                                                  | restrict `undefined` to super-admin / tenant scope                                                         |
| 3   | `read.all` bypasses scope          | **yes** (S2/S3/S4)                                  | unchanged unless the `undefined` is removed                                                           | remove all three returns                                                                                   |
| 4   | `read.site` bypasses scope         | no today                                            | possible if the AND is applied only on the `all` branch                                               | apply the AND on **every** branch                                                                          |
| 5   | `self` widened to a person set     | no                                                  | **yes** — `self` currently means "own records"; person-scope must not become "everyone in my project" | keep `self` as an OR-term with own rows, not a replacement                                                 |
| 6   | `requestedOrgUnitIds` widening     | no                                                  | yes if implemented as a union                                                                         | intersect only (the resolver already does)                                                                 |
| 7   | tenant mismatch                    | handled (`tenant_mismatch`)                         | must not be re-opened by a consumer retry without scope                                               | keep the check before any query                                                                            |
| 8   | `tenant_admin` leak                | no (D2 = explicit tenant scope)                     | yes if someone adds a role-name bypass                                                                | no role names in the resolver; a test that a `tenant_admin`-named role with no scope is _not_ unrestricted |
| 9   | super-admin semantics              | fine                                                | fine — but `isSuperAdmin` also short-circuits `can()`, so it bypasses the ladder entirely             | keep it as the single explicit escape                                                                      |
| 10  | report/export divergence           | **yes** — 10 of 14 exports are tenant-wide          | worse, if modules go live before exports converge                                                     | converge exports **before** module adoption (design S3)                                                    |
| 11  | dashboard aggregate leak           | **yes** for the 60 s cache window on a scope change | worse once scope is assignment-derived                                                                | extend the fingerprint (§8)                                                                                |
| 12  | cached result reused across scopes | no (key includes `user`)                            | only via staleness                                                                                    | extend the fingerprint                                                                                     |
| 13  | public API ≠ UI                    | **yes** — API is permission-only, tenant-wide       | unchanged; must be documented                                                                         | a spec note + a "current stated behaviour" test                                                            |
| 14  | worker/run-as ≠ UI                 | no — both use `resolveEntity`                       | yes if only the web subject is extended                                                               | extend `report-run-as-scope.ts` in the same change                                                         |

---

## 10. Implementation phases — re-derived from real dependencies

The design's S0–S8 order holds, with three corrections this audit forces.

### 15B-1 — this audit (no code)

### 15B-2 — core semantics, `visibility.ts` only

- **files:** `apps/web/src/lib/visibility.ts`; a new
  `apps/web/src/lib/visibility-scope-bridge.ts`; its contract test
- **risk: highest in the whole programme.** `undefined` is consumed as "no filter" by 115
  call sites. Mitigation: land the bridge and the tests **before** touching the four returns;
  prove `read.all` + unrestricted is byte-identical.
- **tests:** per-module, `read.all`+scoped is strictly narrower than `read.all`+unrestricted;
  `empty` → `sql\`false\``; the IDOR test (hidden list row 404s on detail); the assistant
`search_people` test (none exists today).
- **migration:** 0. **compatibility:** a tenant-wide caller must see no change at all.
- **start with `recordVisibilityWhere`**, not `moduleScopeWhere` — 2 consumers, and it proves
  the pattern before it is replicated 68 times.

### 15B-3 — analytics, reports, dashboard, and the cache

- **files:** `packages/analytics/src/server/scope.ts`, `apps/web/src/lib/analytics-access.ts`
  (+ the fingerprint), `apps/worker/src/lib/report-run-as-scope.ts`
- **why inseparable from 15B-2:** a scope-correct module page with a scope-blind card cache
  is still a leak; and the worker needs the same subject or generated reports diverge.
- **risk:** medium-high — `resolveEntity` gates _withholding_, so a mistake removes data
  rather than leaking it (fail-closed by construction). The cache fingerprint is the one
  genuine leak surface.
- **tests:** the analytics suites; a new **cache-key test** asserting two users whose
  resolved project scopes differ get different cache keys, and that removing an assignment
  changes the key.
- **migration:** 0. **compatibility:** exports and worker reports change scope — intended.

### 15B-4 — entity config decisions

- **files:** `PREFIX_SCOPE` / `TABLE_SCOPE` in `scope.ts`; `ppe_` / `person_` / `people_` /
  `customer_` / `job_title` specs
- **risk:** low technically, high in product terms — each flat key is a decision about
  whether a rollup may be project-scoped at all.
- **tests:** per-entity, a scoped holder's row set.
- **migration:** 0.

### 15B-5 — consumers that cannot be fixed centrally

- `ppe_issue_reports` (R5 join), the assistant actions, and the **export routes** (R6/R8 need
  the picker and the register).
- **Hard ordering:** exports converge **before** any module goes live, or every module needs
  a temporary tenant-wide exemption — which is exactly the divergence the work exists to
  remove.

### Still out of scope

Public API scoping (needs a migration); `read.org_unit` (the `readTierCovers` regex is
closed, and D1 does not need it); write-scope for actions; kiosks.

---

## 11. Test matrix for 15B (design only)

### Roles × scopes × tiers

| role           | scope fixture                                           | tiers exercised               |
| -------------- | ------------------------------------------------------- | ----------------------------- |
| super-admin    | unrestricted                                            | all three (must be unchanged) |
| tenant_admin   | `{type:'tenant'}`                                       | all three (must be unchanged) |
| safety_manager | project A / project B / none                            | all, site                     |
| foreman        | site A / site B / none                                  | all, site, self               |
| worker         | none / one assignment                                   | self                          |
| viewer         | none                                                    | self (deny)                   |
| any            | 0 / 1 / 2 concurrent / historical / expired assignments | —                             |

### Per entity

`people`, `ppe_items`, `ppe_inspections`, `equipment_items`, vehicle log,
`training_records`, `compliance_obligations`, `report_*`, analytics card, dashboard,
assistant `search_people`.

### Per level

| level   | what it must prove                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------- |
| unit    | tier resolution, `readTierCovers` widening, the `[]` ≠ `undefined` contract, `pickColumn` fallbacks, fingerprint shape |
| DB      | the resolver against real rows (the 22-check script from 15A, re-run)                                                  |
| route   | list and detail agree; a hidden list row 404s; `?tab=`/`?drawer=` do not widen                                         |
| action  | R5 refused for an out-of-scope target; an impersonated admin uses the target's scope                                   |
| export  | every export returns exactly its page's row set; 403 not 500                                                           |
| worker  | a foreman's scheduled report contains only their project; run-as uses the target's scope                               |
| browser | §12                                                                                                                    |

**Cross-cutting assertions, every level:** no-assignment → 0 rows (never all rows);
`read.all` + scoped strictly narrower than `read.all` + unrestricted; a cross-tenant id
yields nothing; expired assignment contributes nothing.

---

## 12. Browser verification plan (design only — Chromium unavailable)

Chromium on this host is a snap that refuses to run
(`/user.slice/user-1000.slice/session-29.scope is not a snap cgroup for tag
snap.chromium.chromium`), so nothing was verified in a browser and the environment was not
modified.

| identity           | fixtures                     | surfaces                                              |
| ------------------ | ---------------------------- | ----------------------------------------------------- |
| project A user     | assignment → project A       | nav, list, detail, export, dashboard card             |
| project B user     | assignment → project B       | same, and **zero** project-A rows anywhere            |
| no-assignment user | person row, zero assignments | empty everywhere **with a reason**, never a full list |
| tenant_admin       | `{type:'tenant'}`            | whole tenant; unchanged from today                    |
| super-admin        | —                            | whole tenant; unchanged from today                    |

Assertions must be **HTTP status + absence of specific PII** (name, employee number, email),
never "the page looked right". Two captures per identity are required: the row set **and**
the export, because exports are the known divergence.

---

## 13. Unresolved decisions

D1 and D2 are settled for 15B per the brief and are implementable — no architectural conflict
found. These remain open:

| #       | decision                                                                                                                                                                                     | why it blocks                                                                  | blocking       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------- |
| **D3**  | with no effective assignment, may a caller see their own row?                                                                                                                                | the difference between an empty roster and a broken-looking one                | 15B-2 `people` |
| **D4**  | is a former colleague (ended assignment) reachable, under what permission?                                                                                                                   | history is currently invisible; "no" is defensible but must be stated          | 15B-2          |
| **D5**  | may an org unit belong to two projects?                                                                                                                                                      | the tree says **no**; if the business says yes the org model must change first | 15B-2          |
| **D6**  | does Project Scope gate **write** capabilities?                                                                                                                                              | R5 needs it; the ladder is read-only                                           | 15B-5          |
| **D7**  | is the public API in scope?                                                                                                                                                                  | in scope ⇒ `api_keys` needs a scope column ⇒ **1 migration**                   | later          |
| **D8**  | may the 10 permission-only exports stay tenant-wide meanwhile?                                                                                                                               | if yes, UI and CSV disagree                                                    | 15B-5          |
| **D9**  | who may assign a person to a project — `admin.org.manage` or a new key?                                                                                                                      | Commit 13 used the former                                                      | data           |
| **D10** | on assignment, grant the site, or the site **and** its project?                                                                                                                              | changes the `ancestorOrgUnitIds` walk                                          | 15B-2          |
| **D11** | **NEW** — `compliance_obligations` has no scope relation. Is a project-scoped holder allowed to see obligations at all, or only their own?                                                   | the flat key currently makes it tenant-wide                                    | 15B-4          |
| **D12** | **NEW** — `training` has no `read.site` tier (only `all` + `self`). Project-scoping training therefore relies on the person leg only. Is that intended, or is a `training.read.site` wanted? | affects whether a foreman can see course records for their site                | 15B-2          |

---

## 14. Corrections to the previous audit's assumptions

| previous claim                                          | reality at HEAD                                                                                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "86 files use the ladder, all affected"                 | true in aggregate, but they split **68** `moduleScopeWhere` + **45** `canSeeRecord` + **2** `recordVisibilityWhere`. The S1 blast radius is 2, not 86 — and it is the _riskiest_ 2                            |
| "`recordVisibilityWhere` short-circuit is a fifth site" | **confirmed, and worse than described**: both callers do `if (vis) conds.push(vis)`, so `undefined` is definitively "no filter". One is the AI assistant's `search_people`, an agent-facing people enumerator |
| `visibility.ts:165` / `:201`                            | exact at HEAD                                                                                                                                                                                                 |
| `scope.ts:327` / `:374`                                 | exact at HEAD; `pickColumn` is first reached at **376**                                                                                                                                                       |
| "tenant_admin uses `read.all`"                          | it holds the whole catalogue, but its breadth should come from an explicit `{type:'tenant'}` scope (D2) — and `recordVisibilityWhere` already keys off that scope, not off permissions                        |
| "insight cards are cached"                              | the **definitions** are a table; only **results** are cached, in one process-level `Map` with a 60 s TTL, keyed on a fingerprint that has no project-scope component                                          |
| `apps/web/src/lib/iam.ts`                               | **does not exist.** The permission catalogue is `packages/db/src/schema/iam.ts`; `can()` and `readTierCovers` are in `packages/tenant/src/index.ts`                                                           |
