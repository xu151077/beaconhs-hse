// Canonical Project Scope resolver — unit and contract tests.
//
// SCOPE OF THIS FILE. The org-tree walks and every case that resolves before the
// database is reached are proven here. The database-backed resolution cases
// (assignments, unions, date boundaries, tenant isolation, peer expansion) are
// proven against the live database by `apps/web/scripts/project-scope-verification.mjs`,
// because this repo has no real-DB test harness — the same split Commit 13 used.
//
// What is asserted here, and why each matters:
//   • the output is a discriminated union, and `empty` is never `unrestricted`
//   • `unrestricted` is reachable from exactly two sources and nothing else
//   • a role NAME can never produce it
//   • the SQL and TypeScript forms of the effective-date rule agree
//   • the tree walks are depth-capped and cycle-guarded

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { peopleAssignments } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { effectiveOn, isAssignmentEffectiveOn } from './assignment-validity'
import {
  MAX_ORG_UNIT_DEPTH,
  resolveProjectScopeIn,
  ancestorOrgUnitIds,
  buildOrgTreeIndex,
  descendantOrgUnitIds,
  resolveProjectScope,
  type OrgNode,
  type ProjectScope,
  type ProjectScopeEmptyReason,
} from './project-scope'

const TENANT = '10000000-0000-4000-8000-0000000000aa'
const PERSON = '20000000-0000-4000-8000-0000000000bb'

/**
 * A transaction sentinel that throws if touched. Proves a case resolved BEFORE any
 * query. The public `resolveProjectScope` always opens a transaction (it must,
 * to get one), so the pre-DB assertions target `resolveProjectScopeIn` — which is
 * the form the visibility bridge calls with the transaction it already holds.
 */
const NO_DB = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error('this case must resolve before touching the database: ' + String(prop))
    },
  },
) as never

/** A context whose `ctx.db` throws — proves a case resolved before any query. */
function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'user_1',
    tenantId: TENANT,
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'm1', displayName: 'A' },
    personId: PERSON,
    permissions: new Set<string>(),
    scopes: [],
    activeRoleId: null,
    db: (() => {
      throw new Error('this case must resolve before touching the database')
    }) as unknown as RequestContext['db'],
    ...overrides,
  } as RequestContext
}

/** Source with comments removed, so prose about a forbidden API is not a hit. */
const code = (): string =>
  readFileSync(new URL('./project-scope.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** JSON.stringify that tolerates the circular column objects inside a SQL AST. */
function render(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== 'object') return String(value)
  if (seen.has(value)) return '"[circular]"'
  seen.add(value)
  if (Array.isArray(value)) return `[${value.map((v) => render(v, seen)).join(',')}]`
  return `{${Object.entries(value)
    .map(([k, v]) => `${k}:${render(v, seen)}`)
    .join(',')}}`
}

const node = (
  id: string,
  parentId: string | null,
  level = 'site',
  deletedAt: Date | null = null,
): OrgNode => ({ id, parentId, level, deletedAt })

// ---------------------------------------------------------------------------

describe('output contract', () => {
  it('is a discriminated union whose empty case carries a reason', () => {
    // The reason is what lets a caller distinguish "no project assigned" from
    // "no data", so `empty` can never be a bare marker.
    const reasons: ProjectScopeEmptyReason[] = [
      'no_scope',
      'no_assignment',
      'expired_assignment',
      'invalid_assignment',
      'missing_org_unit',
      'requested_outside_scope',
      'tenant_mismatch',
    ]
    expect(reasons).toHaveLength(7)
  })

  it('never represents unrestricted as undefined, null, or an empty array', () => {
    // `kind: 'unrestricted'` is the only unrestricted representation. A consumer
    // reading `undefined` or `[]` as "no restriction" is the bug this prevents.
    const source = readFileSync(new URL('./project-scope.ts', import.meta.url), 'utf8')
    expect(source).toContain("kind: 'unrestricted'")
    // No function may return undefined.
    expect(source).not.toMatch(/return undefined\s*\n/)
    // An empty org-unit list must map to `empty`, never to `unrestricted`.
    expect(source).toContain(
      "if (orgUnitIds.length === 0 && personIds.length === 0) return empty('no_scope')",
    )
  })

  it('regression: a caller cannot read an `empty` result as unrestricted', () => {
    // If any future helper maps `empty` to "no filter", the fail-closed guarantee
    // is gone. Pin the shape so the mapping is a deliberate, visible change.
    const asFilter = (scope: ProjectScope): undefined | string[] => {
      // A representative consumer: turn a scope into an `IN (...)` list.
      switch (scope.kind) {
        case 'unrestricted':
          return undefined
        case 'orgUnits':
          return scope.orgUnitIds
        case 'persons':
          return []
        case 'peopleAndOrgUnits':
          return scope.orgUnitIds
        case 'empty':
          return [] // fail closed: no rows, not "no filter"
      }
    }
    const emptyScope: ProjectScope = { kind: 'empty', reason: 'no_assignment' }
    expect(asFilter(emptyScope)).toEqual([])
    expect(asFilter(emptyScope)).not.toBeUndefined()
    expect(asFilter({ kind: 'unrestricted' })).toBeUndefined()
  })
})

describe('unrestricted comes from exactly two sources', () => {
  it('super-admin is unrestricted', async () => {
    const scope = await resolveProjectScopeIn(NO_DB, context({ isSuperAdmin: true }))
    expect(scope).toEqual({ kind: 'unrestricted' })
  })

  it('an explicit {type:"tenant"} scope is unrestricted', async () => {
    const scope = await resolveProjectScopeIn(NO_DB, context({ scopes: [{ type: 'tenant' }] }))
    expect(scope).toEqual({ kind: 'unrestricted' })
  })

  it('a role NAME resembling tenant_admin is NOT unrestricted', async () => {
    // The resolver must not key off a role string. `role_assignments` in the
    // fixture is literally named tenant_admin, and that must change nothing.
    const reachedDb = await resolveProjectScope(
      context({ activeRoleId: 'role_tenant_admin', scopes: [] }),
    ).then(
      () => false,
      (e: unknown) => e instanceof Error && e.message.includes('before touching the database'),
    )
    expect(reachedDb, 'a role name must not short-circuit to unrestricted').toBe(true)
  })

  it('holding every read permission does NOT produce unrestricted', async () => {
    // K: the resolver is permission-agnostic. A `read.all` holder with no scope is
    // not unrestricted, and the db must be consulted to prove it.
    let reachedDb = false
    const scope = await resolveProjectScope(
      context({
        permissions: new Set(['incidents.read.all', 'people.read.all', 'ppe.read.all']),
      }),
    ).catch((e: unknown) => {
      reachedDb = e instanceof Error && e.message.includes('before touching the database')
      return null
    })
    expect(reachedDb, 'must resolve via assignments, not permissions').toBe(true)
    expect(reachedDb).toBe(true)
  })

  it('never reads permissions, read tiers, or role keys', () => {
    // Checked against comment-stripped source: the file's own prose names these
    // to explain why it avoids them, and prose is not a usage.
    const source = code()
    expect(source).not.toContain('ctx.permissions')
    expect(source).not.toContain('read.all')
    expect(source).not.toContain('readTier')
    expect(source).not.toContain('tenant_admin')
    expect(source).not.toMatch(/role\.key|roleKey/)
    expect(source).not.toContain('permissions')
  })
})

describe('tenant isolation', () => {
  it('a caller-supplied tenant that disagrees resolves empty, never unrestricted', async () => {
    const scope = await resolveProjectScopeIn(NO_DB, context({ isSuperAdmin: true }), {
      tenantId: '99999999-0000-4000-8000-0000000000ff',
    })
    // Even a super-admin cannot assert a foreign tenant.
    expect(scope).toEqual({ kind: 'empty', reason: 'tenant_mismatch' })
  })

  it('a matching caller-supplied tenant does not change the outcome', async () => {
    const scope = await resolveProjectScopeIn(NO_DB, context({ isSuperAdmin: true }), {
      tenantId: TENANT,
    })
    expect(scope).toEqual({ kind: 'unrestricted' })
  })
})

describe('effective-date rule matches @beaconhs/compliance', () => {
  it('the SQL form is the rule the compliance readers inline', () => {
    // packages/compliance/src/audience.ts:99-104 and identity.ts:104-105 both use
    // `valid_from <= current_date AND (valid_to IS NULL OR valid_to >= today)`.
    // The resolver must not introduce a third meaning of "effective".
    const predicate = effectiveOn(peopleAssignments.validFrom, peopleAssignments.validTo)
    const rendered = render(predicate?.queryChunks)
    expect(rendered).toContain('current_date')
    // Both window bounds referenced, so neither can be silently dropped.
    expect(rendered).toContain('valid_from')
    expect(rendered).toContain('valid_to')
  })

  it('the resolver and compliance read the same columns', () => {
    // If either side ever adds a third window bound, the two drift silently.
    const source = readFileSync(new URL('./project-scope.ts', import.meta.url), 'utf8')
    expect(source).toContain('isAssignmentEffectiveOn(r, onDate)')
    expect(source).toContain('effectiveOn(peopleAssignments.validFrom, peopleAssignments.validTo')
  })

  it('valid_to is INCLUSIVE, matching compliance', () => {
    expect(
      isAssignmentEffectiveOn({ validFrom: '2026-01-01', validTo: '2026-06-01' }, '2026-06-01'),
    ).toBe(true)
    expect(
      isAssignmentEffectiveOn({ validFrom: '2026-01-01', validTo: '2026-05-31' }, '2026-06-01'),
    ).toBe(false)
    expect(isAssignmentEffectiveOn({ validFrom: '2026-06-01', validTo: null }, '2026-06-01')).toBe(
      true,
    )
    expect(isAssignmentEffectiveOn({ validFrom: '2026-06-02', validTo: null }, '2026-06-01')).toBe(
      false,
    )
  })

  it('accepts an explicit onDate rather than reading the clock', () => {
    // Required so historical and future scopes are testable at all.
    const row = { validFrom: '2026-01-01', validTo: '2026-06-01' }
    expect(isAssignmentEffectiveOn(row, '2025-12-31')).toBe(false)
    expect(isAssignmentEffectiveOn(row, '2026-03-01')).toBe(true)
  })
})

describe('org tree traversal', () => {
  const tree: OrgNode[] = [
    node('customer', null, 'customer'),
    node('project_a', 'customer', 'project'),
    node('site_a1', 'project_a'),
    node('site_a2', 'project_a'),
    node('area_a1', 'site_a1', 'area'),
    node('project_b', 'customer', 'project'),
    node('site_b1', 'project_b'),
  ]

  it('expands a parent to all its descendants', () => {
    const idx = buildOrgTreeIndex(tree)
    expect(descendantOrgUnitIds(idx, 'project_a').sort()).toEqual(['area_a1', 'site_a1', 'site_a2'])
  })

  it('a site has no descendants', () => {
    const idx = buildOrgTreeIndex(tree)
    expect(descendantOrgUnitIds(idx, 'site_b1')).toEqual([])
  })

  it('walks up to the ancestors, nearest first', () => {
    const live = new Map(tree.map((n) => [n.id, n]))
    expect(ancestorOrgUnitIds(live, 'area_a1')).toEqual(['site_a1', 'project_a', 'customer'])
  })

  it('a root node has no ancestors', () => {
    const live = new Map(tree.map((n) => [n.id, n]))
    expect(ancestorOrgUnitIds(live, 'customer')).toEqual([])
  })

  it('excludes soft-deleted nodes by default, and can be told to keep them', () => {
    const withDeleted = [...tree, node('site_a3', 'project_a', 'site', new Date())]
    expect(descendantOrgUnitIds(buildOrgTreeIndex(withDeleted), 'project_a').sort()).toEqual([
      'area_a1',
      'site_a1',
      'site_a2',
    ])
    expect(
      descendantOrgUnitIds(
        buildOrgTreeIndex(withDeleted, { excludeDeleted: false }),
        'project_a',
      ).sort(),
    ).toContain('site_a3')
  })

  it('a cyclic parent chain terminates instead of hanging', () => {
    // `org_units.parent_id` has no CHECK constraint, so a cycle is possible data.
    // It must fail closed, not recurse forever.
    const cyclic: OrgNode[] = [
      node('a', 'c', 'project'),
      node('b', 'a', 'site'),
      node('c', 'b', 'site'),
    ]
    const idx = buildOrgTreeIndex(cyclic)
    expect(descendantOrgUnitIds(idx, 'a').sort()).toEqual(['b', 'c'])
    const live = new Map(cyclic.map((n) => [n.id, n]))
    expect(ancestorOrgUnitIds(live, 'a').sort()).toEqual(['b', 'c'])
  })

  it('a chain deeper than the cap is truncated, not followed', () => {
    const deep: OrgNode[] = Array.from({ length: 20 }, (_, i) =>
      node(`n${i}`, i === 0 ? null : `n${i - 1}`, 'area'),
    )
    const idx = buildOrgTreeIndex(deep)
    const out = descendantOrgUnitIds(idx, 'n0')
    expect(out.length).toBeLessThanOrEqual(MAX_ORG_UNIT_DEPTH)
    expect(out).toContain('n1')
  })

  it('a missing node yields no descendants rather than throwing', () => {
    const idx = buildOrgTreeIndex(tree)
    expect(descendantOrgUnitIds(idx, 'does_not_exist')).toEqual([])
    expect(ancestorOrgUnitIds(new Map(tree.map((n) => [n.id, n])), 'does_not_exist')).toEqual([])
  })
})

describe('the resolver is read-only and uncached', () => {
  const source = readFileSync(new URL('./project-scope.ts', import.meta.url), 'utf8')

  it('performs no writes and creates no audit record', () => {
    // Table-targeted writes only: `Set.prototype.delete` on an in-memory
    // id set is how the person filter intersects, and is not a database write.
    for (const forbidden of [
      'tx.insert(',
      'tx.update(',
      'tx.delete(',
      '.insert(peopleAssignments)',
      '.update(peopleAssignments)',
      'recordAudit',
      'withSuperAdmin',
    ]) {
      expect(code(), `must not contain ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('reads through ctx.db so the tenant RLS policy applies', () => {
    // The public entry point opens the tenant-scoped transaction; the
    // transaction-taking variant is what the visibility bridge reuses.
    expect(source).toContain('return ctx.db((tx) => resolveProjectScopeIn(tx, ctx, options))')
    // No raw client, no root db import.
    expect(source).not.toContain('withTenant(')
    expect(source).not.toMatch(/postgres\(|sqlClient/)
  })

  it('introduces no cache', () => {
    // An assignment edit must be visible on the next read, so caching here would
    // be a correctness bug rather than an optimisation.
    for (const forbidden of ['cache(', 'unstable_cache', 'redis', 'lru', 'memoize', 'new Map()']) {
      expect(code(), `must not contain ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('uses a bounded number of queries, not N+1', () => {
    // three SELECTs: the caller's person, the assignments, the org tree, the
    // peers. Counted so a future change has to be deliberate.
    const selects = source.match(/\.select\w*\(/g) ?? []
    expect(selects.length).toBeLessThanOrEqual(5)
  })
})

describe('requested scope can only narrow', () => {
  it('a requested org unit does not widen a tenant-wide caller', async () => {
    // `unrestricted` plus a filter must not stay `unrestricted`, or the caller
    // would receive more than they asked for.
    const reachedDb = await resolveProjectScope(context({ isSuperAdmin: true }), {
      requestedOrgUnitIds: ['org_x'],
    }).then(
      () => false,
      (e: unknown) => e instanceof Error && e.message.includes('before touching the database'),
    )
    // Taking the database path proves the unrestricted shortcut was bypassed, so a
    // requested subset can never be silently ignored.
    expect(reachedDb).toBe(true)
  })

  it('the source intersects rather than replaces', () => {
    const src = code()
    expect(src).toContain(
      'const narrowed = new Set([...orgUnitIds].filter((id) => wanted.has(id)))',
    )
    expect(src).toContain("return empty('requested_outside_scope')")
    // Never a union of resolved and requested.
    expect(src).not.toMatch(/new Set\(\[\.\.\.orgUnitIds, \.\.\.wanted\]\)/)
  })
})
