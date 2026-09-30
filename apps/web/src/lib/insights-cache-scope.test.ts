// 15B-2 — the insights card cache key must reflect the caller's Project Scope.
//
// `insights/_data.ts` keeps a process-level `CARD_RESULT_CACHE` (60 s TTL) keyed on
//
//     ${ctx.tenantId}:${access.scopeKey}:${trustScope}:${key}
//
// and the source comment already states that the scope in that key is load-bearing.
// Before 15B-2 the fingerprint only carried `sites` (from `{type:'sites'}` scopes),
// so a scope that derives from `people_assignments` was invisible to it: a user
// removed from a project kept being served that project's card rows for the TTL.
//
// These tests pin the eight cases the brief requires. They exercise the REAL
// fingerprint function, not a copy of it.

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

describe('insights cache key and Project Scope', () => {
  it('A. the same user with the same scope gets the same key', () => {
    expect(key({ orgUnitIds: [A], projectPersonIds: ['p1'] })).toBe(
      key({ orgUnitIds: [A], projectPersonIds: ['p1'] }),
    )
  })

  it('B. the same user scoped to project A gets a distinct A key', () => {
    const a = key({ orgUnitIds: [A] })
    expect(a).toContain(A)
  })

  it('C. the same user scoped to project B gets a DIFFERENT key from project A', () => {
    expect(key({ orgUnitIds: [B] })).not.toBe(key({ orgUnitIds: [A] }))
  })

  it('D. the same user scoped to A and B gets a third, different key', () => {
    const both = key({ orgUnitIds: [A, B] })
    expect(both).not.toBe(key({ orgUnitIds: [A] }))
    expect(both).not.toBe(key({ orgUnitIds: [B] }))
  })

  it('E. an EMPTY scope never shares a key with a restricted scope', () => {
    // An empty scope resolves to zero rows, so it must not reuse a real project's
    // cached result.
    expect(key({ orgUnitIds: [], projectPersonIds: [] })).not.toBe(key({ orgUnitIds: [A] }))
  })

  it('F. unrestricted, empty and restricted never share a key', () => {
    // Caught by this test: `unrestricted` and a scope that resolved to `empty`
    // both produce empty id lists, so without the discriminator a caller who can
    // see nothing would be served a company-wide cached result.
    const unrestricted = key({ projectScopeKind: 'unrestricted' })
    const empty = key({ projectScopeKind: 'empty', orgUnitIds: [], projectPersonIds: [] })
    const restricted = key({ projectScopeKind: 'restricted', orgUnitIds: [A] })
    const unknown = key()
    const all = new Set([unrestricted, empty, restricted, unknown])
    expect(all.size, 'all four scope states must have distinct keys').toBe(4)
    expect(unrestricted).not.toBe(empty)
  })

  it('G. REVOKING a project changes the key', () => {
    // The regression this exists for: the same user, the same role, one fewer
    // project. Before 15B-2 the key was unchanged and the stale rows were served.
    const before = key({ orgUnitIds: [A, B] })
    const after = key({ orgUnitIds: [A] })
    expect(after).not.toBe(before)
  })

  it('H. the user dimension still distinguishes two members of the same scope', () => {
    expect(key({ orgUnitIds: [A], tenantUserId: 'user_1' })).not.toBe(
      key({ orgUnitIds: [A], tenantUserId: 'user_2' }),
    )
  })

  it('canonicalises the ids: order and duplicates do not change the key', () => {
    // Unsorted Set iteration would make two identical scopes produce different
    // keys, which would silently defeat the cache for everyone.
    expect(key({ orgUnitIds: [B, A, A] })).toBe(key({ orgUnitIds: [A, B] }))
    expect(key({ projectPersonIds: ['p2', 'p1', 'p2'] })).toBe(
      key({ projectPersonIds: ['p1', 'p2'] }),
    )
  })

  it('a project scope does not disturb the pre-existing fingerprint fields', () => {
    // The `user`/`sites`/`super` dimensions must keep working exactly as before,
    // because the existing key was already correct for those.
    const withScope = key({ orgUnitIds: [A], tenantUserId: 'user_1' })
    const withoutScope = key({ tenantUserId: 'user_1' })
    expect(withScope).not.toBe(withoutScope)
    expect(key({ orgUnitIds: [A], isSuperAdmin: true })).not.toBe(key({ orgUnitIds: [A] }))
  })
})
