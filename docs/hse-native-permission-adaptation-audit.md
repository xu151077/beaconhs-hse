# Native Permission Adaptation Audit

> Second-round **read-only** permission architecture audit. No production code,
> test, schema, migration or existing document was modified. This file is the
> only artefact created. The previous round's
> `docs/hse-project-scope-removal-audit.md` is untouched.
>
> Product principle under audit: the final authorization model is
> `Tenant/RLS → Permission → Role Scope → Visibility Tier → Record`, with Project
> Scope removed outright. **HSE role requirements may be changed to fit that
> model.** Anything that genuinely cannot be expressed natively is to be named a
> real capability gap, not re-solved with Project Scope.

---

## 1. Executive Summary

Project Scope can be removed without inventing any new native capability. Every
module in the inventory resolves to **KEEP** or **ADAPT ROLE**.

| Conclusion                         | Verdict                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **People**                         | **ADAPT ROLE** — `people.read.all` becomes the whole tenant roster. Only 2 of 4 roles hold it.                               |
| **Safe Distance**                  | **ADAPT ROLE** — add the native tier family `tools.safe-distance.read.all/.site/.self`. The row already carries the columns. |
| **Analytics Cache**                | **SAFE** — the key is already per-member; removing Project Scope removes no discriminating power the query still uses.       |
| **Documents**                      | **KEEP** — flat `documents.read` / `documents.manage` + `status='published'` is already sufficient.                          |
| **Forms Responses**                | **KEEP** + **OPEN QUESTION** — the `read.site` Web/Analytics divergence predates Project Scope and is not touched here.      |
| **Dashboard / KPI**                | **KEEP** — `canReadAppResponses` and `TRUSTED_RESPONSE_KPI` are native permission fixes.                                     |
| **New native capability required** | **NONE**                                                                                                                     |

Two findings drive the shape of the work:

1. **Only 4 built-in roles exist**: `worker`, `foreman`, `safety_manager`,
   `tenant_admin`. None of the eight roles named in the brief
   (HSE System Administrator, HSE Manager, HSE Supervisor, HSE User, HSE Viewer)
   appears anywhere in the repository. §10 maps them onto the real four rather
   than inventing eight.

2. **People and Safe Distance are different problems, and only Safe Distance
   needs a change.** `safe_distance_records` carries `site_org_unit_id` and
   `operator_person_id` on the row, so a site tier is enforceable with a
   catalogue entry and nothing else. The `people` table carries **no** location
   or owner column, and `PERMISSION_CATALOGUE` deliberately declares only
   `people.read.all` for exactly that reason. So People is resolved by accepting
   a wider view for the two roles that can already read it — not by adding a tier.

---

## 2. Current Native Authorization Model

### 2.1 The ladder (verified, not assumed)

```
ctx.isSuperAdmin                     →  tier 'all'      (packages/tenant/src/index.ts:101)
can(ctx, `${prefix}.read.all`)       →  tier 'all'
can(ctx, `${prefix}.read.site`)      →  tier 'site'
otherwise                            →  tier 'self'      (apps/web/src/lib/visibility.ts:142)
```

`readTierCovers` (`packages/tenant/src/index.ts:243`) widens **downward** only:
`read.all` covers `read.site` and `read.self`; `read.site` covers `read.self`. No
hidden upward widening, so the permission set fully determines the tier.

### 2.2 Tiered read families actually in the catalogue (96 keys)

```
ca  compliance  equipment  hazid  incidents  inspections  journals  people  ppe  training
```

`compliance` has `.read.all` + `.read.site` (no `.self`). `people` has
**`.read.all` only**. `forms` uses the `forms.response.read.*` family; `reports`,
`dashboards`, `insights`, `tools.safe-distance`, `documents` are **flat** keys
with no read tier at all.

### 2.3 Role Scope (`packages/db/src/schema/iam.ts:49-55`)

```ts
export type RoleScope =
  | { type: 'tenant' }
  | { type: 'sites'; siteIds: string[] }
  | { type: 'team'; departmentIds: string[]; groupIds: string[] }
  | { type: 'people'; personIds: string[] }
  | { type: 'crews'; crewIds: string[] }
  | { type: 'self' }
```

`role_assignments.scope` is `jsonb NOT NULL`, exactly one variant per row. A
`(user, role)` pair is unique, so a role's scope cannot be unioned across rows.
`mySiteIds(ctx)` / `siteIdsFromScopes()` collect only `type === 'sites'`.

Five of the six variants carry no sites. `admin/users/_scope-data.ts:39,56`
offers `{type:'self'}` and **falls back to it** for any unparseable scope, so
`read.site` with `siteIds = []` is producible through the product UI.

### 2.4 RLS

`ctx.db()` runs under `withTenant(baseDb, ctx.tenantId, …)`. Root `db` requires
an explicit `withSuperAdmin` / `withTenant`. RLS is the tenant boundary; the
ladder is the intra-tenant boundary. Removing Project Scope does not touch RLS.

### 2.5 `people_assignments` — native, and stays

Introduced in `8e98f218`. Not a Project Scope table. It keeps these consumers
after Project Scope removal: `packages/compliance/src/audience.ts`,
`identity.ts`, `people/_actions/assignments.ts`, the Location-assignments tab on
`people/[id]/page.tsx`, `people-assignment-contract.test.ts`,
`people-org-relational-integrity.test.ts`, `personnel-placement-repair.ts`. What
disappears is its _authorization_ role, not the table.

---

## 3. People

### 3.1 Native People permission surface

| Key                                     | In catalogue                              | Held by                                            |
| --------------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| `people.read.all`                       | yes (`iam.ts:219`)                        | `safety_manager`, `tenant_admin` (whole catalogue) |
| `people.read.site`                      | **no**                                    | —                                                  |
| `people.read.self`                      | **no**                                    | —                                                  |
| `people.manage` (via `canManageModule`) | derived from `permissionModule('people')` | `safety_manager`, `tenant_admin`                   |

The catalogue states the reason inline (`iam.ts:214-218`):

> People — the workforce directory. `people` carries no location or owner column
> of its own, so only the tenant-wide tier is declared. A site or self tier would
> be unenforceable from this table and must not be implied: the person↔org-unit
> relationship lives in `people_assignments`, which this module deliberately does
> not read.

Both People surfaces already hard-gate on the flat key and use **no** tier:

- `people/page.tsx:65` — `if (!can(ctx, 'people.read.all')) redirect('/dashboard')`
- `people/[id]/page.tsx:268` — `if (!can(ctx, 'people.read.all')) notFound()`
- `nav/registry.ts:177` — `requiredPermission: 'people.read.all'`

**There is no `resolveVisibilityTier`, no `moduleScopeWhere` and no
`canSeeRecord` on the People module.** `projectScopePredicate` /
`recordInProjectScope` are the only row filters it has ever had
(`people/page.tsx:78`, `people/[id]/page.tsx:280`, `export.csv/route.ts:63`).

### 3.2 Who is actually affected

| Role             | `people.read.*`    | Reachable at all?            | Today                                      | After removal           |
| ---------------- | ------------------ | ---------------------------- | ------------------------------------------ | ----------------------- |
| `worker`         | none               | No — redirected / `notFound` | nothing                                    | **unchanged**           |
| `foreman`        | none               | No — redirected / `notFound` | nothing                                    | **unchanged**           |
| `safety_manager` | `.read.all`        | Yes                          | people inside their resolved Project Scope | **whole tenant roster** |
| `tenant_admin`   | `.read.all`        | Yes                          | same                                       | **whole tenant roster** |
| super-admin      | via `isSuperAdmin` | Yes                          | same                                       | **whole tenant roster** |

**The exposure is two roles, both of which are tenant-wide HSE or admin roles.**
`foreman` and `worker` never see the directory at all, so nothing widens for the
field workforce.

### 3.3 Can Role Scope express the narrower need?

| Scope                              | Expresses "people at my sites"?                                                                             | Verdict                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `{type:'sites', siteIds}`          | Only with a `people_assignments` sub-select — `people` has no org-unit column to filter on.                 | Requires new query shape                 |
| `{type:'people', personIds}`       | An explicit person list. Expresses a named set, not "my site's people".                                     | Semantically different; not a substitute |
| `{type:'self'}`                    | Would need `people.id = ctx.personId`. Correct for a person's own record, but nobody asked for a self tier. | Not the requirement                      |
| `{type:'team'}` / `{type:'crews'}` | Same sub-select problem via departments / crews.                                                            | Requires new query shape                 |

So: **no existing Role Scope expresses the requirement without a new query
shape.** That is exactly the situation the catalogue comment anticipates, which
is why only `.read.all` is declared.

### 3.4 The relevant native precedent

`ppe_items` also has no org-unit column — only `current_holder_person_id`. The
foreman holds `ppe.read.site`, and the ladder **degrades the site tier to the
holder column** rather than failing. That is a native, working pattern for "a
tiered read permission on a table with no location column". People has no
equivalent column at all, so the pattern is not available here.

### 3.5 Verdict

**ADAPT ROLE.** `people.read.all` means the whole tenant directory. The HSE
requirement "a safety manager sees only the people at the locations they are
assigned to" is **dropped**, not re-implemented.

This is defensible on its own terms: the workforce directory is master data
(names, employee numbers, job titles, hire dates) that compliance audiences,
training matrices, org charts and pickers all need in full. A safety manager who
could not see the whole roster could not run the compliance program the role
exists to own.

If a narrower directory is later required, the correct shape is **not** Project
Scope — it is a new `people.read.site` key plus a `people_assignments`
sub-select in the People query. That is a catalogue + query change, listed in
§11 as available-but-not-requested.

---

## 4. Safe Distance

### 4.1 Native permission surface

| Key                                                | In catalogue       | Held by                                |
| -------------------------------------------------- | ------------------ | -------------------------------------- |
| `tools.safe-distance.use`                          | yes (`iam.ts:281`) | **all four roles**, including `worker` |
| `tools.safe-distance.read.all` / `.site` / `.self` | **no**             | —                                      |

The catalogue comment (`iam.ts:278-280`):

> Native field calculators. Safe Distance creates auditable pressure-test
> assessments, so opening, editing, locking, printing, and exporting it all use
> one explicit capability instead of borrowing a domain permission.

`SAFE_DISTANCE_PERMISSION = 'tools.safe-distance.use'` is the single gate
(`apps/web/src/lib/safe-distance-access.ts`). There is no `prefix: 'tools'` in
`PREFIX_SCOPE`, and `safe_distance_records` is **not** a `TABLE_SCOPE` key, so
`scopeAnalyticsEntities` never governs it either.

### 4.2 Row columns — this is the decisive difference from People

`packages/db/src/schema/safe-distance.ts:68-70`:

```ts
siteOrgUnitId:        uuid('site_org_unit_id').references(() => orgUnits.id),
supervisorTenantUserId: uuid('supervisor_tenant_user_id').references(() => tenantUsers.id),
operatorPersonId:     uuid('operator_person_id').references(() => people.id),
```

Both column families are already in the generic pick-lists:

| Column               | Pick-list                         | Position                                                         |
| -------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `site_org_unit_id`   | `SITE_COLUMNS` (`scope.ts:216`)   | index 0 — first match                                            |
| `operator_person_id` | `PERSON_COLUMNS` (`scope.ts:239`) | added by `2e0d4038 fix(auth): align safe-distance project scope` |

So the row is already shaped for the native tier ladder. The only reason
`moduleScopeWhere` is not used today is that **no tiered key exists** and
`2e0d4038` reached for Project Scope instead of asking for one.

### 4.3 Option assessment (A → D, per the brief's priority order)

| Option                                                     | Assessment                                                                                                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Use the existing native visibility tier**             | **Not available as-is** — `tools.safe-distance.read.*` does not exist.                                                                                                                    |
| **B. Use existing `sites` / `people` / `self` Role Scope** | **Not available as-is** — `moduleScopeWhere` derives its filter from the _tier_, not from the scope type. Hand-writing a `siteIds` predicate would be the "custom ACL" the brief forbids. |
| **C. Permission + RLS only**                               | **Technically valid, and rejected on exposure.** `tools.safe-distance.use` is held by `worker`, so a field worker would see every pressure-test assessment in the tenant.                 |
| **D. Add a native permission mapping**                     | **Chosen** — but note this is _catalogue work_, not a capability extension.                                                                                                               |

### 4.4 What "D" actually requires

1. `PERMISSION_CATALOGUE`: add `tools.safe-distance.read.all`,
   `.read.site`, `.read.self`. Three strings. `resolveVisibilityTier`,
   `tierFor`, `readTierCovers` and `moduleScopeWhere` are all prefix-generic and
   need no change.
2. `BUILTIN_ROLES`: keep `tools.safe-distance.use` on all four roles (it is the
   _operate_ capability — open, edit, lock, print, export) and add the read tier
   per §10.
3. `PREFIX_SCOPE`: add one entry `prefix: 'tools'` with `read: { prefix: 'tools.safe-distance' }`,
   `siteCols: SITE_COLUMNS`, `personCols: PERSON_COLUMNS` — so analytics reports
   on the table get the same ladder.
4. `page.tsx` / `export.csv` / `[id]/page.tsx` / `[id]/print/page.tsx`: call
   `moduleScopeWhere` / `canSeeRecord` instead of `projectScopePredicate`.

`validateScopeSpecs` already rejects a spec that both exempts itself and declares
columns, so no exemption is needed or wanted here.

### 4.5 Not permitted, and not proposed

No `safe-distance project scope`, no exemption, no custom ACL. The §4.4 change
is three catalogue strings, one spec entry, and four call-site swaps.

### 4.6 Verdict

**ADAPT ROLE.** `tools.safe-distance.read.*` is added; `tools.safe-distance.use`
stays as the operate capability. After that, `moduleScopeWhere` + `canSeeRecord`

- RLS express the requirement natively and Project Scope is simply unnecessary.

---

## 5. Analytics Cache

### 5.1 The complete key — every dimension, not just the fingerprint

`apps/web/src/app/(app)/insights/_data.ts:53`:

```ts
const cacheKey = `${ctx.tenantId}:${access.scopeKey}:${trustScope}:${key}`
```

| Segment                     | Source                                  | Authorization dimension |
| --------------------------- | --------------------------------------- | ----------------------- |
| `ctx.tenantId`              | membership                              | **Tenant**              |
| `access.scopeKey.role`      | `ctx.activeRoleId ?? 'all'`             | Active role             |
| `access.scopeKey.roleKeys`  | `getEffectiveRoleKeys(ctx, tx)`, sorted | Effective role set      |
| `access.scopeKey.templates` | accessible Builder templates, sorted    | Template authorization  |
| `access.scopeKey.rowScope`  | `analyticsScopeFingerprint(subject)`    | Row scope (below)       |
| `trustScope`                | `'system'` \| `'user'`                  | Trusted-KPI branch      |
| `key`                       | caller-supplied card key                | Card identity + params  |

`rowScope` = `analyticsScopeFingerprint` =
`{ super, sites, person, user, projectScopeKind, orgUnitIds, projectPersonIds }`
(`scope.ts:1038`).

Only **one** cache consumes it — `CARD_RESULT_CACHE`, 60 s TTL, per process.
`grep` confirms no other `analyticsScopeFingerprint` / `analyticsAccessScopeKey`
consumer exists outside tests.

### 5.2 The permission matrix

| Permission    | Role Scope  | `rowScope` after removal                            | Distinct from other members? |
| ------------- | ----------- | --------------------------------------------------- | ---------------------------- |
| `read.all`    | `tenant`    | `{super:false, sites:[], person:P, user:U}`         | **Yes** — `U` is unique      |
| `read.site`   | `sites:[A]` | `{super:false, sites:[A], person:P, user:U}`        | **Yes**                      |
| `read.self`   | `self`      | `{super:false, sites:[], person:P, user:U}`         | **Yes**                      |
| no permission | any         | `user:U` still present; `can()` false for every key | **Yes**                      |

`read.all` and `read.self` both yield `sites: []` — but they cannot collide,
because they belong to **different `ctx.permissions` sets held by different
`ctx.membership` rows**.

### 5.3 Why the key is per-member

`analyticsScopeSubject` (`analytics-access.ts:96`):

```ts
tenantUserId: ctx.membership?.id ?? null,
```

`ctx.membership.id` is the `tenant_users` row — unique per (tenant, member).
**Two different members can never share a `rowScope`.** Since `can()` reads only
`ctx.permissions` + `isSuperAdmin`, and both are fixed for a given membership,
the permission set and therefore the tier is captured transitively. Adding
`ctx.permissions` to the key would be redundant.

**Impersonation was checked specifically**, because an admin "viewing as" someone
else is the one place a mismatch could arise. `resolveImpersonation`
(`auth.ts:344-365`) resolves the **target's** `tenantUsers` row and calls
`resolveMembershipPerms(tx, m.id)` on it, so `membership.id` is the target's, not
the actor's. Two different impersonation targets under one admin therefore get
two different keys. **No collision.**

### 5.4 Verdict: SAFE

After removing Project Scope the key is
`tenantId : {role, roleKeys, templates, rowScope:{super, sites, person, user}} : trustScope : cardKey`,
and it still discriminates every dimension that affects the result. **No change
is required.** Adding complexity "to look safer" would violate the brief.

Two residual facts, stated for honesty and not as defects:

1. `ctx.membership === null` degrades `user` to `null`. That shape is reachable
   only from API-key contexts (`ctx.apiKey` is set there), which never render
   `(app)` server components and so never reach this cache. Worth a one-line
   guard comment, not code.
2. A permission or scope change takes up to 60 s to be reflected, for that member
   only. That is staleness, not a cross-principal leak.

**What is lost:** the two Project Scope fields stop discriminating. That is
correct, not a regression — after removal `people_assignments` no longer affects
the query, so it must not affect the key either. `insights-cache-scope.test.ts`
cases E and F lose their referent and should be deleted with the rest of the
Project Scope tests; cases A–D (scope-identity) remain meaningful and stay.

---

## 6. Documents

### 6.1 Native surface

| Key                     | Shape | Held by                                               |
| ----------------------- | ----- | ----------------------------------------------------- |
| `documents.read`        | flat  | all four roles                                        |
| `documents.manage`      | flat  | `safety_manager`, `tenant_admin`                      |
| `documents.acknowledge` | flat  | `worker`, `foreman`, `safety_manager`, `tenant_admin` |
| `documents.review`      | flat  | `safety_manager`, `tenant_admin`                      |

`documentReadFilter` (`apps/web/src/lib/assistant/doc-access.ts`) is the single
authority and is **untouched** by Project Scope:

```ts
export function documentReadFilter(ctx: RequestContext): SQL | undefined {
  return canManageDocuments(ctx) ? undefined : eq(documents.status, 'published')
}
```

In `TABLE_SCOPE`, `documents` carries the Project Scope exemption
`tenant-level-document-library` and **no columns** — consistent with a controlled
document library that is tenant-wide by definition.

### 6.2 Is that sufficient for the product?

The library is a tenant-level controlled document set. Publication state is the
access axis; location is not. `documents.read` + `status='published'` for
everyone, plus `documents.manage` for full control, expresses:

- published controlled documents → every member;
- drafts and superseded versions → document managers only;
- acknowledgement tracking → `documents.acknowledge`, per member.

Nothing about the product requires a location-scoped document library. The
Project Scope four-state rule (`unrestricted` / `restricted` / `empty` /
`unknown`) added a second axis to a module that has one.

### 6.3 Business authorization that must survive

`apps/web/src/app/(app)/documents/[id]/_send-email.ts` (commit `84e18618`) is the
only outbound document-content path. It keeps, independently of any scope:

- `assertCan(ctx, 'documents.manage')`
- an explicit `eq(documents.status, 'published')` — kept explicit precisely
  because `documentReadFilter` waives publication for a manager.

### 6.4 Verdict

**KEEP.** Delete `document-project-scope.ts` and the 11 `documentAuthorizationFilter`
call sites; restore `documentReadFilter(ctx)` at each. **Add no replacement
scope.** Keep `documents.manage` + `status='published'` in `_send-email.ts`.

---

## 7. Forms Responses

### 7.1 Native semantics (unchanged, not redesigned)

`forms.response.read.all | .site | .self` is a complete native family, present
since `8e98f218` — long before Project Scope.

| Tier   | Filter                                                    |
| ------ | --------------------------------------------------------- |
| `all`  | no row filter (RLS bounds to tenant)                      |
| `site` | `site_col IN siteIds`, **unioned with own records** (Web) |
| `self` | owner / subject columns                                   |

### 7.2 The two pre-existing divergences — recorded, not touched

| #   | Divergence                                                                       | Origin                                                                               |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `read.site` + no sites scope: Web falls through to own-only; Analytics withholds | Web: `9107bd13~1` (pre-Project-Scope). Analytics: `9c5859ea:376` (pre-Project-Scope) |
| 2   | Site tier leg: Web = `site ∪ own`; Analytics = `site only`                       | Both pre-Project-Scope                                                               |

Both were confirmed last round to predate Project Scope. Per the brief they are
**not** unified here. Listed in §11 as open product questions.

Also unchanged: the `app_responses` trusted KPI is authorized by
`forms.response.read.all` **only** (`canReadAppResponses`, commit `114219ac`).
The underlying `app_responses` **entity** is native (`9c5859ea`); only its
Project Scope exemption disappears.

### 7.3 Real data exposure after removal?

**No.** The `forms.response.read.*` family is a genuine native tier family, and
`form_responses` carries `site_org_unit_id` and `subject_person_id`, so
`moduleScopeWhere` and `canSeeRecord` enforce it. Project Scope was a _second_
narrowing on top of an already-enforceable tier.

### 7.4 Verdict

**KEEP** the family and its role assignments exactly as they are.
**OPEN QUESTION** on the two divergences above.

---

## 8. Dashboard / KPI

| Item                                                      | Origin                            | Native?                                                    | Verdict                                      |
| --------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| `canReadAppResponses` = `forms.response.read.all` only    | `114219ac` (was `\|\| read.site`) | **Yes** — a `forms.response.read.*` key on a `ctx` boolean | **KEEP**                                     |
| `TRUSTED_RESPONSE_KPI = ['forms.response.read.all']`      | `f16aa3d7`                        | **Yes** — `WIDGET_PERMISSIONS` is a pure permission map    | **KEEP**                                     |
| `FORMS` (`read.all` + `read.site`)                        | pre-existing                      | Yes                                                        | **KEEP** — `canSeeOrgAggregates` consumes it |
| `runCardCached` `trustScope` + `canReadAppResponses` gate | pre-existing                      | Yes                                                        | **KEEP**                                     |

`forms.response.read.all` remains a correct gate for a tenant-wide scalar
`count`: a `read.site` viewer must not see the company total, and
`read.site + no sites scope` is withheld by Analytics anyway, which is the
fail-closed half of the pair. Neither commit depends on Project Scope — their
comments _mention_ it as justification, nothing more.

**KEEP. Do not regress.**

---

## 9. Other Project Scope Surfaces

| Module                      | Current filter                                                                        | Native expression?                                        | Verdict                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Feed**                    | `moduleScopeWhere` only — the file has **zero** direct Project Scope references       | **Yes** — `incidents` / `ca` / `hazid` families all exist | **KEEP.** Reverting `moduleScopeWhere` restores correct feed behaviour automatically                                      |
| **Journals**                | Bespoke site ladder + Project Scope on the `read.all` branch only                     | **Yes** — `journals.read.*` family exists                 | **KEEP.** `read.all` branch returns to `return undefined`; the `.site`/`.self` branches are native bespoke logic and stay |
| **Locations / `org_units`** | Project Scope applied to a `level='customer'` view                                    | `admin.org.manage` + `admin.data.export`; no read tier    | **KEEP.** Admin-only surface; the export PII question from last round is unchanged and still open                         |
| **Analytics / Reports**     | `TABLE_SCOPE` + tiers + `scopeContribution`                                           | **Yes**                                                   | **KEEP.** Remove `scopeContribution`, the exemption system and the subject scope fields                                   |
| **Assistant**               | `documentAuthorizationFilter` on 3 paths                                              | **Yes**                                                   | **KEEP** → `documentReadFilter`                                                                                           |
| **Exports (CSV)**           | Per-route; two are blocked, see §3/§4                                                 | Mixed                                                     | **ADAPT ROLE** for people + safe-distance; KEEP elsewhere                                                                 |
| **PDF / print**             | **No Project Scope reference on any PDF, print or download route**                    | n/a                                                       | **KEEP** — no change                                                                                                      |
| **Email**                   | `journals/_send-email.ts` has **0** hits; only `documents/[id]/_send-email.ts` has 1  | **Yes**                                                   | **KEEP** — `_send-email.ts` reverts to `documentReadFilter`, keeps `manage` + `published`                                 |
| **API**                     | `api/query.ts:133` `documentAuthorizationFilter`; report paths via `TABLE_SCOPE`      | **Yes**                                                   | **KEEP** → `documentReadFilter`                                                                                           |
| **Worker**                  | `report-run-as-scope.ts` threads a `projectScope` param; `reports.ts:563` resolves it | **Yes**                                                   | **KEEP.** Delete the parameter and the call                                                                               |

### 9.1 Modules with zero Project Scope dependency

`people_assignments` / compliance audience · `ppes` register · training ·
inspections · equipment · corrective actions · flow gates · attachment
finalization · the whole `@beaconhs/compliance` and `@beaconhs/reports` engines.
None appear in the 58-file inventory.

---

## 10. HSE Role Adaptation Proposal

### 10.0 A correction to the brief

The eight roles named in the brief **do not exist in this repository.** Grep
returns zero mentions of _HSE System Administrator, HSE Manager, HSE Supervisor,
HSE User,_ or _HSE Viewer_. `BUILTIN_ROLES` contains exactly four keys, and the
`roles` table explicitly supports custom slugs (`iam.ts:27`,
`isBuiltIn: boolean`). The proposal below is therefore written against the **real
four**, with the brief's archetypes mapped onto them.

| Brief archetype          | Nearest real role                      | Note                   |
| ------------------------ | -------------------------------------- | ---------------------- |
| HSE Viewer               | `worker`                               | read-only self-scope   |
| HSE User                 | `worker`                               | + create own records   |
| HSE Supervisor           | `foreman`                              | site tier              |
| HSE Manager              | `safety_manager`                       | tenant-wide H&S        |
| HSE System Administrator | `tenant_admin`                         | `PERMISSION_CATALOGUE` |
| —                        | `foreman` also covers "HSE Supervisor" | already site-tiered    |

### 10.1 `worker` — Viewer / User

|                        |                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Permission (read)**  | `forms.response.read.self`, `incidents.read.self`, `inspections.read.self`, `hazid.read.self`, `training.read.self`, `ppe.read.self`, `ca.read.self`, `journals.read.self`, `documents.read`                        |
| **Permission (write)** | `forms.response.create`, `forms.response.update.own`, `incidents.create`, `inspections.create/update`, `hazid.create/update`, `journals.create/update.own/submit`, `documents.acknowledge`, `forms.response.create` |
| **Proposed change**    | add `tools.safe-distance.read.self`                                                                                                                                                                                 |
| **Role Scope**         | `{type:'self'}` (or `{type:'crews'}` for a crew view)                                                                                                                                                               |
| **Data result**        | Own records only. After the change, only the pressure-test assessments they operated. Directory: no access.                                                                                                         |

### 10.2 `foreman` — HSE Supervisor

|                        |                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Permission (read)**  | `forms.response.read.site`, `incidents.read.site`, `inspections.read.site`, `hazid.read.site`, `ppe.read.site`, `equipment.read.site`, `ca.read.site`, `journals.read.site`, `compliance.read.site`, `training.read.all`, `documents.read`          |
| **Permission (write)** | `forms.response.create`, `incidents.create/update`, `inspections.create/update`, `hazid.create/update`, `journals.create/submit/assign`, `ca.create/update`, `ppe.issue/inspect`, `equipment.inspect`, `compliance.assign`, `documents.acknowledge` |
| **Proposed change**    | add `tools.safe-distance.read.site`                                                                                                                                                                                                                 |
| **Role Scope**         | `{type:'sites', siteIds:[…]}` — **the load-bearing field for every `.read.site`**                                                                                                                                                                   |
| **Data result**        | Records at their scoped sites, unioned with their own. Pressure tests at their sites only. Directory: still no access.                                                                                                                              |
| **Caveat**             | With a non-`sites` scope, `.read.site` degrades to own-only on Web and is withheld in Analytics — the pre-existing divergence, unchanged                                                                                                            |

### 10.3 `safety_manager` — HSE Manager

|                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Permission (read)**         | `forms.response.read.all`, `incidents.read.all`, `inspections.read.all`, `hazid.read.all`, `training.read.all`, `equipment.read.all`, `ppe.read.all`, `ca.read.all`, `journals.read.all`, `compliance.read.all`, `people.read.all`, `documents.read`                                                                                                                                                                                                                                              |
| **Permission (write/manage)** | `incidents.investigate/close`, `inspections.manage`, `hazid.review`, `training.course/class/record/matrix.manage`, `equipment.manage` + workorder create/close, `ppe.manage/issue/return/inspect/return_to_service`, `ca.verify`, `journals.create/submit/assign`, `compliance.manage/assign`, `documents.manage/acknowledge/review`, `reports.builder/schedule`, `dashboards.edit`, `insights.create/publish`, `forms.template.create/publish`, `forms.ai.generate`, `admin.integrations.manage` |
| **Proposed change**           | add `tools.safe-distance.read.all`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Role Scope**                | `{type:'tenant'}` — no narrowing needed; every read key is `.read.all`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Data result**               | **Whole-tenant records, including the whole workforce directory.** This is the one accepted widening, and it is the role that owns the compliance program                                                                                                                                                                                                                                                                                                                                         |

### 10.4 `tenant_admin` — HSE System Administrator

|                               |                                                                         |
| ----------------------------- | ----------------------------------------------------------------------- |
| **Permission (read)**         | `PERMISSION_CATALOGUE` in full (96 keys, unchanged)                     |
| **Permission (write/manage)** | same                                                                    |
| **Proposed change**           | none — inherits the new `tools.safe-distance.read.*` keys automatically |
| **Role Scope**                | `{type:'tenant'}`                                                       |
| **Data result**               | Whole tenant, every module. Unchanged                                   |

### 10.5 Role Scope matrix

| Role             | Scope                         | Effect                                                                                |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| `worker`         | `{type:'self'}`               | self tiers; no site ids, so any `.read.site` they hold would degrade — they hold none |
| `foreman`        | `{type:'sites', siteIds:[…]}` | **the only field that makes `.read.site` meaningful**                                 |
| `safety_manager` | `{type:'tenant'}`             | not consulted: every read key is `.read.all`                                          |
| `tenant_admin`   | `{type:'tenant'}`             | same                                                                                  |

`{type:'team'}` and `{type:'people'}` remain available for custom roles and are
already used by the scope picker. `{type:'crews'}` is the natural fit for a
`worker` who should see their crew rather than only themselves.

### 10.6 Modules with zero role change

`incidents` · `corrective_actions` · `hazid` · `inspections` · `training` ·
`equipment` · `ppe` · `journals` · `compliance` · `documents` · `forms` ·
`reports` · `dashboards` · `insights` · `assistant` — all keep their current
permission sets and Role Scope semantics. Only `people` (widening accepted) and
`tools.safe-distance` (tier family added) change.

---

## 11. True Native Capability Gaps

**None.**

Every requirement in the inventory resolves to KEEP or ADAPT ROLE. Recorded for
completeness, and available on request — **not** proposed, and **not** to be
solved with Project Scope:

| #   | Candidate                                       | Why it is not needed now                                                  | If it were ever requested                                                                                                                                                    |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `people.read.site` (personnel-scope sub-select) | Only 2 tenant-wide roles can read the directory, and both need it in full | Add the key + a `people_assignments` sub-select in the People query. Changes no existing tier semantics; backward compatible because a new key grants nothing until assigned |
| 2   | Project/org-unit scoping for API keys           | `api-keys` has no scope column and the brief forbids implying one         | A real capability gap, but it is about **API keys**, not about Project Scope. Out of scope here                                                                              |

---

## 12. Recommended Execution Order

Each step is independently shippable and independently verifiable.

| #   | Step                                                                                                                                                                                                                                                        | Risk                                                                               | Gates to run                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Add `tools.safe-distance.read.all/.site/.self` to `PERMISSION_CATALOGUE`; add the tier per role (§10); add the `prefix: 'tools'` entry to `PREFIX_SCOPE`                                                                                                    | Low — additive keys grant nothing until assigned                                   | `format:check typecheck lint test deadcode:check build`           |
| 2   | Switch the four Safe Distance surfaces to `moduleScopeWhere` / `canSeeRecord`                                                                                                                                                                               | Low — a real filter is added, replacing a real filter                              | + `pnpm --filter @beaconhs/web test`                              |
| 3   | Delete the 7 dedicated Project Scope modules and 2 verification scripts                                                                                                                                                                                     | Low — nothing imports them after step 5                                            | + `deadcode:check`                                                |
| 4   | Restore the 11 document call sites to `documentReadFilter`; keep `_send-email.ts` as-is                                                                                                                                                                     | Low                                                                                | web tests                                                         |
| 5   | Revert `visibility.ts` to the `9107bd13~1` bodies; revert the `scope.ts` tier branch to `9c5859ea`; drop `scopeContribution` / exemptions / subject scope fields; update the 8 analytics re-exports, the web subject, the worker param and `reports.ts:563` | **Medium** — the single densest edit                                               | full gate set; `scope.test.ts` split must land in the same commit |
| 6   | Resolve the People filter: delete the three `projectScopePredicate` / `recordInProjectScope` uses and accept the tenant-wide roster                                                                                                                         | **Medium** — a deliberate, recorded widening for `safety_manager` / `tenant_admin` | full gate set + a new test asserting the accepted behaviour       |
| 7   | Revert the journals `read.all` branch to `return undefined`                                                                                                                                                                                                 | Low — restores the pre-15B-2 model                                                 | journals + analytics tests                                        |
| 8   | Split the 12 mixed test files; delete the Project-Scope-only ones; drop `insights-cache-scope.test.ts` E/F                                                                                                                                                  | Low                                                                                | full gate set                                                     |
| 9   | Rewrite the People and Oversight manual articles + recompile `en`/`es`/`fr`; retire `docs/hse-project-scope-15b3-audit.md`                                                                                                                                  | Low but mandatory — the current articles assert the opposite of the target model   | `format:check` on the JSON                                        |

Do **not** `git revert` `84e18618`, `114219ac` or `f16aa3d7` — each holds a native
security fix. Do not revert `d6080b7d`; it is Prettier-only.

---

## 13. Risks

| #   | Risk                                                                                             | Severity                | Mitigation                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **People roster widens for `safety_manager` / `tenant_admin`**                                   | **High (accepted)**     | Both are tenant-wide roles. Record the decision in the People manual article and in a test that asserts the roster is tenant-wide, so it is a stated contract rather than a silent consequence                                                                            |
| 2   | **Safe Distance widens to the whole tenant if step 1 is skipped**                                | **High**                | `tools.safe-distance.use` is held by `worker`. Steps 1 and 2 must land together; never delete the Project Scope filter before the tier family exists                                                                                                                      |
| 3   | **Manual articles become false**                                                                 | **High (user-visible)** | `oversight-admin.ts` asserts "A read-all permission is not the whole company" and "an account with no location assignment reaches nothing"; `people.ts` asserts "no active assignment sees an empty directory". All three become false. Step 9 is mandatory, not cosmetic |
| 4   | The pre-existing `read.site` divergence is mistaken for a removal regression                     | Medium                  | The 15B-3C audit already records it; state it again in the removal commit message                                                                                                                                                                                         |
| 5   | `insights-cache-scope.test.ts` E/F deleted without a replacement                                 | Medium                  | E/F only existed because `empty` and `unrestricted` collided. With no `empty` state there is nothing to collide with. §5.3 is the written argument; keep it                                                                                                               |
| 6   | `PERMISSION_CATALOGUE.length` is asserted as `96` in `ppe-read-tier-contract.test.ts`            | Low                     | Step 1 changes it to `99`; update the test in the same commit                                                                                                                                                                                                             |
| 7   | `insights-cache-scope.test.ts` subject factory has a `projectScopeKind` default                  | Low                     | Remove the field with the rest                                                                                                                                                                                                                                            |
| 8   | `2e0d4038` added `operator_person_id` to `PERSON_COLUMNS` for Project Scope                      | Low                     | Under §4.4 it is **kept**, because the new `tools.safe-distance.read.self` tier needs it. If step 1 is rejected, remove it instead                                                                                                                                        |
| 9   | A future reader reinstates Project Scope because "the analytics ladder has no project dimension" | Low                     | §1 and §11 of this report state plainly that no native capability is missing                                                                                                                                                                                              |
| 10  | The pre-existing 20 `.opencode/**/*.md` Prettier failures keep `format:check` red                | Medium (unrelated)      | `AGENTS.md` rule 8 forbids suppressing a gate. Must be resolved on its own before any removal commit is called green                                                                                                                                                      |

---

## 14. KEEP / ADAPT ROLE / NEW NATIVE CAPABILITY

### KEEP

```
Documents            flat documents.read / documents.manage + status='published'
Forms Responses      forms.response.read.all | .site | .self, unchanged
Dashboard / KPI      canReadAppResponses, TRUSTED_RESPONSE_KPI, FORMS, trustScope
Feed                 moduleScopeWhere only — no direct Project Scope
Journals             bespoke site/self ladder; read.all branch reverts to undefined
Locations            admin.org.manage + admin.data.export
Analytics / Reports  TABLE_SCOPE + PREFIX_SCOPE + tiers
Assistant            documentAuthorizationFilter -> documentReadFilter
API                  documentAuthorizationFilter -> documentReadFilter; reports via TABLE_SCOPE
Worker               drop the projectScope parameter and the reports.ts call
PDF / print          no Project Scope dependency anywhere
Email                documents/_send-email.ts keeps manage + explicit published
people_assignments   native table, keeps compliance/audience/UI consumers
RLS                  untouched
Analytics cache key  per-member via ctx.membership.id; impersonation rebases correctly
```

### ADAPT ROLE

```
people          ADOPT people.read.all as "whole tenant directory".
                Drop the HSE requirement that a safety manager sees only their
                assigned locations' people. No new permission.

tools.safe-distance
                ADD tools.safe-distance.read.all / .read.site / .read.self.
                ADD the prefix: 'tools' entry to PREFIX_SCOPE.
                ASSIGN: worker -> .read.self
                        foreman -> .read.site
                        safety_manager -> .read.all
                        tenant_admin -> inherits the full catalogue
                KEEP tools.safe-distance.use on all four as the operate capability.
                SWITCH the 4 surfaces to moduleScopeWhere / canSeeRecord.
```

### NEW NATIVE CAPABILITY

**None.** §11 records two candidates that are available on request and are not
needed now. Project Scope is not proposed for anything.

### OPEN PRODUCT QUESTION (not decided here)

```
read.site + no {type:'sites'} scope
  Web       own-only fallback   (9107bd13~1)
  Analytics withheld             (9c5859ea:376)
  Both predate Project Scope. Not unified by this work.

site-tier leg
  Web       site UNION own
  Analytics site only
  Also pre-dates Project Scope. Independent of the above.
```

---

## 15. Verification

Read-only commands only. No production code, test, schema, migration, existing
document or git history was modified. See the handoff summary for the
`git status --short` / `git diff --check` output.
