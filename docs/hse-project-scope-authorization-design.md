# BeaconHS — Project Scope & `read.all` Authorization Design

**Status:** design only. Nothing in this document is implemented.
**Audit basis:** live code and live schema at `4777b2f9`, verified against the running
Postgres instance. No document claim below is inherited from earlier design notes without
re-verification; where an earlier note was wrong, that is stated.

**Scope of this document.** The authorization contract for Project Scope, and the
`read.all` short-circuit that currently makes scope-bearing permission tiers mean
"unrestricted tenant-wide". It defines semantics and a resolver contract. It creates no
permission key, no table, no migration, and changes no resolver.

---

## 1. Current authorization model

There is one permission system (`PERMISSION_CATALOGUE` + `role_assignments`) and one
visibility ladder (`apps/web/src/lib/visibility.ts`, 86 consuming files). The pipeline is:

```
permission key  →  read tier  →  visibility ladder  →  SQL predicate  →  query
                      │
                      └── ctx.scopes (RoleScope[])  ← the *other* input
```

The ladder has **three** entry points in `visibility.ts` and **one** in the analytics
package. All four collapse on `tier === 'all'`:

| #   | entry point                 | file:line                                    | tier `all` behaviour                                                                                        |
| --- | --------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `recordVisibilityWhere`     | `visibility.ts:46`                           | `ctx.isSuperAdmin` → `return undefined` (line 51); a `{type:'tenant'}` scope → `return undefined` (line 53) |
| 2   | `moduleScopeWhere`          | `visibility.ts:157`                          | `if (tier === 'all' …) return undefined` (line 165)                                                         |
| 3   | `canSeeRecord`              | `visibility.ts:194`                          | `if (tier === 'all' …) return true` (line 201)                                                              |
| 4   | `resolveEntity` (analytics) | `packages/analytics/src/server/scope.ts:368` | `if (tier === 'all') return { visible: true, filter: undefined }` (line 374)                                |

Tier resolution itself:

- `visibility.ts:114-118` — `resolveVisibilityTier`: super-admin or `<prefix>.read.all` →
  `'all'`; else `.read.site` → `'site'`; **else `'self'`** (a safe default, never `'none'`).
- `scope.ts:325-333` — `tierFor`: super-admin → `'all'`; a **flat key** (`{key}`) → `'all'`
  or `'none'` only; a `prefix` → `.read.all` / `.read.site` / `.read.self` / `'none'`.

Scope input:

- `ctx.scopes: RoleScope[]` — six variants (`iam.ts:49-55`): `tenant`, `sites`, `team`,
  `people`, `crews`, `self`. **None is project/org-unit.**
- `mySiteIds(ctx)` (`visibility.ts:121`) reads **only** `{type:'sites'}`.
- `siteIdsFromScopes` (`scope.ts:308`) likewise.

### Which step short-circuits

Two independent inputs — permission tier and `ctx.scopes` — are combined by a rule that
discards the second one when the first is maximal:

- `resolveVisibilityTier` never reads `ctx.scopes`.
- `moduleScopeWhere` / `canSeeRecord` return _before_ `ownPredicates` and before
  `mySiteIds` is consulted.
- `resolveEntity` returns at line 374 **before** the first `pickColumn` at line 376, which is why a
  flat-keyed entity's declared `siteCols` / `personCols` / `userCols` were unreachable
  (this is what Commit 12 fixed for `report_compliance_status` by moving it to a `prefix`).
- `recordVisibilityWhere` is the one entry point that _does_ union scopes — but it bypasses
  permissions entirely and inverts the dependency: scope grants visibility regardless of tier
  (`:51`, `:53`).

**Consequence:** for every module that uses entry points 2, 3 or 4, a caller holding
`<prefix>.read.all` sees every row in the tenant, whatever their `ctx.scopes` say. For every
module that uses entry point 1, a caller holding `{type:'tenant'}` sees every row in the
tenant, whatever their permissions say.

### Module coverage (86 files)

| area                                                           | consuming files |
| -------------------------------------------------------------- | --------------- |
| equipment (+ vehicle log)                                      | 22              |
| apps (builder)                                                 | 14              |
| corrective actions                                             | 10              |
| training                                                       | 8               |
| inspections                                                    | 5               |
| incidents                                                      | 5               |
| hazard assessments                                             | 5               |
| PPE                                                            | 2               |
| people, locations, journals, feed, dashboard, assistant, admin | 1 each          |

### Paths that do NOT use the ladder

| path                          | authorization                                                                                                                          | row scope                                                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **public REST API `/api/v1`** | `keyHasPermission` + `readPermissionForEntity` (`api/v1/[entity]/route.ts:28`)                                                         | **none** — `readEntityRows` filters `deletedAt` and RLS only. `api_keys` has **no scope column** (`id, tenant_id, name, key_hash, prefix, permissions, created_by, last_used_at, expires_at, revoked_at, created_at, updated_at, builder_template_ids`) |
| **worker report run-as**      | `scopeAnalyticsEntities` + `siteIdsFromScopes` (`report-run-as-scope.ts:29,46`)                                                        | analytics ladder only                                                                                                                                                                                                                                   |
| **export routes**             | 4 of 14 use the ladder (`equipment`, `apps/responses`, `incidents`, `inspections`, `corrective-actions`); 10 gate on a permission only | divergent                                                                                                                                                                                                                                               |

Export routes without the ladder: `documents` (`documents.manage`), `equipment/vehicle-log`
(`equipment.read.all`), `journals` (`journals.read.self`), `locations` (`admin.org.manage`),
`people` (`admin.users.manage`), `ppe` (`ppe.read.all`), `reports/definitions/[id]`
(`reports.read`), `training/courses` (`training.read.all`). Two more were checked and are
**not** findings: `insights/cards/[id]/export` gates via `canViewInsights(ctx)` → 403, and
`tools/safe-distance/export` is a static reference table with no tenant data.

**All ten are permission-gated, so none is an authorization hole today. But they are
tenant-wide, which is exactly the divergence Project Scope would widen.**

---

## 2. Current `read.all` short-circuit

### A. Is `read.all` always tenant-wide today?

**Yes, for the three ladder entry points that read a tier.** `read.all` (or super-admin, or
`hazid.read.others`) yields `undefined` / `true` / `filter: undefined`, and RLS bounds only to
the tenant. So `read.all` ≡ _tenant-wide_ today.

**Not always, in two respects worth recording:**

- A **flat key** (`{key: 'x'}`) is not a tier at all; it is an all-or-nothing grant
  (`scope.ts:327`). Several entities still use it. `compliance.read` was one; Commit 12 gave
  it a tier family.
- `people.read.all` was added in Commit 12 and **deliberately** means tenant-wide today,
  because `people` has no location column. The people page gate is permission-only.
- `recordVisibilityWhere` grants tenant-wide on `{type:'tenant'}` scope **regardless of tier**.

### B. Should `read.all` change meaning under Project Scope?

Two defensible candidate semantics:

- **B1 — re-purpose:** `read.all` = "all rows _within_ the caller's authorized scope". Reads
  naturally as "the whole module", stops implying tenant-wide, and makes
  `people.read.all` + project scope mean "the roster of my project".
- **B2 — keep `read.all` = tenant-wide, add a separate scope axis** that only applies to
  `read.site`/`.self` holders. Preserves every existing behaviour exactly; but leaves the
  dangerous reading ("`.all` means the whole tenant") permanently available to the next
  engineer, and gives project-scoped users no way to obtain module-wide read within their
  project.

B1 is the semantics this document recommends, for a specific reason rather than taste: today
the only way to express "I can read all of module X" and "I can only see project Y" is to
pick one, because the two are the same bit. The feature request — _a safety manager who can
read all of compliance, but only within their project_ — is inexpressible under B2 without a
new permission key, which is out of scope.

**Compatibility cost of B1 is real and must be stated:** it changes the meaning of a
permission that 6 role baselines already hold. It is a semantic change, not a refactor.

### C. Is a genuinely tenant-wide capability still needed?

Yes. Three needs exist today and would otherwise be lost under B1:

1. **Super-admin** across tenants — already orthogonal (`ctx.isSuperAdmin`, checked first in
   every entry point). Unaffected.
2. **Tenant-wide compliance/legal discovery** — "show me every obligation in the company,
   including other projects" is a legitimate need for a HSE manager preparing an audit.
3. **Migration and backfill** — needs the whole tenant regardless of assignments.

Candidate carriers, in preference order, **none of which is created by this document**:

- the existing `{type:'tenant'}` scope, which `recordVisibilityWhere` already honours — this
  is the least-surprising carrier because it is the existing vocabulary for exactly this;
- super-admin;
- a future, explicitly-named key — only if the business cannot express the need with
  `{type:'tenant'}`.

---

## 3. Project Scope authorization contract

Two candidate models were compared. Neither is ranked; the trade-offs are stated.

### Model A — permission tier and data scope fully bound

`read.all` ≡ tenant-wide; `read.site` ≡ assigned sites; `read.self` ≡ own. Project scope is
folded into `read.site`'s site-id list (a project expands to its descendant sites).

- **Pros:** no semantic change to any existing permission. Smallest possible diff —
  `mySiteIds()` is the single place to extend. Existing 86 files keep working unchanged.
  `read.all` keeps its literal meaning, so no downstream surprise.
- **Risks:**
  - Cannot express "read all of compliance, within my project" (§2B) — the exact case the
    work is for. A project-scoped manager must take `read.site`, which also scopes _every_
    other module they hold.
  - Project expansion bakes into "site ids", so a site moving between projects silently
    changes the caller's scope with no visible cause.
  - Cannot express "all of compliance in project A, some of incidents in project B".
  - Conflates two genuinely different questions: _which module may I read?_ and _which
    places may I read?_
- **Migration:** 0. **Code impact:** 1 function (`mySiteIds`) + `siteIdsFromScopes`.
- **Compatibility:** perfect for existing behaviour; blocks the target use case.

### Model B — permission tier orthogonal to project scope

```
Authorization = Permission (may I read this module?)
              × Visibility (all | site | self — how do I rank records?)
              × Project Scope (which org units / projects may I see?)
```

With re-purposed `read.all` (B1): the predicate becomes the **intersection** of the
visibility predicate and the project-scope predicate, with project scope always applied as an
`AND`. `read.all` removes the visibility predicate but **not** the scope predicate.

- **Pros:** expresses every role in the brief. `read.all` + project scope = module-wide read
  inside the project (B1). Keeps "which module" and "which places" separable, so a manager
  can be module-wide in compliance and site-restricted in incidents. Makes the security
  property "scope is never removed by a permission" structurally true instead of a code
  convention. `people` and `ppe_items` become scopeable through people→assignments without a
  location column, because scope becomes a set of _person_ ids too.
- **Risks:**
  - Changes the meaning of `read.all` for 6 role baselines. Every module that returns
    `undefined` on tier `all` must be re-examined, and the ladder's default-to-`undefined`
    is a fail-_open_ pattern that must become fail-closed-by-construction.
  - Two axes mean two places to get it wrong. Mitigation: one resolver, one output shape
    (§5), and the axis order fixed in one function.
  - "No scope" must be distinguishable from "no permission", or the UI cannot tell a user
    why they see nothing. Requires an explicit `empty` reason in the resolver output.
  - Every one of the 86 consumers needs a scope predicate even when its tier is `all`;
    a missed consumer is a silent leak. Mitigation: a contract test that fails if a
    scope-bearing module is added without a resolver binding.
- **Migration:** 0 for both the resolver and the tier. **Code impact:** the ladder internals
  plus 86 call sites (mechanical, and the existing 31-test scope contract files give the
  scaffolding).
- **Compatibility:** breaking in _meaning_, not in shape. Requires a documented cutover note
  and a re-audit of the 10 permission-only export routes and the public API (§11).

### Which model the brief's role matrix requires

| requirement                                     | Model A                                      | Model B                                   |
| ----------------------------------------------- | -------------------------------------------- | ----------------------------------------- |
| tenant_admin tenant-wide                        | `{type:'tenant'}`                            | `{type:'tenant'}`                         |
| safety_manager project-scoped                   | `read.site` everywhere                       | `read.all` + project scope                |
| foreman project/site-scoped                     | `read.site`                                  | `read.site` + project scope               |
| worker self-scoped                              | `read.self`                                  | `read.self` + project scope               |
| viewer read-only                                | no read tier                                 | no read tier                              |
| `people.read.all` must not bypass project scope | ✗ impossible                                 | ✓                                         |
| PPE issue target within operable scope          | partial (needs a site column on `ppe_items`) | ✓ via person scope                        |
| reports / export / public API share semantics   | ✗ already divergent                          | requires closing the export/API gap first |

**Model A satisfies five of eight; Model B satisfies all eight.** Model B is therefore the
only one that can deliver the stated goal. Model A is not wrong — it is the correct _fallback_
if the business decides project-scoped users must not hold module-wide read.

---

## 4. Permission vs Visibility vs Scope

| axis              | question                                  | vocabulary today                                               | contract under Model B                                                                           |
| ----------------- | ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Permission**    | may I invoke this capability at all?      | `PERMISSION_CATALOGUE`, wildcards, `assertCan`                 | unchanged. A gate, never a filter.                                                               |
| **Visibility**    | how do records rank?                      | `all` / `site` / `self` from `<prefix>.read.*`                 | `all` → no visibility predicate; `site` → assigned sites ∪ own; `self` → own only. Never widens. |
| **Scope**         | which places/people may I see?            | `ctx.scopes` (`tenant`/`sites`/`team`/`people`/`crews`/`self`) | **always** applied as an `AND`. Never removed by a permission.                                   |
| **Project Scope** | which projects do those places belong to? | **does not exist**                                             | derived from `people_assignments` + `org_units` ancestry, resolved once per request              |

**The rule that fixes the bug:** visibility may _narrow_, scope may only _narrow_, and
neither may be discarded by the other. Today that rule is violated in both directions
(entry points 2–4 discard scope; entry point 1 discards permission).

---

## 5. Canonical scope resolver contract

**There must be exactly one.** It is a new function, not a second ladder: it produces the
_scope_ input, which the existing four entry points then consume. The ladder keeps deciding
visibility; the resolver decides places. Both are ANDed.

### Input

```ts
type ScopeResolverInput = {
  tenantId: string // always from the request context, never from input
  personIds: readonly string[] // the caller's person rows (0..n, no primary flag exists)
  orgUnitIds: readonly string[] // requested org units, if the caller asked for a subset
  onDate: IsoDate // effective date, default today (UTC)
  excludeDeleted: boolean // soft-deleted org units are never in scope
}
```

Permission and tier are **not** inputs. The resolver is permission-agnostic: it answers
"where may this person be", never "may this person look". Mixing them is how the current
ladder ended up with a `read.all` that deletes a scope.

### Output

```ts
type ResolvedScope =
  | { kind: 'unrestricted' } // {type:'tenant'} scope or super-admin
  | { kind: 'orgUnits'; orgUnitIds: string[] } // includes project + descendant site ids
  | { kind: 'persons'; personIds: string[] } // for entities with only a person column
  | { kind: 'peopleAndOrgUnits'; personIds: string[]; orgUnitIds: string[] }
  | { kind: 'empty'; reason: 'no-assignment' | 'no-scope' | 'all-targets-deleted' }
```

`kind: 'empty'` is a **distinct, non-error** state. It is what lets a UI say "you have no
project assigned" instead of rendering an empty list that looks like missing data. It is
never equivalent to "unrestricted".

### Resolution steps

1. Super-admin, or a `{type:'tenant'}` scope → `unrestricted`. Both are already
   tenant/company-wide by intent and are checked **first**, explicitly.
2. Otherwise read `people_assignments` for the caller's person ids, filtered by
   `tenantId`, `onDate`, and a live `org_units` row.
3. Walk `org_units.parent_id` upward to collect each assignment's **project** ancestor
   (and keep the assigned node itself).
4. Expand each project downward to its descendant `site` nodes, so a site-bearing entity can
   be filtered directly.
5. Emit both the org-unit id set and the person id set — a caller's _peers_ are the people
   sharing any of their effective assignments' org units.
6. Anything that resolves to nothing → `empty`, never `unrestricted`.

### Required behaviour per case

| case                                      | required outcome                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| no assignment                             | `empty` — fail closed. Not "see everything", not "error".                     |
| expired assignment (`valid_to < onDate`)  | contributes nothing                                                           |
| future assignment (`valid_from > onDate`) | contributes nothing                                                           |
| multiple effective assignments            | **union** of both org units and persons — never intersection, never overwrite |
| `tenantId` mismatch on the assignment     | contributes nothing (RLS hides it; the explicit check documents intent)       |
| assignment → missing org unit             | contributes nothing; must not throw                                           |
| assignment → soft-deleted org unit        | contributes nothing                                                           |
| `tenant_admin`                            | see §9 — explicit, not accidental                                             |
| `safety_manager` / `foreman`              | whatever their scope resolves to; `empty` if none                             |
| `worker` / `viewer`                       | their scope, intersected with `self` visibility                               |

### Explicitly forbidden

- A second `read.all`-style early return anywhere in the resolver or the ladder.
- A module-local scope helper. If a module needs a scope variant, it must call this resolver.
- Reading `ctx.scopes` for site ids _and_ the resolver — pick one source per consumer.

---

## 6. `people` scope

`people` has **no** location, org-unit or project column. Verified against the live schema:
its only link to organisation is `manager_person_id`, and the person↔org relationship lives
exclusively in `people_assignments`. There is no third option.

### Contract

`people.read.all` under Project Scope returns **the people covered by the caller's effective
assignments** — not the tenant roster. Concretely, from the resolver's `personIds` plus the
people sharing the caller's org units.

| question                            | answer                                                                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| person with multiple assignments    | union of all their org units; the person appears once                                                                                                                                                     |
| historical assignment               | **not visible** as current. A person whose only assignment ended is not in the caller's current scope. Optional: a separate, explicitly-labelled "former colleagues" view — not in scope for this design. |
| multiple people in the same project | all in scope, by shared org unit, not by name                                                                                                                                                             |
| `tenant_admin`                      | see §9                                                                                                                                                                                                    |
| no assignment                       | `empty` — a project-scoped user with no assignment sees nobody, including themselves, unless the person-self predicate is ORed in. **Open decision D3.**                                                  |
| self                                | a person must always be able to see their own row, independent of assignments. Recommended: OR `people.id = ctx.personId`. **Open decision D3.**                                                          |

**Compatibility note.** This changes `people.read.all` from tenant-wide to project-scoped for
`safety_manager`. `tenant_admin` retains tenant-wide (§9). Any module, export or AI tool
that assumed "`.all` ⇒ whole roster" must be re-audited — the `/people` page is the
authoritative one, and Commit 12's R1 gate is the reference implementation.

---

## 7. PPE scope

`ppe_items` has **no** org/site column. It has `current_holder_person_id`. This is the chain
the work depends on:

```
ppe_items.current_holder_person_id
  → people_assignments (effective window, same tenant)
  → org_units
  → project ancestor + descendant sites
```

`ppe_inspections` has `site_org_unit_id` **and** `supervisor_person_id`, so it can be
filtered directly — the two PPE tables need different strategies and must not be forced into
one.

| residual                | entity                        | can the same resolver serve it?                                                                                                                                                                                           |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R5** PPE issue target | `ppe_issue_reports`           | **Yes, via a join.** It has **no** `person_id` and must not gain one. The check is `item_id → ppe_items.current_holder_person_id → resolver.personIds`. The action asserts the _target_ is in the actor's operable scope. |
| **R6** picker           | `api/picker-options/route.ts` | **Yes.** The `ppe-active-people` query is currently unscoped; apply the resolver's `personIds` to it. Same semantics as the page, so the picker cannot offer a person the page would refuse.                              |
| **R8** foreman register | `ppe_items` list              | **Yes, via holder → `personIds`.** But a foreman with no `people_assignments` rows gets `empty` and an empty register — fail-closed, not a bug, and it must be labelled in the UI.                                        |

**Do not add `site_org_unit_id` to `ppe_items`.** The holder is the real relationship; a
denormalised site column on an item that changes hands would be a second source of truth that
drifts on every transfer.

**Precondition, unchanged from Commit 13:** R5/R6/R8 all require _populated_
`people_assignments`. A resolver over an empty table yields `empty` for everyone. Phase A
made the table writable; populating it is a data task, not a schema task.

---

## 8. Entity scope matrix

Verified against the live schema at `4777b2f9`. "Direct" = a usable org/site column on the
table. "Indirect" = only reachable through a person column.

| Entity                       | direct scope column        | indirect scope relation                                  | supported tiers (today)                               | no-scope behaviour                             | notes                                                                                                                                                            |
| ---------------------------- | -------------------------- | -------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `people`                     | **none**                   | `people → people_assignments → org_units`                | `people.read.all` only (Commit 12)                    | page gate → `redirect`/`notFound`              | most sensitive table; §6                                                                                                                                         |
| `people_assignments`         | `org_unit_id`              | —                                                        | **n/a — is the scope source**                         | RLS by tenant                                  | not a record module; must never be a filterable entity in its own right                                                                                          |
| `ppe_items`                  | **none**                   | `current_holder_person_id → people_assignments`          | `ppe.read.all` / `.site` / `.self`                    | `.site` falls back to holder col, then `false` | R6/R8 depend on this row                                                                                                                                         |
| `ppe_issue_reports`          | **none**                   | `item_id → ppe_items.current_holder_person_id`           | permission-gated only                                 | —                                              | **must not gain a `person_id`**; R5 is a join                                                                                                                    |
| `ppe_inspections`            | `site_org_unit_id`         | `supervisor_person_id`                                   | tiered                                                | falls back to owner                            | the one PPE table filterable directly                                                                                                                            |
| `equipment_items`            | `current_site_org_unit_id` | `current_holder_person_id`, `last_seen_holder_person_id` | `equipment.read.all` / `.site`                        | `.site` → site, else owner                     | largest consumer group (22 files)                                                                                                                                |
| vehicle log                  | via `equipment_items`      | parent vehicle's site                                    | `equipment.read.site` (Commit 4)                      | —                                              | scoped on the **parent** vehicle's site, matching the list                                                                                                       |
| `training_records`           | **none**                   | `person_id`, `evaluator_person_id`                       | `training.read.all` / `.site`                         | `.site` → owner                                | person-scope only                                                                                                                                                |
| `training_enrollments`       | **none**                   | `person_id`                                              | tiered                                                | owner                                          | person-scope only                                                                                                                                                |
| `training_skill_assignments` | **none**                   | `person_id`                                              | tiered                                                | owner                                          | person-scope only                                                                                                                                                |
| reports (`report_*` views)   | source-dependent           | via the source entity's columns                          | `reports.read` + the source entity's tier             | `visible:false`                                | Commit 12 made `report_compliance_status` a `prefix` so its declared columns actually apply; the entity has **no** scope column, so a `.site` holder is withheld |
| `compliance_obligations`     | **none**                   | —                                                        | `compliance.read` + tier family (Commit 12)           | —                                              | cross-module rollup; no location by design                                                                                                                       |
| `compliance_status`          | **none**                   | —                                                        | `compliance.read.*` tier                              | `visible:false` for scoped holders             | 0 rows today; severity rests on the code path                                                                                                                    |
| analytics / dashboards       | source-dependent           | —                                                        | per-entity ladder + `tenantWideOnly` guard (Commit 2) | `visible:false`                                | already the most disciplined consumer                                                                                                                            |
| public API `/api/v1`         | n/a                        | n/a                                                      | permission only                                       | RLS only                                       | **no scope axis exists** — `api_keys` has no scope column                                                                                                        |
| export routes                | 4 of 14 have it            | —                                                        | permission only (10 of 14)                            | —                                              | tenant-wide today; must converge                                                                                                                                 |

---

## 9. `tenant_admin` semantics

`tenant_admin` holds the entire catalogue, so it holds every `read.*` key. Two candidates:

### Option T1 — bypass Project Scope (`unrestricted`)

- **Permission semantics:** `read.all` keeps its literal meaning for this role; the bypass is
  carried by the existing `{type:'tenant'}` scope, not by a special case in the resolver.
- **Commit 12 behaviour:** unchanged. `people.read.all` stays tenant-wide for `tenant_admin`;
  the R1 fix and its tests keep passing.
- **Compatibility:** highest. No existing expectation changes.
- **Security boundary:** the bypass is a _scope_ fact, visible in `role_assignments`, and
  therefore auditable and revocable per user. A user can be `tenant_admin` in one tenant and
  project-scoped in another.
- **Implementation complexity:** lowest — one branch in the resolver, first.

### Option T2 — enter the resolver, unrestricted by assignment

- **Permission semantics:** identical keys; the resolver returns `unrestricted` for a
  `{type:'tenant'}` scope _or_ for the `tenant_admin` role.
- **Commit 12 behaviour:** unchanged in outcome, but the _reason_ changes — a
  `tenant_admin` whose assignment rows are empty would still see everything.
- **Compatibility:** same, but the code path now depends on role identity as well as scope,
  which adds a second source of truth for "who is unrestricted".
- **Security boundary:** weaker. Tying it to a _role key_ means any future role that inherits
  the catalogue inherits an unconditional bypass, and the bypass stops being visible in data.
- **Implementation complexity:** marginally higher, and a standing invitation to add
  role-key special cases — the exact anti-pattern the brief lists as #4.

**Both are admissible; they differ in where the bypass is recorded.** T1 records it in data
(`role_assignments.scopes`), T2 in code (`role key`). This document prefers T1 because the
decision is then reviewable by someone who can read a role row, and because
`recordVisibilityWhere` already treats `{type:'tenant'}` as unrestricted — so T1 makes the two
entry points agree instead of introducing a third meaning.

**Neither option may be selected implicitly.** Whichever is chosen must be an explicit
resolver branch with a test asserting the other roles are _not_ unrestricted, so a future
`read.all` holder can never inherit the bypass by accident.

---

## 10. Multi-assignment and historical semantics

`people_assignments` has no `is_primary` and no uniqueness constraint, so a person may hold
several concurrent assignments. Verified live.

| question                            | answer                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A person in several projects**    | Yes, and it is a first-class case, not an edge case. Their scope is the **union** of the projects — widening, never narrowing. Two projects ⇒ two project ids ⇒ both site sets.                                                                                                                                                                                                             |
| **An org unit in several projects** | **No.** `org_units.parent_id` is single-parent, so the tree is strict and each node has exactly one project ancestor. This is a **constraint to state in the product**, not an accident to work around: a site cannot serve two projects. If the business needs that, the org model must change first — out of scope here.                                                                  |
| **Do assignments inherit upward?**  | Yes. An assignment to a **site** grants that site **and its project ancestor**, so a project-scoped reader sees site-level records and a site-scoped reader can be reasoned about per project. Assignments to a **project** node grant the project and all descendant sites.                                                                                                                |
| **Several assignments → one scope** | Union. Never intersection (that would silently empty a legitimately broad role), never last-write-wins.                                                                                                                                                                                                                                                                                     |
| **Historical assignments**          | **Do not create current access.** An assignment with `valid_to < onDate` contributes nothing to current scope.                                                                                                                                                                                                                                                                              |
| **Effective-date test**             | `valid_from <= onDate AND (valid_to IS NULL OR valid_to >= onDate)`, evaluated in **UTC**, matching the single shared definition in `apps/web/src/lib/assignment-validity.ts` and the SQL `current_date` used by `@beaconhs/compliance`.                                                                                                                                                    |
| **`valid_to` inclusive?**           | **Yes, and it must stay inclusive.** `packages/compliance/src/audience.ts:99-104` and `packages/compliance/src/identity.ts:104-105` both use `valid_to >= today`, so an assignment ending today is still effective today. A Project Scope resolver that made it exclusive would disagree with compliance on the boundary day — the same class of drift the shared helper exists to prevent. |
| **Duplicated / overlapping rows**   | Possible (no constraint). Harmless for scope — the resolver unions id sets, so a duplicate changes nothing. Worth recording as a data-hygiene item, not a resolver concern.                                                                                                                                                                                                                 |

---

## 11. Migration impact

| change                                          | migration               | note                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{type:'orgUnits'}` on `RoleScope`              | **0**                   | `role_assignments.scopes` is JSONB. A new variant is a TypeScript union member.                                                                                                                                                          |
| `read.org_unit` tier (if adopted)               | **0**                   | `PERMISSION_CATALOGUE` is code. `readTierCovers`' regex (`packages/tenant/src/index.ts:244`, `^(.+)\.read\.(all                                                                                                                          | site | self)$`) would need the tier added — code, not schema. |
| canonical scope resolver                        | **0**                   | reads existing tables. `people_assignments` already has `(tenant_id, person_id)` and `(tenant_id, org_unit_id)` indexes.                                                                                                                 |
| recursive org-tree walk                         | **0**                   | `org_units_parent_idx ON (tenant_id, parent_id)` already exists. No recursive CTE exists in the codebase today, so the walk is new code but index-backed.                                                                                |
| populating `people_assignments`                 | **0**                   | data task. Phase A (`4777b2f9`) added the write path.                                                                                                                                                                                    |
| `people_assignments.is_primary`                 | **1, only if required** | needed only if "home project" becomes a business concept. Not required for scope.                                                                                                                                                        |
| overlap constraint on assignments               | **0 or 1**              | optional data hygiene.                                                                                                                                                                                                                   |
| RLS                                             | **0**                   | 187/193 tables are tenant-isolated; **0** policies reference org unit, site or scope. Project Scope is an application-layer concern. Adding an RLS scope policy would duplicate the resolver in a second language — explicitly rejected. |
| adding a scope column to `ppe_items` / `people` | **rejected**            | second source of truth; drifts on every transfer.                                                                                                                                                                                        |
| new `projects` / `project_org_units` tables     | **rejected**            | `org_units.level='project'` already is the project hierarchy, with a live tree (`Acme Refinery → Turnaround 2026 → Site A / Site B`). A separate table would duplicate it.                                                               |

**Total: 0 migrations.** The only conditional case is `is_primary`, and it is not required by
this design.

---

## 12. Compatibility impact

Ordered by blast radius.

| #   | area                                 | impact                                                                                                                            | mitigation                                                                                                                                           |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`read.all` semantics**             | breaking _in meaning_ for 6 role baselines. Every `return undefined` / `return true` on tier `all` (4 sites) must be re-derived.  | explicit cutover note; the existing 31-test scope contract files are the scaffold; re-run all four with a project-scoped subject                     |
| 2   | **86 consuming files**               | each scope-bearing module needs a scope predicate even at tier `all`; a missed one is a silent leak                               | a contract test that fails when a module is added without a resolver binding, plus an explicit allowlist of modules that are genuinely tenant-wide   |
| 3   | **10 permission-only export routes** | currently tenant-wide; would remain so unless converged, creating exactly the UI-vs-export divergence the work is meant to remove | converge exports onto the same resolver _before_ enabling project scope for their modules                                                            |
| 4   | **public API `/api/v1`**             | no scope axis exists. A project-scoped API consumer cannot be expressed, and a tenant-wide key stays tenant-wide                  | add a scope column to `api_keys` — a **migration**, and therefore explicitly out of scope here. Until then the API is documented as permission-only. |
| 5   | **worker report run-as**             | already routes through `scopeAnalyticsEntities`; gains project scope for free once the subject carries it                         | extend `reportRunAsScopeSubject` only                                                                                                                |
| 6   | **Commit 12 (`people.read.all`)**    | R1's outcome changes for `safety_manager` if B1 is adopted                                                                        | re-run the Commit 12 contract file; the `people.read.all` assertions must be re-pointed at the resolver, not deleted                                 |
| 7   | **AI assistant tools**               | `assistant/tools.ts:86` passes `ctx.scopes` into tool context; a tool must not re-derive scope                                    | tools consume the resolver output, never `ctx.scopes` directly                                                                                       |
| 8   | **empty ≠ unrestricted**             | new state; UIs that rendered an empty list now need a reason                                                                      | resolver returns a `reason`; no UI may treat `empty` as "no data"                                                                                    |
| 9   | **manual / walkthroughs**            | role-visible help text may change                                                                                                 | AGENTS.md rule 7 — update the affected articles and tour steps in the same change                                                                    |

---

## 13. Security invariants

Each is stated so it can be **tested**, and each names where it is enforced.

| #   | invariant                                                                 | enforced at                                         | testable by                                                                        |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | `read.all` never means unrestricted tenant-wide for a project-scoped role | resolver step 1; the 4 ladder short-circuits        | foreman + `read.all` subject sees only its own project's rows                      |
| 2   | the tenant boundary can never be crossed                                  | `ctx.tenantId` only; composite FKs; tenant-only RLS | cross-tenant assignment and cross-tenant entity id both return nothing             |
| 3   | a historical assignment creates no current access                         | resolver date filter                                | `valid_to = yesterday` contributes nothing                                         |
| 4   | an expired assignment creates no current access                           | same                                                | as above, plus a `valid_to = today` boundary case (inclusive)                      |
| 5   | no effective assignment fails closed                                      | `kind: 'empty'`                                     | a user with 0 assignments sees 0 rows, **not** all rows                            |
| 6   | multiple effective assignments produce a **union**                        | resolver step 5                                     | two concurrent assignments ⇒ both projects' rows visible                           |
| 7   | self scope stays strictly narrower than site/project                      | visibility is ANDed with scope, never ORed away     | a `.self` holder sees fewer rows than a `.site` holder in the same project         |
| 8   | a PPE target cannot escape the actor's scope                              | R5 join `item_id → holder`                          | an issue raised against an out-of-scope holder is refused                          |
| 9   | UI filtering is never the authorization boundary                          | actions/routes re-check                             | hide a button, call the action directly, still refused                             |
| 10  | actions, routes, API, export and worker share one semantic                | the single resolver                                 | same fixture, five surfaces, one answer                                            |
| 11  | `tenant_admin`'s breadth is explicit, not accidental                      | resolver step 1, one documented branch              | `tenant_admin` unrestricted; `safety_manager` is not                               |
| 12  | exactly one canonical resolver exists                                     | a contract test on the module set                   | adding a second module-local scope helper fails `deadcode:check`/the contract test |

---

## 14. Implementation sequence

Each step is independently shippable and independently testable. Ordering is driven by
dependencies, not preference.

| step   | work                                                                                                        | exit criterion                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S0** | populate `people_assignments` with real data                                                                | a foreman has ≥1 effective assignment; `materializeUserIdentityAudienceObligations` returns a non-empty org-unit audience (today it returns 0 for everyone) |
| **S1** | resolver, returning `ResolvedScope`, **unused by any module**                                               | unit + DB tests for all 10 required cases in §5; no consumer yet, so zero regression risk                                                                   |
| **S2** | bind the resolver into `recordVisibilityWhere` and `moduleScopeWhere`; remove the 4 short-circuits          | the 4 ladder contract suites pass with a project-scoped subject; a `read.all` + scoped subject is **narrower** than before                                  |
| **S3** | converge the 10 permission-only export routes                                                               | each export returns exactly the rows its page returns, for the same fixture                                                                                 |
| **S4** | adopt per module, §8 matrix order: equipment → incidents/inspections/corrective actions → training → people | foreman A and foreman B see disjoint, non-empty sets on each module                                                                                         |
| **S5** | PPE (R6 → R5 → R8)                                                                                          | picker, action and register all agree on the same person set                                                                                                |
| **S6** | worker run-as + analytics subject                                                                           | a scheduled report authored by a foreman contains only that foreman's project                                                                               |
| **S7** | manual articles, walkthroughs, cutover note                                                                 | AGENTS.md rule 7 satisfied; the `read.all` semantics change is documented for operators                                                                     |
| **S8** | public API scope (`api_keys` scope column)                                                                  | separate decision — needs a migration, therefore its own change                                                                                             |

**S0 before S1 is a hard dependency:** a resolver over an empty assignments table is
untestable and looks like a bug. **S3 before S4** is a hard dependency: converging exports
after modules are live means every module needs a temporary exemption.

---

## 15. Test design (design only — not implemented)

### Unit — pure resolver logic, no database

- 6 role subjects (tenant_admin, safety_manager, foreman, worker, viewer, super-admin)
  × 5 fixtures (0 / 1 / 2 concurrent / historical-only / expired) = 30 cases
- boundary: `valid_to = today` is **effective** (inclusive, matching compliance)
- boundary: `valid_from = today` is effective; `valid_from = tomorrow` is not
- `kind: 'empty'` with the correct `reason`, never `unrestricted`
- `onDate` is honoured, not read from the clock
- no `read.all`-style early return: a `read.all` subject **with** a scope is narrower than one without

### DB — the resolver's own queries

- person with 0 / 1 / 2 / N effective assignments ⇒ union
- assignment to a **site** grants that site **and** its project ancestor
- assignment to a **project** grants the project **and** all descendant sites
- assignment → soft-deleted org unit ⇒ contributes nothing, no throw
- assignment → missing org unit ⇒ contributes nothing, no throw
- cross-tenant assignment ⇒ contributes nothing
- deep org chain (customer → project → site → area) walks correctly; depth cap holds
- recursion cost: a wide project (many sites) resolves within a stated budget

### Server action

- `createAssignment` / `updateAssignment` / `endAssignment` refuse a **non**-`admin.org.manage` caller (extends Commit 13's 31 tests)
- assignment to a cross-tenant org unit refused
- `endAssignment` sets `valid_to` and never deletes
- **R5**: issuing PPE against an out-of-scope holder is refused; in-scope succeeds
- an impersonated admin cannot use a target's narrower scope

### Route / page

- list and detail agree: a row visible on the list is fetchable by id, and a hidden row 404s
- `?tab=…` does not widen access
- **R6**: the picker offers exactly the persons the page would accept
- **R8**: a foreman with no assignment gets an **empty register with a reason**, not an error and not a full list

### Export

- for each of the 14 export routes: row set **equals** the corresponding page's row set
- a denied export returns 403, not 500 (extends Commit 12)
- export response contains no row outside the caller's scope

### Public API

- an API key without the permission is refused (existing Commit 7 contract)
- **documented limitation:** an API key is permission-only and therefore tenant-wide; a test
  asserts this is _the current stated behaviour_ so a future change is a deliberate diff
- if S8 proceeds: key scope intersects entity scope

### Worker

- a scheduled report authored by a foreman contains only that foreman's project
- run-as an impersonated admin uses the **target's** scope, not the admin's
- a report whose author has since lost their assignment regenerates narrower

### Browser (real session, per identity)

| identity                           | expected                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| tenant_admin                       | full roster; can manage assignments; sees the "company-wide" reason          |
| safety_manager                     | only own project's roster; **no** cross-project person                       |
| foreman                            | own site only; PPE register scoped; issue refused for an out-of-scope holder |
| worker                             | own record only                                                              |
| viewer                             | own record only; no management UI                                            |
| user with 0 assignments            | empty everywhere, **with a reason shown**                                    |
| user with 2 concurrent assignments | union, and the UI shows both projects                                        |

Assert on **HTTP status + absence of specific PII** (name, employee number, email), never on
"the page looked right".

---

## 16. Unresolved business decisions

These need an answer before S2. Each one changes behaviour, so none is assumed here.

| #       | decision                                                                                              | why it matters                                                              | blocking |
| ------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------- |
| **D1**  | Adopt re-purposed `read.all` (B1) or keep it tenant-wide (B2)?                                        | determines whether Model B is even possible; changes 6 role baselines       | S2       |
| **D2**  | `tenant_admin`: T1 (`{type:'tenant'}` scope) or T2 (role-key bypass)?                                 | where the bypass is recorded: data or code                                  | S2       |
| **D3**  | With no effective assignment, is the person visible to themselves?                                    | the difference between an empty roster and a broken-looking one             | S4       |
| **D4**  | Is a former colleague (ended assignment) reachable at all, and if so under what label and permission? | history is currently invisible; "no" is defensible but must be stated       | S4       |
| **D5**  | Can an org unit belong to more than one project?                                                      | the tree says no; if the business says yes, the org model must change first | S4       |
| **D6**  | Does project scope apply to _write_ capabilities, or read only?                                       | R5 needs it for an action; the ladder is read-only today                    | S5       |
| **D7**  | Is the public API in or out of scope?                                                                 | in scope ⇒ `api_keys` needs a scope column ⇒ **1 migration**                | S8       |
| **D8**  | Are the 10 permission-only exports allowed to stay tenant-wide in the interim?                        | if yes, UI and CSV disagree for those modules                               | S3       |
| **D9**  | Who may assign a person to a project — `admin.org.manage` only, or a new scoped key?                  | Commit 13 used the former; a project manager may need their own             | S0       |
| **D10** | Should a person see the roster of a project they are assigned to, or only their own site?             | changes whether the project ancestor is granted on assignment               | S4       |

---

## 17. Audit findings recorded but not acted on

Found during this audit, outside the design's scope, **read-only, not fixed**:

1. **Four short-circuits, not two.** The brief cited `visibility.ts:165`/`:201` and
   `scope.ts:329`/`:369`. `recordVisibilityWhere` (`visibility.ts:46`, returning `undefined`
   on `ctx.isSuperAdmin` at line 51 and on a `{type:'tenant'}` scope at line 53) is a **fifth**
   site, and it inverts the dependency: scope grants visibility regardless of permission.
   Any fix that touches only the four cited lines leaves this one.
2. **`readTierCovers`' regex is closed** (`packages/tenant/src/index.ts:244`,
   `^(.+)\.read\.(all|site|self)$`). A new tier name would silently degrade to a bare
   `Set.has()`, so no tier widening at all. Any adopted tier must be added there.
3. **`report_compliance_status` still has no scope column.** Commit 12 moved it to a `prefix`
   so its declared columns apply — and they resolve to `null` for all three candidate sets, so
   a `.site` holder is **withheld entirely**. Fail-closed and correct, but it means a
   project-scoped foreman sees _no_ compliance report data, not a filtered subset.
4. **10 of 14 export routes are tenant-wide** (§1). All permission-gated, so no hole today —
   but they are the largest single source of UI-vs-export divergence.
5. **`compliance_status` and `form_responses` with `monitor_status` hold 0 rows**, which is
   why 7 published reports return nothing. F11 from the Commit 11 audit was **reclassified as
   a misdiagnosis** — both entities are valid inline subqueries, not missing views. No
   migration is needed for that one.
6. **`hazid_assessments.project_org_unit_id` is inert** — written, displayed, exported to
   flows, and never used in a `WHERE`. Its two `.where()` uses are display joins
   (`eq(orgUnits.id, …)`).
7. **`pnpm build` fails at `/_global-error`** with
   `TypeError: Cannot read properties of null (reading 'useContext')`. **Proven pre-existing**:
   reproduced at pure `dc231ef7` with none of Commit 13's changes present. Cause:
   `app/global-error.tsx` is a `'use client'` component calling next-intl hooks, but a global
   error _replaces_ the root layout, so `NextIntlClientProvider` is not an ancestor.
