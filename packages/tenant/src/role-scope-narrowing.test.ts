// PD-01 phase 2 — scope narrowing primitives.
//
// These are the only two functions that decide whether a machine credential's
// requested scopes are allowed by its principal. They must be subset-exact: a
// credential may narrow, never widen, and the three-valued input (null / [] /
// values) must stay distinguishable.

import { describe, expect, it } from 'vitest'
import type { RoleScope } from '@beaconhs/db/schema'
import { narrowRoleScopes, roleScopeCovers } from './index'

describe('roleScopeCovers', () => {
  it('a tenant principal covers every scope', () => {
    const principal: RoleScope = { type: 'tenant' }
    expect(roleScopeCovers(principal, { type: 'tenant' })).toBe(true)
    expect(roleScopeCovers(principal, { type: 'sites', siteIds: ['a'] })).toBe(true)
    expect(roleScopeCovers(principal, { type: 'self' })).toBe(true)
  })

  it('site scopes require an exact-or-narrower site list', () => {
    const principal: RoleScope = { type: 'sites', siteIds: ['a', 'b'] }
    expect(roleScopeCovers(principal, { type: 'sites', siteIds: ['a'] })).toBe(true)
    expect(roleScopeCovers(principal, { type: 'sites', siteIds: ['a', 'b'] })).toBe(true)
    expect(roleScopeCovers(principal, { type: 'sites', siteIds: ['c'] })).toBe(false)
    expect(roleScopeCovers(principal, { type: 'tenant' })).toBe(false)
  })

  it('team scopes require both lists to be subsets', () => {
    const principal: RoleScope = { type: 'team', departmentIds: ['d1'], groupIds: ['g1'] }
    expect(roleScopeCovers(principal, { type: 'team', departmentIds: ['d1'], groupIds: [] })).toBe(
      true,
    )
    expect(
      roleScopeCovers(principal, { type: 'team', departmentIds: ['d2'], groupIds: ['g1'] }),
    ).toBe(false)
    expect(
      roleScopeCovers(principal, { type: 'team', departmentIds: ['d1'], groupIds: ['g2'] }),
    ).toBe(false)
  })

  it('self is covered only by self', () => {
    expect(roleScopeCovers({ type: 'self' }, { type: 'self' })).toBe(true)
    expect(roleScopeCovers({ type: 'self' }, { type: 'sites', siteIds: ['a'] })).toBe(false)
  })
})

describe('narrowRoleScopes', () => {
  const principal: RoleScope[] = [{ type: 'sites', siteIds: ['a', 'b'] }]

  it('null and undefined inherit the principal verbatim', () => {
    expect(narrowRoleScopes(principal, null)).toEqual({ ok: true, scopes: principal })
    expect(narrowRoleScopes(principal, undefined)).toEqual({ ok: true, scopes: principal })
  })

  it('an empty array is an explicit no-scope, not inheritance', () => {
    expect(narrowRoleScopes(principal, [])).toEqual({ ok: true, scopes: [] })
  })

  it('a covered subset is accepted as-is', () => {
    const requested: RoleScope[] = [{ type: 'sites', siteIds: ['a'] }]
    expect(narrowRoleScopes(principal, requested)).toEqual({ ok: true, scopes: requested })
  })

  it('an uncovered scope fails closed instead of being dropped', () => {
    expect(narrowRoleScopes(principal, [{ type: 'sites', siteIds: ['z'] }])).toEqual({
      ok: false,
      reason: 'exceeds_principal',
    })
    expect(narrowRoleScopes(principal, [{ type: 'tenant' }])).toEqual({
      ok: false,
      reason: 'exceeds_principal',
    })
  })
})
