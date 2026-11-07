# Project Scope Removal Audit

> Read-only architecture audit. No production code, test, schema, migration or
> existing document was modified. This file is the only artefact created.
>
> Question under audit: **Project Scope was introduced as a second authorization
> dimension. What exactly must be removed to return BeaconHS to its native
> `Tenant/RLS → Permission → Role Scope / Visibility Tier → Record` model, and
> what genuine native security fixes must survive that removal?**

---

## 1. 当前 Git 状态 / Current Git State

| Item               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEAD`             | `f16aa3d7` — `fix(auth): align dashboard trusted KPI gate`                                                                                                                                                                                                                                                                                                                                                                                                        |
| Branch             | `hse-platform`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `origin/main`      | `c96bb1ba`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Ahead / behind     | **31 ahead, 1 behind**                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Staged             | 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Modified (tracked) | `apps/web/next-env.d.ts`, `apps/web/next.config.ts`                                                                                                                                                                                                                                                                                                                                                                                                               |
| Untracked (17)     | `docker-compose.yml.bak`, `docker-compose.yml.pre-cleanup-backup`, `docs/hse-authorization-hardening-{analysis,design,implementation-plan}.md`, `docs/hse-permission-cutover-{analysis,design,implementation-plan}.md`, `docs/hse-permission-cutover-v2-plan.md`, `docs/hse-ppe-picker-authorization-analysis.md`, `docs/hse-project-scope-{15b-impact-audit,analysis,authorization-design,design,implementation-plan}.md`, `docs/hse-schema-drift-0041-audit.md` |
| `git diff --check` | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Drizzle journal    | 41 entries, last idx 40 — **untouched**                                                                                                                                                                                                                                                                                                                                                                                                                           |

The two modified tracked files and all 17 untracked files predate this audit and
were left exactly as found.

### Introduction commits (context, not in the 9-commit list)

| Commit     | Subject                                                    | Role                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9c5859ea` | `feat(hse): harden report authorization and row scoping`   | **created** `packages/analytics/src/server/scope.ts` (`TABLE_SCOPE`, `PREFIX_SCOPE`, `ALWAYS_ALLOWED`, `analyticsScopeFingerprint`, `resolveEntity`). Zero Project Scope. |
| `9107bd13` | `feat(auth): complete project scope authorization bridge`  | **introduced Project Scope into the web ladder** (29 files)                                                                                                               |
| `c4ccd722` | `fix(auth): enforce project scope in analytics and worker` | **introduced Project Scope into analytics + worker** (20 files)                                                                                                           |
| `8e98f218` | `Scaffold Phase 0 + Phase 1 spine`                         | native: `people_assignments`, `forms.response.read.*`, `PERMISSION_CATALOGUE`, `RoleScope`                                                                                |

---

## 2. Project Scope 全量依赖清单 / Full Dependency Inventory

58 files reference Project Scope concepts. Occurrence counts are for
`resolveProjectScope|ProjectScope|projectScope|project-scope|project_scope|scopeContribution|PROJECT_SCOPE_EXEMPTIONS|TABLE_SCOPE`.

### 2.1 Dedicated Project Scope modules — pure, delete whole file

| File                                                        | Hits | Native logic present | Verdict                                                                                                                           |
| ----------------------------------------------------------- | ---- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/analytics/src/server/project-scope.ts`            | 20   | No                   | **DELETE** (438 lines — the single resolver)                                                                                      |
| `apps/web/src/lib/project-scope-predicate.ts`               | 9    | No                   | **DELETE** (128 lines — `projectScopePredicate`, `isAlwaysFalse`, `recordInProjectScope`, `andPredicates`, `ProjectScopeBinding`) |
| `apps/web/src/lib/project-scope.ts`                         | 7    | No                   | **DELETE** (37 lines — pure compatibility re-export of the above)                                                                 |
| `apps/web/src/lib/assistant/document-project-scope.ts`      | 7    | No                   | **DELETE** — superseded by native `documentReadFilter`                                                                            |
| `apps/web/src/lib/testing/project-scope-fixture.ts`         | 7    | No                   | **DELETE** (test stand-in `projectScopeTx`)                                                                                       |
| `apps/web/scripts/project-scope-verification.ts`            | 26   | No                   | **DELETE** (synthetic verification script)                                                                                        |
| `apps/web/scripts/project-scope-live-verification.ts`       | 11   | No                   | **DELETE** (live-database verification script)                                                                                    |
| `apps/web/src/lib/project-scope-contract.test.ts`           | 21   | No                   | **DELETE** (28 resolver contract tests)                                                                                           |
| `apps/web/src/lib/documents-project-scope-contract.test.ts` | 24   | No                   | **DELETE** (24 documents Project Scope tests)                                                                                     |
| `apps/web/src/lib/project-scope-oracle.test.ts`             | 6    | No                   | **DELETE**                                                                                                                        |

> `apps/web/scripts/personnel-placement-repair.ts` was added by `9107bd13` for
> Project Scope's benefit but repairs `people_assignments` data, which is native.
> See §8 `REVIEW`.

### 2.2 Documents surfaces — 1 call site each, mechanical revert

All eleven call sites replaced the native `documentReadFilter(ctx)` with
`await documentAuthorizationFilter(ctx, tx)`. Reverting is a one-line change per
file plus a comment cleanup. **No native logic is lost** — `documentReadFilter`
is untouched in `apps/web/src/lib/assistant/doc-access.ts` and is the sole
authority for `published`-vs-`manage`.

| File                                                                           | Call           |
| ------------------------------------------------------------------------------ | -------------- |
| `apps/web/src/app/(app)/documents/page.tsx`                                    | `:86`          |
| `apps/web/src/app/(app)/documents/[id]/page.tsx`                               | `:444`         |
| `apps/web/src/app/(app)/documents/[id]/_actions.ts`                            | `:90`          |
| `apps/web/src/app/(app)/documents/[id]/_ai-actions.ts`                         | `:43`          |
| `apps/web/src/app/(app)/documents/[id]/read/page.tsx`                          | `:37`          |
| `apps/web/src/app/(app)/documents/[id]/versions/[versionId]/download/route.ts` | `:75`          |
| `apps/web/src/app/api/search/route.ts`                                         | `:108`         |
| `apps/web/src/lib/assistant/tools.ts`                                          | `:355`         |
| `apps/web/src/lib/assistant/document-content.ts`                               | `:101`, `:193` |
| `apps/web/src/app/(app)/assistant/_document-reader-actions.ts`                 | `:49`          |
| `apps/web/src/lib/api/query.ts`                                                | `:133`         |

**Native security that must survive:** `documents/[id]/_send-email.ts` (commit
`84e18618`) keeps `assertCan('documents.manage')` + an explicit
`eq(documents.status, 'published')`. That is an **independent outbound-content
layer**, not Project Scope. It is a mixed file — see §5.

### 2.3 People / safe-distance / journals — Project Scope is the _only_ filter

These are the highest-risk files. In each, `projectScopePredicate` is the sole
row restriction; there is no `moduleScopeWhere` fallback.

| File                                                                   | Project Scope usage                                       | Is it the only filter?                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/web/src/app/(app)/people/page.tsx:73,78`                         | `projectScopePredicate(scope, { personCol: people.id })`  | **YES** — `people` has no `PREFIX_SCOPE` entry                       |
| `apps/web/src/app/(app)/people/[id]/page.tsx:275,280`                  | `recordInProjectScope(...)` detail guard                  | **YES**                                                              |
| `apps/web/src/app/(app)/people/export.csv/route.ts:62,63`              | same predicate                                            | **YES**                                                              |
| `apps/web/src/app/(app)/tools/safe-distance/page.tsx:98,99`            | `projectScopePredicate(...)`                              | **YES** — `safe_distance_records` is absent from `TABLE_SCOPE`       |
| `apps/web/src/app/(app)/tools/safe-distance/export.csv/route.ts:62,63` | same predicate                                            | **YES**                                                              |
| `apps/web/src/app/(app)/journals/_lib.ts:62,63`                        | replaces `return undefined` in the `read.all` branch only | **No** — the `.site`/`.self` branches below are native bespoke logic |

Analytics: `people` **is** a `TABLE_SCOPE` key (`read: { key: 'admin.users.manage' }`,
no columns, no exemption). `safe_distance_records` is **not** in `TABLE_SCOPE`.

### 2.4 Mixed production files — split

| File                                                | Hits | Native part                                                                                                                                                       | Project Scope part                                                                                                                                                           | Verdict                                              |
| --------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/web/src/lib/visibility.ts`                    | 12   | `moduleScopeWhere` tier ladder, `canSeeRecord`, `resolveVisibilityTier`, `mySiteIds`, `ownPredicates`                                                             | `resolveProjectScopeIn` call, `scopeCond`, `isAlwaysFalse` short-circuit, Project Scope in `canSeeRecord`                                                                    | **REFACTOR** — restore the exact `9107bd13~1` bodies |
| `packages/analytics/src/server/scope.ts`            | 43   | `TABLE_SCOPE`, `PREFIX_SCOPE`, `ALWAYS_ALLOWED`, `tierFor`, `resolveEntity` tier branches, `analyticsScopeFingerprint` (minus scope fields), `validateScopeSpecs` | `scopeContribution`, `ProjectScopeExemption`, `PROJECT_SCOPE_EXEMPTIONS`, `projectScopeExempt` spec field, `projectScopeKind`/`orgUnitIds`/`projectPersonIds` on the subject | **REFACTOR** — the highest-risk file                 |
| `apps/web/src/lib/analytics-access.ts`              | 4    | `resolveAnalyticsAccess`, `scopeAnalyticsEntities`, `runAuthorizedBhql`, `canReadAppResponses`                                                                    | subject construction with Project Scope fields                                                                                                                               | **REFACTOR**                                         |
| `apps/worker/src/lib/report-run-as-scope.ts`        | 8    | `reportRunAsScopeSubject`, `scopeReportRunAsSources`                                                                                                              | `projectScope` parameter threading, fail-closed `unknown` comment                                                                                                            | **REFACTOR**                                         |
| `apps/worker/src/workers/reports.ts`                | 2    | scheduled report run-as wiring                                                                                                                                    | `:61` import, `:563` `await resolveProjectScopeIn(requestCtx, tx)`                                                                                                           | **REFACTOR**                                         |
| `packages/analytics/src/server/index.ts`            | 9    | all other server exports                                                                                                                                          | 8 re-exports from `./project-scope` (`:17-39`)                                                                                                                               | **REFACTOR**                                         |
| `apps/web/src/lib/assignment-validity.ts`           | 1    | `isAssignmentEffectiveOn`, `effectiveOn` (native date helpers)                                                                                                    | **comment only** (`:5`)                                                                                                                                                      | **KEEP**, drop the comment reference                 |
| `packages/db/src/converge-personnel-assignments.ts` | 1    | native personnel-placement convergence                                                                                                                            | **comment only** (`:248`)                                                                                                                                                    | **KEEP**, drop the comment reference                 |

### 2.5 Native security fixes that must NOT be touched

| File / commit                                                                              | What it is                                                                                | Why it survives                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/analytics-access.ts` @ `114219ac`                                        | `canReadAppResponses` = `forms.response.read.all` **only** (was `\|\| read.site`)         | Pure native permission fix. The comment _mentions_ Project Scope as justification but the code is tier-only.                                         |
| `apps/web/src/app/(app)/dashboard/_widget-access.ts` @ `f16aa3d7`                          | `TRUSTED_RESPONSE_KPI = ['forms.response.read.all']` replacing `[...FORMS, ...ANALYTICS]` | Pure native permission fix. `FORMS` left intact for `canSeeOrgAggregates`.                                                                           |
| `apps/web/src/app/(app)/documents/[id]/_send-email.ts` @ `84e18618`                        | `assertCan('documents.manage')` + explicit `status='published'`                           | Independent outbound-content layer.                                                                                                                  |
| `packages/analytics/src/server/scope.ts:563` `ALWAYS_ALLOWED = new Set(['app_responses'])` | born in `9c5859ea`                                                                        | The **`app_responses` entity** is native. The `Set` only expresses "no Project Scope predicate" — it disappears with the scope, not with the entity. |

### 2.6 Documentation that asserts Project Scope as product behaviour

These are **user-facing product claims** written by `9107bd13` that Project Scope
made true. Removing Project Scope makes them **false** and they must be rewritten,
not deleted silently.

| Location                                                       | Claim that becomes false                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/lib/manual/content/oversight-admin.ts`           | "**A read-all permission is not the whole company.** … The location rule is still applied on top of it."                 |
| `apps/web/src/lib/manual/content/oversight-admin.ts`           | "**Only two things give a company-wide view.**"                                                                          |
| `apps/web/src/lib/manual/content/oversight-admin.ts`           | "**Nobody is widened automatically.** An account with no location assignment reaches nothing."                           |
| `apps/web/src/lib/manual/content/people.ts` (added `9107bd13`) | "**Someone with no active assignment sees an empty directory.** Every person's page, including their own, is not found." |
| `apps/web/src/lib/manual/content/people.ts`                    | "**Read all** does not mean **everyone**" section                                                                        |
| `packages/i18n/src/messages/{en,es,fr}.json`                   | the compiled translations of both articles above                                                                         |
| `docs/hse-project-scope-15b3-audit.md`                         | the whole Project Scope audit trail                                                                                      |

---

## 3. Production Code

### 3.1 DELETE — files with no native content

```
apps/web/scripts/project-scope-verification.ts
apps/web/scripts/project-scope-live-verification.ts
apps/web/src/lib/project-scope.ts
apps/web/src/lib/project-scope-predicate.ts
apps/web/src/lib/assistant/document-project-scope.ts
apps/web/src/lib/testing/project-scope-fixture.ts
packages/analytics/src/server/project-scope.ts
```

### 3.2 RESTORE — exact pre-Project-Scope bodies

**`apps/web/src/lib/visibility.ts`** — verified original at `9107bd13~1`:

```ts
export async function moduleScopeWhere(
  ctx: RequestContext,
  _tx: Database,
  cols: ModuleScopeCols,
): Promise<SQL | undefined> {
  const tier = resolveVisibilityTier(ctx, cols.prefix)
  if (tier === 'all' || (cols.prefix === 'hazid' && can(ctx, 'hazid.read.others'))) return undefined
  const ownConds = await ownPredicates(ctx, cols)
  if (tier === 'site' && cols.siteCol) {
    const sites = mySiteIds(ctx)
    if (sites.length > 0) return or(inArray(cols.siteCol, sites), ...ownConds)
    // read.site but no site scope assigned → fall through to own-only.
  }
  if (ownConds.length === 0) return sql`false`
  return ownConds.length === 1 ? ownConds[0]! : or(...ownConds)!
}
```

`canSeeRecord` reverts to the same shape: tier check, then
`tier === 'site' && rec.siteId && mySiteIds(ctx).includes(rec.siteId)`, then the
own legs, then `false`. The `recordInProjectScope` guard and the
`resolveProjectScopeIn` call are removed. `_tx` returns to being unused.

**`packages/analytics/src/server/scope.ts`** — verified original at `9c5859ea`
for the tier branch:

```ts
if (tier === 'site' && siteCol) {
  if (subject.siteIds.length === 0) return { visible: false }
  return { visible: true, filter: rule(siteCol, subject.siteIds) }
}
```

Removed: `scopeContribution`, `ProjectScopeExemption`,
`PROJECT_SCOPE_EXEMPTIONS`, the `projectScopeExempt` field on `ScopeSpec`, the
`projectScopeKind` / `orgUnitIds` / `projectPersonIds` subject fields, and the
`orgUnitFilter` plumbing in `resolveEntity`. `analyticsScopeFingerprint` reverts
to `{ super, sites, person, user }`. `ALWAYS_ALLOWED` loses `app_responses`
(meaningless with no scope) but the `app_responses` **entity template** stays.

### 3.3 RESTORE — documents call sites

Replace `await documentAuthorizationFilter(ctx, tx)` with `documentReadFilter(ctx)`
at all 11 sites. `documentReadFilter` is already present and unchanged in
`doc-access.ts`:

```ts
export function documentReadFilter(ctx: RequestContext): SQL | undefined {
  return canManageDocuments(ctx) ? undefined : eq(documents.status, 'published')
}
```

### 3.4 REFACTOR — the one-occurrence surfaces

For each, delete the `resolveProjectScopeIn` import, the resolver call, and the
`projectScopePredicate` / `recordInProjectScope` AND-term — **and read the
surrounding file to decide what replaces the filter.** See §7.1: three of these
have no native replacement and would become tenant-wide.

### 3.5 KEEP — native, untouched

```
packages/db/src/schema/org.ts (people_assignments)   — native, 8e98f218
packages/db/src/schema/iam.ts (RoleScope, role_assignments.scope)
apps/web/src/lib/assistant/doc-access.ts (documentReadFilter)
apps/web/src/lib/visibility.ts (tier ladder, mySiteIds, ownPredicates)
packages/analytics/src/server/scope.ts (TABLE_SCOPE, PREFIX_SCOPE, tierFor)
apps/web/src/lib/analytics-access.ts (canReadAppResponses @ 114219ac)
apps/web/src/app/(app)/dashboard/_widget-access.ts (TRUSTED_RESPONSE_KPI @ f16aa3d7)
apps/web/src/app/(app)/documents/[id]/_send-email.ts (84e18618)
```

---

## 4. Tests

### 4.1 Project Scope 专用测试 — DELETE

| File                                                         | Tests         | Notes                                                                  |
| ------------------------------------------------------------ | ------------- | ---------------------------------------------------------------------- |
| `apps/web/src/lib/project-scope-contract.test.ts`            | 28            | resolver contract                                                      |
| `apps/web/src/lib/project-scope-oracle.test.ts`              | ~12           | resolver vs `people_assignments`                                       |
| `apps/web/src/lib/documents-project-scope-contract.test.ts`  | 24            | all four scope states on documents                                     |
| `apps/web/src/lib/document-send-email-authorization.test.ts` | part          | **split** — the email path is native, see §4.3                         |
| `apps/web/src/lib/insights-cache-scope.test.ts`              | cases E, F, G | **split** — the Project Scope discriminator cases go; A–D are native   |
| `apps/web/src/lib/export-scope-authorization.test.ts`        | 18 refs       | **split** — see §4.3                                                   |
| `apps/web/src/lib/journals-scope-contract.test.ts`           | 26 refs       | **split** — see §4.3                                                   |
| `apps/web/src/lib/safe-distance-scope-contract.test.ts`      | 10 refs       | **DELETE** — safe-distance has no native scope story                   |
| `apps/web/src/lib/locations-export-scope-contract.test.ts`   | 3 refs        | **REVIEW** — pins the locations/org_units contract; may be salvageable |
| `apps/worker/src/lib/report-run-as-scope.test.ts`            | 8 refs        | **split** — subject construction is native; scope fields are not       |
| `packages/analytics/src/server/scope.test.ts`                | 51 refs       | **split** — the largest mixed file; see §4.3                           |
| `packages/analytics/src/server/scope-report-views.test.ts`   | 14 refs       | **split** — see §4.3                                                   |

### 4.2 BeaconHS 原生权限测试 — KEEP

```
apps/web/src/lib/authorization-bridge-contract.test.ts   (43 → fewer; tier ladder is native)
apps/web/src/lib/ppe-read-tier-contract.test.ts          (catalogue + role matrix, native)
apps/web/src/lib/hazid-read-others-contract.test.ts       (native hazid opt-in)
apps/web/src/lib/documents-published-rule-contract.test.ts (published-vs-manage, native)
apps/web/src/lib/document-pdf-url-authorization.test.ts  (native)
apps/web/src/lib/document-version-download-authorization.test.ts (native)
apps/web/src/lib/insights-trusted-card-scope-contract.test.ts (canReadAppResponses @ 114219ac)
apps/web/src/app/(app)/dashboard/_widget-access.test.ts  (17 tests @ f16aa3d7)
apps/web/src/app/(app)/dashboard/_metrics-scope.test.ts  (2 refs; foreman fixture is native)
apps/web/src/lib/feed-scope-contract.test.ts             (2 refs; see §4.3)
apps/web/src/lib/report-scope-authorization.test.ts      (1 ref; see §4.3)
apps/web/src/lib/people-assignment-contract.test.ts      (native placement)
```

### 4.3 混合测试 — must be split, not deleted wholesale

`packages/analytics/src/server/scope.test.ts` is the clearest example. It contains
**both**:

- **Native** (keep): `tierFor` matrix, the site-tier tests
  `:114-120` _"withholds the entity when the site tier resolves to no sites"_
  and `:122` _"falls back to the owner column when the entity has no site column"_,
  the `read.all` branch, the `ALWAYS_ALLOWED` / `app_responses` exemption test.
- **Project Scope** (delete): every `projectScopeKind` /
  `orgUnitIds` / `projectPersonIds` fixture override, the `empty`/`unknown` deny
  cases, the exemption-named cases, the side-by-side
  `{...formResponses}` / `app_responses` restricted-subject test, and the
  `subject()` factory's `projectScopeKind: 'unrestricted'` default.

Note `:504-512`'s comment — _"15B-3B did not change that, so it is asserted rather
than assumed to pass through"_ — marks a **native** test that must be retained and
whose comment should be reworded once Project Scope is gone.

---

## 5. Commit 分析 / Commit Analysis

| Commit                                                            | Project Scope content to delete                                                                                                                                 | Native content to keep                                                                                                                                                                           | Manual refactor? |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `6d3a1fbc` `fix(auth): enforce feed project scope`                | `_data.ts`: `resolveProjectScopeIn` + `projectScopePredicate` AND-term; `feed-scope-contract.test.ts` entirely                                                  | feed list/detail wiring stays                                                                                                                                                                    | No               |
| `2c80b775` `fix(auth): enforce journal project scope`             | `journals/_lib.ts` `read.all` branch → `return undefined`; `journals-scope-contract.test.ts` Project Scope cases; `docs/hse-project-scope-15b3-audit.md` append | journals' own `.site`/`.self` bespoke ladder, the `'super-admin'` sentinel guard in `authorTenantUserId`, `getAuthorPersonId` soft-delete exclusion, `picker-scaling-contract.test.ts`           | No               |
| `c976e796` `fix(auth): define project scope exemptions`           | `PROJECT_SCOPE_EXEMPTIONS` array, `ProjectScopeExemption` type, `projectScopeExempt` spec field, the `scope.test.ts` exemption cases, audit §14 append          | `TABLE_SCOPE` column declarations, `validateScopeSpecs`                                                                                                                                          | No               |
| `84e18618` `fix(auth): enforce document email project scope`      | the `documentAuthorizationFilter` half in `_send-email.ts`; Project Scope cases in `documents-project-scope-contract.test.ts`                                   | **`assertCan('documents.manage')` + explicit `eq(documents.status,'published')`** — the outbound-content authorization; its own test file                                                        | No               |
| `e61f39ac` `test(auth): pin locations export scope contract`      | cases asserting the `org_units` Project Scope semantics                                                                                                         | any case asserting the `level='customer'` view contract                                                                                                                                          | No               |
| `d6080b7d` `style: format authorization files`                    | nothing semantic                                                                                                                                                | nothing — **Prettier-only**; survives as-is                                                                                                                                                      | No               |
| `c184b678` `test(auth): harden documents project scope contract`  | whole file (test-only, brace-depth extraction of a Project Scope spec)                                                                                          | nothing                                                                                                                                                                                          | No               |
| `114219ac` `fix(auth): restrict trusted KPI to response read all` | **nothing** — the only Project Scope mention is a justifying comment                                                                                            | **`canReadAppResponses` = `forms.response.read.all` alone**; the 8-case matrix in `insights-trusted-card-scope-contract.test.ts`; the `app_responses` restricted-subject test's _exemption_ half | Comment reword   |
| `f16aa3d7` `fix(auth): align dashboard trusted KPI gate`          | **nothing**                                                                                                                                                     | **`TRUSTED_RESPONSE_KPI`**, the 17 `_widget-access.test.ts` tests, the two-KPI `it.each` matrix                                                                                                  | Comment reword   |

**Do not `git revert` any of the nine.** `84e18618`, `114219ac` and `f16aa3d7`
each contain a genuine native security fix entangled with Project Scope
justification comments. `d6080b7d` is format-only and would be reverted for no
reason at all.

---

## 6. BeaconHS 原生权限恢复方案 / Restoration Plan

Target model, top to bottom, with nothing in between:

```
Tenant / RLS
    ↓
BeaconHS Permission        <prefix>.read.all | .read.site | .read.self
    ↓
BeaconHS Role Scope        role_assignments.scope  (one of six RoleScope variants)
    ↓
BeaconHS Visibility Tier   tierFor / resolveVisibilityTier
    ↓
Record                    RLS-bounded
```

### 6.1 Domain-by-domain target behaviour

| Domain                | Target                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Documents**         | `documentReadFilter(ctx)` only. `documents.manage` ⇒ all documents; otherwise `status='published'`. Project Scope gone. **No native replacement for the four-state rule** — the library reverts to a flat published/manage model.                                        |
| **Forms / Responses** | `forms.response.read.all` ⇒ tenant-wide (RLS). `.read.site` ⇒ `site_org_unit_id IN mySiteIds`, falling through to own-only when `siteIds` is empty (**original BeaconHS**, §7.4). `.read.self` ⇒ own. The `app_responses` KPI aggregate stays `read.all`-only.           |
| **Analytics**         | `resolveEntity` = `tierFor` → tier branch (`all` ⇒ no filter; `site` ⇒ `siteCol IN siteIds` or withhold; `self` ⇒ owner columns). `scopeContribution` and the whole exemption system deleted.                                                                            |
| **Dashboard**         | `WIDGET_PERMISSIONS` unchanged. `TRUSTED_RESPONSE_KPI` unchanged. `canSeeOrgAggregates` / `FORMS` unchanged.                                                                                                                                                             |
| **Export (CSV)**      | Each route reverts to whatever the native tier ladder gave it. **Three routes (`people`, `safe-distance`, and the journals `read.all` branch) currently rely on Project Scope as their only filter and will widen — see §7.1.**                                          |
| **API**               | `apps/web/src/lib/api/query.ts` → `documentReadFilter(ctx)`. Report/view authorization stays on `TABLE_SCOPE` + tiers.                                                                                                                                                   |
| **Worker**            | `reportRunAsScopeSubject(ctx)` — the `projectScope` parameter is deleted; the `unknown`-fails-closed comment goes with it. `reports.ts:563` deletes the `resolveProjectScopeIn` call and its import.                                                                     |
| **Assistant**         | `tools.ts` / `document-content.ts` / `_document-reader-actions.ts` → `documentReadFilter(ctx)`.                                                                                                                                                                          |
| **People**            | **No native tier exists.** `people` is absent from `PREFIX_SCOPE`; in analytics it is a single flat `admin.users.manage` key. Removing Project Scope leaves the web directory with **no row filter beyond RLS**. This needs a product decision, not a mechanical revert. |

### 6.2 The manual becomes untrue

`9107bd13` taught users, in plain language, that "Read all is not the whole
company" and that "an account with no location assignment reaches nothing".
After removal, `read.all` **is** the whole company, and an unassigned account
reaches everything its permission allows. Both articles plus their three
compiled translations must be rewritten, not dropped — dropping them removes the
`who you can see` / `read all` / `empty directory` search keys the assistant uses.

---

## 7. 风险 / Risks

### 7.1 CRITICAL — three surfaces have no native replacement filter

| Surface                                                          | Current filter                                            | After removal                                                                                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `people/page.tsx`, `people/[id]/page.tsx`, `people/export.csv`   | `projectScopePredicate(scope, { personCol: people.id })`  | **Entire tenant roster** for any `people.read.*` holder. A foreman sees every employee.                                                                                                      |
| `tools/safe-distance/page.tsx`, `tools/safe-distance/export.csv` | `projectScopePredicate(scope, { orgUnitCol, personCol })` | **Every safe-distance record in the tenant.**                                                                                                                                                |
| `journals/_lib.ts` `read.all` branch                             | `projectScopePredicate(...)`                              | Reverts to `return undefined` ⇒ tenant-wide. This _is_ the pre-15B-2 model, so it is a restoration, but it is a visible widening for any `journals.read.all` holder who is not company-wide. |

None of these is a mechanical revert. Each needs either a native tier
(`people.read.all` / `.read.site` does not exist in `PERMISSION_CATALOGUE`) or an
explicit product acceptance of the widening. **This is the single largest blocker.**

### 7.2 HIGH — analytics cache-key collision returns

`insights-cache-scope.test.ts` cases E and F exist because `unrestricted` and a
scope that resolved to `empty` both produce empty id lists, so without a
discriminator **a caller who can see nothing could be served a company-wide
cached result**. `analyticsScopeFingerprint` at `9c5859ea` was
`{ super, sites, person, user }` — **it never included the permission tier**.
Removing Project Scope removes the discriminator and restores that shape. Two
callers with identical `sites`/`person`/`user` but different tiers are the
collision. `activeRoleId` and `effectiveRoleKeys` in `scopeKey`
(`analytics-access.ts:67-72`) mitigate this, but only if two callers never share
a role — which a custom-role-per-department setup can violate.

### 7.3 MEDIUM — the `read.site` divergence is NOT resolved by this removal

See §7.4. The user's stated premise that Analytics' withholding is a Project
Scope artifact is **incorrect**; it is original. Removal neither fixes nor
aggravates it.

### 7.4 The `read.site` + no-site-scope divergence is pre-existing, native

Verified against history:

| Question                                         | Answer                                                                                                                                                                                 | Evidence                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Original `read.site` semantics                   | `{type:'sites'}` scope ⇒ `site_col IN siteIds`; tier from `.read.all`/`.read.site`/`.read.self`                                                                                        | `9c5859ea`, `9107bd13~1`                                                                                                         |
| Must the Role Scope be `{type:'sites'}`?         | **No** — permission and scope are independent; 5 of the 6 `RoleScope` variants carry no sites                                                                                          | `packages/db/src/schema/iam.ts:49-55`; `admin/users/_scope-data.ts:39,56` defaults to `{type:'self'}`                            |
| Original behaviour with no sites — Web           | **own-only fallback**                                                                                                                                                                  | present at `9107bd13~1`, comment _"read.site but no site scope assigned → fall through to own-only."_ predates Project Scope     |
| Original behaviour with no sites — Analytics     | **withhold**                                                                                                                                                                           | `9c5859ea:376` `if (subject.siteIds.length === 0) return { visible: false }` — in a file with **zero** Project Scope occurrences |
| Is the Web fallback Project Scope's doing?       | **No.** `9107bd13` only added a `NOTE` annotation on top of existing code                                                                                                              | `visibility.ts:218-221`                                                                                                          |
| Is Analytics' withholding Project Scope's doing? | **No.** It predates it entirely                                                                                                                                                        | `9c5859ea`                                                                                                                       |
| What should they unify to after removal?         | **Nothing changes.** The divergence is BeaconHS-native                                                                                                                                 | —                                                                                                                                |
| Other modules affected?                          | **Yes — all of them.** Both `moduleScopeWhere` and the `tier === 'site'` branch are generic. `incidents`, `ca`, `hazid`, `training`, `journals`, `inspections`, `equipment`, `reports` | `PREFIX_SCOPE` has 8 prefixes; `TABLE_SCOPE` has 31 keys                                                                         |

An **adjacent** native divergence also persists and is independent of this one:
the Web site tier is `or(inArray(siteCol, sites), ...ownConds)` — **site ∪ own** —
while the Analytics site tier is `rule(siteCol, siteIds)` — **site only**. Web is
wider even when a sites scope exists.

Test-coverage asymmetry worth noting: the Analytics half is **pinned** by
`scope.test.ts:114-120` and `:504-512`; the Web half is **not pinned by any test** —
every web `read.site` fixture supplies a sites list
(`authorization-bridge-contract.test.ts:240`, `_metrics-scope.test.ts:81-82`,
`report-scope-authorization.test.ts:181`, `_equipment-policy.test.ts:27`).

### 7.5 MEDIUM — `people_assignments` becomes an orphaned table

`people_assignments` is **native** (`8e98f218`) and keeps other consumers:
`packages/compliance/src/audience.ts`, `identity.ts`,
`people/_actions/assignments.ts`, `people/[id]/page.tsx` (Location assignments
tab), `people-assignment-contract.test.ts`, `people-org-relational-integrity.test.ts`,
`personnel-placement-repair.ts`. It is **not** orphaned. But its _authorization_
role disappears: after removal, placement no longer narrows anything, so
"Location assignments" becomes purely informational and a user with no assignment
is no longer protected by it. The manual and the People article must say so.

### 7.6 Test coverage that must be rebuilt

Per the CI contract in `AGENTS.md`, all six gates must pass. Removing Project
Scope deletes 51 hits from `scope.test.ts` alone. The `web` suite is 1666 tests /
215 files; the deleted and split files account for roughly 200 of them. Every
retained native ladder test must be re-verified, and §7.4's Web half currently has
**no** test to lose — so removing Project Scope will not break it, but it will also
not be caught if it drifts.

### 7.7 Genuinely missing native capability

Only one, and it is the reason §7.1 is a blocker rather than a formality:
**`people` and `safe_distance_records` have no native read tier.** Everything else
in the inventory has a working native ladder.

### 7.8 Gate state that removal will not change

`pnpm format:check` currently fails with **20 `.opencode/**/*.md` Prettier
failures** — a pre-existing baseline defect, unrelated to Project Scope. Rule 8
of `AGENTS.md` forbids suppressing a gate, so this must be resolved on its own
before any removal commit can be called green.

---

## 8. 最终删除/恢复清单 / Final Action List

### DELETE

```
apps/web/scripts/project-scope-verification.ts
apps/web/scripts/project-scope-live-verification.ts
apps/web/src/lib/project-scope.ts
apps/web/src/lib/project-scope-predicate.ts
apps/web/src/lib/assistant/document-project-scope.ts
apps/web/src/lib/testing/project-scope-fixture.ts
packages/analytics/src/server/project-scope.ts
apps/web/src/lib/project-scope-contract.test.ts
apps/web/src/lib/project-scope-oracle.test.ts
apps/web/src/lib/documents-project-scope-contract.test.ts
apps/web/src/lib/safe-distance-scope-contract.test.ts
docs/hse-project-scope-15b3-audit.md
```

### RESTORE

```
apps/web/src/lib/visibility.ts            moduleScopeWhere + canSeeRecord -> 9107bd13~1 bodies
packages/analytics/src/server/scope.ts    resolveEntity tier branch -> 9c5859ea shape;
                                          drop scopeContribution, ProjectScopeExemption,
                                          PROJECT_SCOPE_EXEMPTIONS, projectScopeExempt,
                                          subject scope fields, ALWAYS_ALLOWED entry
packages/analytics/src/server/index.ts    drop the 8 ./project-scope re-exports (:17-39)
apps/web/src/lib/analytics-access.ts      drop Project Scope subject fields
apps/worker/src/lib/report-run-as-scope.ts drop the projectScope parameter + comment
apps/worker/src/workers/reports.ts        drop :61 import and :563 resolver call
11 document call sites                     documentAuthorizationFilter -> documentReadFilter(ctx)
apps/web/src/lib/assignment-validity.ts   drop the :5 comment reference only
packages/db/src/converge-personnel-assignments.ts  drop the :248 comment reference only
knip.ts                                    drop the two Project Scope script entries
```

### KEEP

```
apps/web/src/lib/analytics-access.ts                        canReadAppResponses  (114219ac)
apps/web/src/app/(app)/dashboard/_widget-access.ts          TRUSTED_RESPONSE_KPI (f16aa3d7)
apps/web/src/app/(app)/dashboard/_widget-access.test.ts     17 tests
apps/web/src/lib/insights-trusted-card-scope-contract.test.ts  8 tests
apps/web/src/app/(app)/documents/[id]/_send-email.ts        assertCan + explicit published (84e18618)
apps/web/src/lib/assistant/doc-access.ts                    documentReadFilter
packages/db/src/schema/org.ts                                people_assignments
packages/db/src/schema/iam.ts                                RoleScope, role_assignments.scope
visibility.ts  moduleScopeWhere tier ladder / mySiteIds / ownPredicates
scope.ts       TABLE_SCOPE / PREFIX_SCOPE / tierFor / resolveEntity tier branches
javadocs       d6080b7d Prettier-only formatting
```

### REFACTOR

```
apps/web/src/app/(app)/people/page.tsx                      BLOCKED - see 7.1
apps/web/src/app/(app)/people/[id]/page.tsx                 BLOCKED - see 7.1
apps/web/src/app/(app)/people/export.csv/route.ts           BLOCKED - see 7.1
apps/web/src/app/(app)/tools/safe-distance/page.tsx         BLOCKED - see 7.1
apps/web/src/app/(app)/tools/safe-distance/export.csv/route.ts  BLOCKED - see 7.1
apps/web/src/app/(app)/journals/_lib.ts                     read.all branch -> return undefined
packages/analytics/src/server/scope.test.ts                 split: native tier tests vs Project Scope fixtures
packages/analytics/src/server/scope-report-views.test.ts    split
apps/web/src/lib/journals-scope-contract.test.ts            split
apps/web/src/lib/export-scope-authorization.test.ts         split
apps/web/src/lib/insights-cache-scope.test.ts               keep A-D, drop E-G
apps/worker/src/lib/report-run-as-scope.test.ts             split
apps/web/src/lib/feed-scope-contract.test.ts                split
apps/web/src/lib/report-scope-authorization.test.ts         split
apps/web/src/lib/document-send-email-authorization.test.ts  keep the manage+published cases
apps/web/src/lib/authorization-bridge-contract.test.ts       keep the tier-ladder cases (43 -> fewer)
apps/web/src/lib/manual/content/oversight-admin.ts          REWRITE the "read all is not the whole company" claims
apps/web/src/lib/manual/content/people.ts                    REWRITE "no assignment sees an empty directory"
packages/i18n/src/messages/{en,es,fr}.json                  recompile both articles
```

### REVIEW

```
apps/web/src/lib/locations-export-scope-contract.test.ts    does it pin a Project Scope rule or the customer-level view?
apps/web/scripts/personnel-placement-repair.ts              native data repair kept for Project Scope - still needed for compliance audience?
docs/hse-project-scope-15b3-audit.md                          other untracked docs/ reference it - retire or annotate?
apps/web/src/lib/insights-cache-scope.test.ts cases A-D      still meaningful without a Project Scope discriminator?
permissive read.site + no site scope                         native divergence, unresolved; see 7.4
Web site tier = site U own vs Analytics site tier = site     native divergence, unresolved; see 7.4
```

---

## 9. 执行摘要 / Execution Summary

Project Scope touches **58 files**, but the genuine native security work in the
same window is small and identifiable: `canReadAppResponses` (`114219ac`),
`TRUSTED_RESPONSE_KPI` (`f16aa3d7`) and the documents email authorization
(`84e18618`). None of the three needs Project Scope to be correct.

Two findings materially change the shape of this task:

1. **The `read.site` divergence is not a Project Scope artifact.** The Web
   own-only fallback predates Project Scope (`9107bd13~1`); the Analytics
   withhold predates it further (`9c5859ea`). Removal resolves nothing here, and
   both halves should be left exactly as they are.

2. **Removal is not mechanically safe.** `people` (3 surfaces) and
   `safe_distance_records` (2 surfaces) have **no native read tier** — Project
   Scope is their only row filter. Reverting them makes those lists and exports
   tenant-wide for every permission holder. That is a product decision, and it
   blocks the clean part of the work from being landed as one change.

Recommended sequencing: land the unblocked removals (dedicated modules, documents
revert, analytics/worker plumbing, test splits, manual rewrite) and resolve
§7.1 as a separate, explicitly accepted change.
