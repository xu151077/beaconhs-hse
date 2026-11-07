import { describe, expect, it } from 'vitest'
import { PERMISSION_CATALOGUE } from '@beaconhs/db/schema'
import { keyHasPermission, readPermissionForEntity } from './permissions'
import { REPORT_ENTITIES } from '@beaconhs/reports'

/**
 * The public REST API gates its read access with a category → permission map
 * (`READ_PERMISSION_BY_CATEGORY` in ./permissions.ts). The map is keyed by
 * strings and typed as `CataloguePermission`, but TypeScript cannot verify that a
 * hand-written entry names a key that actually exists — a typo would type-check
 * and then deny every read request for that category at runtime.
 *
 * These tests read the catalogue from the schema rather than restating it, so
 * they cannot drift the way the earlier hand-typed cutover lists did (see
 * docs/hse-verification-hardening.md).
 */

const catalogue = PERMISSION_CATALOGUE as unknown as string[]
const catalogueSet = new Set(catalogue)

/** The map is module-private; reach it through its only consumer. */
const readPermissionFor = (category: string): string => {
  const entity = { category } as unknown as Parameters<typeof readPermissionForEntity>[0]
  return readPermissionForEntity(entity)
}

const CATEGORIES = [
  'forms',
  'apps',
  'incidents',
  'inspections',
  'hazid',
  'training',
  'documents',
  'equipment',
  'ppe',
  'corrective_actions',
  'compliance',
] as const

/**
 * Categories that intentionally share one gate because they expose the same
 * module and the same underlying rows. `apps` is the monitored-session runtime
 * view over `form_responses`; `forms` is the Builder response surface over the
 * same table. Granting `forms.response.read.all` must reach both, exactly as the
 * Builder apps API already does.
 */
const SAME_MODULE_SHARED_GATE = {
  'forms.response.read.all': ['forms', 'apps'],
} as const

describe('READ_PERMISSION_BY_CATEGORY catalogue invariant', () => {
  it('maps every category the public API exposes', () => {
    for (const category of CATEGORIES) {
      expect(
        readPermissionFor(category),
        `no read permission mapped for "${category}"`,
      ).toBeTruthy()
    }
  })

  it('only names permission keys that exist in PERMISSION_CATALOGUE', () => {
    // The point of the test: a typo in the map cannot pass.
    const unknown = CATEGORIES.filter((category) => !catalogueSet.has(readPermissionFor(category)))
    expect(unknown, 'categories mapped to a key that is not in the catalogue').toEqual([])
  })

  it('holds for every report entity category with an API read gate', () => {
    // Guards against a new entity category being added without a read gate.
    const categories = [...new Set(REPORT_ENTITIES.map((entity) => entity.category))]

    const unmapped = categories.filter((category) => {
      try {
        return !catalogueSet.has(readPermissionFor(category))
      } catch {
        return true
      }
    })
    expect(unmapped, 'report entity categories without a catalogue-backed read gate').toEqual([])
  })

  it('shares one gate only across categories that expose the same module', () => {
    // One role grant must not silently cover two unrelated modules. The only
    // permitted duplicate is the documented `forms` / `apps` pair, which reads
    // the same `form_responses` rows.
    const byPermission = new Map<string, string[]>()
    for (const category of CATEGORIES) {
      const permission = readPermissionFor(category)
      byPermission.set(permission, [...(byPermission.get(permission) ?? []), category])
    }
    const shared = Object.fromEntries(
      [...byPermission].filter(([, categories]) => categories.length > 1),
    )
    expect(shared).toEqual(SAME_MODULE_SHARED_GATE)
  })
})

describe('readPermissionForEntity', () => {
  it('throws for an unmapped category rather than failing open', () => {
    expect(() => readPermissionFor('not_a_category')).toThrow(
      /No public API read permission mapped/,
    )
  })
})

describe('the Builder-backed report projections publish through the forms gate', () => {
  const entityFor = (key: string) =>
    REPORT_ENTITIES.find((entity) => entity.key === key) as unknown as Parameters<
      typeof readPermissionForEntity
    >[0]

  for (const key of ['environmental_monitoring', 'statutory_compliance']) {
    it(`${key} is gated on the existing forms.response.read.all`, () => {
      // Both read `form_responses`, so they inherit the exact permission a Builder
      // reader already holds. No new category and no new permission key: a key granted
      // `forms.response.read.all` reaches the app's own responses and these two views
      // of the same rows, which is the intent.
      expect(readPermissionForEntity(entityFor(key))).toBe('forms.response.read.all')
    })

    it(`${key} is refused without that permission, and never fails open`, () => {
      const entity = entityFor(key)
      expect(keyHasPermission([], 'forms.response.read.all')).toBe(false)
      expect(keyHasPermission(['ca.read.all'], 'forms.response.read.all')).toBe(false)
      expect(keyHasPermission(['forms.response.read.all'], 'forms.response.read.all')).toBe(true)
      expect(keyHasPermission(['forms.response.*'], 'forms.response.read.all')).toBe(true)
      // The gate is derived, never read off the entity, so an entity cannot opt itself in.
      expect(entity.category).toBe('forms')
    })
  }

  it('gates monitored sessions on the Builder app read permission', () => {
    // `monitored_sessions` (category `apps`) is a view over the same
    // `form_responses` rows the Builder apps API already exposes, so it uses the
    // same read grant rather than a parallel permission ladder. Before EA-12 the
    // category was unmapped, which made `/api/v1` discovery and
    // `/api/v1/monitored_sessions` throw a 500.
    const entity = entityFor('monitored_sessions')
    expect(entity.category).toBe('apps')
    expect(readPermissionForEntity(entity)).toBe('forms.response.read.all')
    expect(keyHasPermission(['forms.response.read.all'], 'forms.response.read.all')).toBe(true)
    expect(keyHasPermission(['forms.response.*'], 'forms.response.read.all')).toBe(true)
    expect(keyHasPermission([], 'forms.response.read.all')).toBe(false)
    expect(keyHasPermission(['incidents.read.all'], 'forms.response.read.all')).toBe(false)
  })
})
