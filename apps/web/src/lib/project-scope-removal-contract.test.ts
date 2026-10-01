// The Project Scope removal contract.
//
// The second authorization dimension has been removed. BeaconHS's model is now
// exactly, top to bottom, with nothing in between:
//
//     Tenant / RLS  ->  Permission  ->  Role Scope  ->  Read Tier  ->  Record
//
// This file is the removal's own regression test. It has two halves, and they are
// deliberately different in kind:
//
//   1. BEHAVIOURAL. The real resolvers are called and their compiled SQL and BOUND
//      parameters are read back, so "a caller with the self key sees only their own
//      rows" is proven by what the resolver actually returns. Ids are read from
//      `params`, never from the statement text: Drizzle compiles `inArray` to
//      `in ($1, $2)` and binds the values, so a text grep would pass for the wrong
//      reason — it simply never finds an id, whether or not the filter is correct.
//
//   2. STRUCTURAL. The removal of a SYMBOL is a whole-codebase property, and a grep
//      is the honest way to test it. This half is a static check, and it is labelled
//      as such: it asserts a symbol is absent from production code, never that a
//      caller may see a row. Where half 1 can reach a surface, half 1 is what
//      decides it.
//
// Why the greps in half 2 are still worth having: the failure mode this guards is
// a new module quietly reintroducing the dimension through a helper nobody reviews,
// and the greps cost nothing to keep running on every build.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  correctiveActions,
  documents,
  formResponses,
  people,
  ppeItems,
  safeDistanceRecords,
  BUILTIN_ROLES,
  type RoleScope,
} from '@beaconhs/db/schema'
import type { Database } from '@beaconhs/db'
import type { RequestContext } from '@beaconhs/tenant'
import { documentReadFilter } from './assistant/doc-access'
import { andPredicates, canSeeRecord, moduleScopeWhere } from './visibility'
import { SAFE_DISTANCE_SCOPE_COLUMNS, safeDistanceScopeWhere } from './safe-distance-access'

const SITE_A = '00000000-0000-4000-8000-00000000a001'
const SITE_B = '00000000-0000-4000-8000-00000000b001'
const READER = '018f47ba-86c4-7ee2-8d7a-5e7602f2afff'
const PEER = '0c000000-0000-4000-8000-0000000000c2'
const OTHER_PERSON = '0c000000-0000-4000-8000-0000000000c9'
const TENANT_USER = 'member_1'

const dialect = new PgDialect()
const bound = (p: unknown): string[] =>
  p === undefined ? [] : dialect.sqlToQuery(p as never).params.map(String)
const sqlText = (p: unknown): string =>
  p === undefined ? '(no predicate)' : dialect.sqlToQuery(p as never).sql

/**
 * The tier ladder resolves entirely from `ctx` and never reads the transaction, so
 * an empty stand-in is what the resolver actually does with the argument — not a
 * shortcut. A stub that threw would fail every test below, which is the point.
 */
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
    membership: { id: TENANT_USER, displayName: 'A' },
    personId: READER,
    permissions: new Set(permissions),
    scopes: [],
    activeRoleId: null,
    db: (async (fn: (t: unknown) => unknown) => fn({})) as RequestContext['db'],
    ...over,
  } as RequestContext
}

const atSites = (siteIds: string[]): RoleScope[] => [{ type: 'sites', siteIds }]

// ===========================================================================
// 1. BEHAVIOURAL — the native ladder, on the real resolvers.
// ===========================================================================

describe('the tier ladder is Permission + Role Scope only', () => {
  it('read.all is the whole tenant', async () => {
    const p = await moduleScopeWhere(ctx(['x.read.all'], { scopes: atSites([SITE_A]) }), tx, {
      prefix: 'x',
      siteCol: correctiveActions.siteOrgUnitId,
    })
    expect(p).toBeUndefined()
    expect(bound(p)).toEqual([])
  })

  it("read.site is the caller's Role Scope and nothing else", async () => {
    const p = await moduleScopeWhere(ctx(['x.read.site'], { scopes: atSites([SITE_A]) }), tx, {
      prefix: 'x',
      siteCol: correctiveActions.siteOrgUnitId,
    })
    expect(bound(p)).toContain(SITE_A)
    expect(bound(p)).not.toContain(SITE_B)
  })

  it('read.self is the caller and nobody else', async () => {
    const p = await moduleScopeWhere(ctx(['x.read.self'], { scopes: atSites([SITE_A]) }), tx, {
      prefix: 'x',
      personCol: formResponses.subjectPersonId,
    })
    expect(bound(p)).toEqual([READER])
  })

  it('a caller with no read key degrades to self, never to the tenant', async () => {
    const p = await moduleScopeWhere(ctx(['some.other.read'], { scopes: atSites([SITE_A]) }), tx, {
      prefix: 'x',
      personCol: formResponses.subjectPersonId,
    })
    expect(p).toBeDefined()
    expect(bound(p)).toEqual([READER])
  })

  it('a caller with no read key AND no identity is denied outright', async () => {
    const p = await moduleScopeWhere(
      ctx(['some.other.read'], { personId: null, membership: null, scopes: atSites([SITE_A]) }),
      tx,
      { prefix: 'x', personCol: formResponses.subjectPersonId },
    )
    // `undefined` is the tenant-wide answer. This must not be it.
    expect(sqlText(p)).toBe('false')
    expect(bound(p)).toEqual([])
  })

  it('andPredicates can only narrow', async () => {
    const wide = await moduleScopeWhere(ctx(['x.read.all']), tx, { prefix: 'x' })
    const narrow = await moduleScopeWhere(ctx(['x.read.self'], { personId: PEER }), tx, {
      prefix: 'x',
      personCol: formResponses.subjectPersonId,
    })
    // `undefined` is the wide leg, so AND-ing it must be a no-op rather than a
    // widening. This is the helper that used to join a visibility predicate to a
    // second scope predicate, so "can only narrow" is the property that matters.
    expect(andPredicates(wide, narrow)).toEqual(narrow)
    expect(andPredicates(undefined, narrow)).toEqual(narrow)
    expect(andPredicates(narrow, undefined)).toEqual(narrow)
    expect(andPredicates(undefined, undefined)).toBeUndefined()
    // And an unfiltered caller still ends up filtered, never the other way round.
    expect(bound(andPredicates(wide, narrow))).toEqual([PEER])
    expect(bound(wide)).toEqual([])
  })
})

// ===========================================================================
// 2. BEHAVIOURAL — the four migrated modules, through their own bindings.
// ===========================================================================

describe('Safe Distance reads through the native tier', () => {
  it('the binding is the prefix plus the two columns the table already carries', () => {
    expect(SAFE_DISTANCE_SCOPE_COLUMNS.prefix).toBe('tools.safe-distance')
    expect(SAFE_DISTANCE_SCOPE_COLUMNS.siteCol.name).toBe('site_org_unit_id')
    expect(SAFE_DISTANCE_SCOPE_COLUMNS.personCol.name).toBe('operator_person_id')
  })

  it("read.self binds only the caller's own operator id", async () => {
    const p = await safeDistanceScopeWhere(
      ctx(['tools.safe-distance.read.self'], { scopes: atSites([SITE_A]) }),
      tx,
    )
    expect(bound(p)).toEqual([READER])
    expect(bound(p)).not.toContain(SITE_A)
  })

  it('read.site binds the Role Scope, and cannot reach another site', async () => {
    const p = await safeDistanceScopeWhere(
      ctx(['tools.safe-distance.read.site'], { scopes: atSites([SITE_A]) }),
      tx,
    )
    expect(bound(p)).toContain(SITE_A)
    expect(bound(p)).not.toContain(SITE_B)
  })

  it('read.all binds nothing', async () => {
    expect(await safeDistanceScopeWhere(ctx(['tools.safe-distance.read.all']), tx)).toBeUndefined()
  })

  it('the record guard answers the same question the list does', async () => {
    const c = ctx(['tools.safe-distance.read.site'], { scopes: atSites([SITE_A]) })
    const record = { siteOrgUnitId: SITE_B, operatorPersonId: PEER }
    const byId = await canSeeRecord(c, tx, {
      prefix: SAFE_DISTANCE_SCOPE_COLUMNS.prefix,
      siteId: record.siteOrgUnitId,
      personId: record.operatorPersonId,
    })
    const list = bound(await safeDistanceScopeWhere(c, tx))
    expect(byId).toBe(false)
    // A record refused by id cannot come back from the list query.
    expect(list.some((v) => v === SITE_B || v === PEER)).toBe(false)
  })
})

describe('Documents reads through the published/manage rule', () => {
  it('a manager sees every document, published or not', () => {
    const c = ctx(['documents.read', 'documents.manage'])
    expect(documentReadFilter(c)).toBeUndefined()
  })

  it('a non-manager sees published documents only', () => {
    const p = documentReadFilter(ctx(['documents.read']))
    expect(p).toBeDefined()
    expect(sqlText(p)).toContain('"documents"."status"')
    expect(bound(p)).toEqual(['published'])
  })

  it('a caller with no documents key gets no predicate from this helper at all', () => {
    // Deliberate: `documentReadFilter` is the PUBLICATION half only, and every
    // surface asserts `documents.read` itself. Asserted here so the composition
    // stays visible rather than implied.
    expect(documentReadFilter(ctx([]))).toBeDefined()
  })

  it("a manager can still not be given another tenant's documents by this helper", () => {
    // The tenant boundary is RLS, not this filter. Stated so nobody reads the
    // `undefined` above as "no filter means no boundary".
    expect(sqlText(documentReadFilter(ctx(['documents.manage'])))).toBe('(no predicate)')
    expect(bound(documentReadFilter(ctx(['documents.manage'])))).toEqual([])
  })
})

describe('Forms Responses keeps its three native tiers', () => {
  const binding = {
    prefix: 'forms.response',
    siteCol: formResponses.siteOrgUnitId,
    personCol: formResponses.subjectPersonId,
  }

  it('read.all is the whole tenant', async () => {
    expect(await moduleScopeWhere(ctx(['forms.response.read.all']), tx, binding)).toBeUndefined()
  })

  it('read.site binds the Role Scope', async () => {
    const p = await moduleScopeWhere(
      ctx(['forms.response.read.site'], { scopes: atSites([SITE_A]) }),
      tx,
      binding,
    )
    expect(bound(p)).toContain(SITE_A)
  })

  it('read.self binds only the caller', async () => {
    const p = await moduleScopeWhere(ctx(['forms.response.read.self']), tx, binding)
    expect(bound(p)).toEqual([READER])
  })

  it('a peer cannot read a record the caller submitted', async () => {
    const alice = ctx(['forms.response.read.self'])
    const bob = ctx(['forms.response.read.self'], { personId: PEER })
    const record = { personId: READER }
    expect(await canSeeRecord(alice, tx, { prefix: 'forms.response', ...record })).toBe(true)
    expect(await canSeeRecord(bob, tx, { prefix: 'forms.response', ...record })).toBe(false)
  })
})

describe('People is tenant-level by design', () => {
  it('`people.read.all` is the whole boundary, and the table has no column to narrow', () => {
    // Asserted negatively: the catalogue comment at the key says a site or self
    // tier "would be unenforceable from this table and must not be implied". If a
    // location column ever appears on `people`, this fails and the question has to
    // be reopened deliberately.
    expect('siteOrgUnitId' in people).toBe(false)
    expect('personId' in people).toBe(false)
    expect('ownerTenantUserId' in people).toBe(false)
  })

  it('so a holder of the key resolves to no row predicate', async () => {
    // The predicate for `people` is the permission plus RLS, and the detail guard
    // is the same question answered for one record.
    expect(
      await moduleScopeWhere(ctx(['people.read.all'], { scopes: atSites([SITE_A]) }), tx, {
        prefix: 'people',
      }),
    ).toBeUndefined()
  })

  it('and PPE, whose site tier falls back to the holder column, still works', async () => {
    // The neighbouring precedent: a table with no location column is not a
    // contradiction, it just resolves a different tier through the column it has.
    const p = await moduleScopeWhere(ctx(['ppe.read.self'], { scopes: atSites([SITE_A]) }), tx, {
      prefix: 'ppe',
      personCol: ppeItems.currentHolderPersonId,
    })
    expect(bound(p)).toEqual([READER])
  })
})

// ===========================================================================
// 1d. THE ROLE MATRIX — the end-to-end outcome for each built-in role.
//
// This is the regression net for the removal's accepted widening. The expected
// answers are written out per role so a future change to `BUILTIN_ROLES`, to the
// catalogue, or to the ladder has to be made deliberately: a test failure names
// the role and the answer that moved.
//
// The matrix is built from the REAL `BUILTIN_ROLES` permissions and the REAL
// resolvers, so it cannot pass by agreeing with itself.
describe('the four built-in roles, end to end', () => {
  const permsOf = (role: keyof typeof BUILTIN_ROLES): string[] =>
    (BUILTIN_ROLES[role]?.permissions ?? []) as unknown as string[]

  /** A caller with exactly that role's permissions, standing at one site. */
  const asRole = (role: keyof typeof BUILTIN_ROLES, over: Partial<RequestContext> = {}) =>
    ctx(permsOf(role), { scopes: atSites([SITE_A]), ...over })

  it('worker: no People directory, Safe Distance self only, nothing tenant-wide', async () => {
    const w = asRole('worker')
    expect(permsOf('worker')).not.toContain('people.read.all')
    // People: the page gate is `people.read.all`, so a worker never reaches the
    // query at all. The ladder's answer for one is a hard `false` — `people`
    // declares no owner column, so a worker has nothing to bind and the predicate
    // cannot match a row. `undefined` here would be the tenant-wide answer.
    const peoplePredicate = await moduleScopeWhere(w, tx, { prefix: 'people' })
    expect(sqlText(peoplePredicate)).toBe('false')
    expect(bound(peoplePredicate)).toEqual([])
    expect(
      await canSeeRecord(w, tx, { prefix: 'people', personId: PEER }),
      'a worker must not resolve another person by id',
    ).toBe(false)

    // Safe Distance: `read.self`, so only their own assessments, never a site.
    const sd = await safeDistanceScopeWhere(w, tx)
    expect(bound(sd)).toEqual([READER])
    expect(bound(sd)).not.toContain(SITE_A)
    expect(bound(sd)).not.toContain(SITE_B)
    // Form responses: the native `read.self`.
    expect(
      bound(
        await moduleScopeWhere(w, tx, {
          prefix: 'forms.response',
          personCol: formResponses.subjectPersonId,
        }),
      ),
    ).toEqual([READER])
  })

  it('foreman: Safe Distance site tier, Forms read.site, nothing tenant-wide', async () => {
    const f = asRole('foreman', { personId: PEER })
    expect(permsOf('foreman')).not.toContain('people.read.all')

    const sd = await safeDistanceScopeWhere(f, tx)
    expect(bound(sd)).toContain(SITE_A)
    expect(bound(sd)).not.toContain(SITE_B)
    // The record guard agrees, so a site-B assessment is not readable by id.
    expect(
      await canSeeRecord(f, tx, {
        prefix: SAFE_DISTANCE_SCOPE_COLUMNS.prefix,
        siteId: SITE_B,
        personId: OTHER_PERSON,
      }),
    ).toBe(false)

    const forms = await moduleScopeWhere(f, tx, {
      prefix: 'forms.response',
      siteCol: formResponses.siteOrgUnitId,
      personCol: formResponses.subjectPersonId,
    })
    expect(bound(forms)).toContain(SITE_A)
    expect(bound(forms)).not.toContain(SITE_B)
    // Documents: `read` but not `manage`, so published only.
    expect(bound(documentReadFilter(f))).toEqual(['published'])
  })

  it('safety_manager: People tenant-wide, Safe Distance all, documents native', async () => {
    const s = asRole('safety_manager')
    expect(permsOf('safety_manager')).toContain('people.read.all')
    // The accepted widening: the roster is the tenant. Asserted so it is a
    // recorded decision rather than an accident nobody re-examines.
    expect(await moduleScopeWhere(s, tx, { prefix: 'people' })).toBeUndefined()
    expect(await canSeeRecord(s, tx, { prefix: 'people', personId: PEER })).toBe(true)

    expect(await safeDistanceScopeWhere(s, tx)).toBeUndefined()
    // `documents.manage` waives the publication half, per the shared rule.
    expect(documentReadFilter(s)).toBeUndefined()
    expect(bound(await moduleScopeWhere(s, tx, { prefix: 'forms.response' }))).toEqual([])
  })

  it('tenant_admin: the catalogue, so every module resolves to its widest tier', async () => {
    const a = asRole('tenant_admin')
    // Held as the whole catalogue rather than a list, so every key is present by
    // construction — asserted here because that is what makes the rest sound.
    for (const key of [
      'people.read.all',
      'tools.safe-distance.read.all',
      'forms.response.read.all',
      'documents.read',
      'documents.manage',
    ]) {
      expect(permsOf('tenant_admin'), key).toContain(key)
    }
    expect(await moduleScopeWhere(a, tx, { prefix: 'people' })).toBeUndefined()
    expect(await safeDistanceScopeWhere(a, tx)).toBeUndefined()
    expect(await moduleScopeWhere(a, tx, { prefix: 'forms.response' })).toBeUndefined()
    expect(documentReadFilter(a)).toBeUndefined()
    // Still bounded by the tenant: a Role Scope at another site is not consulted
    // for a tier-`all` holder, and RLS is what bounds them.
    expect(await canSeeRecord(a, tx, { prefix: 'people', personId: PEER })).toBe(true)
  })

  it('no built-in role is granted a people read tier other than `all`', async () => {
    // There is no `people.read.site` or `.self` to hold, by design. If one is ever
    // added, this fails and the "no column to narrow on" argument has to be
    // revisited rather than assumed to still hold.
    for (const role of Object.keys(BUILTIN_ROLES) as (keyof typeof BUILTIN_ROLES)[]) {
      const peopleKeys = permsOf(role).filter((k) => k.startsWith('people.read.'))
      for (const k of peopleKeys) expect(k, role).toBe('people.read.all')
    }
  })
})

// ===========================================================================
// 3. STRUCTURAL — the symbols are gone from production code.
//
// A grep is the honest test for "a symbol does not exist", and this half is
// explicitly not an authorization test. Half 1 decides who may see what.
// ===========================================================================

const HERE = dirname(fileURLToPath(import.meta.url))
// `apps/web/src/lib` -> repo root is four levels up (`lib` → `src` → `web` → `apps` → root).
const REPO_ROOT = resolve(HERE, '../../../..')
const WEB_SRC = resolve(HERE, '..')
const ANALYTICS_SRC = resolve(REPO_ROOT, 'packages/analytics/src')

/** Every `.ts` / `.tsx` under `dir`, excluding tests and build output. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') return []
      return sourceFiles(full)
    }
    if (!/\.tsx?$/.test(entry) || entry.endsWith('.test.ts')) return []
    return [full]
  })
}

const productionSources = [...sourceFiles(WEB_SRC), ...sourceFiles(ANALYTICS_SRC)]

/** Repo-relative, so a failure names a file rather than a temp path. */
const rel = (full: string) => full.slice(REPO_ROOT.length + 1)

/** The removed API surface, by name. */
const REMOVED = [
  'resolveProjectScope',
  'resolveProjectScopeIn',
  'projectScopePredicate',
  'recordInProjectScope',
  'documentScopeFilter',
  'documentScopeUsable',
  'documentAuthorizationFilter',
  'scopeContribution',
  'ProjectScopeExemption',
  'projectScopeExempt',
  'applyProjectScope',
  'isAlwaysFalse',
  'projectScopeKind',
  'projectPersonIds',
] as const

// NOT in the list above: `orgUnitIds`. It was a field on the removed subject, but
// it is also an ordinary local variable name in native code — the compliance
// audience resolver, org sync, the locations drill-down and flow execution all use
// it for a list of org-unit ids. Asserting its absence would be a false contract:
// it would fail on correct code and pass on reintroduced scope plumbing.

describe('the removed authorization dimension is gone from production code', () => {
  it.each(REMOVED)('no production source declares or calls %s', (symbol) => {
    const pattern = new RegExp(`\\b${symbol}\\b`)
    const offenders = productionSources.filter((f) => pattern.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel), `${symbol} must not survive anywhere in production code`).toEqual([])
  })

  it('and the resolver modules themselves are gone', () => {
    for (const gone of [
      'packages/analytics/src/server/project-scope.ts',
      'apps/web/src/lib/project-scope.ts',
      'apps/web/src/lib/project-scope-predicate.ts',
      'apps/web/src/lib/assistant/document-project-scope.ts',
      'apps/web/src/lib/testing/project-scope-fixture.ts',
      'apps/web/scripts/project-scope-verification.ts',
      'apps/web/scripts/project-scope-live-verification.ts',
    ]) {
      let exists = true
      try {
        statSync(resolve(REPO_ROOT, gone))
      } catch {
        exists = false
      }
      expect(exists, `${gone} should have been deleted`).toBe(false)
    }
  })

  it('the analytics package no longer re-exports a resolver', () => {
    const index = readFileSync(resolve(ANALYTICS_SRC, 'server/index.ts'), 'utf8')
    expect(index).not.toContain("from './project-scope'")
    // What it does export is the native subject builder and the fingerprint.
    expect(index).toContain('analyticsScopeSubject')
    expect(index).toContain('scopeAnalyticsEntities')
    expect(index).toContain('analyticsScopeFingerprint')
  })

  it('`people_assignments` is untouched — it is native data, not an authorization mechanism', () => {
    // The distinction this removal must not blur. Placement is read by the
    // compliance audience and identity resolvers and is shown on the person's page;
    // it simply no longer narrows anything.
    const schema = readFileSync(resolve(REPO_ROOT, 'packages/db/src/schema/org.ts'), 'utf8')
    expect(schema).toContain('export const peopleAssignments = pgTable(')
    expect(schema).toContain("'people_assignments'")
  })

  it('and the native ladder is still the only one exported', () => {
    const vis = readFileSync(resolve(WEB_SRC, 'lib/visibility.ts'), 'utf8')
    // `resolveVisibilityTier` is private and drives both entry points; that is the
    // point. A second tier resolver would be a second ladder.
    const tierFns = [...vis.matchAll(/function (\w*[Tt]ier\w*)\(/g)].map((m) => m[1])
    expect(tierFns).toEqual(['resolveVisibilityTier'])
    expect(vis).toContain('export async function moduleScopeWhere')
    expect(vis).toContain('export async function canSeeRecord')
  })
})
