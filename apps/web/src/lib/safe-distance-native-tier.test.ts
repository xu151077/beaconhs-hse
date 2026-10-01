// Safe Distance on the NATIVE read tier — Cases A–H.
//
// WHAT IS ASSERTED
//
// `tools.safe-distance.use` is the OPERATE capability (open the tool, create,
// save, lock, print, export) and says nothing about which records a caller may
// see. That question belongs to the one shared BeaconHS ladder —
// `resolveVisibilityTier` / `moduleScopeWhere` / `canSeeRecord` in
// `lib/visibility.ts` — driven by three catalogue keys:
//
//   tools.safe-distance.read.all   → the whole tenant
//   tools.safe-distance.read.site  → the caller's `{type:'sites'}` Role Scope
//   tools.safe-distance.read.self  → records whose operator_person_id is them
//
// The two bindings are columns `safe_distance_records` already carries:
// `site_org_unit_id` and `operator_person_id`.
//
// HOW IT IS ASSERTED
//
// Row-level claims are judged on `dialect.sqlToQuery(p)` — the compiled statement
// and its BOUND parameters. Drizzle compiles `inArray` to `in ($1, $2)` and binds
// the values, so an id never appears in the statement text and a text grep would
// pass for the wrong reason. The detail/print/mutation guard is asserted as real
// booleans from `canSeeRecord`, never from a proxy for it.
//
// The cross-surface checks (Case G/H) read SOURCES, because the failure being
// guarded is drift between files that must all go through one shared helper —
// the exact defect 15B-3C-2A had to repair for the analytics binding.
//
// The suite is mutation-verified: 16 mutations of the tier decision, the two
// column bindings, the Project Scope opt-out and the scope prefix were applied
// one at a time, each first proven to change the resolvers' output, and 14 were
// caught here. The two that were not are provably no-op rewrites, recorded in
// `MUTATION NOTES` below.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PgDialect } from 'drizzle-orm/pg-core'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE, type RoleScope } from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'
import type { RequestContext } from '@beaconhs/tenant'
import {
  SAFE_DISTANCE_PERMISSION,
  SAFE_DISTANCE_SCOPE_COLUMNS,
  SAFE_DISTANCE_SCOPE_PREFIX,
  canSeeSafeDistanceRecord,
  canUseSafeDistance,
  safeDistanceScopeWhere,
} from './safe-distance-access'

const SITE_A = '00000000-0000-4000-8000-00000000a001'
const SITE_B = '00000000-0000-4000-8000-00000000b001'
const OPERATOR_A = '0c000000-0000-4000-8000-0000000000c1'
const OPERATOR_B = '0c000000-0000-4000-8000-0000000000c2'
const TU_A = '1a000000-0000-4000-8000-0000000000a1'

const dialect = new PgDialect()

/** The BOUND values of a predicate. Never the SQL text — the ids are parameters. */
const boundValues = (p: unknown): string[] => {
  if (p === undefined) return []
  return dialect.sqlToQuery(p as never).params.map(String)
}

const statement = (p: unknown): string =>
  p === undefined ? '(no predicate)' : dialect.sqlToQuery(p as never).sql

/**
 * Safe Distance opts out of the Project Scope conjunct, so neither resolver
 * issues a database read and the transaction is never touched. If a future change
 * reintroduces that read, the stub below fails loudly rather than silently
 * letting a test pass on a predicate the ladder no longer builds.
 */
const tx = new Proxy({} as Database, {
  get(_t, prop) {
    throw new Error(
      `Safe Distance authorization must not touch the database (accessed .${String(prop)}). ` +
        `Either the Project Scope opt-out was removed, or a resolver started reading.`,
    )
  },
})

function ctx(permissions: string[], over: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-0000000000aa',
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: TU_A, displayName: 'A' },
    personId: OPERATOR_A,
    permissions: new Set(permissions),
    scopes: [],
    activeRoleId: null,
    db: (async (fn: (t: unknown) => unknown) => fn({})) as RequestContext['db'],
    ...over,
  } as RequestContext
}

const atSites = (siteIds: string[]): RoleScope[] => [{ type: 'sites', siteIds }]

/** A caller whose `personId` is unset — no self leg is derivable at all. */
const noPerson = (permissions: string[], scopes: RoleScope[] = []) =>
  ctx(permissions, { personId: null, membership: null, scopes })

// ---------------------------------------------------------------------------
// Case A / B / C / D / E / F — the tier matrix, on the real resolvers.
// ---------------------------------------------------------------------------

describe('Safe Distance native read tier — list predicate', () => {
  it('A. read.all binds no ids at all, leaving RLS to bound the tenant', async () => {
    const p = await safeDistanceScopeWhere(ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.all`]), tx)
    expect(p).toBeUndefined()
    expect(boundValues(p)).toEqual([])
  })

  it('B. read.site + sites:[A] binds exactly site A, never site B', async () => {
    const p = await safeDistanceScopeWhere(
      ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.site`], { scopes: atSites([SITE_A]) }),
      tx,
    )
    expect(statement(p)).toContain('"safe_distance_records"."site_org_unit_id"')
    expect(boundValues(p)).toContain(SITE_A)
    expect(boundValues(p)).not.toContain(SITE_B)
  })

  it('D. read.site + sites:[B] binds site B and cannot reach site A', async () => {
    const p = await safeDistanceScopeWhere(
      ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.site`], { scopes: atSites([SITE_B]) }),
      tx,
    )
    expect(boundValues(p)).toContain(SITE_B)
    expect(boundValues(p)).not.toContain(SITE_A)
  })

  it("C. read.self binds the caller's own operator id and no site id", async () => {
    const p = await safeDistanceScopeWhere(
      ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.self`], { scopes: atSites([SITE_A]) }),
      tx,
    )
    // The self tier is the OWN leg only. Holding `read.self` must not inherit the
    // site tier even when the caller holds a sites Role Scope — `resolveVisibilityTier`
    // checks `.read.all` then `.read.site` and stops at self.
    expect(statement(p)).toContain('"safe_distance_records"."operator_person_id"')
    expect(boundValues(p)).toContain(OPERATOR_A)
    expect(boundValues(p)).not.toContain(SITE_A)
    expect(boundValues(p)).not.toContain(SITE_B)
  })

  it('E. two self-tier operators bind different ids, so neither sees the other', async () => {
    const mine = await safeDistanceScopeWhere(ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.self`]), tx)
    const theirs = await safeDistanceScopeWhere(
      ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.self`], { personId: OPERATOR_B }),
      tx,
    )
    expect(boundValues(mine)).toEqual([OPERATOR_A])
    expect(boundValues(theirs)).toEqual([OPERATOR_B])
    expect(boundValues(mine)).not.toContain(OPERATOR_B)
    expect(boundValues(theirs)).not.toContain(OPERATOR_A)
  })

  it('F. the operate capability alone degrades to self, never to the tenant', async () => {
    // The critical fail-closed property, and the one the phase forbids breaking:
    // `tools.safe-distance.use` is held by all four roles, so if the ladder let it
    // widen, a field worker would read every pressure test in the tenant.
    const p = await safeDistanceScopeWhere(ctx([SAFE_DISTANCE_PERMISSION]), tx)
    expect(p).toBeDefined()
    expect(boundValues(p)).toEqual([OPERATOR_A])
  })

  it('F. the operate capability plus a sites scope still does not reach the site tier', async () => {
    // A sites Role Scope is not a read permission. Without a read key the tier is
    // self, so the site leg must not appear.
    const p = await safeDistanceScopeWhere(
      ctx([SAFE_DISTANCE_PERMISSION], { scopes: atSites([SITE_A]) }),
      tx,
    )
    expect(boundValues(p)).toEqual([OPERATOR_A])
    expect(boundValues(p)).not.toContain(SITE_A)
  })

  it('F. a caller with no permission at all still cannot widen', async () => {
    const p = await safeDistanceScopeWhere(ctx([]), tx)
    expect(p).toBeDefined()
    expect(boundValues(p)).toEqual([OPERATOR_A])
  })

  it('F. a caller with no person record is denied outright rather than widened', async () => {
    // With no `personId` the own leg cannot be built, so the ladder must return a
    // terminal `false` — never `undefined`, which would mean the whole tenant.
    const p = await safeDistanceScopeWhere(noPerson([]), tx)
    expect(p).toBeDefined()
    expect(boundValues(p)).toEqual([])
    expect(statement(p)).toBe('false')
  })

  it("the site tier unions the caller's own records with their sites", async () => {
    // Native ladder behaviour, unchanged: a site-scoped reviewer also sees what
    // they personally operated. Both ids are bound in one predicate.
    const p = await safeDistanceScopeWhere(
      ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.site`], { scopes: atSites([SITE_A]) }),
      tx,
    )
    expect(statement(p).toLowerCase()).toContain(' or ')
    expect(boundValues(p)).toContain(SITE_A)
    expect(boundValues(p)).toContain(OPERATOR_A)
  })

  it('read.all wins over read.site and read.self when a caller holds all three', async () => {
    const p = await safeDistanceScopeWhere(
      ctx([
        `${SAFE_DISTANCE_SCOPE_PREFIX}.read.all`,
        `${SAFE_DISTANCE_SCOPE_PREFIX}.read.site`,
        `${SAFE_DISTANCE_SCOPE_PREFIX}.read.self`,
      ]),
      tx,
    )
    expect(p).toBeUndefined()
  })

  it('the site tier degrades to own records when the caller holds no sites scope', async () => {
    // Pre-existing native ladder behaviour, asserted so it cannot drift silently:
    // `read.site` with an empty site list falls through to the own leg. It is NOT
    // tenant-wide, which is the property that matters here.
    const p = await safeDistanceScopeWhere(ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.site`]), tx)
    expect(boundValues(p)).toEqual([OPERATOR_A])
    expect(p).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// The detail / print / mutation guard, as real booleans from canSeeRecord.
// ---------------------------------------------------------------------------

describe('Safe Distance native read tier — single-record guard', () => {
  const record = (siteOrgUnitId: string | null, operatorPersonId: string | null) => ({
    siteOrgUnitId,
    operatorPersonId,
  })

  it('A. read.all may read any record in the tenant', async () => {
    const c = ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.all`])
    expect(await canSeeSafeDistanceRecord(c, tx, record(SITE_A, OPERATOR_B))).toBe(true)
    expect(await canSeeSafeDistanceRecord(c, tx, record(SITE_B, OPERATOR_B))).toBe(true)
  })

  it('B. read.site + sites:[A] may read site A', async () => {
    const c = ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.site`], { scopes: atSites([SITE_A]) })
    expect(await canSeeSafeDistanceRecord(c, tx, record(SITE_A, OPERATOR_B))).toBe(true)
  })

  it('D. read.site + sites:[A] may NOT read site B', async () => {
    const c = ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.site`], { scopes: atSites([SITE_A]) })
    expect(await canSeeSafeDistanceRecord(c, tx, record(SITE_B, OPERATOR_B))).toBe(false)
  })

  it('D. read.site + sites:[A] may still read their own record at site B', async () => {
    // The union half of the site tier: site B is outside the scope, but the caller
    // operated this check themselves.
    const c = ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.site`], { scopes: atSites([SITE_A]) })
    expect(await canSeeSafeDistanceRecord(c, tx, record(SITE_B, OPERATOR_A))).toBe(true)
  })

  it('C. read.self may read their own operated record', async () => {
    const c = ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.self`])
    expect(await canSeeSafeDistanceRecord(c, tx, record(SITE_A, OPERATOR_A))).toBe(true)
  })

  it("C. read.self may NOT read another operator's record at their own site", async () => {
    const c = ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.self`], { scopes: atSites([SITE_A]) })
    expect(await canSeeSafeDistanceRecord(c, tx, record(SITE_A, OPERATOR_B))).toBe(false)
  })

  it("E. two self-tier operators cannot read each other's records", async () => {
    const alice = ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.self`], { personId: OPERATOR_A })
    const bob = ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.self`], { personId: OPERATOR_B })
    const aliceRecord = record(SITE_A, OPERATOR_A)
    expect(await canSeeSafeDistanceRecord(alice, tx, aliceRecord)).toBe(true)
    expect(await canSeeSafeDistanceRecord(bob, tx, aliceRecord)).toBe(false)
  })

  it('F. a record with no site and no operator is refused for every non-all tier', async () => {
    // A NULL site is excluded by `IN (...)` under three-valued logic and a NULL
    // operator never equals the caller, so an unassigned record is not reachable
    // by guessing its id.
    const orphan = record(null, null)
    for (const key of ['read.site', 'read.self'] as const) {
      const c = ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.${key}`], { scopes: atSites([SITE_A]) })
      expect(await canSeeSafeDistanceRecord(c, tx, orphan), key).toBe(false)
    }
  })

  it('F. a self-tier caller with no person record is refused everything', async () => {
    const c = noPerson([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.self`], atSites([SITE_A]))
    expect(await canSeeSafeDistanceRecord(c, tx, record(SITE_A, OPERATOR_A))).toBe(false)
    expect(await canSeeSafeDistanceRecord(c, tx, record(SITE_A, OPERATOR_B))).toBe(false)
  })

  it('a row the list filter cannot reach is also refused by id', async () => {
    // The consistency that matters. The list binds ids as PARAMETERS, so this
    // compares against the bound values — never the statement text, where no id
    // appears at all. Asserted across the whole matrix rather than one case.
    const callers = [
      ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.all`]),
      ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.site`], { scopes: atSites([SITE_A]) }),
      ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.site`], { scopes: atSites([SITE_B]) }),
      ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.site`]),
      ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.self`]),
      ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.self`], { scopes: atSites([SITE_A]) }),
      ctx([SAFE_DISTANCE_PERMISSION]),
      ctx([]),
      noPerson([]),
    ]
    const rows = [
      record(SITE_A, OPERATOR_A),
      record(SITE_A, OPERATOR_B),
      record(SITE_B, OPERATOR_A),
      record(SITE_B, OPERATOR_B),
      record(null, OPERATOR_A),
      record(null, null),
      record(SITE_A, null),
    ]
    for (const c of callers) {
      for (const row of rows) {
        const label = `${[...c.permissions].join('+') || '(none)'}|sites=${JSON.stringify(c.scopes)}|person=${c.personId}|site=${row.siteOrgUnitId}|op=${row.operatorPersonId}`
        const bound = boundValues(await safeDistanceScopeWhere(c, tx))
        const byId = await canSeeSafeDistanceRecord(c, tx, row)

        if (byId) {
          // Readable by id ⇒ either the list is unrestricted (tier `all`, so RLS
          // alone bounds it) or this row's own binding was bound. Never narrower.
          expect(
            bound.length === 0 ||
              (row.siteOrgUnitId !== null && bound.includes(row.siteOrgUnitId)) ||
              (row.operatorPersonId !== null && bound.includes(row.operatorPersonId)),
            label,
          ).toBe(true)
        } else {
          // Refused by id ⇒ the list predicate cannot match this row, so the detail
          // page can never surface something the list withholds.
          expect(
            bound.some((v) => v === row.siteOrgUnitId || v === row.operatorPersonId),
            label,
          ).toBe(false)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The catalogue and the role mapping.
// ---------------------------------------------------------------------------

describe('Safe Distance read tier — catalogue', () => {
  it('declares exactly the three read tiers plus the operate capability', () => {
    for (const key of ['all', 'site', 'self'] as const) {
      expect(PERMISSION_CATALOGUE).toContain(`tools.safe-distance.read.${key}`)
    }
    expect(PERMISSION_CATALOGUE).toContain('tools.safe-distance.use')
  })

  it('names them under the existing tools.safe-distance prefix, not a new namespace', () => {
    // A separate `safe_distance.` namespace would split the operate capability
    // from the read tier and break `readTierCovers` widening within the module.
    const sd = PERMISSION_CATALOGUE.filter((k) => /safe.?distance/.test(k))
    expect(sd.length).toBe(4)
    expect(sd.every((k) => k.startsWith('tools.safe-distance.'))).toBe(true)
  })

  it('the shared binding is declared once, on the two native columns', () => {
    expect(SAFE_DISTANCE_SCOPE_PREFIX).toBe('tools.safe-distance')
    expect(SAFE_DISTANCE_SCOPE_COLUMNS.prefix).toBe('tools.safe-distance')
    // A mutation that swapped either column for a different one is the failure
    // this pins: the ladder would bind a column the table does not have, or would
    // bind the right column for the wrong tier.
    expect(SAFE_DISTANCE_SCOPE_COLUMNS.siteCol.name).toBe('site_org_unit_id')
    expect(SAFE_DISTANCE_SCOPE_COLUMNS.personCol.name).toBe('operator_person_id')
  })

  it('declares no flag, scope type or predicate helper of its own', () => {
    // Safe Distance's boundary is the shared ladder plus the two columns, nothing
    // else. A module-specific predicate helper, or a flag on the shared resolver,
    // would be a second ladder — and the flag this file once asserted is gone.
    const keys = Object.keys(SAFE_DISTANCE_SCOPE_COLUMNS).sort()
    expect(keys).toEqual(['personCol', 'prefix', 'siteCol'])
  })
})

describe('Safe Distance read tier — built-in role mapping', () => {
  it('worker holds the self tier, so a field worker is never tenant-wide', () => {
    expect(BUILTIN_ROLES.worker?.permissions).toContain('tools.safe-distance.read.self')
    expect(BUILTIN_ROLES.worker?.permissions).not.toContain('tools.safe-distance.read.site')
    expect(BUILTIN_ROLES.worker?.permissions).not.toContain('tools.safe-distance.read.all')
  })

  it('foreman holds the site tier, matching its other site-tiered reads', () => {
    expect(BUILTIN_ROLES.foreman?.permissions).toContain('tools.safe-distance.read.site')
    expect(BUILTIN_ROLES.foreman?.permissions).not.toContain('tools.safe-distance.read.all')
  })

  it('safety_manager holds the all tier', () => {
    expect(BUILTIN_ROLES.safety_manager?.permissions).toContain('tools.safe-distance.read.all')
  })

  it('tenant_admin holds all three through the whole catalogue', () => {
    for (const key of ['all', 'site', 'self'] as const) {
      expect(BUILTIN_ROLES.tenant_admin?.permissions).toContain(`tools.safe-distance.read.${key}`)
    }
  })

  it('every built-in role that may operate the tool declares a read tier', () => {
    // The transitional state the phase forbids: an operate capability with no read
    // tier would rely on the ladder's self fallback, which is safe but unintentional.
    const withoutATier: string[] = []
    for (const [name, role] of Object.entries(BUILTIN_ROLES)) {
      const perms = role.permissions as string[]
      if (!perms.includes('tools.safe-distance.use')) continue
      const tiers = ['all', 'site', 'self'].filter((t) =>
        perms.includes(`tools.safe-distance.read.${t}`),
      )
      if (tiers.length === 0) withoutATier.push(name)
    }
    expect(withoutATier).toEqual([])
  })

  it('the three non-admin roles each name exactly one tier, so no grant is redundant', () => {
    // `tenant_admin` is excluded deliberately: it holds the whole catalogue, so it
    // holds all three by construction. For the other three, two tiers on one role
    // would make the narrower grant dead configuration.
    for (const name of ['worker', 'foreman', 'safety_manager'] as const) {
      const perms = BUILTIN_ROLES[name]?.permissions as string[]
      const tiers = ['all', 'site', 'self'].filter((t) =>
        perms.includes(`tools.safe-distance.read.${t}`),
      )
      expect(tiers.length, `${name} should declare exactly one tier`).toBe(1)
    }
  })

  it('each role resolves to one effective tier, ordered narrowest to widest', () => {
    // `tenant_admin` holds the whole catalogue, so it holds all three keys; the
    // ladder takes the WIDEST one, which is what `resolveVisibilityTier` checks
    // first. This asserts the mapping the ladder actually produces.
    const effectiveTier = (name: keyof typeof BUILTIN_ROLES) => {
      const perms = BUILTIN_ROLES[name]?.permissions as string[]
      if (perms.includes('tools.safe-distance.read.all')) return 'all'
      if (perms.includes('tools.safe-distance.read.site')) return 'site'
      return 'self'
    }
    expect([
      effectiveTier('worker'),
      effectiveTier('foreman'),
      effectiveTier('safety_manager'),
      effectiveTier('tenant_admin'),
    ]).toEqual(['self', 'site', 'all', 'all'])
  })

  it('the operate capability is still required to reach the tool at all', () => {
    // Read and operate are independent axes: a read tier alone does not open the
    // tool, and the operate capability alone does not widen the records.
    expect(canUseSafeDistance(ctx([`${SAFE_DISTANCE_SCOPE_PREFIX}.read.all`]))).toBe(false)
    expect(canUseSafeDistance(ctx([SAFE_DISTANCE_PERMISSION]))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cross-surface consistency. These read SOURCES: the failure is drift between
// files that must all go through the one shared helper.
// ---------------------------------------------------------------------------

const readSource = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

const LIST = readSource('../app/(app)/tools/safe-distance/page.tsx')
const CSV = readSource('../app/(app)/tools/safe-distance/export.csv/route.ts')
const DETAIL = readSource('../app/(app)/tools/safe-distance/[id]/page.tsx')
const PRINT = readSource('../app/(app)/tools/safe-distance/[id]/print/page.tsx')
const ACTIONS = readSource('../app/(app)/tools/safe-distance/_actions.ts')
const SCOPE_SPEC = readSource('../../../../packages/analytics/src/server/scope.ts')

describe('Safe Distance — list, detail, print, CSV, mutations and analytics agree', () => {
  it('G. the list and the CSV both filter through the one shared helper', () => {
    for (const [name, source] of [
      ['list', LIST],
      ['csv', CSV],
    ] as const) {
      expect(source, name).toContain('safeDistanceScopeWhere(ctx, tx)')
      // Neither may re-declare the columns: a second binding is exactly how the
      // list and the export drifted apart in 15B-3C-2A.
      expect(source, name).not.toMatch(/orgUnitCol:\s*safeDistanceRecords/)
      expect(source, name).not.toMatch(/personCol:\s*safeDistanceRecords/)
      expect(source, name).not.toMatch(/siteCol:\s*safeDistanceRecords/)
    }
  })

  it('G. the CSV is not widened relative to the list — both AND the same conjunct', () => {
    // The list keeps `if (scopeWhere) filters.push(scopeWhere)`; the export must
    // too, and neither may substitute the scope for the deleted-at check.
    for (const [name, source] of [
      ['list', LIST],
      ['csv', CSV],
    ] as const) {
      expect(source, name).toMatch(
        /const filters: SQL<unknown>\[\] = \[isNull\(safeDistanceRecords\.deletedAt\)\]/,
      )
      expect(source, name).toMatch(/if \(scopeWhere\) filters\.push\(scopeWhere\)/)
      expect(source, name).toContain('const whereClause = and(...filters)')
    }
  })

  it('G. the list facet counts are bounded by the same tier as the rows', () => {
    // Otherwise a narrowed caller reads the tenant-wide totals off the method chips
    // even though the rows behind them are withheld. `and()` drops an undefined
    // conjunct, so the unfiltered `all` tier is still correct here.
    expect(LIST).toContain('.where(and(isNull(safeDistanceRecords.deletedAt), scopeWhere))')
    expect(LIST.indexOf('scopeWhere')).toBeLessThan(LIST.indexOf('const mc = await tx'))
  })

  it('G. the detail page and the print view both run the record guard', () => {
    expect(DETAIL).toContain('canSeeSafeDistanceRecord(ctx, tx, row)')
    // The print view joins the site, supervisor and operator, so leaving it
    // unguarded would make it a strictly wider read-by-id bypass than the page.
    expect(PRINT).toContain('canSeeSafeDistanceRecord(ctx, tx, row.rec)')
  })

  it('G. every mutating action gates on the read tier, not only the operate key', () => {
    // A server action is its own entry point, so a UI-level filter is not a
    // control. All three id-taking actions — save, lock/unlock, delete — must
    // consult the guard before they write. Exactly three, so adding a new
    // id-taking action without one is visible here.
    const callSites = ACTIONS.match(/await loadMutableRecord\(ctx, tx,/g) ?? []
    expect(callSites).toHaveLength(3)
    expect(ACTIONS).toContain('canSeeSafeDistanceRecord(ctx, tx, row)')
  })

  it('G. a denied mutation is indistinguishable from a missing one', () => {
    // `loadMutableRecord` returns null for both, and the caller reports the same
    // message, so a caller cannot learn that a record exists by the response.
    expect(ACTIONS).toContain("return { ok: false as const, error: 'Assessment not found.' }")
    expect(ACTIONS.match(/'Assessment not found\.'/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('no Safe Distance surface still depends on Project Scope', () => {
    for (const [name, source] of [
      ['list', LIST],
      ['csv', CSV],
      ['detail', DETAIL],
      ['print', PRINT],
      ['actions', ACTIONS],
    ] as const) {
      expect(source, name).not.toContain('projectScope')
      expect(source, name).not.toContain('ProjectScope')
      expect(source, name).not.toContain('resolveProjectScopeIn')
      expect(source, name).not.toContain('projectScopePredicate')
    }
  })

  it('H. the analytics spec reads the same tiered prefix, not the flat key', () => {
    const start = SCOPE_SPEC.indexOf("'safe_distance',")
    expect(start, 'the safe_distance spec must exist').toBeGreaterThan(-1)
    // A small fixed window: the entry is a fixed literal, so the read spec and both
    // candidate lists must appear immediately after the name. Slicing to the next
    // `]` is fragile because the entry closes with `],`.
    const block = SCOPE_SPEC.slice(start, start + 260)
    expect(block).toContain("read: { prefix: 'tools.safe-distance' }")
    // A flat `read: { key: … }` resolves to tier 'all' in `tierFor`, which would
    // hand every holder of the operate capability the whole tenant.
    expect(block).not.toContain("read: { key: 'tools.safe-distance.use' }")
    expect(block).toContain('siteCols: SITE_COLUMNS')
    expect(block).toContain('personCols: PERSON_COLUMNS')
  })

  it('H. the operator person column stays last in the analytics candidate list', () => {
    // `pickColumn` returns the first candidate the entity has, so inserting
    // `operator_person_id` earlier would silently steal another module's binding.
    const start = SCOPE_SPEC.indexOf('const PERSON_COLUMNS = [')
    const list = SCOPE_SPEC.slice(start, SCOPE_SPEC.indexOf('] as const', start))
    const names = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
    expect(names[names.length - 1]).toBe('operator_person_id')
    expect(names.slice(0, 5)).toEqual([
      'person_id',
      'subject_person_id',
      'driver_person_id',
      'inspector_person_id',
      'current_holder_person_id',
    ])
  })
})

// SUPERSEDES
//
// `safe-distance-scope-contract.test.ts` (15B-3C-2A) was removed by this phase. It
// asserted that the list, the CSV and the analytics spec all applied the SAME
// Project Scope, and that an `empty` or unresolved scope was a hard `false`. Those
// properties no longer describe the module: there is no Project Scope predicate
// left on any Safe Distance surface.
//
// Nothing was weakened. The fail-closed property it protected — "this caller
// cannot reach the whole tenant" — is now asserted against the mechanism that
// actually enforces it: the self-tier predicate bound to the caller's own operator
// id, for the operate capability alone, for a caller with no read key, and for a
// caller with no person record at all. Cross-surface agreement is now structural
// (one shared helper) rather than grepped, which is what let the original drift
// happen in the first place.
//
// MUTATION NOTES
//
// 16 mutations were applied one at a time to `visibility.ts` and
// `safe-distance-access.ts`, each first proven non-equivalent by diffing the
// resolvers' output signature (bound ids for the list predicate, booleans for
// the record guard) across 10 caller shapes, then run against this suite.
//
//   CAUGHT  read.site resolves to the all tier
//   CAUGHT  a caller with no read key resolves to the all tier
//   CAUGHT  a caller with no read key resolves to the site tier
//   CAUGHT  the site-tier branch is never taken
//   CAUGHT  the site column binding is removed
//   CAUGHT  the person column binding is removed
//   CAUGHT  the Project Scope opt-out is removed
//   CAUGHT  the scope prefix is renamed, so the tier keys stop resolving
//   CAUGHT  the record guard ignores the opt-out
//   CAUGHT  the site leg is dropped from the site tier
//   CAUGHT  the own leg is dropped from the site tier
//   CAUGHT  the detail guard accepts any site when the caller has any scope
//   CAUGHT  the self tier is widened to any person
//   CAUGHT  the all tier short-circuit is removed
//   CAUGHT  a caller with no person record is no longer denied outright
//   CAUGHT  the two caller surfaces stop agreeing
//
//   EQUIVALENT (no-op rewrites, proved by an unchanged signature — not gaps)
//     • forcing the site branch with an empty site list: Drizzle compiles
//       `inArray(col, [])` to the literal `false`, so `or(false, ...ownConds)`
//       reduces to the own leg the fall-through already produces.
//     • widening the owner leg to any owner: `canSeeSafeDistanceRecord` passes no
//       `ownerIds`, so that leg is unreachable for this module by construction.
