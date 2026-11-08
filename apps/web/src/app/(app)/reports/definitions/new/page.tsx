import { assertCan } from '@beaconhs/tenant'
import { asc, like, or } from 'drizzle-orm'
import { reportDefinitions } from '@beaconhs/db/schema'
import {
  DEFAULT_REPORT_LAYOUT,
  defaultColumnsFor,
  type CustomReportDefinition,
} from '@beaconhs/reports'
import { PageContainer } from '@/components/page-layout'
import { getGeneratedTranslations } from '@/i18n/generated.server'
import { requireRequestContext } from '@/lib/auth'
import { loadAuthorizedReportCatalog } from '@/lib/report-catalog'
import { ReportsBackLink } from '../../_back-link'
import { loadTenantBranding } from '../../_run'
import { BeaconReportStudio } from '../../_studio/studio.client'

export default async function NewReportPage() {
  const tGenerated = await getGeneratedTranslations()
  const ctx = await requireRequestContext()
  assertCan(ctx, 'reports.builder')
  const [branding, catalog] = await Promise.all([
    loadTenantBranding(ctx),
    loadAuthorizedReportCatalog(ctx),
  ])
  const defaultBaseName = tGenerated('m_017ca81c89345d')
  // The slug is a stable machine key and must stay ASCII kebab-case even when
  // the display name is localized (a Chinese name would otherwise strip to an
  // empty slug and fail `assertCustomReportDefinition` on first preview/save).
  const defaultSlugBase = 'custom-report'
  const existingDefaults = await ctx.db((tx) =>
    tx
      .select({ name: reportDefinitions.name, slug: reportDefinitions.slug })
      .from(reportDefinitions)
      .where(
        or(
          like(reportDefinitions.name, `${defaultBaseName}%`),
          like(reportDefinitions.slug, `${defaultSlugBase}%`),
        ),
      )
      .orderBy(asc(reportDefinitions.name)),
  )
  const existingNames = new Set(existingDefaults.map((row) => row.name))
  let defaultName = defaultBaseName
  for (let suffix = 2; existingNames.has(defaultName); suffix += 1) {
    defaultName = `${defaultBaseName} ${suffix}`
  }
  const existingSlugs = new Set(existingDefaults.map((row) => row.slug))
  let defaultSlug = defaultSlugBase
  for (let suffix = 2; existingSlugs.has(defaultSlug); suffix += 1) {
    defaultSlug = `${defaultSlugBase}-${suffix}`
  }
  const source = catalog.entities[0]!
  const definition: CustomReportDefinition = {
    schemaVersion: 1,
    id: 'new',
    slug: defaultSlug,
    name: defaultName,
    description: tGenerated('m_0352af5525392e'),
    query: {
      entity: source.key,
      mode: 'rows',
      columns: defaultColumnsFor(source),
      filters: null,
      groupBy: null,
      sort: source.defaultSort ?? null,
      sorts: source.defaultSort ? [source.defaultSort] : null,
      limit: 1000,
    },
    layout: DEFAULT_REPORT_LAYOUT,
    state: 'published',
    tags: [source.category],
  }
  return (
    <PageContainer className="flex min-h-full flex-col gap-3">
      <ReportsBackLink />
      <BeaconReportStudio
        definition={definition}
        initialResult={null}
        organization={branding.name}
        logoUrl={branding.logoUrl}
        primaryColor={branding.primaryColor}
        catalog={catalog}
      />
    </PageContainer>
  )
}
