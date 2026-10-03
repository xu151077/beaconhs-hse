// Phase 11-E — `document_categories` for Fire and Statutory.
//
// Two new leaves under the existing `Safety` root. Deliberately NOT a new
// document entity: a fire plan or an air-quality permit is a controlled document
// like any other, and `documents` already carries `owner_tenant_user_id`,
// `review_frequency_months`, `next_review_on`, versions, reviews and
// acknowledgements.
//
// Note `documents` has NO site column, and none is added. A statute, a fire
// emergency plan and a discharge permit are tenant-wide instruments; the
// site-scoped object for the statutory register is the register ENTRY (a
// Builder App response), not the document. Adding a site column to `documents`
// would be a schema change and is out of scope.
//
// Idempotent by the SAME sibling-name identity the schema's partial unique index
// enforces (`tenant_id, COALESCE(parent_id::text,''), lower(btrim(name))` WHERE
// deleted_at IS NULL), so a second run matches the existing row instead of
// inserting a duplicate.

import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DrizzleTx } from './hazard-assessment-app-templates'
import { documentCategories } from '../schema'

type DrizzleTxWithSelect = Pick<DrizzleTx, 'select' | 'insert'>

export const CATEGORY_DEFS: {
  name: string
  parent?: string
  description: string
}[] = [
  {
    name: 'Fire',
    parent: 'Safety',
    description: 'Fire protection plans, emergency procedures and fire-system records.',
  },
  {
    name: 'Statutory',
    parent: 'Safety',
    description: 'Statutory registers, permits, licences and regulatory instruments.',
  },
]

export async function seedPhase11EDocumentCategories(
  tx: DrizzleTxWithSelect,
  tenantId: string,
): Promise<{ inserted: number; total: number }> {
  const resolved = new Map<string, string>()
  let inserted = 0

  for (const def of CATEGORY_DEFS) {
    // Resolve the parent first so a Fire/Statutory leaf can only ever attach to
    // this tenant's own `Safety` node.
    const parentId = def.parent ? (resolved.get(def.parent) ?? null) : null
    let parentIdForLookup = parentId
    if (def.parent && !parentIdForLookup) {
      const [parent] = await tx
        .select({ id: documentCategories.id })
        .from(documentCategories)
        .where(
          and(
            eq(documentCategories.tenantId, tenantId),
            isNull(documentCategories.parentId),
            isNull(documentCategories.deletedAt),
            sql`lower(btrim(${documentCategories.name})) = lower(btrim(${def.parent}))`,
          ),
        )
        .limit(1)
      parentIdForLookup = parent?.id ?? null
    }

    const existing = await tx
      .select({ id: documentCategories.id })
      .from(documentCategories)
      .where(
        and(
          eq(documentCategories.tenantId, tenantId),
          parentIdForLookup
            ? eq(documentCategories.parentId, parentIdForLookup)
            : isNull(documentCategories.parentId),
          isNull(documentCategories.deletedAt),
          sql`lower(btrim(${documentCategories.name})) = lower(btrim(${def.name}))`,
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      resolved.set(def.name, existing[0]!.id)
      continue
    }
    const [row] = await tx
      .insert(documentCategories)
      .values({
        tenantId,
        name: def.name,
        // `parentIdForLookup`, not the unresolved `parentId`: the parent may have
        // been found by query rather than from the in-run `resolved` map.
        parentId: parentIdForLookup,
        description: def.description,
      })
      .returning({ id: documentCategories.id })
    if (row) {
      resolved.set(def.name, row.id)
      inserted += 1
    }
  }

  return { inserted, total: CATEGORY_DEFS.length }
}
