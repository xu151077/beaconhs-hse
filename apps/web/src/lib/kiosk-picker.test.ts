import { describe, expect, it } from 'vitest'
import { parseKioskPickerInput, parseKioskUnlockInput } from './kiosk-picker'

const TENANT_ID = '10000000-0000-4000-8000-000000000001'
const PERSON_ID = '20000000-0000-4000-8000-000000000002'

describe('people kiosk picker policy', () => {
  it('accepts exact, bounded PIN-gated searches', () => {
    expect(
      parseKioskPickerInput({
        tenantId: TENANT_ID.toUpperCase(),
        pin: ' 482913 ',
        kind: 'person',
        query: '  Alex ',
        selected: PERSON_ID.toUpperCase(),
      }),
    ).toEqual({
      tenantId: TENANT_ID,
      pin: '482913',
      kind: 'person',
      search: { query: 'Alex', selected: PERSON_ID },
    })
  })

  it('accepts only the three purpose-specific directories', () => {
    for (const kind of ['person', 'site', 'crew'] as const) {
      expect(
        parseKioskPickerInput({
          tenantId: TENANT_ID,
          pin: '482913',
          kind,
          query: '',
          selected: null,
        }).kind,
      ).toBe(kind)
    }
    expect(() =>
      parseKioskPickerInput({
        tenantId: TENANT_ID,
        pin: '482913',
        kind: 'tenant',
        query: '',
        selected: null,
      }),
    ).toThrow(/option type is invalid/)
  })

  it('rejects malformed PINs, identifiers, and augmented unlock requests', () => {
    expect(() => parseKioskUnlockInput({ tenantId: TENANT_ID, pin: '12' })).toThrow(/6–12 digits/)
    expect(() => parseKioskUnlockInput({ tenantId: 'bad', pin: '482913' })).toThrow(/invalid/)
    expect(() =>
      parseKioskUnlockInput({ tenantId: TENANT_ID, pin: '482913', includeDirectory: true }),
    ).toThrow(/invalid/)
    expect(() =>
      parseKioskPickerInput({
        tenantId: TENANT_ID,
        pin: '482913',
        kind: 'person',
        query: '',
        selected: null,
        scope: 'all',
      }),
    ).toThrow(/invalid/)
  })
})
