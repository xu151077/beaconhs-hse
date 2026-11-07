// Skill catalogue — issuing authorities and the skill types they certify.
//
// Pure per-tenant reference data: authorities and types only, no assignments.
// Assignments are per-person business records and live in the demo seed.
//
// Extracted from `seed.ts`'s demo flow, which interleaved these definitions
// with demo assignments. Tenant provisioning and the backfill call this one
// implementation; the demo seed keeps its assignments and looks the types up
// by code.

import type { SeedTx } from './types'
import { and, eq } from 'drizzle-orm'
import { trainingSkillAuthorities, trainingSkillTypes } from '../schema'

const SKILL_AUTHORITY_SEEDS = [
  {
    name: 'In-house Quality Control',
    code: 'IHQC',
    jurisdiction: 'Internal',
    notes: 'Internal evaluator sign-off for in-house competencies.',
  },
  {
    name: 'Boilermakers Local 128',
    code: 'BM128',
    jurisdiction: 'Ontario',
    notes: null as string | null,
  },
] as const

const SKILL_TYPE_SEEDS = [
  {
    authorityCode: 'IHQC',
    name: 'Forklift Operator',
    code: 'FORK',
    validForMonths: 36,
    description: 'Class 4/5 sit-down counterbalance forklift competency.',
  },
  {
    authorityCode: 'IHQC',
    name: 'Confined Space Attendant',
    code: 'CSA',
    validForMonths: 12,
    description: 'Permit-required confined space attendant role.',
  },
  {
    authorityCode: 'BM128',
    name: 'Pressure Welding Certification',
    code: 'PWELD',
    validForMonths: 24,
    description: 'Provincially-recognised pressure welding ticket.',
  },
] as const

/**
 * Insert the standard authorities and skill types for a tenant.
 * Idempotent by (tenant, code): existing rows — edited by the administrator —
 * are left exactly as found.
 */
export async function seedSkillCatalogue(tx: SeedTx, tenantId: string): Promise<void> {
  for (const authority of SKILL_AUTHORITY_SEEDS) {
    const [already] = await tx
      .select({ id: trainingSkillAuthorities.id })
      .from(trainingSkillAuthorities)
      .where(
        and(
          eq(trainingSkillAuthorities.tenantId, tenantId),
          eq(trainingSkillAuthorities.code, authority.code),
        ),
      )
      .limit(1)
    if (!already) {
      await tx.insert(trainingSkillAuthorities).values({ tenantId, ...authority })
    }
  }

  const authorities = await tx
    .select({ id: trainingSkillAuthorities.id, code: trainingSkillAuthorities.code })
    .from(trainingSkillAuthorities)
    .where(eq(trainingSkillAuthorities.tenantId, tenantId))
  const authorityByCode = new Map(authorities.map((a) => [a.code, a.id]))

  for (const skill of SKILL_TYPE_SEEDS) {
    const authorityId = authorityByCode.get(skill.authorityCode)
    if (!authorityId) continue
    const [already] = await tx
      .select({ id: trainingSkillTypes.id })
      .from(trainingSkillTypes)
      .where(
        and(eq(trainingSkillTypes.tenantId, tenantId), eq(trainingSkillTypes.code, skill.code)),
      )
      .limit(1)
    if (already) continue
    await tx.insert(trainingSkillTypes).values({
      tenantId,
      authorityId,
      name: skill.name,
      code: skill.code,
      validForMonths: skill.validForMonths,
      description: skill.description,
    })
  }
}
