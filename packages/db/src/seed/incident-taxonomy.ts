// Incident taxonomy: classifications (hierarchical) and injury types.
//
// PURE TENANT REFERENCE DATA. This module writes `incident_classifications` and
// `incident_injury_types` and nothing else. It never touches `incidents`,
// `incident_injuries`, `incident_hours_periods`, `audit_log`, or any identity or
// org-unit table, and it never updates a row that already exists.
//
// Lifted out of `seed.ts`, which runs `main()` at module scope and so cannot be
// imported. Tenant provisioning and the demo seed both call this one
// implementation, so the taxonomy has a single source of truth.
//
// WHAT DELIBERATELY DOES NOT LIVE HERE
//
// `seed.ts` also does three things that are demo business data, not taxonomy, and
// which provisioning must never perform:
//
//   - assigning injury types to specific seeded injuries, keyed on hard-coded demo
//     references ('INC-2026-0002', 'INC-2026-0003');
//   - writing hours-worked windows with figures invented for a fictional ~40-person
//     crew, which would silently become a production tenant's TRIR denominator;
//   - back-filling `incidents.classification_id` on the demo incidents.
//
// Those stay in `seed.ts`. This module returns the name→id maps that the demo
// halves need, so the split costs them nothing.

import { eq } from 'drizzle-orm'
import { incidentClassifications, incidentInjuryTypes } from '../schema'
import type { SeedTx } from './types'

/**
 * The standard incident classification set: five top-level categories plus one
 * nested example, which is what makes the classification picker show a hierarchy
 * instead of a flat list. `parentName` defers the parent FK to a second pass.
 *
 * `isRecordable` drives the TRIR / OSHA-log rollup, so it is data, not decoration.
 * Exported so tests derive their expectations from this list rather than restating
 * it — a hard-coded copy in a test is how a catalogue change goes unnoticed.
 */
export const INCIDENT_CLASSIFICATION_SEED: readonly {
  name: string
  code: string
  description: string
  isRecordable: number
  parentName?: string
}[] = [
  { name: 'Injury', code: 'INJ', description: 'Personal injury — recordable.', isRecordable: 1 },
  { name: 'Illness', code: 'ILL', description: 'Occupational illness.', isRecordable: 1 },
  { name: 'Near miss', code: 'NM', description: 'No injury; loss potential.', isRecordable: 0 },
  {
    name: 'Property damage',
    code: 'PD',
    description: 'Damage to equipment, vehicle, or infrastructure.',
    isRecordable: 0,
  },
  {
    name: 'Environmental',
    code: 'ENV',
    description: 'Spill / release / emission.',
    isRecordable: 0,
  },
  {
    name: 'Slip, trip & fall',
    code: 'STF',
    description: 'Sub-category of injury.',
    isRecordable: 1,
    parentName: 'Injury',
  },
]

/**
 * The standard injury types a body of work actually records. Exported for the same
 * reason as the classification set above.
 */
export const INCIDENT_INJURY_TYPE_SEED: readonly {
  name: string
  oshaCode: string
  description: string
}[] = [
  { name: 'Laceration', oshaCode: 'CUT', description: 'Cut or tear of skin.' },
  {
    name: 'Contusion / bruise',
    oshaCode: 'CON',
    description: 'Blunt trauma without skin break.',
  },
  { name: 'Strain / sprain', oshaCode: 'STR', description: 'Soft-tissue stretch or tear.' },
  { name: 'Fracture', oshaCode: 'FRA', description: 'Bone break.' },
  { name: 'Burn — thermal', oshaCode: 'BRN', description: 'Heat-source burn.' },
  { name: 'Chemical exposure', oshaCode: 'CHM', description: 'Skin or inhalation exposure.' },
]

export type IncidentTaxonomy = {
  /** Classification name → id, for every row in `INCIDENT_CLASSIFICATION_SEED`. */
  classificationsByName: Map<string, string>
  /** Injury type name → id, for every row in `INCIDENT_INJURY_TYPE_SEED`. */
  injuryTypesByName: Map<string, string>
  /** Rows this call actually inserted. Zero on a re-run against a seeded tenant. */
  inserted: { classifications: number; injuryTypes: number }
}

/**
 * Key a classification by (parent, name), mirroring the
 * `incident_classifications_tenant_parent_name_ux` unique index.
 *
 * JSON encoding rather than string concatenation with a separator: a hand-picked
 * separator is only safe if you can prove it cannot occur in either column, and a
 * control character that genuinely cannot occur also cannot be typed in source
 * without turning the file binary to grep, diff and editors. `[parentId, name]` is
 * unambiguous by construction and costs nothing at six rows.
 */
function classificationKey(parentId: string | null, name: string): string {
  return JSON.stringify([parentId, name])
}

/**
 * Idempotently seed the incident taxonomy for one tenant.
 *
 * IDEMPOTENCY, and why this reads before it writes
 *
 * `incident_injury_types` has a plain `(tenant_id, name)` unique index and
 * `incident_classifications` has `(tenant_id, parent_id, name)`, so `ON CONFLICT DO
 * NOTHING` would cover both — except it would NOT cover top-level classifications.
 * `parent_id` is nullable and Postgres treats NULLs as distinct in a unique index, so
 * two root rows named 'Injury' do not conflict and the database will happily store
 * both. The read below is therefore load-bearing for roots, not belt-and-braces, and
 * the comment is here so nobody "simplifies" it into an upsert that quietly
 * duplicates the taxonomy.
 *
 * The read is also what makes re-running non-destructive of a tenant's own edits:
 * an admin who renamed a classification keeps their row and their id, and this
 * seeder links to it rather than restoring the standard text over the top.
 *
 * Concurrency: provisioning creates exactly one tenant, and `tenants.slug` is unique,
 * so two concurrent provisioners cannot both reach this function for the same
 * tenant. Within a tenant the worst case is one duplicate root row, which the read
 * above narrows but cannot fully exclude without a partial unique index — a schema
 * change, deliberately not made here.
 */
export async function seedIncidentTaxonomy(
  tx: SeedTx,
  tenantId: string,
): Promise<IncidentTaxonomy> {
  const existing = await tx
    .select({
      id: incidentClassifications.id,
      name: incidentClassifications.name,
      parentId: incidentClassifications.parentId,
    })
    .from(incidentClassifications)
    .where(eq(incidentClassifications.tenantId, tenantId))

  const classificationIds = new Map<string, string>()
  for (const row of existing) {
    classificationIds.set(classificationKey(row.parentId, row.name), row.id)
  }

  let classificationsInserted = 0
  let order = 10

  // Top level first: the nested rows need their parent's id to exist.
  for (const pass of ['root', 'child'] as const) {
    for (const c of INCIDENT_CLASSIFICATION_SEED) {
      const isChild = c.parentName !== undefined
      if ((pass === 'child') !== isChild) continue

      let parentId: string | null = null
      if (c.parentName) {
        const parent = classificationIds.get(classificationKey(null, c.parentName))
        if (!parent) {
          // Only reachable if the loop above failed to insert a parent it was asked
          // for. Fail loudly rather than writing an orphan root-shaped row.
          throw new Error(
            `incident_taxonomy: classification "${c.name}" references unknown parent "${c.parentName}"`,
          )
        }
        parentId = parent
      }

      if (classificationIds.has(classificationKey(parentId, c.name))) continue

      const [row] = await tx
        .insert(incidentClassifications)
        .values({
          tenantId,
          parentId,
          name: c.name,
          code: c.code,
          description: c.description,
          isRecordable: c.isRecordable,
          sortOrder: order,
        })
        .returning({ id: incidentClassifications.id })
      if (row) {
        classificationIds.set(classificationKey(parentId, c.name), row.id)
        classificationsInserted++
      }
      order += 10
    }
  }

  const injuryTypesByName = new Map<string, string>()
  const existingInjuryTypes = await tx
    .select({ id: incidentInjuryTypes.id, name: incidentInjuryTypes.name })
    .from(incidentInjuryTypes)
    .where(eq(incidentInjuryTypes.tenantId, tenantId))
  for (const row of existingInjuryTypes) {
    injuryTypesByName.set(row.name, row.id)
  }

  let injuryTypesInserted = 0
  for (const [index, t] of INCIDENT_INJURY_TYPE_SEED.entries()) {
    if (injuryTypesByName.has(t.name)) continue
    const [row] = await tx
      .insert(incidentInjuryTypes)
      .values({
        tenantId,
        name: t.name,
        oshaCode: t.oshaCode,
        description: t.description,
        sortOrder: (index + 1) * 10,
      })
      .returning({ id: incidentInjuryTypes.id })
    if (row) {
      injuryTypesByName.set(t.name, row.id)
      injuryTypesInserted++
    }
  }

  const classificationsByName = new Map<string, string>()
  for (const c of INCIDENT_CLASSIFICATION_SEED) {
    const parentId = c.parentName
      ? (classificationIds.get(classificationKey(null, c.parentName)) ?? null)
      : null
    const id = classificationIds.get(classificationKey(parentId, c.name))
    if (!id) {
      throw new Error(`incident_taxonomy: classification "${c.name}" has no id after seeding`)
    }
    classificationsByName.set(c.name, id)
  }

  return {
    classificationsByName,
    injuryTypesByName,
    inserted: { classifications: classificationsInserted, injuryTypes: injuryTypesInserted },
  }
}
