import { describe, expect, it } from 'vitest'
import { PERMISSION_CATALOGUE } from '@beaconhs/db/schema'
import { readPermissionForEntity } from './permissions'
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
  'incidents',
  'inspections',
  'hazid',
  'training',
  'documents',
  'equipment',
  'ppe',
  'corrective_actions',
] as const

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
    //
    // `compliance` and `apps` are excluded because they are a known, recorded
    // defect: they have no entry in READ_PERMISSION_BY_CATEGORY, so an API key
    // request against them throws ("POST /api/v1 returns 500"). Recorded in
    // AGENTS.md §Environment and tooling issues. Fixing it means adding a
    // permission grant, which is a business-authorization decision and out of
    // scope here — so these are listed rather than silently passed over. When
    // the defect is fixed, delete them from this list and the test will hold.
    const KNOWN_UNGATED = new Set(['compliance', 'apps'])
    const categories = [...new Set(REPORT_ENTITIES.map((entity) => entity.category))]

    const unmapped = categories.filter((category) => {
      if (KNOWN_UNGATED.has(category)) return false
      try {
        return !catalogueSet.has(readPermissionFor(category))
      } catch {
        return true
      }
    })
    expect(unmapped, 'report entity categories without a catalogue-backed read gate').toEqual([])
  })

  it('still reports the known-ungated categories, so the exclusion cannot go stale', () => {
    // If `compliance`/`apps` ever gain a read gate, this fails and tells us to
    // drop them from KNOWN_UNGATED above rather than leave a dead exclusion.
    const stillUngated = ['compliance', 'apps'].filter((category) => {
      try {
        readPermissionFor(category)
        return false
      } catch {
        return true
      }
    })
    expect(stillUngated).toEqual(['compliance', 'apps'])
  })

  it('assigns no duplicate permission to two categories', () => {
    // A duplicate would mean one role read grant silently covers two modules.
    const values = CATEGORIES.map(readPermissionFor)
    expect(new Set(values).size, 'two categories share one read permission').toBe(values.length)
  })

  it('gives each category a distinct read scope', () => {
    // Complements the duplicate check: asserts the map is not a constant.
    expect(new Set(CATEGORIES.map(readPermissionFor)).size).toBe(CATEGORIES.length)
  })
})

describe('readPermissionForEntity', () => {
  it('throws for an unmapped category rather than failing open', () => {
    expect(() => readPermissionFor('not_a_category')).toThrow(
      /No public API read permission mapped/,
    )
  })
})
