# 15B-3 Impact Audit — Analytics, Exports, Public API, Worker, Cache

Baseline: `9107bd13 feat(auth): complete project scope authorization bridge`
Audit type: **read-only**. No application code, schema, migration, or seed was
modified. No file was staged or committed.

15B-2 wired Project Scope into the three ladder entry points
(`moduleScopeWhere`, `canSeeRecord`, `recordVisibilityWhere`). This audit asks
one question about everything 15B-2 did **not** reach: does a maximal permission
still discard scope there?

**The answer is yes, in five places.** Two of them were not in the 15B-1 audit.

---

## 1. S4 and S5 are the same short-circuit, not two bugs

The 15B-1 plan named S4 (analytics `resolveEntity`) and S5 (`tierFor` + flat
permission keys) as separate work items. They are one defect in one function.

`packages/analytics/src/server/scope.ts:392-398`:

```ts
392  function resolveEntity(subject: AnalyticsScopeSubject, entity: AnalyticsEntity): Resolution {
393    const spec = resolveScopeSpec(entity.table)
394    if (!spec || spec.read === null) return { visible: false }
395
396    const tier = tierFor(subject, spec.read)
397    if (tier === 'none') return { visible: false }
398    if (tier === 'all') return { visible: true, filter: undefined }   // ← THE SHORT-CIRCUIT
```

`tierFor` (`:349-357`) maps a tiered read key to a tier:

```ts
353    if (subject.permissions(`${prefix}.read.all`)) return 'all'
```

and a flat key is `'all'` or `'none'` (`:351`) — there is no middle tier.

So **both** the tiered path (S5) and the flat-key path (S4) converge on line
398, and line 398 returns `filter: undefined`. `undefined` means "no
`baseFilter` is written", so the entity's rows are unfiltered except by RLS.

`filter: undefined` is the _mechanism_; `tier === 'all'` is the _cause_. Fixing
one without the other changes nothing.

### Contrast: the 15B-2 fix, same shape, opposite outcome

`apps/web/src/lib/visibility.ts:205-209` handles the identical `tier === 'all'`
case:

```ts
205    // An empty Project Scope is terminal: nothing a permission can grant is visible
206    // inside no scope. Returning the visibility predicate here would be a leak.
207    if (isAlwaysFalse(scopeCond)) return scopeCond
208
209    if (tier === 'all' || othersTier) return scopeCond
```

Line 209 returns `scopeCond` — the Project Scope predicate. Line 398 in
analytics returns `undefined`. **The two ladders give different answers for the
same caller holding the same permission.** That divergence is the bug.

### The subject already carries everything needed

15B-2 extended `AnalyticsScopeSubject` (`scope.ts:31-64`) with three fields
precisely so this could be fixed later:

| field               | line  | purpose                                             |
| ------------------- | ----- | --------------------------------------------------- |
| `orgUnitIds?`       | `:51` | Project Scope org units                             |
| `projectPersonIds?` | `:53` | Project Scope people                                |
| `projectScopeKind?` | `:63` | `unrestricted` / `empty` / `restricted` / `unknown` |

`resolveEntity` reads **none** of them today. They currently affect only
`analyticsScopeFingerprint` (`:459-476`). **No type change is required to fix
S4/S5** — the plumbing is already in place and unused.

---

## 2. Bound vs unbound: the distinction that decides the fix

Not every entity can be narrowed. A row predicate needs a column to bind to.

| entity                                                           | Project Scope can apply? | why                                                                                         |
| ---------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| **bound** — spec declares `siteCols` / `personCols` / `userCols` | **yes**                  | the adapter already handles any subset of these; `projectScopePredicate` needs at least one |
| **unbound** — flat key, no columns                               | **no**                   | there is no column to filter on, and inferring one from a table name would be a guess       |

Every **tiered** spec is bound. Verified: no `prefix` spec lacks all three
column lists.

**The rule for unbound entities is fail-closed, not permissive.** A restricted
caller must get `{ visible: false }` — the entity disappears from the catalogue
entirely. There is already a precedent for exactly this in the same function:

```ts
404    if (tier === 'site' && siteCol) {
405      if (subject.siteIds.length === 0) return { visible: false }
406      return { visible: true, filter: rule(siteCol, subject.siteIds) }
407    }
```

Line 405 withholds because the scope cannot be expressed. The `tier === 'all'`
branch must gain the same discipline.

### The four Project Scope states, and what each must do

| state                  | bound entity                                      | unbound entity                  |
| ---------------------- | ------------------------------------------------- | ------------------------------- |
| `unrestricted`         | no filter — tenant-wide is **explicitly correct** | no filter — correct             |
| `restricted`           | AND the Project Scope predicate                   | **withhold** (`visible: false`) |
| `empty`                | `false` / withhold                                | **withhold**                    |
| unresolved (`unknown`) | withhold                                          | withhold                        |

**`empty` must never be treated as `unrestricted`.** This is the exact collision
the 15B-2 cache tests caught (`insights-cache-scope.test.ts`): both produce
empty id lists. The `projectScopeKind` discriminator exists solely to keep them
apart, and an `unknown` (not-yet-resolved) state must fail closed too — an
absent scope is not evidence of a wide one.

---

## 3. The 16 unbound flat-key specs

`read: { key: … }` with no `siteCols` / `personCols` / `userCols`. For a
restricted Project Scope subject, **all 16 currently read tenant-wide**.

`PREFIX_SCOPE` (`scope.ts:110`) — 9 of them:

| line   | entity prefix   | permission key            |
| ------ | --------------- | ------------------------- |
| `:155` | `document_`     | `documents.read`          |
| `:158` | `compliance_`   | `compliance.read`         |
| `:162` | `person_`       | `admin.users.manage`      |
| `:163` | `people_`       | `admin.users.manage`      |
| `:164` | `customer_`     | `admin.users.manage`      |
| `:165` | `job_title`     | `admin.users.manage`      |
| `:169` | `role`          | `admin.users.manage`      |
| `:172` | `insight_`      | `insights.read`           |
| `:192` | `safe_distance` | `tools.safe-distance.use` |

`TABLE_SCOPE` (`scope.ts:216`) — 7 of them:

| line   | table                  | permission key       |
| ------ | ---------------------- | -------------------- |
| `:221` | `documents`            | `documents.read`     |
| `:222` | `people`               | `admin.users.manage` |
| `:233` | `vehicle_log_settings` | `equipment.read.all` |
| `:236` | `org_units`            | `admin.org.manage`   |
| `:237` | `departments`          | `admin.org.manage`   |
| `:238` | `crews`                | `admin.org.manage`   |
| `:239` | `trades`               | `admin.org.manage`   |

### The one bound flat key, for contrast

```ts
139  ['ppe_', { read: { key: 'ppe.read.all' }, siteCols: SITE_COLUMNS, personCols: PERSON_COLUMNS }],
```

Flat keys are not inherently unscopable — `ppe_` proves it. The 16 above are
unbound because the entity genuinely has no location or owner column.

### Why this is the highest-risk item in 15B-3

`documents`, `compliance`, `org_units`, `departments`, `crews`, `trades` are
**administrative catalogue tables**. Withholding them from every restricted
caller means an Insights Card or a saved report that references `departments`
stops returning rows — not because of a bug, but because the scope genuinely
cannot be applied.

Two sub-cases, and they are not the same:

- **`org_units` / `departments` / `crews` / `trades`** — these _are_ the scope
  definition domain. A caller restricted to Site A arguably should see only the
  org units in their own scope. That is a **product decision**, not a
  mechanical fix.
- **`documents` / `compliance` / `insights`** — records that have no location
  column. Withholding is the only safe answer, but it may remove data users
  currently rely on.

**This must be decided before code is written**, not discovered by a test.

---

## 4. Two further parallel ladders — not in the 15B-1 audit

The 15B-1 impact audit found five short-circuits and 15B-2 fixed three. While
tracing the analytics divergence I found **two more hand-rolled tier ladders
that 15B-2 did not wire**, because they do not call `moduleScopeWhere`.

### 4.1 `journalScopeWhere` — `apps/web/src/app/(app)/journals/_lib.ts:33-54`

```ts
33  export function journalScopeWhere(ctx, authorPersonId): SQL | undefined {
37    if (journalCanReadAll(ctx)) return undefined     // ← journals.read.all ⇒ tenant-wide
…
45    if (can(ctx, 'journals.read.site')) {
46      const siteIds = ctx.scopes.flatMap((s) => (s.type === 'sites' ? s.siteIds : []))
…
53    return ownWhere ?? sql`false`
```

`journalCanReadAll` is `:13-15` — `ctx.isSuperAdmin || can(ctx,'journals.read.all')`.
Line 37 returns `undefined` with **no Project Scope check at all**. The file
contains zero references to `projectScope` or `resolveProjectScope`.

**9 call sites**, all inheriting the gap:

- `journals/_data.ts:127`, `:283`, `:339`
- `journals/_actions.ts:86`
- `journals/_send-email.ts:35`
- `journals/_lib.ts:78`
- `journals/records/_tag-picker-actions.ts:18`
- `feed/_data.ts:135`, `:414`

Note the irony: `visibility.ts:131` cites this function as the _original_ that
`moduleScopeWhere` generalises, and the generalisation was never applied back to
it.

**Status: FIXED in 15B-3C-4B.** Everything above is retained unchanged as the
historical record of the finding; the resolution follows.

#### Resolution — 15B-3C-4B

##### Original finding

Unchanged from the audit above. The `.all` branch returned `undefined`, so a
caller holding `journals.read.all` with a restricted Project Scope read every
journal in the tenant, from all 9 call sites. This was a real authorization gap,
not a cosmetic divergence.

##### Root cause

The pre-15B-2 model treated a `.all` read tier as "no row filter". Since 15B-2 a
Project Scope is a dimension **orthogonal** to the read tier, and the canonical
ladder applies it even at tier `all` (`lib/visibility.ts`, `if (tier === 'all')
return scopeCond`). `journalScopeWhere` predated that and was never migrated.

##### Implemented fix

Only the one escaping branch was changed. Journals were **not** migrated wholesale
onto `moduleScopeWhere`:

```ts
if (journalCanReadAll(ctx)) {
  const projectScope = await resolveProjectScopeIn(ctx, tx)
  return projectScopePredicate(projectScope, {
    orgUnitCol: journalEntries.siteOrgUnitId,
    personCol: journalEntries.personId,
  })
}
```

Two imports were added: `resolveProjectScopeIn` (`@/lib/project-scope`) and
`projectScopePredicate` (`@/lib/project-scope-predicate`). No new helper was
created, and no second Project Scope implementation was introduced.

##### Preserved invariants

The fix deliberately did **not** touch journals' own semantics, which
`moduleScopeWhere` does not share. Verified unchanged:

- `.site` branch — still `ctx.scopes` bare site ids + `or(siteWhere, ownWhere)`
- `.self` / own-entry leg — `personId` OR `createdByTenantUserId`, visible at
  every tier
- no-permission fall-through — still `ownWhere ?? sql\`false\`` (fail closed)
- `super-admin` sentinel in `authorTenantUserId` — still short-circuits to `null`
- `getAuthorPersonId` soft-deleted employee exclusion — still `isNull(people.deletedAt)`
- `journalByAuthorWhere` author filter and its `sql\`false\`` fallback
- tenant isolation / RLS — the predicate only ever narrows the RLS-bounded rowset
- mutation authorization — `journalMutationScope`, `journalSelfScopeWhere`,
  `mutationWhere` untouched
- PDF route — still delegates to `getEntry` and inherits its scope
- email path — still bound by `journalScopeWhere`; `canEmailJournal` remains the
  caller's gate
- feed journal legs — still `journalScopeWhere`, **not** routed to canonical
  `moduleScope`

A wholesale migration would also have closed the `.site` / `.self` under-exposure,
but it would have bound the own-entry leg to the scope and broken the first six
items above. That remains a product decision, tracked separately.

##### tx propagation

Project Scope resolution needs a transaction, so `journalScopeWhere` and
`journalAuthorScopeWhere` became `async` + `tx`, and all 11 call sites were
threaded. Three positions had no reusable transaction — their predicate is
consumed by queries that each open their own — and were given a minimal dedicated
`ctx.db` transaction that resolves the predicate and ends immediately, with **no
data query inside it**:

- `journals/_data.ts` — target-author scope (`getWorkspaceData`)
- `journals/_actions.ts` — `scopedWhere`
- `journals/records/_tag-picker-actions.ts` — `reviewerScope`

The remaining sites reuse an existing transaction, either directly or by moving
the single predicate-construction statement inside the `ctx.db` block that was
already its only consumer. No transaction boundary, lifetime, or existing query
was widened.

##### Affected files — 6 production

- `apps/web/src/app/(app)/journals/_lib.ts`
- `apps/web/src/app/(app)/journals/_data.ts`
- `apps/web/src/app/(app)/journals/_actions.ts`
- `apps/web/src/app/(app)/journals/records/_tag-picker-actions.ts`
- `apps/web/src/app/(app)/journals/_send-email.ts`
- `apps/web/src/app/(app)/feed/_data.ts`

##### Tests — 3 files

- `apps/web/src/lib/journals-scope-contract.test.ts` — **new**, 45 tests, Cases
  A–M. Narrowing is asserted behaviourally by executing the canonical pipeline
  and reading the compiled SQL and its bound parameters; the wiring is asserted
  structurally against brace-matched function/branch bodies, because
  `journalScopeWhere` is not importable from the vitest runner (no `@/*` alias).
- `apps/web/src/lib/feed-scope-contract.test.ts` — source-contract assertion
  synchronised for the `tx` propagation.
- `apps/web/src/lib/picker-scaling-contract.test.ts` — stale call-form assertion
  corrected; original intent preserved and strengthened to pin the dedicated
  transaction plus the awaited `tx`.

##### Verification

| Gate  | Command                                            | Result                                                      |
| ----- | -------------------------------------------------- | ----------------------------------------------------------- |
| B     | focused contract tests                             | 58/58 pass                                                  |
| C     | `pnpm --filter @beaconhs/web test`                 | 211 files / **1572 tests** pass                             |
| D     | `pnpm typecheck`                                   | 26/26 tasks, 0 errors                                       |
| E     | `pnpm lint`                                        | pass (`eslint .`)                                           |
| F     | `pnpm deadcode:check`                              | pass (knip)                                                 |
| G     | `pnpm --filter @beaconhs/db check:migration-drift` | pass — `No NEW drift`, index `0041`                         |
| H     | `pnpm format:check`                                | **exit 1 — known pre-existing failure** (see residual note) |
| I     | 4B integrity re-check                              | 6/6 pass                                                    |
| J / K | final git + boundary checks                        | pass                                                        |

**Mutation testing: M1–M5, 5/5 CAUGHT.** M1 delete the Project Scope predicate;
M2 break the restricted-scope column binding; M3 delete the `super-admin`
sentinel; M4 delete the soft-deleted employee guard; M5 restore the old
`.all → return undefined`. Each mutation was applied to the real file, the
focused test was confirmed to fail, and the file was restored; all 8 tracked
files matched their pre-mutation SHA256 afterwards.

**Schema / migration: unchanged.** 0 diff, journal entries = 41, last idx = 40.

##### Residual notes

- **Gate H is a pre-existing repository formatting defect, not a 4B regression.**
  `pnpm format:check` exits 1 on exactly 20 `.opencode/**/*.md` files (9
  `agents/*.md` + 11 `skills/*/SKILL.md`). The 4B files pass a targeted Prettier
  check 9/9, and this batch has **0 diff** under `.opencode`. Not addressed here.
- The `.site` and `.self` branches remain **unscoped** — bare `ctx.scopes` ids
  with no org-tree walk and no personnel-placement expansion, so they
  under-expose relative to the canonical ladder. That is a correctness gap, not a
  security one; closing it is the product decision noted above.
- The `journalScopeWhere` gap recorded in §4.1 is closed. The parallel ladder in
  **§4.2 (`moduleScope`) is a separate finding** and is not part of 15B-3C-4B.

### 4.2 `moduleScope` — `apps/web/src/app/(app)/feed/_data.ts:50-65`

```ts
50  function moduleScope(ctx, base, siteCol, actorCol): ModuleScope {
56    if (can(ctx, `${base}.all`)) return undefined      // ← tenant-wide
57    if (can(ctx, `${base}.site`)) {
58      const siteIds = ctx.scopes.flatMap(…)
59      return siteIds.length ? inArray(siteCol, siteIds) : sql`false`
…
64    return 'none'
```

**6 call sites**: `feed/_data.ts:173`, `:220`, `:320`, `:424`, `:445`, `:485`.
No Project Scope reference in the file.

Its own doc comment (`:44-49`) states:

> "The dashboard metrics were the last other caller of this duplicate and now
> use the canonical one too, so there is a single tier ladder."

**That claim is now false**, and it was false before this audit: the Dashboard
migration happened, but the feed's own private copy was left behind. The comment
is a trap for the next reader and should be corrected when the code is.

Both files are the **Activity feed and Journals** — the two most-read surfaces
for a frontline worker, and exactly the audience 15B-2's people/placement work
was built for. A `foreman` with `journals.read.all` currently sees every journal
in the tenant.

**Status: FIXED in 4A.** Everything above is retained unchanged as the historical
record of the finding.

The fix for this ladder landed in **15B-3C-4A**, not in 4B:

- 4A completed the feed `moduleScope` Project Scope propagation.
- The fix is contained in the current HEAD, commit `6d3a1fbc`.
- **15B-3C-4B did not modify this ladder.** 4B addressed only the journals
  `journalScopeWhere` `.all` branch Project Scope gap recorded in §4.1; see the
  Resolution block there.

No new technical conclusion is added here — this note records status only.

---

## 5. Consistency matrix: Analytics / Reports / Dashboard / UI

| surface                         | authorization                                     | tier ladder  | Project Scope      | data source              | cache               | required change  | risk     |
| ------------------------------- | ------------------------------------------------- | ------------ | ------------------ | ------------------------ | ------------------- | ---------------- | -------- |
| **UI module lists** (68 sites)  | `moduleScopeWhere`                                | full         | **yes** ✅         | module tables            | none                | none             | —        |
| **UI detail pages** (45 sites)  | `canSeeRecord`                                    | full         | **yes** ✅         | module tables            | none                | none             | —        |
| **People list + detail**        | `moduleScopeWhere` / `recordInProjectScope`       | full         | **yes** ✅ (15B-2) | `people`                 | none                | none             | —        |
| **Dashboard metrics**           | `moduleScopeWhere` ×10                            | full         | **yes** ✅         | `_metrics.ts:400-431`    | none                | none             | —        |
| **Analytics** (Insights)        | `resolveAnalyticsEntities`                        | S4/S5 broken | **no** ❌          | BHQL `runBhql`           | `CARD_RESULT_CACHE` | `scope.ts:398`   | **high** |
| **Reports (interactive)**       | `resolveAnalyticsAccess` → `report-catalog.ts:12` | S4/S5 broken | **no** ❌          | `runBeaconReport`        | none                | same line 398    | medium   |
| **Reports (scheduled, worker)** | `scopeReportSourcesForRunAs`                      | S4/S5 broken | **no** ❌          | same                     | none                | same + §7        | medium   |
| **Journals**                    | `journalScopeWhere`                               | private copy | **no** ❌          | `journal_entries`        | none                | `_lib.ts:37`     | **high** |
| **Activity feed**               | `feed` `moduleScope`                              | private copy | **no** ❌          | several                  | none                | `_data.ts:56`    | **high** |
| **Compliance obligations list** | none — tenant-wide by construction                | —            | **no** ❌          | `compliance_obligations` | none                | product decision | low      |

### Are the three surfaces consistent today? **No.**

The same caller, the same permission, three different answers:

- UI list → Project Scope applied
- Dashboard metric → Project Scope applied
- Insights card → **entire tenant**
- Report → **entire tenant**

A `foreman` assigned to Site A sees 8 people in the People directory and 100 in
a card that counts `ppe_items` company-wide. **Dashboard is the only surface
that can serve as the correctness oracle**, because it is the only one already
correct — which is what makes it valuable as the test reference for 15B-3B.

### The Reports chain, verified

```
reports/definitions/[id]/export/route.ts:29   assertCan(ctx, 'reports.read')
                                    :54   runReportForViewer(ctx, definition, …)
reports/_run.ts:8                           loadAuthorizedReportCatalogInTransaction
lib/report-catalog.ts:6                     resolveAnalyticsAccess   ← the S4 boundary
```

So the report **execution** path runs through the same `resolveEntity` as
Insights. One fix at `scope.ts:398` repairs both. The export route's
`assertCan('reports.read')` is a _gate_, not a row predicate — it never
substitutes for scoping.

---

## 6. The 15 export routes

Measured: permission asserted + whether a row predicate is applied.

| #   | route                                 | permission                         | row predicate                                                              | classification                                         |
| --- | ------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | `incidents/export.csv`                | `incidents.read.all`               | `moduleScopeWhere` (`:50`, `siteCol: incidents.siteOrgUnitId`)             | ✅ **already scoped**                                  |
| 2   | `corrective-actions/export.csv`       | `ca.read.all`                      | `moduleScopeWhere` (`:56`, `siteCol`)                                      | ✅ **already scoped**                                  |
| 3   | `inspections/export.csv`              | `inspections.read.self`            | `moduleScopeWhere` (`:77`, `siteCol`)                                      | ✅ **already scoped**                                  |
| 4   | `equipment/export.csv`                | `equipment.read.site`              | `moduleScopeWhere` (`:49`, `siteCol: equipmentItems.currentSiteOrgUnitId`) | ✅ **already scoped**                                  |
| 5   | `apps/responses/export.csv`           | `forms.response.read.all`          | `moduleScopeWhere` (`:82`, `personCol: formResponses.subjectPersonId`)     | ✅ **already scoped**                                  |
| 6   | `people/export.csv`                   | `admin.users.manage` (`:47`)       | **none**                                                                   | 🔧 **needs person predicate** — `personCol: people.id` |
| 7   | `ppe/export.csv`                      | `ppe.read.all` (`:55`)             | **none**                                                                   | 🔧 **needs holder join** — R5                          |
| 8   | `journals/export.csv`                 | `journals.read.self`               | `listEntries` → `journalScopeWhere`                                        | ❌ **tenant-wide via §4.1**                            |
| 9   | `documents/export.csv`                | `documents.manage`                 | **none**                                                                   | ⚠️ **intrinsically unscoped**                          |
| 10  | `locations/export.csv`                | `admin.org.manage` (`:34`)         | **none**                                                                   | ⚠️ **scope definition domain**                         |
| 11  | `equipment/vehicle-log/export.csv`    | `equipment.read.all` (`:38`)       | **none**                                                                   | 🔧 **needs predicate**                                 |
| 12  | `training/courses/export.csv`         | `training.read.all`                | **none** (`training_courses`)                                              | ❓ **product decision** — catalogue, not records       |
| 13  | `tools/safe-distance/export.csv`      | `SAFE_DISTANCE_PERMISSION` (`:42`) | **none**                                                                   | ⚠️ **intrinsically unscoped**                          |
| 14  | `insights/cards/[id]/export/route.ts` | _(none asserted)_                  | `runAuthorizedBhql` (`:9`)                                                 | ➖ **fixed by S4**                                     |
| 15  | `reports/definitions/[id]/export`     | `reports.read` (`:29`)             | `runReportForViewer` → S4                                                  | ➖ **fixed by S4**                                     |

### Classification totals

- **already scoped (5)** — 1, 2, 3, 4, 5
- **requires person predicate (2)** — 6 `people`, and 12 if treated as records
- **requires PPE holder join (1)** — 7
- **intrinsically unscoped (2)** — 9 `documents`, 13 `tools.safe-distance`
- **fixed by S4 automatically (2)** — 14, 15
- **fixed by the two private ladders (1)** — 8
- **needs a predicate added (1)** — 11
- **requires an explicit product decision (1)** — 10 `locations`, plus 12

### R5 — the PPE case, and the constraint that governs it

`ppe_issue_reports` has **no person column**. The holder is reachable only by
joining `item_id → ppe_items.current_holder_person_id`.

**`people_assignments` semantics must not change, and no `person_id` column may
be added to `ppe_issue_reports`.** The join is the only correct route, and
`projectScopePredicate`'s `personCol` accepts a sub-select expression, so no
schema change is needed.

### The `admin.*.manage` question, unresolved

`people/export.csv:47` asserts `admin.users.manage` — an **administrative**
permission, not a read tier. Two defensible answers:

- **Export is an administrative act.** An org administrator legitimately exports
  the whole roster. Project Scope should not apply, and the current code is
  correct.
- **Export is a read act.** It is the same rows as the list, so it must obey the
  same scope. Otherwise a role that has been granted `admin.users.manage` for
  one purpose silently gains a company-wide roster download.

**15B-2 established that `people` list/detail is Project-Scoped.** If export
stays tenant-wide, the list and its own CSV disagree — the same defect class as
line 398. **This must be decided, not defaulted.**

Note also: `documents/export.csv` uses `documents.manage`, and
`locations/export.csv` uses `admin.org.manage`. Both are management permissions
on tables with no location column, which is self-consistent — but only if the
"administrative act" reading is chosen deliberately.

---

## 7. Cache investigation

Two caches were flagged as possible cross-scope risks. Both were read in full.

### 7.1 `assistant/document-content.ts` — SAFE, and it is safe for a specific reason

| property                    | finding                                                         | evidence              |
| --------------------------- | --------------------------------------------------------------- | --------------------- |
| cache key                   | `` `${id}:${version?.id ?? 'draft'}` ``                         | `:130`                |
| value                       | extracted PDF/DOCX **text**, pages, scanned flag                | `:42-47`              |
| authorization point         | **before** the cache read, every call                           | `:95-113`             |
| value user-independent?     | **yes** — text of one document version is the same for everyone | `:63-79`              |
| Project Scope affects it?   | **no** — `documents` has no location column                     | `doc-access.ts:17-18` |
| cross-scope reuse possible? | **no**                                                          | see below             |

The order matters and is correct:

```ts
 95    if (!can(ctx, 'documents.read') && !can(ctx, 'documents.manage')) {
 96      return { ok: false, error: 'forbidden' }
 98    const includeUnpublished = ctx.isSuperAdmin || can(ctx, 'documents.manage')
 99    return ctx.db(async (tx) => {
101      const filter = documentReadFilter(ctx)
102      if (filter) conds.push(filter)
103      const [doc] = await tx.select(…).where(and(...conds)).limit(1)
113      if (!doc) return { ok: false, error: 'not_found' }
…
130      const cacheKey = `${id}:${version?.id ?? 'draft'}`
131      const cached = cacheGet(cacheKey)
```

Authorization and the **row fetch** both complete before the cache is consulted.
A cache hit returns only the _text extraction_ of a version the caller has
already been authorized to see. The permission-varying part
(`includeUnpublished`, `:98` → `documentVersionVisibilityWhere`,
`document-version-policy.ts:11-17`) changes the **version id**, and the version
id is in the key — so a manager and a reader cannot collide, because they
resolve different `version.id`s.

`documentReadFilter` is a **publication** filter (`published` vs any,
`doc-access.ts:18`), not a location filter, so no Project Scope is missing here.

**Verdict: no change needed.** Bounded at 64 entries, LRU (`:48-61`), and the
cached value is not authorization-bearing. Worth a comment in the file recording
that the auth-before-cache ordering is load-bearing.

### 7.2 `collabora.ts` — SAFE, and for a stronger reason than 7.1

| property                    | finding                                              | evidence   |
| --------------------------- | ---------------------------------------------------- | ---------- |
| cache key                   | `` `${app}:${action}` `` — e.g. `presentation:edit`  | `:62-64`   |
| value                       | the Collabora **WOPI discovery action URL**          | `:103-106` |
| authorization point         | **none in this module** — the value is not user data | —          |
| value user-independent?     | **yes, and tenant-independent**                      | —          |
| Project Scope affects it?   | **no** — cannot                                      | —          |
| cross-scope reuse possible? | **no**                                               | —          |

`getCollaboraActionUrl` fetches `/hosting/discovery` from the Collabora
container and extracts a static action endpoint. It is a **service
configuration URL**, not a per-user capability:

```ts
 96    const res = await fetch(`${base}/hosting/discovery`, { …, cache: 'no-store' })
103    const url = resolveCollaboraActionUrlBytes(body, base, app, action)
106    cached.set(key, { url, at: Date.now() })
```

The key has no tenant, no user, no document — deliberately, because the value
needs none. Document authorization happens at the **callers**:
`documents/[id]/_master-actions.ts:88` and `training/pptx/_actions.ts:68`, `:108`,
each of which authorizes before resolving the URL.

**Verdict: no change needed.** My earlier concern — that a presigned URL cached
without a scope would extend a leak window — **does not apply here**. The
per-document WOPI token is not built or cached by this module; this caches only
the Collabora host's action path.

### 7.3 The cache that _is_ correctly scoped

`apps/web/src/app/(app)/insights/_data.ts:53`:

```ts
const cacheKey = `${ctx.tenantId}:${access.scopeKey}:${trustScope}:${key}`
```

`access.scopeKey` includes `analyticsScopeFingerprint` (`scope.ts:459-476`),
which carries `projectScopeKind` + `orgUnitIds` + `projectPersons`, all sorted
and deduped. Because the **discriminator is in the key**, `unrestricted`,
`empty` and `restricted` can never share one. Covered by
`insights-cache-scope.test.ts` (10 tests).

**Important consequence:** 15B-2 fixed the _cache_ for Insights but not the
_query_. After 15B-3B narrows `resolveEntity`, the cache is already correct and
needs no change — **provided the fingerprint keeps carrying the scope.**

### 7.4 Remaining cache surface

- `worker/src/lib/escalation-scanner.ts:48` `roleAudienceCache` — created per
  run, never crosses requests. Low risk.
- `worker/src/lib/compliance-scanner.ts:318` — per run. Low risk.
- `lib/collabora.ts` is the only other module-level cache holding a URL.
- **All worker caches are tenant-wide today** because the worker has no scope
  at all (§8). They must be re-reviewed after 15B-3D.

---

## 8. Worker: no Project Scope at all

Verified by search:

```
grep -rn "resolveProjectScope|projectScope" apps/worker/src   →   0 matches
```

The worker's run-as subject omits every Project Scope field —
`apps/worker/src/lib/report-run-as-scope.ts:26-33`:

```ts
export function reportRunAsScopeSubject(ctx: RequestContext): AnalyticsScopeSubject {
  return {
    isSuperAdmin: ctx.isSuperAdmin,
    permissions: (key) => can(ctx, key),
    siteIds: siteIdsFromScopes(ctx.scopes),
    personId: ctx.personId,
    tenantUserId: ctx.membership?.id ?? null,
  }
}
```

No `orgUnitIds`, no `projectPersonIds`, no `projectScopeKind`.

**The run-as context is otherwise complete** — `apps/worker/src/workers/reports.ts:513-525`
builds a full `makeTenantContext` with `personId: principal.personId ?? null` and
`scopes: resolved.scopes`. So the worker already has everything it needs to
_resolve_ a scope; it only lacks the call.

### A trap that must be avoided

**If 15B-3B lands before the worker is bridged, every scheduled report will
return zero rows.** `resolveEntity` would receive `projectScopeKind: undefined`
→ treated as unresolved → fail closed → withhold. That is the correct security
behaviour and a total functional regression for scheduled reports.

Therefore **15B-3D must ship in the same release as 15B-3B**, or the worker
subject must be populated first as a standalone step. This is a sequencing
constraint, not a preference.

### The structural obstacle: the resolver cannot be imported

The resolver lives at `apps/web/src/lib/project-scope.ts` — an **app**, not a
package. `apps/worker` cannot import from `apps/web`.

Its own dependencies are the constraint that makes relocation clean:

```
26  import { and, eq, inArray, sql } from 'drizzle-orm'
27  import type { Database } from '@beaconhs/db'
28  import { orgUnits, people, peopleAssignments } from '@beaconhs/db/schema'
29  import type { RequestContext } from '@beaconhs/tenant'
30  import { … } from './assignment-validity'
```

Only `drizzle-orm`, `@beaconhs/db`, `@beaconhs/tenant`, and one local module.
No Next.js, no `server-only`, no app internals. It is **relocatable without
rewriting it** — plus `./assignment-validity` (also local, also pure) and the
adapter `./project-scope-predicate.ts`.

**No code was moved. The placement decision is recorded in §12.**

---

## 9. Public API: `api_keys` has no scope, and is hard-coded tenant-wide

### Current semantics

`apps/web/src/lib/api/auth.ts:122-138`:

```ts
130    membership: null,
131    // No human employee behind an API key — record visibility is full-tenant.
132    personId: null,
133    apiKey: { id: row.id, name: row.name },
134    // API keys use the same permission vocabulary as tenant roles. They are
135    // tenant-level credentials, so record visibility is full-tenant.
136    permissions: new Set(permissions),
137    scopes: [{ type: 'tenant' }],
```

`scopes: [{ type: 'tenant' }]` is the one input that makes
`resolveProjectScope` return `unrestricted` (`project-scope.ts:245`, 251). So
**every API key currently resolves to `unrestricted` by construction**, and no
API-key request can be affected by S4 or any export change.

### The schema cannot express a scope

`packages/db/src/schema/api-keys.ts:19-45` — the full column set is
`tenantId`, `name`, `keyHash`, `prefix`, `permissions` (jsonb),
`builderTemplateIds` (jsonb), `createdBy`, `lastUsedAt`, `expiresAt`,
`revokedAt`, timestamps. **No scope column. No person anchor.**

Both facts block any narrowing:

1. `personId: null` — and `callerPersonIds` (`project-scope.ts:103-113`)
   resolves from `ctx.personId` first, falling back to
   `people WHERE user_id = ctx.userId`. Neither is available: a key has no
   employee record, and `ctx.userId` is `row.createdBy ?? 'api_key:<id>'`, which
   is either another human's id or a synthetic string.
2. No column to store an explicit org-unit list.

### Three possible future semantics

|       | semantics                                                           | migration? | consequence                                                       |
| ----- | ------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| **A** | **tenant-wide**, as today — and say so in the manual                | **no**     | unchanged behaviour; a key is a tenant-level credential by design |
| **B** | **person-bound** — add `person_id`, resolve that person's placement | **yes**    | key visibility tracks one employee; a real narrowing              |
| **C** | **explicit scope** — add a `scope` jsonb, reuse `RoleScope`         | **yes**    | most flexible; reuses an existing vocabulary                      |

**A is the only option requiring no migration, and it is a legitimate design
position** — a machine credential is not a person and has no "where they stand".
The defect today is not the behaviour, it is that the behaviour is **undocumented
in the manual** while looking like an accident.

B and C are real work: migration, backfill policy, and a decision on what an
existing key means after the column lands. Note the AGENTS.md constraint:
API keys have no scope column, so **no work may imply API-key project scoping
until this is decided**.

**No migration was written or planned in this audit.**

---

## 10. Unresolved semantic decision: `read.site` with no site scope

The two ladders disagree, and the disagreement is recorded in the code itself —
`visibility.ts:218-221`:

```ts
218 // read.site but no site scope assigned → fall through to own-only.
219 // NOTE: this is the "own-only fallback" the 15B-1 audit flagged as
220 // disagreeing with `packages/analytics/src/server/scope.ts:383`, which
221 // withholds instead. The disagreement is recorded, not resolved here.
```

| caller                            | holds `read.site`, no `sites` scope | result               |
| --------------------------------- | ----------------------------------- | -------------------- |
| UI list — `visibility.ts:213-225` | falls through to own rows           | sees **own** records |
| Analytics — `scope.ts:404-407`    | `siteIds.length === 0`              | **withheld**         |

Same permission, same data, two answers. The UI answer is the more permissive
one.

Three sub-cases, and they are not equivalent:

- A `foreman` with `read.site` and **no** `{type:'sites'}` scope but **with** a
  personnel placement. Under 15B-2 the Project Scope is the org units; the
  legacy `sites` scope is the access boundary. They are independent
  vocabularies, so this caller has a scope and no site list.
- A `safety_manager` with `read.site`, a placement, and a sites scope. No
  conflict — both narrow.
- A caller with neither. `empty` — must withhold.

**This becomes materially worse after 15B-3B.** Today analytics withholds while
the UI shows own rows; after the fix, a `read.site` + Project-Scope-restricted
analytics caller narrows to Project Scope while the UI narrows to
`own ∪ legacy-sites`. The two will disagree in the _opposite_ direction.

**Decide before 15B-3B.** The honest options are: make analytics fall through to
own (matching the UI, and the more useful behaviour), or make the UI withhold
(matching analytics, and the more conservative one). Either is defensible; they
are not interchangeable, and leaving it open means 15B-3B lands with a known
inconsistency.

---

## 11. Evidence index

| claim                                    | path:lines                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| S4/S5 short-circuit                      | `packages/analytics/src/server/scope.ts:392-398`                                                                                       |
| `tierFor` maps read.all → 'all'          | `packages/analytics/src/server/scope.ts:349-357`                                                                                       |
| flat key is 'all' or 'none' only         | `packages/analytics/src/server/scope.ts:351`                                                                                           |
| withhold precedent                       | `packages/analytics/src/server/scope.ts:404-407`                                                                                       |
| Project Scope fields on subject (unused) | `packages/analytics/src/server/scope.ts:31-64` (`:51`, `:53`, `:63`)                                                                   |
| fingerprint includes scope               | `packages/analytics/src/server/scope.ts:459-476`                                                                                       |
| PREFIX_SCOPE / TABLE_SCOPE               | `packages/analytics/src/server/scope.ts:110`, `:216`                                                                                   |
| bound flat key (ppe)                     | `packages/analytics/src/server/scope.ts:139`                                                                                           |
| 16 unbound flat keys                     | `scope.ts:155,158,162,163,164,165,169,172,192,221,222,233,236,237,238,239`                                                             |
| 15B-2 fixed counterpart                  | `apps/web/src/lib/visibility.ts:205-209`                                                                                               |
| `resolveVisibilityTier`                  | `apps/web/src/lib/visibility.ts:142-146`                                                                                               |
| own-only divergence note                 | `apps/web/src/lib/visibility.ts:218-221`                                                                                               |
| ladder call counts                       | `moduleScopeWhere` 68 · `canSeeRecord` 45 · `recordVisibilityWhere` 2                                                                  |
| journal private ladder                   | `apps/web/src/app/(app)/journals/_lib.ts:33-54`, gate `:13-15`                                                                         |
| journal ladder call sites                | `_data.ts:127,283,339` · `_actions.ts:86` · `_send-email.ts:35` · `_lib.ts:78` · `_tag-picker-actions.ts:18` · `feed/_data.ts:135,414` |
| feed private ladder                      | `apps/web/src/app/(app)/feed/_data.ts:50-65`, gate `:56`                                                                               |
| feed call sites                          | `feed/_data.ts:173,220,320,424,445,485`                                                                                                |
| "single tier ladder" claim (false)       | `apps/web/src/app/(app)/feed/_data.ts:44-49`                                                                                           |
| Dashboard (correct)                      | `apps/web/src/app/(app)/dashboard/_metrics.ts:38,400-431`                                                                              |
| Reports chain                            | `reports/definitions/[id]/export/route.ts:29,54` → `reports/_run.ts:8` → `lib/report-catalog.ts:6`                                     |
| Insights cache key                       | `apps/web/src/app/(app)/insights/_data.ts:53`                                                                                          |
| document-content cache                   | `apps/web/src/lib/assistant/document-content.ts:48-61,95-113,130-131`                                                                  |
| document publication filter              | `apps/web/src/lib/assistant/doc-access.ts:17-18`                                                                                       |
| document version policy                  | `apps/web/src/lib/document-version-policy.ts:11-17`                                                                                    |
| collabora cache                          | `apps/web/src/lib/collabora.ts:60-64,96-106`                                                                                           |
| collabora callers                        | `documents/[id]/_master-actions.ts:88` · `training/pptx/_actions.ts:68,108`                                                            |
| worker subject (no scope)                | `apps/worker/src/lib/report-run-as-scope.ts:26-33`                                                                                     |
| worker run-as context                    | `apps/worker/src/workers/reports.ts:513-525`                                                                                           |
| API key hard-coded tenant                | `apps/web/src/lib/api/auth.ts:130-137`                                                                                                 |
| `api_keys` columns                       | `packages/db/src/schema/api-keys.ts:19-45`                                                                                             |
| resolver dependencies                    | `apps/web/src/lib/project-scope.ts:26-30`                                                                                              |
| `callerPersonIds`                        | `apps/web/src/lib/project-scope.ts:103-113`                                                                                            |
| resolver tenant check                    | `apps/web/src/lib/project-scope.ts:245,251`                                                                                            |
| PPE holder join constraint               | `ppe_issue_reports` has no person column; join `item_id → ppe_items.current_holder_person_id`                                          |
| people export admin perm                 | `apps/web/src/app/(app)/people/export.csv/route.ts:47`                                                                                 |
| compliance obligations unscoped          | `apps/web/src/app/(app)/compliance/obligations/_data.ts:40-49`                                                                         |

---

## 12. Prerequisites before 15B-3B through 15B-3F

### 15B-3B — analytics row predicates (the core change)

Decisions required **before** any code:

1. **The 16 unbound entities — withhold, or exempt?** `org_units`,
   `departments`, `crews`, `trades` are the scope definition domain;
   `documents`, `compliance`, `insights` have no location. Withholding is the
   fail-closed answer, but it removes data from cards and reports today.
   **This is the single largest behavioural risk in 15B-3.**
2. **`read.site` + no site scope — own-only or withhold?** (§10) Must be settled
   together with the change, because the fix moves the disagreement.
3. **Does the worker ship in the same release?** (§8) If not, scheduled reports
   return zero rows. Either 15B-3D lands first, or the worker subject is
   populated as a standalone step.

The Dashboard (`_metrics.ts`) is the correctness oracle for the test suite: it
is already correct, so the two can be compared.

### 15B-3C — exports

4. **Is an export an administrative act or a read act?** (`admin.users.manage`
   on `people`, `documents`, `admin.org.manage` on `locations`.) If read, the
   list and its own CSV must agree. If administrative, the current code is right
   and the manual should say so.
5. **`locations/export.csv` — exempt or withhold?** It exports `org_units`,
   which _defines_ the scope. A restricted caller exporting the whole tree is
   not necessarily wrong, but it is not scoped either.
6. **`training/courses/export.csv` — records or catalogue?** Exports
   `training_courses`, which is a course catalogue rather than a person's
   records. Candidate for explicit exemption.
7. **`vehicle-log/export.csv` — which column?** Confirm the intended
   `siteCol` before wiring.

### 15B-3D — resolver placement

8. **Which package hosts the resolver?** It is currently in an app
   (`apps/web/src/lib/project-scope.ts`) and the worker cannot import it. It
   depends only on `drizzle-orm`, `@beaconhs/db`, `@beaconhs/tenant` and two
   local pure modules, so it relocates cleanly. Candidates, by existing
   dependency direction:
   - `@beaconhs/tenant` — already depends on `@beaconhs/db`; would gain a
     schema import. Most natural home for an authorization rule.
   - `@beaconhs/db` — lowest layer, but mixes business rules into the data
     package.
   - a new package — **discouraged**; adds a package for one module.

   Whatever is chosen, `apps/web` must keep re-exporting the existing symbol so
   the 43 authorization bridge tests and the live-verification script keep
   working unchanged. **No move was made in this audit.**

### 15B-3E — API-key semantics

9. **A, B, or C?** (§9) A is tenant-wide and needs **no migration** — only a
   manual correction. B and C need a migration plus a backfill decision for
   existing keys. Until decided, nothing may imply API-key project scoping.

### 15B-3F — caches

10. **Nothing to change.** Both flagged caches are safe (§7.1, §7.2) for
    documented reasons. The only follow-up: record in each file that the
    auth-before-cache ordering (documents) and the tenant-independent value
    (collabora) are load-bearing, so a future change does not reorder them.
11. **Re-review worker caches after 15B-3D** — they are tenant-wide today
    because the worker has no scope.
12. **Confirm the Insights fingerprint keeps carrying Project Scope** after
    15B-3B. The cache is already correct; the fix must not remove the fields.

---

## 13. Invariants this audit holds to

Recorded because every proposed fix is judged against them:

- **fail-closed** — an unbindable scope withholds; it never widens
- **no role-name bypass** — `unrestricted` comes only from `ctx.isSuperAdmin` or
  an explicit `{type:'tenant'}` scope
- **role scope and personnel placement are independent** — `role_assignments.scope`
  is an access boundary, `people_assignments` is where a person works; neither
  derives the other
- **`empty` ≠ `unrestricted`** — the `projectScopeKind` discriminator keeps them
  apart, in the resolver and in the cache key
- **no `IN ()`** — an empty id list yields `false`, never an empty predicate
- **no new permission keys, no schema change** — except the API-key option
  chosen in 15B-3E

---

## 14. 15B-3C-3E — Project Scope definition-domain exemption

**Status: IMPLEMENTED.**

> **Naming note.** The `TODO(15B-3E)` in `packages/analytics/src/server/scope.ts`
> refers to _this_ decision — the org definition domain. It is **not** the
> `15B-3E — API-key semantics` in §12 above, which is a separate and still-undecided
> item. Both labels are load-bearing in their own file; this section does not
> resolve §9.

### Decision

An explicit, named exemption, not a binding and not a restoration of tenant-wide
access. `ProjectScopeExemption` gains a second member:

```ts
export type ProjectScopeExemption = 'tenant-level-setting' | 'tenant-level-definition'
```

`tenant-level-definition` means: the table contains tenant-level organizational
definition/configuration data rather than per-person, per-project, or
project-scoped business records. It is intentionally visible to authorized tenant
administrators regardless of the caller's Project Scope.

### Affected entities

| table         | read key           | exemption                 |
| ------------- | ------------------ | ------------------------- |
| `org_units`   | `admin.org.manage` | `tenant-level-definition` |
| `departments` | `admin.org.manage` | `tenant-level-definition` |
| `crews`       | `admin.org.manage` | `tenant-level-definition` |
| `trades`      | `admin.org.manage` | `tenant-level-definition` |

### Why these entities are exempt

They are the vocabulary every scope is expressed in. `org_units` **defines** the
tree; `departments` / `crews` / `trades` are grouping catalogs drawn from it.

A binding was rejected because none exists that is not circular: `org_units.parent_id`
points at another org unit, so restricting the org tree by the org tree uses the
rows being filtered as their own scope. The other three are name/code catalogs
with no relationship to any record. 15B-3B deliberately did not invent a column
for this, and neither does 15B-3E — no `org_unit_id` / `site_org_unit_id` was added
to any of the four.

Withholding (the 15B-3B fail-closed default) was rejected because it removed a
scoped administrator's ability to group a report by location, department, crew or
trade while holding the very permission that administers them. These are
definitional, not business facts.

### Why an exemption is not tenant-wide business-data access

The exemption skips the Project Scope **row predicate** only. It never grants a
read permission:

- `tierFor` runs **first** and independently. A caller without `admin.org.manage`
  is withheld by `tier === 'none'` before the scope is consulted at all.
- The four tables hold no per-person, per-site or per-project rows, so there is
  nothing in them to leak.
- `validateScopeSpecs` refuses any spec that both exempts itself and declares a
  scope column, so an exemption can never become a licence to skip a bindable
  entity.
- `runScopeSpecValidation` re-asserts each table's actual column list against a
  transcription of `packages/db/src/schema/org.ts`, so a future person-, site- or
  project-keyed column fails the check rather than inheriting the exemption.

> **The exemption is explicit and named. It is not inferred from
> `tier === 'all'`, absence of scope columns, or administrator permission.**

This is **not** a restoration of the fail-open 15B-3B fixed. That path made
_every_ unbindable table tenant-wide for a `read.all` holder; this names four
tables, is enforced structurally, and leaves every other unbindable entity
withheld. That boundary is pinned by an explicit anti-fail-open test.

An exemption also does **not** rescue an unusable scope: `empty` and `unknown`
still deny before the exemption is consulted, because an absent scope is not
evidence of a wide one.

### Why `locations/export.csv` remains deferred

`locations/export.csv` is **not** covered by this decision and must not be assumed
exempt because the four tables are.

> `locations/export.csv` remains deferred to a separate 3E decision. Its exported
> columns and business semantics must be verified before deciding whether it is a
> definition-domain exemption or requires Project Scope binding.

It is recorded in §6 as a scope-definition-domain concern and in §12 item 5 as an
open question. Deciding it from the four-table exemption would extend a decision
that was never made about it.

### Validation guarantees

| Guarantee                                       | Mechanism                                             |
| ----------------------------------------------- | ----------------------------------------------------- |
| exemption + any scope column → error            | `validateScopeSpecs` (site / orgUnit / person / user) |
| unrecognised exemption string → error           | `validateScopeSpecs` vs `PROJECT_SCOPE_EXEMPTIONS`    |
| the four real specs are valid                   | `runScopeSpecValidation`                              |
| each exempt table's shape is still definitional | `runScopeSpecValidation` vs the schema transcription  |
| exemption grants no permission                  | read tier resolved before scope                       |
| exemption does not rescue `empty`/`unknown`     | `scopeContribution` order                             |
| no other unbindable entity became visible       | anti-fail-open + allowlist tests                      |

### Tests performed

Added to the **existing** `packages/analytics/src/server/scope.test.ts` — no new
test file and no parallel harness.

| Case | Assertion                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| A    | restricted + `admin.org.manage` → all four `visible`, `filter` undefined; and an un-exempted unbindable table stays withheld |
| B    | `empty` and `unknown` scope → all four still withheld                                                                        |
| C    | `unrestricted` → all four visible, no filter (existing behaviour)                                                            |
| D    | without `admin.org.manage` (incl. other modules' keys) → all four invisible                                                  |
| E    | `tenant-level-definition` + each of site / orgUnit / person / user columns → validation error                                |
| F    | unknown exemption string → validation error                                                                                  |
| G    | `vehicle_log_settings` keeps `tenant-level-setting` and still resolves                                                       |
| H    | `read.all` + no columns + no exemption → still withheld; super-admin unaffected; a spec-less table withheld for everyone     |

Result: `scope.test.ts` 61 passed, `scope-report-views.test.ts` 19 passed, full
analytics package **105 passed**.

Mutation-checked — each mutation was applied to `scope.ts`, the suite confirmed to
fail, and the file restored to an identical hash:

| Mutation                                              | Result               |
| ----------------------------------------------------- | -------------------- |
| drop the exemption from all four tables               | **caught**           |
| restore the 15B-3B fail-open (`tier all` ⇒ no filter) | **caught** (9 tests) |
| make the exemption bypass the read tier               | **caught**           |
| let the exemption rescue `empty`/`unknown`            | **caught**           |
| accept any exemption string (validation disabled)     | **caught**           |

### Schema / migration

**Unchanged.** No schema edit, no migration, no `db:generate` / `migrate` / `push`.
No column was added to any of the four tables. Drizzle journal remains at 41
entries, last idx 40. The exemption is a resolver-level fact about how a table is
read, expressed in the scope specification — not a data-model change.

---

## 15. 15B-3C — the controlled-document library (DECIDED AND IMPLEMENTED)

**Status: IMPLEMENTED.** This is a settled product decision and its final
implementation, not an open question. The original analysis of `documents` as an
unbound flat-key spec is retained above, unedited: §3 lists it among the 16 unbound
specs and, under "Why this is the highest-risk item in 15B-3", groups it with
`compliance` and `insights` as a record with no location column, records that
withholding was then the only safe answer, and requires the question to be settled
before any code is written. §7 recorded that `doc-access.ts` applies no Project
Scope, and §6 row 9 classified `documents/export.csv`. That history records the
question; this section records the answer.

### Decision

`documents` is a **tenant-level controlled document library**. A tenant publishes
ONE version of an SDS / SOP / policy, and every field worker on every site must be
able to read it. A document that varied by project would be a different artefact
per project, which is not what a controlled document is.

The Project Scope exemption is named **`tenant-level-document-library`**, and is
deliberately NOT `tenant-level-definition`: a controlled-document library carries
business facts — a publication lifecycle (`draft` / `published` / `archived` /
`under_review`), a review cycle, and a nullable owner — whereas the §14 definition
tables are pure organizational structure.

### What was explicitly NOT built

No applicability binding of any kind was introduced:

- no `project_id`, no `site_org_unit_id`, no `person_id`
- no owner-based Project Scope binding — `owner_tenant_user_id` is nullable
  **authorship**, and was not promoted to scope
- **no Document Applicability Scope** feature

`documents` therefore still declares no scope column, and `runScopeSpecValidation`
carries a shape guard transcribed from the schema so that a future person-, site-
or project-keyed column fails the check instead of silently inheriting the
exemption.

### The four states — Web and Analytics agree

| Project Scope  | Web       | Analytics    |
| -------------- | --------- | ------------ |
| `unrestricted` | **ALLOW** | **VISIBLE**  |
| `restricted`   | **ALLOW** | **VISIBLE**  |
| `empty`        | **DENY**  | **WITHHELD** |
| `unknown`      | **DENY**  | **WITHHELD** |

A `restricted` caller — a `worker`, `foreman` or `safety_manager` holding
`documents.read` — reads the tenant-wide published library. That is the whole point
of the decision: a field worker must not be unable to read the SDS for the site
they are standing on.

### An exemption may not rescue an unusable scope

`empty` and `unknown` deny, and that ordering is structural rather than incidental.
On the analytics side `scopeContribution` denies both **above** the exemption
check, so an exemption cannot reach them; **the global fail-closed order was not
changed**. On the web side the gate is written fail-closed by construction — only a
scope that is present and not `empty` is usable, so an absent or unrecognised scope
denies.

`unknown` is grouped with `empty` for one reason: an absent scope is not evidence
of a wide one, and a caller whose scope could not be resolved must never fall
through to a company-wide read.

### Authorization layers are independent

`documents.read`, `documents.manage` and publication visibility are a **separate
authorization layer** from Project Scope. The two are conjoined, never substituted:

- `documentReadFilter` is **unchanged** and still answers exactly one question —
  "may an unpublished document be seen". It is not scope-aware.
- The web rule is `documentReadFilter` **AND** the Project Scope usability gate.
  A manager inside a usable scope gets no extra constraint; a manager inside an
  unusable scope is still denied. The publication waiver is not a scope bypass.

### Web: a documents-specific primitive, not a change to the shared ladder

The web ladder has no exemption concept, and teaching it one would have changed
every module behind it. Instead `lib/assistant/document-project-scope.ts` adds a
single-purpose primitive:

- `documentScopeUsable(scope)` — pure, and the **only** place the four-state
  decision is made
- `documentScopeFilter(ctx, tx)` — resolves the caller's scope into a predicate
- `documentAuthorizationFilter(ctx, tx)` — `documentReadFilter` AND the scope gate

Every read surface composes that one function. Confirmed unchanged: `moduleScopeWhere`,
`projectScopePredicate`, `resolveProjectScopeIn` and RLS. **The other 68 module
lists are unaffected**, and no surface derives the four states for itself.

### Analytics: the existing mechanism, reused

`TABLE_SCOPE.documents` gains `projectScopeExempt: 'tenant-level-document-library'`,
and the recognition set gains the member. `scopeContribution`, `resolveEntity` and
`tierFor` are untouched: the resolver already handled exemptions generically, and
already denied `empty`/`unknown` first.

The 15B-3B fail-closed rule is unchanged and still applies to every OTHER
unbindable table; its `unbound` test fixture moved from `documents` to
`insight_cards` so the rule keeps testing a genuinely non-exempt entity.

### What closed the Web/Analytics gap

Before this decision the two halves disagreed: web applied no Project Scope at
all and showed the tenant library, while analytics withheld `documents` from every
scoped caller. That divergence is now closed, and it was closed in the direction
that keeps the fail-closed property: both sides now allow a `restricted` caller
and both deny an unusable one.

### Schema / migration

**Unchanged.** No column, no migration, no RLS edit. Drizzle journal remains at 41
entries, last idx 40. `documents` gains no scope column, so the exemption rests on
the absence of anything to bind on — which the shape guard keeps honest.
---

## 16. 15B-3C — the Insights trusted system KPI (DECIDED AND IMPLEMENTED)

**Status: IMPLEMENTED.** A settled product decision, recorded here so the
exception is not later mistaken for an oversight. §12 item 5, §14 and §15 are
retained above as the historical record and are not modified by this section.

### The two cards

Only two built-in Overview cards read the `app_responses` entity:

| card                            | query                                                    | shape                    |
| ------------------------------- | -------------------------------------------------------- | ------------------------ |
| `kpi-submissions`               | `count(app_responses)` where `submitted_at` today        | one scalar, no `groupBy` |
| `kpi-monitored-sessions-active` | `count(app_responses)` where `monitor_status = 'active'` | one scalar, no `groupBy` |

Neither projects a person, a site, or any row. Both are aggregate system
metrics, which is why they are tenant-wide rather than Project-Scope-scoped: a
tenant KPI is not a scoped view.

### The rule

`app_responses` remains on the analytics `ALWAYS_ALLOWED` list, so Project Scope
is intentionally **not** applied to it. The permission half is decided in apps/web
by `canReadAppResponses`, and it admits **`forms.response.read.all` only**:

| permission                  | Project Scope | trusted KPI |
| --------------------------- | ------------- | ----------- |
| `forms.response.read.all`   | unrestricted  | tenant-wide |
| `forms.response.read.all`   | restricted    | tenant-wide |
| `forms.response.read.all`   | `empty`       | tenant-wide |
| `forms.response.read.all`   | `unknown`     | tenant-wide |
| `forms.response.read.site`  | any           | **DENY**    |
| `forms.response.read.self`  | any           | **DENY**    |
| no response read permission | any           | **DENY**    |

`forms.response.read.site` does not authorize these cards. It did before this
decision, which is why a site-scoped reader could see a tenant-wide total.

**Why `empty` / `unknown` do not block it.** Not because a scope was widened.
`forms.response.read.all` is a tenant-wide capability in its own right, and an
aggregate with no rows has no scope left to narrow. The grant rests on the
permission, which is enforced before the analytics layer is reached — so this is
a documented exception, not a fail-open.

### The boundary that must not blur

```
Apps Responses — ordinary form-response records
  └─ Project Scope APPLIES (moduleScopeWhere, `form_` spec)

Insights trusted KPI — app_responses aggregate
  └─ tenant-wide, `forms.response.read.all` only
```

`app_responses` is `{ ...formResponses }` with only `key` / `label` / `category` /
`description` overridden, so it reads the **same rows** as ordinary form
responses. The exemption is on the alias the two KPI cards use, not on the table.
Ordinary response records keep their normal narrowing, and the analytics suite
asserts both halves of that boundary side by side.

### Schema / migration

**Unchanged.** No column, no migration, no RLS edit, and no change to
`moduleScopeWhere`, `projectScopePredicate`, `resolveProjectScopeIn`,
`scopeContribution` or `resolveEntity`. `ALWAYS_ALLOWED` is retained rather than
removed; only the caller's permission gate was narrowed.
