# `locations/export.csv` — native permission audit

**Date:** 2026-10-01
**Scope:** read-only audit. No production code, test, schema or migration was modified.
**Question:** can the data range of `locations/export.csv` be expressed safely with
BeaconHS's native `Permission → Role Scope → Visibility Tier → Record` model?
**Constraint:** Project Scope is permanently removed and must not be reintroduced.

---

## 0. Headline finding

**The export route's authorization is already native and needs no new permission.**
It has been bounded by two flat permissions plus RLS since before Project Scope
existed, and it never applied Project Scope at all.

**The actual defect is one level up and is not about the export at all: the
Locations _read_ surface has no permission gate and no row scope.** `/locations`,
`/locations/[id]` and the customer contact records they render are bounded by RLS
alone. It is the only module list page in the repository with neither a permission
gate nor a visibility tier.

**Verdict: `NEW NATIVE PERMISSION`** — one flat read key, `admin.org.read`,
following the existing `admin.audit.read` precedent. Not an export permission.
Section 10 states why no export permission is needed.

---

## 1. Current behavior

### 1.1 The route

`apps/web/src/app/(app)/locations/export.csv/route.ts`

| Property        | Value                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability gate | `requireExportContext()` → `assertCan(ctx, 'admin.data.export')` + `assertNotImpersonating(ctx, 'export')`, then `assertCan(ctx, 'admin.org.manage')` |
| Row scope       | **none** — `moduleScopeWhere` is never called                                                                                                         |
| Row filter      | `orgUnits.level = 'customer'` (hard-coded, first conjunct), optional `q` on name/code, optional soft-delete status                                    |
| Ordering        | name or code, asc/desc                                                                                                                                |
| Bound           | `CSV_EXPORT_QUERY_LIMIT` = `CSV_EXPORT_MAX_ROWS + 1` = **10 001** (over 10 000 returns a refusal, not a partial file)                                 |
| Audit           | `recordAudit({ entityType: 'org_unit', action: 'export', … })` with the filters used                                                                  |
| Columns         | 8 declared; caller may request a **subset** only, never add one                                                                                       |

The exported columns, and their sensitivity:

| #   | Column           | Kind                    |
| --- | ---------------- | ----------------------- |
| 1   | `Name`           | identifier-ish          |
| 2   | `Code`           | identifier-ish          |
| 3   | `Level`          | structural (`customer`) |
| 4   | `Address line 1` | **address**             |
| 5   | `City`           | **address**             |
| 6   | `Region`         | **address**             |
| 7   | `Postal code`    | **address**             |
| 8   | `Country`        | **address**             |

Five of eight are address components. `orgUnits.address` is a JSONB column typed
`{ line1?, line2?, city?, region?, postal?, country? }`; **`line2` is not exported**,
and neither are `lat` / `lng` (site-level geolocation). The existing
`selectCsvColumns` narrowing plus `exportColumns` is what prevents a caller adding
`id`, `tenantId`, `parentId` or a project column — asserted in
`locations-export-scope-contract.test.ts`.

### 1.2 Who can reach it today

| Role             | `admin.data.export` | `admin.org.manage` | Net                    |
| ---------------- | ------------------- | ------------------ | ---------------------- |
| `worker`         | –                   | –                  | refused                |
| `foreman`        | –                   | –                  | refused                |
| `safety_manager` | –                   | –                  | refused                |
| `tenant_admin`   | ✔ (full catalogue)  | ✔ (full catalogue) | **tenant-wide export** |

Only `tenant_admin`, and only because it holds the whole 99-key
`PERMISSION_CATALOGUE` rather than an explicit list. `roles.key` accepts custom
slugs and `roles.permissions` is a JSONB `PermissionKey[]`, so a **custom** role
granted both keys would also reach it — see §5.3.

### 1.3 The read surfaces around it

| Surface                                    | Page-level read gate                                | Row scope | Net boundary     |
| ------------------------------------------ | --------------------------------------------------- | --------- | ---------------- |
| `/locations`                               | **none**                                            | **none**  | **RLS only**     |
| `/locations/[id]`                          | **none** (`notFound()` only when the row is absent) | **none**  | **RLS only**     |
| `/locations/units`, `/locations/manage`    | none                                                | none      | RLS only         |
| `customer_contacts` rendered on both pages | none                                                | none      | RLS only         |
| `/locations/export.csv`                    | `admin.data.export` + `admin.org.manage`            | none      | permission + RLS |

Contrast, same repository, same pattern of "gate at the page, scope the rows":

| Module list       | Page read gate                                             | Row scope                        |
| ----------------- | ---------------------------------------------------------- | -------------------------------- |
| `people`          | `if (!can(ctx,'people.read.all')) redirect('/dashboard')`  | RLS only (flat key, no column)   |
| `documents`       | `if (!canManage && !can(ctx,'documents.read')) notFound()` | RLS only                         |
| `ppe`             | none                                                       | `moduleScopeWhere(prefix:'ppe')` |
| `equipment`       | none                                                       | `moduleScopeWhere`               |
| `incidents`, `ca` | none                                                       | `moduleScopeWhere`               |
| **`locations`**   | **none**                                                   | **none**                         |

`ppe` and `equipment` have no page gate but are still safe: with no read key,
`resolveVisibilityTier` returns `self` and the predicate is own-only or `false`.
Locations has no read key **and** no ladder call, so nothing narrows it.

The nav entry reinforces this: `nav/registry.ts` gives `people` →
`people.read.all` and `equipment` → `equipment.read.site`, but `locations` has
**no `requiredPermission`**. (`documents` and `ppe` also lack one, which is why the
page gate and the row scope matter.)

### 1.4 Analytics and search

`org_units` is tenant master data and is granted in `TABLE_SCOPE` with a flat key:

```
org_units:    { read: { key: 'admin.org.manage' } }
departments:  { read: { key: 'admin.org.manage' } }
crews:        { read: { key: 'admin.org.manage' } }
trades:       { read: { key: 'admin.org.manage' } }
```

`tierFor` resolves a flat key to tier `all` (no row predicate); a caller without the
key is withheld. `org_units` is **not** reachable from `api/search`, `api/query` or
the assistant. The neighbouring `PREFIX_SCOPE` entry is
`['customer_', { read: { key: 'admin.users.manage' }, orgUnitCols: ORG_UNIT_COLUMNS }]`.

### 1.5 The admin export hub

`admin/export/_entities.ts` declares the locations tile as:

```
key: 'locations', permissionAny: ['admin.org.manage'],
sensitivity: 'Standard', defaultScope: 'Tenant customer locations'
```

The hub page itself requires `admin.data.export` (`_entities.ts` → `page.tsx:107`)
and renders a tile only when `permissionAny.some(can)`, so for locations the tile
visibility and the route's gate **agree** — no hub/route drift here.

### 1.6 RLS

`org_units` is entry 2 in `TENANT_SCOPED_TABLES` (`packages/db/src/rls.ts:107`), so
every read runs under the tenant GUC via `ctx.db`. The tenant boundary is real and
enforced below every permission in this document.

---

## 2. Original BeaconHS behavior

The route's history, oldest first:

| Commit     | Subject                                                                   | Gate                                                           |
| ---------- | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `0b0aeb5a` | Upgrade Next 15 → 16.2.6, Drizzle 0.36 → 0.45, plus deep module expansion | **none** — `requireRequestContext()` only                      |
| `95e639a5` | commit in-progress working tree                                           | **none**                                                       |
| `5043be63` | **Rebuild utilities export center**                                       | `requireExportContext()` + `assertCan(ctx,'admin.org.manage')` |
| `14ae1a47` | Unify location detail page; gate location writes                          | unchanged                                                      |
| `156f14a8` | complete production clean cutover                                         | unchanged                                                      |
| `a0cd5041` | stop Link prefetch logging phantom exports                                | + `isRouterPrefetch` short-circuit                             |

Two conclusions:

1. **The original design had no gate whatsoever.** In `0b0aeb5a` any authenticated
   member could export the tenant-wide customer address book. The current gate is
   _newer_ than the route and came from the utilities-export-center work, not from
   the locations module.
2. **This route never applied Project Scope.** Checked at `0b0aeb5a`, `5043be63`,
   `14ae1a47` and `51995178`: zero references to `projectScope`, `ProjectScope`,
   `moduleScopeWhere` or `recordInProjectScope` in the route at any point. The
   route was recorded in the 15B-3C audit as _deferred to a separate 3E decision_
   and never received a Project Scope conjunct.

Therefore the tenant-wide export is **not** a widening introduced by the removal.
The route's data range is unchanged by Phase 2. What the removal _did_ do is remove
the last plausible place where a future narrower scope could have been added
without a product decision.

---

## 3. Current native permissions

Everything relevant that exists today:

| Key                 | Shape | Meaning                                                                                                                                      | Held by                          |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `admin.data.export` | flat  | "Tenant-wide CSV export permission, required by every export.csv route and the central Admin data export hub." (catalogue comment, verbatim) | `tenant_admin`                   |
| `admin.org.manage`  | flat  | manage the org tree                                                                                                                          | `tenant_admin`                   |
| `admin.audit.read`  | flat  | read the audit log — **the naming precedent for a flat read key in the `admin.` namespace** (`iam.ts:320`)                                   | `tenant_admin`                   |
| `people.read.all`   | flat  | the workforce directory                                                                                                                      | `safety_manager`, `tenant_admin` |

Keys that **do not** exist: `admin.org.read`, `locations.*`, `org_units.*`, and any
`*.read.{all,site,self}` family for the org structure.

### 3.1 The repo's export convention (15 routes)

Every `export.csv` route calls `requireExportContext()` (so `admin.data.export` is
universal) and then adds a **module capability**. `admin.data.export` is the only
export-flavoured key in the entire catalogue.

| Route                                                                           | Additional capability                        |
| ------------------------------------------------------------------------------- | -------------------------------------------- |
| `people/export.csv`                                                             | `admin.users.manage` **+ `people.read.all`** |
| `documents/export.csv`                                                          | `documents.manage`                           |
| `locations/export.csv`                                                          | `admin.org.manage`                           |
| `ppe/export.csv`                                                                | `ppe.read.all`                               |
| `equipment/vehicle-log/export.csv`                                              | `equipment.read.all`                         |
| `equipment/export.csv`                                                          | `equipment.read.site`                        |
| `inspections/export.csv`                                                        | `inspections.read.self`                      |
| `journals/export.csv`                                                           | `journals.read.self`                         |
| `reports/definitions/[id]/export`                                               | `reports.read`                               |
| `incidents`, `ca`, `responses`, `insights`, `safe-distance`, `training/courses` | none beyond `admin.data.export`              |

The convention is unambiguous: **one generic, tenant-wide export capability plus the
module's own capability.** No route has a module-specific export key.

### 3.2 `can()` widening rules (`packages/tenant/src/index.ts:101`)

```ts
can(ctx, perm) === ctx.isSuperAdmin
  || permissions.has(perm)
  || readTierCovers(permissions, perm)      // <prefix>.read.all ⊇ .site ⊇ .self, same prefix
  || some p endsWith '.*' && perm.startsWith(p.slice(0,-1))
```

`readTierCovers` only widens **within one `read` family of one prefix**. A flat
`admin.org.manage` therefore does **not** imply `admin.org.read`. This matters for
any migration (see §8.3).

---

## 4. Role Scope applicability

`RoleScope` has six variants and **none is a project/org-unit scope**
(`packages/db/src/schema/iam.ts:49-55`). For `org_units` specifically:

| Candidate tier    | Expressible?                    | Why                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read.self`       | **No**                          | `org_units` has no person column and no owner column. `ownPredicates` would return `[]` → hard `false` for everyone. Same argument the catalogue already records for `people.read.all`: "a site or self tier would be unenforceable from this table and must not be implied".                                                                                                                             |
| `read.site`       | **No, not with today's ladder** | `mySiteIds(ctx)` returns the **literal** `{type:'sites'}` ids — there is no ancestor walk. A `customer` row is an **ancestor** of the caller's sites, not a member of them. `org_units.parent_id` points at another org unit, so filtering the org tree by the org tree is **circular**. Making this tier work would require a **new resolver capability** (an ancestor expansion), not a new permission. |
| `read.all` (flat) | **Yes, today**                  | A flat key resolves to tier `all` → no row predicate; RLS bounds the tenant. This is exactly how `people.read.all` already works.                                                                                                                                                                                                                                                                         |

**Conclusion:** Role Scope can express a tenant-wide org-structure read _now_, and
cannot express a narrower one without adding tree-walking to the shared ladder.
That is a larger change than this audit is scoped to, and it is a product decision
(should a supervisor see the customers whose sites they run?).

---

## 5. PII exposure

### 5.1 What is actually sensitive

Five of eight exported columns are address components of a **customer** — a
commercial counterparty's premises, not BeaconHS's own site. In construction this
is the client address book, frequently including registered office addresses and
subcontractor sites. Comparable to `people`'s export (email, phone, date of birth,
emergency contact) in kind, if not in volume.

### 5.2 Where it is exposed beyond the export

Because the read surfaces are ungated, the same data is visible to **any
authenticated member**:

- `/locations` lists every customer with name and code.
- `/locations/[id]` loads a row **by id** and renders the full address
  (`addressLine1`, `addressLine2`, `addressCity`, `addressRegion`,
  `addressPostal`, `addressCountry`) plus `customer_contacts` — contact **name,
  role, email, phone, notes**.
- Neither surface calls `moduleScopeWhere` or checks a permission.
- The nav entry has no `requiredPermission`.

So the export gate is the **only** thing standing between a member and the address
book — and it is a gate on the _export_, not on the _view_. That is the inversion
to fix: the more sensitive act (bulk extract, exfiltratable) is gated, and the
on-screen read of the same data is not.

### 5.3 The residual, genuine risk after the export gate

The exposure that remains once the export gate is respected is **custom-role
escalation**: a role granted `admin.org.manage` + `admin.data.export` — a plausible
"site setup manager" — receives the tenant-wide customer address book, because
`admin.org.manage` is a **write** capability being used as a **read** boundary, and
because there is no key that means "may read the org structure".

Two smaller inconsistencies in the same area, both pre-existing and both outside
this audit's decision:

- The export hub labels locations `sensitivity: 'Standard'` while labelling
  `people` `Restricted` and `journals`/`ppe`/`inspections` `Sensitive`. Given five
  address columns, `Standard` understates it by the repository's own convention.
- The hub's `permissionAny` for `people` is `admin.users.manage` only, while the
  route also requires `people.read.all` — so a custom role with
  `admin.data.export` + `admin.users.manage` but not `people.read.all` sees the
  People tile and receives a 403. Locations does not have this drift.

### 5.4 What is _not_ exposed

- Cross-tenant: impossible. `org_units` is RLS-tenant-scoped.
- Super-columnar: impossible. `id`, `tenant_id`, `parent_id`, `lat`, `lng`,
  `address.line2` and `metadata` are not exported and cannot be requested.
- Unbounded: impossible. >10 000 rows is refused rather than truncated.

---

## 6. Options

### Option 1 — KEEP the export exactly as it is

`admin.data.export` + `admin.org.manage` continues to gate a tenant-wide export.

- Pros: zero migration; no new key; matches the 15-route convention; the export's
  data range never changed in this phase or any previous one.
- Cons: leaves a write capability acting as a read boundary; leaves the read
  surfaces ungated; leaves `sensitivity: 'Standard'` on an address export.
- Does not address the actual defect (§0).

### Option 2 — ADAPT ROLE: reuse `admin.org.manage` as the read gate

Add `if (!can(ctx,'admin.org.manage')) notFound()` to `/locations` and
`/locations/[id]`.

- Pros: no new key; closes the ungated read immediately; consistent with
  `documents`, where `documents.manage` also satisfies the read check
  (`if (!canManage && !can(ctx,'documents.read')) notFound()`).
- Cons: **it does not close anything that matters.** Only `tenant_admin` holds
  `admin.org.manage` today, so the page would be closed to everyone else — which is
  the fix — but the boundary is still a manage key, and a future custom role
  granted `admin.org.manage` for org-tree editing silently inherits read access to
  the whole address book. It also over-constrains: an org-tree _editor_ and a
  customer _directory reader_ are genuinely different jobs.

### Option 3 — NEW NATIVE PERMISSION: a flat `admin.org.read`

- Pros: names the actual capability; follows `admin.audit.read` exactly; separates
  read from write; lets a custom role read locations without being able to
  restructure the tree; keeps the export gate unchanged; fully expressible with
  today's ladder (§4).
- Cons: one new catalogue key (100th); custom roles holding only
  `admin.org.manage` need either the key or an explicit accept-both check (§8.3).

### Option 4 — a tier family `admin.org.read.{all,site,self}`

- Pros: would allow a narrower tier someday.
- Cons: **`site` is not implementable today** (§4 — needs ancestor expansion in the
  shared ladder); `self` is unenforceable (no column); `all` is identical to a flat
  key. This declares a capability the resolver cannot honour, which is worse than
  Option 3 — it invites a caller to write `prefix:'admin.org'` and get a silent
  own-only/`false` answer.

### Option 5 — reduce the exported columns

Drop the five address components, or make them opt-in.

- Pros: directly reduces the PII surface; no permission work.
- Cons: the CSV's stated purpose is "customer-level location export with codes and
  address fields" (`admin/export/_entities.ts:604`). Removing them breaks a
  documented feature for every legitimate recipient. It reduces _what_ leaks, not
  _who_ can leak it, and leaves the ungated on-screen read untouched.

---

## 7. Recommended native solution

**Verdict: `NEW NATIVE PERMISSION` — one flat read key, `admin.org.read`.**
Sub-verdict for the export gate itself: **KEEP** unchanged.

Rationale:

1. **The export needs nothing new.** `admin.data.export` is already the repository's
   single, explicitly tenant-wide export capability, and `admin.org.manage` is a
   real module capability. Section 10 explains why a `locations.export`-style key
   would be a parallel system.
2. **The read needs exactly one new key.** No existing permission means "may read
   the org structure". `admin.org.manage` is a write capability; using it as the
   read boundary is the semantic mismatch that makes a custom role's escalation
   invisible at review time.
3. **`admin.org.read` matches an existing precedent in the same namespace.**
   `admin.audit.read` (`iam.ts:320`) is a flat read key in `admin.*`, used as a
   page gate (`admin/audit/page.tsx:60`), a nav gate (`nav/registry.ts:249`) and a
   capability check (`admin/export/page.tsx:161`). `admin.org.read` is the same
   shape for the same reason.
4. **It is fully expressible with today's ladder** — flat key → tier `all` → RLS
   bounds the tenant. No new resolver capability, no schema change, no migration.
5. **It leaves the tier question open rather than pre-empting it.** If a narrower
   org-structure view is ever wanted, that is a decision about ancestor expansion in
   `moduleScopeWhere`, and it should be made deliberately — not smuggled in by
   declaring a `.read.site` key the ladder cannot bind.

Explicitly rejected, as instructed: any location-scoped ACL, any project/site scope
on this route, and any per-module export permission.

---

## 8. Required code changes

**None are implemented by this audit.** Listed so the decision is reviewable.

### 8.1 Catalogue

- `packages/db/src/schema/iam.ts`: add `'admin.org.read'` immediately before
  `'admin.org.manage'`, with a comment in the style of the neighbouring entries
  stating that it is the read-only counterpart and that `admin.org.manage` does not
  imply it (see §3.2).
- Catalogue length 99 → **100**. Three assertions in
  `ppe-read-tier-contract.test.ts` pin the count and must move together:
  `:85` (`PERMISSION_CATALOGUE.length`), `:86` (the `Set` size, i.e. no
  duplicates) and `:111` (`tenant_admin`'s inherited length). The comment at
  `:83` records the previous 96 → 99 step and should note this one.
- `apps/web/src/lib/permissions-meta.ts`: add the human label.

### 8.2 Gate the read surfaces

- `apps/web/src/app/(app)/locations/page.tsx`: add the read gate next to the
  existing `canManage` / `canExport` reads. Follow the `documents` precedent —
  accept the read key **or** the manage key, so a custom role holding only
  `admin.org.manage` is not silently locked out:
  `if (!canManage && !can(ctx, 'admin.org.read')) redirect('/dashboard')`.
- `apps/web/src/app/(app)/locations/[id]/page.tsx`: the same check before
  `ctx.db(...)` loads the row, so a guessed id does not resolve. Mirror
  `people/[id]/page.tsx`, which checks `people.read.all` **before** loading.
- `apps/web/src/lib/nav/registry.ts:180-186`: add
  `requiredPermission: 'admin.org.read'` to the `locations` entry.

### 8.3 Migration and rollout

- `tenant_admin` holds the full catalogue → receives the key automatically.
- `safety_manager` gains nothing (it holds neither `admin.org.*` nor
  `admin.data.export`), so nothing changes for it.
- **Custom roles holding `admin.org.manage` but not `admin.org.read` would lose
  Locations access** unless §8.2's accept-both check is used. That check is
  therefore not optional politeness — it is the migration path. Alternatively
  back-fill the new key onto every role that already holds `admin.org.manage`.
- No schema change, no migration, no Drizzle journal entry. Journal stays at 41
  entries / idx 40.

### 8.4 Consistency follow-ups (optional, same area)

- `apps/web/src/app/(app)/admin/export/_entities.ts:610`: reconsider
  `sensitivity: 'Standard'` for an export that is five-eighths address fields. The
  repository's own ladder puts `people` at `Restricted`.
- Optional second defence in depth, independent of permissions: have the hub's
  `permissionAny` for locations list **both** `admin.org.read` and
  `admin.org.manage` so the tile matches the route exactly.

---

## 9. Required tests

Extend `apps/web/src/lib/locations-export-scope-contract.test.ts` — which already
covers the export's capability pair, the `level = 'customer'` pinning, the
eight-column allowlist and the tenant-level/RLS contract — with the new
**behavioural** read assertions. Rename the file to drop `scope` from the name
(it no longer asserts anything about a scope) once the read tests land.

New assertions:

1. **Read gate exists on the list** and accepts `admin.org.read`.
2. **Read gate exists on the detail page and runs before the row is loaded** — the
   `people/[id]` precedent; a guessed id must not resolve.
3. **`admin.org.manage` alone still satisfies the read** (the migration path), and
   `admin.org.read` alone does **not** grant write: the org-tree mutation actions in
   `locations/_actions/units.ts` and `_actions/locations.ts` must still require
   `admin.org.manage`.
4. **`admin.org.manage` does not imply `admin.org.read`** at the `can()` level, so
   the review-time semantics stay honest. Asserted against the real `can()`.
5. **Nav entry carries `requiredPermission`.**
6. **Export gate is unchanged**: still `admin.data.export` + `admin.org.manage`,
   still audited, still pinned to `level = 'customer'`, still ≤ 10 001 rows. This
   is a regression guard, not a new behaviour.
7. **No tier family is declared**: `admin.org.read.site` / `.self` must not exist in
   the catalogue, because §4 shows they are unenforceable — a future edit that adds
   them should fail here and force the ancestor-expansion decision first.
8. **Export-hub sensitivity** if §8.4 is adopted.

Assertion style, per the repository's existing contracts and per this project's
standing rule that source greps are not authorization tests: assert the **compiled
SQL and bound parameters** of any predicate; reserve `readFileSync` checks for
_wiring_ facts (a gate is called before a query, a route imports the shared helper)
and for the catalogue-shape assertions in (7).

---

## 10. Is a new native Permission actually necessary?

**For the export: NO.** This is the direct answer to the question as posed.

`admin.data.export` already exists, is described in the catalogue as
"tenant-wide CSV export permission, required by every export.csv route", is
asserted by all 15 export routes, and is held only by `tenant_admin`. It _is_ the
native export permission. Adding `locations.export` would:

- be the **only** module-specific export key in the catalogue, against 15 routes
  that all follow `admin.data.export` + module capability;
- duplicate `admin.data.export`'s meaning inside one module — a second ladder for
  the same question, which the architecture rules forbid;
- grant nothing that is not already expressible, because `admin.data.export`
  already reaches the route and `admin.org.manage` already scopes it to the org
  module.

A `locations.export` key would only be justified if the requirement were "export
locations **without** holding the generic data-export capability" — which would
mean deliberately exempting one module from the tenant-wide export policy. That is
a product decision, and it is not the problem here.

**For the read: YES.** `admin.org.read` is necessary, because no existing permission
expresses "may read the org structure", and the current situation is that
**nothing** does. `admin.org.manage` cannot substitute without leaving a write
capability as the read boundary — the exact semantic overlap §11 identifies.

**Net: one new native permission is necessary, and it is a read key, not an export
key.**

---

## 11. Answers to the posed questions

### A — Is a `tenant_admin` exporting tenant-wide locations native design?

**Split answer.**

- **Yes for the export.** `admin.data.export` is documented as tenant-wide by
  design, `org_units` is tenant master data, and this route has _never_ been
  Project-Scope-scoped (§2). Tenant-wide is the correct native answer, and Phase 2
  changed nothing about it.
- **No for the read.** `/locations`, `/locations/[id]` and the customer contact
  records they render are bounded by RLS alone, with no permission and no tier. That
  is not a design decision; it is a missing gate, and it is structurally identical
  to the recorded defect D2 (`people` nav entry ungated), which was closed by adding
  `people.read.all`.

### B — Is there a native `view locations ≠ export locations` distinction?

**Asymmetric, and that asymmetry is the finding.**

- **On the export side: yes.** `admin.data.export` is a distinct, tenant-wide
  capability, separate from the module capability. Only `tenant_admin` holds it.
- **On the read side: no.** There is no `locations`/`org_units` read permission at
  all, so "may view" is currently implied by "is logged in".

So the distinction exists for the act of extraction and is absent for the act of
reading — the inverse of what a data-protection review would expect.

### C — Can it be implemented with existing Permission / Role Scope?

**For the export gate: yes, and it already is** (`admin.data.export` +
`admin.org.manage` + RLS). Nothing to add.

**For a read gate: no.** No existing key means "may read the org structure", and
Role Scope cannot supply one either (§4: `self` unenforceable, `site` not
implementable without a new ladder capability, `all` expressible but needs a key).

### D — Is a minimal new native export permission needed?

**No.** See §10. `admin.data.export` is already the native, tenant-wide export
capability and the repository convention is uniform across all 15 export routes. A
`locations.export` key would be a second, module-specific export permission — a
parallel system — and would grant nothing new.

What _is_ needed is one flat **read** key, `admin.org.read`, named after the
existing `admin.audit.read` precedent.

### E — Are the People / Locations / Org Units permission boundaries consistent?

**No. Locations is the outlier, and `people` is the model to follow.**

|                          | `people`                                     | `locations` / `org_units` |
| ------------------------ | -------------------------------------------- | ------------------------- |
| List read gate           | `people.read.all` → redirect                 | **none**                  |
| Detail read gate         | `people.read.all` → `notFound()` before load | **none**                  |
| Nav `requiredPermission` | `people.read.all`                            | **none**                  |
| Row scope                | flat key, no column                          | flat key, no column       |
| Export gate              | `admin.users.manage` + `people.read.all`     | `admin.org.manage`        |
| Hub `sensitivity`        | `Restricted`                                 | `Standard`                |

**Semantic overlap found:** the two modules use **the same shape of key** for
different jobs — an `admin.*.manage` key acting as the read boundary — but only
`people` also has a proper read key. Concretely:

- `admin.users.manage` is used as the people _export_ gate **and** as the
  `customer_` `PREFIX_SCOPE` read key in analytics. So one key means "manage user
  accounts" on the people side and "may read customer contacts" on the analytics
  side.
- `admin.org.manage` is used as the locations _export_ gate **and** as the
  `org_units` / `departments` / `crews` / `trades` read key in `TABLE_SCOPE`. Same
  inversion: a write capability is the read boundary for four tables.

Neither overlap is a leak today (both keys are `tenant_admin`-only), but both make a
custom-role grant harder to review, because the key's name does not describe what it
actually grants. `admin.org.read` removes the second one. The first (`admin.users.manage`
on `customer_`) is a separate observation, out of scope here, and should be recorded
rather than changed as a side effect of this audit.

---

## 12. Verification performed

Read-only throughout. Every claim above is anchored to a file and line:

- route gates, filters, columns, limit, audit — `locations/export.csv/route.ts:1-102`
- export context — `apps/web/src/lib/auth.ts:401-406`
- list page (no gate) — `locations/page.tsx:62-77`
- detail page (no gate; `moduleScopeWhere` at `:246` is the **incidents tab**) — `locations/[id]/page.tsx:424-442`
- nav entries — `nav/registry.ts:175-194`
- catalogue keys and comments — `packages/db/src/schema/iam.ts:214-219` (`people.read.all`),
  `:49-55` (`RoleScope`, six variants), `:316-325` (`admin.*` keys, `admin.data.export` comment)
- role composition — `iam.ts` `BUILTIN_ROLES`
- `can()` and `readTierCovers` — `packages/tenant/src/index.ts:101-115, 243-253`
- `moduleScopeWhere`, `mySiteIds` — `apps/web/src/lib/visibility.ts:141-206`
- `TABLE_SCOPE` / `PREFIX_SCOPE` / `TENANT_LEVEL_TABLES` — `packages/analytics/src/server/scope.ts:311-325, 197, 551-628`
- RLS — `packages/db/src/rls.ts:105-112`
- `orgUnits` / `customerContacts` schema — `packages/db/src/schema/org.ts:24, 33-53`, `locations.ts:14-26`
- export hub — `admin/export/_entities.ts:601-625`, `page.tsx:107, 122-125`
- route history — `git log --follow` on the route, plus `git show` at `0b0aeb5a`, `5043be63`, `14ae1a47`, `51995178`
- existing contract coverage — `locations-export-scope-contract.test.ts` (25 tests)

`git status --short` and `git diff --check` were run at the end; see the handoff
message. This audit is the only file added.
