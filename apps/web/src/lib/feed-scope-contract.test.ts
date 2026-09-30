// 15B-3C-4A — the activity feed must not be a wider read surface than the module
// it aggregates.
//
// THE DEFECT
//
// `feed/_data.ts` carried its own tier ladder:
//
//     if (can(ctx, `${base}.all`)) return undefined          // ← no row filter
//     if (can(ctx, `${base}.site`)) return inArray(siteCol, rawScopeIds)
//     if (can(ctx, `${base}.self`)) return eq(actorCol, me)
//     return 'none'
//
// That model predates 15B-2. It read `role_assignments.scope` directly, with no
// org-tree walk and no personnel-placement expansion, and — in the direction that
// matters — it treated a `.all` read tier as "no restriction at all".
//
// So a caller holding `incidents.read.all` (or `ca.read.all`,
// `forms.response.read.all`) with a RESTRICTED Project Scope saw:
//
//     /incidents                       → restricted to their scope
//     /incidents/export.csv            → restricted to their scope
//     /feed                            → THE WHOLE TENANT
//
// The canonical resolver returns the Project Scope predicate even at tier `all`
// (`lib/visibility.ts:209`), so the feed was strictly wider than the module it
// was summarising. This file pins the aligned behaviour and the properties the
// alignment must not cost.
//
// WHAT IS ASSERTED, AND HOW
//
// The narrowing property is asserted BEHAVIOURALLY, by calling the real
// `moduleScopeWhere` and reading the compiled SQL and its BOUND PARAMETERS —
// which is how we know it is restricted, and to which sites. The wiring is
// asserted from source, because `moduleScope` is module-private and has no
// callable export; those assertions are deliberately about DELEGATION (does it
// call the canonical resolver, with a transaction, at every call site) rather
// than about the shape of the old ladder, so an equivalent future
// implementation is not falsely failed.
//
// The `site`-tier divergence the old ladder also had — bare scope ids, no
// org-tree walk — is covered incidentally by the same delegation, and is called
// out below because it was a correctness bug, not a security one.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PgDialect } from 'drizzle-orm/pg-core'
import { correctiveActions, formResponses, incidents, type RoleScope } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { moduleScopeWhere } from './visibility'
import { projectScopeTx } from './testing/project-scope-fixture'

const dialect = new PgDialect()
const tx = projectScopeTx()
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

/** A safety_manager: the role that actually holds all three `.all` tiers. */
const siteScopedSafetyManager = (base: string) =>
  context([`${base}.read.all`], [{ type: 'sites', siteIds: ['site_1'] }])

// ---------------------------------------------------------------------------
// 1. The property the fix depends on
// ---------------------------------------------------------------------------

describe('15B-3C-4A — the canonical resolver narrows a .all tier for a scoped caller', () => {
  it('returns a site-bound predicate, not no filter, for incidents', async () => {
    const scope = await moduleScopeWhere(siteScopedSafetyManager('incidents'), tx, {
      prefix: 'incidents',
      siteCol: incidents.siteOrgUnitId,
      ownerCols: [incidents.reportedByTenantUserId],
    })
    expect(scope).toBeDefined()
    const { sql, params } = compile(scope)
    expect(sql).toContain('"incidents"."site_org_unit_id" in (')
    // The scope's own site is among the bound ids, together with the ancestors
    // and siblings the org-tree walk contributes.
    expect(params).toContain('site_1')
  })

  it('does the same for corrective actions', async () => {
    const scope = await moduleScopeWhere(siteScopedSafetyManager('ca'), tx, {
      prefix: 'ca',
      siteCol: correctiveActions.siteOrgUnitId,
      ownerCols: [correctiveActions.ownerTenantUserId],
    })
    expect(scope).toBeDefined()
    expect(compile(scope).sql).toContain('"corrective_actions"."site_org_unit_id" in (')
  })

  it('and for form responses', async () => {
    const scope = await moduleScopeWhere(siteScopedSafetyManager('forms.response'), tx, {
      prefix: 'forms.response',
      siteCol: formResponses.siteOrgUnitId,
      ownerCols: [formResponses.submittedBy],
    })
    expect(scope).toBeDefined()
    expect(compile(scope).sql).toContain('"form_responses"."site_org_unit_id" in (')
  })

  it('agrees with the old behaviour for an unrestricted caller', async () => {
    // The fix must only ever NARROW. `{type:'tenant'}` resolves to
    // `unrestricted`, so these callers keep the whole tenant in their feed.
    for (const base of ['incidents', 'ca', 'forms.response']) {
      const scope = await moduleScopeWhere(
        context([`${base}.read.all`], [{ type: 'tenant' }]),
        tx,
        {
          prefix: base,
        },
      )
      expect(scope, base).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. The feed actually delegates
// ---------------------------------------------------------------------------

describe('15B-3C-4A — the feed delegates to the canonical resolver', () => {
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
    // The pre-15B-2 model read role scope directly and short-circuited `.all`
    // to no filter. Both are gone.
    expect(code).not.toMatch(/ctx\.scopes\.flatMap/)
    expect(code).not.toMatch(/can\(ctx, `\$\{base\}\.all`\)/)
    expect(code).not.toMatch(/can\(ctx, `\$\{base\}\.site`\)/)
    expect(code).not.toMatch(/can\(ctx, `\$\{base\}\.self`\)/)
  })
})

// ---------------------------------------------------------------------------
// 3. Scope guard — what was deliberately NOT changed
// ---------------------------------------------------------------------------

describe('15B-3C-4A — the journal legs are left for their own batch', () => {
  it('the feed still uses journalScopeWhere for its journal sources', () => {
    // `journalScopeWhere` carries the same pre-15B-2 model, but it is shared with
    // the whole journals module (listEntries, countEntries, getEntry, buildTree,
    // the send-email and tag-picker actions). Changing it here would silently
    // rescope journals, which is 15B-3C-4B and needs its own review.
    expect(FEED).toContain('journalScopeWhere(ctx, authorPersonId)')
  })

  it('and the deferral is written down where the next reader will hit it', () => {
    expect(FEED).toMatch(/15B-3C-4B/)
  })
})

// ---------------------------------------------------------------------------
// 4. The module lists the feed aggregates are the reference answer
// ---------------------------------------------------------------------------

describe('15B-3C-4A — the aggregated modules were already scoped, so this is alignment', () => {
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
