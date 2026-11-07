// HAZID libraries: hazard types, hazards, task libraries, and the assessment
// types that bind them together.
//
// Pure per-tenant reference data. No hazard ASSESSMENTS and no photos — those
// are records a site fills in.
//
// PURE TENANT REFERENCE DATA. This module must never write `user`,
// `tenant_users`, `people`, `org_units`, `audit_log`, or any business
// record, and must never modify a row that already exists.
//
// Lifted out of `seed.ts`, which runs `main()` at module scope and so
// cannot be imported. Tenant provisioning and the demo seed both call
// this one implementation, so the catalogue has a single source of truth.

import type { SeedTx } from './types'
import { seedHazardAssessmentAppTemplates } from './hazard-assessment-app-templates'
import { sql } from 'drizzle-orm'
import {
  hazidAssessmentTypeApps,
  hazidAssessmentTypePPE,
  hazidAssessmentTypeQuestions,
  hazidAssessmentTypes,
  hazidHazardSets,
  hazidHazardTypes,
  hazidHazards,
  hazidTasks,
} from '../schema'

export async function seedHazidLibraries(tx: SeedTx, tenantId: string): Promise<void> {
  const existing = await tx
    .select({ id: hazidHazardTypes.id })
    .from(hazidHazardTypes)
    .where(sql`${hazidHazardTypes.tenantId} = ${tenantId}`)
  if (existing.length > 0) {
    console.log(`  · hazid libraries: ${existing.length} hazard types already present, skipping`)
    return
  }

  const typeRows = await tx
    .insert(hazidHazardTypes)
    .values([
      { tenantId, name: 'Physical', color: '#ef4444' },
      { tenantId, name: 'Chemical', color: '#a855f7' },
      { tenantId, name: 'Biological', color: '#22c55e' },
      { tenantId, name: 'Ergonomic', color: '#0ea5e9' },
      { tenantId, name: 'Environmental', color: '#f59e0b' },
    ])
    .returning({ id: hazidHazardTypes.id, name: hazidHazardTypes.name })

  const byName: Record<string, string> = {}
  for (const r of typeRows) byName[r.name] = r.id

  const hazardRows = await tx
    .insert(hazidHazards)
    .values([
      {
        tenantId,
        name: 'Slip / trip',
        hazardTypeId: byName['Physical'],
        standardControls: 'Housekeeping; remove debris; mark wet floors.',
      },
      {
        tenantId,
        name: 'Falling object',
        hazardTypeId: byName['Physical'],
        standardControls: 'Toe-boards; hard hats; secure tools at height.',
      },
      {
        tenantId,
        name: 'Pinch point',
        hazardTypeId: byName['Physical'],
        standardControls: 'LOTO; guard installed; awareness training.',
      },
      {
        tenantId,
        name: 'Sharp edges',
        hazardTypeId: byName['Physical'],
        standardControls: 'Cut-resistant gloves; deburr; storage cages.',
      },
      {
        tenantId,
        name: 'Solvent exposure',
        hazardTypeId: byName['Chemical'],
        standardControls: 'Local exhaust; respirator per SDS; eye-wash station.',
      },
      {
        tenantId,
        name: 'Welding fumes',
        hazardTypeId: byName['Chemical'],
        standardControls: 'Fume extractor; PAPR for stainless/galv; SDS posted.',
      },
      {
        tenantId,
        name: 'Biohazard (bodily fluid)',
        hazardTypeId: byName['Biological'],
        standardControls: 'Universal precautions; disposable nitrile; biohazard kit.',
      },
      {
        tenantId,
        name: 'Heavy lifting',
        hazardTypeId: byName['Ergonomic'],
        standardControls: 'Mechanical aid; team lift > 25kg; rotation.',
      },
      {
        tenantId,
        name: 'Repetitive motion',
        hazardTypeId: byName['Ergonomic'],
        standardControls: 'Job rotation; ergonomic tooling; stretching protocol.',
      },
      {
        tenantId,
        name: 'Heat stress',
        hazardTypeId: byName['Environmental'],
        standardControls: 'Hydration station; mandated breaks; shaded rest area.',
      },
      {
        tenantId,
        name: 'Cold exposure',
        hazardTypeId: byName['Environmental'],
        standardControls: 'Insulated PPE; warming hut; buddy system.',
      },
      {
        tenantId,
        name: 'Noise > 85 dBA',
        hazardTypeId: byName['Physical'],
        standardControls: 'Hearing protection mandatory; audiometric testing.',
      },
    ])
    .returning({ id: hazidHazards.id, name: hazidHazards.name })

  // Hazard sets — pre-curated groupings
  const hazardSets = await tx
    .insert(hazidHazardSets)
    .values([
      {
        tenantId,
        name: 'Confined space entry',
        hazardIds: hazardRows
          .filter((h: any) => /slip|pinch|solvent|biohaz/i.test(h.name))
          .map((h: any) => h.id),
      },
      {
        tenantId,
        name: 'Outdoor work — summer',
        hazardIds: hazardRows
          .filter((h: any) => /heat|slip|repetitive|fall/i.test(h.name))
          .map((h: any) => h.id),
      },
      {
        tenantId,
        name: 'Welding / hot work',
        hazardIds: hazardRows
          .filter((h: any) => /weld|sharp|noise|fall/i.test(h.name))
          .map((h: any) => h.id),
      },
    ])
    .returning({ id: hazidHazardSets.id, name: hazidHazardSets.name })
  const hazardSetByName = new Map(hazardSets.map((s: any) => [s.name, s.id] as const))

  // Task library
  await tx.insert(hazidTasks).values([
    {
      tenantId,
      name: 'Set up barricades',
      description: 'Establish barrier perimeter before work begins.',
    },
    {
      tenantId,
      name: 'Lock out / tag out',
      description: 'Isolate energy sources, verify zero state.',
    },
    {
      tenantId,
      name: 'Pre-use inspection',
      description: 'Visual + functional inspection of every tool/PPE.',
    },
    { tenantId, name: 'Atmospheric test', description: 'Verify O₂ / LEL / H₂S / CO before entry.' },
    {
      tenantId,
      name: 'Rigging setup',
      description: 'Inspect slings, check WLL, verify anchor points.',
    },
    {
      tenantId,
      name: 'Hot work permit',
      description: 'Verify fire watch + extinguisher + clear combustibles.',
    },
    {
      tenantId,
      name: 'Don PPE',
      description: 'Confirm all crew has required PPE before entering zone.',
    },
    {
      tenantId,
      name: 'Tailboard meeting',
      description: 'Review JSA with crew; confirm understanding.',
    },
  ])

  const embeddedAppTemplates = await seedHazardAssessmentAppTemplates(tx, tenantId)

  // Assessment types — native JSHA structure plus embedded builder apps for
  // specialty procedures that need their own structure/workflow.
  const [fullType, minimalType, confinedType, arcFlashType] = await tx
    .insert(hazidAssessmentTypes)
    .values([
      {
        tenantId,
        name: 'Standard JSHA',
        description: 'Task-based Job Safety Hazard Analysis with PPE and questions.',
        style: 'task_based',
        hasPPE: true,
        hasQuestions: true,
      },
      {
        tenantId,
        name: 'Quick FLRA',
        description: 'Hazard-based Field-Level Risk Assessment — minimal sections, fast to fill.',
        style: 'hazard_based',
        hasPPE: true,
        hasQuestions: false,
        defaultHazardSetId: hazardSetByName.get('Outdoor work — summer') ?? null,
      },
      {
        tenantId,
        name: 'Confined Space JSHA',
        description:
          'Hazard-based JSHA plus an embedded confined-space entry app for readings, entry log, rescue planning, and sign-off.',
        style: 'hazard_based',
        hasPPE: true,
        hasQuestions: true,
        defaultHazardSetId: hazardSetByName.get('Confined space entry') ?? null,
      },
      {
        tenantId,
        name: 'Arc Flash JSHA',
        description:
          'Hazard-based JSHA plus an embedded arc-flash work-plan app for electrical boundaries, PPE, controls, and qualified sign-off.',
        style: 'hazard_based',
        hasPPE: true,
        hasQuestions: true,
        defaultHazardSetId: hazardSetByName.get('Welding / hot work') ?? null,
      },
    ])
    .returning({ id: hazidAssessmentTypes.id, name: hazidAssessmentTypes.name })

  // The insert above writes exactly these four rows in this order, so all four
  // slots come back populated. `noUncheckedIndexedAccess` cannot see that, and
  // the rest of this function indexes the four rows positionally — a short
  // result would otherwise surface much later as a confusing `undefined.id`.
  if (!fullType || !minimalType || !confinedType || !arcFlashType) {
    throw new Error('hazid_libraries: assessment-type insert returned fewer rows than were written')
  }

  await tx.insert(hazidAssessmentTypeApps).values([
    {
      tenantId,
      typeId: confinedType.id,
      templateId: embeddedAppTemplates.confinedSpaceTemplateId,
      key: 'confined_space_entry_plan',
      label: 'Confined-space entry app',
      description: 'Readings, entry log, rescue planning, and entry sign-off.',
      required: true,
      autoCreate: true,
      entityOrder: 1,
      config: { replacesNativeSection: 'confined_space' },
    },
    {
      tenantId,
      typeId: arcFlashType.id,
      templateId: embeddedAppTemplates.arcFlashTemplateId,
      key: 'arc_flash_work_plan',
      label: 'Arc-flash work-plan app',
      description: 'Electrical study details, controls, PPE, boundaries, and sign-off.',
      required: true,
      autoCreate: true,
      entityOrder: 1,
      config: { replacesNativeSection: 'arc_flash' },
    },
  ])

  const basePpe: Array<[string, boolean]> = [
    ['Hard hat', true],
    ['Safety glasses', true],
    ['Steel-toe boots', true],
    ['Hi-vis vest', true],
    ['Gloves (task-specific)', false],
    ['Hearing protection', false],
  ]
  const ppeRows = [fullType, minimalType, confinedType, arcFlashType].flatMap((type: any) =>
    basePpe.map(([name, required], i) => ({
      tenantId,
      typeId: type.id,
      name,
      required,
      entityOrder: i + 1,
    })),
  )
  ppeRows.push(
    {
      tenantId,
      typeId: fullType.id,
      name: 'Fall harness (if WAH)',
      required: false,
      entityOrder: 7,
    },
    {
      tenantId,
      typeId: confinedType.id,
      name: 'Respiratory protection (if required by atmosphere/SDS)',
      required: false,
      entityOrder: 7,
    },
    {
      tenantId,
      typeId: confinedType.id,
      name: 'Retrieval harness / lifeline',
      required: true,
      entityOrder: 8,
    },
    {
      tenantId,
      typeId: arcFlashType.id,
      name: 'Arc-rated FR clothing',
      required: true,
      entityOrder: 7,
    },
    {
      tenantId,
      typeId: arcFlashType.id,
      name: 'Voltage-rated gloves with leather protectors',
      required: true,
      entityOrder: 8,
    },
  )
  await tx.insert(hazidAssessmentTypePPE).values(ppeRows)

  const baseQuestions = [
    'Have all crew members reviewed this JSHA?',
    'Have all hazards been assessed and controlled?',
    'Is the work area clear and properly barricaded?',
    'Are emergency procedures known to all crew?',
  ]
  const questionRows = [fullType, confinedType, arcFlashType].flatMap((type: any) =>
    baseQuestions.map((question, i) => ({
      tenantId,
      typeId: type.id,
      question,
      questionType: 'yes_no' as const,
      requiresYes: true,
      entityOrder: i + 1,
    })),
  )
  questionRows.push(
    {
      tenantId,
      typeId: confinedType.id,
      question: 'Has the confined-space entry app been completed before entry?',
      questionType: 'yes_no' as const,
      requiresYes: true,
      entityOrder: 5,
    },
    {
      tenantId,
      typeId: arcFlashType.id,
      question: 'Has the arc-flash work-plan app been completed before electrical work?',
      questionType: 'yes_no' as const,
      requiresYes: true,
      entityOrder: 5,
    },
  )
  await tx.insert(hazidAssessmentTypeQuestions).values(questionRows)

  console.log(
    `  · hazid libraries: ${typeRows.length} hazard types, ${hazardRows.length} hazards, 3 sets, 8 tasks, 4 assessment types, 2 embedded apps`,
  )
}
