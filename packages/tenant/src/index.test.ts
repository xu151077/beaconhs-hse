// The permission core every server action relies on. `can()` / `assertCan()`
// implement the wildcard + read-tier conventions documented in AGENTS.md;
// a regression here silently opens or closes whole modules, so these cases
// are pinned rather than left to indirect coverage.

import { describe, expect, it } from 'vitest'
import {
  assertCan,
  assertNotImpersonating,
  can,
  canEditResponsePayload,
  canSeeSite,
  effectiveRoleAssignments,
  ForbiddenError,
  type RequestContext,
} from './index'

function ctx(partial: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    isSuperAdmin: false,
    timezone: 'Asia/Kuala_Lumpur',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: null,
    personId: null,
    permissions: new Set<string>(),
    scopes: [],
    db: (() => Promise.reject(new Error('no db in test'))) as never,
    ...partial,
  }
}

describe('can()', () => {
  it('grants exact permission matches', () => {
    expect(can(ctx({ permissions: new Set(['people.read.all']) }), 'people.read.all')).toBe(true)
    expect(can(ctx({ permissions: new Set(['people.read.all']) }), 'people.read.site')).toBe(true)
  })

  it('denies permissions the caller does not hold', () => {
    expect(can(ctx(), 'people.read.all')).toBe(false)
    expect(can(ctx({ permissions: new Set(['incidents.read.all']) }), 'people.read.all')).toBe(
      false,
    )
  })

  it('lets a super-admin pass any check', () => {
    expect(can(ctx({ isSuperAdmin: true }), 'admin.settings.manage')).toBe(true)
    expect(can(ctx({ isSuperAdmin: true }), 'forms.template.delete')).toBe(true)
  })

  it('honours module wildcards only within their own prefix', () => {
    const wildcard = ctx({ permissions: new Set(['incidents.*']) })
    expect(can(wildcard, 'incidents.create')).toBe(true)
    expect(can(wildcard, 'incidents.read.all')).toBe(true)
    expect(can(wildcard, 'people.read.all')).toBe(false)
  })

  it('covers read tiers: all covers site+self, site covers self only', () => {
    const all = ctx({ permissions: new Set(['documents.read.all']) })
    expect(can(all, 'documents.read.site')).toBe(true)
    expect(can(all, 'documents.read.self')).toBe(true)

    const site = ctx({ permissions: new Set(['documents.read.site']) })
    expect(can(site, 'documents.read.self')).toBe(true)
    expect(can(site, 'documents.read.all')).toBe(false)
    expect(can(site, 'documents.read.site')).toBe(true)

    const self = ctx({ permissions: new Set(['documents.read.self']) })
    expect(can(self, 'documents.read.self')).toBe(true)
    expect(can(self, 'documents.read.site')).toBe(false)
  })

  it('does not treat a tiered grant as a write permission', () => {
    const reader = ctx({ permissions: new Set(['documents.read.all']) })
    expect(can(reader, 'documents.update')).toBe(false)
    expect(can(reader, 'documents.manage')).toBe(false)
  })
})

describe('assertCan()', () => {
  it('passes for an available permission and throws a typed error otherwise', () => {
    expect(() =>
      assertCan(ctx({ permissions: new Set(['people.read.all']) }), 'people.read.all'),
    ).not.toThrow()
    expect(() => assertCan(ctx(), 'people.read.all')).toThrow(ForbiddenError)
    expect(() => assertCan(ctx(), 'people.read.all')).toThrow(
      /Missing permission: people\.read\.all/,
    )
  })

  it('blocks impersonated admins from identity-writing actions', () => {
    const impersonating = ctx({
      impersonation: {
        actor: { userId: 'admin', name: 'A', email: 'a@example.com' },
        tenantId: 'tenant-1',
        expiresAt: new Date(),
      },
    })
    expect(() => assertNotImpersonating(impersonating, 'reset password')).toThrow(/blocked/)
    expect(() => assertNotImpersonating(ctx())).not.toThrow()
  })
})

describe('canSeeSite()', () => {
  it('allows empty site ids and tenant-wide scopes', () => {
    expect(canSeeSite(ctx(), null)).toBe(true)
    expect(canSeeSite(ctx({ scopes: [{ type: 'tenant' }] }), 'site-9')).toBe(true)
  })

  it('respects site scope lists', () => {
    const scoped = ctx({ scopes: [{ type: 'sites', siteIds: ['site-1'] }] })
    expect(canSeeSite(scoped, 'site-1')).toBe(true)
    expect(canSeeSite(scoped, 'site-2')).toBe(false)
  })
})

describe('effectiveRoleAssignments()', () => {
  const assignments = [
    { roleId: 'r1', name: 'Field' },
    { roleId: 'r2', name: 'Office' },
  ]

  it('returns everything when no role is active', () => {
    expect(effectiveRoleAssignments(null, assignments)).toEqual(assignments)
    expect(effectiveRoleAssignments(undefined, assignments)).toEqual(assignments)
  })

  it('narrows to the switched role', () => {
    expect(effectiveRoleAssignments('r2', assignments)).toEqual([{ roleId: 'r2', name: 'Office' }])
  })
})

describe('canEditResponsePayload()', () => {
  it('refuses locked payloads for everyone, including super-admins', () => {
    // Locked means read-only until the unlock flow runs; the permission
    // checks below handle who may act on unlocked payloads.
    const response = { status: 'draft', locked: true, submittedBy: 'm-1' }
    expect(
      canEditResponsePayload(ctx({ membership: { id: 'm-1', displayName: 'x' } }), response),
    ).toBe(false)
    expect(
      canEditResponsePayload(
        ctx({ isSuperAdmin: true, membership: { id: 'm-1', displayName: 'x' } }),
        response,
      ),
    ).toBe(false)
    expect(
      canEditResponsePayload(ctx({ isSuperAdmin: true }), {
        status: 'draft',
        locked: false,
        submittedBy: 'm-2',
      }),
    ).toBe(true)
  })

  it('lets the owner edit their own in-progress draft with update permission', () => {
    const owner = ctx({
      membership: { id: 'm-1', displayName: 'x' },
      permissions: new Set(['forms.response.update.own']),
    })
    expect(
      canEditResponsePayload(owner, { status: 'draft', locked: false, submittedBy: 'm-1' }),
    ).toBe(true)
    expect(
      canEditResponsePayload(owner, { status: 'draft', locked: false, submittedBy: 'm-2' }),
    ).toBe(false)
    // The owner clause does not require a draft: it is the LOCK that marks a
    // payload read-only (submitted by someone else can still be reworked
    // through the unlock flow by admins).
    expect(
      canEditResponsePayload(owner, { status: 'submitted', locked: false, submittedBy: 'm-1' }),
    ).toBe(true)
  })
})
