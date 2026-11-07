// Phase 11-F runtime-catalogue assertions — moved from
// packages/reports/src/phase11f-report-integrity.test.ts.
//
// Why this lives in apps/web: `@beaconhs/analytics` depends on
// `@beaconhs/reports`, so a test inside `packages/reports` cannot import
// `@beaconhs/analytics/server` without a workspace cycle (Turbo refuses to
// build it, and a fresh isolated pnpm install refuses to resolve it: TS2307).
// apps/web already declares both packages, same as the existing
// `report-seed-runtime-parity.test.ts` precedent.
//
// Semantics preserved verbatim from the original location:
//   * each Phase 11-F seed compiles through the one AppKit query contract,
//     against discovery (not the curated list);
//   * tenant_id is bound as a parameter, never inlined;
//   * no other Phase 11-F entity leaks into the compiled SQL.
//
// No database is required — `discoverEntities()` is the DB-free half of the
// same discovery that `discoverEntitiesWithScopedApps` wraps.

import { describe, expect, it } from 'vitest'
import { discoverEntities } from '@beaconhs/analytics/server'
import { compileCustomReport, type ReportEntityCatalog } from '@beaconhs/reports'
import { BEACON_REPORT_SEEDS } from '@beaconhs/db/seed/report-definitions'

const TENANT = '00000000-0000-4000-8000-000000000001'
const RUNTIME_CATALOG: ReportEntityCatalog = {
  entities: discoverEntities() as unknown as ReportEntityCatalog['entities'],
}

const seedOf = (key: string) => {
  const found = BEACON_REPORT_SEEDS.find((d) => d.seedKey === key)
  expect(found, `seed ${key} must exist`).toBeDefined()
  return found!
}
const compileInRuntime = (key: string) =>
  compileCustomReport(seedOf(key).query, TENANT, RUNTIME_CATALOG, { maxRows: 1 })

const PHASE_11_F_KEYS = [
  'work_permit_expiry',
  'safety_observations',
  'contractor_company_register',
] as const

describe('Phase 11-F seeds compile against the runtime catalogue', () => {
  it.each(PHASE_11_F_KEYS)(
    '%s compiles through the one AppKit query contract, against the runtime catalogue',
    (key) => {
      // The runtime catalogue, not the curated list: reports are compiled
      // against discovery, so that is the fixture that means anything.
      expect(() => compileInRuntime(key)).not.toThrow()
    },
  )
})

describe.each(PHASE_11_F_KEYS)('%s is tenant-bound at compile time', (key) => {
  it('binds tenant_id as a parameter, never as an inline literal', () => {
    const compiled = compileInRuntime(key)
    expect(compiled.sql).toContain('tenant_id')
    expect(compiled.params).toContain(TENANT)
    expect(compiled.sql).not.toContain(TENANT)
  })

  it('reads only from its own entity, so no other table leaks in', () => {
    const entity = seedOf(key).query.entity
    const others = PHASE_11_F_KEYS.map((k) => seedOf(k).query.entity).filter((e) => e !== entity)
    const compiled = compileInRuntime(key)
    for (const other of others) {
      if (other === 'journal_entries') continue // monitored_sessions reads it internally
      expect(compiled.sql).not.toContain(`"${other}"`)
    }
  })
})
