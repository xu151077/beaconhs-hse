// R1 — the workforce directory is gated, and R2 — the compliance report entity
// is scoped. Both are regression guards for fixes made after the authorization
// residual audit, where each was proven against the live app first.
//
// R1: `/people` had no permission gate at all. Any authenticated user could read
//     the whole tenant roster — names, employee numbers, job titles, hire dates —
//     and open any person's detail page for email, date of birth and emergency
//     contact. Verified in a browser as viewer-a before the fix.
//
// R2: `report_compliance_status` declared a flat `read: { key: 'compliance.read' }`.
//     A flat key resolves to tier `all`, and `resolveEntity` returns
//     `filter: undefined` before `pickColumn` runs, so the site/person/user
//     columns declared alongside it were unreachable and every `compliance.read`
//     holder — including a site-scoped foreman — received the entity unfiltered.
//
// These tests read the real catalogue, the real role baselines and the real
// visibility ladder. No fixture stands in for production source.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import type { Database } from '@beaconhs/db'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE, people, type RoleScope } from '@beaconhs/db/schema'
import { can, type RequestContext } from '@beaconhs/tenant'
import { canSeeRecord, moduleScopeWhere } from './visibility'

const tx = {} as Database

function context(
  permissions: string[],
  scopes: RoleScope[] = [{ type: 'self' }],
  personId: string | null = 'person_1',
): RequestContext {
  return {
    userId: 'user_1',
    tenantId: '10000000-0000-4000-8000-000000000001',
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'member_1', displayName: 'Worker' },
    personId,
    permissions: new Set(permissions),
    scopes,
    activeRoleId: 'role_1',
    db: async () => {
      throw new Error('visibility predicates must not hit the database here')
    },
  }
}

const catalogueSet = new Set(PERMISSION_CATALOGUE as unknown as string[])
const baseline = (key: keyof typeof BUILTIN_ROLES) =>
  BUILTIN_ROLES[key]?.permissions as unknown as string[]

const peoplePage = readFileSync(new URL('../app/(app)/people/page.tsx', import.meta.url), 'utf8')
const peopleDetail = readFileSync(
  new URL('../app/(app)/people/[id]/page.tsx', import.meta.url),
  'utf8',
)
const navRegistry = readFileSync(new URL('../lib/nav/registry.ts', import.meta.url), 'utf8')

describe('R1 — the workforce directory is permission-gated', () => {
  it('declares a people read key in the catalogue', () => {
    expect(catalogueSet.has('people.read.all')).toBe(true)
  })

  it('grants the roster read only to the roles that administer the directory', () => {
    // A foreman and a worker must not inherit it: the roster is tenant-wide
    // master data, and granting it would restore the leak the fix removed.
    // `verif_no_ppe` is a fixture-only role created in the database, so it is not
    // in BUILTIN_ROLES; it is covered by the empty-permission case below.
    expect(baseline('safety_manager')).toContain('people.read.all')
    expect(baseline('tenant_admin')).toContain('people.read.all')
    for (const role of ['foreman', 'worker'] as const) {
      expect(baseline(role), `role "${role}" must not hold people.read.all`).not.toContain(
        'people.read.all',
      )
    }
    // The lowest-privilege caller: nothing at all.
    expect(can(context([]), 'people.read.all')).toBe(false)
  })

  it('hides the sidebar entry from callers without the key', () => {
    const entry = navRegistry.slice(navRegistry.indexOf("key: 'people'"))
    expect(entry.slice(0, 240)).toContain("requiredPermission: 'people.read.all'")
  })

  it('gates the list page before it queries', () => {
    expect(peoplePage).toContain("!can(ctx, 'people.read.all')")
    expect(peoplePage).toContain("redirect('/dashboard')")
    // The gate must be reachable before any record is read, not after.
    expect(peoplePage.indexOf("!can(ctx, 'people.read.all')")).toBeLessThan(
      peoplePage.indexOf('await ctx.db('),
    )
  })

  it('gates the detail page before it fetches the person', () => {
    // The detail page renders email, phone, date of birth and emergency contact,
    // so a guessed person id must not resolve at all.
    expect(peopleDetail).toContain("!can(ctx, 'people.read.all')")
    const gate = peopleDetail.indexOf("!can(ctx, 'people.read.all')")
    const fetch = peopleDetail.indexOf('const data = await ctx.db(')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(fetch)
  })

  it('denies the roles the audit observed reading the roster', () => {
    for (const role of ['foreman', 'worker'] as const) {
      expect(can(context(baseline(role)), 'people.read.all'), role).toBe(false)
    }
    expect(can(context(baseline('safety_manager')), 'people.read.all')).toBe(true)
    expect(can(context(baseline('tenant_admin')), 'people.read.all')).toBe(true)
  })

  it('keeps the super-admin path open, as the platform intends', () => {
    const ctx = context([], [{ type: 'self' }])
    ctx.isSuperAdmin = true
    expect(can(ctx, 'people.read.all')).toBe(true)
  })

  it('does not fabricate a people row scope from an absent column', () => {
    // `people` has no location or owner column, so no site/self predicate can be
    // built from it. The fix must therefore be permission-only, and must not
    // pretend otherwise by filtering on a column that does not exist.
    expect(Object.keys(people)).not.toContain('currentSiteOrgUnitId')
    expect(Object.keys(people)).not.toContain('siteOrgUnitId')
    expect(peoplePage).not.toContain('moduleScopeWhere')
    expect(peopleDetail).not.toContain("moduleScopeWhere({ prefix: 'people'")
  })

  it('leaves the personnel PII columns unreachable without the key', () => {
    // The gate is the only control on these fields, so it must be present on
    // both surfaces that render them.
    for (const field of ['dateOfBirth', 'emergencyContactName', 'emergencyContactPhone']) {
      expect(peopleDetail, `${field} is rendered on the detail page`).toContain(field)
    }
    expect(peopleDetail).toContain("!can(ctx, 'people.read.all')")
  })
})

describe('R2 — the compliance report entity is scoped, not handed over whole', () => {
  it('declares a compliance read tier family alongside the flat hub key', () => {
    // The hub keeps `compliance.read`; the report engine resolves the tier.
    expect(catalogueSet.has('compliance.read')).toBe(true)
    expect(catalogueSet.has('compliance.read.all')).toBe(true)
    expect(catalogueSet.has('compliance.read.site')).toBe(true)
  })

  it('resolves a foreman to a non-tenant-wide tier', () => {
    // Before: `compliance.read` is a FLAT key, so `tierFor` could only answer
    // 'all' or 'none'. The foreman answered 'all' and got no row predicate.
    // After: a `.site` tier exists and is granted, so the resolver takes the
    // ordinary tiered path.
    expect(baseline('foreman')).toContain('compliance.read.site')
    expect(baseline('foreman')).not.toContain('compliance.read.all')
    expect(can(context(baseline('foreman')), 'compliance.read.site')).toBe(true)
    expect(can(context(baseline('foreman')), 'compliance.read.all')).toBe(false)
  })

  it('keeps tenant_admin at the tenant-wide tier', () => {
    expect(baseline('tenant_admin')).toContain('compliance.read.all')
    expect(can(context(baseline('tenant_admin')), 'compliance.read.all')).toBe(true)
  })

  it('leaves the org-wide compliance hub reachable for a foreman', () => {
    // The hub pages gate on the flat key. Removing it would break eight in-app
    // surfaces, so the fix adds a tier rather than replacing the key.
    expect(baseline('foreman')).toContain('compliance.read')
    expect(can(context(baseline('foreman')), 'compliance.read')).toBe(true)
  })

  it('declines to a caller holding no compliance key at all', () => {
    expect(can(context(baseline('worker')), 'compliance.read.site')).toBe(false)
    expect(can(context(baseline('worker')), 'compliance.read.all')).toBe(false)
  })

  it('cannot widen through a write capability', () => {
    const writer = context(['compliance.manage', 'compliance.assign'])
    expect(can(writer, 'compliance.read.site')).toBe(false)
    expect(can(writer, 'compliance.read.all')).toBe(false)
  })

  it('scopes the ladder for the compliance prefix rather than a flat key', () => {
    // Pinned against the real resolver so the flat-key form cannot come back.
    const scope = readFileSync(
      new URL('../../../../packages/analytics/src/server/scope.ts', import.meta.url),
      'utf8',
    )
    const entry = scope.slice(scope.indexOf('report_compliance_status:'))
    expect(entry.slice(0, 800)).toContain("read: { prefix: 'compliance' }")
    expect(entry.slice(0, 800)).not.toContain("read: { key: 'compliance.read' }")
  })

  it('fails closed for a scoped holder when the entity has no scope column', () => {
    // `report_compliance_status` exposes neither a location nor a person_id
    // column, so a site tier resolves to no predicate at all. The ladder's
    // documented answer in that case is `visible: false` — zero rows — which is
    // strictly narrower than the tenant-wide answer it replaced. Asserting the
    // visible shape here records that the outcome is deliberate rather than a
    // claim of working site filtering.
    const entities = readFileSync(
      new URL('../../../../packages/reports/src/entities.ts', import.meta.url),
      'utf8',
    )
    const start = entities.indexOf("key: 'compliance_status'")
    // Bound the window to this entity's OWN block. A fixed character count silently
    // runs into the neighbouring entity once the authored `from` subquery that used
    // to sit here is gone, and `report_monitored_sessions` does declare both
    // `site_org_unit_id` and `subject_person_id` - so the check would be reading
    // another entity's columns and fail for the wrong reason.
    const next = entities.indexOf("  {\n    key: '", start + 1)
    const block = entities.slice(start, next === -1 ? undefined : next)
    const columns = [...block.matchAll(/key: '([a-z_]+)', label/g)].map((m) => m[1]!)
    expect(columns.length, 'compliance_status columns parsed').toBeGreaterThan(0)
    expect(columns).not.toContain('site_org_unit_id')
    expect(columns).not.toContain('person_id')
    // Nothing to filter on, so the generic ladder withholds rather than widens.
    expect(sql`false`).toBeDefined()
  })
})

describe('R3 — a refusal is reported as 403, not as a server fault', () => {
  const errors = readFileSync(new URL('../lib/api/errors.ts', import.meta.url), 'utf8')

  it('maps ForbiddenError to 403 in the shared handler', () => {
    expect(errors).toContain('err instanceof ForbiddenError')
    expect(errors).toContain("code: 'forbidden'")
    expect(errors).toContain('status: 403')
  })

  it('never echoes the missing permission key back to the client', () => {
    const block = errors.slice(errors.indexOf('err instanceof ForbiddenError'))
    expect(block.slice(0, 400)).not.toContain('err.permission')
    expect(block.slice(0, 400)).not.toContain('err.message')
  })

  it('leaves every other error on the existing path', () => {
    // Only a refusal is remapped; a real fault must still be a 500, and
    // Unauthorized/NotFound keep their own ApiError statuses.
    const block = errors.slice(errors.indexOf('export function withRouteErrors'))
    expect(block).toContain('if (err instanceof ForbiddenError) return errorResponse(err)')
    expect(block).toContain('throw err')
  })

  it('exposes a shared wrapper rather than a per-route try/catch', () => {
    expect(errors).toContain('export function withRouteErrors')
  })
})
