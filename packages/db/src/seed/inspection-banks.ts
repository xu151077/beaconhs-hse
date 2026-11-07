// Inspection banks — reusable criteria libraries that inspection types import from.
//
// Pure per-tenant reference data. A bank is a named set of criteria questions;
// `seedInspectionTypes` copies them into per-type groups + criteria. Banks
// themselves are admin-editable afterwards.
//
// PURE TENANT REFERENCE DATA. This module must never write `user`,
// `tenant_users`, `people`, `org_units`, `audit_log`, or any business record,
// and must never modify a row that already exists.
//
// Extracted from `seed.ts`'s demo flow, which used to create these banks
// inline against a demo admin. Tenant provisioning and the demo seed both call
// this one implementation, so the catalogue has a single source of truth.

import type { SeedTx } from './types'
import { and, eq } from 'drizzle-orm'
import { inspectionBankCriteria, inspectionBanks } from '../schema'

type BankCriterion = {
  sequence: number
  text: string
  responseType: 'pass_fail_na' | 'yes_no'
  requiresPhoto: boolean
  requiresComment: boolean
}

type BankSeed = {
  name: string
  description: string
  category: 'site_inspection' | 'ppe_check'
  isPublished: boolean
  criteria: BankCriterion[]
}

const INSPECTION_BANK_SEEDS: BankSeed[] = [
  {
    name: 'Site Daily Walk-Through',
    description:
      'Routine site safety walk-through criteria used by site supervisors at start of shift.',
    category: 'site_inspection',
    isPublished: true,
    criteria: [
      {
        sequence: 1,
        text: 'Are walkways clear and unobstructed?',
        responseType: 'pass_fail_na',
        requiresPhoto: false,
        requiresComment: false,
      },
      {
        sequence: 2,
        text: 'Is fire extinguisher signage visible from all working areas?',
        responseType: 'pass_fail_na',
        requiresPhoto: true,
        requiresComment: false,
      },
      {
        sequence: 3,
        text: 'Are MSDS binders accessible at the chemical storage?',
        responseType: 'yes_no',
        requiresPhoto: false,
        requiresComment: true,
      },
      {
        sequence: 4,
        text: 'Eyewash stations functional and unobstructed?',
        responseType: 'pass_fail_na',
        requiresPhoto: true,
        requiresComment: true,
      },
    ],
  },
  {
    name: 'PPE Pre-Use Inspection (Harness)',
    description: 'Draft template — to be reviewed before publishing.',
    category: 'ppe_check',
    isPublished: false,
    criteria: [
      {
        sequence: 1,
        text: 'Webbing free from cuts, frays, burns, or chemical damage?',
        responseType: 'pass_fail_na',
        requiresPhoto: true,
        requiresComment: false,
      },
      {
        sequence: 2,
        text: 'D-rings free from cracks, sharp edges, or deformation?',
        responseType: 'pass_fail_na',
        requiresPhoto: false,
        requiresComment: false,
      },
      {
        sequence: 3,
        text: 'Buckles function and lock correctly?',
        responseType: 'pass_fail_na',
        requiresPhoto: false,
        requiresComment: false,
      },
    ],
  },
]

/**
 * Insert the standard inspection banks (and their criteria) for a tenant.
 * Idempotent by (tenant, bank name): a bank the administrator already has —
 * edited or deleted — is left exactly as found.
 */
export async function seedInspectionBanks(tx: SeedTx, tenantId: string): Promise<void> {
  for (const bank of INSPECTION_BANK_SEEDS) {
    const [already] = await tx
      .select({ id: inspectionBanks.id })
      .from(inspectionBanks)
      .where(and(eq(inspectionBanks.tenantId, tenantId), eq(inspectionBanks.name, bank.name)))
      .limit(1)
    if (already) continue

    const [created] = await tx
      .insert(inspectionBanks)
      .values({
        tenantId,
        name: bank.name,
        description: bank.description,
        category: bank.category,
        isPublished: bank.isPublished,
      })
      .returning()
    if (!created) continue

    await tx.insert(inspectionBankCriteria).values(
      bank.criteria.map((c) => ({
        tenantId,
        bankId: created.id,
        sequence: c.sequence,
        text: c.text,
        responseType: c.responseType,
        requiresPhoto: c.requiresPhoto,
        requiresComment: c.requiresComment,
      })),
    )
  }
}
