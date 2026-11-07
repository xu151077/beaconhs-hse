# PPE Picker Authorization — Analysis

> ## 中文摘要
>
> **结论：G.1 不是一个隐私漏洞，而是一个「失败关闭（fail-closed）」的功能缺陷；但对它的天真修复会制造一个潜在漏洞。**
>
> - picker `ppe-register-filter-holders`（`apps/web/src/app/api/picker-options/route.ts:298-299`）只接受 `ppe.read.all` 加三个**写**权限（`ppe.manage`/`ppe.issue`/`ppe.inspect`），因此 `ppe.read.self` / `ppe.read.site` 持有者拿到 **403**。方向是安全闭合（拒绝），不是泄露。
> - 它返回的数据是**全体租户内曾持有或曾被开过 PPE 工单的 `people`**（`:1625-1644`），字段为姓名、工号（`employee_no`）、主岗位。**完全没有 scope 过滤**——没有 `moduleScopeWhere`、没有 `canSeeRecord`、没有站点或本人谓词。
> - **今天不存在隐私泄露**：`/people` 目录对任何已登录用户完全无门槛（RUNTIME VERIFIED —— `worker` 角色持有者看到全部 10 人含工号与岗位）。这正是已登记缺陷 **D2**。PPE 持有人集合是该目录的**子集**，不构成新的披露面。
> - **风险是潜在的**：如果只把 `ppe.read.self`/`ppe.read.site` 加进 `canAny()`，**数据仍然是租户级的**。今天看似无害仅仅因为 D2 尚未修复；一旦 D2 关闭，这个只读筛选器就会变成绕过它的后门。
> - **因此正确修复必须同时做两件事**：(a) 门槛接受调用方实际持有的 tier；(b) **按调用方 scope 收窄数据**。缺 (b) 就是错的。
> - 正确的 tier 语义：`read.all` → 全量持有人（现状正确）；`read.self` → 仅本人；`read.site` → **等同于 self**（`ppe_items` 无 org 列，不存在可辩护的更宽集合，与 Phase 1.5 已确立的 `moduleScopeWhere` 降级一致）。
> - 写权限之所以合理，是它们服务于**另一个** lookup：`ppe-active-people`（`:1646-1654`），签发 PPE 本就需要指定接收人。把「写」语义套到「读筛选器」上，才是真正的设计错误。
>
> 本文档只做分析，不修改业务代码。

---

## 1. The finding

**RUNTIME VERIFIED** (Phase 1.5 follow-up, demo tenant):

```
[worker-a@beaconhs.local/ppe] console: Failed to load resource: 403 (Forbidden)
[worker-a@beaconhs.local/ppe] console: [picker-options] lookup failed
  {lookup: ppe-register-filter-holders,
   lookupError: Error: Picker lookup failed (403) at RemoteSearchSelec…}
```

`worker` is a **read-only** PPE user: it holds `ppe.read.self` and none of
`ppe.read.all` / `ppe.manage` / `ppe.issue` / `ppe.inspect`. The `/ppe` page
renders for it (the page gate accepts any read tier), and it renders the holder
filter — but the filter's backing lookup refuses.

**RUNTIME VERIFIED** (direct API probe, same session):

| user         | tier              | `/api/picker-options?lookup=ppe-register-filter-holders` |
| ------------ | ----------------- | -------------------------------------------------------- |
| `worker-a@`  | `ppe.read.self`   | **HTTP 403**, 0 options                                  |
| `viewer-a@`  | no PPE permission | **HTTP 403**, 0 options                                  |
| `foreman-a@` | `ppe.read.all`    | HTTP 200, full holder list                               |

## 2. The gate

**STATIC VERIFIED** — `apps/web/src/app/api/picker-options/route.ts:296-299`:

```ts
296:    // Filtering the register is a READ. Gating this on the write
297:    // permissions would deny the filter to read-only PPE users.
298:    case 'ppe-register-filter-holders':
299:      return canAny('ppe.read.all', 'ppe.manage', 'ppe.issue', 'ppe.inspect')
```

`canAny` is tier-aware — `route.ts:198-199`:

```ts
198:  const canAny = (...permissions: string[]) =>
199:    ctx.isSuperAdmin || permissions.some((permission) => can(ctx, permission))
```

Because tier widening runs `all → site → self`
(`readTierCovers`, established in Phase 1.5), `can(ctx, 'ppe.read.all')` is true
only for an all-tier holder. So the effective gate is:

**`ppe.read.all` OR any PPE write capability OR super-admin.**

**The comment states the intent and the code contradicts it.** It says gating on
write permissions "would deny the filter to read-only PPE users" — and then it
does exactly that, because it accepts only `ppe.read.all` among the read keys.

This was **unreachable before Phase 1.5**: `ppe.read.all` was the only PPE read
key, so "PPE reader" and "holder of `ppe.read.all`" were the same set and the
comment's intent held by accident. Phase 1.5 introduced `ppe.read.self` /
`ppe.read.site`, creating the genuine "read-only PPE user" the comment anticipates.

## 3. What data it returns

**STATIC VERIFIED** — `route.ts:1625-1644`:

```ts
1625:    if (lookup === 'ppe-register-filter-holders') {
1626:      // Everyone who holds PPE now OR was ever issued some, so a discarded or
1627:      // returned item stays findable by the person who actually had it.
1628:      const rows = await tx
1629:        .select(PERSON_OPTION_SELECTION)
1630:        .from(people)
1631:        .where(
1632:          and(
1633:            isNull(people.deletedAt),
1634:            personMatch(input),
1635:            or(
1636:              sql`exists (select 1 from ${ppeItems} pi where pi.current_holder_person_id = ${people.id})`,
1637:              sql`exists (select 1 from ${ppeIssues} pl where pl.person_id = ${people.id})`,
1638:            ),
1639:          ),
1640:        )
1641:        .orderBy(...personOrder(input.selected))
1642:        .limit(PICKER_RESULT_LIMIT + 1)
1643:      return boundPickerOptions(personOptions(rows))
1644:    }
```

Fields returned per person — `route.ts:94-100`:

```ts
94: const PERSON_OPTION_SELECTION = {
95:   id: people.id,
96:   firstName: people.firstName,
97:   lastName: people.lastName,
98:   employeeNo: people.employeeNo,
99:   jobTitle: primaryPersonTitleName(people.id, people.tenantId),
100: }
```

So each option carries **full name, employee number, and job title**.

### Answers to the specific questions

**Does it contain all people?** No — only people who are a current `ppe_items`
holder (`:1636`) **or** are referenced by a `ppe_issues` row, i.e. anyone who has
_ever_ had a PPE issue (`:1637`). The `or` is deliberate so a returned or
discarded item stays findable (`:1626-1627`).

**RUNTIME VERIFIED** (demo tenant): 3 of 10 people qualify.

**Is it already scope-filtered?** **No.** The only predicates are soft-delete
(`:1633`), the search term / selected id (`personMatch`, `:1634`), and the
holder-or-issue `EXISTS` (`:1635-1638`). There is **no** `moduleScopeWhere`, no
`canSeeRecord`, no `site_org_unit_id` predicate, and no
`current_holder_person_id = ctx.personId` predicate. The result is **tenant-wide**
by construction. Tenant RLS supplies tenant isolation and nothing more.

## 4. What each tier should see

The picker's purpose is to filter the `/ppe` register, which is itself scoped.
The filter must never disclose more than the register it filters.

| Tier            | Register shows                                       | Filter **should** return | Filter returns today      |
| --------------- | ---------------------------------------------------- | ------------------------ | ------------------------- |
| `ppe.read.all`  | all PPE                                              | all holders              | all holders — **correct** |
| `ppe.read.site` | degrades to own gear (no site column on `ppe_items`) | own person only          | **403**                   |
| `ppe.read.self` | own gear                                             | own person only          | **403**                   |

`ppe.read.site` collapsing to `self` is not a shortcut — it is the same
degradation Phase 1.5 established and documented for `moduleScopeWhere` on `ppe`:
`ppe_items` has **no** org-unit column, so there is no defensible broader set. A
site-tier holder has not earned the right to enumerate colleagues.

Returning the caller's own row is the right behaviour even for `self`: it keeps
the filter usable (they can filter to "me") while disclosing nothing new, and it
does not produce a 403.

## 5. Why `manage` / `issue` / `inspect` are legitimately involved — elsewhere

The write permissions are not wrong to name people; they are wrong to be the
_authorisation_ for a **read** filter. The legitimate write lookup is a different
one — `route.ts:1646-1654`:

```ts
1646:    if (lookup === 'ppe-active-people') {
1647:      const rows = await tx
1648:        .select(PERSON_OPTION_SELECTION)
1649:        .from(people)
1650:        .where(and(eq(people.status, 'active'), isNull(people.deletedAt), personMatch(input)))
...
```

gated at `route.ts:294-295`:

```ts
294:    case 'ppe-active-people':
295:      return can(ctx, 'ppe.issue') || can(ctx, 'ppe.manage')
```

Issuing a harness _to_ a named person is a write act that inherently requires
naming the recipient, and returning all active people is proportionate to it.
That is coherent.

**The design error is the conflation:** one switch statement
(`pickerAuthorized`, `route.ts:197-…`) answers "may this caller invoke this
lookup?" while each lookup's own query answers "what does it return?" — and for
this one lookup the two were never reconciled. The write keys were added to
`ppe-register-filter-holders` as a way to let issue/inspect users filter the
register, which mixed the two semantics.

## 6. Privacy and over-reach risk

### 6.1 Today: no leak

**RUNTIME VERIFIED.** The `people` directory is fully ungated. For
`worker-a@beaconhs.local` — which holds no admin permission at all — `/people`
returns HTTP 200 and renders the entire workforce:

```
| Anderson, John   E001  Foreman        Field Operations  Supervisor  2023-01-15  active
| Bell, Sarah       E002  Carpenter     Field Operations  Carpenter  2023-01-15  active
| Chen, Marcus      E003  Carpenter     Field Operations  Electrician 2023-01-15  active
| Desai, Priya      E004  Welder        Field Operations  Welder     2023-01-15  active
| Eaton, Tom        E005  Foreman        Field Operations  Supervisor  2023-01-15  active
| Foster, Maya      E006  Apprentice    Field Operations  Carpenter  2023-01-15  active
| Gonzales, Daniel  E007  Apprentice    Field Operations  Electrician 2023-01-15  active
| Hamid, Aisha      E008  Welder        Field Operations  Welder     2023-01-15  active
| Iverson, Linda    E009  Safety Officer Office             —          2023-01-15  active
| Jensen, Robert    E010  Project Mgr   Office             —          2023-01-15  active
```

`apps/web/src/app/(app)/people/page.tsx` has no `assertCan` and no `redirect`; the
only permission check is `canExport` at `:58`. This is recorded defect **D2**
(`AGENTS.md:434`, `docs/project-development-state.md:119`), which describes an
even wider exposure ("emergency contacts, DOB, termination dates").

The PPE holder set (3 people) is a **strict subset** of what `/people` already
returns (10 people, with employee numbers and job titles). So the 403 on the
picker removes nothing that is not available one click away.

**Verdict: G.1 is a usability defect, not a live vulnerability.** The 403 is the
safe direction.

### 6.2 The latent risk — why the naive fix is wrong

The tempting one-line fix is to append the new tiers to `canAny()` at
`route.ts:299`. That would:

- make the filter work for read-only PPE users, **and**
- return the **unchanged, tenant-wide** holder list from `:1625-1644`.

That is harmless **only while D2 is open**. It is self-justifying today — "the
same data is already public at `/people`" — and therefore the kind of change that
gets merged and forgotten.

The moment D2 is fixed and `/people` is gated, this picker becomes an
**ungated read path to a subset of the workforce directory**, reachable by the
lowest-privilege role in the product, through a UI control that looks
innocuous. It would then be a real IDOR-class disclosure, and it would be
attributed to the PPE module rather than to the people module.

**Therefore the fix must be two-part, and part (b) is not optional:**

| Part | Change                                                                                                              | Without it                              |
| ---- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| (a)  | `pickerAuthorized` accepts the tier the caller actually holds, so the filter renders                                | 403 persists                            |
| (b)  | The query at `:1625-1644` applies the caller's PPE read tier, returning only their own person row for `self`/`site` | tenant-wide disclosure once D2 is fixed |

Part (b) is also what makes part (a) safe to ship at all.

### 6.3 Residual: the write keys still over-reach

Even with (a) and (b), leaving `ppe.manage` / `ppe.issue` / `ppe.inspect` in this
read filter's gate is semantically wrong: a user with `ppe.issue` but only
`ppe.read.self` would gain a read-filter list they should not have. Under (b)
that is harmless (the data is scope-matched), but the clean end-state is for
this lookup to depend on the **read tier alone**; write-scoped lookups are
`ppe-active-people`'s job.

## 7. Classification

| Item                                            | Class              | Rationale                                                      |
| ----------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `ppe-active-people` returning all active people | **PRESERVE**       | Proportionate to a write act that must name a recipient        |
| `ppe.read.all` → full holder list               | **PRESERVE**       | Correct and unchanged                                          |
| The `or(exists holder, exists issue)` intent    | **PRESERVE**       | Returning items must stay findable                             |
| `pickerAuthorized` switch structure             | **ADAPT**          | Must key on read tier for this lookup, not write capability    |
| The `:1625-1644` query                          | **ADAPT**          | Must apply the caller's PPE read tier; today it is tenant-wide |
| `ppe.read.site` → own row                       | **ADAPT**          | Consistent with the no-site-column degradation                 |
| A privacy claim on this picker today            | **NEW — rejected** | Superseded by D2; `/people` already exposes more               |
| New PPE permission keys                         | **PRESERVE**       | Already added in Phase 1.5; correct                            |

## 8. Evidence ledger

| Claim                                                        | Label            | Source                                                      |
| ------------------------------------------------------------ | ---------------- | ----------------------------------------------------------- |
| Gate accepts `ppe.read.all` + 3 write keys                   | STATIC VERIFIED  | `route.ts:296-299`                                          |
| Gate's own comment states the opposite intent                | STATIC VERIFIED  | `route.ts:296-297`                                          |
| `canAny` is tier-aware via `can()`                           | STATIC VERIFIED  | `route.ts:198-199`                                          |
| Query has no scope predicate                                 | STATIC VERIFIED  | `route.ts:1625-1644`                                        |
| Returns name + employeeNo + jobTitle                         | STATIC VERIFIED  | `route.ts:94-100`                                           |
| 3 of 10 demo people qualify as holders                       | RUNTIME VERIFIED | `select count(*) … exists(ppe_items) or exists(ppe_issues)` |
| `read.self` / `read.site` holder receives 403                | RUNTIME VERIFIED | Phase 1.5 console capture + direct API probe                |
| `read.all` holder receives 200                               | RUNTIME VERIFIED | direct API probe                                            |
| `/people` renders the full directory to a no-permission user | RUNTIME VERIFIED | `worker-a@` `/people` innerText                             |
| `/people` has no `assertCan` / `redirect`                    | STATIC VERIFIED  | `people/page.tsx` — only `canExport` at `:58`               |
| D2 is the recorded defect                                    | STATIC VERIFIED  | `AGENTS.md:434`; `docs/project-development-state.md:119`    |
| `ppe_items` has no org-unit column                           | STATIC VERIFIED  | Phase 1.5, `ppe-read-tier-contract.test.ts:120`             |
| Would the naive fix leak?                                    | **UNVERIFIED**   | Depends on D2 remaining open; reasoned, not executed        |

## 9. Recommendation

Do not patch `route.ts:299` in isolation. The correct change is small and
belongs in its own review:

1. In `pickerAuthorized`, replace the write keys for this case with the read-tier
   test, so any PPE reader may invoke the filter.
2. In the `:1625-1644` branch, apply the caller's resolved PPE read tier before
   selecting: `all` → unchanged; `site`/`self` → restrict to the caller's own
   `people.id`.
3. Reuse the existing tier resolution rather than re-deriving it, so the picker
   and the register cannot drift.
4. Add a regression test per tier asserting the **number and identity** of
   returned options — not merely that the call is permitted.

Sequencing note: this should land **after** or **with** D2, not before. Fixing
D2 first makes the PPE picker's data semantics observable in isolation; fixing
the picker first leaves a window where it is the only ungated people read path.
