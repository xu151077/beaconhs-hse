// PD-01 phase 2 — API credential authorization decision.
//
// Covers the thirteen behaviours the phase-2 brief requires. Everything here is
// the pure decision function; the DB predicates that feed it are asserted by the
// source-contract test at the bottom (a real-PG variant is out of scope until the
// read/write surfaces are switched in phase 3).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RoleScope } from '@beaconhs/db/schema'
import { authorizeApiCredential, type ApiCredentialRow, type ApiPrincipalRow } from './principal'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'

const credential = (over: Partial<ApiCredentialRow> = {}): ApiCredentialRow => ({
  id: 'key-1',
  tenantId: TENANT_A,
  principalTenantUserId: 'member-1',
  permissions: ['incidents.read.all', 'incidents.update.any'],
  scopes: null,
  ...over,
})

const principal = (over: Partial<ApiPrincipalRow> = {}): ApiPrincipalRow => ({
  id: 'member-1',
  tenantId: TENANT_A,
  userId: 'user-1',
  status: 'active',
  displayName: 'Pat Supervisor',
  ...over,
})

const access = (permissions: string[], scopes: RoleScope[] = [{ type: 'tenant' }]) => ({
  permissions: new Set(permissions),
  scopes,
})

describe('authorizeApiCredential', () => {
  it('1. accepts a valid binding and inherits principal access', () => {
    const result = authorizeApiCredential({
      credential: credential(),
      principal: principal(),
      access: access(['incidents.read.all', 'incidents.update.any', 'ppe.read.all']),
      personId: 'person-1',
      fallbackUserId: 'api_key:key-1',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bound).toBe(true)
    expect(result.userId).toBe('user-1')
    expect(result.personId).toBe('person-1')
    expect(result.membership).toEqual({ id: 'member-1', displayName: 'Pat Supervisor' })
    // Intersection, not union.
    expect([...result.permissions].sort()).toEqual(['incidents.read.all', 'incidents.update.any'])
  })

  it('2. rejects a principal from another tenant', () => {
    const result = authorizeApiCredential({
      credential: credential({ tenantId: TENANT_A }),
      principal: principal({ tenantId: TENANT_B }),
      access: access(['incidents.read.all']),
      personId: null,
      fallbackUserId: 'x',
    })
    expect(result).toEqual({ ok: false, reason: 'principal_tenant_mismatch' })
  })

  it('3. rejects a missing principal row', () => {
    expect(
      authorizeApiCredential({
        credential: credential(),
        principal: null,
        access: null,
        personId: null,
        fallbackUserId: 'x',
      }),
    ).toEqual({ ok: false, reason: 'principal_missing' })
  })

  it('3b. rejects a principal whose id does not match the credential binding', () => {
    expect(
      authorizeApiCredential({
        credential: credential({ principalTenantUserId: 'member-other' }),
        principal: principal(),
        access: access(['incidents.read.all']),
        personId: null,
        fallbackUserId: 'x',
      }),
    ).toEqual({ ok: false, reason: 'principal_missing' })
  })

  it('4. rejects an inactive principal', () => {
    expect(
      authorizeApiCredential({
        credential: credential(),
        principal: principal({ status: 'suspended' }),
        access: access(['incidents.read.all']),
        personId: null,
        fallbackUserId: 'x',
      }),
    ).toEqual({ ok: false, reason: 'principal_inactive' })
  })

  it('5. a principal with no remaining roles yields no permissions', () => {
    const result = authorizeApiCredential({
      credential: credential(),
      principal: principal(),
      access: access([]),
      personId: null,
      fallbackUserId: 'x',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Empty intersection: the credential authenticates but can do nothing, which
    // is the correct outcome after every role assignment is revoked.
    expect(result.permissions.size).toBe(0)
  })

  it('6. passes the principal RoleScope through when the credential does not narrow', () => {
    const scopes: RoleScope[] = [{ type: 'sites', siteIds: ['site-a'] }]
    const result = authorizeApiCredential({
      credential: credential({ scopes: null }),
      principal: principal(),
      access: access(['incidents.read.all'], scopes),
      personId: 'person-1',
      fallbackUserId: 'x',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scopes).toEqual(scopes)
  })

  it('7. passes personId through so self/people scopes resolve', () => {
    const result = authorizeApiCredential({
      credential: credential(),
      principal: principal(),
      access: access(['incidents.read.all'], [{ type: 'self' }]),
      personId: 'person-9',
      fallbackUserId: 'x',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.personId).toBe('person-9')
    expect(result.scopes).toEqual([{ type: 'self' }])
  })

  it('8. credential permissions cannot exceed the principal', () => {
    const result = authorizeApiCredential({
      credential: credential({ permissions: ['incidents.read.all', 'admin.users.manage'] }),
      principal: principal(),
      access: access(['incidents.read.all']),
      personId: null,
      fallbackUserId: 'x',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.permissions]).toEqual(['incidents.read.all'])
  })

  it('9. credential scopes cannot exceed the principal', () => {
    expect(
      authorizeApiCredential({
        credential: credential({ scopes: [{ type: 'tenant' }] }),
        principal: principal(),
        access: access(['incidents.read.all'], [{ type: 'sites', siteIds: ['site-a'] }]),
        personId: null,
        fallbackUserId: 'x',
      }),
    ).toEqual({ ok: false, reason: 'scope_exceeds_principal' })
  })

  it('10. distinguishes null (inherit) from [] (no scope)', () => {
    const inherited = authorizeApiCredential({
      credential: credential({ scopes: null }),
      principal: principal(),
      access: access(['incidents.read.all'], [{ type: 'self' }]),
      personId: null,
      fallbackUserId: 'x',
    })
    const none = authorizeApiCredential({
      credential: credential({ scopes: [] }),
      principal: principal(),
      access: access(['incidents.read.all'], [{ type: 'self' }]),
      personId: null,
      fallbackUserId: 'x',
    })
    expect(inherited.ok && inherited.scopes).toEqual([{ type: 'self' }])
    expect(none.ok && none.scopes).toEqual([])
  })

  it('11. keeps unbound credentials on the legacy tenant-wide path', () => {
    const result = authorizeApiCredential({
      credential: credential({ principalTenantUserId: null, scopes: null }),
      principal: null,
      access: null,
      personId: null,
      fallbackUserId: 'api_key:key-1',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bound).toBe(false)
    expect(result.userId).toBe('api_key:key-1')
    expect(result.scopes).toEqual([{ type: 'tenant' }])
    expect(result.personId).toBeNull()
    expect(result.membership).toBeNull()
    expect([...result.permissions]).toEqual(['incidents.read.all', 'incidents.update.any'])
  })

  it('12. ignores a spoofed tenant on the credential when the principal differs', () => {
    // The DB predicate pins tenant equality; this asserts the decision layer
    // refuses even if a caller managed to hand it mismatched rows.
    expect(
      authorizeApiCredential({
        credential: credential({ tenantId: TENANT_B }),
        principal: principal({ tenantId: TENANT_A }),
        access: access(['incidents.read.all']),
        personId: null,
        fallbackUserId: 'x',
      }),
    ).toEqual({ ok: false, reason: 'principal_tenant_mismatch' })
  })
})

describe('permission intersection & wildcard compatibility (L1)', () => {
  it('14. drops a wildcard grant the principal does not hold', () => {
    // Wildcards are not part of the API-key permission model: the catalogue has
    // no wildcard keys and sanitizeApiPermissions strips them from credentials.
    // The decision layer therefore only ever sees exact catalogue keys.
    const result = authorizeApiCredential({
      credential: credential({ permissions: ['incidents.read.all', 'incidents.*'] }),
      principal: principal(),
      access: access(['incidents.read.all']),
      personId: null,
      fallbackUserId: 'x',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.permissions]).toEqual(['incidents.read.all'])
  })

  it('15. keeps an identical wildcard key only via exact-match intersection', () => {
    // Compat: a wildcard string stored on BOTH the credential and the principal
    // survives as the literal key (downstream can() expands it). Behaviour is
    // unchanged by the L1 dead-branch removal.
    const result = authorizeApiCredential({
      credential: credential({ permissions: ['incidents.*'] }),
      principal: principal(),
      access: access(['incidents.*']),
      personId: null,
      fallbackUserId: 'x',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.permissions]).toEqual(['incidents.*'])
  })

  it('16. keeps an unbound credential permissions verbatim (legacy compatibility)', () => {
    const result = authorizeApiCredential({
      credential: credential({ principalTenantUserId: null, permissions: ['a.read', 'b.write'] }),
      principal: null,
      access: null,
      personId: null,
      fallbackUserId: 'api_key:key-1',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bound).toBe(false)
    expect([...result.permissions]).toEqual(['a.read', 'b.write'])
  })

  it('17. source contract: no wildcard branch in the decision; credentials are sanitized', () => {
    const decision = readFileSync(new URL('./principal.ts', import.meta.url), 'utf8')
    // L1: the unreachable wildcard branch is gone.
    expect(decision).not.toContain("endsWith('.*')")
    // Credentials never reach the decision with unsanitized permissions.
    const auth = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8')
    expect(auth).toContain('sanitizeApiPermissions(row.permissions')
  })
})

describe('auth wiring contract', () => {
  const source = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8')

  it('13. reads the principal inside the tenant-pinned, bypass-RLS transaction', () => {
    // The principal lookup must carry the tenant predicate; otherwise a forged
    // binding could load another tenant's membership row.
    expect(source).toContain('eq(tenantUsers.id, match.key.principalTenantUserId)')
    expect(source).toContain('eq(tenantUsers.tenantId, match.key.tenantId)')
    // Employee record resolution is tenant-pinned too (self/people scopes).
    expect(source).toContain('eq(people.tenantId, match.key.tenantId)')
    expect(source).toContain('eq(people.userId, member.userId)')
    // The context is built from the decision, never from the raw credential.
    expect(source).toContain('authorizeApiCredential({')
    expect(source).toContain('permissions: authorization.permissions')
    expect(source).toContain('scopes: authorization.scopes')
    expect(source).toContain('personId: authorization.personId')
    // A failed decision must throw, not degrade.
    expect(source).toContain('if (!authorization.ok)')
  })
})
