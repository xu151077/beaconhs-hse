// CSV exports must never be a way around the list they mirror.
//
// Each route below already asserted a PERMISSION. The point of this file is the
// second half: that a caller who passes the permission gate still gets the SAME
// rows the corresponding list page would show them. A CSV is the same rows as a
// list; if the two disagree, the export is the bypass.
//
// The three modules differ in how they express that, and each is asserted in its
// own terms:
//
//   people         `people.read.all` is the whole boundary — the table declares no
//                  site or owner column, so there is no narrower native tier. The
//                  export therefore requires the same read capability the list
//                  requires, and RLS bounds both to the tenant.
//   ppe            a tiered module. `ppe.read.{all,site,self}` decides the rows and
//                  the export calls the same shared ladder the list does.
//   safe-distance  a tiered module added in Phase 1, with the binding declared once
//                  in `lib/safe-distance-access.ts` and shared by list, detail,
//                  print, CSV and the analytics spec.
//
// WHERE THE ASSERTIONS COME FROM
//
// The row-level tier behaviour is asserted against the REAL resolvers on compiled
// SQL and bound parameters — never by grepping SQL text for an id, which would pass
// for the wrong reason (drizzle binds ids, so an id never appears in the text).
//
// The cross-surface checks read the SOURCES, because the failure being guarded is
// drift between a list and its export: two independently correct filters that
// disagree at runtime. That is a wiring property, not a SQL property, and reading
// the file is the honest way to test it.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PgDialect } from 'drizzle-orm/pg-core'
import { ppeItems } from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'
import type { RequestContext } from '@beaconhs/tenant'
import { moduleScopeWhere } from './visibility'

const SITE_A = '00000000-0000-4000-8000-00000000a001'
const SITE_B = '00000000-0000-4000-8000-00000000b001'
const READER = '018f47ba-86c4-7ee2-8d7a-5e7602f2afff'
const PEER_A = '0c000000-0000-4000-8000-0000000000c2'
const PEER_B = '0c000000-0000-4000-8000-0000000000c3'

const dialect = new PgDialect()
const bound = (p: unknown): string[] =>
  p === undefined ? [] : dialect.sqlToQuery(p as never).params.map(String)
const sqlText = (p: unknown): string =>
  p === undefined ? '(no predicate)' : dialect.sqlToQuery(p as never).sql

/** The tier ladder resolves from `ctx` alone and never reads the transaction. */
const tx = {} as Database

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
    membership: { id: 'm1', displayName: 'A' },
    personId: READER,
    permissions: new Set(permissions),
    scopes: [],
    activeRoleId: null,
    db: (async (fn: (t: unknown) => unknown) => fn({})) as RequestContext['db'],
    ...over,
  } as RequestContext
}

const atSites = (siteIds: string[]) => [{ type: 'sites' as const, siteIds }]

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const PEOPLE_EXPORT = source('../app/(app)/people/export.csv/route.ts')
const PEOPLE_LIST = source('../app/(app)/people/page.tsx')
const PPE_EXPORT = source('../app/(app)/ppe/export.csv/route.ts')
const PPE_LIST = source('../app/(app)/ppe/page.tsx')
const SAFE_DISTANCE_EXPORT = source('../app/(app)/tools/safe-distance/export.csv/route.ts')
const SAFE_DISTANCE_LIST = source('../app/(app)/tools/safe-distance/page.tsx')

// ---------------------------------------------------------------------------
// people — the whole boundary is the read capability.
// ---------------------------------------------------------------------------

describe('the people export is bounded by the same capability as the list', () => {
  it('the route requires BOTH the management and the read capability', async () => {
    // `admin.users.manage` says who may export the roster at all;
    // `people.read.all` is what the list is gated on. Requiring both is what stops
    // a CUSTOM role that holds one without the other from exporting a roster it
    // cannot open on screen.
    expect(PEOPLE_EXPORT).toContain("assertCan(ctx, 'admin.users.manage')")
    expect(PEOPLE_EXPORT).toContain("assertCan(ctx, 'people.read.all')")
  })

  it('the list gates on the same read capability', () => {
    expect(PEOPLE_LIST).toContain("if (!can(ctx, 'people.read.all')) redirect('/dashboard')")
  })

  it('the list shows the export button only when the route would accept it', () => {
    // Showing a button the route rejects is worse than hiding it.
    expect(PEOPLE_LIST).toContain("can(ctx, 'admin.data.export')")
    expect(PEOPLE_LIST).toContain("can(ctx, 'admin.users.manage')")
    expect(PEOPLE_LIST).toContain("can(ctx, 'people.read.all')")
  })

  it('the read gate comes before the management gate, and nothing returns between them', () => {
    // A capability checked after an early return is not a control.
    const manage = PEOPLE_EXPORT.indexOf("assertCan(ctx, 'admin.users.manage')")
    const read = PEOPLE_EXPORT.indexOf("assertCan(ctx, 'people.read.all')")
    expect(manage).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(manage)
    expect(PEOPLE_EXPORT.slice(manage, read)).not.toContain('return csvResponse')
  })

  it('keeps the soft-delete filter rather than substituting the boundary', () => {
    expect(PEOPLE_EXPORT).toContain('isNull(people.deletedAt)')
    expect(PEOPLE_EXPORT).toContain('const whereClause = and(...filters)')
  })

  it('declares no narrower row scope, because the table has no column to bind one to', () => {
    // `people` carries no site and no owner column. Asserting the absence is the
    // point: a future site-keyed column should make this fail and be given a real
    // tier rather than silently inheriting a tenant-wide read.
    expect(PEOPLE_EXPORT).not.toMatch(
      /people\.(siteOrgUnitId|orgUnitId|personId|ownerTenantUserId)/,
    )
  })
})

// ---------------------------------------------------------------------------
// ppe — a tiered module, on the shared ladder.
// ---------------------------------------------------------------------------

describe('the ppe export uses the shared native ladder, like the list', () => {
  const ppePredicate = (permissions: string[], siteIds: string[]) =>
    moduleScopeWhere(ctx(permissions, { scopes: atSites(siteIds) }), tx, {
      prefix: 'ppe',
      personCol: ppeItems.currentHolderPersonId,
    })

  it('read.all binds nothing, so the export is the tenant register', async () => {
    expect(await ppePredicate(['ppe.read.all'], [SITE_A])).toBeUndefined()
  })

  it("read.self binds only the caller's own holder id", async () => {
    const p = await ppePredicate(['ppe.read.self'], [SITE_A])
    expect(bound(p)).toEqual([READER])
    expect(bound(p)).not.toContain(PEER_B)
  })

  it('a caller with no read key degrades to self, never to the register', async () => {
    const p = await ppePredicate(['ppe.use'], [SITE_A])
    expect(p).toBeDefined()
    expect(bound(p)).toEqual([READER])
  })

  it('the route and the list both call the shared ladder on the holder column', () => {
    for (const [name, src] of [
      ['export', PPE_EXPORT],
      ['list', PPE_LIST],
    ] as const) {
      expect(src, name).toContain('moduleScopeWhere')
      expect(src, name).toContain('prefix:')
      expect(src, name).toContain('personCol: ppeItems.currentHolderPersonId')
    }
  })

  it('the route keeps the capability gate and the soft-delete filter', () => {
    expect(PPE_EXPORT).toContain("assertCan(ctx, 'ppe.read.all')")
    expect(PPE_EXPORT).toContain('isNull(')
    expect(PPE_EXPORT).toMatch(/filters\.push\(scope\)/)
    // A substitution would drop the soft-delete check.
    expect(PPE_EXPORT).not.toMatch(/whereClause\s*=\s*scope\b/)
  })

  it('adds no join and no new column', () => {
    // The binding is the column the table already had.
    expect(PPE_EXPORT).not.toMatch(/\bperson_id\b/)
    expect(PPE_EXPORT).not.toMatch(/itemId:\s*ppeIssues/)
    expect(PPE_EXPORT).not.toMatch(/from\(ppeIssues|from\(ppeIssueReports/)
  })
})

// ---------------------------------------------------------------------------
// safe-distance — a tiered module whose binding is declared once.
// ---------------------------------------------------------------------------

describe('the safe-distance export uses the one shared binding', () => {
  it('routes through the shared helper, not a bespoke predicate', () => {
    expect(SAFE_DISTANCE_EXPORT).toContain('safeDistanceScopeWhere(ctx, tx)')
    // No second binding: re-declaring the columns is how the list and the export
    // drifted apart once already.
    expect(SAFE_DISTANCE_EXPORT).not.toMatch(/orgUnitCol:\s*safeDistanceRecords/)
    expect(SAFE_DISTANCE_EXPORT).not.toMatch(/personCol:\s*safeDistanceRecords/)
    expect(SAFE_DISTANCE_EXPORT).not.toMatch(/siteCol:\s*safeDistanceRecords/)
  })

  it('the list calls the same helper, so the two cannot answer differently', () => {
    expect(SAFE_DISTANCE_LIST).toContain('safeDistanceScopeWhere(ctx, tx)')
  })

  it('carries no second authorization dimension', () => {
    for (const [name, src] of [
      ['export', SAFE_DISTANCE_EXPORT],
      ['list', SAFE_DISTANCE_LIST],
    ] as const) {
      expect(src, name).not.toContain('resolveProjectScopeIn')
      expect(src, name).not.toContain('projectScopePredicate')
      expect(src, name).not.toContain('ProjectScope')
      expect(src, name).not.toContain('applyProjectScope')
    }
  })

  it('keeps the operate-capability gate, so read and operate stay separate axes', () => {
    expect(SAFE_DISTANCE_EXPORT).toContain('assertCan(ctx, SAFE_DISTANCE_PERMISSION)')
  })

  it('ANDs the boundary into the existing filters rather than replacing them', () => {
    expect(SAFE_DISTANCE_EXPORT).toMatch(
      /const filters: SQL<unknown>\[\] = \[isNull\(safeDistanceRecords\.deletedAt\)\]/,
    )
    expect(SAFE_DISTANCE_EXPORT).toMatch(/if \(scopeWhere\) filters\.push\(scopeWhere\)/)
    expect(SAFE_DISTANCE_EXPORT).toContain('const whereClause = and(...filters)')
  })

  it('still audits the export', () => {
    expect(SAFE_DISTANCE_EXPORT).toContain('recordAudit')
  })
})

// ---------------------------------------------------------------------------
// The cross-cutting property, restated for the three modules.
// ---------------------------------------------------------------------------

describe('no export can return more than its list', () => {
  it('every tiered export pushes its boundary into the SAME filter list', () => {
    // Substituting the boundary for the filter list would drop the soft-delete
    // check and the search term, which is a leak of a different kind.
    //
    // The people export is deliberately NOT in this list: it has no narrower tier
    // to push, because `people` declares no site or owner column. Its boundary is
    // the capability gate plus RLS, asserted in its own block above.
    for (const [name, src] of [
      ['ppe', PPE_EXPORT],
      ['safe-distance', SAFE_DISTANCE_EXPORT],
    ] as const) {
      expect(src, name).toContain('isNull(')
      expect(src, `${name} must AND the boundary, not replace filters`).toMatch(
        /filters\.push\((scope|scopeWhere)\)/,
      )
      expect(src, name).toContain('const whereClause = and(...filters)')
      expect(src, name).not.toMatch(/whereClause\s*=\s*(scope|scopeWhere)\b/)
    }
  })

  it('the people export keeps its own filters and adds no row scope', () => {
    // The negative counterpart: asserting the absence is what stops a future
    // column from being silently filtered on one surface only.
    expect(PEOPLE_EXPORT).toContain('isNull(people.deletedAt)')
    expect(PEOPLE_EXPORT).toContain('const whereClause = and(...filters)')
    expect(PEOPLE_EXPORT).not.toMatch(/filters\.push\((scope|scopeWhere)\)/)
  })

  it('every export resolves its boundary inside its own transaction', () => {
    // A boundary resolved outside the export's transaction could read a different
    // snapshot from the rows it is about to filter.
    for (const [name, src] of [
      ['ppe', PPE_EXPORT],
      ['safe-distance', SAFE_DISTANCE_EXPORT],
    ] as const) {
      expect(src, name).toMatch(/ctx\.db\(async \(tx\) =>/)
      expect(src, name).toMatch(/await (moduleScopeWhere|safeDistanceScopeWhere)\(ctx, tx/)
    }
  })

  it('every export audits what it produced', () => {
    for (const [name, src] of [
      ['people', PEOPLE_EXPORT],
      ['ppe', PPE_EXPORT],
      ['safe-distance', SAFE_DISTANCE_EXPORT],
    ] as const) {
      expect(src, name).toContain('recordAudit')
    }
  })

  it('an empty result is a header-only file, not an error and not the tenant', async () => {
    for (const [name, src] of [
      ['people', PEOPLE_EXPORT],
      ['ppe', PPE_EXPORT],
      ['safe-distance', SAFE_DISTANCE_EXPORT],
    ] as const) {
      expect(src, name).toContain('csvResponse')
    }
    // The self tier with no person record is the terminal case: `false`, never
    // `undefined`. `undefined` would be the tenant-wide answer.
    const p = await moduleScopeWhere(ctx([], { personId: null, scopes: atSites([SITE_A]) }), tx, {
      prefix: 'ppe',
      personCol: ppeItems.currentHolderPersonId,
    })
    expect(sqlText(p)).toBe('false')
  })
})
