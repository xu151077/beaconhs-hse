'use server'

// Deleting a Builder app.
//
// A template is the app's identity; its versions, responses and automations hang
// off it. Deletion is therefore a guarded soft delete:
//
//   • the caller needs `forms.template.delete` (super-admins pass via `*`).
//     Templates are tenant-level builder objects with no site/self tier in
//     the schema, so this permission is intentionally tenant-wide — unlike
//     responses, which re-scope by visibility before deleting.
//   • an app that still has responses is refused — the responses are the
//     operational record and are deleted deliberately, one by one, not as a
//     side effect of removing the app;
//   • an app that still has automations is refused, because a deleted template
//     would leave a flow firing against a record nobody can open;
//   • the row keeps its data; `deleted_at` removes it from the builder, the
//     sidebar's pinned-form resolver and every app query, and the audit log
//     records who removed it and when.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, count, eq, isNull } from 'drizzle-orm'
import { formAutomations, formResponses, formTemplates } from '@beaconhs/db/schema'
import { assertCan } from '@beaconhs/tenant'
import { requireRequestContext } from '@/lib/auth'
import { recordAuditInTransaction } from '@/lib/audit'
import { isUuid } from '@/lib/list-params'
import { appDeleteRefusal } from './_lib/delete-policy'

type DeleteAppResult = { ok: true } | { ok: false; error: string }

/** Guarded soft delete of one app. Returns a business refusal instead of throwing. */
async function deleteFormTemplate(templateId: string): Promise<DeleteAppResult> {
  const ctx = await requireRequestContext()
  assertCan(ctx, 'forms.template.delete')
  if (!isUuid(templateId)) return { ok: false, error: 'App not found.' }

  return ctx.db(async (tx) => {
    const [template] = await tx
      .select({ id: formTemplates.id, name: formTemplates.name })
      .from(formTemplates)
      .where(and(eq(formTemplates.id, templateId), isNull(formTemplates.deletedAt)))
      .limit(1)
    if (!template) return { ok: false, error: 'App not found.' }

    const [responses] = await tx
      .select({ total: count() })
      .from(formResponses)
      .where(and(eq(formResponses.templateId, templateId), isNull(formResponses.deletedAt)))
    const [automations] = await tx
      .select({ total: count() })
      .from(formAutomations)
      .where(eq(formAutomations.templateId, templateId))

    const refusal = appDeleteRefusal({
      hasResponses: Number(responses?.total ?? 0) > 0,
      hasAutomations: Number(automations?.total ?? 0) > 0,
    })
    if (refusal) return { ok: false, error: refusal }

    const deleted = await tx
      .update(formTemplates)
      .set({ deletedAt: new Date() })
      .where(and(eq(formTemplates.id, templateId), isNull(formTemplates.deletedAt)))
      .returning({ id: formTemplates.id })
    if (!deleted[0]) return { ok: false, error: 'App not found.' }

    await recordAuditInTransaction(tx, ctx, {
      entityType: 'form_template',
      entityId: templateId,
      action: 'delete',
      summary: `Deleted app "${template.name}"`,
    })
    return { ok: true }
  })
}

/** Form-action wrapper: keeps the refusal visible on the list instead of failing silently. */
export async function deleteFormTemplateAction(formData: FormData): Promise<void> {
  const templateId = String(formData.get('templateId') ?? '')
  const result = await deleteFormTemplate(templateId)
  if (!result.ok) {
    redirect(`/apps?deleteError=${encodeURIComponent(result.error)}`)
  }
  revalidatePath('/apps')
  revalidatePath('/')
  redirect('/apps')
}
