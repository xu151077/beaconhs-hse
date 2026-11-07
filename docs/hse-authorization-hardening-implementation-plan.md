# BeaconHS HSE — Authorization Boundary Hardening: Implementation Plan

> **Plan only. No implementation performed. No commit made.**
> Evidence: `docs/hse-authorization-hardening-analysis.md` ·
> Fixes: `docs/hse-authorization-hardening-design.md`
> Baseline: HEAD `454658c4`, read-only phase complete.

---

## 中文摘要

**本阶段不需要任何 migration，不改 RLS，不新增数据模型。**

**修复顺序有强依赖，不能并行：**

```
F1  entity gate  ──▶ F2  row scope  ──▶ F3  insights/BHQL
                       │
F5  vehicle-log detail ──▶ F6  PPE tier  （与 F1/F2 无依赖）
```

**F2 必须在 F1 之后**——否则会注入一个"能查但没权限"的谓词。
**F3 必须与 F2 同批**——`runCardCached` 是独立副本，只修 `runAuthorizedBhql`
会让 `/dashboard` 继续泄露。

**最容易被漏掉的一条：** `insights/_data.ts:41` 的结果缓存键当前只含
`tenantId`，**不含用户**。一旦引入 scope，同一租户内 A 用户的行会被缓存命中
返回给 B 用户。这是 F3 里必须一起改的部分。

**全部修复共用一个硬约束（已验证）：** `packages/reports` 的依赖里没有
`@beaconhs/tenant`，位于 `apps/web` 之下，**无法 import
`@/lib/visibility`**。所以 scope 必须在 `apps/web` 计算后作为**数据**传入。

---

## 1. Findings

Ten, ranked. All verified against `454658c4`. **Recorded, not fixed.**

| ID       | Sev          | Finding                                                                                                                                                   | Location                                                                                         |
| -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **H-1**  | **Critical** | Reports/insights bypass every module read permission and all row scope. A foreman can run the seeded `osha_300_log` and export tenant-wide incidents/CAs. | `reports/_run.ts:23-35`; `packages/reports/src/run.ts:46-58`; `analytics-access-policy.ts:12-20` |
| **H-2**  | **Critical** | Scheduled reports resolve the run-as user's `scopes` (`:521`) then discard them (`:137-140`), emailing tenant-wide data indefinitely.                     | `apps/worker/src/workers/reports.ts`                                                             |
| **H-3**  | **Critical** | Vehicle-log detail page has no permission check; only `?tab=edit` is gated.                                                                               | `equipment/vehicle-log/[id]/page.tsx:870, 884`                                                   |
| **H-4**  | **Critical** | PPE list + detail have no permission gate and no scope; nav ungated. A `worker` (0 ppe permissions) reads the whole register incl. holder names.          | `ppe/page.tsx:116`; `ppe/[id]/page.tsx:884`; `nav/registry.ts:188`                               |
| **H-5**  | High         | Analytics authorisation is a **blocklist** (`EXCLUDE_TABLES`); any table added to `TENANT_SCOPED_TABLES` is auto-granted tenant-wide.                     | `packages/analytics/src/server/discover.ts:35-65, 274`                                           |
| **H-6**  | High         | Two system cards reach tenant-wide `form_responses` with no `forms.response.read.*`.                                                                      | `insights/_widgets.ts:659-673, 725-742`                                                          |
| **H-7**  | Medium       | `loadDefinitionById` omits the `state` filter → archived definitions viewable/re-runnable/exportable by id.                                               | `reports/_definitions.ts:41` vs `:28`                                                            |
| **H-8**  | Medium       | `reports/layout.tsx` admits `reports.builder` alone, then renders the definition list without `reports.read`.                                             | `reports/layout.tsx:16-21`; `reports/page.tsx:40, 51`                                            |
| **H-9**  | Medium       | `/insights` nav gated on `reports.read`, not `insights.read`.                                                                                             | `nav/registry.ts:209`                                                                            |
| **H-10** | Info         | `canSeeSite` / `selfOnlyFilter` are dead code (0 call sites); `packages/tenant` has no tests.                                                             | `packages/tenant/src/index.ts:290, 302`                                                          |

**Baseline corrections recorded:** `PERMISSION_CATALOGUE` = **91** (not 89);
`canSeeSite` / `selfOnlyFilter` are **not** effective gates.

---

## 2. Root cause

**Two authorization systems that never met.**

```
SYSTEM A  module authorization   PERMISSION_CATALOGUE → ctx.permissions
                                  visibility.ts: moduleScopeWhere / canSeeRecord / recordVisibilityWhere
                                  ↓ operates on Drizzle PgColumn, returns Drizzle `SQL`
                                  used by ~40 list pages, ~45 detail pages, 13 CSV exports, global search

SYSTEM B  analytics authorization  nav.requiredPermission → reports.layout → runBeaconReport → compileCustomReport
                                  ↓ checks AREA access only; never a module read permission, never ctx.scopes
                                  ↓ emits raw parameterised SQL strings
```

The incompatibility is structural, not accidental: a Drizzle `SQL` object cannot
be pushed into a raw-SQL compiler, and `packages/reports` **cannot** import the
layer that owns `SQL` — verified, it does not depend on `@beaconhs/tenant` and
sits below `apps/web`.

`canAccessTemplate` (`packages/tenant/src/index.ts:136-154`) was the analytics
side's only content-level check, and it was solving a **different problem**
(Builder-app audience), so its presence masked the absence of a module gate.

**H-3 and H-4 are a separate, simpler cause:** an affordance flag was read as a
gate. Both pages compute `can(...)` and use it to show/hide controls, while the
surrounding `if (!isUuid(id)) notFound()` looked like an access check. Three
sibling routes in each module are correctly gated — the pattern was known and
simply not applied to the page.

**H-7/H-8/H-9 are consistency defects** in the reports area, not boundary gaps.

---

## 3. Proposed fix

| Fix    | Closes          | Change                                                                                                                                                                                                                                                 |
| ------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **F1** | H-1 (part), H-5 | Export `resolveVisibilityTier` + `mySiteIds` from `visibility.ts`; add `moduleReadGate(ctx, prefix)`. Filter `access.entities` by `readableReportEntityKeys(ctx)` in `loadAuthorizedReportCatalogInTransaction`.                                       |
| **F2** | H-1             | Add optional `scope?: ReportRuleGroup` to `BeaconReportRunOptions`; compose it last in `mergeFilters`. New `apps/web/src/lib/report-scope.ts` → `buildReportScope(ctx, tx, entities)` using `moduleScopeWhere`. `runReportForViewer` always passes it. |
| **F3** | H-1, H-6        | Apply the same two gates to **both** `runAuthorizedBhql` and the independent `runCardCached` copy. Add a scope fingerprint to the result cache key. Gate `trustedSystemCard` consumption on `forms.response.read.*`.                                   |
| **F4** | H-2             | `workers/reports.ts:137` passes the `requestCtx`-derived scope into `runBeaconReport`.                                                                                                                                                                 |
| **F5** | H-7, H-8, H-9   | Nav `/insights` → `insights.read`; layout requires `reports.read` to render the list; `loadDefinitionById` adds `ne(state,'archived')`; `export/route.ts` uses `requireExportContext()`.                                                               |
| **F6** | H-3             | `vehicle-log/[id]/page.tsx`: add the list's read-tier gate (`:86-92` verbatim) + `canSeeRecord` on the parent vehicle (mirroring `equipment/[id]/page.tsx:869-874`).                                                                                   |
| **F7** | H-4             | Add `ppe.read.self` + `ppe.read.site` (91 → 93). Gate + `moduleScopeWhere(personCol)` on list and detail; nav gate.                                                                                                                                    |
| **F8** | H-10            | **Separate change** — delete dead code. Excluded here for reviewability.                                                                                                                                                                               |

**Design rules that constrain the implementation:**

1. **No RLS change.** 190 policies are correct; all findings are within-tenant.
2. **No migration.** Every fix is a code path.
3. **New parameters stay optional** so the 4-argument `runBeaconReport` call
   sites in existing tests keep compiling.
4. **Scope is never sourced from `definition.query`** — a tenant author must not
   be able to widen past their own access.
5. **The entity gate becomes the allowlist** that `EXCLUDE_TABLES` is not
   (H-5), instead of inverting the blocklist.

---

## 4. Affected files

### F1 — entity gate

| File                                   | Change                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/web/src/lib/visibility.ts`       | `export` `resolveVisibilityTier` (:114) and `mySiteIds` (:120); add `moduleReadGate` |
| `apps/web/src/lib/report-catalog.ts`   | filter `access.entities` at :12-15                                                   |
| `apps/web/src/lib/analytics-access.ts` | expose the entity→prefix map                                                         |

### F2 — row scope

| File                                     | Change                                                           |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `apps/web/src/lib/report-scope.ts`       | **NEW** — `buildReportScope`                                     |
| `apps/web/src/app/(app)/reports/_run.ts` | pass `scope` into `runBeaconReport` (:25)                        |
| `packages/reports/src/run.ts`            | `scope?` on options (:11-15); compose in `mergeFilters` (:60-67) |

### F3 — insights

| File                                       | Change                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `apps/web/src/lib/analytics-access.ts`     | gate in `runAuthorizedBhql` (:63-75)                                           |
| `apps/web/src/app/(app)/insights/_data.ts` | gate in `runCardCached` (:32-58); **scope fingerprint in the cache key** (:41) |
| `insights/cards/[id]/export/route.ts`      | pair `isTrustedSystemCard` with `forms.response.read.*` (:78, :121)            |

### F4 — scheduled reports

| File                                 | Change                                              |
| ------------------------------------ | --------------------------------------------------- |
| `apps/worker/src/workers/reports.ts` | pass scope at :137-140 using `requestCtx` from :131 |

### F5 — reports-area gates

`apps/web/src/lib/nav/registry.ts` (:209) · `reports/layout.tsx` (:16-21) ·
`reports/_definitions.ts` (:41) · `reports/definitions/[id]/export/route.ts` (:28)

### F6 — vehicle-log

| File                                                         | Change                                     |
| ------------------------------------------------------------ | ------------------------------------------ |
| `apps/web/src/app/(app)/equipment/vehicle-log/[id]/page.tsx` | gate after :867; `canSeeRecord` after :886 |

### F7 — PPE

| File                                       | Change                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `packages/db/src/schema/iam.ts`            | + `ppe.read.self`, `ppe.read.site` (:215-223)                           |
| `packages/db/src/schema/iam.ts`            | `BUILTIN_ROLES`: `worker` + `ppe.read.self`; `foreman` + `ppe.read.all` |
| `apps/web/src/app/(app)/ppe/page.tsx`      | gate + `moduleScopeWhere` at :116                                       |
| `apps/web/src/app/(app)/ppe/[id]/page.tsx` | gate at :867; `canSeeRecord` after :886                                 |
| `apps/web/src/lib/nav/registry.ts`         | `requiredPermission: 'ppe.read.self'` (:188)                            |

**Totals: ~17 files, 2 permission keys, 0 migrations, 0 RLS changes.**

---

## 5. Tests

### 5.1 Per-fix regression tests

Every test is **negative** — it asserts data is _not_ returned, which is what
actually fails today.

| ID      | Fix | Asserts                                                                                                                  |
| ------- | --- | ------------------------------------------------------------------------------------------------------------------------ |
| T-S1-1  | F1  | foreman + `reports.read` resolves a catalogue: `incidents`/`corrective_actions` present; **`people`/`org_units` absent** |
| T-S1-2  | F2  | `buildReportScope` for a site-scoped foreman is non-null and every rule is site-scoped                                   |
| T-S1-3  | F2  | foreman runs `incidents_weekly` → rows ⊆ his `siteIds`                                                                   |
| T-S1-4  | F3  | `runAuthorizedBhql` for a foreman → rows ⊆ scope                                                                         |
| T-S1-5  | F3  | **cache key differs per user**; dashboard rows ⊆ scope                                                                   |
| T-S1-6  | F3  | foreman hits insights export → 403 (already true — pins it)                                                              |
| T-S1-7  | F4  | schedule run-as a site-scoped member → scope reaches the runner                                                          |
| T-S1-8  | F5  | `loadDefinitionById` on an archived id → `null`                                                                          |
| T-S2-1  | F6  | `worker` (0 equipment perms) opens `[id]` → redirect/404                                                                 |
| T-S2-2  | F6  | site-A foreman opens a site-B entry → not visible                                                                        |
| T-S2-3  | F6  | detail visibility **equals** list visibility for the same entry                                                          |
| T-S3-1  | F7  | role without `ppe.read.*` → nav entry absent                                                                             |
| T-S3-2  | F7  | role without `ppe.read.*` → page redirects                                                                               |
| T-S3-3  | F7  | `worker` sees only own `current_holder_person_id`                                                                        |
| T-S3-4  | F7  | `ppe.read.all` holder sees everything (unchanged)                                                                        |
| T-PRE-1 | —   | `org_unit` compliance audience with no assignments → `[]` (**pins today's behaviour**)                                   |

**T-S1-5 is the highest-risk omission.** `runCardCached`
(`insights/_data.ts:32-58`) is an independent copy; fixing only
`runAuthorizedBhql` leaves `/dashboard` unscoped, and the cache key at `:41` is
currently tenant-scoped but **not user-scoped**.

### 5.2 Existing contract tests that will break

Verified present; each needs a deliberate update, not a bypass.

| Test                                                                   | Constraint                                                                                                                                                           | Action                                                                                                                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker/src/lib/report-source-access-contract.test.ts` (19 lines) | **string-matches `workers/reports.ts` source**; asserts the literal `'loadBeaconReportCatalog(tx, sources)'` and `not.toMatch(/loadBeaconReportCatalog\(tx\)(?!,)/)` | Update the assertion to match the new call. It breaks on a **behaviour-preserving** refactor — document why in a comment.                                 |
| `packages/reports/src/seed-parity.test.ts` (113 lines)                 | compiles all **32** seeds; `expect(BEACON_REPORT_SEEDS).toHaveLength(32)` (:45)                                                                                      | Keep `scope` **optional** so the 4-arg call compiles. A seed whose entity lacks the scope column will throw — add the column to that entity or exempt it. |
| `apps/web/src/lib/analytics-access-policy.test.ts` (258 lines)         | `runBeaconReport(tx, 'tenant-1', {...}, { entities: [INCIDENTS] })` — 4 args (:221-237)                                                                              | Optional `scope` keeps this compiling unchanged.                                                                                                          |
| `packages/reports/src/source-catalog.test.ts` (133 lines)              | asserts app scope compiles to `"template_id"` in SQL (:43-61)                                                                                                        | Scope injection must not remove that predicate.                                                                                                           |
| `apps/web/src/app/(app)/insights/_widgets.test.ts` (31 lines)          | builds `addTrustedSystemAppResponsesEntity(...)` at module scope (:11)                                                                                               | **Gate the entity at consumption; do not remove it.**                                                                                                     |

**Rule:** updating these assertions is allowed **only** with a comment stating
what changed and why. Silently editing an assertion to pass is a gate bypass
(`AGENTS.md` rule 8).

### 5.3 Gates

All six, each with its own captured exit code:
`format:check`, `typecheck`, `lint`, `test`, `deadcode:check`, `build`.

Baseline to preserve: 24/24 turbo · web 189 files/1141 · db 49 files/232 ·
auth 16/16 · email-render 49/49.

Additional per-phase gates:

- F2/F3 → `seed-parity.test.ts` + `source-catalog.test.ts` green.
- F7 → `rls.test.ts` unchanged and green (**no table was added**, so it must be
  byte-identical in behaviour).
- All → `pnpm deadcode:check` catches any export left dangling.

---

## 6. Migration requirement

**None. Zero migrations.**

| Concern                  | Migrations? | Why                                                               |
| ------------------------ | ----------- | ----------------------------------------------------------------- |
| RLS policy               | **No**      | 190 policies correct; findings are within-tenant                  |
| `TENANT_SCOPED_TABLES`   | **No**      | No table added                                                    |
| `role_assignments.scope` | **No**      | No new scope type; site scope reused                              |
| `ppe_items`              | **No**      | No location column added (deferred)                               |
| Permission catalogue     | **No**      | Adding keys to a TypeScript array is not a schema change; 91 → 93 |
| `people_assignments`     | **No**      | Untouched                                                         |

**Deferred, each requiring its own approval:**

| Deferred item                        | Migration?                                                      |
| ------------------------------------ | --------------------------------------------------------------- |
| `ppe_items.current_site_org_unit_id` | **Yes** — plus write-path changes across issue/return/check-out |
| `api_keys.scope`                     | **Yes**                                                         |
| Any RLS second dimension             | **Yes**                                                         |
| Contractor organisation entity       | **Yes** — separate design decision                              |

---

## 7. Compatibility risk

### 7.1 Behaviour that becomes more restrictive (intended)

| Surface                                     | Before → After                                                       | Risk                                                    |
| ------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| Reports — foreman                           | all 32 seeds tenant-wide → scoped entities + scoped rows             | **High visibility.** Users will notice smaller numbers. |
| Reports — `safety_manager` / `tenant_admin` | unchanged (`read.all` → `undefined`)                                 | None                                                    |
| Insights — foreman                          | tenant-wide `app_responses` → hidden without `forms.response.read.*` | Medium — dashboard cards disappear                      |
| PPE — `worker`                              | whole register → own issued gear                                     | **Medium.** Crews lose sight of unissued stock.         |
| PPE — `foreman`                             | whole register → whole register (granted `read.all`)                 | None                                                    |
| PPE — `safety_manager`                      | unchanged                                                            | None                                                    |
| Vehicle-log detail                          | anyone → read tier + scope                                           | Medium                                                  |
| `/insights` nav                             | `reports.read` → `insights.read`                                     | Low — a foreman holds both                              |
| Archived definition                         | reachable by id → 404                                                | Low                                                     |
| Export by `reports.builder`-only            | allowed → requires `reports.read`                                    | Low                                                     |

### 7.2 Compatibility guarantees

| Guaranteed                                                                     | Evidence                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **Zero changes** to any module list/detail/export `moduleScopeWhere` call site | F1/F2/F6/F7 touch only analytics, vehicle-log and PPE |
| **Zero change** to RLS                                                         | `rls.test.ts` must be byte-identical in behaviour     |
| **Zero change** to `/api/v1` and API keys                                      | Out of scope                                          |
| Existing 4-argument `runBeaconReport` calls keep compiling                     | `scope` is optional                                   |
| `packages/reports` gains **no** dependency on `@beaconhs/tenant`               | Scope arrives as data                                 |
| All tenant-admin / safety-manager workflows unchanged                          | `read.all` → no filter                                |

### 7.3 Product decisions required before shipping

1. **`osha_300_log`** — a site-scoped foreman would produce a **partial** OSHA
   300 log, which is federally required to be complete. Options: restrict to
   `read.all`, or document as a site extract. **Compliance/legal call — must be
   answered before F2 ships.**
2. **`ppe.read.site` degrades to `self`** — accepted, because `ppe_items` has no
   location column. Must be stated in the manual, or users will expect site-wide
   stock.
3. **Dead-code deletion** (`canSeeSite`, `selfOnlyFilter`) — recommended as a
   separate change to keep this one reviewable.

### 7.4 Documentation required (`AGENTS.md` rule 7)

Three manual articles change: **reports access**, **insights access**, **PPE
visibility**. In all three a user sees fewer rows than before, which is
self-documentation in the worst way — it must be explained.

---

## 8. Rollback strategy

### 8.1 Per-fix reversibility

| Fix                   | Rollback                                                                         | Blast radius if reverted            |
| --------------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
| F5 (nav/layout/state) | Revert 4 files                                                                   | None — pure gates                   |
| F6 (vehicle-log)      | Revert 1 file                                                                    | None — restores the bypass          |
| F7 (PPE)              | Revert 5 files; the 2 permission keys are additive and unused if reverted        | None                                |
| F1 (entity gate)      | Revert 3 files                                                                   | Entities reappear in the catalogue  |
| F2 (row scope)        | Revert 3 files; `scope` is **optional**, so leaving the option in place is inert | Rows become tenant-wide again       |
| F3 (insights)         | Revert 3 files                                                                   | `/dashboard` becomes unscoped again |
| F4 (scheduled)        | Revert 1 file                                                                    | Schedules become tenant-wide again  |

**No destructive step anywhere.** No migration to reverse, no data to restore,
no schema to reconcile. Every fix is a revert.

### 8.2 Recommended sequencing for rollback safety

Land in **three reviewable commits** so a problem can be isolated:

1. **Commit 1 — F5 + F6** (gate-only, zero behaviour risk)
2. **Commit 2 — F1 + F7** (entity gate + PPE tier)
3. **Commit 3 — F2 + F3 + F4** (row scope across reports, insights, schedules)

Commit 3 is the only one with real regression risk, and it is last so it can be
held back independently.

### 8.3 Rollback triggers

Revert the relevant commit if any of these appear:

| Trigger                                                                                | Action                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------- |
| Any of the 5 existing contract tests cannot be updated without weakening its assertion | **Stop.** Re-derive the design.             |
| A tenant-admin or safety-manager workflow loses rows                                   | Revert Commit 3.                            |
| `pnpm deadcode:check` fails on a new export                                            | Revert that fix; remove the export.         |
| A scheduled report stops being delivered                                               | Revert F4 only.                             |
| Report run latency regresses materially                                                | Revert F2 (make `scope` opt-in per entity). |

### 8.4 Monitoring after release

- Count report runs by actor role in the first 48 h.
- Compare `report_runs` row counts before/after for `safety_manager` schedules —
  they must be **identical**; a difference means the `read.all` path regressed.
- Watch `insights/_data.ts` cache-hit rate: a sharp drop suggests the new scope
  fingerprint is fragmenting the cache.

---

## 9. Exit criteria

### 9.1 This phase (analysis + design) — **met**

| #   | Criterion                                                                                                                            | Status                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 1   | S1 verified: reports/insights bypass module read permission and site scope                                                           | ✅ full chain traced; 5 permissions identified; `ctx.scopes` never read |
| 2   | S1 verified against each named surface (`reports.read`, `insights.read`, `*.read.site`, `*.read.all`, query, export, insights query) | ✅ §2                                                                   |
| 3   | Minimal fix designed so a foreman's incidents report is site-scoped                                                                  | ✅ `design` §3.2-3.3, F1+F2                                             |
| 4   | S2 verified: page read, actions, edit vs read permission, tenant isolation, site scope, IDOR                                         | ✅ §3                                                                   |
| 5   | S3 verified: navigation, page loader, server action, API, query, permission, scope, tenant isolation                                 | ✅ §4                                                                   |
| 6   | `people_assignments` assessed — **not** assumed necessary                                                                            | ✅ §5: inert; out of scope; regression test pinned                      |
| 7   | `PERMISSION_CATALOGUE` count confirmed and recorded as **91**                                                                        | ✅ exact line parse                                                     |
| 8   | `canSeeSite` real call status confirmed; **not** described as an effective gate                                                      | ✅ 0 call sites, dead code                                              |
| 9   | Three documents written                                                                                                              | ✅ analysis / design / plan                                             |
| 10  | Minimal change; max reuse; no unnecessary data model; no RLS change                                                                  | ✅ 17 files, 2 keys, 0 migrations, 0 RLS                                |
| 11  | Backward compatibility explicit                                                                                                      | ✅ `design` §7, plan §7                                                 |
| 12  | A regression test named for every fix                                                                                                | ✅ 16 tests                                                             |
| 13  | Report / export / insights cannot bypass module read scope — each with a named choke point                                           | ✅ `design` §3.6                                                        |
| 14  | Read-only: no business code, migration, seed, or database change                                                                     | ✅ `git diff HEAD` empty                                                |
| 15  | No `git reset` / `restore` / `clean` / `rebase` / `merge`                                                                            | ✅ none run                                                             |
| 16  | No Docker / storage / MinIO / SeaweedFS change                                                                                       | ✅ untouched                                                            |
| 17  | No Project Scope implementation started                                                                                              | ✅ scope work stays in `hse-project-scope-*`                            |
| 18  | No commit made                                                                                                                       | ✅ working tree carries the 3 new untracked docs only                   |

### 9.2 Phase 1.5 implementation — for the follow-on phase

| #   | Criterion                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | A foreman running any incidents report receives **only** rows whose `site_org_unit_id` is inside their scope (T-S1-3). |
| 2   | A foreman's analytics catalogue contains **no** entity lacking a matching read permission (T-S1-1).                    |
| 3   | `/dashboard` is scoped, and the insight cache key varies per user (T-S1-5).                                            |
| 4   | A scheduled report created by a site-scoped member emits scoped output (T-S1-7).                                       |
| 5   | `worker` cannot open a vehicle-log entry (T-S2-1), and detail visibility **equals** list visibility (T-S2-3).          |
| 6   | `worker` cannot list PPE outside their own issued items (T-S3-3), and can still list their own (T-S3-3 positive).      |
| 7   | `safety_manager` and `tenant_admin` see **identical** row counts before and after.                                     |
| 8   | All 5 existing contract tests pass, each updated with an explanatory comment.                                          |
| 9   | All six gates pass with captured exit codes.                                                                           |
| 10  | `rls.test.ts` behaviour unchanged.                                                                                     |
| 11  | Three manual articles updated.                                                                                         |
| 12  | `osha_300_log` scope decision recorded.                                                                                |

---

## 10. Next steps

1. **Answer the `osha_300_log` question** — it blocks F2 and is a legal call.
2. **Decide `ppe.read.site`** — accept `self` degradation, or defer the key.
3. **Start with Commit 1** (F5 + F6): gate-only, zero regression risk, and it
   closes a Critical finding immediately.
4. **Commit the five analysis documents**, currently untracked with no Git copy.

**Explicitly not next:** Project Scope implementation. Per
`docs/hse-project-scope-implementation-plan.md`, Step B (reports/insights scope)
is the same work as F1–F4 here — this phase should be completed first, and that
plan's Step B updated to reference it rather than duplicated.

Stopping here. No implementation started. No commit made.
