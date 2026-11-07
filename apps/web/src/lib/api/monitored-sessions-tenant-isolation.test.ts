// Live tenant-isolation test for the public API's monitored-session read path.
//
// The route is already covered without a database in
// `monitored-sessions-route.test.ts`: authentication, the permission gate and
// the fact that the route passes the authenticated key's tenant context through.
// This suite proves the half a mock cannot prove: `readEntityRows` executes under
// the caller's `ctx.db` transaction, and PostgreSQL RLS returns no row from
// another tenant even when both rows live in the same view.
//
// It is SKIPPED, not passed, unless SEED_TEST_SCRATCH_DATABASE_URL points at an
// isolated test database. The suite creates and removes its own tenants.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inArray } from 'drizzle-orm'
import { closeDatabaseConnections, db, withSuperAdmin } from '@beaconhs/db'
import { formResponses, formTemplates, formTemplateVersions, tenants } from '@beaconhs/db/schema'
import { makeTenantContext, type RequestContext } from '@beaconhs/tenant'
import { REPORT_ENTITY_MAP } from '@beaconhs/reports'
import { readEntityRows } from './query'

const SCRATCH_URL = process.env.SEED_TEST_SCRATCH_DATABASE_URL

function sameDatabase(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  try {
    const a = new URL(left)
    const b = new URL(right)
    return a.host === b.host && a.pathname === b.pathname
  } catch {
    return false
  }
}

// The imported database clients are created from DATABASE_URL and
// SUPERADMIN_DATABASE_URL before this module body runs, so setting them here
// would be too late. Refuse to run unless the process was started with both
// clients already pointed at the same isolated scratch database. A skipped run
// is preferable to creating and deleting fixtures in a developer database.
const isIsolatedScratch =
  Boolean(SCRATCH_URL) &&
  sameDatabase(SCRATCH_URL, process.env.DATABASE_URL) &&
  sameDatabase(SCRATCH_URL, process.env.SUPERADMIN_DATABASE_URL)

const describeDb = isIsolatedScratch ? describe : describe.skip

if (!isIsolatedScratch) {
  console.warn(
    SCRATCH_URL
      ? '[api-monitored-sessions] refusing to run: DATABASE_URL and SUPERADMIN_DATABASE_URL must both point at SEED_TEST_SCRATCH_DATABASE_URL — tenant-isolation scenarios are SKIPPED, not passed.'
      : '[api-monitored-sessions] SEED_TEST_SCRATCH_DATABASE_URL is not set — tenant-isolation scenarios are SKIPPED, not passed.',
  )
}

const monitoredSessions = REPORT_ENTITY_MAP['monitored_sessions']!

type Fixture = {
  tenantId: string
  appName: string
}

function context(tenantId: string): RequestContext {
  return makeTenantContext(db, {
    userId: `api_key:${tenantId}`,
    tenantId,
    isSuperAdmin: false,
    timezone: 'UTC',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: null,
    personId: null,
    permissions: new Set(['forms.response.read.all']),
    scopes: [{ type: 'tenant' }],
    activeRoleId: null,
  })
}

async function createTenantFixture(name: string): Promise<Fixture> {
  const tenantId = randomUUID()
  const templateId = randomUUID()
  const versionId = randomUUID()
  const appName = `Monitored ${name}`

  await withSuperAdmin(db, async (tx) => {
    await tx.insert(tenants).values({
      id: tenantId,
      slug: `${name}-${tenantId.slice(0, 8)}`,
      name: appName,
    })
    await tx.insert(formTemplates).values({
      id: templateId,
      tenantId,
      key: `monitored-${name}`,
      name: appName,
      status: 'published',
    })
    await tx.insert(formTemplateVersions).values({
      id: versionId,
      tenantId,
      templateId,
      version: 1,
      schema: { version: 1, sections: [] } as never,
      publishedAt: new Date(),
    })
    await tx.insert(formResponses).values({
      id: randomUUID(),
      tenantId,
      templateId,
      templateVersionId: versionId,
      status: 'submitted',
      monitorStatus: 'active',
      data: {},
    })
  })

  return { tenantId, appName }
}

describeDb('monitored-sessions API read path (live database + RLS)', () => {
  let alpha: Fixture
  let beta: Fixture

  beforeAll(async () => {
    alpha = await createTenantFixture('alpha')
    beta = await createTenantFixture('beta')
  })

  afterAll(async () => {
    await withSuperAdmin(db, async (tx) => {
      await tx.delete(tenants).where(inArray(tenants.id, [alpha.tenantId, beta.tenantId]))
    })
    await closeDatabaseConnections()
  })

  it("returns the caller tenant's session and refuses the other tenant's row", async () => {
    const alphaPage = await readEntityRows(
      context(alpha.tenantId),
      monitoredSessions,
      new URLSearchParams(),
    )
    const betaPage = await readEntityRows(
      context(beta.tenantId),
      monitoredSessions,
      new URLSearchParams(),
    )

    expect(alphaPage.data.map((row) => row.app_name)).toEqual([alpha.appName])
    expect(betaPage.data.map((row) => row.app_name)).toEqual([beta.appName])
    expect(alphaPage.data.map((row) => row.app_name)).not.toContain(beta.appName)
    expect(betaPage.data.map((row) => row.app_name)).not.toContain(alpha.appName)
  })
})
