import { getGeneratedTranslations } from '@/i18n/generated.server'
import { notFound } from 'next/navigation'
import { PageHeader } from '@beaconhs/ui'
import { requireRequestContext } from '@/lib/auth'
import { DetailPageLayout } from '@/components/page-layout'
import { isUuid } from '@/lib/list-params'
import { journalMutationFlags } from '../../journals/_mutation-policy'
import { getObservation, listObservationActions } from '../_data'
import { ObservationView } from './_observation-view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const tGenerated = await getGeneratedTranslations()
  return { title: tGenerated('m_1c17d55bdc29d4') }
}

export default async function ObservationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const ctx = await requireRequestContext()
  const flags = journalMutationFlags(ctx)

  // `getObservation` returns null for an id that does not exist AND for one the
  // caller may not see — the journals read tier, the own-record cross-site rule,
  // the soft delete and the observation class partition all sit inside it. Both
  // cases 404, so a guessed id never reveals that a record is there.
  const entry = await getObservation(ctx, id)
  if (!entry) notFound()

  // The linked actions are read through the observation, so an invisible
  // observation is already gone before this runs; the list itself is filtered by
  // the caller's own `ca` read boundary.
  const actions = await listObservationActions(ctx, entry.id)

  const tGenerated = await getGeneratedTranslations()
  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={tGenerated('m_1c17d55bdc29d4')}
          description={tGenerated('m_1a2e65e20a4428')}
        />
      }
    >
      <ObservationView
        entry={entry}
        actions={actions}
        canEdit={flags.canEdit}
        canSubmit={flags.canSubmit}
      />
    </DetailPageLayout>
  )
}
