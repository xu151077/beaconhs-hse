import { describe, expect, it } from 'vitest'
import { DEFAULT_TENANT_REGION, TENANT_REGIONS, isTenantRegion } from './tenant-regions'

describe('tenant regions', () => {
  it('has unique values', () => {
    const values = TENANT_REGIONS.map((region) => region.value)
    expect(new Set(values).size).toBe(values.length)
  })

  it('includes the APAC regions a Malaysia deployment needs', () => {
    expect(isTenantRegion('ap-southeast-1')).toBe(true)
    expect(isTenantRegion('ap-southeast-2')).toBe(true)
    expect(isTenantRegion('ap-southeast-3')).toBe(true)
    expect(isTenantRegion('ap-southeast-4')).toBe(true)
  })

  it('includes mainland China regions', () => {
    expect(isTenantRegion('cn-north-1')).toBe(true)
    expect(isTenantRegion('cn-northwest-1')).toBe(true)
  })

  it('keeps the historical default selectable', () => {
    expect(isTenantRegion(DEFAULT_TENANT_REGION)).toBe(true)
  })

  it('rejects unknown values', () => {
    expect(isTenantRegion('xx-unknown-1')).toBe(false)
  })
})
