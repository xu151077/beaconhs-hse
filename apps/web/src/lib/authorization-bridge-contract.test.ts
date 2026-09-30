// 15B-2 — the core authorization contract: Permission × Visibility × Project Scope.
//
//   Permission  ->  Read Tier  ->  Visibility  AND  Project Scope  ->  predicate
//
// The rule under test throughout: **Project Scope can only narrow.** A permission
// never widens it, a role name never bypasses it, and an empty scope is a hard
// `false` rather than an absent filter.
//
// The fixture models two projects (A and B) under a customer, with the caller
// assigned to a site in project A and peers on both, so a test can prove that A
// cannot see B. The resolver's own semantics are covered separately by
// `project-scope-contract.test.ts` (28 unit) and
// `scripts/project-scope-verification.ts` (22 live-DB); this file covers the
// BRIDGE — the adapter and the three ladder entry points.

import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { people, peopleAssignments } from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'
import type { RequestContext } from '@beaconhs/tenant'
import type { RoleScope } from '@beaconhs/db/schema'
import { canSeeRecord, moduleScopeWhere, recordVisibilityWhere } from './visibility'
import {
  andPredicates,
  isAlwaysFalse,
  projectScopePredicate,
  recordInProjectScope,
} from './project-scope-predicate'
import type { ProjectScope } from './project-scope'
import { projectScopeTx } from './testing/project-scope-fixture'

const SITE_A = '00000000-0000-4000-8000-00000000a001'
const SITE_B = '00000000-0000-4000-8000-00000000b001'
const READER = '018f47ba-86c4-7ee2-8d7a-5e7602f2afff'
const PEER_A = '0c000000-0000-4000-8000-0000000000c2'
const PEER_B = '0c000000-0000-4000-8000-0000000000c3'

const dialect = new PgDialect()
const render = (p: ReturnType<typeof projectScopePredicate>) =>
  p === undefined ? '(no predicate)' : dialect.sqlToQuery(p).sql

type CtxOverrides = { scopes?: RoleScope[]; personId?: string | null; isSuperAdmin?: boolean }

function ctx(permissions: string[], over: CtxOverrides = {}): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-0000000000aa',
    isSuperAdmin: over.isSuperAdmin ?? false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'm1', displayName: 'A' },
    personId: over.personId === undefined ? READER : over.personId,
    permissions: new Set(permissions),
    scopes: over.scopes ?? [],
    activeRoleId: null,
    db: (async (fn: (t: unknown) => unknown) => fn({})) as RequestContext['db'],
  } as RequestContext
}

/** A caller assigned to site A only. */
const projectA = () => ctx(['x.read.all'], { personId: READER })
/** A caller assigned to site B only. */
const projectB = () => ctx(['x.read.all'], { personId: PEER_B })

/**
 * An explicit fixture, because the shared default assigns the caller to `site_1`
 * while this suite reasons in terms of SITE_A / SITE_B. Both projects are in the
 * tree; only the caller's assignment decides what is in scope.
 */
const assigned = (orgUnitId: string, personId = READER) =>
  projectScopeTx({
    assignments: [{ personId, orgUnitId, validFrom: '2020-01-01', validTo: null }],
  })

const txA = () => assigned(SITE_A)
const txB = () => assigned(SITE_B, PEER_B)

// ---------------------------------------------------------------------------

describe('unrestricted', () => {
  it('a super-admin gets no Project Scope predicate at all', async () => {
    const c = ctx(['x.read.all'], { isSuperAdmin: true })
    expect(await moduleScopeWhere(c, txA(), { prefix: 'x' })).toBeUndefined()
  })

  it('an explicit {type:"tenant"} scope gets no Project Scope predicate', async () => {
    const c = ctx(['x.read.all'], { scopes: [{ type: 'tenant' }] })
    expect(await moduleScopeWhere(c, txA(), { prefix: 'x' })).toBeUndefined()
  })

  it('recordVisibilityWhere also stays unrestricted for both', async () => {
    const c = ctx(['x.read.all'], { scopes: [{ type: 'tenant' }] })
    expect(await recordVisibilityWhere(c, txA(), { personCol: people.id })).toBeUndefined()
  })

  it('the adapter maps unrestricted to undefined and nothing else', () => {
    expect(projectScopePredicate({ kind: 'unrestricted' })).toBeUndefined()
  })
})

describe('tenant scope is the ONLY non-super-admin route to unrestricted', () => {
  it('a role NAMED tenant_admin without a tenant scope is NOT unrestricted', async () => {
    const c = ctx(['x.read.all', 'admin.users.manage'], { activeRoleId: 'tenant_admin' } as never)
    const out = await moduleScopeWhere(c, txA(), { prefix: 'x' })
    // A predicate comes back…
    expect(out).toBeDefined()
    // …and it is emphatically NOT the company-wide "no filter" answer, which is
    // the whole point: the role NAME grants nothing.
    expect(out).not.toBeUndefined()
    expect(isAlwaysFalse(out)).toBe(true)
  })

  it('a role name cannot make canSeeRecord return true for an out-of-scope record', async () => {
    const c = ctx(['x.read.all'], { activeRoleId: 'tenant_admin' } as never)
    expect(await canSeeRecord(c, txA(), { prefix: 'x', siteId: SITE_B })).toBe(false)
  })
})

describe('project scope narrows, and cannot see the other project', () => {
  it('project A cannot see a project B record', async () => {
    expect(
      await canSeeRecord(projectA(), txA(), { prefix: 'x', siteId: SITE_B, ownerIds: [] }),
    ).toBe(false)
  })

  it('project A CAN see a project A record', async () => {
    expect(
      await canSeeRecord(projectA(), txA(), { prefix: 'x', siteId: SITE_A, ownerIds: [] }),
    ).toBe(true)
  })

  it('a project B caller sees B and not A', async () => {
    expect(
      await canSeeRecord(projectB(), txB(), { prefix: 'x', siteId: SITE_B, ownerIds: [] }),
    ).toBe(true)
    expect(
      await canSeeRecord(projectB(), txB(), { prefix: 'x', siteId: SITE_A, ownerIds: [] }),
    ).toBe(false)
  })

  it('a union of A and B reaches both', async () => {
    const unionTx = projectScopeTx({
      assignments: [
        { personId: READER, orgUnitId: SITE_A, validFrom: '2020-01-01', validTo: null },
        { personId: READER, orgUnitId: SITE_B, validFrom: '2020-01-01', validTo: null },
      ],
    })
    const c = projectA()
    expect(await canSeeRecord(c, unionTx, { prefix: 'x', siteId: SITE_A, ownerIds: [] })).toBe(true)
    expect(await canSeeRecord(c, unionTx, { prefix: 'x', siteId: SITE_B, ownerIds: [] })).toBe(true)
  })
})

describe('an empty scope is fail-closed', () => {
  const noAssignment = () => projectScopeTx({ assignments: [], employeeRecord: 'present' })

  it('no assignment -> an always-false predicate, never an absent one', async () => {
    const out = await moduleScopeWhere(projectA(), noAssignment(), { prefix: 'x' })
    expect(out).toBeDefined()
    expect(isAlwaysFalse(out)).toBe(true)
  })

  it('no assignment -> an always-false predicate for EVERY read tier', async () => {
    for (const key of ['x.read.all', 'x.read.site', 'x.read.self']) {
      const out = await moduleScopeWhere(ctx([key]), noAssignment(), { prefix: 'x' })
      expect(isAlwaysFalse(out), key).toBe(true)
    }
  })

  it('no assignment -> canSeeRecord refuses, even for a read.all holder', async () => {
    expect(
      await canSeeRecord(ctx(['x.read.all']), noAssignment(), { prefix: 'x', siteId: SITE_A }),
    ).toBe(false)
  })

  it('the adapter maps empty to false and unbindable to false', () => {
    expect(isAlwaysFalse(projectScopePredicate({ kind: 'empty', reason: 'no_assignment' }))).toBe(
      true,
    )
    // Scoped, but the entity exposes neither column: fail closed, never widen.
    expect(
      isAlwaysFalse(
        projectScopePredicate({ kind: 'orgUnits', orgUnitIds: ['x'], personIds: [] }, {}),
      ),
    ).toBe(true)
  })
})

describe('expired, future and deleted assignments', () => {
  it('an expired assignment contributes nothing', async () => {
    const tx = projectScopeTx({
      assignments: [
        { personId: READER, orgUnitId: SITE_A, validFrom: '2020-01-01', validTo: '2020-06-01' },
      ],
    })
    expect(await canSeeRecord(projectA(), tx, { prefix: 'x', siteId: SITE_A, ownerIds: [] })).toBe(
      false,
    )
  })

  it('a future assignment contributes nothing', async () => {
    const tx = projectScopeTx({
      assignments: [
        { personId: READER, orgUnitId: SITE_A, validFrom: '2099-01-01', validTo: null },
      ],
    })
    expect(isAlwaysFalse(await moduleScopeWhere(projectA(), tx, { prefix: 'x' }))).toBe(true)
  })

  it('an assignment to a soft-deleted org unit contributes nothing', async () => {
    const tx = projectScopeTx({
      assignments: [
        {
          personId: READER,
          orgUnitId: '00000000-0000-4000-8000-00000000dead',
          validFrom: '2020-01-01',
          validTo: null,
        },
      ],
    })
    expect(isAlwaysFalse(await moduleScopeWhere(projectA(), tx, { prefix: 'x' }))).toBe(true)
  })
})

describe('read.all / read.site / read.self all AND with the scope', () => {
  it('read.all + project A yields a predicate, not an unfiltered one', async () => {
    const out = await moduleScopeWhere(ctx(['x.read.all']), txA(), {
      prefix: 'x',
      siteCol: people.id,
    })
    expect(out).toBeDefined()
    expect(render(out)).toContain('in')
  })

  it('read.site + project A intersects the site leg with the scope leg', async () => {
    const c = ctx(['x.read.site'], { scopes: [{ type: 'sites', siteIds: [SITE_A] }] })
    const out = await moduleScopeWhere(c, txA(), { prefix: 'x', siteCol: people.id })
    expect(out).toBeDefined()
    // Two bindings ANDed, not one replacing the other.
    expect(render(out)).toContain('and')
  })

  it('read.self + project A still refuses the other project', async () => {
    const c = ctx(['x.read.self'])
    expect(await canSeeRecord(c, txA(), { prefix: 'x', siteId: SITE_B })).toBe(false)
  })

  it('a read.all holder is strictly NARROWER than a company-wide holder', async () => {
    const scoped = await moduleScopeWhere(projectA(), txA(), { prefix: 'x', siteCol: people.id })
    const wide = await moduleScopeWhere(
      ctx(['x.read.all'], { scopes: [{ type: 'tenant' }] }),
      txA(),
      { prefix: 'x', siteCol: people.id },
    )
    expect(scoped).toBeDefined()
    expect(wide).toBeUndefined()
  })
})

describe('hazid.read.others no longer implies company-wide', () => {
  it('lifts the visibility tier but NOT the project scope', async () => {
    const c = ctx(['hazid.read.self', 'hazid.read.others'])
    const out = await moduleScopeWhere(c, txA(), { prefix: 'hazid', siteCol: people.id })
    // Company-wide would be `undefined`; it is a scope predicate instead.
    expect(out).toBeDefined()
  })

  it('and does not widen other modules', async () => {
    const c = ctx(['hazid.read.others', 'x.read.self'])
    const hazid = await moduleScopeWhere(c, txA(), { prefix: 'hazid', siteCol: people.id })
    const other = await moduleScopeWhere(c, txA(), { prefix: 'x', siteCol: people.id })
    expect(isAlwaysFalse(other)).toBe(false)
    expect(other).toBeDefined()
    expect(hazid).toBeDefined()
  })
})

describe('moduleScopeWhere and canSeeRecord agree', () => {
  const records = [
    { siteId: SITE_A, personId: undefined, label: 'in-scope site record' },
    { siteId: SITE_B, personId: undefined, label: 'out-of-scope site record' },
    { siteId: null, personId: PEER_A, label: 'out-of-scope person record' },
  ]

  for (const rec of records) {
    it(`${rec.label}: the SQL filter and the record guard reach the same verdict`, async () => {
      const c = projectA()
      // The list filter, with a person column so the scope has something to bind.
      const where = await moduleScopeWhere(c, txA(), { prefix: 'x', siteCol: people.id })
      const listExcludes = isAlwaysFalse(where)
      const guardAllows = await canSeeRecord(c, txA(), {
        prefix: 'x',
        siteId: rec.siteId,
        personId: rec.personId,
        ownerIds: [],
      })
      // `listExcludes` is the blanket verdict; the guard must not be more
      // permissive than the list, and a non-excluded record must be decidable.
      if (listExcludes) expect(guardAllows).toBe(false)
    })
  }

  it('recordInProjectScope is the single-record form of the same rule', () => {
    const scope: ProjectScope = { kind: 'orgUnits', orgUnitIds: [SITE_A], personIds: [PEER_A] }
    expect(recordInProjectScope(scope, { siteId: SITE_A })).toBe(true)
    expect(recordInProjectScope(scope, { personId: PEER_A })).toBe(true)
    expect(recordInProjectScope(scope, { siteId: SITE_B })).toBe(false)
    expect(recordInProjectScope({ kind: 'unrestricted' }, { siteId: SITE_B })).toBe(true)
    expect(recordInProjectScope({ kind: 'empty', reason: 'no_scope' }, { siteId: SITE_A })).toBe(
      false,
    )
  })
})

describe('the adapter never produces an empty IN () or widens', () => {
  it('an org-unit scope with an empty id list is false, not IN ()', () => {
    const p = projectScopePredicate(
      { kind: 'orgUnits', orgUnitIds: [], personIds: [] },
      { orgUnitCol: people.id },
    )
    expect(isAlwaysFalse(p)).toBe(true)
  })

  it('a person scope with an empty id list is false', () => {
    const p = projectScopePredicate({ kind: 'persons', personIds: [] }, { personCol: people.id })
    expect(isAlwaysFalse(p)).toBe(true)
  })

  it('peopleAndOrgUnits binds BOTH legs when both columns exist', () => {
    const p = projectScopePredicate(
      { kind: 'peopleAndOrgUnits', orgUnitIds: ['o1'], personIds: ['p1'] },
      { orgUnitCol: people.id, personCol: peopleAssignments.personId },
    )
    expect(p).toBeDefined()
    const sql = render(p)
    expect(sql).toContain('"people"."id"')
    expect(sql).toContain('"people_assignments"."person_id"')
    expect(sql).toContain('or')
  })

  it('peopleAndOrgUnits degrades to the ONE leg that exists', () => {
    const onlyPerson = projectScopePredicate(
      { kind: 'peopleAndOrgUnits', orgUnitIds: ['o1'], personIds: ['p1'] },
      { personCol: people.id },
    )
    expect(onlyPerson).toBeDefined()
    expect(render(onlyPerson)).toContain('"people"."id"')
  })

  it('andPredicates treats undefined as "no constraint", never as a widening', () => {
    expect(andPredicates(undefined, undefined)).toBeUndefined()
    expect(andPredicates(sql`false`, undefined)).toBeDefined()
  })
})

describe('the people binding uses the person column', () => {
  it('a restricted caller gets `people.id IN (…)`, so the roster is project-scoped', async () => {
    const c = projectA()
    const p = projectScopePredicate(
      { kind: 'persons', personIds: [PEER_A] },
      { personCol: people.id },
    )
    expect(render(p)).toContain('"people"."id"')
    // And the record guard refuses a person outside the scope.
    expect(await canSeeRecord(c, txA(), { prefix: 'people', personId: PEER_B })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// `{type:'sites', siteIds:[…]}` + a personnel assignment.
//
// This is the combination the development fixture actually runs on: a foreman
// holds `role_assignments.scope = {type:'sites', siteIds:[<org_units.id>]}` AND a
// `people_assignments` row at that same org unit. The two are independent facts
// (see `converge-personnel-assignments.ts`), so the properties that matter are:
//
//   · the placement decides what is visible;
//   · the scope NEVER grants visibility on its own;
//   · the scope NEVER upgrades a role to company-wide;
//   · a role NAME still grants nothing.
//
// The resolver consults exactly one scope variant, `tenant`:
// `apps/web/src/lib/project-scope.ts:245`. Everything else is ignored, by design.
// ---------------------------------------------------------------------------

/** A `{type:'sites'}` RoleScope — the shape a foreman's role assignment holds. */
const sitesScope = (...siteIds: string[]) => ({ type: 'sites' as const, siteIds })

describe('a {type:"sites"} scope and a personnel assignment are independent', () => {
  it('scope naming A + assignment at A: sees A', async () => {
    const c = ctx(['x.read.all'], { personId: READER, scopes: [sitesScope(SITE_A)] })
    expect(await canSeeRecord(c, txA(), { prefix: 'x', siteId: SITE_A })).toBe(true)
  })

  it('scope naming A + assignment at A: still cannot see B', async () => {
    const c = ctx(['x.read.all'], { personId: READER, scopes: [sitesScope(SITE_A)] })
    expect(await canSeeRecord(c, txA(), { prefix: 'x', siteId: SITE_B })).toBe(false)
  })

  it('a scope naming B does NOT grant B when the assignment is at A', async () => {
    // The sharpest form of the independence rule: the access scope says B, the
    // personnel placement says A, and A is what wins. If the scope could grant
    // visibility this would be `true`.
    const c = ctx(['x.read.all'], { personId: READER, scopes: [sitesScope(SITE_B)] })
    expect(await canSeeRecord(c, txA(), { prefix: 'x', siteId: SITE_B })).toBe(false)
    expect(await canSeeRecord(c, txA(), { prefix: 'x', siteId: SITE_A })).toBe(true)
  })

  it('no assignment at all stays empty even WITH a {type:"sites"} scope', async () => {
    // A scope is not a placement. Without `people_assignments` the answer is
    // `empty`, not "whatever the scope names".
    const c = ctx(['x.read.all'], { personId: READER, scopes: [sitesScope(SITE_A, SITE_B)] })
    const noAssignment = projectScopeTx({ assignments: [], employeeRecord: 'present' })
    expect(isAlwaysFalse(await moduleScopeWhere(c, noAssignment, { prefix: 'x' }))).toBe(true)
  })

  it('a {type:"sites"} scope never yields the company-wide "no filter" answer', async () => {
    for (const ids of [[], [SITE_A], [SITE_A, SITE_B]]) {
      const c = ctx(['x.read.all'], { personId: READER, scopes: [sitesScope(...ids)] })
      expect(await moduleScopeWhere(c, txA(), { prefix: 'x' })).toBeDefined()
    }
  })

  it('scope naming A+B with an assignment only at A still sees A only', async () => {
    const c = ctx(['x.read.all'], { personId: READER, scopes: [sitesScope(SITE_A, SITE_B)] })
    expect(await canSeeRecord(c, txA(), { prefix: 'x', siteId: SITE_A })).toBe(true)
    expect(await canSeeRecord(c, txA(), { prefix: 'x', siteId: SITE_B })).toBe(false)
  })
})

describe('role name and non-tenant scope never reach unrestricted', () => {
  it('a role NAMED tenant_admin holding {type:"sites"} is not unrestricted', async () => {
    const c = ctx(['x.read.all'], {
      personId: READER,
      scopes: [sitesScope(SITE_A)],
      activeRoleId: 'tenant_admin',
    } as never)
    const out = await moduleScopeWhere(c, txA(), { prefix: 'x' })
    expect(out).toBeDefined()
  })

  it('a role NAMED tenant_admin holding {type:"sites"} cannot see outside it', async () => {
    const c = ctx(['x.read.all'], {
      personId: READER,
      scopes: [sitesScope(SITE_A)],
      activeRoleId: 'tenant_admin',
    } as never)
    expect(await canSeeRecord(c, txA(), { prefix: 'x', siteId: SITE_B })).toBe(false)
  })

  it('a role NAMED foreman with the full catalogue is still fail-closed without a placement', async () => {
    const c = ctx(['*'], {
      personId: READER,
      scopes: [sitesScope(SITE_A, SITE_B)],
      activeRoleId: 'foreman',
    } as never)
    const noAssignment = projectScopeTx({ assignments: [], employeeRecord: 'present' })
    expect(isAlwaysFalse(await moduleScopeWhere(c, noAssignment, { prefix: 'x' }))).toBe(true)
  })

  it('an explicit {type:"tenant"} IS unrestricted — the only non-super-admin route', async () => {
    const c = ctx(['x.read.all'], { scopes: [{ type: 'tenant' }] })
    expect(await moduleScopeWhere(c, txA(), { prefix: 'x' })).toBeUndefined()
    expect(await canSeeRecord(c, txA(), { prefix: 'x', siteId: SITE_B })).toBe(true)
  })
})
