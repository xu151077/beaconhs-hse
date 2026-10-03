import { describe, expect, it } from 'vitest'
import { compileCustomReport } from '@braedonsaunders/appkit-reports'
import {
  BEACON_REPORT_SEEDS,
  EXPECTED_BEACON_REPORT_SEED_KEYS,
} from '@beaconhs/db/seed/report-definitions'
import { BEACON_REPORT_CATALOG, REPORT_ENTITIES } from './entities'

const TENANT = '00000000-0000-4000-8000-000000000001'

/**
 * The curated entity list, pinned exactly.
 *
 * `REPORT_ENTITIES` is simultaneously the report overlay AND the public REST API
 * entity list (`/api/v1` derives its published entities from it, and
 * `records.ts` derives per-record access from it). Growing it therefore
 * PUBLISHES a new API entity — and one with no `READ_PERMISSION_BY_CATEGORY`
 * entry makes /api/v1 throw. That is an authorization decision, not a seed
 * change, so it is pinned here rather than left implicit.
 *
 * The compile fixture below deliberately stays the curated catalogue. The
 * assertion that all SEEDS compile against the real runtime catalogue needs
 * `discoverEntities()`, and `@beaconhs/analytics` depends on this package, so a
 * test here cannot import it without a Turbo build cycle. That assertion lives
 * in `apps/web/src/lib/report-seed-runtime-parity.test.ts`, where both packages
 * are legal declared dependencies.
 */
const CURATED_ENTITY_KEYS = [
  'compliance_status',
  'corrective_actions',
  'documents',
  'equipment_fleet',
  'equipment_items',
  'hazid_signatures',
  'incident_rates',
  'incidents',
  'inspection_records',
  'monitored_sessions',
  'ppe_items',
  'skill_assignments',
  'training_matrix',
  'training_records',
  'vehicle_log_entries',
  'vehicle_log_monthly',
] as const

const LEGACY_REPORT_REPLACEMENTS = [
  'training_certificates',
  'training_expired_upcoming',
  'training_missing',
  'skills_matrix',
  'skills_expired_upcoming',
  'skills_missing',
  'skills_cwb',
  'ppe_list',
  'ppe_expired_upcoming',
  'compliance_by_entity',
  'compliance_by_person',
  'corrective_actions_list',
  'hazid_signatures',
  'equipment_fleet',
  'equipment_inspections',
  'equipment_oil_change_due',
] as const

describe('Beacon AppKit report catalogue', () => {
  it('compiles every curated entity through the one AppKit query contract', () => {
    // Scoped to the CURATED list on purpose. The equivalent check for ALL seeds
    // against the runtime catalogue lives in apps/web, because
    // `@beaconhs/analytics` depends on this package and importing discovery here
    // would be a Turbo build cycle.
    //
    // What this asserts is that the curated overlay itself stays internally
    // coherent — every curated entity is a usable source for a report.
    for (const entity of BEACON_REPORT_CATALOG.entities) {
      expect(() =>
        compileCustomReport(
          { entity: entity.key, mode: 'rows', columns: [entity.columns[0]!.key] },
          TENANT,
          BEACON_REPORT_CATALOG,
          { maxRows: 1 },
        ),
      ).not.toThrow()
    }
  })

  it('keeps the curated entity list exactly as it is', () => {
    expect([...REPORT_ENTITIES.map((entity) => entity.key)].sort()).toEqual([
      ...CURATED_ENTITY_KEYS,
    ])
  })

  it('does not add a physical table to the curated list for a Phase 11-F report', () => {
    // Safety Observations and Contractor / Company Register are seeded against
    // `journal_entries` and `companies`. Those must stay OUT of the curated list,
    // or they become public API entities with no read gate.
    const keys = REPORT_ENTITIES.map((entity) => entity.key)
    expect(keys).not.toContain('journal_entries')
    expect(keys).not.toContain('companies')
  })

  it('contains every intended legacy replacement exactly once', () => {
    const keys = new Set(EXPECTED_BEACON_REPORT_SEED_KEYS)
    expect(EXPECTED_BEACON_REPORT_SEED_KEYS).toHaveLength(keys.size)
    expect(BEACON_REPORT_SEEDS).toHaveLength(35)
    for (const key of LEGACY_REPORT_REPLACEMENTS) expect(keys.has(key)).toBe(true)
  })

  it('does not duplicate the Training Matrix insight or seed excluded financial reports', () => {
    const searchable = BEACON_REPORT_SEEDS.map(
      (definition) => `${definition.seedKey} ${definition.slug} ${definition.name}`,
    ).join(' ')
    expect(searchable).not.toMatch(/\btraining[ _-]matrix\b/i)
    expect(searchable).not.toMatch(/\b(equipment[ _-])?(charges?|roi)\b/i)
  })

  it('exposes the employee, course, department, and group dimensions required by training parity', () => {
    const matrix = BEACON_REPORT_CATALOG.entities.find((entity) => entity.key === 'training_matrix')
    expect(matrix).toBeDefined()
    const columns = matrix?.columns.map((column) => column.key) ?? []
    expect(columns).toEqual(
      expect.arrayContaining([
        'person_id',
        'employee_no',
        'person_name',
        'course_id',
        'course_code',
        'course_name',
        'course_type',
        'delivery_type',
        'department_id',
        'department_name',
        'group_id_list',
        'person_status',
      ]),
    )
    const records = BEACON_REPORT_CATALOG.entities.find(
      (entity) => entity.key === 'training_records',
    )
    expect(records?.table).toBe('report_training_records')
    expect(records?.columns.map((column) => column.key)).toEqual(
      expect.arrayContaining([
        'employee_no',
        'person_name',
        'person_status',
        'department_id',
        'department_name',
        'course_code',
        'course_name',
        'group_id_list',
      ]),
    )
  })

  it('seeds employment status and wallet-card PDF export on training reports', () => {
    const trainingSeeds = BEACON_REPORT_SEEDS.filter(
      (definition) => definition.query.entity === 'training_matrix',
    )
    expect(trainingSeeds.length).toBeGreaterThan(0)
    for (const definition of trainingSeeds) {
      const rules = definition.query.filters?.rules ?? []
      expect(rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'person_status', op: 'eq', value: 'active' }),
        ]),
      )
    }
    const wallet = BEACON_REPORT_SEEDS.find(
      (definition) => definition.seedKey === 'training_wallet_cards',
    )
    expect(wallet?.layout).toEqual(expect.objectContaining({ exportMode: 'credential-fronts' }))
  })
})
