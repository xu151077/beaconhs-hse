# BeaconHS — Canonical Project Scope Resolver

**Status:** implemented, no consumers. Resolver added in Commit 15A; wiring the
authorization pipeline onto it is a later commit.
**Design basis:** `docs/hse-project-scope-authorization-design.md`.
**Implementation:** `apps/web/src/lib/project-scope.ts`.

> **Nothing consumes this yet.** `read.all` still means tenant-wide everywhere it
> did before. `visibility.ts`, `analytics/src/server/scope.ts`, all 86 authorization
> consumers, the public API and the export routes are untouched by this commit. The
> resolver exists so its semantics can be reviewed and tested on their own, and so the
> later migration has one canonical target to move onto.

---

## 1. Purpose

Answer exactly one question: **which places and which people may this identity see, as of
a given date?**

It is deliberately _not_ an authorization decision maker. It never reads
`ctx.permissions`, never reads a read tier, and never looks at a role name. The bug this
exists to prevent is that a maximal permission currently discards scope entirely:

| site                                         | current behaviour on the maximal tier                      |
| -------------------------------------------- | ---------------------------------------------------------- |
| `apps/web/src/lib/visibility.ts:165`         | `tier === 'all'` → `return undefined` (no filter)          |
| `apps/web/src/lib/visibility.ts:201`         | `tier === 'all'` → `return true`                           |
| `packages/analytics/src/server/scope.ts:374` | `tier === 'all'` → `filter: undefined`                     |
| `apps/web/src/lib/visibility.ts:51,53`       | super-admin / `{type:'tenant'}` scope → `return undefined` |

Keeping permission, visibility and scope as three separate inputs — where scope may only
_narrow_ and is never removed by a permission — is the whole design.

## 2. Placement, and why

`apps/web/src/lib/project-scope.ts`, next to `visibility.ts`.

The alternative was `packages/tenant`, which already depends on `@beaconhs/db` and
`drizzle-orm` and already imports `RoleScope`. It was rejected for one reason: the
effective-date rule must not be duplicated, and it currently lives in
`apps/web/src/lib/assignment-validity.ts`. A package cannot import app code, so hosting the
resolver in `packages/tenant` would have meant either restating the rule (forbidden by the
brief) or relocating a Commit 13 file and its 31 tests. `apps/web` can import the helper
directly, so the rule exists once.

Consequence to record: `@beaconhs/compliance` cannot import this resolver. That package
inlines the same rule at `audience.ts:99-104` and `identity.ts:104-105`. See §14.

## 3. Input

```ts
type ProjectScopeOptions = {
  tenantId?: string // assertion; must equal ctx.tenantId or it is tenant_mismatch
  onDate?: IsoDate // effective date, UTC; defaults to today
  requestedOrgUnitIds?: readonly string[] // narrows; never widens
  personIds?: readonly string[] // narrows; never widens
  excludeDeleted?: boolean // default true
}
```

Identity comes from the `RequestContext`: `ctx.tenantId`, `ctx.userId`, `ctx.personId`,
`ctx.isSuperAdmin`, `ctx.scopes`, and `ctx.db`. **`ctx.personId` is canonical**; when it is
null (an account with no employee record) the resolver re-derives it from
`people.userId = ctx.userId` in one query, so it is correct standalone.

Permission keys, read tiers and role names are **not** inputs and are never read. A
contract test asserts their absence from the implementation.

## 4. Output

```ts
type ProjectScope =
  | { kind: 'unrestricted' }
  | { kind: 'orgUnits'; orgUnitIds: string[]; personIds: string[] }
  | { kind: 'persons'; personIds: string[] }
  | { kind: 'peopleAndOrgUnits'; orgUnitIds: string[]; personIds: string[] }
  | { kind: 'empty'; reason: ProjectScopeEmptyReason }

type ProjectScopeEmptyReason =
  | 'no_scope'
  | 'no_assignment'
  | 'expired_assignment'
  | 'invalid_assignment'
  | 'missing_org_unit'
  | 'requested_outside_scope'
  | 'tenant_mismatch'
```

Five properties the type is chosen to guarantee:

1. **Discriminated union on `kind`.** A consumer must handle every case explicitly.
2. **`empty` and `unrestricted` are different cases.** They cannot be conflated.
3. **`unrestricted` is never `undefined`, `null`, or `[]`.** An empty id list maps to
   `empty`, never to unrestricted.
4. **A requested subset narrows even an unrestricted caller.** Returning `unrestricted`
   while ignoring a filter would hand back more than the caller asked for.
5. **`empty` carries a reason**, so a UI can say "you have no project assigned" rather than
   rendering a list that looks like missing data.

`invalid_assignment` is declared but currently unreachable: the columns are
`date NOT NULL` / `date NULL` and `isAssignmentEffectiveOn` cannot fail on a readable row.
It is kept so a future data-quality problem has a truthful reason rather than being
misreported as `no_assignment`.

## 5. Effective assignment definition

```
valid_from <= onDate  AND  (valid_to IS NULL OR valid_to >= onDate)
```

`valid_to` is **INCLUSIVE**. This is not a new rule — it is the rule in
`apps/web/src/lib/assignment-validity.ts`, which is the rule `@beaconhs/compliance` applies
to this same table. The resolver **calls** `isAssignmentEffectiveOn` for its decision and
`effectiveOn` for the inverse (peer) query, so it restates nothing.

Both directions are verified: the TypeScript form decides the caller's own assignments, the
SQL form filters peers, and a contract test asserts the SQL predicate still references
`current_date` and both `valid_from` and `valid_to`.

## 6. Multi-assignment semantics

Several concurrent assignments produce a **UNION**, via `Set`s, so:

- a person assigned to two projects sees both;
- a person with several assignments to the same org appears **once**;
- duplicates (possible — there is no uniqueness constraint) change nothing.

Never an intersection, never last-write-wins. An intersection would silently empty a
legitimately broad role.

## 7. Historical assignments

An assignment with `valid_to < onDate` contributes **nothing** to current scope. The row is
never deleted or modified — the resolver is strictly read-only, and history is what the
compliance audience readers depend on.

`valid_to == onDate` is still effective, matching compliance. Making it exclusive would put
the resolver and `@beaconhs/compliance` in disagreement on the boundary day, which is the
exact drift the shared helper exists to prevent.

When a person has rows but none are effective, the reason distinguishes _everything has
ended_ (`expired_assignment`) from _everything is still in the future_ (`no_assignment`),
rather than guessing.

## 8. Org tree traversal

`org_units.parent_id` is single-parent. For each effective assignment the resolver:

1. adds the assigned node;
2. adds **all descendants**, so a project assignment reaches its sites;
3. adds the **whole ancestor chain**, so a site assignment also grants the project it sits
   under — otherwise a project-scoped reader could not see the site they are standing on.

The tenant's org units are read **once** and walked in memory, so the traversal costs
O(org units) in memory and 1 query, not N+1.

Two failure guards, both tested:

- **Cycle** — `parent_id` has no CHECK constraint, so a cyclic chain is possible data. A
  `seen` set in each direction makes the walk visit each node once and stop. Verified to
  terminate in ~5 ms against a real cycle.
- **Depth** — `MAX_ORG_UNIT_DEPTH = 8`. A well-formed tree is four deep
  (`customer → project → site → area`); a longer chain is truncated rather than followed.

`excludeDeleted` (default `true`) drops soft-deleted org units from the index entirely, so a
deleted place cannot be reached as a descendant either. An assignment pointing at a
soft-deleted org unit yields `missing_org_unit` — this is the **real** fail-closed case,
because a genuinely _missing_ org unit is impossible (see §9).

The three walk functions are exported pure functions — `buildOrgTreeIndex`,
`descendantOrgUnitIds`, `ancestorOrgUnitIds` — so the tree, deep-tree and cycle cases are
unit-testable without a database.

## 9. Tenant isolation

Three layers, all verified:

1. **Tenant comes from `ctx.tenantId`**, never from caller input. A caller-supplied
   `tenantId` that disagrees returns `empty`/`tenant_mismatch` — **even for a super-admin**,
   who therefore cannot assert a foreign tenant.
2. **All reads run inside `ctx.db`**, so the existing tenant RLS policy applies. The resolver
   imports no root client and uses no raw connection.
3. **The database forbids the shapes a resolver would have to defend against.**
   `people_assignments_tenant_org_fk` and `people_assignments_tenant_person_fk` are
   _composite_ on `(tenant_id, …)`, so an assignment naming a non-existent org unit, or one
   from another tenant, is **rejected outright**. The verification asserts the rejection
   rather than trying to construct the row. That is a stronger guarantee than the
   resolver's own `live.get()` check, which remains as defence in depth.

## 10. Unrestricted semantics

`unrestricted` is reachable from **exactly two** sources:

- `ctx.isSuperAdmin`
- an explicit `{type:'tenant'}` scope held in `role_assignments`

**Not** from a role name. `tenant_admin` is only a role key; keying off the string would
hand an unconditional bypass to any future role that happened to share it. The scope row is
data, so the decision is auditable and revocable per user. Verified: a role whose id is
literally `tenant_admin`, with no tenant scope, does **not** resolve to `unrestricted`.

This matches design §9 Option **T1** (the preferred option there) and also matches
`recordVisibilityWhere`, which already treats `{type:'tenant'}` as unrestricted — so the two
entry points agree rather than a third meaning being introduced.

## 11. Empty semantics

| reason                    | when                                                                             |
| ------------------------- | -------------------------------------------------------------------------------- |
| `tenant_mismatch`         | caller-supplied `tenantId` ≠ `ctx.tenantId`                                      |
| `no_scope`                | the identity has no `people` row, so no assignment can exist                     |
| `no_assignment`           | a `people` row exists but has no assignment rows, or all are still in the future |
| `expired_assignment`      | assignment rows exist but every one has ended before `onDate`                    |
| `missing_org_unit`        | the only effective assignments name a soft-deleted org unit                      |
| `requested_outside_scope` | the requested subset does not intersect the resolved scope                       |

**A user with zero effective assignments gets `empty`, never `unrestricted`, never
tenant-wide.** A contract test pins the representative consumer shape: a scope converted to
an `IN (…)` list returns `[]` for `empty` and `undefined` only for `unrestricted`.

There is deliberately **no self fallback** in the resolver. A `read.self` holder with no
assignment resolves to `empty`; whether such a caller may see their own row is an
authorization-policy question for the consumer layer, and design §6 lists it as open
decision **D3**.

## 12. Requested scope intersection

`requestedOrgUnitIds` and `personIds` **intersect**; they never replace and never union. The
org narrowing happens **before** the person set is derived, so a person assigned only to an
org the caller did not request is not in the answer. Verified: a requested site inside scope
returns exactly that site; a requested site outside scope returns
`empty`/`requested_outside_scope`; a person filter keeps the peer and drops the caller.

## 13. Performance and caching

- **Queries:** at most 4 tenant-scoped SELECTs — the caller's person (only when
  `ctx.personId` is null), their assignments, the tenant's org units, and the peer
  assignments. A contract test caps the `.select(` count so a future change is deliberate.
- **Memory:** O(org units) for the tree, plus O(in-scope people) for the peer set.
- **Scaling note, and a known limitation:** `personIds` is returned as a materialised id
  list. For a project with thousands of people that is a large `IN (…)`. A subquery/closure
  form would be the right answer at that size; it is recorded as a follow-up rather than
  built speculatively, because truncating a peer list would be a security-relevant
  behaviour change and guessing at a cap is worse than a documented limit.
- **No cache.** No Redis, no `unstable_cache`, no request-global memo, no in-process map.
  An assignment edit must be visible on the very next read, so a cache here would be a
  correctness bug rather than an optimisation. A contract test asserts no cache primitive
  appears in the implementation.

## 14. Compliance consistency

Same rule, same columns, same inclusivity, same tenant, same org unit. The resolver calls
the shared helper rather than restating it, and a contract test asserts:

- the SQL form still references `current_date` and both `valid_from` and `valid_to`;
- the implementation contains the shared call, not an inline comparison.

**Known duplication, not addressed here:** `@beaconhs/compliance` inlines the same predicate
in `audience.ts` and `identity.ts`. That is a package-boundary consequence — compliance
cannot import app code — and the brief directs that it be recorded as a consolidation task
rather than refactored now. It is tracked as the follow-up in §17.

## 15. Security invariants

| #   | invariant                                         | enforced at                                  | proven by                     |
| --- | ------------------------------------------------- | -------------------------------------------- | ----------------------------- |
| 1   | `read.all` never widens a project-scoped caller   | permissions are not read at all              | K, L (DB) + source contract   |
| 2   | the tenant boundary is never crossed              | `ctx.tenantId` only; `ctx.db`; composite FKs | A, H, T (DB)                  |
| 3   | a historical assignment creates no current access | `isAssignmentEffectiveOn`                    | E (DB)                        |
| 4   | an expired assignment creates no current access   | same                                         | E (DB)                        |
| 5   | no effective assignment fails closed              | `empty` + reason                             | B, G (DB) + contract          |
| 6   | multiple effective assignments union              | `Set`                                        | D, O (DB)                     |
| 7   | a role name cannot grant `unrestricted`           | only two sources                             | L (DB) + contract             |
| 8   | a requested subset can only narrow                | intersect before deriving persons            | M1, M2, N, N2 (DB)            |
| 9   | a deleted place is not in scope                   | `excludeDeleted` index filter                | S (DB)                        |
| 10  | a malformed org tree cannot hang or loop          | `seen` sets + `MAX_ORG_UNIT_DEPTH`           | cycle + deep-tree (unit + DB) |
| 11  | the resolver cannot write                         | no insert/update/delete/audit in code        | source contract               |
| 12  | the resolver cannot cache a stale scope           | no cache primitive in code                   | source contract               |
| 13  | exactly one resolver exists                       | one file, one exported entry point           | this document                 |

## 16. Known limitations

1. **No consumers.** Every existing authorization path still uses the old short-circuits.
   Invariant 1 is a property _of the resolver_, not yet of the application.
2. **`read.all` semantics are unchanged** (design decision **D1** is still open). Until that
   is decided and wired, the resolver is correct but unused.
3. **`invalid_assignment` is unreachable** today (§4).
4. **`personIds` is a materialised list**, not a subquery — see §13.
5. **Peer expansion is unscoped by project depth.** A caller assigned to the `customer`
   root would resolve to every live org unit in the tenant. That is correct — a customer-root
   assignment genuinely means the whole company — but it is a wide result and is worth
   knowing about before anyone assigns someone to the root.
6. **The org tree is read per resolution.** Fine for a request-scoped call; a future
   batch/worker use would want it hoisted, which is a caching decision deliberately not
   taken here.
7. **A missing org unit cannot be exercised** end-to-end because the FK prevents it (§9);
   the real case is the soft-deleted one.

## 17. Future integration point

The resolver is designed to be consumed by the four existing ladder entry points as an
**additional AND-ed predicate**, never as a replacement for visibility:

1. `recordVisibilityWhere` (`visibility.ts:46`) — union the scope predicate with the
   existing per-scope conditions. Note it currently bypasses permissions entirely
   (lines 51/53), which is the dependency inversion flagged in design §17.
2. `moduleScopeWhere` (`visibility.ts:157`) — AND it in after the tier branch, so `all`
   stops meaning "no filter".
3. `canSeeRecord` (`visibility.ts:194`) — the single-record equivalent.
4. `resolveEntity` (`packages/analytics/src/server/scope.ts:368`) — pass the resolved
   org/person ids as `subject.siteIds`, and extend `siteIdsFromScopes` rather than adding a
   second source.

The order is fixed by design §14 (S0–S8). Two hard dependencies remain: **populate
`people_assignments` first**, and **converge the 10 permission-only export routes before
any module goes live**, or every module needs a temporary exemption.

**Follow-ups recorded, not done here:**

| #   | item                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | consolidate the effective-date rule into one package both `apps/web` and `@beaconhs/compliance` can import, removing the inline copies in `audience.ts` / `identity.ts` |
| F2  | consider moving the resolver to `packages/tenant` once F1 exists, so it is reachable from `apps/worker` and `@beaconhs/compliance`                                      |
| F3  | decide **D1** (`read.all` re-purposed or not) and **D3** (self visibility with no assignment)                                                                           |
| F4  | public API scope: `api_keys` has no scope column, so this needs a migration and is deliberately out of scope                                                            |
| F5  | subquery/closure form for `personIds` if a project scope grows large                                                                                                    |
| F6  | `people_assignments.is_primary` only if the business needs a "home project"                                                                                             |

## 18. Verification

| suite                                                                                                | what it covers                                                                                                                                                                                                                                                                                                                                                                                 | result    |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `apps/web/src/lib/project-scope-contract.test.ts` (28 tests, vitest)                                 | output contract, `empty` ≠ `unrestricted`, the two `unrestricted` sources, role-name spoofing, permission-indifference, tenant mismatch, SQL/TS date-rule agreement, tree expansion, ancestors, soft-delete, cycle, depth cap, read-only, no-cache, bounded queries, intersection                                                                                                              | **28/28** |
| `apps/web/scripts/project-scope-verification.ts` (22 checks, live DB in one rolled-back transaction) | A tenant isolation · B no assignment · C one assignment · D two concurrent · E historical · F inclusive boundary · G future · H FK rejects a missing org unit · I tenant scope · J super-admin · K `read.all` does not widen · L role-name spoofing · M requested inside/outside · N person filter · O duplicates · P descendants · Q deep tree · R cycle · S soft-deleted · T tenant mismatch | **22/22** |

The DB script builds and tears down its own fixtures inside a transaction that is
deliberately rolled back, so it leaves no residue in the product schema. Running it again
afterwards confirms `0` probe org units, `0` probe people, `0` assignments.
