// PD-01 Phase 3 专项 B — PURE LOGIC tests for the create-time scope guard.
// No database, no HTTP, no mocks: `assertCreateInScope` only reads the
// request context and the fixed entity map. Reported as its own test layer.

import { describe, expect, it } from 'vitest'
import type { RequestContext } from '@beaconhs/tenant'
import { assertCreateInScope } from './scope'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SITE_A = '550e8400-e29b-41d4-a716-446655440000'
const SITE_B = '660e8400-e29b-41d4-a716-446655440001'
const ME = 'aaaaaaaa-0000-4000-8000-0000000000a1'
const OTHER = 'bbbbbbbb-0000-4000-8000-0000000000b2'
const MY_PERSON = 'cccccccc-0000-4000-8000-0000000000c3'
const OTHER_PERSON = 'dddddddd-0000-4000-8000-0000000000d4'

function ctx(overrides: {
  scopes: RequestContext['scopes']
  membershipId?: string | null
  personId?: string | null
}): RequestContext {
  return {
    tenantId: TENANT,
    scopes: overrides.scopes,
    membership: overrides.membershipId ? { id: overrides.membershipId, displayName: 'me' } : null,
    personId: overrides.personId ?? null,
    permissions: new Set<string>(),
  } as unknown as RequestContext
}

describe('assertCreateInScope (pure logic)', () => {
  it('1. tenant scope stays compatible for every entity and body', () => {
    const c = ctx({ scopes: [{ type: 'tenant' }] })
    expect(() => assertCreateInScope(c, 'form_responses', {})).not.toThrow()
    expect(() => assertCreateInScope(c, 'documents', {})).not.toThrow()
    expect(() => assertCreateInScope(c, 'corrective_actions', {})).not.toThrow()
    expect(() => assertCreateInScope(c, 'training_records', {})).not.toThrow()
  })

  it('2. sites scope on an unmapped entity is refused (B-1)', () => {
    const c = ctx({ scopes: [{ type: 'sites', siteIds: [SITE_A] }] })
    expect(() => assertCreateInScope(c, 'form_responses', { siteOrgUnitId: SITE_A })).toThrow(
      /cannot create/i,
    )
  })

  it('3. sites scope on an entity with no site column fails closed', () => {
    const c = ctx({ scopes: [{ type: 'sites', siteIds: [SITE_A] }] })
    expect(() => assertCreateInScope(c, 'documents', { title: 'x' })).toThrow(
      /without a site scope/i,
    )
    expect(() => assertCreateInScope(c, 'training_records', { personId: MY_PERSON })).toThrow(
      /without a site scope/i,
    )
  })

  it('4. sites scope may create corrective_actions at its own site only', () => {
    const c = ctx({ scopes: [{ type: 'sites', siteIds: [SITE_A] }] })
    expect(() =>
      assertCreateInScope(c, 'corrective_actions', { title: 'x', siteOrgUnitId: SITE_A }),
    ).not.toThrow()
    expect(() =>
      assertCreateInScope(c, 'corrective_actions', { title: 'x', siteOrgUnitId: SITE_B }),
    ).toThrow(/outside its site scope/i)
    expect(() => assertCreateInScope(c, 'corrective_actions', { title: 'x' })).toThrow(
      /outside its site scope/i,
    )
  })

  it('5. self scope may create a document owned by the principal only', () => {
    const c = ctx({ scopes: [{ type: 'self' }], membershipId: ME })
    expect(() =>
      assertCreateInScope(c, 'documents', { title: 'x', ownerTenantUserId: ME }),
    ).not.toThrow()
    expect(() =>
      assertCreateInScope(c, 'documents', { title: 'x', ownerTenantUserId: OTHER }),
    ).toThrow(/for another owner/i)
    expect(() => assertCreateInScope(c, 'documents', { title: 'x' })).toThrow(/for another owner/i)
  })

  it('6. self scope may create a training record for its own person only', () => {
    const c = ctx({
      scopes: [{ type: 'self' }],
      membershipId: ME,
      personId: MY_PERSON,
    })
    expect(() => assertCreateInScope(c, 'training_records', { personId: MY_PERSON })).not.toThrow()
    expect(() => assertCreateInScope(c, 'training_records', { personId: OTHER_PERSON })).toThrow(
      /for another person/i,
    )
  })

  it('7. self scope with no linked person fails closed on training_records', () => {
    const c = ctx({ scopes: [{ type: 'self' }], membershipId: ME, personId: null })
    expect(() => assertCreateInScope(c, 'training_records', { personId: MY_PERSON })).toThrow(
      /for another person/i,
    )
  })

  it('8. self scope cannot create corrective_actions (site scope not carried)', () => {
    const c = ctx({ scopes: [{ type: 'self' }], membershipId: ME })
    expect(() =>
      assertCreateInScope(c, 'corrective_actions', {
        title: 'x',
        siteOrgUnitId: SITE_A,
        ownerTenantUserId: ME,
      }),
    ).toThrow(/outside its site scope/i)
  })
})
