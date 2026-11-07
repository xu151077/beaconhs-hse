import { getTranslations } from 'next-intl/server'
import { Card, CardContent, DetailHeader } from '@beaconhs/ui'
import { PageContainer } from '@/components/page-layout'
import { getPlatformOpenSourceSettings } from '@/lib/open-source-config'
import { PlatformOpenSourceForm } from './_form'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('OpenSource')
  return { title: t('settingsTitle') }
}

export default async function PlatformOpenSourcePage() {
  const t = await getTranslations('OpenSource')
  const settings = await getPlatformOpenSourceSettings()

  return (
    <PageContainer>
      <div className="max-w-2xl space-y-4">
        <DetailHeader
          back={{ href: '/platform', label: 'Back to platform' }}
          title={t('settingsTitle')}
          subtitle={t('settingsSubtitle')}
        />
        <Card>
          <CardContent className="pt-6">
            <PlatformOpenSourceForm settings={settings} />
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  )
}
