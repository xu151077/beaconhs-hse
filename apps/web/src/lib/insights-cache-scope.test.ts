// The insights card cache key must reflect every native authorization dimension
// that changes a caller's result.
//
// `insights/_data.ts` keeps a process-level `CARD_RESULT_CACHE` (60 s TTL) keyed on
//
//     ${ctx.tenantId}:${access.scopeKey}:${trustScope}:${key}
//
// and the source comment already states that the scope in that key is load-bearing.
// Before the fingerprint carried the caller's row scope at all, the key covered
// role and template ids only, so two members holding the same role with different
// `{type:'sites'}` Role Scopes shared one entry and were served each other's rows.
//
// WHAT IS IN THE KEY, AND WHY EACH FIELD IS LOAD-BEARING
//
//   super      a super-admin resolves every entity to tier `all`
//   sites      the `{type:'sites'}` Role Scope, which is the `site` tier's only input
//   person     the `self` tier's identity binding
//   user       `ctx.membership.id` — the tenant_users row, so the key is PER MEMBER
//
// The `user` field deserves its own note. Because it is the membership id, two
// different members can never share a `rowScope`, and a given member's permission
// set — the only other input to the tier — is fixed for them. So the tier is
// captured transitively and does not need to be in the key itself. Impersonation
// rebases onto the TARGET's membership id, so two impersonation targets under one
// admin also get two different keys.
//
// These tests exercise the REAL fingerprint function, not a copy of it.

import { describe, expect, it } from 'vitest'
import { analyticsScopeFingerprint, type AnalyticsScopeSubject } from '@beaconhs/analytics/server'

const subject = (over: Partial<AnalyticsScopeSubject> = {}): AnalyticsScopeSubject => ({
  isSuperAdmin: false,
  permissions: () => true,
  siteIds: [],
  personId: 'person_1',
  tenantUserId: 'user_1',
  ...over,
})

const key = (over: Partial<AnalyticsScopeSubject> = {}) => analyticsScopeFingerprint(subject(over))

const A = '0a000000-0000-4000-8000-000000000001'
const B = '0b000000-0000-4000-8000-000000000002'

describe("insights cache key — the caller's native row scope", () => {
  it('A. the same caller with the same scope gets the same key', () => {
    expect(key({ siteIds: [A] })).toBe(key({ siteIds: [A] }))
  })

  it('B. a caller scoped to site A gets a distinct key from one scoped to site B', () => {
    expect(key({ siteIds: [A] })).not.toBe(key({ siteIds: [B] }))
  })

  it('C. site order in the Role Scope does not change the key', () => {
    // Two members can hold the same sites in a different insertion order; they must
    // still share a key, or the cache would miss on every request for one of them.
    expect(key({ siteIds: [A, B] })).toBe(key({ siteIds: [B, A] }))
  })

  it('D. an empty site list is still distinct from a real site list', () => {
    // A caller holding a non-`sites` scope resolves the `self` tier, not the site
    // tier, so their result is their own rows — never the tenant's.
    expect(key({ siteIds: [] })).not.toBe(key({ siteIds: [A] }))
  })

  it('E. two members never share a key, whatever else matches', () => {
    // The membership id makes the key per-member, which is what makes the tier
    // transitively safe: a given member's permission set cannot change under a
    // stable key.
    expect(key({ tenantUserId: 'user_1', siteIds: [A] })).not.toBe(
      key({ tenantUserId: 'user_2', siteIds: [A] }),
    )
  })

  it('F. two people with the same role and sites still get different keys', () => {
    // The `self` tier resolves to the caller's own person, so a shared key here
    // would serve one member's rows to the other.
    expect(key({ personId: 'p1', siteIds: [A] })).not.toBe(key({ personId: 'p2', siteIds: [A] }))
  })

  it('G. super-admin is distinct from a plain member with the same inputs', () => {
    expect(key({ isSuperAdmin: true, siteIds: [A] })).not.toBe(key({ siteIds: [A] }))
  })

  it('H. a null membership and a null person are encoded, not dropped', () => {
    // An API-key or service context has neither. They must still produce a
    // distinct, stable key rather than colliding with an all-null one.
    const bare = key({ tenantUserId: null, personId: null })
    expect(bare).not.toBe(key({ tenantUserId: 'user_1', personId: null }))
    expect(bare).toBe(key({ tenantUserId: null, personId: null }))
  })
})
