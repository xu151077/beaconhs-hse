// Training assessment types with their question banks.
//
// Pure per-tenant reference data. No assessment ATTEMPTS — those are learner
// records, seeded separately for demos only.
//
// PURE TENANT REFERENCE DATA. This module must never write `user`,
// `tenant_users`, `people`, `org_units`, `audit_log`, or any business
// record, and must never modify a row that already exists.
//
// Lifted out of `seed.ts`, which runs `main()` at module scope and so
// cannot be imported. Tenant provisioning and the demo seed both call
// this one implementation, so the catalogue has a single source of truth.

import type { SeedTx } from './types'
import { eq } from 'drizzle-orm'
import {
  trainingAssessmentTypeQuestions,
  trainingAssessmentTypes,
  trainingCourses,
} from '../schema'

export async function seedTrainingAssessmentTypes(tx: SeedTx, tenantId: string): Promise<void> {
  const existing = await tx
    .select({ id: trainingAssessmentTypes.id })
    .from(trainingAssessmentTypes)
    .where(eq(trainingAssessmentTypes.tenantId, tenantId))
    .limit(1)
  if (existing.length > 0) {
    console.log(`  · training assessment types: already seeded for tenant ${tenantId}, skipping`)
    return
  }

  // Try to find the WHMIS course so we can link the quiz to it (passing the
  // quiz then auto-creates a training_records row).
  const [whmisCourse] = await tx
    .select({ id: trainingCourses.id })
    .from(trainingCourses)
    .where(eq(trainingCourses.tenantId, tenantId))
    .limit(50)
  // Find by code if multiple
  let whmisId: string | null = null
  const allCourses = await tx
    .select({ id: trainingCourses.id, code: trainingCourses.code })
    .from(trainingCourses)
    .where(eq(trainingCourses.tenantId, tenantId))
  for (const c of allCourses) {
    if (c.code === 'WHMIS') {
      whmisId = c.id
      break
    }
  }
  // Fallback to the first returned course (rare; only if the WHMIS row isn't
  // present)
  if (!whmisId && whmisCourse) whmisId = whmisCourse.id

  // --- WHMIS quiz ----------------------------------------------------------
  const [whmis] = await tx
    .insert(trainingAssessmentTypes)
    .values({
      tenantId,
      name: 'WHMIS 2015 quiz',
      description:
        'Five-question knowledge check covering WHMIS pictograms, safety data sheets, and supplier vs workplace labels.',
      passingScore: 80,
      courseId: whmisId,
      preAssessmentMessage:
        'Answer all five questions. You need 80% to pass. Passing this quiz will record completion of WHMIS 2015 for you automatically.',
      postAssessmentMessage:
        'Thanks for completing the WHMIS quiz. If you passed, your training record has been updated.',
      graded: true,
      active: true,
    })
    .returning()
  if (whmis) {
    const whmisQuestions = [
      {
        prompt:
          'What does the "skull and crossbones" WHMIS 2015 pictogram indicate about a material?',
        kind: 'single_choice' as const,
        options: [
          { value: 'A', label: 'Acute toxicity (can cause death or serious harm at low doses)' },
          { value: 'B', label: 'Mildly irritating to the skin' },
          { value: 'C', label: 'Environmental damage only' },
          { value: 'D', label: 'Flammable liquid' },
        ],
        correctAnswer: 'A',
        points: 1,
      },
      {
        prompt: 'A workplace label is required when',
        kind: 'single_choice' as const,
        options: [
          {
            value: 'A',
            label: 'A controlled product is decanted into another container at the workplace',
          },
          { value: 'B', label: 'A product is sold to another company' },
          { value: 'C', label: 'A product is stored unopened in original packaging' },
          { value: 'D', label: 'None of the above' },
        ],
        correctAnswer: 'A',
        points: 1,
      },
      {
        prompt: 'Safety data sheets (SDS) must be readily available to all workers.',
        kind: 'true_false' as const,
        options: null,
        correctAnswer: 'true',
        points: 1,
      },
      {
        prompt: 'Which sections of the SDS are most relevant during an emergency?',
        kind: 'multi_choice' as const,
        options: [
          { value: 'A', label: 'Section 4: First-aid measures' },
          { value: 'B', label: 'Section 5: Firefighting measures' },
          { value: 'C', label: 'Section 6: Accidental release measures' },
          { value: 'D', label: 'Section 16: Other information' },
        ],
        correctAnswer: 'A,B,C',
        points: 2,
      },
      {
        prompt:
          'How long must a worker complete WHMIS training before being allowed to work with controlled products?',
        kind: 'text' as const,
        options: null,
        correctAnswer: null,
        points: 1,
      },
    ]
    let order = 1
    for (const q of whmisQuestions) {
      await tx.insert(trainingAssessmentTypeQuestions).values({
        tenantId,
        typeId: whmis.id,
        prompt: q.prompt,
        kind: q.kind,
        options: q.options,
        correctAnswer: q.correctAnswer,
        points: q.points,
        entityOrder: order++,
        mandatory: true,
      })
    }
  }

  // --- Basic Safety Quiz (course-agnostic) ---------------------------------
  const [basic] = await tx
    .insert(trainingAssessmentTypes)
    .values({
      tenantId,
      name: 'Basic site safety quiz',
      description:
        'General safety awareness quiz — hazard recognition, PPE basics, near-miss reporting, and emergency procedures. Useful as part of a site induction.',
      passingScore: 70,
      courseId: null,
      preAssessmentMessage:
        'Eight short questions. You need 70% to pass. There is no course linked to this quiz — it is purely a competency check.',
      postAssessmentMessage:
        'Thanks for completing the basic safety quiz. Review any questions you got wrong with your supervisor.',
      graded: true,
      active: true,
    })
    .returning()
  if (basic) {
    const basicQuestions = [
      {
        prompt: 'What should you do immediately after a near-miss incident?',
        kind: 'single_choice' as const,
        options: [
          { value: 'A', label: 'Keep working and forget about it' },
          { value: 'B', label: 'Report it to your supervisor as soon as possible' },
          { value: 'C', label: 'Only report it if it happens again' },
          { value: 'D', label: 'Discuss it with co-workers only' },
        ],
        correctAnswer: 'B',
        points: 1,
      },
      {
        prompt:
          'Hard hats must be worn whenever overhead work is occurring within a barricaded area.',
        kind: 'true_false' as const,
        options: null,
        correctAnswer: 'true',
        points: 1,
      },
      {
        prompt:
          'What is the minimum distance you should maintain from an unprotected leading edge of a work platform?',
        kind: 'single_choice' as const,
        options: [
          { value: 'A', label: '0.5 m' },
          { value: 'B', label: '1.0 m' },
          { value: 'C', label: '2.0 m' },
          { value: 'D', label: '3.0 m' },
        ],
        correctAnswer: 'C',
        points: 1,
      },
      {
        prompt:
          'How many of the following are valid types of PPE that should be inspected before each use?',
        kind: 'numeric' as const,
        options: null,
        correctAnswer: '4',
        helpText:
          'Consider: full-body harness, hard hat, safety glasses, hearing protection. The answer should be one number.',
        points: 1,
      },
      {
        prompt: 'Select every situation that requires a hot-work permit.',
        kind: 'multi_choice' as const,
        options: [
          { value: 'A', label: 'Welding above grade in a designated welding bay' },
          { value: 'B', label: 'Grinding on piping in an operating unit' },
          { value: 'C', label: 'Cutting steel beams during a turnaround' },
          { value: 'D', label: 'Plugging in a laptop' },
        ],
        correctAnswer: 'B,C',
        points: 2,
      },
      {
        prompt: 'In Canada, the universal emergency number for non-medical workplace incidents is',
        kind: 'numeric' as const,
        options: null,
        correctAnswer: '911',
        points: 1,
      },
      {
        prompt: 'Lockout/tagout is required only when working on equipment that is more than 50 V.',
        kind: 'true_false' as const,
        options: null,
        correctAnswer: 'false',
        points: 1,
      },
      {
        prompt: 'Briefly describe what "STOP work authority" means and when you would use it.',
        kind: 'text' as const,
        options: null,
        correctAnswer: null,
        points: 2,
      },
    ]
    let order = 1
    for (const q of basicQuestions) {
      await tx.insert(trainingAssessmentTypeQuestions).values({
        tenantId,
        typeId: basic.id,
        prompt: q.prompt,
        kind: q.kind,
        options: q.options,
        correctAnswer: q.correctAnswer,
        helpText: (q as any).helpText ?? null,
        points: q.points,
        entityOrder: order++,
        mandatory: true,
      })
    }
  }

  console.log(
    `  · training assessment types: seeded WHMIS quiz (${whmis?.id ? '5q' : 'failed'}) + Basic Safety Quiz (${basic?.id ? '8q' : 'failed'})`,
  )
}
