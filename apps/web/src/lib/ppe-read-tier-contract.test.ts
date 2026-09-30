// PPE permission-boundary contract.
//
// `ppe_items` / `ppe_issues` carry no org-unit column, so the PPE module can
// only be bounded by PERMISSION. This file pins that boundary: the read tiers
// exist in the catalogue, the built-in roles get the right one, the generic
// tier resolver honours them, and every PPE surface (list, detail, nav) applies
// it instead of showing the whole register to any signed-in user.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Database } from '@beaconhs/db'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE, ppeItems, type RoleScope } from '@beaconhs/db/schema'
import { can, type RequestContext } from '@beaconhs/tenant'
import { canSeeRecord, moduleScopeWhere } from './visibility'

const tx = {} as Database

/** The literal chunks of a drizzle SQL predicate (drizzle-orm 0.45: a property). */
function chunksOf(predicate: unknown): unknown[] {
  const chunks = (predicate as { queryChunks?: unknown } | undefined)?.queryChunks
  return Array.isArray(chunks) ? chunks : []
}

/**
 * True only for the literal ``sql`false` `` sentinel moduleScopeWhere returns
 * when it has no own predicates left to filter on — i.e. a WHERE that can never
 * match a row. Compared structurally rather than by serialising, because a
 * predicate built from a Column does not serialise to anything comparable.
 */
function isAlwaysFalse(predicate: unknown): boolean {
  if (predicate === undefined) return false
  const chunks = chunksOf(predicate)
  if (chunks.length !== 1) return false
  const only = chunks[0] as { value?: unknown }
  // drizzle's `sql` tag wraps a literal in a StringChunk whose `value` is an
  // array of string parts. Tolerate a bare string too, in case that changes.
  const literal = Array.isArray(only?.value)
    ? only.value.join('')
    : typeof only === 'string'
      ? only
      : only?.value
  return literal === 'false'
}

function context(
  permissions: string[],
  scopes: RoleScope[] = [{ type: 'self' }],
  // `null` models a tenant user with no `people` row, so `resolvePersonId`
  // returns null — the shape a foreman actually has in the runtime fixture.
  personId: string | null = 'person_1',
): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-000000000001',
    isSuperAdmin: false,
    timezone: 'America/Toronto',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'member_1', displayName: 'Worker' },
    personId,
    permissions: new Set(permissions),
    scopes,
    db: async () => {
      throw new Error('visibility predicates must not hit the database here')
    },
  }
}

/** A record belonging to somebody else, at a site the caller may or may not hold. */
function otherRecord(siteId: string | null) {
  return { prefix: 'ppe', personId: 'person_2', siteId }
}

describe('ppe read-tier catalogue', () => {
  it('declares the full read family and nothing else changed', () => {
    expect(PERMISSION_CATALOGUE).toContain('ppe.read.all')
    expect(PERMISSION_CATALOGUE).toContain('ppe.read.site')
    expect(PERMISSION_CATALOGUE).toContain('ppe.read.self')
    // The catalogue is a curated list; a count change means a key was added or
    // dropped without anyone reading this test.
    expect(PERMISSION_CATALOGUE.length).toBe(93)
    expect(new Set(PERMISSION_CATALOGUE).size).toBe(93)
  })

  it('grants a worker own-PPE read', () => {
    expect(BUILTIN_ROLES.worker?.permissions).toContain('ppe.read.self')
    expect(BUILTIN_ROLES.worker?.permissions).not.toContain('ppe.read.site')
    expect(BUILTIN_ROLES.worker?.permissions).not.toContain('ppe.read.all')
  })

  it('scopes a foreman to the site tier, matching its equipment read', () => {
    // A foreman's equipment read is site-scoped, so its PPE read must be too.
    // ppe.read.all here would be a tenant-wide grant on every built-in role of
    // every existing tenant (convergeRolePermissions unions the baseline).
    expect(BUILTIN_ROLES.foreman?.permissions).toContain('ppe.read.site')
    expect(BUILTIN_ROLES.foreman?.permissions).not.toContain('ppe.read.all')
    // The write capabilities a foreman needs to run an inspection are unchanged.
    expect(BUILTIN_ROLES.foreman?.permissions).toContain('ppe.issue')
    expect(BUILTIN_ROLES.foreman?.permissions).toContain('ppe.inspect')
  })

  it('keeps the register-wide read with safety_manager and tenant_admin', () => {
    expect(BUILTIN_ROLES.safety_manager?.permissions).toContain('ppe.read.all')
    expect(BUILTIN_ROLES.tenant_admin?.permissions).toContain('ppe.read.all')
    expect(BUILTIN_ROLES.tenant_admin?.permissions).toContain('ppe.read.site')
    expect(BUILTIN_ROLES.tenant_admin?.permissions).toHaveLength(93)
  })

  it('widens through readTierCovers so higher tiers satisfy lower ones', () => {
    const all = context(['ppe.read.all'])
    const site = context(['ppe.read.site'])
    const self = context(['ppe.read.self'])
    expect(can(all, 'ppe.read.site')).toBe(true)
    expect(can(all, 'ppe.read.self')).toBe(true)
    expect(can(site, 'ppe.read.self')).toBe(true)
    expect(can(self, 'ppe.read.self')).toBe(true)
    expect(can(self, 'ppe.read.site')).toBe(false)
    expect(can(self, 'ppe.read.all')).toBe(false)
    // A write capability alone must not imply read access to the register.
    expect(can(context(['ppe.issue']), 'ppe.read.self')).toBe(false)
  })
})

describe('ppe read tiers reach the shared visibility resolver', () => {
  // `resolveVisibilityTier` is private to visibility.ts, so the tier is proved
  // through its two public effects: the list predicate and the record guard.
  it('resolves ppe.read.all to no list filter', async () => {
    expect(await moduleScopeWhere(context(['ppe.read.all']), tx, { prefix: 'ppe' })).toBeUndefined()
    expect(await moduleScopeWhere(context(['ppe.read.all']), tx, { prefix: 'ppe' })).toBeUndefined()
  })

  it('resolves ppe.read.site to a site-scoped list and a site record guard', async () => {
    const ctx = context(['ppe.read.site'], [{ type: 'sites', siteIds: ['site_1'] }])
    expect(await moduleScopeWhere(ctx, tx, { prefix: 'ppe' })).toBeDefined()
    // Tier is `site`, not `all`: a record outside my sites stays hidden.
    expect(await canSeeRecord(ctx, tx, otherRecord('site_1'))).toBe(true)
    expect(await canSeeRecord(ctx, tx, otherRecord('site_2'))).toBe(false)
  })

  it('resolves ppe.read.self to own records only', async () => {
    const ctx = context(['ppe.read.self'], [{ type: 'sites', siteIds: ['site_1'] }])
    expect(await moduleScopeWhere(ctx, tx, { prefix: 'ppe' })).toBeDefined()
    // A `self` holder is denied even at one of their own sites...
    expect(await canSeeRecord(ctx, tx, otherRecord('site_1'))).toBe(false)
    // ...and allowed their own gear.
    expect(await canSeeRecord(ctx, tx, { prefix: 'ppe', personId: 'person_1', siteId: null })).toBe(
      true,
    )
  })

  it('gives a holder of no ppe read key nothing at all', async () => {
    // The page gate turns this into a redirect, but the ladder must not be the
    // thing that saves us: with no read key the tier floors at `self`, and a
    // user with no person link matches no holder, so both surfaces deny.
    const ctx = context([], [{ type: 'sites', siteIds: ['site_1'] }], null)
    expect(
      await moduleScopeWhere(ctx, tx, { prefix: 'ppe', personCol: ppeItems.currentHolderPersonId }),
    ).toBeDefined()
    expect(await canSeeRecord(ctx, tx, otherRecord('site_1'))).toBe(false)
    // A write capability is not a read capability — this is the viewer case.
    const writer = context(['ppe.manage'], [{ type: 'sites', siteIds: ['site_1'] }], null)
    expect(await canSeeRecord(writer, tx, otherRecord('site_1'))).toBe(false)
    expect(await canSeeRecord(writer, tx, otherRecord(null))).toBe(false)
  })

  it('resolves the seeded built-in roles to the tier they were granted', async () => {
    // Built on the real role permission sets, so a role that lost its PPE read
    // key would silently drop to an empty register instead of the intended tier.
    const worker = context([...BUILTIN_ROLES.worker!.permissions])
    expect(await canSeeRecord(worker, tx, otherRecord(null))).toBe(false)
    expect(
      await canSeeRecord(worker, tx, { prefix: 'ppe', personId: 'person_1', siteId: null }),
    ).toBe(true)
    const foreman = context([...BUILTIN_ROLES.foreman!.permissions])
    // A foreman holds ppe.read.site, but ppe_items has NO org-unit column and
    // neither PPE surface passes a siteCol, so the ladder's `site` branch never
    // fires and the holder predicate is the only one that applies. The practical
    // consequence: a foreman sees their OWN gear, not their crew's — and with
    // no person link, nothing at all (pinned in the next describe block).
    // Deliberate: it is the cost of not granting the tenant-wide ppe.read.all,
    // and it must not drift silently.
    expect(await canSeeRecord(foreman, tx, otherRecord('site_1'))).toBe(false)
    expect(await canSeeRecord(foreman, tx, otherRecord('site_2'))).toBe(false)
    expect(
      await canSeeRecord(foreman, tx, { prefix: 'ppe', personId: 'person_1', siteId: null }),
    ).toBe(true)
    // The list is scoped, so it is no longer an unfiltered tenant-wide register.
    expect(await moduleScopeWhere(foreman, tx, { prefix: 'ppe' })).toBeDefined()
  })

  it('keeps a register-wide read for the roles that still hold ppe.read.all', async () => {
    // safety_manager is unchanged by the foreman correction and is the role that
    // must still see the whole register.
    const safetyManager = context([...BUILTIN_ROLES.safety_manager!.permissions])
    expect(await canSeeRecord(safetyManager, tx, otherRecord('site_2'))).toBe(true)
    expect(await moduleScopeWhere(safetyManager, tx, { prefix: 'ppe' })).toBeUndefined()
  })

  it('leaves ppe_items with no site column, so site degrades to own-only', async () => {
    // ppe_items is the record the list/detail scope resolves against, and it
    // has no org-unit column at all — that is WHY the ppe tiers can only be
    // person-scoped today.
    expect(Object.keys(ppeItems)).not.toContain('currentSiteOrgUnitId')
    expect(Object.keys(ppeItems)).toContain('currentHolderPersonId')
    // No siteCol is passed by either PPE surface, so moduleScopeWhere /
    // canSeeRecord fall through to the "own" predicates rather than widening.
    const list = readFileSync(new URL('../app/(app)/ppe/page.tsx', import.meta.url), 'utf8')
    expect(list).not.toContain('siteCol: ppeItems')
    expect(list).toContain('personCol: ppeItems.currentHolderPersonId')
  })
})

describe('ppe.read.site must not fail open when there is no person link', () => {
  // The runtime case this pins: a foreman holds `ppe.read.site` but has no
  // `people` row, so `ctx.personId` is null. ppe_items has no org-unit column,
  // so the `site` branch of the ladder cannot fire, and there is no holder to
  // match — which leaves NO predicate that could match a row.
  //
  // The safe answer is an always-false WHERE: an empty register. The unsafe
  // answer is `undefined`, which moduleScopeWhere reads as "no filter" and
  // which would hand a site-tier holder the whole tenant's PPE. That is the
  // single most damaging way this code could regress, so it is asserted
  // directly rather than inferred from the other tier tests.
  const sites: RoleScope[] = [{ type: 'sites', siteIds: ['site_1'] }]

  it('yields an always-false list predicate, never an unfiltered one', async () => {
    const ctx = context(['ppe.read.site'], sites, null)
    const scope = await moduleScopeWhere(ctx, tx, {
      prefix: 'ppe',
      personCol: ppeItems.currentHolderPersonId,
    })
    // Not undefined: undefined is the tenant-wide "no filter" answer.
    expect(scope).toBeDefined()
    expect(scope).not.toBeUndefined()
    // Exactly the always-false sentinel, i.e. zero rows rather than six.
    expect(isAlwaysFalse(scope)).toBe(true)
    // And the fail-open answer must never satisfy this helper — if `undefined`
    // ever counted as safe, this whole block would pass on a widened register.
    expect(isAlwaysFalse(undefined)).toBe(false)
  })

  it('is not vacuous: with a person link the predicate tracks that holder', async () => {
    // If the predicate above were always-false for everyone, this would fail —
    // which is the point. Two linked holders must get two DIFFERENT predicates,
    // which is only possible if the holder column is genuinely being compared.
    const mine = await moduleScopeWhere(context(['ppe.read.site'], sites, 'person_1'), tx, {
      prefix: 'ppe',
      personCol: ppeItems.currentHolderPersonId,
    })
    const theirs = await moduleScopeWhere(context(['ppe.read.site'], sites, 'person_9'), tx, {
      prefix: 'ppe',
      personCol: ppeItems.currentHolderPersonId,
    })
    expect(mine).toBeDefined()
    expect(isAlwaysFalse(mine)).toBe(false)
    expect(chunksOf(mine)).not.toEqual(chunksOf(theirs))
  })

  it('denies every record because the PPE detail page passes no siteId', async () => {
    // canSeeRecord's `site` branch only fires when the CALLER supplies a siteId.
    // The PPE surfaces deliberately never do — ppe_items has none — so a record
    // shaped the way the page actually builds it is denied on the holder alone.
    const ctx = context(['ppe.read.site'], sites, null)
    expect(await canSeeRecord(ctx, tx, { prefix: 'ppe', personId: 'person_2' })).toBe(false)
    // …and the same context would be ALLOWED a siteId-bearing record, which is
    // precisely why the surfaces must never start passing one.
    expect(await canSeeRecord(ctx, tx, otherRecord('site_1'))).toBe(true)
    expect(await canSeeRecord(ctx, tx, otherRecord('site_2'))).toBe(false)
  })

  it('leaves the two PPE surfaces unable to widen it', async () => {
    // Neither surface may start passing a siteCol or a siteId, which is the
    // only way the always-false above could silently become a site scope.
    const list = readFileSync(new URL('../app/(app)/ppe/page.tsx', import.meta.url), 'utf8')
    const detail = readFileSync(new URL('../app/(app)/ppe/[id]/page.tsx', import.meta.url), 'utf8')
    expect(list).not.toContain('siteCol')
    expect(detail.slice(detail.indexOf('const visible = await canSeeRecord'))).not.toContain(
      'siteId',
    )
  })

  it('never grants foreman ppe.read.all, which is what would mask the empty register', async () => {
    // convergeRolePermissions unions the built-in baseline into existing
    // tenants, so a read.all here would widen every tenant's foreman role and
    // hide the empty-register consequence behind a working-looking screen.
    expect(BUILTIN_ROLES.foreman?.permissions).not.toContain('ppe.read.all')
    // The empty register is therefore the standing, intended behaviour for a
    // foreman with no person link — fail-closed until ppe_items gains a
    // location column, at which point this expectation is what must change.
    const foreman = context([...BUILTIN_ROLES.foreman!.permissions], sites, null)
    const scope = await moduleScopeWhere(foreman, tx, {
      prefix: 'ppe',
      personCol: ppeItems.currentHolderPersonId,
    })
    expect(isAlwaysFalse(scope)).toBe(true)
  })
})

describe('ppe surfaces apply the boundary', () => {
  const GATE = [
    "!can(ctx, 'ppe.read.all')",
    "!can(ctx, 'ppe.read.site')",
    "!can(ctx, 'ppe.read.self')",
  ]

  it('gates the register list page and scopes its query', () => {
    const page = readFileSync(new URL('../app/(app)/ppe/page.tsx', import.meta.url), 'utf8')
    for (const fragment of GATE) expect(page).toContain(fragment)
    expect(page).toContain("redirect('/dashboard')")
    expect(page).toContain("moduleScopeWhere(ctx, tx, {\n      prefix: 'ppe',")
    expect(page).toContain('if (scope) filters.push(scope)')
  })

  it('gates the item detail page and re-checks the single record', () => {
    const page = readFileSync(new URL('../app/(app)/ppe/[id]/page.tsx', import.meta.url), 'utf8')
    for (const fragment of GATE) expect(page).toContain(fragment)
    expect(page).toContain("redirect('/dashboard')")
    expect(page).toContain("prefix: 'ppe',")
    expect(page).toContain('personId: row.item.currentHolderPersonId')
    expect(page).toContain('if (!visible) return null')
    // The page component gate lives after requireRequestContext in the default
    // export, not only in the server actions.
    const component = page.slice(page.indexOf('export default async function PpeDetailPage'))
    expect(component).toContain("!can(ctx, 'ppe.read.self')")
  })

  it('gates the sidebar entry on the lowest read tier', () => {
    const nav = readFileSync(new URL('./nav/registry.ts', import.meta.url), 'utf8')
    const entry = nav.slice(nav.indexOf("key: 'ppe'"), nav.indexOf("key: 'ppe'") + 240)
    expect(entry).toContain("requiredPermission: 'ppe.read.self'")
    expect(entry).toContain("href: '/ppe'")
    // Built-in roles that kept the PPE nav entry before still keep it.
    const roles = ['worker', 'foreman', 'safety_manager'] as const
    for (const role of roles) {
      const permissions = new Set(BUILTIN_ROLES[role]?.permissions ?? [])
      const ctx = context([...permissions])
      expect(can(ctx, 'ppe.read.self')).toBe(true)
    }
  })
})
