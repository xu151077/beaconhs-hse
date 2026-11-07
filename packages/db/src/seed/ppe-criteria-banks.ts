// PPE criteria banks — reusable question libraries keyed by PPE category.
//
// Pure per-tenant reference data, mirroring the inspection-bank pattern: a
// bank groups criteria questions that a PPE type's checklist can import. The
// questions are the same inspection criteria the PPE types themselves carry,
// so a type builder starts from the bank instead of a blank list.
//
// PURE TENANT REFERENCE DATA. This module must never write `user`,
// `tenant_users`, `people`, `org_units`, `audit_log`, or any business record,
// and must never modify a row that already exists.

import type { SeedTx } from './types'
import { and, eq } from 'drizzle-orm'
import { ppeCriteriaBankCriteria, ppeCriteriaBanks } from '../schema'
import { PPE_TYPES } from './ppe-types'

type BankCriterion = {
  sequence: number
  question: string
  description?: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  requiresPhoto: boolean
}

type BankSeed = {
  name: string
  category: string
  description: string
  criteria: BankCriterion[]
}

/**
 * One bank per PPE category, built from that category's own seeded criteria so
 * the bank and the types can never drift apart.
 */
function buildBanks(): BankSeed[] {
  const byCategory = new Map<string, BankSeed>()
  const labels: Record<string, string> = {
    head: 'Head PPE checks',
    eye: 'Eye PPE checks',
    hand: 'Hand PPE checks',
    fall: 'Fall PPE checks',
    body: 'Body PPE checks',
  }
  for (const type of PPE_TYPES) {
    const seed = byCategory.get(type.category) ?? {
      name: labels[type.category] ?? `${type.category} PPE checks`,
      category: type.category,
      description: `Standard pre-use inspection questions for ${type.category} PPE.`,
      criteria: [],
    }
    for (const criterion of type.criteria) {
      if (criterion.kind !== 'pre_use') continue
      seed.criteria.push({
        sequence: seed.criteria.length + 1,
        question: criterion.question,
        description: criterion.description,
        severity: criterion.severity,
        requiresPhoto: criterion.requiresPhoto ?? false,
      })
    }
    byCategory.set(type.category, seed)
  }
  return [...byCategory.values()]
}

/**
 * Insert the standard PPE criteria banks for a tenant.
 * Idempotent by (tenant, bank name): existing banks are left exactly as found.
 */
export async function seedPpeCriteriaBanks(tx: SeedTx, tenantId: string): Promise<void> {
  for (const bank of buildBanks()) {
    const [already] = await tx
      .select({ id: ppeCriteriaBanks.id })
      .from(ppeCriteriaBanks)
      .where(and(eq(ppeCriteriaBanks.tenantId, tenantId), eq(ppeCriteriaBanks.name, bank.name)))
      .limit(1)
    if (already) continue

    const [created] = await tx
      .insert(ppeCriteriaBanks)
      .values({
        tenantId,
        name: bank.name,
        description: bank.description,
        category: bank.category,
        isPublished: true,
      })
      .returning()
    if (!created) continue

    await tx.insert(ppeCriteriaBankCriteria).values(
      bank.criteria.map((c) => ({
        tenantId,
        bankId: created.id,
        sequence: c.sequence,
        question: c.question,
        description: c.description ?? null,
        severity: c.severity,
        requiresPhoto: c.requiresPhoto,
      })),
    )
  }
}
