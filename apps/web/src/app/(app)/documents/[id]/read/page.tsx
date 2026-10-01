import { getGeneratedTranslations } from '@/i18n/generated.server'
import { notFound } from 'next/navigation'
import { and, desc, eq, isNotNull, isNull, type SQL } from 'drizzle-orm'
import { documentAcknowledgments, documentVersions, documents } from '@beaconhs/db/schema'
import { can } from '@beaconhs/tenant'
import { requireRequestContext } from '@/lib/auth'
import { documentAuthorizationFilter } from '@/lib/assistant/document-project-scope'
import { isUuid } from '@/lib/list-params'
import { DocumentReader } from './_reader'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const tGenerated = await getGeneratedTranslations()
  return { title: tGenerated('m_0431e4b7409595') }
}

export default async function DocumentReadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const ctx = await requireRequestContext()
  const canManage = ctx.isSuperAdmin || can(ctx, 'documents.manage')
  const canRead = canManage || can(ctx, 'documents.read')
  if (!canRead) notFound()
  const canAcknowledge = ctx.isSuperAdmin || can(ctx, 'documents.acknowledge')

  const data = await ctx.db(async (tx) => {
    // The published rule is applied IN the statement rather than as a JavaScript
    // comparison on a row we have already fetched. Same verdict, one less row
    // crossing the boundary: an unpublished document now fails to match at all,
    // so `!doc` below produces the same 404 the explicit `status` check used to.
    //
    // `documentReadFilter` yields `undefined` for a manager, and a manager is
    // NOT thereby allowed to see unpublished versions — the version query below
    // still requires `publishedAt`, unchanged.
    const visibility = await documentAuthorizationFilter(ctx, tx)
    const docConds: SQL[] = [eq(documents.id, id), isNull(documents.deletedAt)]
    if (visibility) docConds.push(visibility)

    const [doc] = await tx
      .select({
        id: documents.id,
        title: documents.title,
        key: documents.key,
        status: documents.status,
      })
      .from(documents)
      .where(and(...docConds))
      .limit(1)
    if (!doc) return null

    const [publishedVersion] = await tx
      .select({
        id: documentVersions.id,
        version: documentVersions.version,
      })
      .from(documentVersions)
      .where(and(eq(documentVersions.documentId, id), isNotNull(documentVersions.publishedAt)))
      .orderBy(desc(documentVersions.version))
      .limit(1)

    const myAck =
      ctx.personId && publishedVersion
        ? ((
            await tx
              .select({ acknowledgedAt: documentAcknowledgments.acknowledgedAt })
              .from(documentAcknowledgments)
              .where(
                and(
                  eq(documentAcknowledgments.documentId, id),
                  eq(documentAcknowledgments.personId, ctx.personId),
                  eq(documentAcknowledgments.versionId, publishedVersion.id),
                ),
              )
              .orderBy(desc(documentAcknowledgments.acknowledgedAt))
              .limit(1)
          )[0] ?? null)
        : null

    return { doc, publishedVersion: publishedVersion ?? null, myAck }
  })

  if (!data) notFound()

  const selfStatus: 'can' | 'acked' | 'unpublished' | 'no-person' | 'no-permission' =
    !canAcknowledge
      ? 'no-permission'
      : !ctx.personId
        ? 'no-person'
        : data.myAck
          ? 'acked'
          : !data.publishedVersion
            ? 'unpublished'
            : 'can'

  return (
    <DocumentReader
      documentId={id}
      title={data.doc.title}
      documentKey={data.doc.key}
      versionNumber={data.publishedVersion?.version ?? null}
      selfStatus={selfStatus}
      selfAckedAt={data.myAck?.acknowledgedAt.toISOString() ?? null}
      canManage={canManage}
    />
  )
}
