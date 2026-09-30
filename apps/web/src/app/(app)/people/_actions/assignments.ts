'use server'

// Server actions for person↔org-unit assignments (`people_assignments`).
//
// This table already existed with its schema, indexes and RLS, but had no write
// path, so it was permanently empty. That silently broke two live features:
//   • `materializeUserIdentityAudienceObligations` (packages/compliance/src/
//     identity.ts:98-105) resolves a user's org units from here, so every user
//     was materialised with ZERO org-unit compliance obligations.
//   • a `kind='org_unit'` compliance audience (packages/compliance/src/
//     audience.ts:96-103) resolved to zero people.
//
// Phase A only adds the ability to record assignments. It deliberately does NOT
// change how authorisation consumes them — no Project Scope resolver, no change
// to `read.all`, no change to `visibility.ts`.
//
// Semantics:
//   • A person may hold SEVERAL concurrent assignments. There is no `is_primary`
//     and no uniqueness constraint.
//   • History is kept. Ending an assignment sets `valid_to`; nothing is deleted.
//   • `valid_to` is inclusive and nullable (null = open ended).
//
// Authorisation: `admin.org.manage`, which is exactly the permission the people
// module already declares in `lib/module-admin/registry.ts`. Only
// `tenant_admin` holds it, so foreman / worker / viewer / safety_manager cannot
// manage assignments. Deliberately NOT `admin.users.manage` — that governs
// accounts, not org structure.
//
// All writes go through `ctx.db`, so the existing tenant RLS policy applies and
// the tenant comes from the request context, never from the form.

import { revalidatePath } from 'next/cache'
import { and, eq, isNull } from 'drizzle-orm'
import { orgUnits, peopleAssignments, people } from '@beaconhs/db/schema'
import { assertCan } from '@beaconhs/tenant'
import { requireRequestContext } from '@/lib/auth'
import { recordAuditInTransaction } from '@/lib/audit'
import { getGeneratedValueTranslations } from '@/i18n/generated.server'
import { parseValidityWindow, type IsoDate, type Translate } from '@/lib/assignment-validity'

type Result = { ok: true } | { ok: false; error: string }

const PERSON_BASE = '/people'

/**
 * The single authorisation gate. Throws `ForbiddenError` when the caller lacks
 * `admin.org.manage`, which the shared route/action error handling turns into a
 * 403 rather than a 500.
 */
async function requireOrgAdmin() {
  const ctx = await requireRequestContext()
  // `assertCan` throws the real ForbiddenError, which the shared error handling
  // renders as 403 rather than a 500.
  assertCan(ctx, 'admin.org.manage')
  return ctx
}

/**
 * Wrap the locale value translator in the `Translate` shape the validity helper
 * wants: translate the English source, then substitute `{name}` placeholders.
 */
async function translator(): Promise<Translate> {
  const gv = await getGeneratedValueTranslations()
  return (source, values) => {
    const text = gv(source)
    return values
      ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m))
      : text
  }
}

/** Human window for an audit summary; `null` end date means open ended. */
function windowLabel(from: string, to: string | null, t: Translate): string {
  return to ? `${from} - ${to}` : t('from {date} (open ended)', { date: from })
}

/**
 * Confirm the person and the org unit both exist in THIS tenant.
 *
 * Both reads run through `ctx.db`, so the tenant RLS policy already hides rows
 * belonging to another tenant — a cross-tenant id comes back as "not found"
 * rather than as a leak. The explicit `tenantId` comparison is kept as well:
 * it is the check that makes the intent legible, and it does not depend on the
 * policy being installed. A caller-supplied `tenantId` is never accepted.
 */
async function resolveTargets(
  ctx: Awaited<ReturnType<typeof requireOrgAdmin>>,
  personId: string,
  orgUnitId: string,
  t: Translate,
): Promise<
  | { ok: true; person: { id: string; name: string }; orgUnit: { id: string; name: string } }
  | { ok: false; error: string }
> {
  return ctx.db(async (tx) => {
    const [person] = await tx
      .select({
        id: people.id,
        firstName: people.firstName,
        lastName: people.lastName,
        formalName: people.formalName,
      })
      .from(people)
      .where(and(eq(people.id, personId), eq(people.tenantId, ctx.tenantId)))
      .limit(1)
    if (!person) {
      return { ok: false as const, error: t('That person was not found in this company.') }
    }

    const [org] = await tx
      .select({ id: orgUnits.id, name: orgUnits.name })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, orgUnitId),
          eq(orgUnits.tenantId, ctx.tenantId),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1)
    if (!org)
      return { ok: false as const, error: t('That location was not found in this company.') }

    const label = [person.firstName, person.lastName].filter(Boolean).join(' ').trim()
    return {
      ok: true as const,
      person: { id: person.id, name: label || person.formalName || person.id },
      orgUnit: { id: org.id, name: org.name },
    }
  })
}

export async function createAssignment(input: {
  personId: string
  orgUnitId: string
  validFrom: string
  validTo?: string | null
}): Promise<Result> {
  const ctx = await requireOrgAdmin()
  const t = await translator()

  const personId = input.personId.trim()
  const orgUnitId = input.orgUnitId.trim()
  if (!personId) return { ok: false, error: t('Person is required.') }
  if (!orgUnitId) return { ok: false, error: t('Location is required.') }

  const window = parseValidityWindow(input.validFrom, input.validTo, t)
  if (!window.ok) return { ok: false, error: window.error }

  const targets = await resolveTargets(ctx, personId, orgUnitId, t)
  if (!targets.ok) return { ok: false, error: targets.error }

  await ctx.db(async (tx) => {
    const [inserted] = await tx
      .insert(peopleAssignments)
      .values({
        tenantId: ctx.tenantId,
        personId: personId,
        orgUnitId: orgUnitId,
        validFrom: window.validFrom,
        validTo: window.validTo,
      })
      .returning({ id: peopleAssignments.id })
    await recordAuditInTransaction(tx, ctx, {
      entityType: 'people_assignment',
      entityId: inserted?.id,
      action: 'create',
      summary: t('Assigned {person} to {orgUnit} from {validFrom} to {validTo}.', {
        person: targets.person.name,
        orgUnit: targets.orgUnit.name,
        validFrom: window.validFrom,
        validTo: window.validTo ?? t('open ended'),
      }),
      after: {
        personId,
        personName: targets.person.name,
        orgUnitId,
        orgUnitName: targets.orgUnit.name,
        validFrom: window.validFrom,
        validTo: window.validTo,
      },
    })
  })

  revalidatePath(`${PERSON_BASE}/${personId}`)
  return { ok: true }
}

export async function updateAssignment(
  assignmentId: string,
  input: { validFrom: string; validTo?: string | null },
): Promise<Result> {
  const ctx = await requireOrgAdmin()
  const t = await translator()

  const id = assignmentId.trim()
  if (!id) return { ok: false, error: t('Assignment not found.') }

  const window = parseValidityWindow(input.validFrom, input.validTo, t)
  if (!window.ok) return { ok: false, error: window.error }

  const outcome = await ctx.db(async (tx) => {
    const [before] = await tx
      .select({
        id: peopleAssignments.id,
        personId: peopleAssignments.personId,
        orgUnitId: peopleAssignments.orgUnitId,
        validFrom: peopleAssignments.validFrom,
        validTo: peopleAssignments.validTo,
      })
      .from(peopleAssignments)
      .where(and(eq(peopleAssignments.id, id), eq(peopleAssignments.tenantId, ctx.tenantId)))
      .limit(1)
    if (!before) return { ok: false as const, error: t('Assignment not found.') }

    // `updatedAt` is maintained by the schema's `$onUpdate`, not by hand.
    const [after] = await tx
      .update(peopleAssignments)
      .set({ validFrom: window.validFrom, validTo: window.validTo })
      .where(and(eq(peopleAssignments.id, id), eq(peopleAssignments.tenantId, ctx.tenantId)))
      .returning({ validFrom: peopleAssignments.validFrom, validTo: peopleAssignments.validTo })

    await recordAuditInTransaction(tx, ctx, {
      entityType: 'people_assignment',
      entityId: id,
      action: 'update',
      summary: t('Changed assignment dates from {before} to {after}.', {
        before: windowLabel(before.validFrom, before.validTo, t),
        after: windowLabel(
          after?.validFrom ?? window.validFrom,
          after?.validTo ?? window.validTo,
          t,
        ),
      }),
      before: { validFrom: before.validFrom, validTo: before.validTo },
      after: { validFrom: window.validFrom, validTo: window.validTo },
      metadata: { personId: before.personId, orgUnitId: before.orgUnitId, operation: 'update' },
    })

    return { ok: true as const, personId: before.personId }
  })

  if (outcome.ok) revalidatePath(`${PERSON_BASE}/${outcome.personId}`)
  return outcome
}

/**
 * End an assignment. This sets `valid_to` — it never deletes the row, because
 * the row is the historical record that compliance audiences read.
 */
export async function endAssignment(
  assignmentId: string,
  endDate?: string | null,
): Promise<Result> {
  const ctx = await requireOrgAdmin()
  const t = await translator()

  const id = assignmentId.trim()
  if (!id) return { ok: false, error: t('Assignment not found.') }

  const endIso: IsoDate = (endDate ?? '').trim() || new Date().toISOString().slice(0, 10)

  const outcome = await ctx.db(async (tx) => {
    const [before] = await tx
      .select({
        id: peopleAssignments.id,
        personId: peopleAssignments.personId,
        validFrom: peopleAssignments.validFrom,
        validTo: peopleAssignments.validTo,
      })
      .from(peopleAssignments)
      .where(and(eq(peopleAssignments.id, id), eq(peopleAssignments.tenantId, ctx.tenantId)))
      .limit(1)
    if (!before) return { ok: false as const, error: t('Assignment not found.') }
    if (before.validTo) {
      return { ok: false as const, error: t('That assignment has already ended.') }
    }
    // Never end before it started: that would produce a window the UI and the
    // compliance reader would both treat as never-active.
    if (endIso < before.validFrom) {
      return { ok: false as const, error: t('End date cannot be before the start date.') }
    }

    const [after] = await tx
      .update(peopleAssignments)
      .set({ validTo: endIso })
      .where(and(eq(peopleAssignments.id, id), eq(peopleAssignments.tenantId, ctx.tenantId)))
      .returning({ validTo: peopleAssignments.validTo })

    await recordAuditInTransaction(tx, ctx, {
      entityType: 'people_assignment',
      entityId: id,
      action: 'update',
      summary: t('Ended assignment from {validFrom} to {validTo}.', {
        validFrom: before.validFrom,
        validTo: after?.validTo ?? endIso,
      }),
      before: { validTo: before.validTo },
      after: { validTo: after?.validTo ?? endIso },
      metadata: { personId: before.personId, operation: 'end' },
    })

    return { ok: true as const, personId: before.personId }
  })

  if (outcome.ok) revalidatePath(`${PERSON_BASE}/${outcome.personId}`)
  return outcome
}
