'use server'

// Deleting one Builder response.
//
// The response row is the operational record: it feeds reports, compliance
// evidence and per-person history. Deletion is a guarded soft delete:
//
//   • the caller needs `forms.response.delete`;
//   • a response opened for a scheduled compliance obligation is EVIDENCE and is
//     refused — those are retired through the compliance process, never removed
//     from under it;
//   • the row keeps its payload; `deleted_at` removes it from lists, reports and
//     the evidence pipeline, and the audit log records the actor and time.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, eq, isNull } from 'drizzle-orm'
import { formResponses, formTemplates } from '@beaconhs/db/schema'
import { assertCan } from '@beaconhs/tenant'
import { lockFormResponseForMutation } from '@beaconhs/db'
import { classifyParentLockError } from './_lock-outcome'
import { requireRequestContext } from '@/lib/auth'
import { canSeeRecord } from '@/lib/visibility'
import { recordAuditInTransaction } from '@/lib/audit'
import { isUuid } from '@/lib/list-params'
import { responseDeleteRefusal } from '../_lib/delete-policy'

type DeleteResponseResult = { ok: true } | { ok: false; error: string }

/** Guarded soft delete of one response. */
async function deleteFormResponse(responseId: string): Promise<DeleteResponseResult> {
  const ctx = await requireRequestContext()
  assertCan(ctx, 'forms.response.delete')
  if (!isUuid(responseId)) return { ok: false, error: 'Response not found.' }

  return ctx.db(async (tx) => {
    const [row] = await tx
      .select({
        id: formResponses.id,
        templateName: formTemplates.name,
        obligationId: formResponses.complianceObligationId,
        status: formResponses.status,
        submittedBy: formResponses.submittedBy,
        subjectPersonId: formResponses.subjectPersonId,
        siteOrgUnitId: formResponses.siteOrgUnitId,
      })
      .from(formResponses)
      .leftJoin(formTemplates, eq(formTemplates.id, formResponses.templateId))
      .where(and(eq(formResponses.id, responseId), isNull(formResponses.deletedAt)))
      .limit(1)
    if (!row) return { ok: false, error: 'Response not found.' }

    // Record-visibility re-scope: the delete permission alone must not reach a
    // response outside the caller's site/self tier. Same refusal as a missing
    // row so the check is not an oracle.
    const visible = await canSeeRecord(ctx, tx, {
      prefix: 'forms.response',
      ownerIds: [row.submittedBy],
      personId: row.subjectPersonId,
      siteId: row.siteOrgUnitId,
    })
    if (!visible) return { ok: false, error: 'Response not found.' }

    const refusal = responseDeleteRefusal({ complianceObligationId: row.obligationId })
    if (refusal) return { ok: false, error: refusal }

    // Same parent-first lock as every other response writer: deleting must not
    // race a parent assessment that is being locked for mutation.
    //
    // A response can outlive its parent: deleting a HazID assessment leaves the
    // response rows behind. There is then no live parent to lock, and the lock
    // helper reports an integrity error — which must not make the response
    // undeletable. A still-locked parent is a real refusal with its own message.
    let mutable: Awaited<ReturnType<typeof lockFormResponseForMutation>> = null
    let parentGone = false
    try {
      mutable = await lockFormResponseForMutation(tx, ctx.tenantId, responseId)
    } catch (error) {
      const outcome = classifyParentLockError(error)
      if (outcome === 'parent-gone') {
        parentGone = true
      } else if (outcome === 'parent-locked') {
        return {
          ok: false,
          error: 'The parent hazard assessment is locked. Unlock it before deleting this response.',
        }
      } else {
        throw error
      }
    }
    if (!parentGone && !mutable) return { ok: false, error: 'Response not found.' }

    const deleted = await tx
      .update(formResponses)
      .set({ deletedAt: new Date() })
      .where(and(eq(formResponses.id, responseId), isNull(formResponses.deletedAt)))
      .returning({ id: formResponses.id })
    if (!deleted[0]) return { ok: false, error: 'Response not found.' }

    await recordAuditInTransaction(tx, ctx, {
      entityType: 'form_response',
      entityId: responseId,
      action: 'delete',
      summary: `Deleted ${row.templateName ?? 'app'} response`,
      metadata: { status: row.status },
    })
    return { ok: true }
  })
}

/** Form-action wrapper that returns the caller to the list with a visible refusal. */
export async function deleteFormResponseAction(formData: FormData): Promise<void> {
  const responseId = String(formData.get('responseId') ?? '')
  // The redirect target is caller-controlled FormData: only ever honor the
  // known same-origin list path, never an arbitrary URL.
  const requestedReturnTo = String(formData.get('returnTo') ?? '/apps/responses')
  const returnTo = requestedReturnTo === '/apps/responses' ? requestedReturnTo : '/apps/responses'
  const result = await deleteFormResponse(responseId)
  if (!result.ok) {
    redirect(`${returnTo}?deleteError=${encodeURIComponent(result.error)}`)
  }
  revalidatePath('/apps/responses')
  revalidatePath(returnTo)
  redirect(returnTo)
}
