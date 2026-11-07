// PPE types with their pre-use and annual inspection criteria.
//
// Pure per-tenant reference data: the standard PPE catalogue and what an
// inspector checks on each item. No PPE ITEMS — the register of what a person
// actually holds is business data, seeded separately for demos only.
//
// PURE TENANT REFERENCE DATA. This module must never write `user`,
// `tenant_users`, `people`, `org_units`, `audit_log`, or any business
// record, and must never modify a row that already exists.
//
// Lifted out of `seed.ts`, which runs `main()` at module scope and so
// cannot be imported. Tenant provisioning and the demo seed both call
// this one implementation, so the catalogue has a single source of truth.

import type { SeedTx } from './types'
import { and, eq } from 'drizzle-orm'
import { ppeTypeInspectionCriteria, ppeTypes } from '../schema'

export type PpeTypeSeed = {
  name: string
  category: string
  sizing: string[] | null
  isInspectable: boolean
  everyDays?: number
  criteria: {
    kind: 'pre_use' | 'annual'
    question: string
    description?: string
    severity: 'low' | 'medium' | 'high' | 'critical'
    requiresPhoto?: boolean
  }[]
}

export const PPE_TYPES: PpeTypeSeed[] = [
  {
    name: 'Hard hat',
    category: 'head',
    sizing: ['S', 'M', 'L', 'XL'],
    isInspectable: true,
    everyDays: 30,
    criteria: [
      {
        kind: 'pre_use',
        question: 'Shell free of cracks, gouges, or sun damage?',
        description:
          'Inspect the entire outer shell for stress cracks, deep gouges, or chalky UV degradation.',
        severity: 'high',
        requiresPhoto: true,
      },
      {
        kind: 'pre_use',
        question: 'Suspension straps and crown intact, properly adjusted?',
        severity: 'medium',
      },
      {
        kind: 'pre_use',
        question: 'Chinstrap (if equipped) operates correctly?',
        severity: 'low',
      },
      {
        kind: 'pre_use',
        question: 'Date of manufacture within 5-year service life?',
        description:
          'Locate the inside-shell DOM stamp and confirm the helmet is still in service window.',
        severity: 'critical',
      },
      {
        kind: 'annual',
        question: 'Manufacturer-recommended pressure / drop test passed?',
        severity: 'critical',
        requiresPhoto: true,
      },
    ],
  },
  {
    name: 'Full-body harness',
    category: 'fall',
    sizing: ['S', 'M', 'L', 'XL'],
    isInspectable: true,
    everyDays: 30,
    criteria: [
      {
        kind: 'pre_use',
        question: 'Webbing free of cuts, fraying, or burns?',
        description: 'Flex the webbing into an inverted U and look for surface damage every 30 cm.',
        severity: 'critical',
        requiresPhoto: true,
      },
      {
        kind: 'pre_use',
        question: 'D-rings + buckles free of cracks, deformation, or corrosion?',
        severity: 'critical',
        requiresPhoto: true,
      },
      {
        kind: 'pre_use',
        question: 'Stitching intact (no cut, pulled, or loose threads)?',
        severity: 'high',
      },
      {
        kind: 'pre_use',
        question: 'Impact indicator on lanyard / SRL not deployed?',
        severity: 'critical',
      },
      {
        kind: 'pre_use',
        question: 'Labels legible and intact?',
        severity: 'medium',
      },
      {
        kind: 'annual',
        question: 'Annual third-party inspection certificate within 12 months?',
        severity: 'critical',
        requiresPhoto: true,
      },
      {
        kind: 'annual',
        question: 'Webbing tensile sample tested if required by jurisdiction?',
        severity: 'high',
      },
    ],
  },
  {
    name: 'Safety glasses',
    category: 'eye',
    sizing: null,
    isInspectable: true,
    everyDays: 30,
    criteria: [
      {
        kind: 'pre_use',
        question: 'Lenses free of cracks, deep scratches, or pitting?',
        severity: 'high',
      },
      {
        kind: 'pre_use',
        question: 'Side shields intact and securely attached?',
        severity: 'medium',
      },
      {
        kind: 'pre_use',
        question: 'Frame / temples not bent or broken?',
        severity: 'low',
      },
      {
        kind: 'pre_use',
        question: 'Anti-fog / mirror coating still functional (no flaking)?',
        severity: 'low',
      },
    ],
  },
  {
    name: 'Cut-resistant gloves',
    category: 'hand',
    sizing: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
    isInspectable: true,
    everyDays: 30,
    criteria: [
      {
        kind: 'pre_use',
        question: 'Outer shell free of cuts, holes, or punctures?',
        description: 'Pull gloves over your knuckles and inspect every finger pad.',
        severity: 'high',
        requiresPhoto: true,
      },
      {
        kind: 'pre_use',
        question: 'Stitching intact, no fingertips exposed?',
        severity: 'medium',
      },
      {
        kind: 'pre_use',
        question: "Cut rating (e.g. ANSI A4) appropriate for today's task?",
        severity: 'high',
      },
      {
        kind: 'pre_use',
        question: 'Cuff / wrist closure functioning correctly?',
        severity: 'low',
      },
    ],
  },
  {
    name: 'Reflective vest',
    category: 'body',
    sizing: ['S', 'M', 'L', 'XL', 'XXL'],
    isInspectable: true,
    everyDays: 30,
    criteria: [
      {
        kind: 'pre_use',
        question: 'Reflective bands intact, not peeling or cracked?',
        description:
          'Check every band front and back; a torn or lifting band loses most of its night visibility.',
        severity: 'high',
        requiresPhoto: true,
      },
      {
        kind: 'pre_use',
        question: 'Fabric free of tears, holes, or oil-soaked areas?',
        severity: 'medium',
      },
      {
        kind: 'pre_use',
        question: 'Zip, hook-and-loop, or ties still fasten securely?',
        severity: 'medium',
      },
      {
        kind: 'pre_use',
        question: 'Correct size to wear over the work clothes without restricting movement?',
        severity: 'low',
      },
    ],
  },
]

const inserted: { id: string; name: string }[] = []
export async function seedPpeTypesWithCriteria(
  tx: SeedTx,
  tenantId: string,
): Promise<{ id: string; name: string }[]> {
  const inserted: { id: string; name: string }[] = []
  for (const t of PPE_TYPES) {
    // Idempotency — skip if a type with this name already exists in the tenant.
    // A tenant that renamed the seeded name to its own language must not get a
    // duplicate: the seeded set has one type per category, so a type in the
    // same category is the seeded one under its new name. Its criteria are
    // still topped up below by question text.
    const byName = await tx
      .select()
      .from(ppeTypes)
      .where(and(eq(ppeTypes.tenantId, tenantId), eq(ppeTypes.name, t.name)))
      .limit(1)
    const byCategory = await tx
      .select()
      .from(ppeTypes)
      .where(and(eq(ppeTypes.tenantId, tenantId), eq(ppeTypes.category, t.category)))
      .limit(1)
    let typeRow = byName[0] ?? byCategory[0]
    if (!typeRow) {
      const rows = await tx
        .insert(ppeTypes)
        .values({
          tenantId,
          name: t.name,
          category: t.category,
          isInspectable: t.isInspectable,
          sizingScheme: t.sizing,
          inspectionSchedule: t.everyDays ? { everyDays: t.everyDays } : null,
        })
        .returning()
      typeRow = rows[0]
    }
    if (!typeRow) continue
    inserted.push({ id: typeRow.id, name: typeRow.name })

    // Insert criteria — skipping any that already exist (matched on question
    // text within type+kind) so repeated seeds are idempotent.
    const existingCriteria = await tx
      .select()
      .from(ppeTypeInspectionCriteria)
      .where(eq(ppeTypeInspectionCriteria.ppeTypeId, typeRow.id))
    const seen = new Set(existingCriteria.map((c: any) => `${c.inspectionKind}::${c.question}`))

    const byKindOrder = { pre_use: 1, annual: 1 }
    for (const c of t.criteria) {
      const key = `${c.kind}::${c.question}`
      if (seen.has(key)) {
        byKindOrder[c.kind]++
        continue
      }
      await tx.insert(ppeTypeInspectionCriteria).values({
        tenantId,
        ppeTypeId: typeRow.id,
        inspectionKind: c.kind,
        question: c.question,
        description: c.description ?? null,
        severity: c.severity,
        requiresPhoto: c.requiresPhoto ?? false,
        entityOrder: byKindOrder[c.kind]++,
      })
    }
  }

  console.log(
    `  · PPE types: ${inserted.length} seeded with criteria — ${inserted.map((i) => i.name).join(', ')}`,
  )
  return inserted
}
