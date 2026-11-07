# BeaconHS HSE — Project / Organization Scope Implementation Plan

> **Plan only. No implementation has been performed.**
> Evidence: `docs/hse-project-scope-analysis.md` · Design: `docs/hse-project-scope-design.md`
> Baseline: HEAD `454658c4`, read-only phase complete.

---

## 中文摘要

**当前阶段（Phase 1：分析与设计）已完成，未做任何实现。**

**推荐实施顺序（与「先加 project scope」相反）：**

```
Step A  修复 5 个无 scope 的暴露面        ← 前置条件
Step B  报表/洞察注入 scope              ← 最严重缺陷 S1
Step C  填充 people_assignments          ← people-based scope 的前提
Step D  新增 orgUnit scope 类型 + 解析器  ← 真正的 project scope
Step E  UI / 权限键 / 收尾
```

**为什么不是直接做 D：** 报表、洞察、PPE、People、Vehicle-log 这 5 个界面
**完全没有行级 scope**。在它们连基础 tier 都没有的情况下加 project scope，
等于把一层 scope 建在空洞之上。所以 A/B 必须先行。

**关键约束（必须写入每个 Step 的验收）：**

- **全程不修改 RLS**
- **全程不给记录表加 project 列**
- **全程不需要 migration**
- `canSeeSite` 和 `selfOnlyFilter` 是**死代码**，应删除而非扩展

---

## 1. Phase 1 — this phase: read-only analysis and design

### 1.1 Exit criteria (this phase)

| #   | Criterion                                                                              | Status                                                                                                  |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Full read-only audit of `RoleScope`, all 6 variants, and their consumers               | ✅ `analysis` §1.1, §3                                                                                  |
| 2   | Full read-only audit of the `all` / `site` / `self` tier path                          | ✅ `analysis` §1.2                                                                                      |
| 3   | RLS policy audited; every scoping GUC identified                                       | ✅ 190 policies, 0 reference org_unit/site/project, **RUNTIME VERIFIED**                                |
| 4   | All permission keys enumerated and counted                                             | ✅ **91** keys, exact line parse                                                                        |
| 5   | Server-action permission checks audited across HSE modules                             | ✅ incidents, inspections, hazid, CA, documents, journals, PPE, people, equipment, training, compliance |
| 6   | API permission checks audited                                                          | ✅ `/api/v1`, no scope column on `api_keys`                                                             |
| 7   | Builder / custom-entity scope audited                                                  | ✅ `form_responses.site_org_unit_id` client-set, unenforced                                             |
| 8   | People, equipment, training, compliance, inspection, incident, HazID, CA scope audited | ✅ all 8                                                                                                |
| 9   | Report / analytics scope audited                                                       | ✅ **no scope injected** — most severe finding                                                          |
| 10  | Dashboard scope audited                                                                | ✅ no org dimension; role-only ACL                                                                      |
| 11  | Export scope audited                                                                   | ✅ 15 routes; 13 correct, 2 not                                                                         |
| 12  | Worker / background-job scope audited                                                  | ✅ 1 clear violation (`scheduled.ts:154`)                                                               |
| 13  | Places that already support project scope identified                                   | ✅ **one** — `hazid_assessments.project_org_unit_id`, on an empty table, never a filter                 |
| 14  | Places with site scope only identified                                                 | ✅ 10 surfaces — table in `analysis` §3                                                                 |
| 15  | Places with no scope at all identified                                                 | ✅ 12 surfaces — table in `analysis` §3                                                                 |
| 16  | RLS-bypass locations identified                                                        | ✅ 131 `withSuperAdmin` sites; 1 violates the worker rule                                               |
| 17  | Permission-check gaps identified                                                       | ✅ 17 findings, S1–S17                                                                                  |
| 18  | Minimal-change path for project scope derived                                          | ✅ `design` §3 — one scope type + one resolver, **zero migrations**                                     |
| 19  | Reuse / extend / no-change / compatibility decided                                     | ✅ `design` §2 (A/B/C/D/E)                                                                              |
| 20  | HSE organizational scenario mapped to the real model                                   | ✅ `analysis` §6 — 5 reusable, 1 warning, 1 absent                                                      |
| 21  | Migration risk assessed                                                                | ✅ `design` §9 — none in the recommended path                                                           |
| 22  | Compatibility risk assessed                                                            | ✅ `design` §10                                                                                         |
| 23  | Three deliverables written                                                             | ✅ analysis / design / plan                                                                             |
| 24  | No source, schema, migration, or database change                                       | ✅ verified below                                                                                       |
| 25  | No `git reset` / `restore` / `clean` / destructive command                             | ✅ none run                                                                                             |

### 1.2 Verification of the read-only constraint

```
$ git status --short
?? docker-compose.yml.bak
?? docker-compose.yml.pre-cleanup-backup
```

Tracked-file diff: **none**. The only entries are two pre-existing untracked
backup files that predate this phase. `docker-compose.yml`, `packages/**`,
`apps/**`, `.env`, `package.json` are all byte-identical to HEAD.

Database: read-only `SELECT` and catalog queries only. No `INSERT`/`UPDATE`/
`DELETE`/`DDL`. No migration, no seed.

### 1.3 What Phase 1 deliberately does NOT deliver

- No new module, table, column, index, or permission key.
- No fix for findings S1–S17.
- No `people_assignments` data.
- No contractor model.
- **No implementation of project scope.** That is Step D.

---

## 2. Recommended implementation phases

The order below **deliberately differs** from "add project scope first". Rationale
per step is stated.

### Step A — Close the zero-scope surfaces (prerequisite)

**Why first:** project scope is a _second_ dimension. Laying it on surfaces with
no first dimension produces a filter that either does nothing or is
unreachable.

| Task                                                                                              | Files                                                      | Finding   |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------- |
| A1 Gate the vehicle-log detail page with the read tier, then `canSeeRecord` on the parent vehicle | `equipment/vehicle-log/[id]/page.tsx:108-133`              | S2        |
| A2 Add a `ppe.read` tier + nav gate                                                               | `ppe/page.tsx`, `nav/registry.ts:188`                      | S3        |
| A3 Introduce a `people.read.*` family and gate the people list + detail                           | `people/page.tsx:78`, `people/[id]/page.tsx:273`, `iam.ts` | S4        |
| A4 Gate compliance `by-person` against the viewer's people scope                                  | `compliance/by-person/page.tsx:43,57`, `_hub.ts:171-177`   | S5        |
| A5 Gate the global-search `people` group                                                          | `api/search/route.ts:204-243`                              | (from §4) |

**Exit:** every list and detail page in the 12-surface table either has a
permission tier or an explicit "intentionally tenant-wide" comment with an
owner.

### Step B — Inject scope into reports and insights

**Why second:** this is the most severe finding (S1) and a **foreman can
currently export the whole tenant's incidents**. It is also the smallest fix —
one function.

| Task                                                                                 | Files                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| B1 Compute the caller's per-module scope once per request                            | new helper reusing the Step D resolver                                          |
| B2 Intersect the discovered entity map with the caller's module read permissions     | `apps/web/src/lib/analytics-access.ts:27-61`                                    |
| B3 Inject the resolved scope as a mandatory system `AND` on every discovered entity  | `packages/reports/src/run.ts:46-58`, `packages/analytics/src/server/execute.ts` |
| B4 Use the resolved scope in scheduled report runs                                   | `apps/worker/src/workers/reports.ts:137-140, 512-523`                           |
| B5 Require `forms.response.read.*` before granting the `app_responses` system source | `insights/_widgets.ts:667, 733`, `insights/_data.ts:47`                         |
| B6 Reduce insight export `maxRows` from 50 000 to the report path's 10 000           | `insights/cards/[id]/export/route.ts:76-79, 119-122`                            |

**Exit:** a `foreman` running a seeded incident report receives **only**
site-scoped rows; a test asserts this.

### Step C — Populate `people_assignments`

**Why before Step D:** it is the only people→org mechanism, it is proven in
`packages/compliance/src/audience.ts:89-104`, and it is currently empty with no
writer.

| Task                                                                                                  | Files                                                                                |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| C1 Server action to assign/unassign a person to an org unit with a validity window, gated and audited | new `people/_actions/assignments.ts` (follows `assertCanActOnPerson`, `recordAudit`) |
| C2 UI on the person detail page                                                                       | `people/[id]/page.tsx`                                                               |
| C3 Fix the missing subtree walk in the compliance `org_unit` audience                                 | `packages/compliance/src/audience.ts:101`                                            |
| C4 Regression test: an `org_unit` audience resolves to the assigned people                            | `packages/compliance/*.test.ts`                                                      |
| C5 Verify `setObligationEnabled` writes an audit record                                               | `compliance/obligations/_actions.ts:446-489` (S17)                                   |

**Exit:** `people_assignments` has rows; a `kind='org_unit'` compliance audience
resolves to a non-empty, tested set.

### Step D — Project / org-unit scope (the actual feature)

**Why fourth:** Steps A–C make the feature land on real foundations instead of
fixing itself later.

| Task                                                                                  | Files                                            | Migration? |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------- |
| D1 Add `{ type: 'orgUnits'; orgUnitIds: string[] }`                                   | `packages/db/src/schema/iam.ts:49-55`            | **No**     |
| D2 Add the descendant resolver (one recursive CTE, memoised per request)              | new `apps/web/src/lib/org-unit-scope.ts`         | **No**     |
| D3 Add an unrecognised-scope-type guard (log + ignore, never widen)                   | resolver module                                  | **No**     |
| D4 Add `'org_unit'` to `VisibilityTier` and thread it through `resolveVisibilityTier` | `visibility.ts:106, 114-118`                     | **No**     |
| D5 Add the tier branch **before** the self fall-through                               | `visibility.ts:156-177`                          | **No**     |
| D6 Add the same branch to `canSeeRecord`                                              | `visibility.ts:193-208`                          | **No**     |
| D7 Add `<prefix>.read.org_unit` keys                                                  | `iam.ts:155-296`                                 | **No**     |
| D8 Widen the `readTierCovers` regex; keep widening downward                           | `packages/tenant/src/index.ts:244`               | **No**     |
| D9 `parseRoleScope` + `loadScopeOptions` + `describeScope` + `TYPE_OPTIONS`           | `admin/users/_scope-data.ts`, `scope-picker.tsx` | **No**     |
| D10 Add the project option to the HazID project picker's scope filter                 | `hazard-assessments/[id]/page.tsx:359-372` (S6)  | **No**     |
| D11 **Delete** the dead `canSeeSite` and `selfOnlyFilter`                             | `packages/tenant/src/index.ts:290, 302`          | **No**     |
| D12 Add `packages/tenant` unit tests (it has **none** today)                          | new `packages/tenant/src/*.test.ts`              | **No**     |

**D11 note:** both functions have zero consumers. `selfOnlyFilter`'s `order` map
would be a compile error on adding a variant — which is exactly why deleting it
is safer than extending it.

**Exit:** a user assigned `{type:'orgUnits', orgUnitIds:[projectX]}` sees
exactly the records whose `site_org_unit_id` is project X **or any descendant**,
on every surface in the `analysis` §3 table, and no others.

### Step E — Close the remaining gaps

| Task                                                                        | Finding                            |
| --------------------------------------------------------------------------- | ---------------------------------- |
| E1 Notification audience filtered through `canSeeRecord` at enqueue         | S7                                 |
| E2 Worker `scheduled.ts` split into a bypass scan + a `withTenant` mutation | S8                                 |
| E3 Bind the 11 incident sub-record mutations to their parent incident       | S9                                 |
| E4 Inspection email path `canSeeRecord`                                     | S10                                |
| E5 Documents facet counts respect the `published` filter                    | S11                                |
| E6 Document version download checks parent `deletedAt`/`status`             | S12                                |
| E7 Kiosk: device/site binding + minimum query length                        | S13 — **needs a product decision** |
| E8 Training `classes` scoped; `record.create` bypass reviewed               | S14, S15                           |
| E9 Builder `siteOrgUnitId` validated against caller scope                   | S16                                |

### Explicit sequencing constraints

- **B before D.** Reports must consume the resolver; D introduces it.
- **C before D's people-based path.** People scope depends on populated assignments.
- **A before D.** The new tier must not be the first filter on a surface.
- **E1 before the notification-heavy HSE work.** Findings/Risk/Action all emit notifications.
- **D12 (tenant tests) must land with D1.** `packages/tenant` currently has no
  test file and no `test` script, so a scope regression would be invisible.

---

## 3. Test strategy

### 3.1 Current baseline to preserve

| Suite                   | Result at HEAD              |
| ----------------------- | --------------------------- |
| Turbo tasks             | 24/24 successful            |
| `apps/web`              | 189 test files / 1141 tests |
| `packages/db`           | 49 test files / 232 tests   |
| `packages/auth`         | 16/16                       |
| `packages/email-render` | 49/49                       |

Every step must leave these green. A failing gate blocks the step.

### 3.2 Test levels for this work

| Level                     | Required for                                                                                            | Runner                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Unit**                  | scope resolver (descendant walk, cycle safety, empty set, unrecognised type); `readTierCovers` widening | `vitest` — **new** `packages/tenant` suite   |
| **Database**              | `TENANT_SCOPED_TABLES` coverage; hierarchy integrity                                                    | `packages/db` (`vitest`)                     |
| **Permission**            | tier resolution per role; scope → visible row set                                                       | `vitest` in `apps/web`                       |
| **Integration**           | each module's list + detail + export returns the scoped set                                             | `apps/web` (`vitest`)                        |
| **Regression (security)** | the 17 findings, each with a test that fails before the fix                                             | `apps/web`, `packages/events`, `apps/worker` |
| **E2E**                   | foreman cannot export another site's incidents                                                          | Playwright MCP via the `ui-e2e` skill        |

**There is no checked-in Playwright suite** — browser verification is done with
the Playwright MCP. Do not add an E2E runner as part of this work.

### 3.3 The specific tests that matter

**Descendant resolver (unit):**

- resolves a project → its sites and areas at every depth
- returns the requested ids themselves, not only descendants
- **returns an empty set, not everything, when the id list is empty**
- terminates on a cycle (the schema has **no** cycle protection — verified)
- ignores an unrecognised scope type instead of widening

**Tier resolution (permission):**

- `read.all` → no filter (unchanged)
- `read.site` → exactly the assigned site ids (unchanged)
- `read.org_unit` → project + all descendants
- no recognised scope → `sql\`false\`` (fail-closed preserved)
- an org-unit scope that resolves to nothing → **no rows**, not all rows

**Per-surface matrix (integration):** one test per row of the `analysis` §3
table asserting the visible row set for: a `tenant` scope, a `sites` scope, an
`orgUnits` scope, and no scope.

**The S1 regression test (the most important single test):**

> A `foreman` — who holds `reports.read` and `*.read.site` but **no** `*.read.all`
> — runs a seeded incidents report and receives only rows whose
> `site_org_unit_id` is inside their scope.

**Hierarchy integrity (database):** a site may not be its own ancestor; the
schema does **not** enforce this today, so either add an application-level
check or accept and test that the resolver is cycle-safe.

### 3.4 Gates

Run all six per `AGENTS.md`, each with its own captured exit code:
`format:check`, `typecheck`, `lint`, `test`, `deadcode:check`, `build`.

Additional per-step gates:

| Step | Gate                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------- |
| B    | The S1 regression test fails on the pre-fix code                                                |
| D    | `rls.test.ts` still passes unchanged — RLS was not touched                                      |
| D    | `pnpm deadcode:check` passes — `canSeeSite`/`selfOnlyFilter` deletion leaves no dangling export |
| D    | `packages/tenant` now has a `test` script and a suite that runs                                 |

---

## 4. Risks

### Implementation risks

| #   | Risk                                                                                                                       | Severity | Mitigation                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **B is a behaviour regression users notice.** Reports/insights/PPE/people suddenly return fewer rows.                      | High     | Deliberate and correct. Land B with release notes, a manual update, and a tenant-scoped smoke test. Do not ship it silently.                   |
| R2  | Descendant resolution is called per query and degrades large lists.                                                        | Medium   | Memoise per request context; `org_units` is small per tenant; assert the CTE runs once.                                                        |
| R3  | **No cycle protection in `org_units`.** A corrupt cycle could hang the recursive CTE.                                      | Medium   | The resolver must bound depth. Test it. Consider a depth guard rather than an unbounded `UNION ALL`.                                           |
| R4  | `readTierCovers` widening direction is wrong, accidentally granting or revoking access.                                    | Medium   | Decide and document `all ⊃ site ⊃ org_unit ⊃ self` before writing the regex. Test all four directions.                                         |
| R5  | An unrecognised `scope` row in a real tenant DB behaves unpredictably.                                                     | Medium   | The D3 guard: ignore + log, never widen. Add a startup diagnostic that reports unrecognised scope types.                                       |
| R6  | **Scoping reports/insights breaks existing saved reports** whose definitions assume tenant-wide rows.                      | Medium   | Inventory saved reports before B. A report authored for tenant-wide use will now return a subset — which is the point, but users must be told. |
| R7  | `people_assignments` gains a writer, so the compliance audience changes behaviour.                                         | Medium   | C4 regression test **before** C1 ships.                                                                                                        |
| R8  | Phase D touches `visibility.ts`, which ~40 list pages and ~45 detail pages depend on.                                      | Medium   | `all` and `self` branches must be byte-identical. Full `apps/web` suite (1141 tests) is the gate.                                              |
| R9  | The 5 no-scope surfaces (Step A) are gated by **permission**, which may need new keys — and new keys need manual articles. | Low      | `AGENTS.md` rule 7: update `apps/web/src/lib/manual/content/*` in the same commit.                                                             |
| R10 | Scope assignments cannot express "project X **except** site Y".                                                            | Low      | Accepted limitation. Deny-rules (`applyPermissionDenies`) operate on permissions, not scopes. Document it.                                     |

### Security risks still open until Step E

Findings **S1–S17 remain live** after this phase. S1 (reports), S2 (vehicle-log
detail) and S3 (PPE list) are reachable by any authenticated tenant member.
They are recorded here and in `docs/project-development-state.md`; per
`AGENTS.md` they must be fixed deliberately and separately, not as a side
effect of scope work.

### Operational risks

| #   | Risk                                                                                      | Mitigation                                                                                                              |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| O1  | No staging tenant has more than one project seeded.                                       | Seed a second project + site set in the demo tenant before Step D so the resolver is exercised on real hierarchy depth. |
| O2  | Tenant admins will assign scopes to org units that are later deleted or moved.            | The resolver must return an empty set, not everything. Test this.                                                       |
| O3  | `hazid_assessments.project_org_unit_id` already holds values that look like scope inputs. | Document it as authoring metadata in `design` §3.4 so nobody wires it into a filter later.                              |

---

## 5. Dependencies

| This work depends on                                             | Status                                    |
| ---------------------------------------------------------------- | ----------------------------------------- |
| OpenCode V2 project infrastructure (skills, agents, permissions) | ✅ complete                               |
| `docs/hse-development-baseline.md`                               | ✅ complete                               |
| `docs/hse-project-scope-analysis.md` (this phase)                | ✅ complete                               |
| `docs/hse-project-scope-design.md` (this phase)                  | ✅ complete                               |
| Storage baseline / MinIO                                         | ✅ verified, 25/25                        |
| Database migrated + seeded                                       | ✅ 41 migrations, 202 tables              |
| Second project in the demo tenant                                | 🔴 **not present** — needed before Step D |
| Decision on contractor modelling                                 | 🔴 **not taken** — non-goal of Phase 1    |
| Decision on kiosk hardening (S13)                                | 🔴 **not taken** — product/security call  |

**Nothing in this phase blocked on anything external.** The blockers above are
for the _implementation_ phases.

---

## 6. Recommended immediate next steps

In order, and none of them starts HSE feature development:

1. **Record S1–S17 in `docs/project-development-state.md`** so the register is
   authoritative. (Documentation change only.)
2. **Decide S13 (kiosk)** — it needs a product and security answer, not a code
   change.
3. **Seed a second project** in the demo tenant so project scope has a
   multi-level hierarchy to resolve against.
4. **Start Step B first**, not Step D. It fixes the most severe finding with the
   smallest diff, and it is the prerequisite that makes Step D land correctly.
5. Correct the "89 permission keys" figure to **91** wherever it appears.

**Explicitly not next:** building `findings` or `risks` from
`docs/hse-development-baseline.md` §17. Those phases assume a permission model
that can express "project X" — and it cannot today. Steps A–D come first.
