'use server'

// Server actions for the /people/companies admin — flat CRUD over `companies`,
// the contractor / subcontractor employers a person can belong to
// (one company per person, via people.companyId).
//
// This is a NAMED TENANT CATALOG, exactly like `departments` / `trades` / `crews`:
// a nullable column on `people` plus a composite `(tenant_id, company_id)` foreign
// key. That key is what makes a cross-tenant employer reference impossible, so no
// action here re-implements tenant scoping — `ctx.db` runs under RLS and the
// database enforces the tenant boundary structurally.
//
// Authorization is the org-admin permission the People module already uses
// (`assertCanManageModule(ctx, 'people')`, i.e. `admin.org.manage`). No
// contractor-specific permission and no new RoleScope variant is introduced: a
// company association is business data, not an authorization scope.
//
// Create + edit run through saveCompany (returns {ok|error} for the drawer).
// Delete is a row form action that refuses while people are still assigned — the
// same rule `people_tenant_company_fk` enforces underneath it, mirrored here so
// the user gets a message instead of an FK violation.

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { and, count, eq } from 'drizzle-orm'
import { normalizeCatalogDisplayName } from '@beaconhs/db'
import { companies, people } from '@beaconhs/db/schema'
import { requireRequestContext } from '@/lib/auth'
import { assertCanManageModule } from '@/lib/module-admin/guard'
import { recordAudit, recordAuditInTransaction } from '@/lib/audit'

const BASE = '/people/companies'

/** The DB enum's only two values. Kept in step with `companyType` in the schema. */
const COMPANY_TYPES = ['contractor', 'subcontractor'] as const

type CompanyTypeValue = (typeof COMPANY_TYPES)[number]

function isCompanyType(value: string): value is CompanyTypeValue {
  return (COMPANY_TYPES as readonly string[]).includes(value)
}

/** True when the error is the tenant-scoped unique-name violation. */
function isDuplicateNameError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /companies_tenant_(?:normalized_)?name_ux/.test(msg)
}

export async function saveCompany(input: {
  id?: string
  name: string
  type: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireRequestContext()
  assertCanManageModule(ctx, 'people')
  const name = normalizeCatalogDisplayName(input.name)
  if (!name) return { ok: false, error: 'Name is required.' }
  // Bind to a local before narrowing: a property of a parameter loses its
  // narrowed type across the awaits below, and `type` must stay the enum union
  // for Drizzle's insert/update types.
  const { type } = input
  if (!isCompanyType(type)) return { ok: false, error: 'Invalid company type.' }

  if (input.id) {
    const before = await ctx.db(async (tx) => {
      const [row] = await tx
        .select()
        .from(companies)
        .where(and(eq(companies.tenantId, ctx.tenantId), eq(companies.id, input.id!)))
        .limit(1)
      return row ?? null
    })
    if (!before) return { ok: false, error: 'Company not found.' }
    try {
      await ctx.db((tx) =>
        tx
          .update(companies)
          .set({ name, type })
          .where(and(eq(companies.tenantId, ctx.tenantId), eq(companies.id, input.id!))),
      )
    } catch (err) {
      if (isDuplicateNameError(err)) {
        return { ok: false, error: 'A company with that name already exists.' }
      }
      throw err
    }
    await recordAudit(ctx, {
      entityType: 'company',
      entityId: input.id,
      action: 'update',
      summary: `Updated company "${name}"`,
      before: { name: before.name, type: before.type },
      after: { name, type },
    })
    revalidatePath(BASE)
    // The company name is shown on the directory list and every person page.
    revalidatePath('/people')
    return { ok: true }
  }

  let createdId: string | null = null
  try {
    const [row] = await ctx.db((tx) =>
      tx
        .insert(companies)
        .values({ tenantId: ctx.tenantId, name, type })
        .returning({ id: companies.id }),
    )
    createdId = row?.id ?? null
  } catch (err) {
    if (isDuplicateNameError(err)) {
      return { ok: false, error: 'A company with that name already exists.' }
    }
    throw err
  }
  if (createdId) {
    await recordAudit(ctx, {
      entityType: 'company',
      entityId: createdId,
      action: 'create',
      summary: `Added company "${name}"`,
      after: { name, type },
    })
  }
  revalidatePath(BASE)
  return { ok: true }
}

export async function deleteCompany(formData: FormData): Promise<void> {
  const ctx = await requireRequestContext()
  assertCanManageModule(ctx, 'people')
  const id = String(formData.get('id') ?? '')
  if (!id) return

  const result = await ctx.db(async (tx) => {
    const [row] = await tx
      .select()
      .from(companies)
      .where(and(eq(companies.tenantId, ctx.tenantId), eq(companies.id, id)))
      .limit(1)
      .for('update')
    if (!row) return { state: 'missing' as const }

    // Mirrors the `people_tenant_company_fk` ON DELETE no-action guard, so an
    // employer is never silently removed from under the people who work for it.
    const [u] = await tx
      .select({ c: count() })
      .from(people)
      .where(and(eq(people.tenantId, ctx.tenantId), eq(people.companyId, id)))
    const usage = Number(u?.c ?? 0)
    if (usage > 0) return { state: 'assigned' as const, row, usage }

    const [deleted] = await tx
      .delete(companies)
      .where(and(eq(companies.tenantId, ctx.tenantId), eq(companies.id, id)))
      .returning({ id: companies.id })
    if (!deleted) return { state: 'missing' as const }
    await recordAuditInTransaction(tx, ctx, {
      entityType: 'company',
      entityId: id,
      action: 'delete',
      summary: `Deleted company "${row.name}"`,
      before: { name: row.name, type: row.type },
    })
    return { state: 'deleted' as const }
  })

  if (result.state === 'missing') return
  if (result.state === 'assigned') {
    revalidatePath(BASE)
    redirect(
      `${BASE}?error=${encodeURIComponent(
        `"${result.row.name}" is assigned to ${result.usage} ${result.usage === 1 ? 'person' : 'people'}. Reassign them before deleting.`,
      )}`,
    )
  }
  revalidatePath(BASE)
  redirect(BASE)
}
