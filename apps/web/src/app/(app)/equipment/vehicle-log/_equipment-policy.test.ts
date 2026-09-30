import { describe, expect, it } from 'vitest'
import { orgUnits, peopleAssignments } from '@beaconhs/db/schema'

/** The tenant user this suite reads as; also their `people` row id. */
const READER_PERSON = '018f47ba-86c4-7ee2-8d7a-5e7602f2afff'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { Database } from '@beaconhs/db'
import type { RequestContext } from '@beaconhs/tenant'
import { resolveVehicleEquipmentWhere } from './_equipment-policy'

const SITE_A = '018f47ba-86c4-7ee2-8d7a-5e7602f2a001'
const SITE_B = '018f47ba-86c4-7ee2-8d7a-5e7602f2a002'

function context(siteId: string): RequestContext {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    isSuperAdmin: false,
    timezone: 'America/Toronto',
    locale: 'en',
    defaultLocale: 'en',
    enabledLocales: ['en'],
    localeOverride: null,
    membership: { id: 'membership-1', displayName: 'Site reader' },
    personId: READER_PERSON,
    permissions: new Set(['equipment.read.site']),
    scopes: [{ type: 'sites', siteIds: [siteId] }],
    db: async () => {
      throw new Error('Database access is not expected')
    },
  }
}

/**
 * The count query plus the Project Scope queries.
 *
 * Since 15B-2 the visibility ladder resolves a Project Scope first, so this
 * stand-in must also answer the resolver's assignment and org-unit lookups. The
 * reader is modelled as assigned to the site they are scoped to, so the suite's
 * own site-visibility assertions are unchanged and stay meaningful.
 */
function countOnlyTx(classifiedCount: number, siteId: string): Database {
  const otherSite = siteId === SITE_A ? SITE_B : SITE_A
  const orgs = [
    { id: siteId, parentId: null, level: 'site', deletedAt: null },
    { id: otherSite, parentId: null, level: 'site', deletedAt: null },
  ]
  const assignments = [
    { personId: READER_PERSON, orgUnitId: siteId, validFrom: '2020-01-01', validTo: null },
  ]
  const query: Record<string, unknown> = {}
  let table: unknown = null
  query.from = (t: unknown) => {
    table = t
    return query
  }
  query.leftJoin = () => query
  query.orderBy = () => query
  query.limit = () => query
  query.where = async () => {
    if (table === orgUnits) return orgs
    if (table === peopleAssignments) return assignments
    return [{ c: classifiedCount }]
  }
  query.selectDistinct = () => query
  return { select: () => query, selectDistinct: () => query } as unknown as Database
}

function compiled(where: Awaited<ReturnType<typeof resolveVehicleEquipmentWhere>>['where']) {
  return new PgDialect().sqlToQuery(where)
}

describe('vehicle-log equipment visibility', () => {
  it('builds a site-A-only predicate and never includes a different site', async () => {
    const result = await resolveVehicleEquipmentWhere(context(SITE_A), countOnlyTx(12, SITE_A))
    const query = compiled(result.where)

    expect(result.usesVehicleTaxonomy).toBe(true)
    expect(query.sql).toContain('"equipment_items"."current_site_org_unit_id" in')
    expect(query.params).toContain(SITE_A)
    expect(query.params).not.toContain(SITE_B)
  })

  it('resolves the same policy independently for site B', async () => {
    const query = compiled(
      (await resolveVehicleEquipmentWhere(context(SITE_B), countOnlyTx(8, SITE_B))).where,
    )

    expect(query.params).toContain(SITE_B)
    expect(query.params).not.toContain(SITE_A)
  })

  it('keeps the vehicle taxonomy for more than 500 mixed accessible rows without a cap', async () => {
    const result = await resolveVehicleEquipmentWhere(context(SITE_A), countOnlyTx(620, SITE_A))
    const query = compiled(result.where)

    expect(result.usesVehicleTaxonomy).toBe(true)
    expect(query.params).toContain('%vehicle%')
    expect(query.params).toContain('%truck%')
  })

  it('falls back to all scope-safe equipment only when no accessible item has vehicle taxonomy', async () => {
    const result = await resolveVehicleEquipmentWhere(context(SITE_A), countOnlyTx(0, SITE_A))
    const query = compiled(result.where)

    expect(result.usesVehicleTaxonomy).toBe(false)
    expect(query.params).not.toContain('%vehicle%')
    expect(query.params).not.toContain('%truck%')
    expect(query.params).toContain(SITE_A)
  })
})
