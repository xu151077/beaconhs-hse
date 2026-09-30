// Download a published version's artifact: ?kind=pdf (default — the document
// of record) or ?kind=docx (the immutable Word snapshot). Readers can fetch
// published versions; unpublished snapshots require documents.manage.
//
// Two conjunctive rules gate the blob, and BOTH must pass:
//
//   1. the PARENT document must be live (`deleted_at IS NULL`) and — for anyone
//      who is not a document manager — `status = 'published'`, via the shared
//      `documentReadFilter`. This is the same rule the list, detail, reader and
//      assistant surfaces apply; it is not re-derived here.
//   2. the version itself must be published, unless the caller manages documents.
//
// Rule 1 exists because `document_versions` has no `deleted_at` and no `status`:
// without loading the parent, a soft-deleted document's artifacts remained
// downloadable to anyone holding `documents.read` who knew the two UUIDs.
//
// PROJECT SCOPE IS DELIBERATELY ABSENT. `documents` has no reliable binding
// column — no org unit, no site, no person, and `owner_tenant_user_id` is
// authorship rather than placement. Restricting this route to a caller's scope
// therefore needs a product decision (withhold, exempt as tenant-level
// controlled-library data, or add a real placement column) before it can be
// written. Until then this route matches every other document read surface:
// tenant-wide within the tenant boundary. Do not "fix" this by borrowing
// `document_acknowledgment_sessions.site_org_unit_id` — that is a sign-off
// instance's location, not the document's, and a document may have sessions at
// several sites or none at all.

import { NextResponse, type NextRequest } from 'next/server'
import { and, eq, isNull, type SQL } from 'drizzle-orm'
import { attachments, documents, documentVersions } from '@beaconhs/db/schema'
import { assertCan, can } from '@beaconhs/tenant'
import { getObjectStream } from '@beaconhs/storage'
import { requireRequestContext } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { documentReadFilter } from '@/lib/assistant/doc-access'
import { isUuid } from '@/lib/list-params'
import { isRouterPrefetch } from '@/lib/router-prefetch'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  routeCtx: { params: Promise<{ id: string; versionId: string }> },
): Promise<Response> {
  if (isRouterPrefetch(req)) return new Response(null, { status: 204 })

  const { id, versionId } = await routeCtx.params
  if (!isUuid(id) || !isUuid(versionId)) return new NextResponse('Not found', { status: 404 })

  const kind = req.nextUrl.searchParams.get('kind') === 'docx' ? 'docx' : 'pdf'
  const ctx = await requireRequestContext()
  assertCan(ctx, 'documents.read')

  const att = await ctx.db(async (tx) => {
    // The PARENT DOCUMENT IS LOADED, not assumed.
    //
    // `document_versions` carries neither `deleted_at` nor `status`, so a version
    // row on its own can never answer "is this document still live, and may this
    // caller read it?" — which is why a soft-deleted document's versions stayed
    // downloadable for as long as the two UUIDs were known. The join below makes
    // the parent a real precondition rather than an inference.
    //
    // `documentReadFilter` is the single source of truth for the second half. It
    // yields `undefined` for a manager (no status restriction) and
    // `documents.status = 'published'` for everyone else — the identical rule the
    // list, detail, reader and assistant-content surfaces apply. Reusing it here
    // is what removes the fourth copy of that rule.
    //
    // The version-level `publishedAt` check is KEPT as well, and it is not
    // redundant: it is what stops a reader from pulling an unpublished snapshot
    // out of an otherwise-published document. Both checks are conjunctive, so
    // this is strictly narrower than before — no previously-authorized download
    // is lost.
    const documentConds: SQL[] = [eq(documents.id, id), isNull(documents.deletedAt)]
    const readFilter = documentReadFilter(ctx)
    if (readFilter) documentConds.push(readFilter)

    const [v] = await tx
      .select({
        version: documentVersions.version,
        publishedAt: documentVersions.publishedAt,
        docxAttachmentId: documentVersions.docxAttachmentId,
        pdfAttachmentId: documentVersions.pdfAttachmentId,
        contentAttachmentId: documentVersions.contentAttachmentId,
      })
      .from(documentVersions)
      .innerJoin(
        documents,
        and(eq(documents.id, documentVersions.documentId), and(...documentConds)),
      )
      .where(and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, id)))
      .limit(1)
    if (!v) return null
    if (!v.publishedAt && !can(ctx, 'documents.manage')) return null
    const attachmentId =
      kind === 'docx' ? v.docxAttachmentId : (v.pdfAttachmentId ?? v.contentAttachmentId)
    if (!attachmentId) return null
    const [row] = await tx
      .select({ key: attachments.r2Key, filename: attachments.filename })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1)
    return row ? { ...row, versionNumber: v.version } : null
  })
  if (!att) return new NextResponse('Not found', { status: 404 })

  await recordAudit(ctx, {
    entityType: 'document',
    entityId: id,
    action: 'export',
    summary: `Downloaded v${att.versionNumber} ${kind.toUpperCase()} "${att.filename}"`,
    metadata: { versionId, kind },
  })

  const obj = await getObjectStream({ key: att.key })
  const filename = att.filename.replace(/[^\w.\- ]+/g, '_') || `document.${kind}`
  return new NextResponse(obj.stream, {
    headers: {
      'Content-Type': obj.contentType ?? 'application/octet-stream',
      ...(obj.contentLength ? { 'Content-Length': String(obj.contentLength) } : {}),
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
