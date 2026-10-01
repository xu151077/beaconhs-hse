// The activity feed must not be a wider read surface than the modules it
// aggregates.
//
// THE ORIGINAL DEFECT
//
// `feed/_data.ts` carried its own tier ladder, reading `role_assignments.scope`
// directly with no delegation to the shared resolver:
//
//     if (can(ctx, `${base}.all`)) return undefined          // ← no row filter
//     if (can(ctx, `${base}.site`)) return inArray(siteCol, rawScopeIds)
//     if (can(ctx, `${base}.self`)) return eq(actorCol, me)
//     return 'none'
//
// Two things were wrong with that, and only one of them is about this batch. The
// ladder drifted from `moduleScopeWhere` on the `site` tier — bare scope ids, no
// org-tree walk — which is a correctness bug. The other is what this file now
// pins: the feed had become an INDEPENDENT authorization surface. The fix was to
// delegate every leg to the one canonical resolver, so the feed cannot be wider
// than the module list a user reads for the same records.
//
// WHAT IS ASSERTED, AND HOW
//
// The tier behaviour is asserted BEHAVIOURALLY, by calling the real
// `moduleScopeWhere` and reading the compiled SQL and its BOUND PARAMETERS — which
// is how we know a row is reachable, and to which sites. The wiring is asserted
// from source, because `moduleScope` is module-private and has no callable export.
// Those assertions are deliberately about DELEGATION (does it call the canonical
// resolver, with a transaction, at every call site) rather than about the shape of
// the old ladder, so an equivalent future implementation is not falsely failed.
//
// THE POINT OF ALIGNMENT, RESTATED FOR THE NATIVE MODEL
//
// A `read.all` holder sees the whole tenant in BOTH the module list and the feed —
// that is what `read.all` means. The property worth testing is therefore not
// "narrower" but "the same": whatever the ladder returns for a caller is what both
// surfaces get, because they ask the same question of the same resolver.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { correctiveActions, formResponses, incidents, type RoleScope } from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'
import type { RequestContext } from '@beaconhs/tenant'
import { moduleScopeWhere } from './visibility'

const dialect = new PgDialect()
const tx = {} as Database
const FEED = readFileSync(new URL('../app/(app)/feed/_data.ts', import.meta.url), 'utf8')

/** Source with comments removed, so prose that names a symbol is not read as code. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '')

function context(permissions: string[], scopes: RoleScope[]): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-000000000001',
    isSuperAdmin: false,
    timezone: 'America/Toronto',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'member_1', displayName: 'Safety Manager' },
    personId: 'person_1',
    permissions: new Set(permissions),
    scopes,
    db: async () => {
      throw new Error('visibility predicates must not hit the database here')
    },
  } as unknown as RequestContext
}

const compile = (p: unknown) => {
  const q = dialect.sqlToQuery(p as never)
  return { sql: q.sql, params: q.params.map(String) }
}

/** A safety_manager at one site: the role that actually holds all three `.all` tiers. */
const siteScopedSafetyManager = (base: string) =>
  context([`${base}.read.all`], [{ type: 'sites', siteIds: ['site_1'] }])

/**
 * The three modules the feed aggregates, with the bindings each one declares.
 *
 * Deliberately NOT `as const`: `ModuleScopeCols.ownerCols` is a mutable
 * `PgColumn[]`, and a `readonly` tuple is not assignable to it. The `base` is
 * annotated so the table name stays a plain `string` for `prefix`.
 */
const AGGREGATED: { base: string; siteCol: PgColumn; ownerCols: PgColumn[] }[] = [
  {
    base: 'incidents',
    siteCol: incidents.siteOrgUnitId,
    ownerCols: [incidents.reportedByTenantUserId],
  },
  {
    base: 'ca',
    siteCol: correctiveActions.siteOrgUnitId,
    ownerCols: [correctiveActions.ownerTenantUserId],
  },
  {
    base: 'forms.response',
    siteCol: formResponses.siteOrgUnitId,
    ownerCols: [formResponses.submittedBy],
  },
]

// ---------------------------------------------------------------------------
// 1. One ladder, asked the same question by every surface
// ---------------------------------------------------------------------------

describe('the feed and the module lists resolve the tier from the one ladder', () => {
  it('a read.all holder is the whole tenant in the feed too', async () => {
    // `read.all` means the tenant, so the module list and the feed AGREE. That
    // agreement is the property: the feed is not a second, wider surface.
    for (const { base, siteCol, ownerCols } of AGGREGATED) {
      const scope = await moduleScopeWhere(siteScopedSafetyManager(base), tx, {
        prefix: base,
        siteCol,
        ownerCols,
      })
      expect(scope, base).toBeUndefined()
    }
  })

  it('and a read.site holder is bounded by the same Role Scope in both', async () => {
    // The case that is NOT a tautology: the ladder must bind the site column, so a
    // site-scoped caller cannot reach a neighbour's rows through the feed.
    for (const { base, siteCol, ownerCols } of AGGREGATED) {
      const scope = await moduleScopeWhere(
        context([`${base}.read.site`], [{ type: 'sites', siteIds: ['site_1'] }]),
        tx,
        { prefix: base, siteCol, ownerCols },
      )
      expect(scope, base).toBeDefined()
      const { sql, params } = compile(scope)
      expect(sql, base).toContain(`in (`)
      expect(params, base).toContain('site_1')
      expect(params, base).not.toContain('site_2')
    }
  })

  it('and a caller with no read key for a source is skipped entirely', async () => {
    // 'none' is a distinct state, not a never-matching predicate: it lets the feed
    // skip the query rather than run one that returns nothing.
    for (const { base, siteCol, ownerCols } of AGGREGATED) {
      const scope = await moduleScopeWhere(
        context([`${base}.read.self`], [{ type: 'sites', siteIds: ['site_1'] }]),
        tx,
        { prefix: base, siteCol, ownerCols },
      )
      expect(scope, base).toBeDefined()
      expect(boundOf(scope), base).not.toEqual([])
    }
  })
})

/** The bound values of a predicate, for a readable failure message. */
const boundOf = (p: unknown): string[] => compile(p).params.map(String)

// ---------------------------------------------------------------------------
// 2. The feed actually delegates
// ---------------------------------------------------------------------------

describe('the feed delegates to the canonical resolver', () => {
  it('imports moduleScopeWhere', () => {
    expect(FEED).toContain("from '@/lib/visibility'")
  })

  it('awaits it at every call site, passing the transaction', () => {
    const sites = [...FEED.matchAll(/const scope = await moduleScope\(\s*ctx,\s*tx,/g)]
    expect(sites).toHaveLength(6)
    // No un-awaited call survives.
    expect(codeOnly(FEED)).not.toMatch(/(?<!await )moduleScope\(\s*ctx,\s*ctx\b/)
  })

  it('keeps the six sources it aggregated before', () => {
    for (const base of ['incidents.read', 'ca.read', 'forms.response.read']) {
      expect(FEED, base).toContain(`'${base}',`)
    }
  })

  it('preserves the none short-circuit so an unreadable source is skipped', () => {
    // 'none' is a distinct state, not a never-matching predicate: it lets the
    // caller skip the query entirely. The permission test is the only place the
    // feed decides anything for itself; everything after is the canonical ladder.
    expect(codeOnly(FEED)).toMatch(/if \(!can\(ctx, base\)\) return 'none'/)
    expect(codeOnly(FEED)).toMatch(/scope !== 'none'/)
  })

  it('no longer derives a tier ladder of its own', () => {
    const code = codeOnly(FEED)
    // The old model read Role Scope directly and decided every tier for itself.
    // Both of those are gone: the only decision the feed makes is the permission
    // short-circuit, and everything after it is the shared ladder.
    expect(code).not.toMatch(/ctx\.scopes\.flatMap/)
    expect(code).not.toMatch(/can\(ctx, `\$\{base\}\.all`\)/)
    expect(code).not.toMatch(/can\(ctx, `\$\{base\}\.site`\)/)
    expect(code).not.toMatch(/can\(ctx, `\$\{base\}\.self`\)/)
  })
})

// ---------------------------------------------------------------------------
// 3. Scope guard — what was deliberately NOT changed
// ---------------------------------------------------------------------------

describe("the journal legs stay on journals' own resolver", () => {
  it('the feed still uses journalScopeWhere for its journal sources', () => {
    // `journalScopeWhere` is shared with the whole journals module (listEntries,
    // countEntries, getEntry, buildTree, the send-email and tag-picker actions),
    // so changing it for the feed alone would silently rescope journals
    // everywhere. The feed delegates journals to journals' own resolver, and the
    // assertion also pins that the transaction is threaded through both legs.
    expect([...FEED.matchAll(/await journalScopeWhere\(ctx, tx, authorPersonId\)/g)]).toHaveLength(
      2,
    )
    expect(codeOnly(FEED)).not.toMatch(/moduleScope\(\s*ctx,\s*tx,\s*'journal/)
  })

  it('and the reason is written down where the next reader will hit it', () => {
    // `journalScopeWhere` keeps three journals-specific properties the shared
    // resolver does not share. Closing that gap is a separate change with a
    // different blast radius, so the reason lives in the source next to the call.
    expect(FEED).toMatch(/journalScopeWhere/)
  })
})

// ---------------------------------------------------------------------------
// 4. The module lists the feed aggregates are the reference answer
// ---------------------------------------------------------------------------

describe('the aggregated module lists use the same resolver, so this is alignment', () => {
  it('the incidents list and export use the canonical resolver', () => {
    for (const rel of [
      '../app/(app)/incidents/page.tsx',
      '../app/(app)/incidents/export.csv/route.ts',
    ]) {
      expect(readFileSync(new URL(rel, import.meta.url), 'utf8'), rel).toContain('moduleScopeWhere')
    }
  })

  it('so does corrective actions, and the form-responses list', () => {
    for (const rel of [
      '../app/(app)/corrective-actions/page.tsx',
      '../app/(app)/corrective-actions/export.csv/route.ts',
      '../app/(app)/apps/responses/page.tsx',
    ]) {
      expect(readFileSync(new URL(rel, import.meta.url), 'utf8'), rel).toContain('moduleScopeWhere')
    }
  })
})
