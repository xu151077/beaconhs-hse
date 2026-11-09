'use server'

// Office-master actions for authored documents. The matching Collabora app (Writer,
// Impress or Calc) is THE editor: the master file is the working draft
// WOPI host — page setup, comments and track changes live in the file), and
// publishing snapshots it into an immutable, numbered document_versions row
// whose PDF + text the worker renders for readers.

import { revalidatePath } from 'next/cache'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { attachments, documents, documentVersions } from '@beaconhs/db/schema'
import { materializeEvidenceTargetObligations } from '@beaconhs/compliance'
import { assertCan, can } from '@beaconhs/tenant'
import {
  deleteObject,
  getObject,
  newAttachmentKey,
  putObject,
  assertStorageWriteAllowed,
} from '@beaconhs/storage'
import { enqueueDocumentVersionRender } from '@beaconhs/jobs'
import {
  DOCX_MIME_TYPE,
  MAX_OFFICE_SOURCE_BYTES,
  officeSourceExtension,
} from '@beaconhs/office/limits'
import { requireRequestContext } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { STORAGE_FROZEN_ACTION } from '@/lib/storage-freeze-copy'
import { isStorageFreezeRefusal } from '@/lib/storage-freeze-refusal'
import { buildEditorUrl, collaboraAppForMime, getCollaboraEditUrl } from '@/lib/collabora'
import { mintWopiToken } from '@/lib/wopi'
import { tenantIsActive } from '@/lib/active-tenant'
import { blankDocxBuffer } from '@/lib/docx-blank'
import { isUuid } from '@/lib/list-params'
import {
  documentMasterMetadataError,
  MAX_DOCUMENT_VERSION_NOTE_CHARS,
  nextDocumentMajorVersion,
  type DocumentMasterMetadata,
} from '@/lib/document-authoring-policy'
import type { CollaboraSession } from '@/components/collabora-embed'

type DocumentMasterAttachment = {
  id: string
  key: string
} & DocumentMasterMetadata

function assertDocumentId(value: string): void {
  if (!isUuid(value)) throw new Error('Document not found')
}

function assertDocumentMasterAttachment(attachment: DocumentMasterAttachment): void {
  const error = documentMasterMetadataError(attachment)
  if (error) throw new Error(error)
}

/**
 * Mint a Writer session. Without `versionId` this opens the live master
 * (writable, documents.manage). With `versionId` it opens that immutable
 * published snapshot read-only (documents.read) — version history viewing.
 */
export async function getDocumentWriterSession(
  documentId: string,
  versionId?: string,
): Promise<CollaboraSession> {
  if (!isUuid(documentId) || (versionId !== undefined && !isUuid(versionId))) {
    return { ok: false, error: 'no_master' }
  }
  const ctx = await requireRequestContext()
  assertCan(ctx, versionId ? 'documents.read' : 'documents.manage')
  if (ctx.impersonation) return { ok: false, error: 'impersonation_blocked' }
  if (!(await tenantIsActive(ctx.tenantId))) {
    return { ok: false, error: 'workspace_unavailable' }
  }

  const attachmentId = await ctx.db(async (tx) => {
    if (versionId) {
      const [v] = await tx
        .select({
          docxAttachmentId: documentVersions.docxAttachmentId,
          publishedAt: documentVersions.publishedAt,
        })
        .from(documentVersions)
        .where(and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, documentId)))
        .limit(1)
      // Readers only ever see published snapshots.
      if (!v?.publishedAt && !can(ctx, 'documents.manage')) return null
      return v?.docxAttachmentId ?? null
    }
    const [doc] = await tx
      .select({ sourceAttachmentId: documents.sourceAttachmentId })
      .from(documents)
      .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
      .limit(1)
    return doc?.sourceAttachmentId ?? null
  })
  if (!attachmentId) return { ok: false, error: 'no_master' }

  // Phase 6T-B: Check freeze state before minting a WOPI token.
  // Retrieve the attachment to get its key, which names the tenant.
  const [attachment] = await ctx.db(async (tx) =>
    tx
      .select({
        r2Key: attachments.r2Key,
        filename: attachments.filename,
        contentType: attachments.contentType,
      })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1),
  )
  if (!attachment) return { ok: false, error: 'no_master' }

  try {
    await assertStorageWriteAllowed({ operation: 'wopiToken', key: attachment.r2Key })
  } catch (error) {
    return { ok: false, error: 'workspace_frozen' }
  }

  const editUrl = await getCollaboraEditUrl(collaboraAppForMime(attachment.contentType))
  if (!editUrl) return { ok: false, error: 'not_configured' }

  const { token, exp } = mintWopiToken({
    attachmentId,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    userName: ctx.membership?.displayName ?? 'BeaconHS user',
    target: 'document',
    targetId: documentId,
    audience: 'document',
    courseId: null,
    enrollmentId: null,
    lessonId: null,
    canWrite: !versionId,
    activeRoleId: ctx.activeRoleId ?? null,
  })
  return {
    ok: true,
    actionUrl: buildEditorUrl(editUrl, attachmentId),
    accessToken: token,
    accessTokenTtl: exp,
  }
}

/**
 * Start a new document: create a blank .docx master.
 *
 * Returns a refusal instead of throwing when the tenant's storage is frozen: a
 * freeze is an expected product state, and an exception here is masked by the RSC
 * runtime into an opaque "Minified React error #441" with no usable message. Every
 * other failure still throws, so a permission or database fault is never disguised
 * as a frozen workspace.
 */
export async function createBlankDocumentMaster(
  documentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  assertDocumentId(documentId)
  const ctx = await requireRequestContext()
  assertCan(ctx, 'documents.manage')
  if (!ctx.tenantId) throw new Error('No active tenant')
  const tenantId = ctx.tenantId

  const docx = blankDocxBuffer()
  let createdKey: string | null = null
  let frozen = false
  try {
    await ctx.db(async (tx) => {
      const [doc] = await tx
        .select({
          title: documents.title,
          key: documents.key,
          sourceAttachmentId: documents.sourceAttachmentId,
        })
        .from(documents)
        .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
        .limit(1)
        .for('update')
      if (!doc) throw new Error('Document not found')
      if (doc.sourceAttachmentId) throw new Error('This document already has a working file')

      const base =
        (doc.key || doc.title || 'Document')
          .replace(/[^\w.\- ]+/g, '')
          .trim()
          .slice(0, 180) || 'Document'
      const filename = `${base}.docx`
      createdKey = newAttachmentKey({ tenantId, kind: 'document', filename })

      // Phase 6T-B: Check freeze state before creating a blank document.
      // The key names the tenant; a frozen tenant is refused here, before any bytes
      // are written, and reported back as a normal business outcome.
      try {
        await assertStorageWriteAllowed({ operation: 'putObject', key: createdKey })
      } catch (error) {
        if (isStorageFreezeRefusal(error)) {
          frozen = true
          return
        }
        throw error
      }

      await putObject({ key: createdKey, body: docx, contentType: DOCX_MIME_TYPE })
      const [attachment] = await tx
        .insert(attachments)
        .values({
          tenantId,
          uploadedBy: ctx.userId,
          kind: 'document',
          r2Key: createdKey,
          contentType: DOCX_MIME_TYPE,
          sizeBytes: docx.length,
          filename,
        })
        .returning({ id: attachments.id })
      if (!attachment) throw new Error('Failed to create the document file')
      await tx
        .update(documents)
        .set({ sourceAttachmentId: attachment.id })
        .where(eq(documents.id, documentId))
    })
  } catch (error) {
    if (createdKey) {
      await deleteObject({ key: createdKey }).catch((cleanupError) => {
        console.error('[documents] failed to clean an uncommitted blank master', {
          documentId,
          createdKey,
          cleanupError,
        })
      })
    }
    throw error
  }
  if (frozen) return { ok: false, error: STORAGE_FROZEN_ACTION }
  await recordAudit(ctx, {
    entityType: 'document',
    entityId: documentId,
    action: 'update',
    summary: 'Started a new Word document',
  })
  revalidatePath(`/documents/${documentId}`)
  return { ok: true }
}

/** Import / replace the working master with an uploaded .docx, .pptx or .xlsx. */
export async function importDocumentMaster(documentId: string, attachmentId: string) {
  assertDocumentId(documentId)
  if (!isUuid(attachmentId)) throw new Error('Uploaded file not found')
  const ctx = await requireRequestContext()
  assertCan(ctx, 'documents.manage')

  await ctx.db(async (tx) => {
    const [doc] = await tx
      .select({ id: documents.id, sourceAttachmentId: documents.sourceAttachmentId })
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.tenantId, ctx.tenantId),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1)
      .for('update')
    if (!doc) throw new Error('Document not found')
    const [att] = await tx
      .select({
        id: attachments.id,
        key: attachments.r2Key,
        kind: attachments.kind,
        contentType: attachments.contentType,
        sizeBytes: attachments.sizeBytes,
        filename: attachments.filename,
      })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1)
    if (!att) throw new Error('Uploaded file not found')
    assertDocumentMasterAttachment(att)
    await tx
      .update(documents)
      .set({ sourceAttachmentId: attachmentId })
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, ctx.tenantId)))
    // 1:1 master: reclaim the replaced master attachment in the same tx.
    if (doc.sourceAttachmentId && doc.sourceAttachmentId !== attachmentId) {
      await tx
        .delete(attachments)
        .where(
          and(eq(attachments.id, doc.sourceAttachmentId), eq(attachments.tenantId, ctx.tenantId)),
        )
    }
  })
  await recordAudit(ctx, {
    entityType: 'document',
    entityId: documentId,
    action: 'update',
    summary: 'Imported an Office file as the working document',
    after: { attachmentId },
  })
  revalidatePath(`/documents/${documentId}`)
}

/**
 * Publish: snapshot the DOCX master into an immutable numbered version and
 * queue its PDF/text render. The master keeps living as the next draft.
 */
export async function publishDocumentVersion(documentId: string, changelog?: string) {
  assertDocumentId(documentId)
  if (changelog !== undefined && typeof changelog !== 'string') {
    throw new Error('The version note is invalid')
  }
  const normalizedChangelog = changelog?.trim() ?? ''
  if (normalizedChangelog.length > MAX_DOCUMENT_VERSION_NOTE_CHARS) {
    throw new Error(
      `The version note must be ${MAX_DOCUMENT_VERSION_NOTE_CHARS} characters or fewer`,
    )
  }

  const ctx = await requireRequestContext()
  assertCan(ctx, 'documents.manage')
  if (!ctx.tenantId) throw new Error('No active tenant')
  const tenantId = ctx.tenantId

  let snapshotKey: string | null = null
  let versionId: string
  try {
    versionId = await ctx.db(async (tx) => {
      // The document row is the publication mutex. It serializes version
      // allocation and keeps WOPI/import from swapping the master while its
      // immutable snapshot is being copied.
      const [doc] = await tx
        .select({
          title: documents.title,
          key: documents.key,
          sourceAttachmentId: documents.sourceAttachmentId,
        })
        .from(documents)
        .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
        .limit(1)
        .for('update')
      if (!doc?.sourceAttachmentId) throw new Error('This document has no office file to publish')

      const [attachment] = await tx
        .select({
          id: attachments.id,
          key: attachments.r2Key,
          kind: attachments.kind,
          contentType: attachments.contentType,
          sizeBytes: attachments.sizeBytes,
          filename: attachments.filename,
        })
        .from(attachments)
        .where(eq(attachments.id, doc.sourceAttachmentId))
        .limit(1)
      if (!attachment) throw new Error('The working document file is missing')
      assertDocumentMasterAttachment(attachment)

      const bytes = await getObject({ key: attachment.key })
      if (bytes.length !== attachment.sizeBytes || bytes.length > MAX_OFFICE_SOURCE_BYTES) {
        throw new Error('The working document size does not match its attachment record')
      }

      const [latest] = await tx
        .select({ version: documentVersions.version })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, documentId))
        .orderBy(desc(documentVersions.version))
        .limit(1)
      const nextVersion = nextDocumentMajorVersion(latest?.version)

      const base =
        (doc.key || doc.title || 'document')
          .replace(/[^\w.\- ]+/g, '')
          .trim()
          .slice(0, 180) || 'document'
      const sourceExtension = officeSourceExtension(attachment.contentType)
      if (!sourceExtension) throw new Error('The working document file type is not supported')
      const filename = `${base}-v${nextVersion}.${sourceExtension}`
      snapshotKey = newAttachmentKey({ tenantId, kind: 'document', filename })
      await putObject({
        key: snapshotKey,
        body: bytes,
        contentType: attachment.contentType,
      })

      const [snapshot] = await tx
        .insert(attachments)
        .values({
          tenantId,
          uploadedBy: ctx.userId,
          kind: 'document',
          r2Key: snapshotKey,
          contentType: attachment.contentType,
          sizeBytes: bytes.length,
          filename,
        })
        .returning({ id: attachments.id })
      if (!snapshot) throw new Error('Failed to snapshot the document file')

      const [version] = await tx
        .insert(documentVersions)
        .values({
          tenantId,
          documentId,
          version: nextVersion,
          docxAttachmentId: snapshot.id,
          renderStatus: 'pending',
          publishedAt: new Date(),
          publishedBy: ctx.userId,
          changelog: normalizedChangelog || null,
        })
        .returning({ id: documentVersions.id })
      if (!version) throw new Error('Failed to create the version')

      await tx.update(documents).set({ status: 'published' }).where(eq(documents.id, documentId))
      await materializeEvidenceTargetObligations(tx, tenantId, {
        sourceModule: 'document',
        targetRef: { documentId },
      })
      return version.id
    })
  } catch (error) {
    if (snapshotKey) {
      await deleteObject({ key: snapshotKey }).catch((cleanupError) => {
        console.error('[documents] failed to clean an uncommitted version snapshot', {
          documentId,
          snapshotKey,
          cleanupError,
        })
      })
    }
    throw error
  }

  try {
    await enqueueDocumentVersionRender({
      kind: 'document_version_render',
      tenantId,
      documentId,
      versionId,
    })
  } catch (error) {
    // The durable version is already committed. The scheduled stale-pending
    // reconciler re-enqueues it; surfacing a false publish failure would invite
    // the operator to create a duplicate version.
    console.error('[documents] published version awaits render reconciliation', {
      documentId,
      versionId,
      error,
    })
  }
  await recordAudit(ctx, {
    entityType: 'document',
    entityId: documentId,
    action: 'publish',
    summary: 'Published a new version',
    metadata: { versionId, changelog: normalizedChangelog || null },
  })
  revalidatePath(`/documents/${documentId}`)
}
