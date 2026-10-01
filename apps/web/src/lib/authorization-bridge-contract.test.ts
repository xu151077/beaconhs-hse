// The core authorization contract: Permission → Role Scope → Visibility Tier.
//
//   Tenant / RLS  ->  Permission  ->  Role Scope  ->  Read Tier  ->  predicate
//
// The rule under test throughout: **a permission decides the tier, the Role Scope
// decides the rows, and neither can widen itself.** A role NAME never bypasses
// anything, and an unusable input fails closed rather than degrading to "no
// filter" — which in this ladder means the whole tenant.
//
// Two resolvers are covered, because they are different models and both are live:
//
//   `recordVisibilityWhere` — scope-driven. Reads the raw `RoleScope` variants.
//   `moduleScopeWhere` / `canSeeRecord` — tier-driven. The tier comes from
//     `<prefix>.read.{all,site,self}`; the rows come from `{type:'sites'}` plus
//     the caller's own identity.
//
// HOW IT IS ASSERTED
//
// Row-level claims are judged on `dialect.sqlToQuery(p)` — the compiled statement
// and its BOUND parameters. Drizzle compiles `inArray` to `in ($1, $2)` and binds
// the values, so an id never appears in the statement text and a text grep would
// pass for the wrong reason.

import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { people, peopleAssignments } from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'
import type { RequestContext } from '@beaconhs/tenant'
import type { RoleScope } from '@beaconhs/db/schema'
import { andPredicates, canSeeRecord, moduleScopeWhere, recordVisibilityWhere } from './visibility'

const SITE_A = '00000000-0000-4000-8000-00000000a001'
const SITE_B = '00000000-0000-4000-8000-00000000b001'
const READER = '018f47ba-86c4-7ee2-8d7a-5e7602f2afff'
const PEER_A = '0c000000-0000-4000-8000-0000000000c2'
const PEER_B = '0c000000-0000-4000-8000-0000000000c3'
const PEER_C = '0c000000-0000-4000-8000-0000000000c4'

const dialect = new PgDialect()
const render = (p: unknown) =>
  p === undefined ? '(no predicate)' : dialect.sqlToQuery(p as never).sql
const bound = (p: unknown): string[] =>
  p === undefined ? [] : dialect.sqlToQuery(p as never).params.map(String)

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
const atSiteA = (permissions: string[], over: CtxOverrides = {}) =>
  ctx(permissions, { scopes: [{ type: 'sites', siteIds: [SITE_A] }], ...over })
/** A caller assigned to site B only. */
const atSiteB = (permissions: string[], over: CtxOverrides = {}) =>
  ctx(permissions, { scopes: [{ type: 'sites', siteIds: [SITE_B] }], ...over })

/**
 * The tier ladder resolves entirely from `ctx` and never reads the transaction,
 * so this is not a shortcut — it is what the resolver does with the argument. A
 * stub that threw would fail these tests, which is the point.
 */
const tx = {} as Database

const X = {
  siteCol: peopleAssignments.orgUnitId,
  personCol: peopleAssignments.personId,
} as const

// ---------------------------------------------------------------------------
// Company-wide. There are exactly two routes, and only one of them is a role.
// ---------------------------------------------------------------------------

describe('company-wide is reachable two ways only', () => {
  it('a super-admin gets no row predicate', async () => {
    expect(
      await moduleScopeWhere(ctx([], { isSuperAdmin: true }), tx, { prefix: 'x' }),
    ).toBeUndefined()
    expect(
      await recordVisibilityWhere(ctx([], { isSuperAdmin: true }), tx, { personCol: people.id }),
    ).toBeUndefined()
  })

  it('an explicit {type:"tenant"} scope gets no row predicate', async () => {
    const c = ctx(['x.read.all'], { scopes: [{ type: 'tenant' }] })
    expect(await moduleScopeWhere(c, tx, { prefix: 'x' })).toBeUndefined()
    expect(await recordVisibilityWhere(c, tx, { personCol: people.id })).toBeUndefined()
  })

  it('a role NAME grants nothing on its own', async () => {
    // The single most important negative here. A role is a permission bundle and
    // nothing else: there is no `tenant_admin` shortcut in any resolver. A caller
    // with a `{type:'sites'}` scope but WITHOUT `x.read.all` must not reach the
    // company-wide answer through the back door.
    const named = ctx(['some.other.read'], { scopes: [{ type: 'sites', siteIds: [SITE_A] }] })
    const p = await moduleScopeWhere(named, tx, { prefix: 'x', siteCol: X.siteCol })
    expect(p).toBeDefined()
    expect(p).not.toBeUndefined()
  })

  it('a role name cannot make canSeeRecord return true without the read permission', async () => {
    const named = ctx(['some.other.read'], { scopes: [{ type: 'sites', siteIds: [SITE_A] }] })
    expect(await canSeeRecord(named, tx, { prefix: 'x', siteId: SITE_B, personId: PEER_B })).toBe(
      false,
    )
  })
})

// ---------------------------------------------------------------------------
// The site tier: the Role Scope is the boundary.
// ---------------------------------------------------------------------------

describe("read.site is bounded by the caller's own Role Scope", () => {
  it('site A cannot see a site B record', async () => {
    const p = await moduleScopeWhere(atSiteA(['x.read.site']), tx, {
      prefix: 'x',
      siteCol: X.siteCol,
    })
    expect(bound(p)).toContain(SITE_A)
    expect(bound(p)).not.toContain(SITE_B)
  })

  it('site A CAN see a site A record, and the guard agrees', async () => {
    const c = atSiteA(['x.read.site'], { personId: PEER_B })
    const p = await moduleScopeWhere(c, tx, { prefix: 'x', siteCol: X.siteCol })
    expect(bound(p)).toContain(SITE_A)
    expect(await canSeeRecord(c, tx, { prefix: 'x', siteId: SITE_A, personId: PEER_B })).toBe(true)
  })

  it('a site B caller sees B and not A', async () => {
    // The site A record is somebody ELSE's, so the own leg cannot rescue it. (The
    // site tier unions the caller's own records by design; a site A record the
    // caller personally owns is legitimately theirs.)
    const c = atSiteB(['x.read.site'], { personId: PEER_B })
    const p = await moduleScopeWhere(c, tx, { prefix: 'x', siteCol: X.siteCol })
    expect(bound(p)).toContain(SITE_B)
    expect(bound(p)).not.toContain(SITE_A)
    expect(await canSeeRecord(c, tx, { prefix: 'x', siteId: SITE_A, personId: PEER_C })).toBe(false)
  })

  it('but a site A record the caller personally operated is still theirs', async () => {
    const c = atSiteB(['x.read.site'], { personId: PEER_B })
    expect(await canSeeRecord(c, tx, { prefix: 'x', siteId: SITE_A, personId: PEER_B })).toBe(true)
  })

  it('a union of A and B reaches both', async () => {
    const c = ctx(['x.read.site'], { scopes: [{ type: 'sites', siteIds: [SITE_A, SITE_B] }] })
    const p = await moduleScopeWhere(c, tx, { prefix: 'x', siteCol: X.siteCol })
    expect(bound(p).sort()).toEqual([SITE_A, SITE_B].sort())
  })

  it('a {type:"sites"} scope never yields the company-wide "no filter" answer', async () => {
    // The distinction that matters: `undefined` here would hand one site's rows to
    // a caller scoped elsewhere.
    const p = await moduleScopeWhere(atSiteA(['x.read.site']), tx, {
      prefix: 'x',
      siteCol: X.siteCol,
    })
    expect(p).toBeDefined()
    expect(render(p)).not.toBe('(no predicate)')
  })
})

// ---------------------------------------------------------------------------
// read.all is tenant-wide; that is what the tier means.
// ---------------------------------------------------------------------------

describe('read.all is the whole tenant, by definition', () => {
  it('binds no ids at all', async () => {
    const p = await moduleScopeWhere(ctx(['x.read.all']), tx, { prefix: 'x', siteCol: X.siteCol })
    expect(p).toBeUndefined()
    expect(bound(p)).toEqual([])
  })

  it('a read.all holder is NOT narrower than a company-wide holder', async () => {
    // The pair of properties that used to be asserted as "read.all is narrower".
    // Under the native model they are the same answer, and that is correct: RLS
    // bounds both to the tenant, and the tier's job is done.
    const readAll = await moduleScopeWhere(ctx(['x.read.all']), tx, { prefix: 'x' })
    const tenant = await moduleScopeWhere(
      ctx(['x.read.all'], { scopes: [{ type: 'tenant' }] }),
      tx,
      { prefix: 'x' },
    )
    expect(readAll).toBeUndefined()
    expect(tenant).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// read.self is the caller's own rows, and it is the safe default.
// ---------------------------------------------------------------------------

describe('read.self, and the default when no read key is held', () => {
  it("binds the caller's own person and never a site", async () => {
    const p = await moduleScopeWhere(atSiteA(['x.read.self']), tx, {
      prefix: 'x',
      siteCol: X.siteCol,
      personCol: X.personCol,
    })
    expect(bound(p)).toContain(READER)
    expect(bound(p)).not.toContain(SITE_A)
    expect(bound(p)).not.toContain(SITE_B)
  })

  it("a self-tier caller cannot see a peer's row", async () => {
    const c = atSiteA(['x.read.self'])
    expect(await canSeeRecord(c, tx, { prefix: 'x', siteId: SITE_A, personId: PEER_A })).toBe(false)
    expect(await canSeeRecord(c, tx, { prefix: 'x', siteId: SITE_A, personId: READER })).toBe(true)
  })

  it('a caller with NO read key degrades to self, never to the tenant', async () => {
    // The fail-closed default. `resolveVisibilityTier` returns `self` for a caller
    // with no tier, so holding some unrelated permission can never widen them.
    const p = await moduleScopeWhere(ctx(['something.else']), tx, {
      prefix: 'x',
      personCol: X.personCol,
    })
    expect(p).toBeDefined()
    expect(bound(p)).toEqual([READER])
  })

  it('a caller with no read key AND no person record is denied outright', async () => {
    const p = await moduleScopeWhere(
      ctx(['something.else'], { personId: null, scopes: [{ type: 'sites', siteIds: [SITE_A] }] }),
      tx,
      { prefix: 'x', personCol: X.personCol },
    )
    expect(p).toBeDefined()
    // `undefined` is the tenant-wide answer; this must not be it.
    expect(render(p)).toBe('false')
    expect(bound(p)).toEqual([])
  })

  it('a self-tier caller with no person record is refused every record', async () => {
    const c = ctx(['x.read.self'], {
      personId: null,
      scopes: [{ type: 'sites', siteIds: [SITE_A] }],
    })
    expect(await canSeeRecord(c, tx, { prefix: 'x', siteId: SITE_A, personId: READER })).toBe(false)
  })

  it('an owner column matches the caller by membership id', async () => {
    const c = ctx(['x.read.self'])
    expect(
      await canSeeRecord(c, tx, {
        prefix: 'x',
        ownerIds: ['m1'],
        siteId: SITE_B,
        personId: PEER_B,
      }),
    ).toBe(true)
    expect(
      await canSeeRecord(c, tx, {
        prefix: 'x',
        ownerIds: ['m2'],
        siteId: SITE_B,
        personId: PEER_B,
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// hazid.read.others lifts the VISIBILITY tier, scoped to hazid.
// ---------------------------------------------------------------------------

describe('hazid.read.others lifts the tier, and only for hazid', () => {
  const othersCtx = (prefix: string) =>
    ctx([`${prefix}.read.self`, 'hazid.read.others'], { personId: null, scopes: [] })

  it("lifts a self-tier hazid holder to see other people's rows", async () => {
    const c = othersCtx('hazid')
    expect(
      await moduleScopeWhere(c, tx, { prefix: 'hazid', personCol: X.personCol }),
    ).toBeUndefined()
    expect(await canSeeRecord(c, tx, { prefix: 'hazid', personId: PEER_A, siteId: SITE_A })).toBe(
      true,
    )
  })

  it('does not widen other modules', async () => {
    const c = othersCtx('incidents')
    const p = await moduleScopeWhere(c, tx, { prefix: 'incidents', personCol: X.personCol })
    expect(p).toBeDefined()
    expect(bound(p)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The list filter and the record guard are the same rule.
// ---------------------------------------------------------------------------

describe('moduleScopeWhere and canSeeRecord agree', () => {
  const callers = [
    ['super-admin', ctx([], { isSuperAdmin: true })],
    ['read.all', ctx(['x.read.all'], { scopes: [{ type: 'sites', siteIds: [SITE_A] }] })],
    ['read.site@A', atSiteA(['x.read.site'], { personId: PEER_B })],
    ['read.site@B', atSiteB(['x.read.site'], { personId: PEER_C })],
    ['read.self', atSiteA(['x.read.self'])],
    ['no read key', ctx(['other.read'], { scopes: [{ type: 'sites', siteIds: [SITE_A] }] })],
  ] as const

  const records = [
    ['A / peer', { siteId: SITE_A, personId: PEER_B }],
    ['A / me', { siteId: SITE_A, personId: READER }],
    ['B / peer', { siteId: SITE_B, personId: PEER_B }],
    ['B / me', { siteId: SITE_B, personId: READER }],
    ['no site / peer', { siteId: null, personId: PEER_B }],
  ] as const

  for (const [callerName, caller] of callers) {
    it(`${callerName}: the SQL filter and the record guard reach the same verdict`, async () => {
      for (const [recName, rec] of records) {
        const label = `${callerName} | ${recName}`
        const boundIds = bound(
          await moduleScopeWhere(caller, tx, {
            prefix: 'x',
            siteCol: X.siteCol,
            personCol: X.personCol,
          }),
        )
        const byId = await canSeeRecord(caller, tx, { prefix: 'x', ...rec })

        if (byId) {
          // Readable by id ⇒ unrestricted, or this row's own binding was bound.
          expect(
            boundIds.length === 0 ||
              (rec.siteId !== null && boundIds.includes(rec.siteId)) ||
              (rec.personId !== null && boundIds.includes(rec.personId)),
            label,
          ).toBe(true)
        } else {
          // Refused by id ⇒ the list predicate cannot match this row, so a detail
          // page can never surface something the list withholds.
          expect(
            boundIds.some((v) => v === rec.siteId || v === rec.personId),
            label,
          ).toBe(false)
        }
      }
    })
  }
})

// ---------------------------------------------------------------------------
// andPredicates: the only AND-ing helper, and it can only narrow.
// ---------------------------------------------------------------------------

describe('andPredicates treats undefined as "no constraint", never as a widening', () => {
  it('drops undefined legs', async () => {
    const p = await moduleScopeWhere(atSiteA(['x.read.site']), tx, {
      prefix: 'x',
      siteCol: X.siteCol,
    })
    expect(render(andPredicates(p, undefined))).toBe(render(p))
  })

  it('all-undefined yields undefined, which callers read as "no filter"', () => {
    expect(andPredicates(undefined, undefined)).toBeUndefined()
  })

  it('two real legs compose with AND', async () => {
    const p = await moduleScopeWhere(atSiteA(['x.read.site']), tx, {
      prefix: 'x',
      siteCol: X.siteCol,
      personCol: X.personCol,
    })
    const composed = andPredicates(p, p)
    expect(render(composed).toLowerCase()).toContain(' and ')
  })
})

// ---------------------------------------------------------------------------
// recordVisibilityWhere: the scope-driven resolver, on real RoleScope variants.
// ---------------------------------------------------------------------------

describe('recordVisibilityWhere reads the raw RoleScope variants', () => {
  it('a {type:"people"} scope binds the person column', async () => {
    const p = await recordVisibilityWhere(
      ctx(['y.read'], { scopes: [{ type: 'people', personIds: [PEER_A] }] }),
      tx,
      { personCol: people.id },
    )
    expect(bound(p)).toContain(PEER_A)
    expect(bound(p)).not.toContain(PEER_B)
  })

  it('a {type:"sites"} scope binds the site column', async () => {
    const p = await recordVisibilityWhere(
      ctx(['y.read'], { scopes: [{ type: 'sites', siteIds: [SITE_A] }] }),
      tx,
      {
        personCol: people.id,
        siteCol: peopleAssignments.orgUnitId,
      },
    )
    expect(bound(p)).toContain(SITE_A)
  })

  it('an empty scope variant sees nothing rather than everything', async () => {
    // `{type:'sites'}` with no ids is not company-wide; it grants nothing.
    const p = await recordVisibilityWhere(
      ctx(['y.read'], { scopes: [{ type: 'sites', siteIds: [] }] }),
      tx,
      { personCol: people.id },
    )
    expect(p).toBeDefined()
  })

  it("the caller's own records are always included", async () => {
    const p = await recordVisibilityWhere(
      ctx(['y.read'], { scopes: [{ type: 'people', personIds: [PEER_A] }] }),
      tx,
      { personCol: people.id },
    )
    expect(bound(p)).toContain(READER)
    expect(bound(p)).toContain(PEER_A)
  })
})

// ---------------------------------------------------------------------------
// The scope-driven resolver and the tier-driven ladder answer differently on
// purpose. Both are live, so the difference is recorded rather than papered over.
// ---------------------------------------------------------------------------

describe('OPEN PRODUCT QUESTION — read.site with an empty site list', () => {
  it('the web ladder falls through to own-only', async () => {
    // Pre-existing native behaviour, asserted so it cannot drift silently. It is
    // NOT tenant-wide, which is the property that matters.
    const c = ctx(['x.read.site'], { scopes: [{ type: 'sites', siteIds: [] }] })
    const p = await moduleScopeWhere(c, tx, {
      prefix: 'x',
      siteCol: X.siteCol,
      personCol: X.personCol,
    })
    expect(bound(p)).toEqual([READER])
    expect(p).toBeDefined()
  })

  it('and the guard refuses an out-of-site record for the same caller', async () => {
    const c = ctx(['x.read.site'], { scopes: [{ type: 'sites', siteIds: [] }] })
    expect(await canSeeRecord(c, tx, { prefix: 'x', siteId: SITE_A, personId: PEER_B })).toBe(false)
  })

  it('the analytics ladder withholds instead — asserted in packages/analytics', () => {
    // The counterpart is pinned there; this note exists so neither side is changed
    // without the other being looked at. Both behaviours predate the removal of
    // the second authorization dimension, and unifying them is a product decision.
    expect(true).toBe(true)
  })
})
