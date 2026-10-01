---
name: Permission Review
description: Review Role, Permission, Scope, Tenant, Project and object-level authorization in BeaconHS. Use when adding or changing a permission key, a role, a scope variant, a visibility tier, nav gating, or API-key authorization.
---

# Permission Review

Checks one thing: **can the intended user do this, and can no one else?**

Scope of review is the authorization model itself — roles, keys, scopes,
visibility tiers, and how they compose into an effective per-record decision.

## When to use

- Adding or renaming a `PERMISSION_CATALOGUE` key.
- Adding a role, or changing a built-in role's permission set.
- Changing `RoleScope`, `role_assignments.scope`, or the scope picker.
- Adding or changing a visibility tier or `readTierCovers`.
- Gating a nav entry, a Manage hub, a page, or a server action.
- Changing API-key authorization.
- Any change where "who can see this" is part of the requirement.

## The model as it exists

Read `packages/db/src/schema/iam.ts` and `packages/tenant/src/index.ts` first.
Current shape:

| Element                 | Location                      | Notes                                                 |
| ----------------------- | ----------------------------- | ----------------------------------------------------- |
| `PERMISSION_CATALOGUE`  | `iam.ts:155-296`              | **89** unique keys                                    |
| Built-in roles          | `iam.ts:301-448`              | `worker`, `foreman`, `safety_manager`, `tenant_admin` |
| `RoleScope`             | `iam.ts:49-55`                | **6** variants                                        |
| Scope storage           | `iam.ts:66`                   | per-assignment, not per-role                          |
| `readTierCovers`        | `tenant/src/index.ts:243-253` | `.read.all` covers `.read.site`, etc.                 |
| `resolveVisibilityTier` | `visibility.ts:114-118`       | **3** tiers                                           |
| `canSeeSite`            | `tenant/src/index.ts:290-297` | exact-id membership only                              |
| API keys                | `api-keys.ts:19-45`           | permissions + builder template ids, **no scope**      |

### RoleScope variants

```ts
{ type: 'tenant' }
{ type: 'sites';   siteIds: string[] }
{ type: 'team';    departmentIds: string[]; groupIds: string[] }
{ type: 'people';  personIds: string[] }
{ type: 'crews';   crewIds: string[] }
{ type: 'self' }
```

**There is no project / org-unit variant.** This is the single most important
fact when reviewing anything about scoping.

### Visibility tiers

`resolveVisibilityTier` returns exactly `'all' | 'site' | 'self'`, chosen by
permission strings only — it never inspects `ctx.scopes`. A user holding
`<prefix>.read.all` gets **no record filter at all**.

## The effective-permission question

For any change, answer these in order:

1. **What permission key does this action require?** Name the exact key. If it
   does not exist, that is the finding — do not invent a runtime check as a
   substitute.
2. **Which tier does the read resolve to?** Trace
   `resolveVisibilityTier(ctx, prefix)`.
3. **What record filter results?** `undefined` means tenant-wide. Say so.
4. **Which scopes apply, and do they include this record?** For the `sites`
   variant, membership is exact-id — no descendant or subtree expansion.
5. **Can the user reach the object by id even if they cannot list it?** An
   unscoped detail fetch is an IDOR even when the list is filtered.

## Checks to run

```sh
# Does the key exist in the catalogue?
grep -n "'<prefix>\.<action>'" packages/db/src/schema/iam.ts

# Is the nav entry gated at all?
grep -n -A6 "key: '<entry>'" apps/web/src/lib/nav/registry.ts | grep -E "requiredPermission|requiredAnyPermission"

# Is the action guard present (not just the page guard)?
grep -rn "assertCan\|assertCanManageModule" "<module>/_actions.ts"

# Is the module-admin permission coherent?
grep -n -A8 "moduleKey: '<module>'" apps/web/src/lib/module-admin/registry.ts
```

## Rules for adding a key

- Add it to `PERMISSION_CATALOGUE` in the module's block, grouped with its
  siblings.
- Decide its `.read.<tier>` family deliberately; `readTierCovers` makes
  `read.all` subsume the others.
- Grant it to the correct built-in roles. `tenant_admin` takes the whole
  catalogue automatically.
- Gate the nav entry with `requiredPermission` (or `requiredAnyPermission`).
- Add the manual article so the permission is explainable to a non-technical
  user (`AGENTS.md` rule 7).

## Rules for adding a scope variant

Do not add one ad hoc. Project scoping needs all of:

1. A `RoleScope` variant.
2. A visibility tier that consults it (the current tier function is
   permission-driven only).
3. Scope-picker support — `parseRoleScope`, `describeScope`, `TYPE_OPTIONS`,
   and the org-unit level filter in
   `apps/web/src/app/(app)/admin/users/_scope-data.ts`, which today hard-filters
   `level = 'site'`.
4. A rank in the `selfOnlyFilter` order map (`tenant/src/index.ts:305`), which
   collapses multi-scope unions to the single widest scope.

A variant that is only half-wired produces a scope that silently widens.

## Known limitations to report, not fix locally

- No project/org-unit scope; project isolation is not expressible.
- `api_keys` has no scope column, so API-key project scoping is impossible at
  the storage layer.
- `selfOnlyFilter` collapses a scope union to one scope, so "self plus project
  X" cannot be expressed.
- `nav/registry.ts:185` uses `equipment.read.self`, absent from the catalogue;
  it passes only through tier mapping.
- The `people` nav entry (`nav/registry.ts:172`) has **no** permission gate,
  while its mutations require `admin.org.manage`.

## Forbidden

- Never gate a page but leave its server action unguarded.
- Never widen a scope to make a test pass.
- Never rely on hiding a nav entry as authorization. Nav is UX, not security.
- Never add a permission key that duplicates an existing one under a new name.
- Never default a new scope to `{ type: 'self' }` without noticing what that
  hides.

## Completion criteria

For the change under review you can state, in writing:

- the exact permission key required,
- the resolved visibility tier,
- the resulting record filter,
- the scopes that grant access,
- the object-level check, and
- the nav/Manage/manual surfaces updated to match.
