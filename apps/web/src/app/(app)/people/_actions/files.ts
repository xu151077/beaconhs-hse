'use server'

// Server actions for the per-person Files tab + signature image upload.
//
// File rows live in `person_files`. The signature image lives directly on
// `people.signature_attachment_id` because there's exactly one per person and
// any number of forms / inspections / lift plans want to render it inline.

import { revalidatePath } from 'next/cache'
import { and, eq, isNull } from 'drizzle-orm'
import { attachments, personFiles, people } from '@beaconhs/db/schema'
import { isUuid } from '@/lib/list-params'
import { requireRequestContext } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { assertCanActOnPerson } from '../_lib/person-access'

const ALLOWED_KINDS = new Set(['resume', 'certification', 'id_copy', 'other'])

export async function addPersonFile(args: {
  personId: string
  attachmentId: string
  label: string
  kind: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireRequestContext()
  if (!args.personId) return { ok: false, error: 'Missing personId' }
  if (!args.attachmentId) return { ok: false, error: 'Missing attachmentId' }
  assertCanActOnPerson(ctx, args.personId)
  const label = args.label.trim()
  if (!label) return { ok: false, error: 'Label is required' }
  if (!isUuid(args.attachmentId)) return { ok: false, error: 'File not found.' }
  const kind = ALLOWED_KINDS.has(args.kind) ? args.kind : 'other'

  // The attachment must exist under this tenant before linking, so a caller
  // cannot bind an arbitrary or missing id (which would otherwise surface as
  // a raw database error).
  const [attachment] = await ctx.db((tx) =>
    tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(eq(attachments.id, args.attachmentId), eq(attachments.tenantId, ctx.tenantId)))
      .limit(1),
  )
  if (!attachment) return { ok: false, error: 'File not found.' }

  const [row] = await ctx.db((tx) =>
    tx
      .insert(personFiles)
      .values({
        tenantId: ctx.tenantId,
        personId: args.personId,
        attachmentId: args.attachmentId,
        label,
        kind,
        uploadedBy: ctx.userId,
      })
      .returning(),
  )
  if (!row) return { ok: false, error: 'Insert failed' }

  await recordAudit(ctx, {
    entityType: 'person',
    entityId: args.personId,
    action: 'create',
    summary: `Uploaded ${kind.replace('_', ' ')}: ${label}`,
    metadata: { personFileId: row.id, attachmentId: args.attachmentId, kind },
  })

  revalidatePath(`/people/${args.personId}`)
  return { ok: true }
}

/**
 * Set (or clear) the person's portrait photo.
 *
 * The portrait is taken from the uploaded attachment; it is what the ID badge
 * renders. The attachment must be an image belonging to this tenant — the
 * upload already validated its type and size, this stamps the reference.
 */
export async function setPersonPhoto(args: {
  personId: string
  attachmentId: string | null
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireRequestContext()
  if (!isUuid(args.personId)) return { ok: false, error: 'Person not found.' }
  if (args.attachmentId && !isUuid(args.attachmentId)) {
    return { ok: false, error: 'Photo not found.' }
  }
  assertCanActOnPerson(ctx, args.personId)

  const attachmentId = args.attachmentId
  if (attachmentId) {
    const [att] = await ctx.db((tx) =>
      tx
        .select({ id: attachments.id, kind: attachments.kind })
        .from(attachments)
        .where(and(eq(attachments.id, attachmentId), eq(attachments.tenantId, ctx.tenantId)))
        .limit(1),
    )
    if (!att) return { ok: false, error: 'Photo not found.' }
    if (att.kind !== 'image') return { ok: false, error: 'The portrait must be an image file.' }
  }

  const updated = await ctx.db(async (tx) => {
    const [old] = await tx
      .select({ photoAttachmentId: people.photoAttachmentId })
      .from(people)
      .where(
        and(
          eq(people.id, args.personId),
          eq(people.tenantId, ctx.tenantId),
          isNull(people.deletedAt),
        ),
      )
      .limit(1)
      .for('update')
    if (!old) return []
    const rows = await tx
      .update(people)
      .set({ photoAttachmentId: args.attachmentId })
      .where(
        and(
          eq(people.id, args.personId),
          eq(people.tenantId, ctx.tenantId),
          isNull(people.deletedAt),
        ),
      )
      .returning({ id: people.id })
    // 1:1 portrait: reclaim the now-unreferenced attachment in the same tx.
    if (old.photoAttachmentId && old.photoAttachmentId !== args.attachmentId) {
      await tx
        .delete(attachments)
        .where(
          and(eq(attachments.id, old.photoAttachmentId), eq(attachments.tenantId, ctx.tenantId)),
        )
    }
    return rows
  })
  if (!updated[0]) return { ok: false, error: 'Person not found.' }

  await recordAudit(ctx, {
    entityType: 'person',
    entityId: args.personId,
    action: 'update',
    summary: args.attachmentId ? 'Set portrait photo' : 'Removed portrait photo',
    metadata: { attachmentId: args.attachmentId },
  })

  revalidatePath(`/people/${args.personId}`)
  return { ok: true }
}

export async function deletePersonFile(formData: FormData): Promise<void> {
  const ctx = await requireRequestContext()
  const id = String(formData.get('id') ?? '')
  const personId = String(formData.get('personId') ?? '')
  if (!id || !personId) return
  assertCanActOnPerson(ctx, personId)

  const before = await ctx.db(async (tx) => {
    const [r] = await tx
      .select()
      .from(personFiles)
      .where(and(eq(personFiles.id, id), eq(personFiles.personId, personId)))
      .limit(1)
    return r
  })
  if (!before) return

  // Delete link + attachment atomically (1:1 person file).
  await ctx.db(async (tx) => {
    await tx.delete(personFiles).where(eq(personFiles.id, id))
    if (before.attachmentId) {
      await tx
        .delete(attachments)
        .where(and(eq(attachments.id, before.attachmentId), eq(attachments.tenantId, ctx.tenantId)))
    }
  })

  await recordAudit(ctx, {
    entityType: 'person',
    entityId: personId,
    action: 'delete',
    summary: `Deleted file: ${before.label}`,
    before: before as unknown as Record<string, unknown>,
    metadata: { personFileId: id, kind: before.kind },
  })

  revalidatePath(`/people/${personId}`)
}
