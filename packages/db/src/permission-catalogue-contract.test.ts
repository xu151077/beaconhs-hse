import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  AUDIT_DEFAULT_UNGRANTED,
  BUILTIN_ROLES,
  PERMISSION_CATALOGUE,
  type CataloguePermission,
} from './schema'

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

  it('gives tenant_admin the whole catalogue except the PD-02 audit keys', () => {
    // tenant_admin = catalogue minus AUDIT_DEFAULT_UNGRANTED: cross-tenant audit
    // reads/approvals are grant-scoped platform capabilities (V3 P-4/P-5) and
    // must never ride along with the admin role.
    expect([...baseline('tenant_admin')].sort()).toEqual(
      catalogue
        .filter((key) => !(AUDIT_DEFAULT_UNGRANTED as readonly string[]).includes(key))
        .sort(),
    )
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
    // PD-02 audit read keys are NOT visibility-ladder tiers: they are
    // platform-level gates checked against `audit_access_grants` scope
    // ('tenant' = one tenant's trail, 'platform' = cross-tenant), never through
    // resolveVisibilityTier/readTierCovers. Allowed explicitly here so the
    // ladder rule stays strict for every other family.
    const AUDIT_READ_KEYS = new Set(['audit.read.tenant', 'audit.read.platform'])
    const malformed = catalogue.filter((key) => {
      if (AUDIT_READ_KEYS.has(key)) return false
      const parts = key.split('.')
      if (parts.length < 3 || parts[parts.length - 2] !== 'read') return false
      return !TIERS.has(parts[parts.length - 1]!)
    })
    expect(malformed).toEqual([])
  })
})

describe('every permission referenced by a registry exists in the catalogue', () => {
  // D1: `nav/registry.ts` and `module-admin/registry.ts` both named
  // `equipment.read.self`, which is not a catalogue key. It happened to work
  // because `readTierCovers` resolves a `.read.all`/`.read.site` holder to the
  // weaker `.read.self` key, so the gate behaved correctly by accident and no
  // test failed. A catalogue-driven audit cannot verify such a key at all.
  //
  // These read the references straight out of the registries and compare them to
  // the real catalogue. No second key list is kept here — that is the whole
  // failure mode this file exists to prevent.
  const readFile = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

  const registryDir = '../../../apps/web/src/lib'

  it('holds for every nav requiredPermission', () => {
    const nav = readFile(`${registryDir}/nav/registry.ts`)
    const referenced = [...nav.matchAll(/requiredPermission: '([^']+)'/g)].map((m) => m[1]!)
    expect(referenced.length, 'nav requiredPermission references found').toBeGreaterThan(0)
    const unknown = referenced.filter((key) => !catalogueSet.has(key))
    expect(unknown, 'nav entries naming a key outside PERMISSION_CATALOGUE').toEqual([])
  })

  it('holds for every module-admin permission reference', () => {
    const registry = readFile(`${registryDir}/module-admin/registry.ts`)
    const referenced = [...registry.matchAll(/permission: '([^']+)'/g)].map((m) => m[1]!)
    expect(referenced.length, 'module-admin permission references found').toBeGreaterThan(0)
    const unknown = referenced.filter((key) => !catalogueSet.has(key))
    expect(unknown, 'module-admin entries naming a key outside PERMISSION_CATALOGUE').toEqual([])
  })

  it('no longer names the equipment self tier that D1 recorded', () => {
    // Kept as an explicit regression so the fix cannot be undone by re-adding the
    // key to one registry only.
    const nav = readFile(`${registryDir}/nav/registry.ts`)
    const registry = readFile(`${registryDir}/module-admin/registry.ts`)
    expect(nav).not.toContain("requiredPermission: 'equipment.read.self'")
    expect(registry).not.toContain("permission: 'equipment.read.self'")
    // …and the real replacement is the key that does exist.
    expect(catalogueSet.has('equipment.read.site')).toBe(true)
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
