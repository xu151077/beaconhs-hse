// Phase 11-E (A. Calibration / B. Fire) — equipment + inspection seed breadth.
//
// The approved audit found that BeaconHS ALREADY expresses calibration as an
// `equipment_inspection_types` row: the demo tenant ships a "Calibration" type
// with five real pass/fail criteria against `Portable Gas Detector`. What is
// missing is BREADTH, not capability. So this file adds:
//
//   A. Calibration — instrument categories/types, each with its own calibration
//      inspection type and criteria, wired to the existing schedule → next_due_on
//      → compliance obligation chain.
//   B. Fire — a "Fire protection" equipment category with the five standard
//      fire-safety asset types, a monthly visual check and an annual service
//      check, plus a generic site `Fire Protection Inspection` type.
//
// NOTHING here is fire- or calibration-specific plumbing. No table, no enum, no
// permission, no RoleScope variant, no nav module, no flow profile, no
// scheduler. Every row goes into tables the platform already owns, and every one
// of them renders through existing screens with existing site scope, existing CA
// spawning and existing reporting.
//
// Two deliberate differences from `seedAtmosphericGasDetectorPilot`, which this
// file must NOT copy:
//
//   1. `equipment_types` is linked to its category by `category_id`, NOT by a
//      `category` string. The gas-detector pilot writes `category: 'safety'`,
//      which drizzle silently drops because no such column exists — leaving that
//      type with `category_id = NULL` and uncategorised in /equipment. (Recorded
//      as a pre-existing defect; not fixed here.) This file resolves `categoryId`
//      from the real row.
//
//   2. The gas-detector pilot returns early when its type exists, so it is
//      first-run-only by construction. This file is written to run for EVERY
//      tenant on EVERY seed and to be individually idempotent per row, matching
//      the per-tenant rule the Phase 11-C seed review established.

import { and, eq } from 'drizzle-orm'
import type { Database } from '../client'
import {
  equipmentCategories,
  equipmentInspectionCriteria,
  equipmentInspectionGroups,
  equipmentInspectionTypes,
  equipmentTypes,
} from '../schema'

/** The narrow slice of Drizzle this seed needs, matching the house convention. */
export type Phase11ETx = Pick<Database, 'select' | 'insert' | 'update'>

// `equipment_categories` is uniquely keyed by (tenantId, slug), so a category can
// be created with ON CONFLICT DO NOTHING and is then guaranteed to exist.
async function ensureEquipmentCategory(
  tx: Phase11ETx,
  tenantId: string,
  args: { slug: string; name: string; description: string; sortOrder: number },
): Promise<string> {
  const [inserted] = await tx
    .insert(equipmentCategories)
    .values({
      tenantId,
      slug: args.slug,
      name: args.name,
      description: args.description,
      sortOrder: args.sortOrder,
    })
    .onConflictDoNothing({ target: [equipmentCategories.tenantId, equipmentCategories.slug] })
    .returning({ id: equipmentCategories.id })
  if (inserted) return inserted.id
  const [existing] = await tx
    .select({ id: equipmentCategories.id })
    .from(equipmentCategories)
    .where(and(eq(equipmentCategories.tenantId, tenantId), eq(equipmentCategories.slug, args.slug)))
    .limit(1)
  if (!existing) throw new Error(`Failed to ensure equipment category "${args.slug}"`)
  return existing.id
}

// `equipment_types` has NO unique index on name, so every insert is guarded by an
// explicit lookup first. Relying on a conflict target here would insert a
// duplicate on every seed run.
async function ensureEquipmentType(
  tx: Phase11ETx,
  tenantId: string,
  args: { categoryId: string; name: string; description: string },
): Promise<string> {
  const [existing] = await tx
    .select({ id: equipmentTypes.id })
    .from(equipmentTypes)
    .where(and(eq(equipmentTypes.tenantId, tenantId), eq(equipmentTypes.name, args.name)))
    .limit(1)
  if (existing) {
    // Repair a type that exists but was never linked to a category. Idempotent
    // and safe: it only fills a null category_id.
    if (!args.categoryId) return existing.id
    const [full] = await tx
      .select({ categoryId: equipmentTypes.categoryId })
      .from(equipmentTypes)
      .where(eq(equipmentTypes.id, existing.id))
      .limit(1)
    if (full && isNullSafe(full.categoryId)) {
      await tx
        .update(equipmentTypes)
        .set({ categoryId: args.categoryId })
        .where(eq(equipmentTypes.id, existing.id))
    }
    return existing.id
  }
  const [inserted] = await tx
    .insert(equipmentTypes)
    .values({
      tenantId,
      name: args.name,
      categoryId: args.categoryId,
      description: args.description,
    })
    .returning({ id: equipmentTypes.id })
  if (!inserted) throw new Error(`Failed to ensure equipment type "${args.name}"`)
  return inserted.id
}

function isNullSafe(value: string | null | undefined): boolean {
  return value === null || value === undefined
}

type Criterion = {
  question: string
  kind: 'pass_fail' | 'pass_fail_na' | 'text' | 'numeric' | 'photo'
  severity: 'low' | 'medium' | 'high' | 'critical'
  critical?: boolean
  requiresPhoto?: boolean
  requiresComment?: boolean
}

/**
 * Ensure one `equipment_inspection_types` row plus its groups and criteria.
 *
 * Idempotent at three levels: the type is looked up by
 * (tenantId, appliesToTypeId, name); the groups by (type, label); and a criterion
 * by (type, group, question). A second seed run therefore adds nothing and
 * mutates nothing, while a type seeded with extra criteria later is still
 * topped up rather than duplicated.
 */
async function ensureEquipmentInspectionType(
  tx: Phase11ETx,
  tenantId: string,
  args: {
    appliesToTypeId: string
    name: string
    description: string
    intervalValue: number
    intervalUnit: 'day' | 'week' | 'month' | 'year'
    allowPassAll: boolean
    failsSpawnWorkOrders: boolean
    groups: { label: string; description: string; criteria: Criterion[] }[]
  },
): Promise<string> {
  const [existingType] = await tx
    .select({ id: equipmentInspectionTypes.id })
    .from(equipmentInspectionTypes)
    .where(
      and(
        eq(equipmentInspectionTypes.tenantId, tenantId),
        eq(equipmentInspectionTypes.appliesToTypeId, args.appliesToTypeId),
        eq(equipmentInspectionTypes.name, args.name),
      ),
    )
    .limit(1)

  let typeId = existingType?.id
  if (!typeId) {
    const [inserted] = await tx
      .insert(equipmentInspectionTypes)
      .values({
        tenantId,
        appliesToTypeId: args.appliesToTypeId,
        name: args.name,
        description: args.description,
        intervalValue: args.intervalValue,
        intervalUnit: args.intervalUnit,
        allowPassAll: args.allowPassAll,
        failsSpawnWorkOrders: args.failsSpawnWorkOrders,
        isActive: true,
      })
      .returning({ id: equipmentInspectionTypes.id })
    if (!inserted) throw new Error(`Failed to ensure equipment inspection type "${args.name}"`)
    typeId = inserted.id
  }

  for (let g = 0; g < args.groups.length; g += 1) {
    const group = args.groups[g]!
    const [existingGroup] = await tx
      .select({ id: equipmentInspectionGroups.id })
      .from(equipmentInspectionGroups)
      .where(
        and(
          eq(equipmentInspectionGroups.tenantId, tenantId),
          eq(equipmentInspectionGroups.inspectionTypeId, typeId),
          eq(equipmentInspectionGroups.label, group.label),
        ),
      )
      .limit(1)
    let groupId = existingGroup?.id
    if (!groupId) {
      const [inserted] = await tx
        .insert(equipmentInspectionGroups)
        .values({
          tenantId,
          inspectionTypeId: typeId,
          sequence: g,
          label: group.label,
          description: group.description,
        })
        .returning({ id: equipmentInspectionGroups.id })
      if (!inserted) throw new Error(`Failed to ensure inspection group "${group.label}"`)
      groupId = inserted.id
    }

    for (let c = 0; c < group.criteria.length; c += 1) {
      const criterion = group.criteria[c]!
      const [existingCriterion] = await tx
        .select({ id: equipmentInspectionCriteria.id })
        .from(equipmentInspectionCriteria)
        .where(
          and(
            eq(equipmentInspectionCriteria.tenantId, tenantId),
            eq(equipmentInspectionCriteria.inspectionTypeId, typeId),
            eq(equipmentInspectionCriteria.question, criterion.question),
          ),
        )
        .limit(1)
      if (existingCriterion) continue
      await tx.insert(equipmentInspectionCriteria).values({
        tenantId,
        inspectionTypeId: typeId,
        groupId,
        sequence: c,
        question: criterion.question,
        kind: criterion.kind,
        severity: criterion.severity,
        requiresPhoto: criterion.requiresPhoto ?? false,
        requiresComment: criterion.requiresComment ?? false,
        isRequired: true,
        isCritical: criterion.critical ?? false,
      })
    }
  }

  return typeId
}

// ---------------------------------------------------------------------------
// A. CALIBRATION
// ---------------------------------------------------------------------------
//
// Every entry below is an instrument whose calibration is a pass/fail check
// against a known reference. They differ only in what "against a known
// reference" means, which is exactly the shape the existing criteria model
// expresses. No new domain fields are invented: criteria are `pass_fail` with a
// severity and an `isCritical` flag, exactly as the seeded gas-detector
// calibration already does.

export const CALIBRATION_CATEGORY = {
  slug: 'instruments',
  name: 'Calibrated Instruments',
  description: 'Measuring instruments whose accuracy is verified against a reference.',
  sortOrder: 30,
}

export type CalibrationSpec = {
  type: string
  description: string
  intervalValue: number
  intervalUnit: 'month' | 'year'
  groupLabel: string
  groupDescription: string
  criteria: Criterion[]
  /** True when a failed check must raise a work order. */
  spawnWorkOrders: boolean
}

export const CALIBRATION_SPECS: CalibrationSpec[] = [
  {
    type: 'Pressure Gauge',
    description: 'Bourdon/bellows process or test gauge verified against a calibrated reference.',
    intervalValue: 12,
    intervalUnit: 'month',
    groupLabel: 'Calibration check',
    groupDescription: 'As-found indication against the reference gauge.',
    spawnWorkOrders: true,
    criteria: [
      {
        question: 'As-found indication agrees with the reference gauge within tolerance',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
        requiresComment: true,
      },
      {
        question: 'Zero / span adjustment verified and recorded',
        kind: 'pass_fail',
        severity: 'medium',
      },
      {
        question: 'Calibration certificate attached to the unit',
        kind: 'pass_fail',
        severity: 'high',
      },
    ],
  },
  {
    type: 'Torque Wrench',
    description: 'Calibrated torque wrench verified against a reference wrench.',
    intervalValue: 12,
    intervalUnit: 'month',
    groupLabel: 'Calibration check',
    groupDescription: 'Displayed torque against the reference instrument.',
    spawnWorkOrders: true,
    criteria: [
      {
        question: 'Displayed torque agrees with the reference within tolerance',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Setting scale legible and undamaged',
        kind: 'pass_fail',
        severity: 'medium',
      },
      {
        question: 'Calibration certificate attached to the unit',
        kind: 'pass_fail',
        severity: 'high',
      },
    ],
  },
  {
    type: 'Weight Set',
    description: 'Traceable test weights used to verify lifting and weighing equipment.',
    intervalValue: 24,
    intervalUnit: 'month',
    groupLabel: 'Calibration check',
    groupDescription: 'Mass verification against certified reference weights.',
    spawnWorkOrders: true,
    criteria: [
      {
        question: 'Each mass verified within tolerance and certificate valid',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Engraved mass markings legible on every piece',
        kind: 'pass_fail',
        severity: 'medium',
      },
    ],
  },
  {
    type: 'Vibration Meter',
    description: 'Handheld vibration meter for machine condition monitoring.',
    intervalValue: 12,
    intervalUnit: 'month',
    groupLabel: 'Calibration check',
    groupDescription: 'Response against a reference calibrator.',
    spawnWorkOrders: true,
    criteria: [
      {
        question: 'Accelerometer response within tolerance of the reference calibrator',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Overall velocity reading agrees within tolerance',
        kind: 'pass_fail',
        severity: 'high',
      },
      {
        question: 'Calibration certificate attached to the unit',
        kind: 'pass_fail',
        severity: 'medium',
      },
    ],
  },
  {
    type: 'Sound Level Meter',
    description: 'Class 1/2 sound level meter for noise exposure and compliance monitoring.',
    intervalValue: 24,
    intervalUnit: 'month',
    groupLabel: 'Calibration check',
    groupDescription: 'Acoustic calibrator check.',
    spawnWorkOrders: true,
    criteria: [
      {
        question: 'Reads 94 dB on the acoustic calibrator within tolerance',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Reads 114 dB on the acoustic calibrator within tolerance',
        kind: 'pass_fail',
        severity: 'high',
      },
      {
        question: 'Calibration certificate attached to the unit',
        kind: 'pass_fail',
        severity: 'medium',
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// B. FIRE
// ---------------------------------------------------------------------------

export const FIRE_CATEGORY = {
  slug: 'fire',
  name: 'Fire protection',
  description: 'Fire detection, suppression and emergency equipment.',
  sortOrder: 20,
}

export type FireTypeSpec = {
  type: string
  description: string
  visualCriteria: Criterion[]
  serviceCriteria: Criterion[]
}

export const FIRE_TYPE_SPECS: FireTypeSpec[] = [
  {
    type: 'Fire extinguisher',
    description: 'Portable fire extinguisher (water, foam, dry powder, CO₂).',
    visualCriteria: [
      {
        question: 'Seal and tamper tag intact',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Gauge reads in the green operating range',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Hose, horn and pin in good condition',
        kind: 'pass_fail',
        severity: 'high',
      },
      {
        question: 'Correct type and rating for the hazard it serves',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
        requiresPhoto: true,
      },
      {
        question: 'Mounted, visible and unobstructed',
        kind: 'pass_fail',
        severity: 'high',
        requiresPhoto: true,
      },
      {
        question: 'Inspection tag current and legible',
        kind: 'pass_fail',
        severity: 'medium',
      },
    ],
    serviceCriteria: [
      {
        question: 'Serviced by a competent certified contractor',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Pressure / charge verified in the operating range',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Hydrostatic test date within the required interval',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Service certificate attached to the unit',
        kind: 'pass_fail',
        severity: 'high',
      },
    ],
  },
  {
    type: 'Fire hose reel',
    description: 'Wall-mounted fire hose reel and its supply.',
    visualCriteria: [
      {
        question: 'Reel accessible, unlatched and not obstructed',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Valve / nozzle present and undamaged',
        kind: 'pass_fail',
        severity: 'high',
      },
      {
        question: 'Hose fully extended and free of kinks or splits',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Supply valve closed and capped',
        kind: 'pass_fail',
        severity: 'medium',
      },
    ],
    serviceCriteria: [
      {
        question: 'Annual flow / pressure test completed',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Nozzle and coupling threads serviceable',
        kind: 'pass_fail',
        severity: 'high',
      },
      {
        question: 'Test certificate attached to the unit',
        kind: 'pass_fail',
        severity: 'medium',
      },
    ],
  },
  {
    type: 'Fire alarm panel',
    description: 'Fire detection and alarm control panel.',
    visualCriteria: [
      {
        question: 'Panel shows normal healthy state with no active faults',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Battery and AC supply healthy',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Annunciator / zone indications legible',
        kind: 'pass_fail',
        severity: 'high',
        requiresPhoto: true,
      },
    ],
    serviceCriteria: [
      {
        question: 'Detection and alarm circuits tested end to end',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Battery capacity tested and within specification',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Strobe / horn audibility and visibility verified',
        kind: 'pass_fail',
        severity: 'high',
      },
      {
        question: 'Service certificate attached to the unit',
        kind: 'pass_fail',
        severity: 'high',
      },
    ],
  },
  {
    type: 'Emergency lighting',
    description: 'Battery-backed emergency luminaire or exit sign.',
    visualCriteria: [
      {
        question: 'Charge / test button function verified on duration test',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Lens and housing clean and undamaged',
        kind: 'pass_fail',
        severity: 'medium',
        requiresPhoto: true,
      },
      {
        question: 'Mounted securely and clearly visible from the escape route',
        kind: 'pass_fail',
        severity: 'high',
      },
    ],
    serviceCriteria: [
      {
        question: 'Full-duration discharge test passed',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Battery replacement date recorded where due',
        kind: 'pass_fail',
        severity: 'high',
      },
    ],
  },
  {
    type: 'Smoke detector',
    description: 'Addressable or conventional smoke / heat detector.',
    visualCriteria: [
      {
        question: 'Head clean, undamaged and correctly sited',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
        requiresPhoto: true,
      },
      {
        question: 'Indicator / test button accessible from the floor',
        kind: 'pass_fail',
        severity: 'high',
      },
      {
        question: 'No permanent obstruction, paint or damage to the sensing chamber',
        kind: 'pass_fail',
        severity: 'high',
        requiresPhoto: true,
      },
    ],
    serviceCriteria: [
      {
        question: 'Functional test performed and passed',
        kind: 'pass_fail',
        severity: 'critical',
        critical: true,
      },
      {
        question: 'Sensitivity within the manufacturer’s specified range',
        kind: 'pass_fail',
        severity: 'high',
      },
    ],
  },
]

export type Phase11ESeedCounts = {
  calibrationCategories: number
  calibrationTypes: number
  calibrationInspectionTypes: number
  fireCategories: number
  fireTypes: number
  fireInspectionTypes: number
}

/**
 * Seed Phase 11-E equipment breadth for one tenant.
 *
 * Idempotent at every level and safe to run for EVERY tenant on EVERY seed. No
 * sample equipment ITEMS are created: assets belong to the tenant, and seeding
 * fake extinguishers would put records in the field that no one owns.
 */
export async function seedPhase11EEquipment(
  tx: Phase11ETx,
  tenantId: string,
): Promise<Phase11ESeedCounts> {
  const counts: Phase11ESeedCounts = {
    calibrationCategories: 0,
    calibrationTypes: 0,
    calibrationInspectionTypes: 0,
    fireCategories: 0,
    fireTypes: 0,
    fireInspectionTypes: 0,
  }

  // --- A. Calibration -------------------------------------------------------
  const calibrationCategoryId = await ensureEquipmentCategory(tx, tenantId, CALIBRATION_CATEGORY)
  counts.calibrationCategories += 1

  for (const spec of CALIBRATION_SPECS) {
    const typeId = await ensureEquipmentType(tx, tenantId, {
      categoryId: calibrationCategoryId,
      name: spec.type,
      description: spec.description,
    })
    counts.calibrationTypes += 1
    await ensureEquipmentInspectionType(tx, tenantId, {
      appliesToTypeId: typeId,
      name: 'Calibration',
      description: 'Calibration against a certified reference. A failed check forces a work order.',
      intervalValue: spec.intervalValue,
      intervalUnit: spec.intervalUnit,
      allowPassAll: false,
      failsSpawnWorkOrders: spec.spawnWorkOrders,
      groups: [
        {
          label: spec.groupLabel,
          description: spec.groupDescription,
          criteria: spec.criteria,
        },
      ],
    })
    counts.calibrationInspectionTypes += 1
  }

  // --- B. Fire --------------------------------------------------------------
  const fireCategoryId = await ensureEquipmentCategory(tx, tenantId, FIRE_CATEGORY)
  counts.fireCategories += 1

  for (const spec of FIRE_TYPE_SPECS) {
    const typeId = await ensureEquipmentType(tx, tenantId, {
      categoryId: fireCategoryId,
      name: spec.type,
      description: spec.description,
    })
    counts.fireTypes += 1

    // Monthly visual check — the routine site walk, not a service visit.
    await ensureEquipmentInspectionType(tx, tenantId, {
      appliesToTypeId: typeId,
      name: 'Monthly visual check',
      description: 'Monthly in-service condition check of the unit.',
      intervalValue: 1,
      intervalUnit: 'month',
      allowPassAll: true,
      failsSpawnWorkOrders: true,
      groups: [
        {
          label: 'Visual check',
          description: 'In-service condition.',
          criteria: spec.visualCriteria,
        },
      ],
    })
    // Annual service — competent-person service with a certificate.
    await ensureEquipmentInspectionType(tx, tenantId, {
      appliesToTypeId: typeId,
      name: 'Annual service',
      description: 'Annual service by a competent person, with the certificate attached.',
      intervalValue: 1,
      intervalUnit: 'year',
      allowPassAll: false,
      failsSpawnWorkOrders: true,
      groups: [
        {
          label: 'Service check',
          description: 'Service verification.',
          criteria: spec.serviceCriteria,
        },
      ],
    })
    counts.fireInspectionTypes += 2
  }

  return counts
}
