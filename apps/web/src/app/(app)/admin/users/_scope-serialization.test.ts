import { describe, expect, it } from 'vitest'
import { toRoleScope } from './_scope-serialization'

describe('role scope serialization', () => {
  it('keeps the tenant-wide choice tenant-wide', () => {
    expect(toRoleScope({ type: 'tenant' })).toEqual({ type: 'tenant' })
  })

  it('keeps the self choice self', () => {
    expect(toRoleScope({ type: 'self' })).toEqual({ type: 'self' })
  })

  it('carries the ids for each multi-value scope', () => {
    expect(toRoleScope({ type: 'sites', siteIds: ['a'] })).toEqual({
      type: 'sites',
      siteIds: ['a'],
    })
    expect(toRoleScope({ type: 'crews', crewIds: ['b'] })).toEqual({
      type: 'crews',
      crewIds: ['b'],
    })
    expect(toRoleScope({ type: 'people', personIds: ['c'] })).toEqual({
      type: 'people',
      personIds: ['c'],
    })
    expect(toRoleScope({ type: 'team', departmentIds: ['d'], groupIds: ['e'] })).toEqual({
      type: 'team',
      departmentIds: ['d'],
      groupIds: ['e'],
    })
  })

  it('throws on an unknown type instead of silently downgrading to self', () => {
    expect(() => toRoleScope({ type: 'nonsense' as never })).toThrow(/Unknown scope type/)
  })
})
