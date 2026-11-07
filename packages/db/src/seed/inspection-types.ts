// Inspection types, their criterion groups, and their criteria.
//
// Pure per-tenant reference data, so the Inspections module has something to
// offer on day one. No inspection RECORDS — a separate, demo-only seeder owns
// those.
//
// PURE TENANT REFERENCE DATA. This module must never write `user`,
// `tenant_users`, `people`, `org_units`, `audit_log`, or any business
// record, and must never modify a row that already exists.
//
// Lifted out of `seed.ts`, which runs `main()` at module scope and so
// cannot be imported. Tenant provisioning and the demo seed both call
// this one implementation, so the catalogue has a single source of truth.

import type { SeedTx } from './types'
import { eq, sql } from 'drizzle-orm'
import {
  inspectionBankCriteria,
  inspectionBanks,
  inspectionTypeCriteria,
  inspectionTypeGroups,
  inspectionTypes,
} from '../schema'

export async function seedInspectionTypes(tx: SeedTx, tenantId: string): Promise<void> {
  // Per-type idempotency: a tenant that already has types (created by hand,
  // or by an earlier partial run) must still get criteria for any type that
  // has none. The old wholesale early-return left exactly that state behind —
  // a type with an empty checklist — which is worse than no type at all.
  const existingTypes = await tx
    .select({ id: inspectionTypes.id, name: inspectionTypes.name })
    .from(inspectionTypes)
    .where(sql`${inspectionTypes.tenantId} = ${tenantId}`)

  // Find the seeded banks so we can link by category.
  const banks = await tx
    .select({
      id: inspectionBanks.id,
      name: inspectionBanks.name,
      category: inspectionBanks.category,
    })
    .from(inspectionBanks)
    .where(sql`${inspectionBanks.tenantId} = ${tenantId}`)

  const siteBank = banks.find((b: { category: string | null }) => b.category === 'site_inspection')
  const ppeBank = banks.find((b: { category: string | null }) => b.category === 'ppe_check')
  const equipBank = banks.find((b: { category: string | null }) => b.category === 'equipment_check')

  const samples = [
    {
      name: 'Site Walk',
      description:
        'Daily site walk-through — supervisor walks the work zone with the foreman, captures customer sign-off.',
      requiresForeman: true,
      requiresCustomerSignature: true,
      enableCorrectiveActions: true,
      defaultCadence: 'day',
      bankIds: [siteBank?.id, ppeBank?.id].filter((v): v is string => Boolean(v)),
    },
    {
      name: 'Equipment Daily',
      description:
        'Per-shift equipment safety check. No customer signature needed; auto-spawns corrective actions on serious failures.',
      requiresForeman: false,
      requiresCustomerSignature: false,
      enableCorrectiveActions: true,
      defaultCadence: 'day',
      bankIds: [equipBank?.id, ppeBank?.id].filter((v): v is string => Boolean(v)),
    },
    {
      name: 'Crew Toolbox',
      description:
        'Weekly crew safety review. Foreman-led, no customer signature, fewer criteria — quick to complete.',
      requiresForeman: true,
      requiresCustomerSignature: false,
      enableCorrectiveActions: true,
      defaultCadence: 'week',
      bankIds: [siteBank?.id].filter((v): v is string => Boolean(v)),
    },
  ] as const

  let createdTypes = 0
  let importedGroups = 0
  for (const sample of samples) {
    const [type] = await tx
      .insert(inspectionTypes)
      .values({
        tenantId,
        name: sample.name,
        description: sample.description,
        requiresForeman: sample.requiresForeman,
        requiresCustomerSignature: sample.requiresCustomerSignature,
        enableCorrectiveActions: sample.enableCorrectiveActions,
        allowCompliantNotes: true,
        defaultCadence: sample.defaultCadence,
        isPublished: true,
      })
      .onConflictDoNothing({ target: [inspectionTypes.tenantId, inspectionTypes.name] })
      .returning()
    // Resolve the type whether this run created it or it already existed.
    const typeRow =
      type ??
      (
        await tx
          .select({ id: inspectionTypes.id })
          .from(inspectionTypes)
          .where(
            sql`${inspectionTypes.tenantId} = ${tenantId} AND ${inspectionTypes.name} = ${sample.name}`,
          )
          .limit(1)
      )[0]
    if (!typeRow) continue
    if (type) createdTypes += 1

    // Only import criteria for a type that has none. A type the administrator
    // already filled in keeps its own checklist.
    const currentCriteria = await tx
      .select({ id: inspectionTypeCriteria.id })
      .from(inspectionTypeCriteria)
      .where(eq(inspectionTypeCriteria.typeId, typeRow.id))
      .limit(1)
    if (currentCriteria.length > 0) continue
    // Import each bank's criteria into its own group on the type. Banks are now
    // just a library — the type owns the resulting groups + criteria outright.
    for (let i = 0; i < sample.bankIds.length; i++) {
      const bankId = sample.bankIds[i]
      if (!bankId) continue
      const bank = banks.find((b: { id: string }) => b.id === bankId)
      const [group] = await tx
        .insert(inspectionTypeGroups)
        .values({
          tenantId,
          typeId: typeRow.id,
          sequence: i,
          label: bank?.name ?? 'Imported criteria',
        })
        .returning()
      const bankCriteria = await tx
        .select()
        .from(inspectionBankCriteria)
        .where(eq(inspectionBankCriteria.bankId, bankId))
        .orderBy(inspectionBankCriteria.sequence)
      if (bankCriteria.length > 0) {
        await tx.insert(inspectionTypeCriteria).values(
          bankCriteria.map((c: any, j: number) => ({
            tenantId,
            typeId: typeRow.id,
            groupId: group?.id ?? null,
            sequence: j,
            text: c.text,
            responseType: c.responseType,
            choiceOptions: c.choiceOptions,
            requiresPhoto: c.requiresPhoto,
            requiresComment: c.requiresComment,
            sourceBankId: bankId,
            sourceBankCriterionId: c.id,
          })),
        )
      }
      importedGroups += 1
    }
  }
  console.log(
    `  · inspection types: ${createdTypes} created, ${importedGroups} group${importedGroups === 1 ? '' : 's'} imported`,
  )
}
