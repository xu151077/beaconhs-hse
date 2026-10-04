// Report seeds must compile against the catalogue REPORTS ACTUALLY RUN AGAINST.
//
// Reports never read `REPORT_ENTITIES`. `runReportForViewer` and the Studio both
// go `loadAuthorizedReportCatalogInTransaction` -> `resolveAnalyticsAccess` ->
// `discoverEntitiesWithScopedApps`, so the real catalogue is the schema-discovered
// inventory with the curated `report_*` projections merged in.
//
// Asserting seeds compile against the CURATED list instead imposes a stricter
// rule than the product has: every seed must name a curated entity. That rule is
// unsatisfiable for a plain physical table, and the only way to satisfy it is to
// add the table to `REPORT_ENTITIES` — which also PUBLISHES it on /api/v1 with no
// read gate. So the fixture here is discovery, and `seed-parity.test.ts` keeps
// pinning the curated list so this decoupling cannot silently widen the API.
//
// This lives in apps/web rather than packages/reports because
// `@beaconhs/analytics` depends on `@beaconhs/reports`: importing discovery from
// a test inside `packages/reports` would create a package cycle that Turbo
// refuses to build, even for a devDependency.
//
// No database is required — `discoverEntities()` is the DB-free half of the same
// discovery that `discoverEntitiesWithScopedApps` wraps.

import { describe, expect, it } from 'vitest'
import {
  discoverEntities,
  scopeAnalyticsEntities,
  type AnalyticsScopeSubject,
} from '@beaconhs/analytics/server'
import { compileCustomReport, REPORT_ENTITIES, type ReportEntityCatalog } from '@beaconhs/reports'
import { BEACON_REPORT_SEEDS } from '@beaconhs/db/seed/report-definitions'

const TENANT = '00000000-0000-4000-8000-000000000001'

const RUNTIME_CATALOG: ReportEntityCatalog = {
  entities: discoverEntities() as unknown as ReportEntityCatalog['entities'],
}

/** Seeds that target an entity the discovered catalogue does not expose. */
function seedsMissingFromRuntime(): string[] {
  const keys = new Set(RUNTIME_CATALOG.entities.map((entity) => entity.key))
  return BEACON_REPORT_SEEDS.filter((d) => !keys.has(d.query.entity)).map(
    (d) => `${d.seedKey} -> ${d.query.entity}`,
  )
}

describe('report seeds compile against the runtime (discovered) catalogue', () => {
  it('uses a genuinely larger catalogue than the curated list', () => {
    // If these were equal, this file would be testing the curated list again
    // under a misleading name.
    expect(RUNTIME_CATALOG.entities.length).toBeGreaterThan(REPORT_ENTITIES.length)
  })

  it('compiles every seeded definition through the one AppKit query contract', () => {
    for (const definition of BEACON_REPORT_SEEDS) {
      expect(() =>
        compileCustomReport(definition.query, TENANT, RUNTIME_CATALOG, { maxRows: 1 }),
      ).not.toThrow()
    }
  })

  it('binds tenant_id for every seed, so no seed can widen past its tenant', () => {
    for (const definition of BEACON_REPORT_SEEDS) {
      const compiled = compileCustomReport(definition.query, TENANT, RUNTIME_CATALOG, {
        maxRows: 1,
      })
      expect(compiled.sql, `${definition.seedKey} must be tenant-bound`).toContain('tenant_id')
      expect(compiled.params).toContain(TENANT)
      expect(compiled.sql).not.toContain(TENANT)
    }
  })

  it('exposes every seeded entity in the runtime catalogue', () => {
    // This was the assertion that surfaced the `hazid_signatures` defect: its
    // curated entry named the base table `hazid_assessment_signatures`, so
    // discovery never injected it and the seeded report threw "Unknown report
    // entity" at runtime. It now declares `report_hazid_signatures` and resolves
    // like every other seeded report. Kept as an exact-empty assertion so any
    // future seed naming an unreachable entity fails loudly.
    expect(seedsMissingFromRuntime()).toEqual([])
  })

  it('resolves hazid_signatures without shadowing its base table', () => {
    const keys = RUNTIME_CATALOG.entities.map((e) => e.key)
    expect(keys).toContain('hazid_signatures')
    // `discoverEntities()` must still expose the base table with its complete
    // schema, because discovery deliberately never lets a report-only projection
    // shadow a business entity.
    expect(keys).toContain('hazid_assessment_signatures')
    const projection = RUNTIME_CATALOG.entities.find((e) => e.key === 'hazid_signatures')!
    expect(projection.table).toBe('report_hazid_signatures')
    // The curated 5-column projection, not the base table's 12 raw columns.
    expect(projection.columns.map((c) => c.key)).toEqual([
      'assessment_id',
      'signature_type',
      'person_id',
      'external_name',
      'signed_at',
    ])
  })

  it('keeps hazid_signatures on the Hazard ID read ladder, not the reports default', () => {
    // A `report_`-prefixed table falls through to the studio-wide `reports.read`
    // default, which would let ANY report viewer read every signature in the
    // tenant. TABLE_SCOPE must rebind it to `hazid.read.*`, so this asserts the
    // OBSERVABLE behaviour through the public scoping entrypoint rather than the
    // private spec table.
    const subject = (permissions: string[]): AnalyticsScopeSubject => ({
      isSuperAdmin: false,
      permissions: (key) => permissions.includes(key),
      siteIds: [],
      personId: '22222222-2222-4222-8222-222222222222',
      tenantUserId: null,
    })
    const visibleTo = (permissions: string[]) => {
      const scoped = scopeAnalyticsEntities(subject(permissions), RUNTIME_CATALOG.entities as never)
      // `scopeAnalyticsEntities` drops withheld entities, so presence is the signal.
      return scoped.some((e) => e.key === 'hazid_signatures')
    }

    // The reports-wide default must NOT grant it.
    expect(visibleTo(['reports.read.all'])).toBe(false)
    expect(visibleTo(['reports.read.site'])).toBe(false)
    // The Hazard ID ladder must, exactly as it does for the base table.
    expect(visibleTo(['hazid.read.all'])).toBe(true)
    expect(visibleTo(['hazid.read.self'])).toBe(true)
    // And it must behave identically to the table it projects from.
    // `scopeAnalyticsEntities` DROPS withheld entities rather than returning them
    // flagged, so presence in the scoped list is the visibility signal.
    for (const permissions of [['hazid.read.all'], ['hazid.read.self'], ['reports.read.all'], []]) {
      const scoped = scopeAnalyticsEntities(subject(permissions), RUNTIME_CATALOG.entities as never)
      const projectionPresent = scoped.some((e) => e.key === 'hazid_signatures')
      const basePresent = scoped.some((e) => e.key === 'hazid_assessment_signatures')
      expect(projectionPresent, `projection vs base for [${permissions.join(',')}]`).toBe(
        basePresent,
      )
    }
  })

  it('does not expand the public API entity list', () => {
    // The `report_` rename must not have added an API entity, and must not have
    // published the raw base table either.
    const curated = REPORT_ENTITIES.map((e) => e.key)
    expect(curated).toHaveLength(18)
    expect(curated).toContain('hazid_signatures')
    expect(curated).not.toContain('hazid_assessment_signatures')
    expect(curated).not.toContain('journal_entries')
    expect(curated).not.toContain('companies')
  })

  it('the Phase 11-F reports resolve entirely from discovery', () => {
    // The whole point of the decoupling: these three name entities that exist in
    // the schema and are RLS-registered, but were never curated.
    for (const key of [
      'work_permit_expiry',
      'safety_observations',
      'contractor_company_register',
    ]) {
      const definition = BEACON_REPORT_SEEDS.find((d) => d.seedKey === key)
      expect(definition, `${key} must be seeded`).toBeDefined()
      expect(seedsMissingFromRuntime()).not.toContain(`${key} -> ${definition!.query.entity}`)
      expect(RUNTIME_CATALOG.entities.map((e) => e.key)).toContain(definition!.query.entity)
    }
  })
})
