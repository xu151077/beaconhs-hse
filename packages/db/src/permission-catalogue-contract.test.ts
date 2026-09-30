import { describe, expect, it } from 'vitest'
import { BUILTIN_ROLES, PERMISSION_CATALOGUE } from './schema'

/**
 * The permission catalogue is the single source of truth for authorization.
 * Everything else — role baselines, the analytics scope table, the API key
 * gates, generated cutover SQL — must be derived from it.
 *
 * These invariants exist because Phase 1.5 found two hand-maintained copies of
 * the key list, both of which had drifted (see
 * `docs/hse-verification-hardening.md`).
 */

const catalogue = PERMISSION_CATALOGUE as unknown as string[]
const catalogueSet = new Set(catalogue)
const baseline = (key: keyof typeof BUILTIN_ROLES) =>
  BUILTIN_ROLES[key]?.permissions as unknown as string[]

describe('permission catalogue integrity', () => {
  it('has no duplicate keys', () => {
    expect(catalogueSet.size).toBe(catalogue.length)
  })

  it('contains no empty or whitespace-only key', () => {
    const bad = catalogue.filter((key) => key.trim() !== key || key.length === 0)
    expect(bad).toEqual([])
  })

  it('gives tenant_admin the full catalogue', () => {
    expect([...baseline('tenant_admin')].sort()).toEqual([...catalogue].sort())
  })

  it('names every key as a lowercase dotted path with a module prefix', () => {
    // Structure only — the module list is deliberately NOT restated here, since a
    // hand-typed copy of the catalogue is the exact failure this file exists to
    // prevent. Hyphens are legal in non-first segments (`admin.api-keys.manage`).
    const bad = catalogue.filter(
      (key) => !/^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$/.test(key) || key.split('.').length < 2,
    )
    expect(bad).toEqual([])
  })

  it('uses only read tiers the visibility ladder can resolve', () => {
    // `resolveVisibilityTier` / `readTierCovers` in packages/tenant key off
    // `^(.+)\.read\.(all|site|self)$`. A family member with a tier outside that
    // set — `incidents.read.All`, `incidents.read.tenant` — would silently stop
    // being a tier at all and floor to `self`, so the module would quietly scope
    // to the caller's own rows instead of the granted tier.
    //
    // `others` is the deliberate hazid opt-in for reading another person's
    // assessment, so it is a legal tier here. Flat reads such as
    // `documents.read` are NOT tier families: their second-to-last segment is
    // not `read`, so this rule correctly leaves them alone.
    //
    // Note what is deliberately NOT asserted: that a family granting `read.all`
    // also lists `read.site`. It does not have to. `readTierCovers` derives the
    // weaker tiers at runtime (`training` grants `all` + `self` and no `site`),
    // so the catalogue records explicit grants and the ladder supplies the rest.
    const TIERS = new Set(['all', 'site', 'self', 'others'])
    const malformed = catalogue.filter((key) => {
      const parts = key.split('.')
      if (parts.length < 3 || parts[parts.length - 2] !== 'read') return false
      return !TIERS.has(parts[parts.length - 1]!)
    })
    expect(malformed).toEqual([])
  })
})

describe('built-in role baselines', () => {
  it('are a subset of the catalogue for every built-in role', () => {
    for (const [key, def] of Object.entries(BUILTIN_ROLES)) {
      const stray = (def.permissions as unknown as string[]).filter((p) => !catalogueSet.has(p))
      expect(stray, `role "${key}" holds keys outside the catalogue`).toEqual([])
    }
  })

  it('contain no duplicates within a role', () => {
    for (const [key, def] of Object.entries(BUILTIN_ROLES)) {
      const keys = def.permissions as unknown as string[]
      expect(new Set(keys).size, `role "${key}" repeats a key`).toBe(keys.length)
    }
  })

  it('keeps worker at own-PPE read only', () => {
    expect(baseline('worker')).toContain('ppe.read.self')
    expect(baseline('worker')).not.toContain('ppe.read.site')
    expect(baseline('worker')).not.toContain('ppe.read.all')
  })

  it('scopes a foreman to the site tier, matching its equipment read', () => {
    // A foreman's equipment read is site-scoped, so its PPE read must be too.
    // ppe.read.all here is a tenant-wide grant that convergeRolePermissions
    // would push into every built-in role of every existing tenant.
    expect(baseline('foreman')).toContain('ppe.read.site')
    expect(baseline('foreman')).not.toContain('ppe.read.all')
    expect(baseline('foreman')).toContain('equipment.read.site')
    // the write capabilities a foreman needs to run an inspection are unchanged
    expect(baseline('foreman')).toContain('ppe.issue')
    expect(baseline('foreman')).toContain('ppe.inspect')
  })

  it('keeps the register-wide PPE read on safety_manager', () => {
    expect(baseline('safety_manager')).toContain('ppe.read.all')
  })
})
